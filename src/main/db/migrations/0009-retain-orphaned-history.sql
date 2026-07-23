-- =====================================================================================
-- Migration 0009 — permanent history retention for ORPHANED transcripts.
--
-- ⚠️ A NEW numbered file, never an edit to 0001–0008: merged migration files are IMMUTABLE
-- (STACK ADR-007, §3.18). 0001–0008 are untouched.
--
-- WHY (§2.2, §3.2, §5.3, §3.18 AMENDED 2026-07-22, ADR-041):
--
--   Until now, a transcript that vanished from `<claudeDir>` was classified `MISSING` (§5.3):
--   its `file_manifest` row was deleted and the cascade took its events, tool_calls,
--   subagent_runs and file_touches with it. So when Claude (or the user) deleted a transcript,
--   the very next sync SILENTLY SHRANK every lifetime total — the project's defining failure
--   (CLAUDE.md §1), arriving through the same door ADR-033 closed for archiving.
--
--   Archiving already solved this for files the app MOVES: the RETAINED class (§2.2), carried by
--   `file_manifest.archive_id` / `sessions.archive_id`, keeps the parsed rows and spares them
--   from every purge (§3.18) and from the `MISSING` classifier (§5.3 `ARCHIVED`). Orphan
--   retention is a SECOND road into that same RETAINED class — but it is NOT archiving. There is
--   no archive root, no moved file, no `archives` row and nothing to undo, because the file is
--   simply GONE. It therefore cannot reuse `archive_id` (which per ADR-034 implies a recoverable
--   `archives` location); it needs its own marker.
--
--   The setting `retainOrphanedHistory` (§3.13, default TRUE) governs the transition. ON: a
--   `MISSING` transcript is marked retained-orphan and every row is KEPT (ADR-041). OFF: the
--   old delete-and-cascade behaviour stands, so a user who wants a pure mirror keeps it.
--
-- Additive DDL plus two partial indexes. No row is deleted, no table is dropped, no fact table
-- is rewritten, and `price_rows`, `settings`, `audit_log` and `archives` are not named
-- (INV-12, §12.2 `db-migration-review`). Retention changes no metric (INV-18): a retained-orphan
-- session's events, tokens, tool calls and active time contribute to every total exactly as they
-- did the moment before the file disappeared.
-- =====================================================================================

-- §3.2 — the retention marker on `file_manifest`, distinct from `archive_id` (ADR-041).
-- 0 = a live or already-purged file. 1 = the file is gone from `<claudeDir>` and its parsed
-- rows are RETAINED (§2.2): structurally derived but no longer derivable, because a rescan will
-- never reproduce a file that no longer exists. The purge predicate (§3.18) spares these rows
-- alongside `archive_id IS NOT NULL` ones. The DEFAULT 0 is the only legal constant here — a
-- backfilled row is a file we still have (it was in the last sync), so it is not an orphan.
ALTER TABLE file_manifest
  ADD COLUMN retained_orphan INTEGER NOT NULL DEFAULT 0 CHECK (retained_orphan IN (0, 1));

-- §3.4 — the session-level mirror, exactly as `sessions.archive_id` mirrors the file's
-- `archive_id` for archiving. A session is retained-orphan (= 1) when AT LEAST ONE of its source
-- files became an orphan; the purge must then spare the SESSION row too, or the sessions delete
-- would cascade the retained events away (`events.session_id ... ON DELETE CASCADE`, §3.5). It is
-- set and cleared from the current `file_manifest` state at classification time (§5.3), never
-- accumulated (INV-04).
ALTER TABLE sessions
  ADD COLUMN retained_orphan INTEGER NOT NULL DEFAULT 0 CHECK (retained_orphan IN (0, 1));

-- The seeks the purge guard and the §4.6 disclosure count make. Partial, so they cost nothing
-- for the common case where nothing has been orphaned — mirroring `idx_file_manifest_archive`
-- and `idx_sessions_archive` (§3.2, §3.4).
CREATE INDEX IF NOT EXISTS idx_file_manifest_retained_orphan
  ON file_manifest(retained_orphan) WHERE retained_orphan = 1;
CREATE INDEX IF NOT EXISTS idx_sessions_retained_orphan
  ON sessions(retained_orphan) WHERE retained_orphan = 1;
