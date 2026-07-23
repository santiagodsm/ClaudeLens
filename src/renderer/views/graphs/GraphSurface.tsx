/**
 * The navigable SVG surface for the two canvases ADR-011 has us render ourselves — Tool
 * Transition and Flow Sankey. It is §6.7's "Interactions on all four: pan, zoom,
 * click-node-to-inspect" for the half of the four that `@xyflow/react` does not provide.
 *
 * ⚠️⚠️ **The `<svg>` is the camera.** Its `viewBox` is the only thing that changes when the user
 * pans or zooms; nothing is scaled, translated or re-laid-out. That is what makes zooming out
 * reveal empty space around the diagram instead of shrinking a clipped picture (see `camera.ts`
 * for the defect this replaced), and it is what keeps P-23's 30 fps budget — one attribute write
 * per frame, no layout pass.
 *
 * ⚠️ `preserveAspectRatio` is left at its default `xMidYMid meet`, deliberately. `meet` shows the
 * **whole** viewBox and pads the other axis, so "the viewBox contains the content" is sufficient
 * for "nothing is cut off" at any container aspect ratio. `slice` would crop, and this component
 * exists because something was being cropped.
 *
 * ⚠️ **Keyboard is a first-class input** (§6.12 P-30): the surface is focusable, has the app-wide
 * focus ring (`tokens.css` styles `[tabindex]:focus-visible`), and answers arrows / `+` / `−` /
 * `0` / `F`. Nodes inside it are focusable in their own right, so Tab walks the graph and Enter
 * inspects — which is the property `cytoscape`'s canvas renderer could not have given us.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, type JSX, type ReactNode } from 'react';
import { KEY_PAN_RATIO, ZOOM_STEP } from './camera';
import type { GraphCamera } from './use-graph-camera';

/** Said once, in the accessible name, because a canvas cannot show its own instructions. */
export const SURFACE_HELP =
  'Drag to pan, scroll to zoom, arrow keys to pan, plus and minus to zoom, 0 or F to fit the whole graph.';

/** A drag shorter than this many client pixels is a click on whatever is underneath, not a pan. */
const DRAG_SLOP = 3;

export interface GraphSurfaceProps {
  camera: GraphCamera;
  /** What this canvas is, in the reader's terms. The help text is appended to it. */
  label: string;
  /** §6.7 — "Click empty space to deselect." */
  onBackgroundClick?: () => void;
  children: ReactNode;
  'data-testid'?: string;
}

interface DragState {
  pointerId: number;
  clientX: number;
  clientY: number;
  moved: boolean;
}

export function GraphSurface({
  camera,
  label,
  onBackgroundClick,
  children,
  'data-testid': testId = 'graph-surface',
}: GraphSurfaceProps): JSX.Element {
  const ref = useRef<SVGSVGElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const swallowClick = useRef(false);

  // The wheel listener below is registered once and must not be torn down on every render, so it
  // reads the camera through a ref rather than closing over the render's copy. Written in a
  // layout effect — before any event can fire — rather than during render.
  const cameraRef = useRef(camera);
  useLayoutEffect(() => {
    cameraRef.current = camera;
  });

  /**
   * Client pixels → graph units. `getBoundingClientRect()` is the only measurement in the whole
   * camera, and it is taken per gesture rather than stored, so a resized window needs no
   * observer. A zero-width rect (jsdom, or a canvas in a collapsed panel) falls back to 1:1
   * rather than producing `Infinity` and throwing the view to nowhere.
   */
  const geometry = useCallback((): { x: number; y: number; left: number; top: number } => {
    const view = cameraRef.current.view;
    const rect = ref.current?.getBoundingClientRect();
    const width = rect === undefined || rect.width <= 0 ? 0 : rect.width;
    const height = rect === undefined || rect.height <= 0 ? 0 : rect.height;
    return {
      x: width === 0 ? 1 : view.width / width,
      y: height === 0 ? 1 : view.height / height,
      left: rect?.left ?? 0,
      top: rect?.top ?? 0,
    };
  }, []);

  /**
   * Wheel and trackpad zoom, on a **non-passive** native listener.
   *
   * ⚠️ React attaches `wheel` at the root as passive, so `preventDefault()` inside an `onWheel`
   * prop is ignored and the surrounding view scrolls away under the pointer. The listener is
   * therefore registered here, on the element, with `{ passive: false }`.
   */
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const box = geometry();
      const view = cameraRef.current.view;
      // Zoom about the pointer: the thing under the cursor stays under the cursor, which is what
      // makes a wheel feel like a camera rather than a slider.
      cameraRef.current.zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, {
        x: view.x + (event.clientX - box.left) * box.x,
        y: view.y + (event.clientY - box.top) * box.y,
      });
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
    };
  }, [geometry]);

  return (
    <svg
      ref={ref}
      data-testid={testId}
      viewBox={camera.viewBox}
      tabIndex={0}
      // `application` is the honest role: this element handles its own keys, and telling
      // assistive technology otherwise would have it swallow the arrows before they arrive.
      role="application"
      aria-label={`${label}. ${SURFACE_HELP}`}
      // The affordance itself — a grabbable plane, not a picture (P-30, FRONTEND §7).
      className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        drag.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          moved: false,
        };
        // Not available in every environment the renderer tests run under; the drag still works
        // without it, it just stops tracking if the pointer leaves the element.
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (active === null || active.pointerId !== event.pointerId) return;
        const dx = event.clientX - active.clientX;
        const dy = event.clientY - active.clientY;
        const moved = active.moved || Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP;
        const box = geometry();
        // Drag-to-pan means the content follows the pointer, so the *window* moves the other way.
        camera.panBy(-dx * box.x, -dy * box.y);
        drag.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          moved,
        };
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        swallowClick.current = drag.current.moved;
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        // Enter and Space belong to whichever node has focus; everything else is the camera's.
        switch (event.key) {
          case 'ArrowLeft':
            camera.panByFraction(-KEY_PAN_RATIO, 0);
            break;
          case 'ArrowRight':
            camera.panByFraction(KEY_PAN_RATIO, 0);
            break;
          case 'ArrowUp':
            camera.panByFraction(0, -KEY_PAN_RATIO);
            break;
          case 'ArrowDown':
            camera.panByFraction(0, KEY_PAN_RATIO);
            break;
          case '+':
          case '=':
            camera.zoomIn();
            break;
          case '-':
          case '_':
            camera.zoomOut();
            break;
          case '0':
          case 'f':
          case 'F':
            camera.fit();
            break;
          default:
            return;
        }
        event.preventDefault();
      }}
      onClickCapture={(event) => {
        // A pan that ended over a node must not also select it.
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.stopPropagation();
        event.preventDefault();
      }}
      onClick={() => {
        // §6.7 — "Click empty space to deselect." Every selectable thing on these canvases stops
        // propagation when it handles a click, so anything that reaches here is empty space (or a
        // band, which is decoration): the check is *whether the event arrived*, not what it hit.
        onBackgroundClick?.();
      }}
    >
      {children}
    </svg>
  );
}

export interface SvgNodeProps {
  /** Announced to a screen reader, and the reason the graph is legible without colour. */
  label: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
  'data-testid': string;
}

/**
 * One clickable, focusable, inspectable node on a hand-drawn canvas — §6.7's
 * "click-node-to-inspect", plus P-30's "Tab through nodes, Enter to inspect".
 *
 * ⚠️ This is the concrete thing ADR-011's canvas-based alternative could not offer. A node here
 * is a real DOM element: it takes focus, it carries an accessible name, its hover and selected
 * states come from the token layer, and a test can assert a tool's name on it. `cytoscape`'s own
 * renderer paints into a `<canvas>` — no element, no focus, no CSS custom properties, nothing for
 * `getByRole` to find.
 */
export function SvgNode({
  label,
  selected,
  onSelect,
  children,
  'data-testid': testId,
}: SvgNodeProps): JSX.Element {
  return (
    <g
      data-testid={testId}
      data-selected={selected ? 'true' : undefined}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      className="group cursor-pointer"
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        // Stopped before the surface sees it: Space would otherwise scroll, and the surface's own
        // key handling must not compete with the focused node's.
        event.preventDefault();
        event.stopPropagation();
        onSelect();
      }}
    >
      {children}
    </g>
  );
}
