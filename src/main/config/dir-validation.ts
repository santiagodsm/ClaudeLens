// §4.3 `dir:validate` / `dir:pick` — is this path a Claude data directory, and how do we say so?
//
// ⚠️ INV-17: the root is a PARAMETER. Nothing here calls `os.homedir()`, reads a setting, or
// defaults to anything. That is what lets every test point it at a sandbox.
//
// ⚠️ `transcriptFileCount` is **counted, not estimated** (§4.3). `0` is a legal answer and
// means "a valid Claude directory with no transcripts yet" — which is `READY_EMPTY`, not an
// error. Estimating it, or substituting a plausible number, would be the defining bug of this
// project wearing a different hat (CLAUDE.md §1).

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DirStatus, DirValidation } from '../../shared/ipc-contract';
import { BACKUP_ROOT_NAME } from './paths';

/** §2.1 / §4.3 — the two things whose presence makes a directory a Claude data directory. */
const PROJECTS_DIR = 'projects';
const HISTORY_FILE = 'history.jsonl';

/** §3.2 — the transcript extension. Counting is a `.jsonl` count under `projects/`. */
const TRANSCRIPT_EXT = '.jsonl';

interface EntryProbe {
  readonly exists: boolean;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  /** EACCES / EPERM — `unreadable` rather than `not_found` (§4.3). */
  readonly denied: boolean;
}

async function probe(path: string): Promise<EntryProbe> {
  try {
    const stats = await stat(path);
    return {
      exists: true,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      denied: false,
    };
  } catch (cause) {
    return { exists: false, isDirectory: false, isFile: false, denied: isDenied(cause) };
  }
}

function isDenied(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * §4.3 — validate one candidate path.
 *
 * The four failure statuses are distinguished because §4.1 gives each its own `ErrorCode` and
 * the renderer branches on the code, never on prose (§4.1 rule 2):
 *
 *   `not_found`  — the path does not exist, or is not a directory   → `E_DIR_NOT_FOUND`
 *   `unreadable` — it exists but permission was denied              → `E_DIR_UNREADABLE`
 *   `invalid`    — it exists but has neither `projects/` nor `history.jsonl` → `E_DIR_INVALID`
 *   `valid`      — one or both are present
 */
export async function validateClaudeDir(path: string): Promise<DirValidation> {
  const root = await probe(path);
  if (root.denied) {
    return failure('unreadable', 'That directory exists but this app is not allowed to read it.');
  }
  if (!root.exists || !root.isDirectory) {
    return failure('not_found', 'That path does not exist, or is not a directory.');
  }

  const projects = await probe(join(path, PROJECTS_DIR));
  const history = await probe(join(path, HISTORY_FILE));
  if (projects.denied || history.denied) {
    return failure('unreadable', 'That directory exists but this app is not allowed to read it.');
  }

  const hasProjects = projects.exists && projects.isDirectory;
  const hasHistory = history.exists && history.isFile;
  if (!hasProjects && !hasHistory) {
    return {
      status: 'invalid',
      hasProjects,
      hasHistory,
      transcriptFileCount: 0,
      reason: `That directory has neither a ${PROJECTS_DIR}/ folder nor a ${HISTORY_FILE} file.`,
    };
  }

  return {
    status: 'valid',
    hasProjects,
    hasHistory,
    transcriptFileCount: hasProjects ? await countTranscripts(join(path, PROJECTS_DIR)) : 0,
  };
}

function failure(status: DirStatus, reason: string): DirValidation {
  return { status, hasProjects: false, hasHistory: false, transcriptFileCount: 0, reason };
}

/**
 * Counts `*.jsonl` files under `projects/`, recursively, **excluding the backup root**
 * (INV-14). Unreadable subtrees are skipped rather than thrown: a permission-denied folder is
 * incompleteness, and incompleteness is data (§4.6). The count is therefore a floor, which is
 * why nothing downstream treats it as a metric — it drives the onboarding preview only.
 */
async function countTranscripts(projectsDir: string): Promise<number> {
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.name === BACKUP_ROOT_NAME) continue;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(TRANSCRIPT_EXT)) count += 1;
    }
  };
  await walk(projectsDir);
  return count;
}

/** §4.1 — the `DirStatus` → `ErrorCode` mapping, stated once. */
export function errorCodeForDirStatus(
  status: Exclude<DirStatus, 'valid'>,
): 'E_NO_DIR' | 'E_DIR_NOT_FOUND' | 'E_DIR_INVALID' | 'E_DIR_UNREADABLE' {
  switch (status) {
    case 'unset':
      return 'E_NO_DIR';
    case 'not_found':
      return 'E_DIR_NOT_FOUND';
    case 'invalid':
      return 'E_DIR_INVALID';
    case 'unreadable':
      return 'E_DIR_UNREADABLE';
  }
}
