// Filesystem primitives shared by the harness scanner (§3.10), Bloat Radar (§5.11) and the
// guarded-action catalogue (§5.7).
//
// ⚠️ INV-17 / STACK ADR-013 — **the root is always a parameter.** Nothing here reads a setting,
// calls `os.homedir()` or defaults to `~/.claude`. That is what lets every test point this at a
// sandbox, and what lets `test/support/tripwire.ts` fire before a byte is read.
//
// ⚠️ INV-14 — `<claudeDir>/.claude-lens-backups/` is excluded from every walk that starts at
// `claudeDir`. Without it Bloat Radar flags the app's own restore points as reclaimable and
// offers to delete them, which turns the safety net into the first casualty.
//
// ⚠️ Symlinks are never followed, exactly as `src/main/sync/scan.ts` does not follow them: a
// symlink out of `claudeDir` would let a walk — and therefore an action's target list — leave the
// root entirely (§2.1 "zero inference").

import { lstat, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { BACKUP_ROOT_NAME } from '../config/paths';

/** One file found beneath a root. `relPath` is POSIX and relative to that root (§3.1.4). */
export interface WalkedFile {
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/** One directory found beneath a root. */
export interface WalkedDirectory {
  readonly relPath: string;
  readonly mtimeMs: number;
}

export interface WalkResult {
  readonly files: readonly WalkedFile[];
  readonly directories: readonly WalkedDirectory[];
}

export interface WalkOptions {
  /**
   * INV-14. `true` (the default) skips `<root>/.claude-lens-backups` and everything under it.
   * ⚠️ ACT-06 — `clear-backups` — is the only caller that passes `false`, and its targets are
   * *only* inside that directory (§5.5 rule 7).
   */
  readonly excludeBackupRoot?: boolean;
}

/** POSIX relative path from `root` to `absolute`. `''` when they are the same path. */
export function toPosixRel(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

export async function pathExists(absolute: string): Promise<boolean> {
  try {
    await lstat(absolute);
    return true;
  } catch {
    return false;
  }
}

/** `'file'`, `'directory'`, or `null` when the path is absent or is neither. */
export async function entryKind(absolute: string): Promise<'file' | 'directory' | null> {
  try {
    const stats = await lstat(absolute);
    if (stats.isFile()) return 'file';
    if (stats.isDirectory()) return 'directory';
    return null;
  } catch {
    return null;
  }
}

/**
 * Every file and directory beneath `root`, recursively.
 *
 * An unreadable subtree is skipped rather than thrown: incompleteness is data, never a fatal
 * error (§4.6, CLAUDE.md §1), and §6.9 requires that "a failed harness scan never blocks the
 * analytics views".
 */
export async function walkTree(root: string, options: WalkOptions = {}): Promise<WalkResult> {
  const excludeBackupRoot = options.excludeBackupRoot ?? true;
  const files: WalkedFile[] = [];
  const directories: WalkedDirectory[] = [];

  const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relPath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      const absolute = join(absoluteDir, entry.name);

      if (entry.isDirectory()) {
        // INV-14 — the exact §9.3 backup root, at the top level of `root` and nowhere else.
        if (excludeBackupRoot && relativeDir === '' && entry.name === BACKUP_ROOT_NAME) continue;
        try {
          const stats = await stat(absolute);
          directories.push({ relPath, mtimeMs: Math.trunc(stats.mtimeMs) });
        } catch {
          continue;
        }
        await walk(absolute, relPath);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const stats = await stat(absolute);
        files.push({
          relPath,
          sizeBytes: stats.size,
          // §3.1.1 — UTC epoch ms in every column.
          mtimeMs: Math.trunc(stats.mtimeMs),
        });
      } catch {
        // Vanished between readdir and stat. The next scan sees it, or does not.
      }
    }
  };

  await walk(root, '');
  const byPath = (left: { relPath: string }, right: { relPath: string }): number =>
    left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0;
  return { files: [...files].sort(byPath), directories: [...directories].sort(byPath) };
}

/**
 * §3.10 `harness_nodes.size_bytes` — "on-disk size of `rel_path`, **recursive for directories**".
 * Also the size every action preview and every Bloat Radar flag reports, so the number the user
 * confirms against is the number the same function produced.
 */
export async function sizeOnDisk(absolute: string): Promise<number> {
  const kind = await entryKind(absolute);
  if (kind === null) return 0;
  if (kind === 'file') {
    try {
      return (await stat(absolute)).size;
    } catch {
      return 0;
    }
  }
  const tree = await walkTree(absolute, { excludeBackupRoot: false });
  return tree.files.reduce((total, file) => total + file.sizeBytes, 0);
}
