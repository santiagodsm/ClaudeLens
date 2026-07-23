// FIXTURE F-08 — costing across a price change (§5.9.1, M-05, ADR-024).
//
//   "Usage before and after the boundary costed at its OWN row's rate; half-open `[from, to)`
//    means the boundary instant belongs to exactly one row."
//
// ⚠️ This is the user's stated requirement in their own words (PRD): "Usage joins to the price row
// valid at each record's own timestamp — NEVER to today's price." A fixture that only checked the
// total would pass even if every event were costed at the newest rate; this one puts events on
// both sides AND exactly ON the boundary instant, so the two readings disagree.
//
// Every expected value below is hand-computed with the arithmetic in the comment.
// `toMatchSnapshot()` is banned (STACK ADR-012).

import { describe, expect, it } from 'vitest';
import { CostCalculator } from '../../../src/main/pricing/cost';
import { PriceRepo } from '../../../src/main/pricing/price-repo';
import { validatePriceDocument } from '../../../src/main/pricing/price-document';
import { useSandbox } from '../../support/sandbox';
import { useTestDatabases } from '../db/helpers';
import { DAY_MS, T0, flatRates, insertEvents, priceDocument, seedSkeleton } from './helpers';

const MODEL = 'claude-sonnet-4-5-20250929';
const BOUNDARY = T0 + 10 * DAY_MS;

const ALL_TIME = { projectIds: null, from: null, to: null };

describe('F-08 — costing across a price change', () => {
  const sandbox = useSandbox();
  const databases = useTestDatabases(sandbox);

  it('costs usage before and after the boundary at its own row rate, half-open [from, to)', () => {
    const db = databases.openMigrated();
    seedSkeleton(db);
    const prices = new PriceRepo(db);

    // Two periods for ONE model, built through the real auto-versioning path (§3.11):
    //   [T0-1d, BOUNDARY) at $3.00/Mtok  → 3_000_000 picoUSD/token
    //   [BOUNDARY, ∞)     at $6.00/Mtok  → 6_000_000 picoUSD/token
    const opened = prices.applyDocument(
      validatePriceDocument(
        priceDocument([
          {
            model: MODEL,
            rates: flatRates(3),
            effectiveFrom: new Date(T0 - DAY_MS).toISOString(),
          },
        ]),
      ),
      { source: 'seed', sourceUrl: null, now: T0 },
    );
    expect(opened.applied).toHaveLength(5); // one per token class (five since A-05)

    const raised = prices.applyDocument(
      validatePriceDocument(
        priceDocument([
          {
            model: MODEL,
            rates: flatRates(6),
            effectiveFrom: new Date(BOUNDARY).toISOString(),
          },
        ]),
      ),
      { source: 'fetch', sourceUrl: 'https://example.invalid/prices.json', now: T0 + DAY_MS },
    );
    expect(raised.applied).toHaveLength(5);

    // The old row was closed AT the boundary and the new one opened AT the boundary — adjacency
    // with no gap and no double-cover (ADR-024).
    const inputRows = prices
      .list({ model: MODEL, includeHistory: true })
      .filter((row) => row.tokenClass === 'input')
      .sort((a, b) => a.validFrom - b.validFrom);
    expect(inputRows).toHaveLength(2);
    expect(inputRows[0]?.usdPerMillion).toBe(3);
    expect(inputRows[0]?.validTo).toBe(BOUNDARY);
    expect(inputRows[1]?.usdPerMillion).toBe(6);
    expect(inputRows[1]?.validFrom).toBe(BOUNDARY);
    expect(inputRows[1]?.validTo).toBeNull();

    // ⚠️ THE HALF-OPEN ASSERTION, STATED DIRECTLY. The boundary instant belongs to exactly one
    // row — the NEW one — and the instant one millisecond earlier belongs to the old one.
    expect(prices.rateAt(MODEL, 'input', BOUNDARY - 1)).toBe(3_000_000);
    expect(prices.rateAt(MODEL, 'input', BOUNDARY)).toBe(6_000_000);
    expect(prices.rateAt(MODEL, 'input', BOUNDARY + 1)).toBe(6_000_000);

    insertEvents(db, [
      // BEFORE the change: 1_000 input + 2_000 output at $3.00/Mtok.
      { eventKey: 'before', ts: BOUNDARY - DAY_MS, model: MODEL, input: 1_000, output: 2_000 },
      // EXACTLY ON the boundary: 1_000 input at the NEW rate (half-open [from, to)).
      { eventKey: 'boundary', ts: BOUNDARY, model: MODEL, input: 1_000 },
      // AFTER the change: 1_000 input + 2_000 output at $6.00/Mtok.
      { eventKey: 'after', ts: BOUNDARY + DAY_MS, model: MODEL, input: 1_000, output: 2_000 },
    ]);

    const result = new CostCalculator(db).cost(ALL_TIME);

    // ── Hand-computed, in picoUSD/token (ADR-023: USD/Mtok × 1e6) ────────────────────────────
    //   $3.00/Mtok = 3_000_000 pico/token · $6.00/Mtok = 6_000_000 pico/token
    //
    //   before   : 1_000 × 3_000_000 + 2_000 × 3_000_000 = 3.0e9 + 6.0e9 =  9_000_000_000 pico
    //   boundary : 1_000 × 6_000_000                     =                  6_000_000_000 pico
    //   after    : 1_000 × 6_000_000 + 2_000 × 6_000_000 = 6.0e9 + 12.0e9 = 18_000_000_000 pico
    //                                                              total  = 33_000_000_000 pico
    //   nanoUSD  : 33_000_000_000 / 1_000 (round-half-up) =                     33_000_000 nano
    //   (sanity in USD, produced only here for the reader: 33_000_000 / 1e9 = $0.033)
    expect(result.costNanoUsd).toBe(33_000_000);
    expect(result.costedEvents).toBe(3);
    expect(result.uncosted.records).toBe(0);

    // ⚠️ THE FAILING READING, ASSERTED AGAINST. If historical usage were costed at TODAY'S price
    // ($6.00), every event would be at 6_000_000 pico/token:
    //   (1_000 + 2_000 + 1_000 + 1_000 + 2_000) × 6_000_000 = 7_000 × 6e6 = 42_000_000_000 pico
    //                                                                     = 42_000_000 nano
    // That number must NOT be what we produce.
    expect(result.costNanoUsd).not.toBe(42_000_000);
  });

  it('costs a window that straddles the boundary from both rows, not from one', () => {
    const db = databases.openMigrated();
    seedSkeleton(db);
    const prices = new PriceRepo(db);

    prices.applyDocument(
      validatePriceDocument(
        priceDocument([
          { model: MODEL, rates: flatRates(3), effectiveFrom: new Date(T0).toISOString() },
        ]),
      ),
      { source: 'seed', sourceUrl: null, now: T0 },
    );
    prices.applyDocument(
      validatePriceDocument(
        priceDocument([
          { model: MODEL, rates: flatRates(6), effectiveFrom: new Date(BOUNDARY).toISOString() },
        ]),
      ),
      { source: 'manual', sourceUrl: null, now: T0 },
    );

    insertEvents(db, [
      { eventKey: 'a', ts: BOUNDARY - 1, model: MODEL, output: 1_000_000 },
      { eventKey: 'b', ts: BOUNDARY, model: MODEL, output: 1_000_000 },
    ]);

    const result = new CostCalculator(db).cost(ALL_TIME);

    // ── Hand-computed ────────────────────────────────────────────────────────────────────────
    //   a : 1_000_000 tok × 3_000_000 pico/tok = 3_000_000_000_000 pico  ($3.00)
    //   b : 1_000_000 tok × 6_000_000 pico/tok = 6_000_000_000_000 pico  ($6.00)
    //                                    total = 9_000_000_000_000 pico
    //   nanoUSD = 9_000_000_000_000 / 1_000    =     9_000_000_000 nano  ($9.00)
    expect(result.costNanoUsd).toBe(9_000_000_000);
    expect(result.costedEvents).toBe(2);
  });
});
