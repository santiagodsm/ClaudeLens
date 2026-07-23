// Restore points — DESIGN §5.5 rule 1, §9.3, §9.4, INV-07, ADR-034.
//
// ⚠️⚠️ **BACKUP STRICTLY PRECEDES MUTATION. IF BACKUP FAILS, NOTHING IS MUTATED, EVER.** That is
// INV-07 and §5.5 rule 1, and it is why every function in this file either completes or throws
// before the caller is allowed to touch a target. There is no "best effort" branch.
//
// Two shapes of restore point, because there are two classes of action (ADR-034):
//
//   · **Delete/overwrite class (ACT-01…ACT-05)** — the bytes are copied into
//     `<claudeDir>/.claude-lens-backups/<iso>-<auditId>/`, mirroring the target's rel_path. Undo
//     copies them back.
//
//   · **Move class (ACT-07 only)** — the restore point is a **`move-manifest.json`**, not copies.
//     "A move destroys nothing — the bytes exist at the destination the moment the operation
//     completes — so copying hundreds of megabytes into a restore point that is *never pruned*
//     would permanently consume exactly the disk the user was trying to free, defeating the
//     action's purpose" (§5.5 rule 1). Undo replays it in reverse and **verifies size and mtime
//     before moving each file back**, refusing with `E_ARCHIVE_VERIFY_FAILED` if anything changed.
//     "The invariant is unchanged in substance: a restore point always exists and is always
//     sufficient to reverse the action."
//
// ⚠️ **Nothing here ever deletes a restore point.** No retention policy, no age cap, no size cap,
// no silent pruning (§1.6 non-goal 4, OQ-103). ACT-06 is the only thing in this application that
// removes one, and it is a guarded action with typed confirmation and its own audit entry.

import { copyFile, cp, mkdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { BACKUP_ROOT_NAME, backupRoot } from '../config/paths';
import { HandlerError } from '../ipc/errors';
import { entryKind, sizeOnDisk, walkTree } from '../harness/tree';
import type { ResolvedTarget } from './targets';

/** §5.5 rule 1 / ADR-034 — the move-class restore point's one file. */
export const MOVE_MANIFEST_NAME = 'move-manifest.json';

/** The delete-class restore point's index, so undo does not have to guess what it holds. */
export const COPY_MANIFEST_NAME = 'restore-point.json';

/**
 * §9.3 — `<claudeDir>/.claude-lens-backups/<iso>-<auditId>/`, as a rel_path (§3.1.4).
 *
 * ⚠️ The ISO instant has its `:` replaced by `-`. macOS's Finder renders a literal `:` in a
 * filename as `/`, which would make the restore point's name unreadable in exactly the tool
 * §5.7 tells the user to manage these folders with. The `<iso>-<auditId>` shape §9.3 specifies is
 * otherwise preserved, and the audit id — which is unique — is what actually identifies the row.
 */
export function restorePointRelPath(auditId: number, at: number): string {
  const iso = new Date(at).toISOString().replaceAll(':', '-');
  return `${BACKUP_ROOT_NAME}/${iso}-${String(auditId)}`;
}

export interface CopyManifestEntry {
  readonly relPath: string;
  readonly kind: 'file' | 'directory';
  readonly sizeBytes: number;
}

export interface CopyManifest {
  readonly kind: 'copy';
  readonly auditId: number;
  readonly claudeDir: string;
  readonly entries: readonly CopyManifestEntry[];
}

/** §5.5 rule 1 — "every `{ originalRelPath, archiveRelPath, sizeBytes, mtimeMs }` pair". */
export interface MoveManifestEntry {
  readonly originalRelPath: string;
  readonly archiveRelPath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export interface MoveManifest {
  readonly kind: 'move';
  readonly auditId: number;
  readonly archiveId: number;
  readonly claudeDir: string;
  readonly archiveRoot: string;
  readonly entries: readonly MoveManifestEntry[];
}

function backupFailed(cause: unknown, detail: string): HandlerError {
  return new HandlerError(
    'E_ACTION_BACKUP_FAILED',
    'The restore point could not be written, so nothing was changed.',
    { cause, detail },
  );
}

/**
 * Copies every target into a fresh restore point. Delete/overwrite class only.
 *
 * ⚠️ Throws `E_ACTION_BACKUP_FAILED` on any failure, having written nothing the caller may rely
 * on. The caller must treat a throw as "nothing has been mutated" and go straight to `FAILED`
 * (§5.5's `backup fails ──> FAILED (E_ACTION_BACKUP_FAILED; NOTHING mutated)`).
 *
 * A 0-byte target is still copied and still recorded — §5.7 says so of ACT-05 explicitly ("the
 * file (0 B, still recorded)"), because the restore point's job is to make undo possible, and an
 * empty file that used to exist is a different state from a file that never did.
 */
export async function writeCopyRestorePoint(
  claudeDir: string,
  backupRelPath: string,
  auditId: number,
  targets: readonly ResolvedTarget[],
): Promise<{ backupBytes: number }> {
  const backupDir = resolve(join(claudeDir, backupRelPath));
  try {
    await mkdir(backupDir, { recursive: true });
    const entries: CopyManifestEntry[] = [];
    for (const target of targets) {
      const source = resolve(join(claudeDir, target.relPath));
      const destination = join(backupDir, target.relPath);
      await mkdir(dirname(destination), { recursive: true });
      const kind = await entryKind(source);
      if (kind === 'directory') {
        await cp(source, destination, { recursive: true, preserveTimestamps: true });
      } else if (kind === 'file') {
        await copyFile(source, destination);
      } else {
        // The target vanished between resolution and backup. That is not a backup failure — it is
        // a target that will be reported as skipped — so it is recorded as absent and skipped here.
        continue;
      }
      entries.push({ relPath: target.relPath, kind: kind, sizeBytes: await sizeOnDisk(source) });
    }

    const manifest: CopyManifest = { kind: 'copy', auditId, claudeDir, entries };
    await writeFile(join(backupDir, COPY_MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');

    // Measured from the restore point itself rather than from the sources: `backup_bytes` (§3.14)
    // is what is on disk under the backup root, and Settings adds it up (§6.10 card 6).
    return { backupBytes: await sizeOnDisk(backupDir) };
  } catch (cause) {
    throw backupFailed(cause, `restore point ${backupRelPath} for audit ${String(auditId)}`);
  }
}

/** Writes the move-class restore point. ACT-07 only (ADR-034). */
export async function writeMoveManifest(
  claudeDir: string,
  backupRelPath: string,
  manifest: MoveManifest,
): Promise<{ backupBytes: number }> {
  const backupDir = resolve(join(claudeDir, backupRelPath));
  try {
    await mkdir(backupDir, { recursive: true });
    const file = join(backupDir, MOVE_MANIFEST_NAME);
    await writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
    return { backupBytes: (await stat(file)).size };
  } catch (cause) {
    throw backupFailed(cause, `move manifest ${backupRelPath}/${MOVE_MANIFEST_NAME}`);
  }
}

export type AnyManifest = CopyManifest | MoveManifest;

/**
 * Reads whichever manifest a restore point holds.
 *
 * `E_ACTION_BACKUP_MISSING` when the folder or its manifest is gone — which is a real state: the
 * user may have deleted the folder in Finder, and §5.5 rule 5 makes undo conditional on
 * `backup_present = 1`, a database claim the filesystem can outdate.
 */
export async function readRestorePoint(
  claudeDir: string,
  backupRelPath: string,
): Promise<AnyManifest> {
  const backupDir = resolve(join(claudeDir, backupRelPath));
  for (const name of [MOVE_MANIFEST_NAME, COPY_MANIFEST_NAME]) {
    try {
      const text = await readFile(join(backupDir, name), 'utf8');
      return JSON.parse(text) as AnyManifest;
    } catch {
      continue;
    }
  }
  throw new HandlerError(
    'E_ACTION_BACKUP_MISSING',
    'That restore point is no longer on disk, so this action cannot be undone.',
    { detail: `no manifest under ${backupRelPath}` },
  );
}

/**
 * Undo for the delete/overwrite class: copies every recorded entry back over its original path.
 *
 * ⚠️ It overwrites. That is the point of an undo of a delete, and it is why §11.5 keeps
 * *arbitrary older* restore points out of v1: restoring a three-day-old point over a tree that
 * has moved on has conflict semantics nobody has specified, and guessing them in a delete-capable
 * app is not acceptable. Single-level undo, immediately after the action, is fully specified.
 */
export async function restoreFromCopy(
  claudeDir: string,
  backupRelPath: string,
  manifest: CopyManifest,
): Promise<number> {
  const backupDir = resolve(join(claudeDir, backupRelPath));
  let restored = 0;
  for (const entry of manifest.entries) {
    const source = join(backupDir, entry.relPath);
    const destination = resolve(join(claudeDir, entry.relPath));
    if ((await entryKind(source)) === null) continue;
    await mkdir(dirname(destination), { recursive: true });
    if (entry.kind === 'directory') {
      await rm(destination, { recursive: true, force: true });
      await cp(source, destination, { recursive: true, preserveTimestamps: true });
    } else {
      await copyFile(source, destination);
    }
    restored += 1;
  }
  return restored;
}

/**
 * Moves one path, preferring `rename` and falling back to a timestamp-preserving copy.
 *
 * ⚠️ `preserveTimestamps` is load-bearing for the move class: `move-manifest.json` records the
 * mtime of every file and undo **refuses** on a mismatch (`E_ARCHIVE_VERIFY_FAILED`). An archive
 * root on an external volume is a cross-device move, so the fallback is the normal path there,
 * not an edge case.
 */
export async function movePath(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
    return;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    if (code !== 'EXDEV') throw cause;
  }
  await cp(source, destination, { recursive: true, preserveTimestamps: true });
  await rm(source, { recursive: true, force: true });
}

/** Every file beneath `absolute`, or the file itself, as `{ relPath, sizeBytes, mtimeMs }`. */
export async function filesUnder(
  root: string,
  relPath: string,
): Promise<{ relPath: string; sizeBytes: number; mtimeMs: number }[]> {
  const absolute = resolve(join(root, relPath));
  const kind = await entryKind(absolute);
  if (kind === null) return [];
  if (kind === 'file') {
    const stats = await stat(absolute);
    return [{ relPath, sizeBytes: stats.size, mtimeMs: Math.trunc(stats.mtimeMs) }];
  }
  const tree = await walkTree(absolute, { excludeBackupRoot: false });
  return tree.files.map((file) => ({
    relPath: `${relPath}/${file.relPath}`,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
  }));
}

/**
 * Undo for the move class — ADR-034, §5.5 rule 1.
 *
 * ⚠️⚠️ **Verifies size and mtime before moving each file back, and refuses with
 * `E_ARCHIVE_VERIFY_FAILED` if anything changed.** The manifest-only restore point is sound
 * precisely because of this check: "undo depends on the destination still being intact, which is
 * why it verifies size and mtime and refuses on mismatch" (ADR-034's own accounting of what
 * rejecting a byte-copy costs).
 *
 * ⚠️ **Verification runs over the WHOLE manifest before a single file moves.** Verifying and
 * moving file-by-file would leave a half-restored tree behind on the first mismatch, which is the
 * partial-mutation state §5.5 rule 1 exists to prevent.
 *
 * ⚠️ Nothing under the archive root is ever deleted by this function beyond the moved file's own
 * source entry, which ceases to exist because it was moved, not removed (§5.7 ACT-07 rule 4).
 */
export async function restoreFromMove(manifest: MoveManifest): Promise<number> {
  const archiveDir = resolve(manifest.archiveRoot);

  if ((await entryKind(archiveDir)) === null) {
    throw new HandlerError(
      'E_ARCHIVE_UNREACHABLE',
      'The archive folder is not reachable right now, so the archive cannot be undone.',
      { detail: 'archive root is not readable' },
    );
  }

  for (const entry of manifest.entries) {
    const archived = join(archiveDir, entry.archiveRelPath);
    let stats;
    try {
      stats = await stat(archived);
    } catch (cause) {
      throw verifyFailed(entry, 'the file is no longer at its archived location', cause);
    }
    if (stats.size !== entry.sizeBytes) {
      throw verifyFailed(
        entry,
        `size changed from ${String(entry.sizeBytes)} to ${String(stats.size)}`,
        undefined,
      );
    }
    if (Math.trunc(stats.mtimeMs) !== entry.mtimeMs) {
      throw verifyFailed(entry, 'the file was modified after it was archived', undefined);
    }
  }

  let restored = 0;
  for (const entry of manifest.entries) {
    await movePath(
      join(archiveDir, entry.archiveRelPath),
      resolve(join(manifest.claudeDir, entry.originalRelPath)),
    );
    restored += 1;
  }
  return restored;
}

function verifyFailed(entry: MoveManifestEntry, reason: string, cause: unknown): HandlerError {
  return new HandlerError(
    'E_ARCHIVE_VERIFY_FAILED',
    'An archived file no longer matches what was moved, so nothing was moved back.',
    { cause, detail: `${entry.archiveRelPath}: ${reason}` },
  );
}

/** ACT-06 — removes one restore point directory. The ONLY deletion under the backup root. */
export async function removeRestorePoint(claudeDir: string, backupRelPath: string): Promise<void> {
  const target = resolve(join(claudeDir, backupRelPath));
  const root = backupRoot(claudeDir);
  // Belt and braces with `assertTargetsAllowed`: this is the one function in the codebase that
  // may unlink under the backup root, so it re-derives the containment itself (INV-14).
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new HandlerError(
      'E_ACTION_TARGET_FORBIDDEN',
      'Clearing backups may only remove restore points.',
      { detail: `refused: ${backupRelPath} is not under the backup root` },
    );
  }
  await rm(target, { recursive: true, force: true });
}
