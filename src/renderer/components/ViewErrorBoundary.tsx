/**
 * §7.3 — "Renderer errors are caught by one error boundary per view, so a broken chart never
 * blanks the shell."
 *
 * One instance wraps each route element in `routes.tsx`. It is a class component because React
 * has no hook equivalent of `componentDidCatch`, and it deliberately does **not** use React
 * Router's `errorElement`: that only catches errors raised by a data-router's loaders and
 * actions, and the failure this guards against is a render-time throw inside a chart.
 *
 * ⚠️ It renders an `ErrorState`, not an empty view. A view that catches an exception and shows
 * an empty chart has converted a crash into a silently wrong number, which CLAUDE.md §1 rates
 * as the worse of the two.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type { AppError } from '../../shared/ipc-contract';
import { ErrorState } from './ErrorState';

interface ViewErrorBoundaryProps {
  /** The view id (§6.2), so the boundary can say which view failed. */
  viewId: string;
  children: ReactNode;
}

interface ViewErrorBoundaryState {
  error: AppError | null;
}

export class ViewErrorBoundary extends Component<ViewErrorBoundaryProps, ViewErrorBoundaryState> {
  override state: ViewErrorBoundaryState = { error: null };

  static getDerivedStateFromError(thrown: unknown): ViewErrorBoundaryState {
    // §4.1 — a renderer-side throw is presented with the same shape as an IPC failure, so the
    // UI has exactly one error vocabulary. `retryable: true`: re-mounting the subtree is a
    // legitimate thing to try, and it is the user who triggers it, never the app (§4.1 rule 3).
    return {
      error: {
        code: 'E_INTERNAL',
        message: 'This view could not be displayed.',
        detail: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
        retryable: true,
      },
    };
  }

  override componentDidCatch(thrown: Error, info: ErrorInfo): void {
    // §7.3 — main-process logs go to a file; the renderer has only the console, and it must
    // never carry prompt text or the absolute Claude directory path. A component stack does not.
    console.error(`[view:${this.props.viewId}]`, thrown, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <ErrorState
        error={error}
        onRetry={this.reset}
        data-testid={`view-${this.props.viewId}-error`}
        className="m-6"
      />
    );
  }
}
