/**
 * §6.7's shell — "a full-bleed canvas with zoom +/− controls" — plus P-30's keyboard and
 * `aria-label` requirements ("`aria-label` on every icon button", "full keyboard navigation …
 * and graph node selection").
 *
 * One presentational component for all four canvases, so the two `@xyflow/react` views, the
 * `cytoscape` view and the Sankey cannot end up with three different zoom affordances.
 */

import type { JSX } from 'react';

export interface ZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  /**
   * "Fit" rather than "reset": the honest name for what it does to a panned canvas.
   *
   * ⚠️ **Not optional on any canvas.** A reader who has zoomed or panned into empty space has no
   * other way back, and "I do not know what I am looking at" is exactly the state this button
   * exists to end in one click.
   */
  onFit: () => void;
  'data-testid'?: string;
}

export function ZoomControls({
  onZoomIn,
  onZoomOut,
  onFit,
  'data-testid': testId = 'zoom-controls',
}: ZoomControlsProps): JSX.Element {
  return (
    <div data-testid={testId} className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in (+)"
        data-testid={`${testId}-in`}
        onClick={onZoomIn}
        className="rounded-control border border-border px-3 py-1 text-small text-text-muted transition-colors duration-hover hover:bg-bg-surface-2"
      >
        +
      </button>
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out (−)"
        data-testid={`${testId}-out`}
        onClick={onZoomOut}
        className="rounded-control border border-border px-3 py-1 text-small text-text-muted transition-colors duration-hover hover:bg-bg-surface-2"
      >
        −
      </button>
      <button
        type="button"
        aria-label="Fit to view"
        title="Reset the view — frame the whole graph again (0 or F)"
        data-testid={`${testId}-fit`}
        onClick={onFit}
        className="rounded-control border border-border px-3 py-1 text-micro text-text-muted transition-colors duration-hover hover:bg-bg-surface-2"
      >
        Fit
      </button>
    </div>
  );
}
