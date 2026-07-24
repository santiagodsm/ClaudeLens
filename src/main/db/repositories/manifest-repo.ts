// `file_manifest` — DESIGN §3.2, and the write half of §5.3's classification table.
//
// STACK ADR-008: SQL exists only under `src/main/db/**`, behind a repository function. The
// sync engine (`src/main/sync/**`) and the parse worker (`src/main/worker/**`) reach the
// manifest exclusively through this class.
//
// ⚠️ Two rules in here are the difference between "a sync" and "a silent shrink of every
// lifetime total":
//
//   1. `deleteMissing` carries `AND archive_id IS NULL`. An archived file is absent from
//      `<claudeDir>` **by design** — the app moved it, with an audit entry (§5.12, ADR-034).
//      Deleting its manifest row cascades its events away and every lifetime total drops
//      (§5.3 `ARCHIVED`, INV-18).
//   2. `resetForReparse` deletes the parsed rows but KEEPS the manifest row, so `rel_path`
//      (the identity, §3.2), `id` and `first_seen_at` survive a SHRANK/REWROTE re-parse.
//   3. ADR-041 — `retainOrphan` is the SAFE alternative to `deleteMissing` when the file is gone
//      and `retainOrphanedHistory` is ON: it deletes nothing, marks the file and its sessions
//      RETAINED, and so keeps every lifetime total intact across the disappearance. `clearOrphan`
//      is its inverse, for a file that comes back.

import { Repository } from './base';
import type { SqliteDatabase } from '../sqlite';
import type { FileKind } from '../../parse/source-file';

/** §3.2 — the columns §5.3 classifies on, plus the identity ones ingest needs. */
export interface ManifestRow {
  readonly id: number;
  readonly rel_path: string;
  readonly kind: string;
  readonly size_bytes: number;
  readonly mtime_ms: number;
  readonly byte_offset: number;
  readonly lines_parsed: number;
  readonly bad_lines: number;
  /** §3.2 (migration 0005, A-05) — §5.4 rule 8's sum-assertion failures. Mirrors `bad_lines`. */
  readonly cache_split_mismatches: number;
  readonly content_hash: string | null;
  readonly archive_id: number | null;
  /** §3.2 (migration 0009, ADR-041) — 1 = the file is gone from `<claudeDir>` and RETAINED. */
  readonly retained_orphan: number;
}

/** §3.15 — the archive roots a sync stats, and nothing more (§5.3 `ARCHIVED`). */
export interface ArchiveRootRow {
  readonly id: number;
  readonly archive_root: string;
}

export interface InsertManifestInput {
  readonly relPath: string;
  readonly kind: FileKind;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly contentHash: string | null;
  readonly now: number;
}

export interface RecordParseInput {
  readonly id: number;
  readonly byteOffset: number;
  readonly linesParsed: number;
  readonly badLines: number;
  /** §3.2 (A-05) — absolute, like `badLines`: this file's running total, not a delta. */
  readonly cacheSplitMismatches: number;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly contentHash: string | null;
  readonly now: number;
}

const SELECT_ALL = `SELECT id, rel_path, kind, size_bytes, mtime_ms, byte_offset, lines_parsed, bad_lines,
          cache_split_mismatches, content_hash, archive_id, retained_orphan
     FROM file_manifest`;

const SELECT_BY_REL_PATH = `${SELECT_ALL} WHERE rel_path = ?`;

const INSERT_ROW = `INSERT INTO file_manifest
  (rel_path, kind, size_bytes, mtime_ms, byte_offset, lines_parsed, bad_lines, content_hash,
   first_seen_at, last_seen_at, parsed_at)
  VALUES (@relPath, @kind, @sizeBytes, @mtimeMs, 0, 0, 0, @contentHash, @now, @now, NULL)`;

/**
 * §5.3 `UNCHANGED` — "Skip; touch `last_seen_at` only." Nothing else moves, so an unchanged
 * file costs one `UPDATE` of one column and no parse (P-02, P-37).
 */
const TOUCH_SEEN = 'UPDATE file_manifest SET last_seen_at = ? WHERE id = ?';

const RECORD_PARSE = `UPDATE file_manifest
   SET byte_offset  = @byteOffset,
       lines_parsed = @linesParsed,
       bad_lines    = @badLines,
       cache_split_mismatches = @cacheSplitMismatches,
       size_bytes   = @sizeBytes,
       mtime_ms     = @mtimeMs,
       content_hash = @contentHash,
       last_seen_at = @now,
       parsed_at    = @now
 WHERE id = @id`;

// §5.3 SHRANK/REWROTE — "Delete all rows with `source_file_id`, reset offset to 0, re-parse".
// `tool_calls` and `file_touches` follow `events` by ON DELETE CASCADE (§3.1.5); they are not
// deleted here because deleting them separately would be a second, driftable list.
const DELETE_EVENTS_OF_FILE = 'DELETE FROM events WHERE source_file_id = ?';
const DELETE_PROMPTS_OF_FILE = 'DELETE FROM prompts WHERE source_file_id = ?';
const DELETE_STATS_OF_FILE = 'DELETE FROM stats_cache_days WHERE source_file_id = ?';
const DELETE_RUNS_OF_FILE = 'DELETE FROM subagent_runs WHERE transcript_file_id = ?';
// ⚠️ `api_ids_from_line = 0` belongs in this list for the same reason `bad_lines` does (migration
// 0011). The watermark counts LEADING lines of this file whose records were ingested before the
// app read API-call ids; a SHRANK/REWROTE re-parse re-reads the file from line 1 with a build that
// does read them, so none of its lines are behind the boundary any more. Leaving the old value
// here would make the §4.6 count report freshly-checked records as "not checked" — an
// understatement, but still a number that does not mean what it says.
const RESET_OFFSET = `UPDATE file_manifest
      SET byte_offset = 0, lines_parsed = 0, bad_lines = 0, cache_split_mismatches = 0,
          api_ids_from_line = 0
    WHERE id = ?`;

/**
 * ⚠️ `AND archive_id IS NULL` is load-bearing (§5.3 `ARCHIVED`, INV-18, ADR-033). Without it
 * the first sync after an archive deletes the archived transcripts' manifest rows, cascades
 * their events away, and every lifetime total silently shrinks.
 */
const DELETE_MISSING = 'DELETE FROM file_manifest WHERE id = ? AND archive_id IS NULL';

// ADR-041 — retention, the SAFE alternative to DELETE_MISSING when the setting is ON. Nothing is
// deleted: the manifest row is marked, and so is every session the file fed, so the purge (§3.18)
// spares the session row and its retained events cannot be cascaded away.
//
// ⚠️ Guarded `AND archive_id IS NULL`: an archived file is never an orphan (§5.3 `ARCHIVED` wins),
// and marking one would be a category error.
const MARK_FILE_RETAINED_ORPHAN =
  'UPDATE file_manifest SET retained_orphan = 1 WHERE id = ? AND archive_id IS NULL';

// Every session that has a parsed row from this file: via its events (covers main AND subagent
// transcripts — a subagent transcript's events carry the PARENT session id, ADR-020), via its own
// `transcript_file_id` (a session whose transcript is this file even if it produced no events),
// and via a `subagent_runs` row pointing at this file (a run with no events, still retained).
const MARK_SESSIONS_RETAINED_ORPHAN = `UPDATE sessions SET retained_orphan = 1
   WHERE archive_id IS NULL
     AND id IN (
       SELECT session_id FROM events        WHERE source_file_id = @id
       UNION
       SELECT id         FROM sessions       WHERE transcript_file_id = @id
       UNION
       SELECT session_id FROM subagent_runs  WHERE transcript_file_id = @id
     )`;

// ADR-041 — the inverse, run when an orphaned file REAPPEARS on disk (the user restored it, a
// volume was remounted). Clear the file's marker, then clear a session's marker only when NO
// retained-orphan file feeds it any more — so a session with several files, only some of which
// returned, correctly stays retained until the last one is back. Run AFTER the file marker is
// cleared, so this query sees the current state.
const CLEAR_FILE_RETAINED_ORPHAN = 'UPDATE file_manifest SET retained_orphan = 0 WHERE id = ?';

const CLEAR_SESSIONS_RETAINED_ORPHAN = `UPDATE sessions SET retained_orphan = 0
   WHERE retained_orphan = 1
     AND id IN (
       SELECT session_id FROM events        WHERE source_file_id = @id
       UNION
       SELECT id         FROM sessions       WHERE transcript_file_id = @id
       UNION
       SELECT session_id FROM subagent_runs  WHERE transcript_file_id = @id
     )
     AND NOT EXISTS (
       SELECT 1 FROM events e JOIN file_manifest f ON f.id = e.source_file_id
       WHERE e.session_id = sessions.id AND f.retained_orphan = 1
     )
     AND NOT EXISTS (
       SELECT 1 FROM subagent_runs sr JOIN file_manifest f ON f.id = sr.transcript_file_id
       WHERE sr.session_id = sessions.id AND f.retained_orphan = 1
     )`;

const SELECT_ARCHIVE_ROOTS = 'SELECT id, archive_root FROM archives';

// §3.15 — `reachable` is informational only: it never deletes a row, never marks data
// partial and never changes a metric (ADR-033). `last_reachable_at` only ever moves forward.
const SET_ARCHIVE_REACHABLE = `UPDATE archives
   SET reachable = @reachable,
       last_reachable_at = CASE WHEN @reachable = 1 THEN @now ELSE last_reachable_at END,
       updated_at = @now
 WHERE id = @id`;

export class ManifestRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Every manifest row, archived ones included — §5.3 classifies on `archive_id`. */
  listAll(): ManifestRow[] {
    return this.all<ManifestRow>(SELECT_ALL);
  }

  byRelPath(relPath: string): ManifestRow | undefined {
    return this.one<ManifestRow>(SELECT_BY_REL_PATH, relPath);
  }

  /** §5.3 `NEW` — "insert manifest row" at offset 0; the parse follows in its own step. */
  insert(input: InsertManifestInput): number {
    const result = this.run(INSERT_ROW, {
      relPath: input.relPath,
      kind: input.kind,
      sizeBytes: input.sizeBytes,
      mtimeMs: input.mtimeMs,
      contentHash: input.contentHash,
      now: input.now,
    });
    return Number(result.lastInsertRowid);
  }

  touchSeen(id: number, now: number): void {
    this.run(TOUCH_SEEN, now, id);
  }

  /**
   * Writes the post-parse state of one file. `linesParsed`, `badLines` and
   * `cacheSplitMismatches` are **absolute**, not deltas: the caller carries the pre-parse values
   * forward, so a re-parse after a SHRANK cannot double-count them.
   */
  recordParse(input: RecordParseInput): void {
    this.run(RECORD_PARSE, {
      id: input.id,
      byteOffset: input.byteOffset,
      linesParsed: input.linesParsed,
      badLines: input.badLines,
      cacheSplitMismatches: input.cacheSplitMismatches,
      sizeBytes: input.sizeBytes,
      mtimeMs: input.mtimeMs,
      contentHash: input.contentHash,
      now: input.now,
    });
  }

  /** §5.3 SHRANK/REWROTE — drop everything parsed from this file, keep its identity. */
  resetForReparse(id: number): void {
    this.run(DELETE_EVENTS_OF_FILE, id);
    this.run(DELETE_PROMPTS_OF_FILE, id);
    this.run(DELETE_STATS_OF_FILE, id);
    this.run(DELETE_RUNS_OF_FILE, id);
    this.run(RESET_OFFSET, id);
  }

  /**
   * §5.3 `MISSING` — "Delete the manifest row (cascade removes its rows)".
   * Returns the number of rows deleted: `0` means the row was RETAINED and was correctly
   * left alone, which the caller reports rather than treating as a no-op.
   */
  deleteMissing(id: number): number {
    return this.run(DELETE_MISSING, id).changes;
  }

  /**
   * ADR-041 — §5.3 `RETAINED_ORPHAN` — the file is gone from `<claudeDir>` and retention is ON.
   * Keep every parsed row; mark the manifest row AND every session it fed, so the purge (§3.18)
   * spares them. Returns the number of manifest rows marked: `0` means the row was archived (never
   * an orphan) and was correctly left alone.
   *
   * ⚠️ Both writes are one transaction: a marked file whose sessions were not marked would leave
   * the session purgeable, and its retained events would cascade away on the next `claudeDir`
   * change — the exact silent shrink this feature exists to prevent.
   */
  retainOrphan(id: number): number {
    return this.transaction((): number => {
      const marked = this.run(MARK_FILE_RETAINED_ORPHAN, id).changes;
      if (marked > 0) this.run(MARK_SESSIONS_RETAINED_ORPHAN, { id });
      return marked;
    });
  }

  /**
   * ADR-041 — the reappearance path. An orphaned file is back on disk (restored, remounted), so
   * clear its marker and clear any session that has no other retained-orphan file left. Normal
   * classification (`GREW`/`UNCHANGED`/`REWROTE`) then resumes for the file itself; ADR-019's
   * `event_key` dedup makes the re-ingest idempotent, so nothing is double-counted.
   */
  clearOrphan(id: number): void {
    this.transaction((): void => {
      this.run(CLEAR_FILE_RETAINED_ORPHAN, id);
      this.run(CLEAR_SESSIONS_RETAINED_ORPHAN, { id });
    });
  }

  /** §5.3 `ARCHIVED` — sync stats these roots and refreshes reachability. Nothing else. */
  archiveRoots(): ArchiveRootRow[] {
    return this.all<ArchiveRootRow>(SELECT_ARCHIVE_ROOTS);
  }

  setArchiveReachable(id: number, reachable: boolean, now: number): void {
    this.run(SET_ARCHIVE_REACHABLE, { id, reachable: reachable ? 1 : 0, now });
  }
}
