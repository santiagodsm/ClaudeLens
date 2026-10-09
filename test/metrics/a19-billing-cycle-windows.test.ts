// A-19 (PROGRESS.md amendment log) — **the billing-cycle window arithmetic**, extended from A-18.
//
// The module under test is `src/shared/billing-cycle.ts`: a day of the month plus an instant give
// the half-open local window `[from, to)` of §4.2, and A-19 adds the cycle containing an arbitrary
// instant, the list of every cycle over a dataset, and the label. Everything below is an inline
// hand-computed expected value with the arithmetic in the comment; no snapshot (CLAUDE.md §1).
//
// ⚠️ **Why a shared module is tested from the `main` Vitest project.** These expectations are
// local-calendar facts, so the suite has to pin `TZ` the way every other calendar fixture does
// (`usePinnedTimezone`, ADR-021). That pin is only honoured under the `main` project's **forks**
// pool: the `renderer` and `shared` projects run on worker threads, where a write to
// `process.env.TZ` never reaches the C runtime and the zone silently stays the developer's own.
// The module is pure (no React, no DOM, no I/O), so a node environment exercises the shipped code.
//
// ⚠️ Expected instants are written as `Date.UTC(...)` with the local reading in the comment. That
// is deliberately NOT the local-time constructor the implementation uses: an expectation built
// the same way as the code would agree with it even when both are wrong.
//
// ⚠️ **`assertDstTimezonePinned()` opens EVERY test in this file, without exception.** It proves
// the `TZ` write actually reached the C runtime on both sides of the daylight-saving rule, and a
// pin that is asserted in some tests and assumed in others is not a discipline — the tests that
// assume it are the ones that would pass quietly in the developer's own zone. It is one line, and
// it costs nothing, so it is applied evenly rather than where it seemed most needed.

import { describe, expect, it } from 'vitest';
import {
  MAX_BILLING_CYCLES,
  billingCycleKey,
  cycleContaining,
  cycleDayCounts,
  cycleLabel,
  cyclesBetween,
  isCycleInProgress,
} from '../../src/shared/billing-cycle';
import { DST_TZ, assertDstTimezonePinned, usePinnedTimezone } from './support/pinned-tz';

/**
 * ⚠️ Whether a label names the month of a **hand-computed** instant.
 *
 * `cycleLabel` renders months with `toLocaleDateString`, so its exact text depends on the machine
 * running the suite and cannot be written out literally. What can be pinned is the calendar facts
 * the label must carry: the day number, the year and the month. Day and year are digits in every
 * locale; the month is a short name in most and a two-digit number in some, so both forms are
 * accepted. Deliberately NOT built by calling the function under test.
 */
function namesMonthOf(label: string, epochMs: number): boolean {
  const date = new Date(epochMs);
  return [
    date.toLocaleDateString(undefined, { month: 'short' }),
    String(date.getMonth() + 1).padStart(2, '0'),
  ].some((token) => label.includes(token));
}

describe('A-19 — the cycle containing an arbitrary instant', () => {
  usePinnedTimezone(DST_TZ);

  it('puts an instant EXACTLY on a boundary in the NEW cycle, never the old one', () => {
    assertDstTimezonePinned();

    // 15 Feb 2026, 00:00:00.000 local (EST, UTC-5) → 05:00Z. This is the first instant of the
    // cycle that opens on 15 February, because §4.2's window is INCLUSIVE at `from`.
    const onTheBoundary = Date.UTC(2026, 1, 15, 5);
    expect(cycleContaining(15, onTheBoundary).from).toBe(onTheBoundary);

    // One millisecond earlier is 14 Feb 2026, 23:59:59.999 local — the LAST instant of the cycle
    // that opened on 15 January, and the one whose `to` is the boundary above.
    const oneMsEarlier = cycleContaining(15, onTheBoundary - 1);
    expect(oneMsEarlier.from).toBe(Date.UTC(2026, 0, 15, 5)); // 15 Jan 2026 00:00 EST
    expect(oneMsEarlier.to).toBe(onTheBoundary);
  });

  it('rolls the year over with no special case (Dec → Jan)', () => {
    assertDstTimezonePinned();
    // 20 Dec 2025, 12:00 local (EST) → 17:00Z. The 15th of December has passed, so the cycle
    // opened on 15 Dec 2025 and closes on 15 Jan 2026 — the constructor normalises month 12.
    const cycle = cycleContaining(15, Date.UTC(2025, 11, 20, 17));
    expect(cycle.from).toBe(Date.UTC(2025, 11, 15, 5)); // 15 Dec 2025 00:00 EST
    expect(cycle.to).toBe(Date.UTC(2026, 0, 15, 5)); //  15 Jan 2026 00:00 EST

    // 5 Jan 2026, 12:00 local — BEFORE the 15th, so the containing cycle is still the December
    // one. The two readings must be the same window, which is the year rollover working.
    expect(cycleContaining(15, Date.UTC(2026, 0, 5, 17))).toEqual(cycle);
  });

  it('anchors on day 1 — the cycle IS the calendar month', () => {
    assertDstTimezonePinned();
    // 20 Mar 2026, 12:00 local (EDT, UTC-4) → 16:00Z. Anchor 1 ⇒ [1 Mar, 1 Apr).
    const cycle = cycleContaining(1, Date.UTC(2026, 2, 20, 16));
    expect(cycle.from).toBe(Date.UTC(2026, 2, 1, 5)); // 1 Mar 2026 00:00 EST (before the DST change)
    expect(cycle.to).toBe(Date.UTC(2026, 3, 1, 4)); //  1 Apr 2026 00:00 EDT (after it)
    // ⚠️ 27 days and 1 hour of UTC, because the cycle spans the spring-forward. `(to - from)` is
    // 2_674_800_000 ms, which is NOT a whole number of 24-hour days — this is the exact assertion
    // that the boundaries are local midnights and not `from + 31 × 86_400_000`.
    expect(cycle.to - cycle.from).toBe(2_674_800_000);
    expect((cycle.to - cycle.from) % 86_400_000).toBe(82_800_000);
    // …and by the CALENDAR it is 31 days, which is what the surfaces report.
    expect(cycleDayCounts(cycle, cycle.to - 1).totalDays).toBe(31);
  });

  it('anchors on day 28 — the highest legal day, present in every month including February', () => {
    assertDstTimezonePinned();
    // 1 Mar 2026, 12:00 local (EST) → 17:00Z. Anchor 28 ⇒ the cycle opened 28 Feb 2026.
    const cycle = cycleContaining(28, Date.UTC(2026, 2, 1, 17));
    expect(cycle.from).toBe(Date.UTC(2026, 1, 28, 5)); // 28 Feb 2026 00:00 EST
    expect(cycle.to).toBe(Date.UTC(2026, 2, 28, 4)); //  28 Mar 2026 00:00 EDT
    // 28 calendar days — February's short month never moved the boundary, which is the whole
    // reason the setting stops at 28 rather than 31.
    expect(cycleDayCounts(cycle, cycle.to - 1).totalDays).toBe(28);
  });

  it('rejects an anchor day outside 1…28 rather than clamping it', () => {
    assertDstTimezonePinned();
    expect(() => cycleContaining(0, Date.UTC(2026, 2, 1))).toThrow(/1 to 28/);
    expect(() => cycleContaining(29, Date.UTC(2026, 2, 1))).toThrow(/1 to 28/);
    expect(() => cycleContaining(15.5, Date.UTC(2026, 2, 1))).toThrow(/1 to 28/);
  });
});

describe('A-19 — every cycle over a dataset, newest first', () => {
  usePinnedTimezone(DST_TZ);

  it('spans the first record to now, and consecutive cycles partition time exactly', () => {
    assertDstTimezonePinned();

    // First record 20 Jan 2026 10:00 EST (15:00Z); now 20 Jun 2026 12:00 EDT (16:00Z).
    // Cycles containing them: [15 Jan, 15 Feb) and [15 Jun, 15 Jul) — six cycles inclusive:
    //   Jun, May, Apr, Mar, Feb, Jan.
    const series = cyclesBetween(15, Date.UTC(2026, 0, 20, 15), Date.UTC(2026, 5, 20, 16));
    expect(series.truncated).toBe(0);
    expect(series.cycles).toHaveLength(6);

    // Newest first.
    expect(series.cycles[0]?.from).toBe(Date.UTC(2026, 5, 15, 4)); // 15 Jun 2026 00:00 EDT
    expect(series.cycles[5]?.from).toBe(Date.UTC(2026, 0, 15, 5)); // 15 Jan 2026 00:00 EST

    // ⚠️ THE PARTITION PROPERTY — `cycles[i].from === cycles[i + 1].to` for every consecutive
    // pair. No gap (a record would belong to no cycle) and no overlap (a record would be counted
    // twice). It holds across the 8 March daylight-saving change, which is the pair whose two
    // boundaries have different UTC offsets.
    for (let index = 0; index + 1 < series.cycles.length; index += 1) {
      expect(series.cycles[index]?.from).toBe(series.cycles[index + 1]?.to);
    }
    // The March pair, spelled out. Newest first, so index 4 is [15 Feb, 15 Mar) and index 3 is
    // [15 Mar, 15 Apr). February's cycle closes at 15 Mar 00:00 EDT = 04:00Z, exactly where
    // March's opens — an hour off UTC-midnight from where February itself opened (05:00Z).
    expect(series.cycles[4]?.to).toBe(Date.UTC(2026, 2, 15, 4));
    expect(series.cycles[3]?.from).toBe(Date.UTC(2026, 2, 15, 4));
    expect(series.cycles[5]?.to).toBe(Date.UTC(2026, 1, 15, 5));
  });

  it('returns NO cycles when the dataset holds nothing — never a fabricated current one', () => {
    assertDstTimezonePinned();
    expect(cyclesBetween(15, null, Date.UTC(2026, 5, 20, 16))).toEqual({
      cycles: [],
      truncated: 0,
    });
  });

  it('covers a record dated AFTER the clock rather than leaving it in no cycle', () => {
    assertDstTimezonePinned();
    // A transcript can carry a timestamp ahead of the wall clock. First record 20 Jun 2026,
    // "now" 20 Jan 2026 — the endpoints arrive out of order and both must still be covered:
    // Jun, May, Apr, Mar, Feb, Jan = six cycles, newest first.
    const series = cyclesBetween(15, Date.UTC(2026, 5, 20, 16), Date.UTC(2026, 0, 20, 15));
    expect(series.cycles).toHaveLength(6);
    expect(series.cycles[0]?.from).toBe(Date.UTC(2026, 5, 15, 4));
    expect(series.cycles[5]?.from).toBe(Date.UTC(2026, 0, 15, 5));
  });

  it('refuses an instant no date can represent, instead of returning NaN in the payload', () => {
    assertDstTimezonePinned();

    // ⚠️ `9e15` is FINITE and is 360 000 000 000 ms past the largest time value a `Date` can hold
    // (±8.64e15 ms — ECMA-262's ±100 000 000 days). `new Date(9e15)` is Invalid Date, every field
    // read off it is `NaN`, and the arithmetic downstream returned a shape that looked like an
    // answer rather than throwing: `{ cycles: [], truncated: NaN }`, which draws an empty card
    // under the line "NaN older billing cycles are not shown".
    expect(() => cyclesBetween(15, 9e15, Date.UTC(2026, 5, 20, 16))).toThrow(RangeError);
    expect(() => cyclesBetween(15, Date.UTC(2026, 5, 20, 16), 9e15)).toThrow(RangeError);
    expect(() => cycleContaining(15, -9e15)).toThrow(RangeError);
    expect(() => cycleDayCounts(cycleContaining(15, 0), 9e15)).toThrow(RangeError);
    expect(() => isCycleInProgress(cycleContaining(15, 0), 9e15)).toThrow(RangeError);
    // `Infinity` and `NaN` were already refused, and still are.
    expect(() => cyclesBetween(15, Number.POSITIVE_INFINITY, 0)).toThrow(RangeError);
    expect(() => cyclesBetween(15, Number.NaN, 0)).toThrow(RangeError);

    // …and the boundary itself is legal, because a `Date` can represent it exactly. Nothing is
    // clamped: the guard either admits an instant or refuses it (CLAUDE.md §1).
    expect(() => cycleContaining(15, 8.64e15)).not.toThrow();
    expect(() => cycleContaining(15, 8.64e15 + 1)).toThrow(RangeError);
  });

  it('caps the list and REPORTS what it left out, rather than dropping cycles quietly', () => {
    assertDstTimezonePinned();
    // 15 Jan 1990 → 20 Jun 2026 is 437 months from January 1990 to June 2026 inclusive:
    //   (2026 − 1990) × 12 + (5 − 0) + 1 = 432 + 5 + 1 = 438 cycles.
    // The cap keeps the newest 120 and reports 438 − 120 = 318.
    const series = cyclesBetween(15, Date.UTC(1990, 0, 20, 15), Date.UTC(2026, 5, 20, 16));
    expect(MAX_BILLING_CYCLES).toBe(120);
    expect(series.cycles).toHaveLength(120);
    expect(series.truncated).toBe(318);
    // The kept ones are still the newest and still partition time.
    expect(series.cycles[0]?.from).toBe(Date.UTC(2026, 5, 15, 4));
    for (let index = 0; index + 1 < series.cycles.length; index += 1) {
      expect(series.cycles[index]?.from).toBe(series.cycles[index + 1]?.to);
    }
  });
});

describe('A-19 — how a cycle is described', () => {
  usePinnedTimezone(DST_TZ);

  it('labels the last INCLUDED day, never the exclusive bound', () => {
    assertDstTimezonePinned();
    // [15 Jul 2026, 15 Aug 2026) — the last day it includes is 14 August, not the 15th.
    const cycle = cycleContaining(15, Date.UTC(2026, 6, 20, 16));
    const label = cycleLabel(cycle);
    expect(label).toContain('15');
    expect(label).toContain('14');
    expect(label).toContain('2026');
    expect(namesMonthOf(label, cycle.from)).toBe(true); // July
    expect(namesMonthOf(label, cycle.to - 1)).toBe(true); // August
    // ⚠️ Writing "15 Aug" would name a day whose records are NOT in the total (§4.2).
    expect(namesMonthOf(label, cycle.to)).toBe(true); // August again — same month, still fine
    expect(label).not.toContain('16');
  });

  it('carries both years when the cycle crosses into a new one', () => {
    assertDstTimezonePinned();
    // [15 Dec 2025, 15 Jan 2026) — two years, and a list of cycles must not show them as one.
    const label = cycleLabel(cycleContaining(15, Date.UTC(2025, 11, 20, 17)));
    expect(label).toContain('2025');
    expect(label).toContain('2026');
  });

  it('counts elapsed and total days by the CALENDAR, across a daylight-saving change', () => {
    assertDstTimezonePinned();
    // [15 Feb 2026, 15 Mar 2026) — 28 calendar days, and it contains the 8 March spring-forward.
    const cycle = cycleContaining(15, Date.UTC(2026, 1, 20, 17));
    expect(cycle.to - cycle.from).toBe(2_415_600_000); // 27 days + 23 h of UTC, not 28 × 86_400_000
    expect((cycle.to - cycle.from) / 86_400_000).not.toBe(28); // …which is why we do not divide

    // 18 Feb 2026 is the cycle's fourth day: 15th = 1, 16th = 2, 17th = 3, 18th = 4.
    expect(cycleDayCounts(cycle, Date.UTC(2026, 1, 18, 17))).toEqual({
      elapsedDays: 4,
      totalDays: 28,
    });
    // 9 March 2026 — the day AFTER the clocks moved. 15 Feb → 9 Mar is 14 remaining days of
    // February (15…28) plus 9 of March = 23. A 24-hour-day count would be an hour short and
    // could report 22.
    expect(cycleDayCounts(cycle, Date.UTC(2026, 2, 9, 16)).elapsedDays).toBe(23);
    // A finished cycle reads "28 of 28", never more.
    expect(cycleDayCounts(cycle, cycle.to).elapsedDays).toBe(28);
  });

  it('is in progress only for the window the clock is inside', () => {
    assertDstTimezonePinned();
    const cycle = cycleContaining(15, Date.UTC(2026, 1, 20, 17));
    expect(isCycleInProgress(cycle, cycle.from)).toBe(true);
    expect(isCycleInProgress(cycle, cycle.to - 1)).toBe(true);
    expect(isCycleInProgress(cycle, cycle.to)).toBe(false); // half-open at `to` (§4.2)
    expect(isCycleInProgress(cycle, cycle.from - 1)).toBe(false);
  });

  it('keys a cycle on the year-month its window OPENS in — the join key the SQL produces', () => {
    assertDstTimezonePinned();
    // Anchor 15: [15 Feb, 15 Mar) is keyed '2026-02', because the SQL shifts every local date in
    // it back by 14 days, landing 15 Feb on 1 Feb and 14 Mar on the last day of February.
    expect(billingCycleKey(cycleContaining(15, Date.UTC(2026, 1, 20, 17)))).toBe('2026-02');
    expect(billingCycleKey(cycleContaining(15, Date.UTC(2026, 2, 1, 17)))).toBe('2026-02');
    expect(billingCycleKey(cycleContaining(15, Date.UTC(2026, 2, 20, 16)))).toBe('2026-03');
    // Anchor 1: the shift is zero and the key is simply the month.
    expect(billingCycleKey(cycleContaining(1, Date.UTC(2026, 2, 20, 16)))).toBe('2026-03');
    // Anchor 28: [28 Dec 2025, 28 Jan 2026) keys on December, the month it opens in.
    expect(billingCycleKey(cycleContaining(28, Date.UTC(2026, 0, 5, 17)))).toBe('2025-12');
  });
});
