/**
 * §6.3 — the Activity calendar heatmap. These assertions pin the four user-reported bugs and the
 * §6.12 / P-30 rules the fix must not regress:
 *   · all seven weekdays are represented on the Y axis (not the truncated {Mon,Wed,Fri});
 *   · month labels appear along the top, one per month boundary, in the right columns;
 *   · the grid fills its container width — fractional tracks, never a fixed pixel width;
 *   · clicking a day opens the inspector with the date in words and the day's message count;
 *   · the grid is anchored on the LAST OBSERVED day, never on the run date (`Date.now()`);
 *   · a pre-transcript (partial) day keeps its treatment and a click never claims a real zero;
 *   · the grid is keyboard-navigable — arrow keys move, Enter activates.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ActivityCalendar } from '../../../src/shared/ipc-contract';
import {
  CalendarHeatmap,
  formatDayInWords,
  monthColumnLabels,
} from '../../../src/renderer/views/charts/CalendarHeatmap';

const WEEKS = 26;

afterEach(cleanup);

/**
 * A calendar whose last observed day is a FIXED date well in the past relative to any plausible
 * run date, so "anchored on the last observed day, not today" is testable. Spans several months
 * so the X axis has month boundaries to place. `partialBefore` is off unless a test sets it.
 */
function calendar(lastDay: string, count = 5): ActivityCalendar {
  // One observed day near the start of the window and one at the anchor; the window is filled by
  // the component. A single count keeps the arithmetic obvious.
  return { days: [{ day: lastDay, messages: count }] };
}

function dayButtons(): HTMLElement[] {
  return screen
    .getAllByRole('gridcell')
    .filter((cell): cell is HTMLButtonElement => cell.hasAttribute('data-day'));
}

describe('§6.3 calendar — Y axis (the reported bug)', () => {
  it('represents all seven weekdays, not just Mon/Wed/Fri', () => {
    render(<CalendarHeatmap calendar={calendar('2026-06-15')} weeks={WEEKS} />);
    const axis = screen.getByTestId('calendar-weekdays');
    for (const label of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      expect(axis).toHaveTextContent(label);
    }
    // The specific regression: the days the old every-other rule dropped are present now.
    expect(axis).toHaveTextContent('Sun');
    expect(axis).toHaveTextContent('Tue');
    expect(axis).toHaveTextContent('Thu');
    expect(axis).toHaveTextContent('Sat');
  });
});

describe('§6.3 calendar — X axis month labels', () => {
  it('renders month names along the top spanning ≥ 2 boundaries', () => {
    render(<CalendarHeatmap calendar={calendar('2026-06-15')} weeks={WEEKS} />);
    const months = screen.getByTestId('calendar-months');
    // A 26-week window ending 2026-06-15 starts in December 2025, so several months appear.
    const present = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'].filter((name) =>
      (months.textContent ?? '').includes(name),
    );
    expect(present.length).toBeGreaterThanOrEqual(2);
  });

  it('places one label per month boundary, in the column where the month begins', () => {
    // Hand-checked fixture: three columns whose first days fall in Feb, Feb, Mar. The label
    // appears on the FIRST column of each new month and nowhere else (§6.3).
    const cells = [
      { key: 'a', day: '2026-02-01', value: 0, partial: false },
      ...Array.from({ length: 6 }, (_u, i) => ({
        key: `a${String(i)}`,
        day: `2026-02-0${String(i + 2)}`,
        value: 0,
        partial: false,
      })),
      { key: 'b', day: '2026-02-08', value: 0, partial: false },
      ...Array.from({ length: 6 }, (_u, i) => ({
        key: `b${String(i)}`,
        day: `2026-02-${String(i + 9).padStart(2, '0')}`,
        value: 0,
        partial: false,
      })),
      { key: 'c', day: '2026-03-01', value: 0, partial: false },
      ...Array.from({ length: 6 }, (_u, i) => ({
        key: `c${String(i)}`,
        day: `2026-03-0${String(i + 2)}`,
        value: 0,
        partial: false,
      })),
    ];
    expect(monthColumnLabels(cells, 3)).toEqual(['Feb', null, 'Mar']);
  });
});

describe('§6.3 calendar — full width (the reported bug)', () => {
  it('lays the weeks out on fractional tracks, not a fixed pixel width', () => {
    render(<CalendarHeatmap calendar={calendar('2026-06-15')} weeks={WEEKS} />);
    const grid = screen.getByTestId('calendar-grid');
    expect(grid.style.gridTemplateColumns).toContain('1fr');
    // A fixed cell grid would pin a pixel width on the grid; a full-width one must not.
    expect(grid.style.width).toBe('');
    expect(grid.style.gridTemplateColumns).not.toMatch(/\d+px/);
  });
});

describe('§6.3 calendar — clicking a day (the reported bug)', () => {
  it('opens the inspector with the date in words and the day’s message count', () => {
    render(<CalendarHeatmap calendar={calendar('2026-06-15', 5489)} weeks={WEEKS} />);
    // Before any click, a discoverable prompt — never a stray zero.
    expect(screen.getByTestId('calendar-day-detail')).toHaveTextContent(
      'Select a day to see its activity',
    );

    const anchor = screen.getByRole('gridcell', { name: /Monday, 15 June 2026/ });
    fireEvent.click(anchor);

    const detail = screen.getByTestId('calendar-day-value');
    expect(detail).toHaveTextContent('Monday, 15 June 2026');
    expect(detail).toHaveTextContent('5,489 messages');
  });

  it('formats the date in words deterministically', () => {
    expect(formatDayInWords('2026-07-09')).toBe('Thursday, 9 July 2026');
  });

  it('clears the selection', () => {
    render(<CalendarHeatmap calendar={calendar('2026-06-15', 5489)} weeks={WEEKS} />);
    fireEvent.click(screen.getByRole('gridcell', { name: /Monday, 15 June 2026/ }));
    fireEvent.click(screen.getByTestId('calendar-day-clear'));
    expect(screen.getByTestId('calendar-day-detail')).toHaveTextContent(
      'Select a day to see its activity',
    );
  });
});

describe('§6.3 calendar — anchored on the last observed day, never today', () => {
  it('draws the window ending on the last observed day, with nothing after it', () => {
    // The run date is well after this; a today-anchored grid would include July 2026 cells.
    render(<CalendarHeatmap calendar={calendar('2026-06-15')} weeks={WEEKS} />);
    const days = dayButtons()
      .map((cell) => cell.getAttribute('data-day') ?? '')
      .filter((day) => day !== '');

    expect(days).toContain('2026-06-15');
    const latest = days.reduce((max, day) => (day > max ? day : max), days[0] ?? '');
    expect(latest).toBe('2026-06-15');
    // No cell for a date after the anchor — in particular none in the run month.
    expect(days.every((day) => day <= '2026-06-15')).toBe(true);
  });
});

describe('§6.12 calendar — partial (pre-transcript) days', () => {
  it('keeps the partial treatment and a click never claims a real zero', () => {
    // A boundary inside the window: days before it are prompts-only, suppressed and hatched.
    const partialBefore = new Date(2026, 4, 1).getTime(); // 1 May 2026, local
    render(
      <CalendarHeatmap
        calendar={calendar('2026-06-15')}
        weeks={WEEKS}
        partialBefore={partialBefore}
      />,
    );

    const partialCells = dayButtons().filter(
      (cell) => cell.getAttribute('data-partial') === 'true',
    );
    expect(partialCells.length).toBeGreaterThan(0);
    // The partial cell announces "no data", not a zero (§6.12). Its accessible name comes from
    // the shared cell's own label, so read that.
    const partial = partialCells[0];
    const label = partial?.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/no data/);
    expect(label).not.toMatch(/0 messages/);

    fireEvent.click(partial as HTMLElement);
    const detail = screen.getByTestId('calendar-day-value');
    expect(detail).toHaveTextContent('before transcripts were recorded');
    expect(detail).not.toHaveTextContent('0 messages');
  });
});

describe('§6.12 / P-30 calendar — keyboard navigation', () => {
  it('moves between days with the arrow keys and activates with Enter', () => {
    render(<CalendarHeatmap calendar={calendar('2026-06-15', 5489)} weeks={WEEKS} />);
    const grid = screen.getByTestId('calendar-grid');

    // Focus starts on the anchor (the last observed day), which is the roving tab stop.
    const anchor = screen.getByRole('gridcell', { name: /Monday, 15 June 2026/ });
    act(() => {
      anchor.focus();
    });
    expect(document.activeElement).toBe(anchor);

    // Left moves to the prior week's Monday (7 days earlier): Monday, 8 June 2026.
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    const prior = screen.getByRole('gridcell', { name: /Monday, 8 June 2026/ });
    expect(document.activeElement).toBe(prior);

    // Up moves to the prior day within the column: Sunday, 7 June 2026.
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(
      screen.getByRole('gridcell', { name: /Sunday, 7 June 2026/ }),
    );

    // Enter activates the focused day.
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(screen.getByTestId('calendar-day-value')).toHaveTextContent('Sunday, 7 June 2026');
  });

  it('exposes exactly one roving tab stop', () => {
    render(<CalendarHeatmap calendar={calendar('2026-06-15')} weeks={WEEKS} />);
    const tabbable = dayButtons().filter((cell) => cell.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
  });
});
