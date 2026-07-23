// Session-efficiency trajectory math — PROGRESS.md amendment A-12 (2026-07-23).
//
// ⚠️ This is the ONE definition of the baseline / decay / verdict arithmetic (CLAUDE.md §1: every
// metric defined once). It is deliberately in `src/shared/**`: it is a pure function of the raw
// per-turn series the wire already carries, with no DOM, no React and no I/O, so both the renderer
// (which colours the curve) and the golden metric test import exactly this — there is no second
// copy to drift.
//
// ⚠️ **`efficiency` is a self-referential proxy — output produced per token of context carried.**
// It is NOT a measure of answer quality (this app cannot see quality). Nothing here, and no caller,
// may imply otherwise.
//
// ⚠️ Nothing is computed in SQL and nothing is stored (ADR-027). The threshold arrives per call
// because it is a live, user-configurable setting; changing it re-colours instantly with no
// re-query. A `context = 0` turn is never divided — it is excluded from the ratio and counted as
// incomplete (§1: never divide by zero, never fabricate a `0`).

/** One raw turn as it arrives on the wire (`ContextOverhead.sessions[].turns`). */
export interface TrajectoryTurn {
  readonly context: number;
  readonly output: number;
}

/** The four end-states a session (or a turn) can be in. `grey` = not enough to judge. */
export type TrajectoryBand = 'green' | 'amber' | 'red' | 'grey';

/**
 * A-12 — the baseline is the median efficiency of the first 3 ELIGIBLE turns. Median (not mean)
 * resists one early outlier; 3 is the smallest window a median is robust over, and it is taken
 * before the context has accumulated, which is what "how it started" means.
 */
export const BASELINE_TURNS = 3;

/**
 * A-12 — the end-state verdict is the band of the median decay over the last 3 eligible turns, so a
 * single terse reply at the very end cannot paint a whole session red.
 */
export const VERDICT_TURNS = 3;

/**
 * A-12 — a session needs at least this many eligible turns to be judged at all. Below it the
 * verdict is grey "too short to judge", NEVER a fabricated red or green (§1). Five gives a 3-turn
 * baseline plus a distinct recent window to decay against.
 */
export const MIN_ELIGIBLE_TURNS = 5;

/**
 * A-12 — "live" means the last recorded activity is within this window of the wall clock. A
 * PRESENTATIONAL constant, not a metric and not a setting; the comparison to "now" happens only in
 * the renderer and is written nowhere (§1's one sanctioned use of the clock).
 */
export const LIVE_WINDOW_MS = 5 * 60 * 1000;

/**
 * A-12 — "recently active" means the last activity was older than the live window but still within
 * the last hour. Same discipline as `LIVE_WINDOW_MS`: PRESENTATIONAL only, not a metric, not a
 * setting, compared to "now" only in the renderer and written nowhere.
 */
export const RECENT_WINDOW_MS = 60 * 60 * 1000;

/** The efficiency of one turn, or `null` when its context is zero (undivided, not `0`). */
export function efficiencyOf(turn: TrajectoryTurn): number | null {
  if (turn.context <= 0) return null;
  return turn.output / turn.context;
}

/** The median of a non-empty list. Undefined behaviour on empty is avoided by every caller. */
function median(values: readonly number[]): number {
  const sorted = [...values].toSorted((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  // Non-null: callers only pass non-empty arrays; the `?? 0` is a type guard, never reached.
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** One point of the analysed trajectory: the raw pair plus its efficiency (null if uncountable). */
export interface TrajectoryPoint {
  readonly context: number;
  readonly output: number;
  /** `null` when `context = 0` — this turn is not counted, it is not "efficiency 0". */
  readonly efficiency: number | null;
  /** `efficiency / baseline`, or `null` when either side is unavailable. */
  readonly decay: number | null;
}

/** The whole analysed trajectory of one session. */
export interface Trajectory {
  readonly points: readonly TrajectoryPoint[];
  /** Median efficiency of the first `BASELINE_TURNS` eligible turns, or `null` if too few. */
  readonly baseline: number | null;
  /** Turns whose context was `> 0` — the ones the ratio is built from. */
  readonly eligibleTurns: number;
  /** Turns skipped because their context was `0` (disclosed, never silently dropped). */
  readonly skippedZeroContext: number;
}

/**
 * Analyse a raw per-turn series into efficiencies, a baseline and per-turn decay. Pure; the
 * threshold is not needed here — it only enters when a decay is turned into a colour (`bandOf`).
 */
export function analyseTrajectory(turns: readonly TrajectoryTurn[]): Trajectory {
  const eligibleEfficiencies: number[] = [];
  let skippedZeroContext = 0;
  for (const turn of turns) {
    const efficiency = efficiencyOf(turn);
    if (efficiency === null) skippedZeroContext += 1;
    else eligibleEfficiencies.push(efficiency);
  }

  const baseline =
    eligibleEfficiencies.length >= BASELINE_TURNS
      ? median(eligibleEfficiencies.slice(0, BASELINE_TURNS))
      : null;

  const points: TrajectoryPoint[] = turns.map((turn) => {
    const efficiency = efficiencyOf(turn);
    const decay =
      efficiency !== null && baseline !== null && baseline > 0 ? efficiency / baseline : null;
    return { context: turn.context, output: turn.output, efficiency, decay };
  });

  return {
    points,
    baseline,
    eligibleTurns: eligibleEfficiencies.length,
    skippedZeroContext,
  };
}

/**
 * A-12 — the presentational "efficiency lost since it started" value for the third curve, on a
 * FIXED 0–100% scale: `(1 − min(decay, 1)) × 100`, clamped to [0, 100].
 *
 * ⚠️ Purely how the curve is DRAWN — it does not change the flag rule or the stored threshold
 * (`bandOf(decay, threshold)` still decides colours). A turn as efficient as its start OR BETTER
 * (`decay ≥ 1`) counts as **0% lost** (the `min(decay, 1)` cap), so early turns that beat the
 * median baseline sit flat at the bottom instead of pushing the axis past 100%. `decay = 0.40`
 * (the default flag) → **60% lost**; `decay → 0` → **100% lost**.
 */
export function efficiencyLostPercent(decay: number): number {
  const lost = (1 - Math.min(decay, 1)) * 100;
  return Math.min(Math.max(lost, 0), 100);
}

/**
 * A-12 — the colour of a single decay against the live threshold: red below the threshold, amber
 * between the threshold and baseline, green at or above baseline. Moving the slider (the threshold)
 * moves the red boundary, which is exactly what "flag below N%" means.
 */
export function bandOf(decay: number, threshold: number): Exclude<TrajectoryBand, 'grey'> {
  if (decay < threshold) return 'red';
  if (decay < 1) return 'amber';
  return 'green';
}

/**
 * A-12 — WHY a session cannot be judged, when it cannot. Two genuinely different situations, so the
 * screen can explain each accurately rather than lie in one of them (§1):
 *   · `'too-short'`  — fewer than `MIN_ELIGIBLE_TURNS` eligible turns, so there is not yet enough of
 *                      the session to see a trend.
 *   · `'no-baseline'` — enough turns, but the first ones produced no output, so the starting
 *                      efficiency is zero and there is no meaningful "how it started" to decay from
 *                      (dividing by it would be the divide-by-zero this app refuses, §1).
 * `null` means the session IS judgeable.
 */
export type GreyReason = 'too-short' | 'no-baseline';

export function greyReasonOf(trajectory: Trajectory): GreyReason | null {
  if (trajectory.eligibleTurns < MIN_ELIGIBLE_TURNS) return 'too-short';
  // `baseline === null` also lands here, but with ≥ MIN_ELIGIBLE_TURNS turns that cannot happen
  // (a baseline is null only for < BASELINE_TURNS eligible turns, and 5 > 3); `<= 0` is the real
  // case — a degenerate zero baseline from early turns that wrote nothing.
  if (trajectory.baseline === null || trajectory.baseline <= 0) return 'no-baseline';
  return null;
}

/**
 * A-12 — the session's end-state verdict. Grey when it cannot be judged (see `greyReasonOf`, the
 * single authority — never a fabricated colour, §1); otherwise the band of the median decay over
 * the last `VERDICT_TURNS` eligible turns.
 */
export function verdictOf(trajectory: Trajectory, threshold: number): TrajectoryBand {
  if (greyReasonOf(trajectory) !== null) return 'grey';
  const recentDecays = trajectory.points
    .map((point) => point.decay)
    .filter((decay): decay is number => decay !== null)
    .slice(-VERDICT_TURNS);
  // Defensive: with a positive baseline and ≥ 5 eligible turns this is always non-empty.
  if (recentDecays.length === 0) return 'grey';
  return bandOf(median(recentDecays), threshold);
}

/**
 * A-12 — crop a series to its last `n` items, for the detail view's x-axis window (view zoom).
 *
 * ⚠️ **A pure VIEW crop — it NEVER re-measures anything (§1).** The baseline, per-turn decay and
 * per-turn colours are computed by `analyseTrajectory` over the WHOLE session BEFORE this is called;
 * this only slices those already-anchored points (or the raw turns) for drawing, so a turn that is
 * red at full scale stays red when the window is zoomed onto it. The baseline never moves.
 *
 * `n === null` (whole session) or `n >= length` returns every item; a session with fewer than `n`
 * items returns all of them — never padded, never fabricated.
 */
export function lastN<T>(items: readonly T[], n: number | null): readonly T[] {
  if (n === null || n >= items.length) return items;
  return items.slice(items.length - n);
}

/**
 * A-12 — whether a session was active within `LIVE_WINDOW_MS` of `now`. Presentational only. A
 * `lastActivityTs` in the future (clock skew) is not "live"; it is treated as not-recent rather
 * than trusted.
 */
export function isLive(lastActivityTs: number, now: number): boolean {
  const age = now - lastActivityTs;
  return age >= 0 && age < LIVE_WINDOW_MS;
}

/**
 * A-12 — whether a session was active in the last hour but NOT within the live window (so a session
 * is either live or recent, never both). Presentational only, like `isLive`. A `lastActivityTs` in
 * the future (clock skew) has a negative age and is neither live nor recent — it is not trusted.
 */
export function isRecent(lastActivityTs: number, now: number): boolean {
  const age = now - lastActivityTs;
  return age > LIVE_WINDOW_MS && age <= RECENT_WINDOW_MS;
}
