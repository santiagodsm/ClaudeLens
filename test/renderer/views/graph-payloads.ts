/**
 * §4.5 graph payload factories for the §6.7 suites (E11).
 *
 * ⚠️ Hand-written contract shapes, never snapshots. The values are chosen to make a **rule**
 * visible: a `designed: true, observed: 0` edge, a `designed: false, observed > 0` edge and a
 * `designed: true, observed > 0` edge all exist here, because the Harness Map's legend has three
 * categories and a payload containing only one of them would let two of them rot untested.
 */

import type {
  ExecutionTrace,
  FlowSankey,
  Graph,
  GraphEdge,
  GraphNode,
  TraceSpan,
} from '../../../src/shared/ipc-contract';

export const G0 = Date.UTC(2026, 2, 2, 9, 0, 0);
const MINUTE = 60_000;

export function graphNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'n1',
    kind: 'skill',
    label: 'demo-skill',
    colorIndex: 0,
    metrics: { sizeBytes: 1_024, observed: 4 },
    ...overrides,
  };
}

export function graphEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: 'e1',
    source: 'n1',
    target: 'n2',
    kind: 'tool_grant',
    designed: true,
    observed: 3,
    ...overrides,
  };
}

/**
 * A Harness Map with one of each evidence class:
 *   · `orchestrator` → `demo-skill`   designed, never observed  (dashed)
 *   · `demo-skill`   → `Read`         designed and observed     (solid)
 *   · `worker`       → `Bash`         observed, not declared    (highlighted)
 */
export function harnessGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    nodes: [
      graphNode({
        id: 'n0',
        label: 'setup-project',
        role: 'orchestrator',
        metrics: { observed: 2 },
      }),
      graphNode({ id: 'n1', label: 'demo-skill', metrics: { sizeBytes: 2_048, observed: 4 } }),
      graphNode({ id: 'n2', kind: 'tool', label: 'Read', colorIndex: 1, metrics: { observed: 9 } }),
      graphNode({ id: 'n3', kind: 'tool', label: 'Bash', colorIndex: 2, metrics: { observed: 5 } }),
      graphNode({
        id: 'n4',
        kind: 'agent',
        label: 'worker',
        colorIndex: 3,
        metrics: { observed: 0 },
      }),
      graphNode({
        id: 'n5',
        kind: 'file',
        label: 'PLAN.md',
        colorIndex: 4,
        metrics: { observed: 0 },
      }),
    ],
    edges: [
      graphEdge({
        id: 'e0',
        source: 'n0',
        target: 'n1',
        kind: 'handoff',
        designed: true,
        observed: 0,
        evidence: 'body_mention',
      }),
      graphEdge({
        id: 'e1',
        source: 'n1',
        target: 'n2',
        designed: true,
        observed: 9,
        evidence: 'frontmatter',
      }),
      graphEdge({ id: 'e2', source: 'n4', target: 'n3', designed: false, observed: 5 }),
      graphEdge({
        id: 'e3',
        source: 'n1',
        target: 'n5',
        kind: 'reads',
        designed: true,
        observed: 0,
        evidence: 'frontmatter',
      }),
    ],
    ...overrides,
  };
}

/**
 * A Harness Map spanning **two projects and the shared `~/.claude` harness**, for the §6.7 display
 * filter (ADR-039). `meta.project` is the full folder name the payload carries; a node without it
 * is shared. Hand-built so the scope maths is checkable by eye:
 *
 *   · shared:      `Read` (tool), `global-helper` (skill)
 *   · family-app:  `family-orchestrator` (skill, orchestrator role), `family-skill` (skill)
 *   · budget-tool: `budget-skill` (skill)
 *
 * Both projects grant the shared `Read`; family-app's skill also reaches budget-tool's skill —
 * the one cross-project connection, so a project scope has something honest to disclose.
 *
 * ⚠️ Every node keeps its own `metrics.observed`; the filter must never change it (INV-13). The
 * numbers are distinct so a test can prove a node reads the same filtered and unfiltered.
 */
export function harnessGraphMultiProject(): Graph {
  return {
    nodes: [
      graphNode({
        id: 'sh-read',
        kind: 'tool',
        label: 'Read',
        colorIndex: 1,
        metrics: { observed: 30 },
      }),
      graphNode({
        id: 'sh-skill',
        kind: 'skill',
        label: 'global-helper',
        colorIndex: 2,
        metrics: { sizeBytes: 512, observed: 3 },
      }),
      graphNode({
        id: 'fa-orch',
        kind: 'skill',
        label: 'family-orchestrator',
        role: 'orchestrator',
        colorIndex: 3,
        metrics: { observed: 5 },
        meta: { project: 'family-app', source: 'user' },
      }),
      graphNode({
        id: 'fa-skill',
        kind: 'skill',
        label: 'family-skill',
        colorIndex: 4,
        metrics: { sizeBytes: 2_048, observed: 7 },
        meta: { project: 'family-app', source: 'user' },
      }),
      graphNode({
        id: 'bt-skill',
        kind: 'skill',
        label: 'budget-skill',
        colorIndex: 5,
        metrics: { sizeBytes: 1_024, observed: 9 },
        meta: { project: 'budget-tool', source: 'user' },
      }),
    ],
    edges: [
      graphEdge({
        id: 'e-fa-hand',
        source: 'fa-orch',
        target: 'fa-skill',
        kind: 'handoff',
        designed: true,
        observed: 5,
        evidence: 'body_mention',
      }),
      graphEdge({
        id: 'e-fa-read',
        source: 'fa-skill',
        target: 'sh-read',
        kind: 'tool_grant',
        designed: true,
        observed: 30,
        evidence: 'frontmatter',
      }),
      graphEdge({
        id: 'e-bt-read',
        source: 'bt-skill',
        target: 'sh-read',
        kind: 'tool_grant',
        designed: true,
        observed: 30,
        evidence: 'frontmatter',
      }),
      graphEdge({
        id: 'e-fa-bt',
        source: 'fa-skill',
        target: 'bt-skill',
        kind: 'handoff',
        designed: false,
        observed: 2,
      }),
    ],
  };
}

export function traceSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    // ⚠️ The span id IS the node id — `AnalyticsRepository.executionTrace` pushes both from the
    // same string (`session:<id>`, `run:<n>`, `tool:…`). They were allowed to drift apart here
    // while the tab was a node-link diagram that only ever read the nodes; the timeline joins
    // them, so a fixture whose ids do not match is a fixture that cannot happen.
    id: 'session:sess-1',
    kind: 'main',
    label: 'demo-alpha',
    startTs: G0,
    endTs: G0 + 20 * MINUTE,
    depth: 0,
    ...overrides,
  };
}

/**
 * A trace with one linked run, one **unlinked** run and two tool calls.
 * `metrics.linked` is the flag §6.7's degraded row turns on — `0` means detached.
 */
export function executionTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    nodes: [
      graphNode({
        id: 'session:sess-1',
        kind: 'session',
        label: 'demo-alpha',
        metrics: { messages: 24, toolCalls: 40 },
      }),
      graphNode({
        id: 'run:1',
        kind: 'subagent',
        label: 'worker',
        colorIndex: 3,
        metrics: { outputTokens: 500, linked: 1 },
      }),
      graphNode({
        id: 'run:2',
        kind: 'subagent',
        label: 'stray-worker',
        colorIndex: 5,
        metrics: { outputTokens: 120, linked: 0 },
      }),
      graphNode({
        id: 'tool:a',
        kind: 'tool',
        label: 'Read',
        colorIndex: 1,
        metrics: { ts: G0 + MINUTE },
      }),
      graphNode({
        id: 'tool:b',
        kind: 'tool',
        label: 'Bash',
        colorIndex: 2,
        metrics: { ts: G0 + 2 * MINUTE },
      }),
    ],
    // ⚠️ No edge to `run:2`. The main process emits none for an unlinked run (ADR-020), which is
    // what makes "guessing a parent" impossible rather than merely discouraged.
    edges: [
      graphEdge({
        id: 'spawn:1',
        source: 'session:sess-1',
        target: 'run:1',
        kind: 'spawn',
        designed: false,
        observed: 1,
      }),
      graphEdge({
        id: 'call:a',
        source: 'session:sess-1',
        target: 'tool:a',
        kind: 'tool_call',
        designed: false,
        observed: 1,
      }),
      graphEdge({
        id: 'call:b',
        source: 'run:1',
        target: 'tool:b',
        kind: 'tool_call',
        designed: false,
        observed: 1,
      }),
    ],
    // ⚠️ One span per node, exactly as the repository emits them: the main loop, **both** runs
    // (an unlinked run is still on the timeline — it is unparented, not unrecorded) and both
    // tool calls. A tool call's two timestamps are equal, because it is a point event (§3.6).
    timeline: [
      traceSpan(),
      traceSpan({
        id: 'run:1',
        kind: 'subagent',
        label: 'worker',
        startTs: G0 + MINUTE,
        endTs: G0 + 10 * MINUTE,
        depth: 1,
      }),
      traceSpan({
        id: 'run:2',
        kind: 'subagent',
        label: 'stray-worker',
        startTs: G0 + 12 * MINUTE,
        endTs: G0 + 15 * MINUTE,
        depth: 1,
      }),
      traceSpan({
        id: 'tool:a',
        kind: 'tool',
        label: 'Read',
        startTs: G0 + MINUTE,
        endTs: G0 + MINUTE,
        depth: 1,
      }),
      traceSpan({
        id: 'tool:b',
        kind: 'tool',
        label: 'Bash',
        startTs: G0 + 2 * MINUTE,
        endTs: G0 + 2 * MINUTE,
        depth: 2,
      }),
    ],
    unlinkedRuns: 1,
    ...overrides,
  };
}

/** A Markov graph: four tools, five transitions, every edge observed-only by construction. */
export function toolTransition(overrides: Partial<Graph> = {}): Graph {
  const names = ['Read', 'Edit', 'Bash', 'Grep'];
  return {
    nodes: names.map((name, index) =>
      graphNode({ id: `tool:${name}`, kind: 'tool', label: name, colorIndex: index, metrics: {} }),
    ),
    edges: [
      graphEdge({
        id: 't:Read->Edit',
        source: 'tool:Read',
        target: 'tool:Edit',
        kind: 'transition',
        designed: false,
        observed: 40,
      }),
      graphEdge({
        id: 't:Edit->Bash',
        source: 'tool:Edit',
        target: 'tool:Bash',
        kind: 'transition',
        designed: false,
        observed: 25,
      }),
      graphEdge({
        id: 't:Bash->Read',
        source: 'tool:Bash',
        target: 'tool:Read',
        kind: 'transition',
        designed: false,
        observed: 12,
      }),
      graphEdge({
        id: 't:Grep->Read',
        source: 'tool:Grep',
        target: 'tool:Read',
        kind: 'transition',
        designed: false,
        observed: 7,
      }),
      graphEdge({
        id: 't:Read->Grep',
        source: 'tool:Read',
        target: 'tool:Grep',
        kind: 'transition',
        designed: false,
        observed: 3,
      }),
    ],
    ...overrides,
  };
}

/** `project → model → tool`, banded by output tokens. Two stages, conserving. */
export function flowSankey(overrides: Partial<FlowSankey> = {}): FlowSankey {
  return {
    nodes: [
      graphNode({
        id: 'project:-work-demo-alpha',
        kind: 'project',
        label: '-work-demo-alpha',
        colorIndex: 0,
        metrics: {},
      }),
      graphNode({
        id: 'model:claude-test-1',
        kind: 'model',
        label: 'claude-test-1',
        colorIndex: 1,
        metrics: {},
      }),
      graphNode({ id: 'tool:Read', kind: 'tool', label: 'Read', colorIndex: 2, metrics: {} }),
      graphNode({
        id: 'tool:(no tool)',
        kind: 'tool',
        label: '(no tool)',
        colorIndex: 3,
        metrics: {},
      }),
    ],
    links: [
      { source: 'project:-work-demo-alpha', target: 'model:claude-test-1', value: 1_000 },
      { source: 'model:claude-test-1', target: 'tool:Read', value: 600 },
      { source: 'model:claude-test-1', target: 'tool:(no tool)', value: 400 },
    ],
    ...overrides,
  };
}

/** `count` nodes with descending `observed`, for the P-23 cap. */
export function wideGraph(count: number): Graph {
  return {
    nodes: Array.from({ length: count }, (_unused, index) =>
      graphNode({
        id: `n${String(index).padStart(4, '0')}`,
        kind: 'tool',
        label: `tool-${String(index)}`,
        colorIndex: index % 8,
        metrics: { observed: count - index },
      }),
    ),
    edges: [],
  };
}
