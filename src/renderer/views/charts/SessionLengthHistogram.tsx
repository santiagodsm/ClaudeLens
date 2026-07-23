/**
 * §6.5 — "**Session length distribution** (histogram by active time, **M-07 binding (A)** — one
 * bucket per session)".
 *
 * Recharts (STACK ADR-011 — "standard chart types (stacked areas, bars, histogram)").
 *
 * ⚠️ The binding is in the card's own subtitle, not only in this comment: a histogram of
 * "session length" that silently used the working-day partition would be a different chart
 * wearing the same title (§5.9 M-07, ADR-036). The caller states it; this component counts
 * whatever `q:sessionHistogram` returns, which is binding (A) by construction.
 *
 * **The histogram is a filter control.** Clicking a bar (pointer) or activating its bucket
 * button (keyboard / assistive tech) hands the bucket back to the caller, which narrows the
 * sessions table below to the sessions of that active-time range. Recharts bars are the pointer
 * target; the accessible list beneath — one native `<button>` per bucket — is the keyboard and
 * screen-reader path, and is the copy of the bucket table in words (FRONTEND §8), not merely a
 * mirror of the picture.
 */

import { useId } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SessionHistogram } from '../../../shared/ipc-contract';
import { formatInteger } from '../../lib/format';

const CHART_HEIGHT = 240;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

/** One bucket of `q:sessionHistogram` — a range of active seconds and how many sessions fall in it. */
export type SessionHistogramBucket = SessionHistogram['buckets'][number];

/**
 * The bucket's active-time range, in plain words — never a bucket id and never a channel name
 * (§1a). "under 15 minutes" · "lasting 2 to 4 hours" · "of 8 hours or more". Both the chip on the
 * sessions table and the bucket buttons read from this one function so they never drift.
 */
export function bucketRangePhrase(lowerSeconds: number, upperSeconds: number | null): string {
  if (upperSeconds === null) return `of ${plainDuration(lowerSeconds)} or more`;
  if (lowerSeconds === 0) return `under ${plainDuration(upperSeconds)}`;
  // When both bounds are the same unit, say the unit once: "15 to 30 minutes", "2 to 4 hours".
  const lowerUnit = unitOf(lowerSeconds);
  const upperUnit = unitOf(upperSeconds);
  if (lowerUnit === upperUnit) {
    const low = amountIn(lowerSeconds, lowerUnit);
    return `lasting ${String(low)} to ${plainDuration(upperSeconds)}`;
  }
  return `lasting ${plainDuration(lowerSeconds)} to ${plainDuration(upperSeconds)}`;
}

/** A whole number of hours or minutes, spelled out: `900 → "15 minutes"`, `7200 → "2 hours"`. */
function plainDuration(seconds: number): string {
  const unit = unitOf(seconds);
  const amount = amountIn(seconds, unit);
  return `${String(amount)} ${unit}${amount === 1 ? '' : 's'}`;
}

function unitOf(seconds: number): 'hour' | 'minute' {
  return seconds >= SECONDS_PER_HOUR && seconds % SECONDS_PER_HOUR === 0 ? 'hour' : 'minute';
}

function amountIn(seconds: number, unit: 'hour' | 'minute'): number {
  return unit === 'hour' ? seconds / SECONDS_PER_HOUR : Math.round(seconds / SECONDS_PER_MINUTE);
}

export interface SessionLengthHistogramProps {
  histogram: SessionHistogram;
  /** Bar / bucket-button activation. When set, the histogram becomes a filter control. */
  onSelectBucket?: (bucket: SessionHistogramBucket) => void;
  /** The lower bound of the currently selected bucket, so the chosen bar reads as chosen. */
  selectedLowerSeconds?: number | null;
  'data-testid'?: string;
}

export function SessionLengthHistogram({
  histogram,
  onSelectBucket,
  selectedLowerSeconds = null,
  'data-testid': testId = 'session-histogram',
}: SessionLengthHistogramProps): JSX.Element {
  const gradientId = useId();
  const hasSelection = selectedLowerSeconds !== null;

  // Enter / Space activate the focused bucket button, exactly as `DataTable` does for its rows.
  // `preventDefault` keeps Space from scrolling and stops the native second activation, so the
  // filter fires once (P-30 — full keyboard navigation, §6.12 focus-visible rings come for free
  // from `tokens.css`).
  const onBucketKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    bucket: SessionHistogramBucket,
  ): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelectBucket?.(bucket);
  };

  return (
    <div data-testid={testId}>
      <div style={{ height: CHART_HEIGHT }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={histogram.buckets}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" />
                <stop offset="100%" stopColor="var(--accent-2)" />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" stroke="var(--text-muted)" tickLine={false} axisLine={false} />
            <YAxis
              stroke="var(--text-muted)"
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--bg-surface-2)',
                borderRadius: 'var(--radius-control)',
                boxShadow: 'var(--shadow)',
                color: 'var(--text-primary)',
              }}
              formatter={(value) => [
                typeof value === 'number' ? formatInteger(value) : String(value ?? '—'),
                'sessions',
              ]}
            />
            <Bar
              dataKey="count"
              name="sessions"
              radius={4}
              // ⚠️ §6.12 — Recharts replays its bar animation on every data change, which is
              // exactly what "a live data update never re-animates a chart" forbids. The
              // entrance belongs to the card (Framer, mount-only); the bars update in place.
              isAnimationActive={false}
            >
              {histogram.buckets.map((bucket) => {
                const selected = hasSelection && bucket.lowerSeconds === selectedLowerSeconds;
                return (
                  <Cell
                    key={bucket.label}
                    fill={`url(#${gradientId})`}
                    // A selection dims the other bars so the chosen one reads as chosen — a
                    // redundant cue only: the chip below names the bucket in words, so meaning is
                    // never carried by opacity alone (FRONTEND §8).
                    fillOpacity={!hasSelection || selected ? 1 : 0.3}
                    cursor={onSelectBucket === undefined ? undefined : 'pointer'}
                    onClick={
                      onSelectBucket === undefined
                        ? undefined
                        : () => {
                            onSelectBucket(bucket);
                          }
                    }
                  />
                );
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* The bucket table in words. Non-interactive when the caller wants no filter; a list of
          native buttons — the keyboard and screen-reader path to the same filter the bars drive —
          when it does. The buttons are visually hidden until focused, so they add the keyboard
          affordance without a second copy of the x-axis on screen. */}
      {onSelectBucket === undefined ? (
        <ul className="sr-only" data-testid={`${testId}-list`}>
          {histogram.buckets.map((bucket) => (
            <li key={bucket.label}>
              {bucket.label}: {formatInteger(bucket.count)} sessions
            </li>
          ))}
        </ul>
      ) : (
        <ul data-testid={`${testId}-list`} className="flex flex-wrap gap-1">
          {histogram.buckets.map((bucket) => (
            <li key={bucket.label}>
              <button
                type="button"
                disabled={bucket.count === 0}
                data-testid={`${testId}-bucket`}
                onClick={() => {
                  onSelectBucket(bucket);
                }}
                onKeyDown={(event) => {
                  onBucketKeyDown(event, bucket);
                }}
                className="sr-only rounded-control border border-border bg-bg-surface px-2 py-1 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2 focus:not-sr-only disabled:opacity-60"
              >
                Show {formatInteger(bucket.count)} {bucket.count === 1 ? 'session' : 'sessions'}{' '}
                {bucketRangePhrase(bucket.lowerSeconds, bucket.upperSeconds)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
