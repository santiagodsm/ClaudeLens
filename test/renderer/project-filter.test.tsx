/**
 * The global project filter — §6.2 (top bar), §4.2 (`GlobalFilter`), §2.1 ("Global filter"),
 * §3.3 (display names are not identities), §6.12 / FRONTEND §8 (keyboard and non-colour cues).
 *
 * ⚠️ The first suite is a **regression suite for a reported defect**: the filter used to render
 * "all projects" as every row ticked and to start a toggle from "every id", so clicking the one
 * project you wanted *removed* it and kept the rest. Against the old component the first test
 * here asserts `[2]` and receives `[1, 3]`.
 *
 * Everything is driven through `TopBar`, so the assertions run against the real store path
 * (§7.4): a click has not worked until `useAppStore.getState().filter.projectIds` says so.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { TopBar } from '../../src/renderer/shell/TopBar';
import { ALL_PROJECTS_LABEL } from '../../src/renderer/shell/ProjectFilter';
import { ALL_TIME_ALL_PROJECTS, useAppStore } from '../../src/renderer/store/app-store';
import type { ProjectCard } from '../../src/shared/ipc-contract';
import {
  DEFAULT_SETTINGS,
  IDLE_SYNC,
  installBridge,
  renderRouted,
  resetStore,
  uninstallBridge,
} from './harness';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetStore();
});

function card(overrides: Partial<ProjectCard>): ProjectCard {
  return {
    projectId: 1,
    displayName: 'alpha',
    encodedName: '-work-alpha',
    colorIndex: 0,
    sessions: 1,
    outputTokens: 1,
    costNanoUsd: null,
    toolCalls: 0,
    activeSeconds: 0,
    editSparkline: new Array<number>(12).fill(0),
    groupId: null,
    members: [],
    ...overrides,
  };
}

/**
 * Three projects, and **two of them share a display name** (§3.3 — worktrees are siblings and
 * `display_name` is cosmetic). Every fixture in this file carries that collision, so no test can
 * pass by matching on a name.
 */
const ROWS: ProjectCard[] = [
  card({ projectId: 1, displayName: 'alpha', encodedName: '-work-alpha' }),
  card({ projectId: 2, displayName: 'lens', encodedName: '-work-lens', colorIndex: 3 }),
  card({ projectId: 3, displayName: 'lens', encodedName: '-work-lens-wt-fix', colorIndex: 5 }),
];

function renderFilter(rows: ProjectCard[] = ROWS): void {
  installBridge({
    'q:projectCards': () => ({ ok: true, data: { rows, uncosted: { records: 0, byModel: [] } } }),
    'settings:set': () => ({ ok: true, data: DEFAULT_SETTINGS }),
  });
  useAppStore.setState({
    bootstrap: 'ready',
    dirStatus: 'valid',
    schemaVersion: 1,
    sync: IDLE_SYNC,
    filter: ALL_TIME_ALL_PROJECTS,
    settings: { ...DEFAULT_SETTINGS, claudeDir: '/sandbox/claude' },
    reduceMotion: 'reduce',
  });
  renderRouted(<TopBar title="Overview" disabled={false} />);
}

/** Opens the menu and waits for the project rows. */
async function openMenu(): Promise<void> {
  fireEvent.click(screen.getByTestId('project-filter'));
  await screen.findByTestId('project-filter-all');
}

function projectIds(): number[] | null {
  return useAppStore.getState().filter.projectIds;
}

function checkbox(projectId: number): HTMLElement {
  return screen.getByTestId(`project-filter-checkbox-${String(projectId)}`);
}

describe('⚠️ regression — "I select something but it appears I am unselecting it"', () => {
  it('from "all projects", clicking one project selects THAT project, not the other two', async () => {
    renderFilter();
    await openMenu();
    expect(projectIds()).toBeNull(); // the state we start in: all projects

    fireEvent.click(checkbox(2));

    // The reported bug produced [1, 3] here — everything except the one that was clicked.
    await waitFor(() => {
      expect(projectIds()).toEqual([2]);
    });
    expect(checkbox(2)).toBeChecked();
    expect(checkbox(1)).not.toBeChecked();
    expect(checkbox(3)).not.toBeChecked();
  });

  it('⚠️ never renders "all projects" as every row ticked — "all" is its own checked row', async () => {
    renderFilter();
    await openMenu();

    expect(screen.getByTestId('project-filter-all')).toHaveAttribute('aria-pressed', 'true');
    for (const row of ROWS) {
      expect(checkbox(row.projectId)).not.toBeChecked();
    }
    expect(screen.getByTestId('project-filter-summary')).toHaveTextContent('Showing every project');
  });
});

describe('§4.2 — the three states, and only three', () => {
  it('adds a second project without dropping the first', async () => {
    renderFilter();
    await openMenu();

    fireEvent.click(checkbox(1));
    await waitFor(() => {
      expect(projectIds()).toEqual([1]);
    });
    fireEvent.click(checkbox(3));
    await waitFor(() => {
      expect(projectIds()).toEqual([1, 3]);
    });
    expect(screen.getByTestId('project-filter-summary')).toHaveTextContent(
      'Showing 2 of 3 projects',
    );
  });

  it('deselecting back down to none returns to "all", never to an empty result', async () => {
    renderFilter();
    await openMenu();

    fireEvent.click(checkbox(1));
    fireEvent.click(checkbox(3));
    await waitFor(() => {
      expect(projectIds()).toEqual([1, 3]);
    });

    fireEvent.click(checkbox(1));
    await waitFor(() => {
      expect(projectIds()).toEqual([3]);
    });
    fireEvent.click(checkbox(3));

    // ⚠️ `[]` would mean "show nothing" — §4.2 does not define it and nobody asks for it.
    await waitFor(() => {
      expect(projectIds()).toBeNull();
    });
    expect(screen.getByTestId('project-filter')).toHaveTextContent(ALL_PROJECTS_LABEL);
  });

  it('collapses to "all" when every project ends up ticked (one representation of everything)', async () => {
    renderFilter();
    await openMenu();

    fireEvent.click(checkbox(1));
    fireEvent.click(checkbox(2));
    fireEvent.click(checkbox(3));

    await waitFor(() => {
      expect(projectIds()).toBeNull();
    });
    expect(screen.getByTestId('project-filter-all')).toHaveAttribute('aria-pressed', 'true');
  });

  it('gets back to "all" in one click, from the "All projects" row and from Clear', async () => {
    renderFilter();
    await openMenu();

    fireEvent.click(checkbox(2));
    await waitFor(() => {
      expect(projectIds()).toEqual([2]);
    });
    fireEvent.click(screen.getByTestId('project-filter-all'));
    await waitFor(() => {
      expect(projectIds()).toBeNull();
    });
    expect(screen.getByTestId('project-filter-clear')).toBeDisabled();

    fireEvent.click(checkbox(2));
    await waitFor(() => {
      expect(screen.getByTestId('project-filter-clear')).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId('project-filter-clear'));
    await waitFor(() => {
      expect(projectIds()).toBeNull();
    });
  });

  it('"Only" collapses a wider selection to exactly one project', async () => {
    renderFilter();
    await openMenu();

    fireEvent.click(checkbox(1));
    fireEvent.click(checkbox(2));
    await waitFor(() => {
      expect(projectIds()).toEqual([1, 2]);
    });

    fireEvent.click(screen.getByTestId('project-filter-only-3'));
    await waitFor(() => {
      expect(projectIds()).toEqual([3]);
    });
  });
});

describe('§6.2 — the trigger states the filter precisely', () => {
  it('shows "All projects", then the project NAME for one, then "N projects"', async () => {
    renderFilter();
    const trigger = screen.getByTestId('project-filter');
    expect(trigger).toHaveTextContent(ALL_PROJECTS_LABEL);
    expect(trigger).toHaveAttribute('data-state', 'all');

    await openMenu();
    fireEvent.click(checkbox(2));
    await waitFor(() => {
      // The name, not "1 project" — it is more useful and takes the same room.
      expect(trigger).toHaveTextContent('lens');
    });
    expect(trigger).not.toHaveTextContent('1 project');
    expect(trigger).toHaveAttribute('data-state', 'one');
    // §3.3 — the encoded name disambiguates in the tooltip.
    expect(trigger).toHaveAttribute('title', '-work-lens');

    fireEvent.click(checkbox(1));
    await waitFor(() => {
      expect(trigger).toHaveTextContent('2 projects');
    });
    expect(trigger).toHaveAttribute('data-state', 'many');
  });
});

describe('§3.3 — two projects may share a display name', () => {
  it('keeps them independently selectable, by id, and disambiguates by encoded name', async () => {
    renderFilter();
    await openMenu();

    // Same display name, different rows, different tooltips.
    expect(screen.getByTestId('project-filter-option-2')).toHaveAttribute('title', '-work-lens');
    expect(screen.getByTestId('project-filter-option-3')).toHaveAttribute(
      'title',
      '-work-lens-wt-fix',
    );
    expect(screen.getByTestId('project-filter-option-2')).toHaveTextContent('-work-lens');
    expect(screen.getByTestId('project-filter-option-3')).toHaveTextContent('-work-lens-wt-fix');

    fireEvent.click(checkbox(3));
    await waitFor(() => {
      expect(projectIds()).toEqual([3]);
    });
    expect(checkbox(3)).toBeChecked();
    expect(checkbox(2)).not.toBeChecked();

    fireEvent.click(checkbox(2));
    await waitFor(() => {
      expect(projectIds()).toEqual([3, 2]);
    });
    expect(screen.getByTestId('project-filter')).toHaveTextContent('2 projects');
  });
});

describe('§6.12 / FRONTEND §8 — keyboard and non-colour cues', () => {
  it('opens with ArrowDown, arrows through the rows, toggles, and Escape restores focus', async () => {
    renderFilter();
    const trigger = screen.getByTestId('project-filter');
    trigger.focus();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await screen.findByTestId('project-filter-all');
    // Focus lands inside the menu, on the first item — "All projects".
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('project-filter-all'));
    });

    fireEvent.keyDown(document.activeElement ?? trigger, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(checkbox(1));
    fireEvent.keyDown(document.activeElement ?? trigger, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(checkbox(2));
    fireEvent.keyDown(document.activeElement ?? trigger, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(checkbox(1));

    fireEvent.keyDown(checkbox(1), { key: 'Enter' });
    await waitFor(() => {
      expect(projectIds()).toEqual([1]);
    });

    fireEvent.keyDown(document.activeElement ?? trigger, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('project-filter-menu')).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
    // The filter survived the close: Escape dismisses the menu, not the selection.
    expect(projectIds()).toEqual([1]);
  });

  it('labels the trigger and every row for a screen reader', async () => {
    renderFilter();
    const trigger = screen.getByTestId('project-filter');
    expect(trigger).toHaveAttribute('aria-label', `Project filter: ${ALL_PROJECTS_LABEL}`);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await openMenu();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // ⚠️ Selection is a checkbox, not a tint — it survives a monochrome screen (FRONTEND §8).
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(ROWS.length);
    expect(screen.getByLabelText('Show only lens (-work-lens-wt-fix)')).toBeInTheDocument();
  });

  it('does not shift the page: the menu is an overlay, and the trigger keeps its width', async () => {
    renderFilter();
    const trigger = screen.getByTestId('project-filter');
    const classes = trigger.className;

    await openMenu();
    expect(screen.getByTestId('project-filter-menu').className).toContain('absolute');
    // The trigger's box is fixed by tokens, so a longer label cannot reflow the bar (§6.2).
    expect(trigger.className).toBe(classes);
    expect(classes).toContain('min-w-40');
    expect(classes).toContain('max-w-64');
  });
});

describe('the menu is honest about what it does not know (§6.12)', () => {
  it('shows an error rather than an empty project list when the query fails', async () => {
    installBridge({}); // no `q:projectCards` handler at all
    useAppStore.setState({
      bootstrap: 'ready',
      dirStatus: 'valid',
      sync: IDLE_SYNC,
      filter: ALL_TIME_ALL_PROJECTS,
      settings: { ...DEFAULT_SETTINGS, claudeDir: '/sandbox/claude' },
      reduceMotion: 'reduce',
    });
    renderRouted(<TopBar title="Overview" disabled={false} />);

    fireEvent.click(screen.getByTestId('project-filter'));
    expect(await screen.findByTestId('error-state')).toBeInTheDocument();
    expect(screen.queryByTestId('project-filter-all')).toBeNull();
  });

  it('says so when there are no projects, and never emits an empty selection', async () => {
    renderFilter([]);
    fireEvent.click(screen.getByTestId('project-filter'));
    expect(await screen.findByTestId('empty-state')).toHaveTextContent(
      'No projects have been parsed yet',
    );
    expect(projectIds()).toBeNull();
  });
});
