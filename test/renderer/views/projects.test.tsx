/**
 * Projects & Code — §6.8.
 *
 * Two prohibitions are asserted directly, because they are the kind that get "helpfully" undone:
 *   · **"edits", never "lines changed", and no diff anywhere** (§1.6 non-goal 3, M-15);
 *   · **no overlap disclosure**, which §6.8 proves is identically `0` for a single-project scope
 *     (INV-22(d)) and which E1 made compiler-enforced by leaving `overlapSeconds` off
 *     `ProjectCards` entirely.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PROJECTS_EMPTY_REASON, ProjectsView } from '../../../src/renderer/views/ProjectsView';
import { NO_EDITS_SENTENCE } from '../../../src/renderer/views/charts/EditSparkline';
import { DB_BUSY, ok, renderView, resetAll, uninstallBridge } from './view-harness';
import { fileMetrics, projectCard, projectCards, uncosted } from './payloads';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetAll();
});

function stubs(overrides: Partial<Record<string, () => unknown>> = {}) {
  return {
    'q:projectCards': () => ok(projectCards()),
    'q:fileMetrics': () => ok(fileMetrics()),
    ...overrides,
  } as Parameters<typeof renderView>[1];
}

describe('§6.8 Projects & Code — states', () => {
  it('renders skeleton cards at final height rather than zeroed cards', () => {
    renderView(<ProjectsView />, stubs());
    expect(screen.getByTestId('project-card-skeletons')).toBeInTheDocument();
    expect(screen.queryByTestId('project-card')).not.toBeInTheDocument();
  });

  it('renders §6.8’s empty copy verbatim', async () => {
    renderView(<ProjectsView />, stubs({ 'q:projectCards': () => ok(projectCards({ rows: [] })) }));
    expect(await screen.findByTestId('projects-empty')).toHaveTextContent(PROJECTS_EMPTY_REASON);
  });

  it('renders an ErrorState instead of empty cards', async () => {
    renderView(<ProjectsView />, stubs({ 'q:projectCards': () => DB_BUSY }));
    expect(await screen.findByTestId('projects-error')).toHaveAttribute(
      'data-error-code',
      'E_DB_BUSY',
    );
  });

  it('is offline-identical: every call is a local query', async () => {
    const { bridge } = renderView(<ProjectsView />, stubs());
    await screen.findByTestId('project-card');
    expect(bridge.calls.every((call) => call.channel.startsWith('q:'))).toBe(true);
  });
});

describe('§6.8 Projects & Code — the cards', () => {
  it('shows Sessions · Output · Tool calls · Active, with the idle-gap note', async () => {
    renderView(<ProjectsView />, stubs(), { settings: { idleGapMinutes: 20 } });
    const card = await screen.findByTestId('project-card');

    expect(within(card).getByText('Sessions')).toBeInTheDocument();
    expect(within(card).getByText('12')).toBeInTheDocument();
    expect(within(card).getByText('450,000')).toBeInTheDocument();
    expect(within(card).getByText('300')).toBeInTheDocument();
    expect(within(card).getByText('10h 0m')).toBeInTheDocument();
    expect(card).toHaveTextContent('idle gaps >20m removed');
  });

  it('⚠️ renders NO overlap disclosure — INV-22(d) proves it is identically 0 here', async () => {
    renderView(<ProjectsView />, stubs());
    await screen.findByTestId('project-card');
    expect(screen.queryByTestId('overlap-disclosure')).not.toBeInTheDocument();
    expect(screen.getByTestId('view-projects')).not.toHaveTextContent('overlap');
  });

  it('⚠️ labels the sparkline "Edits" and never "lines changed"', async () => {
    renderView(<ProjectsView />, stubs());
    const card = await screen.findByTestId('project-card');

    expect(within(card).getByText('Edits')).toBeInTheDocument();
    expect(within(card).getByTestId('edit-sparkline')).toHaveAttribute(
      'aria-label',
      '27 edits across 12 buckets',
    );
    expect(card).not.toHaveTextContent(/lines? changed/i);
    expect(card).not.toHaveTextContent(/churn/i);
  });

  it('says so in words when a project has no file edits, rather than drawing a flat line', async () => {
    renderView(
      <ProjectsView />,
      stubs({
        'q:projectCards': () =>
          ok(
            projectCards({ rows: [projectCard({ editSparkline: new Array<number>(12).fill(0) })] }),
          ),
      }),
    );
    expect(await screen.findByTestId('edit-sparkline-empty')).toHaveTextContent(NO_EDITS_SENTENCE);
  });

  it('carries the uncosted disclosure for the cards’ $ figures (INV-10)', async () => {
    renderView(
      <ProjectsView />,
      stubs({ 'q:projectCards': () => ok(projectCards({ uncosted: uncosted(4) })) }),
    );
    expect(await screen.findByTestId('uncosted-disclosure')).toHaveTextContent(
      '4 records uncosted',
    );
  });
});

/**
 * §6.8 — the project-detail surface (user directive 2026-07-22, asked for in three places): a
 * card opens the ONE drawer, which carries the project's stats, its files-touched panel and — for
 * a group — its member folders. The treemap tile in Tokens & Cost opens the same drawer.
 */
describe('§6.8 Projects & Code — the project-detail drawer', () => {
  it('opens on card click, showing the project’s real stats and its files (labelled "Edits", no diff)', async () => {
    renderView(<ProjectsView />, stubs());
    fireEvent.click(await screen.findByTestId('project-card-open'));

    const drawer = await screen.findByTestId('project-detail-drawer');
    // The project's hand-checked numbers (demo-alpha: 450,000 output, 12 sessions).
    expect(within(drawer).getByTestId('project-detail-output')).toHaveTextContent('450,000');
    expect(within(drawer).getByTestId('project-detail-sessions')).toHaveTextContent('12');

    const files = await within(drawer).findByTestId('project-detail-files');
    expect(within(files).getByRole('columnheader', { name: 'Edits' })).toBeInTheDocument();
    expect(files).toHaveTextContent(/never lines changed, and no diff is shown/i);
    expect(within(files).getByText('src/index.ts')).toBeInTheDocument();
    // An unmapped extension is surfaced as "other", never guessed (M-15 — in code, not on screen).
    expect(within(files).getByText('other')).toBeInTheDocument();
  });

  it('asks for that project’s files, and only once it is selected', async () => {
    const { bridge } = renderView(<ProjectsView />, stubs());
    await screen.findByTestId('project-card');
    expect(bridge.calls.some((call) => call.channel === 'q:fileMetrics')).toBe(false);

    fireEvent.click(screen.getByTestId('project-card-open'));
    await screen.findByTestId('file-metrics-table');
    const call = bridge.calls.find((entry) => entry.channel === 'q:fileMetrics');
    expect((call?.request as { projectId: number }).projectId).toBe(1);
  });

  it('closes again without leaving the view', async () => {
    renderView(<ProjectsView />, stubs());
    fireEvent.click(await screen.findByTestId('project-card-open'));
    await screen.findByTestId('project-detail-drawer');

    fireEvent.click(screen.getByTestId('project-detail-drawer-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('project-detail-drawer')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('view-projects')).toBeInTheDocument();
  });

  it('opens from the keyboard', async () => {
    renderView(<ProjectsView />, stubs());
    const open = await screen.findByTestId('project-card-open');
    open.focus();
    expect(document.activeElement).toBe(open);
    fireEvent.click(open);
    expect(await screen.findByTestId('project-detail-drawer')).toBeInTheDocument();
  });

  it('carries no jargon on screen (§1a)', async () => {
    const { view } = renderView(<ProjectsView />, stubs());
    fireEvent.click(await screen.findByTestId('project-card-open'));
    await screen.findByTestId('project-detail-drawer');
    const text = view.container.textContent ?? '';
    for (const jargon of [/\bM-\d/, /\bINV-\d/, /\bADR-\d/, /\bq:[a-z]/i, /§\d/]) {
      expect(text).not.toMatch(jargon);
    }
  });
});

/**
 * ADR-040 — "these two projects are the same project", the action and what it produces.
 *
 * ⚠️ Two things are asserted that would otherwise be quietly lost:
 *   · **nothing suggests a grouping** — no bar, no hint, no candidate list, until the user has
 *     ticked two cards themselves (§2.1, zero inference);
 *   · **plain language on screen** (§1a) — no metric ids, no "merge", no "entity", no section
 *     numbers anywhere on the grouping surface.
 */
describe('§6.8 Projects & Code — saying two projects are the same (ADR-040)', () => {
  const alpha = projectCard({
    projectId: 1,
    displayName: 'Photo-Booth',
    encodedName: '-work-demo-family-app-old',
    members: [
      {
        projectId: 1,
        displayName: 'Photo-Booth',
        encodedName: '-work-demo-family-app-old',
        colorIndex: 0,
        outputTokens: 10,
        sessions: 1,
        toolCalls: 0,
        activeSeconds: 1_200,
      },
    ],
  });
  const beta = projectCard({
    projectId: 2,
    displayName: 'Photo-Booth',
    encodedName: '-work-demo-family-app-new',
    colorIndex: 3,
    members: [
      {
        projectId: 2,
        displayName: 'Photo-Booth',
        encodedName: '-work-demo-family-app-new',
        colorIndex: 3,
        outputTokens: 20,
        sessions: 1,
        toolCalls: 0,
        activeSeconds: 1_200,
      },
    ],
  });

  it('offers nothing until the user has ticked two cards themselves', async () => {
    renderView(
      <ProjectsView />,
      stubs({ 'q:projectCards': () => ok(projectCards({ rows: [alpha, beta] })) }),
    );
    await screen.findAllByTestId('project-card');
    // ⚠️ The two cards are one `mv` apart and share a display name — exactly what a name-matching
    // heuristic would pounce on. Nothing is offered.
    expect(screen.queryByTestId('same-project-bar')).not.toBeInTheDocument();
    expect(screen.queryByText(/same project/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('project-card-tick-1'));
    // One tick is not an offer either: the bar explains, and does not yet propose.
    expect(screen.getByTestId('same-project-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('same-project-start')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('project-card-tick-2'));
    expect(screen.getByTestId('same-project-start')).toHaveTextContent(
      'These are the same project',
    );
  });

  it('sends the FOLDER names, never the project ids (§3.3, the rebuild trap)', async () => {
    const { bridge } = renderView(
      <ProjectsView />,
      stubs({
        'q:projectCards': () => ok(projectCards({ rows: [alpha, beta] })),
        'groups:create': () => ok({ rows: [] }),
      }),
    );
    await screen.findAllByTestId('project-card');
    fireEvent.click(screen.getByTestId('project-card-tick-1'));
    fireEvent.click(screen.getByTestId('project-card-tick-2'));
    fireEvent.click(screen.getByTestId('same-project-start'));
    fireEvent.change(screen.getByTestId('same-project-name'), {
      target: { value: 'Family App' },
    });
    fireEvent.click(screen.getByTestId('same-project-save'));

    await waitFor(() => {
      expect(bridge.calls.some((call) => call.channel === 'groups:create')).toBe(true);
    });
    const call = bridge.calls.find((entry) => entry.channel === 'groups:create');
    expect(call?.request).toEqual({
      name: 'Family App',
      // ⚠️ `encoded_name`s. `projects.id` is a surrogate on a DERIVED table and a rebuild
      // renumbers it, so a group sent by id would re-point at the wrong folders afterwards.
      encodedNames: ['-work-demo-family-app-old', '-work-demo-family-app-new'],
    });
  });

  it('states the failure where the action was taken, and keeps the selection', async () => {
    renderView(
      <ProjectsView />,
      stubs({
        'q:projectCards': () => ok(projectCards({ rows: [alpha, beta] })),
        'groups:create': () => DB_BUSY,
      }),
    );
    await screen.findAllByTestId('project-card');
    fireEvent.click(screen.getByTestId('project-card-tick-1'));
    fireEvent.click(screen.getByTestId('project-card-tick-2'));
    fireEvent.click(screen.getByTestId('same-project-start'));
    fireEvent.change(screen.getByTestId('same-project-name'), { target: { value: 'Family App' } });
    fireEvent.click(screen.getByTestId('same-project-save'));

    expect(await screen.findByTestId('same-project-error')).toHaveTextContent(
      'The database is busy.',
    );
    // The user's selection is still theirs; nothing was silently cleared.
    expect(screen.getByTestId('project-card-tick-1')).toBeChecked();
  });

  it('renders a group as one card and shows its folders with their own numbers', async () => {
    const group = projectCard({
      projectId: -7,
      groupId: 7,
      displayName: 'Family App',
      encodedName: null,
      activeSeconds: 3_300,
      members: [...(alpha.members ?? []), ...(beta.members ?? [])],
    });
    renderView(
      <ProjectsView />,
      stubs({ 'q:projectCards': () => ok(projectCards({ rows: [group] })) }),
    );
    const card = await screen.findByTestId('project-card');
    expect(card).toHaveTextContent('2 folders');
    expect(screen.getByTestId('project-card-grouped')).toHaveTextContent(
      'You said these 2 folders are the same project',
    );

    fireEvent.click(screen.getByTestId('project-card-open'));
    const panel = await screen.findByTestId('project-group-members');
    expect(within(panel).getByText('-work-demo-family-app-old')).toBeInTheDocument();
    expect(within(panel).getByText('-work-demo-family-app-new')).toBeInTheDocument();
    // ⚠️ The honest caption: 20m + 20m is not the card's 55m, and the screen says why in plain
    // words rather than leaving two numbers that look like they should add up (§1a).
    expect(panel).toHaveTextContent('do not add up');
    expect(panel).toHaveTextContent('55m');
  });

  it('uses plain language everywhere on the grouping surface (§1a)', async () => {
    renderView(
      <ProjectsView />,
      stubs({ 'q:projectCards': () => ok(projectCards({ rows: [alpha, beta] })) }),
    );
    await screen.findAllByTestId('project-card');
    fireEvent.click(screen.getByTestId('project-card-tick-1'));
    fireEvent.click(screen.getByTestId('project-card-tick-2'));
    fireEvent.click(screen.getByTestId('same-project-start'));
    const bar = screen.getByTestId('same-project-bar');
    for (const jargon of [/merge/i, /entity/i, /ADR-/, /M-0/, /§/, /unit id/i, /encoded/i]) {
      expect(bar.textContent ?? '').not.toMatch(jargon);
    }
  });
});
