/**
 * §6.7 tab 3 — **Tool Transition**. `q:toolTransition`, laid out by `cytoscape` (ADR-011) and
 * drawn as SVG by us; see `tool-transition-layout.ts` for why the render half is ours.
 *
 * ⚠️ **A Markov graph over consecutive tool calls within a session** (§6.7). `q:toolTransition`
 * emits every transition as `designed: false, observed: N` — "a transition is runtime evidence,
 * never a declaration" — so the whole graph sits in one evidence class, and the legend says so
 * rather than showing three swatches of which two can never occur here.
 *
 * ⚠️ **The empty copy is §6.7's, verbatim**: "fewer than two consecutive tool calls in range".
 * That is a different claim from "no tool calls" and the reader can act on it.
 *
 * ⚠️⚠️ **AMENDED 2026-07-22 — the camera.** This tab used to emit a constant
 * `viewBox="0 0 900 600"` and implement zoom as a CSS `transform: scale()` on the `<svg>`. The
 * `circle` layout does not respect that box (see `tool-transition-layout.ts`), so most of a real
 * graph was clipped and scaling only resized the clipped remains — the reported "it is an image,
 * extremely zoomed in, and there is nothing beyond the lines". The frame is now
 * `layout.bounds`, measured from the placement, driven through `useGraphCamera`.
 *
 * ⚠️ **Still rendered by us, not by `cytoscape`'s renderer**, and ADR-011's own constraint is
 * why: its renderer is a `<canvas>`, which cannot read a CSS custom property (§6.1's token layer)
 * and offers no element for P-30's keyboard selection or for a test to assert a tool name on. The
 * camera is a `viewBox`, which costs less than solving both of those would have.
 */

import { useMemo, useState, type JSX } from 'react';
import { GraphCanvas } from '../../components/GraphCanvas';
import { useQuery } from '../../hooks/use-query';
import { categoricalVar } from '../../lib/colors';
import { formatInteger } from '../../lib/format';
import { useAppStore } from '../../store/app-store';
import { EvidenceLegend } from './EvidenceLegend';
import {
  capGraph,
  classifyEdge,
  edgeWidth,
  maxObserved,
  EDGE_EVIDENCE_STROKE,
} from './graph-model';
import { GraphSurface, SvgNode } from './GraphSurface';
import { NodeInspector } from './NodeInspector';
import { GRAPH_TAB_BY_ID } from './tabs';
import { layoutToolTransition, NODE_HEIGHT } from './tool-transition-layout';
import { useGraphCamera } from './use-graph-camera';
import { ZoomControls } from './ZoomControls';

const TAB = GRAPH_TAB_BY_ID.transition;

/** Selected pills and edges thicken; the change is never carried by colour alone (FRONTEND §8). */
const SELECTED_STROKE_WIDTH = 3;
const NODE_STROKE_WIDTH = 1.5;

export function ToolTransitionTab(): JSX.Element {
  const filter = useAppStore((state) => state.filter);
  const query = useQuery('q:toolTransition', filter);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const model = useMemo(() => {
    const graph = query.data ?? { nodes: [], edges: [] };
    // §11.7 leaves this graph's ranking open. Stated here: **by total transitions touching the
    // node**, which is the only measured quantity this graph has, so a cap keeps the busiest part
    // of the fingerprint. Ties break on id inside `capGraph`.
    const weightOf = new Map<string, number>();
    for (const edge of graph.edges) {
      weightOf.set(edge.source, (weightOf.get(edge.source) ?? 0) + edge.observed);
      weightOf.set(edge.target, (weightOf.get(edge.target) ?? 0) + edge.observed);
    }
    const capped = capGraph(graph.nodes, graph.edges, (node) => weightOf.get(node.id) ?? 0);
    const layout = layoutToolTransition(capped.nodes, capped.edges);
    return {
      capped,
      layout,
      busiest: maxObserved(capped.edges),
      present: new Set(capped.edges.map((edge) => classifyEdge(edge))),
    };
  }, [query.data]);

  // The camera fits to the layout's own bounding box, and re-fits whenever the layout changes —
  // which is what makes a filter change reframe rather than crop (§6.7).
  const camera = useGraphCamera(model.layout.bounds);

  const selectedNode = model.layout.byId.get(selectedId ?? '');
  const selectedEdge = model.capped.edges.find((edge) => edge.id === selectedId);

  const inspector =
    selectedNode !== undefined ? (
      <NodeInspector
        label={selectedNode.label}
        kind="tool"
        colorIndex={selectedNode.colorIndex}
        rows={[{ label: 'Transitions touching it', value: formatInteger(selectedNode.weight) }]}
        note="A Markov graph over consecutive tool calls within a session. Every edge here is runtime evidence; nothing declares a transition."
      />
    ) : selectedEdge !== undefined ? (
      <NodeInspector
        label={`${model.layout.byId.get(selectedEdge.source)?.label ?? selectedEdge.source} → ${model.layout.byId.get(selectedEdge.target)?.label ?? selectedEdge.target}`}
        kind="transition"
        rows={[
          { label: 'Observed', value: `${formatInteger(selectedEdge.observed)} times` },
          { label: 'Declared', value: 'no — a transition is never declared' },
        ]}
        note="One tool call immediately followed by another, within a single session."
      />
    ) : undefined;

  const isEmpty = query.data !== null && query.data.edges.length === 0;

  return (
    <GraphCanvas
      title={TAB.title}
      data-testid="graphs-transition"
      nodeCount={model.capped.total}
      renderedNodeCount={model.capped.rendered}
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
      legend={<EvidenceLegend present={model.present} data-testid="transition-evidence-legend" />}
      {...(inspector === undefined
        ? {}
        : {
            inspector,
            onCloseInspector: () => {
              setSelectedId(null);
            },
          })}
    >
      {/* `overflow-hidden`, never `overflow-auto`: the camera is the viewport, and a scrollbar
          here would be a second, competing one. */}
      <div className="h-full min-h-80 w-full overflow-hidden p-6" data-testid="transition-canvas">
        <GraphSurface
          camera={camera}
          label="Tool transition graph"
          data-testid="transition-surface"
          onBackgroundClick={() => {
            setSelectedId(null);
          }}
        >
          <defs>
            <marker
              id="transition-arrow"
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={6}
              markerHeight={6}
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE_EVIDENCE_STROKE['observed-only']} />
            </marker>
          </defs>

          {model.capped.edges.map((edge) => {
            const from = model.layout.byId.get(edge.source);
            const to = model.layout.byId.get(edge.target);
            if (from === undefined || to === undefined) return null;
            const selected = selectedId === edge.id;
            return (
              <line
                key={edge.id}
                data-testid="transition-edge"
                data-observed={String(edge.observed)}
                data-selected={selected ? 'true' : undefined}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={selected ? 'var(--accent)' : EDGE_EVIDENCE_STROKE[classifyEdge(edge)]}
                strokeWidth={edgeWidth(edge.observed, model.busiest)}
                markerEnd="url(#transition-arrow)"
                className="cursor-pointer"
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedId(edge.id);
                }}
              >
                <title>{`${from.label} → ${to.label}: ${formatInteger(edge.observed)}`}</title>
              </line>
            );
          })}

          {model.layout.nodes.map((node) => {
            const selected = selectedId === node.id;
            return (
              <SvgNode
                key={node.id}
                data-testid="transition-node"
                label={`${node.label}, ${formatInteger(node.weight)} transitions`}
                selected={selected}
                onSelect={() => {
                  setSelectedId(node.id);
                }}
              >
                <rect
                  x={node.x - node.width / 2}
                  y={node.y - NODE_HEIGHT / 2}
                  width={node.width}
                  height={NODE_HEIGHT}
                  rx={NODE_HEIGHT / 2}
                  fill="var(--bg-surface-2)"
                  stroke={selected ? 'var(--accent)' : categoricalVar(node.colorIndex)}
                  strokeWidth={selected ? SELECTED_STROKE_WIDTH : NODE_STROKE_WIDTH}
                  className="transition-opacity duration-hover group-hover:opacity-80"
                />
                {/* The tool NAME is the message; the hue is a cue (FRONTEND §8). */}
                <text
                  x={node.x}
                  y={node.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="var(--text-primary)"
                  fontSize={12}
                  className="pointer-events-none"
                >
                  {node.label}
                </text>
              </SvgNode>
            );
          })}
        </GraphSurface>
      </div>
    </GraphCanvas>
  );
}
