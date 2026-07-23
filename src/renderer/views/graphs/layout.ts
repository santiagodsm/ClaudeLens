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

/** Gap between layers (bands), between rows, and between sub-columns *within* a layer. */
export const LAYER_GAP = 260;
export const ROW_GAP = 72;
export const COL_GAP = 200;

export interface PlacedNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Places each layer in its own band, centred vertically against the tallest band.
 *
 * ⚠️⚠️ **A layer wraps into several sub-columns instead of one tall column** (fix, 2026-07-22).
 * The Harness Map's real graphs are dominated by one kind — hundreds of files, or (after the
 * P-23 cap) 500 tools — and the old one-column-per-layer placement stacked all of them into a
 * single column `n × ROW_GAP` tall and barely `LAYER_GAP` wide. Fit-to-content then scaled that
 * ~1300 × 20000 box to fit a wide canvas by its *height*, leaving the graph a ~40 px vertical
 * stripe: the reported symptom. Wrapping a big layer across `⌈√total⌉` rows gives the whole graph
 * a broad, near-filling aspect instead, and the layout still fills the wider canvas rather than
 * hiding in the middle of it.
 *
 * The order **within** a layer is the caller's; this function never sorts, because the caller is
 * the one that knows whether "alphabetical" or "chronological" is the honest reading. What it
 * guarantees is that a given ordering always lands on the same coordinates — no clock, no
 * randomness, no measurement; two calls with the same input return identical coordinates.
 */
export function layoutLayers(layers: readonly (readonly string[])[]): PlacedNode[] {
  const total = layers.reduce((sum, layer) => sum + layer.length, 0);
  if (total === 0) return [];

  // A square-ish target for the whole graph: the tallest a sub-column is allowed to grow before
  // the layer wraps into another sub-column. `⌈√total⌉` keeps a small graph a single column per
  // layer (so a 6-node map reads exactly as before) and a 500-node layer a broad grid.
  const rowsPerColumn = Math.max(1, Math.ceil(Math.sqrt(total)));

  // Rows each layer actually occupies, for vertical centring against the tallest.
  const layerRows = layers.map((layer) => Math.min(layer.length, rowsPerColumn));
  const tallest = layerRows.reduce((max, rows) => Math.max(max, rows), 0);

  const placed: PlacedNode[] = [];
  let cursorX = 0;
  layers.forEach((layer, index) => {
    // An empty layer takes no width and leaves no gap — a leading empty band would push the whole
    // graph off to one side of the canvas for no reason.
    if (layer.length === 0) return;
    const rows = layerRows[index] ?? 0;
    const offset = ((tallest - rows) * ROW_GAP) / 2;
    const subColumns = Math.ceil(layer.length / rowsPerColumn);
    layer.forEach((id, i) => {
      const subColumn = Math.floor(i / rowsPerColumn);
      const row = i % rowsPerColumn;
      placed.push({ id, x: cursorX + subColumn * COL_GAP, y: offset + row * ROW_GAP });
    });
    // Advance past this layer's own sub-columns, then leave the wider between-layer gap so the
    // bands still read left to right (containers → orchestrators → workers → tools → files).
    cursorX += (subColumns - 1) * COL_GAP + LAYER_GAP;
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
