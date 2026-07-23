// The write half of `harness_nodes` / `harness_edges` — DESIGN §3.10.
//
// ⚠️ **Parsed harness text is data, never instructions** (§3.10, §7.8, STACK ADR-017). Every
// string that reaches this file came out of a `SKILL.md`, an agent definition or a plugin
// manifest in the user's configuration directory. It is bound as a SQL parameter, stored, counted
// and rendered — never executed, never interpolated into anything executable, never sent anywhere.
// There is exactly one network egress point in this application and it is not reachable from here
// (INV-15).
//
// ⚠️ Both tables are DERIVED and **fully replaced** on each scan, in ONE transaction: a node that
// no longer exists on disk must disappear rather than linger as a ghost the Harness Map still
// draws. `bloat_flags` is replaced the same way and for the same reason (§3.12).

import { Repository } from './base';
import type { SqliteDatabase } from '../sqlite';

/** §3.10 `harness_nodes.kind` CHECK, transcribed. */
export type HarnessNodeKind =
  | 'skill'
  | 'agent'
  | 'command'
  | 'tool'
  | 'file'
  | 'plugin'
  | 'marketplace'
  | 'memory'
  | 'claude_md'
  | 'settings';

/** §3.10 `harness_nodes.source` CHECK. */
export type HarnessNodeSource = 'user' | 'plugin' | 'builtin' | 'transcript';

/** §3.10 `harness_edges.kind` CHECK. */
export type HarnessEdgeKind = 'handoff' | 'tool_grant' | 'reads' | 'writes' | 'contains';

/** §3.10 `harness_edges.evidence` CHECK. */
export type HarnessEdgeEvidence = 'frontmatter' | 'body_mention' | 'directory';

/**
 * One node as the scanner produces it, before it has a database id.
 *
 * `key` is the scanner's own handle for the node — the unique tuple of §3.10's
 * `uq_harness_nodes` index, `(kind, name, source, COALESCE(rel_path,''))` — so edges can name
 * their endpoints without the scanner having to care what row id they land on.
 */
export interface HarnessNodeInput {
  readonly kind: HarnessNodeKind;
  readonly name: string;
  readonly source: HarnessNodeSource;
  /** The `key` of the plugin node that contains this one, when there is one. */
  readonly pluginKey: string | null;
  /**
   * ADR-039 — the project this node was declared in, or `null` for everything that came from the
   * Claude data directory itself.
   *
   * ⚠️ **It is also the exclusion marker.** A non-null `projectId` means `relPath` points OUTSIDE
   * the configured root — it is relative to the *project* directory — so the node is filtered out
   * of `q:skills`, `q:memories` and `q:plugins`, never reaches Bloat Radar, and can never become
   * the target of a guarded action. ACT-01…07 operate only within the Claude data directory and
   * ADR-039 does not widen them.
   */
  readonly projectId: number | null;
  readonly relPath: string | null;
  readonly role: string | null;
  readonly description: string | null;
  readonly sizeBytes: number;
  readonly mtimeMs: number | null;
  readonly enabled: boolean | null;
  /**
   * Migration 0003 — §6.9's memory browser. `null` means "not counted", which is the honest
   * value for every kind that is not a memory. It is never read as zero.
   */
  readonly entryCount: number | null;
  /**
   * Migration 0010 — §6.7 / §1a. The plugin's own declared version (from `plugin.json` /
   * `marketplace.json` `version`), for the Harness Map's label disambiguation. `null` for every
   * node that is not a plugin/marketplace, and for a manifest that declares none. It is NOT part
   * of node identity (§3.10 `uq_harness_nodes`): two versions of a plugin already differ by
   * `relPath`. Never read as a version of `0`.
   */
  readonly version: string | null;
}

/** One edge, naming its endpoints by node `key` rather than by row id. */
export interface HarnessEdgeInput {
  readonly fromKey: string;
  readonly toKey: string;
  readonly kind: HarnessEdgeKind;
  readonly evidence: HarnessEdgeEvidence;
}

/** §3.10's `uq_harness_nodes` tuple, as one string. The scanner's node identity. */
export function harnessNodeKey(node: {
  readonly kind: HarnessNodeKind;
  readonly name: string;
  readonly source: HarnessNodeSource;
  readonly relPath: string | null;
  readonly projectId?: number | null;
}): string {
  // ADR-039 added `project_id` to `uq_harness_nodes`, so it is part of the key here too: two
  // projects may legitimately declare the same skill name at the same project-relative path,
  // and they are two nodes — exactly as §3.3 says two projects may share a `display_name` and
  // still be two projects. `0` stands for "no project", matching the index's
  // `COALESCE(project_id, 0)`.
  return `${node.kind}\0${node.name}\0${node.source}\0${node.relPath ?? ''}\0${String(node.projectId ?? 0)}`;
}

/**
 * ADR-039 — one subagent run's agent type, read from its `agent-*.meta.json` sidecar.
 *
 * ⚠️ **Why this exists at all.** §3.7 fills `subagent_runs.subagent_type` by resolving the run's
 * earliest event's `parent_uuid` against `events.uuid`. On real data that resolves for **none** of
 * the runs, which starves §5.9 M-14 completely: with no agent name on a run, no agent→skill and no
 * agent→tool edge is derivable, and the observed half of the Harness Map stays empty however many
 * transcripts exist. The name is not missing from disk — it sits in a sidecar beside every run.
 *
 * `observedRuntimeEdges()` reads `COALESCE(subagent_runs.subagent_type, agent_type)`, so this
 * becomes redundant rather than contradictory the day §3.7's linkage starts resolving.
 */
export interface HarnessRunAgentInput {
  /** `file_manifest.rel_path` of the run's transcript — POSIX, relative to `claudeDir` (§3.1.4). */
  readonly transcriptRelPath: string;
  readonly agentType: string;
  /** §3.6 `tool_calls.tool_use_id` of the spawning `Agent` call; `null` when the sidecar has none. */
  readonly spawnToolUseId: string | null;
}

export interface HarnessGraphCounts {
  readonly nodes: number;
  readonly edges: number;
}

const DELETE_EDGES = 'DELETE FROM harness_edges';
const DELETE_NODES = 'DELETE FROM harness_nodes';

const INSERT_NODE = `INSERT INTO harness_nodes
  (kind, name, source, plugin_id, project_id, rel_path, role, description, size_bytes, mtime_ms,
   enabled, entry_count, version)
  VALUES (@kind, @name, @source, @pluginId, @projectId, @relPath, @role, @description, @sizeBytes,
          @mtimeMs, @enabled, @entryCount, @version)`;

/** ADR-039 — the run→agent map is replaced whole beside the graph, in the same transaction. */
const DELETE_RUN_AGENTS = 'DELETE FROM harness_run_agents';
const INSERT_RUN_AGENT = `INSERT OR REPLACE INTO harness_run_agents
  (transcript_rel_path, agent_type, spawn_tool_use_id) VALUES (?, ?, ?)`;

const SET_PLUGIN_ID = 'UPDATE harness_nodes SET plugin_id = ? WHERE id = ?';

const INSERT_EDGE = `INSERT OR IGNORE INTO harness_edges (from_id, to_id, kind, evidence)
  VALUES (?, ?, ?, ?)`;

const COUNT_NODES = 'SELECT COUNT(*) AS n FROM harness_nodes';
const COUNT_EDGES = 'SELECT COUNT(*) AS n FROM harness_edges';

/**
 * §5.9 M-13 / §5.11 BR-03 — the distinct tool names actually observed in the transcripts.
 *
 * ⛔ INV-13: no `GlobalFilter`, no date bound, no project bound. "Installed but never invoked"
 * is a claim about the whole dataset or it is a claim about nothing.
 */
const OBSERVED_TOOL_NAMES = 'SELECT DISTINCT tool_name AS name FROM tool_calls ORDER BY tool_name';

/**
 * ADR-039 — the distinct skill names actually invoked, all time.
 *
 * §2.1 "Skill invocation" is a tool call whose `tool_name` is `Skill`; its `skill_name` is the
 * skill that ran. A skill that ran is a vertex of the Harness Map whether or not any `SKILL.md`
 * declares it — `source = 'transcript'` in §3.10's CHECK is for exactly this — and without it the
 * Map is empty on a machine that keeps its skills somewhere the app does not read.
 *
 * ⛔ INV-13: no filter, no date bound, no project bound.
 */
const OBSERVED_SKILL_NAMES = `SELECT DISTINCT skill_name AS name FROM tool_calls
  WHERE tool_name = 'Skill' AND skill_name IS NOT NULL AND skill_name <> ''
  ORDER BY skill_name`;

/**
 * ADR-039 — the distinct agent definitions actually spawned, all time.
 *
 * ⚠️ §2.1 "Agent definition" already says an agent definition is "a `.claude/agents/*.md` file,
 * **or a `subagent_type` value observed in an `Agent` tool call**". The second half of that
 * sentence had no implementation until now; this is it, and it is the reason the Harness Map can
 * show agents at all on a machine with no agent files.
 *
 * Both sources of the name are unioned: the spawning `Agent` tool call's `subagent_type` (§3.6),
 * and the run's own `agent-*.meta.json` sidecar (`harness_run_agents`, this migration). A spawn
 * whose run never landed on disk, and a run whose spawn call is in an unparsed file, each name a
 * real agent; taking only one source would drop one of them.
 *
 * ⛔ INV-13: no filter, no date bound, no project bound.
 */
const OBSERVED_AGENT_NAMES = `SELECT DISTINCT name FROM (
    SELECT subagent_type AS name FROM tool_calls
     WHERE tool_name = 'Agent' AND subagent_type IS NOT NULL AND subagent_type <> ''
    UNION
    SELECT subagent_type AS name FROM subagent_runs
     WHERE subagent_type IS NOT NULL AND subagent_type <> ''
    UNION
    SELECT agent_type AS name FROM harness_run_agents WHERE agent_type <> ''
  ) ORDER BY name`;

export class HarnessGraphRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /**
   * Replaces the whole graph in one transaction (§3.10, §3.12's "fully replaced" rule).
   *
   * Edges naming a node that was not inserted are **dropped silently on purpose**: the scanner
   * emits `tool_grant` edges for every `allowed-tools` entry it reads, and a skill may grant a
   * tool that no other evidence establishes. The scanner creates those tool nodes itself; an
   * edge that still cannot be resolved here describes a node this build does not model, and
   * inventing one would put a vertex on the Harness Map that nothing on disk supports.
   *
   * ⚠️ **A node whose key is already present is skipped, and every edge naming that key resolves
   * to the row already inserted.** `harnessNodeKey` IS `uq_harness_nodes`, so two inputs sharing
   * a key are one vertex by definition. This is not defensive padding: ADR-039 made it reachable
   * the moment a second project appeared. Tool nodes are deliberately **not** project-scoped —
   * `Read` is the same `Read` everywhere, and one `Read` per project would shatter the Map into
   * disconnected islands — so every project that grants `Read` in a skill's `allowed-tools`
   * offers the same key. Found by running the scanner against a real machine with five resolvable
   * projects, where it raised `SQLITE_CONSTRAINT_UNIQUE` and aborted the whole scan. Merging is
   * the correct answer and dropping the second edge would have been the silent one.
   */
  replaceGraph(
    nodes: readonly HarnessNodeInput[],
    edges: readonly HarnessEdgeInput[],
    runAgents: readonly HarnessRunAgentInput[] = [],
  ): void {
    this.transaction((): void => {
      this.run(DELETE_EDGES);
      this.run(DELETE_NODES);
      this.run(DELETE_RUN_AGENTS);

      for (const run of runAgents) {
        this.run(INSERT_RUN_AGENT, run.transcriptRelPath, run.agentType, run.spawnToolUseId);
      }

      const idByKey = new Map<string, number>();
      for (const node of nodes) {
        const key = harnessNodeKey(node);
        if (idByKey.has(key)) continue;
        const result = this.run(INSERT_NODE, {
          kind: node.kind,
          name: node.name,
          source: node.source,
          // Resolved in a second pass: a plugin node may be inserted after the skill it contains.
          pluginId: null,
          projectId: node.projectId,
          relPath: node.relPath,
          role: node.role,
          description: node.description,
          sizeBytes: node.sizeBytes,
          mtimeMs: node.mtimeMs,
          enabled: node.enabled === null ? null : node.enabled ? 1 : 0,
          entryCount: node.entryCount,
          // Migration 0010 — §6.7 / §1a. Present only on plugin/marketplace nodes.
          version: node.version,
        });
        idByKey.set(key, Number(result.lastInsertRowid));
      }

      for (const node of nodes) {
        if (node.pluginKey === null) continue;
        const selfId = idByKey.get(harnessNodeKey(node));
        const pluginId = idByKey.get(node.pluginKey);
        if (selfId === undefined || pluginId === undefined) continue;
        this.run(SET_PLUGIN_ID, pluginId, selfId);
      }

      for (const edge of edges) {
        const fromId = idByKey.get(edge.fromKey);
        const toId = idByKey.get(edge.toKey);
        if (fromId === undefined || toId === undefined) continue;
        this.run(INSERT_EDGE, fromId, toId, edge.kind, edge.evidence);
      }
    });
  }

  counts(): HarnessGraphCounts {
    return {
      nodes: this.one<{ n: number }>(COUNT_NODES)?.n ?? 0,
      edges: this.one<{ n: number }>(COUNT_EDGES)?.n ?? 0,
    };
  }

  /** ⛔ INV-13 — all time, by construction: the query has no scope parameter to give it. */
  observedToolNames(): string[] {
    return this.all<{ name: string }>(OBSERVED_TOOL_NAMES).map((row) => row.name);
  }

  /** ADR-039 ⛔ INV-13 — every skill name a transcript shows running, all time. */
  observedSkillNames(): string[] {
    return this.all<{ name: string }>(OBSERVED_SKILL_NAMES).map((row) => row.name);
  }

  /** ADR-039 ⛔ INV-13 — every agent definition a transcript shows running, all time. */
  observedAgentNames(): string[] {
    return this.all<{ name: string }>(OBSERVED_AGENT_NAMES).map((row) => row.name);
  }

  /**
   * ADR-039 — every project the sync cycle has recorded (§3.3), for project-harness resolution.
   *
   * Each carries its **encoded name** (§3.3's identity) and the distinct `events.cwd` values
   * recorded for it.
   *
   * ⚠️⚠️ **`cwd` is what makes the resolution exact rather than lossy, and reading it here does
   * not weaken §3.5.** §3.5 says `cwd` "is retained for provenance only, is never rendered, and
   * never leaves the database". All three still hold: this value is consumed inside the main
   * process to decide which directory to open, and it is never rendered, never logged, never put
   * on an IPC payload and never written to a file. What crosses the boundary is a **count** of
   * resolved and skipped projects (§4.8) and node paths that are relative to their project.
   *
   * ⚠️ A caller may use a `cwd` only when re-encoding it reproduces this project's `encoded_name`
   * exactly — an equality check against two recorded columns, not a search. §2.1's "zero
   * inference" forbids hunting the filesystem for a plausible alternative, and nothing here does.
   */
  projectIdentities(): { id: number; encodedName: string; cwds: string[] }[] {
    const cwdsByProject = new Map<number, string[]>();
    for (const row of this.all<{ readonly project_id: number; readonly cwd: string }>(
      `SELECT DISTINCT project_id, cwd FROM events
        WHERE cwd IS NOT NULL AND cwd <> '' AND project_id IS NOT NULL
        ORDER BY project_id, cwd`,
    )) {
      const existing = cwdsByProject.get(row.project_id);
      if (existing === undefined) cwdsByProject.set(row.project_id, [row.cwd]);
      else existing.push(row.cwd);
    }
    return this.all<{ readonly id: number; readonly encoded_name: string }>(
      'SELECT id, encoded_name FROM projects ORDER BY id',
    ).map((row) => ({
      id: row.id,
      encodedName: row.encoded_name,
      cwds: cwdsByProject.get(row.id) ?? [],
    }));
  }
}
