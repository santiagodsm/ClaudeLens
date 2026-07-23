// FIXTURE F-09 — costing with no applicable price row (§5.9.1, M-05, M-06, INV-09, INV-10).
//
//   "The record is ENTIRELY excluded from `$` (INV-09) AND surfaced in `UncostedSummary` —
//    never zero-filled, never substituted."
//
// ⚠️ The mixed case is the one that matters. ADR-024: "a record priced on three of its four
// classes would produce a number that is confidently wrong rather than honestly absent." A fixture
// with only fully-unpriced events would pass under a partial-costing implementation too, so this
// file includes an event whose `input` and `output` ARE priced while its `cache_read` is not —
// and asserts the WHOLE event drops out.
//
// Every expected value is hand-computed with the arithmetic in the comment.

import { describe, expect, it } from 'vitest';
import { CostCalculator } from '../../../src/main/pricing/cost';
import { PriceRepo } from '../../../src/main/pricing/price-repo';
import { validatePriceDocument } from '../../../src/main/pricing/price-document';
import { useSandbox } from '../../support/sandbox';
import { useTestDatabases } from '../db/helpers';
import { DAY_MS, T0, insertEvents, priceDocument, seedSkeleton } from './helpers';

const PRICED = 'claude-opus-4-8';
const UNPRICED = 'some-model-nobody-priced';
const ALL_TIME = { projectIds: null, from: null, to: null };

describe('F-09 — costing with no applicable price row', () => {
  const sandbox = useSandbox();
  const databases = useTestDatabases(sandbox);

  it('excludes the record entirely from $ and surfaces it in UncostedSummary', () => {
    const db = databases.openMigrated();
    seedSkeleton(db);

    new PriceRepo(db).applyDocument(
      validatePriceDocument(
        priceDocument([
          {
            model: PRICED,
            // The real published Opus 4.8 rates (§4.7 units: USD per 1M tokens).
            rates: {
              input: 5,
              output: 25,
              cache_write: 6.25,
              cache_write_1h: 10,
              cache_read: 0.5,
            },
            effectiveFrom: new Date(T0 - DAY_MS).toISOString(),
          },
        ]),
      ),
      { source: 'seed', sourceUrl: null, now: T0 },
    );

    insertEvents(db, [
      { eventKey: 'priced', ts: T0, model: PRICED, input: 1_000, output: 500 },
      { eventKey: 'unpriced-1', ts: T0 + 1, model: UNPRICED, input: 9_000_000, output: 9_000_000 },
      { eventKey: 'unpriced-2', ts: T0 + DAY_MS, model: UNPRICED, output: 1 },
    ]);

    const result = new CostCalculator(db).cost(ALL_TIME);

    // ── Hand-computed ────────────────────────────────────────────────────────────────────────
    //   $5.00/Mtok  = 5_000_000 pico/token   ·   $25.00/Mtok = 25_000_000 pico/token
    //   priced : 1_000 × 5_000_000 + 500 × 25_000_000
    //          = 5_000_000_000 + 12_500_000_000 = 17_500_000_000 pico
    //   nanoUSD  = 17_500_000_000 / 1_000      =     17_500_000 nano   ($0.0175)
    //   The two `some-model-nobody-priced` events contribute NOTHING.
    expect(result.costNanoUsd).toBe(17_500_000);
    expect(result.costedEvents).toBe(1);

    // INV-10: the disclosure travels with the figure, in the same payload.
    expect(result.uncosted.records).toBe(2);
    expect(result.uncosted.byModel).toEqual([
      { model: UNPRICED, records: 2, fromTs: T0 + 1, toTs: T0 + DAY_MS },
    ]);

    // ⚠️ NEVER ZERO-FILLED. Zero-filling would have produced the same $ total but `records: 0`,
    // and a complete-looking figure is the failure the user named. The disclosure is what
    // distinguishes them, so assert both halves.
    expect(result.uncosted.records).not.toBe(0);

    // ⚠️ NEVER SUBSTITUTED. Had the unpriced model borrowed the priced model's rate (ADR-025's
    // rejected "closest model" fallback), the 18M unpriced tokens would have added
    //   9_000_000 × 5_000_000 + 9_000_000 × 25_000_000 = 4.5e13 + 2.25e14 = 2.7e14 pico
    //                                                  = 270_000_000_000 nano
    // for a total of 270_017_500_000. That number must NOT appear.
    expect(result.costNanoUsd).not.toBe(270_017_500_000);
  });

  it('drops the WHOLE event when one non-zero class is unpriced and the others are priced', () => {
    const db = databases.openMigrated();
    seedSkeleton(db);
    const prices = new PriceRepo(db);

    // Price four of the five classes for one model, by hand, one class at a time — the fifth
    // (`cache_read`) is deliberately left with NO row at all. This is exactly the "gap" §3.11
    // says is legal, arrived at through the first-class manual-entry path (§5.8 rule 5).
    for (const tokenClass of ['input', 'output', 'cache_write', 'cache_write_1h'] as const) {
      prices.upsertRate({ model: PRICED, tokenClass, usdPerMillion: 10 }, T0 - DAY_MS);
    }
    expect(prices.rateAt(PRICED, 'cache_read', T0)).toBeUndefined();

    insertEvents(db, [
      // Fully priceable: no cache_read at all, so the missing class is irrelevant to it.
      { eventKey: 'ok', ts: T0, model: PRICED, input: 100, output: 200, cacheWrite: 300 },
      // ⚠️ THE MIXED CASE. input/output/cache_write are priced; cache_read is NOT and is non-zero.
      {
        eventKey: 'mixed',
        ts: T0 + 1,
        model: PRICED,
        input: 100,
        output: 200,
        cacheWrite: 300,
        cacheRead: 1,
      },
    ]);

    const result = new CostCalculator(db).cost(ALL_TIME);

    // ── Hand-computed ────────────────────────────────────────────────────────────────────────
    //   $10.00/Mtok = 10_000_000 pico/token
    //   ok    : (100 + 200 + 300) × 10_000_000 = 600 × 1e7 = 6_000_000_000 pico
    //   mixed : EXCLUDED IN FULL (INV-09) — contributes 0, not its priced three classes.
    //   nanoUSD = 6_000_000_000 / 1_000       =            6_000_000 nano  ($0.006)
    expect(result.costNanoUsd).toBe(6_000_000);
    expect(result.costedEvents).toBe(1);
    expect(result.uncosted.records).toBe(1);
    expect(result.uncosted.byModel).toEqual([
      { model: PRICED, records: 1, fromTs: T0 + 1, toTs: T0 + 1 },
    ]);

    // ⚠️ THE PARTIAL-COSTING READING, ASSERTED AGAINST. Had `mixed` been costed on its three
    // priced classes and had its cache_read silently treated as free, the total would be
    //   6_000_000_000 + 600 × 10_000_000 = 12_000_000_000 pico = 12_000_000 nano.
    expect(result.costNanoUsd).not.toBe(12_000_000);
  });

  it('treats a GAP between two price rows as uncosted, not as an error and not as either rate', () => {
    const db = databases.openMigrated();
    seedSkeleton(db);
    const prices = new PriceRepo(db);

    // §3.11: "Gaps are legal — a gap simply means the records inside it are uncosted and
    // disclosed (INV-09)." Build one by hand-correcting an effective date, which is the exact
    // situation the design says the feature exists for.
    for (const tokenClass of ['input', 'output', 'cache_write', 'cache_read'] as const) {
      prices.upsertRate({ model: PRICED, tokenClass, usdPerMillion: 4 }, T0);
    }
    const rows = prices.list({ model: PRICED, includeHistory: true });
    for (const row of rows) {
      // Close every row at T0 + 1 day, leaving [T0 + 1d, ∞) with no coverage at all.
      prices.setDates({ id: row.id, validFrom: row.validFrom, validTo: T0 + DAY_MS }, T0);
    }

    insertEvents(db, [
      { eventKey: 'inside', ts: T0 + 1, model: PRICED, output: 1_000 },
      { eventKey: 'in-the-gap', ts: T0 + DAY_MS, model: PRICED, output: 1_000 },
    ]);

    const result = new CostCalculator(db).cost(ALL_TIME);

    // ── Hand-computed ────────────────────────────────────────────────────────────────────────
    //   $4.00/Mtok = 4_000_000 pico/token
    //   inside      : 1_000 × 4_000_000 = 4_000_000_000 pico
    //   in-the-gap  : no covering row at T0+1d (the row ends AT it, half-open) → EXCLUDED
    //   nanoUSD = 4_000_000_000 / 1_000 =     4_000_000 nano  ($0.004)
    expect(result.costNanoUsd).toBe(4_000_000);
    expect(result.uncosted.records).toBe(1);
    expect(result.uncosted.byModel[0]?.model).toBe(PRICED);

    // A gap is data, not a failure: the call succeeded and reported the shortfall.
    expect(result.costedEvents).toBe(1);
  });

  it('reports a complete figure as complete — records: 0 means nothing is missing', () => {
    const db = databases.openMigrated();
    seedSkeleton(db);
    new PriceRepo(db).upsertRate(
      { model: PRICED, tokenClass: 'output', usdPerMillion: 25 },
      T0 - DAY_MS,
    );
    insertEvents(db, [{ eventKey: 'only', ts: T0, model: PRICED, output: 40 }]);

    const result = new CostCalculator(db).cost(ALL_TIME);
    // 40 × 25_000_000 = 1_000_000_000 pico → 1_000_000 nano ($0.001)
    expect(result.costNanoUsd).toBe(1_000_000);
    expect(result.uncosted).toEqual({ records: 0, byModel: [] });
  });

  it('excludes synthetic events from cost AND from the uncosted count (M-01)', () => {
    const db = databases.openMigrated();
    seedSkeleton(db);
    insertEvents(db, [
      { eventKey: 'synthetic', ts: T0, model: UNPRICED, output: 1_000, synthetic: true },
    ]);

    const result = new CostCalculator(db).cost(ALL_TIME);
    // M-01: "Synthetic events are excluded from every token, cost and model statistic." They are
    // counted in `Disclosures.syntheticEvents` instead — a different disclosure, not this one.
    expect(result.costNanoUsd).toBe(0);
    expect(result.uncosted).toEqual({ records: 0, byModel: [] });
  });
});
