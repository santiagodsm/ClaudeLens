/**
 * §6.7's Execution Trace, as a timeline you drill into.
 *
 * The rules this suite exists to hold — every one of them is a thing the reader can be misled by
 * if it drifts:
 *
 *   · **One level at a time.** The session level draws the main loop and its subagent runs and
 *     **nothing else**; a tool call is not in the document until you open the run that made it,
 *     and opening a run unmounts that run's siblings. This is the reduction that makes a session
 *     with thousands of tool calls readable at all.
 *   · **Repetition is one bar.** Forty-seven consecutive `Read` calls are `Read ×47`, drawn once,
 *     from the first call to the last.
 *   · **Width is time.** Asserted against hand-computed ratios, never a snapshot — a snapshot of
 *     a wrong geometry is a machine for blessing it (STACK ADR-012).
 *   · **The axis re-fits per level**, which is what makes a four-second run inside a nine-hour
 *     session legible, and it carries **real clock labels**.
 *   · **Unlinked runs keep their own labelled lane** and are never re-parented (§3.7, ADR-020).
 *   · **A hidden remainder is a visible, clickable count** (§8.5 P-23).
 *   · ⚠️ **No internal identifier reaches the screen** (CLAUDE.md §1a) — asserted by walking every
 *     rendered string in the view.
 *   · **The mounted element count stays bounded** on a large trace, at every level.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  ExecutionTrace,
  GraphEdge,
  GraphNode,
  TraceSpan,
} from '../../../src/shared/ipc-contract';
import { GraphsView } from '../../../src/renderer/views/GraphsView';
import { UNLINKED_LANE_LABEL } from '../../../src/renderer/views/graphs/ExecutionTraceTab';
import {
  aggregateToolCalls,
  axisTicks,
  barGeometry,
  buildTraceLevel,
  chooseRows,
  groupLabel,
  indexTrace,
  type TraceRow,
} from '../../../src/renderer/views/graphs/trace-timeline';
import { DB_BUSY, ok, renderView, resetAll, uninstallBridge } from './view-harness';
import { flowSankey, harnessGraph, toolTransition } from './graph-payloads';
import { sessionsPage } from './payloads';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetAll();
});

// ---------------------------------------------------------------------------------------
// A trace built to a stated shape, so every expected value below is hand-computed from it
// ---------------------------------------------------------------------------------------

/** 09:00:00 local, so every clock label in this file is readable by eye. */
const T0 = new Date(2026, 2, 2, 9, 0, 0, 0).getTime();
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

interface RunSpec {
  readonly id: string;
  readonly name: string;
  /** Minutes after `T0`. */
  readonly startMin: number;
  readonly lengthMin: number;
  readonly linked?: boolean;
  readonly outputTokens?: number;
  /** Tool calls this run made, in order: `[name, secondsAfterRunStart]`. */
  readonly calls?: readonly (readonly [string, number])[];
}

interface TraceSpec {
  readonly sessionMinutes: number;
  readonly runs: readonly RunSpec[];
  /** Tool calls the main loop made itself. */
  readonly mainCalls?: readonly (readonly [string, number])[];
  readonly promptPreview?: string;
}

const SESSION_ID = 'sess-0000-1111';
const SESSION_NODE = `session:${SESSION_ID}`;

function buildTrace(spec: TraceSpec): ExecutionTrace {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const timeline: TraceSpan[] = [];

  nodes.push({
    id: SESSION_NODE,
    kind: 'session',
    label: 'demo-alpha',
    colorIndex: 0,
    metrics: { messages: 24, toolCalls: 40 },
    ...(spec.promptPreview === undefined ? {} : { meta: { promptPreview: spec.promptPreview } }),
  });
  timeline.push({
    id: SESSION_NODE,
    kind: 'main',
    label: 'demo-alpha',
    startTs: T0,
    endTs: T0 + spec.sessionMinutes * MINUTE,
    depth: 0,
  });

  const addCalls = (
    owner: string,
    baseTs: number,
    calls: readonly (readonly [string, number])[],
  ): void => {
    calls.forEach(([name, offsetSeconds], position) => {
      const id = `tool:${owner}:${String(position)}`;
      const ts = baseTs + offsetSeconds * SECOND;
      nodes.push({ id, kind: 'tool', label: name, colorIndex: 1, metrics: { ts } });
      // ⚠️ A tool call is a point event: one timestamp, no end (§3.6).
      timeline.push({ id, kind: 'tool', label: name, startTs: ts, endTs: ts, depth: 2 });
      edges.push({
        id: `call:${id}`,
        source: owner,
        target: id,
        kind: 'tool_call',
        designed: false,
        observed: 1,
      });
    });
  };

  addCalls(SESSION_NODE, T0, spec.mainCalls ?? []);

  for (const run of spec.runs) {
    const startTs = T0 + run.startMin * MINUTE;
    const linked = run.linked ?? true;
    nodes.push({
      id: run.id,
      kind: 'subagent',
      label: run.name,
      colorIndex: 3,
      metrics: { outputTokens: run.outputTokens ?? 0, linked: linked ? 1 : 0 },
    });
    timeline.push({
      id: run.id,
      kind: 'subagent',
      label: run.name,
      startTs,
      endTs: startTs + run.lengthMin * MINUTE,
      depth: 1,
    });
    // ⚠️ §3.7 / ADR-020 — an unlinked run gets NO edge. The payload makes a guessed parent
    // impossible to produce by accident, and this fixture keeps that property.
    if (linked) {
      edges.push({
        id: `spawn:${run.id}`,
        source: SESSION_NODE,
        target: run.id,
        kind: 'spawn',
        designed: false,
        observed: 1,
      });
    }
    addCalls(run.id, startTs, run.calls ?? []);
  }

  return {
    nodes,
    edges,
    timeline,
    unlinkedRuns: spec.runs.filter((run) => run.linked === false).length,
  };
}

/** 47 `Read`s one second apart, then 12 `Edit`s — the user's own example, exactly. */
function readsThenEdits(): readonly (readonly [string, number])[] {
  const calls: (readonly [string, number])[] = [];
  for (let index = 0; index < 47; index += 1) calls.push(['Read', index]);
  for (let index = 0; index < 12; index += 1) calls.push(['Edit', 60 + index * 2]);
  return calls;
}

/**
 * The trace most of the rendering tests below run against:
 *
 *   main loop      09:00 → 10:00                 (60 minutes)
 *     reviewer     09:00 → 09:20   20 minutes    47 Reads then 12 Edits
 *     scout        09:30 → 09:40   10 minutes    2 calls
 *     stray        09:45 → 09:50   ⚠️ unlinked
 */
function standardTrace(): ExecutionTrace {
  return buildTrace({
    sessionMinutes: 60,
    mainCalls: [['Bash', 30]],
    runs: [
      {
        id: 'run:1',
        name: 'reviewer',
        startMin: 0,
        lengthMin: 20,
        outputTokens: 9_000,
        calls: readsThenEdits(),
      },
      {
        id: 'run:2',
        name: 'scout',
        startMin: 30,
        lengthMin: 10,
        outputTokens: 40_000,
        calls: [
          ['Grep', 0],
          ['Grep', 5],
        ],
      },
      { id: 'run:3', name: 'stray', startMin: 45, lengthMin: 5, linked: false, outputTokens: 100 },
    ],
  });
}

function stubs(
  trace: ExecutionTrace = standardTrace(),
  overrides: Record<string, () => unknown> = {},
) {
  return {
    'q:harnessGraph': () => ok(harnessGraph()),
    'q:executionTrace': () => ok(trace),
    'q:toolTransition': () => ok(toolTransition()),
    'q:flowSankey': () => ok(flowSankey()),
    'q:sessions': () => ok(sessionsPage()),
    ...overrides,
  } as Parameters<typeof renderView>[1];
}

/** Render the tab with a session already chosen — the state every test below starts from. */
async function openTrace(trace: ExecutionTrace = standardTrace()): Promise<void> {
  renderView(<GraphsView />, stubs(trace));
  fireEvent.click(screen.getByTestId('graphs-tab-trace'));
  fireEvent.change(await screen.findByTestId('trace-session-picker'), {
    target: { value: SESSION_ID },
  });
  await screen.findByTestId('timeline-band');
}

function rowNamed(label: string): HTMLElement {
  const row = screen
    .getAllByTestId('trace-row')
    .find((candidate) => candidate.textContent?.startsWith(label) === true);
  if (row === undefined) throw new Error(`no row labelled ${label}`);
  return row;
}

function barOf(label: string): HTMLElement {
  return within(rowNamed(label)).getByTestId('trace-bar');
}

function rowLabels(): string[] {
  return screen
    .getAllByTestId('trace-row')
    .map((row) => row.querySelector('span')?.textContent ?? '');
}

/** The visible time window, read back off the axis caption's two clock labels. */
function axisRange(): string {
  return screen.getByTestId('timeline-band-window').textContent ?? '';
}

// ---------------------------------------------------------------------------------------
// Level 1 — the session, and nothing else
// ---------------------------------------------------------------------------------------

describe('§6.7 Execution Trace — level 1 is the session and its runs', () => {
  it('⚠️ draws the main loop and its subagent runs, and mounts no tool call at all', async () => {
    await openTrace();

    // Four bars: the main loop, and the three runs. Not one of the 60 tool calls is mounted.
    expect(screen.getAllByTestId('trace-bar')).toHaveLength(4);
    expect(rowLabels()).toEqual(['demo-alpha', 'reviewer', 'scout', 'stray']);
    expect(screen.queryByText('Read ×47')).not.toBeInTheDocument();
    expect(screen.queryByText(/Edit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Grep/)).not.toBeInTheDocument();
  });

  it('says what this level is showing, in words', async () => {
    await openTrace();
    expect(screen.getByTestId('trace-level-caption')).toHaveTextContent(
      '3 subagent runs, in the order they happened.',
    );
  });

  it('⚠️ the unlinked run keeps its own labelled lane and is never re-parented', async () => {
    await openTrace();
    const lane = screen.getByTestId('trace-unlinked-lane');
    expect(lane).toHaveTextContent(UNLINKED_LANE_LABEL);
    expect(lane).toHaveTextContent('1 shown on their own');

    const unlinked = screen
      .getAllByTestId('trace-row')
      .filter((row) => row.dataset['unlinked'] === 'true');
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toHaveTextContent('stray');

    // It is drawn, not dropped — and the disclosure states that its numbers still count.
    expect(screen.getByTestId('trace-unlinked-badge')).toHaveTextContent('totals are unaffected');
  });

  it('⚠️ an unlinked run cannot be opened into a parent it does not have', async () => {
    await openTrace();
    // No spawn edge, no tool calls: nothing to open, and nothing invented to open into.
    expect(within(rowNamed('stray')).queryByTestId('trace-open')).not.toBeInTheDocument();
  });

  it('⚠️ the lane heading is true of every row beneath it, whatever the timings were', async () => {
    // `stray` ran BEFORE `late` — so in pure time order it would sit in the middle and the lane
    // heading would claim a linked run was unlinked. Unlinked runs are grouped at the end.
    await openTrace(
      buildTrace({
        sessionMinutes: 60,
        runs: [
          { id: 'run:1', name: 'early', startMin: 0, lengthMin: 5 },
          { id: 'run:2', name: 'stray', startMin: 10, lengthMin: 5, linked: false },
          { id: 'run:3', name: 'late', startMin: 20, lengthMin: 5 },
        ],
      }),
    );
    expect(rowLabels()).toEqual(['demo-alpha', 'early', 'late', 'stray']);
    const rows = screen.getAllByTestId('trace-row');
    // Everything from the lane heading down is unlinked, which is what the heading claims.
    expect(rows[3]?.dataset['unlinked']).toBe('true');
    expect(screen.getByTestId('trace-unlinked-lane')).toHaveTextContent('1 shown on their own');
  });
});

// ---------------------------------------------------------------------------------------
// Geometry — width is time, position is when. Hand-computed, never snapshotted.
// ---------------------------------------------------------------------------------------

describe('§6.7 Execution Trace — width is time', () => {
  it('⚠️ a run twice as long is twice as wide, and a later run starts further right', async () => {
    await openTrace();

    // The window is the session: 09:00 → 10:00, 60 minutes.
    //   reviewer  09:00 → 09:20  ⇒ left  0/60 = 0%      width 20/60 = 33.33%
    //   scout     09:30 → 09:40  ⇒ left 30/60 = 50%     width 10/60 = 16.67%
    const reviewer = barOf('reviewer');
    const scout = barOf('scout');

    expect(reviewer.style.left).toBe('0%');
    expect(reviewer.style.width).toBe('33.33%');
    expect(scout.style.left).toBe('50%');
    expect(scout.style.width).toBe('16.67%');

    // Twice as long, twice as wide — asserted as the ratio, not as two numbers that happen to
    // look right: 20 minutes / 10 minutes = 2.
    expect(
      Number.parseFloat(reviewer.style.width) / Number.parseFloat(scout.style.width),
    ).toBeCloseTo(2, 1);
    // …and later means further right.
    expect(Number.parseFloat(scout.style.left)).toBeGreaterThan(
      Number.parseFloat(reviewer.style.left),
    );
  });

  it('the main loop fills the width, because the level is fitted to it', async () => {
    await openTrace();
    const main = barOf('demo-alpha');
    expect(main.style.left).toBe('0%');
    expect(main.style.width).toBe('100%');
  });

  it('barGeometry is fractions of the window, and clipping is reported rather than hidden', () => {
    const window = { startTs: 0, endTs: 1_000 };
    expect(barGeometry({ startTs: 250, endTs: 500 }, window)).toEqual({
      left: 0.25,
      width: 0.25,
      clippedStart: false,
      clippedEnd: false,
      visible: true,
    });
    // A bar that runs past the right-hand edge is drawn to the edge and says it was cut.
    const clipped = barGeometry({ startTs: 800, endTs: 2_000 }, window);
    expect(clipped.left).toBeCloseTo(0.8, 10);
    expect(clipped.width).toBeCloseTo(0.2, 10);
    expect(clipped.clippedEnd).toBe(true);
    // Entirely outside: not drawn at all, which is what keeps the DOM small when zoomed in.
    expect(barGeometry({ startTs: 2_000, endTs: 3_000 }, window).visible).toBe(false);
    // ⚠️ A window of no length has no proportions — nothing is stretched to fill it.
    expect(barGeometry({ startTs: 5, endTs: 5 }, { startTs: 5, endTs: 5 })).toMatchObject({
      width: 0,
      visible: true,
    });
  });
});

// ---------------------------------------------------------------------------------------
// Level 2 — drilling into one run
// ---------------------------------------------------------------------------------------

describe('§6.7 Execution Trace — drilling into a run', () => {
  it('⚠️ mounts that run’s tool calls and unmounts its siblings', async () => {
    await openTrace();
    fireEvent.click(within(rowNamed('reviewer')).getByTestId('trace-open'));

    await waitFor(() => {
      expect(screen.getByText('Read ×47')).toBeInTheDocument();
    });
    // The siblings are gone from the document — not hidden with CSS, not scrolled away.
    expect(screen.queryByText('scout')).not.toBeInTheDocument();
    expect(screen.queryByText('stray')).not.toBeInTheDocument();
    // The run itself stays, as the row for the thing being looked at.
    expect(rowLabels()).toEqual(['reviewer', 'Read ×47', 'Edit ×12']);
  });

  it('⚠️ 47 consecutive Read calls are ONE bar, spanning the first call to the last', async () => {
    await openTrace();
    fireEvent.click(within(rowNamed('reviewer')).getByTestId('trace-open'));
    await screen.findByText('Read ×47');

    // One bar, not 47.
    expect(
      screen.getAllByTestId('trace-bar').filter((bar) => bar.dataset['measured'] === 'false'),
    ).toHaveLength(2);

    // The level is fitted to the run: 09:00:00 → 09:20:00, 1,200 seconds.
    //   Read  ×47: first call +0 s, last call +46 s  ⇒ left 0%, width 46/1200 = 3.83%
    //   Edit  ×12: first call +60 s, last +82 s      ⇒ left 60/1200 = 5%, width 22/1200 = 1.83%
    const read = barOf('Read ×47');
    expect(read.style.left).toBe('0%');
    expect(read.style.width).toBe('3.83%');
    const edit = barOf('Edit ×12');
    expect(edit.style.left).toBe('5%');
    expect(edit.style.width).toBe('1.83%');

    // ⚠️ And it is labelled as what it is: a group of calls, with the count in the label.
    expect(read).toHaveAttribute(
      'aria-label',
      expect.stringContaining('the width is when the calls happened, not how long they took'),
    );
  });

  it('⚠️ re-fits the time axis to the run — the whole point of re-scoping', async () => {
    await openTrace();
    const sessionRange = axisRange();
    // The session level runs to 10:00.
    expect(sessionRange).toContain('10:00');

    fireEvent.click(within(rowNamed('scout')).getByTestId('trace-open'));
    await waitFor(() => {
      expect(axisRange()).not.toBe(sessionRange);
    });
    // scout ran 09:30 → 09:40, and that is now the whole width.
    expect(axisRange()).toContain('09:30');
    expect(axisRange()).toContain('09:40');
    expect(barOf('scout').style.width).toBe('100%');
  });

  it('states the width rule on screen, where the bars are', async () => {
    await openTrace();
    expect(screen.getByTestId('timeline-band-width-rule')).toHaveTextContent(
      'Tool calls are recorded as single moments with no end time',
    );
    expect(screen.getByTestId('timeline-band-width-rule')).toHaveTextContent(
      'not how long they took',
    );
  });

  it('opens the main loop’s own tool calls, which are not shown at the session level', async () => {
    await openTrace();
    expect(screen.queryByText('Bash')).not.toBeInTheDocument();
    fireEvent.click(within(rowNamed('demo-alpha')).getByTestId('trace-open'));
    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------------------
// Level 3 — the individual calls
// ---------------------------------------------------------------------------------------

describe('§6.7 Execution Trace — drilling into a group of repeated calls', () => {
  it('shows the calls one by one, each at its own moment', async () => {
    await openTrace();
    fireEvent.click(within(rowNamed('reviewer')).getByTestId('trace-open'));
    await screen.findByText('Read ×47');
    fireEvent.click(within(rowNamed('Read ×47')).getByTestId('trace-open'));

    await waitFor(() => {
      expect(screen.getByTestId('trace-level-caption')).toHaveTextContent('47 individual calls');
    });
    // ⚠️ Even here the level opens on a handful: twelve calls plus the group's own row, and the
    // other thirty-five are a visible, clickable count rather than a wall (§8.5 P-23).
    expect(screen.getAllByTestId('trace-row')).toHaveLength(13);
    expect(screen.getByTestId('timeline-band-more')).toHaveTextContent('and 35 more');

    // ⚠️ Each call is a single moment: no width at all, and it is marked as such.
    const first = screen.getAllByTestId('trace-bar')[1] as HTMLElement;
    expect(first.dataset['instant']).toBe('true');
    expect(first.dataset['measured']).toBe('false');

    fireEvent.click(screen.getByTestId('timeline-band-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('trace-row')).toHaveLength(48);
    });
  });
});

// ---------------------------------------------------------------------------------------
// The breadcrumb, and Escape
// ---------------------------------------------------------------------------------------

describe('§6.7 Execution Trace — getting back out', () => {
  it('⚠️ the breadcrumb walks back to the session level', async () => {
    await openTrace();
    fireEvent.click(within(rowNamed('reviewer')).getByTestId('trace-open'));
    await screen.findByText('Read ×47');

    const crumbs = screen.getAllByTestId('trace-crumb');
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(['Whole session', 'reviewer']);

    fireEvent.click(crumbs[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.getByText('scout')).toBeInTheDocument();
    });
    expect(screen.queryByText('Read ×47')).not.toBeInTheDocument();
  });

  it('⚠️ Escape steps back one level', async () => {
    await openTrace();
    fireEvent.click(within(rowNamed('reviewer')).getByTestId('trace-open'));
    await screen.findByText('Read ×47');
    fireEvent.click(within(rowNamed('Read ×47')).getByTestId('trace-open'));
    await waitFor(() => {
      expect(screen.getAllByTestId('trace-crumb')).toHaveLength(3);
    });

    fireEvent.keyDown(screen.getByTestId('trace-timeline'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.getAllByTestId('trace-crumb')).toHaveLength(2);
    });
    fireEvent.keyDown(screen.getByTestId('trace-timeline'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.getByText('scout')).toBeInTheDocument();
    });
  });

  it('a double-click on a bar opens it, and a single click does not', async () => {
    await openTrace();
    fireEvent.click(barOf('reviewer'));
    // One click selects: the rail opens, and the level does not change.
    expect(await screen.findByTestId('node-inspector')).toBeInTheDocument();
    expect(screen.getByText('scout')).toBeInTheDocument();

    fireEvent.doubleClick(barOf('reviewer'));
    await waitFor(() => {
      expect(screen.getByText('Read ×47')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------------------
// The inspector rail
// ---------------------------------------------------------------------------------------

describe('§6.7 Execution Trace — clicking a bar fills the inspector with its real numbers', () => {
  it('shows a run’s timing and tokens, in words', async () => {
    await openTrace();
    fireEvent.click(barOf('scout'));
    const rail = await screen.findByTestId('node-inspector');

    expect(rail).toHaveTextContent('scout');
    expect(rail).toHaveTextContent('Subagent run');
    expect(rail).toHaveTextContent('How long it ran');
    // scout ran ten minutes, and produced 40,000 tokens.
    expect(rail).toHaveTextContent('10m');
    expect(rail).toHaveTextContent('Tokens it produced');
    expect(rail).toHaveTextContent('40,000');
  });

  it('⚠️ tells the reader what an aggregated bar’s width is, and is not', async () => {
    await openTrace();
    fireEvent.click(within(rowNamed('reviewer')).getByTestId('trace-open'));
    await screen.findByText('Read ×47');
    fireEvent.click(barOf('Read ×47'));

    const rail = await screen.findByTestId('node-inspector');
    expect(rail).toHaveTextContent('How many calls');
    expect(rail).toHaveTextContent('First call');
    expect(rail).toHaveTextContent('Last call');
    expect(within(rail).getByTestId('node-inspector-note')).toHaveTextContent(
      'its width tells you when those calls happened — not how long they took',
    );
  });

  it('explains an unlinked run rather than leaving the reader to infer it', async () => {
    await openTrace();
    fireEvent.click(barOf('stray'));
    const note = await screen.findByTestId('node-inspector-note');
    expect(note).toHaveTextContent('says where this run was started from');
    expect(note).toHaveTextContent('Everything it did is still counted');
  });
});

// ---------------------------------------------------------------------------------------
// The axis
// ---------------------------------------------------------------------------------------

describe('§6.7 Execution Trace — the time axis carries real clock labels', () => {
  it('⚠️ labels the axis with times of day, not bare offsets', async () => {
    await openTrace();
    const ticks = within(screen.getByTestId('timeline-band-axis')).getAllByTestId(
      'timeline-band-tick',
    );
    expect(ticks.length).toBeGreaterThan(2);
    // Every label is a clock time.
    for (const tick of ticks) {
      expect(tick.textContent ?? '').toMatch(/\d{1,2}:\d{2}/);
    }
  });

  it('places its ticks on round clock times inside the window', () => {
    // 09:00 → 10:00 wants roughly six labels, so the step is ten minutes and the ticks land on
    // 09:00, 09:10 … 10:00 — seven of them, aligned to the clock rather than to the window, and
    // none of them outside it.
    const ticks = axisTicks({ startTs: T0, endTs: T0 + 60 * MINUTE });
    expect(ticks).toHaveLength(7);
    expect(ticks[0]?.ts).toBe(T0);
    expect(ticks[0]?.fraction).toBe(0);
    expect(ticks[1]?.fraction).toBeCloseTo(10 / 60, 6);
    expect(ticks[6]?.ts).toBe(T0 + 60 * MINUTE);
  });

  it('names the day when a window crosses local midnight', () => {
    // A 23-hour session, which the reference dataset really contains.
    const ticks = axisTicks({ startTs: T0, endTs: T0 + 23 * 60 * MINUTE });
    const crossing = ticks.filter((tick) => tick.dayLabel !== null);
    expect(crossing.length).toBeGreaterThan(0);
  });

  it('draws no axis for a window of no length, rather than an invented one', () => {
    expect(axisTicks({ startTs: T0, endTs: T0 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// §8.5 P-23 — the cap, and the remainder as a clickable count
// ---------------------------------------------------------------------------------------

describe('§8.5 P-23 — nothing is dropped in silence', () => {
  function manyRuns(count: number): ExecutionTrace {
    return buildTrace({
      sessionMinutes: 600,
      runs: Array.from({ length: count }, (_unused, index) => ({
        id: `run:${String(index).padStart(4, '0')}`,
        name: `agent-${String(index)}`,
        startMin: index,
        // Descending length, so "the longest first" has an unambiguous answer.
        lengthMin: count - index,
        outputTokens: index,
      })),
    });
  }

  it('⚠️ shows the top rows and states how many are not drawn', async () => {
    await openTrace(manyRuns(40));
    expect(screen.getAllByTestId('trace-bar')).toHaveLength(13); // 12 runs + the main loop
    expect(screen.getByTestId('trace-level-caption')).toHaveTextContent(
      'Showing the 12 of 40 subagent runs with the highest “how long it ran”',
    );
    expect(screen.getByTestId('trace-level-caption')).toHaveTextContent('28 more are not drawn');
  });

  it('⚠️ the remainder is a button, and clicking it draws the rest', async () => {
    await openTrace(manyRuns(40));
    const more = screen.getByTestId('timeline-band-more');
    expect(more).toHaveTextContent('and 28 more — show them');
    fireEvent.click(more);
    await waitFor(() => {
      expect(screen.getAllByTestId('trace-bar')).toHaveLength(41);
    });
    expect(screen.queryByTestId('timeline-band-more')).not.toBeInTheDocument();
  });

  it('picks the longest-running rows, and says which rule it used', async () => {
    await openTrace(manyRuns(40));
    // Longest first ⇒ agent-0 … agent-11 survive; agent-39 (one minute long) does not.
    expect(screen.getByText('agent-0')).toBeInTheDocument();
    expect(screen.queryByText('agent-39')).not.toBeInTheDocument();
  });

  it('lets the reader change the rule to tokens, and re-picks accordingly', async () => {
    await openTrace(manyRuns(40));
    fireEvent.change(screen.getByTestId('trace-order'), { target: { value: 'tokens' } });
    await waitFor(() => {
      // Tokens ascend with the index, so the last twelve now survive and the first do not.
      expect(screen.getByText('agent-39')).toBeInTheDocument();
    });
    expect(screen.queryByText('agent-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('trace-level-caption')).toHaveTextContent(
      'with the highest “tokens it produced”',
    );
  });
});

// ---------------------------------------------------------------------------------------
// Performance — the mounted element count, at every level
// ---------------------------------------------------------------------------------------

describe('§8.5 P-23 — a large trace mounts a bounded number of elements', () => {
  /** ~2,000 spans: 40 runs × 50 tool calls, plus the runs and the session. */
  function bigTrace(): ExecutionTrace {
    return buildTrace({
      sessionMinutes: 23 * 60,
      runs: Array.from({ length: 40 }, (_unused, index) => ({
        id: `run:${String(index).padStart(4, '0')}`,
        name: `agent-${String(index)}`,
        startMin: index * 30,
        lengthMin: 25,
        outputTokens: 1_000 + index,
        // Ten Reads, ten Edits, … — 50 calls that aggregate to five bars.
        calls: Array.from(
          { length: 50 },
          (_ignored, position) =>
            [
              ['Read', 'Edit', 'Bash', 'Grep', 'Write'][Math.floor(position / 10)] ?? 'Read',
              position * 2,
            ] as const,
        ),
      })),
    });
  }

  it('⚠️ stays bounded at the session level, at a run, and inside a group', async () => {
    const trace = bigTrace();
    expect(trace.timeline).toHaveLength(2_041); // 1 session + 40 runs + 2,000 calls

    await openTrace(trace);

    // Level 1 — 12 runs plus the main loop. Not 2,000 anything.
    expect(screen.getAllByTestId('trace-bar').length).toBeLessThanOrEqual(13);
    const level1 = document.querySelectorAll('*').length;
    expect(level1).toBeLessThan(600);

    // Level 2 — the run's 50 calls collapse to five bars.
    fireEvent.click(within(rowNamed('agent-0')).getByTestId('trace-open'));
    await waitFor(() => {
      expect(screen.getByText('Read ×10')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('trace-bar')).toHaveLength(6);
    expect(document.querySelectorAll('*').length).toBeLessThan(600);

    // Level 3 — ten individual calls, and its own row.
    fireEvent.click(within(rowNamed('Read ×10')).getByTestId('trace-open'));
    await waitFor(() => {
      expect(screen.getAllByTestId('trace-row')).toHaveLength(11);
    });
    expect(document.querySelectorAll('*').length).toBeLessThan(600);
  });
});

// ---------------------------------------------------------------------------------------
// CLAUDE.md §1a — no internal identifier reaches the screen
// ---------------------------------------------------------------------------------------

describe('CLAUDE.md §1a — the screen speaks English', () => {
  /**
   * ⚠️ The identifiers this project uses internally, as they would appear if one were copied into
   * a label: a metric id, an invariant, an ADR, a performance target, a fixture, an action, a
   * business rule, or a bare section sign.
   */
  const JARGON = /\b(M-\d|INV-\d|ADR-\d|P-\d\d|F-\d\d|ACT-\d|BR-\d|OQ-\d)|§/;

  function everyRenderedString(root: HTMLElement): string[] {
    const strings: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      strings.push(node.textContent ?? '');
    }
    // Attributes a reader can also see: hover titles, accessible names, placeholders.
    for (const element of root.querySelectorAll('*')) {
      for (const name of ['title', 'aria-label', 'placeholder', 'alt']) {
        const value = element.getAttribute(name);
        if (value !== null) strings.push(value);
      }
    }
    return strings;
  }

  function assertNoJargon(): void {
    const card = screen.getByTestId('graphs-trace');
    const offenders = everyRenderedString(card).filter((text) => JARGON.test(text));
    expect(offenders).toEqual([]);
  }

  it('⚠️ at the session level', async () => {
    await openTrace();
    assertNoJargon();
  });

  it('⚠️ inside a run, with the inspector open on an aggregated group', async () => {
    await openTrace();
    fireEvent.click(within(rowNamed('reviewer')).getByTestId('trace-open'));
    await screen.findByText('Read ×47');
    fireEvent.click(barOf('Read ×47'));
    await screen.findByTestId('node-inspector');
    assertNoJargon();
  });

  it('⚠️ with the unlinked disclosure and the inspector note on screen', async () => {
    await openTrace();
    fireEvent.click(barOf('stray'));
    await screen.findByTestId('node-inspector-note');
    assertNoJargon();
  });

  it('⚠️ when the query fails', async () => {
    renderView(<GraphsView />, stubs(standardTrace(), { 'q:executionTrace': () => DB_BUSY }));
    fireEvent.click(screen.getByTestId('graphs-tab-trace'));
    fireEvent.change(await screen.findByTestId('trace-session-picker'), {
      target: { value: SESSION_ID },
    });
    await screen.findByTestId('error-state');
    assertNoJargon();
  });
});

// ---------------------------------------------------------------------------------------
// The pure model, on its own
// ---------------------------------------------------------------------------------------

describe('the trace model', () => {
  it('⚠️ aggregates CONSECUTIVE calls only — an interruption starts a new group', () => {
    const span = (id: string, label: string, ts: number): TraceSpan => ({
      id,
      kind: 'tool',
      label,
      startTs: ts,
      endTs: ts,
      depth: 2,
    });
    const groups = aggregateToolCalls([
      span('a', 'Read', 10),
      span('b', 'Read', 20),
      span('c', 'Edit', 30),
      span('d', 'Read', 40),
    ]);

    // Three groups, not two: the second run of Reads is a separate stretch of time, and merging
    // it with the first would draw a bar across the Edit that the Reads did not occupy.
    expect(groups.map((group) => groupLabel(group.name, group.count))).toEqual([
      'Read ×2',
      'Edit',
      'Read',
    ]);
    expect(groups[0]).toMatchObject({ firstTs: 10, lastTs: 20 });
  });

  it('⚠️ never adopts a tool call whose owner is not in the payload', () => {
    const trace = standardTrace();
    // Strip one call's edge — the main process would emit none for an owner it could not resolve.
    trace.edges = trace.edges.filter((edge) => edge.id !== 'call:tool:run:1:0');
    const index = indexTrace(trace);

    expect(index.unattachedToolCalls).toBe(1);
    // The main loop did not gain it, and neither did the run.
    expect(index.toolsByOwner.get('run:1')).toHaveLength(58);
    expect(index.toolsByOwner.get(SESSION_NODE)).toHaveLength(1);
  });

  it('reports the unattached count on screen rather than absorbing it', async () => {
    const trace = standardTrace();
    trace.edges = trace.edges.filter((edge) => edge.id !== 'call:tool:run:1:0');
    await openTrace(trace);
    expect(screen.getByTestId('trace-unattached')).toHaveTextContent(
      '1 tool call could not be matched to the main loop or to a subagent run',
    );
  });

  it('ranks by the stated rule and keeps the drawn rows in time order', () => {
    const rows: TraceRow[] = [1, 2, 3].map((index) => ({
      id: `r${String(index)}`,
      kind: 'subagent',
      name: `r${String(index)}`,
      label: `r${String(index)}`,
      count: 1,
      startTs: index * 100,
      endTs: index * 100 + index * 10,
      colorIndex: 0,
      measured: true,
      unlinked: false,
      drillable: false,
      toolCalls: 0,
      outputTokens: 100 - index,
      nodeId: null,
    }));

    // Longest first keeps r3 (30 ms) and r2 (20 ms) — and returns them in time order.
    const byDuration = chooseRows(rows, 'duration', 2);
    expect(byDuration.rows.map((row) => row.id)).toEqual(['r2', 'r3']);
    expect(byDuration.hidden).toBe(1);

    // Most tokens first keeps r1 (99) and r2 (98) — same ordering rule on the way out.
    expect(chooseRows(rows, 'tokens', 2).rows.map((row) => row.id)).toEqual(['r1', 'r2']);
  });

  it('a breadcrumb pointing at something the payload no longer has resolves to nothing drawn', () => {
    const index = indexTrace(standardTrace());
    const level = buildTraceLevel(index, [{ kind: 'run', id: 'run:404', label: 'gone' }]);
    expect(level.resolved).toBe(false);
    expect(level.rows).toEqual([]);
  });
});
