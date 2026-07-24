// ⚠️⚠️ **The gate that stops the E4↔E6 gap recurring** (DESIGN §4, ADR-031).
//
// E4 implemented every `q:*` repository and fixture-tested it. E6 built the registration table.
// For seventeen channels the two never met: `register.ts` returned `notImplemented` while a
// finished, tested repository sat one call below, and Overview, Tokens & Cost, Sessions & Time,
// Tools & Agents and Projects & Code all rendered an `ErrorState` in the running app. Every
// individual suite was green the entire time, because **no test in the build called a handler.**
// `typecheck` could not see it either: `notImplementedHandler` satisfies `IpcHandler<C>`.
//
// So this file calls **every channel in the contract**, against a real sandboxed database seeded
// through the real parser, and asserts each answers `ok: true` with a payload of the right shape.
//
// ⚠️ **It is exhaustive by construction, not by a hand-written list.** `CHANNEL_PLAN` is a mapped
// type over `IpcChannel`, so a channel added to §4 that nobody plans here is a **compile error**,
// and the channels it iterates are `Object.keys(handlers)` — which `IpcHandlerMap` already
// guarantees is exactly the contract's key set. A new channel is covered automatically or the
// build is red; there is no third outcome.
//
// ⚠️ **The allowlist is `skip`, it is small, and every entry states why in one line.** A skipped
// channel is still forced to have a plan entry, so "skipping" is a visible decision rather than
// an omission. Nothing here is skipped for being inconvenient — only for invoking the filesystem
// mutation subsystem, or for needing the network.

import { mkdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type {
  IpcChannel,
  IpcHandlerMap,
  IpcRequest,
  IpcResponse,
  Result,
} from '../../src/shared/ipc-contract';
import { ActionService } from '../../src/main/actions/service';
import { HarnessService } from '../../src/main/harness/service';
import { DatasetService } from '../../src/main/ipc/dataset';
import { createHandlers } from '../../src/main/ipc/register';
import { silentLogger } from '../../src/main/log/logger';
import { openDatabase } from '../../src/main/db/driver';
import type { SqliteDatabase } from '../../src/main/db/sqlite';
import type { WatchHandle } from '../../src/main/watcher/watcher';
import { PricingService } from '../../src/main/pricing';
import { useSandbox, type Sandbox } from '../support/sandbox';
import { fixturePath, FIXED_NOW } from '../support/sync-harness';

/** SM-5 is not under test here; a watch that never fires keeps the cycle deterministic. */
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
 * Facts discovered from the seeded dataset, so requests name **real** ids.
 *
 * ⚠️ A `sessionId` of `'anything'` would make `q:sessionDetail` answer with a legitimate error
 * and this test would then be asserting that a channel fails politely — the opposite of its job.
 */
interface Discovered {
  readonly sessionId: string;
  readonly projectId: number;
  readonly priceRowId: number;
  readonly claudeDir: string;
  /** ADR-040 — §3.3 identities, which is what a group is made of. Never `projects.id`. */
  readonly encodedNames: string[];
}

/** One channel's plan: either a reason to skip it, or a request and a shape assertion. */
type ChannelCase<C extends IpcChannel> =
  | {
      /** The one-line reason. Present ⇒ the channel is not invoked. */
      readonly skip: string;
    }
  | {
      readonly request: (found: Discovered) => IpcRequest<C>;
      /** Asserts the payload's shape. Runs only on `ok: true`. */
      readonly shape: (data: IpcResponse<C>) => void;
    };

/**
 * ⚠️ Total over `IpcChannel`. **This mapped type is the mechanism.** Adding
 * `'q:whatever'` to `IpcChannels` without adding a row here does not compile.
 */
type ChannelPlan = { [C in IpcChannel]: ChannelCase<C> };

const ALL_FILTER = { projectIds: null, from: null, to: null };
const PAGE = { limit: 25 };

/** Every payload is an object; these two helpers keep each row to one line. */
function isObject(value: unknown): void {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
}

function isRowsOf(value: { rows: unknown[] }): void {
  isObject(value);
  expect(Array.isArray(value.rows)).toBe(true);
}

function isPaged(value: { rows: unknown[]; nextCursor: string | null }): void {
  isRowsOf(value);
  // §4.2 — `nextCursor` is `null` at the end of a result set, never absent.
  expect(value.nextCursor === null || typeof value.nextCursor === 'string').toBe(true);
}

function isGraph(value: { nodes: unknown[]; edges: unknown[] }): void {
  expect(Array.isArray(value.nodes)).toBe(true);
  expect(Array.isArray(value.edges)).toBe(true);
}

/**
 * ⚠️ Every `$`-carrying payload's disclosure, asserted structurally (INV-10). A missing
 * `uncosted` here is the exact failure INV-10 names — a cost with no way to know it is complete.
 */
function hasUncosted(value: { uncosted: { records: number; byModel: unknown[] } }): void {
  isObject(value);
  expect(typeof value.uncosted.records).toBe('number');
  expect(Array.isArray(value.uncosted.byModel)).toBe(true);
}

/**
 * ADR-040 — the id `groups:create` produced, so `groups:rename` and `groups:ungroup` can name a
 * group that really exists. Written by one plan entry and read by the two that run after it,
 * which the sweep's insertion order guarantees.
 */
let createdGroupId: number | null = null;

const CHANNEL_PLAN: ChannelPlan = {
  // ---- §4.3 ----
  'app:bootstrap': {
    request: () => undefined,
    shape: (data) => {
      isObject(data);
      expect(typeof data.schemaVersion).toBe('number');
      // ⚠️ E6 shipped this returning `notImplemented` on a populated database. It is the
      // renderer's front door — an error here is a blank app over a full dataset.
      isObject(data.coverage);
      hasUncosted(data.disclosures);
      expect(typeof data.disclosures.activeOverlapSeconds).toBe('number');
    },
  },
  'settings:get': {
    request: () => undefined,
    shape: (data) => {
      isObject(data);
      expect(typeof data.idleGapMinutes).toBe('number');
    },
  },
  'settings:set': {
    request: () => ({ key: 'theme', value: 'dark' }),
    shape: (data) => {
      expect(data.theme).toBe('dark');
    },
  },
  'dir:pick': {
    request: () => undefined,
    shape: (data) => {
      // §4.3 — cancellation is data. The injected picker returns the sandbox fixture root.
      expect(data.cancelled).toBe(false);
    },
  },
  'dir:validate': {
    request: (found) => ({ path: found.claudeDir }),
    shape: (data) => {
      expect(data.status).toBe('valid');
    },
  },

  // ---- §4.4 ----
  'sync:start': {
    request: () => ({ kind: 'incremental' as const }),
    shape: (data) => {
      expect(typeof data.phase).toBe('string');
    },
  },
  'sync:cancel': {
    request: () => undefined,
    shape: (data) => {
      expect(typeof data.phase).toBe('string');
    },
  },
  'sync:state': {
    request: () => undefined,
    shape: (data) => {
      expect(typeof data.phase).toBe('string');
    },
  },
  'sync:rebuild': {
    skip: 'A-16 / §3.18 — it DELETES every DERIVED row and starts a cold re-parse. Invoking it mid-sweep would purge the dataset the fifty channels after it are asserted against, and `q:sessionDetail` would then be asserting its own error path. `test/main/sync/rebuild.test.ts` drives it end to end against a real parsed directory.',
  },

  // ---- §4.5 — the seventeen ----
  'q:overviewTiles': {
    request: () => ALL_FILTER,
    shape: (data) => {
      hasUncosted(data);
      expect(typeof data.outputTokens).toBe('number');
      // ⚠️ M-07 binding (C) and its mandatory M-20 companion (INV-23), both present.
      expect(typeof data.activeSeconds).toBe('number');
      expect(typeof data.overlapSeconds).toBe('number');
    },
  },
  'q:activityCalendar': {
    request: () => ({ ...ALL_FILTER, weeks: 12 }),
    shape: (data) => {
      expect(Array.isArray(data.days)).toBe(true);
    },
  },
  'q:modelMixTimeline': {
    request: () => ({ ...ALL_FILTER, bucket: 'day' as const }),
    shape: (data) => {
      expect(Array.isArray(data.buckets)).toBe(true);
      expect(Array.isArray(data.series)).toBe(true);
    },
  },
  'q:tokensByModel': {
    request: () => ({ ...ALL_FILTER, bucket: 'day' as const, mode: 'all' as const }),
    shape: (data) => {
      expect(Array.isArray(data.buckets)).toBe(true);
      expect(Array.isArray(data.series)).toBe(true);
    },
  },
  'q:tokensByProject': { request: () => ALL_FILTER, shape: (data) => hasUncosted(data) },
  'q:cacheEfficiency': {
    request: () => ALL_FILTER,
    shape: (data) => {
      // M-18 — a ratio in [0,1], never a percentage and never NaN on a zero denominator.
      expect(data.hitRatio).toBeGreaterThanOrEqual(0);
      expect(data.hitRatio).toBeLessThanOrEqual(1);
    },
  },
  'q:contextOverhead': {
    request: () => ALL_FILTER,
    shape: (data) => {
      // A-11 — two raw totals and a leaderboard array; no ratio on the wire (it is derived in
      // the renderer). Both totals are real numbers, `0` included.
      expect(typeof data.cacheReadTokens).toBe('number');
      expect(typeof data.outputTokens).toBe('number');
      expect(Array.isArray(data.sessions)).toBe(true);
    },
  },
  'q:costBreakdown': {
    request: () => ({ ...ALL_FILTER, by: 'model' as const }),
    shape: (data) => {
      isRowsOf(data);
      hasUncosted(data);
    },
  },
  'q:sessionHistogram': {
    request: () => ALL_FILTER,
    shape: (data) => {
      // §6.5's axis is a fixed closed set, so the buckets are always present.
      expect(data.buckets.length).toBeGreaterThan(0);
    },
  },
  'q:rhythmHeatmap': {
    request: () => ALL_FILTER,
    shape: (data) => {
      expect(Array.isArray(data.cells)).toBe(true);
    },
  },
  'q:workingDays': { request: () => ({ ...ALL_FILTER, ...PAGE }), shape: (data) => isPaged(data) },
  'q:sessions': {
    request: () => ({ ...ALL_FILTER, ...PAGE, sort: 'firstTs' as const, dir: 'desc' as const }),
    shape: (data) => {
      isPaged(data.page);
      hasUncosted(data);
    },
  },
  'q:sessionDetail': {
    request: (found) => ({ sessionId: found.sessionId }),
    shape: (data) => {
      hasUncosted(data);
      expect(Array.isArray(data.subagentRuns)).toBe(true);
      expect(Array.isArray(data.toolCounts)).toBe(true);
    },
  },
  'q:toolFingerprint': {
    request: () => ALL_FILTER,
    shape: (data) => {
      isRowsOf(data);
      expect(typeof data.distinct).toBe('number');
    },
  },
  'q:originSplit': {
    request: () => ALL_FILTER,
    shape: (data) => {
      // INV-02's two halves must both be present, or the roll-up cannot be checked at all.
      isObject(data.main);
      isObject(data.subagent);
    },
  },
  'q:toolMixByProject': {
    request: () => ({ ...ALL_FILTER, topN: 5 }),
    shape: (data) => {
      expect(Array.isArray(data.projects)).toBe(true);
    },
  },
  'q:projectCards': { request: () => ALL_FILTER, shape: (data) => hasUncosted(data) },
  // ---- ADR-040 — the user's project groups. Read here; the mutations are exercised end to end
  // in `test/main/db/project-groups.test.ts` and `test/metrics/f16-grouped-active-time.test.ts`.
  // ---- ADR-040 — the four grouping channels, exercised for real and IN ORDER.
  //
  // ⚠️ The sweep walks `Object.keys(handlers)`, which is the registration table's insertion
  // order, so these four run list → create → rename → ungroup. `create`'s shape callback records
  // the id it produced so the two that follow name a group that genuinely exists — the same rule
  // the rest of this file follows ("a request that names nothing tests the error path, which
  // reads as coverage and is not").
  //
  // ⚠️ The dataset ends this sweep with NO group, because `ungroup` runs last. That is
  // deliberate: this file must not leave a grouping behind that a later assertion silently
  // inherits.
  'groups:list': { request: () => undefined, shape: (data) => isRowsOf(data) },
  'groups:create': {
    request: (found) => ({ name: 'Same project', encodedNames: found.encodedNames }),
    shape: (data) => {
      isRowsOf(data);
      expect(data.rows).toHaveLength(1);
      createdGroupId = data.rows[0]?.id ?? null;
      expect(data.rows[0]?.members.length).toBeGreaterThanOrEqual(2);
    },
  },
  'groups:rename': {
    request: () => ({ groupId: createdGroupId ?? 0, name: 'Same project, renamed' }),
    shape: (data) => {
      expect(data.rows[0]?.name).toBe('Same project, renamed');
    },
  },
  'groups:ungroup': {
    request: () => ({ groupId: createdGroupId ?? 0 }),
    shape: (data) => {
      // Splitting the group back apart leaves nothing behind — the grouping was only a label.
      expect(data.rows).toHaveLength(0);
    },
  },
  'q:fileMetrics': {
    request: (found) => ({ ...ALL_FILTER, ...PAGE, projectId: found.projectId }),
    shape: (data) => isPaged(data),
  },

  // ---- §6.7's four graph channels ----
  'q:harnessGraph': {
    request: () => ({ tab: 'harness' as const }),
    shape: (data) => isGraph(data),
  },
  'q:executionTrace': {
    request: (found) => ({ sessionId: found.sessionId }),
    shape: (data) => {
      isGraph(data);
      expect(Array.isArray(data.timeline)).toBe(true);
      expect(typeof data.unlinkedRuns).toBe('number');
    },
  },
  'q:toolTransition': { request: () => ALL_FILTER, shape: (data) => isGraph(data) },
  'q:flowSankey': {
    request: () => ALL_FILTER,
    shape: (data) => {
      expect(Array.isArray(data.nodes)).toBe(true);
      expect(Array.isArray(data.links)).toBe(true);
    },
  },

  // ---- §6.9's four ⛔ INV-13 channels ----
  'q:skills': {
    request: () => ({ ...PAGE, sort: 'never_used' as const }),
    shape: (data) => isPaged(data),
  },
  'q:claudeMdFiles': { request: () => undefined, shape: (data) => isRowsOf(data) },
  'q:plugins': {
    request: () => undefined,
    shape: (data) => {
      expect(Array.isArray(data.plugins)).toBe(true);
      expect(Array.isArray(data.marketplaces)).toBe(true);
    },
  },
  'q:memories': { request: () => undefined, shape: (data) => isRowsOf(data) },
  // ADR-039 — §6.9's per-project sections. Read-only; each row is one project's own harness.
  'q:harnessProjects': { request: () => undefined, shape: (data) => isRowsOf(data) },

  // ---- §4.6 ----
  'q:disclosures': {
    request: () => ALL_FILTER,
    shape: (data) => {
      hasUncosted(data);
      // The two fields E6 named as the reason it could not answer at all.
      expect(typeof data.activeOverlapSeconds).toBe('number');
      expect(data.partialBefore === null || typeof data.partialBefore === 'number').toBe(true);
      expect(typeof data.badLines).toBe('number');
      expect(typeof data.syntheticEvents).toBe('number');
      expect(typeof data.unlinkedSubagentRuns).toBe('number');
      expect(typeof data.filesMissingSinceLastSync).toBe('number');
    },
  },
  'q:uncosted': {
    request: () => ALL_FILTER,
    shape: (data) => {
      expect(typeof data.records).toBe('number');
      expect(Array.isArray(data.byModel)).toBe(true);
    },
  },

  // ---- §4.7 Pricing ----
  'pricing:list': {
    request: () => ({ includeHistory: false }),
    shape: (data) => isRowsOf(data),
  },
  'pricing:upsertRate': {
    request: () => ({
      model: 'claude-lens-integration-model',
      tokenClass: 'input' as const,
      usdPerMillion: 1.5,
    }),
    shape: (data) => isRowsOf(data),
  },
  'pricing:setDates': {
    request: (found) => ({ id: found.priceRowId, validFrom: 0, validTo: null }),
    shape: (data) => isRowsOf(data),
  },
  'pricing:deleteRow': {
    request: (found) => ({ id: found.priceRowId }),
    shape: (data) => isRowsOf(data),
  },
  'pricing:fetch': {
    skip: '§5.8 / INV-15 — the one network egress point. No test in this build performs real network I/O.',
  },
  'pricing:resetToSeed': {
    request: () => undefined,
    shape: (data) => {
      expect(Array.isArray(data.applied)).toBe(true);
    },
  },
  'pricing:models': { request: () => undefined, shape: (data) => isRowsOf(data) },

  // ---- §4.8 ----
  'harness:scan': {
    request: () => undefined,
    shape: (data) => {
      expect(typeof data.nodes).toBe('number');
    },
  },
  'bloat:list': { request: () => undefined, shape: (data) => isRowsOf(data) },
  'action:preview': {
    // ⚠️ Read-only by contract (§4.8: "it mutates nothing — not the filesystem, not the
    // database"). ACT-01 over a fixture with no `skills/` resolves zero targets, which is a
    // real answer; the point here is that the channel answers at all.
    request: () => ({ actionType: 'delete-orphan-skill-folders' as const, payload: {} }),
    shape: (data) => {
      expect(Array.isArray(data.targets)).toBe(true);
      expect(typeof data.confirmToken).toBe('string');
    },
  },
  'action:execute': {
    skip: 'ACT-01…07 delete or move real files (§5.5, ADR-032). A shape test never invokes a guarded action; E10 owns their fixtures.',
  },
  'action:undoLast': {
    skip: 'Restores a backup over live files (§5.5 rule 4). Same rule as `action:execute` — never invoked here.',
  },
  'audit:list': { request: () => PAGE, shape: (data) => isPaged(data) },
  'backups:summary': {
    request: () => undefined,
    shape: (data) => {
      expect(typeof data.restorePoints).toBe('number');
    },
  },
  'archives:list': { request: () => undefined, shape: (data) => isRowsOf(data) },
  'archives:candidates': {
    request: () => ({ olderThanTs: FIXED_NOW, projectIds: null }),
    shape: (data) => {
      expect(Array.isArray(data.sessions)).toBe(true);
    },
  },
};

/**
 * One channel, generically — which is what keeps `IpcRequest<C>` correlated with
 * `IpcResponse<C>`. Indexing the plan with the bare `IpcChannel` union would collapse the
 * correlation and force a cast, and a cast here would hide precisely the mismatch this file
 * exists to catch (the same reasoning as `registerOne` in `src/main/ipc/register.ts`).
 */
async function callOne<C extends IpcChannel>(
  channel: C,
  handlers: IpcHandlerMap,
  found: Discovered,
): Promise<{ skipped: string } | { result: Result<IpcResponse<C>> }> {
  const plan = CHANNEL_PLAN[channel];
  if ('skip' in plan) return { skipped: plan.skip };
  const result = await handlers[channel](plan.request(found));
  if (result.ok) plan.shape(result.data);
  return { result };
}

interface Rig {
  readonly handlers: IpcHandlerMap;
  readonly found: Discovered;
  readonly db: SqliteDatabase;
}

/**
 * The real stack over one sandbox: a real Claude data directory (a copied fixture tree), a real
 * SQLite file **outside** it (§9.3), the real parser via SM-2, and E5/E10's real services.
 *
 * ⚠️ Nothing is stubbed except the watcher and the directory dialog. A rig that faked the
 * repositories would re-create the exact blindness this file exists to remove.
 */
async function buildRig(sandbox: Sandbox): Promise<Rig> {
  const claudeDir = await sandbox.copyFixture(fixturePath('f03-append/base'), 'claude');
  // §6.9 / BR-01 — a CLAUDE.md so the harness scan has something to find, written into the
  // sandbox copy rather than committed, so `test/fixtures/**` stays diff-clean (ADR-013).
  await writeFile(`${claudeDir}/CLAUDE.md`, '# fixture harness file\n', 'utf8');
  await mkdir(`${claudeDir}/skills`, { recursive: true });

  const db = openDatabase(sandbox.resolve('lens.db'));
  const dataset = new DatasetService({
    db,
    logger: silentLogger(),
    now: () => FIXED_NOW,
    watchFactory: () => inertWatch(),
  });
  await dataset.boot();

  const pricing = new PricingService({
    db,
    settings: () => dataset.settingsSnapshot().priceFetchUrl,
    now: () => FIXED_NOW,
  });
  pricing.seedIfEmpty();

  const harness = new HarnessService({
    db,
    claudeDir: () => dataset.claudeDir(),
    now: () => FIXED_NOW,
  });
  const actions = new ActionService({
    db,
    logger: silentLogger(),
    claudeDir: () => dataset.claudeDir(),
    archiveRoot: () => dataset.settingsSnapshot().archiveRoot,
    suspendWatcher: () => {
      dataset.suspendWatcher();
    },
    resumeWatcher: () => {
      dataset.resumeWatcher();
    },
    now: () => FIXED_NOW,
    onActionCompleted: () => undefined,
  });

  const handlers = createHandlers({
    dataset,
    pricing,
    harness,
    actions,
    logger: silentLogger(),
    pickDirectory: () => Promise.resolve(claudeDir),
  });

  // §5.1 — the real transition: validate, purge DERIVED, full sync. Everything below runs
  // against rows the real parser wrote.
  const applied = await handlers['settings:set']({ key: 'claudeDir', value: claudeDir });
  expect(applied.ok).toBe(true);
  await dataset.settled();
  await harness.scan();

  const sessions = await handlers['q:sessions']({
    ...ALL_FILTER,
    ...PAGE,
    sort: 'firstTs',
    dir: 'asc',
  });
  if (!sessions.ok) throw new Error(`the rig could not list sessions: ${sessions.error.detail}`);
  const sessionId = sessions.data.page.rows[0]?.id;
  const projectId = sessions.data.page.rows[0]?.projectId;

  // ADR-040 — the §3.3 identities of the parsed projects. The fixture has two, which is exactly
  // what `groups:create` needs to be exercised for real rather than through its refusal path.
  const cards = await handlers['q:projectCards'](ALL_FILTER);
  if (!cards.ok) throw new Error(`the rig could not list projects: ${cards.error.detail}`);
  const encodedNames = cards.data.rows.flatMap((row) =>
    row.members.map((member) => member.encodedName),
  );

  const prices = await handlers['pricing:list']({ includeHistory: false });
  if (!prices.ok) throw new Error(`the rig could not list prices: ${prices.error.detail}`);
  const priceRowId = prices.data.rows[0]?.id;

  // §12.2 — **fail loudly rather than skip.** A rig that quietly produced no session would turn
  // every id-taking channel into a test of its own error path, which reads as coverage and is not.
  if (
    sessionId === undefined ||
    projectId === undefined ||
    priceRowId === undefined ||
    encodedNames.length < 2
  ) {
    throw new Error(
      'the fixture did not seed a session, a price row and at least two projects; the ' +
        'exhaustive channel sweep cannot run against ids it does not have (DESIGN §12.2).',
    );
  }
  createdGroupId = null;

  return { handlers, found: { sessionId, projectId, priceRowId, claudeDir, encodedNames }, db };
}

describe('every §4 channel answers over a real parsed dataset (ADR-031, §12.2)', () => {
  const sandbox = useSandbox();

  it('returns ok:true with a payload of the right shape on every channel', async () => {
    const rig = await buildRig(sandbox);
    // ⚠️ The channel list is the REGISTRATION TABLE's own key set, and `IpcHandlerMap` is a
    // mapped type over `IpcChannel` — so this is the contract's channel set, obtained without a
    // second hand-maintained copy of it (§4 preamble).
    const channels = Object.keys(rig.handlers) as IpcChannel[];

    const failures: string[] = [];
    const skipped: string[] = [];
    let called = 0;

    for (const channel of channels) {
      const outcome = await callOne(channel, rig.handlers, rig.found);
      if ('skipped' in outcome) {
        skipped.push(channel);
        continue;
      }
      called += 1;
      if (!outcome.result.ok) {
        failures.push(
          `${channel}: ${outcome.result.error.code} — ${outcome.result.error.message} ` +
            `(${outcome.result.error.detail ?? 'no detail'})`,
        );
      }
    }

    // One assertion carrying every failure, so a run reports ALL broken channels rather than
    // stopping at the first — the seventeen were broken together and would have been found
    // together.
    expect(failures).toEqual([]);
    expect(called).toBe(channels.length - skipped.length);
    // The allowlist is small and stays small. Growing it is a decision, and this makes it one.
    // ⚠️ 3 → 4 on 2026-07-24 (A-16), and the decision is recorded rather than absorbed: the
    // fourth is `sync:rebuild`, skipped for the same class of reason as `action:execute` — it
    // mutates the thing every other channel in this sweep is asserted against. Its own suite
    // calls it against a real parsed directory, so it is covered, not excused.
    expect(skipped.length).toBeLessThanOrEqual(4);
    rig.db.close();
  });

  it('leaves no channel unplanned, and every skip states a reason', () => {
    // The compile-time half is `ChannelPlan` being a total mapped type. This is the runtime
    // half: a skip whose reason is blank is an omission wearing a decision's clothes.
    for (const [channel, plan] of Object.entries(CHANNEL_PLAN)) {
      if ('skip' in plan) {
        expect(plan.skip.length, `${channel} is skipped with no reason`).toBeGreaterThan(20);
      }
    }
  });

  it('registers no handler that answers "not implemented" (CLAUDE.md §1)', async () => {
    const rig = await buildRig(sandbox);
    const channels = Object.keys(rig.handlers) as IpcChannel[];

    const notImplemented: string[] = [];
    for (const channel of channels) {
      const outcome = await callOne(channel, rig.handlers, rig.found);
      if ('skipped' in outcome) continue;
      if (outcome.result.ok) continue;
      // `notImplemented()` in `src/main/ipc/errors.ts` writes this exact sentence. Matching on
      // it is legitimate here precisely because it is a *test* asserting the absence of a
      // build-state marker, not the renderer branching on message text (§4.1 rule 2).
      if (outcome.result.error.message.includes('not built yet')) notImplemented.push(channel);
    }

    expect(notImplemented).toEqual([]);
    rig.db.close();
  });
});
