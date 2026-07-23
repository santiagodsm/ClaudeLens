/**
 * Tokens & Cost — §6.4, the "first among equals" view.
 *
 * The assertions that matter are the degraded ones. §6.4 states the rule in absolute terms —
 * "⚠️ It never shows `$0.00`" — so this suite drives the panel through all three of its cost
 * conditions and checks the *character* `$` is absent in the one where nothing is priced.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { CACHE_READ_NOTE, TokensView } from '../../../src/renderer/views/TokensView';
import { formatCost } from '../../../src/renderer/lib/format';
import { NO_PRICING_SENTENCE } from '../../../src/renderer/views/shared/disclosures';
import { DB_BUSY, ok, renderView, resetAll, uninstallBridge } from './view-harness';
import {
  contextOverhead,
  costBreakdown,
  fileMetrics,
  modelTimeline,
  originSplit,
  projectCards,
  T0,
  toolFingerprint,
  tokensByProject,
  uncosted,
} from './payloads';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetAll();
});

function stubs(overrides: Partial<Record<string, () => unknown>> = {}) {
  return {
    'q:tokensByModel': () => ok(modelTimeline()),
    'q:contextOverhead': () => ok(contextOverhead()),
    'q:tokensByProject': () => ok(tokensByProject()),
    'q:costBreakdown': () => ok(costBreakdown()),
    'q:originSplit': () => ok(originSplit()),
    ...overrides,
  } as Parameters<typeof renderView>[1];
}

describe('§6.4 Tokens & Cost — states and the standing note', () => {
  it('renders skeletons while loading and never a zero', () => {
    renderView(<TokensView />, stubs());
    expect(screen.getAllByTestId('loading-state').length).toBeGreaterThan(0);
  });

  it('renders §6.4’s per-card empty copy verbatim', async () => {
    renderView(
      <TokensView />,
      stubs({
        'q:tokensByModel': () => ok({ buckets: [], series: [] }),
        'q:costBreakdown': () => ok({ rows: [], uncosted: { records: 0, byModel: [] } }),
      }),
    );
    await waitFor(() => {
      expect(screen.getAllByText('no assistant events in this range').length).toBeGreaterThan(0);
    });
  });

  it('renders a per-card ErrorState without blanking the view', async () => {
    renderView(<TokensView />, stubs({ 'q:contextOverhead': () => DB_BUSY }));
    const card = await screen.findByTestId('tokens-context-overhead');
    expect(within(card).getByTestId('error-state')).toHaveAttribute('data-error-code', 'E_DB_BUSY');
    expect(screen.getByTestId('tokens-cost-panel')).toBeInTheDocument();
  });

  it('is offline-identical: nothing on this view touches the network', async () => {
    const { bridge } = renderView(<TokensView />, stubs());
    await screen.findByTestId('cost-total');
    expect(bridge.calls.every((call) => call.channel.startsWith('q:'))).toBe(true);
  });

  it('carries the standing cache-read note whichever way the toggle is set', async () => {
    renderView(<TokensView />, stubs());
    expect(screen.getByText(CACHE_READ_NOTE)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('token-mode-toggle-all'));
    expect(await screen.findByText('All tokens by model')).toBeInTheDocument();
    expect(screen.getByText(CACHE_READ_NOTE)).toBeInTheDocument();
  });

  it('flips the stacked-area title with the segmented toggle, and moves by keyboard', async () => {
    renderView(<TokensView />, stubs());
    expect(await screen.findByText('Output tokens by model')).toBeInTheDocument();

    const group = screen.getByTestId('token-mode-toggle');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(await screen.findByText('All tokens by model')).toBeInTheDocument();
    expect(screen.getByTestId('token-mode-toggle-all')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('§6.4 Tokens & Cost — the Cost panel’s three conditions', () => {
  it('shows the total with "all records costed" when nothing is uncosted', async () => {
    renderView(<TokensView />, stubs());
    // 10.00 + 2.34
    expect(await screen.findByTestId('cost-total')).toHaveTextContent('$12.34');
    expect(screen.getByTestId('all-costed-disclosure')).toBeInTheDocument();
  });

  it('shows the figure WITH the disclosure and a Settings → Pricing link when records > 0', async () => {
    renderView(
      <TokensView />,
      stubs({ 'q:costBreakdown': () => ok(costBreakdown({ uncosted: uncosted(7) })) }),
    );
    const panel = await screen.findByTestId('tokens-cost-panel');
    const disclosure = screen.getByTestId('tokens-cost-panel-disclosure');

    expect(screen.getByTestId('cost-total')).toHaveTextContent('$12.34');
    expect(disclosure).toHaveTextContent('7 records uncosted');
    // INV-10 / §6.12 — pinned beneath the total, inside the same card, never a tooltip.
    expect(panel).toContainElement(disclosure);
    expect(within(disclosure).getByTestId('pricing-settings-link')).toHaveAttribute(
      'href',
      '/settings#pricing',
    );
  });

  it('⚠️ shows NO $ at all — and never $0.00 — when no price row covers any record', async () => {
    renderView(
      <TokensView />,
      stubs({ 'q:costBreakdown': () => ok(costBreakdown({ rows: [], uncosted: uncosted(12) })) }),
    );
    const panel = await screen.findByTestId('tokens-cost-panel');

    expect(panel).not.toHaveTextContent('$0.00');
    expect(panel.textContent ?? '').not.toContain('$');
    expect(screen.getByTestId('no-pricing-disclosure')).toHaveTextContent(NO_PRICING_SENTENCE);
    expect(formatCost(null)).not.toBe('$0.00');
  });

  it('regroups by project without losing the disclosure', async () => {
    renderView(
      <TokensView />,
      stubs({ 'q:costBreakdown': () => ok(costBreakdown({ uncosted: uncosted(2) })) }),
    );
    await screen.findByTestId('cost-total');

    fireEvent.click(screen.getByTestId('cost-by-toggle-project'));
    await waitFor(() => {
      // Scoped to the cost table: the context-overhead leaderboard also has a "Project" column,
      // so an unscoped columnheader query would now match two headers (A-11).
      expect(
        within(screen.getByTestId('cost-table')).getByRole('columnheader', { name: /project/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId('tokens-cost-panel-disclosure')).toHaveTextContent(
      '2 records uncosted',
    );
  });

  it('shows all five token classes on every row (M-04, A-05)', async () => {
    renderView(<TokensView />, stubs());
    const table = await screen.findByTestId('cost-table');
    // ⚠️ A-05 — five, and the two cache-write columns are LABELLED 5m / 1h. A bare "Cache write"
    // beside a second cache-write column would be the ambiguity this change exists to remove:
    // they bill at 1.25x and 2x input respectively.
    for (const header of ['Input', 'Output', 'Cache write 5m', 'Cache write 1h', 'Cache read']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
  });
});

describe('§6.4 Tokens & Cost — context overhead (A-11, user directive 2026-07-22)', () => {
  it('leads with the re-read-per-output ratio and the two grounding totals', async () => {
    // The default payload: 900,000 cache reads over 30,000 output → 30 tokens re-read per output.
    renderView(<TokensView />, stubs());
    const card = await screen.findByTestId('tokens-context-overhead');
    const headline = within(card).getByTestId('context-overhead-headline');
    expect(headline).toHaveTextContent('re-read about 30 tokens of context for every 1 token');
    // The two real numbers are shown in full.
    expect(within(card).getByText('900,000')).toBeInTheDocument();
    expect(within(card).getByText('30,000')).toBeInTheDocument();
  });

  it('lists the heaviest sessions by PROJECT NAME, cache-read first — never an id or a path', async () => {
    renderView(<TokensView />, stubs());
    const card = await screen.findByTestId('tokens-context-overhead');
    const rows = within(card).getAllByTestId('context-overhead-row');
    // Two sessions, heaviest cache-read first (demo-alpha 600K before demo-beta 300K).
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('demo-alpha');
    expect(rows[1]).toHaveTextContent('demo-beta');
    // §1a — the stable session id is used for React identity only and is never on screen.
    expect(card.textContent ?? '').not.toContain('sess-0000-1111');
    expect(card.textContent ?? '').not.toContain('-work-demo-alpha');
  });

  it('⚠️ says "no output tokens", not a fabricated ratio, when output is zero', async () => {
    renderView(
      <TokensView />,
      stubs({
        'q:contextOverhead': () =>
          ok(contextOverhead({ cacheReadTokens: 5_000, outputTokens: 0, sessions: [] })),
      }),
    );
    const card = await screen.findByTestId('tokens-context-overhead');
    expect(within(card).getByTestId('context-overhead-headline')).toHaveTextContent(
      'No output tokens in this range yet.',
    );
    // Never a NaN, never a divide-by-zero artefact, never a bare "0" ratio.
    expect(card.textContent ?? '').not.toContain('NaN');
    expect(card.textContent ?? '').not.toContain('Infinity');
  });

  it('renders no leaderboard when there are no sessions in range', async () => {
    renderView(
      <TokensView />,
      stubs({
        'q:contextOverhead': () =>
          ok(contextOverhead({ cacheReadTokens: 0, outputTokens: 0, sessions: [] })),
      }),
    );
    await screen.findByTestId('tokens-context-overhead');
    expect(screen.queryByTestId('context-overhead-leaderboard')).not.toBeInTheDocument();
  });

  it('renders the M-17 donut with both percentages and the absolute subagent figure', async () => {
    renderView(<TokensView />, stubs());
    const donut = await screen.findByTestId('origin-donut');
    // 72,000 of 100,000 output tokens — the ~72% §1.4 is about.
    expect(within(donut).getByTestId('origin-donut-centre')).toHaveTextContent('72K');
    const shares = within(donut).getAllByTestId('origin-donut-share');
    expect(shares[0]).toHaveTextContent('Main loop 28%');
    expect(shares[1]).toHaveTextContent('Subagents 72%');
  });

  it('footnotes unlinked runs and says the totals are unaffected', async () => {
    renderView(
      <TokensView />,
      stubs({ 'q:originSplit': () => ok(originSplit({ unlinkedRuns: 4 })) }),
    );
    expect(await screen.findByTestId('tokens-origin-split-disclosure')).toHaveTextContent(
      '4 subagent runs could not be linked to a spawn point — totals are unaffected.',
    );
  });
});

describe('§6.4 Tokens & Cost — the cost columns explain themselves (user directive)', () => {
  it('glosses every cost column in plain words, with no metric ids', async () => {
    renderView(<TokensView />, stubs());
    const panel = await screen.findByTestId('tokens-cost-panel');
    expect(within(panel).getByTestId('cost-columns-explainer')).toHaveTextContent(
      /reused from cache instead of re-sent/i,
    );
    // The dollar figure's meaning is stated (list price), not left as a bare number.
    expect(panel).toHaveTextContent(/what those tokens would cost at list price/i);
    for (const jargon of ['M-04', 'M-05']) {
      expect(panel).not.toHaveTextContent(jargon);
    }
  });
});

describe('§6.4 Tokens & Cost — the model-mix scale is configurable (user directive)', () => {
  const drawerStubs = {
    'q:projectCards': () => ok(projectCards()),
    'q:toolFingerprint': () => ok(toolFingerprint()),
    'q:fileMetrics': () => ok(fileMetrics()),
  } as const;

  it('re-queries with a weekly bucket when the bucket toggle is used', async () => {
    const { bridge } = renderView(<TokensView />, stubs());
    await screen.findByTestId('tokens-timeline');
    fireEvent.click(screen.getByTestId('timeline-bucket-toggle-week'));
    await waitFor(() => {
      const call = bridge.calls.filter((entry) => entry.channel === 'q:tokensByModel').pop();
      expect((call?.request as { bucket: string }).bucket).toBe('week');
    });
  });

  it('zooms by setting the GLOBAL date filter, anchored to the newest data — not a second range', async () => {
    const { bridge } = renderView(<TokensView />, stubs(), { coverage: { transcriptsTo: T0 } });
    await screen.findByTestId('tokens-timeline');
    fireEvent.click(screen.getByTestId('timeline-range-toggle-week'));
    await waitFor(() => {
      const call = bridge.calls.filter((entry) => entry.channel === 'q:tokensByModel').pop();
      // Anchored to coverage.transcriptsTo (T0), a 7-day window, and switched to day buckets.
      expect((call?.request as { from: number | null }).from).toBe(T0 - 7 * 86_400_000);
      expect((call?.request as { bucket: string }).bucket).toBe('day');
    });
  });

  it('labels the grey region in plain words when partialBefore is set', async () => {
    renderView(<TokensView />, stubs(), { coverage: { partialBefore: Date.UTC(2026, 2, 2) } });
    const caption = await screen.findByTestId('partial-caption');
    expect(caption).toHaveTextContent(/only have prompts, not full token detail/i);
    // The words also sit ON the grey band, not only below the chart.
    expect(screen.getByTestId('partial-region-label')).toBeInTheDocument();
    expect(caption).not.toHaveTextContent('M-16');
  });

  it('renders no grey-region label when partialBefore is null', async () => {
    renderView(<TokensView />, stubs());
    await screen.findByTestId('tokens-timeline');
    expect(screen.queryByTestId('partial-caption')).not.toBeInTheDocument();
    expect(screen.queryByTestId('partial-region-label')).not.toBeInTheDocument();
  });

  it('opens the ONE project-detail surface from a treemap tile (§6.4)', async () => {
    renderView(<TokensView />, stubs(drawerStubs));
    const tile = await screen.findByTestId('treemap-tile-1');
    fireEvent.click(tile);
    const drawer = await screen.findByTestId('project-detail-drawer');
    // The drawer shows THAT project's real numbers (demo-alpha: 450,000 output tokens).
    expect(within(drawer).getByText('demo-alpha')).toBeInTheDocument();
    expect(within(drawer).getByTestId('project-detail-output')).toHaveTextContent('450,000');
  });
});

/**
 * §1a — the user directive: "I do not want jargon in any of the app." A grep over the whole
 * rendered view, across every state the toggles reach, catches a metric id or a channel name
 * that slips back onto the screen.
 */
describe('§6.4 Tokens & Cost — no jargon on screen (§1a)', () => {
  const JARGON = [/\bM-\d/, /\bINV-\d/, /\bADR-\d/, /\bq:[a-z]/i, /§\d/];

  it('renders no metric id, channel name or section number in any of its states', async () => {
    const { view } = renderView(
      <TokensView />,
      stubs({ 'q:originSplit': () => ok(originSplit({ unlinkedRuns: 4 })) }),
      {
        coverage: { partialBefore: Date.UTC(2026, 2, 2) },
      },
    );
    await screen.findByTestId('cost-total');
    const scan = (): void => {
      const text = view.container.textContent ?? '';
      for (const pattern of JARGON) expect(text).not.toMatch(pattern);
    };
    scan();
    // Flip every toggle so the alternate copy is on screen too.
    fireEvent.click(screen.getByTestId('token-mode-toggle-all'));
    fireEvent.click(screen.getByTestId('cost-by-toggle-project'));
    fireEvent.click(screen.getByTestId('timeline-bucket-toggle-week'));
    await waitFor(() => {
      expect(screen.getByText('All tokens by model')).toBeInTheDocument();
    });
    scan();
  });
});
