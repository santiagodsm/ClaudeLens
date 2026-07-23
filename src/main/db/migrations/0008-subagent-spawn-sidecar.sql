-- =====================================================================================
-- Migration 0008 — the subagent run's own `agent-*.meta.json`, as a structural source.
--
-- ⚠️ A NEW numbered file, never an edit to 0001–0007: merged migration files are IMMUTABLE
-- (STACK ADR-007, §3.18).
--
-- WHY (§3.7 / §5.4 AMENDED 2026-07-22 — see the amendment blocks in DESIGN.md):
--
--   §3.7 specified spawn linkage as: take the run's earliest event, resolve its
--   `parent_uuid` against `events.uuid`, and if that event is an assistant event carrying
--   an `Agent` tool call, fill `spawn_event_id`, `spawn_tool_call_id`, `subagent_type` and
--   `description`.
--
--   ⚠️ On the reporting user's real data that rule resolves for **0 of 2,514** subagent
--   runs, and it does so for a reason that no amount of query-writing fixes: the run's
--   earliest event has **no `parent_uuid` at all**. Measured, not guessed — of 237,606
--   subagent-origin events, exactly 2,515 carry a NULL `parent_uuid`, which is precisely
--   one per run: the head of the run's own chain. The uuid chain is per-file and does not
--   cross the file boundary; **zero** subagent events resolve to a main-loop event. The
--   rule was not mis-implemented. It was specified over an edge that does not exist.
--
--   The fact is on disk anyway. Every `subagents/<run-id>.jsonl` has a sibling
--   `<run-id>.meta.json` carrying `agentType`, `description` and `toolUseId` — the
--   `tool_use_id` of the spawning `Agent` call, which joins to §3.6 `tool_calls.tool_use_id`
--   exactly. That sidecar sits inside the run's own directory, which makes it *more*
--   structural than the uuid chain, not less: it is the same kind of evidence ADR-020
--   already prefers over the record-level `isSidechain` flag — where the file is, not what
--   a record claims about itself.
--
--   ⚠️ It is not a competing source of truth. On the reference dataset, sidecar `agentType`
--   and the linked `Agent` call's `subagent_type` agree on **2,334 of 2,334** runs where
--   both are known, with zero disagreements, and `description` agrees on **2,438 of 2,438**.
--   The sidecar additionally names the agent for 104 runs whose `Agent` call carried no
--   `subagent_type` in its input.
--
--   ⚠️ What did NOT change: **session attribution is still the path** (ADR-020), linkage is
--   still best-effort, still never a heuristic, and a run with no sidecar and no resolvable
--   chain still keeps `spawn_event_id IS NULL`, is still counted, and is still disclosed
--   (§4.6). There is no timestamp proximity, no nearest-preceding and no "the only Agent
--   call in that window" anywhere in this change. Totals were never affected either way,
--   because attribution is structural and linkage is only a label (§3.7).
--
-- The three columns below hold the sidecar VERBATIM, as parsed facts. They are not the
-- derived answer: `subagent_type`, `description`, `spawn_event_id` and `spawn_tool_call_id`
-- are still recomputed in full at FINALIZING from current table contents
-- (`RESOLVE_SPAWN_LINKS`, src/main/db/repositories/ingest-repo.ts), which is what keeps an
-- append and a cold parse identical (INV-04).
--
-- ⚠️ No aggregate column (ADR-027): there is no count, sum or average here.
--
-- Additive DDL plus one new index. No row is deleted, no table is dropped, no fact table is
-- rewritten, and `price_rows`, `settings`, `audit_log` and `archives` are not named
-- (INV-12, §12.2 `db-migration-review`).
-- =====================================================================================

-- The sidecar's `agentType`, verbatim. NULL means "no sidecar, or none was readable" — and
-- is what makes a run eligible to be re-probed on the next FINALIZING, so a database that
-- already exists is filled in by the next sync rather than needing a rebuild.
ALTER TABLE subagent_runs ADD COLUMN meta_agent_type TEXT;

-- The sidecar's `toolUseId`. NULL is honest and observed: the 77 nested
-- `subagents/workflows/<wf>/agent-*.meta.json` sidecars on the reference dataset carry an
-- `agentType` and no `toolUseId` at all. Such a run is NAMED but not LINKED — partial
-- knowledge, which is better than none and must not be discarded for being incomplete.
ALTER TABLE subagent_runs ADD COLUMN meta_tool_use_id TEXT;

-- The sidecar's `description`. Same field the spawning `Agent` call carries (§5.4 rule 9),
-- and observed to agree with it on every run where both exist.
ALTER TABLE subagent_runs ADD COLUMN meta_description TEXT;

-- `RESOLVE_SPAWN_LINKS` joins `subagent_runs.meta_tool_use_id` to `tool_calls.tool_use_id`
-- once per run. These two indexes are what make that a pair of seeks instead of a nested scan
-- of 87,653 tool calls × 2,516 runs at every FINALIZING — measured, the statement is 122 ms on
-- its first pass and 16–24 ms once nothing changes; without the `subagent_runs` side it is
-- 343 ms for the join alone, which would put the append fast-path outside P-03/P-04.
-- Both are partial: the columns are NULL for every content item that carried no `id` (§3.6)
-- and for every run whose sidecar names no `toolUseId`.
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_use
  ON tool_calls(tool_use_id) WHERE tool_use_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subagent_runs_meta_tool_use
  ON subagent_runs(meta_tool_use_id) WHERE meta_tool_use_id IS NOT NULL;

-- The seek that answers "which runs still need their sidecar read?" at FINALIZING.
CREATE INDEX IF NOT EXISTS idx_subagent_runs_meta_pending
  ON subagent_runs(id) WHERE meta_agent_type IS NULL;
