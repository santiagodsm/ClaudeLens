// Project and file queries — DESIGN §4.5 `q:tokensByProject`, `q:projectCards`,
// `q:fileMetrics`; §5.9 M-02, M-05, M-07 binding (C), M-12, M-15.
//
// ⚠️ `ProjectCard.activeSeconds` is M-07 binding **(C)** restricted to one project: the sum of
// that project's M-08 working-day values over the filter. INV-21's second sentence — "Likewise
// `ProjectCard.activeSeconds` equals the sum over that project's rows" — is why it is summed
// from the SAME `byWorkingDay()` rows `q:workingDays` returns, and not recomputed with a
// project-shaped partition that would only accidentally agree.
//
// ⚠️ There is deliberately no `overlapSeconds` on this payload, and it is provable rather than
// assumed (INV-22(d), §6.8): binding (C) restricted to one project has exactly one partition per
// local day, and two distinct days' covered intervals cannot intersect, so M-20 is identically
// `0`. The disclosure would always read "0 hours". Do not "complete the pattern" later.
//
// ⚠️ M-15 is "**never called churn, never presented as lines changed**". `edits` is a count of
// write-class tool calls (ADR-028); no diff is read and none exists to read.

import { Repository, sumToSafeNumber } from './base';
import { ActiveTimeRepository } from './active-time';
import { costToWire, CostRepository } from './cost';
import { PROJECT_UNIT_CTE, ProjectGroupsRepository } from './project-groups';
import { scopeClause, type QueryContext } from './scope';
import type { SqlParam, SqliteDatabase } from '../sqlite';

/**
 * §4.5 `q:tokensByProject` row.
 *
 * ⚠️ `projectId` is a **project unit** id (ADR-040): the project's own id, or `-groupId` when the
 * user has said this folder is the same project as another. Every project-shaped payload in this
 * file uses the unit, because the user asked for the group to behave as one project everywhere.
 */
export interface ProjectTokenRow {
  readonly projectId: number;
  readonly displayName: string;
  readonly colorIndex: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number | null;
}

/** One folder inside a unit — the same shape whether the unit is a group or a lone project. */
export interface ProjectMemberRow {
  readonly projectId: number;
  readonly displayName: string;
  readonly encodedName: string;
  readonly colorIndex: number;
  readonly outputTokens: number;
  readonly sessions: number;
  readonly toolCalls: number;
  readonly activeSeconds: number;
}

/** §4.5 `ProjectCard`. */
export interface ProjectCardRow extends ProjectTokenRow {
  /** `null` for a group: a group is not a directory and has no encoded name of its own. */
  readonly encodedName: string | null;
  /** Non-null when the user grouped these folders (§3.19). */
  readonly groupId: number | null;
  /**
   * The folders inside this card, each with its OWN numbers. One entry for a lone project, N for
   * a group. ⚠️ §6.8: opening a group shows its member folders, "so nothing is hidden".
   */
  readonly members: ProjectMemberRow[];
  readonly sessions: number;
  readonly toolCalls: number;
  readonly activeSeconds: number;
  readonly editSparkline: number[];
}

/** §4.5 `FileMetricRow` (M-15). */
export interface FileMetricRecord {
  readonly path: string;
  readonly basename: string;
  readonly language: string | null;
  readonly edits: number;
  readonly lastTs: number;
}

/** §6.8 — the sparkline is a fixed twelve buckets, whatever the range. */
export const SPARKLINE_BUCKETS = 12;

export class ProjectStatsRepository extends Repository {
  readonly #active: ActiveTimeRepository;
  readonly #cost: CostRepository;
  readonly #groups: ProjectGroupsRepository;

  constructor(db: SqliteDatabase) {
    super(db);
    this.#active = new ActiveTimeRepository(db);
    this.#cost = new CostRepository(db);
    this.#groups = new ProjectGroupsRepository(db);
  }

  /** §4.5 `q:tokensByProject` — M-02 and M-05 per project (§6.4 treemap). */
  tokensByProject(context: QueryContext): ProjectTokenRow[] {
    const costs = this.#projectCosts(context);
    return this.#projectTokenRows(context).map((row) => ({
      ...row,
      costNanoUsd: costs.get(row.projectId) ?? null,
    }));
  }

  /**
   * §4.5 `q:projectCards` (§6.8).
   *
   * ⚠️ One card per **project unit** (ADR-040): a group renders as one card, and its member
   * folders travel with it in `members` so nothing is hidden. Every headline number on the card
   * is computed over the unit, never summed from the members — see `#memberRows`.
   */
  projectCards(context: QueryContext): ProjectCardRow[] {
    const costs = this.#projectCosts(context);
    const activity = this.#activeSecondsByUnit(context);
    const sessions = this.#countByUnit(context, 'e.session_id', 'events');
    const tools = this.#countByUnit(context, null, 'tool_calls');
    const sparklines = this.#editSparklines(context);
    const members = this.#memberRows(context);
    const names = this.#groups.unitNames();
    return this.#projectTokenRows(context).map((row) => ({
      ...row,
      encodedName: row.encodedName,
      groupId: names.get(row.projectId)?.groupId ?? null,
      members: members.get(row.projectId) ?? [],
      costNanoUsd: costs.get(row.projectId) ?? null,
      sessions: sessions.get(row.projectId) ?? 0,
      toolCalls: tools.get(row.projectId) ?? 0,
      activeSeconds: activity.get(row.projectId) ?? 0,
      editSparkline: sparklines.get(row.projectId) ?? new Array<number>(SPARKLINE_BUCKETS).fill(0),
    }));
  }

  /**
   * §4.5 `q:fileMetrics` — M-15, one row per distinct `path`.
   *
   * Ordered by edit count descending so the busiest file is on the first page; `path` breaks
   * ties so the order is total and the keyset cursor is well-defined.
   */
  fileMetrics(context: QueryContext, projectId?: number): FileMetricRecord[] {
    const scope = scopeClause(context.filter, 'f');
    const params = [...scope.params];
    let extra = '';
    if (projectId !== undefined) {
      // ⚠️ `projectId` is a **unit** id (ADR-040), so it is expanded to the folders it stands
      // for. An empty expansion selects NOTHING, never everything — §4.2's rule, restated in
      // `expandUnitIds`.
      const ids = this.#groups.expandUnitIds([projectId]);
      extra = `\n    AND f.project_id IN (${ids.map(() => '?').join(', ') || 'NULL'})`;
      params.push(...ids);
    }
    return this.all<{
      readonly path: string;
      readonly basename: string;
      readonly language: string | null;
      readonly edits: number;
      readonly last_ts: number;
    }>(
      `SELECT f.path AS path, f.basename AS basename, f.language AS language,
              COUNT(*) AS edits, MAX(f.ts) AS last_ts
       FROM   file_touches f
       WHERE  1 = 1${scope.sql}${extra}
       GROUP BY f.path
       ORDER BY edits DESC, path ASC`,
      ...params,
    ).map((row) => ({
      path: row.path,
      basename: row.basename,
      language: row.language,
      edits: row.edits,
      lastTs: row.last_ts,
    }));
  }

  /** M-15 — the language mix of the §6.8 file panel. `NULL` is surfaced as "other". */
  languageMix(
    context: QueryContext,
    projectId?: number,
  ): { language: string | null; edits: number }[] {
    const scope = scopeClause(context.filter, 'f');
    const params = [...scope.params];
    let extra = '';
    if (projectId !== undefined) {
      // ADR-040 — a unit id, expanded exactly as in `fileMetrics` above.
      const ids = this.#groups.expandUnitIds([projectId]);
      extra = `\n    AND f.project_id IN (${ids.map(() => '?').join(', ') || 'NULL'})`;
      params.push(...ids);
    }
    return this.all<{ readonly language: string | null; readonly edits: number }>(
      `SELECT f.language AS language, COUNT(*) AS edits
       FROM   file_touches f
       WHERE  1 = 1${scope.sql}${extra}
       GROUP BY f.language
       ORDER BY edits DESC`,
      ...params,
    );
  }

  /**
   * M-02 per **unit**, with the unit's display facts.
   *
   * ⚠️ `JOIN project_unit` replaces the old `JOIN projects p`, and it preserves exactly the same
   * rows: `project_unit` is built FROM `projects`, one row per project. The grouping only changes
   * which key the `GROUP BY` collapses onto.
   */
  #projectTokenRows(context: QueryContext): (ProjectTokenRow & { encodedName: string | null })[] {
    const scope = scopeClause(context.filter, 'e');
    return this.all<{
      readonly project_id: number;
      readonly display_name: string;
      readonly encoded_name: string | null;
      readonly color_index: number;
      readonly output_tokens: number | bigint | null;
    }>(
      `WITH ${PROJECT_UNIT_CTE}
       SELECT u.unit_id AS project_id, u.unit_name AS display_name,
              u.unit_encoded_name AS encoded_name, u.unit_color_index AS color_index,
              COALESCE(SUM(e.tok_output), 0) AS output_tokens
       FROM   events e
       JOIN   project_unit u ON u.project_id = e.project_id
       WHERE  e.is_synthetic = 0${scope.sql}
       GROUP BY u.unit_id
       ORDER BY output_tokens DESC, display_name ASC`,
      ...scope.params,
    ).map((row) => ({
      projectId: row.project_id,
      displayName: row.display_name,
      encodedName: row.encoded_name,
      colorIndex: row.color_index,
      outputTokens: sumToSafeNumber(row.output_tokens, 'outputTokens'),
      costNanoUsd: null,
    }));
  }

  /**
   * M-07 binding (C), per unit — the sum of that unit's M-08 groups (INV-21).
   *
   * ⚠️ `byWorkingDay()` already partitions by `(local day, unit)` (ADR-040), so this is a sum of
   * that unit's own groups and **not** an addition of two projects' finished results.
   */
  #activeSecondsByUnit(context: QueryContext): Map<number, number> {
    const totals = new Map<number, number>();
    for (const group of this.#active.byWorkingDay(context)) {
      totals.set(group.projectId, (totals.get(group.projectId) ?? 0) + group.activeSeconds);
    }
    return totals;
  }

  #projectCosts(context: QueryContext): Map<number, number | null> {
    const map = new Map<number, number | null>();
    for (const group of this.#cost.totalsGroupedBy(context.filter, 'project')) {
      map.set(Number.parseInt(group.key, 10), costToWire(group.costPicoUsd, group.costedEvents));
    }
    return map;
  }

  /**
   * A count per unit, over `events` (distinct sessions) or `tool_calls` (rows).
   *
   * Written once for both because the only difference is the table and the aggregate, and two
   * near-identical copies of a unit join is exactly how one of them ends up ungrouped.
   */
  #countByUnit(
    context: QueryContext,
    distinctColumn: string | null,
    table: 'events' | 'tool_calls',
  ): Map<number, number> {
    const alias = table === 'events' ? 'e' : 't';
    const scope = scopeClause(context.filter, alias);
    const aggregate = distinctColumn === null ? 'COUNT(*)' : `COUNT(DISTINCT ${distinctColumn})`;
    const map = new Map<number, number>();
    for (const row of this.all<{ readonly unit_id: number; readonly n: number }>(
      `WITH ${PROJECT_UNIT_CTE}
       SELECT u.unit_id AS unit_id, ${aggregate} AS n
       FROM   ${table} ${alias}
       JOIN   project_unit u ON u.project_id = ${alias}.project_id
       WHERE  1 = 1${scope.sql}
       GROUP BY u.unit_id`,
      ...scope.params,
    )) {
      map.set(row.unit_id, row.n);
    }
    return map;
  }

  /**
   * §6.8 — the folders inside each unit, each with its **own** numbers.
   *
   * ⚠️ Every figure here is computed per real `projects.id`, ignoring the grouping, because that
   * is what "its own numbers" means: what that folder shows when it stands alone. ⚠️ **The member
   * active times do not add up to the card's active time, and §6.8 says so on screen** — merging
   * two folders makes the gaps between them on a shared day intra-partition gaps, which are
   * capped and counted (ADR-040). Presenting them as summands would be a silently wrong number.
   */
  #memberRows(context: QueryContext): Map<number, ProjectMemberRow[]> {
    const scope = scopeClause(context.filter, 'e');
    const toolScope = scopeClause(context.filter, 't');
    const params: SqlParam[] = [...scope.params, ...toolScope.params];
    const rows = this.all<{
      readonly unit_id: number;
      readonly project_id: number;
      readonly display_name: string;
      readonly encoded_name: string;
      readonly color_index: number;
      readonly output_tokens: number | bigint | null;
      readonly sessions: number;
      readonly tool_calls: number;
    }>(
      `WITH ${PROJECT_UNIT_CTE},
       per_project AS (
         SELECT e.project_id AS project_id,
                COALESCE(SUM(CASE WHEN e.is_synthetic = 0 THEN e.tok_output ELSE 0 END), 0)
                  AS output_tokens,
                COUNT(DISTINCT e.session_id) AS sessions
         FROM   events e
         WHERE  1 = 1${scope.sql}
         GROUP BY e.project_id
       ),
       per_project_tools AS (
         SELECT t.project_id AS project_id, COUNT(*) AS tool_calls
         FROM   tool_calls t
         WHERE  1 = 1${toolScope.sql}
         GROUP BY t.project_id
       )
       SELECT u.unit_id AS unit_id, p.id AS project_id, p.display_name AS display_name,
              p.encoded_name AS encoded_name, p.color_index AS color_index,
              COALESCE(pp.output_tokens, 0) AS output_tokens,
              COALESCE(pp.sessions, 0)      AS sessions,
              COALESCE(pt.tool_calls, 0)    AS tool_calls
       FROM   projects p
       JOIN   project_unit u ON u.project_id = p.id
       LEFT   JOIN per_project pp ON pp.project_id = p.id
       LEFT   JOIN per_project_tools pt ON pt.project_id = p.id
       WHERE  pp.project_id IS NOT NULL OR pt.project_id IS NOT NULL
       ORDER BY u.unit_id, output_tokens DESC, p.encoded_name ASC`,
      ...params,
    );

    const activeByProject = new Map<number, number>();
    for (const group of this.#active.byWorkingDayUngrouped(context)) {
      activeByProject.set(
        group.projectId,
        (activeByProject.get(group.projectId) ?? 0) + group.activeSeconds,
      );
    }

    const map = new Map<number, ProjectMemberRow[]>();
    for (const row of rows) {
      const list = map.get(row.unit_id) ?? [];
      list.push({
        projectId: row.project_id,
        displayName: row.display_name,
        encodedName: row.encoded_name,
        colorIndex: row.color_index,
        outputTokens: sumToSafeNumber(row.output_tokens, 'member.outputTokens'),
        sessions: row.sessions,
        toolCalls: row.tool_calls,
        activeSeconds: activeByProject.get(row.project_id) ?? 0,
      });
      map.set(row.unit_id, list);
    }
    return map;
  }

  /**
   * §6.8 — "a files-touched sparkline (12 buckets of **edit counts**, M-15)".
   *
   * The range is the filter window when it is closed on both ends, and otherwise the observed
   * `[MIN(ts), MAX(ts)]` of the file touches in scope. ⚠️ It is never anchored to `Date.now()`:
   * nothing in this layer reads a clock, so the same database always produces the same sparkline
   * (CLAUDE.md §1). A project with no file touches gets no entry at all, which §6.8 renders as
   * "no file edits recorded in this range" rather than a flat line of zeroes.
   */
  #editSparklines(context: QueryContext): Map<number, number[]> {
    const scope = scopeClause(context.filter, 'f');
    const bounds = this.one<{ readonly lo: number | null; readonly hi: number | null }>(
      `SELECT MIN(f.ts) AS lo, MAX(f.ts) AS hi FROM file_touches f WHERE 1 = 1${scope.sql}`,
      ...scope.params,
    );
    const lo = context.filter.from ?? bounds?.lo ?? null;
    const hi = context.filter.to ?? bounds?.hi ?? null;
    const map = new Map<number, number[]>();
    if (lo === null || hi === null) return map;
    // A single instant is one bucket wide; `width` is never 0, so no touch can divide by zero.
    const width = Math.max(1, Math.ceil((hi - lo + 1) / SPARKLINE_BUCKETS));

    // ADR-040 — bucketed against the **unit**, so a group's sparkline is its folders' edits
    // merged into one series rather than two half-height ones.
    for (const row of this.all<{ readonly project_id: number; readonly ts: number }>(
      `WITH ${PROJECT_UNIT_CTE}
       SELECT u.unit_id AS project_id, f.ts AS ts
       FROM   file_touches f
       JOIN   project_unit u ON u.project_id = f.project_id
       WHERE  1 = 1${scope.sql}`,
      ...scope.params,
    )) {
      const bucket = Math.min(SPARKLINE_BUCKETS - 1, Math.floor((row.ts - lo) / width));
      const series = map.get(row.project_id) ?? new Array<number>(SPARKLINE_BUCKETS).fill(0);
      series[bucket] = (series[bucket] ?? 0) + 1;
      map.set(row.project_id, series);
    }
    return map;
  }
}
