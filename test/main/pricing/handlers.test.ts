// The seven §4.7 pricing channels, and §3.11's auto-versioning as the user meets it.
//
// ⚠️ `pricing:models` is the surface that makes an unpriced model VISIBLE rather than silent
// (§4.7, ADR-025) — the Settings-side counterpart of the M-06 uncosted disclosure. It gets the
// most attention here, because "the user then fixes it with one Settings edit" is only true if
// the user can SEE what needs fixing.

import { describe, expect, it } from 'vitest';
import { PricingService } from '../../../src/main/pricing';
import { PriceRepo } from '../../../src/main/pricing/price-repo';
import { validatePriceDocument } from '../../../src/main/pricing/price-document';
import { useSandbox } from '../../support/sandbox';
import { useTestDatabases } from '../db/helpers';
import {
  DAY_MS,
  T0,
  dumpPriceRows,
  flatRates,
  insertEvents,
  priceDocument,
  seedSkeleton,
} from './helpers';

const OPUS = 'claude-opus-4-8';
const MYSTERY = 'claude-something-that-does-not-exist-yet';

describe('§4.7 pricing channels', () => {
  const sandbox = useSandbox();
  const databases = useTestDatabases(sandbox);

  it('pricing:models lists every observed model with priced telling the truth', async () => {
    const db = databases.openMigrated();
    seedSkeleton(db);
    insertEvents(db, [
      { eventKey: 'a', ts: T0, model: OPUS, output: 10 },
      { eventKey: 'b', ts: T0 + DAY_MS, model: OPUS, output: 10 },
      { eventKey: 'c', ts: T0 + 2 * DAY_MS, model: MYSTERY, output: 10 },
    ]);

    const app = new PricingService({ db, settings: { priceFetchUrl: '' }, now: () => T0 });
    app.seedIfEmpty();

    const result = await app.handlers()['pricing:models']();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.rows).toEqual([
      // The bundled seed knows Opus 4.8…
      { model: OPUS, events: 2, firstTs: T0, lastTs: T0 + DAY_MS, priced: true },
      // …and does not know this one. ⚠️ It is LISTED, by name, with `priced: false` — not
      // silently mapped to `claude-opus-4-8` because the strings look similar (ADR-025).
      {
        model: MYSTERY,
        events: 1,
        firstTs: T0 + 2 * DAY_MS,
        lastTs: T0 + 2 * DAY_MS,
        priced: false,
      },
    ]);
  });

  it('pricing:models excludes synthetic events from its counts (M-01)', async () => {
    const db = databases.openMigrated();
    seedSkeleton(db);
    insertEvents(db, [
      { eventKey: 'real', ts: T0, model: OPUS, output: 1 },
      { eventKey: 'fake', ts: T0 + 1, model: OPUS, output: 1, synthetic: true },
    ]);

    const app = new PricingService({ db, settings: { priceFetchUrl: '' }, now: () => T0 });
    const result = await app.handlers()['pricing:models']();
    expect(result.ok && result.data.rows[0]?.events).toBe(1);
  });

  it('pricing:upsertRate auto-versions on a change and writes nothing when nothing differs', async () => {
    const db = databases.openMigrated();
    const app = new PricingService({ db, settings: { priceFetchUrl: '' }, now: () => T0 });
    const handlers = app.handlers();

    const created = await handlers['pricing:upsertRate']({
      model: OPUS,
      tokenClass: 'input',
      usdPerMillion: 5,
      note: 'from the docs',
    });
    expect(created.ok && created.data.versioned).toBe(true);
    expect(created.ok && created.data.rows).toHaveLength(1);
    expect(created.ok && created.data.rows[0]?.note).toBe('from the docs');
    expect(created.ok && created.data.rows[0]?.source).toBe('manual');

    const snapshot = dumpPriceRows(db);

    // §3.11: "If nothing differs, nothing is written."
    const same = await handlers['pricing:upsertRate']({
      model: OPUS,
      tokenClass: 'input',
      usdPerMillion: 5,
    });
    expect(same.ok && same.data.versioned).toBe(false);
    expect(dumpPriceRows(db)).toEqual(snapshot);

    // A change at a LATER instant closes the old row and opens a new one — history for free.
    const later = new PricingService({
      db,
      settings: { priceFetchUrl: '' },
      now: () => T0 + DAY_MS,
    }).handlers();
    const raised = await later['pricing:upsertRate']({
      model: OPUS,
      tokenClass: 'input',
      usdPerMillion: 6,
    });
    expect(raised.ok && raised.data.versioned).toBe(true);
    if (!raised.ok) return;
    const rows = [...raised.data.rows].sort((a, b) => a.validFrom - b.validFrom);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.usdPerMillion).toBe(5);
    expect(rows[0]?.validFrom).toBe(T0);
    expect(rows[0]?.validTo).toBe(T0 + DAY_MS);
    expect(rows[1]?.usdPerMillion).toBe(6);
    expect(rows[1]?.validTo).toBeNull();
  });

  it('pricing:resetToSeed is ADDITIVE and never deletes a manual row', async () => {
    const db = databases.openMigrated();
    const prices = new PriceRepo(db);

    // A hand-entered rate for a model the seed also knows, effective long before the seed's own
    // start — the awkward case, where "reset" could plausibly be read as "throw mine away".
    prices.upsertRate(
      { model: OPUS, tokenClass: 'input', usdPerMillion: 99, note: 'mine' },
      Date.parse('2023-01-01T00:00:00.000Z'),
    );
    // And one for a model the seed does not know at all.
    prices.upsertRate({ model: MYSTERY, tokenClass: 'output', usdPerMillion: 42 }, T0);

    const manualBefore = db
      .prepare(`SELECT * FROM price_rows WHERE source = 'manual' ORDER BY id`)
      .all();
    expect(manualBefore).toHaveLength(2);

    const app = new PricingService({ db, settings: { priceFetchUrl: '' }, now: () => T0 });
    const reset = await app.handlers()['pricing:resetToSeed']();
    expect(reset.ok).toBe(true);

    // ⚠️ BOTH manual rows survive, ids intact. `applyDocument` contains no delete at all.
    const manualAfter = db
      .prepare<{ id: number; model: string }>(
        `SELECT id, model FROM price_rows WHERE source = 'manual' ORDER BY id`,
      )
      .all();
    expect(manualAfter).toHaveLength(2);
    expect(manualAfter.map((row) => row.model)).toEqual([OPUS, MYSTERY]);

    // The manual Opus rate was CLOSED at the seed's effective date rather than removed, so its
    // history is still there and still costs anything that happened before 2024-01-01.
    const opusInput = prices
      .list({ model: OPUS, includeHistory: true })
      .filter((row) => row.tokenClass === 'input')
      .sort((a, b) => a.validFrom - b.validFrom);
    expect(opusInput[0]?.usdPerMillion).toBe(99);
    expect(opusInput[0]?.source).toBe('manual');
    expect(opusInput[0]?.validTo).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
    expect(opusInput[1]?.usdPerMillion).toBe(5);
    expect(opusInput[1]?.source).toBe('seed');
  });

  it('pricing:deleteRow removes exactly one row and reports E_PRICE_NOT_FOUND for a stale id', async () => {
    const db = databases.openMigrated();
    const app = new PricingService({ db, settings: { priceFetchUrl: '' }, now: () => T0 });
    const handlers = app.handlers();

    await handlers['pricing:upsertRate']({ model: OPUS, tokenClass: 'input', usdPerMillion: 5 });
    const listed = await handlers['pricing:list']({ includeHistory: true });
    expect(listed.ok && listed.data.rows).toHaveLength(1);
    const id = listed.ok ? (listed.data.rows[0]?.id ?? -1) : -1;

    const deleted = await handlers['pricing:deleteRow']({ id });
    expect(deleted.ok && deleted.data.rows).toEqual([]);

    const again = await handlers['pricing:deleteRow']({ id });
    expect(again.ok).toBe(false);
    expect(again.ok ? null : again.error.code).toBe('E_PRICE_NOT_FOUND');
  });

  it('pricing:list honours includeHistory', async () => {
    const db = databases.openMigrated();
    const prices = new PriceRepo(db);
    prices.applyDocument(
      validatePriceDocument(
        priceDocument([
          { model: OPUS, rates: flatRates(3), effectiveFrom: new Date(T0).toISOString() },
          { model: OPUS, rates: flatRates(6), effectiveFrom: new Date(T0 + DAY_MS).toISOString() },
        ]),
      ),
      { source: 'seed', sourceUrl: null, now: T0 },
    );

    const app = new PricingService({ db, settings: { priceFetchUrl: '' }, now: () => T0 });
    const handlers = app.handlers();

    const withHistory = await handlers['pricing:list']({ model: OPUS, includeHistory: true });
    expect(withHistory.ok && withHistory.data.rows).toHaveLength(10); // 5 classes × 2 periods

    const currentOnly = await handlers['pricing:list']({ model: OPUS, includeHistory: false });
    expect(currentOnly.ok && currentOnly.data.rows).toHaveLength(5);
    expect(currentOnly.ok && currentOnly.data.rows.every((row) => row.validTo === null)).toBe(true);
  });

  it('never lets an exception cross the boundary — every failure is a typed Result (ADR-031)', async () => {
    const db = databases.openMigrated();
    const app = new PricingService({ db, settings: { priceFetchUrl: '' }, now: () => T0 });
    const handlers = app.handlers();

    const precision = await handlers['pricing:upsertRate']({
      model: OPUS,
      tokenClass: 'input',
      usdPerMillion: 1.23456789,
    });
    expect(precision.ok).toBe(false);
    expect(precision.ok ? null : precision.error.code).toBe('E_PRICE_PRECISION');
    // §4.1: `message` is "one sentence, user-facing, never a stack trace" — the stack, when there
    // is one, goes in `detail` and is rendered only behind "Details".
    expect(precision.ok ? '' : precision.error.message).not.toMatch(/\n|\bat [\w./]+:\d+/);
    expect(precision.ok ? true : precision.error.retryable).toBe(false);

    const notFound = await handlers['pricing:setDates']({
      id: 4_242,
      validFrom: T0,
      validTo: null,
    });
    expect(notFound.ok ? null : notFound.error.code).toBe('E_PRICE_NOT_FOUND');
  });

  it('pricing:fetch reports E_FETCH_NO_URL when the URL setting is empty (the shipped default)', async () => {
    const db = databases.openMigrated();
    const app = new PricingService({ db, settings: { priceFetchUrl: '' }, now: () => T0 });
    const result = await app.handlers()['pricing:fetch']();
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe('E_FETCH_NO_URL');
  });
});
