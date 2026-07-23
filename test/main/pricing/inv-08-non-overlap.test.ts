// INV-08 — "No two `price_rows` with the same `(model, token_class)` have overlapping
// `[valid_from, valid_to)` ranges." (§3.11, ADR-024.)
//
// ⚠️ SQLite has no exclusion constraint, so this invariant is enforced by the REPOSITORY, inside
// the same write transaction as the write it guards. That makes it the one invariant in the
// schema that could be silently lost by a refactor, so it gets its own file — including the two
// cases a naive `valid_from < to AND from < valid_to` implementation gets wrong:
//
//   · NULL as +∞ — an open-ended row overlaps everything after its start.
//   · A RE-DATING edit (`pricing:setDates`) that would push one row into another.

import { describe, expect, it } from 'vitest';
import { PriceRepo } from '../../../src/main/pricing/price-repo';
import { validatePriceDocument } from '../../../src/main/pricing/price-document';
import { useSandbox } from '../../support/sandbox';
import { useTestDatabases } from '../db/helpers';
import { DAY_MS, T0, dumpPriceRows, flatRates, priceDocument } from './helpers';

const MODEL = 'claude-opus-4-8';

/** INV-08 as an executable predicate, checked over the whole table. */
function assertNoOverlaps(
  rows: { model: string; tokenClass: string; validFrom: number; validTo: number | null }[],
): void {
  for (const a of rows) {
    for (const b of rows) {
      if (a === b) continue;
      if (a.model !== b.model || a.tokenClass !== b.tokenClass) continue;
      const aEnd = a.validTo ?? Number.POSITIVE_INFINITY;
      const bEnd = b.validTo ?? Number.POSITIVE_INFINITY;
      expect(a.validFrom < bEnd && b.validFrom < aEnd).toBe(false);
    }
  }
}

describe('INV-08 — non-overlapping validity ranges', () => {
  const sandbox = useSandbox();
  const databases = useTestDatabases(sandbox);

  it('rejects an insert that would overlap an OPEN-ENDED row (NULL as +∞)', () => {
    const db = databases.openMigrated();
    const prices = new PriceRepo(db);

    // One open-ended row: [T0, ∞).
    prices.upsertRate({ model: MODEL, tokenClass: 'input', usdPerMillion: 5 }, T0);
    const before = dumpPriceRows(db);

    // ⚠️ Attempt to re-date an unrelated row into that open range. Build a second, closed row
    // first so there is something to move.
    prices.applyDocument(
      validatePriceDocument(
        priceDocument([
          { model: MODEL, rates: flatRates(9), effectiveFrom: new Date(T0 + DAY_MS).toISOString() },
        ]),
      ),
      { source: 'manual', sourceUrl: null, now: T0 },
    );

    const rows = prices.list({ model: MODEL, includeHistory: true });
    const inputRows = rows
      .filter((row) => row.tokenClass === 'input')
      .sort((a, b) => a.validFrom - b.validFrom);
    expect(inputRows).toHaveLength(2);
    // [T0, T0+1d) at $5 and [T0+1d, ∞) at $9 — adjacent, not overlapping.
    expect(inputRows[0]?.validTo).toBe(T0 + DAY_MS);
    expect(inputRows[1]?.validTo).toBeNull();

    // Now try to open the FIRST row's end back up to +∞. It would then overlap the second row,
    // which is the NULL-as-+∞ case on the OTHER side.
    const first = inputRows[0];
    expect(first).toBeDefined();
    expect(() =>
      prices.setDates({ id: first?.id ?? -1, validFrom: T0, validTo: null }, T0),
    ).toThrow(expect.objectContaining({ code: 'E_PRICE_OVERLAP' }));

    assertNoOverlaps(prices.list({ model: MODEL, includeHistory: true }));
    expect(before.length).toBeGreaterThan(0);
  });

  it('rejects a RE-DATING edit that would push one row into another', () => {
    const db = databases.openMigrated();
    const prices = new PriceRepo(db);

    prices.applyDocument(
      validatePriceDocument(
        priceDocument([
          { model: MODEL, rates: flatRates(3), effectiveFrom: new Date(T0).toISOString() },
          {
            model: MODEL,
            rates: flatRates(6),
            effectiveFrom: new Date(T0 + 10 * DAY_MS).toISOString(),
          },
        ]),
      ),
      { source: 'seed', sourceUrl: null, now: T0 },
    );

    const outputRows = prices
      .list({ model: MODEL, includeHistory: true })
      .filter((row) => row.tokenClass === 'output')
      .sort((a, b) => a.validFrom - b.validFrom);
    expect(outputRows).toHaveLength(2);

    const before = dumpPriceRows(db);
    const later = outputRows[1];
    expect(later).toBeDefined();

    // Move the LATER row's start back before the earlier row's end — a classic hand-correction
    // that must not be allowed to silently double-cover a week of usage.
    expect(() =>
      prices.setDates({ id: later?.id ?? -1, validFrom: T0 + 5 * DAY_MS, validTo: null }, T0),
    ).toThrow(expect.objectContaining({ code: 'E_PRICE_OVERLAP' }));

    // ⚠️ The transaction rolled back: the table is byte-identical.
    expect(dumpPriceRows(db)).toEqual(before);
    assertNoOverlaps(prices.list({ model: MODEL, includeHistory: true }));
  });

  it('allows a re-dating edit that only shortens a range — and leaves a legal GAP', () => {
    const db = databases.openMigrated();
    const prices = new PriceRepo(db);

    prices.upsertRate({ model: MODEL, tokenClass: 'input', usdPerMillion: 5 }, T0);
    const row = prices.list({ model: MODEL, includeHistory: true })[0];
    expect(row).toBeDefined();

    // §3.11: "Gaps are legal — a gap simply means the records inside it are uncosted and
    // disclosed." Closing the only row leaves [T0+1d, ∞) uncovered, and that is NOT an error.
    const after = prices.setDates({ id: row?.id ?? -1, validFrom: T0, validTo: T0 + DAY_MS }, T0);
    expect(after.rows[0]?.validTo).toBe(T0 + DAY_MS);
    expect(prices.rateAt(MODEL, 'input', T0 + DAY_MS)).toBeUndefined();
    assertNoOverlaps(after.rows);
  });

  it('rejects an inverted range with E_PRICE_RANGE, not with a raw constraint error', () => {
    const db = databases.openMigrated();
    const prices = new PriceRepo(db);
    prices.upsertRate({ model: MODEL, tokenClass: 'input', usdPerMillion: 5 }, T0);
    const row = prices.list({ model: MODEL, includeHistory: true })[0];

    expect(() =>
      prices.setDates({ id: row?.id ?? -1, validFrom: T0, validTo: T0 - 1 }, T0),
    ).toThrow(expect.objectContaining({ code: 'E_PRICE_RANGE' }));
  });

  it('allows different token classes and different models to share a range', () => {
    const db = databases.openMigrated();
    const prices = new PriceRepo(db);

    prices.applyDocument(
      validatePriceDocument(
        priceDocument([
          { model: MODEL, rates: flatRates(5), effectiveFrom: new Date(T0).toISOString() },
          {
            model: 'claude-haiku-4-5',
            rates: flatRates(1),
            effectiveFrom: new Date(T0).toISOString(),
          },
        ]),
      ),
      { source: 'seed', sourceUrl: null, now: T0 },
    );

    // Ten open-ended rows: five classes × two models, all `[T0, ∞)`. INV-08 is scoped to
    // `(model, token_class)`, and `uq_price_rows_open` allows one open row per that pair.
    const all = prices.list({ model: undefined, includeHistory: true });
    expect(all).toHaveLength(10);
    assertNoOverlaps(all);
  });
});
