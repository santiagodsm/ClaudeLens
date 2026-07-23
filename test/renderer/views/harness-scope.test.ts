/**
 * §6.7 Harness Map — the display filter's scope/kind maths, tested as pure functions (ADR-039).
 *
 * ⚠️ The property that matters most is the one INV-13 turns on: this filter changes which nodes
 * are DRAWN and never a `metrics` value. The renderer suite asserts it end-to-end on the inspector;
 * here it is asserted structurally — a filtered node is the *same object* the payload carried.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_SCOPE,
  SHARED_SCOPE,
  filterHarnessGraph,
  harnessScopeOptions,
  kindGroupOf,
  presentKindGroups,
  projectOf,
} from '../../../src/renderer/views/graphs/harness-scope';
import { harnessGraphMultiProject } from './graph-payloads';

const NO_KINDS_HIDDEN = new Set<never>();

describe('§6.7 — the Harness Map scope options', () => {
  it('lists all projects, the shared harness, and one entry per project by folder name', () => {
    const { nodes } = harnessGraphMultiProject();
    const options = harnessScopeOptions(nodes);

    expect(options.map((option) => option.value)).toEqual([
      ALL_SCOPE,
      SHARED_SCOPE,
      // ⚠️ Projects by full folder name (§3.3 display_name), in folder-name order.
      'budget-tool',
      'family-app',
    ]);
    // The counts are each scope's own node count — a display aid, never a metric.
    expect(options.find((option) => option.value === ALL_SCOPE)?.nodeCount).toBe(5);
    expect(options.find((option) => option.value === SHARED_SCOPE)?.nodeCount).toBe(2);
    expect(options.find((option) => option.value === 'family-app')?.nodeCount).toBe(2);
    expect(options.find((option) => option.value === 'budget-tool')?.nodeCount).toBe(1);
  });

  it('omits the shared option when nothing is shared', () => {
    const { nodes } = harnessGraphMultiProject();
    const projectOnly = nodes.filter((node) => projectOf(node) !== null);
    const options = harnessScopeOptions(projectOnly);
    expect(options.some((option) => option.value === SHARED_SCOPE)).toBe(false);
    expect(options[0]?.value).toBe(ALL_SCOPE);
  });
});

describe('§6.7 — scoping the visible node set by project', () => {
  it('a project scope shows that project’s nodes plus the shared tools they reach', () => {
    const { nodes, edges } = harnessGraphMultiProject();
    const result = filterHarnessGraph(nodes, edges, 'family-app', NO_KINDS_HIDDEN);

    // family-orchestrator + family-skill, and the shared Read they grant — never budget-tool's
    // skill and never the unrelated shared skill.
    expect(new Set(result.nodes.map((node) => node.label))).toEqual(
      new Set(['family-orchestrator', 'family-skill', 'Read']),
    );
    // The two in-scope edges survive; the cross-project ones do not.
    expect(new Set(result.edges.map((edge) => edge.id))).toEqual(
      new Set(['e-fa-hand', 'e-fa-read']),
    );
  });

  it('discloses the cross-project connections a scope hides rather than dropping them', () => {
    const { nodes, edges } = harnessGraphMultiProject();
    // family-app → budget-tool (the handoff) and budget-tool → shared Read both leave the scope.
    expect(
      filterHarnessGraph(nodes, edges, 'family-app', NO_KINDS_HIDDEN).crossScopeHiddenEdges,
    ).toBe(2);
    // "All projects" hides nothing, so there is nothing to disclose.
    expect(filterHarnessGraph(nodes, edges, ALL_SCOPE, NO_KINDS_HIDDEN).crossScopeHiddenEdges).toBe(
      0,
    );
  });

  it('the shared scope shows only the shared harness', () => {
    const { nodes, edges } = harnessGraphMultiProject();
    const result = filterHarnessGraph(nodes, edges, SHARED_SCOPE, NO_KINDS_HIDDEN);
    expect(new Set(result.nodes.map((node) => node.label))).toEqual(
      new Set(['Read', 'global-helper']),
    );
  });

  it('⚠️ INV-13 — filtering never changes a node’s count: it returns the same object', () => {
    const { nodes, edges } = harnessGraphMultiProject();
    const source = nodes.find((node) => node.label === 'family-skill');

    const inAll = filterHarnessGraph(nodes, edges, ALL_SCOPE, NO_KINDS_HIDDEN).nodes.find(
      (node) => node.label === 'family-skill',
    );
    const inProject = filterHarnessGraph(nodes, edges, 'family-app', NO_KINDS_HIDDEN).nodes.find(
      (node) => node.label === 'family-skill',
    );

    // Same reference, so the same `metrics.observed` — 7, all time, whichever scope drew it.
    expect(inAll).toBe(source);
    expect(inProject).toBe(source);
    expect(inAll?.metrics['observed']).toBe(7);
    expect(inProject?.metrics['observed']).toBe(7);
  });
});

describe('§6.7 — the node-kind toggles', () => {
  it('maps every §3.10 kind into a chip, agents covering commands and plugins the marketplace', () => {
    expect(kindGroupOf('agent')).toBe('agents');
    expect(kindGroupOf('command')).toBe('agents');
    expect(kindGroupOf('marketplace')).toBe('plugins');
    expect(kindGroupOf('claude_md')).toBe('claudeMd');
    // An unmodelled kind still gets a chip rather than vanishing untoggleable.
    expect(kindGroupOf('something-new')).toBe('other');
  });

  it('hides exactly the nodes of a hidden kind, keeping edges only between survivors', () => {
    const { nodes, edges } = harnessGraphMultiProject();
    // Everything visible, then drop tools from the shared scope: Read goes, global-helper stays.
    const withTools = filterHarnessGraph(nodes, edges, SHARED_SCOPE, NO_KINDS_HIDDEN);
    const withoutTools = filterHarnessGraph(nodes, edges, SHARED_SCOPE, new Set(['tools']));

    expect(withTools.nodes.map((node) => node.label)).toContain('Read');
    expect(withoutTools.nodes.map((node) => node.label)).not.toContain('Read');
    expect(withoutTools.nodes.map((node) => node.label)).toContain('global-helper');
  });

  it('offers a chip only for a kind that is present', () => {
    const { nodes } = harnessGraphMultiProject();
    // The fixture is all skills and one tool — no agents, files, memories or plugins.
    expect(presentKindGroups(nodes)).toEqual(['skills', 'tools']);
  });
});
