/**
 * FRONTEND §5 — "titled container: header (title + optional legend + control) · chart body ·
 * footer note. Consistent padding (24), radius 16, animates in."
 *
 * The card owns the four states so no chart has to (§6.12). Pass `loading` / `error` / `empty`
 * and it renders the right one; pass `children` and it renders the chart. That is what makes
 * "every view must have all three" cheap enough that no one skips it.
 *
 * ⚠️ `loading` with `children` already rendered is a **refresh in place**: the card keeps the
 * chart and shows a small inline spinner in the header. It does not swap in a skeleton, because
 * §6.2 forbids a push event from causing a layout change.
 */

import { motion } from 'framer-motion';
import type { JSX, ReactNode } from 'react';
import type { AppError } from '../../shared/ipc-contract';
import { cx } from '../lib/cx';
import { useEntrance } from '../lib/motion';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { LoadingState } from './LoadingState';

export interface ChartCardProps {
  title: string;
  /** Optional subtitle under the title — the standing notes of §6.4, for instance. */
  subtitle?: string;
  /** Interactive legend or segmented control, right-aligned in the header (FRONTEND §5/§6). */
  control?: ReactNode;
  legend?: ReactNode;
  /** The footer note: a metric caveat, a definition, a "showing top N" label. */
  footer?: ReactNode;
  /** §6.12 — the disclosure that qualifies whatever number the chart shows. Never a tooltip. */
  disclosure?: ReactNode;

  loading?: boolean;
  error?: AppError | null;
  /** `true` means the query succeeded and returned nothing (§6.12). */
  empty?: boolean;
  /** Named concretely, in the view's own words: "no assistant events in this range". */
  emptyReason?: string;
  onRetry?: () => void;

  /** Entrance stagger position (FRONTEND §7). First mount only (§6.12). */
  index?: number;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  'data-testid'?: string;
}

export function ChartCard({
  title,
  subtitle,
  control,
  legend,
  footer,
  disclosure,
  loading = false,
  error = null,
  empty = false,
  emptyReason = 'Nothing in this range',
  onRetry,
  index = 0,
  children,
  className,
  bodyClassName,
  'data-testid': testId = 'chart-card',
}: ChartCardProps): JSX.Element {
  const entrance = useEntrance(index);
  const hasChildren = children !== undefined && children !== null;
  const refreshingInPlace = loading && hasChildren;

  return (
    <motion.section
      {...entrance}
      data-testid={testId}
      aria-label={title}
      className={cx(
        'flex flex-col rounded-card border border-border bg-bg-surface shadow-card',
        className,
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 p-6 pb-3">
        <div>
          <h2 className="text-h3 font-semibold text-text-primary">{title}</h2>
          {subtitle !== undefined && <p className="mt-1 text-small text-text-muted">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-3">
          {refreshingInPlace && <LoadingState variant="inline" label={`Refreshing ${title}`} />}
          {legend}
          {control}
        </div>
      </header>

      <div className={cx('min-h-0 flex-1 px-6', bodyClassName)}>
        {error !== null ? (
          <ErrorState error={error} onRetry={onRetry} className="border-0" />
        ) : loading && !hasChildren ? (
          <LoadingState label={`Loading ${title}`} />
        ) : empty ? (
          <EmptyState reason={emptyReason} />
        ) : (
          children
        )}
      </div>

      {/* INV-10 — the disclosure sits with the number, above the decorative footer note. */}
      {disclosure !== undefined && (
        <p data-testid={`${testId}-disclosure`} className="px-6 pt-3 text-small text-text-muted">
          {disclosure}
        </p>
      )}
      {footer !== undefined && (
        <p className="px-6 pt-3 pb-6 text-small text-text-faint">{footer}</p>
      )}
      {footer === undefined && <div className="pb-6" />}
    </motion.section>
  );
}
