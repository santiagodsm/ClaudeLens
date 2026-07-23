/**
 * §6.7 tab 1 — **Harness Map**. `q:harnessGraph` on `@xyflow/react` (ADR-011).
 *
 * ⚠️⚠️ **The value of this tab is designed-vs-actual.** §4.5 keeps `designed` and `observed` as
 * two fields on purpose; §6.7 spells out the three treatments — edge thickness ∝ `observed`,
 * dashed where `designed && observed === 0`, highlighted where `!designed && observed > 0` — and
 * its Degraded row requires the legend to distinguish designed-only, observed-only and both.
 * All four live here, and the arithmetic behind them is in `graph-model.ts` where it is testable.
 *
 * ⛔ **INV-13 — this tab ignores the global filter entirely.** `q:harnessGraph` is typed without
 * `GlobalFilter` (§4.5), so that is a compile-time property rather than a convention; what this
 * file adds is saying so on screen. §6.9's reason applies word for word: a skill deleted because
 * it looked unused this month is exactly the irreversible mistake the rule prevents.
 *
 * ⚠️ **Parsed harness text is data, never instructions** (§3.10, ADR-017). Skill names, roles and
 * descriptions are rendered as text and counted. Nothing here executes or interpolates them.
 */

import '@xyflow/react/dist/base.css';

import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { Edge } from '@xyflow/react';
import { useMemo, useState, type JSX } from 'react';
import { Badge, Pill } from '../../components/Badge';
import { GraphCanvas } from '../../components/GraphCanvas';
import { RescanButton } from '../../components/RescanButton';
import { useQuery } from '../../hooks/use-query';
import { cx } from '../../lib/cx';
import { formatBytes, formatInteger } from '../../lib/format';
import { EvidenceLegend } from './EvidenceLegend';
import { FlowCanvas, FIT_PADDING } from './FlowCanvas';
import { type FlowGraphNode } from './FlowNode';
import {
  capGraph,
  classifyEdge,
  edgeDashArray,
  EDGE_EVIDENCE_LABEL,
  EDGE_EVIDENCE_NOTE,
  EDGE_EVIDENCE_STROKE,
  edgeWidth,
  harnessShape,
  HARNESS_SHAPE_LABEL,
  maxObserved,
  type EdgeEvidenceClass,
} from './graph-model';
import {
  ALL_SCOPE,
  filterHarnessGraph,
  harnessScopeOptions,
  KIND_GROUP_LABEL,
  presentKindGroups,
  SHARED_SCOPE,
  type HarnessKindGroup,
  type HarnessScopeOption,
} from './harness-scope';
import { layoutLayers } from './layout';
import { NodeInspector, type InspectorRow } from './NodeInspector';
import { GRAPH_TAB_BY_ID } from './tabs';
import { ZoomControls } from './ZoomControls';

const TAB = GRAPH_TAB_BY_ID.harness;

/**
 * §6.7's reading order, left to right: what contains things, what orchestrates, what works,
 * what is called, what is touched. Within a layer the order is the payload's — `q:harnessGraph`
 * returns `ORDER BY kind, name` — so the picture is the same on every re-query.
 */
const LAYER_OF_SHAPE = {
  container: 0,
  orchestrator: 1,
  worker: 2,
  tool: 3,
  file: 4,
  other: 5,
} as const;

export function HarnessMapTab(): JSX.Element {
  return (
    // The provider wraps the whole card so the zoom buttons in `GraphCanvas`'s header can drive
    // the viewport — `useReactFlow()` needs the same provider the canvas is mounted under.
    <ReactFlowProvider>
      <HarnessMapCard />
    </ReactFlowProvider>
  );
}

function HarnessMapCard(): JSX.Element {
  const query = useQuery('q:harnessGraph', { tab: 'harness' });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ⚠️ A Harness-Map-LOCAL project scope (ADR-039), its own state — never the global filter. It
  // changes which nodes are DRAWN, never how their counts are computed, so INV-13 holds: the
  // request stays `{ tab: 'harness' }` with no date range and the "all time" badge stays on. The
  // default is the shared (`~/.claude`) harness rather than the whole ~555-node graph, because a
  // focused first view is the point; "All projects" is one click away in the same selector.
  const [scope, setScope] = useState<string>(SHARED_SCOPE);
  // Kind toggles start all-on (nothing hidden); a kind the user drops leaves this set.
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<HarnessKindGroup>>(
    () => new Set<HarnessKindGroup>(),
  );

  // The selector's options and the chips to show come from the WHOLE payload, so neither changes
  // as the scope narrows. Cheap, and stable across the focus-on-click re-renders.
  const scopeOptions = useMemo(() => harnessScopeOptions(query.data?.nodes ?? []), [query.data]);
  const kindGroups = useMemo(() => presentKindGroups(query.data?.nodes ?? []), [query.data]);

  // If the payload has no nodes for the default (shared) scope but does have projects, the shared
  // option is absent — fall back to "all" so the first view is never an empty canvas over a full
  // graph. A pure derivation of the options; no effect, no extra render.
  const effectiveScope =
    scope === ALL_SCOPE || scopeOptions.some((option) => option.value === scope)
      ? scope
      : ALL_SCOPE;

  const model = useMemo(() => {
    const graph = query.data ?? { nodes: [], edges: [] };
    // The project scope and the kind toggles decide what is DRAWN (INV-13: counts are untouched).
    const scoped = filterHarnessGraph(graph.nodes, graph.edges, effectiveScope, hiddenKinds);
    // §8.5 P-23 / §11.7 — the Harness Map's ranking is the one §11.7 says IS specified:
    // "by `observed`". Ties break on id inside `capGraph`, so the top 500 is stable.
    const capped = capGraph(scoped.nodes, scoped.edges, (node) => node.metrics['observed'] ?? 0);
    const busiest = maxObserved(capped.edges);

    const byShape = new Map<number, string[]>();
    const shapeOf = new Map<string, ReturnType<typeof harnessShape>>();
    for (const node of capped.nodes) {
      const shape = harnessShape(node);
      shapeOf.set(node.id, shape);
      const layer = LAYER_OF_SHAPE[shape];
      byShape.set(layer, [...(byShape.get(layer) ?? []), node.id]);
    }
    const layers = Object.values(LAYER_OF_SHAPE).map((layer) => byShape.get(layer) ?? []);
    const placed = new Map(layoutLayers(layers).map((node) => [node.id, node]));

    const nodes: FlowGraphNode[] = capped.nodes.map((node) => {
      const at = placed.get(node.id);
      return {
        id: node.id,
        type: 'lens',
        position: { x: at?.x ?? 0, y: at?.y ?? 0 },
        data: {
          label: node.label,
          kindLabel: node.kind,
          shape: shapeOf.get(node.id) ?? 'other',
          colorIndex: node.colorIndex,
        },
      };
    });

    const evidenceOf = new Map<string, EdgeEvidenceClass>();
    const edges: Edge[] = capped.edges.map((edge) => {
      const evidence = classifyEdge(edge);
      evidenceOf.set(edge.id, evidence);
      const dash = edgeDashArray(evidence);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        // ⚠️ Three visual channels, one per §6.7 clause: width ∝ observed, dash for
        // designed-but-never-observed, hue for the evidence class. None of them is the only
        // carrier of its meaning — the legend and the inspector both state it in words.
        style: {
          stroke: EDGE_EVIDENCE_STROKE[evidence],
          strokeWidth: edgeWidth(edge.observed, busiest),
          ...(dash === null ? {} : { strokeDasharray: dash }),
        },
        data: { evidence },
      };
    });

    return {
      capped,
      nodes,
      edges,
      evidenceOf,
      present: new Set(evidenceOf.values()),
      shapes: new Set(shapeOf.values()),
      crossScopeHiddenEdges: scoped.crossScopeHiddenEdges,
    };
  }, [query.data, effectiveScope, hiddenKinds]);

  const selectedNode = query.data?.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedEdge = query.data?.edges.find((edge) => edge.id === selectedId) ?? null;

  const inspector =
    selectedNode !== null ? (
      <NodeInspector
        label={selectedNode.label}
        kind={selectedNode.kind}
        role={selectedNode.role}
        colorIndex={selectedNode.colorIndex}
        rows={nodeRows(selectedNode.metrics, selectedNode.meta)}
        note={`${HARNESS_SHAPE_LABEL[harnessShape(selectedNode)]}. Every count on this tab is all time — the global filter does not reach this view.`}
      />
    ) : selectedEdge !== null ? (
      <NodeInspector
        label={`${labelOf(query.data?.nodes, selectedEdge.source)} → ${labelOf(query.data?.nodes, selectedEdge.target)}`}
        kind={selectedEdge.kind}
        rows={[
          { label: 'Declared', value: selectedEdge.designed ? 'yes' : 'no' },
          { label: 'Observed', value: `${formatInteger(selectedEdge.observed)} calls` },
          {
            label: 'Evidence',
            value: selectedEdge.evidence ?? 'transcript only',
          },
          { label: 'Reads as', value: EDGE_EVIDENCE_LABEL[classifyEdge(selectedEdge)] },
        ]}
        note={EDGE_EVIDENCE_NOTE[classifyEdge(selectedEdge)]}
      />
    ) : undefined;

  const isEmpty = query.data !== null && query.data.nodes.length === 0;

  return (
    <GraphCanvas
      title={TAB.title}
      data-testid="graphs-harness"
      nodeCount={model.capped.total}
      renderedNodeCount={model.capped.rendered}
      loading={query.loading && query.data === null}
      error={query.error}
      empty={isEmpty}
      emptyReason={TAB.emptyReason}
      onRetry={query.refetch}
      className="min-h-96"
      controls={<FlowZoomControls />}
      filters={
        <HarnessMapFilters
          scope={effectiveScope}
          options={scopeOptions}
          onScope={(next) => {
            setScope(next);
            // A new scope is a new picture — the node the rail is inspecting may no longer be
            // drawn, so clear the selection (and with it the focus dimming).
            setSelectedId(null);
          }}
          kindGroups={kindGroups}
          hiddenKinds={hiddenKinds}
          onToggleKind={(group) => {
            setHiddenKinds((current) => {
              const next = new Set(current);
              if (next.has(group)) next.delete(group);
              else next.add(group);
              return next;
            });
          }}
          crossScopeHiddenEdges={model.crossScopeHiddenEdges}
        />
      }
      legend={
        <div className="flex flex-wrap items-center gap-3">
          {/* ⛔ INV-13, said on the surface rather than only in a comment. */}
          <Badge tone="info" data-testid="harness-all-time">
            all time
          </Badge>
          {/* §6.7 / §6.9 — the same user-initiated rescan the Harness Manager offers. */}
          <RescanButton />
          <EvidenceLegend present={model.present} data-testid="harness-evidence-legend" />
          <ul
            data-testid="harness-shape-legend"
            aria-label="Node kinds"
            className="flex flex-wrap items-center gap-2 text-micro text-text-muted"
          >
            {[...model.shapes].map((shape) => (
              <li key={shape} data-shape={shape}>
                {HARNESS_SHAPE_LABEL[shape]}
              </li>
            ))}
          </ul>
        </div>
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
      <FlowCanvas
        data-testid="harness-flow"
        label="Harness map"
        nodes={model.nodes}
        edges={model.edges}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
    </GraphCanvas>
  );
}

/**
 * §6.7's control area for the Harness Map: the project scope selector, the node-kind chips, and
 * the honest note about connections a scope hides. Every one of them changes only what is *drawn*
 * — none of them touches a count or carries a date, so INV-13 holds and the "all time" badge in
 * the legend stays true (its assertion is in the tests, not just here).
 *
 * ⚠️ Plain language throughout (CLAUDE.md §1a): "Project", "Shared (~/.claude)", "Agents",
 * "CLAUDE.md files" — never a `kind` literal, a channel name or a section number.
 */
function HarnessMapFilters({
  scope,
  options,
  onScope,
  kindGroups,
  hiddenKinds,
  onToggleKind,
  crossScopeHiddenEdges,
}: {
  scope: string;
  options: readonly HarnessScopeOption[];
  onScope: (next: string) => void;
  kindGroups: readonly HarnessKindGroup[];
  hiddenKinds: ReadonlySet<HarnessKindGroup>;
  onToggleKind: (group: HarnessKindGroup) => void;
  crossScopeHiddenEdges: number;
}): JSX.Element {
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-small text-text-muted">
          Project
          <select
            data-testid="harness-project-scope"
            aria-label="Which project’s harness to show"
            value={scope}
            onChange={(event) => {
              onScope(event.target.value);
            }}
            className="rounded-control border border-border bg-bg-surface px-3 py-1 text-small text-text-primary"
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.variant === 'all'
                  ? option.label
                  : `${option.label} (${formatInteger(option.nodeCount)})`}
              </option>
            ))}
          </select>
        </label>

        {/* Node-kind chips — press one to drop that kind from the picture. Files and tools are
            usually the bulk of the nodes, so dropping them to "just agents and skills" is the
            biggest single readability win after the project scope. */}
        {kindGroups.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Which kinds of node to show"
            data-testid="harness-kind-toggles"
          >
            {kindGroups.map((group) => {
              const shown = !hiddenKinds.has(group);
              return (
                <Pill
                  key={group}
                  data-testid={`harness-kind-${group}`}
                  pressed={shown}
                  onClick={() => {
                    onToggleKind(group);
                  }}
                >
                  {/* The word carries the meaning; "pressed" is the on/off, not colour alone. */}
                  <span className={cx(!shown && 'line-through')}>{KIND_GROUP_LABEL[group]}</span>
                </Pill>
              );
            })}
          </div>
        )}
      </div>

      {/* ⚠️ Cross-project connections are hidden by a scope, never dropped in silence: a filtered
          map that showed a project as an island when it is not would be its own small lie. */}
      {crossScopeHiddenEdges > 0 && (
        <p className="text-micro text-text-muted" data-testid="harness-cross-scope">
          {crossScopeHiddenEdges === 1
            ? '1 connection to another project is hidden by this filter.'
            : `${formatInteger(crossScopeHiddenEdges)} connections to other projects are hidden by this filter.`}
        </p>
      )}
    </div>
  );
}

/**
 * The zoom +/− and the **fit** of §6.7's shell, driving `@xyflow/react`'s own viewport.
 *
 * ⚠️ "Fit" re-frames the whole graph with the same margin the canvas opens with, which is §6.7's
 * required one-click way back for a reader who has zoomed into empty space.
 */
export function FlowZoomControls(): JSX.Element {
  const flow = useReactFlow();
  return (
    <ZoomControls
      onZoomIn={() => {
        void flow.zoomIn();
      }}
      onZoomOut={() => {
        void flow.zoomOut();
      }}
      onFit={() => {
        void flow.fitView({ padding: FIT_PADDING });
      }}
    />
  );
}

/** §4.5's `meta` keys, as §6.7's inspector words them. An unknown key renders under its own name. */
const META_LABEL: Record<string, string> = {
  description: 'Description',
  relPath: 'Path',
  source: 'Source',
};

/**
 * `GraphNode.metrics` is `Record<string, number>` and `GraphNode.meta` is
 * `Record<string, string>` (§4.5, AMENDED 2026-07-22 (E12)); render every entry either carries.
 *
 * ⚠️ Numbers first, then text — §6.7's rail reads "label · kind · key/value rows", and the
 * measured facts are what the tab exists for. ⚠️ Every `meta` value came out of a `SKILL.md`, an
 * agent definition or a transcript and is placed in a text node, never interpolated into
 * anything executable (§3.10, ADR-017).
 */
function nodeRows(
  metrics: Record<string, number>,
  meta: Record<string, string> | undefined,
): InspectorRow[] {
  return [
    ...Object.entries(metrics).map(([key, value]) => ({
      label: key === 'observed' ? 'Observed calls' : key === 'sizeBytes' ? 'Size' : key,
      value: key === 'sizeBytes' ? formatBytes(value) : formatInteger(value),
    })),
    ...Object.entries(meta ?? {}).map(([key, value]) => ({
      label: META_LABEL[key] ?? key,
      value,
    })),
  ];
}

function labelOf(nodes: { id: string; label: string }[] | undefined, id: string): string {
  return nodes?.find((node) => node.id === id)?.label ?? id;
}

export { TAB as HARNESS_TAB };
