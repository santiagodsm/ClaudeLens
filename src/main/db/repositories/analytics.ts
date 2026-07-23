// The §4.5 / §4.6 analytics façade — one method per `q:*` channel, each returning the exact
// response type from `src/shared/ipc-contract.ts`.
//
// ⚠️ The contract types are IMPORTED, never restated. E1 owns §4 and `typecheck` is the IPC-drift
// gate (§12.1 item 6); a payload shape re-declared here would be a second contract that compiles
// green while disagreeing with the renderer.
//
// ⚠️ ADR-027 — every number below is a `SELECT` computed on request. There is no rollup table, no
// stored total, no cached aggregate anywhere in this epic.
//
// ⚠️ INV-10 — every payload carrying a `$` figure carries its `UncostedSummary`, filled from the
// same `costed` flag that produced the money (E5's `cost.ts`). ⚠️ INV-23 — every payload carrying
// a multi-session M-07 binding-(C) figure carries its `overlapSeconds` (M-20). Both are filled,
// never left at zero.

import { ActiveTimeRepository } from './active-time';
import { CostRepository, costToWire, nullWhenUnpriced, type CostScope } from './cost';
import { EventStatsRepository } from './event-stats';
import { GraphStatsRepository } from './graph-stats';
import { HarnessManagerRepository } from './harness-manager';
import { ProjectGroupsRepository } from './project-groups';
import { ProjectStatsRepository } from './project-stats';
import { SESSION_HISTOGRAM_BUCKETS, SessionStatsRepository } from './session-stats';
import { ToolStatsRepository } from './tool-stats';
import { pageFrom, type QueryContext } from './scope';
import { picoToNanoUsd, assertSafeAggregate } from '../../../shared/money';
import { colorIndexFor } from '../../../shared/color-index';
import type { SqliteDatabase } from '../sqlite';
import type {
  ActivityCalendar,
  CacheEfficiency,
  ClaudeMdFiles,
  CostBreakdown,
  CostBreakdownBy,
  DataCoverage,
  Disclosures,
  ExecutionTrace,
  FileMetricRow,
  FlowSankey,
  Graph,
  GraphEdge,
  GraphNode,
  Memories,
  ModelTimeline,
  OriginSplit,
  OverviewTiles,
  Page,
  Paged,
  PluginsAndMarketplaces,
  ProjectCards,
  ProjectGroups,
  RhythmHeatmap,
  SessionDetail,
  SessionHistogram,
  SessionSort,
  SessionsPage,
  SkillRow,
  SkillSort,
  SortDirection,
  TimelineBucket,
  TokensByModelMode,
  TokensByProject,
  ToolFingerprint,
  ToolMixByProject,
  TraceSpan,
  UncostedSummary,
  WorkingDayRow,
} from '../../../shared/ipc-contract';

/**
 * Facts this layer cannot read from the database, supplied by the caller.
 *
 * ⚠️ `filesMissingSinceLastSync` (§4.6) has **no persisted source**: §5.3 deletes a `MISSING`
 * file's manifest row, and §3.17's `meta` key set is closed and does not include the count. The
 * sync cycle has it (`CycleSummary.filesMissing`), so E6 passes it in. Defaulting to `0` is
 * honest before the first sync of a process — nothing has gone missing since a sync that has not
 * happened — and is reported rather than papered over.
 */
export interface DisclosureInputs {
  readonly filesMissingSinceLastSync?: number;
  /** INV-14 — the rel_path prefix nothing may be reported from. */
  readonly backupRootPrefix?: string;
}

/** §6.7 — "capped at 500 rendered nodes with an explicit 'showing top 500' label". */
export const GRAPH_NODE_CAP = 500;

export class AnalyticsRepository {
  readonly #active: ActiveTimeRepository;
  readonly #cost: CostRepository;
  readonly #events: EventStatsRepository;
  readonly #graphs: GraphStatsRepository;
  readonly #harness: HarnessManagerRepository;
  readonly #groups: ProjectGroupsRepository;
  readonly #projects: ProjectStatsRepository;
  readonly #sessions: SessionStatsRepository;
  readonly #tools: ToolStatsRepository;

  constructor(db: SqliteDatabase) {
    this.#active = new ActiveTimeRepository(db);
    this.#cost = new CostRepository(db);
    this.#events = new EventStatsRepository(db);
    this.#graphs = new GraphStatsRepository(db);
    this.#harness = new HarnessManagerRepository(db);
    this.#groups = new ProjectGroupsRepository(db);
    this.#projects = new ProjectStatsRepository(db);
    this.#sessions = new SessionStatsRepository(db);
    this.#tools = new ToolStatsRepository(db);
  }

  // -------------------------------------------------------------------------------------
  // §6.3 Overview
  // -------------------------------------------------------------------------------------

  /**
   * `q:overviewTiles` — M-02, M-05, **M-07 binding (C)**, M-12, plus the two disclosures.
   *
   * ⚠️ `activeSeconds` is the sum of M-08 working-day values over the filter (ADR-036), taken
   * from the same `byWorkingDay()` rows `q:workingDays` returns, so INV-21 holds by construction
   * rather than by coincidence. ⚠️ `overlapSeconds` is M-20 and is its mandatory companion
   * (INV-23); it is computed, not left at zero, and it is `0` only when nothing double-counts.
   */
  overviewTiles(context: QueryContext): OverviewTiles {
    const tokens = this.#events.tokenTotals(context);
    const counts = this.#events.counts(context);
    const tools = this.#tools.totals(context);
    const overlap = this.#active.overlap(context);
    const cost = this.#costSummary(context.filter);
    return {
      outputTokens: tokens.output,
      costNanoUsd: cost.costNanoUsd,
      activeSeconds: overlap.activeSeconds,
      toolCalls: tools.total,
      sessions: counts.sessions,
      cacheReadTokens: tokens.cacheRead,
      distinctTools: tools.distinct,
      uncosted: cost.uncosted,
      overlapSeconds: overlap.overlapSeconds,
    };
  }

  /** `q:activityCalendar` (§6.3). */
  activityCalendar(context: QueryContext, weeks: number): ActivityCalendar {
    return { days: this.#events.activityCalendar(context, weeks) };
  }

  /** `q:modelMixTimeline` (§6.3, §6.4). */
  modelMixTimeline(context: QueryContext, bucket: TimelineBucket): ModelTimeline {
    return toTimeline(this.#events.modelMixTimeline(context, bucket));
  }

  // -------------------------------------------------------------------------------------
  // §6.4 Tokens & Cost
  // -------------------------------------------------------------------------------------

  /** `q:tokensByModel` (§6.4). */
  tokensByModel(
    context: QueryContext,
    bucket: TimelineBucket,
    mode: TokensByModelMode,
  ): ModelTimeline {
    return toTimeline(this.#events.tokensByModel(context, bucket, mode));
  }

  /** `q:tokensByProject` (§6.4 treemap) — carries `uncosted` (INV-10, A-01). */
  tokensByProject(context: QueryContext): TokensByProject {
    return {
      rows: this.#projects.tokensByProject(context),
      uncosted: this.#uncostedSummary(context.filter),
    };
  }

  /** `q:cacheEfficiency` (§6.4 gauge) — M-18. */
  cacheEfficiency(context: QueryContext): CacheEfficiency {
    const tokens = this.#events.tokenTotals(context);
    const denominator = tokens.cacheRead + tokens.input;
    return {
      cacheReadTokens: tokens.cacheRead,
      inputTokens: tokens.input,
      // A-05 — the gauge's caption talks about cache WRITES as a whole, so both classes count.
      cacheWriteTokens: tokens.cacheWrite + tokens.cacheWrite1h,
      outputTokens: tokens.output,
      // M-18: "`0` when the denominator is 0" — stated, so it is not a substituted value.
      hitRatio: denominator === 0 ? 0 : tokens.cacheRead / denominator,
    };
  }

  /** `q:costBreakdown` (§6.4) — grouped M-05 with its M-06 disclosure (INV-10). */
  costBreakdown(context: QueryContext, by: CostBreakdownBy): CostBreakdown {
    const rows = this.#cost.totalsGroupedBy(context.filter, by).map((group) => ({
      key: group.key,
      costNanoUsd: assertSafeAggregate(picoToNanoUsd(group.costPicoUsd), 'costNanoUsd'),
      tokensByClass: {
        input: group.tokInput,
        output: group.tokOutput,
        cacheWrite: group.tokCacheWrite,
        cacheWrite1h: group.tokCacheWrite1h,
        cacheRead: group.tokCacheRead,
      },
    }));
    return { rows, uncosted: this.#uncostedSummary(context.filter) };
  }

  /** `q:originSplit` (§6.4, §6.6) — M-17, with the unlinked-run disclosure (§3.7). */
  originSplit(context: QueryContext): OriginSplit {
    const split = this.#events.originSplit(context);
    const shape = (side: (typeof split)['main']): OriginSplit['main'] => ({
      input: side.input,
      output: side.output,
      cacheWrite: side.cacheWrite,
      cacheWrite1h: side.cacheWrite1h,
      cacheRead: side.cacheRead,
      messages: side.messages,
      toolCalls: side.toolCalls,
    });
    return {
      main: shape(split.main),
      subagent: shape(split.subagent),
      unlinkedRuns: this.#tools.unlinkedSubagentRuns(context),
    };
  }

  // -------------------------------------------------------------------------------------
  // §6.5 Sessions & Time
  // -------------------------------------------------------------------------------------

  /** `q:sessionHistogram` (§6.5) — by active time, M-07 binding (A). */
  sessionHistogram(context: QueryContext): SessionHistogram {
    const counts = this.#sessions.sessionHistogram(context);
    return {
      buckets: SESSION_HISTOGRAM_BUCKETS.map((bucket, index) => ({
        label: bucket.label,
        lowerSeconds: bucket.lowerSeconds,
        upperSeconds: bucket.upperSeconds,
        count: counts[index] ?? 0,
      })),
    };
  }

  /** `q:rhythmHeatmap` (§6.5). */
  rhythmHeatmap(context: QueryContext): RhythmHeatmap {
    return { cells: this.#events.rhythmHeatmap(context) };
  }

  /** `q:workingDays` (§6.5 marathons) — M-07 binding (B); the summands of the tile (INV-21). */
  workingDays(context: QueryContext, page: Page): Paged<WorkingDayRow> {
    const rows = this.#sessions.workingDays(context);
    return pageFrom<WorkingDayRow>(rows, page, (row) => [row.day, row.projectId]);
  }

  /**
   * `q:sessions` (§6.5).
   *
   * ⚠️ No `overlapSeconds`, and that is not an omission: `SessionRow.activeSeconds` is M-07
   * binding **(A)** — one session — and INV-23 binds only multi-session binding-(C) figures.
   * `uncosted` IS present, because the rows carry `costNanoUsd` (INV-10, A-01).
   */
  sessions(context: QueryContext, page: Page, sort: SessionSort, dir: SortDirection): SessionsPage {
    const result = this.#sessions.sessionPage(context, page, sort, dir);
    return {
      page: {
        rows: result.rows,
        nextCursor: result.nextCursor,
        totalKnown: result.totalKnown,
      },
      uncosted: this.#uncostedSummary(context.filter),
    };
  }

  /** `q:sessionDetail` (§6.5 drill-down) — one session, whole; no `GlobalFilter` (§4.5). */
  sessionDetail(sessionId: string, idleGapMinutes: number): SessionDetail | undefined {
    const row = this.#sessions.sessionRow(sessionId, idleGapMinutes);
    const identity = this.#sessions.identity(sessionId);
    if (row === undefined || identity === undefined) return undefined;
    // ⚠️ The disclosure is for THIS session's `$` (INV-10), so it is computed over exactly the
    // rows the money was: one `CostScope` restricted to this session, through E5's queries.
    return {
      ...row,
      gitBranch: identity.gitBranch,
      cliVersion: identity.cliVersion,
      originSplit: this.#sessions.originTokens(sessionId),
      toolCounts: this.#sessions.toolCountsFor(sessionId),
      subagentRuns: this.#sessions.subagentRunsFor(sessionId),
      uncosted: this.#uncostedSummary({
        projectIds: null,
        from: null,
        to: null,
        sessionIds: [sessionId],
      }),
    };
  }

  // -------------------------------------------------------------------------------------
  // §6.6 Tools & Agents
  // -------------------------------------------------------------------------------------

  /** `q:toolFingerprint` (§6.6) — M-12, `Agent` and `Skill` included. */
  toolFingerprint(context: QueryContext): ToolFingerprint {
    const totals = this.#tools.totals(context);
    return {
      total: totals.total,
      distinct: totals.distinct,
      rows: this.#tools.byTool(context).map((row) => ({
        toolName: row.toolName,
        count: row.count,
        colorIndex: colorIndexFor(row.toolName),
      })),
    };
  }

  /** `q:toolMixByProject` (§6.6). */
  toolMixByProject(context: QueryContext, topN: number): ToolMixByProject {
    const cards = this.#projects.projectCards(context);
    const names = new Map(cards.map((card) => [card.projectId, card.displayName]));
    const byProject = new Map<number, { toolName: string; count: number; colorIndex: number }[]>();
    for (const row of this.#tools.byProjectAndTool(context, topN)) {
      const parts = byProject.get(row.projectId) ?? [];
      parts.push({
        toolName: row.toolName,
        count: row.count,
        colorIndex: colorIndexFor(row.toolName),
      });
      byProject.set(row.projectId, parts);
    }
    return {
      projects: [...byProject.entries()].map(([projectId, parts]) => ({
        projectId,
        displayName: names.get(projectId) ?? '',
        parts,
      })),
    };
  }

  // -------------------------------------------------------------------------------------
  // §6.8 Projects & Code
  // -------------------------------------------------------------------------------------

  /**
   * `q:projectCards` (§6.8) — carries `uncosted` (INV-10, A-01) and deliberately **no**
   * `overlapSeconds` (INV-22(d): M-20 is identically `0` for a single-project scope).
   */
  projectCards(context: QueryContext): ProjectCards {
    return {
      rows: this.#projects.projectCards(context),
      uncosted: this.#uncostedSummary(context.filter),
    };
  }

  /**
   * `groups:list` (§6.10, ADR-040) — the groups the user has made.
   *
   * ⚠️ Read-only here; the three mutating channels go through `DatasetService` so that a change
   * can announce itself (`evt:dataChanged`) and every open view re-queries. ⚠️ There is no
   * "suggest a grouping" method on this façade and there must never be one (§2.1, zero inference).
   */
  projectGroups(): ProjectGroups {
    return { rows: this.#groups.list() };
  }

  /** `q:fileMetrics` (§6.8) — M-15. Never "churn", never "lines changed". */
  fileMetrics(context: QueryContext, page: Page, projectId?: number): Paged<FileMetricRow> {
    const rows = this.#projects.fileMetrics(context, projectId);
    return pageFrom<FileMetricRow>(rows, page, (row) => [row.path]);
  }

  // -------------------------------------------------------------------------------------
  // §6.7 Graphs
  // -------------------------------------------------------------------------------------

  /** `q:harnessGraph` ⛔ — designed structure plus M-14's runtime overlay, all time (INV-13). */
  harnessGraph(): Graph {
    const nodes = this.#graphs.nodes();
    const toolCalls = new Map(
      this.#tools.toolInvocationsAllTime().map((row) => [row.name, row.count]),
    );
    // ⚠️ ADR-039 — agent nodes had no runtime join and therefore reported `observed: 0`, which on
    // a Map reads as "this agent never ran" for agents that ran hundreds of times. §2.1 "Agent
    // definition" already names the join: an agent definition is a file "**or** a `subagent_type`
    // value observed in an `Agent` tool call". The number is SPAWNS of that agent, not the calls
    // it then made — those are its outgoing edges (§5.9 M-14).
    //
    // ⚠️⚠️ Agent and skill counts arrive keyed by **node id**, not by name. Once project harnesses
    // exist, several nodes can share a name — two projects declaring `story-implementer`, plus a
    // plugin's copy — and a name map would put the whole dataset's count on every one of them, so
    // a Map showing three nodes at 692 would read as 2,076 runs of something that ran 692 times.
    // `GraphStatsRepository.#resolveNodeId` states the rule that picks the one node a call
    // belongs to. Tool nodes stay keyed by name: ADR-039 leaves them unscoped by construction
    // (`Read` is the same `Read` in every project), so a tool name names one node.
    const spawns = new Map(this.#graphs.agentSpawnCounts().map((row) => [row.nodeId, row.count]));
    const invocations = new Map(
      this.#graphs.skillInvocationCounts().map((row) => [row.nodeId, row.count]),
    );
    const graphNodes: GraphNode[] = nodes.map((node) => {
      const observed =
        node.kind === 'skill'
          ? (invocations.get(node.id) ?? 0)
          : node.kind === 'tool'
            ? (toolCalls.get(node.name) ?? 0)
            : node.kind === 'agent'
              ? (spawns.get(node.id) ?? 0)
              : 0;
      // ⚠️ AMENDED 2026-07-22 (E12) — `meta`, §4.5. `description`, `rel_path` and `source` are
      // all columns of §3.10's `harness_nodes` and all three are what §6.7's inspector
      // "key/value rows" are for; `GraphNode` carried only numbers, so all three were dropped
      // on the floor between a complete table and a view that needed them.
      // ⚠️ A key whose value is absent is OMITTED, never emitted as `''` — an empty string in a
      // key/value row reads as "this node has no description", which is a different claim from
      // "the column is NULL" (CLAUDE.md §1).
      const meta: Record<string, string> = {};
      if (node.description !== null && node.description !== '') meta.description = node.description;
      if (node.relPath !== null && node.relPath !== '') meta.relPath = node.relPath;
      meta.source = node.source;
      // ⚠️ ADR-039 — which project's harness this node belongs to, and therefore that its
      // `relPath` is relative to THAT project rather than to the Claude data directory. Omitted
      // (never `''`) for a node scanned from the Claude data directory itself: an empty value in
      // a key/value row reads as "no project", which is a different claim from "not applicable".
      if (node.projectId !== null) {
        meta.project = node.projectName ?? String(node.projectId);
        // The Harness Manager cannot act on these, and the inspector says so rather than
        // offering a button that ACT-01…07 would refuse (§5.7 — the catalogue is closed and
        // operates only within the Claude data directory).
        meta.scope = 'project (read-only)';
      }
      const graphNode: GraphNode = {
        id: `n${String(node.id)}`,
        kind: node.kind,
        label: node.name,
        colorIndex: colorIndexFor(node.name),
        metrics: { sizeBytes: node.sizeBytes, observed },
        meta,
      };
      return node.role === null ? graphNode : { ...graphNode, role: node.role };
    });
    // The declared half: every row of `harness_edges` IS a declaration (§3.10), so `designed` is
    // true for all of them, and `observed` is M-14's runtime overlay for the edge's target.
    const graphEdges: GraphEdge[] = this.#graphs.edges().map((edge) => ({
      id: `e${String(edge.id)}`,
      source: `n${String(edge.fromId)}`,
      target: `n${String(edge.toId)}`,
      kind: edge.kind,
      evidence: edge.evidence,
      designed: true,
      observed: edge.observed,
    }));

    // ⚠️ The undeclared half — M-14's `designed: false, observed > 0` (E11). §6.7 requires the
    // Harness Map to render it and its legend to distinguish designed-only, observed-only and
    // both; reading `harness_edges` alone can only ever produce `designed: true`, which would
    // leave a specified state unreachable. `observedRuntimeEdges()` states the exact rule.
    //
    // A pair that IS declared keeps its declared edge and is not duplicated: `designed` is a
    // claim about the configuration, and the configuration declares it. The runtime count for
    // such a pair is already on the declared edge's `observed`.
    const declaredPairs = new Set(graphEdges.map((edge) => `${edge.source} ${edge.target}`));
    for (const edge of this.#graphs.observedRuntimeEdges()) {
      const source = `n${String(edge.fromId)}`;
      const target = `n${String(edge.toId)}`;
      if (declaredPairs.has(`${source} ${target}`)) continue;
      graphEdges.push({
        // ADR-039 — the edge KIND is part of the id. Three observed rules now feed this loop and
        // `@xyflow/react` keys on `id`; two rules producing the same pair with different kinds
        // would collide into one drawn edge and silently drop a count.
        id: `o${String(edge.fromId)}-${String(edge.toId)}-${edge.kind}`,
        source,
        target,
        kind: edge.kind,
        // No `evidence`: §3.10's three evidence values all describe a *file* — frontmatter, a body
        // mention, a directory. This edge has none of them; its evidence is the transcript, and
        // inventing a fourth value would put it in a CHECK constraint it does not belong to.
        designed: false,
        observed: edge.observed,
      });
    }

    return { nodes: graphNodes, edges: graphEdges };
  }

  /** `q:executionTrace` (§6.7) — the spawn tree and timeline of one session. */
  executionTrace(sessionId: string): ExecutionTrace {
    const row = this.#sessions.sessionRow(sessionId, 15);
    const runs = this.#sessions.subagentRunsFor(sessionId);
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const timeline: TraceSpan[] = [];

    if (row !== undefined) {
      // ⚠️ AMENDED 2026-07-22 (E12) — §3.9 / §6.7: the graph inspector is the ONLY place in this
      // application a prompt preview may appear, and until now no §4.5 payload could carry the
      // text at all. It is attached to the **session** node of the Execution Trace, which is the
      // node a prompt belongs to (`prompts.session_id`, §3.9) — never to a tool or subagent
      // node, which would be attributing a prompt to something that did not receive it.
      // ⚠️ Already capped at 280 characters by `sessionPromptPreview` (§3.9). Nothing widens it
      // between here and the wire, and the renderer caps again independently.
      // ⚠️ ONE preview, for ONE selected session, reachable only by clicking that node — never a
      // list, never searchable (§1.6 non-goal 1).
      const promptPreview = this.#graphs.sessionPromptPreview(sessionId);
      nodes.push({
        id: `session:${sessionId}`,
        kind: 'session',
        label: row.displayName,
        colorIndex: row.colorIndex,
        metrics: { messages: row.messages, toolCalls: row.toolCalls },
        // Omitted entirely when the session has no prompt: an empty preview would render as an
        // empty quote block, which claims the prompt was empty.
        ...(promptPreview === undefined ? {} : { meta: { promptPreview } }),
      });
      timeline.push({
        id: `session:${sessionId}`,
        kind: 'main',
        label: row.displayName,
        startTs: row.firstTs,
        endTs: row.lastTs,
        depth: 0,
      });
    }

    for (const run of runs) {
      const id = `run:${String(run.id)}`;
      nodes.push({
        id,
        kind: 'subagent',
        label: run.subagentType ?? 'subagent',
        colorIndex: colorIndexFor(run.subagentType ?? 'subagent'),
        metrics: { outputTokens: run.tokens.output, linked: run.linked ? 1 : 0 },
      });
      // ⚠️ §6.7 degraded state: an unlinked run is shown DETACHED, "rather than guessing a
      // parent" (§3.7, ADR-020). No edge is emitted for it.
      if (run.linked) {
        edges.push({
          id: `spawn:${String(run.id)}`,
          source: `session:${sessionId}`,
          target: id,
          kind: 'spawn',
          designed: false,
          observed: 1,
        });
      }
      timeline.push({
        id,
        kind: 'subagent',
        label: run.subagentType ?? 'subagent',
        startTs: run.firstTs,
        endTs: run.lastTs,
        depth: 1,
      });
    }

    const remaining = Math.max(0, GRAPH_NODE_CAP - nodes.length);
    for (const call of this.#sessions.traceToolCalls(sessionId, remaining)) {
      const parent =
        call.subagentRunId === null ? `session:${sessionId}` : `run:${String(call.subagentRunId)}`;
      const id = `tool:${parent}:${call.toolName}:${String(call.ts)}`;
      nodes.push({
        id,
        kind: 'tool',
        label: call.toolName,
        colorIndex: colorIndexFor(call.toolName),
        metrics: { ts: call.ts },
      });
      edges.push({
        id: `call:${id}`,
        source: parent,
        target: id,
        kind: 'tool_call',
        designed: false,
        observed: 1,
      });
      timeline.push({
        id,
        kind: 'tool',
        label: call.toolName,
        startTs: call.ts,
        endTs: call.ts,
        depth: call.subagentRunId === null ? 1 : 2,
      });
    }

    return {
      nodes,
      edges,
      timeline,
      unlinkedRuns: runs.filter((run) => !run.linked).length,
    };
  }

  /** `q:toolTransition` (§6.7) — the Markov graph over consecutive tool calls in a session. */
  toolTransition(context: QueryContext): Graph {
    const transitions = this.#tools.transitions(context);
    const names = new Set<string>();
    for (const edge of transitions) {
      names.add(edge.from);
      names.add(edge.to);
    }
    return {
      nodes: [...names].sort().map((name) => ({
        id: `tool:${name}`,
        kind: 'tool',
        label: name,
        colorIndex: colorIndexFor(name),
        metrics: {},
      })),
      edges: transitions.map((edge) => ({
        id: `t:${edge.from}->${edge.to}`,
        source: `tool:${edge.from}`,
        target: `tool:${edge.to}`,
        kind: 'transition',
        // Observed-only by construction: a transition is runtime evidence, never a declaration.
        designed: false,
        observed: edge.count,
      })),
    };
  }

  /** `q:flowSankey` (§6.7). */
  flowSankey(context: QueryContext): FlowSankey {
    const links = this.#graphs.sankeyLinks(context);
    const names = new Set<string>();
    for (const link of links) {
      names.add(link.source);
      names.add(link.target);
    }
    return {
      nodes: [...names].sort().map((id) => ({
        id,
        kind: id.split(':')[0] ?? 'node',
        label: id.slice(id.indexOf(':') + 1),
        colorIndex: colorIndexFor(id),
        metrics: {},
      })),
      links,
    };
  }

  // -------------------------------------------------------------------------------------
  // §6.9 Harness Manager — ⛔ every one of these ignores the global filter (INV-13).
  // -------------------------------------------------------------------------------------

  /** `q:skills` ⛔ — invocations and "last used" are ALL TIME. */
  skills(page: Page, sort: SkillSort): Paged<SkillRow> {
    const rows: SkillRow[] = this.#harness.skills().map((row) => ({
      name: row.name,
      source: row.source,
      pluginName: row.pluginName,
      relPath: row.relPath,
      sizeBytes: row.sizeBytes,
      invocations: row.invocations,
      lastUsedTs: row.lastUsedTs,
      // Derived from the same number the column shows, so the badge and the count cannot disagree.
      neverUsed: row.invocations === 0,
    }));
    rows.sort((left, right) => {
      switch (sort) {
        case 'never_used':
          // §6.9: "sorted by installed-but-never-used" — the point of the view.
          return (
            Number(right.neverUsed) - Number(left.neverUsed) || left.name.localeCompare(right.name)
          );
        case 'invocations':
          return right.invocations - left.invocations || left.name.localeCompare(right.name);
        case 'size':
          return right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name);
        case 'name':
          return left.name.localeCompare(right.name);
      }
    });
    return pageFrom<SkillRow>(rows, page, (row) => [row.name]);
  }

  /** `q:claudeMdFiles` ⛔ (§6.9, BR-01). */
  claudeMdFiles(backupRootPrefix: string): ClaudeMdFiles {
    return { rows: this.#harness.claudeMdFiles(backupRootPrefix) };
  }

  /** `q:plugins` ⛔ (§6.9, BR-04). */
  plugins(): PluginsAndMarketplaces {
    return this.#harness.plugins();
  }

  /** `q:memories` ⛔ (§6.9). See `HarnessManagerRepository.memories` for `entryCount`'s gap. */
  memories(): Memories {
    return { rows: this.#harness.memories() };
  }

  // -------------------------------------------------------------------------------------
  // §4.6 Disclosures
  // -------------------------------------------------------------------------------------

  /**
   * `q:disclosures` — incompleteness as data, never a log line (§4.6, CLAUDE.md §1).
   *
   * Every field is computed from real data. `activeOverlapSeconds` is M-20 for the same filter,
   * which is what makes the Overview tile's disclosure and this one the same number (INV-23).
   */
  disclosures(context: QueryContext, inputs: DisclosureInputs = {}): Disclosures {
    const coverage = this.coverage();
    const cacheSplit = this.#events.cacheSplitCoverage();
    // ADR-041 — UNFILTERED, like the A-05 counts: a property of the stored dataset, so a date
    // range that excluded the orphaned sessions must not make the caveat vanish (INV-13-style).
    const retainedOrphans = this.#events.retainedOrphanCoverage();
    return {
      uncosted: this.#uncostedSummary(context.filter),
      badLines: this.#events.badLines(),
      syntheticEvents: this.#events.counts(context).syntheticEvents,
      unlinkedSubagentRuns: this.#tools.unlinkedSubagentRuns(context),
      partialBefore: coverage.partialBefore,
      filesMissingSinceLastSync: inputs.filesMissingSinceLastSync ?? 0,
      activeOverlapSeconds: this.#active.overlap(context).overlapSeconds,
      // A-05 — both counts are UNFILTERED on purpose (see `cacheSplitCoverage`): they describe
      // the stored dataset, and a date range that happened to exclude the stale rows would make
      // the caveat vanish while the `$` figure it qualifies stayed understated.
      cacheSplitUnknownEvents: cacheSplit.unknownEvents,
      cacheSplitArchivedEvents: cacheSplit.archivedEvents,
      cacheSplitMismatches: this.#events.cacheSplitMismatches(),
      // ADR-041 — "N sessions kept from files no longer in your Claude folder."
      retainedOrphanSessions: retainedOrphans.sessions,
      retainedOrphanEvents: retainedOrphans.events,
    };
  }

  /** `q:uncosted` — M-06 alone. */
  uncosted(context: QueryContext): UncostedSummary {
    return this.#uncostedSummary(context.filter);
  }

  /**
   * M-16 — data coverage, for `app:bootstrap` (§4.3).
   *
   * `partialBefore` = `transcriptsFrom` when `promptsFrom < transcriptsFrom`, else `null`.
   * A bucket earlier than this renders with the partial-data treatment and **never as zero**
   * (§6.12).
   */
  coverage(): DataCoverage {
    const bounds = this.#events.coverage();
    const partialBefore =
      bounds.promptsFrom !== null &&
      bounds.transcriptsFrom !== null &&
      bounds.promptsFrom < bounds.transcriptsFrom
        ? bounds.transcriptsFrom
        : null;
    return { ...bounds, partialBefore };
  }

  // -------------------------------------------------------------------------------------

  /**
   * M-05 + M-06 for one scope, from E5's queries.
   *
   * ⚠️ There is exactly ONE costing implementation in this application and it is
   * `repositories/cost.ts` (A-10's lesson: INV-11 was implemented twice by two epics and neither
   * suite was red). This method composes it; it does not re-derive it.
   */
  #costSummary(scope: CostScope): { costNanoUsd: number | null; uncosted: UncostedSummary } {
    const totals = this.#cost.totals(scope);
    return {
      costNanoUsd: costToWire(totals.costPicoUsd, totals.costedEvents),
      uncosted: { records: totals.uncostedEvents, byModel: this.#cost.uncostedByModel(scope) },
    };
  }

  /**
   * M-06 **alone** — for the payloads that carry a disclosure but no `$` of their own.
   *
   * ⚠️ `records` is `Σ byModel.records` rather than a second `totals()` call, and the two are
   * **provably** the same number, not approximately: `uncostedByModel` is
   * `COUNT(*) … WHERE costed = 0 GROUP BY model` over the `classified` CTE, so summing its groups
   * is by definition `COUNT(*) − SUM(costed)`, which is exactly what `totals().uncostedEvents`
   * selects — same CTE, same `costed` flag, same rows. `model IS NOT NULL` is part of the
   * priceable population, so no group can be lost to a NULL key.
   *
   * ⚠️ This exists for **P-09** (§8.3), which measured the bi-temporal cost CTE — four classes at
   * the time, five since A-05 — at the dominant cost of thirteen of twenty-five queries: `q:disclosures`, `q:uncosted`,
   * `q:tokensByProject`, `q:projectCards` and `q:sessions` were each running that CTE once purely
   * to read a number the disclosure they already fetch also contains. The identity above is
   * asserted directly by a test rather than trusted, because "provably equal" that nobody checks
   * is how a silently wrong number gets born (CLAUDE.md §1).
   */
  #uncostedSummary(scope: CostScope): UncostedSummary {
    const byModel = this.#cost.uncostedByModel(scope);
    let records = 0;
    for (const row of byModel) records += row.records;
    return { records, byModel };
  }
}

/** Cells → §4.5 `ModelTimeline`. Buckets are the sorted distinct labels; each series is aligned. */
function toTimeline(
  cells: readonly { bucket: string; model: string; value: number }[],
): ModelTimeline {
  const buckets = [...new Set(cells.map((cell) => cell.bucket))].sort();
  const index = new Map(buckets.map((bucket, position) => [bucket, position]));
  const series = new Map<string, number[]>();
  for (const cell of cells) {
    const data = series.get(cell.model) ?? new Array<number>(buckets.length).fill(0);
    const position = index.get(cell.bucket);
    if (position !== undefined) data[position] = cell.value;
    series.set(cell.model, data);
  }
  return {
    buckets,
    series: [...series.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([model, data]) => ({ model, colorIndex: colorIndexFor(model), data })),
  };
}

// `nullWhenUnpriced` is re-exported so the IPC layer can apply the same "never $0.00" rule to any
// figure it composes itself, rather than re-deriving it (§6.4).
export { nullWhenUnpriced };
