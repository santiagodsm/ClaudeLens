// Active time — DESIGN §5.9 M-07, M-08, M-19, M-20; ADR-022, ADR-035, ADR-036, ADR-037.
//
// This is the file the project's quality bar is aimed at. Everything in it is wrong in a way
// that looks right, so every choice below cites the line that forced it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// (1) WHEN AND HOW — ADR-022. Computed at query time, from event timestamps, never stored.
//     `SUM(MIN(ts − LAG(ts) OVER (PARTITION BY <partition> ORDER BY ts), idleGapMs))`, with the
//     first event of each partition contributing 0. No `active_seconds` column exists anywhere.
//
// (2) OVER WHICH EVENTS — ADR-035. **ALL events of the partition, BOTH origins**
//     (`origin IN ('main','subagent')`), merged into ONE timestamp-ordered stream *before* gaps
//     are taken. ⚠️ Synthetic events are excluded from token statistics (M-01) but **are
//     included here** — they are real moments in the stream. There is deliberately no
//     `is_synthetic = 0` and no `origin = 'main'` predicate below; adding either is the
//     rejected reading, and fixtures F-01 and F-06 assert the number the two readings disagree
//     about.
//
// (3) OVER WHICH PARTITION — ADR-036. Exactly three bindings, and **no unbound case**:
//       (A) single session          → PARTITION BY session_id
//       (B) working day             → PARTITION BY (local date of ts, project_id)   [= M-08]
//       (C) any aggregate spanning more than one session
//                                   → the SUM of (B) over every working-day group in scope
//     ⚠️ (C) is NOT a sum over sessions and NOT one global stream. Intra-day inter-session gaps
//     are capped at the threshold and COUNTED, exactly like any other gap (fixture F-12).
//
// (4) FILTER BOUNDARIES — M-07. Each partition's stream is restricted to the `GlobalFilter`
//     window FIRST; the first event *of the restricted stream* contributes 0, so a filter cut
//     behaves exactly like a partition start. That is why `scoped` is the innermost CTE.
//
// (4a) THE UNIT — ADR-040. ⚠️ The partition column is not `events.project_id`; it is the
//     **project unit**, which is the project itself unless the user has said it is the same
//     project as another folder, in which case it is their group. `PROJECT_UNIT_CTE` is joined
//     inside `scoped`, the INNERMOST CTE, so the grouping is applied WHEN THE PARTITION IS
//     FORMED.
//     ⚠️⚠️ **Summing two projects' finished active-time values instead would give a different
//     and wrong number.** Once two folders are one project, a gap between them on the same local
//     day is an INTRA-partition gap: it gets capped at the idle threshold and COUNTED, exactly
//     like the intra-day inter-session gap ADR-036 binding (C) already counts. Adding the two
//     separate results afterwards drops that gap entirely. It is the same class of mistake
//     fixture F-12 exists to catch, and F-16 pins it for grouping with a `not.toBe()` on the
//     naive sum.
//     ⚠️ Nothing here infers a grouping. `project_unit` reads two USER tables the user filled in
//     by hand (§3.19); there is no name matching and no path similarity anywhere in the path.
//
// (5) THE OVERLAP — ADR-037. M-19 is the measure of the UNION of covered intervals across
//     partitions. ⚠️ It is **not** "M-07 with one global partition": capping is applied per
//     partition, so a coarser partition has longer gaps that the cap truncates harder, and the
//     naive reading yields a NEGATIVE overlap (worked counterexample in ADR-037, reproduced in
//     the test suite). M-19 has no surface and exists only so M-20 can be computed; deleting it
//     breaks INV-22 and fixture F-13.

import { Repository, sumToSafeNumber } from './base';
import { PROJECT_UNIT_CTE } from './project-groups';
import { idleGapMs, localDate, scopeClause, type QueryContext } from './scope';
import type { SqlParam, SqliteDatabase } from '../sqlite';

/** M-08 / §4.5 `WorkingDayRow`, before display names are joined on. */
export interface WorkingDayGroup {
  /** Local calendar date, `YYYY-MM-DD` (ADR-021). */
  readonly day: string;
  /**
   * ⚠️ The **project unit**, not `events.project_id` (ADR-040): the project's own id, or
   * `-groupId` when the user has said this folder is the same project as another. `projects.id`
   * is a rowid alias and always `>= 1`, so the two can never collide.
   */
  readonly projectId: number;
  /** M-07 binding (B), in seconds. */
  readonly activeSeconds: number;
  /** M-08 — `(last − first)` within the group, in seconds. */
  readonly spanSeconds: number;
  /** M-08 — distinct `session_id` in the group. */
  readonly sessions: number;
}

/**
 * The two binding-(B) readings §6.8 needs at once — see `byWorkingDayViews`.
 *
 * ⚠️ `units` and `folders` do NOT sum to each other, and that is the point (ADR-040): once two
 * folders are one project, a same-day gap between them is inside one partition and is counted.
 * §6.8 says that on screen in plain words rather than leaving two numbers that look like they
 * should add up (§1a).
 */
export interface WorkingDayViews {
  /** Partitioned by `(local day, project unit)` — the numbers every card and tile reports. */
  readonly units: readonly WorkingDayGroup[];
  /** Partitioned by `(local day, raw folder)` — what each folder shows standing alone. */
  readonly folders: readonly WorkingDayGroup[];
}

/** M-07 binding (A), one row per session in scope. */
export interface SessionActiveRow {
  readonly sessionId: string;
  readonly activeSeconds: number;
}

/** The pair INV-22 is stated over, both in the storage unit so the subtraction is exact. */
export interface OverlapTotals {
  /** M-07 binding (C) — the sum of M-08 over every working-day group in scope, in seconds. */
  readonly activeSeconds: number;
  /** M-19 — the union measure, in ms. Internal; never displayed (§5.9 M-19). */
  readonly dedupMs: number;
  /** The sum of the binding-(B) values in ms, before the per-group conversion to seconds. */
  readonly activeMs: number;
  /** M-20, in seconds. */
  readonly overlapSeconds: number;
}

// ---------------------------------------------------------------------------------------
// The one event stream, and the one gap expression.
// ---------------------------------------------------------------------------------------
//
// ⚠️ `events` is read with NO origin predicate and NO synthetic predicate (ADR-035). Both
// omissions are the decision, not an oversight.
//
// The window's `ORDER BY e.ts, e.id` breaks ties deterministically. Ties change nothing about
// the sum — a second event at the same instant contributes a 0 gap whichever way round it is —
// but a deterministic order makes two runs of the same fixture byte-identical.

function scopedCte(
  filter: QueryContext['filter'],
  grouped = true,
  restrictProjectIds?: readonly number[],
): { sql: string; params: SqlParam[] } {
  const scope = scopeClause(filter, 'e');
  // ⚠️ `grouped: false` is the "as if no group existed" stream, and it exists for exactly one
  // reason: §6.8 shows a group's member folders WITH THEIR OWN NUMBERS, and a folder's own
  // number is the one it had before it was grouped. It is NOT a second reading of M-07 — every
  // surface that reports the unit uses the grouped stream. ⚠️ The two do NOT sum to each other,
  // and that is the point (see (4a) above); §6.8 says so on screen in plain words rather than
  // leaving two numbers that look like they should add up.
  // ⚠️ It is also only ever asked for over the folders the user actually grouped, because those
  // are the only folders the two streams disagree about — `byWorkingDayViews` states why.
  const unit = grouped
    ? `COALESCE(u.unit_id, e.project_id)`
    : // The raw column, untouched by grouping.
      `e.project_id`;
  const join = grouped ? `\n  LEFT   JOIN project_unit u ON u.project_id = e.project_id` : '';
  // ⚠️ A narrowing of the event set, NOT a second filter concept. The partition of the ungrouped
  // stream is `(local day, e.project_id)`, which never spans two folders, so restricting the rows
  // to a set of folders leaves every surviving partition's stream — and therefore every number
  // computed from it — untouched. `byWorkingDayViews` is the one caller and it relies on exactly
  // that (see its comment). An empty list would produce `IN ()`, which is not SQL; the caller
  // never passes one.
  const restriction =
    restrictProjectIds === undefined
      ? ''
      : `\n    AND e.project_id IN (${restrictProjectIds.map(() => '?').join(', ')})`;
  return {
    sql: `${PROJECT_UNIT_CTE},
scoped AS (
  SELECT e.id, e.session_id,
         ${unit} AS project_id,
         e.ts,
         ${localDate('e.ts')} AS local_day
  FROM   events e${join}
  WHERE  1 = 1${scope.sql}${restriction}
)`,
    params: [...scope.params, ...(restrictProjectIds ?? [])],
  };
}

/**
 * `gap` is NULL for the first event of each partition, which is exactly M-07's "the first event
 * of each partition contributing 0": SQLite's `min(X, Y)` returns NULL when either argument is
 * NULL, and `SUM()` skips NULLs. The zero is structural rather than a `COALESCE` that could be
 * dropped in a refactor.
 */
export function gappedCte(partition: string): string {
  return `gapped AS (
  SELECT s.*,
         s.ts - LAG(s.ts) OVER (PARTITION BY ${partition} ORDER BY s.ts, s.id) AS gap
  FROM   scoped s
)`;
}

/**
 * M-07's capped gap, in milliseconds. The one `?` is `idleGapMs`.
 *
 * ⚠️ **The `CAST(? AS INTEGER)` is load-bearing and must not be "simplified" away.**
 * `better-sqlite3` binds every JS `number` as a SQLite **REAL** — `typeof(?)` is `'real'` even
 * for `900000`. SQLite's scalar `min(X, Y)` returns *whichever argument is smaller, with that
 * argument's own type*, so `MIN(gap, ?)` yields an INTEGER when the gap wins and a **REAL**
 * exactly when the cap wins; `SUM()` over a set containing one REAL is a REAL, and from there
 * every downstream `/ 1000` silently becomes floating-point division. M-07 is defined over epoch
 * milliseconds, which are integers, and M-09 does its own ms→s conversion as integer division —
 * the cast is what keeps the whole active-time path in exact 64-bit integer arithmetic instead of
 * making that a property of how one driver happens to bind a number.
 *
 * Found 2026-07-22 by running `q:sessions` against a real ~1 GB dataset (see §5.9 M-07's
 * amendment and `test/metrics/f14-subsecond-active-time.test.ts`).
 */
export const CAPPED_GAP_MS = 'MIN(gap, CAST(? AS INTEGER))';

export const SESSION_PARTITION = 's.session_id';
/**
 * M-08's partition. ⚠️ `s.project_id` here is the **unit** id `scoped` computed (ADR-040), so a
 * group is one partition and its members' same-day gaps are inside it.
 */
const WORKING_DAY_PARTITION = 's.local_day, s.project_id';

/** M-07 binding (A) — one row per session in scope. */
function sessionActiveSql(scoped: string): string {
  return `WITH ${scoped},
${gappedCte(SESSION_PARTITION)}
SELECT session_id                          AS session_id,
       COALESCE(SUM(${CAPPED_GAP_MS}), 0)  AS active_ms
FROM   gapped
GROUP BY session_id`;
}

/**
 * M-07 binding (B) = M-08 — one row per `(local date, project_id)` group in scope.
 *
 * `span_ms` and `sessions` are computed over the SAME `gapped` rows, i.e. over every event of
 * the group including the first, because `SUM` skipping the NULL gap does not remove the row.
 * M-08 defines all three over one group, and computing them from one scan is what makes that
 * literally true rather than nearly true.
 */
function workingDaySql(scoped: string): string {
  return `WITH ${scoped},
${gappedCte(WORKING_DAY_PARTITION)}
SELECT local_day                          AS day,
       project_id                         AS project_id,
       COALESCE(SUM(${CAPPED_GAP_MS}), 0) AS active_ms,
       MAX(ts) - MIN(ts)                  AS span_ms,
       COUNT(DISTINCT session_id)         AS sessions
FROM   gapped
GROUP BY local_day, project_id`;
}

/**
 * M-19 **and** M-07 binding (C), from ONE pass over the working-day gapped stream.
 *
 * M-19 — the measure of the union of covered intervals, by sort-and-merge sweep.
 *
 * Covered interval, per M-19: for each event `i ≥ 1` of a partition with gap `gᵢ` and cap `c`,
 * `Cᵢ = [tᵢ − min(gᵢ, c), tᵢ]`. Within one partition the `Cᵢ` are provably disjoint, so their
 * measure sums to exactly M-07 — M-19 is a restatement of M-07, not a second definition of it.
 *
 * The sweep: order by start; carry the running maximum end of all PRECEDING intervals; each
 * interval contributes `end − max(start, prevMax)` when it extends past `prevMax`, and 0 when it
 * is wholly covered. That is the textbook union measure, expressed as one window function
 * instead of a JS loop so the whole quantity stays inside the query seam (ADR-008).
 *
 * ⚠️ The partition here is the WORKING-DAY partition, the same one binding (C) sums over. M-20
 * is `(C) − M-19`, and the two halves must be over the same partitioning or the difference is
 * not an overlap at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * ⚠️ **WHY BINDING (C) IS COMPUTED HERE INSTEAD OF BY A SECOND STATEMENT.** `overlap()` used to
 * run the M-08 statement and this one back to back. Both open by building the SAME `scoped` and
 * the SAME `gapped` — one index scan of `events`, one `date(…,'localtime')` per row and one sort
 * of the whole stream, done twice to produce two readings of one computation. On the §8 reference
 * dataset that second build was ~50% of the method. M-19's own paragraph above is what makes the
 * merge legitimate rather than a shortcut: the `Cᵢ` of a partition are disjoint and their measure
 * IS that partition's M-07, so `SUM(end_ms − start_ms)` per working-day group is binding (B)
 * *by M-19's own definition*, not by a second derivation that could drift from it.
 *
 * Three things are preserved exactly, because each is a way this could have gone silently wrong:
 *
 *   · **The unit of the sum.** §5.9 M-07 binding (C) and INV-21 are the sum of the per-group
 *     SECONDS, not of the per-group milliseconds — `SUM(active_ms / 1000)` is that, group by
 *     group, before any addition. Both operands are INTEGER (see `CAPPED_GAP_MS`), so `/` is
 *     SQLite integer division and every value here is `≥ 0`, which is `Math.trunc` exactly. The
 *     millisecond sum is returned alongside it, unrounded, because M-20's subtraction is done in
 *     the storage unit (see `overlap()`).
 *   · **Groups whose every gap is NULL.** `covered` drops them, `gapped` did not. Such a group is
 *     one event, its binding-(B) value is 0, and 0 changes neither sum. It never had a covered
 *     interval to contribute to M-19 either.
 *   · **INV-11.** The bound is still asserted, on the totals, by `sumToSafeNumber` in `overlap()`.
 *     A per-group value past `2^53−1` cannot hide inside a total that is under it.
 *
 * `span_ms` and `sessions` are deliberately NOT computed here: `overlap()` never used them, and
 * `byWorkingDay()` remains the one place M-08's three-numbers-over-one-group promise is kept.
 */
function overlapSql(scoped: string): string {
  return `WITH ${scoped},
${gappedCte(WORKING_DAY_PARTITION)},
covered AS (
  SELECT local_day, project_id,
         ts - ${CAPPED_GAP_MS} AS start_ms,
         ts                    AS end_ms
  FROM   gapped
  WHERE  gap IS NOT NULL
),
per_group AS (
  SELECT SUM(end_ms - start_ms) AS active_ms
  FROM   covered
  GROUP BY local_day, project_id
),
swept AS (
  SELECT start_ms, end_ms,
         MAX(end_ms) OVER (ORDER BY start_ms, end_ms
                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max
  FROM   covered
)
SELECT (SELECT COALESCE(SUM(active_ms), 0)        FROM per_group) AS active_ms,
       (SELECT COALESCE(SUM(active_ms / 1000), 0) FROM per_group) AS active_seconds,
       COALESCE(SUM(
         CASE WHEN prev_max IS NULL      THEN end_ms - start_ms
              WHEN end_ms  >  prev_max   THEN end_ms - MAX(start_ms, prev_max)
              ELSE 0 END), 0)                                     AS union_ms
FROM   swept`;
}

/** INV-22(c) — the elapsed wall-clock span of the scope, which M-19 can never exceed. */
function elapsedSql(scoped: string): string {
  return `WITH ${scoped}
SELECT COALESCE(MAX(ts) - MIN(ts), 0) AS elapsed_ms FROM scoped`;
}

interface SessionActiveRecord {
  readonly session_id: string;
  readonly active_ms: number | bigint | null;
}

interface WorkingDayRecord {
  readonly day: string;
  readonly project_id: number;
  readonly active_ms: number | bigint | null;
  readonly span_ms: number | bigint | null;
  readonly sessions: number;
}

/** The single row `overlapSql` returns — M-07 binding (C) in both units, and M-19. */
interface OverlapRecord {
  readonly active_ms: number | bigint | null;
  readonly active_seconds: number | bigint | null;
  readonly union_ms: number | bigint | null;
}

export class ActiveTimeRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /**
   * M-07 binding **(A)** — `PARTITION BY session_id`.
   * Used by `SessionRow.activeSeconds`, the drill-down, the session-length histogram,
   * `SessionSort='activeSeconds'` and M-10.
   */
  bySession(context: QueryContext): SessionActiveRow[] {
    const scoped = scopedCte(context.filter);
    return this.all<SessionActiveRecord>(
      sessionActiveSql(scoped.sql),
      ...scoped.params,
      idleGapMs(context),
    ).map((row) => ({
      sessionId: row.session_id,
      activeSeconds: msToSeconds(row.active_ms, 'activeSeconds'),
    }));
  }

  /**
   * M-07 binding **(B)** = **M-08** — `PARTITION BY (local date of ts, project_id)`.
   * These rows are the summands of binding (C) (INV-21), and the marathon leaderboard's rows.
   */
  byWorkingDay(context: QueryContext): WorkingDayGroup[] {
    const scoped = scopedCte(context.filter);
    return this.all<WorkingDayRecord>(
      workingDaySql(scoped.sql),
      ...scoped.params,
      idleGapMs(context),
    ).map(toWorkingDayGroup);
  }

  /**
   * Both binding-**(B)** views §6.8 needs — over the **units**, and over the **raw folders**,
   * ignoring every grouping — computed once wherever the two are the same computation.
   *
   * ⚠️ `folders` is the "as if no group existed" reading, and it exists for exactly one reason:
   * §6.8 shows a group's member folders WITH THEIR OWN NUMBERS, the numbers they had before they
   * were grouped. ⚠️ **They do not sum to the group's active time and must never be presented as
   * if they did** (ADR-040): merging two folders turns the gaps between them on a shared day into
   * intra-partition gaps, which are capped and counted. The view says so in plain words beside the
   * list (§1a).
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * ⚠️ **WHY ONE OF THE TWO SCANS IS USUALLY NOT RUN AT ALL.** `q:projectCards` used to run the
   * whole working-day window twice — once partitioned by `(local day, unit)`, once by
   * `(local day, folder)` — over every event in scope. But the two partitions differ **only where
   * a grouping exists.** For a folder in no group `PROJECT_UNIT_CTE` gives `unit_id = p.id`
   * (project-groups.ts note 3), so `(local day, unit)` and `(local day, folder)` are the same
   * partition over the same events, and the unit row IS the folder row — same day, same id, same
   * active seconds, same span, same session count. Two projects can never share a positive unit id
   * either, because a positive unit id is a project's own rowid.
   *
   * So the folder view is assembled: the unit rows with a positive id are reused verbatim, and the
   * window is re-run **only over the folders the user actually grouped**. With no groups — the
   * common case — the second scan disappears; with groups it is narrowed to those folders' events;
   * it can never cost more than the scan it replaces. ⚠️ This is a "stop computing it twice"
   * change and nothing else: the rows are the same rows, which is what
   * `test/metrics/f16-grouped-active-time.test.ts` and `f13` hold it to.
   *
   * ⚠️ The set of regrouped folders is read from `project_unit` itself rather than from
   * `project_group_members`, so the equality argument above is stated over the very expression
   * that decides the partition, and the two cannot drift.
   */
  byWorkingDayViews(context: QueryContext): WorkingDayViews {
    const units = this.byWorkingDay(context);
    const regrouped = this.#regroupedProjectIds();
    if (regrouped.length === 0) return { units, folders: units };
    return {
      units,
      folders: [
        // A positive unit id is a folder in no group, reporting under its own id.
        ...units.filter((row) => row.projectId > 0),
        ...this.#workingDayForFolders(context, regrouped),
      ],
    };
  }

  /**
   * M-07 binding **(C)** — the sum of (B) over every working-day group in scope.
   *
   * ⚠️ The sum is over the **per-group seconds**, not over the per-group milliseconds, and that
   * is what makes INV-21 hold *exactly* rather than nearly: `q:overviewTiles.activeSeconds` is
   * literally `SUM(row.activeSeconds)` over the rows `q:workingDays` returns for the same
   * filter, so the tile and the leaderboard cannot disagree by a rounding residue.
   */
  bindingCSeconds(context: QueryContext): number {
    let total = 0;
    for (const group of this.byWorkingDay(context)) total += group.activeSeconds;
    return total;
  }

  /**
   * M-19 (internal) and M-20 (the disclosed quantity), computed together so they cannot drift.
   *
   * ⚠️ **The subtraction happens in milliseconds, the storage unit, and the result is converted
   * to seconds once** — the same "compute exactly, convert at the edge" rule ADR-023 applies to
   * money. Subtracting two independently floored second-counts can produce `−1` from rounding
   * residue alone on data whose overlap is genuinely zero, and INV-22(b) states the overlap is
   * never negative. Doing it in the exact unit makes non-negativity a property of the arithmetic
   * (`union ≤ sum of measures`, elementary) rather than of a clamp that would also hide a real
   * bug.
   */
  overlap(context: QueryContext): OverlapTotals {
    const scoped = scopedCte(context.filter);
    const totals = this.one<OverlapRecord>(
      overlapSql(scoped.sql),
      ...scoped.params,
      idleGapMs(context),
    );
    const activeMs = sumToSafeNumber(totals?.active_ms ?? null, 'activeMs');
    const dedupMs = sumToSafeNumber(totals?.union_ms ?? null, 'dedupMs');

    return {
      // ⚠️ Already the sum of the per-group SECONDS (see `overlapSql`), so INV-21 still holds by
      // construction: this is `SUM(trunc(groupMs / 1000))`, never `trunc(SUM(groupMs) / 1000)`.
      activeSeconds: sumToSafeNumber(totals?.active_seconds ?? null, 'activeSeconds'),
      activeMs,
      dedupMs,
      overlapSeconds: Math.trunc((activeMs - dedupMs) / 1000),
    };
  }

  /** INV-22(c) — `M-19 <= ` the elapsed wall-clock span of the scope, in ms. */
  elapsedMs(context: QueryContext): number {
    const scoped = scopedCte(context.filter);
    const row = this.one<{ readonly elapsed_ms: number | bigint | null }>(
      elapsedSql(scoped.sql),
      ...scoped.params,
    );
    return sumToSafeNumber(row?.elapsed_ms ?? null, 'elapsedMs');
  }

  /**
   * The folders whose partition the grouping actually moves — `unit_id <> project_id`.
   *
   * ⚠️ Read from `PROJECT_UNIT_CTE`, the same expression `scoped` partitions by, so "these are the
   * folders whose two views differ" is true of the query that computes the views and not merely of
   * the membership table beside it (project-groups.ts note 2 and note 4).
   */
  #regroupedProjectIds(): number[] {
    return this.all<{ readonly project_id: number }>(
      `WITH ${PROJECT_UNIT_CTE}
       SELECT project_id FROM project_unit WHERE unit_id <> project_id`,
    ).map((row) => row.project_id);
  }

  /** Binding (B) over the RAW `events.project_id`, restricted to the named folders. */
  #workingDayForFolders(context: QueryContext, projectIds: readonly number[]): WorkingDayGroup[] {
    const scoped = scopedCte(context.filter, false, projectIds);
    return this.all<WorkingDayRecord>(
      workingDaySql(scoped.sql),
      ...scoped.params,
      idleGapMs(context),
    ).map(toWorkingDayGroup);
  }
}

/** One `WorkingDayGroup` from one row, so the three call sites cannot convert it three ways. */
function toWorkingDayGroup(row: WorkingDayRecord): WorkingDayGroup {
  return {
    day: row.day,
    projectId: row.project_id,
    activeSeconds: msToSeconds(row.active_ms, 'activeSeconds'),
    spanSeconds: msToSeconds(row.span_ms, 'spanSeconds'),
    sessions: row.sessions,
  };
}

/**
 * ms → seconds, truncating.
 *
 * M-09 does the same thing in SQL for `sessions.span_seconds` (`(last_ts - first_ts) / 1000`,
 * integer division), so active time and span agree about what "a second" is. `SUM()` over no
 * rows is NULL in SQLite, and NULL here means "no gaps", which is 0 — never a substituted value.
 */
function msToSeconds(value: number | bigint | null, label: string): number {
  return Math.trunc(sumToSafeNumber(value, label) / 1000);
}
