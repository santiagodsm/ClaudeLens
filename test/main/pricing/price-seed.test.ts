// The bundled seed — `resources/price-seed.json` (§3.11 "Seed", §4.7, PRD "Price source").
//
// ⚠️ THIS FILE SHIPS TO EVERY USER WHO CLONES THE REPO. A wrong seed price is precisely a
// silently wrong number, so these assertions are about the FILE, not about the loader: exact
// picoUSD values for rates whose published figures are known, all four classes present on every
// model (ADR-024 — stored, never derived), and an honest `generatedAt`.

import { describe, expect, it } from 'vitest';
import { PRICE_SEED_TEXT, loadPriceSeed } from '../../../src/main/pricing/seed';
import { TOKEN_CLASSES } from '../../../src/main/pricing/price-document';
import { PriceRepo } from '../../../src/main/pricing/price-repo';
import { PricingService } from '../../../src/main/pricing';
import { useSandbox } from '../../support/sandbox';
import { useTestDatabases } from '../db/helpers';
import { T0, dumpPriceRows } from './helpers';

describe('resources/price-seed.json', () => {
  const sandbox = useSandbox();
  const databases = useTestDatabases(sandbox);

  it('is a valid §4.7 document with an honest generatedAt', () => {
    const seed = loadPriceSeed();
    expect(seed.schema).toBe('claude-lens/price-table@1');
    // Honest: the date the published rates behind this file were read, not a placeholder.
    expect(seed.generatedAt).toBe('2026-07-22T00:00:00.000Z');
    expect(Number.isFinite(Date.parse(seed.generatedAt))).toBe(true);
  });

  it('prices ALL FOUR token classes for every model — stored, never derived (ADR-024)', () => {
    const parsed = JSON.parse(PRICE_SEED_TEXT) as {
      models: { model: string; rates: Record<string, unknown> }[];
    };
    expect(parsed.models.length).toBeGreaterThan(0);
    for (const entry of parsed.models) {
      // ⚠️ The user explicitly rejected computing cache rates from the base input rate via the
      // usual multipliers, "because that breaks silently the moment a model deviates from the
      // ratio". Every class is written out, per model, on purpose.
      expect(Object.keys(entry.rates).sort(), entry.model).toEqual([...TOKEN_CLASSES].sort());
      for (const tokenClass of TOKEN_CLASSES) {
        expect(typeof entry.rates[tokenClass], `${entry.model}.${tokenClass}`).toBe('number');
      }
    }
  });

  it('holds the published Claude rates exactly, in picoUSD per token', () => {
    const seed = loadPriceSeed();
    // Every model below has exactly ONE period in the seed, so (model, tokenClass) identifies it.
    // `claude-sonnet-5` is the sole two-period model and has its own test further down.
    const rate = (model: string, tokenClass: string): number | undefined => {
      const matches = seed.entries.filter(
        (entry) => entry.model === model && entry.tokenClass === tokenClass,
      );
      expect(matches, `${model}.${tokenClass} should have exactly one period`).toHaveLength(1);
      return matches[0]?.ratePicoUsdPerToken;
    };

    // ── Hand-computed: rate_picousd_per_token = USD per 1M tokens × 1e6 (§3.11) ──────────────
    //   Opus 4.8   $5 in / $25 out / $6.25 5m-cache-write / $0.50 cache-read
    expect(rate('claude-opus-4-8', 'input')).toBe(5_000_000);
    expect(rate('claude-opus-4-8', 'output')).toBe(25_000_000);
    expect(rate('claude-opus-4-8', 'cache_write')).toBe(6_250_000);
    expect(rate('claude-opus-4-8', 'cache_read')).toBe(500_000);

    //   Sonnet 4.6 $3 / $15 / $3.75 / $0.30
    expect(rate('claude-sonnet-4-6', 'input')).toBe(3_000_000);
    expect(rate('claude-sonnet-4-6', 'output')).toBe(15_000_000);
    expect(rate('claude-sonnet-4-6', 'cache_write')).toBe(3_750_000);
    expect(rate('claude-sonnet-4-6', 'cache_read')).toBe(300_000);

    //   Haiku 4.5  $1 / $5 / $1.25 / $0.10
    expect(rate('claude-haiku-4-5', 'input')).toBe(1_000_000);
    expect(rate('claude-haiku-4-5', 'cache_read')).toBe(100_000);

    //   Haiku 3.5  $0.80 / $4 / $1 / $0.08  ← note cache_read is 0.08, NOT 0.80 × 0.1 = 0.08…
    //   it happens to match here, but Haiku 3's published $0.03 against a $0.25 input does NOT.
    //   That is the whole reason rates are stored per class rather than derived (ADR-024).
    expect(rate('claude-3-5-haiku-20241022', 'input')).toBe(800_000);
    expect(rate('claude-3-5-haiku-20241022', 'output')).toBe(4_000_000);
    expect(rate('claude-3-5-haiku-20241022', 'cache_write')).toBe(1_000_000);
    expect(rate('claude-3-5-haiku-20241022', 'cache_read')).toBe(80_000);

    //   Opus 4.1   $15 / $75 / $18.75 / $1.50 — the pre-4.5 Opus tier
    expect(rate('claude-opus-4-1-20250805', 'output')).toBe(75_000_000);
    expect(rate('claude-opus-4-1-20250805', 'cache_write')).toBe(18_750_000);

    //   Fable 5 / Mythos 5  $10 / $50 / $12.50 5m-cache-write / $1
    expect(rate('claude-fable-5', 'input')).toBe(10_000_000);
    expect(rate('claude-fable-5', 'output')).toBe(50_000_000);
    expect(rate('claude-fable-5', 'cache_write')).toBe(12_500_000);
    expect(rate('claude-fable-5', 'cache_read')).toBe(1_000_000);
  });

  it('stores cache_write as the published 5-MINUTE rate — A-05 is open, not silently derived', () => {
    const seed = loadPriceSeed();
    const rate = (model: string, tokenClass: string): number | undefined =>
      seed.entries.find((e) => e.model === model && e.tokenClass === tokenClass)
        ?.ratePicoUsdPerToken;

    // ⚠️ A-05. The published table prices cache writes at TWO rates by TTL — 1.25x base input for
    // a 5-minute write and 2x for a 1-hour write — and `price_rows.token_class` has exactly ONE
    // `cache_write` member (§3.11). The seed carries the 5-minute rate, so a 1-hour write is
    // under-costed. This test PINS which of the two is stored, so the choice is a recorded fact
    // rather than an accident someone re-derives later.
    //
    // Hand-computed from docs/en/about-claude/pricing, verified 2026-07-22, in picoUSD/token
    // (USD per 1M tokens x 1e6). The 1h column is written out beside it to show the gap:
    //                          input        5m write (stored)   1h write (NOT representable)
    //   Opus 4.8               $5           $6.25               $10
    //   Fable 5                $10          $12.50              $20
    //   Sonnet 5 (intro)       $2           $2.50               $4
    //   Haiku 4.5              $1           $1.25               $2
    expect(rate('claude-opus-4-8', 'cache_write')).toBe(6_250_000);
    expect(rate('claude-fable-5', 'cache_write')).toBe(12_500_000);
    expect(rate('claude-haiku-4-5-20251001', 'cache_write')).toBe(1_250_000);

    // The 5m rate is 1.25x input for every model on the published table as of 2026-07-22 — but it
    // is asserted here as the STORED LITERAL, never computed from `input`. ADR-024 records the
    // user's explicit rejection of deriving cache rates: "it breaks silently the moment a model
    // deviates from the ratio". The equality below is an observation, not the source of the value.
    expect(rate('claude-opus-4-8', 'cache_write')).not.toBe(rate('claude-opus-4-8', 'input'));
  });

  it('dates every rate from a source, and says so when it could not', () => {
    const parsed = JSON.parse(PRICE_SEED_TEXT) as {
      models: { model: string; effectiveFrom: string; note: string }[];
    };
    const entry = (model: string, effectiveFrom: string) =>
      parsed.models.find((m) => m.model === model && m.effectiveFrom === effectiveFrom);

    // ── SOURCED availability dates ──────────────────────────────────────────────────────────
    // Fable 5 / Mythos 5: "generally available on the Claude API ... beginning June 9, 2026"
    // (docs/en/about-claude/models/overview).
    expect(entry('claude-fable-5', '2026-06-09T00:00:00.000Z')).toBeDefined();
    expect(entry('claude-mythos-5', '2026-06-09T00:00:00.000Z')).toBeDefined();
    // Dated snapshots take the release date pinned in their own model id.
    expect(entry('claude-haiku-4-5-20251001', '2025-10-01T00:00:00.000Z')).toBeDefined();
    expect(entry('claude-sonnet-4-5-20250929', '2025-09-29T00:00:00.000Z')).toBeDefined();
    expect(entry('claude-opus-4-5-20251101', '2025-11-01T00:00:00.000Z')).toBeDefined();
    expect(entry('claude-opus-4-1-20250805', '2025-08-05T00:00:00.000Z')).toBeDefined();
    expect(entry('claude-3-5-haiku-20241022', '2024-10-22T00:00:00.000Z')).toBeDefined();

    // ── UNSOURCED: an early sentinel, and it MUST say so ────────────────────────────────────
    // §1.5 — a wrong number is invisible, an admitted gap is visible. These six are dateless
    // snapshots with no published availability date. An over-early `valid_from` is safe by
    // construction (no event can predate its own model) and is disclosed in the note; a guessed
    // exact date would be neither.
    for (const model of [
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ]) {
      const row = entry(model, '2024-01-01T00:00:00.000Z');
      expect(row, model).toBeDefined();
      expect(row?.note, model).toContain('UNVERIFIED');
    }
    // Sonnet 5's introductory period starts unverified but ENDS on a sourced date (below).
    expect(entry('claude-sonnet-5', '2024-01-01T00:00:00.000Z')?.note).toContain('UNVERIFIED');
    expect(entry('claude-sonnet-5', '2026-09-01T00:00:00.000Z')?.note).toContain('SOURCED');

    // Every entry carries provenance — there is no undocumented rate in a published seed. The
    // note must name the date its rates were read off the published page, and that date must be
    // one this repo has actually swept: 2026-07-22 for the original table, 2026-07-24 for the
    // `claude-opus-5` row added afterwards. A free-form date regex would pass a typo; an
    // enumeration makes adding an unswept entry a test failure rather than a silent one.
    const VERIFIED_ON = ['2026-07-22', '2026-07-24'];
    for (const model of parsed.models) {
      expect(typeof model.note, model.model).toBe('string');
      expect(
        VERIFIED_ON.some((date) => model.note.includes(date)),
        `${model.model} note must cite one of ${VERIFIED_ON.join(' / ')}`,
      ).toBe(true);
    }
  });

  it('prices all four models the reference dataset actually uses', () => {
    const db = databases.openMigrated();
    new PricingService({ db, settings: { priceFetchUrl: '' }, now: () => T0 }).seedIfEmpty();
    const prices = new PriceRepo(db);

    // M-05/INV-09: an event is costed only if EVERY non-zero class has a covering row. These are
    // the only four models with events in the reference dataset, so an uncovered class here is
    // the difference between a real dollar figure and a fully-uncosted disclosure.
    const at = Date.parse('2026-07-22T00:00:00.000Z');
    for (const model of [
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-haiku-4-5-20251001',
    ]) {
      for (const tokenClass of TOKEN_CLASSES) {
        expect(prices.rateAt(model, tokenClass, at), `${model}.${tokenClass}`).toBeGreaterThan(0);
      }
    }

    // …and each model's covering row starts at or before the first event observed for it, so no
    // real usage falls into a gap. Earliest observed: opus-4-8 2026-06-26, sonnet-5 2026-07-02,
    // fable-5 2026-07-01, haiku-4-5-20251001 2026-07-21.
    expect(prices.rateAt('claude-fable-5', 'input', Date.parse('2026-07-01T00:00:00.000Z'))).toBe(
      10_000_000,
    );
    expect(prices.rateAt('claude-opus-4-8', 'input', Date.parse('2026-06-26T00:00:00.000Z'))).toBe(
      5_000_000,
    );
  });

  it('carries BOTH the alias and the dated model id, because pricing keys on the exact string', () => {
    const seed = loadPriceSeed();
    const models = new Set(seed.entries.map((entry) => entry.model));
    // ADR-025: "`price_rows.model` matches `events.model` with `=`, case-sensitive, byte-for-byte.
    // There is no alias table, no prefix match, no version-stripping." A transcript that recorded
    // `claude-sonnet-4-5-20250929` gets nothing from a row keyed `claude-sonnet-4-5`, so both are
    // seeded as separate rows rather than resolved by a rule.
    expect(models.has('claude-sonnet-4-5')).toBe(true);
    expect(models.has('claude-sonnet-4-5-20250929')).toBe(true);
    expect(models.has('claude-haiku-4-5')).toBe(true);
    expect(models.has('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('encodes the scheduled Sonnet 5 price change as TWO periods, not as one current rate', () => {
    const db = databases.openMigrated();
    new PricingService({ db, settings: { priceFetchUrl: '' }, now: () => T0 }).seedIfEmpty();

    const rows = new PriceRepo(db)
      .list({ model: 'claude-sonnet-5', includeHistory: true })
      .filter((row) => row.tokenClass === 'input')
      .sort((a, b) => a.validFrom - b.validFrom);

    // Introductory pricing runs through 2026-08-31; $3/MTok takes effect 2026-09-01.
    expect(rows).toHaveLength(2);
    expect(rows[0]?.usdPerMillion).toBe(2);
    expect(rows[0]?.validTo).toBe(Date.parse('2026-09-01T00:00:00.000Z'));
    expect(rows[1]?.usdPerMillion).toBe(3);
    expect(rows[1]?.validFrom).toBe(Date.parse('2026-09-01T00:00:00.000Z'));
    expect(rows[1]?.validTo).toBeNull();

    // ⚠️ This is the bi-temporal point in miniature: usage in August is costed at $2 and usage in
    // September at $3, from the same table, without anyone editing anything.
    const prices = new PriceRepo(db);
    expect(prices.rateAt('claude-sonnet-5', 'input', Date.parse('2026-08-31T23:59:59.999Z'))).toBe(
      2_000_000,
    );
    expect(prices.rateAt('claude-sonnet-5', 'input', Date.parse('2026-09-01T00:00:00.000Z'))).toBe(
      3_000_000,
    );
  });

  it('loads as source=seed rows, and a second load writes nothing', () => {
    const db = databases.openMigrated();
    const service = new PricingService({ db, settings: { priceFetchUrl: '' }, now: () => T0 });

    const first = service.seedIfEmpty();
    expect(first.applied).toBeGreaterThan(0);
    expect(first.unchanged).toBe(0);

    const sources = db
      .prepare<{ source: string; n: number }>(
        `SELECT source, COUNT(*) AS n FROM price_rows GROUP BY source`,
      )
      .all();
    expect(sources).toEqual([{ source: 'seed', n: first.applied }]);

    const afterFirst = dumpPriceRows(db);
    const second = service.seedIfEmpty();
    expect(second.applied).toBe(0);
    expect(dumpPriceRows(db)).toEqual(afterFirst);
  });

  it('is small enough to ship and contains no personal data', () => {
    // P-33: this repo is published. The seed is model ids and numbers, nothing else.
    expect(PRICE_SEED_TEXT.length).toBeLessThan(64 * 1024);
    expect(PRICE_SEED_TEXT).not.toMatch(/\/(Users|home)\//);
  });
});
