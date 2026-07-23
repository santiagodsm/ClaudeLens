-- =====================================================================================
-- Migration 0001 — the initial schema.
--
-- DESIGN §3 preamble: "§3.2–§3.17 IS migration 0001 and must match it exactly."
-- Every CREATE TABLE, every CHECK, every index below is transcribed verbatim from the
-- DDL blocks of DESIGN.md §3.2 through §3.17. Do not "tidy" it: the design document and
-- this file are diffed against each other by `db-migration-review` (§12.2).
--
-- ⚠️ MERGED MIGRATION FILES ARE IMMUTABLE (STACK ADR-007, §3.18). Once this file has
-- shipped, a schema change is a NEW numbered file — never an edit to this one. There is
-- no "drop the database and re-sync" path anywhere in the codebase (§9.6, ADR-026):
-- `price_rows`, `settings`, `audit_log` and `archives` are USER class with no other
-- source, and rows with `archive_id IS NOT NULL` are RETAINED and no longer derivable
-- (§2.2, ADR-033).
--
-- `PRAGMA user_version` is set by the runner (src/main/db/migrate.ts), not here, so that
-- the version bump and the DDL commit or roll back as one unit.
--
-- ---------------------------------------------------------------------------------
-- CREATION ORDER AND THE CIRCULAR REFERENCE  (§3.2, §3.4, §3.15)
-- ---------------------------------------------------------------------------------
-- The schema contains a genuine reference cycle:
--
--     file_manifest.archive_id ──> archives(id)      (ADR-033: the RETAINED marker)
--     sessions.archive_id      ──> archives(id)
--     archives.audit_id        ──> audit_log(id)     (§3.15: the ACT-07 entry)
--     events.subagent_run_id   ──> subagent_runs(id) ⟷ subagent_runs.spawn_event_id ──> events(id)
--
-- It is resolved BY CREATION ORDER, not by dropping a constraint. SQLite resolves a
-- foreign key's parent table lazily — at DML time, not at CREATE TABLE time — so a table
-- may legally be created with a REFERENCES clause naming a table that does not exist yet.
-- Every constraint in the design is therefore present, in full, with its exact
-- ON DELETE action; the tables are simply created in the order below and the cycle
-- closes when the last one lands. `PRAGMA foreign_keys` is left ON throughout: nothing
-- in this file performs DML, so there is nothing to resolve until the app writes a row.
--
-- Order (FK-safe for the acyclic majority, forward-declared for the cycle):
--   file_manifest, projects, sessions, events, tool_calls, subagent_runs, file_touches,
--   prompts, harness_nodes, harness_edges, price_rows, bloat_flags, settings, audit_log,
--   archives, stats_cache_days, meta
--
-- ⚠️ Dropping `archives` while any `file_manifest` or `sessions` row still points at it is
-- prevented by ON DELETE RESTRICT on both referencing columns (§3.15) — that is what makes
-- a migration unable to quietly orphan RETAINED rows.
-- =====================================================================================

-- §3.2 `file_manifest` — DERIVED — incremental-sync bookkeeping
CREATE TABLE file_manifest (
  id            INTEGER PRIMARY KEY,
  rel_path      TEXT    NOT NULL UNIQUE,        -- POSIX, relative to claudeDir
  kind          TEXT    NOT NULL CHECK (kind IN (
                  'transcript','subagent_transcript','history','stats_cache',
                  'skill_md','agent_md','claude_md','settings_json','plugin_manifest',
                  'memory_md','other')),
  size_bytes    INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  byte_offset   INTEGER NOT NULL DEFAULT 0,     -- bytes already consumed; resume point (§5.3)
  lines_parsed  INTEGER NOT NULL DEFAULT 0,
  bad_lines     INTEGER NOT NULL DEFAULT 0,     -- malformed JSON lines skipped; disclosed (§4.6)
  content_hash  TEXT,                           -- sha256; non-JSONL config files only
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  parsed_at     INTEGER,
  -- Archive annotation (ADR-033/034). NULL = live. Non-NULL = RETAINED.
  archive_id       INTEGER REFERENCES archives(id) ON DELETE RESTRICT,
  archive_rel_path TEXT                          -- POSIX, relative to archives.archive_root
);
CREATE INDEX idx_file_manifest_kind    ON file_manifest(kind);
CREATE INDEX idx_file_manifest_archive ON file_manifest(archive_id) WHERE archive_id IS NOT NULL;

-- §3.3 `projects` — DERIVED
CREATE TABLE projects (
  id           INTEGER PRIMARY KEY,
  encoded_name TEXT    NOT NULL UNIQUE,   -- literal directory name under projects/ — the identity
  display_name TEXT    NOT NULL,          -- decoded, for display ONLY; never an identity (OQ-007)
  color_index  INTEGER NOT NULL CHECK (color_index BETWEEN 0 AND 7),
  first_ts     INTEGER,
  last_ts      INTEGER
);

-- §3.4 `sessions` — DERIVED
-- `span_seconds` is a generated column and NOT a stored aggregate: ADR-027 permits generated
-- columns exactly where the value is a pure function of other columns in the SAME row.
-- No token totals, message counts, tool-call counts, active time or primary model live here.
CREATE TABLE sessions (
  id                 TEXT    PRIMARY KEY,        -- sessionId == transcript file basename
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  transcript_file_id INTEGER REFERENCES file_manifest(id) ON DELETE SET NULL,
  first_ts           INTEGER,
  last_ts            INTEGER,
  span_seconds       INTEGER GENERATED ALWAYS AS ((last_ts - first_ts) / 1000) VIRTUAL,
  git_branch         TEXT,                       -- last non-null observed
  cli_version        TEXT,                       -- last non-null observed
  is_partial         INTEGER NOT NULL DEFAULT 0 CHECK (is_partial IN (0,1)),
  archive_id         INTEGER REFERENCES archives(id) ON DELETE RESTRICT   -- NULL = live (ADR-033)
) WITHOUT ROWID;
CREATE INDEX idx_sessions_project_first_ts ON sessions(project_id, first_ts);
CREATE INDEX idx_sessions_last_ts          ON sessions(last_ts);
CREATE INDEX idx_sessions_archive          ON sessions(archive_id) WHERE archive_id IS NOT NULL;

-- §3.5 `events` — DERIVED — the fact table
-- Ingest is `INSERT ... ON CONFLICT(event_key) DO NOTHING` (ADR-019): re-parsing a file,
-- replaying an append, or meeting the same record in two files can never double-count.
CREATE TABLE events (
  id              INTEGER PRIMARY KEY,
  event_key       TEXT    NOT NULL UNIQUE,      -- uuid, else '<rel_path>#<line_no>'  (ADR-019)
  session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_file_id  INTEGER NOT NULL REFERENCES file_manifest(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,
  ts              INTEGER NOT NULL,             -- UTC epoch ms, normalized on ingest (ADR-021)
  type            TEXT    NOT NULL,             -- raw record `type`, verbatim
  role            TEXT,                         -- 'assistant' | 'user' | NULL
  origin          TEXT    NOT NULL CHECK (origin IN ('main','subagent')),   -- ADR-020
  subagent_run_id INTEGER REFERENCES subagent_runs(id) ON DELETE SET NULL,
  uuid            TEXT,
  parent_uuid     TEXT,
  is_sidechain    INTEGER NOT NULL DEFAULT 0 CHECK (is_sidechain IN (0,1)),
  model           TEXT,                         -- raw message.model, verbatim (ADR-025); NULL if absent
  is_synthetic    INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  is_api_error    INTEGER NOT NULL DEFAULT 0 CHECK (is_api_error IN (0,1)),
  tok_input       INTEGER NOT NULL DEFAULT 0,   -- message.usage.input_tokens
  tok_output      INTEGER NOT NULL DEFAULT 0,   -- message.usage.output_tokens
  tok_cache_write INTEGER NOT NULL DEFAULT 0,   -- message.usage.cache_creation_input_tokens
  tok_cache_read  INTEGER NOT NULL DEFAULT 0,   -- message.usage.cache_read_input_tokens
  git_branch      TEXT,
  cli_version     TEXT,
  cwd             TEXT
);

CREATE INDEX idx_events_session_ts  ON events(session_id, ts);
CREATE INDEX idx_events_project_ts  ON events(project_id, ts);
CREATE INDEX idx_events_ts          ON events(ts);
CREATE INDEX idx_events_file        ON events(source_file_id);
CREATE INDEX idx_events_origin      ON events(session_id, origin);
CREATE INDEX idx_events_parent_uuid ON events(parent_uuid) WHERE parent_uuid IS NOT NULL;
CREATE UNIQUE INDEX uq_events_uuid  ON events(uuid) WHERE uuid IS NOT NULL;

-- Partial index over exactly the population that is priced and counted in model stats.
-- The <synthetic> exclusion made structural rather than remembered.
CREATE INDEX idx_events_priceable ON events(model, ts, id)
  WHERE is_synthetic = 0
    AND model IS NOT NULL
    AND (tok_input + tok_output + tok_cache_write + tok_cache_read) > 0;

-- §3.6 `tool_calls` — DERIVED
-- `UNIQUE (event_id, ordinal)` makes tool-call ingest idempotent alongside ADR-019.
CREATE TABLE tool_calls (
  id             INTEGER PRIMARY KEY,
  event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id     TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  origin         TEXT    NOT NULL CHECK (origin IN ('main','subagent')),
  ts             INTEGER NOT NULL,
  ordinal        INTEGER NOT NULL,        -- index of the tool_use item within message.content[]
  tool_name      TEXT    NOT NULL,        -- includes 'Agent' and 'Skill' (§2.1)
  tool_use_id    TEXT,                    -- content item `id` when present
  skill_name     TEXT,                    -- tool_name='Skill' -> the invoked skill name
  subagent_type  TEXT,                    -- tool_name='Agent' -> input.subagent_type
  target_path    TEXT,                    -- write-class only -> input.file_path / notebook_path
  is_write_class INTEGER NOT NULL DEFAULT 0 CHECK (is_write_class IN (0,1)),
  UNIQUE (event_id, ordinal)
);
CREATE INDEX idx_tool_calls_name_ts    ON tool_calls(tool_name, ts);
CREATE INDEX idx_tool_calls_session_ts ON tool_calls(session_id, ts, ordinal);
CREATE INDEX idx_tool_calls_project_ts ON tool_calls(project_id, ts);
CREATE INDEX idx_tool_calls_skill      ON tool_calls(skill_name) WHERE skill_name IS NOT NULL;

-- §3.7 `subagent_runs` — DERIVED
-- Session attribution is structural (the path); spawn linkage is best-effort and also
-- structural. `spawn_event_id IS NULL` means unlinked, which is DISCLOSED (§4.6), never
-- guessed at with a timestamp-proximity heuristic (ADR-020).
CREATE TABLE subagent_runs (
  id                 INTEGER PRIMARY KEY,
  session_id         TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  transcript_file_id INTEGER NOT NULL UNIQUE REFERENCES file_manifest(id) ON DELETE CASCADE,
  spawn_event_id     INTEGER REFERENCES events(id) ON DELETE SET NULL,      -- NULL = unlinked
  spawn_tool_call_id INTEGER REFERENCES tool_calls(id) ON DELETE SET NULL,
  subagent_type      TEXT,           -- from the spawning Agent tool call, when linked
  description        TEXT,           -- from the spawning Agent tool call, when linked
  first_ts           INTEGER,
  last_ts            INTEGER
);
CREATE INDEX idx_subagent_runs_session ON subagent_runs(session_id, first_ts);
CREATE INDEX idx_subagent_runs_type    ON subagent_runs(subagent_type) WHERE subagent_type IS NOT NULL;

-- §3.8 `file_touches` — DERIVED
-- `path` is verbatim from the tool input and may be an absolute personal path — the second
-- of the two deliberate §3.1.4 exceptions. It is rendered basename-first (§6.8).
CREATE TABLE file_touches (
  id           INTEGER PRIMARY KEY,
  tool_call_id INTEGER NOT NULL UNIQUE REFERENCES tool_calls(id) ON DELETE CASCADE,
  session_id   TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ts           INTEGER NOT NULL,
  path         TEXT    NOT NULL,   -- verbatim from the tool input; may be absolute (§3.1.4 exception)
  basename     TEXT    NOT NULL,
  extension    TEXT,               -- lowercased, no dot; NULL when the basename has none
  language     TEXT,               -- from the §5.9 M-15 extension map; NULL when unmapped
  tool_name    TEXT    NOT NULL
);
CREATE INDEX idx_file_touches_project_ts ON file_touches(project_id, ts);
CREATE INDEX idx_file_touches_session    ON file_touches(session_id);
CREATE INDEX idx_file_touches_language   ON file_touches(language) WHERE language IS NOT NULL;

-- §3.9 `prompts` — DERIVED
-- `session_id` is deliberately NOT a foreign key: a prompt may name a session with no
-- transcript. That is a partial-data period (M-16), not an error.
-- ⚠️ `pastedContents` is never stored, in any form.
CREATE TABLE prompts (
  id              INTEGER PRIMARY KEY,
  source_file_id  INTEGER NOT NULL REFERENCES file_manifest(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,
  ts              INTEGER NOT NULL,     -- normalized from ms epoch (HANDOFF §4)
  project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  raw_project     TEXT,                 -- literal `project` value, kept when it matches no project
  session_id      TEXT,                 -- NOT a FK: may name a session with no transcript
  display_preview TEXT,                 -- first 280 characters of `display`
  display_chars   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_file_id, line_no)
);
CREATE INDEX idx_prompts_ts      ON prompts(ts);
CREATE INDEX idx_prompts_project ON prompts(project_id, ts);

-- §3.10 `harness_nodes` / `harness_edges` — DERIVED
-- The runtime overlay is NOT stored (ADR-027); harnessGraph() computes it at query time.
-- ⚠️ Parsed harness text is data, never instructions (STACK ADR-017).
CREATE TABLE harness_nodes (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN (
                'skill','agent','command','tool','file','plugin','marketplace',
                'memory','claude_md','settings')),
  name        TEXT NOT NULL,        -- SKILL.md frontmatter `name`, tool name, or file basename
  source      TEXT NOT NULL CHECK (source IN ('user','plugin','builtin','transcript')),
  plugin_id   INTEGER REFERENCES harness_nodes(id) ON DELETE CASCADE,
  rel_path    TEXT,                 -- relative to claudeDir; NULL for tool nodes
  role        TEXT,                 -- metadata.role, e.g. 'orchestrator'
  description TEXT,
  size_bytes  INTEGER NOT NULL DEFAULT 0,   -- on-disk size of rel_path, recursive for directories
  mtime_ms    INTEGER,
  enabled     INTEGER CHECK (enabled IN (0,1)),  -- plugins/marketplaces; NULL where not applicable
  file_id     INTEGER REFERENCES file_manifest(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_harness_nodes ON harness_nodes(kind, name, source, COALESCE(rel_path, ''));
CREATE INDEX idx_harness_nodes_kind ON harness_nodes(kind);

CREATE TABLE harness_edges (
  id       INTEGER PRIMARY KEY,
  from_id  INTEGER NOT NULL REFERENCES harness_nodes(id) ON DELETE CASCADE,
  to_id    INTEGER NOT NULL REFERENCES harness_nodes(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('handoff','tool_grant','reads','writes','contains')),
  evidence TEXT NOT NULL CHECK (evidence IN ('frontmatter','body_mention','directory')),
  UNIQUE (from_id, to_id, kind)
);
CREATE INDEX idx_harness_edges_from ON harness_edges(from_id);
CREATE INDEX idx_harness_edges_to   ON harness_edges(to_id);

-- §3.11 `price_rows` — USER — bi-temporal, four token classes
-- ⚠️ USER class: never purged, never dropped, never truncated by a migration (INV-12).
-- Hand-edited rates and hand-corrected effective dates have NO other source.
-- `rate_picousd_per_token = USD per 1M tokens × 1e6` (ADR-023, amended): $0.3125/Mtok is
-- exactly 312_500 picoUSD/token, which nanoUSD could only have represented by rounding —
-- and rounding a RATE multiplies straight into every total that uses it.
-- Non-overlap (INV-08) has no SQLite exclusion constraint; the repository asserts it inside
-- the same write transaction and aborts with E_PRICE_OVERLAP (ADR-024).
CREATE TABLE price_rows (
  id                     INTEGER PRIMARY KEY,
  model                  TEXT    NOT NULL,     -- EXACT raw message.model string (ADR-025)
  token_class            TEXT    NOT NULL CHECK (token_class IN
                           ('input','output','cache_write','cache_read')),
  rate_picousd_per_token INTEGER NOT NULL CHECK (rate_picousd_per_token >= 0),  -- ADR-023 (amended)
  valid_from             INTEGER NOT NULL,     -- UTC epoch ms, INCLUSIVE
  valid_to               INTEGER,              -- UTC epoch ms, EXCLUSIVE; NULL = still in effect
  source                 TEXT    NOT NULL CHECK (source IN ('seed','fetch','manual')),
  source_url             TEXT,                 -- set when source='fetch'
  note                   TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- The covering index for the bi-temporal join (STACK ADR-007).
CREATE INDEX idx_price_rows_cover
  ON price_rows(model, token_class, valid_from, valid_to, rate_picousd_per_token);

-- At most ONE open-ended row per (model, token_class). Enforced by the engine, not by review.
CREATE UNIQUE INDEX uq_price_rows_open
  ON price_rows(model, token_class) WHERE valid_to IS NULL;

-- §3.12 `bloat_flags` — DERIVED
-- Fully replaced on each harness scan (DELETE then insert, one transaction), so a resolved
-- issue disappears. `action_type IS NULL` renders as a flag with no button (§6.8, §11.2).
CREATE TABLE bloat_flags (
  id             INTEGER PRIMARY KEY,
  rule_id        TEXT    NOT NULL,      -- BR-01 … BR-06 (§5.11)
  severity       TEXT    NOT NULL CHECK (severity IN ('high','medium','low')),
  title          TEXT    NOT NULL,
  location       TEXT    NOT NULL,      -- rel_path or rel_path glob, relative to claudeDir
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  item_count     INTEGER NOT NULL DEFAULT 1,
  rationale      TEXT    NOT NULL,      -- "why flagged", rendered verbatim
  action_type    TEXT,                  -- a §5.7 catalogue id, or NULL = no action in v1
  action_payload TEXT,                  -- JSON, validated against that action's payload schema
  detected_at    INTEGER NOT NULL,
  UNIQUE (rule_id, location)
);
CREATE INDEX idx_bloat_flags_severity ON bloat_flags(severity, size_bytes DESC);

-- §3.13 `settings` — USER
-- ⚠️ USER class: never purged (INV-12). All app state persists here.
-- `electron-store` is not used (ADR-030): one persistence store, one migration chain,
-- one backup story. The typed key/default table lives in src/main/db/settings-repo.ts.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT    NOT NULL,     -- JSON-encoded scalar or object
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- §3.14 `audit_log` — USER — the guarded-action trail
-- ⚠️ No row of `audit_log` is ever deleted. `backup_present` is set to 0 by ACT-06 for
-- entries whose restore point it removed — the entry survives as history with its undo
-- capability honestly withdrawn.
-- `claude_dir` is absolute: the first of the two deliberate §3.1.4 exceptions.
CREATE TABLE audit_log (
  id              INTEGER PRIMARY KEY,
  action_type     TEXT    NOT NULL,     -- a §5.7 catalogue id
  status          TEXT    NOT NULL CHECK (status IN
                    ('completed','failed_partial','failed','undone')),
  claude_dir      TEXT    NOT NULL,     -- absolute path at the time of the action (§3.1.4 exception)
  target_summary  TEXT    NOT NULL,     -- human-readable, e.g. '24 orphaned skill folders'
  targets_json    TEXT    NOT NULL,     -- JSON array of rel_paths ACTUALLY acted on
  bytes_affected  INTEGER NOT NULL DEFAULT 0,
  backup_rel_path TEXT,                 -- '.claude-lens-backups/<iso>-<id>'; NULL if nothing copied
  backup_bytes    INTEGER NOT NULL DEFAULT 0,
  backup_present  INTEGER NOT NULL DEFAULT 1 CHECK (backup_present IN (0,1)),
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  undone_at       INTEGER,
  undo_of_id      INTEGER REFERENCES audit_log(id),
  error_code      TEXT,
  error_detail    TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_audit_log_started  ON audit_log(started_at DESC);
CREATE INDEX idx_audit_log_undoable ON audit_log(started_at DESC)
  WHERE status = 'completed' AND undone_at IS NULL AND backup_present = 1;

-- §3.15 `archives` — USER — the permanent record of what was archived and where
-- ⚠️ USER class: never purged, never dropped, never auto-deleted (INV-12). An archive you
-- cannot find is a delete with extra steps. `reachable = 0` is informational ONLY — it
-- never deletes a row, never marks data partial and never changes a metric (ADR-033).
-- The ON DELETE RESTRICT on file_manifest.archive_id and sessions.archive_id means a
-- migration cannot remove an `archives` row while any file or session still points at it.
CREATE TABLE archives (
  id             INTEGER PRIMARY KEY,
  audit_id       INTEGER NOT NULL REFERENCES audit_log(id),   -- the ACT-07 entry that created it
  archive_root   TEXT    NOT NULL,     -- ABSOLUTE path, outside claudeDir (§3.1.4 exception)
  claude_dir     TEXT    NOT NULL,     -- the claudeDir the files were moved OUT of
  session_count  INTEGER NOT NULL,
  file_count     INTEGER NOT NULL,
  bytes_moved    INTEGER NOT NULL,
  range_from_ts  INTEGER,              -- earliest event ts among the archived sessions
  range_to_ts    INTEGER,              -- latest
  last_reachable_at INTEGER,           -- last sync at which archive_root was readable; NULL = never
  reachable      INTEGER NOT NULL DEFAULT 1 CHECK (reachable IN (0,1)),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_archives_created ON archives(created_at DESC);

-- §3.16 `stats_cache_days` — DERIVED — coverage metadata only
-- ⚠️ No value from this table is ever summed into, substituted into, or reconciled against
-- a displayed metric (ADR-029). Its only use is day-presence, which feeds M-16.
CREATE TABLE stats_cache_days (
  day            TEXT    PRIMARY KEY,      -- exactly as the file keys it
  raw_json       TEXT    NOT NULL,         -- the per-day object, verbatim
  source_file_id INTEGER NOT NULL REFERENCES file_manifest(id) ON DELETE CASCADE
) WITHOUT ROWID;

-- §3.17 `meta` — DERIVED — sync bookkeeping
-- `meta` is DERIVED; `settings` is USER (ADR-026). Anything a rebuild can recompute belongs
-- here, and nothing else does. That is why a purge truncates this table and never touches
-- `settings` (§3.18).
CREATE TABLE meta (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
