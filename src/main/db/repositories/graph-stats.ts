// Graph queries — DESIGN §4.5 `q:harnessGraph`, `q:executionTrace`, `q:toolTransition`,
// `q:flowSankey`; §3.10's edge-derivation table; §5.9 M-13, M-14.
//
// ⚠️ **Parsed harness text is data, never instructions** (§3.10, STACK ADR-017). Everything here
// reads `harness_nodes` / `harness_edges` and counts; nothing interpolates a stored name into
// anything executable and nothing is sent anywhere (§7.5).
//
// ⚠️ INV-13 — `q:harnessGraph` takes no `GlobalFilter` and the runtime overlay is computed over
// the **full dataset**. §3.10 states this in the same words. The absence of a filter argument on
// these methods is the enforcement, not a comment.
//
// ⚠️ §5.9 M-14 keeps `designed` and `observed` as two fields: "`designed: false, observed > 0` is
// a legal and interesting state". Nothing here collapses them.

import { API_CALL_ROWS_CTE } from './api-call-usage';
import { Repository, sumToSafeNumber } from './base';
import { PROJECT_UNIT_CTE } from './project-groups';
import { scopeClause, type QueryContext } from './scope';
import type { SqliteDatabase } from '../sqlite';
// §3.9's ONE definition of "first 280 characters of `display`" (E3). Imported rather than
// restated so the ingest cap and the query cap cannot drift apart (the A-10 lesson).
import { PROMPT_PREVIEW_CHARS } from '../../parse/parse-line';

/**
 * The `harness_nodes.kind` values this file interpolates into SQL (ADR-039).
 *
 * ⚠️ A closed union, not `string`: `#resolveNodeId` puts the value straight into a query, and this
 * is what makes that safe by construction rather than by review. Nothing scanned from a file, and
 * no value from the database, can reach it — every user-originated string in these queries is a
 * bound parameter or a joined column (§3.10, STACK ADR-017).
 */
type HarnessNodeKindLiteral = 'agent' | 'skill' | 'tool';

/** One `harness_nodes` row, in the shape §4.5 `GraphNode` needs. */
export interface HarnessNodeRow {
  readonly id: number;
  readonly kind: string;
  readonly name: string;
  readonly role: string | null;
  readonly sizeBytes: number;
  readonly relPath: string | null;
  readonly enabled: boolean | null;
  readonly pluginId: number | null;
  readonly mtimeMs: number | null;
  readonly description: string | null;
  /**
   * §3.10 `harness_nodes.source` — `user` · `plugin` · `builtin` · `transcript`.
   * ⚠️ AMENDED 2026-07-22 (E12): selected because §6.7's inspector needs to say *where a node
   * came from* — "installed by a plugin" and "you wrote this" are different answers to the same
   * question, and the Harness Map is the view where the difference decides whether a user
   * deletes something. It reaches the renderer as `GraphNode.meta.source`.
   */
  readonly source: string;
  /**
   * ADR-039 — the project this node was declared in, `null` for everything scanned from the
   * Claude data directory itself. It reaches the renderer as `GraphNode.meta.project` so §6.7's
   * inspector can say *which* project's harness a node belongs to, which is the whole point of
   * reading them: a Map that merges four projects' orchestrators without saying so is worse than
   * an empty one.
   */
  readonly projectId: number | null;
  /** §3.3 `projects.display_name` — cosmetic, for the inspector only. Never an identity. */
  readonly projectName: string | null;
  /**
   * Migration 0010 — §6.7 / §1a. The plugin's own declared version, on plugin/marketplace nodes
   * only. `harnessGraph()` reads it (directly for a plugin node, via `pluginId` for the skills it
   * contains) to qualify a Harness Map label that would otherwise collide with a sibling of the
   * same name. `null` for every non-plugin node. Never rendered except as a plain `(0.5.0)`.
   */
  readonly version: string | null;
}

/** One `harness_edges` row plus its M-14 runtime overlay. */
export interface HarnessEdgeRow {
  readonly id: number;
  readonly fromId: number;
  readonly toId: number;
  readonly kind: string;
  readonly evidence: 'frontmatter' | 'body_mention' | 'directory';
  readonly observed: number;
}

/**
 * One edge the transcripts show but `harness_edges` does not declare — M-14's
 * `designed: false, observed > 0`.
 *
 * ⚠️ §4.5 calls this "a legal and interesting state" and §6.7 requires the Harness Map to
 * render it ("highlighted where `!designed && observed > 0`"). It has no row of its own
 * anywhere: it is computed at query time and never stored (ADR-027).
 */
export interface ObservedEdgeRow {
  readonly fromId: number;
  readonly toId: number;
  readonly kind: string;
  readonly observed: number;
}

/** §6.7 Flow Sankey — one `project → model` or `model → tool` band. */
export interface SankeyLinkRow {
  readonly source: string;
  readonly target: string;
  readonly value: number;
}

export class GraphStatsRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** ⛔ INV-13 — every harness node, all time. */
  nodes(): HarnessNodeRow[] {
    return this.all<{
      readonly id: number;
      readonly kind: string;
      readonly name: string;
      readonly role: string | null;
      readonly size_bytes: number;
      readonly rel_path: string | null;
      readonly enabled: number | null;
      readonly plugin_id: number | null;
      readonly mtime_ms: number | null;
      readonly description: string | null;
      readonly source: string;
      readonly project_id: number | null;
      readonly project_name: string | null;
      readonly version: string | null;
    }>(
      `SELECT n.id AS id, n.kind AS kind, n.name AS name, n.role AS role,
              n.size_bytes AS size_bytes, n.rel_path AS rel_path, n.enabled AS enabled,
              n.plugin_id AS plugin_id, n.mtime_ms AS mtime_ms, n.description AS description,
              n.source AS source, n.project_id AS project_id, n.version AS version,
              p.display_name AS project_name
       FROM   harness_nodes n
       LEFT JOIN projects p ON p.id = n.project_id
       ORDER BY n.kind, n.name`,
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      role: row.role,
      sizeBytes: row.size_bytes,
      relPath: row.rel_path,
      enabled: row.enabled === null ? null : row.enabled === 1,
      pluginId: row.plugin_id,
      mtimeMs: row.mtime_ms,
      description: row.description,
      source: row.source,
      projectId: row.project_id,
      projectName: row.project_name,
      version: row.version,
    }));
  }

  /**
   * §3.9 / §6.7 — the **only** prompt text this application ever puts on the wire.
   *
   * ⚠️ AMENDED 2026-07-22 (E12). §3.9 and §6.7 both state that the graph inspector is the one
   * place a prompt preview (≤280 chars) may appear, and `NodeInspector` implements the cap — but
   * no §4.5 payload carried the text, so the feature was unreachable in the running app. This is
   * the query that closes it, and it is deliberately the narrowest one that can: **one** prompt,
   * the session's first, by `(ts, line_no)`.
   *
   * ⚠️⚠️ **The 280-character cap is applied HERE, in SQL, not in the component.** §1.6 non-goal 1
   * says this is not a transcript reader and §3.9 says `pastedContents` is never stored in any
   * form; a cap enforced only at the render surface would still let oversized text cross IPC,
   * sit in the renderer's memory and reach a future consumer. `substr` on a column that §3.9's
   * DDL already caps is redundant *today* — and that is the point: it stops being redundant the
   * moment anyone widens the column, changes the parser, or backfills the table by hand, and it
   * costs one SQL function call. `NodeInspector`'s own `slice` remains as an independent second
   * guard at the only surface that renders it.
   *
   * ⚠️ `substr` counts UTF-16-independent *characters* in SQLite, which is the same unit
   * `String.prototype.length`-based §3.9 truncation uses for the BMP. Both ends therefore agree
   * on what "280 characters" means for every prompt this app has ever seen.
   *
   * Returns `undefined` when the session has no prompt — never an empty string, which
   * `NodeInspector` would render as an empty quote block implying an empty prompt.
   */
  sessionPromptPreview(sessionId: string): string | undefined {
    const row = this.one<{ readonly preview: string | null }>(
      `SELECT substr(p.display_preview, 1, ?) AS preview
       FROM   prompts p
       WHERE  p.session_id = ? AND p.display_preview IS NOT NULL AND p.display_preview <> ''
       ORDER BY p.ts, p.line_no
       LIMIT  1`,
      PROMPT_PREVIEW_CHARS,
      sessionId,
    );
    if (row === undefined || row.preview === null || row.preview === '') return undefined;
    return row.preview;
  }

  /**
   * ⛔ INV-13 — every harness edge with M-14's `observed` overlay, all time.
   *
   * ⚠️ M-14 says only "`observed` = count of matching tool calls over the full dataset" and
   * §3.10 says the join is `harness_nodes(kind='skill').name → tool_calls.skill_name` and
   * `harness_nodes(kind='tool').name → tool_calls.tool_name`. Neither says which END of the edge
   * is matched. It is read as the **target**: an edge is a claim that its source reaches its
   * target, so the runtime evidence for that claim is how often the target actually ran. Reported
   * as an under-specification rather than settled silently; edges whose target is neither a skill
   * nor a tool node have no runtime signal at all and get `observed = 0`, never a guess.
   */
  edges(): HarnessEdgeRow[] {
    return this.all<{
      readonly id: number;
      readonly from_id: number;
      readonly to_id: number;
      readonly kind: string;
      readonly evidence: string;
      readonly observed: number;
    }>(
      `SELECT he.id AS id, he.from_id AS from_id, he.to_id AS to_id, he.kind AS kind,
              he.evidence AS evidence,
              COALESCE((
                SELECT COUNT(*) FROM tool_calls tc
                WHERE (target.kind = 'skill' AND tc.tool_name = 'Skill' AND tc.skill_name = target.name)
                   OR (target.kind = 'tool'  AND tc.tool_name = target.name)
              ), 0) AS observed
       FROM   harness_edges he
       JOIN   harness_nodes target ON target.id = he.to_id
       ORDER BY he.id`,
    ).map((row) => ({
      id: row.id,
      fromId: row.from_id,
      toId: row.to_id,
      kind: row.kind,
      evidence: row.evidence as HarnessEdgeRow['evidence'],
      observed: row.observed,
    }));
  }

  /**
   * ⛔ INV-13 — the **undeclared** half of M-14's overlay, all time (E11).
   *
   * ⚠️ **Why this method has to exist.** Every row of `harness_edges` is by construction a
   * declared edge, so an implementation that reads only that table can never produce
   * `designed: false` — and §6.7 requires the Harness Map to render exactly that state
   * ("highlighted where `!designed && observed > 0`") and its legend to distinguish
   * designed-only, observed-only and both. A legend entry that can never fire is a promise the
   * view does not keep, so the undeclared half is derived here.
   *
   * ⚠️ **The derivation is exact, and deliberately narrow** (§3.10 — "edge derivation is exact
   * and testable, no natural-language inference"). One rule, and only one: a tool call made
   * **inside a subagent run whose `subagent_type` is known** is an edge from the `agent` node of
   * that name to what the call reached — the invoked `skill` node when `tool_name = 'Skill'`,
   * otherwise the `tool` node of that name. It is the only agent→X relation the schema records
   * exactly: `events.subagent_run_id` links the call to the run, and §3.7 fills
   * `subagent_runs.subagent_type` from the spawning `Agent` tool call, when linked.
   *
   * ⚠️ **An unlinked run contributes nothing.** `subagent_type` is `NULL` there, the join drops
   * it, and no edge is invented — ADR-020 forbids guessing a spawn point, and guessing which
   * agent ran would be the same mistake one table over. Those runs are disclosed as a count
   * (§4.6), never drawn.
   *
   * ⚠️ **Main-loop tool calls produce no edge at all**, and that is not an oversight: nothing in
   * §3.6 records which skill was active when a main-loop tool ran, so attributing one would be
   * an invented number (CLAUDE.md §1). The Harness Map shows those calls on the *node* overlay
   * (`metrics.observed`), which is a measured fact, and draws no edge nothing supports.
   *
   * ⚠️⚠️ **AMENDED 2026-07-22 (ADR-039) — a call resolves to ONE node, not to every node sharing
   * its name.** E11 joined by name alone and said so: "two nodes of one kind sharing a name
   * therefore both match". That was a tolerable ambiguity when every node came from one directory.
   * The moment project harnesses arrived it stopped being tolerable — running this against a real
   * machine drew `story-reviewer → Bash` **three times, each reading 7,631**, once for the
   * plugin-level definition and once for each of two projects that declare the same agent. A
   * viewer who adds up what the picture shows gets 22,893 calls that never happened, which is
   * precisely the silently-wrong number CLAUDE.md §1 rates as the worst possible outcome.
   *
   * `#resolveNodeId` is the fix and it needs no new fact: `tool_calls.project_id` is a recorded
   * column and so is `harness_nodes.project_id`. See it for the rule.
   */
  observedRuntimeEdges(): ObservedEdgeRow[] {
    return [
      ...this.#observedAgentCalls(),
      ...this.#observedAgentSpawns(),
      ...this.#observedMainLoopSpawns(),
    ];
  }

  /**
   * ADR-039 — the **one** node a tool call resolves to, for a given node kind and name.
   *
   * ```
   *   the lowest-id node of that kind and name declared BY THE CALL'S OWN PROJECT,
   *   or, when that project declares none, the lowest-id node of that kind and name
   *   that belongs to no project at all.
   * ```
   *
   * ⚠️ **Project-scoped wins, and that is not a preference — it is what actually ran.** A skill or
   * agent defined in `<project>/.claude/` is the definition in force for work done in that
   * project. Attributing that project's calls to a same-named definition from somewhere else would
   * be the wrong node; attributing them to *both* would be the wrong number.
   *
   * ⚠️ **`MIN(id)` breaks the remaining tie deterministically, and the tie is pre-existing.** Two
   * unscoped nodes can still share a name — two installed plugins each shipping `code-reviewer`,
   * say — and the transcripts contain no plugin→call link that could tell them apart. One is
   * chosen rather than both, so the edge weight stays a count of calls that happened. The other
   * node keeps its declared edges and an `observed` of 0, which is the honest reading: nothing
   * in the data attributes a call to it. Deterministic, so the Map does not reshuffle between
   * scans.
   *
   * ⚠️ Returns `NULL` when no node of that kind and name exists at all; every rule below groups on
   * the result and drops the `NULL` rows, so nothing is invented for a name the graph does not
   * carry.
   *
   * `nameExpr` is a SQL expression **from this file only** — never a value, never anything derived
   * from a scanned file. Every user-originated string in these queries is a bound parameter or a
   * joined column (§3.10, STACK ADR-017).
   *
   * ⚠️ **It resolves against `tc`, which every caller aggregates FIRST.** Each rule below groups
   * its tool calls into a `calls` CTE aliased `tc` before this runs, so the two index seeks happen
   * once per distinct `(project, name)` pair — a few hundred — rather than once per tool call.
   * Running it row-by-row over 87,000 calls put `q:harnessGraph` at 530 ms against real data,
   * which breaks **P-11** (any `q:*` round trip ≤ 250 ms p95). `idx_harness_nodes_lookup`
   * (migration 0004) is the index both seeks use.
   */
  static #resolveNodeId(kind: HarnessNodeKindLiteral, nameExpr: string): string {
    return `COALESCE(
      (SELECT MIN(pn.id) FROM harness_nodes pn
        WHERE pn.kind = '${kind}' AND pn.name = ${nameExpr} AND pn.project_id = tc.project_id),
      (SELECT MIN(gn.id) FROM harness_nodes gn
        WHERE gn.kind = '${kind}' AND gn.name = ${nameExpr} AND gn.project_id IS NULL))`;
  }

  /** The agent name of the run a tool call happened inside — §3.7 first, the sidecar second. */
  static readonly #RUN_AGENT_NAME = 'COALESCE(r.subagent_type, ra.agent_type)';

  /**
   * ADR-039 — how a run's agent type is named, as one SQL fragment used by all three rules.
   *
   * ⚠️ `COALESCE(r.subagent_type, ra.agent_type)`. §3.7's spawn linkage — resolve the run's
   * earliest event's `parent_uuid` against `events.uuid` — is the *first* source and stays first,
   * because it is the one DESIGN specifies. It resolves for **none** of the 2514 runs on the
   * user's machine, which left M-14's observed half permanently empty. The second source is the
   * `agent-*.meta.json` sidecar beside every run transcript, read by the harness scan into
   * `harness_run_agents` (migration 0004). Neither is inferred: both are recorded values.
   *
   * The order matters and is not arbitrary — when §3.7's linkage starts resolving, its value wins
   * and the sidecar becomes redundant rather than a competing second answer.
   */
  static readonly #RUN_AGENT_JOIN = `
       JOIN   subagent_runs r ON r.id = e.subagent_run_id
       LEFT JOIN file_manifest fm     ON fm.id = r.transcript_file_id
       LEFT JOIN harness_run_agents ra ON ra.transcript_rel_path = fm.rel_path`;

  /**
   * ADR-039 rule O-1 (E11's original rule, with the run-agent join widened).
   *
   * A tool call made **inside a subagent run whose agent type is known** is an edge from that
   * `agent` node to what the call reached — the invoked `skill` node when `tool_name = 'Skill'`,
   * otherwise the `tool` node of that name.
   *
   * ⚠️ **`Agent` calls that name a `subagent_type` are excluded here** and handled by O-2 instead.
   * Counting them twice — once as "this agent used the `Agent` tool" and once as "this agent
   * spawned that agent" — would draw the same fact as two edges and turn the `Agent` tool node
   * into a hub every orchestrator points at, which says nothing. An `Agent` call with no
   * `subagent_type` still lands here, because the tool ran and the callee is genuinely unknown.
   *
   * ⚠️ **An unlinked run contributes nothing.** Both name sources are NULL there, the filter drops
   * it, and no edge is invented — ADR-020 forbids guessing a spawn point. Those runs are disclosed
   * as a count (§4.6), never drawn.
   */
  #observedAgentCalls(): ObservedEdgeRow[] {
    // `tc.agent_name` is the CTE's already-coalesced column, not the raw expression: the joins it
    // comes from are only in scope inside the CTE.
    const agent = GraphStatsRepository.#resolveNodeId('agent', 'tc.agent_name');
    // A `Skill` call reaches the invoked SKILL; anything else reaches the TOOL of its own name.
    const target = `CASE WHEN tc.tool_name = 'Skill'
                        THEN ${GraphStatsRepository.#resolveNodeId('skill', 'tc.skill_name')}
                        ELSE ${GraphStatsRepository.#resolveNodeId('tool', 'tc.tool_name')} END`;
    return this.#observedEdgeRows(
      // `edge_kind`, not `kind`: `harness_nodes.kind` is in scope in the subqueries, and SQLite
      // resolves a bare `kind` in GROUP BY against a column before an output alias.
      `WITH calls AS (
         SELECT c.project_id AS project_id,
                ${GraphStatsRepository.#RUN_AGENT_NAME} AS agent_name,
                c.tool_name AS tool_name, c.skill_name AS skill_name,
                COUNT(*) AS n
         FROM   tool_calls c
         JOIN   events e ON e.id = c.event_id${GraphStatsRepository.#RUN_AGENT_JOIN}
         WHERE  ${GraphStatsRepository.#RUN_AGENT_NAME} IS NOT NULL
           AND  NOT (c.tool_name = 'Agent' AND c.subagent_type IS NOT NULL)
         GROUP BY 1, 2, 3, 4
       )
       SELECT ${agent} AS from_id, ${target} AS to_id,
              CASE WHEN tc.tool_name = 'Skill' THEN 'handoff' ELSE 'tool_grant' END AS edge_kind,
              SUM(tc.n) AS observed
       FROM   calls tc
       GROUP BY from_id, to_id, edge_kind
       HAVING from_id IS NOT NULL AND to_id IS NOT NULL
       ORDER BY from_id, to_id, edge_kind`,
    );
  }

  /**
   * ADR-039 rule O-2 — **"…calls subagents, agents…"**, the hop the user asked for by name.
   *
   * An `Agent` tool call carrying a `subagent_type` (§3.6), made inside a run whose own agent type
   * is known, is a `handoff` edge from the calling agent to the called one. Both ends are recorded
   * columns; nothing is matched by proximity, ordering or prose.
   */
  #observedAgentSpawns(): ObservedEdgeRow[] {
    const caller = GraphStatsRepository.#resolveNodeId('agent', 'tc.agent_name');
    const callee = GraphStatsRepository.#resolveNodeId('agent', 'tc.subagent_type');
    return this.#observedEdgeRows(
      `WITH calls AS (
         SELECT c.project_id AS project_id,
                ${GraphStatsRepository.#RUN_AGENT_NAME} AS agent_name,
                c.subagent_type AS subagent_type, COUNT(*) AS n
         FROM   tool_calls c
         JOIN   events e ON e.id = c.event_id${GraphStatsRepository.#RUN_AGENT_JOIN}
         WHERE  c.tool_name = 'Agent' AND c.subagent_type IS NOT NULL
           AND  ${GraphStatsRepository.#RUN_AGENT_NAME} IS NOT NULL
         GROUP BY 1, 2, 3
       )
       SELECT ${caller} AS from_id, ${callee} AS to_id,
              'handoff' AS edge_kind, SUM(tc.n) AS observed
       FROM   calls tc
       GROUP BY from_id, to_id
       HAVING from_id IS NOT NULL AND to_id IS NOT NULL
       ORDER BY from_id, to_id`,
    );
  }

  /**
   * ADR-039 rule O-3 — the orchestrator hop, and ⚠️ **the one semantic assumption in this file.**
   *
   * A **main-loop** `Agent` tool call naming a `subagent_type` is drawn as a `handoff` from the
   * `CLAUDE.md` node **of that call's own project** to the spawned `agent` node.
   *
   * ⚠️ **What is exact, and what is assumed.** Exact: `tool_calls.project_id` and the project a
   * `claude_md` node was scanned from are the same recorded column, so the two are joined, never
   * matched by name or by guess; `origin = 'main'` is a stored column; `subagent_type` is a stored
   * column. Assumed: that a project's own `CLAUDE.md` is the thing that dispatched from the main
   * loop. That is a claim about meaning, not about data, and it is stated here rather than left
   * implicit. E11 declined to draw main-loop edges at all, on the grounds that §3.6 records no
   * skill for a main-loop tool call — which remains true and is why no main-loop *tool* edge is
   * drawn. What ADR-039 adds is narrower: only `Agent` calls, only to the project's own root
   * `CLAUDE.md`, only where such a node was scanned.
   *
   * ⚠️ The node must be **project-scoped** (`project_id IS NOT NULL`) and named exactly
   * `CLAUDE.md`. A user-level `CLAUDE.md` applies to every project and would make one node the
   * source of every spawn in the dataset; `CLAUDE.local.md` is a second file in the same directory
   * and would double every edge. Neither is drawn.
   */
  #observedMainLoopSpawns(): ObservedEdgeRow[] {
    const callee = GraphStatsRepository.#resolveNodeId('agent', 'tc.subagent_type');
    return this.#observedEdgeRows(
      // The orchestrator is joined directly rather than through `#resolveNodeId`: it must be the
      // call's OWN project's node and there is deliberately no unscoped fallback (a user-level
      // `CLAUDE.md` would become the source of every spawn in the dataset).
      `WITH calls AS (
         SELECT c.project_id AS project_id, c.subagent_type AS subagent_type, COUNT(*) AS n
         FROM   tool_calls c
         WHERE  c.tool_name = 'Agent' AND c.origin = 'main' AND c.subagent_type IS NOT NULL
         GROUP BY project_id, subagent_type
       )
       SELECT orchestrator.id AS from_id, ${callee} AS to_id,
              'handoff' AS edge_kind, SUM(tc.n) AS observed
       FROM   calls tc
       JOIN   harness_nodes orchestrator
              ON orchestrator.kind = 'claude_md'
             AND orchestrator.name = 'CLAUDE.md'
             AND orchestrator.project_id = tc.project_id
       GROUP BY from_id, to_id
       HAVING to_id IS NOT NULL
       ORDER BY from_id, to_id`,
    );
  }

  /** The one row-shape every observed-edge rule returns. */
  #observedEdgeRows(sql: string): ObservedEdgeRow[] {
    return this.all<{
      readonly from_id: number;
      readonly to_id: number;
      readonly edge_kind: string;
      readonly observed: number;
    }>(sql).map((row) => ({
      fromId: row.from_id,
      toId: row.to_id,
      kind: row.edge_kind,
      observed: row.observed,
    }));
  }

  /**
   * ADR-039 — §5.9 M-14's node overlay for an **agent** node: how often that agent actually ran.
   *
   * ⚠️ §2.1 "Agent definition" defines an agent definition as "a `.claude/agents/*.md` file, **or
   * a `subagent_type` value observed in an `Agent` tool call**", so the join it needs is the one
   * the glossary already names. Before ADR-039 every agent node reported `observed: 0`, which read
   * as "this agent never ran" on a Map where several of them ran hundreds of times.
   *
   * The count is of **spawns** — `Agent` tool calls naming the agent — not of the calls the agent
   * then made. Those are the agent's outgoing edges, and folding them into the node's own number
   * would silently turn a node overlay into an edge overlay.
   *
   * ⚠️ Keyed by **node id**, not by name, through the same `#resolveNodeId` rule the edges use.
   * A name map would put the whole dataset's spawn count on every node sharing that name, so
   * three definitions of `story-implementer` would each read 692 and the Map would claim 2,076
   * spawns of something that ran 692 times.
   *
   * ⛔ INV-13 — all time; the method takes no scope.
   */
  agentSpawnCounts(): { nodeId: number; count: number }[] {
    const agent = GraphStatsRepository.#resolveNodeId('agent', 'tc.subagent_type');
    return this.all<{ readonly node_id: number; readonly n: number }>(
      `WITH calls AS (
         SELECT c.project_id AS project_id, c.subagent_type AS subagent_type, COUNT(*) AS n
         FROM   tool_calls c
         WHERE  c.tool_name = 'Agent' AND c.subagent_type IS NOT NULL AND c.subagent_type <> ''
         GROUP BY project_id, subagent_type
       )
       SELECT ${agent} AS node_id, SUM(tc.n) AS n
       FROM   calls tc
       GROUP BY node_id
       HAVING node_id IS NOT NULL
       ORDER BY node_id`,
    ).map((row) => ({ nodeId: row.node_id, count: row.n }));
  }

  /**
   * ADR-039 — §5.9 M-13/M-14's node overlay for a **skill** node, keyed by node id.
   *
   * ⚠️ Same reason as `agentSpawnCounts()`: two projects may each declare `polish`, and a
   * name-keyed count would show each of them the sum of both. The `q:skills` table (§4.5) still
   * counts by name and is right to — it lists what is *installed under the Claude data directory*
   * and excludes project nodes entirely, so no name is duplicated in it.
   *
   * ⛔ INV-13 — all time; the method takes no scope.
   */
  skillInvocationCounts(): { nodeId: number; count: number }[] {
    const skill = GraphStatsRepository.#resolveNodeId('skill', 'tc.skill_name');
    return this.all<{ readonly node_id: number; readonly n: number }>(
      `WITH calls AS (
         SELECT c.project_id AS project_id, c.skill_name AS skill_name, COUNT(*) AS n
         FROM   tool_calls c
         WHERE  c.tool_name = 'Skill' AND c.skill_name IS NOT NULL AND c.skill_name <> ''
         GROUP BY project_id, skill_name
       )
       SELECT ${skill} AS node_id, SUM(tc.n) AS n
       FROM   calls tc
       GROUP BY node_id
       HAVING node_id IS NOT NULL
       ORDER BY node_id`,
    ).map((row) => ({ nodeId: row.node_id, count: row.n }));
  }

  /**
   * §6.7 Flow Sankey — `project → model → skill/tool`, banded by output tokens.
   *
   * ⚠️ §6.7 says "band width ∝ output tokens" but tool calls carry no tokens of their own
   * (§3.6), so the second stage needs an attribution rule that §4.5 does not state. The rule
   * here is the only one that **conserves**: an assistant event's output tokens are attributed to
   * the tool of its FIRST `tool_use` item (`ordinal = 0`, §5.4 rule 9), and to the explicit
   * `(no tool)` target when the event called none. Every event's tokens therefore appear exactly
   * once in each stage, so the two stages sum to the same total — which is what makes it a
   * Sankey rather than two unrelated bar charts. Splitting an event's tokens across its tool
   * calls was rejected: an apportioned token count is an invented number.
   * Reported as an under-specification rather than settled silently.
   */
  sankeyLinks(context: QueryContext): SankeyLinkRow[] {
    const scope = scopeClause(context.filter, 'e');
    const stageOne = this.all<{
      readonly source: string;
      readonly target: string;
      readonly value: number | bigint;
    }>(
      // ADR-040 — the first stage's node is the project **unit**, so a grouped project is one
      // band in the Sankey rather than two. ⚠️ The node label is the unit's DISPLAY name
      // (`unit_name` = group name, or the project's folder basename per §3.3) — never
      // `unit_encoded_name`, which is the raw `projects/<encoded-path>` key and embeds the
      // user's absolute home path and username (§7.8 / P-33). Two ungrouped projects that share a
      // display name merge into one band here, which is acceptable and consistent with §3.3
      // treating the display name as cosmetic; leaking the path is not.
      // ⚠️ ADR-042 — the flow value is a token SUM, so it reads `api_call_rows` (one row per call).
      `WITH ${API_CALL_ROWS_CTE},
       ${PROJECT_UNIT_CTE}
       SELECT 'project:' || u.unit_name AS source,
              'model:' || e.model AS target,
              COALESCE(SUM(e.tok_output), 0) AS value
       FROM   api_call_rows e
       JOIN   project_unit u ON u.project_id = e.project_id
       WHERE  e.is_synthetic = 0 AND e.model IS NOT NULL AND e.tok_output > 0${scope.sql}
       GROUP BY source, target`,
      ...scope.params,
    );
    const stageTwo = this.all<{
      readonly source: string;
      readonly target: string;
      readonly value: number | bigint;
    }>(
      // ⚠️ ADR-042 — token SUM, so `api_call_rows`. The tool lookup keys on the representative
      // (final-line) `e.id`, which is the same event the deduped usage is attributed to.
      `WITH ${API_CALL_ROWS_CTE}
       SELECT 'model:' || e.model AS source,
              'tool:' || COALESCE((SELECT tc.tool_name FROM tool_calls tc
                                    WHERE tc.event_id = e.id ORDER BY tc.ordinal LIMIT 1),
                                  '(no tool)') AS target,
              COALESCE(SUM(e.tok_output), 0) AS value
       FROM   api_call_rows e
       WHERE  e.is_synthetic = 0 AND e.model IS NOT NULL AND e.tok_output > 0${scope.sql}
       GROUP BY source, target`,
      ...scope.params,
    );
    return [...stageOne, ...stageTwo].map((row) => ({
      source: row.source,
      target: row.target,
      value: sumToSafeNumber(row.value, 'sankey.value'),
    }));
  }
}
