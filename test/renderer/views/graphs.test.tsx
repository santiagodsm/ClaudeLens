/**
 * Graphs & Harness Flow — §6.7.
 *
 * The rules this suite exists to hold:
 *   · one shell, four tabs, and **all four states on every one of them** (§6.7's state table);
 *   · §6.7's empty copy **verbatim**, per tab, because "select a session" and "no costed or
 *     counted flows in range" are different claims a reader can act on;
 *   · the Harness Map's legend distinguishing **designed-only, observed-only and both** — the
 *     Degraded row, and the whole reason `designed` and `observed` are two fields (§4.5);
 *   · P-23's "showing top 500" label appearing **only** when the graph was actually capped;
 *   · the Execution Trace's **unlinked lane**, labelled, with no guessed parent (§3.7, ADR-020);
 *   · the inspector's **280-character** prompt cap — the only prompt text in the app (§3.9);
 *   · **no chart re-animates on a data update** (§6.12, §1.3 moment 2).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { GraphsView } from '../../../src/renderer/views/GraphsView';
import { NodeInspector } from '../../../src/renderer/views/graphs/NodeInspector';
import { UNLINKED_LANE_LABEL } from '../../../src/renderer/views/graphs/ExecutionTraceTab';
import { GRAPH_TABS } from '../../../src/renderer/views/graphs/tabs';
import { useAppStore } from '../../../src/renderer/store/app-store';
import { DB_BUSY, ok, renderView, resetAll, uninstallBridge } from './view-harness';
import { renderRouted } from '../harness';
import {
  executionTrace,
  flowSankey,
  harnessGraph,
  harnessGraphMultiProject,
  toolTransition,
  wideGraph,
} from './graph-payloads';
import { sessionsPage } from './payloads';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetAll();
});

function stubs(overrides: Record<string, () => unknown> = {}) {
  return {
    'q:harnessGraph': () => ok(harnessGraph()),
    'q:executionTrace': () => ok(executionTrace()),
    'q:toolTransition': () => ok(toolTransition()),
    'q:flowSankey': () => ok(flowSankey()),
    'q:sessions': () => ok(sessionsPage()),
    ...overrides,
  } as Parameters<typeof renderView>[1];
}

function openTab(tab: string): void {
  fireEvent.click(screen.getByTestId(`graphs-tab-${tab}`));
}

/** The Execution Trace's top row — the main loop, which is the bar a prompt belongs to (§3.9). */
function mainLoopRow(): HTMLElement {
  const row = screen
    .getAllByTestId('trace-row')
    .find((candidate) => candidate.dataset['rowKind'] === 'main');
  if (row === undefined) throw new Error('no main-loop row on the Execution Trace');
  return row;
}

// ---------------------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------------------

describe('§6.7 — one shell, four tabs', () => {
  it('renders exactly the four tabs §6.7 names, and no fifth', async () => {
    renderView(<GraphsView />, stubs());
    const tablist = await screen.findByTestId('graphs-tabs');
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Harness Map',
      'Execution Trace',
      'Tool Transition',
      'Flow Sankey',
    ]);
    expect(GRAPH_TABS).toHaveLength(4);
  });

  it('opens on the Harness Map and mounts only the active tab', async () => {
    renderView(<GraphsView />, stubs());
    await screen.findByTestId('graphs-harness');
    expect(screen.getByTestId('graphs-tab-harness')).toHaveAttribute('aria-selected', 'true');
    // Not hidden with CSS — genuinely not mounted, so three canvases are not querying (§8.3).
    expect(screen.queryByTestId('graphs-transition')).not.toBeInTheDocument();
    expect(screen.queryByTestId('graphs-sankey')).not.toBeInTheDocument();
  });

  it('switches tabs, and the shell keeps the view test hooks (ADR-018)', async () => {
    renderView(<GraphsView />, stubs());
    await screen.findByTestId('graphs-harness');
    openTab('sankey');
    expect(await screen.findByTestId('graphs-sankey')).toBeInTheDocument();
    expect(screen.queryByTestId('graphs-harness')).not.toBeInTheDocument();
    expect(screen.getByTestId('view-graphs')).toBeInTheDocument();
    expect(screen.getByTestId('view-graphs-primary')).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys (P-30)', async () => {
    renderView(<GraphsView />, stubs());
    await screen.findByTestId('graphs-harness');
    const tablist = screen.getByTestId('graphs-tabs');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(screen.getByTestId('graphs-tab-trace')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(screen.getByTestId('graphs-tab-harness')).toHaveAttribute('aria-selected', 'true');
  });

  it('every tab exposes zoom controls, with an aria-label on each (P-30)', async () => {
    renderView(<GraphsView />, stubs());
    for (const tab of ['harness', 'trace', 'transition', 'sankey']) {
      openTab(tab);
      const controls = await screen.findByTestId('zoom-controls');
      expect(within(controls).getByLabelText('Zoom in')).toBeInTheDocument();
      expect(within(controls).getByLabelText('Zoom out')).toBeInTheDocument();
      expect(within(controls).getByLabelText('Fit to view')).toBeInTheDocument();
    }
  });

  it('is offline-identical: every call is a local query', async () => {
    const { bridge } = renderView(<GraphsView />, stubs());
    await screen.findByTestId('graphs-harness');
    expect(bridge.calls.every((call) => call.channel.startsWith('q:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Four states, per tab
// ---------------------------------------------------------------------------------------

describe('§6.7 — the four states, on every tab', () => {
  const TAB_TESTIDS = {
    harness: 'graphs-harness',
    trace: 'graphs-trace',
    transition: 'graphs-transition',
    sankey: 'graphs-sankey',
  } as const;

  it('loading: a spinner, never an empty canvas', async () => {
    renderView(<GraphsView />, stubs());
    expect(screen.getByTestId('loading-state')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
    await screen.findByTestId('harness-flow');
  });

  it('error: `ErrorState` fills the canvas and the tab row stays usable', async () => {
    renderView(<GraphsView />, stubs({ 'q:harnessGraph': () => DB_BUSY }));
    const card = await screen.findByTestId('graphs-harness');
    expect(within(card).getByTestId('error-state')).toBeInTheDocument();
    // "the tab row stays usable" (§6.7).
    openTab('sankey');
    expect(await screen.findByTestId('graphs-sankey')).toBeInTheDocument();
  });

  it('offline: identical — nothing on this view touches the network', async () => {
    const { bridge } = renderView(<GraphsView />, stubs());
    openTab('transition');
    await screen.findByTestId('transition-canvas');
    expect(bridge.calls.some((call) => call.channel === 'q:toolTransition')).toBe(true);
    expect(bridge.calls.every((call) => call.channel.startsWith('q:'))).toBe(true);
  });

  for (const tab of GRAPH_TABS) {
    it(`empty: ${tab.id} renders §6.7's copy verbatim — "${tab.emptyReason}"`, async () => {
      renderView(
        <GraphsView />,
        stubs({
          'q:harnessGraph': () => ok({ nodes: [], edges: [] }),
          'q:toolTransition': () => ok({ nodes: [], edges: [] }),
          'q:flowSankey': () => ok({ nodes: [], links: [] }),
          // The Execution Trace's empty state is reached by NOT choosing a session, which is
          // what "select a session" means; the stub is irrelevant until one is picked.
        }),
      );
      openTab(tab.id);
      const card = await screen.findByTestId(TAB_TESTIDS[tab.id]);
      await waitFor(() => {
        expect(within(card).getByTestId('empty-state')).toHaveTextContent(tab.emptyReason);
      });
    });
  }
});

// ---------------------------------------------------------------------------------------
// Harness Map — the designed-vs-observed legend
// ---------------------------------------------------------------------------------------

describe('§6.7 Harness Map — designed vs observed', () => {
  it('⚠️ the legend distinguishes designed-only, observed-only and both', async () => {
    renderView(<GraphsView />, stubs());
    const legend = await screen.findByTestId('harness-evidence-legend');
    const entries = within(legend).getAllByTestId('harness-evidence-legend-item');
    const byClass = new Map(entries.map((entry) => [entry.dataset['evidence'], entry.textContent]));

    expect(byClass.get('designed-only')).toContain('Designed, never observed');
    expect(byClass.get('observed-only')).toContain('Observed, not declared');
    expect(byClass.get('both')).toContain('Designed and observed');
    // Three distinct claims, three distinct words — never one "edge" swatch (§4.5).
    expect(new Set(byClass.values()).size).toBe(byClass.size);
  });

  it('carries the meaning in text, not colour alone (FRONTEND §8)', async () => {
    renderView(<GraphsView />, stubs());
    const legend = await screen.findByTestId('harness-evidence-legend');
    // Every entry has readable words; strip them and nothing is left to read.
    for (const entry of within(legend).getAllByTestId('harness-evidence-legend-item')) {
      expect(entry.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it('names every node kind present, and shows each node’s kind on the node', async () => {
    renderView(<GraphsView />, stubs());
    await screen.findByTestId('harness-flow');
    const shapes = await screen.findByTestId('harness-shape-legend');
    expect(shapes).toHaveTextContent('Orchestrator');
    expect(shapes).toHaveTextContent('Tool');
    // The node itself states its kind as a word, beside the label.
    const nodes = screen.getAllByTestId('flow-node');
    expect(nodes.some((node) => node.textContent?.includes('demo-skill') === true)).toBe(true);
    expect(nodes.some((node) => node.textContent?.includes('tool') === true)).toBe(true);
  });

  it('⛔ badges the counts "all time" — the global filter does not reach this tab (INV-13)', async () => {
    const { bridge } = renderView(<GraphsView />, stubs());
    expect(await screen.findByTestId('harness-all-time')).toHaveTextContent('all time');

    // And the request really carries no filter: §4.5 types it as `{ tab: 'harness' }`.
    const call = bridge.calls.find((entry) => entry.channel === 'q:harnessGraph');
    expect(call?.request).toEqual({ tab: 'harness' });
  });

  it('⛔ does not re-query when the global filter changes', async () => {
    const { bridge } = renderView(<GraphsView />, stubs());
    await screen.findByTestId('harness-flow');
    const before = bridge.calls.filter((call) => call.channel === 'q:harnessGraph').length;
    act(() => {
      useAppStore.getState().setFilter({ projectIds: [1], from: null, to: null });
    });
    await waitFor(() => {
      expect(screen.getByTestId('harness-flow')).toBeInTheDocument();
    });
    expect(bridge.calls.filter((call) => call.channel === 'q:harnessGraph')).toHaveLength(before);
  });

  it('inspects a node, showing its kind and its all-time counts', async () => {
    renderView(<GraphsView />, stubs());
    await screen.findByTestId('harness-flow');
    const node = screen
      .getAllByTestId('flow-node')
      .find((candidate) => candidate.textContent?.includes('demo-skill') === true);
    expect(node).toBeDefined();
    fireEvent.click(node as HTMLElement);
    const inspector = await screen.findByTestId('node-inspector');
    expect(inspector).toHaveTextContent('demo-skill');
    expect(within(inspector).getByTestId('node-inspector-kind')).toHaveTextContent('skill');
    expect(inspector).toHaveTextContent('all time');
  });
});

// ---------------------------------------------------------------------------------------
// §6.7 Harness Map — the navigation controls (project scope, kind toggles, focus-on-click)
// ---------------------------------------------------------------------------------------

describe('§6.7 Harness Map — making ~555 nodes navigable (ADR-039)', () => {
  function multiStubs(overrides: Record<string, () => unknown> = {}) {
    return stubs({ 'q:harnessGraph': () => ok(harnessGraphMultiProject()), ...overrides });
  }

  /** Labels of every drawn node, so a test can say what is and is not on the canvas. */
  function nodeLabels(): string[] {
    return screen.getAllByTestId('flow-node').map((node) => node.textContent ?? '');
  }

  function labelled(label: string): HTMLElement | undefined {
    return screen.getAllByTestId('flow-node').find((node) => node.textContent?.includes(label));
  }

  it('opens on a focused view — the shared harness, not the whole graph', async () => {
    renderView(<GraphsView />, multiStubs());
    await screen.findByTestId('harness-flow');
    // The default scope is the shared (~/.claude) set: the two shared nodes, and neither project's.
    const labels = nodeLabels();
    expect(labels.some((label) => label.includes('Read'))).toBe(true);
    expect(labels.some((label) => label.includes('global-helper'))).toBe(true);
    expect(labels.some((label) => label.includes('family-skill'))).toBe(false);
    expect(labels.some((label) => label.includes('budget-skill'))).toBe(false);
    // The selector says which scope this is, by the shared harness's own name.
    expect(screen.getByTestId('harness-project-scope')).toHaveValue('__shared__');
  });

  it('scopes the visible node set to a chosen project, and discloses what it hides', async () => {
    renderView(<GraphsView />, multiStubs());
    await screen.findByTestId('harness-flow');
    fireEvent.change(screen.getByTestId('harness-project-scope'), {
      target: { value: 'family-app' },
    });
    await waitFor(() => {
      expect(labelled('family-skill')).toBeDefined();
    });
    const labels = nodeLabels();
    // family-app's own nodes plus the shared Read they grant — never budget-tool's node.
    expect(labels.some((label) => label.includes('family-orchestrator'))).toBe(true);
    expect(labels.some((label) => label.includes('Read'))).toBe(true);
    expect(labels.some((label) => label.includes('budget-skill'))).toBe(false);
    // The two connections leaving the scope are disclosed in words, never silently dropped.
    expect(screen.getByTestId('harness-cross-scope')).toHaveTextContent(
      '2 connections to other projects are hidden',
    );
  });

  it('⚠️ INV-13 — a node’s all-time count is identical filtered and unfiltered', async () => {
    renderView(<GraphsView />, multiStubs());
    await screen.findByTestId('harness-flow');

    // Read family-skill's count under "All projects"…
    fireEvent.change(screen.getByTestId('harness-project-scope'), { target: { value: '__all__' } });
    await waitFor(() => expect(labelled('family-skill')).toBeDefined());
    fireEvent.click(labelled('family-skill') as HTMLElement);
    expect(await screen.findByTestId('node-inspector')).toHaveTextContent('7');

    // …and under its own project. Same number — the scope changed the picture, not the count.
    fireEvent.change(screen.getByTestId('harness-project-scope'), {
      target: { value: 'family-app' },
    });
    await waitFor(() => expect(labelled('family-skill')).toBeDefined());
    fireEvent.click(labelled('family-skill') as HTMLElement);
    const inspector = await screen.findByTestId('node-inspector');
    expect(inspector).toHaveTextContent('7');
    expect(inspector).toHaveTextContent('all time');
  });

  it('⛔ never sends a global filter or a date range, whatever the scope (INV-13)', async () => {
    const { bridge } = renderView(<GraphsView />, multiStubs());
    await screen.findByTestId('harness-flow');
    fireEvent.change(screen.getByTestId('harness-project-scope'), {
      target: { value: 'family-app' },
    });
    // The local scope is a renderer concern; the request stays `{ tab: 'harness' }` with no
    // `from`/`to`. A future edit that wires the global filter in fails right here.
    const calls = bridge.calls.filter((call) => call.channel === 'q:harnessGraph');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.request).toEqual({ tab: 'harness' });
    expect(screen.getByTestId('harness-all-time')).toHaveTextContent('all time');
  });

  it('hides a kind on toggle and shows it again, changing the drawn node set', async () => {
    renderView(<GraphsView />, multiStubs());
    await screen.findByTestId('harness-flow');
    // Shared scope draws Read (a tool) and global-helper (a skill).
    expect(labelled('Read')).toBeDefined();
    const before = screen.getAllByTestId('flow-node').length;

    // Drop tools: Read leaves, the node set shrinks (which is what re-fits the camera).
    fireEvent.click(screen.getByTestId('harness-kind-tools'));
    await waitFor(() => expect(labelled('Read')).toBeUndefined());
    expect(screen.getAllByTestId('flow-node').length).toBeLessThan(before);
    expect(labelled('global-helper')).toBeDefined();

    // Toggle it back on: Read returns.
    fireEvent.click(screen.getByTestId('harness-kind-tools'));
    await waitFor(() => expect(labelled('Read')).toBeDefined());
  });

  it('focuses a node on click — neighbours stay lit, the rest dim, and clearing resets', async () => {
    renderView(
      <GraphsView />,
      multiStubs({ 'q:harnessGraph': () => ok(harnessGraphMultiProject()) }),
    );
    await screen.findByTestId('harness-flow');
    fireEvent.change(screen.getByTestId('harness-project-scope'), { target: { value: '__all__' } });
    await waitFor(() => expect(labelled('family-orchestrator')).toBeDefined());

    // family-orchestrator → family-skill is the only edge it has, so those two stay lit and the
    // unrelated Read dims.
    fireEvent.click(labelled('family-orchestrator') as HTMLElement);
    await waitFor(() => {
      expect(labelled('Read')).toHaveAttribute('data-dimmed', 'true');
    });
    expect(labelled('family-orchestrator')).toHaveAttribute('data-dimmed', 'false');
    expect(labelled('family-skill')).toHaveAttribute('data-dimmed', 'false');

    // Clearing the selection (closing the rail) un-dims everything.
    fireEvent.click(screen.getByLabelText('Close inspector'));
    await waitFor(() => {
      expect(labelled('Read')).toHaveAttribute('data-dimmed', 'false');
    });
  });
});

// ---------------------------------------------------------------------------------------
// P-23
// ---------------------------------------------------------------------------------------

describe('§8.5 P-23 — the node cap and its label', () => {
  it('⚠️ shows the "top 500" label only when the graph was actually capped', async () => {
    renderView(<GraphsView />, stubs({ 'q:harnessGraph': () => ok(wideGraph(520)) }));
    const card = await screen.findByTestId('graphs-harness');
    await waitFor(() => {
      expect(card).toHaveTextContent(/top 500 of 520 nodes/i);
    });
  });

  it('says nothing about a cap when nothing was capped', async () => {
    renderView(<GraphsView />, stubs());
    const card = await screen.findByTestId('graphs-harness');
    await waitFor(() => {
      expect(card).toHaveTextContent('6 nodes.');
    });
    expect(card).not.toHaveTextContent(/top 500/i);
  });
});

// ---------------------------------------------------------------------------------------
// Execution Trace — the unlinked lane
// ---------------------------------------------------------------------------------------

describe('§6.7 Execution Trace — the unlinked lane', () => {
  async function openTrace(): Promise<void> {
    renderView(<GraphsView />, stubs());
    openTab('trace');
    const picker = await screen.findByTestId('trace-session-picker');
    fireEvent.change(picker, { target: { value: 'sess-0000-1111' } });
  }

  it('says "select a session" before one is chosen, and fires no query', async () => {
    const { bridge } = renderView(<GraphsView />, stubs());
    openTab('trace');
    const card = await screen.findByTestId('graphs-trace');
    expect(within(card).getByTestId('empty-state')).toHaveTextContent('select a session');
    expect(bridge.calls.some((call) => call.channel === 'q:executionTrace')).toBe(false);
  });

  it('⚠️ draws an unlinked run on its own, in a clearly-labelled lane', async () => {
    await openTrace();
    const lane = await screen.findByTestId('trace-unlinked-lane');
    expect(lane).toHaveTextContent(UNLINKED_LANE_LABEL);
    expect(lane).toHaveTextContent('1 shown on their own');

    // The row itself carries the fact, not only the lane caption above it.
    const detached = screen
      .getAllByTestId('trace-row')
      .filter((row) => row.dataset['unlinked'] === 'true');
    expect(detached).toHaveLength(1);
    expect(detached[0]).toHaveTextContent('stray-worker');
  });

  it('⚠️ never guesses a parent — the unlinked run is drawn, never re-parented (ADR-020)', async () => {
    await openTrace();
    await screen.findByTestId('trace-unlinked-lane');
    // The payload carries no edge to `run:2`, and nothing in the view invents one. The lane's
    // count is the proof the run IS drawn — it is on its own, not dropped.
    expect(screen.getByTestId('trace-unlinked-lane')).toHaveTextContent('1 shown on their own');
    expect(screen.getByTestId('trace-unlinked-badge')).toHaveTextContent(
      '1 run could not be matched to the moment they started — totals are unaffected',
    );
  });

  it('states that totals are unaffected — part of the disclosure, not a nicety (§3.7)', async () => {
    await openTrace();
    expect(await screen.findByTestId('trace-unlinked-badge')).toHaveTextContent(
      'totals are unaffected',
    );
  });

  it('draws one bar per row, each named in text beside it (ADR-011)', async () => {
    await openTrace();
    const band = await screen.findByTestId('timeline-band');
    // The session level: the main loop plus its two runs. ⚠️ Tool calls are NOT here — they
    // live one level down, which is the whole point of the drill-down.
    const rows = within(band).getAllByTestId('trace-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('demo-alpha');
    expect(rows[1]).toHaveTextContent('worker');
    expect(rows[2]).toHaveTextContent('stray-worker');
    expect(within(band).getAllByTestId('trace-bar')).toHaveLength(3);
  });

  it('explains the missing link in the inspector rather than only in the picture', async () => {
    await openTrace();
    await screen.findByTestId('trace-unlinked-lane');
    const detached = screen
      .getAllByTestId('trace-row')
      .filter((row) => row.dataset['unlinked'] === 'true')[0];
    fireEvent.click(within(detached as HTMLElement).getByTestId('trace-bar'));
    const note = await screen.findByTestId('node-inspector-note');
    expect(note).toHaveTextContent('says where this run was started from');
    expect(note).toHaveTextContent('totals elsewhere in the app are unaffected');
  });
});

// ---------------------------------------------------------------------------------------
// Tool Transition and Flow Sankey
// ---------------------------------------------------------------------------------------

describe('§6.7 Tool Transition', () => {
  it('draws one node per tool, named in text, and one edge per transition', async () => {
    renderView(<GraphsView />, stubs());
    openTab('transition');
    await screen.findByTestId('transition-canvas');
    expect(screen.getAllByTestId('transition-node')).toHaveLength(4);
    expect(screen.getAllByTestId('transition-edge')).toHaveLength(5);
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Grep')).toBeInTheDocument();
  });

  it('thickness follows `observed` — the busiest transition is the widest', async () => {
    renderView(<GraphsView />, stubs());
    openTab('transition');
    const edges = await screen.findAllByTestId('transition-edge');
    const widths = new Map(
      edges.map((edge) => [
        Number(edge.dataset['observed']),
        Number(edge.getAttribute('stroke-width')),
      ]),
    );
    expect(widths.get(40)).toBeGreaterThan(widths.get(3) ?? 0);
  });
});

describe('§6.7 Flow Sankey', () => {
  it('draws a band per link and names every node in text', async () => {
    renderView(<GraphsView />, stubs());
    openTab('sankey');
    await screen.findByTestId('sankey-canvas');
    expect(screen.getAllByTestId('sankey-link')).toHaveLength(3);
    expect(screen.getAllByTestId('sankey-node')).toHaveLength(4);
    expect(screen.getAllByText(/claude-test-1/).length).toBeGreaterThan(0);
  });

  it('inspects a node and states what the band width means', async () => {
    renderView(<GraphsView />, stubs());
    openTab('sankey');
    const nodes = await screen.findAllByTestId('sankey-node');
    fireEvent.click(nodes[0] as HTMLElement);
    const inspector = await screen.findByTestId('node-inspector');
    expect(inspector).toHaveTextContent('Output tokens through it');
  });
});

// ---------------------------------------------------------------------------------------
// The inspector's 280-character prompt cap
// ---------------------------------------------------------------------------------------

describe('§3.9 / §6.7 — the inspector is the only place prompt text appears', () => {
  it('⚠️ renders at most 280 characters of a prompt', () => {
    const long = 'p'.repeat(500);
    renderRouted(<NodeInspector label="a prompt" kind="prompt" rows={[]} promptPreview={long} />);
    const quote = screen.getByTestId('node-inspector-prompt');
    expect(quote.textContent).toHaveLength(280);
    expect(quote.textContent).not.toBe(long);
  });

  it('says the text was cut, rather than cutting it silently', () => {
    renderRouted(
      <NodeInspector label="a prompt" kind="prompt" rows={[]} promptPreview={'p'.repeat(500)} />,
    );
    expect(screen.getByText(/Truncated to the first 280 characters/)).toBeInTheDocument();
  });

  it('renders no prompt block at all when there is no preview', () => {
    renderRouted(<NodeInspector label="demo-skill" kind="skill" rows={[]} />);
    expect(screen.queryByTestId('node-inspector-prompt')).not.toBeInTheDocument();
  });

  it('⚠️ no graph tab renders prompt text of its own', async () => {
    // §1.6 non-goal 1 / §3.9: "shown **only** in the graph inspector — never as a list, never
    // searchable". Nothing on any canvas may put prompt text on screen.
    renderView(<GraphsView />, stubs());
    for (const tab of ['harness', 'trace', 'transition', 'sankey']) {
      openTab(tab);
      await waitFor(() => {
        expect(screen.queryByTestId('node-inspector-prompt')).not.toBeInTheDocument();
      });
    }
  });

  /**
   * ⚠️ AMENDED 2026-07-22 (E12). Until now this whole describe block tested `NodeInspector` in
   * isolation — the cap was implemented and asserted while **no §4.5 payload could carry the
   * text**, so the feature was unreachable in the running app and every test still passed.
   * These two close that loop: the preview arrives on `GraphNode.meta`, from the Execution
   * Trace's session node, and reaches the rail.
   */
  it('⚠️ shows the preview a `q:executionTrace` session node carries in `meta`', async () => {
    const withPrompt = executionTrace();
    withPrompt.nodes = withPrompt.nodes.map((node) =>
      node.kind === 'session' ? { ...node, meta: { promptPreview: 'refactor the parser' } } : node,
    );
    renderView(<GraphsView />, stubs({ 'q:executionTrace': () => ok(withPrompt) }));
    openTab('trace');
    fireEvent.change(await screen.findByTestId('trace-session-picker'), {
      target: { value: 'sess-0000-1111' },
    });
    await screen.findByTestId('timeline-band');
    // The main loop's own bar is the session, and it is the node a prompt belongs to (§3.9).
    fireEvent.click(within(mainLoopRow()).getByTestId('trace-bar'));
    const quote = await screen.findByTestId('node-inspector-prompt');
    expect(quote).toHaveTextContent('refactor the parser');
  });

  it('renders no quote block for a session whose payload carries no preview', async () => {
    // The repository omits the key rather than sending `''` (§3.9); the rail must then show
    // nothing at all, because an empty quote block claims the prompt itself was empty.
    renderView(<GraphsView />, stubs());
    openTab('trace');
    fireEvent.change(await screen.findByTestId('trace-session-picker'), {
      target: { value: 'sess-0000-1111' },
    });
    await screen.findByTestId('timeline-band');
    fireEvent.click(within(mainLoopRow()).getByTestId('trace-bar'));
    await screen.findByTestId('node-inspector');
    expect(screen.queryByTestId('node-inspector-prompt')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// §4.5 `GraphNode.meta` — the §3.10 columns the Harness Map inspector needs (E12)
// ---------------------------------------------------------------------------------------

describe('§6.7 — the inspector renders the text-valued facts of a node', () => {
  it('shows description, path and source as key/value rows', async () => {
    const graph = harnessGraph();
    graph.nodes = graph.nodes.map((node) =>
      node.label === 'demo-skill'
        ? {
            ...node,
            meta: {
              description: 'Does the demonstrable thing.',
              relPath: 'skills/demo-skill/SKILL.md',
              source: 'plugin',
            },
          }
        : node,
    );
    renderView(<GraphsView />, stubs({ 'q:harnessGraph': () => ok(graph) }));
    await screen.findByTestId('harness-flow');
    const node = screen
      .getAllByTestId('flow-node')
      .find((candidate) => candidate.textContent?.includes('demo-skill') === true);
    fireEvent.click(node as HTMLElement);
    const rows = await screen.findByTestId('node-inspector-rows');
    // ⚠️ "Installed by a plugin" and "you wrote this" are different answers on the one view
    // where the difference decides whether a user deletes something (§6.9's reasoning, §6.7).
    expect(rows).toHaveTextContent('Does the demonstrable thing.');
    expect(rows).toHaveTextContent('skills/demo-skill/SKILL.md');
    expect(rows).toHaveTextContent('plugin');
  });

  it('⚠️ renders harness text as text — never as markup (§3.10, ADR-017)', async () => {
    const graph = harnessGraph();
    graph.nodes = graph.nodes.map((node) =>
      node.label === 'demo-skill'
        ? { ...node, meta: { description: '<img src=x onerror="boom()">' } }
        : node,
    );
    renderView(<GraphsView />, stubs({ 'q:harnessGraph': () => ok(graph) }));
    await screen.findByTestId('harness-flow');
    const node = screen
      .getAllByTestId('flow-node')
      .find((candidate) => candidate.textContent?.includes('demo-skill') === true);
    fireEvent.click(node as HTMLElement);
    const rows = await screen.findByTestId('node-inspector-rows');
    // Parsed harness text is data, never instructions: it appears as characters and produces
    // no element.
    expect(rows).toHaveTextContent('<img src=x onerror="boom()">');
    expect(rows.querySelector('img')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// §6.12 — entrance on first mount only
// ---------------------------------------------------------------------------------------

describe('§6.12 — a live data update never re-animates a chart', () => {
  it('⚠️ keeps the same DOM nodes when new data arrives for the same tab', async () => {
    let transition = toolTransition();
    renderView(<GraphsView />, stubs({ 'q:toolTransition': () => ok(transition) }));
    openTab('transition');
    const canvasBefore = await screen.findByTestId('transition-canvas');
    const cardBefore = screen.getByTestId('graphs-transition');
    expect(screen.getAllByTestId('transition-node')).toHaveLength(4);

    // A live update: the same mounted tab, new numbers.
    transition = {
      ...transition,
      nodes: [...transition.nodes].slice(0, 3),
      edges: transition.edges.filter((edge) => !edge.id.includes('Grep')),
    };
    act(() => {
      useAppStore.getState().setFilter({ projectIds: [2], from: null, to: null });
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('transition-node')).toHaveLength(3);
    });
    // ⚠️ The SAME elements — nothing is keyed on a payload, so no entrance replays (§6.12).
    expect(screen.getByTestId('transition-canvas')).toBe(canvasBefore);
    expect(screen.getByTestId('graphs-transition')).toBe(cardBefore);
  });

  it('keeps the Harness Map mounted across an unrelated store update', async () => {
    renderView(<GraphsView />, stubs());
    const flowBefore = await screen.findByTestId('harness-flow');
    act(() => {
      useAppStore.getState().setFilter({ projectIds: [3], from: null, to: null });
    });
    await waitFor(() => {
      expect(screen.getByTestId('harness-flow')).toBe(flowBefore);
    });
  });
});
