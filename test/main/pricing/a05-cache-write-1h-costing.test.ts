// A-05 — the FIFTH token class, priced. §5.9 M-04/M-05, §3.11, ADR-024, migration 0005.
//
// ⚠️⚠️ **THE ONE THING THIS FIXTURE EXISTS TO DO IS DISCRIMINATE.** The 5-minute and 1-hour
// cache-write rates below are DIFFERENT ($6.25 and $10.00 per Mtok — the real published pair for
// a $5/Mtok input model). A fixture that priced them the same would pass under the old
// single-class model, under the new one, and under a build that swapped the two columns: it would
// prove nothing at all. Every total here is stated twice — the correct value, and the value the
// pre-A-05 "all cache writes are 5-minute" reading would have produced — and both are asserted,
// so a regression to that reading fails on a number rather than on a shape.
//
// Every expected value is hand-computed with the arithmetic in the comment. `toMatchSnapshot()`
// is banned (STACK ADR-012, CLAUDE.md §1).

import { describe, expect, it } from 'vitest';
import { CostCalculator } from '../../../src/main/pricing/cost';
import { CostRepository } from '../../../src/main/db/repositories/cost';
import { PriceRepo } from '../../../src/main/pricing/price-repo';
import { validatePriceDocument } from '../../../src/main/pricing/price-document';
import { useSandbox } from '../../support/sandbox';
import { useTestDatabases } from '../db/helpers';
import { DAY_MS, T0, insertEvents, priceDocument, seedSkeleton } from './helpers';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';

const MODEL = 'claude-opus-4-8';
const ALL_TIME = { projectIds: null, from: null, to: null };

/**
 * The real published Opus 4.8 rate set (§4.7 units: USD per 1M tokens), including the 1-hour
 * cache-write rate this change added.
 *
 * ⚠️ `cache_write` 6.25 is 1.25x input and `cache_write_1h` 10 is 2x input — which is an
 * OBSERVATION about today's page, not a derivation. Both are stored (§1.7, ADR-024), and the
 * assertion directly below is what keeps this fixture honest about being able to tell them apart.
 */
const RATES = { input: 5, output: 25, cache_write: 6.25, cache_write_1h: 10, cache_read: 0.5 };

// picoUSD per token = USD per Mtok × 1e6 (ADR-023, amended).
const PICO = {
  input: 5_000_000,
  output: 25_000_000,
  cacheWrite: 6_250_000,
  cacheWrite1h: 10_000_000,
  cacheRead: 500_000,
} as const;

function seedPrices(db: SqliteDatabase): void {
  new PriceRepo(db).applyDocument(
    validatePriceDocument(
      priceDocument([
        { model: MODEL, rates: RATES, effectiveFrom: new Date(T0 - DAY_MS).toISOString() },
      ]),
    ),
    { source: 'seed', sourceUrl: null, now: T0 },
  );
}

describe('A-05 — 5-minute and 1-hour cache writes are priced independently', () => {
  const sandbox = useSandbox();
  const databases = useTestDatabases(sandbox);

  it('⚠️ prices the two cache-write classes at DIFFERENT rates — the premise of every case below', () => {
    expect(RATES.cache_write).not.toBe(RATES.cache_write_1h);
    expect(PICO.cacheWrite).not.toBe(PICO.cacheWrite1h);
  });

  it('costs a mixed dataset at both rates, and NOT at the single 5-minute rate', () => {
    const db = databases.openMigrated();
    seedSkeleton(db);
    seedPrices(db);

    insertEvents(db, [
      // e1 — 5-minute writes only.
      { eventKey: 'e1', ts: T0, model: MODEL, cacheWrite: 1_000_000, cacheWrite1h: 0 },
      // e2 — 1-hour writes only. ⚠️ Same token COUNT as e1, so the pre-A-05 reading gives the two
      // events the same cost; the correct reading does not.
      { eventKey: 'e2', ts: T0, model: MODEL, cacheWrite: 0, cacheWrite1h: 1_000_000 },
      // e3 — every class non-zero at once, so no class can be quietly dropped.
      {
        eventKey: 'e3',
        ts: T0,
        model: MODEL,
        input: 100_000,
        output: 20_000,
        cacheWrite: 400_000,
        cacheWrite1h: 600_000,
        cacheRead: 2_000_000,
      },
    ]);

    // ── Hand-computed M-05, in picoUSD (tokens × rate) ─────────────────────────────────────
    //   e1  cache_write     1_000_000 ×  6_250_000 =  6_250_000_000_000
    //   e2  cache_write_1h  1_000_000 × 10_000_000 = 10_000_000_000_000
    //   e3  input             100_000 ×  5_000_000 =    500_000_000_000
    //       output             20_000 × 25_000_000 =    500_000_000_000
    //       cache_write       400_000 ×  6_250_000 =  2_500_000_000_000
    //       cache_write_1h    600_000 × 10_000_000 =  6_000_000_000_000
    //       cache_read      2_000_000 ×    500_000 =  1_000_000_000_000
    //       e3 subtotal                            = 10_500_000_000_000
    //   TOTAL                                      = 26_750_000_000_000 picoUSD
    //   → nanoUSD (÷ 1e3)                          =     26_750_000_000  ($26.75)
    const result = new CostCalculator(db).cost(ALL_TIME);
    expect(result.costNanoUsd).toBe(26_750_000_000);
    expect(result.costedEvents).toBe(3);
    expect(result.uncosted.records).toBe(0);

    // ⚠️ ── What the PRE-A-05 reading produces, hand-computed the same way ────────────────────
    // Every cache write at the 5-minute rate, i.e. `(cw5m + cw1h) × 6_250_000`:
    //   e1  1_000_000 × 6_250_000 =  6_250_000_000_000
    //   e2  1_000_000 × 6_250_000 =  6_250_000_000_000   ← the whole error, in one line
    //   e3  1_000_000 × 6_250_000 =  6_250_000_000_000  + 2_000_000_000_000 (input/output/read)
    //   TOTAL                     = 20_750_000_000_000 picoUSD → 20_750_000_000 nanoUSD ($20.75)
    // The difference is $6.00 on three events. On the reference dataset it was $415.07.
    expect(result.costNanoUsd).not.toBe(20_750_000_000);
    expect(result.costNanoUsd - 20_750_000_000).toBe(6_000_000_000);
  });

  it('reports the two cache-write classes as two numbers in the grouped breakdown (M-04)', () => {
    const db = databases.openMigrated();
    seedSkeleton(db);
    seedPrices(db);
    insertEvents(db, [
      { eventKey: 'g1', ts: T0, model: MODEL, cacheWrite: 400_000, cacheWrite1h: 600_000 },
    ]);

    const [row] = new CostRepository(db).totalsGroupedBy(
      { projectIds: null, from: null, to: null },
      'model',
    );

    // M-04 is "the class sums, always reported as separate numbers, never one". A build that
    // folded them back together would report 1_000_000 in one column and 0 in the other.
    expect(row?.tokCacheWrite).toBe(400_000);
    expect(row?.tokCacheWrite1h).toBe(600_000);
    //   400_000 ×  6_250_000 = 2_500_000_000_000
    //   600_000 × 10_000_000 = 6_000_000_000_000
    //   TOTAL                = 8_500_000_000_000 picoUSD
    expect(row?.costPicoUsd).toBe(8_500_000_000_000n);
  });

  it('drops the WHOLE event when 1-hour writes are non-zero and unpriced (INV-09)', () => {
    const db = databases.openMigrated();
    seedSkeleton(db);
    const prices = new PriceRepo(db);
    // Every class priced EXCEPT the new one — the "gap" §3.11 says is legal, reached through the
    // first-class manual-entry path (§5.8 rule 5).
    for (const tokenClass of ['input', 'output', 'cache_write', 'cache_read'] as const) {
      prices.upsertRate({ model: MODEL, tokenClass, usdPerMillion: 10 }, T0 - DAY_MS);
    }
    expect(prices.rateAt(MODEL, 'cache_write_1h', T0)).toBeUndefined();

    insertEvents(db, [
      // Priceable: no 1-hour writes at all, so the missing class is irrelevant to it.
      //   (100 + 200 + 300) × 10_000_000 = 6_000_000_000 pico → 6_000_000 nano
      { eventKey: 'ok', ts: T0, model: MODEL, input: 100, output: 200, cacheWrite: 300 },
      // ⚠️ THE MIXED CASE. Four classes priced, `cache_write_1h` is not and is non-zero, so the
      // ENTIRE event is uncosted — never partially costed at the rates that do exist.
      {
        eventKey: 'mixed',
        ts: T0 + 1,
        model: MODEL,
        input: 100,
        output: 200,
        cacheWrite: 300,
        cacheWrite1h: 1,
      },
    ]);

    const result = new CostCalculator(db).cost(ALL_TIME);
    expect(result.costNanoUsd).toBe(6_000_000);
    expect(result.costedEvents).toBe(1);
    expect(result.uncosted.records).toBe(1);
    expect(result.uncosted.byModel).toEqual([
      { model: MODEL, records: 1, fromTs: T0 + 1, toTs: T0 + 1 },
    ]);
    // The partially-costed number that must NOT appear: 6_000_000 + (601 × 10_000_000)/1e3.
    expect(result.costNanoUsd).not.toBe(12_010_000);
  });

  it('costs a row whose split is NOT KNOWN exactly as it was costed before A-05', () => {
    const db = databases.openMigrated();
    seedSkeleton(db);
    seedPrices(db);

    // `cacheWrite1h: undefined` writes SQL NULL — precisely the state migration 0005 leaves every
    // pre-existing row in. ⚠️ This is the "not a regression" claim, asserted rather than argued:
    // the whole flat cache-write total is costed at the 5-minute rate, which is what this event
    // cost yesterday, and the count of such rows is disclosed instead of the number moving.
    insertEvents(db, [{ eventKey: 'legacy', ts: T0, model: MODEL, cacheWrite: 1_000_000 }]);

    //   1_000_000 × 6_250_000 = 6_250_000_000_000 pico → 6_250_000_000 nano ($6.25)
    const result = new CostCalculator(db).cost(ALL_TIME);
    expect(result.costNanoUsd).toBe(6_250_000_000);
    expect(result.costedEvents).toBe(1);
    // ⚠️ NOT uncosted. An unknown split is a disclosure, not an exclusion: dropping these events
    // would erase the user's entire lifetime total the moment they upgraded.
    expect(result.uncosted.records).toBe(0);
  });
});
