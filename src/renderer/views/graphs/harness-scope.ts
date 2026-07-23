/**
 * §6.7 Harness Map — the **display** filter that makes ~555 nodes navigable, as pure functions.
 *
 * ⚠️⚠️ **This scopes what is DRAWN, never how a number is computed (INV-13).** ADR-039 already
 * partitions every count per project, so a node's `metrics.observed` is its all-time count *for
 * its own project* whether or not this filter is showing it. Nothing here reads or writes a
 * `metrics` value, and — deliberately — nothing here carries a date range: this is a
 * Harness-Map-local project *scope*, not the global filter. "Never used" stays all-time-true and
 * the "all time" badge stays on the screen. The moment this file touched a count or a timestamp it
 * would be the kind of quiet lie CLAUDE.md §1 is organised against.
 *
 * ⚠️ The project a node belongs to is read from `GraphNode.meta.project`, which
 * `AnalyticsRepository.harnessGraph` fills with the project's full folder name (§3.3
 * `display_name`, ADR-039). A node with no such key was scanned from the Claude data directory
 * itself — the "shared" harness (`project_id IS NULL`). No new payload field is needed: the map
 * already carries which project declared each node.
 */

import type { GraphEdge, GraphNode } from '../../../shared/ipc-contract';

/** The two non-project scope values. A project scope IS the project's display name. */
export const ALL_SCOPE = '__all__';
export const SHARED_SCOPE = '__shared__';

/** The kind groups the toggle chips offer. Every §3.10 `kind` maps into exactly one of these. */
export type HarnessKindGroup =
  | 'agents'
  | 'skills'
  | 'tools'
  | 'files'
  | 'claudeMd'
  | 'plugins'
  | 'memories'
  | 'settings'
  | 'other';

/**
 * §3.10 `harness_nodes.kind` → the chip it lives under. Commands are agent-like invokable
 * definitions and ride with agents; a marketplace is a container like a plugin. Anything the CHECK
 * grows that is not mapped here still gets a chip ("Other") rather than vanishing without a toggle.
 */
const KIND_GROUP: Record<string, HarnessKindGroup> = {
  skill: 'skills',
  agent: 'agents',
  command: 'agents',
  tool: 'tools',
  file: 'files',
  claude_md: 'claudeMd',
  plugin: 'plugins',
  marketplace: 'plugins',
  memory: 'memories',
  settings: 'settings',
};

export function kindGroupOf(kind: string): HarnessKindGroup {
  return KIND_GROUP[kind] ?? 'other';
}

/** ⚠️ Plain words only (CLAUDE.md §1a) — never the `kind` literal, never `claude_md`. */
export const KIND_GROUP_LABEL: Record<HarnessKindGroup, string> = {
  agents: 'Agents',
  skills: 'Skills',
  tools: 'Tools',
  files: 'Files',
  claudeMd: 'CLAUDE.md files',
  plugins: 'Plugins',
  memories: 'Memories',
  settings: 'Settings',
  other: 'Other',
};

/** The order the chips read in — orchestration first, then what they touch. */
export const KIND_GROUP_ORDER: readonly HarnessKindGroup[] = [
  'agents',
  'skills',
  'tools',
  'files',
  'claudeMd',
  'plugins',
  'memories',
  'settings',
  'other',
];

/** The project a node belongs to, or `null` for the shared (`~/.claude`) harness. */
export function projectOf(node: GraphNode): string | null {
  const project = node.meta?.['project'];
  return project === undefined || project === '' ? null : project;
}

export interface HarnessScopeOption {
  /** `ALL_SCOPE` · `SHARED_SCOPE` · a project's display name. */
  readonly value: string;
  readonly label: string;
  readonly variant: 'all' | 'shared' | 'project';
  /** How many nodes this scope holds — the shared set, or one project's own nodes. */
  readonly nodeCount: number;
}

/** ⚠️ A real path the user knows (`~/.claude`), not jargon — §1a permits it. */
export const SHARED_SCOPE_LABEL = 'Shared (~/.claude)';
export const ALL_SCOPE_LABEL = 'All projects';

/**
 * Every scope the selector offers, derived from the whole payload so the list is the same
 * whichever scope is active. Projects are listed by full folder name (§3.3 `display_name`), in
 * folder-name order; two projects that happen to share a display name collapse to one option here,
 * which is a display convenience and never a merge of their numbers (each node keeps its own
 * all-time count regardless of which option draws it).
 */
export function harnessScopeOptions(nodes: readonly GraphNode[]): HarnessScopeOption[] {
  let sharedCount = 0;
  const byProject = new Map<string, number>();
  for (const node of nodes) {
    const project = projectOf(node);
    if (project === null) sharedCount += 1;
    else byProject.set(project, (byProject.get(project) ?? 0) + 1);
  }

  const options: HarnessScopeOption[] = [
    { value: ALL_SCOPE, label: ALL_SCOPE_LABEL, variant: 'all', nodeCount: nodes.length },
  ];
  if (sharedCount > 0) {
    options.push({
      value: SHARED_SCOPE,
      label: SHARED_SCOPE_LABEL,
      variant: 'shared',
      nodeCount: sharedCount,
    });
  }
  for (const name of [...byProject.keys()].sort((a, b) => a.localeCompare(b))) {
    options.push({
      value: name,
      label: name,
      variant: 'project',
      nodeCount: byProject.get(name) ?? 0,
    });
  }
  return options;
}

/** The kind groups actually present in the payload, in reading order — the chips to show. */
export function presentKindGroups(nodes: readonly GraphNode[]): HarnessKindGroup[] {
  const present = new Set<HarnessKindGroup>();
  for (const node of nodes) present.add(kindGroupOf(node.kind));
  return KIND_GROUP_ORDER.filter((group) => present.has(group));
}

/**
 * The node ids a scope contains, by **project membership only** (before kind toggles).
 *
 * ⚠️ A project scope pulls in the shared nodes it directly connects to — the tools it grants, the
 * shared files it reads — because a project's tools ARE part of its picture even though ADR-039
 * keeps tool nodes unscoped (`Read` is the same `Read` everywhere). Without this, selecting a
 * project would erase every `tool_grant` edge and show orphaned skills. Connections that leave the
 * scope entirely (to *another* project) are not pulled in; they are counted and disclosed instead.
 */
function scopeNodeIds(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  scope: string,
): Set<string> {
  if (scope === ALL_SCOPE) return new Set(nodes.map((node) => node.id));
  if (scope === SHARED_SCOPE) {
    return new Set(nodes.filter((node) => projectOf(node) === null).map((node) => node.id));
  }
  const core = new Set(nodes.filter((node) => projectOf(node) === scope).map((node) => node.id));
  const shared = new Set(nodes.filter((node) => projectOf(node) === null).map((node) => node.id));
  const inScope = new Set(core);
  for (const edge of edges) {
    if (core.has(edge.source) && shared.has(edge.target)) inScope.add(edge.target);
    if (core.has(edge.target) && shared.has(edge.source)) inScope.add(edge.source);
  }
  return inScope;
}

export interface HarnessFilterResult {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  /**
   * Edges hidden because one end sits in the selected scope and the other belongs to a different
   * project. Surfaced in words so a filtered map never silently drops the fact that the projects
   * are connected. `0` for the "all projects" scope, which hides nothing.
   */
  readonly crossScopeHiddenEdges: number;
}

/**
 * Apply the project scope and the kind toggles to the payload, returning the visible sub-graph and
 * an honest count of the cross-project connections the scope hid.
 *
 * ⚠️ Order matters: the cross-project count is measured against the *project* scope alone, so it
 * does not change when the user hides a kind — hiding "Files" is the user's own choice and is
 * already reflected in the node count, not a hidden fact about other projects.
 */
export function filterHarnessGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  scope: string,
  hiddenKinds: ReadonlySet<HarnessKindGroup>,
): HarnessFilterResult {
  const inScope = scopeNodeIds(nodes, edges, scope);

  let crossScopeHiddenEdges = 0;
  if (scope !== ALL_SCOPE) {
    for (const edge of edges) {
      const from = inScope.has(edge.source);
      const to = inScope.has(edge.target);
      if (from !== to) crossScopeHiddenEdges += 1;
    }
  }

  const visibleNodes = nodes.filter(
    (node) => inScope.has(node.id) && !hiddenKinds.has(kindGroupOf(node.kind)),
  );
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );

  return { nodes: visibleNodes, edges: visibleEdges, crossScopeHiddenEdges };
}
