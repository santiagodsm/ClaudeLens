// Session and working-day queries — DESIGN §4.5 `q:sessions`, `q:sessionDetail`,
// `q:sessionHistogram`, `q:workingDays`, `q:executionTrace`; §5.9 M-07/M-08/M-09/M-10/M-11.
//
// ⚠️ **Three different active-time bindings meet in this file and they are not interchangeable**
// (ADR-036):
//   · `SessionRow.activeSeconds`, the drill-down, the histogram and `SessionSort='activeSeconds'`
//     are binding **(A)** — one session.
//   · `q:workingDays` rows are binding **(B)** — `(local date, project_id)`.
//   · The Overview tile and `ProjectCard.activeSeconds` are binding **(C)** — the SUM of (B).
// Each is served by the correspondingly-named method on `ActiveTimeRepository`; none is derived
// from another by addition here.
//
// ⚠️ M-09 (span) reads `sessions.span_seconds`, a generated column over two stored values, and
// is explicitly "threshold-independent, and partition-independent". It is NOT recomputed from
// the filtered event window: §5.9 says it "reads two stored columns of one session row and never
// gaps anything", so a filter narrows which sessions appear, not how long each one was.

import { API_CALL_ROWS_CTE } from './api-call-usage';
import { Repository, sumToSafeNumber } from './base';
import { ActiveTimeRepository, CAPPED_GAP_MS, SESSION_PARTITION, gappedCte } from './active-time';
import { costToWire, CostRepository } from './cost';
import { PROJECT_UNIT_CTE, ProjectGroupsRepository } from './project-groups';
import { DbError } from '../errors';
import { decodeCursor, encodeCursor, scopeClause, validateLimit, type QueryContext } from './scope';
import type { SqlParam, SqliteDatabase } from '../sqlite';
import type {
  ContextOverhead,
  Page,
  SessionSort,
  SortDirection,
  TokenBreakdown,
} from '../../../shared/ipc-contract';

/** Everything §4.5 `SessionRow` needs. */
export interface SessionAggregateRow {
  readonly id: string;
  readonly projectId: number;
  readonly displayName: string;
  readonly colorIndex: number;
  readonly primaryModel: string | null;
  readonly firstTs: number;
  readonly lastTs: number;
  readonly spanSeconds: number;
  readonly activeSeconds: number;
  readonly messages: number;
  readonly toolCalls: number;
  readonly subagentRuns: number;
  readonly tokens: TokenBreakdown;
  readonly costNanoUsd: number | null;
  readonly isPartial: boolean;
  /** §3.4 `sessions.archive_id` — `null` = live (ADR-033). */
  readonly archiveId: number | null;
  /** §3.15 `archives.archive_root`, the DESTINATION directory (§3.2 as amended by E10). */
  readonly archiveRoot: string | null;
}

/** §4.5 `q:workingDays` row, display columns joined on. */
export interface WorkingDayNamedRow {
  readonly day: string;
  readonly projectId: number;
  readonly displayName: string;
  readonly colorIndex: number;
  readonly activeSeconds: number;
  readonly spanSeconds: number;
  readonly sessions: number;
}

/** The identity columns §4.5 `SessionDetail` adds on top of `SessionRow`. */
export interface SessionIdentityRow {
  readonly gitBranch: string | null;
  readonly cliVersion: string | null;
}

/** §4.5 `SessionDetailSubagentRun`, in row form. */
export interface SubagentRunRow {
  readonly id: number;
  readonly subagentType: string | null;
  readonly description: string | null;
  readonly firstTs: number;
  readonly lastTs: number;
  readonly linked: boolean;
  readonly tokens: TokenBreakdown;
}

/** One tool-call span of §6.7's execution trace. */
export interface TraceToolRow {
  readonly toolName: string;
  readonly ts: number;
  readonly subagentRunId: number | null;
  readonly origin: string;
}

/** One page of §4.5 `q:sessions`, before the envelope is assembled. */
export interface SessionPageResult {
  readonly rows: SessionAggregateRow[];
  readonly nextCursor: string | null;
  readonly totalKnown: number;
}

// ---------------------------------------------------------------------------------------
// §6.5 — the session-length histogram, transcribed from the prototype.
// ---------------------------------------------------------------------------------------
//
// §6 makes the prototype "authoritative for … tile/chart composition", and its bucket edges are
// `['<15m','15–30m','30–60m','1–2h','2–4h','4–8h','8h+']`. They are transcribed rather than
// invented, and the boundaries are half-open `[lower, upper)` so a session of exactly 15 minutes
// lands in `15–30m` and is counted exactly once.
export const SESSION_HISTOGRAM_BUCKETS: readonly {
  readonly label: string;
  readonly lowerSeconds: number;
  readonly upperSeconds: number | null;
}[] = [
  { label: '<15m', lowerSeconds: 0, upperSeconds: 900 },
  { label: '15–30m', lowerSeconds: 900, upperSeconds: 1_800 },
  { label: '30–60m', lowerSeconds: 1_800, upperSeconds: 3_600 },
  { label: '1–2h', lowerSeconds: 3_600, upperSeconds: 7_200 },
  { label: '2–4h', lowerSeconds: 7_200, upperSeconds: 14_400 },
  { label: '4–8h', lowerSeconds: 14_400, upperSeconds: 28_800 },
  { label: '8h+', lowerSeconds: 28_800, upperSeconds: null },
];

/**
 * §6.4 (A-11) — the Context-overhead panel shows the ten heaviest sessions by cache-read tokens.
 * Ten is the leaderboard the user acts on; the query orders and caps, so the whole set never
 * crosses IPC (P-27/P-28).
 */
export const CONTEXT_OVERHEAD_LIMIT = 10;

/** The `ORDER BY` column for each §4.5 `SessionSort`. A closed map — never an interpolated value. */
const SORT_COLUMN: Readonly<Record<SessionSort, string>> = {
  firstTs: 'first_ts',
  activeSeconds: 'active_seconds',
  spanSeconds: 'span_seconds',
  outputTokens: 'tok_output',
  messages: 'messages',
  toolCalls: 'tool_calls',
};

interface SessionRecord {
  readonly id: string;
  readonly project_id: number;
  readonly display_name: string;
  readonly color_index: number;
  readonly primary_model: string | null;
  readonly first_ts: number;
  readonly last_ts: number;
  readonly span_seconds: number;
  readonly active_seconds: number | bigint | null;
  readonly messages: number | bigint | null;
  readonly tool_calls: number;
  readonly subagent_runs: number;
  readonly tok_input: number | bigint | null;
  readonly tok_output: number | bigint | null;
  readonly tok_cache_write: number | bigint | null;
  readonly tok_cache_write_1h: number | bigint | null;
  readonly tok_cache_read: number | bigint | null;
  readonly is_partial: number;
  readonly archive_id: number | null;
  readonly archive_root: string | null;
}

/**
 * The one per-session aggregate query. Bind order is textual:
 * `[…eventWhere, idleGapMs, …toolWhere]`.
 *
 * `scoped` is the filtered event set; every sub-aggregate reads from it, so a session appears
 * iff it has at least one event inside the `GlobalFilter` window, and every token number on its
 * row is over the same window. `active_seconds` is M-07 binding **(A)** —
 * `PARTITION BY session_id`, both origins, synthetic included (ADR-035) — computed on the same
 * restricted stream, which is what M-07's "filter boundaries" clause requires.
 *
 * ⚠️ **The gap CTE and the cap expression are IMPORTED from `active-time.ts`, not restated here**
 * (CLAUDE.md §1: every metric is defined once). They used to be hand-copied into this file, and
 * the two copies drifted: `ActiveTimeRepository` converts ms→s in JS with `Math.trunc`, while the
 * copy below divides in SQL. That is only equivalent while the sum is an INTEGER, which it stopped
 * being the moment the cap was bound as a REAL — see `CAPPED_GAP_MS`. The active time must be
 * computed *inside* this query rather than joined in from `bySession()`, because `SessionSort`
 * and the keyset cursor both order on `active_seconds` in SQL; sharing the expression is what
 * makes that safe.
 *
 * `active_seconds` is integer division of an INTEGER sum, matching `msToSeconds()` and M-09's
 * generated `span_seconds` exactly. `test/metrics/f14-subsecond-active-time.test.ts` pins it.
 *
 * `subagent_runs` is deliberately NOT windowed: §4.5 calls it the session's run count, and a run
 * is a property of the session (its transcript directory), not of a date range.
 *
 * ⚠️ **The `archives` join is `LEFT`, and it must stay `LEFT`** (§4.5 as amended (E9), §6.5
 * Degraded). `sessions.archive_id` is NULL for every live session (§3.4, ADR-033), so an inner
 * join would silently drop every un-archived session out of `q:sessions`: the table would shrink
 * to whatever had been archived, nothing would throw, and no visible number would be wrong. That
 * is CLAUDE.md §1's failure through a two-letter edit, so it is asserted with a live AND an
 * archived session present in `test/main/db/session-archive-provenance.test.ts` — with only one
 * kind in the database an inner join passes.
 */
function sessionAggregateSql(eventWhere: string, toolWhere: string): string {
  // ⚠️ ADR-042 — TWO scoped populations now. `scoped` is raw `events` and feeds ACTIVE TIME (M-07,
  // about timestamps, unchanged), the MESSAGE count (M-11, a per-line count, unchanged) and the
  // per-session model mix. `scoped_calls` is the deduped one-row-per-call population (`api_call_rows`)
  // and feeds the TOKEN sums only. ⚠️ Bind order gains a second copy of `eventWhere`'s params, right
  // after the first: [scoped-eventWhere, scoped_calls-eventWhere, idleGapMs, toolWhere]. Both callers
  // bind it. INV-02 is preserved: every line of a call shares one session, so the deduped per-session
  // sums still roll up to the deduped grand total.
  return `WITH ${API_CALL_ROWS_CTE},
${PROJECT_UNIT_CTE},
scoped AS (
  SELECT e.id, e.session_id, e.ts, e.role, e.model,
         e.is_synthetic, e.tok_input, e.tok_output, e.tok_cache_write,
         -- A-05: NULL = "the 1-hour split is not known for this row" (migration 0005). Read as 0,
         -- which is exactly what this row reported before A-05; the count is disclosed (§4.6).
         COALESCE(e.tok_cache_write_1h, 0) AS tok_cache_write_1h,
         e.tok_cache_read
  FROM   events e
  WHERE  1 = 1${eventWhere}
),
scoped_calls AS (
  SELECT e.session_id, e.is_synthetic,
         e.tok_input, e.tok_output, e.tok_cache_write,
         COALESCE(e.tok_cache_write_1h, 0) AS tok_cache_write_1h,
         e.tok_cache_read
  FROM   api_call_rows e
  WHERE  1 = 1${eventWhere}
),
${gappedCte(SESSION_PARTITION)},
active AS (
  SELECT session_id, COALESCE(SUM(${CAPPED_GAP_MS}), 0) / 1000 AS active_seconds
  FROM   gapped GROUP BY session_id
),
token_totals AS (
  SELECT session_id,
         COALESCE(SUM(CASE WHEN is_synthetic = 0 THEN tok_input       ELSE 0 END), 0) AS tok_input,
         COALESCE(SUM(CASE WHEN is_synthetic = 0 THEN tok_output      ELSE 0 END), 0) AS tok_output,
         COALESCE(SUM(CASE WHEN is_synthetic = 0 THEN tok_cache_write ELSE 0 END), 0) AS tok_cache_write,
         COALESCE(SUM(CASE WHEN is_synthetic = 0 THEN tok_cache_write_1h ELSE 0 END), 0) AS tok_cache_write_1h,
         COALESCE(SUM(CASE WHEN is_synthetic = 0 THEN tok_cache_read  ELSE 0 END), 0) AS tok_cache_read
  FROM   scoped_calls GROUP BY session_id
),
msg_totals AS (
  SELECT session_id,
         COALESCE(SUM(CASE WHEN is_synthetic = 0 AND role IN ('assistant','user')
                           THEN 1 ELSE 0 END), 0)                                     AS messages
  FROM   scoped GROUP BY session_id
),
tools AS (
  SELECT t.session_id AS session_id, COUNT(*) AS tool_calls
  FROM   tool_calls t WHERE 1 = 1${toolWhere} GROUP BY t.session_id
),
runs AS (
  SELECT sr.session_id AS session_id, COUNT(*) AS subagent_runs
  FROM   subagent_runs sr GROUP BY sr.session_id
),
models AS (
  SELECT session_id, model, COUNT(*) AS uses
  FROM   scoped WHERE is_synthetic = 0 AND model IS NOT NULL
  GROUP BY session_id, model
)
SELECT s.id            AS id,
       -- ADR-040 — the project UNIT. §6.5's table has a project column, and a grouped project is
       -- one project everywhere, including here.
       u.unit_id       AS project_id,
       u.unit_name     AS display_name,
       u.unit_color_index AS color_index,
       (SELECT m.model FROM models m WHERE m.session_id = s.id
         ORDER BY m.uses DESC, m.model ASC LIMIT 1)  AS primary_model,
       s.first_ts      AS first_ts,
       s.last_ts       AS last_ts,
       s.span_seconds  AS span_seconds,
       a.active_seconds                              AS active_seconds,
       mt.messages                                   AS messages,
       COALESCE(tl.tool_calls, 0)                    AS tool_calls,
       COALESCE(rn.subagent_runs, 0)                 AS subagent_runs,
       tk.tok_input, tk.tok_output, tk.tok_cache_write, tk.tok_cache_write_1h, tk.tok_cache_read,
       s.is_partial    AS is_partial,
       s.archive_id    AS archive_id,
       ar.archive_root AS archive_root
FROM   active a
JOIN   sessions s ON s.id = a.session_id
JOIN   projects p ON p.id = s.project_id
JOIN   project_unit u ON u.project_id = s.project_id
JOIN   token_totals tk ON tk.session_id = a.session_id
JOIN   msg_totals   mt ON mt.session_id = a.session_id
LEFT JOIN tools tl ON tl.session_id = a.session_id
LEFT JOIN runs  rn ON rn.session_id = a.session_id
LEFT JOIN archives ar ON ar.id = s.archive_id`;
}

export class SessionStatsRepository extends Repository {
  readonly #active: ActiveTimeRepository;
  readonly #cost: CostRepository;
  readonly #groups: ProjectGroupsRepository;

  constructor(db: SqliteDatabase) {
    super(db);
    this.#active = new ActiveTimeRepository(db);
    this.#cost = new CostRepository(db);
    this.#groups = new ProjectGroupsRepository(db);
  }

  /**
   * §4.5 `q:sessions` — one page, ordered, with the per-session `$` figure attached.
   *
   * Keyset paging, not offset paging: the cursor carries `(sortKey, id)` of the last row and the
   * next page resumes strictly past it, so a session ingested between two requests cannot shift
   * a boundary and hide a row. One extra row is fetched rather than a second `COUNT` being run,
   * because "is there a next page" must be a fact about the same snapshot the page came from.
   */
  sessionPage(
    context: QueryContext,
    page: Page,
    sort: SessionSort,
    dir: SortDirection,
  ): SessionPageResult {
    const limit = validateLimit(page);
    const eventScope = scopeClause(context.filter, 'e');
    const toolScope = scopeClause(context.filter, 't');
    const column = SORT_COLUMN[sort];
    const order = dir === 'asc' ? 'ASC' : 'DESC';
    const comparison = dir === 'asc' ? '>' : '<';

    // ⚠️ ADR-042 — `eventScope.params` is bound TWICE: once for `scoped` (raw events, active time
    // and messages) and once for `scoped_calls` (deduped, token sums). Order matches the CTE order
    // in `sessionAggregateSql`: [scoped, scoped_calls, idleGapMs, tools].
    const params: SqlParam[] = [
      ...eventScope.params,
      ...eventScope.params,
      context.idleGapMinutes * 60_000,
      ...toolScope.params,
    ];
    let where = '';
    if (page.cursor !== undefined) {
      const [key, id] = decodeCursor(page.cursor);
      where = `\nWHERE (${column}, id) ${comparison} (?, ?)`;
      params.push(key ?? 0, id ?? '');
    }
    params.push(limit + 1);

    const records = this.all<SessionRecord>(
      `SELECT * FROM (\n${sessionAggregateSql(eventScope.sql, toolScope.sql)}\n)${where}\n` +
        `ORDER BY ${column} ${order}, id ${order}\nLIMIT ?`,
      ...params,
    );

    const costs = this.#sessionCosts(context);
    const hasMore = records.length > limit;
    const rows = records.slice(0, limit).map((record) => toSessionRow(record, costs));
    const last = records[rows.length - 1];
    return {
      rows,
      nextCursor:
        hasMore && last !== undefined ? encodeCursor([sortKeyOf(last, sort), last.id]) : null,
      totalKnown: this.#sessionCount(context),
    };
  }

  /** §4.5 `q:sessionDetail` — one session, whole; the channel takes no `GlobalFilter`. */
  sessionRow(sessionId: string, idleGapMinutes: number): SessionAggregateRow | undefined {
    // ⚠️ ADR-042 — `e.session_id = ?` now appears twice in the SQL (scoped, then scoped_calls), so
    // `sessionId` is bound twice before the idle gap. See `sessionAggregateSql`'s bind-order note.
    const record = this.one<SessionRecord>(
      sessionAggregateSql('\n    AND e.session_id = ?', '\n    AND t.session_id = ?'),
      sessionId,
      sessionId,
      idleGapMinutes * 60_000,
      sessionId,
    );
    if (record === undefined) return undefined;
    const costs = this.#sessionCosts({
      filter: { projectIds: null, from: null, to: null },
      idleGapMinutes,
    });
    return toSessionRow(record, costs);
  }

  /** §4.5 `SessionDetail` — `gitBranch` / `cliVersion` (last non-null observed, §3.4). */
  identity(sessionId: string): SessionIdentityRow | undefined {
    const row = this.one<{
      readonly git_branch: string | null;
      readonly cli_version: string | null;
    }>('SELECT git_branch, cli_version FROM sessions WHERE id = ?', sessionId);
    if (row === undefined) return undefined;
    return { gitBranch: row.git_branch, cliVersion: row.cli_version };
  }

  /** M-17 restricted to one session — the drill-down's origin split. */
  originTokens(sessionId: string): { main: TokenBreakdown; subagent: TokenBreakdown } {
    const rows = this.all<{
      readonly origin: string;
      readonly tok_input: number | bigint | null;
      readonly tok_output: number | bigint | null;
      readonly tok_cache_write: number | bigint | null;
      readonly tok_cache_write_1h: number | bigint | null;
      readonly tok_cache_read: number | bigint | null;
    }>(
      // ⚠️ ADR-042 — token SUM per origin, so `api_call_rows` (one row per call). INV-02 holds:
      // a call's lines share one origin, so main + subagent equals the deduped session total.
      `WITH ${API_CALL_ROWS_CTE}
       SELECT e.origin AS origin,
              COALESCE(SUM(e.tok_input), 0)       AS tok_input,
              COALESCE(SUM(e.tok_output), 0)      AS tok_output,
              COALESCE(SUM(e.tok_cache_write), 0) AS tok_cache_write,
              COALESCE(SUM(COALESCE(e.tok_cache_write_1h, 0)), 0) AS tok_cache_write_1h,
              COALESCE(SUM(e.tok_cache_read), 0)  AS tok_cache_read
       FROM   api_call_rows e
       WHERE  e.is_synthetic = 0 AND e.session_id = ?
       GROUP BY e.origin`,
      sessionId,
    );
    const side = (origin: string): TokenBreakdown => {
      const row = rows.find((candidate) => candidate.origin === origin);
      return {
        input: sumToSafeNumber(row?.tok_input ?? null, 'tokens.input'),
        output: sumToSafeNumber(row?.tok_output ?? null, 'tokens.output'),
        cacheWrite: sumToSafeNumber(row?.tok_cache_write ?? null, 'tokens.cacheWrite'),
        cacheWrite1h: sumToSafeNumber(row?.tok_cache_write_1h ?? null, 'tokens.cacheWrite1h'),
        cacheRead: sumToSafeNumber(row?.tok_cache_read ?? null, 'tokens.cacheRead'),
      };
    };
    return { main: side('main'), subagent: side('subagent') };
  }

  /** The drill-down's tool histogram. */
  toolCountsFor(sessionId: string): { toolName: string; count: number }[] {
    return this.all<{ readonly tool_name: string; readonly count: number }>(
      `SELECT t.tool_name AS tool_name, COUNT(*) AS count
       FROM   tool_calls t WHERE t.session_id = ?
       GROUP BY t.tool_name ORDER BY count DESC, tool_name ASC`,
      sessionId,
    ).map((row) => ({ toolName: row.tool_name, count: row.count }));
  }

  /**
   * §4.5 `SessionDetail.subagentRuns` — with `linked` shown honestly (§3.7, §6.5).
   *
   * ⚠️ `linked: false` is a fact, not a failure. The run's events are attributed to the parent
   * session by the PATH (ADR-020), so every total already contains them; only the spawn point is
   * unknown. That is why the drill-down lists it and §6.6 says "totals are unaffected".
   */
  subagentRunsFor(sessionId: string): SubagentRunRow[] {
    return this.all<{
      readonly id: number;
      readonly subagent_type: string | null;
      readonly description: string | null;
      readonly first_ts: number;
      readonly last_ts: number;
      readonly linked: number;
      readonly tok_input: number | bigint | null;
      readonly tok_output: number | bigint | null;
      readonly tok_cache_write: number | bigint | null;
      readonly tok_cache_write_1h: number | bigint | null;
      readonly tok_cache_read: number | bigint | null;
    }>(
      // ⚠️ ADR-042 — per-run token SUMS, so the join is to `api_call_rows` (one row per call). The
      // representative row keeps `subagent_run_id`, so the linkage is unchanged; the per-run numbers
      // now sum to the deduped subagent-origin total, consistent with `originTokens`.
      `WITH ${API_CALL_ROWS_CTE}
       SELECT r.id AS id, r.subagent_type AS subagent_type, r.description AS description,
              r.first_ts AS first_ts, r.last_ts AS last_ts,
              CASE WHEN r.spawn_event_id IS NULL THEN 0 ELSE 1 END AS linked,
              COALESCE(SUM(CASE WHEN e.is_synthetic = 0 THEN e.tok_input       END), 0) AS tok_input,
              COALESCE(SUM(CASE WHEN e.is_synthetic = 0 THEN e.tok_output      END), 0) AS tok_output,
              COALESCE(SUM(CASE WHEN e.is_synthetic = 0 THEN e.tok_cache_write END), 0) AS tok_cache_write,
              COALESCE(SUM(CASE WHEN e.is_synthetic = 0 THEN COALESCE(e.tok_cache_write_1h, 0) END), 0) AS tok_cache_write_1h,
              COALESCE(SUM(CASE WHEN e.is_synthetic = 0 THEN e.tok_cache_read  END), 0) AS tok_cache_read
       FROM   subagent_runs r
       LEFT JOIN api_call_rows e ON e.subagent_run_id = r.id
       WHERE  r.session_id = ?
       GROUP BY r.id
       ORDER BY r.first_ts, r.id`,
      sessionId,
    ).map((row) => ({
      id: row.id,
      subagentType: row.subagent_type,
      description: row.description,
      firstTs: row.first_ts,
      lastTs: row.last_ts,
      linked: row.linked === 1,
      tokens: {
        input: sumToSafeNumber(row.tok_input, 'tokens.input'),
        output: sumToSafeNumber(row.tok_output, 'tokens.output'),
        cacheWrite: sumToSafeNumber(row.tok_cache_write, 'tokens.cacheWrite'),
        cacheWrite1h: sumToSafeNumber(row.tok_cache_write_1h, 'tokens.cacheWrite1h'),
        cacheRead: sumToSafeNumber(row.tok_cache_read, 'tokens.cacheRead'),
      },
    }));
  }

  /** §6.7 Execution Trace — the tool calls of one session, with their subagent attribution. */
  traceToolCalls(sessionId: string, limit: number): TraceToolRow[] {
    return this.all<{
      readonly tool_name: string;
      readonly ts: number;
      readonly subagent_run_id: number | null;
      readonly origin: string;
    }>(
      `SELECT t.tool_name AS tool_name, t.ts AS ts, e.subagent_run_id AS subagent_run_id,
              t.origin AS origin
       FROM   tool_calls t
       JOIN   events e ON e.id = t.event_id
       WHERE  t.session_id = ?
       ORDER BY t.ts, t.ordinal
       LIMIT  ?`,
      sessionId,
      limit,
    ).map((row) => ({
      toolName: row.tool_name,
      ts: row.ts,
      subagentRunId: row.subagent_run_id,
      origin: row.origin,
    }));
  }

  /**
   * §4.5 `q:workingDays` — M-07 binding **(B)** with the project's display columns joined on.
   *
   * Ordered by active time descending: §6.5 calls the card "Longest marathons" and subtitles it
   * "ranked by active time (idle gaps >Nm removed)". ⚠️ These rows are **working days**, not
   * sessions (M-10's deliberate asymmetry), and they are the summands of the Overview tile —
   * INV-21 asserts the tile equals their sum over *every* row this returns, across all pages.
   */
  workingDays(context: QueryContext): WorkingDayNamedRow[] {
    const names = this.#projectNames();
    return this.#active
      .byWorkingDay(context)
      .map((group) => ({
        day: group.day,
        projectId: group.projectId,
        displayName: names.get(group.projectId)?.displayName ?? '',
        colorIndex: names.get(group.projectId)?.colorIndex ?? 0,
        activeSeconds: group.activeSeconds,
        spanSeconds: group.spanSeconds,
        sessions: group.sessions,
      }))
      .sort(
        (left, right) =>
          right.activeSeconds - left.activeSeconds ||
          right.day.localeCompare(left.day) ||
          left.projectId - right.projectId,
      );
  }

  /**
   * §4.5 `q:sessionHistogram` — one bucket per session, by **active** time, M-07 binding (A).
   *
   * Buckets with a zero count ARE returned: the axis is a fixed, closed set (above), so a `0`
   * here is the measured fact "no session fell in this range", not a substituted value.
   */
  sessionHistogram(context: QueryContext): number[] {
    const counts = SESSION_HISTOGRAM_BUCKETS.map(() => 0);
    for (const row of this.#active.bySession(context)) {
      const index = SESSION_HISTOGRAM_BUCKETS.findIndex(
        (bucket) =>
          row.activeSeconds >= bucket.lowerSeconds &&
          (bucket.upperSeconds === null || row.activeSeconds < bucket.upperSeconds),
      );
      if (index >= 0) counts[index] = (counts[index] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * §6.4 (A-11, A-12) — the sessions the panel needs: the heaviest by cache-read tokens UNION the
   * most-recently-active, deduped. Ordered cache-read DESC in the result.
   *
   * ⚠️ **The union closes a §1 silent-omission gap.** A freshly-started LIVE session has little
   * cache-read, so a pure heaviest-N list would drop the very sessions the renderer wants to mark
   * "live" — they would never reach the payload. Adding the most-recent-N (by `MAX(ts)` =
   * `lastActivityTs`) guarantees a recently-active session is always present, whatever its weight.
   *
   * ⚠️ **"now" is NOT in the SQL.** The query stays deterministic: it returns each session's
   * `lastActivityTs`, and the RENDERER classifies live/recent against its own clock (`isLive` /
   * `isRecent`). The "recent" set here is by raw recency (`ORDER BY last_activity_ts DESC`), not by
   * a wall-clock window — so a re-run at a different instant returns the same rows.
   *
   * ⚠️ Population is M-01 (`is_synthetic = 0`): `tok_cache_read` is M-04's cache-read class and
   * `tok_output` is M-02, so the per-session numbers sum to the same two totals the panel's headline
   * shows. Both origins roll up (§2.1, ADR-020). `label` is the project UNIT display name (ADR-040),
   * never the numeric unit id or the encoded path (§1a). `startedAt` is `MIN(ts)` over the session's
   * in-scope events (ADR-021). All query-time only, never stored (ADR-027).
   */
  heaviestAndRecentSessions(context: QueryContext, limit: number): ContextOverhead['sessions'] {
    const scope = scopeClause(context.filter, 'e');
    const rows = this.all<{
      readonly key: string;
      readonly label: string;
      readonly started_at: number;
      readonly last_activity_ts: number;
      readonly subagent_turns: number;
      readonly cache_read_tokens: number | bigint | null;
      readonly output_tokens: number | bigint | null;
    }>(
      // ⚠️ ADR-042 — the TWO token sums (`output_tokens`, `cache_read_tokens`) come from the deduped
      // `api_call_rows` population; the MOMENTS (`MIN`/`MAX(ts)`) and the subagent-TURN count stay
      // over raw `events` (timestamps and a row count are per-line, unchanged). Bind order: the scope
      // params bind once for `scoped` and once for `scoped_calls`, then the two `LIMIT`s.
      `WITH ${API_CALL_ROWS_CTE},
       ${PROJECT_UNIT_CTE},
       scoped AS (
         SELECT e.session_id AS session_id, e.ts AS ts, e.role AS role, e.origin AS origin
         FROM   events e
         WHERE  e.is_synthetic = 0${scope.sql}
       ),
       scoped_calls AS (
         SELECT e.session_id AS session_id,
                e.tok_output AS tok_output, e.tok_cache_read AS tok_cache_read
         FROM   api_call_rows e
         WHERE  e.is_synthetic = 0${scope.sql}
       ),
       call_tokens AS (
         SELECT session_id,
                COALESCE(SUM(tok_output), 0)     AS output_tokens,
                COALESCE(SUM(tok_cache_read), 0) AS cache_read_tokens
         FROM   scoped_calls
         GROUP BY session_id
       ),
       per_session AS (
         SELECT sc.session_id                    AS session_id,
                MIN(sc.ts)                        AS started_at,
                -- A-12 — the session's last recorded activity, both origins. The renderer alone
                -- compares it to the wall clock for the presentational "live"/"recent" signal
                -- (written nowhere, fed to no metric, §1).
                MAX(sc.ts)                        AS last_activity_ts,
                COALESCE(ct.output_tokens, 0)     AS output_tokens,
                COALESCE(ct.cache_read_tokens, 0) AS cache_read_tokens,
                -- A-12 — assistant turns a subagent ran, EXCLUDED from the main-context trajectory
                -- below but disclosed honestly (§4.6). A subagent runs a separate context (ADR-020).
                -- A per-line turn COUNT, so it stays over raw events (ADR-042 leaves counts alone).
                COALESCE(SUM(CASE WHEN sc.origin = 'subagent' AND sc.role = 'assistant'
                                  THEN 1 ELSE 0 END), 0)              AS subagent_turns
         FROM   scoped sc
         LEFT   JOIN call_tokens ct ON ct.session_id = sc.session_id
         GROUP BY sc.session_id
       ),
       -- A-12 — the two capped sets, then their UNION. No "now" appears anywhere: "recent" is the
       -- most recently active by MAX(ts), a deterministic ordering, NOT a wall-clock window.
       heaviest AS (
         SELECT session_id FROM per_session ORDER BY cache_read_tokens DESC, session_id ASC LIMIT ?
       ),
       recent AS (
         SELECT session_id FROM per_session ORDER BY last_activity_ts DESC, session_id ASC LIMIT ?
       ),
       chosen AS (
         SELECT session_id FROM heaviest UNION SELECT session_id FROM recent
       )
       SELECT ps.session_id      AS key,
              -- ADR-040 — the project UNIT's display name (a group's name, or §3.3's folder name);
              -- never the numeric unit id or the encoded path (§1a).
              u.unit_name        AS label,
              ps.started_at      AS started_at,
              ps.last_activity_ts AS last_activity_ts,
              ps.subagent_turns  AS subagent_turns,
              ps.cache_read_tokens AS cache_read_tokens,
              ps.output_tokens   AS output_tokens
       FROM   per_session ps
       JOIN   chosen c        ON c.session_id = ps.session_id
       JOIN   sessions s      ON s.id = ps.session_id
       JOIN   project_unit u  ON u.project_id = s.project_id
       ORDER BY ps.cache_read_tokens DESC, ps.session_id ASC`,
      ...scope.params,
      ...scope.params,
      limit,
      limit,
    );

    // A-12 — the per-turn series for exactly the leaderboard sessions, one bounded second query
    // (the leaderboard is already capped at `limit`). Ordered by session then `ts` then `id`, so
    // each session's turns arrive in the exact order the conversation happened (a stable `id`
    // tiebreak keeps two same-millisecond turns deterministic).
    const turnsBySession = this.#trajectoryTurns(
      context,
      rows.map((row) => row.key),
    );

    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      startedAt: row.started_at,
      lastActivityTs: row.last_activity_ts,
      cacheReadTokens: sumToSafeNumber(row.cache_read_tokens, 'tokens.cacheRead'),
      outputTokens: sumToSafeNumber(row.output_tokens, 'tokens.output'),
      subagentTurns: row.subagent_turns,
      turns: turnsBySession.get(row.key) ?? [],
    }));
  }

  /**
   * A-12 — one main-conversation assistant turn per row, in conversation order, for the given
   * sessions. `context` is the tokens fed that turn
   * (`tok_input + tok_cache_read + tok_cache_write + tok_cache_write_1h`); `output` is `tok_output`.
   *
   * ⚠️ **Main only** (`origin = 'main'`): a subagent runs a separate context (ADR-020), so mixing
   * its turns into this stream would show a context that resets for a reason the user did not cause.
   * ⚠️ **No ratio, no baseline, no verdict here** — every one of those is derived in the renderer
   * from these raw pairs (ADR-027; A-11's "compute the ratio at the edge"). A `context = 0` turn is
   * returned as-is; the renderer skips it from the ratio rather than dividing (§1).
   */
  #trajectoryTurns(
    context: QueryContext,
    sessionIds: readonly string[],
  ): Map<string, { context: number; output: number }[]> {
    const bySession = new Map<string, { context: number; output: number }[]>();
    if (sessionIds.length === 0) return bySession;

    const scope = scopeClause(context.filter, 'e');
    const placeholders = sessionIds.map(() => '?').join(', ');
    const turns = this.all<{
      readonly session_id: string;
      readonly context: number | bigint | null;
      readonly output: number | bigint | null;
    }>(
      // ⚠️ ADR-042 — one row per TURN = one API call, so `api_call_rows` (the final line's
      // authoritative usage). This is the fix the "context size per turn" series most needed: a
      // streamed turn used to appear as several rows with partial-then-cumulative context; now each
      // turn is one point at its true context size. The final line carries role='assistant'.
      `WITH ${API_CALL_ROWS_CTE}
       SELECT e.session_id AS session_id,
              COALESCE(e.tok_input, 0) + COALESCE(e.tok_cache_read, 0)
                + COALESCE(e.tok_cache_write, 0) + COALESCE(e.tok_cache_write_1h, 0) AS context,
              COALESCE(e.tok_output, 0) AS output
       FROM   api_call_rows e
       WHERE  e.is_synthetic = 0 AND e.origin = 'main' AND e.role = 'assistant'
              AND e.session_id IN (${placeholders})${scope.sql}
       ORDER BY e.session_id, e.ts, e.id`,
      ...sessionIds,
      ...scope.params,
    );

    for (const turn of turns) {
      let list = bySession.get(turn.session_id);
      if (list === undefined) {
        list = [];
        bySession.set(turn.session_id, list);
      }
      list.push({
        context: sumToSafeNumber(turn.context, 'trajectory.context'),
        output: sumToSafeNumber(turn.output, 'trajectory.output'),
      });
    }
    return bySession;
  }

  #sessionCount(context: QueryContext): number {
    const scope = scopeClause(context.filter, 'e');
    const row = this.one<{ readonly count: number }>(
      `SELECT COUNT(DISTINCT e.session_id) AS count FROM events e WHERE 1 = 1${scope.sql}`,
      ...scope.params,
    );
    return row?.count ?? 0;
  }

  /** M-05 per session, from E5's grouped cost query — never a second costing path (A-10). */
  #sessionCosts(context: QueryContext): Map<string, number | null> {
    const map = new Map<string, number | null>();
    for (const group of this.#cost.totalsGroupedBy(context.filter, 'session')) {
      map.set(group.key, costToWire(group.costPicoUsd, group.costedEvents));
    }
    return map;
  }

  /**
   * ⚠️ Keyed by **project unit** id, not by `projects.id` (ADR-040): `byWorkingDay()` partitions
   * by the unit, so the leaderboard's rows are units and their names must come from the same
   * resolution. A group's name is the user's own words; a lone project's is §3.3's folder name.
   */
  #projectNames(): Map<number, { displayName: string; colorIndex: number }> {
    const map = new Map<number, { displayName: string; colorIndex: number }>();
    for (const [unitId, unit] of this.#groups.unitNames()) {
      map.set(unitId, { displayName: unit.displayName, colorIndex: unit.colorIndex });
    }
    return map;
  }
}

function sortKeyOf(record: SessionRecord, sort: SessionSort): number {
  switch (sort) {
    case 'firstTs':
      return record.first_ts;
    case 'activeSeconds':
      return sumToSafeNumber(record.active_seconds, 'activeSeconds');
    case 'spanSeconds':
      return record.span_seconds;
    case 'outputTokens':
      return sumToSafeNumber(record.tok_output, 'tokens.output');
    case 'messages':
      return sumToSafeNumber(record.messages, 'messages');
    case 'toolCalls':
      return record.tool_calls;
  }
}

/**
 * ⚠️ A hard, permanent property of M-07 binding **(A)**, asserted rather than trusted.
 *
 * Active time is `SUM(MIN(gap, cap))` over one session's own event stream, every term a gap
 * *between two of that session's events*, so it can never exceed the distance between the first
 * and the last of them — which is exactly M-09's `span_seconds`. The bound holds under a filter
 * too: a `GlobalFilter` only ever removes events, and `sessions.first_ts`/`last_ts` are
 * `MIN/MAX(events.ts)` over **all** origins (`ingest-repo.ts`), so the restricted stream is always
 * inside the stored span. Truncation cannot break it either: `active_ms <= span_ms` implies
 * `trunc(active_ms/1000) <= trunc(span_ms/1000)`.
 *
 * It is worth its cost because of what it catches and how precisely. The 2026-07-22 real-data
 * failure surfaced as INV-11 — a generic "too large to report" from an unrelated overflow guard,
 * naming a value that was not in fact large — which cost a full diagnosis to attribute. Any future
 * arithmetic error in the gap CTE (a lost `PARTITION BY`, a dropped cap, a unit mix) violates
 * *this* bound long before it violates INV-11's, and says so in the metric's own terms.
 */
function assertWithinSpan(activeSeconds: number, spanSeconds: number, sessionId: string): number {
  if (activeSeconds > spanSeconds) {
    throw new DbError(
      'E_INTERNAL',
      `Active time for session ${sessionId} came out as ${String(activeSeconds)}s, longer than ` +
        `the session itself (${String(spanSeconds)}s). M-07 binding (A) sums gaps between that ` +
        "session's own events, so it cannot exceed M-09's span; the figure is wrong and was " +
        'not reported.',
      { retryable: false },
    );
  }
  return activeSeconds;
}

function toSessionRow(
  record: SessionRecord,
  costs: Map<string, number | null>,
): SessionAggregateRow {
  return {
    id: record.id,
    projectId: record.project_id,
    displayName: record.display_name,
    colorIndex: record.color_index,
    primaryModel: record.primary_model,
    firstTs: record.first_ts,
    lastTs: record.last_ts,
    spanSeconds: record.span_seconds,
    activeSeconds: assertWithinSpan(
      sumToSafeNumber(record.active_seconds, 'activeSeconds'),
      record.span_seconds,
      record.id,
    ),
    messages: sumToSafeNumber(record.messages, 'messages'),
    toolCalls: record.tool_calls,
    subagentRuns: record.subagent_runs,
    tokens: {
      input: sumToSafeNumber(record.tok_input, 'tokens.input'),
      output: sumToSafeNumber(record.tok_output, 'tokens.output'),
      cacheWrite: sumToSafeNumber(record.tok_cache_write, 'tokens.cacheWrite'),
      cacheWrite1h: sumToSafeNumber(record.tok_cache_write_1h, 'tokens.cacheWrite1h'),
      cacheRead: sumToSafeNumber(record.tok_cache_read, 'tokens.cacheRead'),
    },
    // ⚠️ `?? null` is "this session had nothing priceable", which §6.4 renders as no `$` at all,
    // never as `$0.00`.
    costNanoUsd: costs.get(record.id) ?? null,
    isPartial: record.is_partial === 1,
    // §6.5 Degraded — provenance, never a metric. `null`/`null` is a live session; a non-null
    // pair is what lets the surface name where the transcripts went (§3.15, §9.3). Both are
    // read straight from the columns, never inferred from an `archives:list` date range.
    archiveId: record.archive_id,
    archiveRoot: record.archive_root,
  };
}
