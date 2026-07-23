/**
 * §6.7's node vocabulary for the two `@xyflow/react` canvases:
 * "orchestrator (filled + glow) / worker skill (outlined) / tool (pill) / file (dashed rect)".
 *
 * ⚠️ **Meaning is never carried by colour alone** (FRONTEND §8). Each node renders its **shape**
 * (fill vs outline vs pill vs dashed) *and* its **kind as text** beneath the label. A reader who
 * sees no colour at all still reads "Read · tool".
 *
 * ⚠️ Every colour is a token reference (§6.1, ADR-011's constraint). The per-node hue is the
 * §3.3 FNV-1a index the payload carries, so a tool keeps the hue it has in every other view.
 *
 * ⚠️ The label is a text node. Harness text is data, never instructions (§3.10, ADR-017).
 */

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { JSX } from 'react';
import { categoricalVar } from '../../lib/colors';
import { cx } from '../../lib/cx';
import type { HarnessShape } from './graph-model';

/** The payload the canvases attach to each `@xyflow/react` node. */
export interface FlowNodeData extends Record<string, unknown> {
  readonly label: string;
  /** §3.10's `kind`, rendered as the word beneath the label. */
  readonly kindLabel: string;
  readonly shape: HarnessShape;
  readonly colorIndex: number;
  /**
   * §6.7 focus-on-click — `true` when a node is selected and this one is neither it nor a direct
   * neighbour, so it fades back to let the reader trace one node's connections. A view treatment
   * only: the node is still drawn, still counted and still reachable by keyboard. `FlowCanvas`
   * writes it; it is `undefined` when nothing is focused.
   */
  readonly dimmed?: boolean;
  /*
   * ⚠️ `detached` was removed on 2026-07-22 with the Execution Trace's node-link diagram, which
   * was its only user. §6.7's Degraded rule is unchanged and is now kept by that tab's timeline:
   * an unlinked run sits in a labelled lane of its own rows, never under a guessed parent. The
   * Harness Map, the one remaining canvas that uses this node, has no such state.
   */
}

export type FlowGraphNode = Node<FlowNodeData, 'lens'>;

const SHAPE_CLASS: Record<HarnessShape, string> = {
  // "filled + glow"
  orchestrator: 'rounded-card border-2 font-semibold',
  // "outlined"
  worker: 'rounded-card border',
  // "pill"
  tool: 'rounded-pill border',
  // "dashed rect"
  file: 'rounded-control border border-dashed',
  container: 'rounded-card border-2 border-dotted',
  other: 'rounded-control border',
};

export function FlowNode({ data, selected }: NodeProps<FlowGraphNode>): JSX.Element {
  const hue = categoricalVar(data.colorIndex);
  const filled = data.shape === 'orchestrator';

  return (
    <div
      data-testid="flow-node"
      data-shape={data.shape}
      // §6.7 focus-on-click — read by the tests and by anyone reading the DOM; the fade itself is
      // the opacity below, which never carries meaning alone (FRONTEND §8): the selected node keeps
      // its accent ring and the neighbours stay full-strength, so the message is legible in mono.
      data-dimmed={data.dimmed === true ? 'true' : 'false'}
      className={cx(
        'flex min-w-24 flex-col items-center gap-1 px-3 py-2 text-center text-small',
        SHAPE_CLASS[data.shape],
        filled ? 'text-text-primary' : 'bg-bg-surface-2 text-text-primary',
        // No transition on the graph node's own opacity would make the fade a hard jump; the fade
        // is a viewport-level response, never an entrance animation, so §6.12 is untouched.
        'transition-opacity duration-hover',
      )}
      style={{
        borderColor: hue,
        // §6.7 — "filled + glow" for the orchestrator, and only for it.
        ...(filled ? { background: hue, boxShadow: 'var(--glow)' } : {}),
        ...(selected ? { outline: 'var(--ring-accent)' } : {}),
        ...(data.dimmed === true ? { opacity: 0.25 } : {}),
      }}
    >
      {/* Handles are the attachment points `@xyflow/react` draws edges to. Not connectable:
          this is a read-only visualisation of data, not an editor (§1.6 — nothing here writes). */}
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="font-medium break-words">{data.label}</span>
      <span className="text-micro text-text-muted">{data.kindLabel}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

/** The `nodeTypes` map every flow canvas passes to `<ReactFlow>`. Defined once, module-level,
 *  because a fresh object each render remounts every node — and a remount would replay the
 *  entrance animation on a live data update, which §6.12 forbids. */
export const FLOW_NODE_TYPES = { lens: FlowNode };
