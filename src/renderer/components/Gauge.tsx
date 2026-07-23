/**
 * FRONTEND §5 — "Gauge — cache-efficiency; radial, gradient stroke." §6.4 pairs it with "the
 * caption naming the two real numbers".
 *
 * ⚠️ `value` is `number | null` and `null` is not `0`. A gauge with no ratio renders an empty
 * track and the words "not available" — §5.9 M-18 is undefined when there are no tokens at all,
 * and drawing a needle at zero would assert a 0% cache hit rate that was never measured.
 *
 * ⚠️ The percentage is written in the middle **as text**. The arc is a redundant encoding
 * (FRONTEND §8: never encode meaning by colour or shape alone).
 */

import type { JSX, ReactNode } from 'react';
import { formatPercent } from '../lib/format';
import { cx } from '../lib/cx';

export interface GaugeProps {
  /** A ratio in `[0,1]` — §5.9 M-18 `hitRatio`. `null` when the ratio is undefined. */
  value: number | null;
  label: string;
  /** §6.4 — "only X output tokens billed against Y cache reads". Always shown, never a tooltip. */
  caption?: ReactNode;
  /**
   * Decimal places for the percentage text. Defaults to `0`. ⚠️ A near-pinned ratio (cache reads
   * far outweigh input) rounds to a flat "100%" at 0 decimals, which is exactly the "it is always
   * 100 percent" the user reported; one decimal shows the honest 99.9% (§6.4, user directive).
   */
  decimals?: number;
  className?: string;
  'data-testid'?: string;
}

/** Geometry, in the SVG's own unitless viewBox coordinates — not pixels. */
const VIEW_SIZE = 120;
const RADIUS = 48;
const STROKE = 10;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** A three-quarter arc, opening at the bottom: 270° of 360°. */
const ARC_FRACTION = 0.75;

export function Gauge({
  value,
  label,
  caption,
  decimals = 0,
  className,
  'data-testid': testId = 'gauge',
}: GaugeProps): JSX.Element {
  const clamped = value === null ? null : Math.min(1, Math.max(0, value));
  const arcLength = CIRCUMFERENCE * ARC_FRACTION;
  const filled = clamped === null ? 0 : arcLength * clamped;

  return (
    <figure
      data-testid={testId}
      className={cx('flex flex-col items-center gap-2', className)}
      aria-label={label}
    >
      <svg
        viewBox={`0 0 ${String(VIEW_SIZE)} ${String(VIEW_SIZE)}`}
        className="w-40 max-w-full"
        role="img"
        aria-label={
          clamped === null
            ? `${label}: not available`
            : `${label}: ${formatPercent(clamped, decimals)}`
        }
      >
        <defs>
          {/* FRONTEND §2 — the violet→cyan gradient, as a stroke. */}
          <linearGradient id="gauge-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-2)" />
          </linearGradient>
        </defs>
        <g transform={`rotate(135 ${String(VIEW_SIZE / 2)} ${String(VIEW_SIZE / 2)})`}>
          <circle
            cx={VIEW_SIZE / 2}
            cy={VIEW_SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="var(--border)"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${String(arcLength)} ${String(CIRCUMFERENCE)}`}
          />
          {clamped !== null && (
            <circle
              cx={VIEW_SIZE / 2}
              cy={VIEW_SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="url(#gauge-gradient)"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={`${String(filled)} ${String(CIRCUMFERENCE)}`}
            />
          )}
        </g>
        <text
          x={VIEW_SIZE / 2}
          y={VIEW_SIZE / 2 + 6}
          textAnchor="middle"
          className="fill-text-primary text-h3 font-bold"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {clamped === null ? '—' : formatPercent(clamped, decimals)}
        </text>
      </svg>
      <figcaption className="text-center text-small text-text-muted">
        <span
          className="block text-micro uppercase"
          style={{ letterSpacing: 'var(--tracking-micro)' }}
        >
          {label}
        </span>
        {clamped === null ? <span>not available</span> : caption}
      </figcaption>
    </figure>
  );
}
