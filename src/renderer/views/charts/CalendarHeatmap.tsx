/**
 * §6.3 — "**Activity** calendar heatmap (26 weeks × 7, violet sequential ramp,
 * `q:activityCalendar`)".
 *
 * Built from E7's `HeatmapCell` primitive (FRONTEND §5 names it for exactly this surface): the
 * cell carries the violet `--seq-*` ramp, the null-vs-zero distinction and the per-day
 * `aria-label`. Here it fills a full-width CSS grid — seven weekday rows, one column per week —
 * so the card spans the §6.2 content grid (max-width 1480) instead of sitting in a fixed box
 * with dead space beside it. The squares grow with the container and stay responsive on resize.
 *
 * ⚠️ **The grid is anchored on the last observed day, never on `Date.now()`.** CLAUDE.md §1:
 * "never default a timestamp to 'now'". The query returns days relative to `MAX(day)` in scope
 * (`q:activityCalendar`), so anchoring anywhere else would draw a window the data does not
 * cover and put empty cells where there is no observation. `Date.now()` must not appear in this
 * file.
 *
 * ⚠️ **Three cell states, and they are not the same** (§6.12):
 *   · a day the query returned      → its message count;
 *   · a day inside the window with no row → `0`, which is *known*: the query scanned the whole
 *     window and returned only days with messages;
 *   · a day before `partialBefore`  → `null` plus hatching. Prompts exist, transcripts do not,
 *     and rendering `0` there would be the "zero where it does not know" defect. A click on such
 *     a day says its detail is unavailable — it never claims a real zero.
 *
 * ⚠️ **Clicking a day opens an inline day inspector, it does NOT set the global date filter.**
 * The payload (`q:activityCalendar`) already carries the per-day message count, so the minimum
 * the user asked for — "click a square → date, stats" — needs no new channel and no contract
 * change. The filter path would additionally require the top-bar date control (another concern's
 * surface) to render and clear an arbitrary single day to be done cleanly; a self-contained
 * inspector answers the request without that cross-cutting change. Plain language throughout
 * (CLAUDE.md §1a): the date reads in words and the count reads "N messages".
 *
 * ⚠️ **A11y** (§6.12, P-30): the grid is a real ARIA grid with roving-tabindex keyboard
 * navigation — arrow keys move between days, Enter/Space open the day. Each day's accessible
 * name carries its date in words and its value; the focus ring is the one declared in
 * `tokens.css`. Meaning is never colour-only — the count travels in the label and the inspector.
 */

import { useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import type { ActivityCalendar } from '../../../shared/ipc-contract';
import { HeatmapCell } from '../../components/HeatmapCell';
import { formatInteger } from '../../lib/format';
import { localDayString } from '../shared/disclosures';

const DAYS_PER_WEEK = 7;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAY_FULL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const MONTH_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export interface CalendarHeatmapProps {
  calendar: ActivityCalendar;
  /** §6.3 — 26 weeks. Passed in so the request and the grid cannot disagree. */
  weeks: number;
  /** §4.3 `DataCoverage.partialBefore`; days before it are suppressed and hatched. */
  partialBefore?: number | null;
  'data-testid'?: string;
}

interface Cell {
  key: string;
  day: string | null;
  value: number | null;
  partial: boolean;
}

/** `YYYY-MM-DD` → a local `Date` at midnight (ADR-021: calendar work is local). */
export function parseLocalDay(day: string): Date {
  const [year, month, date] = day.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
}

/**
 * §1a — the date in words, e.g. "Wednesday, 9 July 2026". Built by hand rather than via
 * `toLocaleDateString` so the wording is deterministic across locales (the test asserts it) and
 * so the on-screen label never depends on the host's date format.
 */
export function formatDayInWords(day: string): string {
  const date = parseLocalDay(day);
  return `${WEEKDAY_FULL[date.getDay()]}, ${String(date.getDate())} ${
    MONTH_FULL[date.getMonth()]
  } ${String(date.getFullYear())}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * The cell sequence, column-first over seven rows. Exported for the same reason the metric
 * arithmetic is: the alignment rule ("the grid starts on the Sunday on or before the window
 * start") is a claim that can be wrong, and a wrong one silently shifts every day by a column.
 */
export function calendarCells(
  calendar: ActivityCalendar,
  weeks: number,
  partialBefore: number | null,
): Cell[] {
  if (calendar.days.length === 0) return [];

  const counts = new Map(calendar.days.map((entry) => [entry.day, entry.messages]));
  const lastDayString = calendar.days.reduce(
    (latest, entry) => (entry.day > latest ? entry.day : latest),
    calendar.days[0]?.day ?? '',
  );
  const last = parseLocalDay(lastDayString);
  const windowStart = addDays(last, -(weeks * DAYS_PER_WEEK - 1));
  const start = addDays(windowStart, -windowStart.getDay());
  const boundary = partialBefore === null ? null : localDayString(partialBefore);

  const cells: Cell[] = [];
  for (let cursor = start; cursor <= last; cursor = addDays(cursor, 1)) {
    const day = localDayString(cursor.getTime());
    const partial = boundary !== null && day < boundary;
    cells.push({
      key: day,
      day,
      value: partial ? null : (counts.get(day) ?? 0),
      partial,
    });
  }
  // Fill the final column so the grid does not reflow its last week.
  const trailing = (DAYS_PER_WEEK - (cells.length % DAYS_PER_WEEK)) % DAYS_PER_WEEK;
  for (let index = 0; index < trailing; index += 1) {
    cells.push({ key: `pad-${String(index)}`, day: null, value: null, partial: false });
  }
  return cells;
}

/**
 * §6.3's X axis — one short month name per month boundary, aligned to the week column where that
 * month first appears. Returns a label (or `null`) per column: the label is shown when the
 * column's first observed day falls in a different month than the previous column's, which over
 * a 26-week window is roughly six labels and never two for the same month.
 */
export function monthColumnLabels(cells: Cell[], columns: number): (string | null)[] {
  const labels: (string | null)[] = new Array<string | null>(columns).fill(null);
  let previousMonth = -1;
  for (let column = 0; column < columns; column += 1) {
    let representative: string | null = null;
    for (let row = 0; row < DAYS_PER_WEEK; row += 1) {
      const cell = cells[column * DAYS_PER_WEEK + row];
      if (cell !== undefined && cell.day !== null) {
        representative = cell.day;
        break;
      }
    }
    if (representative === null) continue;
    const month = parseLocalDay(representative).getMonth();
    if (month !== previousMonth) {
      labels[column] = MONTH_SHORT[month] ?? null;
      previousMonth = month;
    }
  }
  return labels;
}

/** The last cell that carries a real day — the anchor, where keyboard focus starts. */
function initialFocus(cells: Cell[], columns: number): { row: number; column: number } {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (cells[index]?.day !== null) {
      return { row: index % DAYS_PER_WEEK, column: Math.floor(index / DAYS_PER_WEEK) };
    }
  }
  return { row: 0, column: Math.max(0, columns - 1) };
}

export function CalendarHeatmap({
  calendar,
  weeks,
  partialBefore = null,
  'data-testid': testId = 'calendar-heatmap',
}: CalendarHeatmapProps): JSX.Element {
  const cells = calendarCells(calendar, weeks, partialBefore);
  const max = calendar.days.reduce((highest, entry) => Math.max(highest, entry.messages), 0);
  const columns = Math.max(1, Math.ceil(cells.length / DAYS_PER_WEEK));
  const months = monthColumnLabels(cells, columns);

  // Roving-tabindex focus (P-30). Anchored on the last observed day, like the grid itself.
  const [focus, setFocus] = useState(() => initialFocus(cells, columns));
  // Selection is stored as the day string, not a cell object, so a live data update re-derives
  // the inspector from the current cells rather than pinning a stale count (§6.12).
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());

  const cellAt = (row: number, column: number): Cell | undefined =>
    cells[column * DAYS_PER_WEEK + row];
  const refKey = (row: number, column: number): string => `${String(row)}:${String(column)}`;

  const moveFocus = (row: number, column: number): void => {
    if (row < 0 || row >= DAYS_PER_WEEK || column < 0 || column >= columns) return;
    const target = cellAt(row, column);
    if (target === undefined || target.day === null) return; // never land on a pad cell
    setFocus({ row, column });
    cellRefs.current.get(refKey(row, column))?.focus();
  };

  const selectCell = (cell: Cell, row: number, column: number): void => {
    if (cell.day === null) return;
    setFocus({ row, column });
    setSelectedDay(cell.day);
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const { row, column } = focus;
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        moveFocus(row, column + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveFocus(row, column - 1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(row + 1, column);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(row - 1, column);
        break;
      case 'Home':
        event.preventDefault();
        moveFocus(row, 0);
        break;
      case 'End':
        event.preventDefault();
        moveFocus(row, columns - 1);
        break;
      case 'Enter':
      case ' ': {
        // Activate the focused day. Handled explicitly (and default-prevented) rather than left
        // to the button's native activation: it keeps Space from scrolling, works the same under
        // the `role="gridcell"` override, and is the behaviour the keyboard test pins (P-30).
        event.preventDefault();
        const cell = cellAt(row, column);
        if (cell !== undefined) selectCell(cell, row, column);
        break;
      }
      default:
        break;
    }
  };

  const selectedCell = selectedDay === null ? null : cells.find((cell) => cell.day === selectedDay);

  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <div
        className="grid"
        style={{
          gridTemplateColumns: 'max-content minmax(0, 1fr)',
          gridTemplateRows: 'auto auto',
          columnGap: 'var(--space-2)',
          rowGap: 'var(--space-2)',
        }}
      >
        {/* Corner — empty, above the weekday gutter. */}
        <div aria-hidden="true" />

        {/* X axis — month labels, aligned to the week columns (§6.3). Decorative: every cell's
            own label already carries the full date, so the axis is `aria-hidden`. */}
        <div
          aria-hidden="true"
          data-testid="calendar-months"
          className="grid text-micro text-text-faint"
          style={{
            gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
            columnGap: 'var(--space-1)',
            alignItems: 'end',
          }}
        >
          {months.map((label, column) => (
            <span key={column} className="whitespace-nowrap leading-none">
              {label ?? ''}
            </span>
          ))}
        </div>

        {/* Y axis — all seven weekdays, one label per row so the axis reads as a full week rather
            than the truncated Mon/Wed/Fri it showed before. Decorative for the same reason. */}
        <div
          aria-hidden="true"
          data-testid="calendar-weekdays"
          className="grid text-micro text-text-faint"
          style={{
            gridTemplateRows: `repeat(${String(DAYS_PER_WEEK)}, minmax(0, 1fr))`,
            rowGap: 'var(--space-1)',
          }}
        >
          {WEEKDAY_LABELS.map((label) => (
            <span key={label} className="flex items-center justify-end pr-1 leading-none">
              {label}
            </span>
          ))}
        </div>

        {/* The days. A real ARIA grid; the `display: contents` rows keep the semantics without
            disturbing the single CSS grid that lays the cells out full-width. */}
        <div
          role="grid"
          aria-label="Activity by day. Use the arrow keys to move between days and Enter to see a day's activity."
          data-testid="calendar-grid"
          className="grid"
          style={{
            gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${String(DAYS_PER_WEEK)}, auto)`,
            gap: 'var(--space-1)',
          }}
          onKeyDown={onGridKeyDown}
        >
          {Array.from({ length: DAYS_PER_WEEK }, (_unused, row) => (
            <div key={row} role="row" style={{ display: 'contents' }}>
              {Array.from({ length: columns }, (_unused2, column) => {
                const cell = cellAt(row, column);
                if (cell === undefined || cell.day === null) {
                  // A pad cell holds the grid's shape but is not a day (§6.12 — not a zero).
                  return (
                    <div
                      key={`pad-${String(row)}-${String(column)}`}
                      role="gridcell"
                      aria-hidden="true"
                      className="aspect-square w-full"
                    />
                  );
                }
                const isFocusTarget = focus.row === row && focus.column === column;
                const words = formatDayInWords(cell.day);
                return (
                  <button
                    key={cell.key}
                    type="button"
                    role="gridcell"
                    tabIndex={isFocusTarget ? 0 : -1}
                    ref={(node) => {
                      if (node === null) cellRefs.current.delete(refKey(row, column));
                      else cellRefs.current.set(refKey(row, column), node);
                    }}
                    data-day={cell.day}
                    data-partial={cell.partial ? 'true' : undefined}
                    onClick={() => {
                      selectCell(cell, row, column);
                    }}
                    onFocus={() => {
                      setFocus({ row, column });
                    }}
                    className="flex aspect-square w-full rounded-sm border-0 bg-transparent p-0"
                    style={cell.partial ? { backgroundImage: 'var(--hatch)' } : undefined}
                  >
                    {/* The `--seq-*` violet ramp, null-vs-zero and the date-in-words label all
                        come from the shared cell. It fills the grid track (`size-full`) so the
                        square grows with the container; the button derives its accessible name
                        from the cell's own label, so nothing is announced twice. For a partial
                        day the value is `null`, so the label reads "no data" and the hatch shows
                        through the faint empty stop — the click never claims a real zero. */}
                    <HeatmapCell
                      value={cell.value}
                      max={max}
                      bucketLabel={words}
                      unit="messages"
                      ramp="violet"
                      className="size-full!"
                    />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* The day inspector. Always present (so a click never shifts the layout, §6.2) and
          announced politely when it changes (P-30). Plain language only (§1a). */}
      <div
        data-testid="calendar-day-detail"
        aria-live="polite"
        className="flex min-h-9 items-center gap-3 text-small text-text-primary"
      >
        {selectedCell === null || selectedCell === undefined ? (
          <span className="text-text-faint">Select a day to see its activity</span>
        ) : selectedCell.partial ? (
          <span data-testid="calendar-day-value">
            {formatDayInWords(selectedCell.day ?? '')} — before transcripts were recorded, so
            message activity isn&rsquo;t available for this day.
          </span>
        ) : (
          <>
            <span data-testid="calendar-day-value">
              {formatDayInWords(selectedCell.day ?? '')} — {formatInteger(selectedCell.value ?? 0)}{' '}
              {selectedCell.value === 1 ? 'message' : 'messages'}
            </span>
            <button
              type="button"
              aria-label="Clear selected day"
              data-testid="calendar-day-clear"
              onClick={() => {
                setSelectedDay(null);
              }}
              className="rounded-control border border-border px-2 py-1 text-micro text-text-muted transition-colors duration-hover hover:bg-bg-surface-2 hover:text-text-primary"
            >
              Clear
            </button>
          </>
        )}
      </div>
    </div>
  );
}
