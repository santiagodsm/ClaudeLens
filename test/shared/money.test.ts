// Unit tests for src/shared/money.ts — §3.11, ADR-023 (AMENDED), fixture F-10.
//
// Every expected value below is hand-computed with the arithmetic in a comment (CLAUDE.md §1).
// No snapshot: an auto-written snapshot of a money conversion is a machine for blessing the bug.

import { describe, expect, it } from 'vitest';
import {
  MAX_USD_PER_MILLION,
  MAX_USD_PER_MILLION_DECIMALS,
  PICO_USD_PER_NANO_USD,
  PICO_USD_PER_TOKEN_PER_USD_PER_MILLION,
  assertSafeAggregate,
  isSafeAggregate,
  picoToNanoUsd,
  picoUsdPerTokenToUsdPerMillion,
  usdPerMillionToPicoUsdPerToken,
} from '../../src/shared/money';

/** Unwraps a `Result` in a test, failing loudly rather than silently coercing. */
function expectOk(result: ReturnType<typeof usdPerMillionToPicoUsdPerToken>): number {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.data;
}

describe('§3.11 / ADR-023 — the unit constants', () => {
  it('states the two divisors once', () => {
    expect(PICO_USD_PER_TOKEN_PER_USD_PER_MILLION).toBe(1_000_000);
    expect(PICO_USD_PER_NANO_USD).toBe(1_000);
  });

  it('accepts six decimal places of USD/Mtok, not the pre-amendment three', () => {
    // ADR-023 amendment: "the input limit is **six** decimal places of USD/Mtok".
    expect(MAX_USD_PER_MILLION_DECIMALS).toBe(6);
  });

  it('bounds USD/Mtok so picoUSD/token stays a safe integer (INV-11)', () => {
    // floor(9_007_199_254_740_991 / 1e6) = 9_007_199_254
    expect(MAX_USD_PER_MILLION).toBe(9_007_199_254);
  });
});

describe('usdPerMillionToPicoUsdPerToken — §3.11 worked examples', () => {
  it('$15.00/Mtok -> 15_000_000 picoUSD/token', () => {
    // 15.00 × 1e6 = 15_000_000
    expect(expectOk(usdPerMillionToPicoUsdPerToken(15.0))).toBe(15_000_000);
  });

  it('$1.50/Mtok -> 1_500_000 picoUSD/token', () => {
    // 1.50 × 1e6 = 1_500_000
    expect(expectOk(usdPerMillionToPicoUsdPerToken(1.5))).toBe(1_500_000);
  });

  it('$75.00/Mtok -> 75_000_000 picoUSD/token', () => {
    // 75.00 × 1e6 = 75_000_000  (the §4.7 seed document's output rate)
    expect(expectOk(usdPerMillionToPicoUsdPerToken(75.0))).toBe(75_000_000);
  });

  it('$18.75/Mtok -> 18_750_000 picoUSD/token', () => {
    // 18.75 × 1e6 = 18_750_000  (the §4.7 seed document's cache_write rate)
    expect(expectOk(usdPerMillionToPicoUsdPerToken(18.75))).toBe(18_750_000);
  });

  it('$0.30/Mtok -> 300_000 picoUSD/token', () => {
    // 0.30 × 1e6 = 300_000  (ADR-023 "$0.30 -> 300" nanoUSD, i.e. 300_000 picoUSD)
    expect(expectOk(usdPerMillionToPicoUsdPerToken(0.3))).toBe(300_000);
  });

  it('$0/Mtok -> 0', () => {
    expect(expectOk(usdPerMillionToPicoUsdPerToken(0))).toBe(0);
  });

  it('uses all six decimal places exactly: $0.000001/Mtok -> 1 picoUSD/token', () => {
    // 0.000001 × 1e6 = 1 — one picoUSD per token, the finest representable rate.
    expect(expectOk(usdPerMillionToPicoUsdPerToken(0.000001))).toBe(1);
  });

  it('is exact for a six-decimal value a float multiply would smear', () => {
    // 0.123456 × 1e6 in IEEE-754 doubles is 123456.00000000001, not 123456.
    // The decimal-string path returns the integer, not the smear.
    expect(expectOk(usdPerMillionToPicoUsdPerToken(0.123456))).toBe(123_456);
  });
});

describe('F-10 — the rate precision fixture (ADR-023 as amended)', () => {
  it('stores $0.3125/Mtok exactly as 312500 picoUSD/token', () => {
    // The real published cache_creation_input_token_cost = 3.125e-07 USD/token
    //   = $0.3125 per 1M tokens
    //   = 0.3125 × 1e6 = 312_500 picoUSD/token, an exact integer.
    // In the originally-locked nanoUSD unit this is 312.5 — not an integer — which is the
    // fact that forced ADR-023's amendment.
    expect(expectOk(usdPerMillionToPicoUsdPerToken(0.3125))).toBe(312_500);
  });

  it('round-trips $0.3125/Mtok through Settings without loss', () => {
    // 312_500 / 1e6 = 0.3125
    expect(picoUsdPerTokenToUsdPerMillion(312_500)).toBe(0.3125);
    expect(expectOk(usdPerMillionToPicoUsdPerToken(picoUsdPerTokenToUsdPerMillion(312_500)))).toBe(
      312_500,
    );
  });

  it('REJECTS a 7-decimal input with E_PRICE_PRECISION rather than rounding it', () => {
    // 0.3125001 has seven decimal places of USD/Mtok = 312_500.1 picoUSD/token.
    // Rounding it to 312_500 would multiply a wrong rate into every total that uses it, so
    // ADR-023 rejects instead. This assertion is the whole point of the amendment.
    const result = usdPerMillionToPicoUsdPerToken(0.3125001);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('E_PRICE_PRECISION');
    expect(result.error.retryable).toBe(false);
  });

  it('rejects a 7-decimal input even when the 7th digit would round away to nothing', () => {
    // 0.0000001 (1e-7 USD/Mtok) = 0.1 picoUSD/token. toFixed(6) would make it 0.000000,
    // i.e. a rate of ZERO — a free model. Rejected, never silently zeroed.
    const result = usdPerMillionToPicoUsdPerToken(0.0000001);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('E_PRICE_PRECISION');
  });
});

describe('usdPerMillionToPicoUsdPerToken — rejections', () => {
  it('rejects a negative rate (§3.11 CHECK rate_picousd_per_token >= 0)', () => {
    const result = usdPerMillionToPicoUsdPerToken(-1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('E_INVALID_SETTING');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects %p', (value) => {
    const result = usdPerMillionToPicoUsdPerToken(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('E_INVALID_SETTING');
  });

  it('rejects a rate whose picoUSD form would breach MAX_SAFE_INTEGER (INV-11)', () => {
    // MAX_USD_PER_MILLION + 1 = 9_007_199_255 -> 9.007199255e15 picoUSD > 9.007199254740991e15
    const result = usdPerMillionToPicoUsdPerToken(MAX_USD_PER_MILLION + 1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('E_INVALID_SETTING');
  });
});

describe('picoToNanoUsd — integer division, round-half-up (ADR-023)', () => {
  it('divides exactly when there is no remainder', () => {
    // 15_000_000 / 1000 = 15_000
    expect(picoToNanoUsd(15_000_000)).toBe(15_000);
  });

  it('rounds a tie UP: 1500 pico -> 2 nano', () => {
    // 1500 / 1000 = 1.5, half-up -> 2
    expect(picoToNanoUsd(1_500)).toBe(2);
  });

  it('rounds a tie UP at zero: 500 pico -> 1 nano', () => {
    // 500 / 1000 = 0.5, half-up -> 1
    expect(picoToNanoUsd(500)).toBe(1);
  });

  it('rounds below the tie DOWN: 499 pico -> 0 nano', () => {
    // 499 / 1000 = 0.499, half-up -> 0
    expect(picoToNanoUsd(499)).toBe(0);
  });

  it('rounds just above the tie up: 501 pico -> 1 nano', () => {
    // 501 / 1000 = 0.501 -> 1
    expect(picoToNanoUsd(501)).toBe(1);
  });

  it('keeps 0 at 0', () => {
    expect(picoToNanoUsd(0)).toBe(0);
  });

  it('converts the §3.11 worst-case total exactly', () => {
    // §3.11: ~6.42e7 output tokens at $75/Mtok = 6.42e7 × 75_000_000 pico = 4.815e15 picoUSD.
    // 4_815_000_000_000_000 / 1000 = 4_815_000_000_000 nanoUSD (= $4,815.00).
    expect(picoToNanoUsd(4_815_000_000_000_000)).toBe(4_815_000_000_000);
  });

  it('is exact for a tie near MAX_SAFE_INTEGER, where a double add would not be', () => {
    // 9_007_199_254_739_500 + 500 = 9_007_199_254_740_000, exactly divisible by 1000.
    // 9_007_199_254_740_000 / 1000 = 9_007_199_254_740
    expect(picoToNanoUsd(9_007_199_254_739_500)).toBe(9_007_199_254_740);
  });

  it('throws rather than silently rounding an unsafe `number` input (INV-11)', () => {
    // A picoUSD total that arrives as a `number` past the bound was ALREADY corrupted by
    // whatever narrowed it, so it is refused rather than converted. SQL sums no longer take
    // this path — see the `bigint` cases below.
    expect(() => picoToNanoUsd(Number.MAX_SAFE_INTEGER + 2)).toThrow(/INV-11/);
  });

  // ⚠️ AMENDED 2026-07-22 — §3.11's two-unit rule, in the unit it is actually about.
  //
  // The bug this pins: `totals()`/`totalsGroupedBy()` narrowed the picoUSD sum to a `number` as it
  // left SQL and asserted INV-11 there, which is $9,007 of lifetime spend in this unit. §3.11 says
  // the conversion happens BEFORE the value crosses IPC precisely BECAUSE picoUSD outgrows
  // `Number.MAX_SAFE_INTEGER` while nanoUSD does not. So the input is a `bigint` and is not
  // bounds-checked; only the result is.
  describe('picoUSD past MAX_SAFE_INTEGER converts exactly from a bigint', () => {
    it('converts a total that a `number` could not have held', () => {
      // 144_575_000_002_891_500 pico is 1.6× MAX_SAFE_INTEGER — $144,575.000002892 of spend.
      // (144_575_000_002_891_500 + 500) / 1000 = 144_575_000_002_892 nanoUSD.
      expect(picoToNanoUsd(144_575_000_002_891_500n)).toBe(144_575_000_002_892);
      // ⚠️ The discriminator. `Number(144_575_000_002_891_500n)` is 144_575_000_002_891_488 —
      // twelve picoUSD low, because at ~1.4e17 a double's neighbours are 32 apart. That drags the
      // round-half-up division one nanoUSD down, to a figure that is invisible on screen and
      // wrong in the data.
      expect(BigInt(Number(144_575_000_002_891_500n))).toBe(144_575_000_002_891_488n);
      expect(picoToNanoUsd(144_575_000_002_891_500n)).not.toBe(144_575_000_002_891);
      // And the narrowed value cannot even be handed back in: the `number` overload refuses it,
      // which is why the picoUSD sum has to stay a `bigint` from SQLite onward rather than be
      // checked after the fact.
      expect(() => picoToNanoUsd(Number(144_575_000_002_891_500n))).toThrow(/INV-11/);
    });

    it('accepts the largest picoUSD total whose nanoUSD form is representable', () => {
      // Rounds DOWN to exactly MAX_SAFE_INTEGER nanoUSD ($9,007,199.254740991).
      expect(picoToNanoUsd(9_007_199_254_740_991_499n)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('still refuses a nanoUSD RESULT past the bound — the guard moved, it did not go', () => {
      // One picoUSD more tips the round-half-up into 9_007_199_254_740_992 nanoUSD, which is not
      // a safe integer. INV-11 reports rather than rounds, and names the unit it is about.
      expect(() => picoToNanoUsd(9_007_199_254_740_991_500n)).toThrow(/INV-11/);
      expect(() => picoToNanoUsd(9_007_199_254_740_991_500n)).toThrow(/costNanoUsd/);
    });
  });
});

describe('picoUsdPerTokenToUsdPerMillion — the §4.7 presentation form', () => {
  it.each([
    [15_000_000, 15],
    [1_500_000, 1.5],
    [312_500, 0.3125],
    [1, 0.000001],
    [0, 0],
  ])('%d picoUSD/token -> $%p/Mtok', (pico, usd) => {
    expect(picoUsdPerTokenToUsdPerMillion(pico)).toBe(usd);
  });

  it('throws on a non-integer stored rate — the INTEGER column would have been violated', () => {
    expect(() => picoUsdPerTokenToUsdPerMillion(312_500.5)).toThrow(/INV-11/);
  });
});

// A-10: `isSafeAggregate` is the SINGLE definition of INV-11's bound. The DB layer's
// `assertSafeAggregate` (src/main/db/repositories/base.ts) mints `DbError('E_INTERNAL')` from
// this same predicate and is exercised in test/main/db/base-repository.test.ts; the two suites
// together are INV-11's coverage, and the predicate's own arithmetic is pinned here.
describe('INV-11 — the shared predicate, the one definition of the bound', () => {
  it('accepts every safe integer and rejects everything above the bound', () => {
    expect(isSafeAggregate(0)).toBe(true);
    expect(isSafeAggregate(3_100_000_000)).toBe(true);
    expect(isSafeAggregate(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isSafeAggregate(-Number.MAX_SAFE_INTEGER)).toBe(true);
    // 2^53 + 1 is not representable: it rounds to 2^53, which is the silent-rounding failure.
    expect(isSafeAggregate(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
    expect(isSafeAggregate(-(Number.MAX_SAFE_INTEGER + 2))).toBe(false);
  });

  it('rejects a non-integer or non-finite number', () => {
    expect(isSafeAggregate(1.5)).toBe(false);
    expect(isSafeAggregate(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSafeAggregate(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isSafeAggregate(Number.NaN)).toBe(false);
  });

  // ⚠️ A-10, the case that used to be latent: `safeIntegers` on a statement makes SQLite hand
  // back `bigint`, and `Number.isSafeInteger` is `false` for EVERY bigint — so an unwidened
  // check would have rejected `9007199254740991n`, a perfectly representable total. It was
  // unreachable only because `sumToSafeNumber` narrowed one frame below, which is call order,
  // not a guarantee. The predicate now compares bigints as bigints.
  it('judges a bigint by its value, not by its type', () => {
    expect(isSafeAggregate(0n)).toBe(true);
    expect(isSafeAggregate(3_100_000_000n)).toBe(true);
    expect(isSafeAggregate(BigInt(Number.MAX_SAFE_INTEGER))).toBe(true); // exactly at the bound
    expect(isSafeAggregate(-BigInt(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(isSafeAggregate(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBe(false); // one past it
    expect(isSafeAggregate(-BigInt(Number.MAX_SAFE_INTEGER) - 1n)).toBe(false);
    expect(isSafeAggregate(10n ** 30n)).toBe(false);
  });
});

describe('INV-11 — the shared layer mints a RangeError from that predicate', () => {
  it('passes a safe integer straight through', () => {
    expect(assertSafeAggregate(0, 'tokens')).toBe(0);
    expect(assertSafeAggregate(3_100_000_000, 'cacheReads')).toBe(3_100_000_000);
    expect(assertSafeAggregate(4_815_000_000_000, 'costNanoUsd')).toBe(4_815_000_000_000);
    expect(assertSafeAggregate(Number.MAX_SAFE_INTEGER, 'tok_cache_read')).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('widens a bigint inside the bound instead of throwing on its type', () => {
    expect(assertSafeAggregate(42n, 'tokens')).toBe(42);
    expect(assertSafeAggregate(BigInt(Number.MAX_SAFE_INTEGER), 'picoUsd')).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('names the quantity in the thrown detail so E_INTERNAL is actionable', () => {
    expect(() => assertSafeAggregate(Number.MAX_SAFE_INTEGER + 2, 'tok_output')).toThrow(
      /tok_output/,
    );
    expect(() => assertSafeAggregate(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'tok_output')).toThrow(
      /tok_output/,
    );
  });

  it('rejects a non-integer, non-finite or out-of-bound aggregate', () => {
    expect(() => assertSafeAggregate(1.5, 'activeSeconds')).toThrow(RangeError);
    expect(() => assertSafeAggregate(Number.POSITIVE_INFINITY, 'seconds')).toThrow(RangeError);
    expect(() => assertSafeAggregate(Number.NaN, 'seconds')).toThrow(RangeError);
    expect(() =>
      assertSafeAggregate(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'lifetimeTokens'),
    ).toThrow(RangeError);
  });
});
