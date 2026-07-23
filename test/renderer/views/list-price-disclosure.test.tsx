/**
 * The standing list-price caveat, on both `$` surfaces (approved 2026-07-22; §6.12, §6.2).
 *
 * §5.9 M-05 costs usage against `price_rows`, which hold **published API list rates**. A Claude
 * subscription is not billed that way, so a lifetime total presented bare invites exactly one
 * wrong conclusion — that the user spent it. One muted line, adjacent to the number, fixes that.
 *
 * ⚠️ **The property this suite exists to pin is that the line is STANDING, not data-dependent.**
 * M-20's overlap disclosure renders nothing at `overlapSeconds === 0` because §6.3 refuses "a
 * reassurance nobody asked for" on the glance surface. This line must NOT follow that precedent:
 * it is true of every `$` the app will ever show, so it is present in every state — which is also
 * the testable form of "it does not push layout around" (§6.2). A line that is always there
 * cannot appear, disappear, or move anything when data arrives.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import { OverviewView } from '../../../src/renderer/views/OverviewView';
import { TokensView } from '../../../src/renderer/views/TokensView';
import { useAppStore } from '../../../src/renderer/store/app-store';
import {
  CACHE_SPLIT_ARCHIVED_SENTENCE,
  CACHE_SPLIT_UNKNOWN_SENTENCE,
  LIST_PRICE_SENTENCE,
} from '../../../src/renderer/views/shared/disclosures';
import { DB_BUSY, ok, renderView, resetAll, uninstallBridge } from './view-harness';
import type { Disclosures } from '../../../src/shared/ipc-contract';
import {
  activityCalendar,
  cacheEfficiency,
  contextOverhead,
  costBreakdown,
  modelTimeline,
  originSplit,
  overviewTiles,
  tokensByProject,
  uncosted,
} from './payloads';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetAll();
});

const NOTHING_TO_DISCLOSE: Disclosures = {
  uncosted: { records: 0, byModel: [] },
  badLines: 0,
  syntheticEvents: 0,
  unlinkedSubagentRuns: 0,
  partialBefore: null,
  filesMissingSinceLastSync: 0,
  activeOverlapSeconds: 0,
  cacheSplitUnknownEvents: 0,
  cacheSplitArchivedEvents: 0,
  cacheSplitMismatches: 0,
  retainedOrphanSessions: 0,
  retainedOrphanEvents: 0,
};

function seedDisclosures(overrides: Partial<Disclosures> = {}): void {
  act(() => {
    useAppStore.setState({ disclosures: { ...NOTHING_TO_DISCLOSE, ...overrides } });
  });
}

function overviewStubs(tiles = overviewTiles()) {
  return {
    'q:overviewTiles': () => ok(tiles),
    'q:activityCalendar': () => ok(activityCalendar()),
    'q:modelMixTimeline': () => ok(modelTimeline()),
  };
}

function tokensStubs(overrides: Partial<Record<string, () => unknown>> = {}) {
  return {
    'q:tokensByModel': () => ok(modelTimeline()),
    'q:cacheEfficiency': () => ok(cacheEfficiency()),
    'q:contextOverhead': () => ok(contextOverhead()),
    'q:tokensByProject': () => ok(tokensByProject()),
    'q:costBreakdown': () => ok(costBreakdown()),
    'q:originSplit': () => ok(originSplit()),
    ...overrides,
  } as Parameters<typeof renderView>[1];
}

describe('the list-price caveat — §6.3 Overview Cost tile', () => {
  it('renders adjacent to the figure, in flow, and never as a tooltip', async () => {
    renderView(<OverviewView />, overviewStubs());
    const tile = await screen.findByTestId('tile-cost');
    const disclosure = within(tile).getByTestId('tile-cost-disclosure');

    expect(within(disclosure).getByTestId('list-price-disclosure')).toHaveTextContent(
      LIST_PRICE_SENTENCE,
    );
    // §6.12 — "never in a tooltip". Nothing on the tile hides the sentence behind hover.
    expect(tile.querySelector('[title]')).toBeNull();
    expect(disclosure).not.toHaveAttribute('title');
  });

  it('⚠️ is present in ALL THREE cost states, so nothing about it moves with the data', async () => {
    // (a) everything costed
    const costed = renderView(<OverviewView />, overviewStubs());
    expect(await screen.findByTestId('list-price-disclosure')).toBeInTheDocument();
    costed.view.unmount();
    cleanup();

    // (b) some records uncosted — the M-06 line joins it rather than replacing it
    renderView(<OverviewView />, overviewStubs(overviewTiles({ uncosted: uncosted(7) })));
    const withUncosted = await screen.findByTestId('tile-cost-disclosure');
    expect(within(withUncosted).getByTestId('list-price-disclosure')).toBeInTheDocument();
    expect(within(withUncosted).getByTestId('uncosted-disclosure')).toHaveTextContent(
      '7 records uncosted',
    );
    cleanup();

    // (c) ⚠️ nothing priced at all — no `$` is rendered, and the caveat still is. This is the
    // state a data-dependent implementation would most plausibly have dropped it in.
    renderView(<OverviewView />, overviewStubs(overviewTiles({ costNanoUsd: null })));
    const unpriced = await screen.findByTestId('tile-cost');
    expect(within(unpriced).getByTestId('list-price-disclosure')).toBeInTheDocument();
    expect(unpriced.textContent ?? '').not.toContain('$');
  });

  it('⚠️ does not follow the overlap disclosure’s render-nothing-at-zero precedent', async () => {
    // Same payload, both disclosures at their "nothing to say" value. M-20 renders NOTHING; the
    // list-price line renders anyway. If a later edit "completes the pattern" by making this one
    // conditional too, this assertion is what fails.
    renderView(<OverviewView />, overviewStubs(overviewTiles({ overlapSeconds: 0 })));
    await screen.findByTestId('tile-cost');

    expect(screen.queryByTestId('overlap-disclosure')).not.toBeInTheDocument();
    expect(screen.getByTestId('list-price-disclosure')).toBeInTheDocument();
  });

  it('occupies the same slot whether or not there is anything else to disclose (§6.2)', async () => {
    // The layout claim, in the only form jsdom can honestly make: the Cost tile's disclosure slot
    // exists and holds the standing line in both cases, so the tile does not gain or lose that
    // line as data arrives. The M-06 line is an *additional* line, not a replacement.
    renderView(<OverviewView />, overviewStubs());
    const quiet = await screen.findByTestId('tile-cost-disclosure');
    expect(within(quiet).getByTestId('list-price-disclosure')).toBeInTheDocument();
    expect(within(quiet).getByTestId('all-costed-disclosure')).toBeInTheDocument();
    cleanup();

    renderView(<OverviewView />, overviewStubs(overviewTiles({ uncosted: uncosted(3) })));
    const loud = await screen.findByTestId('tile-cost-disclosure');
    expect(within(loud).getByTestId('list-price-disclosure')).toBeInTheDocument();
    expect(within(loud).getByTestId('uncosted-disclosure')).toBeInTheDocument();
  });

  it('never appears on a tile that carries no $ figure', async () => {
    renderView(<OverviewView />, overviewStubs());
    await screen.findByTestId('tile-cost');
    for (const testId of ['tile-output-tokens', 'tile-active-hours', 'tile-tool-calls']) {
      expect(screen.getByTestId(testId).textContent ?? '').not.toContain(LIST_PRICE_SENTENCE);
    }
  });
});

describe('the list-price caveat — §6.4 Tokens & Cost panel', () => {
  it('renders inside the Cost panel, beneath the total', async () => {
    renderView(<TokensView />, tokensStubs());
    const panel = await screen.findByTestId('tokens-cost-panel');
    const disclosure = within(panel).getByTestId('tokens-cost-panel-disclosure');

    expect(within(disclosure).getByTestId('list-price-disclosure')).toHaveTextContent(
      LIST_PRICE_SENTENCE,
    );
    expect(panel).toContainElement(disclosure);
  });

  it('survives the "no pricing configured" state, where there is no $ to qualify', async () => {
    renderView(
      <TokensView />,
      tokensStubs({
        'q:costBreakdown': () => ok(costBreakdown({ rows: [], uncosted: uncosted(12) })),
      }),
    );
    const panel = await screen.findByTestId('tokens-cost-panel');
    expect(within(panel).getByTestId('list-price-disclosure')).toBeInTheDocument();
    expect(panel.textContent ?? '').not.toContain('$');
  });

  it('is absent only when the panel itself has no data yet', async () => {
    renderView(<TokensView />, tokensStubs({ 'q:costBreakdown': () => DB_BUSY }));
    const panel = await screen.findByTestId('tokens-cost-panel');
    // An error card renders `ErrorState`, not a figure — so there is no number to qualify.
    expect(within(panel).getByTestId('error-state')).toBeInTheDocument();
    expect(within(panel).queryByTestId('list-price-disclosure')).not.toBeInTheDocument();
  });
});

describe('the A-05 cache-split caveats ride the same slot', () => {
  it('names the re-syncable records and the archived ones in two different sentences', async () => {
    renderView(<OverviewView />, overviewStubs());
    await screen.findByTestId('tile-cost');
    seedDisclosures({ cacheSplitUnknownEvents: 133_701, cacheSplitArchivedEvents: 12 });

    const disclosure = screen.getByTestId('tile-cost-disclosure');
    expect(within(disclosure).getByTestId('cache-split-unknown-disclosure')).toHaveTextContent(
      `133,701 records ${CACHE_SPLIT_UNKNOWN_SENTENCE}.`,
    );
    // ⚠️⚠️ A different sentence, because a re-sync cannot fix it. Telling the user to re-sync an
    // archived session would be advice that cannot work (§5.3 `ARCHIVED`, §9.4).
    expect(within(disclosure).getByTestId('cache-split-archived-disclosure')).toHaveTextContent(
      `12 records ${CACHE_SPLIT_ARCHIVED_SENTENCE}.`,
    );
    expect(CACHE_SPLIT_ARCHIVED_SENTENCE).not.toBe(CACHE_SPLIT_UNKNOWN_SENTENCE);
    // The standing caveat is still first, and still there.
    expect(within(disclosure).getByTestId('list-price-disclosure')).toBeInTheDocument();
  });

  it('says nothing when there is nothing stale — these ARE data-dependent', async () => {
    renderView(<OverviewView />, overviewStubs());
    await screen.findByTestId('tile-cost');
    seedDisclosures();

    expect(screen.queryByTestId('cache-split-unknown-disclosure')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cache-split-archived-disclosure')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cache-split-mismatch-disclosure')).not.toBeInTheDocument();
    expect(screen.getByTestId('list-price-disclosure')).toBeInTheDocument();
  });

  it('carries the same caveats on the Tokens & Cost panel', async () => {
    renderView(<TokensView />, tokensStubs());
    await screen.findByTestId('cost-total');
    seedDisclosures({ cacheSplitArchivedEvents: 4, cacheSplitMismatches: 1 });

    const disclosure = screen.getByTestId('tokens-cost-panel-disclosure');
    expect(within(disclosure).getByTestId('cache-split-archived-disclosure')).toHaveTextContent(
      '4 records',
    );
    expect(within(disclosure).getByTestId('cache-split-mismatch-disclosure')).toHaveTextContent(
      '1 record ',
    );
  });
});
