/**
 * Deterministic layered placement for the two `@xyflow/react` canvases (ADR-011).
 *
 * ⚠️ `@xyflow/react` ships no layout engine — a node's `position` is an input, not an output —
 * so the placement is ours. It is written as a pure function over an ordered list for the same
 * reason ADR-011 chose `cytoscape` for the Tool Transition view: **the same data must produce
 * the same picture twice.** There is no randomness here, no clock and no measurement; two calls
 * with the same input return identical coordinates.
 *
 * Coordinates are unitless graph-space numbers, not CSS lengths (§6.1's token layer governs
 * colour and spacing; a graph coordinate is neither).
 */

/** Horizontal distance between layers, and vertical distance between siblings. */
export const LAYER_GAP = 260;
export const ROW_GAP = 72;

export interface PlacedNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Places each layer in its own column, centred vertically against the tallest layer.
 *
 * The order **within** a layer is the caller's; this function never sorts, because the caller is
 * the one that knows whether "alphabetical" or "chronological" is the honest reading. What it
 * guarantees is that a given ordering always lands on the same coordinates.
 */
export function layoutLayers(layers: readonly (readonly string[])[]): PlacedNode[] {
  const tallest = layers.reduce((max, layer) => Math.max(max, layer.length), 0);
  const placed: PlacedNode[] = [];
  layers.forEach((layer, column) => {
    const offset = ((tallest - layer.length) * ROW_GAP) / 2;
    layer.forEach((id, row) => {
      placed.push({ id, x: column * LAYER_GAP, y: offset + row * ROW_GAP });
    });
  });
  return placed;
}

/*
 * ⚠️ **`layoutUnlinkedLane` and `lowestY` were removed on 2026-07-22, and the rule they served
 * did not go with them.** They placed §6.7's unlinked lane as a band of graph coordinates below
 * the Execution Trace's spawn tree. That tab is no longer a node-link diagram — it is a timeline
 * you drill into, because the node-link picture was unreadable at real scale — and its unlinked
 * lane is now a labelled row band in the DOM (`ExecutionTraceTab.UNLINKED_LANE_LABEL`), which is
 * a stronger form of the same guarantee: a caption a reader can read, not only an offset.
 *
 * Deleted rather than left behind: the Harness Map is the only remaining caller of this module,
 * it has no unlinked lane, and a placement function nothing places with is a thing a later agent
 * will assume is load-bearing.
 */
