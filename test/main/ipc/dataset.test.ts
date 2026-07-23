// SM-1 — DESIGN §5.1, the dataset lifecycle transition table.
//
// One real SQLite file per test, inside a sandbox (STACK ADR-013). The Claude data directory
// is a real directory built in the same sandbox, so the transitions run against the real
// validator, the real migration runner, the real purge and the real sync engine — the only
// injected seams are the clock, the watch factory and the push emitters.

import { describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AppError,
  DirStatus,
  PushEmitterMap,
  SyncState,
} from '../../../src/shared/ipc-contract';
import { DatasetService, claudeDirFingerprint } from '../../../src/main/ipc/dataset';
import { isHandlerError } from '../../../src/main/ipc/errors';
import { silentLogger } from '../../../src/main/log/logger';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';
import { useSandbox } from '../../support/sandbox';
import { T0, countRows, seedAcrossArchiveBoundary, useTestDatabases } from '../db/helpers';
import type { WatchHandle } from '../../../src/main/watcher/watcher';

interface Recorder {
  emit: PushEmitterMap;
  sync: SyncState[];
  dataChanged: { at: number; scopes: string[] }[];
  dirStatus: DirStatus[];
  fatal: AppError[];
}

function recorder(): Recorder {
  const sync: SyncState[] = [];
  const dataChanged: { at: number; scopes: string[] }[] = [];
  const dirStatus: DirStatus[] = [];
  const fatal: AppError[] = [];
  return {
    sync,
    dataChanged,
    dirStatus,
    fatal,
    emit: {
      'evt:sync': (state) => sync.push(state),
      'evt:dataChanged': (payload) => dataChanged.push({ at: payload.at, scopes: payload.scopes }),
      'evt:pricingChanged': () => undefined,
      'evt:actionCompleted': () => undefined,
      'evt:dirStatus': (status) => dirStatus.push(status),
      'evt:fatal': (error) => fatal.push(error),
    },
  };
}

/** A watch that never watches — SM-5 has its own suite; SM-1 only needs it not to touch fs. */
function inertWatch(): WatchHandle {
  return {
    on(): unknown {
      return this;
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** A minimal but real Claude data directory: `projects/` with one transcript, plus history. */
async function makeClaudeDir(root: string, sessionId = 'sess-a'): Promise<string> {
  await mkdir(join(root, 'projects', '-work-demo-alpha'), { recursive: true });
  await writeFile(
    join(root, 'projects', '-work-demo-alpha', `${sessionId}.jsonl`),
    `${JSON.stringify({
      type: 'assistant',
      uuid: 'u-1',
      timestamp: new Date(T0).toISOString(),
      message: {
        role: 'assistant',
        model: 'model-a',
        usage: { input_tokens: 5, output_tokens: 7 },
      },
    })}\n`,
  );
  await writeFile(join(root, 'history.jsonl'), '');
  return root;
}

function service(db: SqliteDatabase, extra: Record<string, unknown> = {}) {
  const events = recorder();
  const dataset = new DatasetService({
    db,
    logger: silentLogger(),
    emit: events.emit,
    now: () => T0,
    watchFactory: () => inertWatch(),
    ...extra,
  });
  return { dataset, events };
}

describe('SM-1 boot (§5.1)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('migrations applied, claudeDir null → NO_DIR', async () => {
    const { dataset, events } = service(dbs.openRaw());
    await dataset.boot();

    expect(dataset.state()).toBe('NO_DIR');
    expect(dataset.dirStatus()).toBe('unset');
    expect(dataset.schemaVersion()).toBeGreaterThan(0);
    expect(events.fatal).toHaveLength(0);
  });

  it('a migration throw → FATAL + evt:fatal E_DB_MIGRATION_FAILED, and NOTHING is purged', async () => {
    // ⚠️ ADR-026: a failed migration leaves the database untouched. There is no
    // drop-and-rebuild path anywhere in this codebase, and this asserts the absence.
    const db = dbs.openRaw();
    db.exec('CREATE TABLE events (x INTEGER)');
    db.prepare('INSERT INTO events (x) VALUES (1)').run();

    const { dataset, events } = service(db);
    await dataset.boot();

    expect(dataset.state()).toBe('FATAL');
    expect(events.fatal).toHaveLength(1);
    expect(events.fatal[0]?.code).toBe('E_DB_MIGRATION_FAILED');
    expect(events.fatal[0]?.retryable).toBe(false);
    // The pre-existing table is exactly as it was: not dropped, not rebuilt, not emptied.
    expect(countRows(db, 'events')).toBe(1);
    // §6.11 — a FATAL dataset answers `app:bootstrap` with its own error rather than an empty
    // payload, so a renderer that missed the push still reaches the blocking screen.
    expect(() => dataset.bootstrap()).toThrow();
  });

  it('VALIDATING with a bad path → NO_DIR, and NEVER purges (§5.1, ADR-026)', async () => {
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);
    const before = {
      events: countRows(db, 'events'),
      sessions: countRows(db, 'sessions'),
      prices: countRows(db, 'price_rows'),
      audit: countRows(db, 'audit_log'),
      prompts: countRows(db, 'prompts'),
    };
    db.prepare(
      'INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('claudeDir', JSON.stringify(sandbox.resolve('does-not-exist')), T0, T0);

    const { dataset, events } = service(db);
    await dataset.boot();

    expect(dataset.state()).toBe('NO_DIR');
    expect(dataset.dirStatus()).toBe('not_found');
    expect(events.dirStatus).toEqual(['not_found']);
    // ⚠️ THE assertion. Pointing the app at a bad path must not cost the user their data.
    expect(countRows(db, 'events')).toBe(before.events);
    expect(countRows(db, 'sessions')).toBe(before.sessions);
    expect(countRows(db, 'prompts')).toBe(before.prompts);
    expect(countRows(db, 'price_rows')).toBe(before.prices);
    expect(countRows(db, 'audit_log')).toBe(before.audit);
  });

  it('VALIDATING with an UNCHANGED fingerprint → READY, incremental sync, no purge', async () => {
    const db = dbs.openMigrated();
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    db.prepare(
      'INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('claudeDir', JSON.stringify(claudeDir), T0, T0);
    db.prepare('INSERT INTO meta (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      'claudeDirFingerprint',
      JSON.stringify(claudeDirFingerprint(claudeDir)),
      T0,
    );

    const { dataset, events } = service(db);
    await dataset.boot();
    await dataset.settled();

    expect(dataset.state()).toBe('READY');
    expect(events.dirStatus).toEqual(['valid']);
    expect(events.sync.some((state) => state.kind === 'incremental')).toBe(true);
    expect(events.sync.some((state) => state.kind === 'full')).toBe(false);
  });

  it('VALIDATING with a CHANGED fingerprint → READY_EMPTY, purge DERIVED only, full sync', async () => {
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    db.prepare(
      'INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('claudeDir', JSON.stringify(claudeDir), T0, T0);
    db.prepare('INSERT INTO meta (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      'claudeDirFingerprint',
      JSON.stringify(claudeDirFingerprint(sandbox.resolve('some-other-dir'))),
      T0,
    );

    const { dataset, events } = service(db);
    await dataset.boot();

    // The purge ran before the sync did: the archived (RETAINED) session survives and the
    // live one is gone (§3.18, INV-18); every USER table is untouched (INV-12).
    expect(
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE id = 's-archived'").get()
        ?.n,
    ).toBe(1);
    expect(countRows(db, 'price_rows')).toBe(2);
    expect(countRows(db, 'audit_log')).toBe(1);
    expect(countRows(db, 'archives')).toBe(1);
    expect(countRows(db, 'settings')).toBeGreaterThan(0);

    await dataset.settled();
    expect(events.sync.some((state) => state.kind === 'full')).toBe(true);
    // §5.1 — "READY_EMPTY | first sync completes with ≥1 event | READY".
    expect(dataset.state()).toBe('READY');
  });

  it('stays READY_EMPTY when the first sync finds no events', async () => {
    const db = dbs.openMigrated();
    const claudeDir = sandbox.resolve('claude-empty');
    await mkdir(join(claudeDir, 'projects'), { recursive: true });
    db.prepare(
      'INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('claudeDir', JSON.stringify(claudeDir), T0, T0);

    const { dataset } = service(db);
    await dataset.boot();
    await dataset.settled();

    expect(dataset.state()).toBe('READY_EMPTY');
  });
});

describe('SM-1 — settings:set claudeDir (§4.3, §5.1)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('validates first and never partially applies', async () => {
    const db = dbs.openMigrated();
    const { dataset } = service(db);
    await dataset.boot();

    const rejected = await dataset
      .setSetting('claudeDir', sandbox.resolve('nowhere'))
      .catch((cause: unknown) => cause);

    expect(isHandlerError(rejected)).toBe(true);
    expect(isHandlerError(rejected) ? rejected.code : null).toBe('E_DIR_NOT_FOUND');
    // ⚠️ Nothing was written: the rejected path is not in the table, so it cannot become the
    // configured directory on the next launch, and no purge was triggered.
    expect(countRows(db, 'settings')).toBe(0);
    expect(dataset.state()).toBe('NO_DIR');
  });

  it('NO_DIR → VALIDATING → READY_EMPTY on a valid path, and persists it', async () => {
    const db = dbs.openMigrated();
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    const { dataset, events } = service(db);
    await dataset.boot();

    const snapshot = await dataset.setSetting('claudeDir', claudeDir);
    await dataset.settled();

    expect(snapshot.claudeDir).toBe(claudeDir);
    expect(dataset.state()).toBe('READY');
    expect(events.dirStatus).toContain('valid');
    expect(dataset.settingsSnapshot().claudeDir).toBe(claudeDir);
  });

  it('setting claudeDir back to null returns to onboarding without purging', async () => {
    const db = dbs.openMigrated();
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    const { dataset } = service(db);
    await dataset.boot();
    await dataset.setSetting('claudeDir', claudeDir);
    await dataset.settled();
    const events = countRows(db, 'events');
    expect(events).toBeGreaterThan(0);

    await dataset.setSetting('claudeDir', null);

    expect(dataset.state()).toBe('NO_DIR');
    expect(dataset.dirStatus()).toBe('unset');
    // The user said "no directory", not "throw away what you parsed" (ADR-026).
    expect(countRows(db, 'events')).toBe(events);
  });

  it('refuses a Claude data directory that would contain the database (§9.3)', async () => {
    const db = dbs.openMigrated();
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    const { dataset } = service(db, {
      assertClaudeDirUsable: (dir: string) => {
        throw new Error(`the database is inside ${dir}`);
      },
    });
    await dataset.boot();

    const rejected = await dataset.setSetting('claudeDir', claudeDir).catch((c: unknown) => c);
    expect(isHandlerError(rejected) ? rejected.code : null).toBe('E_DIR_INVALID');
  });
});

describe('SM-1 — a directory that disappears while READY (§5.1)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('stays READY, emits evt:dirStatus, stops the watcher, and keeps the parsed data', async () => {
    const db = dbs.openMigrated();
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));

    let lost: ((cause: unknown) => void) | null = null;
    const { dataset, events } = service(db, {
      watchFactory: () => ({
        on(event: 'all' | 'error', listener: unknown): unknown {
          if (event === 'error') lost = listener as (cause: unknown) => void;
          return this;
        },
        close: () => Promise.resolve(),
      }),
    });
    await dataset.boot();
    await dataset.setSetting('claudeDir', claudeDir);
    await dataset.settled();
    expect(dataset.state()).toBe('READY');
    const parsed = countRows(db, 'events');
    expect(parsed).toBeGreaterThan(0);

    await rm(claudeDir, { recursive: true, force: true });
    expect(lost).not.toBeNull();
    (lost as unknown as (cause: unknown) => void)(new Error('ENOENT'));
    await vi.waitFor(() => expect(events.dirStatus).toContain('not_found'));

    // ⚠️ The whole point of the row: cached data keeps rendering with a stale banner. Not a
    // blank screen, not zeroes, and NOT a purge.
    expect(dataset.state()).toBe('READY');
    expect(dataset.watcherState()).toBe('STOPPED');
    expect(countRows(db, 'events')).toBe(parsed);
  });
});

describe('SM-5 seam — the guarded-action bracket (§5.6)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('suspends and resumes the live watcher, so E10 never reaches past this seam', async () => {
    const db = dbs.openMigrated();
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    const { dataset } = service(db);
    await dataset.boot();
    await dataset.setSetting('claudeDir', claudeDir);
    await dataset.settled();

    expect(dataset.watcherState()).toBe('WATCHING');
    dataset.suspendWatcher();
    expect(dataset.watcherState()).toBe('SUSPENDED');
    dataset.resumeWatcher();
    expect(dataset.watcherState()).toBe('WATCHING');
    // Resume runs "one explicit incremental sync" (§5.6); let it finish before teardown
    // removes the sandbox out from under it.
    await dataset.settled();
  });
});

describe('§3.17 meta bookkeeping — the half E3 left to E6', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('writes every §3.17 key after a completed cycle', async () => {
    const db = dbs.openMigrated();
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    const { dataset, events } = service(db);
    await dataset.boot();
    await dataset.setSetting('claudeDir', claudeDir);
    await dataset.settled();

    const meta = dataset.meta.snapshot();
    expect(meta.lastSyncCompletedAt).toBe(T0);
    expect(meta.lastSyncDurationMs).toBe(0); // injected clock: start and finish are both T0
    expect(meta.lastSyncKind).toBe('full');
    expect(meta.lastFullParseAt).toBe(T0);
    expect(meta.claudeDirFingerprint).toBe(claudeDirFingerprint(claudeDir));
    expect(meta.recordCounts?.events).toBe(1);
    expect(meta.badLineTotal).toBe(0);
    expect(meta.unlinkedSubagentRuns).toBe(0);

    // §4.9 — one `evt:dataChanged`, with scopes, for the cycle that wrote something.
    expect(events.dataChanged).toHaveLength(1);
    expect(events.dataChanged[0]?.scopes).toEqual([
      'events',
      'sessions',
      'projects',
      'tools',
      'prompts',
    ]);
  });

  it('emits no evt:dataChanged for a cycle that wrote nothing (P-18)', async () => {
    const db = dbs.openMigrated();
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    const { dataset, events } = service(db);
    await dataset.boot();
    await dataset.setSetting('claudeDir', claudeDir);
    await dataset.settled();
    expect(events.dataChanged).toHaveLength(1);

    // Nothing changed on disk. The second cycle parses no file and must invalidate nothing.
    dataset.startSync('incremental');
    await dataset.settled();
    expect(events.dataChanged).toHaveLength(1);
  });
});

describe('§4.3 app:bootstrap', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('answers on an unsynced database, where every disclosure is genuinely zero', async () => {
    const { dataset } = service(dbs.openRaw());
    await dataset.boot();

    const bootstrap = dataset.bootstrap();
    expect(bootstrap.dirStatus).toBe('unset');
    expect(bootstrap.settings.claudeDir).toBeNull();
    expect(bootstrap.sync.phase).toBe('idle');
    expect(bootstrap.coverage.transcriptsFrom).toBeNull();
    expect(bootstrap.disclosures.uncosted.records).toBe(0);
  });

  it('answers from the metric layer once the database has been populated (E12)', async () => {
    // ⚠️ **AMENDED 2026-07-22 (E12).** This test previously asserted the *opposite*: that
    // bootstrap throws `E_INTERNAL` on a populated database. That was the correct E6 assertion
    // while `coverage` (M-16) and `disclosures.activeOverlapSeconds` (M-20) had no
    // implementation — but E4 landed, the `notImplemented` branch was never removed, and the
    // app's front door therefore answered with an error over a complete dataset. The test
    // faithfully pinned the gap in place.
    //
    // ⚠️ The values are still not zero-filled: they come from `AnalyticsRepository`, the same
    // one `q:disclosures` uses, so bootstrap and the disclosure channel cannot disagree.
    const db = dbs.openMigrated();
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    const { dataset } = service(db);
    await dataset.boot();
    await dataset.setSetting('claudeDir', claudeDir);
    await dataset.settled();

    const bootstrap = dataset.bootstrap();
    expect(bootstrap.dirStatus).toBe('valid');
    // The two fields E6 named as the reason it could not answer at all.
    expect(typeof bootstrap.disclosures.activeOverlapSeconds).toBe('number');
    expect(bootstrap.coverage.partialBefore === null).toBe(true);
    // …and they are the SAME numbers `q:disclosures` reports for the unfiltered scope.
    const unfiltered = dataset.disclosures(
      dataset.queryContext({ projectIds: null, from: null, to: null }),
    );
    expect(bootstrap.disclosures).toEqual(unfiltered);
  });
});

describe('§4.4 sync:start (§5.2 rules 1–2)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('raises E_NO_DIR rather than syncing nothing', async () => {
    const { dataset } = service(dbs.openMigrated());
    await dataset.boot();
    expect(() => dataset.startSync('incremental')).toThrow();
    try {
      dataset.startSync('incremental');
    } catch (cause) {
      expect(isHandlerError(cause) ? cause.code : null).toBe('E_NO_DIR');
    }
  });
});
