/**
 * The nine primitives (FRONTEND §5, §6.1) and the three mandatory states (§6.12).
 *
 * The assertions that matter here are the design rules, not the markup:
 *   · every primitive can render loading, empty and error;
 *   · `StatTile` puts its disclosure directly beneath the number, in the DOM, not in a tooltip;
 *   · a `null` value is never rendered as `0`;
 *   · `Badge` severity pairs colour with the severity word;
 *   · `DataTable` is keyboard navigable and enforces the P-28 row cap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useAppStore } from '../../src/renderer/store/app-store';
import type { AppError } from '../../src/shared/ipc-contract';
import { Badge, Pill, SeverityBadge } from '../../src/renderer/components/Badge';
import { ChartCard } from '../../src/renderer/components/ChartCard';
import { DataTable } from '../../src/renderer/components/DataTable';
import { EmptyState } from '../../src/renderer/components/EmptyState';
import { ErrorState } from '../../src/renderer/components/ErrorState';
import { Gauge } from '../../src/renderer/components/Gauge';
import { GraphCanvas } from '../../src/renderer/components/GraphCanvas';
import { HeatmapCell } from '../../src/renderer/components/HeatmapCell';
import { LoadingState } from '../../src/renderer/components/LoadingState';
import { StatTile, UNKNOWN_VALUE_LABEL } from '../../src/renderer/components/StatTile';
import { ViewErrorBoundary } from '../../src/renderer/components/ViewErrorBoundary';
import { MAX_RENDERED_ROWS } from '../../src/renderer/lib/limits';

// P-31 — these assertions are about the DOM the design specifies, not about the animation
// clock. Running them with the `reduceMotionOverride: 'reduce'` setting exercises the real
// P-31 path AND removes the mid-flight `opacity: 0` that an entrance animation legitimately
// puts on a card for its first frame. The motion-on path is covered by `entranceProps` in
// ipc.test.tsx and by the shell suite.
beforeEach(() => {
  useAppStore.setState({ reduceMotion: 'reduce' });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ reduceMotion: 'system' });
});

const RETRYABLE: AppError = {
  code: 'E_DB_BUSY',
  message: 'The database is busy.',
  detail: 'SQLITE_BUSY',
  retryable: true,
};

const TERMINAL: AppError = {
  code: 'E_INTERNAL',
  message: 'That part of the app could not be reached.',
  detail: "no handler registered for 'q:overviewTiles'",
  retryable: false,
};

describe('the three mandatory state components (§6.12)', () => {
  it('EmptyState names what is missing', () => {
    render(<EmptyState reason="no assistant events in this range" hint="Widen the date range" />);
    expect(screen.getByTestId('empty-state')).toHaveAttribute('data-state', 'empty');
    expect(screen.getByText('no assistant events in this range')).toBeInTheDocument();
  });

  it('LoadingState renders a skeleton and an inline spinner', () => {
    const { rerender } = render(<LoadingState lines={4} label="Loading tiles" />);
    expect(screen.getByTestId('loading-state')).toHaveAttribute('data-state', 'loading');
    rerender(<LoadingState variant="inline" progress={0.42} label="Parsing" />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('ErrorState carries the code and hides detail behind Details (§4.1)', () => {
    render(<ErrorState error={TERMINAL} />);
    const state = screen.getByTestId('error-state');
    expect(state).toHaveAttribute('data-error-code', 'E_INTERNAL');
    expect(within(state).getByText('E_INTERNAL')).toBeInTheDocument();
    // `detail` exists in the DOM only inside <details>, never as the headline.
    expect(state.querySelector('details')).not.toBeNull();
  });

  it('offers retry only when the error says it may succeed (§4.1 rule 3)', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState error={TERMINAL} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    rerender(<ErrorState error={RETRYABLE} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('StatTile — INV-10 and §6.12', () => {
  it('renders the disclosure directly beneath the number, in the DOM, not in a tooltip', () => {
    render(
      <StatTile
        label="Total cost"
        value="$412.90"
        disclosure="1,204 records uncosted — the figure is a lower bound"
      />,
    );
    const tile = screen.getByTestId('stat-tile');
    const disclosure = screen.getByTestId('stat-tile-disclosure');
    expect(disclosure).toBeVisible();
    expect(disclosure).toHaveTextContent('1,204 records uncosted');
    // Adjacency: the disclosure follows the value node inside the same tile.
    expect(tile.contains(disclosure)).toBe(true);
    expect(tile).not.toHaveAttribute('title');
    expect(disclosure).not.toHaveAttribute('title');
  });

  it('renders an unknown value as words, never as 0', () => {
    render(<StatTile label="Total cost" value={null} />);
    expect(screen.getByText(UNKNOWN_VALUE_LABEL)).toBeInTheDocument();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.getByTestId('stat-tile').textContent).not.toContain('$0.00');
  });

  it('marks a partial-data range rather than zeroing it (§6.12)', () => {
    render(
      <StatTile label="Active" value="21h 37m" partial disclosure="partial before 2026-01-04" />,
    );
    expect(screen.getByTestId('stat-tile')).toHaveAttribute('data-partial', 'true');
  });
});

describe('ChartCard — all four states from one component', () => {
  it('renders loading, empty, error and content', () => {
    const { rerender } = render(<ChartCard title="Tokens by model" loading />);
    expect(screen.getByTestId('loading-state')).toBeInTheDocument();

    rerender(<ChartCard title="Tokens by model" empty emptyReason="no assistant events" />);
    expect(screen.getByText('no assistant events')).toBeInTheDocument();

    rerender(<ChartCard title="Tokens by model" error={TERMINAL} />);
    expect(screen.getByTestId('error-state')).toBeInTheDocument();

    rerender(
      <ChartCard title="Tokens by model">
        <p>chart</p>
      </ChartCard>,
    );
    expect(screen.getByText('chart')).toBeInTheDocument();
  });

  it('refreshes in place rather than swapping in a skeleton (§6.2)', () => {
    render(
      <ChartCard title="Tokens by model" loading>
        <p>chart</p>
      </ChartCard>,
    );
    expect(screen.getByText('chart')).toBeInTheDocument();
    expect(screen.queryByTestId('loading-state')).not.toBeNull();
    // The inline spinner, not the skeleton: the chart is still on screen.
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });
});

describe('Badge / Pill — FRONTEND §8: meaning is never carried by colour alone', () => {
  it('spells out the severity next to the swatch', () => {
    render(
      <>
        <SeverityBadge severity="high" />
        <SeverityBadge severity="medium" />
        <SeverityBadge severity="low" />
      </>,
    );
    expect(screen.getByTestId('severity-high')).toHaveTextContent('high');
    expect(screen.getByTestId('severity-medium')).toHaveTextContent('medium');
    expect(screen.getByTestId('severity-low')).toHaveTextContent('low');
  });

  it('keeps a model tag in its own hue while still labelling it', () => {
    render(<Badge colorIndex={2}>claude-opus-4-5</Badge>);
    const badge = screen.getByTestId('badge');
    expect(badge).toHaveTextContent('claude-opus-4-5');
    expect(badge.getAttribute('style')).toContain('var(--c3)');
  });

  it('exposes pressed state on an interactive pill', () => {
    const onClick = vi.fn();
    render(
      <Pill onClick={onClick} pressed>
        Bash
      </Pill>,
    );
    const pill = screen.getByTestId('pill');
    expect(pill).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(pill);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('Gauge', () => {
  it('renders the percentage as text as well as an arc', () => {
    render(<Gauge value={0.72} label="Cache efficiency" caption="only 4K billed" />);
    expect(screen.getByText('72%')).toBeInTheDocument();
  });

  it('renders an undefined ratio as "not available", never as 0%', () => {
    render(<Gauge value={null} label="Cache efficiency" />);
    expect(screen.getByText('not available')).toBeInTheDocument();
    expect(screen.queryByText('0%')).toBeNull();
  });
});

describe('HeatmapCell', () => {
  it('distinguishes "no observation" from a measured zero', () => {
    const { rerender } = render(<HeatmapCell value={null} max={10} bucketLabel="Tue 14:00" />);
    expect(screen.getByTestId('heatmap-cell')).toHaveAttribute('data-empty', 'true');
    expect(screen.getByTestId('heatmap-cell')).toHaveAttribute('aria-label', 'Tue 14:00: no data');

    rerender(<HeatmapCell value={0} max={10} bucketLabel="Tue 14:00" />);
    expect(screen.getByTestId('heatmap-cell')).not.toHaveAttribute('data-empty');
    expect(screen.getByTestId('heatmap-cell')).toHaveAttribute('aria-label', 'Tue 14:00: 0 events');
  });

  it('⚠️ carries its OWN box — `size-4` is inert on an inline element', () => {
    // ⚠️ REGRESSION (§6.5, §6.12). The `onClick`-less cell renders a `<span>`, and `display: inline`
    // makes `width`/`height` inert on a non-replaced box: `size-4` was ignored and the cell laid
    // out at 2 × 20 px (two 1 px borders on the line box), measured in Chromium against the built
    // stylesheet. §6.3's calendar looked correct only because `CalendarHeatmap` wraps each cell in
    // an `inline-flex` span, which blockifies the child; §6.5's Rhythm heatmap puts the cell
    // straight into a `<td>` and rendered seven rows of twenty-four invisible cells over correct
    // axes and correct data. A chart that draws no marks over real numbers is the visual form of
    // the silently wrong number (CLAUDE.md §1).
    //
    // jsdom performs no layout, so the box cannot be measured here. What CAN be asserted — and is
    // the actual invariant — is that the cell declares a block-forming display of its own rather
    // than inheriting one from whatever formatting context a caller happens to provide.
    const { rerender } = render(<HeatmapCell value={4} max={10} bucketLabel="Tue 14:00" />);
    const span = screen.getByTestId('heatmap-cell');
    expect(span.tagName).toBe('SPAN');
    expect(span).toHaveClass('inline-block');
    expect(span).toHaveClass('size-4');

    // The clickable variant is a `<button>` (already `inline-block` by UA default), but it must
    // not lose the explicit declaration either — the two variants are the same cell.
    rerender(<HeatmapCell value={4} max={10} bucketLabel="Tue 14:00" onClick={() => undefined} />);
    const button = screen.getByTestId('heatmap-cell');
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveClass('inline-block');
    expect(button).toHaveClass('size-4');
  });
});

describe('GraphCanvas — shell only; E11 fills the canvas', () => {
  it('renders the three states and the P-23 cap label', () => {
    const { rerender } = render(<GraphCanvas title="Harness map" loading />);
    expect(screen.getByTestId('loading-state')).toBeInTheDocument();

    rerender(<GraphCanvas title="Harness map" error={TERMINAL} />);
    expect(screen.getByTestId('error-state')).toBeInTheDocument();

    rerender(<GraphCanvas title="Harness map" empty />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();

    rerender(
      <GraphCanvas title="Harness map" nodeCount={2000}>
        <p>canvas</p>
      </GraphCanvas>,
    );
    expect(screen.getByText('Showing the top 500 of 2,000 nodes.')).toBeInTheDocument();
  });

  it('renders the inspector drawer with a labelled close button', () => {
    const onClose = vi.fn();
    render(
      <GraphCanvas title="Harness map" inspector={<p>node detail</p>} onCloseInspector={onClose}>
        <p>canvas</p>
      </GraphCanvas>,
    );
    expect(screen.getByTestId('graph-canvas-inspector')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

interface Row {
  id: string;
  name: string;
  tokens: number;
}

const COLUMNS = [
  { id: 'name', header: 'Session', sortable: true, render: (row: Row) => row.name },
  {
    id: 'tokens',
    header: 'Output',
    numeric: true,
    sortable: true,
    render: (row: Row) => String(row.tokens),
  },
];

describe('DataTable', () => {
  const rows: Row[] = [
    { id: 'a', name: 'alpha', tokens: 10 },
    { id: 'b', name: 'beta', tokens: 20 },
    { id: 'c', name: 'gamma', tokens: 30 },
  ];

  it('renders a sortable, accessible table with tabular numerals', () => {
    const onSortChange = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        rows={rows}
        rowKey={(row) => row.id}
        caption="Sessions"
        sort={{ columnId: 'tokens', direction: 'desc' }}
        onSortChange={onSortChange}
      />,
    );
    const table = screen.getByTestId('data-table');
    expect(table.getAttribute('style')).toContain('tabular-nums');

    const sorted = screen.getByRole('columnheader', { name: /Output/ });
    expect(sorted).toHaveAttribute('aria-sort', 'descending');

    fireEvent.click(within(sorted).getByRole('button'));
    expect(onSortChange).toHaveBeenCalledWith({ columnId: 'tokens', direction: 'asc' });
  });

  it('is keyboard navigable when rows are activatable (P-30)', () => {
    const onRowActivate = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        rows={rows}
        rowKey={(row) => row.id}
        caption="Sessions"
        onRowActivate={onRowActivate}
      />,
    );
    const tableRows = screen.getAllByTestId('data-table-row');
    const first = tableRows[0];
    const second = tableRows[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'Enter' });
    expect(onRowActivate).toHaveBeenCalledWith(rows[1]);
  });

  it('enforces the P-28 cap and says so instead of truncating silently', () => {
    const many: Row[] = Array.from({ length: MAX_RENDERED_ROWS + 25 }, (_unused, index) => ({
      id: String(index),
      name: `session-${String(index)}`,
      tokens: index,
    }));
    render(<DataTable columns={COLUMNS} rows={many} rowKey={(row) => row.id} caption="Sessions" />);
    expect(screen.getAllByTestId('data-table-row')).toHaveLength(MAX_RENDERED_ROWS);
    expect(screen.getByTestId('data-table-cap')).toHaveTextContent(
      'Showing the first 5,000 of 5,025 rows',
    );
  });
});

describe('ViewErrorBoundary — §7.3, one per view', () => {
  function Exploding(): never {
    throw new Error('chart blew up');
  }

  it('catches a render throw and shows an ErrorState instead of blanking', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ViewErrorBoundary viewId="overview">
        <Exploding />
      </ViewErrorBoundary>,
    );
    expect(screen.getByTestId('view-overview-error')).toBeInTheDocument();
    expect(screen.getByTestId('view-overview-error')).toHaveAttribute(
      'data-error-code',
      'E_INTERNAL',
    );
    consoleError.mockRestore();
  });
});
