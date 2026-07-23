// ⚠️⚠️ **The regression that a small fixture cannot catch** — DESIGN §3.11 (AMENDED 2026-07-22),
// ADR-023, INV-11.
//
// The bug: `CostRepository.totals()` and `totalsGroupedBy()` narrowed the picoUSD sum to a JS
// `number` the moment it left SQL and asserted INV-11 on it there. §3.11 states the rule and the
// reason verbatim — "SQL sums in picoUSD (64-bit) … the repository then converts to **nanoUSD**
// … **before** the value crosses IPC, because picoUSD totals can approach
// `Number.MAX_SAFE_INTEGER` (9.007e15) on a dataset only a few times larger, while the same total
// in nanoUSD (4.8e12) has three orders of headroom." In picoUSD that bound is **$9,007** of
// lifetime spend, so `q:overviewTiles` — the 3-second glance surface — answered `E_INTERNAL` for
// every user past it. INV-11 fired correctly; it was simply asserted at the wrong boundary.
//
// ⚠️ **Why 890 tests were green, which is the part worth internalising.** The committed fixtures
// are tiny, and even the reference-scale perf database totalled `4_705_207_215_000_000` picoUSD —
// about HALF the limit. The synthetic dataset was large enough to measure performance and not
// large enough to overflow, so nothing in the suite ever crossed the boundary. **A fixture under
// the threshold proves nothing**, which is exactly how this shipped.
//
// So this file crosses it, deliberately, and it crosses it the way CLAUDE.md's 256 KB fixture
// rule permits: **three events at an absurd rate**, not volume. Every assertion below is an exact
// integer, hand-computed inline (CLAUDE.md §1 — no snapshots), and every one is paired with a
// `not.toBe()` against the value a lossy `Number` narrowing of the same picoUSD sum would have
// produced. The pairing is the point: an assertion that would pass either way is not a regression
// test.

import { describe, expect, it } from 'vitest';
import { DatasetService } from '../../src/main/ipc/dataset';
import { createHandlers } from '../../src/main/ipc/register';
import { toAppError } from '../../src/main/ipc/errors';
import { silentLogger } from '../../src/main/log/logger';
import { openDatabase } from '../../src/main/db/driver';
import { costToWire } from '../../src/main/db/repositories/cost';
import { picoToNanoUsd } from '../../src/shared/money';
import { ActionService } from '../../src/main/actions/service';
import { HarnessService } from '../../src/main/harness/service';
import { PricingService } from '../../src/main/pricing';
import type { IpcHandlerMap } from '../../src/shared/ipc-contract';
import type { SqliteDatabase } from '../../src/main/db/sqlite';
import type { WatchHandle } from '../../src/main/watcher/watcher';
import { useSandbox, type Sandbox } from '../support/sandbox';
import { fixturePath, FIXED_NOW } from '../support/sync-harness';

// ---------------------------------------------------------------------------------------
// The arithmetic, stated once, in picoUSD — §3.11's storage unit (ADR-023 as amended).
// ---------------------------------------------------------------------------------------
//
// The fixture's rate is `$50,000.000001` per 1M tokens on all four classes of all three models.
// §3.11: `rate_picousd_per_token = USD per 1M tokens × 1e6`, so
//
//   50_000.000001 × 1e6 = 50_000_000_001 picoUSD per token
//
// ⚠️ **Absurd on purpose, and the six-decimal tail is on purpose too.** The rate is what lets
// three events cross a 9.007e15 boundary inside a 256 KB fixture (CLAUDE.md §5), and the trailing
// `1` is what makes each total land on a value a `double` cannot hold — see `LOSSY_*` below.
const RATE_PICO_PER_TOKEN = 50_000_000_001n;

/** `Number.MAX_SAFE_INTEGER` as picoUSD: the bound the old code asserted, = $9,007.20 of spend. */
const MAX_SAFE_PICO = BigInt(Number.MAX_SAFE_INTEGER);

// Each event's four token classes, from the committed fixture. Only the SUM matters, because
// every class carries the same rate.
//
//   alpha  (claude-costly-1)  400_000 + 300_000 + 100_000 +  90_500 =   890_500 tokens
//   beta   (claude-costly-2)  400_000 + 300_000 + 200_000 +  60_500 =   960_500 tokens
//   gamma  (claude-costly-3)  500_000 + 400_000 + 100_000 +  40_500 = 1_040_500 tokens
//                                                             TOTAL = 2_891_500 tokens
const TOKENS_ALPHA = 890_500n;
const TOKENS_BETA = 960_500n;
const TOKENS_GAMMA = 1_040_500n;
const TOKENS_TOTAL = TOKENS_ALPHA + TOKENS_BETA + TOKENS_GAMMA; // 2_891_500

// ── M-05 in picoUSD, hand-computed: tokens × 50_000_000_001 ──────────────────────────────
//
//     890_500 × 50_000_000_001 =  44_525_000_000_890_500   ($44,525.000000891)
//     960_500 × 50_000_000_001 =  48_025_000_000_960_500   ($48,025.000000961)
//   1_040_500 × 50_000_000_001 =  52_025_000_001_040_500   ($52,025.000001041)
//   2_891_500 × 50_000_000_001 = 144_575_000_002_891_500   ($144,575.000002892)
//
// ⚠️ Every one of these four is larger than 9_007_199_254_740_991. The GROUPED figures cross the
// boundary too, not only the total — `q:costBreakdown` and every per-row `$` had the same bug.
const PICO_ALPHA = 44_525_000_000_890_500n;
const PICO_BETA = 48_025_000_000_960_500n;
const PICO_GAMMA = 52_025_000_001_040_500n;
const PICO_TOTAL = 144_575_000_002_891_500n;

// ── The wire unit: nanoUSD, integer division by 1000, ROUND-HALF-UP (§3.11, ADR-023) ─────
//
//   (44_525_000_000_890_500 + 500) / 1000 =  44_525_000_000_891
//   (48_025_000_000_960_500 + 500) / 1000 =  48_025_000_000_961
//   (52_025_000_001_040_500 + 500) / 1000 =  52_025_000_001_041
//  (144_575_000_002_891_500 + 500) / 1000 = 144_575_000_002_892
//
// All four sit far inside `Number.MAX_SAFE_INTEGER` (9.007e15) — which is §3.11's entire
// argument for converting BEFORE the value crosses IPC rather than after.
const NANO_ALPHA = 44_525_000_000_891;
const NANO_BETA = 48_025_000_000_961;
const NANO_GAMMA = 52_025_000_001_041;
const NANO_TOTAL = 144_575_000_002_892;

/**
 * What the same conversion produces if the picoUSD sum is narrowed to a `number` FIRST — the
 * silently-rounded number INV-11 exists to prevent, computed here so the assertions below can
 * name it rather than merely avoid it.
 *
 * At ~1.4e17 a `double`'s neighbours are 32 apart, so `Number(144_575_000_002_891_500n)` is
 * `144_575_000_002_891_488` — twelve picoUSD low, which drags the round-half-up division across
 * its tie and yields a nanoUSD figure one unit smaller. One nanoUSD is $0.000000001: invisible
 * on screen, wrong in the data, and the exact shape of failure CLAUDE.md §1 calls the worst
 * possible outcome.
 */
function lossyNano(picoUsd: bigint): number {
  return Number((BigInt(Number(picoUsd)) + 500n) / 1000n);
}

/** SM-5 is not under test; a watch that never fires keeps the sync deterministic. */
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

interface Rig {
  readonly handlers: IpcHandlerMap;
  readonly db: SqliteDatabase;
}

/**
 * The real stack over the committed fixture: real parser, real SQLite file, real handlers.
 *
 * ⚠️ It goes through `createHandlers` rather than calling `AnalyticsRepository` directly because
 * the reported failure was a `Result` — `q:overviewTiles` answering `E_INTERNAL` — and a test
 * that asserted only on the repository would not have said `ok: true`.
 */
async function buildRig(sandbox: Sandbox): Promise<Rig> {
  const claudeDir = await sandbox.copyFixture(fixturePath('inv11-money-boundary'), 'claude');
  const db = openDatabase(sandbox.resolve('lens.db'));
  const dataset = new DatasetService({
    db,
    logger: silentLogger(),
    now: () => FIXED_NOW,
    watchFactory: () => inertWatch(),
  });
  await dataset.boot();

  const pricing = new PricingService({ db, settings: () => '', now: () => FIXED_NOW });
  const handlers = createHandlers({
    dataset,
    pricing,
    harness: new HarnessService({ db, claudeDir: () => dataset.claudeDir(), now: () => FIXED_NOW }),
    actions: new ActionService({
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
    }),
    logger: silentLogger(),
    pickDirectory: () => Promise.resolve(claudeDir),
  });

  // §5.1 — the real transition: validate, purge DERIVED, full sync through the real parser.
  const applied = await handlers['settings:set']({ key: 'claudeDir', value: claudeDir });
  expect(applied.ok).toBe(true);
  await dataset.settled();

  // ⚠️ The price table is written here, not seeded from `resources/price-seed.json`, so the
  // costed population is exactly the three fixture events and `uncosted` is provably empty
  // (INV-09/INV-10). `price_rows` is USER (ADR-026) and the sync above never touches it.
  const insert = db.prepare(
    `INSERT INTO price_rows (model, token_class, rate_picousd_per_token, valid_from, valid_to,
       source, created_at, updated_at)
     VALUES (?, ?, ?, 0, NULL, 'manual', 0, 0)`,
  );
  for (const model of ['claude-costly-1', 'claude-costly-2', 'claude-costly-3']) {
    for (const tokenClass of ['input', 'output', 'cache_write', 'cache_read']) {
      insert.run(model, tokenClass, RATE_PICO_PER_TOKEN);
    }
  }

  return { handlers, db };
}

const ALL_FILTER = { projectIds: null, from: null, to: null };

describe('§3.11 / INV-11 — a picoUSD total past MAX_SAFE_INTEGER reaches the wire exactly', () => {
  const sandbox = useSandbox();

  it('states its own premise: every figure under test really is past the boundary', () => {
    // ⚠️ This test exists because the suite was full of fixtures that did NOT cross the bound.
    // If a later edit shrinks the fixture, this fails first and says why, instead of the
    // regression quietly turning back into a test of the happy path.
    expect(TOKENS_ALPHA * RATE_PICO_PER_TOKEN).toBe(PICO_ALPHA);
    expect(TOKENS_BETA * RATE_PICO_PER_TOKEN).toBe(PICO_BETA);
    expect(TOKENS_GAMMA * RATE_PICO_PER_TOKEN).toBe(PICO_GAMMA);
    expect(TOKENS_TOTAL * RATE_PICO_PER_TOKEN).toBe(PICO_TOTAL);

    for (const pico of [PICO_ALPHA, PICO_BETA, PICO_GAMMA, PICO_TOTAL]) {
      // Past the bound the old code asserted — 9_007_199_254_740_991 picoUSD, i.e. $9,007.20.
      expect(pico).toBeGreaterThan(MAX_SAFE_PICO);
      // …and genuinely unrepresentable as a `number`, so `not.toBe(lossyNano(...))` below
      // discriminates rather than restating the same integer twice.
      expect(BigInt(Number(pico))).not.toBe(pico);
    }

    // The wire unit, by contrast, has three orders of headroom — §3.11's whole argument.
    for (const nano of [NANO_ALPHA, NANO_BETA, NANO_GAMMA, NANO_TOTAL]) {
      expect(Number.isSafeInteger(nano)).toBe(true);
    }
  });

  it('q:overviewTiles answers ok:true with the exact costNanoUsd (the reported failure)', async () => {
    const rig = await buildRig(sandbox);
    const tiles = await rig.handlers['q:overviewTiles'](ALL_FILTER);

    // ⚠️ The literal bug report: this was `{ ok: false, error: { code: 'E_INTERNAL' } }` with
    // "`costPicoUsd` is too large to report exactly, so it was not reported at all".
    expect(tiles.ok).toBe(true);
    if (!tiles.ok) throw new Error(`q:overviewTiles failed: ${tiles.error.detail ?? ''}`);

    // 144_575_000_002_891_500 picoUSD → (… + 500) / 1000 = 144_575_000_002_892 nanoUSD
    //                                                     = $144,575.000002892
    expect(tiles.data.costNanoUsd).toBe(NANO_TOTAL);
    // …and NOT the figure a `Number` narrowing of the picoUSD sum produces first.
    expect(tiles.data.costNanoUsd).not.toBe(lossyNano(PICO_TOTAL));
    expect(lossyNano(PICO_TOTAL)).toBe(144_575_000_002_891);

    // INV-10 — the disclosure travels with the money, and says "complete", because it is:
    // all three events are costed on all four classes (INV-09).
    expect(tiles.data.uncosted).toEqual({ records: 0, byModel: [] });
    // M-02, for the same three events: 300_000 + 300_000 + 400_000 = 1_000_000 output tokens.
    // §3.5 gives token counts their own headroom argument; they are `number` and stay `number`.
    expect(tiles.data.outputTokens).toBe(1_000_000);
    rig.db.close();
  });

  it('q:costBreakdown answers ok:true with an exact $ for every group', async () => {
    const rig = await buildRig(sandbox);
    const breakdown = await rig.handlers['q:costBreakdown']({ ...ALL_FILTER, by: 'model' });

    expect(breakdown.ok).toBe(true);
    if (!breakdown.ok) throw new Error(`q:costBreakdown failed: ${breakdown.error.detail ?? ''}`);

    // Ordered by `cost_picousd DESC` (§4.5) — gamma, beta, alpha.
    expect(breakdown.data.rows).toEqual([
      {
        key: 'claude-costly-3',
        label: 'claude-costly-3', // model grouping: label === key
        // 1_040_500 × 50_000_000_001 = 52_025_000_001_040_500 pico → 52_025_000_001_041 nano
        costNanoUsd: NANO_GAMMA,
        tokensByClass: {
          input: 500_000,
          output: 400_000,
          cacheWrite: 100_000,
          cacheWrite1h: 0,
          cacheRead: 40_500,
        },
      },
      {
        key: 'claude-costly-2',
        label: 'claude-costly-2', // model grouping: label === key
        // 960_500 × 50_000_000_001 = 48_025_000_000_960_500 pico → 48_025_000_000_961 nano
        costNanoUsd: NANO_BETA,
        tokensByClass: {
          input: 400_000,
          output: 300_000,
          cacheWrite: 200_000,
          cacheWrite1h: 0,
          cacheRead: 60_500,
        },
      },
      {
        key: 'claude-costly-1',
        label: 'claude-costly-1', // model grouping: label === key
        // 890_500 × 50_000_000_001 = 44_525_000_000_890_500 pico → 44_525_000_000_891 nano
        costNanoUsd: NANO_ALPHA,
        tokensByClass: {
          input: 400_000,
          output: 300_000,
          cacheWrite: 100_000,
          cacheWrite1h: 0,
          cacheRead: 90_500,
        },
      },
    ]);

    // Each group, against the narrowed-first figure it must not be.
    const byKey = new Map(breakdown.data.rows.map((row) => [row.key, row.costNanoUsd]));
    expect(byKey.get('claude-costly-1')).not.toBe(lossyNano(PICO_ALPHA));
    expect(byKey.get('claude-costly-2')).not.toBe(lossyNano(PICO_BETA));
    expect(byKey.get('claude-costly-3')).not.toBe(lossyNano(PICO_GAMMA));
    expect([lossyNano(PICO_ALPHA), lossyNano(PICO_BETA), lossyNano(PICO_GAMMA)]).toEqual([
      44_525_000_000_890, 48_025_000_000_960, 52_025_000_001_040,
    ]);

    // ⚠️ The grouped figures sum to 144_575_000_002_893, one nanoUSD ABOVE the ungrouped
    // 144_575_000_002_892 — and that is correct, not a defect. Round-half-up is applied once per
    // conversion (§3.11), and each of the three picoUSD sums here ends in `500`, so each rounds
    // up half a nanoUSD while the single total rounds up only once. Asserted rather than left
    // implicit, because "the parts don't add up to the whole" is exactly the kind of thing a
    // later reader would otherwise `Math.round` away.
    const summed = breakdown.data.rows.reduce((total, row) => total + row.costNanoUsd, 0);
    expect(summed).toBe(NANO_ALPHA + NANO_BETA + NANO_GAMMA);
    expect(summed).toBe(NANO_TOTAL + 1);
    rig.db.close();
  });

  it('q:tokensByProject answers ok:true with an exact per-row $', async () => {
    const rig = await buildRig(sandbox);
    const byProject = await rig.handlers['q:tokensByProject'](ALL_FILTER);

    expect(byProject.ok).toBe(true);
    if (!byProject.ok) throw new Error(`q:tokensByProject failed: ${byProject.error.detail ?? ''}`);

    // One project per model, so the per-project `$` is the per-model `$` (ordered by M-02
    // output tokens DESC: gamma 400_000, then alpha and beta at 300_000, `display_name` ASC).
    const costs = new Map(byProject.data.rows.map((row) => [row.displayName, row.costNanoUsd]));
    expect(byProject.data.rows).toHaveLength(3);

    const gamma = byProject.data.rows[0];
    expect(gamma?.outputTokens).toBe(400_000);
    expect(gamma?.costNanoUsd).toBe(NANO_GAMMA);
    expect(gamma?.costNanoUsd).not.toBe(lossyNano(PICO_GAMMA));

    // The other two, by name rather than by position, so the assertion survives a tie-break edit.
    for (const [name, nano, pico] of [
      ['alpha', NANO_ALPHA, PICO_ALPHA],
      ['beta', NANO_BETA, PICO_BETA],
    ] as const) {
      const key = [...costs.keys()].find((displayName) => displayName.endsWith(name));
      expect(key, `no project row whose display name ends in "${name}"`).toBeDefined();
      expect(costs.get(key ?? '')).toBe(nano);
      expect(costs.get(key ?? '')).not.toBe(lossyNano(pico));
    }

    expect(byProject.data.uncosted).toEqual({ records: 0, byModel: [] });
    rig.db.close();
  });
});

describe('§3.11 / INV-11 — the guard is moved, not removed', () => {
  // ⚠️ The other half of this fix. Widening picoUSD to `bigint` must not turn INV-11 off: a
  // nanoUSD total that genuinely cannot be represented still has to be REFUSED rather than
  // rounded. That case is ~$9,007,199 of costed spend, which no fixture should be asked to reach
  // — so it is constructed directly, from the number itself.

  /**
   * The smallest picoUSD total whose nanoUSD form is past `Number.MAX_SAFE_INTEGER`.
   *
   *   9_007_199_254_740_991 nanoUSD is the last representable figure ($9,007,199.254740991).
   *   × 1000 = 9_007_199_254_740_991_000 picoUSD, and round-half-up needs another 500 to tip
   *   into 9_007_199_254_740_992 nanoUSD, which is NOT a safe integer.
   *
   * Still well inside `2^63` (9.223e18), so it is a value SQLite could genuinely hold and hand
   * back — which is what makes the guard reachable rather than theoretical.
   */
  const UNREPRESENTABLE_PICO = 9_007_199_254_740_991_500n;

  it('refuses a nanoUSD total past the bound rather than rounding it', () => {
    expect((UNREPRESENTABLE_PICO + 500n) / 1000n).toBeGreaterThan(MAX_SAFE_PICO);
    expect(() => picoToNanoUsd(UNREPRESENTABLE_PICO)).toThrow(/INV-11/);
    // The quantity is named, so `E_INTERNAL`'s developer detail is actionable — and it names
    // `costNanoUsd`, the unit the bound actually belongs to, not `costPicoUsd`.
    expect(() => picoToNanoUsd(UNREPRESENTABLE_PICO)).toThrow(/costNanoUsd/);
    expect(() => costToWire(UNREPRESENTABLE_PICO, 1)).toThrow(/INV-11/);
  });

  it('surfaces that refusal as E_INTERNAL, never as a number (§4.1 rule 1, ADR-031)', () => {
    let thrown: unknown;
    try {
      costToWire(UNREPRESENTABLE_PICO, 1);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeDefined();
    expect(toAppError(thrown).code).toBe('E_INTERNAL');
  });

  it('still accepts the largest total that IS representable — the bound is not off by one', () => {
    // 9_007_199_254_740_991_499 pico rounds DOWN to 9_007_199_254_740_991 nanoUSD, exactly
    // `Number.MAX_SAFE_INTEGER`. One picoUSD lower than the refusal above, and it must pass.
    expect(picoToNanoUsd(9_007_199_254_740_991_499n)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
