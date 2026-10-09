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
import {
  CYCLE_EMPTY_REASON,
  OverviewView,
  OVERVIEW_EMPTY_REASON,
  PAST_CYCLE_EMPTY_REASON,
  RANGE_EMPTY_REASON,
} from '../../../src/renderer/views/OverviewView';
import { currentBillingCycle, cycleContaining } from '../../../src/renderer/lib/billing-cycle';
import { formatCost, formatDay } from '../../../src/renderer/lib/format';
import { useAppStore } from '../../../src/renderer/store/app-store';
import {
  ALL_COSTED_SENTENCE,
  NO_PRICING_SENTENCE,
} from '../../../src/renderer/views/shared/disclosures';
import { DEFAULT_SETTINGS } from '../harness';
import { DB_BUSY, ok, renderView, resetAll, uninstallBridge } from './view-harness';
import {
  activityCalendar,
  billingCycleTotals,
  modelTimeline,
  overviewTiles,
  uncosted,
} from './payloads';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetAll();
});

// A-18 — a fixed instant, injected wherever the billing cycle matters, so no assertion depends on
// when the suite runs. The cycle it falls in is whatever the machine's own zone makes of it, which
// is why the expected window is taken from `currentBillingCycle`: the boundary arithmetic itself is
// proved against hand-computed values under a pinned zone in `test/metrics/a18-billing-cycle.test.ts`
// (the `renderer` project runs on worker threads, where a runtime `TZ` pin is not honoured).
const NOW = Date.UTC(2026, 7, 20, 12);
const CYCLE = currentBillingCycle(15, NOW);
/** The cycle before it — closed, and therefore described differently (A-19). */
const PREVIOUS_CYCLE = cycleContaining(15, CYCLE.from - 1);

/** A dataset that really does hold transcripts — all of them older than the cycle under test. */
const HAS_TRANSCRIPTS = {
  transcriptsFrom: Date.UTC(2025, 0, 1),
  transcriptsTo: Date.UTC(2026, 0, 1),
};

/** A tiles payload with nothing in it: the query succeeded and the answer was zero. */
function emptyTiles() {
  return overviewTiles({ sessions: 0, outputTokens: 0, toolCalls: 0, costNanoUsd: null });
}

function stubs(tiles = overviewTiles()) {
  return {
    'q:overviewTiles': () => ok(tiles),
    'q:activityCalendar': () => ok(activityCalendar()),
    'q:modelMixTimeline': () => ok(modelTimeline()),
    // A-19 — the comparison strip under the tiles.
    'q:billingCycleTotals': () => ok(billingCycleTotals()),
  };
}

/** The top bar parked on the current billing cycle, which is the app's default window (A-19). */
function cycleFilter() {
  return { projectIds: null, from: CYCLE.from, to: CYCLE.to };
}

describe('§6.3 Overview — the four mandatory states', () => {
  it('renders skeleton tiles while the query is in flight, and does not render zeroes', () => {
    renderView(<OverviewView now={NOW} />, stubs());
    // Asserted synchronously, before the stub's microtask settles: this is the loading frame.
    expect(screen.getByTestId('tile-skeletons')).toBeInTheDocument();
    expect(screen.queryByTestId('tile-cost')).not.toBeInTheDocument();
  });

  it('renders §6.3’s empty copy verbatim, not zeroes', async () => {
    renderView(
      <OverviewView />,
      stubs(overviewTiles({ sessions: 0, outputTokens: 0, toolCalls: 0, costNanoUsd: null })),
    );
    await screen.findByTestId('overview-empty');

    // ⚠️ A-18/A-19 — §6.3's sentence is a claim about the DIRECTORY, and the app's launch filter
    // is all time, so this is the state it belongs to. Over a chosen billing cycle "no
    // transcripts in this directory" would be a different and possibly false statement (asserted
    // in the A-19 suite below). The assertion itself is unchanged: this copy, verbatim.
    expect(screen.getByTestId('overview-empty')).toHaveTextContent(OVERVIEW_EMPTY_REASON);
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
    const { bridge } = renderView(<OverviewView now={NOW} />, stubs());
    await screen.findByTestId('tile-cost');
    expect(bridge.calls.every((call) => call.channel.startsWith('q:'))).toBe(true);
  });
});

describe('§6.3 Overview — the hero row', () => {
  it('renders the PRD’s four tiles, in order, with Sessions deliberately absent', async () => {
    renderView(<OverviewView now={NOW} />, stubs());
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
    renderView(<OverviewView now={NOW} />, stubs());
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

/**
 * A-18 — the tile row counts over the user's BILLING CYCLE by default.
 *
 * ⚠️ These tests deliberately do NOT pin a timezone: the `renderer` project runs on worker
 * threads, where a runtime `TZ` write is not honoured, so a pinned expectation here would be a
 * lie about which zone it proved. The boundary arithmetic itself is pinned and hand-computed in
 * `test/metrics/a18-billing-cycle.test.ts`; what this suite owns is the WIRING — that the tiles
 * ask for the cycle window and not the raw filter, that the other option asks for the filter,
 * that the label cannot claim "All time" over a filtered range, and that the caption always
 * states which window the four numbers cover.
 */
describe('§6.3 Overview — the window the tiles count, after A-19', () => {
  /** The request the tiles query was last called with. */
  function lastTileRequest(bridge: { calls: { channel: string; request: unknown }[] }): unknown {
    const tileCalls = bridge.calls.filter((call) => call.channel === 'q:overviewTiles');
    return tileCalls.at(-1)?.request;
  }

  it('⚠️ queries the GLOBAL filter — the control at the top owns the window now', async () => {
    const { bridge } = renderView(<OverviewView now={NOW} />, stubs());
    await screen.findByTestId('tile-cost');

    // The store's filter is all-time/all-projects, and after A-19 that is exactly what the tiles
    // must ask for: the A-18 scope toggle that overrode it is gone.
    expect(lastTileRequest(bridge)).toEqual({ projectIds: null, from: null, to: null });
    expect(screen.queryByTestId('tile-scope-toggle')).not.toBeInTheDocument();

    act(() => {
      useAppStore.getState().setFilter(cycleFilter());
    });
    await waitFor(() => {
      expect(lastTileRequest(bridge)).toEqual(cycleFilter());
    });
  });

  it('⚠️ asks the cycle-comparison card for EVERY cycle, with no date range at all', async () => {
    const { bridge } = renderView(<OverviewView now={NOW} />, stubs(), {
      settings: { billingCycleDay: 7 },
    });
    await screen.findByTestId('cycle-strip');

    act(() => {
      useAppStore.getState().setFilter({ projectIds: [4], from: CYCLE.from, to: CYCLE.to });
    });

    await waitFor(() => {
      const cycleCalls = bridge.calls.filter((call) => call.channel === 'q:billingCycleTotals');
      // The project selection travels; neither the dates nor the billing day exist on this
      // request by construction — the main process reads the day from the setting (A-19).
      expect(cycleCalls.at(-1)?.request).toEqual({ projectIds: [4] });
    });
  });

  it('states the window the four numbers cover, with real dates', async () => {
    renderView(<OverviewView now={NOW} />, stubs());
    await screen.findByTestId('tile-cost');

    // All time, which is what the store's launch filter is.
    expect(screen.getByTestId('tile-window-caption')).toHaveTextContent(
      'Counting everything, all time.',
    );

    act(() => {
      useAppStore.getState().setFilter(cycleFilter());
    });
    await waitFor(() => {
      const caption = screen.getByTestId('tile-window-caption');
      expect(caption).toHaveTextContent(`Counting from ${formatDay(CYCLE.from)}`);
      expect(caption).toHaveTextContent('billing cycle so far');
    });

    // A chosen range that is not a cycle is named day by day — the exclusive bound is never the
    // day on screen.
    act(() => {
      useAppStore.getState().setFilter({
        projectIds: null,
        from: Date.UTC(2026, 0, 1, 12),
        to: Date.UTC(2026, 1, 1, 12),
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('tile-window-caption')).toHaveTextContent(
        `Counting ${formatDay(Date.UTC(2026, 0, 1, 12))} to ${formatDay(
          Date.UTC(2026, 1, 1, 12) - 1,
        )}`,
      );
    });
  });

  it('⚠️ reads the billing day from the SETTING when deciding a window is a cycle', async () => {
    const third = currentBillingCycle(3, NOW);
    // The two anchors really do select different windows at this instant, so the negative
    // assertion below has something to catch.
    expect(third).not.toEqual(CYCLE);

    renderView(<OverviewView now={NOW} />, stubs(), { settings: { billingCycleDay: 3 } });
    await screen.findByTestId('tile-cost');

    act(() => {
      useAppStore.getState().setFilter({ projectIds: null, from: third.from, to: third.to });
    });
    await waitFor(() => {
      expect(screen.getByTestId('tile-window-caption')).toHaveTextContent('billing cycle so far');
    });

    // The same window under the default anchor day is NOT one of that user's billing cycles, and
    // the caption must not call it one.
    act(() => {
      useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, billingCycleDay: 15 } });
    });
    await waitFor(() => {
      expect(screen.getByTestId('tile-window-caption')).not.toHaveTextContent('billing cycle');
    });
  });

  it('⚠️ does not claim the directory is empty when only the chosen cycle is', async () => {
    renderView(<OverviewView now={NOW} />, stubs(emptyTiles()), {
      // ⚠️ The dataset HAS transcripts — they simply all predate this cycle. That is the only
      // state in which "no activity in this billing cycle" is the true sentence.
      coverage: HAS_TRANSCRIPTS,
    });
    act(() => {
      useAppStore.getState().setFilter(cycleFilter());
    });

    await waitFor(() => {
      expect(screen.getByTestId('overview-empty')).toHaveTextContent(CYCLE_EMPTY_REASON);
    });
    expect(screen.getByTestId('overview-empty')).not.toHaveTextContent(OVERVIEW_EMPTY_REASON);
    // No path either: "where did you look" is not the question when the directory is fine.
    expect(screen.getByTestId('overview-empty')).not.toHaveTextContent('/sandbox/claude');

    // ⚠️ A cycle that has CLOSED cannot still fill up, so its sentence loses the "yet". One
    // word, and it is the difference between a true sentence and a promise the month cannot keep.
    const past = { projectIds: null, from: PREVIOUS_CYCLE.from, to: PREVIOUS_CYCLE.to };
    act(() => {
      useAppStore.getState().setFilter(past);
    });
    await waitFor(() => {
      expect(screen.getByTestId('overview-empty')).toHaveTextContent(PAST_CYCLE_EMPTY_REASON);
    });
    expect(screen.getByTestId('overview-empty')).not.toHaveTextContent(CYCLE_EMPTY_REASON);

    // A window that is not a cycle gets its own sentence rather than the cycle's, which would be
    // false, or the directory's, which would be false in a more damaging way.
    act(() => {
      useAppStore.getState().setFilter({
        projectIds: null,
        from: Date.UTC(2026, 0, 1),
        to: Date.UTC(2026, 1, 1),
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('overview-empty')).toHaveTextContent(RANGE_EMPTY_REASON);
    });
  });

  it('⚠️ says the DIRECTORY is empty — with the path — when the dataset holds nothing', async () => {
    // The bootstrap coverage reports no transcripts at all, which is what pointing the app at
    // the wrong folder looks like. "No activity yet in this billing cycle" would be a
    // reassurance printed over a misconfiguration, and it would hide the path (§6.3, §1a).
    renderView(<OverviewView now={NOW} />, stubs(emptyTiles()));

    const empty = await screen.findByTestId('overview-empty');
    expect(empty).toHaveTextContent(OVERVIEW_EMPTY_REASON);
    expect(empty).not.toHaveTextContent(CYCLE_EMPTY_REASON);
    expect(empty).toHaveTextContent('/sandbox/claude');
  });

  it('⚠️ asserts no cause at all while the dataset’s coverage is unknown', async () => {
    renderView(<OverviewView now={NOW} />, stubs(emptyTiles()), { coverage: HAS_TRANSCRIPTS });
    act(() => {
      useAppStore.getState().setFilter(cycleFilter());
    });
    await waitFor(() => {
      expect(screen.getByTestId('overview-empty')).toHaveTextContent(CYCLE_EMPTY_REASON);
    });

    // Coverage absent is not knowledge that the directory is empty, so the copy stays with what
    // was actually measured: this cycle counted nothing.
    act(() => {
      useAppStore.setState({ coverage: null });
    });

    await waitFor(() => {
      expect(screen.getByTestId('overview-empty')).toHaveTextContent(CYCLE_EMPTY_REASON);
    });
    expect(screen.getByTestId('overview-empty')).not.toHaveTextContent(OVERVIEW_EMPTY_REASON);
  });

  it('⚠️ captions the window the numbers ON SCREEN came from, not the one in flight', async () => {
    renderView(<OverviewView now={NOW} />, stubs());
    await screen.findByTestId('tile-cost');
    expect(screen.getByTestId('tile-window-caption')).toHaveTextContent(
      'Counting everything, all time.',
    );

    // Changing the window re-queries, and the tiles deliberately keep the numbers they have while
    // it is in flight. Asserted synchronously, before the stub's microtask settles: for that frame
    // the numbers are still all-time's, so the caption must still say so.
    act(() => {
      useAppStore.getState().setFilter(cycleFilter());
    });
    expect(screen.getByTestId('tile-window-caption')).toHaveTextContent(
      'Counting everything, all time.',
    );

    await waitFor(() => {
      expect(screen.getByTestId('tile-window-caption')).toHaveTextContent('billing cycle so far');
    });
  });

  it('keeps the window caption in every state, so the row never resizes', async () => {
    renderView(<OverviewView now={NOW} />, {
      'q:overviewTiles': () => DB_BUSY,
      'q:activityCalendar': () => ok(activityCalendar()),
      'q:modelMixTimeline': () => ok(modelTimeline()),
      'q:billingCycleTotals': () => ok(billingCycleTotals()),
    });

    // The loading frame, asserted before the stub settles.
    expect(screen.getByTestId('tile-window-caption')).toBeInTheDocument();

    // And the error frame.
    await screen.findByTestId('overview-tiles-error');
    expect(screen.getByTestId('tile-window-caption')).toBeInTheDocument();
  });
});

describe('§6.3 Overview — charts', () => {
  it('renders the calendar and the interactive model-mix legend', async () => {
    renderView(<OverviewView now={NOW} />, stubs());
    expect(await screen.findByTestId('calendar-heatmap')).toBeInTheDocument();

    const legend = screen.getByTestId('series-legend');
    // FRONTEND §8 — the series name is text; the hue is a swatch beside it.
    expect(within(legend).getByText('claude-test-1')).toBeInTheDocument();
    expect(within(legend).getAllByRole('button')[0]).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggles a series off from the legend with the keyboard', async () => {
    const { view } = renderView(<OverviewView now={NOW} />, stubs());
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
