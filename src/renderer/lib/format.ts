/**
 * The presentation edge (FRONTEND §6, §3.11, §6.4, §6.12).
 *
 * Three jobs, and one rule that outranks all of them: **this module never invents a number.**
 * It formats what it is given, and where it is given nothing it says so in words. A formatter
 * that turns "unknown" into `0` is exactly the silently-wrong number CLAUDE.md §1 is about.
 */

/**
 * §6.4 — the sentence rendered instead of a `$` figure when no price row covers any record.
 * ⚠️ It is never `$0.00`. `$0.00` asserts "this cost is zero", which is a different and false
 * claim from "we do not know this cost".
 */
export const NO_PRICING_LABEL = 'no pricing configured';

/** §3.11 / ADR-023 — nanoUSD is the wire unit; USD is produced here and nowhere else. */
const NANO_USD_PER_USD = 1_000_000_000n;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/** Fixed locale so a formatted number is a property of the value, not of the machine. */
const GROUPED = new Intl.NumberFormat('en-US', { useGrouping: true, maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** The exact integer, grouped: `1,234,567`. Used wherever the precise count is the point. */
export function formatInteger(value: number): string {
  assertFinite(value, 'formatInteger');
  return GROUPED.format(Math.round(value));
}

/**
 * FRONTEND §6 — "abbreviate large numbers (`1.2M`, `340K`)". Used on axis ticks, chips and
 * anywhere the exact digit count is noise.
 *
 * One decimal below 100 of a unit, none at or above it, trailing `.0` dropped:
 * `999 → 999` · `1234 → 1.2K` · `12_345 → 12.3K` · `340_000 → 340K` · `1_200_000 → 1.2M`.
 */
export function formatCompact(value: number): string {
  assertFinite(value, 'formatCompact');
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);

  const units: { threshold: number; suffix: string }[] = [
    { threshold: 1e12, suffix: 'T' },
    { threshold: 1e9, suffix: 'B' },
    { threshold: 1e6, suffix: 'M' },
    { threshold: 1e3, suffix: 'K' },
  ];

  for (const unit of units) {
    if (magnitude >= unit.threshold) {
      const scaled = magnitude / unit.threshold;
      const decimals = scaled < 100 ? 1 : 0;
      return `${sign}${trimTrailingZero(scaled.toFixed(decimals))}${unit.suffix}`;
    }
  }
  return `${sign}${String(Math.round(magnitude))}`;
}

/** `0.7237 → 72%`. A ratio in `[0,1]`, as the gauge and the cache-efficiency caption want it. */
export function formatPercent(ratio: number, decimals = 0): string {
  assertFinite(ratio, 'formatPercent');
  return `${trimTrailingZero((ratio * 100).toFixed(decimals))}%`;
}

/**
 * A signed delta, for the StatTile change line: `+12.4%` / `-3%` / `0%`.
 * `null` means "no comparable previous period" and renders as an em dash, never as `0%`.
 */
export function formatDelta(ratio: number | null): string {
  if (ratio === null) return '—';
  assertFinite(ratio, 'formatDelta');
  const sign = ratio > 0 ? '+' : '';
  return `${sign}${formatPercent(ratio, 1)}`;
}

// ---------------------------------------------------------------------------
// Durations — §5.9 M-07/M-08 "active" and "span" seconds
// ---------------------------------------------------------------------------

/**
 * `77_820 → '21h 37m'` (§6.2/§6.5 render active and span in this form).
 *
 * Two most-significant units, never three: `h m`, else `m s`, else `s`. Hours are NOT rolled
 * into days — "48h 10m" is the honest reading of an active-hours total that spans a fortnight
 * of working days (M-07 binding (C)), and "2d 0h" invites the reader to think it is elapsed
 * wall-clock time, which §11.9 says it is not.
 */
export function formatDuration(seconds: number): string {
  assertFinite(seconds, 'formatDuration');
  const sign = seconds < 0 ? '-' : '';
  const total = Math.round(Math.abs(seconds));

  const hours = Math.floor(total / SECONDS_PER_HOUR);
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const rest = total % SECONDS_PER_MINUTE;

  if (hours > 0) return `${sign}${String(hours)}h ${String(minutes)}m`;
  if (minutes > 0) return `${sign}${String(minutes)}m ${String(rest)}s`;
  return `${sign}${String(rest)}s`;
}

/** The compact single-unit form for dense table cells: `21.6h` / `37m` / `4s`. */
export function formatDurationShort(seconds: number): string {
  assertFinite(seconds, 'formatDurationShort');
  const sign = seconds < 0 ? '-' : '';
  const total = Math.abs(seconds);
  if (total >= SECONDS_PER_HOUR) {
    return `${sign}${trimTrailingZero((total / SECONDS_PER_HOUR).toFixed(1))}h`;
  }
  if (total >= SECONDS_PER_MINUTE) {
    return `${sign}${String(Math.round(total / SECONDS_PER_MINUTE))}m`;
  }
  return `${sign}${String(Math.round(total))}s`;
}

/** A sync duration, for the sidebar footer: `840 → '840ms'`, `12_400 → '12.4s'`. */
export function formatMillis(ms: number): string {
  assertFinite(ms, 'formatMillis');
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  // Below a minute, keep the tenth of a second: P-02 budgets an incremental sync at 500 ms and
  // P-01 a full one at 60 s, so this is the range the number actually lives in and rounding it
  // to whole seconds would throw away the part the user is watching.
  if (ms < 60_000) return `${trimTrailingZero((ms / 1000).toFixed(1))}s`;
  return formatDurationShort(ms / 1000);
}

// ---------------------------------------------------------------------------
// Money — §3.11, ADR-023, §6.4
// ---------------------------------------------------------------------------

/**
 * ⚠️ **The one place in the renderer that divides by 1e9.** `costNanoUsd` is the wire type of
 * every `$` field in §4; USD exists only inside this function's return string (§3.11 — "USD
 * only at the presentation edge"). No caller may do the division itself.
 *
 * `null` is not zero. A `null` cost means no price row covered the records, and §6.4 states
 * the consequence absolutely: the panel renders *"no pricing configured"* and **shows no `$`
 * at all** — "⚠️ It never shows `$0.00`."
 *
 * The division is done in `BigInt` on the integer nanoUSD value, so a total near
 * `Number.MAX_SAFE_INTEGER` (~$9M) still rounds on the correct side of the half-cent.
 */
export function formatCost(costNanoUsd: number | null): string {
  if (costNanoUsd === null) return NO_PRICING_LABEL;
  assertFinite(costNanoUsd, 'formatCost');
  if (!Number.isSafeInteger(costNanoUsd)) {
    // INV-11 — a non-integer nanoUSD value means the wire unit was violated upstream. Report
    // it; do not round it into something that looks like a cost.
    throw new RangeError(
      `formatCost: costNanoUsd must be a safe integer (nanoUSD, §3.11); got ${String(costNanoUsd)}`,
    );
  }

  const negative = costNanoUsd < 0;
  const magnitude = BigInt(Math.abs(costNanoUsd));
  const whole = magnitude / NANO_USD_PER_USD;
  const fraction = magnitude % NANO_USD_PER_USD;

  // Two decimals normally. Below one cent but not zero, four — because `$0.00` printed for a
  // real, non-zero cost is the same lie as printing it for an unknown one.
  const decimals = whole === 0n && fraction > 0n && fraction < 10_000_000n ? 4 : 2;
  const [dollars, cents] = splitRounded(whole, fraction, decimals);

  return `${negative ? '-' : ''}$${GROUPED.format(Number(dollars))}.${cents}`;
}

/**
 * §6.4's degraded reading, as one string: the figure when it is known, the sentence when it is
 * not, and never a number that pretends to be complete. `records > 0` means the figure is a
 * lower bound, which is what the caller must render as a disclosure line beneath it (INV-10) —
 * this function deliberately does NOT fold that into the string, because a disclosure hidden
 * inside a formatted value is a disclosure that can be dropped by a caller.
 */
export function formatCostOrTokens(costNanoUsd: number | null, outputTokens: number): string {
  return costNanoUsd === null
    ? `${formatCompact(outputTokens)} output tokens`
    : formatCost(costNanoUsd);
}

/** §4.7 — a price row's rate for display: `0.3125 → '$0.3125 / Mtok'`. */
export function formatRatePerMillion(usdPerMillion: number): string {
  assertFinite(usdPerMillion, 'formatRatePerMillion');
  return `$${trimTrailingZeros(usdPerMillion.toFixed(6))} / Mtok`;
}

// ---------------------------------------------------------------------------
// Bytes and dates
// ---------------------------------------------------------------------------

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Dataset size, backup size, reclaimable bytes (§6.2 footer, §6.9). */
export function formatBytes(bytes: number): string {
  assertFinite(bytes, 'formatBytes');
  const sign = bytes < 0 ? '-' : '';
  let magnitude = Math.abs(bytes);
  let unit = 0;
  while (magnitude >= 1024 && unit < BYTE_UNITS.length - 1) {
    magnitude /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 || magnitude >= 100 ? 0 : 1;
  return `${sign}${trimTrailingZero(magnitude.toFixed(decimals))} ${BYTE_UNITS[unit] ?? 'B'}`;
}

/**
 * ADR-021 — timestamps are UTC epoch ms and every calendar rendering is in **local** time.
 * `null` renders as "never", never as the epoch and never as "now".
 */
export function formatTimestamp(epochMs: number | null): string {
  if (epochMs === null) return 'never';
  assertFinite(epochMs, 'formatTimestamp');
  return new Date(epochMs).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The wall-clock time of day, for §6.2's "last-parsed time" in the top bar: `14:32`.
 *
 * ⚠️ Deliberately absolute rather than relative ("4m ago"). A relative label has to re-render on
 * a timer, and §6.2 says the Refresh spinner is the **only** thing that moves while idle — a
 * label that ticks over once a minute is movement in a window that lives in peripheral vision.
 * `null` renders "never", never the epoch and never "now".
 */
export function formatClock(epochMs: number | null): string {
  if (epochMs === null) return 'never';
  assertFinite(epochMs, 'formatClock');
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * A relative "last parsed" line: `just now`, `4m ago`, `2h ago`. Used where the caller already
 * has a fixed `now` — never with `Date.now()` read during a render (see `formatClock`).
 */
export function formatRelative(epochMs: number | null, now: number): string {
  if (epochMs === null) return 'never';
  assertFinite(epochMs, 'formatRelative');
  const elapsedSeconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (elapsedSeconds < 45) return 'just now';
  return `${formatDurationShort(elapsedSeconds)} ago`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * A non-finite value reaching a formatter is a programming fault, not a state to render
 * around. It throws, the view's error boundary catches it (§7.3), and the user sees an
 * ErrorState — which is the honest outcome. Rendering `NaN` as `0` is not.
 */
function assertFinite(value: number, where: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${where}: expected a finite number, got ${String(value)}`);
  }
}

/** `'2.0' → '2'`, `'2.4' → '2.4'`. Only ever removes a zero that carries no information. */
function trimTrailingZero(fixed: string): string {
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/** `'0.312500' → '0.3125'`, `'15.000000' → '15'`. */
function trimTrailingZeros(fixed: string): string {
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Rounds a nanoUSD fraction to `decimals` places, half away from zero, carrying into the
 * whole-dollar part when the rounding rolls over. All BigInt: no float touches the value.
 */
function splitRounded(whole: bigint, fraction: bigint, decimals: number): [bigint, string] {
  const scale = 10n ** BigInt(9 - decimals);
  let scaled = (fraction + scale / 2n) / scale;
  let dollars = whole;
  const ceiling = 10n ** BigInt(decimals);
  if (scaled >= ceiling) {
    scaled -= ceiling;
    dollars += 1n;
  }
  return [dollars, scaled.toString().padStart(decimals, '0')];
}
