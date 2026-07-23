// The directory walk. DESIGN §5.2 `SCANNING`, §3.2 `kind`, INV-14, INV-17.
//
// ⚠️ INV-17 / STACK ADR-013: **the root is a parameter.** Nothing here reads a setting, calls
// `os.homedir()` or defaults to `~/.claude`. That is what lets every test point this at a
// sandbox and what makes the home-directory tripwire able to fire before anything is read.
//
// ⚠️ INV-14: `<claudeDir>/.claude-lens-backups/` is excluded from the manifest **entirely**.
// The app must never see its own safety net — otherwise Bloat Radar flags the restore points
// as bloat and offers to delete them, and the watcher resyncs on the app's own writes.

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_ROOT_NAME } from '../config/paths';
import { classifyFileKind, PARSED_FILE_KINDS, type FileKind } from '../parse/source-file';

/** One discovered file. `relPath` is POSIX and relative to the root (§3.1.4). */
export interface ScannedFile {
  readonly relPath: string;
  readonly kind: FileKind;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  /**
   * §3.2 / §5.3 — sha256, computed only for the kinds the caller asks to hash. `null` for
   * JSONL, always: "hashing 1 GB per sync would defeat the point" (§3.2).
   */
  readonly contentHash: string | null;
}

export interface ScanResult {
  readonly files: readonly ScannedFile[];
  /**
   * Directories that could not be read. Incompleteness is data, never a thrown error
   * (§4.6, CLAUDE.md §1): a permission-denied subtree is reported, not fatal.
   */
  readonly unreadable: readonly string[];
}

export interface ScanOptions {
  /** Restrict the result to these `file_manifest.kind` values. Default: every kind. */
  readonly kinds?: ReadonlySet<FileKind>;
  /**
   * §5.3's last paragraph — the kinds whose change detection is `content_hash` rather than
   * byte offsets. Small files only; a JSONL kind must never appear here (§3.2).
   */
  readonly hashKinds?: ReadonlySet<FileKind>;
  /** Cooperative cancellation (§5.2 `CANCELLING`), checked per directory. */
  readonly isCancelled?: () => boolean;
}

/** The kinds the sync cycle parses; everything else is E10's harness scanner. */
export const SYNC_SCAN_KINDS = PARSED_FILE_KINDS;

/**
 * §5.3 — the parsed kinds whose change detection is a hash rather than a byte offset.
 * `stats-cache.json` is a single small JSON document, not line-delimited, so a byte offset
 * would mean nothing for it (§3.16).
 */
export const SYNC_HASH_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['stats_cache']);

/**
 * Walks `root` and classifies every file into the §3.2 `kind` enum.
 *
 * Results are returned in `relPath` order, so a cycle's file order is a pure function of the
 * tree. Ingest is order-independent by construction (every derived value is recomputed at
 * finalize), but a deterministic order makes a failure reproducible.
 */
export async function scanClaudeDirectory(
  root: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const files: ScannedFile[] = [];
  const unreadable: string[] = [];
  // INV-14 — the exact backup root, per §9.3 `<claudeDir>/.claude-lens-backups/`. Excluded
  // here so it never reaches the manifest, and therefore never reaches analytics, Bloat
  // Radar or the watcher's parsed-kind filter.
  const excludedTopLevel = new Set([BACKUP_ROOT_NAME]);

  const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
    if (options.isCancelled?.() === true) return;
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      unreadable.push(relativeDir === '' ? '.' : relativeDir);
      return;
    }

    for (const entry of entries) {
      const relPath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      // Symlinks are never followed: §2.1 "Project" is explicit that there is **zero
      // inference** — no symlink resolution — and following one can leave the root entirely.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (relativeDir === '' && excludedTopLevel.has(entry.name)) continue;
        await walk(join(absoluteDir, entry.name), relPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const kind = classifyFileKind(relPath);
      if (options.kinds !== undefined && !options.kinds.has(kind)) continue;

      try {
        const absoluteFile = join(absoluteDir, entry.name);
        const stats = await stat(absoluteFile);
        files.push({
          relPath,
          kind,
          sizeBytes: stats.size,
          // §3.1.1 — UTC epoch ms everywhere. `mtimeMs` is already that.
          mtimeMs: Math.trunc(stats.mtimeMs),
          contentHash:
            options.hashKinds?.has(kind) === true ? await sha256OfFile(absoluteFile) : null,
        });
      } catch {
        // The file vanished between readdir and stat. Not an error: the next cycle sees it,
        // or does not (§5.12 "filesystem wins").
        unreadable.push(relPath);
      }
    }
  };

  await walk(root, '');
  files.sort((left, right) =>
    left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0,
  );
  return { files, unreadable };
}

/** §3.2 `content_hash` — sha256, hex. Only ever called for the small non-JSONL kinds. */
async function sha256OfFile(absolutePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(absolutePath))
    .digest('hex');
}
