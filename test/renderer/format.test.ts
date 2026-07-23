/**
 * The presentation edge (FRONTEND §6, §3.11, §6.4). Inline hand-computed expected values with
 * the arithmetic in a comment; no snapshots (STACK ADR-012).
 *
 * ⚠️ The `formatCost(null)` block is the single most important assertion in this file. §6.4:
 * "the panel renders *No pricing configured — showing tokens only* and shows no `$` at all.
 * ⚠️ It never shows `$0.00`."
 */

import { describe, expect, it } from 'vitest';
import {
  NO_PRICING_LABEL,
  formatBytes,
  formatClock,
  formatCompact,
  formatCost,
  formatCostOrTokens,
  formatDelta,
  formatDuration,
  formatDurationShort,
  formatInteger,
  formatMillis,
  formatPercent,
  formatRatePerMillion,
  formatRelative,
  formatTimestamp,
} from '../../src/renderer/lib/format';

describe('formatCompact — FRONTEND §6 "abbreviate large numbers (1.2M, 340K)"', () => {
  it('matches the two examples the design gives verbatim', () => {
    expect(formatCompact(1_200_000)).toBe('1.2M'); // 1_200_000 / 1e6 = 1.2
    expect(formatCompact(340_000)).toBe('340K'); // 340_000 / 1e3 = 340, ≥100 ⇒ 0 decimals
  });

  it('keeps one decimal below 100 of a unit and none at or above it', () => {
    expect(formatCompact(1_234)).toBe('1.2K'); // 1.234 → 1.2
    expect(formatCompact(12_345)).toBe('12.3K'); // 12.345 → 12.3
    expect(formatCompact(999_999)).toBe('1000K'); // 999.999 → 1000 (≥100 ⇒ 0 decimals)
    expect(formatCompact(2_000_000)).toBe('2M'); // trailing .0 dropped
    expect(formatCompact(3_400_000_000)).toBe('3.4B');
  });

  it('leaves small numbers exact and handles sign and zero', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(-1_500)).toBe('-1.5K');
  });

  it('throws rather than printing NaN as a number', () => {
    expect(() => formatCompact(Number.NaN)).toThrow(RangeError);
  });
});

describe('formatInteger', () => {
  it('groups without changing the value', () => {
    expect(formatInteger(1_234_567)).toBe('1,234,567');
    expect(formatInteger(0)).toBe('0');
  });
});

describe('formatDuration — active and span, as "21h 37m" (§6.2, §6.5)', () => {
  it("renders the design's own example", () => {
    // 21h 37m = 21*3600 + 37*60 = 75_600 + 2_220 = 77_820 s
    expect(formatDuration(77_820)).toBe('21h 37m');
  });

  it('shows the two most significant units and never three', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(3_672)).toBe('1h 1m'); // 3600 + 72 → the 12 s is dropped
    expect(formatDuration(605)).toBe('10m 5s');
    expect(formatDuration(0)).toBe('0s');
  });

  it('does NOT roll hours into days', () => {
    // §11.9 — an active-hours total is not elapsed wall-clock time, and "2d 0h" invites
    // exactly that misreading. 48h 10m = 173_400 s.
    expect(formatDuration(173_400)).toBe('48h 10m');
  });
});

describe('formatDurationShort / formatMillis', () => {
  it('collapses to a single unit for dense cells', () => {
    expect(formatDurationShort(77_820)).toBe('21.6h'); // 77_820/3600 = 21.616… → 21.6
    expect(formatDurationShort(2_220)).toBe('37m');
    expect(formatDurationShort(4)).toBe('4s');
  });

  it('renders sub-second sync durations in milliseconds', () => {
    expect(formatMillis(840)).toBe('840ms');
    expect(formatMillis(12_400)).toBe('12.4s');
  });
});

describe('formatCost — §3.11, ADR-023, §6.4', () => {
  it('NEVER renders $0.00 for an unknown cost', () => {
    // ⚠️ The rule this project exists to protect. §6.4: "It never shows $0.00."
    expect(formatCost(null)).toBe(NO_PRICING_LABEL);
    expect(formatCost(null)).toBe('no pricing configured');
    expect(formatCost(null)).not.toContain('$');
    expect(formatCost(null)).not.toBe('$0.00');
  });

  it('divides nanoUSD by 1e9 at the presentation edge', () => {
    expect(formatCost(0)).toBe('$0.00'); // a MEASURED zero is legitimately $0.00
    expect(formatCost(1_000_000_000)).toBe('$1.00'); // 1e9 nano = $1
    expect(formatCost(12_345_670_000)).toBe('$12.35'); // 12.34567 → half-up → 12.35
    expect(formatCost(1_234_567_890_000)).toBe('$1,234.57'); // 1234.56789 → 1234.57
  });

  it('rounds half away from zero, carrying into the dollar', () => {
    expect(formatCost(1_995_000_000)).toBe('$2.00'); // 1.995 → 2.00 (carry)
    expect(formatCost(5_000_000)).toBe('$0.0050'); // below a cent ⇒ four decimals
  });

  it('shows four decimals below one cent rather than a misleading $0.00', () => {
    expect(formatCost(1_000_000)).toBe('$0.0010'); // 0.001 USD
    expect(formatCost(43_000_00)).toBe('$0.0043'); // 4_300_000 nano = 0.0043 USD
  });

  it('handles a negative (a correction) without losing the sign', () => {
    expect(formatCost(-2_500_000_000)).toBe('-$2.50');
  });

  it('refuses a non-integer nanoUSD value instead of rounding it', () => {
    expect(() => formatCost(1.5)).toThrow(RangeError);
  });
});

describe('formatCostOrTokens — §6.4 degraded reading', () => {
  it('falls back to tokens, never to a dollar figure', () => {
    expect(formatCostOrTokens(null, 340_000)).toBe('340K output tokens');
    expect(formatCostOrTokens(2_000_000_000, 340_000)).toBe('$2.00');
  });
});

describe('formatPercent / formatDelta', () => {
  it('formats a ratio, and an absent delta as an em dash rather than 0%', () => {
    expect(formatPercent(0.7237)).toBe('72%');
    expect(formatPercent(0.7237, 1)).toBe('72.4%');
    expect(formatDelta(null)).toBe('—');
    expect(formatDelta(0.124)).toBe('+12.4%');
    expect(formatDelta(-0.03)).toBe('-3%');
  });
});

describe('formatRatePerMillion — §4.7', () => {
  it('renders the rate that forced the ADR-023 amendment exactly', () => {
    expect(formatRatePerMillion(0.3125)).toBe('$0.3125 / Mtok');
    expect(formatRatePerMillion(15)).toBe('$15 / Mtok');
  });
});

describe('formatBytes', () => {
  it('scales without inventing precision', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_536)).toBe('1.5 KB');
    expect(formatBytes(1_048_576)).toBe('1 MB');
  });
});

describe('timestamps — ADR-021, and "never" is never the epoch', () => {
  it('renders null as "never"', () => {
    expect(formatTimestamp(null)).toBe('never');
    expect(formatClock(null)).toBe('never');
    expect(formatRelative(null, Date.now())).toBe('never');
  });

  it('renders a relative time from an explicit now', () => {
    const now = 1_800_000_000_000;
    expect(formatRelative(now - 5_000, now)).toBe('just now');
    expect(formatRelative(now - 240_000, now)).toBe('4m ago');
    expect(formatRelative(now - 7_200_000, now)).toBe('2h ago');
  });
});
