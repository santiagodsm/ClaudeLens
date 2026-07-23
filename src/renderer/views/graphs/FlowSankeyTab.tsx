/**
 * §6.7 tab 4 — **Flow Sankey**. `q:flowSankey` on `d3-sankey` **layout only**, rendered as SVG by
 * our own code (ADR-011).
 *
 * ⚠️ ADR-011, verbatim: "`d3-sankey` has not been published since 2019 and that is fine and stated
 * plainly: it is ~600 lines of finished layout arithmetic with no dependencies and no attack
 * surface; we render its output ourselves." It is not to be swapped for something maintained —
 * the whole reason it is acceptable is that we use none of its rendering. The 2026-07-22 fix here
 * is therefore the **camera and the bounding box**, not a library change.
 *
 * ⚠️⚠️ **The clipping the user reported — "the last part is cut and if I zoom out I cannot see
 * it" — was a `viewBox` that did not contain the drawing.** The layout runs inside
 * `[8, 8] … [892, 512]`, so the final stage's nodes end at `x = 892`; their labels are drawn at
 * `x1 + 4` and run outward from there, well past the constant `viewBox="0 0 900 520"` this tab
 * used to emit. Everything beyond 900 was clipped, and "zoom out" was a CSS `scale()` on the
 * already-clipped element, so the missing labels could never be recovered. `buildSankey` now
 * returns the **measured** bounding box of every band, node and label, and the camera frames it.
 *
 * ⚠️ **Band width ∝ output tokens** (§6.7). `q:flowSankey`'s `value` is output tokens and the
 * band height is `d3-sankey`'s own width for that link; nothing here rescales or apportions.
 *
 * ⚠️ **A cycle is not drawable and is not silently dropped.** `d3-sankey` throws on a circular
 * link set. The two stages `q:flowSankey` emits — `project → model` and `model → tool` — cannot
 * form one, but if a future stage ever did, the tab reports it rather than rendering a partial
 * picture that looks complete (CLAUDE.md §1).
 *
 * ⚠️ Colours come from the token layer via the §3.3 hue index the payload carries, so a project
 * or model keeps the hue it has in every other view (§6.1).
 */

import { sankey, sankeyLinkHorizontal, sankeyJustify } from 'd3-sankey';
import { useMemo, useState, type JSX } from 'react';
import type { FlowSankey } from '../../../shared/ipc-contract';
import { GraphCanvas } from '../../components/GraphCanvas';
import { useQuery } from '../../hooks/use-query';
import { categoricalVar } from '../../lib/colors';
import { formatCompact, formatInteger } from '../../lib/format';
import { MAX_RENDERED_GRAPH_NODES } from '../../lib/limits';
import { useAppStore } from '../../store/app-store';
import { unionBoxes, type Box } from './camera';
import { GraphSurface, SvgNode } from './GraphSurface';
import { NodeInspector } from './NodeInspector';
import { GRAPH_TAB_BY_ID } from './tabs';
import { useGraphCamera } from './use-graph-camera';
import { ZoomControls } from './ZoomControls';

const TAB = GRAPH_TAB_BY_ID.sankey;

/** The unitless box `d3-sankey` lays out inside. ⚠️ NOT the frame — see `SankeyModel.bounds`. */
const WIDTH = 900;
const HEIGHT = 520;
const NODE_WIDTH = 14;
const NODE_PADDING = 12;
const MARGIN = 8;

/** Label geometry, in the same graph units. `LABEL_CHAR_WIDTH` is a deliberate over-estimate. */
const LABEL_GAP = 4;
const LABEL_CHAR_WIDTH = 6.5;
const LABEL_LINE_HEIGHT = 16;
const LABEL_FONT_SIZE = 11;

interface SankeyNode {
  id: string;
  label: string;
  kind: string;
  colorIndex: number;
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
  value?: number;
}

interface SankeyLink {
  source: string | SankeyNode;
  target: string | SankeyNode;
  value: number;
  width?: number;
}

interface SankeyModel {
  nodes: SankeyNode[];
  links: SankeyLink[];
  /** Non-null when the layout could not be computed — reported, never swallowed. */
  failure: string | null;
  total: number;
  rendered: number;
  capped: boolean;
  /**
   * The measured extent of everything drawn — every band **and its label**. `null` when there is
   * nothing to draw. §6.7's fit rule reads off this and nothing else.
   */
  bounds: Box | null;
}

/** What a node's label reads, so its width is estimated from the string actually rendered. */
export function sankeyNodeLabel(label: string, value: number): string {
  return `${label} · ${formatCompact(value)}`;
}

/**
 * The box one node occupies **including the label to its right**.
 *
 * ⚠️ The label is part of the drawing, so it is part of the bounding box. Leaving it out is
 * precisely how the last stage came to be cut off: its bands ended inside the old frame and its
 * names did not.
 */
function nodeBounds(node: SankeyNode): Box {
  const x0 = node.x0 ?? 0;
  const x1 = node.x1 ?? 0;
  const y0 = node.y0 ?? 0;
  const y1 = node.y1 ?? 0;
  const text = sankeyNodeLabel(node.label, node.value ?? 0);
  const height = Math.max(y1 - y0, LABEL_LINE_HEIGHT);
  const centre = (y0 + y1) / 2;
  return {
    x: x0,
    y: centre - height / 2,
    width: x1 - x0 + LABEL_GAP + text.length * LABEL_CHAR_WIDTH,
    height,
  };
}

/**
 * §11.7 leaves the Sankey's ranking open. Stated here: **by the node's own flow value**, which
 * `d3-sankey` computes as the sum of its links — the only quantity a band has. Ranking happens
 * before the layout, because a node dropped afterwards would leave a band hanging.
 */
export function buildSankey(data: FlowSankey, limit = MAX_RENDERED_GRAPH_NODES): SankeyModel {
  const total = data.nodes.length;
  const throughput = new Map<string, number>();
  for (const link of data.links) {
    throughput.set(link.source, (throughput.get(link.source) ?? 0) + link.value);
    throughput.set(link.target, (throughput.get(link.target) ?? 0) + link.value);
  }
  const capped = total > limit;
  const keep = capped
    ? new Set(
        [...data.nodes]
          .sort(
            (left, right) =>
              (throughput.get(right.id) ?? 0) - (throughput.get(left.id) ?? 0) ||
              left.id.localeCompare(right.id),
          )
          .slice(0, limit)
          .map((node) => node.id),
      )
    : new Set(data.nodes.map((node) => node.id));

  const nodes: SankeyNode[] = data.nodes
    .filter((node) => keep.has(node.id))
    .map((node) => ({
      id: node.id,
      label: node.label,
      kind: node.kind,
      colorIndex: node.colorIndex,
    }));
  const links: SankeyLink[] = data.links
    .filter((link) => keep.has(link.source) && keep.has(link.target) && link.value > 0)
    .map((link) => ({ source: link.source, target: link.target, value: link.value }));

  if (nodes.length === 0 || links.length === 0) {
    return { nodes, links, failure: null, total, rendered: nodes.length, capped, bounds: null };
  }

  const layout = sankey<SankeyNode, SankeyLink>()
    .nodeId((node) => node.id)
    .nodeAlign(sankeyJustify)
    .nodeWidth(NODE_WIDTH)
    .nodePadding(NODE_PADDING)
    .extent([
      [MARGIN, MARGIN],
      [WIDTH - MARGIN, HEIGHT - MARGIN],
    ]);

  try {
    const graph = layout({ nodes, links });
    return {
      nodes: graph.nodes,
      links: graph.links,
      failure: null,
      total,
      rendered: nodes.length,
      capped,
      // A band is a curve between two nodes' own vertical extents, so the union of the node boxes
      // already contains every link. Measured, not assumed.
      bounds: unionBoxes(graph.nodes.map(nodeBounds)),
    };
  } catch (cause) {
    // ⚠️ Reported as data, never as a half-drawn diagram. `d3-sankey` throws on a circular link
    // set; a Sankey with some bands missing is indistinguishable from a complete one.
    return {
      nodes: [],
      links: [],
      failure: cause instanceof Error ? cause.message : 'the flow could not be laid out',
      total,
      rendered: 0,
      capped,
      bounds: null,
    };
  }
}

export function FlowSankeyTab(): JSX.Element {
  const filter = useAppStore((state) => state.filter);
  const query = useQuery('q:flowSankey', filter);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const model = useMemo(() => buildSankey(query.data ?? { nodes: [], links: [] }), [query.data]);
  const camera = useGraphCamera(model.bounds);

  const selectedNode = model.nodes.find((node) => node.id === selectedId);
  const inspector =
    selectedNode === undefined ? undefined : (
      <NodeInspector
        label={selectedNode.label}
        kind={selectedNode.kind}
        colorIndex={selectedNode.colorIndex}
        rows={[
          {
            label: 'Output tokens through it',
            value: formatInteger(selectedNode.value ?? 0),
          },
        ]}
        note="Band width is output tokens. A tool call carries no tokens of its own, so an assistant message's output is credited to the tool it called first — every message's tokens appear exactly once in each stage."
      />
    );

  const isEmpty = query.data !== null && query.data.links.length === 0;
  const path = sankeyLinkHorizontal<SankeyNode, SankeyLink>();

  return (
    <GraphCanvas
      title={TAB.title}
      data-testid="graphs-sankey"
      nodeCount={model.total}
      renderedNodeCount={model.rendered}
      loading={query.loading && query.data === null}
      error={query.error}
      empty={isEmpty}
      emptyReason={TAB.emptyReason}
      onRetry={query.refetch}
      className="min-h-96"
      controls={
        <ZoomControls
          onZoomIn={() => {
            camera.zoomIn();
          }}
          onZoomOut={() => {
            camera.zoomOut();
          }}
          onFit={camera.fit}
        />
      }
      {...(inspector === undefined
        ? {}
        : {
            inspector,
            onCloseInspector: () => {
              setSelectedId(null);
            },
          })}
    >
      <div className="h-full min-h-80 w-full overflow-hidden p-6" data-testid="sankey-canvas">
        {model.failure !== null ? (
          <p data-testid="sankey-failure" className="text-small text-danger">
            These flows could not be laid out as a Sankey, so none is drawn rather than some:{' '}
            {model.failure}
          </p>
        ) : (
          <GraphSurface
            camera={camera}
            label="Output-token flow"
            data-testid="sankey-surface"
            onBackgroundClick={() => {
              setSelectedId(null);
            }}
          >
            {model.links.map((link, index) => {
              const source = link.source as SankeyNode;
              const target = link.target as SankeyNode;
              const lit = selectedId === source.id || selectedId === target.id;
              return (
                <path
                  key={`${source.id}->${target.id}-${String(index)}`}
                  data-testid="sankey-link"
                  d={path(link) ?? undefined}
                  fill="none"
                  stroke={categoricalVar(source.colorIndex)}
                  // A selected node lights its own bands. Opacity, not hue: the hue is the §3.3
                  // identity and must not change to mean "selected" (FRONTEND §8).
                  strokeOpacity={lit ? 0.7 : 0.35}
                  strokeWidth={Math.max(1, link.width ?? 1)}
                >
                  <title>{`${source.label} → ${target.label}: ${formatInteger(link.value)} output tokens`}</title>
                </path>
              );
            })}

            {model.nodes.map((node) => {
              const isSelected = selectedId === node.id;
              return (
                <SvgNode
                  key={node.id}
                  data-testid="sankey-node"
                  label={`${node.label}, ${formatInteger(node.value ?? 0)} output tokens`}
                  selected={isSelected}
                  onSelect={() => {
                    setSelectedId(node.id);
                  }}
                >
                  <rect
                    x={node.x0 ?? 0}
                    y={node.y0 ?? 0}
                    width={(node.x1 ?? 0) - (node.x0 ?? 0)}
                    height={Math.max(1, (node.y1 ?? 0) - (node.y0 ?? 0))}
                    fill={categoricalVar(node.colorIndex)}
                    stroke={isSelected ? 'var(--accent)' : 'none'}
                    strokeWidth={2}
                    className="transition-opacity duration-hover group-hover:opacity-80"
                  />
                  {/* ⚠️ Every band is named in text. A Sankey read by colour alone is unreadable
                      for a third of readers (FRONTEND §8). */}
                  <text
                    x={(node.x1 ?? 0) + LABEL_GAP}
                    y={((node.y0 ?? 0) + (node.y1 ?? 0)) / 2}
                    dominantBaseline="central"
                    fill="var(--text-primary)"
                    fontSize={LABEL_FONT_SIZE}
                    className="pointer-events-none"
                  >
                    {sankeyNodeLabel(node.label, node.value ?? 0)}
                  </text>
                </SvgNode>
              );
            })}
          </GraphSurface>
        )}
      </div>
    </GraphCanvas>
  );
}
