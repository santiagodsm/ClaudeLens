// Tool aggregates — DESIGN §5.9 M-12, M-13, and §6.6's three cards.
//
// ⚠️ M-12: "`COUNT(*)` over `tool_calls` in scope. **Includes `Agent` and `Skill`.**" There is
// deliberately no exclusion list here. §2.1 calls `Agent` and `Skill` tools, and a "tool calls"
// figure that quietly drops the two most interesting ones is a wrong number that reads right.
//
// ⚠️ `tool_calls` carries its own `session_id`, `project_id`, `origin` and `ts` (§3.6), so every
// query below scopes on the tool-call row rather than joining back to `events` — one row, one
// scope test, no chance of the join dropping a call whose event fell outside a window boundary.

import { Repository } from './base';
import { PROJECT_UNIT_CTE } from './project-groups';
import { scopeClause, type QueryContext } from './scope';
import type { SqliteDatabase } from '../sqlite';

/** M-12 — the two numbers §6.6's subtitle needs. */
export interface ToolTotals {
  readonly total: number;
  readonly distinct: number;
}

export interface ToolCountRow {
  readonly toolName: string;
  readonly count: number;
}

export interface ProjectToolRow extends ToolCountRow {
  readonly projectId: number;
}

/** One edge of §6.7's Markov graph over consecutive tool calls within a session. */
export interface ToolTransitionRow {
  readonly from: string;
  readonly to: string;
  readonly count: number;
}

export class ToolStatsRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** M-12 — total calls and distinct tool names in scope. */
  totals(context: QueryContext): ToolTotals {
    const scope = scopeClause(context.filter, 't');
    const row = this.one<{ readonly total: number; readonly distinct_tools: number }>(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT t.tool_name) AS distinct_tools
       FROM   tool_calls t
       WHERE  1 = 1${scope.sql}`,
      ...scope.params,
    );
    return { total: row?.total ?? 0, distinct: row?.distinct_tools ?? 0 };
  }

  /** §6.6 tool fingerprint — one row per tool, busiest first. */
  byTool(context: QueryContext): ToolCountRow[] {
    const scope = scopeClause(context.filter, 't');
    return this.all<{ readonly tool_name: string; readonly count: number }>(
      `SELECT t.tool_name AS tool_name, COUNT(*) AS count
       FROM   tool_calls t
       WHERE  1 = 1${scope.sql}
       GROUP BY t.tool_name
       ORDER BY count DESC, tool_name ASC`,
      ...scope.params,
    ).map((row) => ({ toolName: row.tool_name, count: row.count }));
  }

  /**
   * §6.6 "Tool mix per project" — the top `topN` tools of each project.
   *
   * The rank is per project, so a project whose whole mix is one rarely-used tool still shows
   * that tool. `topN` bounds the payload (P-27) without dropping a project.
   */
  byProjectAndTool(context: QueryContext, topN: number): ProjectToolRow[] {
    const scope = scopeClause(context.filter, 't');
    const limit = Math.max(1, Math.trunc(topN));
    return this.all<{
      readonly project_id: number;
      readonly tool_name: string;
      readonly count: number;
    }>(
      // ADR-040 — ranked per **unit**, so a grouped project's mix is one ranking over both
      // folders rather than two rankings that each get their own `topN`.
      `WITH ${PROJECT_UNIT_CTE},
       ranked AS (
         SELECT u.unit_id AS project_id, t.tool_name AS tool_name, COUNT(*) AS count,
                ROW_NUMBER() OVER (PARTITION BY u.unit_id
                                   ORDER BY COUNT(*) DESC, t.tool_name ASC) AS rn
         FROM   tool_calls t
         JOIN   project_unit u ON u.project_id = t.project_id
         WHERE  1 = 1${scope.sql}
         GROUP BY u.unit_id, t.tool_name
       )
       SELECT project_id, tool_name, count FROM ranked WHERE rn <= ?
       ORDER BY project_id, count DESC, tool_name ASC`,
      ...scope.params,
      limit,
    ).map((row) => ({ projectId: row.project_id, toolName: row.tool_name, count: row.count }));
  }

  /**
   * §6.7 Tool Transition — consecutive tool calls **within a session**.
   *
   * "Consecutive" is `(ts, ordinal)` order inside one `session_id`; `ordinal` is the index of
   * the `tool_use` item within `message.content[]` (§3.6), so two tools in one assistant turn
   * are ordered by the model's own array order rather than by an equal timestamp. The window
   * never crosses a session boundary, which is what stops the last tool of Monday's session
   * appearing to hand off to the first tool of Tuesday's.
   */
  transitions(context: QueryContext): ToolTransitionRow[] {
    const scope = scopeClause(context.filter, 't');
    return this.all<{
      readonly from_tool: string;
      readonly to_tool: string;
      readonly count: number;
    }>(
      `WITH ordered AS (
         SELECT t.session_id AS session_id, t.tool_name AS tool_name,
                LAG(t.tool_name) OVER (PARTITION BY t.session_id ORDER BY t.ts, t.ordinal) AS prev
         FROM   tool_calls t
         WHERE  1 = 1${scope.sql}
       )
       SELECT prev AS from_tool, tool_name AS to_tool, COUNT(*) AS count
       FROM   ordered
       WHERE  prev IS NOT NULL
       GROUP BY prev, tool_name
       ORDER BY count DESC, from_tool ASC, to_tool ASC`,
      ...scope.params,
    ).map((row) => ({ from: row.from_tool, to: row.to_tool, count: row.count }));
  }

  /**
   * M-13 / M-14 — skill invocations and the runtime overlay.
   *
   * ⚠️ **INV-13: over the FULL dataset, never the global filter.** There is no scope parameter
   * and there must never be one: "a skill deleted because it looked unused this month is exactly
   * the irreversible mistake this rule prevents" (§6.9). The absence of a `GlobalFilter`
   * argument is the enforcement.
   */
  skillInvocationsAllTime(): { name: string; count: number; lastTs: number }[] {
    return this.all<{
      readonly skill_name: string;
      readonly count: number;
      readonly last_ts: number;
    }>(
      `SELECT t.skill_name AS skill_name, COUNT(*) AS count, MAX(t.ts) AS last_ts
       FROM   tool_calls t
       WHERE  t.tool_name = 'Skill' AND t.skill_name IS NOT NULL
       GROUP BY t.skill_name`,
    ).map((row) => ({ name: row.skill_name, count: row.count, lastTs: row.last_ts }));
  }

  /** M-14 — `observed` for a tool node, over the full dataset (INV-13). */
  toolInvocationsAllTime(): { name: string; count: number }[] {
    return this.all<{ readonly tool_name: string; readonly count: number }>(
      `SELECT t.tool_name AS tool_name, COUNT(*) AS count
       FROM   tool_calls t
       GROUP BY t.tool_name`,
    ).map((row) => ({ name: row.tool_name, count: row.count }));
  }

  /**
   * §3.7 / §4.6 — subagent runs with no resolvable spawn point.
   *
   * "Disclosed, never guessed at with a timestamp-proximity heuristic" (ADR-020). Scoped by the
   * run's project and its first event, so the disclosure matches the filter the user is looking
   * at. ⚠️ §3.7 also states that totals are genuinely unaffected by an unlinked run — the events
   * are attributed to the parent session by the path either way — and §6.6 says so on screen.
   */
  unlinkedSubagentRuns(context: QueryContext): number {
    const scope = scopeClause(context.filter, 'r', 'first_ts');
    const row = this.one<{ readonly count: number }>(
      `SELECT COUNT(*) AS count
       FROM   subagent_runs r
       WHERE  r.spawn_event_id IS NULL${scope.sql}`,
      ...scope.params,
    );
    return row?.count ?? 0;
  }
}
