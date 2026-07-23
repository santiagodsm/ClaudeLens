/**
 * Overview — §6.3.
 *
 * What this suite pins is the design's rules, not the markup:
 *   · the four states of §6.12, including the exact empty copy;
 *   · the PRD's tile order, which deliberately overrides the prototype's;
 *   · the M-06 disclosure rendered **adjacent to** the cost figure, never in a tooltip;
 *   · the M-20 overlap disclosure present at `> 0` and **absent** at `0` — the asymmetry §6.3
 *     states explicitly, and the one a "complete the pattern" edit would quietly break;
 *   · that the Active-hours figure is identical either way (INV-23).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { OverviewView, OVERVIEW_EMPTY_REASON } from '../../../src/renderer/views/OverviewView';
import { formatCost } from '../../../src/renderer/lib/format';
import { useAppStore } from '../../../src/renderer/store/app-store';
import {
  ALL_COSTED_SENTENCE,
  NO_PRICING_SENTENCE,
} from '../../../src/renderer/views/shared/disclosures';
import { DB_BUSY, ok, renderView, resetAll, uninstallBridge } from './view-harness';
import { activityCalendar, modelTimeline, overviewTiles, uncosted } from './payloads';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetAll();
});

function stubs(tiles = overviewTiles()) {
  return {
    'q:overviewTiles': () => ok(tiles),
    'q:activityCalendar': () => ok(activityCalendar()),
    'q:modelMixTimeline': () => ok(modelTimeline()),
  };
}

describe('§6.3 Overview — the four mandatory states', () => {
  it('renders skeleton tiles while the query is in flight, and does not render zeroes', () => {
    renderView(<OverviewView />, stubs());
    // Asserted synchronously, before the stub's microtask settles: this is the loading frame.
    expect(screen.getByTestId('tile-skeletons')).toBeInTheDocument();
    expect(screen.queryByTestId('tile-cost')).not.toBeInTheDocument();
  });

  it('renders §6.3’s empty copy verbatim, not zeroes', async () => {
    renderView(
      <OverviewView />,
      stubs(overviewTiles({ sessions: 0, outputTokens: 0, toolCalls: 0, costNanoUsd: null })),
    );
    expect(await screen.findByTestId('overview-empty')).toHaveTextContent(OVERVIEW_EMPTY_REASON);
    expect(screen.queryByTestId('tile-output-tokens')).not.toBeInTheDocument();
  });

  it('renders an ErrorState for the tile row without blanking the charts', async () => {
    renderView(<OverviewView />, {
      'q:overviewTiles': () => DB_BUSY,
      'q:activityCalendar': () => ok(activityCalendar()),
      'q:modelMixTimeline': () => ok(modelTimeline()),
    });
    const error = await screen.findByTestId('overview-tiles-error');
    expect(error).toHaveAttribute('data-error-code', 'E_DB_BUSY');
    // One failing card never blanks the view (§6.3 error row).
    expect(screen.getByTestId('overview-calendar')).toBeInTheDocument();
  });

  it('is offline-identical: every channel it touches is a local query (§7.5)', async () => {
    const { bridge } = renderView(<OverviewView />, stubs());
    await screen.findByTestId('tile-cost');
    expect(bridge.calls.every((call) => call.channel.startsWith('q:'))).toBe(true);
  });
});

describe('§6.3 Overview — the hero row', () => {
  it('renders the PRD’s four tiles, in order, with Sessions deliberately absent', async () => {
    renderView(<OverviewView />, stubs());
    await screen.findByTestId('tile-cost');

    const tiles = screen
      .getAllByTestId(/^tile-(?!skeletons)[a-z-]+$/)
      .filter((tile) => tile.tagName === 'SECTION')
      .map((tile) => tile.getAttribute('data-testid'));
    expect(tiles).toEqual([
      'tile-output-tokens',
      'tile-cost',
      'tile-active-hours',
      'tile-tool-calls',
    ]);
    // §6.3 — "The session count moves to the Sessions & Time header."
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument();
  });

  it('puts the M-06 disclosure adjacent to the cost figure, in the DOM (INV-10)', async () => {
    renderView(<OverviewView />, stubs(overviewTiles({ uncosted: uncosted(3) })));
    const tile = await screen.findByTestId('tile-cost');

    expect(within(tile).getByText('$12.34')).toBeInTheDocument();
    const disclosure = screen.getByTestId('tile-cost-disclosure');
    expect(disclosure).toHaveTextContent('3 records uncosted');
    expect(disclosure).toHaveTextContent('claude-test-1');
    // Adjacent, not in a tooltip: it is a child of the tile and has no `title` affordance.
    expect(tile).toContainElement(disclosure);
    expect(disclosure).not.toHaveAttribute('title');
    expect(screen.getByTestId('pricing-settings-link')).toHaveAttribute(
      'href',
      '/settings#pricing',
    );
  });

  it('says "all records costed" when nothing is uncosted', async () => {
    renderView(<OverviewView />, stubs());
    expect(await screen.findByTestId('tile-cost-disclosure')).toHaveTextContent(
      ALL_COSTED_SENTENCE,
    );
  });

  it('⚠️ never renders $0.00 when no price row covers any record', async () => {
    renderView(
      <OverviewView />,
      stubs(overviewTiles({ costNanoUsd: null, uncosted: uncosted(9) })),
    );
    const tile = await screen.findByTestId('tile-cost');

    expect(tile).not.toHaveTextContent('$0.00');
    expect(tile.textContent ?? '').not.toContain('$');
    expect(screen.getByTestId('tile-cost-disclosure')).toHaveTextContent(NO_PRICING_SENTENCE);
    // The formatter itself is the guarantee, so pin it here too.
    expect(formatCost(null)).not.toBe('$0.00');
  });
});

describe('§6.3 Overview — the M-20 overlap disclosure (ADR-037, INV-23)', () => {
  it('renders NOTHING extra when overlapSeconds === 0', async () => {
    renderView(<OverviewView />, stubs(overviewTiles({ overlapSeconds: 0 })));
    const tile = await screen.findByTestId('tile-active-hours');

    expect(screen.queryByTestId('overlap-disclosure')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tile-active-hours-disclosure')).not.toBeInTheDocument();
    // ⚠️ Deliberately NOT a positive confirmation — §6.3 contrasts this with the Cost tile.
    expect(tile).not.toHaveTextContent('overlap');
  });

  it('appends the sentence directly beneath the number when overlapSeconds > 0', async () => {
    renderView(<OverviewView />, stubs(overviewTiles({ overlapSeconds: 4_500 })));
    const tile = await screen.findByTestId('tile-active-hours');
    const disclosure = screen.getByTestId('overlap-disclosure');

    expect(disclosure).toHaveTextContent('1h 15m of this total overlap across projects.');
    expect(tile).toContainElement(disclosure);
    expect(disclosure).not.toHaveAttribute('title');
  });

  it('⚠️ leaves the Active-hours figure itself unchanged either way', async () => {
    const { view } = renderView(<OverviewView />, stubs(overviewTiles({ overlapSeconds: 0 })));
    expect(await screen.findByTestId('tile-active-hours')).toHaveTextContent('21h 37m');
    view.unmount();
    cleanup();
    uninstallBridge();

    renderView(<OverviewView />, stubs(overviewTiles({ overlapSeconds: 4_500 })));
    expect(await screen.findByTestId('tile-active-hours')).toHaveTextContent('21h 37m');
  });
});

describe('§6.3 Overview — charts', () => {
  it('renders the calendar and the interactive model-mix legend', async () => {
    renderView(<OverviewView />, stubs());
    expect(await screen.findByTestId('calendar-heatmap')).toBeInTheDocument();

    const legend = screen.getByTestId('series-legend');
    // FRONTEND §8 — the series name is text; the hue is a swatch beside it.
    expect(within(legend).getByText('claude-test-1')).toBeInTheDocument();
    expect(within(legend).getAllByRole('button')[0]).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggles a series off from the legend with the keyboard', async () => {
    const { view } = renderView(<OverviewView />, stubs());
    await screen.findByTestId('series-legend');

    const first = within(screen.getByTestId('series-legend')).getAllByRole('button')[0];
    expect(first).toBeDefined();
    first?.focus();
    expect(document.activeElement).toBe(first);
    first?.click();

    await waitFor(() => {
      expect(within(screen.getByTestId('series-legend')).getAllByRole('button')[0]).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });
    view.unmount();
  });

  it('updates in place when the data changes — no chart is remounted (§6.12)', async () => {
    let tiles = overviewTiles();
    let calendar = activityCalendar(12);
    const { view } = renderView(<OverviewView />, {
      'q:overviewTiles': () => ok(tiles),
      'q:activityCalendar': () => ok(calendar),
      'q:modelMixTimeline': () => ok(modelTimeline()),
    });
    const chartBefore = await screen.findByTestId('calendar-heatmap');
    const tileBefore = screen.getByTestId('tile-output-tokens');
    expect(tileBefore).toHaveTextContent('1,234,567');

    // A live update: new numbers arrive for the same mounted view.
    tiles = overviewTiles({ outputTokens: 2_000_000 });
    calendar = activityCalendar(20);
    act(() => {
      useAppStore.getState().setFilter({ projectIds: [1], from: null, to: null });
    });

    await waitFor(() => {
      expect(screen.getByTestId('tile-output-tokens')).toHaveTextContent('2,000,000');
    });
    // ⚠️ The SAME elements — nothing is keyed on a payload, so nothing re-enters or replays
    // (§6.12: "a live data update never re-animates a chart"; §6.2: number updates are in place).
    expect(screen.getByTestId('calendar-heatmap')).toBe(chartBefore);
    expect(screen.getByTestId('tile-output-tokens')).toBe(tileBefore);
    view.unmount();
  });
});
