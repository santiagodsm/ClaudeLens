/**
 * FRONTEND §5 — "Heatmap cell — calendar + hour×weekday; sequential single-hue scale (violet
 * ramp), tooltip on hover." Used by §6.3's activity calendar and §6.5's rhythm heatmap.
 *
 * ⚠️ A cell with **no observation** and a cell with **zero events** are different cells and must
 * look different: `value: null` renders the empty track, `value: 0` renders the lowest occupied
 * stop. Collapsing them is the "renders zero where it does not know" defect of §6.12.
 *
 * ⚠️ The hover tooltip is a *supplement*. The exact count is also in the cell's `aria-label` and
 * in `title`, so the value is reachable without a pointer (P-30) — and no number this app shows
 * exists only inside a tooltip (INV-10).
 */

import type { JSX } from 'react';
import type { SequentialRamp } from '../lib/colors';
import { sequentialVar } from '../lib/colors';
import { cx } from '../lib/cx';
import { formatInteger } from '../lib/format';

export interface HeatmapCellProps {
  /** The raw count. `null` = no observation for this bucket. */
  value: number | null;
  /** The largest value in the same heatmap, used to normalise. `0` renders every cell empty. */
  max: number;
  /** Human-readable bucket, e.g. "Tue 14:00" or "2026-03-04". */
  bucketLabel: string;
  /** What is being counted, e.g. "events". */
  unit?: string;
  /** §6.3's calendar is violet, §6.5's rhythm heatmap is cyan. Magnitude either way. */
  ramp?: SequentialRamp;
  onClick?: () => void;
  className?: string;
  'data-testid'?: string;
}

export function HeatmapCell({
  value,
  max,
  bucketLabel,
  unit = 'events',
  ramp = 'violet',
  onClick,
  className,
  'data-testid': testId = 'heatmap-cell',
}: HeatmapCellProps): JSX.Element {
  const intensity = value === null || max <= 0 ? 0 : value / max;
  const background = value === null ? sequentialVar(0, ramp) : sequentialVar(intensity, ramp);
  const description =
    value === null ? `${bucketLabel}: no data` : `${bucketLabel}: ${formatInteger(value)} ${unit}`;

  const shared = {
    'data-testid': testId,
    'data-empty': value === null ? 'true' : undefined,
    title: description,
    'aria-label': description,
    style: { background },
    className: cx(
      // ⚠️ `inline-block` is load-bearing, not decoration. A bare `<span>` is `display: inline`,
      // and `width`/`height` do not apply to a non-replaced inline box — so `size-4` was silently
      // ignored and the cell laid out at 2 × 20 px (its two 1 px borders, on the line box). §6.5's
      // Rhythm heatmap puts this component straight into a `<td>` and rendered an empty grid;
      // §6.3's calendar only looked correct because `CalendarHeatmap` happens to wrap each cell in
      // an `inline-flex` span, which blockifies the child. The cell must carry its own box rather
      // than inherit one from whatever formatting context a caller happens to provide — a chart
      // that renders no marks over real data is the visual form of the silently wrong number
      // (CLAUDE.md §1, §6.12).
      'inline-block size-4 rounded-sm border border-border transition-colors duration-hover',
      value === null && 'border-dashed',
      className,
    ),
  };

  return onClick === undefined ? (
    <span role="img" {...shared} />
  ) : (
    <button type="button" onClick={onClick} {...shared} />
  );
}
