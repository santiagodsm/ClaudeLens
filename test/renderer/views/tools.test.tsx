/**
 * Tools & Agents — §6.6.
 *
 * Two rules carry this view: the fingerprint's label must remind the reader that `Agent` and
 * `Skill` **are** tools (§2.1, M-12) — otherwise the total looks wrong — and the unlinked-runs
 * footnote must say that **totals are unaffected**, because §6.6 makes saying so part of the
 * disclosure rather than a nicety.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import {
  AGENT_AND_SKILL_NOTE,
  TOOLS_EMPTY_REASON,
  ToolsView,
} from '../../../src/renderer/views/ToolsView';
import { DB_BUSY, ok, renderView, resetAll, uninstallBridge } from './view-harness';
import { originSplit, toolFingerprint, toolMixByProject } from './payloads';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetAll();
});

function stubs(overrides: Partial<Record<string, () => unknown>> = {}) {
  return {
    'q:toolFingerprint': () => ok(toolFingerprint()),
    'q:originSplit': () => ok(originSplit()),
    'q:toolMixByProject': () => ok(toolMixByProject()),
    ...overrides,
  } as Parameters<typeof renderView>[1];
}

describe('§6.6 Tools & Agents — states', () => {
  it('renders loading skeletons, not empty bars', () => {
    renderView(<ToolsView />, stubs());
    expect(screen.getAllByTestId('loading-state').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('gradient-bars')).not.toBeInTheDocument();
  });

  it('renders §6.6’s empty copy verbatim', async () => {
    renderView(
      <ToolsView />,
      stubs({ 'q:toolFingerprint': () => ok({ total: 0, distinct: 0, rows: [] }) }),
    );
    const card = await screen.findByTestId('tools-fingerprint');
    expect(within(card).getByTestId('empty-state')).toHaveTextContent(TOOLS_EMPTY_REASON);
  });

  it('renders a per-card ErrorState', async () => {
    renderView(<ToolsView />, stubs({ 'q:toolMixByProject': () => DB_BUSY }));
    const card = await screen.findByTestId('tools-mix');
    expect(within(card).getByTestId('error-state')).toBeInTheDocument();
    expect(screen.getByTestId('tools-fingerprint')).toBeInTheDocument();
  });

  it('is offline-identical: every call is a local query', async () => {
    const { bridge } = renderView(<ToolsView />, stubs());
    await screen.findByTestId('origin-donut');
    expect(bridge.calls.every((call) => call.channel.startsWith('q:'))).toBe(true);
  });
});

describe('§6.6 Tools & Agents — the fingerprint', () => {
  it('⚠️ reminds the reader that Agent and Skill are tools, and gives both totals', async () => {
    renderView(<ToolsView />, stubs());
    const card = await screen.findByTestId('tools-fingerprint');
    expect(card).toHaveTextContent(AGENT_AND_SKILL_NOTE);
    expect(card).toHaveTextContent('500 calls · 6 distinct tools');
  });

  it('labels every bar with its tool name and count — never colour alone', async () => {
    renderView(<ToolsView />, stubs());
    const bars = await screen.findByTestId('gradient-bars');
    for (const tool of ['Read', 'Edit', 'Agent', 'Skill']) {
      expect(within(bars).getByText(tool)).toBeInTheDocument();
    }
    expect(within(bars).getByText('220')).toBeInTheDocument();
  });
});

describe('§6.6 Tools & Agents — the M-17 donut', () => {
  it('shows both percentages and the absolute subagent output figure', async () => {
    renderView(<ToolsView />, stubs());
    const donut = await screen.findByTestId('origin-donut');
    expect(within(donut).getByTestId('origin-donut-centre')).toHaveTextContent('72K');
    expect(within(donut).getAllByTestId('origin-donut-share')[1]).toHaveTextContent(
      'Subagents 72%',
    );
    // §6.6 — "the message/tool-call counts beneath".
    expect(donut).toHaveTextContent('120 / 60 messages · 300 / 140 tool calls (main / subagent)');
  });

  it('states no split at all when there are no output tokens, rather than 0% / 0%', async () => {
    renderView(
      <ToolsView />,
      stubs({
        'q:originSplit': () =>
          ok(
            originSplit({
              main: {
                input: 0,
                output: 0,
                cacheWrite: 0,
                cacheWrite1h: 0,
                cacheRead: 0,
                messages: 0,
                toolCalls: 0,
              },
              subagent: {
                input: 0,
                output: 0,
                cacheWrite: 0,
                cacheWrite1h: 0,
                cacheRead: 0,
                messages: 0,
                toolCalls: 0,
              },
            }),
          ),
      }),
    );
    const donut = await screen.findByTestId('origin-donut');
    expect(within(donut).getByTestId('origin-donut-undefined')).toBeInTheDocument();
    expect(donut).not.toHaveTextContent('0%');
  });

  it('⚠️ footnotes unlinked runs AND says the totals are unaffected', async () => {
    renderView(
      <ToolsView />,
      stubs({ 'q:originSplit': () => ok(originSplit({ unlinkedRuns: 1 })) }),
    );
    const footnote = await screen.findByTestId('tools-origin-split-disclosure');
    expect(footnote).toHaveTextContent(
      '1 subagent run could not be linked to a spawn point — totals are unaffected.',
    );
    // Adjacent to the number it qualifies, never a tooltip (§6.12).
    expect(screen.getByTestId('tools-origin-split')).toContainElement(footnote);
  });

  it('renders no footnote when nothing is unlinked', async () => {
    renderView(<ToolsView />, stubs());
    await screen.findByTestId('origin-donut');
    expect(screen.queryByTestId('tools-origin-split-disclosure')).not.toBeInTheDocument();
  });
});

describe('§6.6 Tools & Agents — tool mix per project', () => {
  it('renders one labelled stacked pill per project, with tool names in text', async () => {
    renderView(<ToolsView />, stubs());
    const pills = await screen.findAllByTestId('stacked-pill');
    expect(pills).toHaveLength(1);
    expect(pills[0]).toHaveTextContent('demo-alpha');
    expect(pills[0]).toHaveTextContent('Read 60%');
    expect(pills[0]).toHaveTextContent('Edit 40%');
  });
});
