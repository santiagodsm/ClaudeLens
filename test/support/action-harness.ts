// A whole E10 stack — harness scanner, Bloat Radar and the guarded-action catalogue — over one
// sandbox directory and one real SQLite file.
//
// STACK ADR-013 mechanism 2: "One SQLite file per test … anything exercising the file manifest,
// byte offsets, WAL, migrations or the incremental fast-path must use a real file." Every guarded
// action writes a restore point onto a real filesystem and an audit row into a real database, so
// nothing here may be `:memory:`.
//
// ⚠️ **The real `~/.claude` is unreachable by construction.** `test/support/tripwire.ts` is loaded
// by every Vitest project (ADR-013 mechanism 3) and `src/main/config/paths.ts` carries the
// production assertion (ADR-018). Nothing in this file works around either, and no test names a
// fixed path — every root comes from `useSandbox()`.
//
// This file is not a test (the `main` project collects only `*.{test,spec}.ts`).

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import type { AuditStatus } from '../../src/shared/ipc-contract';
import { ActionService } from '../../src/main/actions/service';
import { openDatabase } from '../../src/main/db/driver';
import { migrate } from '../../src/main/db/migrate';
import type { SqliteDatabase } from '../../src/main/db/sqlite';
import { HarnessService } from '../../src/main/harness/service';
import { silentLogger } from '../../src/main/log/logger';

/** A fixed instant. Nothing in these tests depends on a clock (CLAUDE.md §1). */
export const ACTION_NOW = 1_760_000_000_000;

/**
 * Writes a synthetic `~/.claude`-shaped tree from a `{ relPath: contents }` map.
 *
 * ⚠️ Synthetic, always. No test in this repository may contain real `.claude` content or a
 * personal path (CLAUDE.md §7, P-33), and every root here comes from `useSandbox()`.
 * A `''` value writes an empty file; a key ending in `/` creates a directory and nothing else.
 */
export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, contents] of Object.entries(files)) {
    if (relPath.endsWith('/')) {
      await mkdir(join(root, relPath), { recursive: true });
      continue;
    }
    const absolute = join(root, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }
}

export interface ActionHarness {
  readonly db: SqliteDatabase;
  readonly harness: HarnessService;
  readonly actions: ActionService;
  /** §5.6 — every `suspendWatcher()`/`resumeWatcher()` call, in order, so the bracket is testable. */
  readonly watcherCalls: ('suspend' | 'resume')[];
  /** §4.9 `evt:actionCompleted`, in order. */
  readonly completed: { auditId: number; status: AuditStatus }[];
  /** Lets a test move the injected clock — INV-06's five-minute expiry needs it. */
  setNow(at: number): void;
  /** Lets a test point ACT-07 at a different archive root, or unset it (`E_ARCHIVE_NO_ROOT`). */
  setArchiveRoot(path: string | null): void;
}

export interface ActionHarnessOptions {
  readonly claudeDir: string;
  readonly dbPath: string;
  readonly archiveRoot?: string | null;
  /** BR-05's reported threshold; kept tiny so a test does not have to write 500 MB. */
  readonly transcriptThresholdBytes?: number;
  readonly tokenTtlMs?: number;
}

export function createActionHarness(options: ActionHarnessOptions): ActionHarness {
  const db = openDatabase(options.dbPath);
  migrate(db);

  let now = ACTION_NOW;
  let archiveRoot: string | null = options.archiveRoot ?? null;
  const watcherCalls: ('suspend' | 'resume')[] = [];
  const completed: { auditId: number; status: AuditStatus }[] = [];

  const harness = new HarnessService({
    db,
    claudeDir: () => options.claudeDir,
    now: () => now,
    ...(options.transcriptThresholdBytes === undefined
      ? {}
      : { transcriptThresholdBytes: options.transcriptThresholdBytes }),
  });

  const actions = new ActionService({
    db,
    logger: silentLogger(),
    claudeDir: () => options.claudeDir,
    archiveRoot: () => archiveRoot,
    suspendWatcher: () => watcherCalls.push('suspend'),
    resumeWatcher: () => watcherCalls.push('resume'),
    now: () => now,
    onActionCompleted: (payload) => completed.push(payload),
    ...(options.tokenTtlMs === undefined ? {} : { tokenTtlMs: options.tokenTtlMs }),
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  return {
    db,
    harness,
    actions,
    watcherCalls,
    completed,
    setNow: (at) => {
      now = at;
    },
    setArchiveRoot: (path) => {
      archiveRoot = path;
    },
  };
}
