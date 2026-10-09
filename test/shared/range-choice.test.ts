/**
 * A-19 — `src/shared/range-choice.ts`: **the choice the app persists, and the two dates it
 * resolves to** (§3.13 `lastRangeChoice`).
 *
 * ⚠️ Why the CHOICE and not the dates, restated because it is the whole reason this module
 * exists: `lastGlobalFilter` stores absolute epoch ms, so persisting "this billing cycle" as a
 * window would reopen the app, after the anchor day had passed, on the cycle that has CLOSED —
 * under a control still calling it the current one. A plausible screen, counting the wrong month
 * (CLAUDE.md §1).
 *
 * ⚠️ Expected windows are read from `cycleContaining`, not written as literals: this suite runs in
 * the `shared` project, on worker threads, where a runtime `TZ` pin is NOT honoured (verified in
 * A-18) — so a literal local midnight here would be a claim about a zone this file never
 * established. The boundary arithmetic itself is pinned under a real zone in
 * `test/metrics/a18-billing-cycle.test.ts` and `test/metrics/a19-billing-cycle-windows.test.ts`;
 * what is proved here is the mapping between a stored string and a window.
 */

import { describe, expect, it } from 'vitest';
import { cycleContaining, currentBillingCycle } from '../../src/shared/billing-cycle';
import type { RangeChoice } from '../../src/shared/range-choice';
import {
  DEFAULT_RANGE_CHOICE,
  cycleStartOf,
  parseRangeChoice,
  rangeChoiceForCycle,
  resolveRangeChoice,
} from '../../src/shared/range-choice';

/** A fixed instant and a dataset that starts three cycles before it. */
const NOW = Date.UTC(2026, 7, 20, 12);
const FIRST = Date.UTC(2026, 4, 20, 12);
const ANCHOR = 15;

describe('A-19 — what a legal range choice is (§3.13, rejected not coerced)', () => {
  it('accepts exactly the three shapes', () => {
    expect(parseRangeChoice('all')).toBe('all');
    expect(parseRangeChoice('cycle:current')).toBe('cycle:current');
    expect(parseRangeChoice('cycle:1755230400000')).toBe('cycle:1755230400000');
    expect(parseRangeChoice('cycle:0')).toBe('cycle:0');
    expect(DEFAULT_RANGE_CHOICE).toBe('cycle:current');
  });

  it('⚠️ rejects a cycle whose instant cannot be read, rather than reading it as zero', () => {
    // `Number('')` is 0 and `Number(' 5')` is 5: without a shape check, `cycle:` would be
    // accepted as the cycle containing the epoch — a legal-looking value nobody wrote.
    expect(parseRangeChoice('cycle:')).toBeUndefined();
    expect(parseRangeChoice('cycle: 5')).toBeUndefined();
    expect(parseRangeChoice('cycle:abc')).toBeUndefined();
    expect(parseRangeChoice('cycle:1e3')).toBeUndefined();
    expect(parseRangeChoice('cycle:1.5')).toBeUndefined();
    expect(parseRangeChoice('cycle:NaN')).toBeUndefined();
    // ⚠️ A negative instant is rejected on the way IN, not dropped on the way out. The regex used
    // to admit `cycle:-1`, so the settings table accepted and stored a choice that
    // `resolveRangeChoice` then silently replaced with the current cycle — a stored value the app
    // never honoured, which is the "coerced" behaviour this module's posture rules out. A cycle
    // opening before 1970 is not a range with a repairable typo; no picker can ever list it.
    expect(parseRangeChoice('cycle:-1')).toBeUndefined();
    expect(parseRangeChoice('cycle:-1755230400000')).toBeUndefined();
    // ⚠️ `cycle:0` stays legal — it is a real instant (1 Jan 1970 UTC), it is what the shape check
    // above exists to distinguish from the empty string, and it is pinned on the accepted list.
    expect(parseRangeChoice('cycle:0')).toBe('cycle:0');
    expect(parseRangeChoice('cycle:99999999999999999999')).toBeUndefined();
    expect(parseRangeChoice('')).toBeUndefined();
    expect(parseRangeChoice('last7')).toBeUndefined();
    expect(parseRangeChoice(15)).toBeUndefined();
    expect(parseRangeChoice(null)).toBeUndefined();
    expect(parseRangeChoice(undefined)).toBeUndefined();
  });

  it('round-trips a cycle through the choice that names it', () => {
    const cycle = cycleContaining(ANCHOR, NOW);
    const choice = rangeChoiceForCycle(cycle);
    expect(cycleStartOf(choice)).toBe(cycle.from);
    expect(cycleStartOf('all')).toBeNull();
    expect(cycleStartOf('cycle:current')).toBeNull();
  });
});

describe('A-19 — resolving a choice against the clock', () => {
  it('"all" is unbounded on both ends, and says so with nulls', () => {
    expect(resolveRangeChoice('all', ANCHOR, FIRST, NOW)).toEqual({
      choice: 'all',
      from: null,
      to: null,
    });
  });

  it('"this cycle" resolves against the clock of the moment, not of the write', () => {
    const august = resolveRangeChoice('cycle:current', ANCHOR, FIRST, NOW);
    expect(august).toEqual({ choice: 'cycle:current', ...currentBillingCycle(ANCHOR, NOW) });

    // ⚠️ The same stored string, one month later, is a DIFFERENT window — which is exactly the
    // property that storing two dates would have lost.
    const later = NOW + 31 * 86_400_000;
    const september = resolveRangeChoice('cycle:current', ANCHOR, FIRST, later);
    expect(september.from).toBe(august.to);
    expect(september.from).not.toBe(august.from);
  });

  it('a named cycle resolves to itself while it is one the picker could offer', () => {
    const previous = cycleContaining(ANCHOR, currentBillingCycle(ANCHOR, NOW).from - 1);
    expect(resolveRangeChoice(rangeChoiceForCycle(previous), ANCHOR, FIRST, NOW)).toEqual({
      choice: rangeChoiceForCycle(previous),
      from: previous.from,
      to: previous.to,
    });
  });

  it('⚠️ falls back to this cycle — and SAYS it fell back — when the choice no longer resolves', () => {
    const current = currentBillingCycle(ANCHOR, NOW);

    // A cycle older than every record: the dataset it was chosen over is gone (a rebuild, a
    // different Claude directory), so the picker cannot offer it any more.
    const ancient = rangeChoiceForCycle(cycleContaining(ANCHOR, Date.UTC(2001, 0, 20)));
    expect(resolveRangeChoice(ancient, ANCHOR, FIRST, NOW)).toEqual({
      choice: 'cycle:current',
      from: current.from,
      to: current.to,
    });

    // An instant that is not a cycle boundary at all — which is what a stored choice becomes the
    // moment the user changes their billing day.
    const offBoundary: RangeChoice = `cycle:${current.from + 1}`;
    expect(resolveRangeChoice(offBoundary, ANCHOR, FIRST, NOW).choice).toBe('cycle:current');

    // ⚠️ And with no data at all, no named cycle resolves: a window over a dataset that holds
    // nothing is a promise the data cannot keep.
    expect(resolveRangeChoice(rangeChoiceForCycle(current), ANCHOR, null, NOW).choice).toBe(
      'cycle:current',
    );
  });

  it('every resolved cycle is one the picker lists, and the pair is half-open', () => {
    const current = currentBillingCycle(ANCHOR, NOW);
    const previous = cycleContaining(ANCHOR, current.from - 1);
    const resolved = resolveRangeChoice(rangeChoiceForCycle(previous), ANCHOR, FIRST, NOW);

    // §4.2 — `to` is exclusive and is exactly where the next cycle opens: no gap, no overlap.
    expect(resolved.to).toBe(current.from);
    expect(resolved.from).toBeLessThan(resolved.to ?? 0);
  });
});
