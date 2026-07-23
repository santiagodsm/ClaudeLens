/**
 * §1a — "I do not want jargon in any of the app." (User directive, 2026-07-22.)
 *
 * The durable enforcement of §1a: one sweep that renders **every** view's primary content with a
 * full, successful data set and greps the entire rendered subtree for any internal identifier —
 * a metric id, an invariant/ADR/rule/action id, a section sign, an IPC channel name, a database
 * column name or a state-machine/enum name. §1a is trivial to violate by copy-paste (a subtitle
 * lifted from `DESIGN.md`, a heading carried over from a metric definition), so a re-introduced
 * `M-07` on screen fails this one obvious test rather than shipping.
 *
 * The per-view suites assert their own copy in detail; this test is the backstop that no view is
 * exempt. It renders through the same jsdom + stubbed-IPC harness (STACK ADR-012): no database is
 * opened and every channel returns the `Result` envelope the preload produces (ADR-031).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { OverviewView } from '../../../src/renderer/views/OverviewView';
import { TokensView } from '../../../src/renderer/views/TokensView';
import { SessionsView } from '../../../src/renderer/views/SessionsView';
import { ToolsView } from '../../../src/renderer/views/ToolsView';
import { ProjectsView } from '../../../src/renderer/views/ProjectsView';
import { GraphsView } from '../../../src/renderer/views/GraphsView';
import { HarnessView } from '../../../src/renderer/views/HarnessView';
import { SettingsView } from '../../../src/renderer/views/SettingsView';
import { GRAPH_TABS } from '../../../src/renderer/views/graphs/tabs';
import { DEFAULT_SETTINGS } from '../harness';
import type { ChannelStubs } from './view-harness';
import { ok, renderView, resetAll, uninstallBridge } from './view-harness';
import {
  activityCalendar,
  cacheEfficiency,
  costBreakdown,
  fileMetrics,
  modelTimeline,
  observedModels,
  originSplit,
  overviewTiles,
  priceRows,
  projectCards,
  rhythmHeatmap,
  sessionDetail,
  sessionHistogram,
  sessionsPage,
  toolFingerprint,
  toolMixByProject,
  tokensByProject,
  workingDays,
} from './payloads';
import { executionTrace, flowSankey, harnessGraph, toolTransition } from './graph-payloads';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetAll();
});

/**
 * Every internal-identifier shape that must never reach the screen (§1a). Faithful to the user
 * directive's list: metric ids, invariant / ADR / rule / action / perf / fixture / open-question
 * ids, section signs, IPC channel names, database column names and state-machine / enum names.
 */
const JARGON: readonly RegExp[] = [
  /\bM-\d/, // metric ids: M-01…M-21
  /\bINV-\d/, // invariants
  /\bADR-\d/, // architecture decisions
  /\bBR-\d/, // Bloat Radar rules
  /\bACT-\d/, // guarded-action catalogue
  /\bP-\d/, // performance / product rules
  /\bF-\d/, // fixtures
  /\bOQ-\d/, // open questions
  /§/, // section signs, e.g. §6.4
  /\bq:[a-zA-Z]/, // IPC channel names, e.g. q:sessions
  /binding \([ABC]\)/i, // the M-07 partition bindings, said in code
  /\btok_[a-z]/, // column names, e.g. tok_cache_read
  /\bis_synthetic\b/, // column name
  /\bREADY_[A-Z]/, // state-machine names, e.g. READY_EMPTY
  /origin='/, // enum literals, e.g. origin='subagent'
];

/** Assert no identifier shape appears anywhere in the given rendered text. */
function expectNoJargon(view: string, text: string): void {
  for (const pattern of JARGON) {
    expect(text, `${view} renders jargon matching ${String(pattern)}`).not.toMatch(pattern);
  }
}

/**
 * A single stub table that answers every channel the eight views touch. One table, so a view
 * added to the sweep cannot silently render a loading skeleton forever (an unmatched channel
 * throws in the harness) — the sweep only greps a fully-loaded view.
 */
const FULL_STUBS = {
  // Overview
  'q:overviewTiles': () => ok(overviewTiles()),
  'q:activityCalendar': () => ok(activityCalendar()),
  'q:modelMixTimeline': () => ok(modelTimeline()),
  // Tokens
  'q:tokensByModel': () => ok(modelTimeline()),
  'q:cacheEfficiency': () => ok(cacheEfficiency()),
  'q:tokensByProject': () => ok(tokensByProject()),
  'q:costBreakdown': () => ok(costBreakdown()),
  'q:originSplit': () => ok(originSplit()),
  // Sessions
  'q:sessionHistogram': () => ok(sessionHistogram()),
  'q:rhythmHeatmap': () => ok(rhythmHeatmap()),
  'q:workingDays': () => ok(workingDays()),
  'q:sessions': () => ok(sessionsPage()),
  'q:sessionDetail': () => ok(sessionDetail()),
  // Tools
  'q:toolFingerprint': () => ok(toolFingerprint()),
  'q:toolMixByProject': () => ok(toolMixByProject()),
  // Projects
  'q:projectCards': () => ok(projectCards()),
  'q:fileMetrics': () => ok(fileMetrics()),
  // Graphs
  'q:harnessGraph': () => ok(harnessGraph()),
  'q:executionTrace': () => ok(executionTrace()),
  'q:toolTransition': () => ok(toolTransition()),
  'q:flowSankey': () => ok(flowSankey()),
  // Harness Manager
  'bloat:list': () => ok({ rows: [], totalReclaimableBytes: 0 }),
  'q:skills': () =>
    ok({
      rows: [
        {
          name: 'unused',
          source: 'user',
          pluginName: null,
          relPath: 'skills/unused',
          sizeBytes: 1024,
          invocations: 0,
          lastUsedTs: null,
          neverUsed: true,
        },
      ],
      nextCursor: null,
      totalKnown: 1,
    }),
  'q:claudeMdFiles': () =>
    ok({
      rows: [{ relPath: 'CLAUDE.md', sizeBytes: 128, mtimeMs: 1, backups: [] }],
    }),
  'q:plugins': () => ok({ marketplaces: [], plugins: [] }),
  'q:memories': () =>
    ok({
      rows: [{ relPath: 'MEMORY.md', projectId: null, sizeBytes: 12, mtimeMs: 1, entryCount: 3 }],
    }),
  'q:harnessProjects': () => ok({ rows: [] }),
  // Settings
  'pricing:models': () => ok({ rows: observedModels() }),
  'pricing:list': () => ok({ rows: priceRows() }),
  'groups:list': () => ok({ rows: [] }),
  'dir:validate': () =>
    ok({ status: 'valid', hasProjects: true, hasHistory: true, transcriptFileCount: 412 }),
  'settings:set': (request: unknown) => {
    const [key, value] = Object.entries(request as Record<string, unknown>)[0] ?? [
      'theme',
      'system',
    ];
    return ok({ ...DEFAULT_SETTINGS, claudeDir: '/sandbox/claude', [key]: value });
  },
} as ChannelStubs;

/** Render a view, wait until no card is still loading, and return its rendered text. */
async function renderAndSettle(id: string, ui: ReactElement): Promise<string> {
  const { view } = renderView(ui, FULL_STUBS);
  const primary = await screen.findByTestId(`view-${id}-primary`);
  await waitFor(() => {
    expect(within(primary).queryAllByTestId('loading-state')).toHaveLength(0);
  });
  return view.container.textContent ?? '';
}

describe('§1a — no jargon reaches the screen, across every view', () => {
  const VIEWS: ReadonlyArray<readonly [string, ReactElement]> = [
    ['overview', <OverviewView />],
    ['tokens', <TokensView />],
    ['sessions', <SessionsView />],
    ['tools', <ToolsView />],
    ['projects', <ProjectsView />],
    ['harness', <HarnessView />],
    ['settings', <SettingsView />],
  ];

  it.each(VIEWS)('renders no internal identifier anywhere in the %s view', async (id, ui) => {
    expectNoJargon(id, await renderAndSettle(id, ui));
  });

  // Graphs mounts one tab at a time, so the sweep walks all four to reach every tab's copy.
  it('renders no internal identifier on any of the four graph tabs', async () => {
    const { view } = renderView(<GraphsView />, FULL_STUBS);
    const primary = await screen.findByTestId('view-graphs-primary');
    for (const tab of GRAPH_TABS) {
      fireEvent.click(screen.getByTestId(`graphs-tab-${tab.id}`));
      await screen.findByTestId(`graphs-panel-${tab.id}`);
      await waitFor(() => {
        expect(within(primary).queryAllByTestId('loading-state')).toHaveLength(0);
      });
      expectNoJargon(`graphs:${tab.id}`, view.container.textContent ?? '');
    }
  });
});
