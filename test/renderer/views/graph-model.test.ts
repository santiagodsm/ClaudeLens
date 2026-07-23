/**
 * §6.7's arithmetic, tested where it lives — as pure functions, with hand-computed values.
 *
 * ⚠️ Three of these are the ones that would fail silently in a rendered canvas: the
 * designed/observed classification (a picture still looks like a picture when every edge is in
 * the wrong class), the P-23 cap (a truncated graph looks complete), and cytoscape's determinism
 * (a layout that reshuffles looks like a redraw). None of them is asserted by looking at a line.
 */

import { describe, expect, it } from 'vitest';
import {
  capGraph,
  classifyEdge,
  edgeDashArray,
  edgeIsHighlighted,
  edgeWidth,
  harnessShape,
  MAX_EDGE_WIDTH,
  MIN_EDGE_WIDTH,
  maxObserved,
} from '../../../src/renderer/views/graphs/graph-model';
import {
  layoutToolTransition,
  transitionWeights,
} from '../../../src/renderer/views/graphs/tool-transition-layout';
import { layoutLayers, LAYER_GAP, ROW_GAP } from '../../../src/renderer/views/graphs/layout';
import {
  cappedPromptPreview,
  promptWasTruncated,
  PROMPT_PREVIEW_MAX_CHARS,
} from '../../../src/renderer/views/graphs/NodeInspector';
import { graphEdge, graphNode, toolTransition, wideGraph } from './graph-payloads';

describe('§6.7 / M-14 — designed and observed are two fields, not one', () => {
  it('classifies all four representable combinations', () => {
    expect(classifyEdge({ designed: true, observed: 0 })).toBe('designed-only');
    expect(classifyEdge({ designed: false, observed: 7 })).toBe('observed-only');
    expect(classifyEdge({ designed: true, observed: 7 })).toBe('both');
    expect(classifyEdge({ designed: false, observed: 0 })).toBe('neither');
  });

  it('⚠️ does not collapse `!designed && observed > 0` into "observed"', () => {
    // The state §4.5 calls "legal and interesting": a call that happens but is not declared.
    // A truthiness test on `observed` alone would put this in the same bucket as `both`.
    expect(classifyEdge({ designed: false, observed: 1 })).not.toBe(
      classifyEdge({ designed: true, observed: 1 }),
    );
  });

  it('§6.7 — dashed where designed && observed === 0, highlighted where !designed && observed > 0', () => {
    expect(edgeDashArray('designed-only')).not.toBeNull();
    expect(edgeDashArray('both')).toBeNull();
    expect(edgeDashArray('observed-only')).toBeNull();
    expect(edgeIsHighlighted('observed-only')).toBe(true);
    expect(edgeIsHighlighted('both')).toBe(false);
    expect(edgeIsHighlighted('designed-only')).toBe(false);
  });
});

describe('§6.7 — edge thickness ∝ observed', () => {
  it('scales linearly between the two widths', () => {
    // 6 of 12 observed → half way: 1 + 0.5 × (6 − 1) = 3.5
    expect(edgeWidth(6, 12)).toBe(3.5);
    expect(edgeWidth(12, 12)).toBe(MAX_EDGE_WIDTH);
    // 3 of 12 → 1 + 0.25 × 5 = 2.25
    expect(edgeWidth(3, 12)).toBe(2.25);
  });

  it('⚠️ draws a never-observed edge at the minimum width, never at zero', () => {
    // A zero-width line is an absent line, and a designed-but-dead edge is the thing the map
    // exists to show. It is distinguished by being dashed, not by disappearing.
    expect(edgeWidth(0, 12)).toBe(MIN_EDGE_WIDTH);
    expect(edgeWidth(0, 0)).toBe(MIN_EDGE_WIDTH);
  });

  it('reads the denominator off the graph', () => {
    expect(maxObserved([graphEdge({ observed: 2 }), graphEdge({ observed: 40 })])).toBe(40);
    expect(maxObserved([])).toBe(0);
  });
});

describe('§8.5 P-23 / §11.7 — the node cap', () => {
  it('does not cap a graph under the limit, and says so', () => {
    const graph = wideGraph(10);
    const capped = capGraph(graph.nodes, graph.edges, (node) => node.metrics['observed'] ?? 0, 500);
    expect(capped.capped).toBe(false);
    expect(capped.rendered).toBe(10);
    expect(capped.total).toBe(10);
  });

  it('keeps the top N by the caller’s rank and reports both counts', () => {
    const graph = wideGraph(520); // observed runs 520 down to 1
    const capped = capGraph(graph.nodes, graph.edges, (node) => node.metrics['observed'] ?? 0, 500);
    expect(capped.total).toBe(520);
    expect(capped.rendered).toBe(500);
    expect(capped.capped).toBe(true);
    // The busiest survives, the 501st-busiest does not. `observed` 520 is node 0; `observed` 20
    // is node 500, the first one dropped.
    expect(capped.nodes[0]?.label).toBe('tool-0');
    expect(capped.nodes.some((node) => node.label === 'tool-500')).toBe(false);
  });

  it('⚠️ produces the same 500 twice — a cap that reshuffles is worse than no cap', () => {
    const graph = wideGraph(600);
    const rank = (): number => 0; // every node ties, so only the tie-break decides
    const first = capGraph(graph.nodes, graph.edges, rank, 500).nodes.map((node) => node.id);
    const second = capGraph([...graph.nodes].reverse(), graph.edges, rank, 500).nodes.map(
      (node) => node.id,
    );
    expect(second).toEqual(first);
  });

  it('drops edges whose endpoint was cut, never a line into nothing', () => {
    const nodes = [
      graphNode({ id: 'a', metrics: { observed: 9 } }),
      graphNode({ id: 'b', metrics: { observed: 1 } }),
    ];
    const edges = [graphEdge({ id: 'e', source: 'a', target: 'b' })];
    const capped = capGraph(nodes, edges, (node) => node.metrics['observed'] ?? 0, 1);
    expect(capped.nodes.map((node) => node.id)).toEqual(['a']);
    expect(capped.edges).toEqual([]);
  });
});

describe('§6.7 — Harness Map node shapes', () => {
  it('is total over §3.10’s ten kinds, and role beats kind', () => {
    expect(harnessShape({ kind: 'skill', role: 'orchestrator' })).toBe('orchestrator');
    expect(harnessShape({ kind: 'skill' })).toBe('worker');
    expect(harnessShape({ kind: 'agent' })).toBe('worker');
    expect(harnessShape({ kind: 'command' })).toBe('worker');
    expect(harnessShape({ kind: 'tool' })).toBe('tool');
    for (const kind of ['file', 'memory', 'claude_md', 'settings']) {
      expect(harnessShape({ kind })).toBe('file');
    }
    for (const kind of ['plugin', 'marketplace']) {
      expect(harnessShape({ kind })).toBe('container');
    }
    // An unmapped kind is visibly `other` rather than borrowing one of the four meanings.
    expect(harnessShape({ kind: 'something-new' })).toBe('other');
  });
});

describe('layout — the same data produces the same picture twice', () => {
  it('places layers deterministically, with no clock and no randomness', () => {
    const layers = [['a'], ['b', 'c']];
    const first = layoutLayers(layers);
    expect(layoutLayers(layers)).toEqual(first);
    // Column 0 has one node against a tallest of two, so it is offset by half a row.
    expect(first).toEqual([
      { id: 'a', x: 0, y: ROW_GAP / 2 },
      { id: 'b', x: LAYER_GAP, y: 0 },
      { id: 'c', x: LAYER_GAP, y: ROW_GAP },
    ]);
  });

  // The unlinked-lane placement that used to be tested here went with the Execution Trace's
  // node-link diagram (2026-07-22). The lane itself did not: it is a labelled band of rows on the
  // timeline now, and `execution-trace.test.tsx` asserts it by its caption and its rows.

  // ⚠️ Bug 1 (2026-07-22): the Harness Map rendered as a ~40 px vertical stripe because a whole
  // kind — hundreds of files, or 500 tools after the P-23 cap — stacked into ONE tall column.
  // Fit-to-content then scaled that narrow-and-very-tall box by its height, hiding the graph in a
  // sliver. A dominant layer now wraps across sub-columns so the bounding box is broad, not tall.
  it('⚠️ spreads a layer of many nodes across the width instead of one tall stripe', () => {
    const many = Array.from({ length: 300 }, (_unused, i) => `n${String(i)}`);
    const placed = layoutLayers([many]);
    const xs = placed.map((node) => node.x);
    const ys = placed.map((node) => node.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    // The layer is drawn as a grid, not a single column: many distinct x positions…
    expect(new Set(xs).size).toBeGreaterThan(1);
    // …and the result is wider than it is tall — the opposite of the reported stripe, whose
    // width/height ratio was on the order of 0.007.
    expect(width).toBeGreaterThan(height);
  });

  it('leaves a small graph exactly one column per layer, unchanged', () => {
    // The wrapping must not disturb the common case: a handful of nodes still reads as clean
    // left-to-right columns, so the 6-node demo map looks as it always did.
    expect(layoutLayers([['a', 'b'], ['c']])).toEqual([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 0, y: ROW_GAP },
      { id: 'c', x: LAYER_GAP, y: ROW_GAP / 2 },
    ]);
  });
});

describe('ADR-011 — cytoscape’s layout really is deterministic', () => {
  const graph = toolTransition();

  it('⚠️ returns identical coordinates on a second run', () => {
    // Measured, not assumed: ADR-011 chose this library over a force-directed one *because*
    // the same data must produce the same picture twice.
    const first = layoutToolTransition(graph.nodes, graph.edges).nodes;
    const second = layoutToolTransition(graph.nodes, graph.edges).nodes;
    expect(second).toEqual(first);
  });

  it('⚠️ is independent of the order the payload arrived in', () => {
    // `circle` walks the element array, so without the total order we impose first, a re-query
    // that returned the rows in another order would rotate the whole graph.
    const first = layoutToolTransition(graph.nodes, graph.edges).nodes;
    const shuffled = layoutToolTransition(
      [...graph.nodes].reverse(),
      [...graph.edges].reverse(),
    ).nodes;
    expect([...shuffled].sort(byId)).toEqual([...first].sort(byId));
  });

  it('weights a node by every transition touching it', () => {
    // Read: 40 out + 3 out + 12 in + 7 in = 62
    expect(transitionWeights(graph.nodes, graph.edges).get('tool:Read')).toBe(62);
  });

  it('returns nothing for an empty graph rather than a degenerate point', () => {
    expect(layoutToolTransition([], []).nodes).toEqual([]);
  });
});

describe('§3.9 / §6.7 — the 280-character prompt cap', () => {
  it('passes a short preview through untouched', () => {
    expect(cappedPromptPreview('hello')).toBe('hello');
    expect(promptWasTruncated('hello')).toBe(false);
  });

  it('⚠️ caps at exactly 280 characters and appends nothing', () => {
    const long = 'x'.repeat(400);
    const capped = cappedPromptPreview(long);
    expect(capped).toHaveLength(PROMPT_PREVIEW_MAX_CHARS);
    expect(PROMPT_PREVIEW_MAX_CHARS).toBe(280);
    // An appended ellipsis would make the rendered string 281 long; "≤280" is a stated limit.
    expect(capped.endsWith('…')).toBe(false);
    expect(promptWasTruncated(long)).toBe(true);
  });

  it('does not truncate a preview of exactly 280', () => {
    const exact = 'y'.repeat(280);
    expect(cappedPromptPreview(exact)).toBe(exact);
    expect(promptWasTruncated(exact)).toBe(false);
  });
});

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}
