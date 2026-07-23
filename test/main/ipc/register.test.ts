// §4.1 / ADR-031 — the one `withResult()` wrapper, and the completeness of the channel map.

import { describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IpcHandlerMap, Result } from '../../../src/shared/ipc-contract';
import { DatasetService } from '../../../src/main/ipc/dataset';
import { HandlerError, notImplemented, toAppError, withResult } from '../../../src/main/ipc/errors';
import { createHandlers, registerIpc, unregisterIpc } from '../../../src/main/ipc/register';
import { Logger, silentLogger } from '../../../src/main/log/logger';
import { PricingService } from '../../../src/main/pricing';
import { ActionService } from '../../../src/main/actions/service';
import { HarnessService } from '../../../src/main/harness/service';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';
import type { WatchHandle } from '../../../src/main/watcher/watcher';
import { useSandbox } from '../../support/sandbox';
import { T0, useTestDatabases } from '../db/helpers';

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

/**
 * E10's two services (§4.8). They take the Claude data directory as a parameter and read it live
 * from SM-1 (INV-17), so a dataset with no directory configured gives every E10 channel the same
 * `E_NO_DIR` the rest of §4 gives it.
 */
function e10Services(
  db: SqliteDatabase,
  dataset: DatasetService,
): { harness: HarnessService; actions: ActionService } {
  return {
    harness: new HarnessService({ db, claudeDir: () => dataset.claudeDir(), now: () => T0 }),
    actions: new ActionService({
      db,
      logger: silentLogger(),
      claudeDir: () => dataset.claudeDir(),
      archiveRoot: () => dataset.settingsSnapshot().archiveRoot,
      suspendWatcher: () => dataset.suspendWatcher(),
      resumeWatcher: () => dataset.resumeWatcher(),
      now: () => T0,
      onActionCompleted: () => undefined,
    }),
  };
}

async function build(
  db: SqliteDatabase,
  sandbox: { resolve: (...s: string[]) => string },
): Promise<{ handlers: IpcHandlerMap; dataset: DatasetService }> {
  const dataset = new DatasetService({
    db,
    logger: silentLogger(),
    now: () => T0,
    watchFactory: () => inertWatch(),
  });
  await dataset.boot();
  const pricing = new PricingService({
    db,
    settings: () => '',
    now: () => T0,
  });
  const handlers = createHandlers({
    dataset,
    pricing,
    ...e10Services(db, dataset),
    logger: silentLogger(),
    pickDirectory: () => Promise.resolve(sandbox.resolve('picked')),
  });
  return { handlers, dataset };
}

describe('the channel map is complete (§4 preamble, ADR-031)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('registers every channel the contract declares, and only those', async () => {
    // ⚠️ Completeness is a COMPILE-time property: `IpcHandlerMap` is a mapped type over every
    // channel, so a missing or invented one fails `typecheck`. This test asserts the runtime
    // consequence — that `registerIpc` actually hands each of them to `ipcMain` — rather than
    // duplicating the channel list, which is the drift the one-map design exists to prevent.
    const { handlers } = await build(dbs.openMigrated(), sandbox);
    const registered: string[] = [];
    registerIpc(
      {
        handle: (channel) => registered.push(channel) as unknown as void,
        removeHandler: () => undefined,
      },
      handlers,
      silentLogger(),
    );

    expect(registered.sort()).toEqual(Object.keys(handlers).sort());
    // A representative from each §4 group, so a whole section going missing is visible here.
    for (const channel of [
      'app:bootstrap',
      'settings:set',
      'dir:validate',
      'sync:start',
      'q:overviewTiles',
      'q:uncosted',
      'pricing:list',
      'action:execute',
      'archives:candidates',
    ]) {
      expect(registered).toContain(channel);
    }
  });

  it('unregisters every channel on quit', async () => {
    const { handlers } = await build(dbs.openMigrated(), sandbox);
    const removed: string[] = [];
    const channels = registerIpc(
      { handle: () => undefined, removeHandler: (channel) => removed.push(channel) },
      handlers,
      silentLogger(),
    );
    unregisterIpc({ handle: () => undefined, removeHandler: (c) => removed.push(c) }, channels);
    expect(removed.sort()).toEqual([...channels].sort());
  });
});

describe('withResult() — no exception ever crosses the boundary (§4.1 rule 1)', () => {
  const sandbox = useSandbox();

  it('turns an uncaught throw into E_INTERNAL with the stack in detail, and logs it', async () => {
    const lines: string[] = [];
    const logger = new Logger({
      filePath: sandbox.resolve('claude-lens.log'),
      sink: (line) => lines.push(line),
      now: () => T0,
    });
    const wrapped = withResult(
      'q:overviewTiles',
      () => {
        throw new Error('the repository exploded');
      },
      logger,
    );

    const result = await wrapped({ projectIds: null, from: null, to: null });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('E_INTERNAL');
    // ⚠️ The user-facing sentence is never the stack. §4.1: "one sentence, user-facing, never
    // a stack trace"; the stack goes behind `detail`, rendered only under "Details".
    expect(result.error.message).not.toContain('the repository exploded');
    expect(result.error.message).not.toContain('at ');
    expect(result.error.detail).toContain('the repository exploded');
    expect(result.error.retryable).toBe(false);
    // …and it reached the main-process log, once.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('E_INTERNAL');
  });

  it('keeps a carried code rather than flattening it (§4.1 rule 2)', async () => {
    const wrapped = withResult(
      'sync:start',
      () => {
        throw new HandlerError('E_SYNC_BUSY', 'A sync is already running.', { retryable: true });
      },
      silentLogger(),
    );
    const result = await wrapped({ kind: 'full' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('E_SYNC_BUSY');
    expect(result.error.retryable).toBe(true);
  });

  it('passes a Result through unchanged — double wrapping is a no-op', async () => {
    const inner: Result<{ rows: never[] }> = { ok: true, data: { rows: [] } };
    const wrapped = withResult('pricing:list', () => inner, silentLogger());
    expect(await wrapped({ includeHistory: false })).toBe(inner);
  });

  it('never rejects, so the preload always sees a value', async () => {
    const wrapped = withResult(
      'app:bootstrap',
      () => Promise.reject(new Error('async boom')),
      silentLogger(),
    );
    await expect(wrapped(undefined)).resolves.toMatchObject({ ok: false });
  });

  it('maps a non-Error throw without leaking anything odd', () => {
    const error = toAppError('a bare string');
    expect(error.code).toBe('E_INTERNAL');
    expect(error.detail).toBe('a bare string');
  });
});

describe('not-implemented channels return an error, never a zero (CLAUDE.md §1)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('names the channel and the missing owner, and is not retryable', () => {
    const result = notImplemented('q:overviewTiles', 'E4');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('E_INTERNAL');
    expect(result.error.detail).toContain('q:overviewTiles');
    expect(result.error.retryable).toBe(false);
  });

  it('every analytics channel answers over an empty but migrated database (E12)', async () => {
    // ⚠️ **AMENDED 2026-07-22 (E12).** This test used to assert that `q:overviewTiles`,
    // `q:projectCards` and `q:disclosures` **refuse**, on the (then-true) ground that their
    // repositories did not exist. They did exist, and had since E4; the list was described in
    // this file as "BUILD STATE, not a property", and the build state had moved on without it.
    // ⚠️ The rule it protected is unchanged and is asserted below: an empty result set here is a
    // MEASURED absence over a migrated database, not a fabricated one. What has changed is that
    // measuring is now possible, so refusing would itself be the wrong answer.
    const { handlers } = await build(dbs.openMigrated(), sandbox);
    const filter = { projectIds: null, from: null, to: null };

    const tiles = await handlers['q:overviewTiles'](filter);
    expect(tiles.ok).toBe(true);
    // ⚠️ §6.4's rule, at the channel: with no priced events the `$` is `null`, NEVER `$0.00`.
    // That distinction is the entire reason this describe block exists.
    if (tiles.ok) {
      expect(tiles.data.costNanoUsd).toBeNull();
      expect(tiles.data.costNanoUsd).not.toBe(0);
      expect(tiles.data.uncosted.records).toBe(0);
    }

    const cards = await handlers['q:projectCards'](filter);
    expect(cards.ok).toBe(true);
    const disclosures = await handlers['q:disclosures'](filter);
    expect(disclosures.ok).toBe(true);
    const graph = await handlers['q:harnessGraph']({ tab: 'harness' });
    expect(graph.ok).toBe(true);
    const sessions = await handlers['q:sessions']({
      ...filter,
      limit: 10,
      sort: 'firstTs',
      dir: 'desc',
    });
    expect(sessions.ok).toBe(true);
  });

  it('E10 refuses a harness scan with no directory, and does not invent one (INV-17)', async () => {
    // ⚠️ `harness:scan` walks the Claude data directory, so with none configured the honest
    // answer is `E_NO_DIR`. It never falls back to `~/.claude`: `suggestedClaudeDataDir()` is a
    // suggestion for onboarding, never a recovery path, because this is the input to a delete
    // subsystem (`src/main/config/paths.ts`, INV-17, STACK ADR-013).
    const { handlers } = await build(dbs.openMigrated(), sandbox);
    // ⚠️ Through `withResult`, exactly as `registerIpc` applies it: no exception ever crosses
    // the IPC boundary (§4.1 rule 1, ADR-031), so the refusal must arrive as an error `code`.
    const scan = await withResult(
      'harness:scan',
      handlers['harness:scan'],
      silentLogger(),
    )(undefined);
    expect(scan.ok).toBe(false);
    expect(!scan.ok && scan.error.code).toBe('E_NO_DIR');
  });

  it('E10 answers its read-only channels honestly on an unscanned database', async () => {
    // ⚠️ These are NOT fabricated zeroes. `bloat:list` over a database no scan has written is
    // genuinely "no issues found" — §6.9 calls it "a genuine, celebratory empty state, not an
    // error" — and `audit:list` over an app that has performed no guarded action is genuinely
    // empty. The difference from the channels above is that these have an implementation and
    // that implementation was asked; the ones above have none.
    const { handlers } = await build(dbs.openMigrated(), sandbox);

    const bloat = await handlers['bloat:list'](undefined);
    expect(bloat.ok && bloat.data).toEqual({ rows: [], totalReclaimableBytes: 0 });

    const audit = await handlers['audit:list']({ limit: 10 });
    expect(audit.ok && audit.data.rows).toEqual([]);
    expect(audit.ok && audit.data.totalKnown).toBe(0);

    const backups = await handlers['backups:summary'](undefined);
    expect(backups.ok && backups.data).toEqual({
      restorePoints: 0,
      totalBytes: 0,
      oldestTs: null,
      newestTs: null,
    });

    const archives = await handlers['archives:list'](undefined);
    expect(archives.ok && archives.data).toEqual({ rows: [] });
  });

  it('rejects an action type outside the closed catalogue with E_ACTION_UNKNOWN (ADR-032)', async () => {
    const { handlers } = await build(dbs.openMigrated(), sandbox);
    const result = await withResult(
      'action:preview',
      handlers['action:preview'],
      silentLogger(),
    )({
      // The channel is typed, but a type is not a runtime check — the renderer's value arrives
      // as data. ADR-032: "the dispatcher rejects anything else with `E_ACTION_UNKNOWN`."
      actionType: 'delete-everything' as never,
      payload: {},
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('E_ACTION_UNKNOWN');
  });
});

describe('the handlers that ARE implemented', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('answers settings, dir, sync, uncosted and pricing', async () => {
    const claudeDir = sandbox.resolve('claude');
    await mkdir(join(claudeDir, 'projects'), { recursive: true });
    await writeFile(join(claudeDir, 'history.jsonl'), '');
    const db = dbs.openMigrated();
    const { handlers } = await build(db, sandbox);

    const settings = await handlers['settings:get'](undefined);
    expect(settings.ok).toBe(true);

    const validation = await handlers['dir:validate']({ path: claudeDir });
    expect(validation.ok && validation.data.status).toBe('valid');

    const syncState = await handlers['sync:state'](undefined);
    expect(syncState.ok && syncState.data.phase).toBe('idle');

    // M-05/M-06 exist (E5, F-09), so this one is real rather than deferred — and it is
    // delegated to `CostRepository`, never reimplemented (CLAUDE.md §1: defined once).
    const uncosted = await handlers['q:uncosted']({ projectIds: null, from: null, to: null });
    expect(uncosted.ok && uncosted.data.records).toBe(0);
    expect(uncosted.ok && uncosted.data.byModel).toEqual([]);

    const prices = await handlers['pricing:list']({ includeHistory: false });
    expect(prices.ok).toBe(true);
  });

  it('dir:pick reports cancellation as DATA, not as an error (§4.3)', async () => {
    const db = dbs.openMigrated();
    const dataset = new DatasetService({
      db,
      logger: silentLogger(),
      now: () => T0,
      watchFactory: () => inertWatch(),
    });
    await dataset.boot();
    const handlers = createHandlers({
      dataset,
      pricing: new PricingService({ db: dbs.openMigrated('other.db'), settings: () => '' }),
      ...e10Services(db, dataset),
      logger: silentLogger(),
      pickDirectory: () => Promise.resolve(null),
    });

    const result = await handlers['dir:pick'](undefined);
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toEqual({ cancelled: true });
  });

  it('registerIpc delivers the request argument to the handler', async () => {
    const { handlers } = await build(dbs.openMigrated(), sandbox);
    const listeners = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    registerIpc(
      { handle: (channel, listener) => listeners.set(channel, listener) },
      { ...handlers, 'dir:validate': vi.fn(handlers['dir:validate']) },
      silentLogger(),
    );

    const result = (await listeners.get('dir:validate')?.(null, {
      path: sandbox.resolve('nope'),
    })) as Result<{ status: string }>;
    expect(result.ok && result.data.status).toBe('not_found');
  });
});
