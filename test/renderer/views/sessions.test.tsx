/**
 * Sessions & Time — §6.5.
 *
 * The load-bearing assertion here is the **binding** one: the marathon card ranks *working days*
 * (M-07 binding (B)) while the table's Active column is *sessions* (binding (A)). §5.9 M-10
 * calls the asymmetry out explicitly — "they are different nouns and may name different winners"
 * — so the card must say "working days" on the surface, not only in a comment.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SESSIONS_EMPTY_REASON, SessionsView } from '../../../src/renderer/views/SessionsView';
import { useAppStore } from '../../../src/renderer/store/app-store';
import { DB_BUSY, ok, renderView, resetAll, uninstallBridge } from './view-harness';
import {
  rhythmHeatmap,
  sessionDetail,
  sessionHistogram,
  sessionRow,
  sessionsPage,
  uncosted,
  workingDays,
} from './payloads';

/**
 * A synthetic archive destination (§9.3's `<archiveRoot>/<basename>-<id>`). Never a real path:
 * no test in this repository may contain a personal path (CLAUDE.md §7, P-33).
 */
const ARCHIVE_ROOT = '/sandbox/archive/claude-1';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetAll();
});

function stubs(overrides: Partial<Record<string, () => unknown>> = {}) {
  return {
    'q:sessionHistogram': () => ok(sessionHistogram()),
    'q:rhythmHeatmap': () => ok(rhythmHeatmap()),
    'q:workingDays': () => ok(workingDays()),
    'q:sessions': () => ok(sessionsPage()),
    'q:sessionDetail': () => ok(sessionDetail()),
    ...overrides,
  } as Parameters<typeof renderView>[1];
}

describe('§6.5 Sessions & Time — states', () => {
  it('renders loading skeletons rather than an empty table', () => {
    renderView(<SessionsView />, stubs());
    expect(screen.getAllByTestId('loading-state').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('sessions-table')).not.toBeInTheDocument();
  });

  it('renders §6.5’s empty copy with a control that clears the global filter', async () => {
    renderView(
      <SessionsView />,
      stubs({
        'q:sessions': () =>
          ok(sessionsPage({ page: { rows: [], nextCursor: null, totalKnown: 0 } })),
      }),
      { settings: {} },
    );
    useAppStore.setState({ filter: { projectIds: [7], from: null, to: null } });

    expect(await screen.findByTestId('sessions-empty')).toHaveTextContent(SESSIONS_EMPTY_REASON);
    fireEvent.click(screen.getByTestId('clear-global-filter'));
    expect(useAppStore.getState().filter).toEqual({ projectIds: null, from: null, to: null });
  });

  it('renders a per-card ErrorState and keeps the other cards alive', async () => {
    renderView(<SessionsView />, stubs({ 'q:rhythmHeatmap': () => DB_BUSY }));
    const card = await screen.findByTestId('sessions-rhythm');
    expect(within(card).getByTestId('error-state')).toBeInTheDocument();
    expect(await screen.findByTestId('sessions-table')).toBeInTheDocument();
  });

  it('⚠️ renders the Rhythm grid with visible, valued cells — not axes over nothing', async () => {
    // ⚠️ REGRESSION (§6.5). The card rendered its `0 6 12 18` / `Sun…Sat` axes and a full 7 × 24
    // grid of cells that had no box: `HeatmapCell`'s `<span>` is `display: inline`, so `size-4`
    // was inert and every cell laid out ~2 px wide. The payload was correct the whole time — 155
    // populated cells over the real dataset — which is precisely why nothing failed.
    //
    // Three facts are pinned, because any one of them alone is passable while blank: the grid is
    // complete (7 × 24), the busiest payload cell reaches the grid with its count intact, and
    // every cell declares its own box.
    renderView(<SessionsView />, stubs());
    const card = await screen.findByTestId('sessions-rhythm');
    const cells = within(card).getAllByTestId('heatmap-cell');
    expect(cells).toHaveLength(7 * 24);

    // `rhythmHeatmap()` stubs (1, 9) = 40, (1, 10) = 25, (3, 14) = 60. `weekday` is SQLite's `%w`,
    // so 1 = Mon and 3 = Wed (§6.5) — a Sunday-vs-Monday off-by-one would fail here.
    expect(within(card).getByLabelText('Wed 14:00: 60 events')).toBeInTheDocument();
    expect(within(card).getByLabelText('Mon 09:00: 40 events')).toBeInTheDocument();
    // An omitted `(weekday, hour)` is a KNOWN zero, not "no observation" (§6.12) — it renders as
    // the lowest occupied stop and carries no `data-empty`.
    const knownZero = within(card).getByLabelText('Sat 03:00: 0 events');
    expect(knownZero).not.toHaveAttribute('data-empty');

    // ⚠️ The fix itself. Without a block-forming display the cells exist in the DOM and occupy no
    // space, which is exactly the state that shipped. The Rhythm grid uses `fill` (full-width
    // `block` cells that grow with the window, user request 2026-07-23); `block` is block-forming
    // just as `inline-block` was, so `w-full`/`h-5` apply and the grid can never collapse again.
    for (const cell of cells) {
      expect(cell).toHaveClass('block', 'w-full');
      expect(cell).not.toHaveClass('inline');
    }
  });

  it('is offline-identical: every call is a local query', async () => {
    const { bridge } = renderView(<SessionsView />, stubs());
    await screen.findByTestId('sessions-table');
    expect(bridge.calls.every((call) => call.channel.startsWith('q:'))).toBe(true);
  });
});

describe('§6.5 Sessions & Time — the header and the bindings', () => {
  it('carries the session count in the header (moved here from the Overview tile row)', async () => {
    renderView(<SessionsView />, stubs());
    expect(await screen.findByTestId('sessions-header')).toHaveTextContent(
      '42 sessions · click a row to inspect',
    );
  });

  it('⚠️ says the marathon rows are WORKING DAYS, not sessions', async () => {
    renderView(<SessionsView />, stubs(), { settings: { idleGapMinutes: 15 } });
    const card = await screen.findByTestId('sessions-marathons');

    expect(card).toHaveTextContent('Working days — ranked by active time (idle gaps >15m removed)');
    expect(card).toHaveTextContent(
      'A working day is one calendar day of work on a single project — not the same as a session.',
    );
    expect(within(card).getAllByTestId('gradient-bars-row')).toHaveLength(3);
  });

  it('labels the histogram and the table with plain per-session wording', async () => {
    renderView(<SessionsView />, stubs());
    expect(await screen.findByTestId('sessions-histogram')).toHaveTextContent(
      'One bar per session, grouped by how much active time it held',
    );
    expect(screen.getByTestId('sessions-table-card')).toHaveTextContent(
      'Active time here is measured per session, with idle gaps removed',
    );
  });

  it('hatches marathon rows whose day precedes partialBefore (§6.12)', async () => {
    renderView(<SessionsView />, stubs(), {
      // 2026-03-02 local: the 2026-03-01 row precedes it, the others do not.
      coverage: { partialBefore: new Date(2026, 2, 2).getTime() },
    });
    await screen.findByTestId('sessions-marathons');
    const bars = screen.getAllByTestId('gradient-bars-bar');
    expect(bars[0]?.getAttribute('style') ?? '').toContain('var(--hatch)');
    expect(bars[2]?.getAttribute('style') ?? '').not.toContain('var(--hatch)');
  });
});

describe('§6.5 Sessions & Time — the table', () => {
  it('sorts server-side: clicking a header re-queries with that sort key', async () => {
    const { bridge } = renderView(<SessionsView />, stubs());
    await screen.findByTestId('sessions-table');

    fireEvent.click(screen.getByRole('button', { name: /Active/ }));
    await waitFor(() => {
      const last = bridge.calls.filter((call) => call.channel === 'q:sessions').at(-1);
      expect((last?.request as { sort: string }).sort).toBe('activeSeconds');
    });
    expect(screen.getByRole('columnheader', { name: /Active/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('shows a neutral "partial" badge and no message content', async () => {
    renderView(
      <SessionsView />,
      stubs({
        'q:sessions': () =>
          ok(
            sessionsPage({
              page: {
                rows: [{ ...sessionsPage().page.rows[0]!, isPartial: true }],
                nextCursor: null,
                totalKnown: 1,
              },
            }),
          ),
      }),
    );
    expect(await screen.findByTestId('session-partial-badge')).toHaveTextContent('partial');
  });

  it('⚠️ badges an archived session NEUTRALLY, naming the archive root (§6.5, INV-18)', async () => {
    renderView(
      <SessionsView />,
      stubs({
        'q:sessions': () =>
          ok(
            sessionsPage({
              page: {
                rows: [
                  sessionRow({ id: 'sess-live' }),
                  sessionRow({
                    id: 'sess-archived',
                    archiveId: 1,
                    archiveRoot: ARCHIVE_ROOT,
                  }),
                ],
                nextCursor: null,
                totalKnown: 2,
              },
            }),
          ),
      }),
    );

    // Exactly one badge for two rows: the live session is not a degraded state and carries none.
    const badges = await screen.findAllByTestId('session-archived-badge');
    expect(badges).toHaveLength(1);
    // §6.5 — it NAMES the archive root; §3.15: "an archive you cannot find is a delete with
    // extra steps".
    expect(badges[0]).toHaveTextContent('archived');
    expect(badges[0]).toHaveTextContent(ARCHIVE_ROOT);

    // ⚠️⚠️ The tone assertion is the point of this test. An archived session's numbers are
    // complete and unchanged (INV-18), so a `warn`/`danger` badge would tell the user their data
    // is at risk — a false statement made in colour. A later restyle must fail HERE.
    expect(badges[0]).toHaveAttribute('data-tone', 'neutral');
    expect(badges[0]?.getAttribute('data-tone')).not.toBe('warn');
    expect(badges[0]?.getAttribute('data-tone')).not.toBe('danger');
  });

  it('shows no archived badge at all when every session is live', async () => {
    renderView(<SessionsView />, stubs());
    await screen.findByTestId('sessions-table');
    expect(screen.queryByTestId('session-archived-badge')).not.toBeInTheDocument();
  });

  it('renders the uncosted disclosure beside the table’s $ figures (INV-10)', async () => {
    renderView(
      <SessionsView />,
      stubs({ 'q:sessions': () => ok(sessionsPage({ uncosted: uncosted(5) })) }),
    );
    expect(await screen.findByTestId('sessions-table-card-disclosure')).toHaveTextContent(
      '5 records uncosted',
    );
  });

  it('keeps the last good page and shows a retry strip when the query fails (§6.5)', async () => {
    let fail = false;
    renderView(<SessionsView />, {
      ...stubs(),
      'q:sessions': () => (fail ? DB_BUSY : ok(sessionsPage())),
    });
    await screen.findByTestId('sessions-table');

    // Any re-query will do; a sort click is the one a user actually performs.
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: /Span/ }));

    expect(await screen.findByTestId('sessions-retry-strip')).toHaveTextContent('E_DB_BUSY');
    // ⚠️ Retained AND labelled — never retained and silent.
    expect(screen.getByTestId('sessions-table')).toBeInTheDocument();
  });
});

describe('§6.5 Sessions & Time — the drill-down drawer', () => {
  it('opens on row click, shows metadata only, and closes again', async () => {
    renderView(<SessionsView />, stubs());
    const rows = await screen.findAllByTestId('sessions-table-row');
    expect(screen.queryByTestId('session-drawer')).not.toBeInTheDocument();

    fireEvent.click(rows[0]!);
    const drawer = await screen.findByTestId('session-drawer');

    expect(within(drawer).getByText('main')).toBeInTheDocument();
    expect(within(drawer).getByTestId('drawer-cost')).toHaveTextContent('$1.50');
    // §3.7 — `linked` is shown honestly, both ways.
    const badges = within(drawer).getAllByTestId('subagent-linked-badge');
    expect(badges[0]).toHaveTextContent('linked');
    expect(badges[1]).toHaveTextContent('not linked to a spawn point');

    fireEvent.click(within(drawer).getByTestId('session-drawer-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('session-drawer')).not.toBeInTheDocument();
    });
  });

  it('opens from the keyboard and closes on Escape (P-30)', async () => {
    renderView(<SessionsView />, stubs());
    const rows = await screen.findAllByTestId('sessions-table-row');

    rows[0]?.focus();
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);

    fireEvent.keyDown(rows[1]!, { key: 'Enter' });
    const drawer = await screen.findByTestId('session-drawer');
    expect(document.activeElement).toBe(drawer);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('session-drawer')).not.toBeInTheDocument();
    });
  });

  it('⚠️ carries the same neutral archived badge in the drawer, naming the root (§6.5)', async () => {
    renderView(
      <SessionsView />,
      stubs({
        'q:sessionDetail': () => ok(sessionDetail({ archiveId: 4, archiveRoot: ARCHIVE_ROOT })),
      }),
    );
    const rows = await screen.findAllByTestId('sessions-table-row');
    fireEvent.click(rows[0]!);
    const drawer = await screen.findByTestId('session-drawer');

    const badge = within(drawer).getByTestId('session-archived-badge');
    expect(badge).toHaveTextContent('archived');
    expect(badge).toHaveTextContent(ARCHIVE_ROOT);
    // Neutral in the drawer too — INV-18 does not stop applying because the drawer is open.
    expect(badge).toHaveAttribute('data-tone', 'neutral');
  });

  it('shows no archived badge in the drawer for a live session', async () => {
    renderView(<SessionsView />, stubs());
    const rows = await screen.findAllByTestId('sessions-table-row');
    fireEvent.click(rows[0]!);
    const drawer = await screen.findByTestId('session-drawer');
    expect(within(drawer).queryByTestId('session-archived-badge')).not.toBeInTheDocument();
  });

  it('⚠️ never shows message content — the drawer asks for none', async () => {
    const { bridge } = renderView(<SessionsView />, stubs());
    const rows = await screen.findAllByTestId('sessions-table-row');
    fireEvent.click(rows[0]!);
    await screen.findByTestId('session-drawer');

    // §1.6 non-goal 1: there is no channel that returns message text, and this view calls none.
    const channels = new Set(bridge.calls.map((call) => call.channel));
    expect([...channels].every((channel) => channel.startsWith('q:'))).toBe(true);
    expect(channels.has('q:sessionDetail')).toBe(true);
  });
});

/**
 * §6.5 — the session-length histogram is a filter: clicking a bar narrows the sessions table
 * below to the sessions of that active-time range, still drilling through to the same detail
 * drawer. The bars are the pointer target; the bucket buttons are the keyboard / AT path, and the
 * one this component test drives (a Recharts bar has no box in jsdom).
 */
describe('§6.5 Sessions & Time — the histogram filters the table', () => {
  // Clean bucket boundaries and sessions chosen to STRADDLE the 15–30m boundary, so the filter is
  // proved on a real edge rather than a comfortable middle. Hand-computed placement by
  // `activeSeconds`:
  //   under-app      600s → under 15m   (600 < 900)
  //   edge-app       900s → 15 to 30m   (900 is the lower edge, inclusive)
  //   nearly-app    1799s → 15 to 30m   (1 second under the 1800 upper edge)
  //   marathon-app  9000s → 2 to 4h     (7200 ≤ 9000 < 14400)
  const HISTOGRAM = {
    buckets: [
      { label: '<15m', lowerSeconds: 0, upperSeconds: 900, count: 1 },
      { label: '15–30m', lowerSeconds: 900, upperSeconds: 1800, count: 2 },
      { label: '2–4h', lowerSeconds: 7200, upperSeconds: 14400, count: 1 },
    ],
  };
  const PAGE = sessionsPage({
    page: {
      rows: [
        sessionRow({ id: 's-under', displayName: 'under-app', activeSeconds: 600 }),
        sessionRow({ id: 's-edge', displayName: 'edge-app', activeSeconds: 900 }),
        sessionRow({ id: 's-nearly', displayName: 'nearly-app', activeSeconds: 1799 }),
        sessionRow({ id: 's-marathon', displayName: 'marathon-app', activeSeconds: 9000 }),
      ],
      nextCursor: null,
      totalKnown: 4,
    },
  });

  function bucketStubs() {
    return stubs({
      'q:sessionHistogram': () => ok(HISTOGRAM),
      'q:sessions': () => ok(PAGE),
    });
  }

  const the15to30Button = (): HTMLElement =>
    screen.getByRole('button', { name: /Show 2 sessions lasting 15 to 30 minutes/ });

  it('reveals exactly the sessions in the clicked range, each with its project name', async () => {
    renderView(<SessionsView />, bucketStubs());
    expect(await screen.findAllByTestId('sessions-table-row')).toHaveLength(4);

    fireEvent.click(the15to30Button());

    const visible = screen.getAllByTestId('sessions-table-row');
    expect(visible).toHaveLength(2);
    const text = visible.map((row) => row.textContent ?? '').join(' | ');
    // The two straddling the boundary, and their project names carried through.
    expect(text).toContain('edge-app');
    expect(text).toContain('nearly-app');
    // Neither the shorter nor the far-longer session leaks in.
    expect(text).not.toContain('under-app');
    expect(text).not.toContain('marathon-app');

    // ⚠️ Plain language: the chip names the range in words, never a bucket id (§1a).
    expect(screen.getByTestId('sessions-bucket-chip')).toHaveTextContent(
      'Showing sessions lasting 15 to 30 minutes',
    );
  });

  it('drills a bucketed session through to the existing detail drawer', async () => {
    renderView(<SessionsView />, bucketStubs());
    await screen.findAllByTestId('sessions-table-row');
    fireEvent.click(the15to30Button());

    fireEvent.click(screen.getAllByTestId('sessions-table-row')[0]!);
    expect(await screen.findByTestId('session-drawer')).toBeInTheDocument();
  });

  it('clears the bucket and restores the whole page', async () => {
    renderView(<SessionsView />, bucketStubs());
    await screen.findAllByTestId('sessions-table-row');
    fireEvent.click(the15to30Button());
    expect(screen.getAllByTestId('sessions-table-row')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('sessions-bucket-clear'));
    expect(screen.getAllByTestId('sessions-table-row')).toHaveLength(4);
    expect(screen.queryByTestId('sessions-bucket-chip')).not.toBeInTheDocument();
  });

  it('operates the bar filter from the keyboard (Enter on a focused bucket)', async () => {
    renderView(<SessionsView />, bucketStubs());
    await screen.findAllByTestId('sessions-table-row');

    const button = the15to30Button();
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: 'Enter' });

    expect(screen.getAllByTestId('sessions-table-row')).toHaveLength(2);
  });

  it('keeps the bucket buttons and chip free of jargon (§1a)', async () => {
    renderView(<SessionsView />, bucketStubs());
    await screen.findAllByTestId('sessions-table-row');

    const jargon = [/M-\d/, /INV-\d/, /ADR-/, /§/, /q:[a-z]/i, /binding \([ABC]\)/i];
    for (const button of screen.getAllByTestId('session-histogram-bucket')) {
      for (const pattern of jargon) expect(button.textContent ?? '').not.toMatch(pattern);
    }

    fireEvent.click(the15to30Button());
    const chip = screen.getByTestId('sessions-bucket-chip');
    for (const pattern of jargon) expect(chip.textContent ?? '').not.toMatch(pattern);
  });
});

/**
 * §6.5 — the marathon board is reorderable and groupable, and every row stays a WORKING DAY
 * (M-07 binding (B)); §5.9 M-10's asymmetry means the board and the "longest session" can name
 * different winners, so nothing here may quietly turn a day into a session.
 */
describe('§6.5 Sessions & Time — marathon ordering and grouping', () => {
  // Distinct active / span / sessions / date on each row, so every sort key gives a distinguishable
  // order and grouping gathers project 1's two days.
  const MARATHONS = {
    rows: [
      {
        day: '2026-03-01',
        projectId: 1,
        displayName: 'alpha-app',
        colorIndex: 0,
        activeSeconds: 30_000,
        spanSeconds: 31_000,
        sessions: 2,
      },
      {
        day: '2026-03-05',
        projectId: 2,
        displayName: 'beta-app',
        colorIndex: 1,
        activeSeconds: 20_000,
        spanSeconds: 50_000,
        sessions: 5,
      },
      {
        day: '2026-03-03',
        projectId: 1,
        displayName: 'alpha-app',
        colorIndex: 0,
        activeSeconds: 10_000,
        spanSeconds: 12_000,
        sessions: 9,
      },
    ],
    nextCursor: null,
    totalKnown: 3,
  };

  function marathonStubs() {
    return stubs({ 'q:workingDays': () => ok(MARATHONS) });
  }

  /** The day of each board row, top to bottom — the observable proof of the current order. */
  function dayOrder(): string[] {
    return screen
      .getAllByTestId('gradient-bars-row')
      .map((row) => /2026-03-\d\d/.exec(row.textContent ?? '')?.[0] ?? '');
  }

  it('orders the board by active time, span, session count or date', async () => {
    renderView(<SessionsView />, marathonStubs());
    await screen.findByTestId('sessions-marathons');

    // Default: active time, descending — 30_000, 20_000, 10_000.
    expect(dayOrder()).toEqual(['2026-03-01', '2026-03-05', '2026-03-03']);

    // Span: 50_000 (beta 03-05), 31_000 (alpha 03-01), 12_000 (alpha 03-03).
    fireEvent.click(screen.getByTestId('marathon-sort-span'));
    expect(dayOrder()).toEqual(['2026-03-05', '2026-03-01', '2026-03-03']);

    // Sessions: 9 (03-03), 5 (03-05), 2 (03-01).
    fireEvent.click(screen.getByTestId('marathon-sort-sessions'));
    expect(dayOrder()).toEqual(['2026-03-03', '2026-03-05', '2026-03-01']);

    // Date: newest first.
    fireEvent.click(screen.getByTestId('marathon-sort-date'));
    expect(dayOrder()).toEqual(['2026-03-05', '2026-03-03', '2026-03-01']);
  });

  it('groups by project, gathering a project’s marathon days together', async () => {
    renderView(<SessionsView />, marathonStubs());
    await screen.findByTestId('sessions-marathons');

    fireEvent.click(screen.getByTestId('marathon-group-project'));

    const groups = screen.getAllByTestId('marathon-group-section');
    expect(groups).toHaveLength(2); // alpha-app (two days) + beta-app (one day)

    const alpha = groups.find((group) =>
      (group.getAttribute('aria-label') ?? '').includes('alpha-app'),
    );
    const alphaRows = within(alpha!).getAllByTestId('gradient-bars-row');
    expect(alphaRows).toHaveLength(2);
    const alphaText = alphaRows.map((row) => row.textContent ?? '').join(' ');
    expect(alphaText).toContain('2026-03-01');
    expect(alphaText).toContain('2026-03-03');

    const beta = groups.find((group) =>
      (group.getAttribute('aria-label') ?? '').includes('beta-app'),
    );
    expect(within(beta!).getAllByTestId('gradient-bars-row')).toHaveLength(1);
  });

  it('⚠️ keeps the rows labelled as WORKING DAYS through every sort and group (M-10)', async () => {
    renderView(<SessionsView />, marathonStubs(), { settings: { idleGapMinutes: 15 } });
    const card = await screen.findByTestId('sessions-marathons');

    // Subtitle and footer name the noun in the card's own words.
    expect(card).toHaveTextContent('Working days');
    expect(card).toHaveTextContent('not the same as a session');

    fireEvent.click(screen.getByTestId('marathon-group-project'));
    fireEvent.click(screen.getByTestId('marathon-sort-sessions'));

    // Each group heading counts working DAYS — never sessions.
    const headings = screen.getAllByTestId('marathon-group-heading');
    expect(headings.every((heading) => /working days?/.test(heading.textContent ?? ''))).toBe(true);
  });

  it('operates the sort and group controls from the keyboard (P-30)', async () => {
    renderView(<SessionsView />, marathonStubs());
    await screen.findByTestId('sessions-marathons');

    // ArrowRight moves the sort radiogroup active → span.
    fireEvent.keyDown(screen.getByTestId('marathon-sort'), { key: 'ArrowRight' });
    expect(screen.getByTestId('marathon-sort-span')).toHaveAttribute('aria-checked', 'true');

    // ArrowRight moves the group radiogroup none → project.
    fireEvent.keyDown(screen.getByTestId('marathon-group'), { key: 'ArrowRight' });
    expect(screen.getByTestId('marathon-group-project')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByTestId('marathon-group-section').length).toBeGreaterThan(1);
  });

  it('keeps the sort and group controls free of jargon (§1a)', async () => {
    renderView(<SessionsView />, marathonStubs());
    await screen.findByTestId('sessions-marathons');

    const controls = screen.getByTestId('marathon-controls');
    for (const pattern of [/M-\d/, /INV-\d/, /ADR-/, /§/, /q:[a-z]/i, /binding \([ABC]\)/i]) {
      expect(controls.textContent ?? '').not.toMatch(pattern);
    }
  });
});
