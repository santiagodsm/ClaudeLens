// §5.9 M-14 / §4.5 `q:harnessGraph` — the runtime overlay, with hand-computed expected values.
//
// ⚠️ **The case this file exists for is `designed: false, observed > 0`.** §4.5 calls it "a legal
// and interesting state — a call that happens but is not declared", §6.7 requires the Harness Map
// to render it and its legend to distinguish designed-only, observed-only and both. It is also the
// one an implementation loses silently: reading `harness_edges` alone can only ever produce
// `designed: true`, and the result still looks like a graph.
//
// ⚠️ **`observed` is never stored** (ADR-027). Every number below is computed by the query on the
// request, over the FULL dataset (INV-13 — `harnessGraph()` takes no argument at all, so there is
// nothing to scope it by).
//
// ⚠️ `harness_nodes` / `harness_edges` are seeded directly here rather than scanned. What is under
// test is the overlay ARITHMETIC over a known graph; driving E10's filesystem scanner as well
// would make a failure ambiguous between the scan and the join. The transcripts, by contrast, go
// through the real parser (STACK ADR-013) — `tool_calls.skill_name`, `events.subagent_run_id` and
// `subagent_runs.subagent_type` are exactly the columns the overlay reads, and hand-writing them
// would prove the arithmetic and nothing about whether it is fed the right rows.

import { describe, expect, it } from 'vitest';
import type { GraphEdge } from '../../src/shared/ipc-contract';
import { useSandbox } from '../support/sandbox';
import { loadFixture, type MetricsFixture } from './support/metrics-harness';
import { usePinnedTimezone } from './support/pinned-tz';

/**
 * The configuration the fixture's transcripts run against:
 *
 *   skill `demo-skill`  --tool_grant(frontmatter)-->  tool `Read`
 *   agent `worker`      declares nothing at all
 *   tool  `Bash`        granted by nobody
 *
 * So `Read` is designed **and** observed, and everything `worker` does is observed **and not
 * designed** — which is the state under test.
 */
function seedHarness(fixture: MetricsFixture): { demoSkill: number; worker: number } {
  const node = fixture.db.prepare(
    `INSERT INTO harness_nodes (kind, name, source, rel_path, size_bytes)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const demoSkill = Number(
    node.run('skill', 'demo-skill', 'user', 'skills/demo-skill', 1_024).lastInsertRowid,
  );
  const worker = Number(
    node.run('agent', 'worker', 'user', 'agents/worker.md', 512).lastInsertRowid,
  );
  const read = Number(node.run('tool', 'Read', 'builtin', null, 0).lastInsertRowid);
  node.run('tool', 'Bash', 'builtin', null, 0);
  node.run('tool', 'Agent', 'builtin', null, 0);
  node.run('tool', 'Skill', 'builtin', null, 0);

  fixture.db
    .prepare('INSERT INTO harness_edges (from_id, to_id, kind, evidence) VALUES (?, ?, ?, ?)')
    .run(demoSkill, read, 'tool_grant', 'frontmatter');

  return { demoSkill, worker };
}

/** Every edge between two nodes, named by label rather than by row id. */
function edgesByLabel(graph: {
  nodes: { id: string; label: string }[];
  edges: GraphEdge[];
}): Map<string, GraphEdge> {
  const label = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return new Map(
    graph.edges.map((edge) => [
      `${label.get(edge.source) ?? edge.source}->${label.get(edge.target) ?? edge.target}`,
      edge,
    ]),
  );
}

describe('M-14 — the runtime overlay on q:harnessGraph', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('counts node observations over the full dataset', async () => {
    const fixture = await loadFixture(sandbox, 'm14-harness-overlay');
    seedHarness(fixture);
    const graph = fixture.analytics.harnessGraph();
    const observed = new Map(
      graph.nodes.map((node) => [`${node.kind}:${node.label}`, node.metrics['observed']]),
    );

    // `Skill` calls naming `demo-skill`: one in the main loop (m14-m1) and one inside the linked
    // subagent run (m14-s4).                                                       1 + 1 = 2
    expect(observed.get('skill:demo-skill')).toBe(2);
    // `Read` calls: one in the main loop (m14-m2) and two in the linked run (m14-s1, m14-s2).
    //                                                                              1 + 2 = 3
    expect(observed.get('tool:Read')).toBe(3);
    // `Bash` calls: one in the LINKED run (m14-s3) and one in the UNLINKED run (m14-u1). Both are
    // real calls and both are counted — an unlinked run's events are attributed to the parent
    // session by the path (§3.7, ADR-020); only its *edges* are unknowable.   1 + 1 = 2
    expect(observed.get('tool:Bash')).toBe(2);
    // The `Agent` call that spawned the linked run. `Agent` and `Skill` ARE tools (§2.1, M-12).
    expect(observed.get('tool:Agent')).toBe(1);
    expect(observed.get('tool:Skill')).toBe(2);

    // ⚠️ AMENDED 2026-07-22 (ADR-039). An agent node's overlay used to be a stated `0`, on the
    // grounds that §3.10 names no runtime join for it. §2.1 does: an **agent definition** is "a
    // `.claude/agents/*.md` file, **or a `subagent_type` value observed in an `Agent` tool call**".
    // The number is SPAWNS of that agent — the one `Agent` call at m14-m3.               = 1
    expect(observed.get('agent:worker')).toBe(1);
    // ⚠️ The discriminator survives the amendment, and it is the important half: `worker`'s own
    // linked run made FOUR tool calls, and if this ever read 4 the node overlay would have
    // silently become an edge overlay. Those four are `worker`'s outgoing EDGES, asserted below.
    expect(observed.get('agent:worker')).not.toBe(4);
  });

  it('reports designed and observed as two fields, never one', async () => {
    const fixture = await loadFixture(sandbox, 'm14-harness-overlay');
    seedHarness(fixture);
    const edges = edgesByLabel(fixture.analytics.harnessGraph());

    // DESIGNED AND OBSERVED — `demo-skill` grants `Read` in its frontmatter, and `Read` ran.
    // `observed` for a declared edge is M-14 for its TARGET: three `Read` calls.
    const granted = edges.get('demo-skill->Read');
    expect(granted?.designed).toBe(true);
    expect(granted?.observed).toBe(3);
    expect(granted?.evidence).toBe('frontmatter');
  });

  it('⚠️ emits the undeclared edges — designed: false, observed > 0', async () => {
    const fixture = await loadFixture(sandbox, 'm14-harness-overlay');
    seedHarness(fixture);
    const edges = edgesByLabel(fixture.analytics.harnessGraph());

    // The linked run ran as `worker`, and `worker` declares nothing. Two `Read` calls…
    const workerRead = edges.get('worker->Read');
    expect(workerRead?.designed).toBe(false);
    expect(workerRead?.observed).toBe(2);

    // …one `Bash` call — the tool nobody granted, called anyway. This single edge is the whole
    // point of keeping `designed` and `observed` apart (§4.5, §6.7).
    const workerBash = edges.get('worker->Bash');
    expect(workerBash?.designed).toBe(false);
    expect(workerBash?.observed).toBe(1);

    // …and one `Skill` call, which is an edge to the invoked SKILL, not to the `Skill` tool.
    const workerSkill = edges.get('worker->demo-skill');
    expect(workerSkill?.designed).toBe(false);
    expect(workerSkill?.observed).toBe(1);
    expect(workerSkill?.kind).toBe('handoff');
    // No `evidence`: §3.10's three values all describe a file, and this edge has no file behind it.
    expect(workerSkill?.evidence).toBeUndefined();

    // ⚠️ The discriminator for the unlinked run. `Bash` ran TWICE in the dataset and the node
    // overlay says 2 — but only ONE of those calls happened inside a run whose agent is known.
    // A `worker->Bash` edge of 2 would mean the unlinked run had been attributed to `worker` by
    // guesswork, which ADR-020 forbids outright.
    expect(workerBash?.observed).not.toBe(2);
  });

  it('never invents an edge for an unlinked run, in any direction', async () => {
    const fixture = await loadFixture(sandbox, 'm14-harness-overlay');
    seedHarness(fixture);
    const graph = fixture.analytics.harnessGraph();

    // Four edges, exactly: the one declared `tool_grant`, and the three the linked run observed.
    // Nothing for the unlinked run's `Bash` call, and nothing for the main loop's `Read` or
    // `Skill` calls either — §3.6 records no skill for a main-loop tool call, so an edge would be
    // an invented number (CLAUDE.md §1).
    expect(graph.edges).toHaveLength(4);
    expect(graph.edges.filter((edge) => edge.designed)).toHaveLength(1);
    expect(graph.edges.filter((edge) => !edge.designed)).toHaveLength(3);
  });

  it('does not double an edge that is both declared and observed', async () => {
    const fixture = await loadFixture(sandbox, 'm14-harness-overlay');
    const { worker } = seedHarness(fixture);
    const readId = fixture.db
      .prepare<{ id: number }>("SELECT id FROM harness_nodes WHERE kind = 'tool' AND name = 'Read'")
      .get()?.id;
    expect(readId).toBeDefined();
    // Declare the edge the runtime also shows, so the two halves overlap.
    fixture.db
      .prepare('INSERT INTO harness_edges (from_id, to_id, kind, evidence) VALUES (?, ?, ?, ?)')
      .run(worker, readId as number, 'tool_grant', 'frontmatter');

    const graph = fixture.analytics.harnessGraph();
    const workerRead = graph.edges.filter(
      (edge) => edge.source === `n${String(worker)}` && edge.target === `n${String(readId)}`,
    );
    // One edge, and it is the DECLARED one: `designed` is a claim about the configuration, and
    // the configuration declares it. Two edges here would draw the same relation twice and make
    // the legend's three categories overlap.
    expect(workerRead).toHaveLength(1);
    expect(workerRead[0]?.designed).toBe(true);
    // Its `observed` is the declared edge's reading — M-14 for the target, all three `Read` calls.
    expect(workerRead[0]?.observed).toBe(3);
  });

  it('⛔ INV-13 — the overlay has no filter to ignore', async () => {
    const fixture = await loadFixture(sandbox, 'm14-harness-overlay');
    seedHarness(fixture);
    // `harnessGraph()` takes no argument: "all time" is a compile-time property of the signature
    // (§4.5 types `q:harnessGraph` without `GlobalFilter`), not a convention this test enforces.
    // What it CAN check is that the numbers really do span the whole dataset — the main loop's
    // 2024-05-01T09:00 call and the subagent run's 09:06 one are both in `demo-skill`'s 2.
    expect(fixture.analytics.harnessGraph().nodes.length).toBeGreaterThan(0);
    const observed = new Map(
      fixture.analytics.harnessGraph().nodes.map((node) => [node.label, node.metrics['observed']]),
    );
    expect(observed.get('demo-skill')).toBe(2);
  });
});
