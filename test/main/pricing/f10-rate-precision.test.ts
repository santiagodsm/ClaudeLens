// FIXTURE F-10 — rate precision (§5.9.1, §3.11, ADR-023 as AMENDED 2026-07-20).
//
//   "A rate of `$0.3125/Mtok` (`3.125e-07` USD/token, a REAL PUBLISHED VALUE): stored exactly as
//    `312500` picoUSD/token and round-tripped through Settings without loss; a 7-decimal input is
//    REJECTED with `E_PRICE_PRECISION` rather than rounded."
//
// ⚠️ Why this fixture exists at all. `$0.3125/Mtok` is `312.5` nanoUSD/token — NOT AN INTEGER — so
// the originally-locked nanoUSD unit would have had to round it. "A rounded RATE multiplies
// straight into every total that uses it", which is strictly worse than a rounded total. picoUSD
// represents it exactly. This file is what stops that amendment from being quietly undone.

import { describe, expect, it } from 'vitest';
import { CostCalculator } from '../../../src/main/pricing/cost';
import { PriceRepo } from '../../../src/main/pricing/price-repo';
import { validatePriceDocument } from '../../../src/main/pricing/price-document';
import { isPricingError } from '../../../src/main/pricing/errors';
import { useSandbox } from '../../support/sandbox';
import { useTestDatabases } from '../db/helpers';
import { DAY_MS, T0, insertEvents, priceDocument, seedSkeleton } from './helpers';

const MODEL = 'claude-3-haiku-20240307';
const ALL_TIME = { projectIds: null, from: null, to: null };

function ratePicoUsd(db: ReturnType<ReturnType<typeof useTestDatabases>['openMigrated']>): number {
  const row = db
    .prepare<{ rate_picousd_per_token: number }>(
      `SELECT rate_picousd_per_token FROM price_rows WHERE token_class = 'cache_write'`,
    )
    .get();
  return row?.rate_picousd_per_token ?? -1;
}

describe('F-10 — rate precision', () => {
  const sandbox = useSandbox();
  const databases = useTestDatabases(sandbox);

  it('stores $0.3125/Mtok exactly as 312500 picoUSD/token and round-trips it through Settings', () => {
    const db = databases.openMigrated();
    seedSkeleton(db);
    const prices = new PriceRepo(db);

    // The Settings path (§4.7 `pricing:upsertRate`, §5.8 rule 5 — a first-class path).
    const written = prices.upsertRate(
      { model: MODEL, tokenClass: 'cache_write', usdPerMillion: 0.3125 },
      T0 - DAY_MS,
    );
    expect(written.versioned).toBe(true);

    // ── The stored INTEGER, hand-computed ────────────────────────────────────────────────────
    //   rate_picousd_per_token = USD per 1M tokens × 1e6  (§3.11)
    //   0.3125 × 1e6 = 312_500        ← exact
    //   In nanoUSD that would be 0.3125 × 1e3 = 312.5, NOT an integer — the whole reason for
    //   ADR-023's amendment.
    expect(ratePicoUsd(db)).toBe(312_500);

    // ── The round trip back out (§4.7 `PriceRow.usdPerMillion` = rate / 1e6) ─────────────────
    const readBack = prices
      .list({ model: MODEL, includeHistory: true })
      .find((row) => row.tokenClass === 'cache_write');
    expect(readBack?.usdPerMillion).toBe(0.3125); // no loss, no drift, exactly what was typed

    // And it multiplies exactly: 1_000_000 cache-write tokens at 312_500 pico/token.
    insertEvents(db, [{ eventKey: 'cw', ts: T0, model: MODEL, cacheWrite: 1_000_000 }]);
    const result = new CostCalculator(db).cost(ALL_TIME);
    // 1_000_000 × 312_500 = 312_500_000_000 pico → / 1_000 = 312_500_000 nano  ($0.3125)
    expect(result.costNanoUsd).toBe(312_500_000);
  });

  it('accepts exactly six decimal places of USD/Mtok — one picoUSD per token', () => {
    const db = databases.openMigrated();
    const prices = new PriceRepo(db);

    // Six decimals is the finest rate the storage unit holds: 0.000001 USD/Mtok = 1 pico/token.
    prices.upsertRate(
      { model: MODEL, tokenClass: 'cache_write', usdPerMillion: 0.000001 },
      T0 - DAY_MS,
    );
    expect(ratePicoUsd(db)).toBe(1);

    // And a value using all six: 12.345678 × 1e6 = 12_345_678.
    prices.upsertRate({ model: 'six-dp', tokenClass: 'input', usdPerMillion: 12.345678 }, T0);
    const row = db
      .prepare<{ rate_picousd_per_token: number }>(
        `SELECT rate_picousd_per_token FROM price_rows WHERE model = 'six-dp'`,
      )
      .get();
    expect(row?.rate_picousd_per_token).toBe(12_345_678);
  });

  it('REJECTS a 7-decimal input with E_PRICE_PRECISION rather than rounding it', () => {
    const db = databases.openMigrated();
    const prices = new PriceRepo(db);

    // 0.0000001 USD/Mtok is 0.1 picoUSD/token — finer than the unit can hold.
    expect(() =>
      prices.upsertRate({ model: MODEL, tokenClass: 'input', usdPerMillion: 0.0000001 }, T0),
    ).toThrow(expect.objectContaining({ code: 'E_PRICE_PRECISION' }));

    // A value that would round to something plausible is rejected just as hard — that is the
    // point. 0.3125001 would round to 0.312500 and look right.
    let captured: unknown;
    try {
      prices.upsertRate({ model: MODEL, tokenClass: 'input', usdPerMillion: 0.3125001 }, T0);
    } catch (error) {
      captured = error;
    }
    expect(isPricingError(captured)).toBe(true);
    expect(isPricingError(captured) ? captured.code : null).toBe('E_PRICE_PRECISION');

    // ⚠️ AND NOTHING WAS WRITTEN. A rejected rate never reaches the table.
    const count = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM price_rows`).get();
    expect(count?.n).toBe(0);
  });

  it('rejects a 7-decimal rate inside a price DOCUMENT before a single row is written', () => {
    const db = databases.openMigrated();
    const prices = new PriceRepo(db);

    // Seed something first, so "nothing was written" is a real assertion and not a vacuous one.
    prices.upsertRate({ model: MODEL, tokenClass: 'input', usdPerMillion: 0.25 }, T0);
    const before = db.prepare(`SELECT * FROM price_rows ORDER BY id`).all();

    expect(() =>
      validatePriceDocument(
        priceDocument([
          {
            model: MODEL,
            rates: {
              input: 0.25,
              output: 1.25,
              cache_write: 0.3125,
              cache_write_1h: 0.5,
              cache_read: 0.0000001,
            },
          },
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: 'E_PRICE_PRECISION' }));

    // §5.8 rule 3: validation completes before a single write, so the table is byte-identical.
    expect(db.prepare(`SELECT * FROM price_rows ORDER BY id`).all()).toEqual(before);
  });

  it('holds the real Haiku-3 rate set exactly — the one that forced the ADR-023 amendment', () => {
    const db = databases.openMigrated();
    const prices = new PriceRepo(db);

    // $0.25 / $1.25 / $0.3125 / $0.03 per Mtok. `cache_write` is the 3.125e-07 USD/token rate
    // §11.3 verified against a live community price table on 2026-07-20.
    prices.applyDocument(
      validatePriceDocument(
        priceDocument([
          {
            model: MODEL,
            rates: {
              input: 0.25,
              output: 1.25,
              cache_write: 0.3125,
              cache_write_1h: 0.5,
              cache_read: 0.03,
            },
            effectiveFrom: new Date(T0).toISOString(),
          },
        ]),
      ),
      { source: 'seed', sourceUrl: null, now: T0 },
    );

    const stored = db
      .prepare<{ token_class: string; rate_picousd_per_token: number }>(
        `SELECT token_class, rate_picousd_per_token FROM price_rows ORDER BY token_class`,
      )
      .all();

    // ── Hand-computed: USD/Mtok × 1e6 ────────────────────────────────────────────────────────
    //   cache_read     0.03   × 1e6 =      30_000
    //   cache_write    0.3125 × 1e6 =     312_500   ← the exact value nanoUSD could not hold
    //   cache_write_1h 0.5    × 1e6 =     500_000   (A-05, the fifth class)
    //   input          0.25   × 1e6 =     250_000
    //   output         1.25   × 1e6 =   1_250_000
    expect(stored).toEqual([
      { token_class: 'cache_read', rate_picousd_per_token: 30_000 },
      { token_class: 'cache_write', rate_picousd_per_token: 312_500 },
      { token_class: 'cache_write_1h', rate_picousd_per_token: 500_000 },
      { token_class: 'input', rate_picousd_per_token: 250_000 },
      { token_class: 'output', rate_picousd_per_token: 1_250_000 },
    ]);

    // ⚠️ And note what a derived cache_read would have been: 0.25 × 0.1 = 0.025, i.e. 25_000
    // pico — NOT the 30_000 that is actually published. That 20% error on the largest token class
    // in the dataset is precisely why ADR-024 records the user rejecting derived cache rates.
    expect(stored[0]?.rate_picousd_per_token).not.toBe(25_000);
  });
});
