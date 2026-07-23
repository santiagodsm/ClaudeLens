/**
 * The camera for the two canvases we draw ourselves — §6.7's `cytoscape`-laid-out Tool Transition
 * graph and its `d3-sankey`-laid-out Flow Sankey (ADR-011: both are laid out by a library and
 * **rendered as SVG by our own code**, so the viewport is ours to build too).
 *
 * ⚠️⚠️ **The defect this module exists to fix.** Both canvases used to emit a *fixed* viewBox —
 * `0 0 900 600` and `0 0 900 520` — and "zoom" was a CSS `transform: scale()` on the `<svg>`
 * element. Neither number was the bounding box of anything: `cytoscape`'s `circle` layout grows
 * its radius to avoid node overlap and ignores the `boundingBox` hint, so a real 33-tool graph
 * lays out across roughly `x ∈ [-433, 1333]`, `y ∈ [-584, 1180]` — under a third of it inside the
 * viewBox, the rest clipped away. Scaling the element then shrank *the clipped picture*, which is
 * exactly the "it is an image, and there is nothing beyond the lines" the user reported.
 *
 * The camera is therefore the `viewBox` itself, and nothing else:
 *
 *   · **fit** = the real bounding box of the laid-out geometry, plus a margin (`padToFit`);
 *   · **zoom** = a smaller or larger `viewBox` — zooming out enlarges the window on an infinite
 *     plane, so it can never "run out of image";
 *   · **pan**  = moving the `viewBox` origin.
 *
 * ⚠️ The `<svg>` keeps the default `preserveAspectRatio` (`xMidYMid meet`), which is what makes
 * "the viewBox contains the content bounding box" a *sufficient* condition for nothing being cut
 * off: `meet` fits the whole viewBox inside the element and shows **more** in the other axis,
 * never less. Every fit assertion in the suite rests on that.
 *
 * ⚠️ Pure arithmetic — no React, no DOM, no measurement, no clock. P-23's 30 fps budget is met by
 * changing one attribute per frame rather than re-running a layout, and by these functions being
 * cheap enough to run on every wheel event.
 */

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The margin around a fitted graph, as a fraction of its longest side. */
export const CAMERA_MARGIN_RATIO = 0.06;
/** …and never less than this in graph units, so a one-node graph is not framed flush. */
export const CAMERA_MIN_MARGIN = 12;
/** A viewBox with a zero side is invalid SVG; a degenerate layout still gets a window. */
export const CAMERA_MIN_SPAN = 1;

/** One press of `+` / `−`, and one wheel notch. */
export const ZOOM_STEP = 1.25;

/**
 * How far past the fit level the camera travels, in both directions.
 *
 * ⚠️ Both bounds are stated **relative to fit**, not in absolute units, which is what makes the
 * promise "you can always zoom out further than the whole graph" true for a graph of any size.
 * At `MIN_ZOOM` the window is 20× the graph's own extent — unambiguously empty space around a
 * small diagram, which is the reassurance the user asked for.
 */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 20;

/** One arrow-key press moves the view by this fraction of the visible window (§6.12 P-30). */
export const KEY_PAN_RATIO = 0.12;

/** The window used before any content has been laid out. Never rendered with real geometry. */
export const FALLBACK_VIEW: Box = { x: 0, y: 0, width: 100, height: 100 };

export interface Point {
  readonly x: number;
  readonly y: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** A box centred on a point. The form every node's own extent is expressed in. */
export function boxAround(centre: Point, width: number, height: number): Box {
  return { x: centre.x - width / 2, y: centre.y - height / 2, width, height };
}

/**
 * The union of a set of boxes — the "real bounding box of the laid-out geometry" §6.7's fit rule
 * needs. `null` for an empty set: a graph with no nodes has no bounding box, and inventing one
 * (`0 0 900 600`, say) is how the original defect was written.
 */
export function unionBoxes(boxes: readonly Box[]): Box | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let seen = 0;

  for (const box of boxes) {
    if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) continue;
    if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) continue;
    seen += 1;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }

  if (seen === 0) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** §6.7's "frame the entire graph with a small margin", as one function. */
export function padToFit(content: Box): Box {
  const margin = Math.max(
    CAMERA_MIN_MARGIN,
    Math.max(content.width, content.height) * CAMERA_MARGIN_RATIO,
  );
  return {
    x: content.x - margin,
    y: content.y - margin,
    width: Math.max(CAMERA_MIN_SPAN, content.width + margin * 2),
    height: Math.max(CAMERA_MIN_SPAN, content.height + margin * 2),
  };
}

/** How far in the camera currently is, as a multiple of the fitted view. `1` is fit. */
export function zoomOf(view: Box, fit: Box): number {
  if (view.width <= 0) return MAX_ZOOM;
  return fit.width / view.width;
}

/**
 * Zoom by `factor` (`>1` in, `<1` out), keeping `focus` — a point in **graph** coordinates —
 * pinned where it is. Wheel and pinch pass the pointer; the +/− buttons and the keyboard pass
 * nothing and the view centre is used.
 *
 * ⚠️ Clamped against the **fit** box, not against the content: at either limit the call returns
 * the view unchanged rather than drifting, so holding `−` settles instead of collapsing.
 */
export function zoomView(view: Box, fit: Box, factor: number, focus?: Point): Box {
  if (!Number.isFinite(factor) || factor <= 0) return view;
  const current = zoomOf(view, fit);
  const applied = clamp(current * factor, MIN_ZOOM, MAX_ZOOM) / current;
  if (!Number.isFinite(applied) || applied === 1) return view;

  const fx = focus?.x ?? view.x + view.width / 2;
  const fy = focus?.y ?? view.y + view.height / 2;
  return {
    x: fx - (fx - view.x) / applied,
    y: fy - (fy - view.y) / applied,
    width: view.width / applied,
    height: view.height / applied,
  };
}

/**
 * Move the window by a graph-space delta.
 *
 * ⚠️ Deliberately unbounded. A clamp would fight the zoom-out promise — the user has to be able
 * to put the diagram off to one side and see that there is nothing there — and "Fit" (`0` / `F`,
 * or the control in the header) is the one-click way back, which §6.7's shell already requires.
 */
export function panView(view: Box, dx: number, dy: number): Box {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

/** The `viewBox` attribute for a window. Rounded, so an identical camera renders an identical DOM. */
export function viewBoxOf(view: Box): string {
  const round = (value: number): string => String(Math.round(value * 1_000) / 1_000);
  return `${round(view.x)} ${round(view.y)} ${round(Math.max(CAMERA_MIN_SPAN, view.width))} ${round(Math.max(CAMERA_MIN_SPAN, view.height))}`;
}

/** Does `outer` fully contain `inner`? The property every fit assertion is written against. */
export function boxContains(outer: Box, inner: Box): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

/** Parse a `viewBox` string back into a box, so a test can assert against the rendered attribute. */
export function parseViewBox(value: string): Box | null {
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [x, y, width, height] = parts as [number, number, number, number];
  return { x, y, width, height };
}
