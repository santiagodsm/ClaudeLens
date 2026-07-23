-- 0004 — project-level harness: `harness_nodes.project_id`, and `harness_run_agents`
--
-- ⚠️ A NEW numbered file, never an edit to 0001–0003: merged migration files are IMMUTABLE
-- (STACK ADR-007, §3.18).
--
-- WHY (ADR-039, 2026-07-22 — a scope extension the user asked for in these words: "there may not
-- be a harness at this level but the projects have a harness. the intent was to see in the
-- projects how one orchestrator agent calls skills, calls subagents, agents, and those call
-- tools, etc."):
--
--   §2.1 defined the **Harness** as the `~/.claude` surface, so the scanner walked only the
--   configured Claude data directory. On a machine whose `skills/`, `agents/` and `commands/`
--   directories are all empty at that level — and whose skills and agents all live in
--   project-level `<project>/.claude/` directories — §3.10 produced zero nodes and the Harness
--   Map (§6.7) rendered empty. Not a rendering defect: there was genuinely nothing to scan.
--
--   ADR-039 widens the harness to include, per project, `<project>/.claude/**` and the project's
--   own root `CLAUDE.md`. Two columns of consequence land here.
--
-- 1. `harness_nodes.project_id` — WHICH project a node was declared in, `NULL` for every node
--    that came from the Claude data directory itself. It is also the **exclusion marker**: a node
--    with a non-NULL `project_id` describes a file OUTSIDE the configured root, so it is filtered
--    out of `q:skills`, `q:memories`, `q:plugins` and out of Bloat Radar. Nothing under a project
--    directory may ever be flagged, sized as reclaimable, or handed to a guarded action —
--    ACT-01…07 operate only within the Claude data directory and ADR-039 does not widen them
--    (§5.7, INV-14's shape applied to a second root).
--
--    ⚠️ `rel_path` for such a node is relative to the PROJECT directory (`.claude/skills/foo`,
--    `CLAUDE.md`), not to `claudeDir`. `project_id IS NOT NULL` is what tells the two apart, which
--    is why the uniqueness tuple has to carry it: two projects may legitimately declare the same
--    skill name at the same relative path and they are two nodes, exactly as §3.3 says two
--    projects may share a `display_name` and still be two projects.
--
-- 2. `harness_run_agents` — the agent TYPE of one subagent run, keyed by its transcript's
--    `rel_path` under `claudeDir`.
--
--    ⚠️⚠️ **This table exists because §3.7's spawn linkage does not resolve on real data.** §3.7
--    fills `subagent_runs.subagent_type` by resolving the run's earliest event's `parent_uuid`
--    against `events.uuid`. On the user's machine that yields `subagent_type` for **0 of 2514**
--    runs, which starves §5.9 M-14's runtime overlay completely: with no agent name on a run, no
--    agent→skill and no agent→tool edge can be derived, and the observed half of the Harness Map
--    is empty however many transcripts exist.
--
--    The name is not missing from disk. Every `subagents/agent-*.jsonl` has a sibling
--    `agent-*.meta.json` carrying `agentType`, `description` and `toolUseId` — the spawning
--    `Agent` tool call's `tool_use_id`, which joins to §3.6 `tool_calls.tool_use_id` exactly.
--    The harness scanner already walks past those files; ADR-039 reads them and lands the fact
--    here rather than writing a column §5.2's FINALIZING phase owns.
--
--    ⚠️ This is a parsed FACT, not an aggregate: ADR-027 forbids stored rollups, and there is no
--    count, sum or average in this table. It is DERIVED, replaced whole on every scan alongside
--    `harness_nodes` / `harness_edges`, and `observedRuntimeEdges()` reads
--    `COALESCE(subagent_runs.subagent_type, harness_run_agents.agent_type)` so the table becomes
--    dead weight — not a conflicting second source — the day §3.7's linkage starts resolving.
--
-- Additive DDL plus one index rebuild on a DERIVED, replaced-whole table. No row is deleted, no
-- fact table is touched, and `price_rows`, `settings`, `audit_log` and `archives` are not named
-- (INV-12, §12.2 `db-migration-review`).

ALTER TABLE harness_nodes ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE;

-- §3.10's `uq_harness_nodes`, extended by the project dimension. `COALESCE(project_id, 0)`
-- mirrors the existing `COALESCE(rel_path, '')`: SQLite treats NULLs as distinct in a UNIQUE
-- index, which would silently allow duplicate claudeDir-level nodes.
DROP INDEX IF EXISTS uq_harness_nodes;
CREATE UNIQUE INDEX uq_harness_nodes
  ON harness_nodes(kind, name, source, COALESCE(rel_path, ''), COALESCE(project_id, 0));

CREATE INDEX IF NOT EXISTS idx_harness_nodes_project
  ON harness_nodes(project_id) WHERE project_id IS NOT NULL;

-- §5.9 M-14's observed edges resolve a call to ONE node by `(kind, name, project_id)`, twice per
-- distinct pair — the project-scoped seek and the unscoped fallback. This is the index both use.
-- Without it `q:harnessGraph` scans `harness_nodes` for every pair and misses P-11 (any `q:*`
-- round trip <= 250 ms p95) on a real dataset.
CREATE INDEX IF NOT EXISTS idx_harness_nodes_lookup
  ON harness_nodes(kind, name, project_id);

CREATE TABLE harness_run_agents (
  -- `file_manifest.rel_path` of the run's transcript, POSIX and relative to `claudeDir` (§3.1.4).
  -- Not a foreign key: the sidecar is read by the harness scan, which does not own the manifest,
  -- and a run whose manifest row has not landed yet must be recorded rather than dropped.
  transcript_rel_path TEXT PRIMARY KEY,
  agent_type          TEXT NOT NULL,
  -- The spawning `Agent` tool call (§3.6 `tool_calls.tool_use_id`), when the sidecar names one.
  -- NULL is honest: the run happened and its agent is known, but its spawn point is not.
  spawn_tool_use_id   TEXT
);
CREATE INDEX idx_harness_run_agents_tool_use
  ON harness_run_agents(spawn_tool_use_id) WHERE spawn_tool_use_id IS NOT NULL;
