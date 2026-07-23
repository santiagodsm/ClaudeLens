/**
 * §6.7 tab 3's layout — `cytoscape` (ADR-011), run **headless**, as layout arithmetic.
 *
 * ⚠️⚠️ **Determinism is the reason this library is here at all.** ADR-011: "`cytoscape` is chosen
 * over `react-force-graph-2d` because the Tool Transition view needs deterministic, re-runnable
 * layout over a fixed 33-node Markov graph, not a WebGL particle simulation", and §6.7 says
 * "deterministic layout" in the table itself. Two things make that true here rather than assumed:
 *
 *   1. **A `circle` layout.** `cose` and `random` seed from `Math.random()` and were measured
 *      producing different coordinates for identical input; `circle`, `grid` and `breadthfirst`
 *      did not. There is no seed parameter to set on the ones that do — the choice of layout IS
 *      the seed decision.
 *   2. **A total order imposed before the elements are handed over.** `circle` walks the element
 *      array, so its output is stable for a given order but *rotates* if the payload order
 *      changes. Nodes are therefore sorted by descending weight then by id, and edges by id,
 *      here, in our code — which makes the picture a function of the data rather than of the row
 *      order the query happened to return.
 *
 * ⚠️ **Rendered by us, not by cytoscape.** Its renderer is canvas-based and cannot read a CSS
 * custom property, which would break ADR-011's own constraint that all five libraries "read their
 * colors from the ADR-004 token layer, never from literals" — and a canvas has no DOM for P-30's
 * keyboard selection or for a test to assert a tool name on. So this module returns coordinates
 * and `ToolTransitionTab` draws SVG, exactly the arrangement ADR-011 already blesses for
 * `d3-sankey`. Reported rather than assumed.
 */

import cytoscape from 'cytoscape';
import type { GraphEdge, GraphNode } from '../../../shared/ipc-contract';
import { boxAround, unionBoxes, type Box } from './camera';

/**
 * The box handed to `cytoscape` as a **hint**.
 *
 * ⚠️⚠️ It is a hint and nothing more, and treating it as a guarantee was the reported defect.
 * `circle` grows its radius until nodes do not overlap and ignores `boundingBox` when it has to:
 * measured, 33 tool nodes lay out across `x ∈ [-433, 1333]`, `y ∈ [-584, 1180]` — roughly four
 * times this box. The canvas used to emit `viewBox="0 0 900 600"` regardless, so most of the
 * graph was clipped and "zooming out" scaled the clipped remains. **Nothing may frame this graph
 * from these constants; `ToolTransitionLayout.bounds` is the only truth about its extent.**
 */
export const TRANSITION_WIDTH = 900;
export const TRANSITION_HEIGHT = 600;

/** Node box size handed to the layout, so its spacing accounts for the label pills we draw. */
export const NODE_WIDTH = 96;
export const NODE_HEIGHT = 30;

/**
 * Width of one character of a tool label at the pill's font size, in graph units.
 *
 * An estimate, and deliberately a generous one: it is used to widen the pill so a long tool name
 * fits inside it *and* to grow the bounding box the camera frames. Over-estimating leaves a
 * little extra air around the graph; under-estimating clips a name, which is the class of bug
 * this whole change is about.
 */
export const LABEL_CHAR_WIDTH = 7.5;
const LABEL_PADDING = 24;

/** The drawn width of a tool pill — at least `NODE_WIDTH`, wider when the name needs it. */
export function toolNodeWidth(label: string): number {
  return Math.max(NODE_WIDTH, label.length * LABEL_CHAR_WIDTH + LABEL_PADDING);
}

export interface PlacedToolNode {
  readonly id: string;
  readonly label: string;
  readonly colorIndex: number;
  readonly x: number;
  readonly y: number;
  /** The pill's drawn width, sized to its label. */
  readonly width: number;
  /** Total transitions in or out — the ranking §11.7 leaves open for this graph. */
  readonly weight: number;
}

export interface ToolTransitionLayout {
  readonly nodes: PlacedToolNode[];
  readonly byId: Map<string, PlacedToolNode>;
  /**
   * The real bounding box of everything drawn — every pill at its drawn size. `null` for an empty
   * graph, because a graph with no nodes has no extent and inventing one is the original bug.
   * This is what the camera fits to (§6.7: "frame the entire graph with a small margin").
   */
  readonly bounds: Box | null;
}

/** Total observed transitions touching a node, in either direction. */
export function transitionWeights(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): Map<string, number> {
  const weights = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    weights.set(edge.source, (weights.get(edge.source) ?? 0) + edge.observed);
    weights.set(edge.target, (weights.get(edge.target) ?? 0) + edge.observed);
  }
  return weights;
}

export function layoutToolTransition(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): ToolTransitionLayout {
  if (nodes.length === 0) return { nodes: [], byId: new Map(), bounds: null };

  const weights = transitionWeights(nodes, edges);

  // (2) above — the total order, imposed by us, before cytoscape sees anything.
  const ordered = [...nodes].sort(
    (left, right) =>
      (weights.get(right.id) ?? 0) - (weights.get(left.id) ?? 0) || left.id.localeCompare(right.id),
  );
  const orderedEdges = [...edges].sort((left, right) => left.id.localeCompare(right.id));

  const cy = cytoscape({
    // Headless: no container, no canvas, no renderer. This call is arithmetic.
    headless: true,
    styleEnabled: true,
    style: [{ selector: 'node', style: { width: NODE_WIDTH, height: NODE_HEIGHT } }],
    elements: [
      ...ordered.map((node) => ({ data: { id: node.id } })),
      ...orderedEdges.map((edge) => ({
        data: { id: edge.id, source: edge.source, target: edge.target },
      })),
    ],
  });

  cy.layout({
    // (1) above. `cose` is the non-deterministic one and is deliberately not used.
    name: 'circle',
    boundingBox: { x1: 0, y1: 0, w: TRANSITION_WIDTH, h: TRANSITION_HEIGHT },
    animate: false,
    fit: true,
  }).run();

  const placed: PlacedToolNode[] = ordered.map((node) => {
    const position = cy.getElementById(node.id).position();
    return {
      id: node.id,
      label: node.label,
      colorIndex: node.colorIndex,
      x: position.x,
      y: position.y,
      width: toolNodeWidth(node.label),
      weight: weights.get(node.id) ?? 0,
    };
  });
  cy.destroy();

  // Every edge is drawn between two node centres, so the union of the pills already contains the
  // lines. Measured from the placement, never from `TRANSITION_WIDTH`.
  const bounds = unionBoxes(
    placed.map((node) => boxAround({ x: node.x, y: node.y }, node.width, NODE_HEIGHT)),
  );

  return { nodes: placed, byId: new Map(placed.map((node) => [node.id, node])), bounds };
}
