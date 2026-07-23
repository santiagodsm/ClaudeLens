/**
 * §6.5 — "**Rhythm** (hour × weekday heatmap, cyan sequential)".
 *
 * E7's `HeatmapCell` primitive again (FRONTEND §5 names "calendar + hour×weekday" together),
 * with the **cyan** ramp §6.5 specifies. Seven rows, twenty-four columns, local weekday and
 * local hour (ADR-021) exactly as `q:rhythmHeatmap` returns them: `weekday` is SQLite's `%w`,
 * `0` = Sunday.
 *
 * A `(weekday, hour)` the payload omits is a **known** zero — the query groups every event in
 * scope — so it renders as the lowest occupied stop, not as "no observation". Distinguishing
 * the two is §6.12's rule; asserting the wrong one of them is equally a defect.
 */

import type { JSX } from 'react';
import type { RhythmHeatmap as RhythmHeatmapPayload } from '../../../shared/ipc-contract';
import { HeatmapCell } from '../../components/HeatmapCell';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const HOURS = 24;

export interface RhythmHeatmapProps {
  rhythm: RhythmHeatmapPayload;
  'data-testid'?: string;
}

export function RhythmHeatmap({
  rhythm,
  'data-testid': testId = 'rhythm-heatmap',
}: RhythmHeatmapProps): JSX.Element {
  const counts = new Map(
    rhythm.cells.map((cell) => [`${String(cell.weekday)}:${String(cell.hour)}`, cell.events]),
  );
  const max = rhythm.cells.reduce((highest, cell) => Math.max(highest, cell.events), 0);

  return (
    // §6.5 — the grid grows to fill the view (user request 2026-07-23). `table-fixed` + `w-full`
    // splits the 24 hour columns evenly across whatever width is available; the narrow weekday
    // column is pinned so it does not steal an equal share. A min-width keeps the cells legible on
    // a very narrow window, where the wrapper scrolls rather than crush them to nothing.
    <div className="overflow-x-auto" data-testid={testId}>
      <table
        className="w-full min-w-[32rem] table-fixed border-separate"
        style={{ borderSpacing: 'var(--space-1)' }}
      >
        <caption className="sr-only">Events by local weekday and hour of day</caption>
        <thead>
          <tr>
            <th scope="col" className="w-8 text-micro font-normal text-text-faint">
              <span className="sr-only">Weekday</span>
            </th>
            {Array.from({ length: HOURS }, (_unused, hour) => (
              <th
                key={hour}
                scope="col"
                className="text-micro font-normal text-text-faint"
                aria-label={`${String(hour)}:00`}
              >
                {hour % 6 === 0 ? String(hour) : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WEEKDAY_LABELS.map((label, weekday) => (
            <tr key={label}>
              <th scope="row" className="pr-2 text-micro font-normal text-text-faint">
                {label}
              </th>
              {Array.from({ length: HOURS }, (_unused, hour) => (
                <td key={hour}>
                  <HeatmapCell
                    value={counts.get(`${String(weekday)}:${String(hour)}`) ?? 0}
                    max={max}
                    bucketLabel={`${label} ${String(hour).padStart(2, '0')}:00`}
                    unit="events"
                    ramp="cyan"
                    fill
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
