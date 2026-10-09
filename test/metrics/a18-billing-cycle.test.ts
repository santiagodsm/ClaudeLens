// A-18 (PROGRESS.md amendment log) — **the billing cycle the Overview's four totals count over.**
//
// The whole of the arithmetic is `src/renderer/lib/billing-cycle.ts`: a day of the month plus an
// instant give the half-open local window `[from, to)` of §4.2. Everything below is an inline
// hand-computed expected value with the arithmetic in the comment; no snapshot (CLAUDE.md §1).
//
// ⚠️ **Why a renderer module is tested from the `main` Vitest project.** These expectations are
// local-calendar facts, so the suite has to pin `TZ` the way every other calendar fixture does
// (`usePinnedTimezone`, ADR-021). That pin is only honoured under the `main` project's **forks**
// pool: the `renderer` and `shared` projects run on worker threads, where a write to
// `process.env.TZ` never reaches the C runtime and the zone silently stays the developer's own —
// verified in both directions before this file was placed here. The module under test is pure
// (no React, no DOM, no I/O), so a node environment exercises exactly the shipped code.
//
// ⚠️ Expected instants are written as `Date.UTC(...)` with the local reading in the comment. That
// is deliberately NOT the local-time constructor the implementation uses: an expectation built
// the same way as the code would agree with it even when both are wrong.

import { describe, expect, it } from 'vitest';
import {
  MAX_BILLING_CYCLE_DAY,
  MIN_BILLING_CYCLE_DAY,
  asBillingCycleWindow,
  billingCycleCaption,
  currentBillingCycle,
  filterWindowCaption,
} from '../../src/renderer/lib/billing-cycle';
import { DST_TZ, assertDstTimezonePinned, usePinnedTimezone } from './support/pinned-tz';

/**
 * ⚠️ Whether a caption names the month of a **hand-computed** instant.
 *
 * The captions render dates with `toLocaleDateString`, so their exact text depends on the machine
 * running the suite and cannot be written out literally. What can be pinned is the calendar facts
 * the sentence must carry: the day number, the year and the month. Day and year are digits in
 * every locale; the month is a short name in most and a two-digit number in some, so both forms
 * are accepted. Deliberately NOT `formatDay`: an expectation built by calling the function under
 * test agrees with it even when both are wrong, which is what leaves a date unpinned.
 */
function namesMonthOf(caption: string, epochMs: number): boolean {
  const date = new Date(epochMs);
  return [
    date.toLocaleDateString(undefined, { month: 'short' }),
    String(date.getMonth() + 1).padStart(2, '0'),
  ].some((token) => caption.includes(token));
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

describe('A-18 — the current billing cycle, in local calendar time (ADR-021)', () => {
  usePinnedTimezone(DST_TZ);

  it('starts in the PREVIOUS month when today is before the anchor day', () => {
    assertDstTimezonePinned();

    // 10 Aug 2026, 12:00 local (EDT, UTC-4) → 16:00Z. The 15th of August has not happened yet,
    // so the cycle containing this instant is the one that opened on 15 July.
    const cycle = currentBillingCycle(15, Date.UTC(2026, 7, 10, 16));

    expect(cycle.from).toBe(Date.UTC(2026, 6, 15, 4)); // 15 Jul 2026 00:00 EDT (UTC-4)
    expect(cycle.to).toBe(Date.UTC(2026, 7, 15, 4)); // 15 Aug 2026 00:00 EDT (UTC-4)
    // ⚠️ The discriminator: reading the anchor as "this month's 15th" would have produced a
    // window that has not started yet and would count nothing.
    expect(cycle.from).not.toBe(Date.UTC(2026, 7, 15, 4));
  });

  it('starts in THIS month once the anchor day has arrived', () => {
    assertDstTimezonePinned();

    // 20 Aug 2026, 09:00 local (EDT) → 13:00Z.
    const cycle = currentBillingCycle(15, Date.UTC(2026, 7, 20, 13));

    expect(cycle.from).toBe(Date.UTC(2026, 7, 15, 4)); // 15 Aug 2026 00:00 EDT
    expect(cycle.to).toBe(Date.UTC(2026, 8, 15, 4)); // 15 Sep 2026 00:00 EDT
  });

  it('⚠️ puts local midnight ON the anchor day in the NEW cycle — the range includes `from`', () => {
    assertDstTimezonePinned();

    // Exactly 15 Aug 2026 00:00:00.000 local (EDT) — the boundary instant itself.
    const midnight = Date.UTC(2026, 7, 15, 4);
    const cycle = currentBillingCycle(15, midnight);

    expect(cycle.from).toBe(midnight); // the instant opens the new cycle, it does not close the old
    expect(cycle.to).toBe(Date.UTC(2026, 8, 15, 4)); // 15 Sep 2026 00:00 EDT

    // One millisecond earlier is still the PREVIOUS cycle, which is what half-open means: the two
    // windows meet at this instant with neither a gap nor an overlap (§4.2).
    const justBefore = currentBillingCycle(15, midnight - 1);
    expect(justBefore.to).toBe(midnight);
    expect(justBefore.from).toBe(Date.UTC(2026, 6, 15, 4)); // 15 Jul 2026 00:00 EDT
  });

  it('rolls over December → January in both directions', () => {
    assertDstTimezonePinned();

    // 20 Dec 2026, 09:00 local (EST, UTC-5) → 14:00Z. The cycle runs into the next YEAR.
    const december = currentBillingCycle(15, Date.UTC(2026, 11, 20, 14));
    expect(december.from).toBe(Date.UTC(2026, 11, 15, 5)); // 15 Dec 2026 00:00 EST (UTC-5)
    expect(december.to).toBe(Date.UTC(2027, 0, 15, 5)); // 15 Jan 2027 00:00 EST

    // 5 Jan 2027, 09:00 local (EST) → 14:00Z. Before the 15th, so the cycle opened LAST year.
    const january = currentBillingCycle(15, Date.UTC(2027, 0, 5, 14));
    expect(january.from).toBe(Date.UTC(2026, 11, 15, 5)); // 15 Dec 2026 00:00 EST
    expect(january.to).toBe(Date.UTC(2027, 0, 15, 5)); // 15 Jan 2027 00:00 EST
    // The two readings of the same cycle agree — the rollover is not a special case.
    expect(january).toEqual(december);
  });

  it('handles a February boundary at the 28th, the highest day the setting allows', () => {
    assertDstTimezonePinned();

    // 10 Mar 2026, 12:00 local. 8 March is when EDT begins, so `now` is already UTC-4 → 16:00Z.
    const cycle = currentBillingCycle(28, Date.UTC(2026, 2, 10, 16));

    expect(cycle.from).toBe(Date.UTC(2026, 1, 28, 5)); // 28 Feb 2026 00:00 EST (UTC-5)
    expect(cycle.to).toBe(Date.UTC(2026, 2, 28, 4)); // 28 Mar 2026 00:00 EDT (UTC-4)

    // ⚠️ 28 days MINUS one hour: the window spans the spring-forward, so the calendar month is
    // one hour shorter than 28 × 24 h. Both mistakes this test exists to catch land here — a
    // fixed 28-day addition would end an hour late, and a 30-day one two days late.
    expect(cycle.to - cycle.from).toBe(28 * DAY_MS - HOUR_MS);
    expect(cycle.to - cycle.from).not.toBe(28 * DAY_MS);
  });

  it('⚠️ crosses BOTH daylight-saving transitions on a real local midnight', () => {
    assertDstTimezonePinned();

    // Spring forward — the 15 Feb → 15 Mar cycle contains 8 March.
    const spring = currentBillingCycle(15, Date.UTC(2026, 1, 20, 17)); // 20 Feb 12:00 EST
    expect(spring.from).toBe(Date.UTC(2026, 1, 15, 5)); // 15 Feb 2026 00:00 EST (UTC-5)
    expect(spring.to).toBe(Date.UTC(2026, 2, 15, 4)); // 15 Mar 2026 00:00 EDT (UTC-4)
    expect(spring.to - spring.from).toBe(28 * DAY_MS - HOUR_MS); // Feb has 28 days in 2026

    // Fall back — the 15 Oct → 15 Nov cycle contains 1 November.
    const autumn = currentBillingCycle(15, Date.UTC(2026, 9, 20, 16)); // 20 Oct 12:00 EDT
    expect(autumn.from).toBe(Date.UTC(2026, 9, 15, 4)); // 15 Oct 2026 00:00 EDT (UTC-4)
    expect(autumn.to).toBe(Date.UTC(2026, 10, 15, 5)); // 15 Nov 2026 00:00 EST (UTC-5)
    expect(autumn.to - autumn.from).toBe(31 * DAY_MS + HOUR_MS); // October has 31 days

    // Both boundaries are a real local midnight, which is the property "add 24 h" cannot hold.
    for (const boundary of [spring.from, spring.to, autumn.from, autumn.to]) {
      const local = new Date(boundary);
      expect([local.getHours(), local.getMinutes(), local.getSeconds()]).toEqual([0, 0, 0]);
      expect(local.getDate()).toBe(15);
    }
  });

  it('accepts every day the setting accepts, and refuses every day it does not', () => {
    const now = Date.UTC(2026, 7, 20, 13);
    expect(MIN_BILLING_CYCLE_DAY).toBe(1);
    expect(MAX_BILLING_CYCLE_DAY).toBe(28);

    for (let day = MIN_BILLING_CYCLE_DAY; day <= MAX_BILLING_CYCLE_DAY; day += 1) {
      const cycle = currentBillingCycle(day, now);
      expect(new Date(cycle.from).getDate()).toBe(day);
      expect(new Date(cycle.to).getDate()).toBe(day);
      expect(cycle.to).toBeGreaterThan(cycle.from);
    }

    // ⚠️ Refused, not clamped: a day that does not exist in every month would silently move the
    // window the totals cover (§1). The setting rejects these on write; this is the second gate.
    expect(() => currentBillingCycle(0, now)).toThrow(RangeError);
    expect(() => currentBillingCycle(29, now)).toThrow(RangeError);
    expect(() => currentBillingCycle(31, now)).toThrow(RangeError);
    expect(() => currentBillingCycle(15.5, now)).toThrow(RangeError);
    expect(() => currentBillingCycle(15, Number.NaN)).toThrow(RangeError);
  });

  it('partitions time — consecutive cycles meet exactly, with no gap and no overlap', () => {
    assertDstTimezonePinned();

    // Twelve consecutive cycles across a DST year and a year boundary, each read from a day
    // inside it. Cycle N's `to` must be cycle N+1's `from`.
    let previous = currentBillingCycle(15, Date.UTC(2026, 0, 20, 14));
    for (let month = 1; month < 12; month += 1) {
      const next = currentBillingCycle(15, Date.UTC(2026, month, 20, 14));
      expect(next.from).toBe(previous.to);
      previous = next;
    }
  });
});

describe('A-18 — the captions, which state the window in plain words (§1a)', () => {
  usePinnedTimezone(DST_TZ);

  it('names the real start date of the cycle, and does not claim its unfinished end', () => {
    assertDstTimezonePinned();
    const now = Date.UTC(2026, 7, 20, 13); // 20 Aug 2026 09:00 EDT
    const cycle = currentBillingCycle(15, now);

    const caption = billingCycleCaption(cycle, now);
    expect(caption).toContain('Counting from ');
    expect(caption).toContain(', your billing cycle so far.');

    // The cycle opened on **15 Aug 2026** local, and that is the only date the sentence may
    // carry. Hand-computed here; a caption built from the wrong instant fails on the day number
    // or on the month.
    expect(caption).toContain('15');
    expect(caption).toContain('2026');
    expect(caption).not.toContain('14'); // the day before the boundary — an off-by-one lands here
    expect(caption).not.toContain('16');
    expect(namesMonthOf(caption, Date.UTC(2026, 7, 15, 4))).toBe(true); // 15 Aug 2026 00:00 EDT

    // ⚠️ The cycle's end (15 SEP) is in the future; a caption that named it would describe a
    // period the number cannot have measured. It says "so far" instead. The end carries the same
    // day number as the start, so the month is what catches the substitution.
    expect(namesMonthOf(caption, Date.UTC(2026, 8, 15, 4))).toBe(false); // 15 Sep 2026 00:00 EDT
  });

  it('says "all time" only when the filter really is unbounded', () => {
    expect(filterWindowCaption(null, null)).toBe('Counting everything, all time.');
  });

  /**
   * ⚠️ A-19 — a cycle that has CLOSED must not be captioned "so far".
   *
   * After A-19 the control at the top of the app can select any past cycle, so the caption meets
   * finished windows as well as the running one. "so far" over a closed cycle invites the reader
   * to expect the total to keep rising — a caption that describes a period the number is not
   * still accumulating over (§1a).
   */
  it('⚠️ says "so far" only while the cycle is still running', () => {
    assertDstTimezonePinned();
    const now = Date.UTC(2026, 7, 20, 13); // 20 Aug 2026 09:00 EDT
    const running = currentBillingCycle(15, now); // 15 Aug → 15 Sep 2026
    const closed = currentBillingCycle(15, Date.UTC(2026, 6, 20, 13)); // 15 Jul → 15 Aug 2026

    // Hand-computed: the July cycle's exclusive end is 15 Aug 2026 00:00 EDT, which is BEFORE
    // this instant, so it is over and the sentence must say so.
    expect(closed.to).toBe(Date.UTC(2026, 7, 15, 4));
    expect(closed.to).toBeLessThan(now);

    expect(billingCycleCaption(running, now)).toContain('so far');
    const past = billingCycleCaption(closed, now);
    expect(past).not.toContain('so far');
    expect(past).toContain('one whole billing cycle.');
    // It names the last INCLUDED day, 14 Aug — never the exclusive 15 Aug bound (§4.2).
    expect(past).toContain('14');
    expect(namesMonthOf(past, Date.UTC(2026, 6, 15, 4))).toBe(true); // 15 Jul 2026 00:00 EDT
  });

  it('⚠️ names the LAST INCLUDED day, never the exclusive bound (§4.2)', () => {
    assertDstTimezonePinned();

    const from = Date.UTC(2026, 7, 1, 4); // 1 Aug 2026 00:00 EDT
    const to = Date.UTC(2026, 7, 15, 4); // 15 Aug 2026 00:00 EDT — EXCLUSIVE
    const caption = filterWindowCaption(from, to);

    // Hand-computed: the range covers 1 Aug through 14 Aug locally, because its last instant is
    // 14 Aug 23:59:59.999. So the caption reads 01 and 14, and **never** 15 — the bound whose
    // day holds no records the total counted.
    expect(caption).toContain('01');
    expect(caption).toContain('14');
    expect(caption).not.toContain('15');
    expect(namesMonthOf(caption, from)).toBe(true);
  });

  it('handles a one-sided range without inventing the missing end', () => {
    assertDstTimezonePinned();
    const from = Date.UTC(2026, 7, 1, 4); // 1 Aug 2026 00:00 EDT

    // Open end: the start date is named — 1 Aug 2026 — and nothing stands in for the end.
    const onwards = filterWindowCaption(from, null);
    expect(onwards).toContain('01');
    expect(onwards).toContain('2026');
    expect(namesMonthOf(onwards, from)).toBe(true);
    expect(onwards).toContain('onwards, the dates chosen at the top.');

    // Open start: the exclusive bound is again backed off by one, so the last day it includes is
    // 31 Jul 2026 — a different month from the bound itself, which is what makes it worth
    // asserting.
    const upTo = filterWindowCaption(null, from);
    expect(upTo).toContain('up to');
    expect(upTo).toContain('31');
    expect(namesMonthOf(upTo, Date.UTC(2026, 6, 31, 4))).toBe(true); // 31 Jul 2026 00:00 EDT
    expect(namesMonthOf(upTo, from)).toBe(false); // August is not in a window that ends in July
  });

  it('⚠️ recognises a billing-cycle window by its own boundaries, and nothing else as one', () => {
    assertDstTimezonePinned();
    const cycle = currentBillingCycle(15, Date.UTC(2026, 7, 20, 13)); // 15 Aug → 15 Sep 2026

    expect(asBillingCycleWindow(15, cycle.from, cycle.to)).toEqual(cycle);
    // ⚠️ Still recognised a moment after the clock has rolled into the NEXT cycle: the window
    // the numbers on screen were counted over does not stop being a cycle when it ends.
    const next = currentBillingCycle(15, cycle.to);
    expect(asBillingCycleWindow(15, next.from, next.to)).toEqual(next);

    // A window that merely resembles one is not one.
    expect(asBillingCycleWindow(15, cycle.from, cycle.to - 1)).toBeNull();
    expect(asBillingCycleWindow(15, cycle.from + 1, cycle.to)).toBeNull();
    expect(asBillingCycleWindow(15, null, cycle.to)).toBeNull();
    expect(asBillingCycleWindow(15, cycle.from, null)).toBeNull();
    expect(asBillingCycleWindow(15, null, null)).toBeNull();
    // And it is anchored to THIS user's day: the same dates are not the 3rd's cycle.
    expect(asBillingCycleWindow(3, cycle.from, cycle.to)).toBeNull();
  });
});
