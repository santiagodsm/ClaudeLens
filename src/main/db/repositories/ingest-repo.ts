// The write path for everything §5.4 produces: §3.3 projects, §3.4 sessions, §3.5 events,
// §3.6 tool_calls, §3.7 subagent_runs, §3.8 file_touches, §3.9 prompts, §3.16 stats_cache_days.
//
// STACK ADR-008 — SQL lives only under `src/main/db/**`. `src/main/parse/ingest.ts` composes
// these calls; it never composes SQL.
//
// Two properties of this file are what make INV-03 and INV-04 true rather than argued:
//
//   · **Every insert is idempotent.** `events` on `event_key` (ADR-019), `tool_calls` on
//     `UNIQUE (event_id, ordinal)` (§3.6), `file_touches` on `UNIQUE (tool_call_id)` (§3.8),
//     `prompts` on `UNIQUE (source_file_id, line_no)` (§3.9), `subagent_runs` on
//     `UNIQUE (transcript_file_id)` (§3.7). Re-parsing a file, replaying an append or meeting
//     the same record in two files can never double-count.
//   · **Every derived value is RECOMPUTED, never accumulated.** `sessions.first_ts`,
//     `projects.last_ts`, `subagent_runs.first_ts`, prompt→project resolution and spawn
//     linkage are all `UPDATE … SELECT` over the current table contents. An accumulator would
//     be a different number after an append than after a cold parse, which is exactly what
//     INV-04 forbids.

import { Repository } from './base';
import type { SqliteDatabase } from '../sqlite';

export interface UpsertProjectInput {
  readonly encodedName: string;
  readonly displayName: string;
  readonly colorIndex: number;
}

export interface UpsertSessionInput {
  readonly sessionId: string;
  readonly projectId: number;
  /** §3.4 — set only by the session's own main transcript; NULL until one is seen. */
  readonly transcriptFileId: number | null;
}

export interface InsertEventInput {
  readonly eventKey: string;
  readonly sessionId: string;
  readonly projectId: number;
  readonly sourceFileId: number;
  readonly lineNo: number;
  readonly ts: number;
  readonly type: string;
  readonly role: string | null;
  readonly origin: string;
  readonly subagentRunId: number | null;
  readonly uuid: string | null;
  readonly parentUuid: string | null;
  readonly isSidechain: number;
  readonly model: string | null;
  readonly isSynthetic: number;
  readonly isApiError: number;
  readonly tokInput: number;
  readonly tokOutput: number;
  readonly tokCacheWrite: number;
  /**
   * §3.5 (migration 0005, A-05) — the 1-hour cache-write class. ⚠️ `null` means **not known**
   * and is never read as zero by anything that reports it; the cost path reads
   * `COALESCE(..., 0)`, which reproduces the pre-A-05 behaviour exactly (§5.4 rule 8).
   */
  readonly tokCacheWrite1h: number | null;
  readonly tokCacheRead: number;
  readonly gitBranch: string | null;
  readonly cliVersion: string | null;
  readonly cwd: string | null;
}

export interface InsertToolCallInput {
  readonly eventId: number;
  readonly sessionId: string;
  readonly projectId: number;
  readonly origin: string;
  readonly ts: number;
  readonly ordinal: number;
  readonly toolName: string;
  readonly toolUseId: string | null;
  readonly skillName: string | null;
  readonly subagentType: string | null;
  /** §3.6 (amended, A-09) / §5.4 rule 9 — `Agent` only; the spawn label §3.7 reads back. */
  readonly description: string | null;
  readonly targetPath: string | null;
  readonly isWriteClass: number;
}

export interface InsertFileTouchInput {
  readonly toolCallId: number;
  readonly sessionId: string;
  readonly projectId: number;
  readonly ts: number;
  readonly path: string;
  readonly basename: string;
  readonly extension: string | null;
  readonly language: string | null;
  readonly toolName: string;
}

export interface InsertPromptInput {
  readonly sourceFileId: number;
  readonly lineNo: number;
  readonly ts: number;
  readonly rawProject: string | null;
  readonly sessionId: string | null;
  readonly displayPreview: string | null;
  readonly displayChars: number;
}

/** §3.7 (amended) — one subagent run and the transcript path its sidecar sits beside. */
export interface SubagentRunFile {
  readonly id: number;
  /** `file_manifest.rel_path` — POSIX, relative to `claudeDir` (§3.1.4). */
  readonly relPath: string;
}

/** §3.7 (amended) — the `agent-*.meta.json` fields, verbatim. Each independently optional. */
export interface RecordSubagentMetaInput {
  readonly id: number;
  readonly agentType: string | null;
  readonly toolUseId: string | null;
  readonly description: string | null;
}

export interface IngestCounts {
  readonly events: number;
  readonly sessions: number;
  readonly projects: number;
  readonly toolCalls: number;
  readonly prompts: number;
}

// ---------------------------------------------------------------------------------------
// §3.3 projects — upserted by `encoded_name`, the identity (§5.4 rule 6).
// ---------------------------------------------------------------------------------------

// `color_index` is a pure function of `encoded_name`, so a conflicting insert refreshes
// nothing. `display_name` is written here as the §3.3 FALLBACK (the decoded `encoded_name`)
// and then re-derived from `events.cwd` at FINALIZING — see
// `RECOMPUTE_PROJECT_DISPLAY_NAMES` below (§3.3/§3.5 as amended 2026-07-22). Refreshing it
// on conflict would write the fallback back over a correct name on every re-parse.
const UPSERT_PROJECT = `INSERT INTO projects (encoded_name, display_name, color_index)
  VALUES (@encodedName, @displayName, @colorIndex)
  ON CONFLICT(encoded_name) DO NOTHING`;
const SELECT_PROJECT_ID = 'SELECT id FROM projects WHERE encoded_name = ?';

// ---------------------------------------------------------------------------------------
// §3.4 sessions
// ---------------------------------------------------------------------------------------

// A session row may be created by a subagent transcript before its parent transcript is seen
// (ADR-020: attribution is the path). `transcript_file_id` is therefore filled in whenever a
// main transcript for the session arrives, and never cleared by a later subagent file.
const UPSERT_SESSION = `INSERT INTO sessions (id, project_id, transcript_file_id)
  VALUES (@sessionId, @projectId, @transcriptFileId)
  ON CONFLICT(id) DO UPDATE SET
    transcript_file_id = COALESCE(excluded.transcript_file_id, sessions.transcript_file_id)`;

// ---------------------------------------------------------------------------------------
// §3.5 events — ADR-019
// ---------------------------------------------------------------------------------------

const INSERT_EVENT = `INSERT INTO events
  (event_key, session_id, project_id, source_file_id, line_no, ts, type, role, origin,
   subagent_run_id, uuid, parent_uuid, is_sidechain, model, is_synthetic, is_api_error,
   tok_input, tok_output, tok_cache_write, tok_cache_write_1h, tok_cache_read,
   git_branch, cli_version, cwd)
  VALUES
  (@eventKey, @sessionId, @projectId, @sourceFileId, @lineNo, @ts, @type, @role, @origin,
   @subagentRunId, @uuid, @parentUuid, @isSidechain, @model, @isSynthetic, @isApiError,
   @tokInput, @tokOutput, @tokCacheWrite, @tokCacheWrite1h, @tokCacheRead,
   @gitBranch, @cliVersion, @cwd)
  ON CONFLICT(event_key) DO NOTHING`;
const SELECT_EVENT_ID = 'SELECT id FROM events WHERE event_key = ?';

// ---------------------------------------------------------------------------------------
// §3.6 tool_calls · §3.8 file_touches
// ---------------------------------------------------------------------------------------

// `description` arrives with migration 0002 (A-09): §5.4 rule 9 always extracted it, and
// §3.6's DDL had nowhere to put it, so §3.7's `subagent_runs.description` was necessarily
// NULL. Persisting it here is what lets FINALIZING read it back deterministically.
const INSERT_TOOL_CALL = `INSERT INTO tool_calls
  (event_id, session_id, project_id, origin, ts, ordinal, tool_name, tool_use_id, skill_name,
   subagent_type, description, target_path, is_write_class)
  VALUES
  (@eventId, @sessionId, @projectId, @origin, @ts, @ordinal, @toolName, @toolUseId, @skillName,
   @subagentType, @description, @targetPath, @isWriteClass)
  ON CONFLICT(event_id, ordinal) DO NOTHING`;
const SELECT_TOOL_CALL_ID = 'SELECT id FROM tool_calls WHERE event_id = ? AND ordinal = ?';

const INSERT_FILE_TOUCH = `INSERT INTO file_touches
  (tool_call_id, session_id, project_id, ts, path, basename, extension, language, tool_name)
  VALUES
  (@toolCallId, @sessionId, @projectId, @ts, @path, @basename, @extension, @language, @toolName)
  ON CONFLICT(tool_call_id) DO NOTHING`;

// ---------------------------------------------------------------------------------------
// §3.7 subagent_runs
// ---------------------------------------------------------------------------------------

const UPSERT_SUBAGENT_RUN = `INSERT INTO subagent_runs
  (session_id, project_id, transcript_file_id) VALUES (?, ?, ?)
  ON CONFLICT(transcript_file_id) DO NOTHING`;
const SELECT_SUBAGENT_RUN_ID = 'SELECT id FROM subagent_runs WHERE transcript_file_id = ?';

/**
 * §3.7 (AMENDED 2026-07-22) — the runs whose `agent-*.meta.json` sidecar has not been read
 * yet, so FINALIZING knows which files to open. Migration 0008 leaves every pre-existing row
 * NULL here, which is exactly what makes an already-populated database fill itself in on the
 * next sync instead of needing a rebuild.
 *
 * ⚠️ `archive_id IS NULL` is not an optimisation. An archived transcript has left the Claude
 * data directory on purpose and is **never re-read** (§5.3 `ARCHIVED`, ADR-034); its sidecar
 * went with it. Probing for it every cycle would be a read against a path the app has
 * promised not to touch, and would fail forever anyway.
 *
 * Ordered by `rel_path` — a stored, deterministic value — so two runs of the same cycle read
 * the same files in the same order (INV-04's spirit, applied to the read side).
 */
const SELECT_RUNS_MISSING_META = `SELECT sr.id AS id, fm.rel_path AS relPath
    FROM subagent_runs sr
    JOIN file_manifest fm ON fm.id = sr.transcript_file_id
   WHERE sr.meta_agent_type IS NULL
     AND fm.archive_id IS NULL
   ORDER BY fm.rel_path ASC`;

/**
 * The sidecar stored VERBATIM. These three columns are a parsed fact, not the answer:
 * `subagent_type`, `description` and the two spawn columns are recomputed in full from them
 * by `RESOLVE_SPAWN_LINKS` below, over current table contents (INV-04).
 */
const RECORD_SUBAGENT_META = `UPDATE subagent_runs
     SET meta_agent_type  = @agentType,
         meta_tool_use_id = @toolUseId,
         meta_description = @description
   WHERE id = @id`;

// ---------------------------------------------------------------------------------------
// §3.9 prompts · §3.16 stats_cache_days
// ---------------------------------------------------------------------------------------

// `project_id` is deliberately NOT resolved here: `history.jsonl` may be read before the
// projects it names exist. It is resolved in one pass at finalize time, which is what makes
// the result independent of file order (INV-04).
const INSERT_PROMPT = `INSERT INTO prompts
  (source_file_id, line_no, ts, project_id, raw_project, session_id, display_preview, display_chars)
  VALUES (@sourceFileId, @lineNo, @ts, NULL, @rawProject, @sessionId, @displayPreview, @displayChars)
  ON CONFLICT(source_file_id, line_no) DO NOTHING`;

const UPSERT_STATS_CACHE_DAY = `INSERT INTO stats_cache_days (day, raw_json, source_file_id)
  VALUES (?, ?, ?)
  ON CONFLICT(day) DO UPDATE SET raw_json = excluded.raw_json, source_file_id = excluded.source_file_id`;

// ---------------------------------------------------------------------------------------
// FINALIZING (§5.2) — every cross-file derivation, recomputed from current table contents.
// ---------------------------------------------------------------------------------------

// §3.4 — `git_branch` / `cli_version` are "last non-null observed". "Last" is ordered by
// (ts, line_no, event_key): all three are stored, deterministic values. Ordering by `id`
// would order by INSERT order instead, which differs between a cold parse and an append —
// the exact asymmetry INV-04 forbids.
const RECOMPUTE_SESSION_BOUNDS = `UPDATE sessions SET
  first_ts = (SELECT MIN(e.ts) FROM events e WHERE e.session_id = sessions.id),
  last_ts  = (SELECT MAX(e.ts) FROM events e WHERE e.session_id = sessions.id),
  git_branch = (SELECT e.git_branch FROM events e
                 WHERE e.session_id = sessions.id AND e.git_branch IS NOT NULL
                 ORDER BY e.ts DESC, e.line_no DESC, e.event_key DESC LIMIT 1),
  cli_version = (SELECT e.cli_version FROM events e
                  WHERE e.session_id = sessions.id AND e.cli_version IS NOT NULL
                  ORDER BY e.ts DESC, e.line_no DESC, e.event_key DESC LIMIT 1)`;

const RECOMPUTE_PROJECT_BOUNDS = `UPDATE projects SET
  first_ts = (SELECT MIN(e.ts) FROM events e WHERE e.project_id = projects.id),
  last_ts  = (SELECT MAX(e.ts) FROM events e WHERE e.project_id = projects.id)`;

/**
 * §3.3 / §3.5 (both AMENDED 2026-07-22) — the project's display name, re-derived from the
 * folder its work actually happened in.
 *
 * ⚠️ THE BUG THIS FIXES. §3.3 used to define `display_name` as "the last path-like segment of
 * the decoded `encoded_name`". Claude encodes a path by replacing every non-alphanumeric
 * character with `-`, so the decode is **lossy and ambiguous**: a folder whose own name
 * contains a hyphen is indistinguishable from two nested folders. `Home-Media-Server` showed
 * as "Server", `Photo-Booth` as "Booth", `Portfolio-Site` as "Site". No amount of cleverness
 * recovers the lost characters from the encoded name alone — the information is gone.
 *
 * ⚠️ `events.cwd` is the only unambiguous source, so §3.5's "never rendered" is amended to
 * **basename only** (P-33, §7.8). The absolute path is never selected, never returned, never
 * logged and never crosses IPC; only the last segment leaves this statement. §3.8 already sets
 * that precedent for `file_touches.path`.
 *
 * THE RULE, stated once (`chosen` below is its implementation):
 *
 *   1. The encoding is **character-for-character**, so the project's root path is exactly the
 *      first `length(encoded_name)` characters of any `cwd` inside it. That prefix is ANCHORED
 *      when it re-encodes to `encoded_name` — `GLOB replace(encoded_name, '-', '[^a-zA-Z0-9]')`
 *      is that test, exactly: every alphanumeric must match literally, and every `-` must stand
 *      over a non-alphanumeric. Anchoring is what makes this a *disambiguation* of the identity
 *      rather than a second, competing source of truth for it.
 *   2. A `cwd` deeper than the project root (the user `cd`s into a subdirectory mid-session —
 *      real, and observed) still anchors, because the prefix is taken at the root's length and
 *      the next character must be `/`. Taking the basename of the raw `cwd` would have named
 *      one real project after its `website/` subfolder.
 *   3. Events may disagree. The winner is the **most frequent** anchored root, ties broken
 *      **lexicographically ascending** — a total order over stored values, so an append and a
 *      cold parse agree (INV-04).
 *   4. **No anchor, no change.** A project whose events carry no usable `cwd` keeps the
 *      insert-time fallback — today's decoded `encoded_name` (`displayNameForEncodedProject`).
 *      Never unnamed, never empty.
 *
 * ⚠️ `encoded_name` remains the identity (§3.3). This value is still cosmetic, and two
 * projects may still legitimately share one — with this rule two `Photo-Booth`
 * directories both read `Photo-Booth`, which is correct; the UI disambiguates with the encoded
 * name in a tooltip.
 *
 * ⚠️ Migration `0006-project-display-name-from-cwd.sql` carries this statement verbatim, so
 * databases that already exist are corrected at upgrade rather than waiting for the next file
 * to change. `migrate.test.ts` asserts the two are the same text — one rule, in one place.
 */
export const RECOMPUTE_PROJECT_DISPLAY_NAMES = `WITH anchored AS (
  SELECT p.id                                      AS project_id,
         substr(e.cwd, 1, length(p.encoded_name))  AS root,
         COUNT(*)                                  AS events
    FROM events e
    JOIN projects p ON p.id = e.project_id
   WHERE e.cwd IS NOT NULL
     AND (length(e.cwd) = length(p.encoded_name)
          OR substr(e.cwd, length(p.encoded_name) + 1, 1) = '/')
     AND substr(e.cwd, 1, length(p.encoded_name))
         GLOB replace(p.encoded_name, '-', '[^a-zA-Z0-9]')
   GROUP BY p.id, root
), folder AS (
  -- The last path segment, and ONLY it: \`rtrim(root, <root without its slashes>)\` strips
  -- everything after the final '/', so the absolute prefix never leaves this CTE.
  SELECT project_id,
         substr(root, length(rtrim(root, replace(root, '/', ''))) + 1) AS name,
         SUM(events) AS events
    FROM anchored
   GROUP BY project_id, name
  HAVING name <> ''
), chosen AS (
  SELECT project_id, name FROM (
    SELECT project_id, name,
           ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY events DESC, name ASC) AS pick
      FROM folder)
   WHERE pick = 1
)
UPDATE projects SET display_name = (SELECT c.name FROM chosen c WHERE c.project_id = projects.id)
 WHERE EXISTS (SELECT 1 FROM chosen c WHERE c.project_id = projects.id)`;

const RECOMPUTE_RUN_BOUNDS = `UPDATE subagent_runs SET
  first_ts = (SELECT MIN(e.ts) FROM events e WHERE e.source_file_id = subagent_runs.transcript_file_id),
  last_ts  = (SELECT MAX(e.ts) FROM events e WHERE e.source_file_id = subagent_runs.transcript_file_id)`;

// §3.9 — best-effort match of the literal `project` value onto a project. An exact
// `encoded_name` match wins; otherwise the path-encoded form (`/` → `-`, §5.4 rule 6's
// layout) is tried. No match leaves `project_id` NULL with `raw_project` kept verbatim,
// which §3.9 states is a first-class outcome, not a failure.
const RESOLVE_PROMPT_PROJECTS = `UPDATE prompts SET project_id = (
    SELECT p.id FROM projects p
     WHERE p.encoded_name = prompts.raw_project
        OR p.encoded_name = REPLACE(prompts.raw_project, '/', '-')
     ORDER BY (p.encoded_name = prompts.raw_project) DESC, p.encoded_name ASC
     LIMIT 1)
  WHERE prompts.project_id IS NULL AND prompts.raw_project IS NOT NULL`;

// §3.4 — "`is_partial = 1` when prompts reference this `sessionId` but no transcript file
// exists for it (M-16)."
const RECOMPUTE_SESSION_PARTIAL = `UPDATE sessions SET is_partial = CASE
    WHEN transcript_file_id IS NULL
     AND EXISTS (SELECT 1 FROM prompts pr WHERE pr.session_id = sessions.id) THEN 1
    ELSE 0 END`;

/**
 * §3.7 (AMENDED 2026-07-22) — spawn linkage: **structural, best-effort, and never a
 * heuristic.**
 *
 * ⚠️ WHAT WAS SPECIFIED, AND WHY IT NEVER FIRED. §3.7 said: take the run's earliest event,
 * resolve its `parent_uuid` against `events.uuid`, and if that event is an assistant event
 * carrying an `Agent` tool call, fill all four columns. On the reporting user's real data
 * that resolved **0 of 2,514** runs — not intermittently, never — because the run's earliest
 * event has **no `parent_uuid` at all**. Measured: of 237,606 subagent-origin events exactly
 * 2,515 carry a NULL `parent_uuid`, precisely one per run, and **zero** subagent events
 * resolve to a main-loop event. The uuid chain is per-file; it does not cross the file
 * boundary. The rule was not mis-implemented — it was written over an edge that is not there.
 * It is kept below, exactly as specified, as the second source: it costs nothing, and if a
 * future on-disk layout starts writing that edge it starts working.
 *
 * ⚠️ WHAT RESOLVES INSTEAD. Every `subagents/<run-id>.jsonl` has a sibling
 * `<run-id>.meta.json` carrying `agentType`, `description` and `toolUseId` — the spawning
 * `Agent` call's `tool_use_id`, which joins to §3.6 `tool_calls.tool_use_id` exactly. It sits
 * in the run's own directory, which makes it **more** structural than the uuid chain, not
 * less: it is the same kind of evidence ADR-020 prefers over the record-level `isSidechain`
 * flag. `src/main/parse/subagent-meta.ts` reads it into `meta_agent_type` /
 * `meta_tool_use_id` / `meta_description` (migration 0008) before this statement runs.
 *
 * ⚠️ IT IS NOT A COMPETING SOURCE. On the reference dataset the sidecar's `agentType` and the
 * linked `Agent` call's `subagent_type` agree on 2,334 of 2,334 runs where both are known
 * — zero disagreements — and `description` agrees on 2,438 of 2,438. The sidecar additionally
 * names the agent for 104 runs whose `Agent` call carried no `subagent_type` in its input,
 * which is why it wins the `COALESCE` rather than merely filling gaps behind the tool call.
 *
 * ⚠️ STILL NO HEURISTIC, AND STILL DISCLOSED. There is no timestamp proximity, no
 * nearest-preceding `Agent` call and no "the only candidate in that window" here or anywhere
 * (§3.7, ADR-020). A run with no sidecar and no resolvable chain keeps
 * `spawn_event_id IS NULL`, is counted by `unlinkedSubagentRuns()` and is disclosed (§4.6,
 * §6.6, §6.7). A sidecar naming a `toolUseId` that matches no tool call fills the LABEL and
 * leaves the LINK null — partial knowledge, never all-or-nothing. Totals are unaffected in
 * every one of those cases, because attribution is the path and linkage is only a label.
 *
 * ⚠️ IT IS A FULL RECOMPUTE, over every run, from current table contents. There is no
 * `WHERE spawn_event_id IS NULL` guard on the derivation: the four columns are a pure
 * function of the sidecar columns, `events` and `tool_calls`, so an append and a cold parse
 * produce the same values (INV-04). Every ordering below is over stored, deterministic values
 * — never over `id`, which is insertion order and differs between the two. The trailing
 * `IS NOT` test writes only the rows whose computed value actually changed; it narrows what
 * is WRITTEN, never what is COMPUTED, so it cannot alter the result (and `IS NOT` is
 * null-safe, which `<>` is not).
 *
 * ⚠️ Measured on the reference dataset (2,516 runs, 87,653 tool calls, 290,606 events):
 * 122 ms on the first pass, 16–24 ms once nothing changes. The `chain` half alone cost 442 ms
 * before this change, because it re-derived every run's earliest event on every cycle and
 * — resolving nothing — never shrank its own working set. Restricting it to the runs the
 * sidecar did not already resolve is what pays for the sidecar half and then some (P-03).
 */
const RESOLVE_SPAWN_LINKS = `UPDATE subagent_runs
   SET spawn_event_id = src.event_id,
       spawn_tool_call_id = src.tool_call_id,
       subagent_type = src.subagent_type,
       description = src.description
  FROM (
    WITH sidecar AS (
      -- The run's own directory, via §3.6 \`tool_calls.tool_use_id\`. \`tool_name = 'Agent'\`
      -- is required: a \`toolUseId\` pointing at something that is not an Agent call is not a
      -- spawn point, and the honest answer there is "unlinked", not "close enough".
      --
      -- \`tool_use_id\` has no UNIQUE constraint (§3.6 — it is a value the source states, not a
      -- key this app assigns), so the pick is made explicit rather than left to the planner:
      -- ROW_NUMBER over (ts, the event's \`event_key\`, ordinal), all stored and deterministic.
      -- On the reference dataset there are zero duplicates among 87,653 tool calls, and this
      -- is what keeps that a fact about the data rather than an assumption in the query.
      SELECT run_id, event_id, tool_call_id, subagent_type, description FROM (
        SELECT sr.id AS run_id, tc.event_id AS event_id, tc.id AS tool_call_id,
               tc.subagent_type AS subagent_type, tc.description AS description,
               ROW_NUMBER() OVER (PARTITION BY sr.id
                                  ORDER BY tc.ts ASC, e.event_key ASC, tc.ordinal ASC) AS pick
          FROM subagent_runs sr
          JOIN tool_calls tc ON tc.tool_use_id = sr.meta_tool_use_id AND tc.tool_name = 'Agent'
          JOIN events e ON e.id = tc.event_id
         WHERE sr.meta_tool_use_id IS NOT NULL)
       WHERE pick = 1
    ), chain AS (
      -- §3.7 as originally specified, unchanged in what it accepts. Resolves 0 of 2,514 on
      -- real data; kept because it is the design's own rule, it is deterministic, and if a
      -- future on-disk layout starts writing that edge it starts working with no code change.
      --
      -- ⚠️ Restricted to runs the sidecar did NOT resolve. That is not a precedence decision
      -- smuggled into a WHERE clause — the COALESCE below already prefers the sidecar for
      -- every column — it is the same decision stated where it also costs nothing to compute.
      SELECT sr.id AS run_id, pe.id AS event_id, tc.id AS tool_call_id,
             tc.subagent_type AS subagent_type, tc.description AS description
        FROM subagent_runs sr
        JOIN events fe ON fe.id = (
               SELECT e.id FROM events e
                WHERE e.source_file_id = sr.transcript_file_id
                ORDER BY e.ts ASC, e.line_no ASC, e.event_key ASC LIMIT 1)
        JOIN events pe ON pe.uuid = fe.parent_uuid
        JOIN tool_calls tc ON tc.id = (
               SELECT t.id FROM tool_calls t
                WHERE t.event_id = pe.id AND t.tool_name = 'Agent'
                ORDER BY t.ordinal ASC LIMIT 1)
       WHERE fe.parent_uuid IS NOT NULL
         AND pe.role = 'assistant'
         AND NOT EXISTS (SELECT 1 FROM sidecar sc WHERE sc.run_id = sr.id)
    )
    -- LEFT JOINed from \`subagent_runs\`, so EVERY run gets a row and the recompute can clear
    -- a stale value as readily as it can set a new one.
    SELECT sr.id AS run_id,
           COALESCE(sc.event_id, ch.event_id)                                 AS event_id,
           COALESCE(sc.tool_call_id, ch.tool_call_id)                         AS tool_call_id,
           COALESCE(sr.meta_agent_type, sc.subagent_type, ch.subagent_type)   AS subagent_type,
           COALESCE(sr.meta_description, sc.description, ch.description)      AS description
      FROM subagent_runs sr
      LEFT JOIN sidecar sc ON sc.run_id = sr.id
      LEFT JOIN chain   ch ON ch.run_id = sr.id
  ) AS src
 WHERE subagent_runs.id = src.run_id
   AND (subagent_runs.spawn_event_id     IS NOT src.event_id
     OR subagent_runs.spawn_tool_call_id IS NOT src.tool_call_id
     OR subagent_runs.subagent_type      IS NOT src.subagent_type
     OR subagent_runs.description        IS NOT src.description)`;

const COUNT_UNLINKED_RUNS = 'SELECT COUNT(*) AS n FROM subagent_runs WHERE spawn_event_id IS NULL';
const SUM_BAD_LINES = 'SELECT COALESCE(SUM(bad_lines), 0) AS n FROM file_manifest';
const COUNT_RECORDS = `SELECT
  (SELECT COUNT(*) FROM events)     AS events,
  (SELECT COUNT(*) FROM sessions)   AS sessions,
  (SELECT COUNT(*) FROM projects)   AS projects,
  (SELECT COUNT(*) FROM tool_calls) AS toolCalls,
  (SELECT COUNT(*) FROM prompts)    AS prompts`;

export class IngestRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Runs `body` in one transaction — §5.2 rule 3, "every file is committed in its own". */
  inTransaction<Result>(body: () => Result): Result {
    return this.transaction(body);
  }

  /** §3.3 / §5.4 rule 6 — upserted by `encoded_name`. */
  upsertProject(input: UpsertProjectInput): number {
    this.run(UPSERT_PROJECT, {
      encodedName: input.encodedName,
      displayName: input.displayName,
      colorIndex: input.colorIndex,
    });
    const row = this.one<{ id: number }>(SELECT_PROJECT_ID, input.encodedName);
    if (row === undefined) throw new Error(`project row vanished: ${input.encodedName}`);
    return row.id;
  }

  upsertSession(input: UpsertSessionInput): void {
    this.run(UPSERT_SESSION, {
      sessionId: input.sessionId,
      projectId: input.projectId,
      transcriptFileId: input.transcriptFileId,
    });
  }

  /**
   * §3.5, ADR-019 — `ON CONFLICT(event_key) DO NOTHING`.
   * Returns `{ id, inserted }`: `inserted: false` is the deduplicated case, which the caller
   * counts separately and never treats as an error (§5.12 "first ingested wins").
   */
  insertEvent(input: InsertEventInput): { id: number; inserted: boolean } {
    const result = this.run(INSERT_EVENT, { ...input });
    if (result.changes > 0) return { id: Number(result.lastInsertRowid), inserted: true };
    const row = this.one<{ id: number }>(SELECT_EVENT_ID, input.eventKey);
    if (row === undefined) throw new Error(`event row vanished: ${input.eventKey}`);
    return { id: row.id, inserted: false };
  }

  /** §3.6 — idempotent on `UNIQUE (event_id, ordinal)`. */
  insertToolCall(input: InsertToolCallInput): number {
    const result = this.run(INSERT_TOOL_CALL, { ...input });
    if (result.changes > 0) return Number(result.lastInsertRowid);
    const row = this.one<{ id: number }>(SELECT_TOOL_CALL_ID, input.eventId, input.ordinal);
    if (row === undefined) throw new Error(`tool_call row vanished: event ${input.eventId}`);
    return row.id;
  }

  /** §3.8 — one row per write-class tool call that named a path. */
  insertFileTouch(input: InsertFileTouchInput): void {
    this.run(INSERT_FILE_TOUCH, { ...input });
  }

  /** §3.7 — one run per subagent transcript file; attribution is the path, never inferred. */
  upsertSubagentRun(sessionId: string, projectId: number, transcriptFileId: number): number {
    this.run(UPSERT_SUBAGENT_RUN, sessionId, projectId, transcriptFileId);
    const row = this.one<{ id: number }>(SELECT_SUBAGENT_RUN_ID, transcriptFileId);
    if (row === undefined) throw new Error(`subagent_run row vanished: file ${transcriptFileId}`);
    return row.id;
  }

  /**
   * §3.7 (amended) — the runs whose `agent-*.meta.json` has not been read into the row yet.
   * Archived transcripts are excluded: they are never re-read (§5.3 `ARCHIVED`, ADR-034).
   */
  subagentRunsMissingMeta(): readonly SubagentRunFile[] {
    return this.all<SubagentRunFile>(SELECT_RUNS_MISSING_META);
  }

  /**
   * §3.7 (amended) — stores one run's sidecar verbatim. Called at FINALIZING, before
   * `RESOLVE_SPAWN_LINKS` recomputes the derived columns from it.
   *
   * ⚠️ Writing all three fields, including the `null`s, is deliberate: it is an assignment,
   * not a merge, so re-reading a sidecar that has lost a field cannot leave the old value
   * behind. Nothing here is accumulated (INV-04).
   */
  recordSubagentMeta(rows: readonly RecordSubagentMetaInput[]): void {
    if (rows.length === 0) return;
    this.transaction(() => {
      for (const row of rows) {
        this.run(RECORD_SUBAGENT_META, {
          id: row.id,
          agentType: row.agentType,
          toolUseId: row.toolUseId,
          description: row.description,
        });
      }
    });
  }

  /** §3.9 — idempotent on `UNIQUE (source_file_id, line_no)`. */
  insertPrompt(input: InsertPromptInput): boolean {
    return this.run(INSERT_PROMPT, { ...input }).changes > 0;
  }

  /** §3.16 — the per-day object, verbatim. Never summed into anything (ADR-029). */
  upsertStatsCacheDay(day: string, rawJson: string, sourceFileId: number): void {
    this.run(UPSERT_STATS_CACHE_DAY, day, rawJson, sourceFileId);
  }

  /** §5.2 FINALIZING — every cross-file derivation, in one transaction. */
  finalize(): void {
    this.transaction(() => {
      this.run(RECOMPUTE_SESSION_BOUNDS);
      this.run(RECOMPUTE_PROJECT_BOUNDS);
      // §3.3 (amended) — after the project rows exist and their events are committed; the
      // name is a function of the events, so it is recomputed, never accumulated.
      this.run(RECOMPUTE_PROJECT_DISPLAY_NAMES);
      this.run(RECOMPUTE_RUN_BOUNDS);
      this.run(RESOLVE_PROMPT_PROJECTS);
      this.run(RECOMPUTE_SESSION_PARTIAL);
      this.run(RESOLVE_SPAWN_LINKS);
    });
  }

  /** §4.6 — disclosed, never logged: runs with no resolvable spawn point (§3.7). */
  unlinkedSubagentRuns(): number {
    return this.one<{ n: number }>(COUNT_UNLINKED_RUNS)?.n ?? 0;
  }

  /** §4.6 — malformed JSON lines skipped across all files (§5.4 rule 1). */
  badLineTotal(): number {
    return this.one<{ n: number }>(SUM_BAD_LINES)?.n ?? 0;
  }

  /** §3.17 `recordCounts` — sync bookkeeping, never a displayed metric (ADR-027). */
  recordCounts(): IngestCounts {
    const row = this.one<IngestCounts>(COUNT_RECORDS);
    return row ?? { events: 0, sessions: 0, projects: 0, toolCalls: 0, prompts: 0 };
  }
}
