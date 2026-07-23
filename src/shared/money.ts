// src/shared/money.ts — the money unit conversions (§3.11, ADR-023 as AMENDED 2026-07-20).
//
// Three units, and each has exactly one job:
//
//   picoUSD per token   `price_rows.rate_picousd_per_token INTEGER` = USD per 1M tokens × 1e6.
//                       SQL multiplies and sums in this unit; all cost arithmetic is integer.
//   nanoUSD             the WIRE unit. The repository converts picoUSD → nanoUSD (integer
//                       division, round-half-up) BEFORE the value crosses IPC, because picoUSD
//                       totals can approach Number.MAX_SAFE_INTEGER while the same total in
//                       nanoUSD has three orders of headroom. `costNanoUsd` is the type of every
//                       `$` field in §4.
//   USD                 produced ONCE, at the presentation edge, by dividing by 1e9. Not here.
//
// ⚠️ ADR-023's amendment, and the reason this file exists at all: a REAL published rate is
// `3.125e-07` USD/token (`$0.3125/Mtok`). In the originally-locked nanoUSD unit that is `312.5`
// — not an integer — so the unit would have had to round it, and **a rounded rate multiplies
// into every total that uses it**, which is strictly worse than a rounded total (CLAUDE.md §1).
// picoUSD represents it exactly, as `312_500`. Fixture F-10 pins it.
//
// Pure functions, no I/O, no floating-point in the value path: every conversion below is either
// exact decimal string arithmetic or BigInt.

import type { AppError, ErrorCode, Result } from './ipc-contract';

// ---------------------------------------------------------------------------
// §3.11 / ADR-023 (amended) — the unit constants
// ---------------------------------------------------------------------------

/** §3.11 — `rate_picousd_per_token = USD per 1M tokens × 1e6`. */
export const PICO_USD_PER_TOKEN_PER_USD_PER_MILLION = 1_000_000;

/** ADR-023 — 1 nanoUSD = 1000 picoUSD. The picoUSD → wire-unit divisor. */
export const PICO_USD_PER_NANO_USD = 1_000;

/**
 * ADR-023 as **amended**: Settings accepts USD/Mtok to **six** decimal places and rejects
 * anything finer with `E_PRICE_PRECISION` rather than rounding it away. Six decimal places of
 * USD/Mtok is exactly one picoUSD per token — the finest rate the storage unit can hold.
 *
 * ⚠️ §4.1's inline comment on `E_PRICE_PRECISION` still says "three decimal places"; that is
 * the pre-amendment text. §3.11, ADR-023's amendment block and fixture F-10 all say six.
 */
export const MAX_USD_PER_MILLION_DECIMALS = 6;

/**
 * The largest USD/Mtok input whose picoUSD/token form still fits inside
 * `Number.MAX_SAFE_INTEGER` (INV-11). Anything above it cannot be represented and is rejected
 * rather than silently rounded.
 */
export const MAX_USD_PER_MILLION = Math.floor(
  Number.MAX_SAFE_INTEGER / PICO_USD_PER_TOKEN_PER_USD_PER_MILLION,
);

// ---------------------------------------------------------------------------
// The two error shapes this module can produce
// ---------------------------------------------------------------------------
//
// The split is principled, not stylistic:
//
//   · A rate the USER typed that the unit cannot hold is DATA. It comes back as
//     `Result` with a specific `ErrorCode` so §6.10 can render the right sentence under the
//     right field, and so it can never be mistaken for an internal fault (§4.1 rule 2).
//   · A value that breaches INV-11 is a PROGRAMMING fault. It throws, and the one
//     `withResult()` wrapper turns it into `E_INTERNAL` with the stack in `detail`
//     (§4.1 rule 1, ADR-031) — "the repository asserts this and returns `E_INTERNAL` rather
//     than a silently-rounded number" (INV-11), which is exactly that path.

function fail(code: ErrorCode, message: string, detail: string): Result<never> {
  const error: AppError = { code, message, detail, retryable: false };
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// INV-11 — the MAX_SAFE predicate, defined ONCE (A-10)
// ---------------------------------------------------------------------------

/** INV-11 — the bound itself, as a BigInt, so a `bigint` is compared without narrowing. */
const MAX_SAFE_AGGREGATE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * INV-11 — **the** definition of "this aggregate is representable exactly as a JS number".
 *
 * ⚠️ A-10: this predicate is the single arithmetic truth of INV-11. It was implemented twice
 * — once here and once in `src/main/db/repositories/base.ts` — and a bug fixed in one copy
 * would not have been fixed in the other. Each layer now mints its *own error* from this one
 * predicate (the DB layer a `DbError('E_INTERNAL')`, this layer a `RangeError`), because
 * `src/shared/**` cannot import `DbError` without inverting the layering. The predicate is
 * total and pure: no throw, no I/O, defined for every input of its type.
 *
 * `bigint` is accepted because `safeIntegers` may be enabled on a statement (§3.5, §3.11):
 * SQLite's 64-bit sums can arrive as `bigint`, and a `bigint` inside the bound is a perfectly
 * representable value. It is compared as a `bigint` — `Number.isSafeInteger` returns `false`
 * for *every* `bigint`, so widening before the check would reject valid totals.
 *
 * Bound (both types): `-(2^53 − 1) <= value <= 2^53 − 1`, integers only. `NaN`, `±Infinity`
 * and any fractional `number` are unsafe by construction.
 */
export function isSafeAggregate(value: number | bigint): boolean {
  if (typeof value === 'bigint') {
    return value >= -MAX_SAFE_AGGREGATE && value <= MAX_SAFE_AGGREGATE;
  }
  return Number.isSafeInteger(value);
}

/**
 * INV-11 — "Every numeric aggregate crossing IPC is `<= Number.MAX_SAFE_INTEGER`; the
 * repository asserts this and returns `E_INTERNAL` rather than a silently-rounded number."
 *
 * The pure/shared layer's error-minting wrapper over `isSafeAggregate` above, which is the
 * single definition of the bound (A-10). Throws on breach; the `withResult()` wrapper
 * converts the throw to `E_INTERNAL` (§4.1 rule 1). Returns the value as a `number` so it can
 * be used inline: `assertSafeAggregate(sum, 'tok_output')` — the widening happens only after
 * the bound has been checked against the original value.
 *
 * `what` names the quantity so the developer detail is actionable — it is never user-facing.
 */
export function assertSafeAggregate(value: number | bigint, what: string): number {
  if (!isSafeAggregate(value)) {
    throw new RangeError(
      `INV-11: ${what} = ${String(value)} is not a safe integer and would cross IPC ` +
        'silently rounded. Report it rather than round it.',
    );
  }
  return Number(value);
}

// ---------------------------------------------------------------------------
// §3.11 / ADR-023 (amended) — USD per 1M tokens ↔ picoUSD per token
// ---------------------------------------------------------------------------

/**
 * `$15.00/Mtok → 15_000_000` · `$1.50/Mtok → 1_500_000` · `$0.3125/Mtok → 312_500` (§3.11).
 *
 * Exact and integer: the value is decomposed as a fixed-point decimal string and the digits are
 * re-read as an integer, so no `× 1e6` in IEEE-754 ever touches the rate.
 *
 * Rejects, never rounds:
 *   · more than six decimal places → `E_PRICE_PRECISION` (ADR-023 amended, fixture F-10)
 *   · negative, non-finite, or beyond `MAX_USD_PER_MILLION` → `E_INVALID_SETTING`
 *     (the code §4.2 already uses for an out-of-range request value)
 */
export function usdPerMillionToPicoUsdPerToken(usdPerMillion: number): Result<number> {
  if (!Number.isFinite(usdPerMillion)) {
    return fail(
      'E_INVALID_SETTING',
      'That rate is not a number.',
      `usdPerMillion = ${String(usdPerMillion)}`,
    );
  }
  // §3.11 DDL: CHECK (rate_picousd_per_token >= 0).
  if (usdPerMillion < 0) {
    return fail(
      'E_INVALID_SETTING',
      'A rate cannot be negative.',
      `usdPerMillion = ${String(usdPerMillion)}`,
    );
  }
  if (usdPerMillion > MAX_USD_PER_MILLION) {
    return fail(
      'E_INVALID_SETTING',
      'That rate is too large to store exactly.',
      `usdPerMillion = ${String(usdPerMillion)} exceeds ${String(MAX_USD_PER_MILLION)} ` +
        '(INV-11: picoUSD/token must stay a safe integer)',
    );
  }

  // `toFixed(6)` yields exactly six decimal places, rounding the double if it carries more.
  // If the rounded form is a different number, the input had finer precision than the unit can
  // hold — and ADR-023 says reject it, not round it.
  const fixed = usdPerMillion.toFixed(MAX_USD_PER_MILLION_DECIMALS);
  if (Number(fixed) !== usdPerMillion) {
    return fail(
      'E_PRICE_PRECISION',
      `A rate may have at most ${String(MAX_USD_PER_MILLION_DECIMALS)} decimal places of USD ` +
        'per million tokens.',
      `usdPerMillion = ${String(usdPerMillion)} would be stored as ${fixed} (ADR-023 amended)`,
    );
  }

  // "12.345678" -> "12" + "345678" -> 12_345678. Exact: no multiplication, just digits.
  const dot = fixed.indexOf('.');
  const picoUsdPerToken = Number(fixed.slice(0, dot) + fixed.slice(dot + 1));
  return { ok: true, data: assertSafeAggregate(picoUsdPerToken, 'rate_picousd_per_token') };
}

/**
 * The presentation form of a stored rate: `PriceRow.usdPerMillion` is
 * `rate_picousd_per_token / 1e6` (§4.7). The inverse of the function above, exact for every
 * rate the forward direction accepts (`312_500 → 0.3125`).
 *
 * Throws on a non-integer or unsafe input — a stored rate that is not an integer means the
 * `INTEGER` column has been violated, which is a fault, not user input.
 */
export function picoUsdPerTokenToUsdPerMillion(picoUsdPerToken: number): number {
  assertSafeAggregate(picoUsdPerToken, 'rate_picousd_per_token');
  return picoUsdPerToken / PICO_USD_PER_TOKEN_PER_USD_PER_MILLION;
}

// ---------------------------------------------------------------------------
// ADR-023 (amended) / §3.11 — picoUSD → nanoUSD, the IPC boundary conversion
// ---------------------------------------------------------------------------

/** Floor division for BigInt (`/` truncates toward zero, which is wrong below zero). */
function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const exact = quotient * denominator === numerator;
  const signsDiffer = numerator < 0n !== denominator < 0n;
  return !exact && signsDiffer ? quotient - 1n : quotient;
}

/**
 * §3.11 / ADR-023 — "the repository converts to **nanoUSD** (integer division, round-half-up)
 * before the value crosses IPC, so `costNanoUsd` is the wire type everywhere in §4".
 *
 * Round-half-up means a tie goes to the larger value (toward `+∞`): `1_500 pico → 2 nano`.
 * Performed in BigInt so the `+ 500` carry is exact even for picoUSD totals near
 * `Number.MAX_SAFE_INTEGER` — a double add there would land on the wrong side of the tie.
 *
 * ⚠️ **AMENDED 2026-07-22 — the input is a `bigint` and is NOT bounds-checked.** This function
 * is the conversion §3.11 names, and the whole point of converting is that the *source* unit
 * legitimately outgrows `Number.MAX_SAFE_INTEGER` while the *target* unit does not: 9.007e15
 * picoUSD is only **$9,007** of lifetime spend, whereas the same money in nanoUSD (9.007e12) has
 * three orders of headroom. Asserting INV-11 on the picoUSD side therefore rejected real,
 * perfectly representable totals — and it did, in the running app, on the Overview tiles.
 * INV-11 belongs on the result, and that is the only assertion left here.
 *
 * A `number` is still accepted for the small, hand-written picoUSD quantities in tests and at
 * the rate edge, and a `number` that is not a safe integer is still refused — such a value was
 * already corrupted by whatever narrowed it, and reporting it would be the silently wrong number
 * CLAUDE.md §1 forbids. SQL sums arrive as `bigint` (`safeIntegers`) and skip that path entirely.
 *
 * Throws (→ `E_INTERNAL`) if the nanoUSD **result** is not a safe integer (INV-11) — the case
 * that genuinely cannot be put on the wire, at roughly $9,007,199 of costed spend.
 */
export function picoToNanoUsd(picoUsd: number | bigint): number {
  const exact =
    typeof picoUsd === 'bigint' ? picoUsd : BigInt(assertSafeAggregate(picoUsd, 'costPicoUsd'));
  const half = BigInt(PICO_USD_PER_NANO_USD) / 2n;
  const nanoUsd = floorDiv(exact + half, BigInt(PICO_USD_PER_NANO_USD));
  return assertSafeAggregate(nanoUsd, 'costNanoUsd');
}
