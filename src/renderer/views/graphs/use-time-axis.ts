/**
 * §6.7's "pan, zoom" for the Execution Trace's **time axis**.
 *
 * ⚠️ **This is the same camera the other canvases use, restricted to one dimension.** Every piece
 * of arithmetic — the zoom factor applied about a focus point, the pan, the fit — is imported from
 * `camera.ts` and nothing is re-derived here. A window on the time axis is a `Box` whose `x` is a
 * timestamp, whose `width` is a duration in milliseconds, and whose `y`/`height` are an unused
 * unit strip.
 *
 * ⚠️ **Two deliberate differences from `useGraphCamera`, both because a time axis is not a plane:**
 *
 *   · **Fit is the data extent exactly, with no margin.** `padToFit` adds 6% around a laid-out
 *     graph so a node is not framed flush against the edge; here the frame *is* a stated fact —
 *     the caption reads "09:14 → 17:42" and the axis carries those clock labels — so a margin
 *     would put the window and its own caption in disagreement. A bar that runs the whole level
 *     spans the whole width, which is exactly what a reader should be able to trust.
 *   · **One dimension.** Vertical space is a list of rows and is scrolled, never zoomed; zooming
 *     it would make the bars fatter, which means nothing.
 *
 * ⚠️ Re-framing on a new level is a **derivation, not an animation** (§6.12): drilling into a run
 * replaces the fit window, and the view follows it in the same render rather than one frame late.
 */

import { useCallback, useMemo, useState } from 'react';
import { KEY_PAN_RATIO, ZOOM_STEP, panView, zoomOf, zoomView, type Box } from './camera';
import type { TimeWindowValue } from './trace-timeline';

/** A window with no duration cannot be divided into proportions; one millisecond can. */
const MIN_WINDOW_MS = 1;

/** The unused vertical strip. Present only because the shared camera takes boxes. */
const STRIP = { y: 0, height: 1 } as const;

export function windowToBox(window: TimeWindowValue): Box {
  return {
    ...STRIP,
    x: window.startTs,
    width: Math.max(MIN_WINDOW_MS, window.endTs - window.startTs),
  };
}

export function boxToWindow(box: Box): TimeWindowValue {
  return { startTs: box.x, endTs: box.x + box.width };
}

export interface TimeAxis {
  /** What is on screen right now. */
  readonly window: TimeWindowValue;
  /** What "Fit" returns to — the whole of the level being looked at. */
  readonly full: TimeWindowValue;
  /** How far in the axis is, as a multiple of the level. `1` is the whole level. */
  readonly zoom: number;
  readonly isZoomed: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Zoom about a moment in time — what a wheel over a chart should do. */
  zoomAt: (factor: number, focusTs: number) => void;
  /** Pan by a fraction of the visible window; what an arrow key does (§6.12 P-30). */
  panByFraction: (fraction: number) => void;
  /** Pan by a duration, for a drag. */
  panByMs: (ms: number) => void;
  fit: () => void;
}

export function useTimeAxis(full: TimeWindowValue): TimeAxis {
  // Destructured so the memo depends on the two numbers rather than on the object's identity:
  // the fit box must change exactly when the level's own window changes, and not on every render.
  const { startTs, endTs } = full;
  const fitBox = useMemo(() => windowToBox({ startTs, endTs }), [startTs, endTs]);

  const [view, setView] = useState<Box>(fitBox);
  const [framed, setFramed] = useState<Box>(fitBox);

  // React's documented "adjust state when a prop changes" pattern — the same one `useGraphCamera`
  // uses, and for the same reason: doing it in an effect renders one frame of the previous
  // level's window over the new level's bars.
  if (framed !== fitBox) {
    setFramed(fitBox);
    setView(fitBox);
  }

  const zoomAt = useCallback(
    (factor: number, focusTs: number) => {
      setView((current) => zoomView(current, fitBox, factor, { x: focusTs, y: 0 }));
    },
    [fitBox],
  );

  const zoomIn = useCallback(() => {
    setView((current) => zoomView(current, fitBox, ZOOM_STEP));
  }, [fitBox]);

  const zoomOut = useCallback(() => {
    setView((current) => zoomView(current, fitBox, 1 / ZOOM_STEP));
  }, [fitBox]);

  const panByMs = useCallback((ms: number) => {
    setView((current) => panView(current, ms, 0));
  }, []);

  const panByFraction = useCallback((fraction: number) => {
    setView((current) => panView(current, current.width * fraction, 0));
  }, []);

  const fit = useCallback(() => {
    setView(fitBox);
  }, [fitBox]);

  const zoom = zoomOf(view, fitBox);

  return {
    window: boxToWindow(view),
    full: boxToWindow(fitBox),
    zoom,
    // Anything off the fitted window by more than a rounding wobble counts as zoomed, so the
    // "show the whole level again" affordance appears exactly when it is needed.
    isZoomed: Math.abs(zoom - 1) > 0.001 || Math.abs(view.x - fitBox.x) > 0.5,
    zoomIn,
    zoomOut,
    zoomAt,
    panByFraction,
    panByMs,
    fit,
  };
}

/** Re-exported so the surface sizes its arrow-key step against the same constant. */
export { KEY_PAN_RATIO, ZOOM_STEP };
