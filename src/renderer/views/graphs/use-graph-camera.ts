/**
 * §6.7's "pan, zoom, click-node-to-inspect" for the two canvases we render ourselves, as one
 * hook. `@xyflow/react` has its own viewport API and the Harness Map and Execution Trace use
 * that; this exists so the Tool Transition graph and the Flow Sankey behave *identically* rather
 * than growing two sets of semantics.
 *
 * ⚠️ **Fit-to-content is not an initial guess, it is a derived value.** `content` is the real
 * bounding box of the laid-out geometry, and whenever it changes — a filter re-query returning a
 * different graph, a different session — the camera re-frames. That is the fix for the reported
 * "the last part is cut and if I zoom out I cannot see it": the frame is computed *from* the
 * layout instead of being a constant the layout was assumed to fit inside.
 *
 * ⚠️ **Re-framing is not an entrance animation** (§6.12). Nothing here mounts, keys or transitions
 * anything; a filter change moves one `viewBox` attribute on the same `<svg>` element that was
 * already on screen.
 *
 * ⚠️ `content` must be referentially stable across renders that did not change the layout — every
 * caller computes it inside the same `useMemo` as its layout, so a re-render with unchanged data
 * does **not** throw away a pan the user has made.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  FALLBACK_VIEW,
  KEY_PAN_RATIO,
  ZOOM_STEP,
  padToFit,
  panView,
  viewBoxOf,
  zoomOf,
  zoomView,
  type Box,
  type Point,
} from './camera';

export interface GraphCamera {
  /** The current window, in graph coordinates. */
  readonly view: Box;
  /** The window "Fit" returns to — the content bounding box plus §6.7's small margin. */
  readonly fitBox: Box;
  /** The `viewBox` attribute. The only thing the SVG is driven by. */
  readonly viewBox: string;
  /** How far in the camera is, as a multiple of the fitted view. `1` is fit. */
  readonly zoom: number;
  /** True while the graph has no geometry — the canvas is showing §6.7's empty copy. */
  readonly hasContent: boolean;
  zoomIn: (focus?: Point) => void;
  zoomOut: (focus?: Point) => void;
  zoomBy: (factor: number, focus?: Point) => void;
  /** Pan by a delta in **graph** units. */
  panBy: (dx: number, dy: number) => void;
  /** Pan by a fraction of the visible window — what an arrow key does (P-30). */
  panByFraction: (fx: number, fy: number) => void;
  /** §6.7's required one-click way back from having zoomed into nothing. */
  fit: () => void;
}

export function useGraphCamera(content: Box | null): GraphCamera {
  const fitBox = useMemo(() => (content === null ? FALLBACK_VIEW : padToFit(content)), [content]);

  const [view, setView] = useState<Box>(fitBox);
  const [framed, setFramed] = useState<Box>(fitBox);

  // React's documented "adjust state when a prop changes" pattern: re-framing on new content is
  // a *derivation*, and doing it in an effect would render one frame of the old camera over the
  // new geometry — which is a visible flash of exactly the clipping this all exists to remove.
  if (framed !== fitBox) {
    setFramed(fitBox);
    setView(fitBox);
  }

  const zoomBy = useCallback(
    (factor: number, focus?: Point) => {
      setView((current) => zoomView(current, fitBox, factor, focus));
    },
    [fitBox],
  );

  const zoomIn = useCallback(
    (focus?: Point) => {
      zoomBy(ZOOM_STEP, focus);
    },
    [zoomBy],
  );

  const zoomOut = useCallback(
    (focus?: Point) => {
      zoomBy(1 / ZOOM_STEP, focus);
    },
    [zoomBy],
  );

  const panBy = useCallback((dx: number, dy: number) => {
    setView((current) => panView(current, dx, dy));
  }, []);

  const panByFraction = useCallback((fx: number, fy: number) => {
    setView((current) => panView(current, current.width * fx, current.height * fy));
  }, []);

  const fit = useCallback(() => {
    setView(fitBox);
  }, [fitBox]);

  return {
    view,
    fitBox,
    viewBox: viewBoxOf(view),
    zoom: zoomOf(view, fitBox),
    hasContent: content !== null,
    zoomIn,
    zoomOut,
    zoomBy,
    panBy,
    panByFraction,
    fit,
  };
}

/** Re-exported so a canvas can size its arrow-key step against the same constant. */
export { KEY_PAN_RATIO };
