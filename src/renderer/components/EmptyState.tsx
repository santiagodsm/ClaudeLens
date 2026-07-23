/**
 * FRONTEND §5, §6.12 — one of the three states **every** view must be able to render.
 *
 * ⚠️ "A view that renders zero where it does not know is a defect, not a style choice" (§6.12).
 * An EmptyState is the correct rendering of a *known* absence: the query succeeded and the
 * answer was nothing. It is never a stand-in for a failed query — that is `ErrorState` — and
 * never a stand-in for an in-flight one — that is `LoadingState`.
 *
 * `reason` is required and must name what is missing, in the words of the view: §6.4 asks for
 * "no assistant events in this range", not "No data".
 */

import type { JSX, ReactNode } from 'react';
import { InboxIcon } from './icons';
import { cx } from '../lib/cx';

export interface EmptyStateProps {
  /** What is absent, named concretely. */
  reason: string;
  /** Optional second line: what would make it non-empty. */
  hint?: string;
  /** A single call to action, e.g. "Choose a directory" or "Widen the date range". */
  action?: ReactNode;
  /** Rendered instead of the default inbox glyph. */
  icon?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

export function EmptyState({
  reason,
  hint,
  action,
  icon,
  className,
  'data-testid': testId = 'empty-state',
}: EmptyStateProps): JSX.Element {
  return (
    <div
      data-testid={testId}
      data-state="empty"
      role="status"
      className={cx(
        'flex flex-col items-center justify-center gap-3 px-6 py-10 text-center',
        className,
      )}
    >
      <span className="text-h2 text-text-faint" aria-hidden="true">
        {icon ?? <InboxIcon />}
      </span>
      <p className="text-body text-text-primary">{reason}</p>
      {hint !== undefined && <p className="text-small text-text-muted">{hint}</p>}
      {action !== undefined && <div className="pt-1">{action}</div>}
    </div>
  );
}
