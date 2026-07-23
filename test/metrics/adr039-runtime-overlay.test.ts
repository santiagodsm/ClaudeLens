// ADR-039 / §5.9 M-14 — the runtime overlay with **zero configuration files**, hand-computed.
//
// ⚠️⚠️ **This is the case the Harness Map was empty for.** The user's `~/.claude/skills`,
// `~/.claude/agents` and `~/.claude/commands` are all empty; their skills and agents live in
// project-level `.claude/` directories. §3.10's scanner therefore produced no nodes and §6.7
// rendered "no skills or agents found under this directory" over 288,000 transcript events that
// describe exactly the orchestration the user wanted to see.
//
// ⚠️⚠️ **And §3.7's spawn linkage does not resolve.** §3.7 fills `subagent_runs.subagent_type` by
// resolving the run's earliest event's `parent_uuid` against `events.uuid`; on the user's machine
// that yields a type for 0 of 2514 runs. This fixture reproduces that exactly — **no transcript
// here carries a `parentUuid`** — so every agent name below comes from the `agent-*.meta.json`
// sidecar, which is the only place it exists. A fixture that linked cleanly would pass while the
// real thing stayed blank.
//
// ⚠️ Every expected number is inline with its arithmetic in a comment (CLAUDE.md §1).
// `toMatchSnapshot()` is banned under `test/metrics/**` and does not appear.
//
// ⚠️ The transcripts go through the REAL parser and the REAL harness scanner (STACK ADR-013).
// Nothing here hand-writes a row: what is under test is whether the overlay is fed the right ones.

import { describe, expect, it } from 'vitest';
import { AnalyticsRepository } from '../../src/main/db/repositories/analytics';
import { HarnessService } from '../../src/main/harness/service';
import type { Graph, GraphEdge } from '../../src/shared/ipc-contract';
import { useSandbox, type Sandbox } from '../support/sandbox';
import { createSyncHarness, fixturePath, FIXED_NOW } from '../support/sync-harness';

interface Loaded {
  readonly graph: Graph;
  readonly scanned: { nodes: number; edges: number; projectsResolved: number };
}

/** Sync the fixture, run the real harness scan over it, then read `q:harnessGraph`. */
async function load(sandbox: Sandbox, suffix: string): Promise<Loaded> {
  const root = await sandbox.copyFixture(fixturePath('adr039-runtime'), `root-${suffix}`);
  const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve(`${suffix}.db`) });
  await harness.runSync();
  const service = new HarnessService({
    db: harness.db,
    claudeDir: () => root,
    now: () => FIXED_NOW,
  });
  const summary = await service.scan();
  return {
    graph: new AnalyticsRepository(harness.db).harnessGraph(),
    scanned: {
      nodes: summary.nodes,
      edges: summary.edges,
      projectsResolved: summary.projectsResolved,
    },
  };
}

/** Node overlay by `kind:label`. */
function observedByNode(graph: Graph): Map<string, number | undefined> {
  return new Map(
    graph.nodes.map((node) => [`${node.kind}:${node.label}`, node.metrics['observed']]),
  );
}

/** Every edge, named by its endpoints' labels rather than by row id. */
function edgesByLabel(graph: Graph): Map<string, GraphEdge> {
  const label = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return new Map(
    graph.edges.map((edge) => [
      `${label.get(edge.source) ?? edge.source}->${label.get(edge.target) ?? edge.target}`,
      edge,
    ]),
  );
}

describe('ADR-039 — a useful Harness Map from runtime data alone', () => {
  const sandbox = useSandbox();

  it('the fixture really does have zero configuration files and zero linked runs', async () => {
    const root = await sandbox.copyFixture(fixturePath('adr039-runtime'), 'root-precondition');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('pre.db') });
    await harness.runSync();

    // ⚠️ The precondition this whole file rests on. If a later change adds a `SKILL.md` to the
    // fixture, or gives a transcript a `parentUuid` that resolves, every assertion below would
    // still pass — for the wrong reason — and the real-world case would silently stop being
    // covered.
    //
    // ⚠️ AMENDED 2026-07-22 — §3.7's UUID-CHAIN rule still resolves nothing here, and that is
    // what this precondition now states directly: no subagent transcript in the fixture carries
    // a `parentUuid` at all, which is exactly the real dataset's shape (0 of 2,514). What
    // changed is that §3.7 no longer depends on that chain: it reads the run's own
    // `agent-*.meta.json` sidecar, so `subagent_type` is now filled for the 3 runs whose
    // sidecar names an agent AND a `toolUseId` that resolves. Asserting "linked === 0" would
    // now be asserting that the fix does not work.
    const runs = harness.db
      .prepare<{ n: number; chained: number; named: number }>(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(EXISTS (
                  SELECT 1 FROM events e
                   WHERE e.source_file_id = sr.transcript_file_id
                     AND e.parent_uuid IS NOT NULL)), 0) AS chained,
                COALESCE(SUM(subagent_type IS NOT NULL), 0) AS named
           FROM subagent_runs sr`,
      )
      .get();
    expect(runs?.n).toBe(4);
    // Not one event in any of the four transcripts has a parent to resolve against.
    expect(runs?.chained).toBe(0);
    // b1, c1 and b2 name an agent and a resolvable `toolUseId`; `agent-unknown` names neither
    // an agent nor a `toolUseId` that exists, so it stays unnamed and unlinked (§4.6).
    expect(runs?.named).toBe(3);

    const service = new HarnessService({
      db: harness.db,
      claudeDir: () => root,
      now: () => FIXED_NOW,
    });
    const summary = await service.scan();
    // No `SKILL.md`, no `agents/*.md`, no `CLAUDE.md`, no `settings.json` anywhere under the root,
    // so `harness_edges` — the DESIGNED half — is empty. Every edge in the payload is observed.
    expect(summary.edges).toBe(0);
    // One project in the fixture, and its encoded name decodes to a path that does not exist on
    // any machine, so it is skipped rather than probed for.
    expect(summary.projectsResolved).toBe(0);
    expect(summary.projectsSkipped).toBe(1);
  });

  it('names agents and skills the transcripts show, and counts how often each ran', async () => {
    const { graph } = await load(sandbox, 'nodes');
    const observed = observedByNode(graph);

    // ⚠️ Agent nodes exist at all only because §2.1 defines an agent definition as "a
    // `.claude/agents/*.md` file, **or a `subagent_type` value observed in an `Agent` tool call**".
    // Spawns of `builder`: the two main-loop calls (a-m1, a-m2) and one nested spawn from
    // `checker` (a-c1-2).                                                        2 + 1 = 3
    expect(observed.get('agent:builder')).toBe(3);
    // Spawns of `checker`: one main-loop call (a-m3).                                      = 1
    expect(observed.get('agent:checker')).toBe(1);

    // Skill invocations of `polish`: two inside run b1, one inside run c1.        2 + 1 = 3
    expect(observed.get('skill:polish')).toBe(3);

    // `Read`: one in the main loop (a-m4), one in b1, two in b2.             1 + 1 + 2 = 4
    expect(observed.get('tool:Read')).toBe(4);
    // `Bash`: one in b1 and one in the run whose sidecar names no agent.          1 + 1 = 2
    // ⚠️ Both are real calls and both are counted — a run with no agent name still happened, and
    // only its EDGES are unknowable (§3.7, ADR-020).
    expect(observed.get('tool:Bash')).toBe(2);
    // `Agent` and `Skill` ARE tools (§2.1, M-12). Three main-loop `Agent` calls plus the nested
    // one; three `Skill` calls.                                             3 + 1 = 4, and 3
    expect(observed.get('tool:Agent')).toBe(4);
    expect(observed.get('tool:Skill')).toBe(3);
  });

  it('⚠️ every edge is designed: false, observed > 0 — and it survives to the payload', async () => {
    const { graph } = await load(sandbox, 'edges');
    const edges = edgesByLabel(graph);

    // ⚠️ §4.5 calls `designed: false, observed > 0` "a legal and interesting state" and §6.7
    // requires the Map to highlight it. With no configuration files it is the ONLY state there is.
    expect(graph.edges.filter((edge) => edge.designed)).toHaveLength(0);
    expect(graph.edges.every((edge) => edge.observed > 0)).toBe(true);

    // ---- O-1: what an agent's own run called ------------------------------------------------
    // `builder` ran twice; only run b1 invoked `polish`, and it did so twice.               = 2
    const builderPolish = edges.get('builder->polish');
    expect(builderPolish?.designed).toBe(false);
    expect(builderPolish?.observed).toBe(2);
    expect(builderPolish?.kind).toBe('handoff');
    // No `evidence`: §3.10's three values all describe a FILE, and this edge has no file behind
    // it. Its evidence is the transcript, and inventing a fourth value would put it in a CHECK
    // constraint it does not belong to.
    expect(builderPolish?.evidence).toBeUndefined();

    // `Read` across both `builder` runs: one in b1, two in b2.                   1 + 2 = 3
    expect(edges.get('builder->Read')?.observed).toBe(3);
    expect(edges.get('builder->Read')?.kind).toBe('tool_grant');

    // ⚠️ THE DISCRIMINATOR. `Bash` ran TWICE in the dataset (the node overlay above says 2) but
    // only ONE of those calls was inside a run whose agent is named. A 2 here would mean the
    // anonymous run had been attributed to `builder` by guesswork, which ADR-020 forbids.
    expect(edges.get('builder->Bash')?.observed).toBe(1);
    expect(edges.get('builder->Bash')?.observed).not.toBe(2);

    // `checker`'s own run invoked `polish` once.                                            = 1
    expect(edges.get('checker->polish')?.observed).toBe(1);

    // ---- O-2: "…calls subagents, agents…" — the hop the user asked for by name ---------------
    // `checker` spawned `builder` once, from inside its own run (a-c1-2).                   = 1
    const nested = edges.get('checker->builder');
    expect(nested?.designed).toBe(false);
    expect(nested?.observed).toBe(1);
    expect(nested?.kind).toBe('handoff');

    // ⚠️ That `Agent` call produces the agent→agent edge and NOT a second `checker->Agent` tool
    // edge. Drawing both would state one fact twice and turn the `Agent` tool node into a hub
    // every orchestrator points at, which says nothing.
    expect(edges.get('checker->Agent')).toBeUndefined();

    // Five edges, exactly, and no others: builder→{polish, Read, Bash}, checker→{polish, builder}.
    // Nothing for the anonymous run, and nothing from the main loop — this fixture has no
    // project-level `CLAUDE.md` for rule O-3 to start from.
    expect(graph.edges).toHaveLength(5);
  });

  it('⛔ INV-13 — the overlay has no filter to ignore, and the Map is not empty', async () => {
    const { graph, scanned } = await load(sandbox, 'inv13');
    // `harnessGraph()` takes no argument at all: "all time" is a compile-time property of the
    // signature (§4.5 types `q:harnessGraph` without `GlobalFilter`), not a convention.
    // What this asserts is the outcome the user reported: the Map is no longer empty.
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(scanned.nodes).toBe(graph.nodes.length);
  });
});
