/**
 * The arithmetic and the classifications behind §6.7's four canvases, as pure functions.
 *
 * Nothing here imports a graph library. That is deliberate: the P-23 node cap, the
 * designed-vs-observed classification and the edge-thickness scale are the parts that must be
 * *right*, and they are the parts a library would otherwise hide inside a render pass where no
 * test can reach them.
 */

import type { GraphEdge, GraphNode } from '../../../shared/ipc-contract';
import { MAX_RENDERED_GRAPH_NODES } from '../../lib/limits';

// ---------------------------------------------------------------------------------------
// §6.7 / §5.9 M-14 — designed vs observed
// ---------------------------------------------------------------------------------------

/**
 * §6.7's Degraded row: "Harness Map legend distinguishes designed-only, observed-only and both."
 *
 * ⚠️ `designed` and `observed` are two fields **on purpose** (§4.5). Collapsing them into one
 * number destroys the map's entire value, so the classification is exhaustive over the pair
 * rather than a truthiness test on either.
 */
export type EdgeEvidenceClass = 'designed-only' | 'observed-only' | 'both' | 'neither';

export function classifyEdge(edge: Pick<GraphEdge, 'designed' | 'observed'>): EdgeEvidenceClass {
  if (edge.designed) return edge.observed > 0 ? 'both' : 'designed-only';
  return edge.observed > 0 ? 'observed-only' : 'neither';
}

/**
 * The three-plus-one legend entries, in the order §6.7 names them.
 *
 * ⚠️ **Meaning is never carried by colour alone** (FRONTEND §8): each class pairs its hue with a
 * distinct stroke treatment *and* a word. `neither` is listed because it is representable — an
 * edge that is declared nowhere and ran zero times should not silently share the "both" swatch —
 * but it is rendered only when the graph actually contains one.
 */
export const EDGE_EVIDENCE_LABEL: Record<EdgeEvidenceClass, string> = {
  'designed-only': 'Designed, never observed',
  'observed-only': 'Observed, not declared',
  both: 'Designed and observed',
  neither: 'Neither declared nor observed',
};

/** A one-line explanation for the inspector and the legend's title attribute. */
export const EDGE_EVIDENCE_NOTE: Record<EdgeEvidenceClass, string> = {
  'designed-only':
    'The configuration declares this edge. No matching call appears in any transcript.',
  'observed-only': 'This call happens, and nothing in the configuration declares it.',
  both: 'The configuration declares this edge and the transcripts show it being used.',
  neither: 'Neither declared in the configuration nor seen in any transcript.',
};

/** The CSS custom property each class draws with. §6.1's token layer, never a literal. */
export const EDGE_EVIDENCE_STROKE: Record<EdgeEvidenceClass, string> = {
  'designed-only': 'var(--text-faint)',
  'observed-only': 'var(--accent-3)',
  both: 'var(--accent)',
  neither: 'var(--border)',
};

/** §6.7 — "dashed where `designed && observed === 0`". `null` means a solid stroke. */
export function edgeDashArray(evidence: EdgeEvidenceClass): string | null {
  return evidence === 'designed-only' || evidence === 'neither' ? '6 4' : null;
}

/** §6.7 — "highlighted where `!designed && observed > 0`". */
export function edgeIsHighlighted(evidence: EdgeEvidenceClass): boolean {
  return evidence === 'observed-only';
}

// ---------------------------------------------------------------------------------------
// §6.7 — "edge thickness ∝ `observed`"
// ---------------------------------------------------------------------------------------

/** The stroke widths the scale runs between, in unitless SVG coordinates. */
export const MIN_EDGE_WIDTH = 1;
export const MAX_EDGE_WIDTH = 6;

/**
 * §6.7 — "edge thickness ∝ `observed`", normalised against the busiest edge in the same graph.
 *
 * ⚠️ `observed === 0` renders at `MIN_EDGE_WIDTH` rather than at zero: a zero-width line is an
 * absent line, and a designed-but-never-observed edge is precisely the thing the Harness Map
 * exists to show. It is distinguished by being **dashed**, not by disappearing.
 *
 * ⚠️ Proportional to `observed`, not to `log(observed)`: §6.7 says "∝", and a log scale would
 * make a 100× difference look like a 2× one.
 */
export function edgeWidth(observed: number, maxObserved: number): number {
  if (!Number.isFinite(observed) || observed <= 0) return MIN_EDGE_WIDTH;
  if (maxObserved <= 0) return MIN_EDGE_WIDTH;
  const ratio = Math.min(1, observed / maxObserved);
  return MIN_EDGE_WIDTH + ratio * (MAX_EDGE_WIDTH - MIN_EDGE_WIDTH);
}

/** The busiest edge in a set, for `edgeWidth`'s denominator. `0` when nothing was observed. */
export function maxObserved(edges: readonly Pick<GraphEdge, 'observed'>[]): number {
  let max = 0;
  for (const edge of edges) if (edge.observed > max) max = edge.observed;
  return max;
}

// ---------------------------------------------------------------------------------------
// §8.5 P-23 / §11.7 — the node cap
// ---------------------------------------------------------------------------------------

export interface CappedGraph {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  /** Nodes the query returned, before the cap. */
  readonly total: number;
  /** Nodes actually drawn. */
  readonly rendered: number;
  readonly capped: boolean;
}

/**
 * §8.5 P-23 — "capped at 500 rendered nodes with an explicit 'showing top 500' label".
 *
 * ⚠️ **The label is not optional and it is not cosmetic**: a silent truncation reads as
 * completeness, which is the failure this whole project is organised against (CLAUDE.md §1).
 * `total` and `rendered` are returned separately so the caller states both.
 *
 * ⚠️ **§11.7 is openly NOT SPECIFIED** — "the *ranking* used to choose the top 500 is specified
 * only for the Harness Map (by `observed`) and not for Execution Trace or Tool Transition". So
 * the rank function is a **parameter** here, each caller states its own rule beside the call,
 * and this module does not invent a default. Ties break on `id`, so the same payload always
 * produces the same 500 — a cap that reshuffles under a re-query is worse than no cap.
 *
 * Edges are kept only where **both** endpoints survived. An edge to a node that is not on the
 * canvas would be a line into nothing.
 */
export function capGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  rank: (node: GraphNode) => number,
  limit: number = MAX_RENDERED_GRAPH_NODES,
): CappedGraph {
  const total = nodes.length;
  if (total <= limit) {
    return { nodes: [...nodes], edges: [...edges], total, rendered: total, capped: false };
  }
  const kept = [...nodes]
    .sort((left, right) => rank(right) - rank(left) || left.id.localeCompare(right.id))
    .slice(0, limit);
  const keptIds = new Set(kept.map((node) => node.id));
  return {
    nodes: kept,
    edges: edges.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target)),
    total,
    rendered: kept.length,
    capped: true,
  };
}

// P-23's label itself is E7's `GraphCanvas`, which takes `nodeCount` and `renderedNodeCount` as
// two separate props for exactly this reason and states both. `capGraph` feeds it; it does not
// render a second copy of the sentence.

// ---------------------------------------------------------------------------------------
// §6.7 — Harness Map node shapes
// ---------------------------------------------------------------------------------------

/**
 * §6.7 — "orchestrator (filled + glow) / worker skill (outlined) / tool (pill) / file (dashed
 * rect)".
 *
 * ⚠️ Four shapes are named and `harness_nodes.kind` has **ten** values (§3.10), so the mapping
 * is total over the ten and every node also carries its kind as text (FRONTEND §8 — shape and
 * colour are cues, the word is the message). An unmapped kind renders as `other`, visibly
 * different from all four, rather than borrowing one of their meanings.
 */
export type HarnessShape = 'orchestrator' | 'worker' | 'tool' | 'file' | 'container' | 'other';

export function harnessShape(node: Pick<GraphNode, 'kind' | 'role'>): HarnessShape {
  // §3.10 — `harness_nodes.role` is `metadata.role`, "e.g. 'orchestrator'". The role wins over
  // the kind: an orchestrator is a skill, and the map's top level is exactly those.
  if (node.role === 'orchestrator') return 'orchestrator';
  switch (node.kind) {
    case 'skill':
    case 'agent':
    case 'command':
      return 'worker';
    case 'tool':
      return 'tool';
    case 'file':
    case 'memory':
    case 'claude_md':
    case 'settings':
      return 'file';
    case 'plugin':
    case 'marketplace':
      return 'container';
    default:
      return 'other';
  }
}

/** The legend text for each shape — the word that carries the meaning. */
export const HARNESS_SHAPE_LABEL: Record<HarnessShape, string> = {
  orchestrator: 'Orchestrator',
  worker: 'Worker skill / agent',
  tool: 'Tool',
  file: 'File',
  container: 'Plugin / marketplace',
  other: 'Other',
};
