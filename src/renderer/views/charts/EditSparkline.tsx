/**
 * §6.8 — "a **files-touched** sparkline (12 buckets of **edit counts**, M-15)".
 *
 * ⚠️ **Labelled "edits", never "lines changed"** (§1.6 non-goal 3, M-15: "Never called churn,
 * never presented as lines changed"). The unit is written into this component so a caller
 * cannot relabel it, and no diff is rendered anywhere in this application.
 *
 * ⚠️ **A project with events but no file touches shows a sentence, not an empty sparkline**
 * (§6.8 degraded row). An all-zero sparkline draws a flat line along the axis, which reads as
 * "no edits" only if you already know the chart is populated.
 */

import type { JSX } from 'react';
import { formatInteger } from '../../lib/format';
import { categoricalVar } from '../../lib/colors';

/** Unitless: the SVG stretches to its box, which is exactly what a sparkline should do. */
const VIEW_WIDTH = 100;
const VIEW_HEIGHT = 24;
const BAR_GAP = 1;

/** §6.8's own words for the degraded case. */
export const NO_EDITS_SENTENCE = 'no file edits recorded in this range';

export interface EditSparklineProps {
  /** `ProjectCard.editSparkline` — 12 buckets of edit counts over the filtered range. */
  buckets: readonly number[];
  colorIndex: number;
  'data-testid'?: string;
}

export function EditSparkline({
  buckets,
  colorIndex,
  'data-testid': testId = 'edit-sparkline',
}: EditSparklineProps): JSX.Element {
  const total = buckets.reduce((sum, value) => sum + value, 0);
  if (buckets.length === 0 || total === 0) {
    return (
      <p data-testid={`${testId}-empty`} className="text-small text-text-muted">
        {NO_EDITS_SENTENCE}
      </p>
    );
  }

  const max = buckets.reduce((highest, value) => Math.max(highest, value), 0);
  const slot = VIEW_WIDTH / buckets.length;
  const hue = categoricalVar(colorIndex);

  return (
    <svg
      data-testid={testId}
      viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
      preserveAspectRatio="none"
      className="h-6 w-full"
      role="img"
      aria-label={`${formatInteger(total)} edits across ${String(buckets.length)} buckets`}
    >
      {buckets.map((value, index) => {
        const height = max === 0 ? 0 : (value / max) * VIEW_HEIGHT;
        return (
          <rect
            key={index}
            x={index * slot}
            y={VIEW_HEIGHT - height}
            width={Math.max(0, slot - BAR_GAP)}
            height={height}
            fill={hue}
            fillOpacity={0.8}
          />
        );
      })}
    </svg>
  );
}
