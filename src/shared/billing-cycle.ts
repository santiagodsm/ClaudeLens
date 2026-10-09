/**
 * A-19 (PROGRESS.md amendment log) — **the billing cycle, as a window of local calendar time.**
 *
 * The user is billed for Claude on a fixed day of each month and asked for the whole app to be
 * filterable by that cycle, and for the cycles to be comparable against each other. This module
 * is the whole of that arithmetic: given the day of the month the bill lands, it turns an instant
 * into the half-open window `[from, to)` of §4.2 — the same shape the global filter already
 * carries, so nothing downstream learns a new concept.
 *
 * ⚠️ **It lives in `src/shared/` and not in the renderer, and that placement is the point.**
 * A-18 put it under `src/renderer/lib/`, which was right while a cycle was only ever a range the
 * renderer handed to the global filter. A-19 makes the main process bucket events by cycle too
 * (`q:billingCycleTotals`), and two implementations of one boundary rule are exactly the defect
 * class this project exists to prevent: they can disagree, and the disagreement is invisible —
 * a per-cycle total that covers a different window than the tiles for the same cycle
 * (CLAUDE.md §1). One implementation, compiled into both processes.
 * `src/renderer/lib/billing-cycle.ts` re-exports every name below, so nothing renderer-side moved.
 *
 * ⚠️ **Pure, and computed in LOCAL calendar time** (§3.1.1, ADR-021: timestamps are UTC epoch ms
 * and every calendar boundary is taken in local time). The boundaries are built with the
 * local-time `Date(year, month, day)` constructor, **never by adding a fixed multiple of 24 h**:
 * a month is not 30 days, and a day is not 24 hours across a daylight-saving change. Adding
 * `30 × 86_400_000` would put a boundary an hour off a real local midnight twice a year and a
 * day or three off in every month — either way the totals would quietly cover the wrong records,
 * which is CLAUDE.md §1's worst outcome.
 *
 * ⚠️ The `Date(year, month, day)` constructor normalises an out-of-range month, so month `-1` is
 * December of the previous year and month `12` is January of the next. The year rollover
 * therefore needs no special case — it is the same expression.
 */

/** §4.2's half-open range: `from` inclusive, `to` exclusive, both UTC epoch ms. */
export interface BillingCycleWindow {
  from: number;
  to: number;
}

/** The lowest day of the month a cycle may be anchored to. */
export const MIN_BILLING_CYCLE_DAY = 1;

/**
 * The highest. ⚠️ 28, not 31, and the reason is load-bearing: every month has a 28th, so a cycle
 * boundary in [1, 28] exists in every month and never has to be clamped to a month's last day.
 * A 31st would give February a boundary on a different day from January's — a window that moved
 * without the user asking for it. The setting rejects anything outside this range (§3.13, A-18).
 */
export const MAX_BILLING_CYCLE_DAY = 28;

/**
 * §3.13's documented default for `billingCycleDay`, stated here rather than in three places:
 * the setting table that persists it and every renderer surface that has to name a cycle before
 * a settings snapshot has arrived read the same constant, so "the default" cannot drift between
 * the value that is stored and the value that is drawn (A-19).
 */
export const DEFAULT_BILLING_CYCLE_DAY = 15;

/**
 * A-19 — the most cycles `cyclesBetween` will ever return: 120, or ten years.
 *
 * ⚠️ The cap exists so a corrupt or absurd first timestamp cannot make a picker with fifty
 * thousand entries or a payload that breaches P-27's 2 MB response budget. ⚠️ It is **reported**,
 * never silently applied: `cyclesBetween` returns how many windows it left out, and every caller
 * carries that number through to the user (§4.6 — incompleteness is data in the success payload).
 */
export const MAX_BILLING_CYCLES = 120;

/**
 * The billing cycle containing an arbitrary instant.
 *
 *   · `from` = local midnight of the most recent occurrence of `anchorDay` **on or before** the
 *     instant. An instant exactly at that midnight belongs to the NEW cycle — the range is
 *     inclusive at `from`, which is what §4.2's half-open `[from, to)` means and what makes
 *     consecutive cycles partition time with neither a gap nor an overlap.
 *   · `to`   = local midnight of `anchorDay` in the following month, **exclusive**.
 */
export function cycleContaining(anchorDay: number, instant: number): BillingCycleWindow {
  assertAnchorDay(anchorDay);
  assertInstant(instant, 'instant');

  const at = new Date(instant);
  // Before the anchor day of this month, the cycle that contains the instant started last month.
  const startMonth = at.getDate() >= anchorDay ? at.getMonth() : at.getMonth() - 1;

  return {
    from: new Date(at.getFullYear(), startMonth, anchorDay).getTime(),
    to: new Date(at.getFullYear(), startMonth + 1, anchorDay).getTime(),
  };
}

/**
 * The current billing cycle — `cycleContaining` at the wall clock, kept as its own name because
 * that is what every A-18 caller says and because "the cycle containing now" is the one the
 * surfaces talk about (§6.3).
 */
export function currentBillingCycle(anchorDay: number, now: number): BillingCycleWindow {
  return cycleContaining(anchorDay, now);
}

/**
 * A-19 — every cycle from the one containing `firstInstant` through the one containing `now`,
 * **newest first**, capped at `MAX_BILLING_CYCLES` with the shortfall reported rather than hidden.
 *
 * ⚠️ `firstInstant === null` means "no data, so no cycles have been observed" and returns an
 * EMPTY list, never a fabricated one containing the current cycle. A picker offering a cycle over
 * a dataset that holds nothing is a promise the data cannot keep (CLAUDE.md §1).
 *
 * ⚠️ The two endpoints are read as `min` and `max` rather than assumed in order. A transcript can
 * legitimately carry a timestamp after the wall clock (a machine whose clock was wrong, a file
 * copied from another host), and a list built strictly "backwards from now" would leave those
 * events in no cycle at all — data silently outside every bucket. Covering both endpoints means
 * every observed instant lands in exactly one returned window, or in the reported truncation.
 *
 * ⚠️ The count is computed from the two endpoint months, and only the kept windows are built, so
 * a nonsense `firstInstant` costs a subtraction rather than a million iterations.
 */
export interface BillingCycleSeries {
  /** Newest first. `cycles[i].from === cycles[i + 1].to` for every consecutive pair. */
  cycles: BillingCycleWindow[];
  /** How many older cycles the cap left out. `0` normally; never silently non-zero. */
  truncated: number;
}

export function cyclesBetween(
  anchorDay: number,
  firstInstant: number | null,
  now: number,
): BillingCycleSeries {
  assertAnchorDay(anchorDay);
  assertInstant(now, 'now');
  if (firstInstant === null) return { cycles: [], truncated: 0 };
  assertInstant(firstInstant, 'firstInstant');

  const oldest = cycleContaining(anchorDay, Math.min(firstInstant, now));
  const newest = cycleContaining(anchorDay, Math.max(firstInstant, now));
  // Cycles are one per calendar month by construction (the anchor day exists in every month —
  // that is what `MAX_BILLING_CYCLE_DAY = 28` buys), so the number of them between two windows is
  // the number of months between their starts, counted inclusively. No division, no day counting.
  const total = monthsBetween(new Date(oldest.from), new Date(newest.from)) + 1;
  const kept = Math.min(total, MAX_BILLING_CYCLES);

  const cycles: BillingCycleWindow[] = [];
  let window = newest;
  for (let index = 0; index < kept; index += 1) {
    cycles.push(window);
    // ⚠️ One millisecond before a cycle opens is the last instant of the previous one — the
    // half-open window's own definition, used instead of "subtract a month", so the step back
    // and the step forward are provably the same boundary.
    window = cycleContaining(anchorDay, window.from - 1);
  }
  return { cycles, truncated: total - kept };
}

/**
 * §1a — a cycle in plain words, naming real dates: "15 Jul – 14 Aug 2026".
 *
 * ⚠️ It names the **last included day**, `to - 1`, and never the exclusive bound. Writing the
 * bound on the label would name a day whose records are not in the total — a caption that
 * disagrees with the number beside it (§4.2, CLAUDE.md §1a).
 *
 * ⚠️ The year is always on the closing date, and on the opening one too when the cycle crosses a
 * new year ("15 Dec 2025 – 14 Jan 2026"). A list of cycles runs for years, and two Julys with no
 * year between them are two rows the user cannot tell apart.
 *
 * The month name is rendered by the machine's own locale, like every other date in this
 * application, so the order of day and month is the reader's, not this file's.
 */
export function cycleLabel(window: BillingCycleWindow): string {
  const opens = new Date(window.from);
  const closes = new Date(window.to - 1);
  const sameYear = opens.getFullYear() === closes.getFullYear();
  return `${dayAndMonth(opens, !sameYear)} – ${dayAndMonth(closes, true)}`;
}

/**
 * Whether a window is one of this user's billing cycles — and the window itself if it is, so the
 * caller can caption it without re-deriving it.
 *
 * ⚠️ The test is self-contained: a window is a billing cycle exactly when it is the cycle that
 * contains its own first instant. That stays true of the cycle currently on screen even after the
 * clock has rolled into the next one, which is the state the caption has to be able to describe —
 * the numbers being displayed belong to the window they were counted over, not to the window the
 * view is now asking for (§1).
 */
export function asBillingCycleWindow(
  anchorDay: number,
  from: number | null,
  to: number | null,
): BillingCycleWindow | null {
  if (from === null || to === null) return null;
  const cycle = cycleContaining(anchorDay, from);
  return cycle.from === from && cycle.to === to ? cycle : null;
}

/**
 * A-19 — the key a cycle is joined on when the main process buckets events by cycle in SQL.
 *
 * ⚠️ **This is one half of a two-sided identity and the other half is
 * `billingCycleKeySql()` in `src/main/db/repositories/scope.ts`.** The SQL shifts each event's
 * LOCAL date back by `anchorDay - 1` days and takes its year-month; the shift lands every day of
 * the cycle `[from, to)` inside the calendar month that `from` falls in — the opening day maps to
 * the 1st of that month, the last included day maps to its last — so the year-month of `from` is
 * that key, exactly. Written here as a two-line derivation rather than a second month
 * calculation, and pinned by a golden test that compares the two sides over real parsed rows.
 */
export function billingCycleKey(window: BillingCycleWindow): string {
  const opens = new Date(window.from);
  return `${String(opens.getFullYear()).padStart(4, '0')}-${String(opens.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * How many local calendar days the cycle spans, and how many of them have happened by `at`.
 *
 * ⚠️ Both are **calendar day counts**, computed by re-reading the two local dates through
 * `Date.UTC` and subtracting. That detour is the whole trick and it is not decoration: local
 * midnight to local midnight is 23, 24 or 25 hours across a daylight-saving change, so
 * `(to - from) / 86_400_000` is not an integer twice a year and rounding it would be a number
 * that is right most of the time. Read as UTC, the two local dates are exact multiples of a day
 * apart, always.
 *
 * `elapsed` counts the cycle's opening day as day 1 — "day 4 of 31" is how a person says it —
 * and never exceeds `total`, so a completed cycle reads `31 of 31` rather than more.
 */
export function cycleDayCounts(
  window: BillingCycleWindow,
  at: number,
): { elapsedDays: number; totalDays: number } {
  assertInstant(at, 'at');
  const totalDays = calendarDaysBetween(window.from, window.to);
  if (at < window.from) return { elapsedDays: 0, totalDays };
  return {
    elapsedDays: Math.min(totalDays, calendarDaysBetween(window.from, at) + 1),
    totalDays,
  };
}

/** Whether the cycle is the one the clock is inside — §4.2's half-open window, applied to `now`. */
export function isCycleInProgress(window: BillingCycleWindow, now: number): boolean {
  assertInstant(now, 'now');
  return window.from <= now && now < window.to;
}

// ---------------------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** Whole local calendar days from one instant's local date to another's. See `cycleDayCounts`. */
function calendarDaysBetween(from: number, to: number): number {
  const start = new Date(from);
  const end = new Date(to);
  return (
    (Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) -
      Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
    MS_PER_DAY
  );
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

function dayAndMonth(date: Date, withYear: boolean): string {
  return date.toLocaleDateString(
    undefined,
    withYear
      ? { day: 'numeric', month: 'short', year: 'numeric' }
      : { day: 'numeric', month: 'short' },
  );
}

/**
 * ⚠️ A bad anchor day is a programming fault, not a state to render around: the setting validates
 * the range on write and falls back to its documented default on read (§3.13), so nothing legal
 * reaches here. A throw during render unwinds to the view's `ViewErrorBoundary` (§7.3 — "one
 * error boundary per view, so a broken chart never blanks the shell"), which renders that view as
 * a failure; in the main process it becomes an `E_INTERNAL` result. Either is honest, while
 * silently clamping would move the window the totals cover and say nothing (§1).
 */
function assertAnchorDay(anchorDay: number): void {
  if (
    !Number.isInteger(anchorDay) ||
    anchorDay < MIN_BILLING_CYCLE_DAY ||
    anchorDay > MAX_BILLING_CYCLE_DAY
  ) {
    throw new RangeError(
      `The billing-cycle day must be a whole number from ` +
        `${String(MIN_BILLING_CYCLE_DAY)} to ${String(MAX_BILLING_CYCLE_DAY)}; ` +
        `got ${String(anchorDay)}`,
    );
  }
}

/**
 * The largest epoch ms a `Date` can represent — ±100 000 000 days from the epoch (ECMA-262
 * "Time Values and Time Range"). Beyond it every `Date` is Invalid Date and every field read off
 * one is `NaN`.
 */
const MAX_TIME_VALUE = 8.64e15;

/**
 * ADR-021 — an instant is a UTC epoch ms a `Date` can actually represent. Never defaulted to
 * "now" (CLAUDE.md §1).
 *
 * ⚠️ The bound is `MAX_TIME_VALUE` and **not** merely `Number.isFinite`, because finiteness is
 * not the property this guard needs. `9e15` is finite and out of `Date`'s range, so
 * `new Date(9e15)` is Invalid Date, every month and year read off it is `NaN`, and the arithmetic
 * downstream returns a shape that looks like an answer: `cyclesBetween` produced
 * `{ cycles: [], truncated: NaN }` — an empty card under a disclosure line reading "NaN older
 * billing cycles are not shown". A throw is the honest outcome, and this guard exists precisely
 * to produce it (CLAUDE.md §1).
 */
function assertInstant(value: number, label: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_TIME_VALUE) {
    throw new RangeError(
      `A billing cycle needs an epoch ms a date can represent for ${label}; got ${String(value)}`,
    );
  }
}
