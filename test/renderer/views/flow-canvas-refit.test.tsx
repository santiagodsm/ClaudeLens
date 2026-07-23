/**
 * §6.7 — the fit-to-content camera re-frames whenever the DRAWN node set changes, so a filtered
 * or kind-toggled Harness Map fills the canvas instead of floating tiny in a frame sized for the
 * old, bigger graph. This is the fix for the reported "zoomed into nothing".
 *
 * ⚠️ `@xyflow/react`'s viewport is not an SVG `viewBox`, so the assertion is on `fitView` being
 * re-invoked when the node-id signature changes — the mechanism FlowCanvas uses. `useReactFlow` is
 * stubbed so the call is observable; the real `<ReactFlow>` still renders the nodes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { FlowCanvas } from '../../../src/renderer/views/graphs/FlowCanvas';
import type { FlowGraphNode } from '../../../src/renderer/views/graphs/FlowNode';

const fitView = vi.fn();

vi.mock('@xyflow/react', async (importActual) => {
  const actual = await importActual<typeof import('@xyflow/react')>();
  return {
    ...actual,
    useReactFlow: () => ({
      fitView,
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      setViewport: vi.fn(),
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    }),
  };
});

afterEach(() => {
  cleanup();
  fitView.mockClear();
});

function node(id: string): FlowGraphNode {
  return {
    id,
    type: 'lens',
    position: { x: 0, y: 0 },
    data: { label: id, kindLabel: 'tool', shape: 'tool', colorIndex: 0 },
  };
}

function renderCanvas(nodes: FlowGraphNode[]) {
  return render(
    <ReactFlowProvider>
      <FlowCanvas
        data-testid="refit-flow"
        label="Harness map"
        nodes={nodes}
        edges={[]}
        selectedId={null}
        onSelect={() => undefined}
      />
    </ReactFlowProvider>,
  );
}

describe('§6.7 — the camera re-fits when the visible set changes', () => {
  it('fits on mount and re-fits when the node set shrinks (a filter or kind toggle)', () => {
    const { rerender } = renderCanvas([node('a'), node('b'), node('c')]);
    // Fitted once for the initial graph.
    expect(fitView).toHaveBeenCalledTimes(1);

    // A filter drops a node: the signature changes, so the camera re-frames the smaller graph.
    rerender(
      <ReactFlowProvider>
        <FlowCanvas
          data-testid="refit-flow"
          label="Harness map"
          nodes={[node('a')]}
          edges={[]}
          selectedId={null}
          onSelect={() => undefined}
        />
      </ReactFlowProvider>,
    );
    expect(fitView).toHaveBeenCalledTimes(2);
  });

  it('does not re-fit when the same nodes re-render (a pan the user made survives)', () => {
    const nodes = [node('a'), node('b')];
    const { rerender } = renderCanvas(nodes);
    expect(fitView).toHaveBeenCalledTimes(1);

    // Same ids, new array identity — a live re-render, not a new graph. No re-frame.
    rerender(
      <ReactFlowProvider>
        <FlowCanvas
          data-testid="refit-flow"
          label="Harness map"
          nodes={[node('a'), node('b')]}
          edges={[]}
          selectedId={null}
          onSelect={() => undefined}
        />
      </ReactFlowProvider>,
    );
    expect(fitView).toHaveBeenCalledTimes(1);
  });
});
