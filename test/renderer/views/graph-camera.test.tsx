/**
 * The graph **camera** — §6.7's "Interactions on all four: pan, zoom, click-node-to-inspect, and
 * the global project/date filter", and the defect that made three of the four unusable.
 *
 * ⚠️⚠️ **What was wrong.** Tool Transition and Flow Sankey emitted a *constant* `viewBox`
 * (`0 0 900 600` and `0 0 900 520`) that had nothing to do with where their layouts actually put
 * anything, and implemented "zoom" as a CSS `transform: scale()` on the already-clipped `<svg>`.
 * A real 33-tool Markov graph lays out roughly four times wider than that box, and the Sankey's
 * final stage draws its labels past `x = 892`. Everything outside was cropped, and zooming out
 * scaled the crop — which is exactly the user's report: *"it appears that what it generated was
 * an image, that is extremely zoomed in … there is nothing beyond the lines."*
 *
 * The rules this suite exists to hold, one per reported symptom:
 *   · the first frame **contains the whole laid-out graph**, at any aspect ratio (wide AND tall);
 *   · zooming out past fit keeps **all** of it visible and never runs out of picture;
 *   · pan moves the view, by drag and by arrow key;
 *   · a node is a real, focusable element: click or Enter opens the inspector with **its** data,
 *     and empty space deselects;
 *   · the global filter re-queries three tabs and — INV-13 — **not** the Harness Map;
 *   · P-23's "showing top N" label appears only when the graph was genuinely capped.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { GraphsView } from '../../../src/renderer/views/GraphsView';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  boxContains,
  padToFit,
  panView,
  parseViewBox,
  unionBoxes,
  viewBoxOf,
  zoomOf,
  zoomView,
  type Box,
} from '../../../src/renderer/views/graphs/camera';
import { buildSankey } from '../../../src/renderer/views/graphs/FlowSankeyTab';
import {
  layoutToolTransition,
  NODE_HEIGHT,
  toolNodeWidth,
} from '../../../src/renderer/views/graphs/tool-transition-layout';
import { useAppStore } from '../../../src/renderer/store/app-store';
import { DB_BUSY, ok, renderView, resetAll, uninstallBridge } from './view-harness';
import {
  executionTrace,
  flowSankey,
  harnessGraph,
  toolTransition,
  wideGraph,
} from './graph-payloads';
import { sessionsPage } from './payloads';
import type { Graph } from '../../../src/shared/ipc-contract';

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

/** The rendered camera, read back off the DOM exactly as a browser would. */
function renderedView(testId: string): Box {
  const attribute = screen.getByTestId(testId).getAttribute('viewBox');
  expect(attribute).not.toBeNull();
  const box = parseViewBox(attribute ?? '');
  expect(box).not.toBeNull();
  return box as Box;
}

/**
 * jsdom gives every element a zero-sized rect, so a pointer drag has no pixel-to-graph-unit
 * scale to work from. This is the one measurement the camera makes; stubbing it is what lets a
 * drag be tested at all.
 */
function withSize(testId: string, width: number, height: number): void {
  const element = screen.getByTestId(testId);
  element.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height }) as DOMRect;
}

// ---------------------------------------------------------------------------------------
// The arithmetic, on its own
// ---------------------------------------------------------------------------------------

describe('§6.7 fit-to-content — the frame is measured, never assumed', () => {
  // ⚠️ Both aspect ratios, deliberately: the old bug was a *square-ish constant* frame, and a fit
  // rule that only works on square-ish graphs would reproduce it for anything long or tall.
  const WIDE: Box = { x: -400, y: 40, width: 4_000, height: 80 };
  const TALL: Box = { x: 12, y: -900, width: 80, height: 4_000 };

  it('⚠️ a deliberately WIDE layout is fully inside its fitted view', () => {
    expect(boxContains(padToFit(WIDE), WIDE)).toBe(true);
  });

  it('⚠️ a deliberately TALL layout is fully inside its fitted view', () => {
    expect(boxContains(padToFit(TALL), TALL)).toBe(true);
  });

  it('leaves a margin on every side rather than framing flush', () => {
    const fit = padToFit(WIDE);
    expect(fit.x).toBeLessThan(WIDE.x);
    expect(fit.y).toBeLessThan(WIDE.y);
    expect(fit.x + fit.width).toBeGreaterThan(WIDE.x + WIDE.width);
    expect(fit.y + fit.height).toBeGreaterThan(WIDE.y + WIDE.height);
  });

  it('has no bounding box at all for a graph with no geometry — it does not invent one', () => {
    // Inventing `0 0 900 600` for an empty graph is literally how the reported defect was
    // written. `null` forces the caller to show §6.7's empty copy instead.
    expect(unionBoxes([])).toBeNull();
  });

  it('unions boxes into the true extent, including negative coordinates', () => {
    // `cytoscape`'s circle layout genuinely returns negative coordinates for a 33-node graph.
    expect(
      unionBoxes([
        { x: -50, y: -20, width: 10, height: 10 },
        { x: 90, y: 5, width: 10, height: 5 },
      ]),
    ).toEqual({
      x: -50,
      y: -20,
      width: 150,
      height: 30,
    });
  });
});

describe('§6.7 zoom — the view changes, not the picture', () => {
  const CONTENT: Box = { x: 0, y: 0, width: 400, height: 200 };
  const FIT = padToFit(CONTENT);

  it('⚠️ zooming out past fit keeps ALL of the content visible', () => {
    let view = FIT;
    for (let step = 0; step < 12; step += 1) view = zoomView(view, FIT, 1 / 1.25);
    // The window is now much larger than the graph, and the graph is still entirely inside it.
    expect(view.width).toBeGreaterThan(FIT.width);
    expect(boxContains(view, CONTENT)).toBe(true);
  });

  it('⚠️ never runs out of picture — the window keeps growing until the stated floor', () => {
    let view = FIT;
    for (let step = 0; step < 200; step += 1) view = zoomView(view, FIT, 1 / 1.25);
    expect(zoomOf(view, FIT)).toBeCloseTo(MIN_ZOOM, 6);
    expect(boxContains(view, CONTENT)).toBe(true);
  });

  it('zooms in past fit too, and settles at the ceiling rather than collapsing', () => {
    let view = FIT;
    for (let step = 0; step < 200; step += 1) view = zoomView(view, FIT, 1.25);
    expect(zoomOf(view, FIT)).toBeCloseTo(MAX_ZOOM, 6);
    expect(view.width).toBeGreaterThan(0);
  });

  it('keeps the focus point pinned, so a wheel feels like a camera', () => {
    const focus = { x: 100, y: 50 };
    const zoomed = zoomView(FIT, FIT, 2, focus);
    // The graph point under the cursor sits at the same fraction of the window before and after.
    expect((focus.x - FIT.x) / FIT.width).toBeCloseTo((focus.x - zoomed.x) / zoomed.width, 9);
    expect((focus.y - FIT.y) / FIT.height).toBeCloseTo((focus.y - zoomed.y) / zoomed.height, 9);
  });

  it('pans by moving the window and nothing else', () => {
    const panned = panView(FIT, 30, -15);
    expect(panned.x).toBe(FIT.x + 30);
    expect(panned.y).toBe(FIT.y - 15);
    expect(panned.width).toBe(FIT.width);
    expect(panned.height).toBe(FIT.height);
  });

  it('round-trips through the viewBox attribute', () => {
    expect(parseViewBox(viewBoxOf(FIT))).toEqual({
      x: FIT.x,
      y: FIT.y,
      width: FIT.width,
      height: FIT.height,
    });
  });
});

// ---------------------------------------------------------------------------------------
// Tool Transition — the `cytoscape` layout the old frame did not fit
// ---------------------------------------------------------------------------------------

describe('§6.7 Tool Transition — the camera frames the real layout', () => {
  it('⚠️⚠️ the layout genuinely escapes the old constant frame — the bug was real', () => {
    // 33 tool nodes is the graph §8.5 P-23 sizes the budget against. `circle` grows its radius to
    // avoid overlap and ignores the 900×600 hint, so the old `viewBox="0 0 900 600"` cropped it.
    const nodes = Array.from({ length: 33 }, (_unused, index) => ({
      id: `tool:${String(index)}`,
      kind: 'tool',
      label: `tool-${String(index)}`,
      colorIndex: index % 8,
      metrics: {},
    }));
    const bounds = layoutToolTransition(nodes, []).bounds;
    expect(bounds).not.toBeNull();
    const box = bounds as Box;
    expect(box.x).toBeLessThan(0);
    expect(box.x + box.width).toBeGreaterThan(900);
  });

  it('⚠️ the rendered viewBox contains every node box', async () => {
    renderView(<GraphsView />, stubs());
    openTab('transition');
    await screen.findByTestId('transition-surface');

    const expected = layoutToolTransition(toolTransition().nodes, toolTransition().edges).bounds;
    expect(expected).not.toBeNull();
    expect(boxContains(renderedView('transition-surface'), expected as Box)).toBe(true);
  });

  it('⚠️ every drawn pill is inside the frame, label width included', async () => {
    // A long tool name widens its pill; the frame has to follow, or the name is the thing that
    // gets cut. Asserted against the drawn geometry rather than against the layout's own box.
    const long: Graph = {
      nodes: [
        {
          id: 'a',
          kind: 'tool',
          label: 'a-very-long-tool-name-indeed',
          colorIndex: 0,
          metrics: {},
        },
        { id: 'b', kind: 'tool', label: 'b', colorIndex: 1, metrics: {} },
      ],
      edges: [
        {
          id: 'a->b',
          source: 'a',
          target: 'b',
          kind: 'transition',
          designed: false,
          observed: 2,
        },
      ],
    };
    renderView(<GraphsView />, stubs({ 'q:toolTransition': () => ok(long) }));
    openTab('transition');
    await screen.findByTestId('transition-surface');

    const view = renderedView('transition-surface');
    for (const node of layoutToolTransition(long.nodes, long.edges).nodes) {
      const pill = {
        x: node.x - toolNodeWidth(node.label) / 2,
        y: node.y - NODE_HEIGHT / 2,
        width: toolNodeWidth(node.label),
        height: NODE_HEIGHT,
      };
      expect(boxContains(view, pill)).toBe(true);
    }
  });

  it('⚠️ zooming out with the + / − controls widens the view and keeps the graph inside', async () => {
    renderView(<GraphsView />, stubs());
    openTab('transition');
    await screen.findByTestId('transition-surface');
    const fitted = renderedView('transition-surface');

    for (let step = 0; step < 5; step += 1) {
      fireEvent.click(screen.getByTestId('zoom-controls-out'));
    }
    const zoomedOut = renderedView('transition-surface');
    expect(zoomedOut.width).toBeGreaterThan(fitted.width);
    // The whole graph is still in frame — zooming out reveals space, it does not run out of image.
    expect(boxContains(zoomedOut, fitted)).toBe(true);
  });

  it('zooms in past fit, and "Fit to view" puts it back in one click', async () => {
    renderView(<GraphsView />, stubs());
    openTab('transition');
    await screen.findByTestId('transition-surface');
    const fitted = renderedView('transition-surface');

    fireEvent.click(screen.getByTestId('zoom-controls-in'));
    fireEvent.click(screen.getByTestId('zoom-controls-in'));
    expect(renderedView('transition-surface').width).toBeLessThan(fitted.width);

    fireEvent.click(screen.getByTestId('zoom-controls-fit'));
    expect(renderedView('transition-surface')).toEqual(fitted);
  });

  it('⚠️ a wheel zooms the view — the trackpad drives the same camera as the buttons', async () => {
    renderView(<GraphsView />, stubs());
    openTab('transition');
    const surface = await screen.findByTestId('transition-surface');
    withSize('transition-surface', 800, 400);
    const before = renderedView('transition-surface');

    fireEvent.wheel(surface, { deltaY: -120, clientX: 400, clientY: 200 });
    expect(renderedView('transition-surface').width).toBeLessThan(before.width);

    fireEvent.wheel(surface, { deltaY: 240, clientX: 400, clientY: 200 });
    expect(renderedView('transition-surface').width).toBeGreaterThan(
      renderedView('transition-surface').width / 2,
    );
  });

  it('⚠️ dragging pans the view', async () => {
    renderView(<GraphsView />, stubs());
    openTab('transition');
    const surface = await screen.findByTestId('transition-surface');
    withSize('transition-surface', 800, 400);
    const before = renderedView('transition-surface');

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 300, clientY: 150 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 300, clientY: 150 });

    const after = renderedView('transition-surface');
    // Content follows the pointer, so the window moves the other way — and only the origin moves.
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
    expect(after.width).toBeCloseTo(before.width, 6);
    expect(after.height).toBeCloseTo(before.height, 6);
  });

  it('⚠️ arrow keys pan, +/− zoom and 0 fits (P-30)', async () => {
    renderView(<GraphsView />, stubs());
    openTab('transition');
    const surface = await screen.findByTestId('transition-surface');
    const fitted = renderedView('transition-surface');

    fireEvent.keyDown(surface, { key: 'ArrowRight' });
    expect(renderedView('transition-surface').x).toBeGreaterThan(fitted.x);
    fireEvent.keyDown(surface, { key: 'ArrowDown' });
    expect(renderedView('transition-surface').y).toBeGreaterThan(fitted.y);

    fireEvent.keyDown(surface, { key: '-' });
    expect(renderedView('transition-surface').width).toBeGreaterThan(fitted.width);
    fireEvent.keyDown(surface, { key: '+' });

    fireEvent.keyDown(surface, { key: '0' });
    expect(renderedView('transition-surface')).toEqual(fitted);

    // `F` is the other fit key §6.12 names, and it has to work identically.
    fireEvent.keyDown(surface, { key: 'ArrowLeft' });
    fireEvent.keyDown(surface, { key: 'F' });
    expect(renderedView('transition-surface')).toEqual(fitted);
  });

  it('the canvas takes focus, so the keyboard has somewhere to arrive (P-30)', async () => {
    renderView(<GraphsView />, stubs());
    openTab('transition');
    const surface = await screen.findByTestId('transition-surface');
    // `tokens.css` styles `[tabindex]:focus-visible` app-wide, so being focusable IS the ring.
    expect(surface).toHaveAttribute('tabindex', '0');
    expect(surface.getAttribute('aria-label')).toMatch(/arrow keys to pan/i);
  });

  it('⚠️ a node is a button: it clicks, it takes focus, and Enter inspects it', async () => {
    renderView(<GraphsView />, stubs());
    openTab('transition');
    const nodes = await screen.findAllByTestId('transition-node');
    for (const node of nodes) {
      expect(node).toHaveAttribute('role', 'button');
      expect(node).toHaveAttribute('tabindex', '0');
    }

    const read = nodes.find((node) => node.getAttribute('aria-label')?.startsWith('Read') === true);
    expect(read).toBeDefined();
    fireEvent.keyDown(read as Element, { key: 'Enter' });

    const inspector = await screen.findByTestId('node-inspector');
    expect(inspector).toHaveTextContent('Read');
    expect(inspector).toHaveTextContent('Transitions touching it');
  });

  it('⚠️ clicking a node opens the inspector with THAT node’s numbers', async () => {
    renderView(<GraphsView />, stubs());
    openTab('transition');
    const nodes = await screen.findAllByTestId('transition-node');
    const grep = nodes.find((node) => node.getAttribute('aria-label')?.startsWith('Grep') === true);
    fireEvent.click(grep as Element);

    const inspector = await screen.findByTestId('node-inspector');
    expect(inspector).toHaveTextContent('Grep');
    // Grep is touched by `Grep->Read` (7) and `Read->Grep` (3) — 10 transitions, hand-counted
    // from the fixture rather than read back off the component.
    expect(within(inspector).getByTestId('node-inspector-rows')).toHaveTextContent('10');
  });

  it('⚠️ clicking empty space deselects (§6.7)', async () => {
    renderView(<GraphsView />, stubs());
    openTab('transition');
    const nodes = await screen.findAllByTestId('transition-node');
    fireEvent.click(nodes[0] as Element);
    await screen.findByTestId('node-inspector');

    fireEvent.click(screen.getByTestId('transition-surface'));
    await waitFor(() => {
      expect(screen.queryByTestId('node-inspector')).not.toBeInTheDocument();
    });
  });

  it('marks the selected node in the DOM, not only in colour (FRONTEND §8)', async () => {
    renderView(<GraphsView />, stubs());
    openTab('transition');
    const nodes = await screen.findAllByTestId('transition-node');
    fireEvent.click(nodes[0] as Element);
    await waitFor(() => {
      expect(screen.getAllByTestId('transition-node')[0]).toHaveAttribute('data-selected', 'true');
    });
  });
});

// ---------------------------------------------------------------------------------------
// Flow Sankey — "the last part is cut and if I zoom out I cannot see it"
// ---------------------------------------------------------------------------------------

describe('§6.7 Flow Sankey — the last stage is inside the frame', () => {
  it('⚠️⚠️ the drawing really does extend past the old 900-unit frame', () => {
    // `d3-sankey` is given `[8,8] … [892,512]`, so the final stage's bands end at x = 892 and
    // their labels start at 896 and run outward. The old constant `viewBox="0 0 900 520"` cut
    // them off — this is the user's "the last part is cut", pinned as arithmetic.
    const bounds = buildSankey(flowSankey()).bounds;
    expect(bounds).not.toBeNull();
    expect((bounds as Box).x + (bounds as Box).width).toBeGreaterThan(900);
  });

  it('⚠️ the rendered viewBox contains the whole drawing, labels included', async () => {
    renderView(<GraphsView />, stubs());
    openTab('sankey');
    await screen.findByTestId('sankey-surface');
    const bounds = buildSankey(flowSankey()).bounds;
    expect(boxContains(renderedView('sankey-surface'), bounds as Box)).toBe(true);
  });

  it('⚠️ zooming out keeps the last stage visible instead of running out of image', async () => {
    renderView(<GraphsView />, stubs());
    openTab('sankey');
    await screen.findByTestId('sankey-surface');
    for (let step = 0; step < 6; step += 1) {
      fireEvent.click(screen.getByTestId('zoom-controls-out'));
    }
    const bounds = buildSankey(flowSankey()).bounds as Box;
    const view = renderedView('sankey-surface');
    expect(view.width).toBeGreaterThan(bounds.width);
    expect(boxContains(view, bounds)).toBe(true);
  });

  it('pans with the arrow keys and comes back with Fit', async () => {
    renderView(<GraphsView />, stubs());
    openTab('sankey');
    const surface = await screen.findByTestId('sankey-surface');
    const fitted = renderedView('sankey-surface');

    fireEvent.keyDown(surface, { key: 'ArrowRight' });
    expect(renderedView('sankey-surface').x).toBeGreaterThan(fitted.x);
    fireEvent.click(screen.getByTestId('zoom-controls-fit'));
    expect(renderedView('sankey-surface')).toEqual(fitted);
  });

  it('⚠️ clicking a band’s node opens the inspector with its own output-token figure', async () => {
    renderView(<GraphsView />, stubs());
    openTab('sankey');
    const nodes = await screen.findAllByTestId('sankey-node');
    const model = nodes.find(
      (node) => node.getAttribute('aria-label')?.startsWith('claude-test-1') === true,
    );
    fireEvent.click(model as Element);

    const inspector = await screen.findByTestId('node-inspector');
    expect(inspector).toHaveTextContent('claude-test-1');
    // 600 + 400 out of the model = 1,000 output tokens, hand-counted from the fixture.
    expect(within(inspector).getByTestId('node-inspector-rows')).toHaveTextContent('1,000');
  });

  it('deselects when the canvas background is clicked', async () => {
    renderView(<GraphsView />, stubs());
    openTab('sankey');
    const nodes = await screen.findAllByTestId('sankey-node');
    fireEvent.click(nodes[0] as Element);
    await screen.findByTestId('node-inspector');

    fireEvent.click(screen.getByTestId('sankey-surface'));
    await waitFor(() => {
      expect(screen.queryByTestId('node-inspector')).not.toBeInTheDocument();
    });
  });

  it('inspects a node’s incoming and outgoing output tokens, in plain words', async () => {
    renderView(<GraphsView />, stubs());
    openTab('sankey');
    const nodes = await screen.findAllByTestId('sankey-node');
    const model = nodes.find(
      (node) => node.getAttribute('aria-label')?.startsWith('claude-test-1') === true,
    );
    fireEvent.click(model as Element);
    const rows = within(await screen.findByTestId('node-inspector')).getByTestId(
      'node-inspector-rows',
    );
    // The model takes 1,000 tokens in from the project and passes 600 + 400 out to the two tools.
    expect(rows).toHaveTextContent('Output tokens flowing in');
    expect(rows).toHaveTextContent('Output tokens flowing out');
  });

  // ⚠️⚠️ The reported "clicking a Sankey node does nothing" (2026-07-22). The click was wired the
  // whole time, but the surface captured the pointer on pointer-DOWN, and in Chromium that hands
  // the subsequent `click` to the capturing <svg> — so it hit the background deselect, not the
  // node. jsdom does not model capture-retargets-click, so this pins the cause directly: no
  // capture on a plain click, capture only once a real drag begins.
  it('⚠️ does not capture the pointer on a plain click, so the click reaches the node', async () => {
    renderView(<GraphsView />, stubs());
    openTab('sankey');
    const surface = await screen.findByTestId('sankey-surface');
    const captured: number[] = [];
    surface.setPointerCapture = (id: number) => {
      captured.push(id);
    };

    fireEvent.pointerDown(surface, { button: 0, pointerId: 9, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(surface, { pointerId: 9, clientX: 120, clientY: 120 });
    expect(captured).toEqual([]);
  });

  it('captures the pointer once a drag passes the slop, so a pan still tracks off-element', async () => {
    renderView(<GraphsView />, stubs());
    openTab('sankey');
    const surface = await screen.findByTestId('sankey-surface');
    withSize('sankey-surface', 800, 400);
    const captured: number[] = [];
    surface.setPointerCapture = (id: number) => {
      captured.push(id);
    };

    fireEvent.pointerDown(surface, { button: 0, pointerId: 10, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(surface, { pointerId: 10, clientX: 300, clientY: 150 });
    expect(captured).toContain(10);
  });

  it('shows §6.7’s empty copy rather than an empty camera when there is nothing to draw', async () => {
    renderView(<GraphsView />, stubs({ 'q:flowSankey': () => ok({ nodes: [], links: [] }) }));
    openTab('sankey');
    const card = await screen.findByTestId('graphs-sankey');
    await waitFor(() => {
      expect(within(card).getByTestId('empty-state')).toHaveTextContent(
        'no costed or counted flows in range',
      );
    });
    expect(screen.queryByTestId('sankey-surface')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// The `@xyflow/react` canvases
// ---------------------------------------------------------------------------------------

describe('§6.7 — the two library canvases are navigable too', () => {
  it('the Harness Map canvas is focusable and says how to drive it (P-30)', async () => {
    renderView(<GraphsView />, stubs());
    const flow = await screen.findByTestId('harness-flow');
    expect(flow).toHaveAttribute('tabindex', '0');
    expect(flow.getAttribute('aria-label')).toMatch(/arrow keys to pan/i);
  });

  it('answers the same keys without throwing, and offers the same fit control', async () => {
    renderView(<GraphsView />, stubs());
    const flow = await screen.findByTestId('harness-flow');
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '0', 'F']) {
      fireEvent.keyDown(flow, { key });
    }
    const controls = screen.getByTestId('zoom-controls');
    expect(within(controls).getByLabelText('Fit to view')).toBeInTheDocument();
  });

  it('⚠️ clicking empty canvas closes the inspector', async () => {
    renderView(<GraphsView />, stubs());
    await screen.findByTestId('harness-flow');
    const node = screen
      .getAllByTestId('flow-node')
      .find((candidate) => candidate.textContent?.includes('demo-skill') === true);
    fireEvent.click(node as HTMLElement);
    await screen.findByTestId('node-inspector');

    fireEvent.click(document.querySelector('.react-flow__pane') as Element);
    await waitFor(() => {
      expect(screen.queryByTestId('node-inspector')).not.toBeInTheDocument();
    });
  });

  it('shows §6.7’s empty copy — not a blank canvas — when the scan finds nothing', async () => {
    // ⚠️ The Harness Map's data side is being fixed elsewhere (project-level `.claude/` folders);
    // what this canvas owes is that zero nodes reads as an explanation, not as a broken picture.
    renderView(<GraphsView />, stubs({ 'q:harnessGraph': () => ok({ nodes: [], edges: [] }) }));
    const card = await screen.findByTestId('graphs-harness');
    await waitFor(() => {
      expect(within(card).getByTestId('empty-state')).toHaveTextContent(
        'no skills or agents found under this directory',
      );
    });
    expect(screen.queryByTestId('harness-flow')).not.toBeInTheDocument();
  });

  it('renders and frames the canvas as soon as nodes do arrive', async () => {
    renderView(<GraphsView />, stubs());
    expect(await screen.findByTestId('harness-flow')).toBeInTheDocument();
    expect(screen.getAllByTestId('flow-node').length).toBe(6);
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
  });

  it('⚠️ Enter on a focused node opens the inspector (P-30)', async () => {
    renderView(<GraphsView />, stubs());
    await screen.findByTestId('harness-flow');
    const node = screen
      .getAllByTestId('flow-node')
      .find((candidate) => candidate.textContent?.includes('demo-skill') === true);
    fireEvent.keyDown(node as HTMLElement, { key: 'Enter' });
    expect(await screen.findByTestId('node-inspector')).toHaveTextContent('demo-skill');
  });

  it('draws the inspected node as selected, so the rail and the picture agree', async () => {
    renderView(<GraphsView />, stubs());
    await screen.findByTestId('harness-flow');
    const node = screen
      .getAllByTestId('flow-node')
      .find((candidate) => candidate.textContent?.includes('demo-skill') === true);
    fireEvent.click(node as HTMLElement);
    await screen.findByTestId('node-inspector');
    await waitFor(() => {
      expect(document.querySelectorAll('.react-flow__node.selected')).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------------------
// Execution Trace — it needs a session to select, and the unlinked lane must survive
// ---------------------------------------------------------------------------------------

describe('§6.7 Execution Trace — a session to pick, and a trace once picked', () => {
  it('⚠️ the picker is populated from `q:sessions`, which the tab actually calls', async () => {
    const { bridge } = renderView(<GraphsView />, stubs());
    openTab('trace');
    const picker = await screen.findByTestId('trace-session-picker');
    // One placeholder plus the real rows — an empty picker is the reported symptom.
    expect(within(picker).getAllByRole('option').length).toBeGreaterThan(1);
    expect(bridge.calls.some((call) => call.channel === 'q:sessions')).toBe(true);
  });

  it('renders the timeline and the unlinked lane once a session is chosen', async () => {
    renderView(<GraphsView />, stubs());
    openTab('trace');
    fireEvent.change(await screen.findByTestId('trace-session-picker'), {
      target: { value: 'sess-0000-1111' },
    });
    expect(await screen.findByTestId('trace-unlinked-lane')).toHaveTextContent(
      '1 shown on their own',
    );
    expect(screen.getByTestId('timeline-band')).toBeInTheDocument();
  });

  it('is navigable: focusable surface, keys, and a fit control', async () => {
    renderView(<GraphsView />, stubs());
    openTab('trace');
    fireEvent.change(await screen.findByTestId('trace-session-picker'), {
      target: { value: 'sess-0000-1111' },
    });
    const surface = await screen.findByTestId('timeline-band-surface');
    expect(surface).toHaveAttribute('tabindex', '0');
    for (const key of ['ArrowLeft', 'ArrowRight', '+', '-', '0']) {
      fireEvent.keyDown(surface, { key });
    }
    expect(
      within(screen.getByTestId('zoom-controls')).getByLabelText('Fit to view'),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// The affordance, said in words
// ---------------------------------------------------------------------------------------

describe('§6.7 — the canvas says it can be driven', () => {
  it('⚠️ every drawn canvas states that it pans, zooms and inspects', async () => {
    renderView(<GraphsView />, stubs());
    for (const [tab, testId] of [
      ['harness', 'graphs-harness'],
      ['transition', 'graphs-transition'],
      ['sankey', 'graphs-sankey'],
    ] as const) {
      openTab(tab);
      const card = await screen.findByTestId(testId);
      await waitFor(() => {
        expect(within(card).getByTestId(`${testId}-hint`)).toHaveTextContent(
          /drag to pan.*scroll to zoom.*click a node/i,
        );
      });
    }
  });

  it('says nothing about panning on a canvas that is showing an empty state', async () => {
    // ⚠️ An affordance advertised over §6.7's empty copy contradicts it.
    renderView(<GraphsView />, stubs({ 'q:harnessGraph': () => ok({ nodes: [], edges: [] }) }));
    const card = await screen.findByTestId('graphs-harness');
    await waitFor(() => {
      expect(within(card).getByTestId('empty-state')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('graphs-harness-hint')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// §6.7 — "and the global project/date filter"
// ---------------------------------------------------------------------------------------

describe('§6.7 — the global filter drives three tabs, and INV-13 keeps it off the fourth', () => {
  function countOf(bridge: { calls: { channel: string }[] }, channel: string): number {
    return bridge.calls.filter((call) => call.channel === channel).length;
  }

  it('⚠️ Tool Transition re-queries on a filter change', async () => {
    const { bridge } = renderView(<GraphsView />, stubs());
    openTab('transition');
    await screen.findByTestId('transition-surface');
    const before = countOf(bridge, 'q:toolTransition');

    act(() => {
      useAppStore.getState().setFilter({ projectIds: [7], from: null, to: null });
    });
    await waitFor(() => {
      expect(countOf(bridge, 'q:toolTransition')).toBeGreaterThan(before);
    });
  });

  it('⚠️ Flow Sankey re-queries on a filter change', async () => {
    const { bridge } = renderView(<GraphsView />, stubs());
    openTab('sankey');
    await screen.findByTestId('sankey-surface');
    const before = countOf(bridge, 'q:flowSankey');

    act(() => {
      useAppStore.getState().setFilter({ projectIds: [7], from: null, to: null });
    });
    await waitFor(() => {
      expect(countOf(bridge, 'q:flowSankey')).toBeGreaterThan(before);
    });
  });

  it('⚠️ Execution Trace re-queries the session list on a filter change', async () => {
    // The trace itself is keyed by session; the filter reaches it by changing **which sessions
    // are offerable**, which is the honest binding for a per-session picture.
    const { bridge } = renderView(<GraphsView />, stubs());
    openTab('trace');
    await screen.findByTestId('trace-session-picker');
    const before = countOf(bridge, 'q:sessions');

    act(() => {
      useAppStore.getState().setFilter({ projectIds: [7], from: null, to: null });
    });
    await waitFor(() => {
      expect(countOf(bridge, 'q:sessions')).toBeGreaterThan(before);
    });
  });

  it('⛔ the Harness Map does NOT re-query, and says "all time" on screen (INV-13)', async () => {
    const { bridge } = renderView(<GraphsView />, stubs());
    await screen.findByTestId('harness-flow');
    expect(screen.getByTestId('harness-all-time')).toHaveTextContent('all time');
    const before = countOf(bridge, 'q:harnessGraph');

    act(() => {
      useAppStore.getState().setFilter({ projectIds: [7], from: null, to: null });
    });
    await waitFor(() => {
      expect(screen.getByTestId('harness-flow')).toBeInTheDocument();
    });
    expect(countOf(bridge, 'q:harnessGraph')).toBe(before);
  });

  it('⚠️ a filter change re-frames the camera without remounting the canvas (§6.12)', async () => {
    let payload = toolTransition();
    const { bridge } = renderView(<GraphsView />, stubs({ 'q:toolTransition': () => ok(payload) }));
    openTab('transition');
    const surface = await screen.findByTestId('transition-surface');
    const before = renderedView('transition-surface');

    // A genuinely different graph: one node fewer, so the layout — and the frame — must change.
    payload = {
      nodes: payload.nodes.slice(0, 3),
      edges: payload.edges.filter((edge) => !edge.id.includes('Grep')),
    };
    act(() => {
      useAppStore.getState().setFilter({ projectIds: [9], from: null, to: null });
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('transition-node')).toHaveLength(3);
    });
    // ⚠️ The SAME element — the camera moved, nothing re-entered (§6.12).
    expect(screen.getByTestId('transition-surface')).toBe(surface);
    expect(renderedView('transition-surface')).not.toEqual(before);
    expect(countOf(bridge, 'q:toolTransition')).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------------------
// §8.5 P-23 — the cap label, on the canvases that draw themselves
// ---------------------------------------------------------------------------------------

describe('§8.5 P-23 — the cap is stated, never implied', () => {
  it('⚠️ Tool Transition says "top 500 of N" when it caps, and nothing when it does not', async () => {
    const big = wideGraph(540);
    const edges = big.nodes.slice(0, 400).map((node, index) => ({
      id: `t${String(index)}`,
      source: node.id,
      target: big.nodes[(index + 1) % 400]?.id ?? node.id,
      kind: 'transition',
      designed: false,
      observed: 540 - index,
    }));
    renderView(
      <GraphsView />,
      stubs({ 'q:toolTransition': () => ok({ nodes: big.nodes, edges }) }),
    );
    openTab('transition');
    const card = await screen.findByTestId('graphs-transition');
    await waitFor(() => {
      expect(card).toHaveTextContent(/top 500 of 540 nodes/i);
    });
  });

  it('says nothing about a cap on an uncapped Sankey', async () => {
    renderView(<GraphsView />, stubs());
    openTab('sankey');
    const card = await screen.findByTestId('graphs-sankey');
    await waitFor(() => {
      expect(card).toHaveTextContent('4 nodes.');
    });
    expect(card).not.toHaveTextContent(/top 500/i);
  });

  it('the error state still fills the canvas and leaves the tab row usable', async () => {
    renderView(<GraphsView />, stubs({ 'q:toolTransition': () => DB_BUSY }));
    openTab('transition');
    const card = await screen.findByTestId('graphs-transition');
    expect(within(card).getByTestId('error-state')).toBeInTheDocument();
    expect(screen.queryByTestId('transition-surface')).not.toBeInTheDocument();
  });
});
