/**
 * The arithmetic behind §6.7's Execution Trace, as pure functions: what a session's records look
 * like when they are laid out along time, one level at a time.
 *
 * ⚠️⚠️ **Why this replaced the node-link picture.** §6.7 asked for a spawn tree "main-loop →
 * subagent runs → tool calls", and drawn as a node-link diagram that is a hairball at real scale:
 * one session in the reference dataset holds thousands of tool calls and dozens of subagent runs,
 * and no layout quality makes a thousand-node graph readable. The user's words: *"I love the
 * information that is there but it is not readable, it is just so much."* The information is the
 * same; the presentation is now a **timeline you drill into**, which is what gives it hierarchy:
 *
 *   1. **One level is on screen at a time.** The session level draws the main loop and the
 *      subagent runs it started — nothing else. Opening a run **re-scopes** the whole view to that
 *      run; opening a tool group re-scopes to its individual calls. An accordion that expands in
 *      place walks back to the same wall, one row at a time; re-scoping cannot.
 *   2. **Repetition is aggregated.** Inside a run, consecutive calls of the same tool become one
 *      bar, `Read ×47`. Forty-seven boxes carry no more information than one labelled bar.
 *   3. **Width is time.** Every level re-fits the axis to what is on screen, so a four-second run
 *      inside a nine-hour session fills the width instead of being an invisible sliver.
 *
 * ⚠️⚠️ **Tool calls are point events and the width rule must never be read as a measurement.**
 * `tool_calls` stores one `ts` per call and no end (§3.6), so an aggregated bar is drawn from the
 * **first call in the group to the last** — real, observed instants at both ends. It says *when
 * the calls happened*, never *how long they took*, and a group of one call has no width at all.
 * A fabricated per-call duration would be a silently wrong number rendered as a picture, which is
 * the failure this whole project is organised against (CLAUDE.md §1). Every row carries
 * `measured`, and the surface states the rule in words beside the chart.
 *
 * ⚠️ **Nothing here guesses a parent.** A subagent run whose starting point could not be resolved
 * arrives with no edge at all (§3.7, ADR-020), and it is shown in its own labelled lane. Tool
 * calls whose owner is not in the payload are counted and disclosed, never adopted by the main
 * loop.
 *
 * ⚠️ No React, no DOM, no clock. Every function is a pure transform of the §4.5 payload, so the
 * rules that must be *right* — the aggregation, the ranking, the cap, the axis — are testable
 * without rendering anything.
 */

import type { ExecutionTrace, GraphNode, TraceSpan } from '../../../shared/ipc-contract';
import { colorIndexFor } from '../../lib/colors';
import { MAX_RENDERED_GRAPH_NODES } from '../../lib/limits';

// ---------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------

/** What a bar stands for. Four kinds, and each says which in words on screen. */
export type TraceRowKind = 'main' | 'subagent' | 'toolGroup' | 'toolCall';

export interface TraceRow {
  /** Stable across re-renders of the same payload: a span id, or a derived group id. */
  readonly id: string;
  readonly kind: TraceRowKind;
  /** The bare name — a subagent's type, a tool's name, the session's display name. */
  readonly name: string;
  /** What the row reads on screen: `Read ×47` when it stands for more than one call. */
  readonly label: string;
  /** How many recorded things this row stands for. `1` unless it is an aggregated group. */
  readonly count: number;
  readonly startTs: number;
  readonly endTs: number;
  /** §3.3's stable hue index, so a name keeps its colour in every view. */
  readonly colorIndex: number;
  /**
   * ⚠️ `true` only when both ends of the bar are a recorded start and a recorded end, so the
   * width is elapsed time. `false` for anything built out of point events — see the file header.
   */
  readonly measured: boolean;
  /** §3.7 — this run's starting point could not be resolved. It gets its own lane. */
  readonly unlinked: boolean;
  /** There is a level beneath this row worth opening. */
  readonly drillable: boolean;
  /** How many tool calls sit beneath this row, whether or not it is open. */
  readonly toolCalls: number;
  /** Tokens this run produced, when the payload carries them. `null` when it does not. */
  readonly outputTokens: number | null;
  /** The `q:executionTrace` node this row came from, for the inspector. `null` when derived. */
  readonly nodeId: string | null;
}

// ---------------------------------------------------------------------------------------
// The drill-down path
// ---------------------------------------------------------------------------------------

/**
 * One step of the breadcrumb. The path is the whole navigational state of the tab: the rows on
 * screen are a pure function of the payload and this array.
 */
export type TraceScopeKind = 'session' | 'mainLoop' | 'run' | 'toolGroup';

export interface TraceScope {
  readonly kind: TraceScopeKind;
  /** The row id this scope was opened from. Empty for the session, which is the root. */
  readonly id: string;
  /** The crumb's text, in the reader's words. */
  readonly label: string;
}

/** The root crumb, in plain words rather than the session's identifier. */
export const SESSION_SCOPE_LABEL = 'Whole session';

/** What the rows of each level are, said as a noun a reader can act on. */
export const LEVEL_NOUN: Record<TraceScopeKind, string> = {
  session: 'subagent runs',
  mainLoop: 'tool calls the main loop made itself',
  run: 'tool calls this run made',
  toolGroup: 'individual calls',
};

/** The same nouns for exactly one. "1 tool calls" is the kind of seam a reader trips over. */
export const LEVEL_NOUN_ONE: Record<TraceScopeKind, string> = {
  session: 'subagent run',
  mainLoop: 'tool call the main loop made itself',
  run: 'tool call this run made',
  toolGroup: 'individual call',
};

// ---------------------------------------------------------------------------------------
// Indexing the payload
// ---------------------------------------------------------------------------------------

export interface IndexedRun {
  readonly span: TraceSpan;
  readonly node: GraphNode | undefined;
  readonly linked: boolean;
}

export interface TraceIndex {
  readonly sessionSpan: TraceSpan | null;
  readonly sessionNode: GraphNode | undefined;
  readonly runs: readonly IndexedRun[];
  /** Tool call spans, keyed by the row that made them. Payload order — which is time order. */
  readonly toolsByOwner: ReadonlyMap<string, readonly TraceSpan[]>;
  /** ⚠️ Tool calls whose owner is not in this payload. Counted and disclosed, never adopted. */
  readonly unattachedToolCalls: number;
  /** §3.7's disclosure, straight from the payload. */
  readonly unlinkedRuns: number;
}

/**
 * Turn one `q:executionTrace` payload into the three lookups every level needs.
 *
 * ⚠️ Ownership of a tool call comes from the **edge the main process emitted** (`tool_call`,
 * source = the main loop or a run), never from the shape of an id and never from timestamp
 * proximity. An unowned call is counted separately; §3.7's rule against nearest-preceding
 * guessing applies to every attribution in this tab, not only to spawn points.
 */
export function indexTrace(trace: ExecutionTrace): TraceIndex {
  const nodesById = new Map(trace.nodes.map((node) => [node.id, node]));

  let sessionSpan: TraceSpan | null = null;
  const runSpans: TraceSpan[] = [];
  const toolSpans: TraceSpan[] = [];
  for (const span of trace.timeline) {
    if (span.kind === 'main') sessionSpan ??= span;
    else if (span.kind === 'subagent') runSpans.push(span);
    else toolSpans.push(span);
  }

  const ownerOfTool = new Map<string, string>();
  for (const edge of trace.edges) {
    if (edge.kind === 'tool_call') ownerOfTool.set(edge.target, edge.source);
  }

  const runs: IndexedRun[] = runSpans
    .map((span) => {
      const node = nodesById.get(span.id);
      return { span, node, linked: (node?.metrics['linked'] ?? 0) === 1 };
    })
    .sort((left, right) => left.span.startTs - right.span.startTs || compareIds(left, right));

  const ownerIds = new Set<string>(runs.map((run) => run.span.id));
  if (sessionSpan !== null) ownerIds.add(sessionSpan.id);

  const toolsByOwner = new Map<string, TraceSpan[]>();
  let unattachedToolCalls = 0;
  for (const span of toolSpans) {
    const owner = ownerOfTool.get(span.id);
    if (owner === undefined || !ownerIds.has(owner)) {
      unattachedToolCalls += 1;
      continue;
    }
    const bucket = toolsByOwner.get(owner);
    if (bucket === undefined) toolsByOwner.set(owner, [span]);
    else bucket.push(span);
  }

  return {
    sessionSpan,
    sessionNode: sessionSpan === null ? undefined : nodesById.get(sessionSpan.id),
    runs,
    toolsByOwner,
    unattachedToolCalls,
    unlinkedRuns: trace.unlinkedRuns,
  };
}

function compareIds(left: IndexedRun, right: IndexedRun): number {
  return left.span.id.localeCompare(right.span.id);
}

// ---------------------------------------------------------------------------------------
// Aggregating repetition
// ---------------------------------------------------------------------------------------

export interface ToolGroup {
  readonly name: string;
  readonly count: number;
  /** The instant of the first call in the group. A recorded moment. */
  readonly firstTs: number;
  /** The instant of the last call in the group. Also a recorded moment. */
  readonly lastTs: number;
  /** The calls themselves, so the next level down needs no second pass over the payload. */
  readonly calls: readonly TraceSpan[];
}

/**
 * ⚠️ **Consecutive** calls of the same tool become one group — `Read ×47`.
 *
 * Consecutive, not "all calls of that tool anywhere in the run": a group whose ends were the
 * first and last `Read` of a run that also did forty other things in between would span time the
 * reads did not occupy, and the bar would be a claim about a stretch of the session that is not
 * true. Interleaving is preserved by starting a new group whenever the tool name changes.
 *
 * The input is expected in time order (the payload is ordered by timestamp, then by position in
 * the file); it is re-sorted here anyway so the rule holds whatever order it arrives in.
 */
export function aggregateToolCalls(spans: readonly TraceSpan[]): ToolGroup[] {
  const ordered = [...spans].sort(
    (left, right) => left.startTs - right.startTs || left.id.localeCompare(right.id),
  );

  const groups: ToolGroup[] = [];
  let calls: TraceSpan[] = [];

  const flush = (): void => {
    const first = calls[0];
    const last = calls[calls.length - 1];
    if (first === undefined || last === undefined) return;
    groups.push({
      name: first.label,
      count: calls.length,
      // Both ends are recorded instants. Neither is computed, padded or rounded.
      firstTs: first.startTs,
      lastTs: last.endTs,
      calls,
    });
    calls = [];
  };

  for (const span of ordered) {
    const open = calls[0];
    if (open !== undefined && open.label !== span.label) flush();
    calls.push(span);
  }
  flush();

  return groups;
}

/** `Read ×47`, or just `Read` when it happened once. The count is the label, never a tooltip. */
export function groupLabel(name: string, count: number): string {
  return count > 1 ? `${name} ×${String(count)}` : name;
}

// ---------------------------------------------------------------------------------------
// Choosing which rows to draw — §8.5 P-23 and §11.7
// ---------------------------------------------------------------------------------------

/**
 * §11.7 is openly NOT SPECIFIED for this graph, so the rule is stated here and **on screen**:
 * rows are chosen by how long they ran, or by how many tokens they produced, and the reader can
 * switch between the two. Whatever is left out is shown as a count that can be clicked.
 */
export type TraceRowOrder = 'duration' | 'tokens';

/** The words the control uses. No internal name reaches the screen (CLAUDE.md §1a). */
export const ROW_ORDER_LABEL: Record<TraceRowOrder, string> = {
  duration: 'How long it ran',
  tokens: 'Tokens it produced',
};

/** How many rows a level shows before it says "and N more". */
export const DEFAULT_VISIBLE_ROWS = 12;

export interface ChosenRows {
  readonly rows: readonly TraceRow[];
  readonly total: number;
  readonly hidden: number;
}

/**
 * Rank, take, then put back into **time order**.
 *
 * ⚠️ Ranking decides *which* rows are drawn; it never decides where they sit. A timeline whose
 * rows jumped around when the reader changed the ordering would make the picture unreadable in
 * exactly the way this redesign exists to fix. Ties break on the row id, so the same payload
 * always yields the same rows (a set that reshuffles under a re-query is worse than no cap).
 */
export function chooseRows(
  rows: readonly TraceRow[],
  order: TraceRowOrder,
  limit: number,
): ChosenRows {
  const total = rows.length;
  if (total <= limit) return { rows: [...rows], total, hidden: 0 };

  const rank = (row: TraceRow): number =>
    order === 'tokens' ? (row.outputTokens ?? 0) : row.endTs - row.startTs;

  const kept = new Set(
    [...rows]
      .sort((left, right) => rank(right) - rank(left) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((row) => row.id),
  );

  return {
    rows: rows.filter((row) => kept.has(row.id)),
    total,
    hidden: total - kept.size,
  };
}

// ---------------------------------------------------------------------------------------
// One level of the drill-down
// ---------------------------------------------------------------------------------------

export interface TraceLevel {
  /** The thing being looked at. Its own bar is `header`. */
  readonly scope: TraceScope;
  /** The scope's own bar, drawn above its children. `null` only when the payload is empty. */
  readonly header: TraceRow | null;
  /** The children on screen, in time order. */
  readonly rows: readonly TraceRow[];
  /** Children before the cut. */
  readonly total: number;
  /** Children not drawn — always shown as a count, never dropped in silence (§8.5 P-23). */
  readonly hidden: number;
  /** ⚠️ The time window this level is drawn against. Re-fitted per level. */
  readonly startTs: number;
  readonly endTs: number;
  /** How many of `rows` belong in the unlinked lane (§3.7). */
  readonly unlinkedShown: number;
  /** What the rows are, in words, for the caption and the empty state. */
  readonly noun: string;
  /** The same, for exactly one of them. */
  readonly nounOne: string;
  /** `false` when the breadcrumb pointed at something this payload no longer contains. */
  readonly resolved: boolean;
}

export interface BuildLevelOptions {
  readonly order?: TraceRowOrder;
  /** `true` after the reader clicks "and N more". */
  readonly revealAll?: boolean;
  readonly visibleRows?: number;
  /** §8.5 P-23's hard ceiling, even after the reader asks for everything. */
  readonly maxRows?: number;
}

/**
 * The rows for the level the breadcrumb currently points at.
 *
 * `path` is the breadcrumb minus its root: `[]` is the session, `[run]` is one subagent run,
 * `[run, group]` is one aggregated tool group. Everything on screen is derived here.
 */
export function buildTraceLevel(
  index: TraceIndex,
  path: readonly TraceScope[],
  options: BuildLevelOptions = {},
): TraceLevel {
  const order = options.order ?? 'duration';
  const maxRows = options.maxRows ?? MAX_RENDERED_GRAPH_NODES;
  const limit =
    options.revealAll === true
      ? maxRows
      : Math.min(options.visibleRows ?? DEFAULT_VISIBLE_ROWS, maxRows);

  const session = index.sessionSpan;
  if (session === null) return emptyLevel({ kind: 'session', id: '', label: SESSION_SCOPE_LABEL });

  const step = path[path.length - 1];

  if (step === undefined) return sessionLevel(index, session, order, limit);
  if (step.kind === 'mainLoop') return toolLevel(index, session.id, step, order, limit, 'mainLoop');
  if (step.kind === 'run') return runLevel(index, step, order, limit);
  return callLevel(index, path, step, order, limit);
}

// ---- level 1: the session ---------------------------------------------------------------

function sessionLevel(
  index: TraceIndex,
  session: TraceSpan,
  order: TraceRowOrder,
  limit: number,
): TraceLevel {
  const header = mainRow(index, session);
  const all = index.runs.map((run) => runRow(index, run));
  // ⚠️ §3.7 / §6.7 — the runs whose starting point is unknown go **last, together**, so the lane
  // heading the surface draws before the first of them is true of every row beneath it. Time
  // order is kept inside each group; `index.runs` is already sorted by when they started.
  const rows = [...all.filter((row) => !row.unlinked), ...all.filter((row) => row.unlinked)];
  const chosen = chooseRows(rows, order, limit);
  const window = unionWindow(header, chosen.rows);

  return {
    scope: { kind: 'session', id: session.id, label: SESSION_SCOPE_LABEL },
    header,
    rows: chosen.rows,
    total: chosen.total,
    hidden: chosen.hidden,
    startTs: window.startTs,
    endTs: window.endTs,
    unlinkedShown: chosen.rows.filter((row) => row.unlinked).length,
    noun: LEVEL_NOUN.session,
    nounOne: LEVEL_NOUN_ONE.session,
    resolved: true,
  };
}

// ---- level 2: one run, or the main loop's own calls --------------------------------------

function runLevel(
  index: TraceIndex,
  step: TraceScope,
  order: TraceRowOrder,
  limit: number,
): TraceLevel {
  const run = index.runs.find((candidate) => candidate.span.id === step.id);
  if (run === undefined) return emptyLevel(step);
  return toolLevel(index, run.span.id, step, order, limit, 'run', runRow(index, run));
}

function toolLevel(
  index: TraceIndex,
  ownerId: string,
  step: TraceScope,
  order: TraceRowOrder,
  limit: number,
  kind: 'mainLoop' | 'run',
  presetHeader?: TraceRow,
): TraceLevel {
  const session = index.sessionSpan;
  const header =
    presetHeader ?? (session === null ? null : { ...mainRow(index, session), drillable: false });
  if (header === null) return emptyLevel(step);

  const groups = aggregateToolCalls(index.toolsByOwner.get(ownerId) ?? []);
  const rows = groups.map((group, position) => toolGroupRow(group, ownerId, position));
  const chosen = chooseRows(rows, order, limit);
  const window = unionWindow(header, chosen.rows);

  return {
    scope: step,
    header: { ...header, drillable: false },
    rows: chosen.rows,
    total: chosen.total,
    hidden: chosen.hidden,
    startTs: window.startTs,
    endTs: window.endTs,
    unlinkedShown: 0,
    noun: LEVEL_NOUN[kind],
    nounOne: LEVEL_NOUN_ONE[kind],
    resolved: true,
  };
}

// ---- level 3: the individual calls of one group -------------------------------------------

function callLevel(
  index: TraceIndex,
  path: readonly TraceScope[],
  step: TraceScope,
  order: TraceRowOrder,
  limit: number,
): TraceLevel {
  const parent = path[path.length - 2];
  const ownerId =
    parent === undefined || parent.kind === 'mainLoop' ? (index.sessionSpan?.id ?? '') : parent.id;

  const groups = aggregateToolCalls(index.toolsByOwner.get(ownerId) ?? []);
  const found = groups
    .map((group, position) => ({ group, position }))
    .find((entry) => toolGroupId(ownerId, entry.position, entry.group.name) === step.id);
  if (found === undefined) return emptyLevel(step);

  const header = toolGroupRow(found.group, ownerId, found.position);
  const rows = found.group.calls.map((call) => callRow(call));
  const chosen = chooseRows(rows, order, limit);
  const window = unionWindow(header, chosen.rows);

  return {
    scope: step,
    header: { ...header, drillable: false },
    rows: chosen.rows,
    total: chosen.total,
    hidden: chosen.hidden,
    startTs: window.startTs,
    endTs: window.endTs,
    unlinkedShown: 0,
    noun: LEVEL_NOUN.toolGroup,
    nounOne: LEVEL_NOUN_ONE.toolGroup,
    resolved: true,
  };
}

// ---- rows ---------------------------------------------------------------------------------

function mainRow(index: TraceIndex, session: TraceSpan): TraceRow {
  const own = index.toolsByOwner.get(session.id) ?? [];
  return {
    id: session.id,
    kind: 'main',
    name: session.label,
    label: session.label,
    count: 1,
    startTs: session.startTs,
    endTs: session.endTs,
    colorIndex: index.sessionNode?.colorIndex ?? 0,
    // A session's first and last recorded moments are both real, so the width is elapsed time.
    measured: true,
    unlinked: false,
    drillable: own.length > 0,
    toolCalls: own.length,
    outputTokens: null,
    nodeId: index.sessionNode?.id ?? null,
  };
}

function runRow(index: TraceIndex, run: IndexedRun): TraceRow {
  const own = index.toolsByOwner.get(run.span.id) ?? [];
  const tokens = run.node?.metrics['outputTokens'];
  return {
    id: run.span.id,
    kind: 'subagent',
    name: run.span.label,
    label: run.span.label,
    count: 1,
    startTs: run.span.startTs,
    endTs: run.span.endTs,
    colorIndex: run.node?.colorIndex ?? 0,
    measured: true,
    unlinked: !run.linked,
    drillable: own.length > 0,
    toolCalls: own.length,
    outputTokens: tokens ?? null,
    nodeId: run.node?.id ?? null,
  };
}

/** The id of an aggregated group: stable for one payload, and readable in a test failure. */
export function toolGroupId(ownerId: string, position: number, name: string): string {
  return `group:${ownerId}:${String(position)}:${name}`;
}

function toolGroupRow(group: ToolGroup, ownerId: string, position: number): TraceRow {
  return {
    id: toolGroupId(ownerId, position, group.name),
    kind: 'toolGroup',
    name: group.name,
    label: groupLabel(group.name, group.count),
    count: group.count,
    startTs: group.firstTs,
    endTs: group.lastTs,
    // The same stable hue a tool carries in every other view (§3.3, §6.1).
    colorIndex: colorIndexFor(group.name),
    // ⚠️ First call → last call. Not a duration. The surface says so in words.
    measured: false,
    unlinked: false,
    drillable: group.count > 1,
    toolCalls: group.count,
    outputTokens: null,
    nodeId: null,
  };
}

function callRow(call: TraceSpan): TraceRow {
  return {
    id: call.id,
    kind: 'toolCall',
    name: call.label,
    label: call.label,
    count: 1,
    startTs: call.startTs,
    endTs: call.endTs,
    colorIndex: colorIndexFor(call.label),
    // One recorded instant. It has no width at all, and is drawn as a marker.
    measured: false,
    unlinked: false,
    drillable: false,
    toolCalls: 1,
    outputTokens: null,
    nodeId: call.id,
  };
}

// ---- windows ------------------------------------------------------------------------------

export interface TimeWindowValue {
  readonly startTs: number;
  readonly endTs: number;
}

/**
 * The level's own time window: the scope's bar, widened to contain every row on screen.
 *
 * ⚠️ Widened, never trimmed. A tool call recorded outside its run's own first/last timestamps is
 * a real record; clipping it to make the picture tidy would hide it.
 */
function unionWindow(header: TraceRow | null, rows: readonly TraceRow[]): TimeWindowValue {
  let startTs = header?.startTs ?? Number.POSITIVE_INFINITY;
  let endTs = header?.endTs ?? Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    startTs = Math.min(startTs, row.startTs);
    endTs = Math.max(endTs, row.endTs);
  }
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return { startTs: 0, endTs: 0 };
  return { startTs, endTs: Math.max(startTs, endTs) };
}

function emptyLevel(scope: TraceScope): TraceLevel {
  return {
    scope,
    header: null,
    rows: [],
    total: 0,
    hidden: 0,
    startTs: 0,
    endTs: 0,
    unlinkedShown: 0,
    noun: LEVEL_NOUN[scope.kind],
    nounOne: LEVEL_NOUN_ONE[scope.kind],
    resolved: false,
  };
}

// ---------------------------------------------------------------------------------------
// Geometry — where a bar sits, as a fraction of the visible window
// ---------------------------------------------------------------------------------------

export interface BarGeometry {
  /** Distance from the left edge, `0..1`. */
  readonly left: number;
  /** Width, `0..1`. Zero for anything that occupied a single instant. */
  readonly width: number;
  /** The bar continues past this edge of the window. */
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
  /** `false` when the bar lies entirely outside the window — it is not drawn at all. */
  readonly visible: boolean;
}

const HIDDEN: BarGeometry = {
  left: 0,
  width: 0,
  clippedStart: false,
  clippedEnd: false,
  visible: false,
};

/**
 * ⚠️ **This is the function the whole design rests on: width is time and position is when.**
 * Returned as fractions of the window rather than pixels, so the surface can size itself and a
 * test can assert a hand-computed ratio instead of a rendered snapshot.
 *
 * A window of zero length has no proportions at all, and stretching one instant across the full
 * width would invent a duration — every bar in that case reports zero width, and the surface says
 * why rather than drawing something.
 */
export function barGeometry(row: TimeWindowValue, window: TimeWindowValue): BarGeometry {
  const span = window.endTs - window.startTs;
  if (!(span > 0)) {
    return row.startTs >= window.startTs && row.startTs <= window.endTs
      ? { left: 0, width: 0, clippedStart: false, clippedEnd: false, visible: true }
      : HIDDEN;
  }
  if (row.endTs < window.startTs || row.startTs > window.endTs) return HIDDEN;

  const rawLeft = (row.startTs - window.startTs) / span;
  const rawRight = (row.endTs - window.startTs) / span;
  const left = Math.min(1, Math.max(0, rawLeft));
  const right = Math.min(1, Math.max(0, rawRight));

  return {
    left,
    width: Math.max(0, right - left),
    clippedStart: rawLeft < 0,
    clippedEnd: rawRight > 1,
    visible: true,
  };
}

// ---------------------------------------------------------------------------------------
// The time axis
// ---------------------------------------------------------------------------------------

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The steps an axis is allowed to use. Every one of them reads as a round clock time. */
const TICK_STEPS = [
  10,
  20,
  50,
  100,
  200,
  500,
  SECOND,
  2 * SECOND,
  5 * SECOND,
  10 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
];

/** Never draw more than this many labels, whatever the window. */
const MAX_TICKS = 24;

export interface AxisTick {
  readonly ts: number;
  /** Where it sits, `0..1` of the window. */
  readonly fraction: number;
  /** The clock time, e.g. `14:32`. */
  readonly label: string;
  /** Set on the first tick of a new local day, so a session spanning midnight still reads. */
  readonly dayLabel: string | null;
}

/** The step that gets closest to `target` labels without going below it. */
export function chooseTickStep(spanMs: number, target: number): number {
  const rough = spanMs / Math.max(1, target);
  for (const step of TICK_STEPS) if (step >= rough) return step;
  return Math.ceil(rough / DAY) * DAY;
}

/** Local midnight of the day `ts` falls in — ADR-021, every calendar rendering is local. */
function localDayStart(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function sameLocalDay(left: number, right: number): boolean {
  return localDayStart(left) === localDayStart(right);
}

/**
 * ⚠️ **Real clock labels, never bare offsets.** The user's standing complaint is that axes across
 * the app carry no labels; an axis that reads `0 · 25% · 50%` answers nothing a reader can act on.
 * Ticks are aligned to local midnight so they land on round clock times in the reader's own zone
 * (ADR-021), and the first tick of a new day carries its date so a session running past midnight
 * cannot read as one that looped back.
 */
export function axisTicks(window: TimeWindowValue, target = 6): AxisTick[] {
  const span = window.endTs - window.startTs;
  if (!(span > 0)) return [];

  const step = chooseTickStep(span, target);
  const origin = localDayStart(window.startTs);
  const first = origin + Math.ceil((window.startTs - origin) / step) * step;

  const ticks: AxisTick[] = [];
  for (let ts = first; ts <= window.endTs && ticks.length < MAX_TICKS; ts += step) {
    const previous = ticks[ticks.length - 1];
    const isNewDay =
      previous === undefined ? !sameLocalDay(ts, window.startTs) : !sameLocalDay(ts, previous.ts);
    ticks.push({
      ts,
      fraction: (ts - window.startTs) / span,
      label: formatTickTime(ts, step),
      dayLabel: isNewDay ? formatTickDay(ts) : null,
    });
  }
  return ticks;
}

/** `14:32`, or `14:32:07` when the ticks are closer together than a minute. */
export function formatTickTime(ts: number, stepMs: number): string {
  const withSeconds = stepMs < MINUTE;
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  });
}

function formatTickDay(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
