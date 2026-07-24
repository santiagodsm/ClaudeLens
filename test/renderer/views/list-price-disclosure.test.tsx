/**
 * The standing list-price caveat, on **every** `$` surface (approved 2026-07-22; §6.12, §6.2).
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
 *
 * ⚠️⚠️ **AMENDED — this suite used to import only `OverviewView` and `TokensView`, and that is
 * exactly why three surfaces drifted.** §6.12 binds the caveat to every `$`, but a suite that
 * only knows two screens can only defend two screens: the session drawer shipped a bold figure
 * captioned only "all records costed", and a project card shipped a bare `$` with no label at
 * all. The enumeration below is now the point of the file — `MONEY_SURFACES` names every screen
 * in the application that renders a `$`, each with the setup that gets it on screen, so a new
 * money surface added without its caveat fails here rather than reaching a user.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { OverviewView } from '../../../src/renderer/views/OverviewView';
import { TokensView } from '../../../src/renderer/views/TokensView';
import { SessionsView } from '../../../src/renderer/views/SessionsView';
import { ProjectsView } from '../../../src/renderer/views/ProjectsView';
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
  fileMetrics,
  modelTimeline,
  originSplit,
  overviewTiles,
  projectCard,
  projectCards,
  rhythmHeatmap,
  sessionDetail,
  sessionHistogram,
  sessionsPage,
  tokensByProject,
  uncosted,
  workingDays,
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
  // Migration 0011 — ⚠️ `checkedRecords: 0` means NOTHING HAS BEEN CHECKED, not "no repeats".
  // Suites that want the quiet state must set `checkedRecords` above zero; see
  // `test/renderer/views/repeated-api-calls.test.tsx` for the distinction this pins.
  repeatedApiCalls: { records: 0, checkedRecords: 0, uncheckedRecords: 0, uncheckableRecords: 0 },
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

function sessionsStubs(overrides: Partial<Record<string, () => unknown>> = {}) {
  return {
    'q:sessionHistogram': () => ok(sessionHistogram()),
    'q:rhythmHeatmap': () => ok(rhythmHeatmap()),
    'q:workingDays': () => ok(workingDays()),
    'q:sessions': () => ok(sessionsPage()),
    'q:sessionDetail': () => ok(sessionDetail()),
    ...overrides,
  } as Parameters<typeof renderView>[1];
}

function projectsStubs(overrides: Partial<Record<string, () => unknown>> = {}) {
  return {
    'q:projectCards': () => ok(projectCards()),
    'q:fileMetrics': () => ok(fileMetrics()),
    ...overrides,
  } as Parameters<typeof renderView>[1];
}

/**
 * ⚠️ **The enumeration is the test.** Every screen in this application that renders a `$`, with
 * the least setup that puts its figure on screen, and the two states §6.12 cares about: the
 * ordinary one and the one where **nothing is costed at all** — the state a data-dependent
 * implementation would most plausibly have dropped the caveat in, since there is no `$` left to
 * qualify. Adding a money surface without adding it here is the drift this file failed to catch
 * once already.
 */
interface MoneySurface {
  /** Plain name, so a failure says which screen, not which index. */
  readonly name: string;
  /** Renders the view and drives whatever click is needed, then resolves once the `$` is up. */
  readonly show: (unpriced: boolean) => Promise<HTMLElement>;
}

const MONEY_SURFACES: readonly MoneySurface[] = [
  {
    name: '§6.3 Overview — the Cost tile',
    show: async (unpriced) => {
      renderView(
        <OverviewView />,
        overviewStubs(unpriced ? overviewTiles({ costNanoUsd: null }) : overviewTiles()),
      );
      return screen.findByTestId('tile-cost');
    },
  },
  {
    name: '§6.4 Tokens & Cost — the Cost panel',
    show: async (unpriced) => {
      renderView(
        <TokensView />,
        tokensStubs(
          unpriced
            ? { 'q:costBreakdown': () => ok(costBreakdown({ rows: [], uncosted: uncosted(12) })) }
            : {},
        ),
      );
      return screen.findByTestId('tokens-cost-panel');
    },
  },
  {
    name: '§6.5 Sessions & Time — the session drawer',
    show: async (unpriced) => {
      renderView(
        <SessionsView />,
        sessionsStubs(
          unpriced ? { 'q:sessionDetail': () => ok(sessionDetail({ costNanoUsd: null })) } : {},
        ),
      );
      const rows = await screen.findAllByTestId('sessions-table-row');
      fireEvent.click(rows[0]!);
      return screen.findByTestId('session-drawer');
    },
  },
  {
    name: '§6.8 Projects & Code — a project card',
    show: async (unpriced) => {
      renderView(
        <ProjectsView />,
        projectsStubs(
          unpriced
            ? {
                'q:projectCards': () =>
                  ok(projectCards({ rows: [projectCard({ costNanoUsd: null })] })),
              }
            : {},
        ),
      );
      return screen.findByTestId('project-card');
    },
  },
  {
    name: '§6.8 Projects & Code — the project-detail drawer',
    show: async (unpriced) => {
      renderView(
        <ProjectsView />,
        projectsStubs(
          unpriced
            ? {
                'q:projectCards': () =>
                  ok(projectCards({ rows: [projectCard({ costNanoUsd: null })] })),
              }
            : {},
        ),
      );
      fireEvent.click(await screen.findByTestId('project-card-open'));
      return screen.findByTestId('project-detail-drawer');
    },
  },
];

describe('⚠️ the standing list-price caveat sits beside EVERY $ in the application (§6.12)', () => {
  for (const surface of MONEY_SURFACES) {
    it(`${surface.name} — carries it, adjacent and never in a tooltip`, async () => {
      const region = await surface.show(false);
      expect(within(region).getByTestId('list-price-disclosure')).toHaveTextContent(
        LIST_PRICE_SENTENCE,
      );
      // §6.12 — "never in a tooltip". Nothing on the surface hides the sentence behind hover.
      expect(within(region).getByTestId('list-price-disclosure')).not.toHaveAttribute('title');
    });

    it(`${surface.name} — keeps it when nothing is costed and there is no $ to qualify`, async () => {
      const region = await surface.show(true);
      expect(within(region).getByTestId('list-price-disclosure')).toBeInTheDocument();
    });
  }

  it('⚠️ names every money surface — the count is the guard against a sixth one drifting', () => {
    // A deliberately brittle assertion. If a screen starts rendering a `$`, this number moves,
    // and the person moving it has to add the surface above rather than only bump the count.
    expect(MONEY_SURFACES).toHaveLength(5);
  });
});

describe('§6.8 — the project card labels its $ like its siblings (§1a)', () => {
  it('gives the figure a label and the caveat, so the card answers "what is this number"', async () => {
    renderView(<ProjectsView />, projectsStubs());
    const card = await screen.findByTestId('project-card');

    // The number is no longer an unlabelled string floating under the sparkline.
    const figure = within(card).getByTestId('project-card-cost');
    expect(figure).toHaveTextContent('$4.50');
    const term = within(card).getByText('Cost');
    expect(term.tagName).toBe('DT');
    // Its siblings are labelled the same way, in the same element pair.
    for (const label of ['Sessions', 'Output', 'Tool calls', 'Active']) {
      expect(within(card).getByText(label).tagName).toBe('DT');
    }
    expect(within(card).getByTestId('list-price-disclosure')).toBeInTheDocument();
  });

  it('⚠️ shows the label, the caveat and an em dash — never $0.00 — when nothing is costed', async () => {
    renderView(
      <ProjectsView />,
      projectsStubs({
        'q:projectCards': () => ok(projectCards({ rows: [projectCard({ costNanoUsd: null })] })),
      }),
    );
    const card = await screen.findByTestId('project-card');
    expect(within(card).getByTestId('project-card-cost')).toHaveTextContent('—');
    expect(card.textContent ?? '').not.toContain('$0.00');
    expect(within(card).getByTestId('list-price-disclosure')).toBeInTheDocument();
  });
});

describe('§6.5 — the session drawer gets the whole block, not just the cost line', () => {
  it('⚠️ no longer captions a bold $ with "all records costed" alone', async () => {
    renderView(<SessionsView />, sessionsStubs());
    const rows = await screen.findAllByTestId('sessions-table-row');
    fireEvent.click(rows[0]!);
    const drawer = await screen.findByTestId('session-drawer');

    const disclosure = within(drawer).getByTestId('drawer-cost-disclosure');
    // Both lines, in order: the standing caveat FIRST, then the data-dependent completeness line.
    expect(within(disclosure).getByTestId('list-price-disclosure')).toBeInTheDocument();
    expect(within(disclosure).getByTestId('all-costed-disclosure')).toBeInTheDocument();
    const text = disclosure.textContent ?? '';
    expect(text.indexOf(LIST_PRICE_SENTENCE)).toBeLessThan(text.indexOf('all records costed'));
  });

  it('carries the A-05 cache-split lines too, because it now shares the one block', async () => {
    renderView(<SessionsView />, sessionsStubs());
    const rows = await screen.findAllByTestId('sessions-table-row');
    fireEvent.click(rows[0]!);
    await screen.findByTestId('session-drawer');
    seedDisclosures({ cacheSplitArchivedEvents: 2 });

    expect(
      within(screen.getByTestId('drawer-cost-disclosure')).getByTestId(
        'cache-split-archived-disclosure',
      ),
    ).toHaveTextContent('2 records');
  });
});

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
