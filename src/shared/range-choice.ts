/**
 * A-19 — **what the user picked at the top of the app, as opposed to the dates it resolved to.**
 *
 * ⚠️ **The reason this type exists at all is CLAUDE.md §1.** The global filter carries absolute
 * epoch ms (§4.2), and `lastGlobalFilter` (§3.13) persists it verbatim. Persisting "this billing
 * cycle" that way would store two fixed midnights — so the next launch after the anchor day had
 * passed would silently reopen the app on the cycle that has *closed*, with the control saying
 * "This billing cycle" over totals that stopped moving. That is a wrong number with nothing
 * broken. So the CHOICE is what is persisted, and it is resolved against the clock of the moment
 * it is used; `lastGlobalFilter` keeps owning the project selection, which has no such problem.
 *
 * ⚠️ It lives in `src/shared/` because the main process validates the stored value (§3.13 —
 * rejected, never clamped) and the renderer resolves it. Two definitions of what a legal choice
 * is could disagree, and the disagreement would look like a setting that quietly stopped
 * sticking. One definition, compiled into both processes.
 */

import { currentBillingCycle, cyclesBetween, type BillingCycleWindow } from './billing-cycle';

/**
 * `'all'` — every record, unbounded.
 * `'cycle:current'` — whichever billing cycle the clock is in **at the time of resolution**.
 * `` `cycle:${number}` `` — one specific cycle, named by the epoch ms it opens on.
 *
 * ⚠️ The template-literal member accepts `cycle:1.5` and `cycle:NaN` at the type level, so the
 * runtime validator below is the real gate; the type is what stops a bare string being assigned.
 */
export type RangeChoice = 'all' | 'cycle:current' | `cycle:${number}`;

/** §3.13 — the documented default, and the fallback for a stored value that no longer resolves. */
export const DEFAULT_RANGE_CHOICE: RangeChoice = 'cycle:current';

/** The choice that names one specific cycle. Used when a bar or a picker row is clicked. */
export function rangeChoiceForCycle(window: BillingCycleWindow): RangeChoice {
  return `cycle:${String(window.from)}` as RangeChoice;
}

/**
 * §3.13's validator: the accepted value, or `undefined` when the input is not a legal choice.
 * ⚠️ Rejected, never coerced — a `cycle:` with an unreadable instant behind it is not a range
 * with a repairable typo, it is a value we cannot honour, and honouring it approximately would
 * put the app on a window nobody chose.
 */
export function parseRangeChoice(value: unknown): RangeChoice | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'all' || value === 'cycle:current') return value;
  const prefix = 'cycle:';
  if (!value.startsWith(prefix)) return undefined;
  const digits = value.slice(prefix.length);
  // ⚠️ The shape is checked BEFORE the conversion, because `Number('')` is `0` and `Number(' 5')`
  // is `5`: a bare `cycle:` would otherwise be accepted as the cycle that opened at the epoch — a
  // legal-looking value nobody wrote (CLAUDE.md §1).
  //
  // ⚠️ **Digits only — a leading `-` is rejected here rather than at read.** A cycle opens at a
  // local midnight, and this application's data is Claude transcripts, so a cycle opening before
  // 1970 is not a range with a repairable typo: it is a value no picker can ever list. It used to
  // be accepted, written to `settings`, and then quietly dropped by `resolveRangeChoice`, which is
  // the "coerced" behaviour this module's own posture rules out — the store held a value the app
  // never honoured. Rejecting on the way in means what is stored is what is resolved.
  if (!/^\d+$/.test(digits)) return undefined;
  const instant = Number(digits);
  if (!Number.isSafeInteger(instant)) return undefined;
  return `cycle:${String(instant)}` as RangeChoice;
}

/** The epoch ms a `cycle:<ms>` choice names, or `null` for the other two members. */
export function cycleStartOf(choice: RangeChoice): number | null {
  const parsed = parseRangeChoice(choice);
  if (parsed === undefined || parsed === 'all' || parsed === 'cycle:current') return null;
  return Number(parsed.slice('cycle:'.length));
}

/** §4.2's half-open range, as the global filter carries it. `null` on both ends is unbounded. */
export interface ResolvedRange {
  /**
   * ⚠️ The choice actually honoured, which is NOT always the one asked for: a stored cycle that
   * no longer resolves falls back to the current one, and the caller has to know that so the
   * control can show what is really in force rather than what was stored (CLAUDE.md §1a).
   */
  choice: RangeChoice;
  from: number | null;
  to: number | null;
}

/**
 * The choice, resolved against the clock — the one place a stored choice becomes two dates.
 *
 * ⚠️ **A `cycle:<ms>` that no longer names a cycle falls back to the current one**, deliberately
 * and visibly: the anchor day may have been changed since the choice was stored, or the cycle may
 * predate every record the dataset now holds (a rebuild, a different Claude directory). Either
 * way the stored window is not one the picker can offer, and silently applying an unlisted range
 * would leave every screen filtered to a period the control cannot name (CLAUDE.md §1a).
 *
 * The membership test is against `cyclesBetween`, not against the arithmetic alone, so the
 * resolved window is by construction one of the rows the picker lists.
 */
export function resolveRangeChoice(
  choice: RangeChoice,
  anchorDay: number,
  firstInstant: number | null,
  now: number,
): ResolvedRange {
  if (choice === 'all') return { choice, from: null, to: null };
  const start = cycleStartOf(choice);
  if (start !== null) {
    const listed = cyclesBetween(anchorDay, firstInstant, now).cycles.find(
      (window) => window.from === start,
    );
    if (listed !== undefined) return { choice, from: listed.from, to: listed.to };
  }
  const current = currentBillingCycle(anchorDay, now);
  return { choice: DEFAULT_RANGE_CHOICE, from: current.from, to: current.to };
}
