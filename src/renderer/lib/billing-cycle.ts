/**
 * A-18/A-19 — **the renderer's view of the billing cycle**: the window arithmetic, re-exported,
 * plus the captions that describe a window in plain words.
 *
 * ⚠️ **The arithmetic itself lives in `src/shared/billing-cycle.ts` (A-19)** and this file
 * contains none. A-19 makes the main process bucket events into the same cycles
 * (`q:billingCycleTotals`), and one boundary rule implemented twice can disagree without anything
 * failing — a per-cycle total covering a different window than the tiles for the same cycle
 * (CLAUDE.md §1). Every name A-18 exported is still exported from here, unchanged, so no caller
 * moved: `currentBillingCycle`, `asBillingCycleWindow`, `BillingCycleWindow`,
 * `MIN_BILLING_CYCLE_DAY`, `MAX_BILLING_CYCLE_DAY`, and A-19's additions beside them.
 *
 * What stays here is the text: the captions read a formatted date, and date formatting is a
 * presentation concern that the main process has no business compiling.
 */

export * from '../../shared/billing-cycle';

import { cycleLabel, isCycleInProgress, type BillingCycleWindow } from '../../shared/billing-cycle';
import { formatDay, formatInteger } from './format';

/**
 * §1a — the caption under the tile row, in plain words, naming the real dates the count covers.
 *
 * ⚠️ Two sentences, because they are two different facts. The cycle the clock is inside has not
 * finished, so its total is "so far" — claiming the whole window would be a number covering a
 * period it cannot have measured. A cycle that has closed is complete, and saying "so far" about
 * it would invite the reader to expect it to keep rising (CLAUDE.md §1a).
 *
 * ⚠️ `cycleLabel` names the last INCLUDED day, never §4.2's exclusive bound.
 */
export function billingCycleCaption(cycle: BillingCycleWindow, now: number): string {
  return isCycleInProgress(cycle, now)
    ? `Counting from ${formatDay(cycle.from)}, your billing cycle so far.`
    : `Counting ${cycleLabel(cycle)}, one whole billing cycle.`;
}

/**
 * §1a — the same promise for any other window: whatever the top bar's range is, the caption
 * states it. ⚠️ `to` is EXCLUSIVE (§4.2), so the last day it includes is the day before it —
 * writing the exclusive bound on screen would name a day whose records are not in the total.
 */
export function filterWindowCaption(from: number | null, to: number | null): string {
  if (from === null && to === null) return 'Counting everything, all time.';
  if (from !== null && to !== null) {
    return `Counting ${formatDay(from)} to ${formatDay(to - 1)}, the dates chosen at the top.`;
  }
  if (from !== null) return `Counting ${formatDay(from)} onwards, the dates chosen at the top.`;
  // `to` is non-null here: the both-null case returned above.
  return `Counting everything up to ${formatDay((to ?? 0) - 1)}, the dates chosen at the top.`;
}

/**
 * A-19 — the picker's label for the cycle the clock is inside.
 *
 * ⚠️ It ends at "now" rather than at the cycle's closing date, and that is the honest end: the
 * rest of the window has not happened, so naming its last day would promise a period this option
 * cannot yet be counting (§1a).
 */
export function currentCycleOptionLabel(cycle: BillingCycleWindow): string {
  return `This billing cycle (${formatDay(cycle.from)} – now)`;
}

/**
 * A-19 — the picker's label for a window that is not a billing cycle at all.
 *
 * ⚠️ It exists because another screen can set the app's date range to something else (the zoom
 * controls on Tokens & Cost), and a picker that showed "This billing cycle" over a seven-day
 * window would be a label contradicting the numbers beneath it. The row states the real dates
 * instead, and the last day it names is the last INCLUDED one (§4.2).
 */
export function otherWindowOptionLabel(from: number | null, to: number | null): string {
  if (from !== null && to !== null) return `${formatDay(from)} – ${formatDay(to - 1)}`;
  if (from !== null) return `${formatDay(from)} onwards`;
  return `Up to ${formatDay((to ?? 0) - 1)}`;
}

/**
 * §1a / A-19 — how far through an unfinished cycle we are, said the way a person says it:
 * "day 4 of 31". ⚠️ This is the whole defence against the partial-cycle trap: a cycle four days
 * old sits beside complete ones, and without this line its shorter bar reads as "I spent less"
 * rather than "this one is not over" (CLAUDE.md §1).
 */
export function cycleProgressLabel(elapsedDays: number, totalDays: number): string {
  return `still counting — day ${formatInteger(elapsedDays)} of ${formatInteger(totalDays)}`;
}

/**
 * §4.6 / A-19 — the cycles the app declined to list, said out loud rather than left as a shorter
 * list nobody can see the end of. Returns `null` when nothing was left out.
 */
export function truncatedCyclesNote(truncated: number): string | null {
  if (truncated <= 0) return null;
  return truncated === 1
    ? 'One older billing cycle is not shown.'
    : `${formatInteger(truncated)} older billing cycles are not shown.`;
}
