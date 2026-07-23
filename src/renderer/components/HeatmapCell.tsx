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
  /**
   * When true the cell fills its container (`block`, full width, a fixed row height) instead of
   * being a fixed 16 px square. §6.5's Rhythm heatmap uses this so its grid grows with the window
   * (user request 2026-07-23); §6.3's calendar keeps the fixed square that a week grid needs.
   */
  fill?: boolean;
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
  fill = false,
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
      // ⚠️ The cell carries its OWN box — `inline-block`/`block` — rather than inherit one from
      // whatever formatting context a caller provides. A bare `<span>` is `display: inline`, and
      // `width`/`height` do not apply to a non-replaced inline box, so a fixed size would be
      // silently ignored and the cell would lay out at 2 × 20 px on the line box — a chart that
      // renders no marks over real data, the visual form of the silently wrong number (§1, §6.12).
      'rounded-sm border border-border transition-colors duration-hover',
      // `fill` grows the cell to its container (Rhythm heatmap, full-width grid); the default is a
      // fixed 16 px square (activity calendar's week grid).
      fill ? 'block h-5 w-full' : 'inline-block size-4',
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
