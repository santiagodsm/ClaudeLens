/**
 * FRONTEND §5, §6.12 — the second of the three mandatory states.
 *
 * Two shapes, and the difference is load-bearing:
 *   · `variant="skeleton"` (default) — a shaped placeholder for a card that has never had data.
 *     It occupies the final layout so nothing jumps when the payload lands (§6.2: no push event
 *     triggers a layout animation).
 *   · `variant="inline"` — a small spinner for a control. Used by the Refresh button, which
 *     §6.2 names as **the only thing that moves while idle**.
 *
 * ⚠️ A skeleton is never shown over data that is already on screen. `useQuery` returns
 * `loading: true` with `data !== null` during a refresh precisely so the view can keep the old
 * numbers and update them in place.
 */

import type { JSX } from 'react';
import { cx } from '../lib/cx';

export interface LoadingStateProps {
  variant?: 'skeleton' | 'inline';
  /** Number of skeleton bars. Match the card's real row count so the layout does not shift. */
  lines?: number;
  /** §4.4 sync progress, `0..1`. Rendered as a percentage; omit when there is nothing to report. */
  progress?: number | null;
  /** Screen-reader text. Always says what is loading, never just "Loading". */
  label?: string;
  className?: string;
  'data-testid'?: string;
}

export function LoadingState({
  variant = 'skeleton',
  lines = 3,
  progress = null,
  label = 'Loading',
  className,
  'data-testid': testId = 'loading-state',
}: LoadingStateProps): JSX.Element {
  if (variant === 'inline') {
    return (
      <span
        data-testid={testId}
        data-state="loading"
        role="status"
        aria-live="polite"
        aria-label={label}
        className={cx('inline-flex items-center gap-2 text-small text-text-muted', className)}
      >
        <Spinner />
        {progress !== null && <span>{Math.round(progress * 100)}%</span>}
      </span>
    );
  }

  return (
    <div
      data-testid={testId}
      data-state="loading"
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cx('flex flex-col gap-3 p-6', className)}
    >
      {Array.from({ length: lines }, (_unused, index) => (
        <div
          key={index}
          className="h-3 rounded-control bg-bg-surface-2"
          style={{ width: `${String(96 - index * 12)}%` }}
        />
      ))}
      {progress !== null && (
        <p className="text-small text-text-muted">{Math.round(progress * 100)}% parsed</p>
      )}
    </div>
  );
}

/**
 * The one permanently-animating element in the app (§6.2). It spins only while it is mounted,
 * which is only while something is genuinely in flight.
 *
 * `animate-spin` is a CSS animation, so `prefers-reduced-motion` handling is the token layer's
 * `@media` block, not a prop — a progress spinner is *essential* feedback and P-31 disables
 * "non-essential" animation, so this one keeps a slow rotation rather than stopping dead.
 */
export function Spinner(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className="motion-safe:animate-spin"
      data-testid="spinner"
    >
      <circle cx="12" cy="12" r="9" stroke="var(--border)" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="var(--accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
