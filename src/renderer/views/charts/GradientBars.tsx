/**
 * The horizontal gradient bar list — §6.6's **Tool fingerprint** ("horizontal gradient bars per
 * tool") and §6.5's **Longest marathons** ("rank · date · project · gradient bar · active ·
 * span").
 *
 * ⚠️ Deliberately DOM rather than a chart library, and this is the one place worth saying why:
 * §6.6's loading row is "**Bars animate from zero width once, on first load only**", which is a
 * statement about a single element's entrance. Rendered as text rows with a proportional bar,
 * every label and figure is real text — reachable by a screen reader, by find-in-page and by a
 * test — and the entrance is one `initial → animate` that Framer runs at mount and never again
 * (§6.12). A canvas or an SVG chart would put the labels inside the picture and the animation
 * inside the library's data-diffing.
 *
 * ⚠️ **The hue never carries the meaning** (FRONTEND §8): the label is text beside the bar, and
 * the figure is text after it.
 */

import { motion } from 'framer-motion';
import type { JSX, ReactNode } from 'react';
import { categoricalVar } from '../../lib/colors';
import { cx } from '../../lib/cx';
import { useMotionDisabled } from '../../hooks/use-theme';
import { CHART_DURATION_MS, EASE_OUT, SERIES_STAGGER_MS, seconds } from '../../lib/motion';

export interface GradientBarRow {
  id: string;
  /** A rank, a date — whatever sits before the label. */
  leading?: ReactNode;
  label: ReactNode;
  /** The figures after the bar: a count, an active/span pair. */
  trailing?: ReactNode;
  /** The quantity the bar length encodes. */
  value: number;
  colorIndex: number;
  /** §6.12 — this row's period precedes `partialBefore`; the bar is hatched. */
  partial?: boolean;
}

export interface GradientBarsProps {
  rows: readonly GradientBarRow[];
  /** The denominator. Defaults to the largest value present. */
  max?: number;
  /** Row activation (a marathon day, a tool). Rows become buttons when set. */
  onRowActivate?: (id: string) => void;
  label: string;
  'data-testid'?: string;
}

export function GradientBars({
  rows,
  max,
  onRowActivate,
  label,
  'data-testid': testId = 'gradient-bars',
}: GradientBarsProps): JSX.Element {
  const motionDisabled = useMotionDisabled();
  const denominator = max ?? rows.reduce((highest, row) => Math.max(highest, row.value), 0);

  return (
    <ol data-testid={testId} aria-label={label} className="flex flex-col gap-3">
      {rows.map((row, index) => {
        const share = denominator <= 0 ? 0 : Math.max(0, row.value) / denominator;
        const hue = categoricalVar(row.colorIndex);
        const content = (
          <>
            {row.leading !== undefined && (
              <span className="w-16 shrink-0 text-micro text-text-faint">{row.leading}</span>
            )}
            <span className="w-40 shrink-0 truncate text-small text-text-primary">{row.label}</span>
            <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-pill bg-bg-surface-2">
              <motion.span
                data-testid={`${testId}-bar`}
                aria-hidden="true"
                className="absolute inset-y-0 left-0 origin-left rounded-pill"
                style={{
                  width: `${String(share * 100)}%`,
                  background: hue,
                  backgroundImage: row.partial === true ? 'var(--hatch)' : undefined,
                }}
                // §6.12 / §6.6 — "from zero width once, on first load only". `initial` is the
                // state the element MOUNTS in, so Framer runs this exactly once, at mount, and
                // a re-render with new numbers cannot replay it: the row keeps its key, so it
                // is the same element and only its width changes (`lib/motion.ts`).
                initial={motionDisabled ? false : { scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{
                  duration: seconds(CHART_DURATION_MS),
                  ease: EASE_OUT,
                  delay: seconds(index * SERIES_STAGGER_MS),
                }}
              />
            </span>
            {row.trailing !== undefined && (
              <span className="shrink-0 text-small text-text-muted">{row.trailing}</span>
            )}
          </>
        );

        return (
          <li key={row.id} data-testid={`${testId}-row`}>
            {onRowActivate === undefined ? (
              <span className="flex items-center gap-3">{content}</span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  onRowActivate(row.id);
                }}
                className={cx(
                  'flex w-full items-center gap-3 rounded-control px-1 py-1 text-left',
                  'transition-colors duration-hover hover:bg-bg-surface-2',
                )}
              >
                {content}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
