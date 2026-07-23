/**
 * FRONTEND §5 / §6.7 — "full-bleed React Flow / force-graph area with: zoom controls, a legend,
 * a filter chip row, and a right-hand inspector drawer that slides in on node click."
 *
 * ⚠️ **This is the shell only.** E11 fills in the canvas — the layout engine, the node and edge
 * renderers, the pan/zoom implementation and the P-23 30 fps budget. Everything that survives a
 * change of graph library lives here: the chrome, the four states, the P-23 node cap and its
 * label, the drawer, and the keyboard contract. `children` is the canvas slot; it receives no
 * data from this component.
 *
 * ⚠️ P-23 — "capped at 500 rendered nodes with an explicit 'showing top 500' label". `nodeCount`
 * and `renderedNodeCount` are separate props so the label states the truth rather than implying
 * the graph is complete (§11.7).
 */

import type { JSX, ReactNode } from 'react';
import type { AppError } from '../../shared/ipc-contract';
import { cx } from '../lib/cx';
import { formatInteger } from '../lib/format';
import { MAX_RENDERED_GRAPH_NODES } from '../lib/limits';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { LoadingState } from './LoadingState';

export interface GraphCanvasProps {
  title: string;
  /** The filter chip row (FRONTEND §5). Rendered above the canvas, never over it. */
  filters?: ReactNode;
  /** The legend. Interactive where the library allows (FRONTEND §6). */
  legend?: ReactNode;
  /** Zoom in / out / fit. Supplied by E11 once the canvas has a viewport to drive. */
  controls?: ReactNode;
  /**
   * The right-hand inspector drawer's contents (§6.7 — prompt, tokens, timing, links).
   * `undefined` keeps the drawer closed; the drawer slides in at 240 ms (FRONTEND §7).
   */
  inspector?: ReactNode;
  onCloseInspector?: () => void;

  /** Total nodes the query returned, before the P-23 cap. */
  nodeCount?: number;
  /** Nodes actually drawn. Defaults to `min(nodeCount, 500)`. */
  renderedNodeCount?: number;

  loading?: boolean;
  error?: AppError | null;
  empty?: boolean;
  emptyReason?: string;
  onRetry?: () => void;

  /** The canvas itself. E11 supplies it. */
  children?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

export function GraphCanvas({
  title,
  filters,
  legend,
  controls,
  inspector,
  onCloseInspector,
  nodeCount,
  renderedNodeCount,
  loading = false,
  error = null,
  empty = false,
  emptyReason = 'Nothing to graph in this range',
  onRetry,
  children,
  className,
  'data-testid': testId = 'graph-canvas',
}: GraphCanvasProps): JSX.Element {
  const drawn =
    renderedNodeCount ??
    (nodeCount === undefined ? undefined : Math.min(nodeCount, MAX_RENDERED_GRAPH_NODES));
  const capped = nodeCount !== undefined && drawn !== undefined && drawn < nodeCount;

  return (
    <section
      data-testid={testId}
      aria-label={title}
      className={cx(
        'relative flex min-h-0 flex-col rounded-card border border-border bg-bg-surface shadow-card',
        className,
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 p-6 pb-3">
        <h2 className="text-h3 font-semibold text-text-primary">{title}</h2>
        <div className="flex items-center gap-3">
          {legend}
          {controls}
        </div>
      </header>

      {filters !== undefined && (
        <div className="flex flex-wrap gap-2 px-6 pb-3" data-testid={`${testId}-filters`}>
          {filters}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div className="min-h-0 flex-1" data-testid={`${testId}-surface`}>
          {error !== null ? (
            <ErrorState error={error} onRetry={onRetry} className="m-6 border-0" />
          ) : loading ? (
            <LoadingState label={`Loading ${title}`} lines={5} />
          ) : empty ? (
            <EmptyState reason={emptyReason} />
          ) : (
            children
          )}
        </div>

        {inspector !== undefined && (
          <aside
            data-testid={`${testId}-inspector`}
            aria-label={`${title} inspector`}
            className="w-80 max-w-full shrink-0 overflow-y-auto border-l border-border bg-bg-surface-2 p-6 transition-transform duration-drawer"
          >
            {onCloseInspector !== undefined && (
              <button
                type="button"
                onClick={onCloseInspector}
                aria-label="Close inspector"
                className="mb-3 rounded-control border border-border px-2 py-1 text-micro text-text-muted transition-colors duration-hover hover:bg-bg-surface"
              >
                Close
              </button>
            )}
            {inspector}
          </aside>
        )}
      </div>

      {/* P-23 / §11.7 — the cap is stated, never implied. */}
      <p className="px-6 pt-3 pb-6 text-small text-text-muted">
        {capped
          ? `Showing the top ${formatInteger(drawn)} of ${formatInteger(nodeCount)} nodes.`
          : nodeCount === undefined
            ? 'No node count reported for this canvas.'
            : `${formatInteger(nodeCount)} nodes.`}
        {/*
          ⚠️ The affordance, said in words. A diagram that pans and zooms looks exactly like a
          picture until you try it, and "I do not know what I am looking at" was a reported
          symptom, not a hypothetical. Suppressed while the canvas is not showing a graph, so it
          never contradicts an empty or failed state.
        */}
        {!loading && error === null && !empty && (
          <span data-testid={`${testId}-hint`}>
            {' '}
            Drag to pan, scroll to zoom, click a node to inspect it — or use the controls above.
          </span>
        )}
      </p>
    </section>
  );
}
