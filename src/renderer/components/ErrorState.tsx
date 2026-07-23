/**
 * FRONTEND §5, §6.12 — the third mandatory state, and the most important one for this project.
 *
 * ⚠️ Three rules it exists to enforce:
 *   1. **The renderer branches on `code`, never on `message`** (§4.1 rule 2). The heading and
 *      the offered action come from `presentError(error)`; `message` is displayed as prose and
 *      never inspected.
 *   2. **Retry is offered only when `retryable` is true** (§4.1 rule 3). A retry button on a
 *      non-retryable error trains the user to mash it.
 *   3. **`detail` is developer text and renders only behind "Details"** (§4.1). It is never the
 *      headline, and it never reaches the user by default.
 *
 * A failed query renders this — never zeroes, never an EmptyState. "No data" and "we could not
 * find out" are different claims and the user must be able to tell them apart (CLAUDE.md §1).
 */

import type { JSX } from 'react';
import type { AppError } from '../../shared/ipc-contract';
import { presentError } from '../lib/ipc';
import { AlertIcon } from './icons';
import { cx } from '../lib/cx';

export interface ErrorStateProps {
  error: AppError;
  /** Wired to the retry button. Offered only when the error says it may succeed unchanged. */
  onRetry?: () => void;
  className?: string;
  'data-testid'?: string;
}

export function ErrorState({
  error,
  onRetry,
  className,
  'data-testid': testId = 'error-state',
}: ErrorStateProps): JSX.Element {
  const presentation = presentError(error);
  const canRetry = onRetry !== undefined && error.retryable && presentation.action === 'retry';

  return (
    <div
      data-testid={testId}
      data-state="error"
      data-error-code={error.code}
      role="alert"
      className={cx(
        'flex flex-col items-start gap-2 rounded-card border border-border p-6',
        className,
      )}
    >
      <span className="flex items-center gap-2 text-h3 text-danger">
        <AlertIcon aria-hidden="true" />
        <span className="text-body font-semibold text-text-primary">{presentation.title}</span>
      </span>
      <p className="text-small text-text-muted">{error.message}</p>
      {/* FRONTEND §8 / §6.12 — meaning never carried by colour alone: the code is spelled out. */}
      <p className="font-mono text-micro text-text-faint">{error.code}</p>

      {error.detail !== undefined && (
        <details className="w-full">
          <summary className="cursor-pointer text-small text-text-muted">Details</summary>
          <pre className="mt-2 overflow-x-auto rounded-control bg-bg-surface-2 p-3 text-micro text-text-muted">
            {error.detail}
          </pre>
        </details>
      )}

      {canRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-control border border-border px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
        >
          Try again
        </button>
      )}
    </div>
  );
}
