// `archives` — DESIGN §3.15, §4.8 `archives:list` / `archives:candidates`, §5.7 ACT-07,
// ADR-033 (the RETAINED class), ADR-034 (move-class archiving).
//
// ⚠️ **Annotate, never delete** (§5.7 ACT-07 rule 3). Archiving sets `file_manifest.archive_id` /
// `archive_rel_path` and `sessions.archive_id`, inserts the `archives` row and writes the audit
// entry. **No `events`, `tool_calls`, `subagent_runs` or `file_touches` row is touched** — which
// is why `archiveRows()` below is an UPDATE-only surface and there is no delete of a fact row
// anywhere in this file. That single property is INV-18: "archiving changes no metric".
//
// ⚠️ **INV-20 — a session's files are never split across the two roots.** `assertNotSplit()`
// checks it against the database after every annotate, rather than trusting the caller, because
// `purge.ts`'s `events` statement guards on `file_manifest.archive_id` while every other statement
// guards on `sessions.archive_id`, and those two predicates are only equivalent because INV-20
// holds. A split session would make a purge silently delete an archived session's events.
//
// ⚠️ The app **never deletes anything under the archive root**, ever (§5.7 ACT-07 rule 4). There
// is no path from this repository to an unlink under `archives.archive_root`.

import { Repository } from './base';
import type { SqliteDatabase } from '../sqlite';
import { DbError } from '../errors';

/** §3.15, column-for-column. */
export interface ArchiveRecordInput {
  /** Reserved before the move, because §9.3's destination is `<archiveRoot>/<basename>-<id>/`. */
  readonly id: number;
  readonly auditId: number;
  /** ABSOLUTE — §3.1.4's second deliberate exception (§3.15). */
  readonly archiveRoot: string;
  readonly claudeDir: string;
  readonly sessionCount: number;
  readonly fileCount: number;
  readonly bytesMoved: number;
  readonly rangeFromTs: number | null;
  readonly rangeToTs: number | null;
  readonly now: number;
}

export interface ArchiveRecord {
  readonly id: number;
  readonly auditId: number;
  readonly archiveRoot: string;
  readonly claudeDir: string;
  readonly sessionCount: number;
  readonly fileCount: number;
  readonly bytesMoved: number;
  readonly rangeFromTs: number | null;
  readonly rangeToTs: number | null;
  readonly reachable: boolean;
  readonly lastReachableAt: number | null;
  readonly createdAt: number;
}

/** One file moved by ACT-07, as the annotation needs it. Both paths are POSIX and relative. */
export interface ArchivedFileAnnotation {
  /** Relative to `claudeDir` — the `file_manifest.rel_path` identity (§3.2). */
  readonly relPath: string;
  /** Relative to `archives.archive_root` — where the bytes are now (§3.2 `archive_rel_path`). */
  readonly archiveRelPath: string;
}

/** §4.8 `archives:candidates` — a live session and what archiving it would move. */
export interface ArchiveCandidateRecord {
  readonly id: string;
  readonly displayName: string;
  readonly lastTs: number;
  readonly bytes: number;
}

/** The on-disk footprint of one live session: its transcript and its `subagents/` tree. */
export interface SessionFileSet {
  readonly sessionId: string;
  readonly transcriptRelPath: string;
  /** `projects/<encoded>/<session-id>/subagents` — the whole directory moves (INV-20). */
  readonly subagentsRelDir: string;
  readonly manifestRelPaths: string[];
  readonly bytes: number;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
}

const NEXT_ID = 'SELECT COALESCE(MAX(id), 0) + 1 AS next FROM archives';

const INSERT_ROW = `INSERT INTO archives
  (id, audit_id, archive_root, claude_dir, session_count, file_count, bytes_moved,
   range_from_ts, range_to_ts, last_reachable_at, reachable, created_at, updated_at)
  VALUES (@id, @auditId, @archiveRoot, @claudeDir, @sessionCount, @fileCount, @bytesMoved,
          @rangeFromTs, @rangeToTs, @now, 1, @now, @now)`;

const SELECT_ALL = `SELECT id, audit_id, archive_root, claude_dir, session_count, file_count,
                           bytes_moved, range_from_ts, range_to_ts, reachable, last_reachable_at,
                           created_at
                      FROM archives ORDER BY created_at DESC, id DESC`;

const ANNOTATE_FILE = `UPDATE file_manifest
   SET archive_id = @archiveId, archive_rel_path = @archiveRelPath
 WHERE rel_path = @relPath`;

const ANNOTATE_SESSION = 'UPDATE sessions SET archive_id = ? WHERE id = ?';

const CLEAR_FILES =
  'UPDATE file_manifest SET archive_id = NULL, archive_rel_path = NULL WHERE archive_id = ?';

const CLEAR_SESSIONS = 'UPDATE sessions SET archive_id = NULL WHERE archive_id = ?';

// §11.5 keeps un-archiving an OLDER archive out of v1; ACT-07's own undo is specified (§5.7
// rule 5, "restoring the exact prior state"). The `archives` row is that action's record and the
// only column that could qualify it — `reachable` — means "the volume is not mounted", so a
// retained row would assert that transcripts are somewhere they are not. It goes with the undo;
// the audit trail keeps both entries forever (§3.14).
const DELETE_ARCHIVE = 'DELETE FROM archives WHERE id = ?';

const SESSIONS_OF_ARCHIVE = 'SELECT id FROM sessions WHERE archive_id = ?';

/**
 * INV-20's check, as SQL. Every manifest row belonging to one of the archive's sessions — its
 * transcript and everything under its `subagents/` directory — must carry the same `archive_id`.
 */
const SPLIT_FILES = `SELECT fm.rel_path AS rel_path
   FROM file_manifest fm
  WHERE fm.archive_id IS NULL
    AND EXISTS (
      SELECT 1 FROM sessions s
        JOIN file_manifest t ON t.id = s.transcript_file_id
       WHERE s.archive_id = @archiveId
         AND (fm.rel_path = t.rel_path
              OR fm.rel_path LIKE REPLACE(REPLACE(REPLACE(
                   SUBSTR(t.rel_path, 1, LENGTH(t.rel_path) - 6),
                   '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '/subagents/%' ESCAPE '\\')
    )`;

const CANDIDATES = `SELECT s.id AS id, p.display_name AS display_name, s.last_ts AS last_ts
   FROM sessions s JOIN projects p ON p.id = s.project_id
  WHERE s.archive_id IS NULL AND s.last_ts < @olderThanTs
  ORDER BY s.last_ts, s.id`;

const SESSION_FILE_SET = `SELECT s.id AS session_id, t.rel_path AS transcript_rel_path,
                                 s.first_ts AS first_ts, s.last_ts AS last_ts,
                                 s.project_id AS project_id, s.archive_id AS archive_id
   FROM sessions s LEFT JOIN file_manifest t ON t.id = s.transcript_file_id
  WHERE s.id = ?`;

const MANIFEST_UNDER = `SELECT rel_path, size_bytes FROM file_manifest
   WHERE rel_path = @exact
      OR rel_path LIKE @prefix ESCAPE '\\'`;

export class ArchivesRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** The id the next archive will carry. Needed before the move: it names the destination. */
  reserveId(): number {
    return this.one<{ next: number }>(NEXT_ID)?.next ?? 1;
  }

  /**
   * §5.7 ACT-07 rule 3, as ONE transaction: insert the `archives` row, annotate the manifest
   * rows, annotate the sessions. No fact table is named anywhere in it.
   *
   * The caller has already written the audit entry with `id = input.auditId` inside the same
   * outer transaction, which is what satisfies `archives.audit_id`'s foreign key.
   */
  recordArchive(
    input: ArchiveRecordInput,
    files: readonly ArchivedFileAnnotation[],
    sessionIds: readonly string[],
  ): void {
    this.run(INSERT_ROW, {
      id: input.id,
      auditId: input.auditId,
      archiveRoot: input.archiveRoot,
      claudeDir: input.claudeDir,
      sessionCount: input.sessionCount,
      fileCount: input.fileCount,
      bytesMoved: input.bytesMoved,
      rangeFromTs: input.rangeFromTs,
      rangeToTs: input.rangeToTs,
      now: input.now,
    });
    for (const file of files) {
      this.run(ANNOTATE_FILE, {
        archiveId: input.id,
        archiveRelPath: file.archiveRelPath,
        relPath: file.relPath,
      });
    }
    for (const sessionId of sessionIds) this.run(ANNOTATE_SESSION, input.id, sessionId);
    this.assertNotSplit(input.id);
  }

  /**
   * INV-20 — refuses rather than reports.
   *
   * A split session is not a cosmetic inconsistency: `purge.ts`'s `events` statement guards on
   * `file_manifest.archive_id` while its `tool_calls`/`file_touches`/`subagent_runs` statements
   * guard on `sessions.archive_id`, and the two are equivalent **only** while this holds. The
   * failure it prevents is a lifetime total shrinking silently on the next rebuild.
   */
  assertNotSplit(archiveId: number): void {
    const split = this.all<{ rel_path: string }>(SPLIT_FILES, { archiveId });
    if (split.length === 0) return;
    throw new DbError(
      'E_INTERNAL',
      "Refusing to archive: a session's transcript and its subagents/ directory would end up " +
        'on opposite sides of the archive boundary (INV-20).',
      { retryable: false },
    );
  }

  /** §5.7 ACT-07 rule 5 — undo "clears the annotations, restoring the exact prior state". */
  clearArchive(archiveId: number): string[] {
    const sessions = this.all<{ id: string }>(SESSIONS_OF_ARCHIVE, archiveId).map((row) => row.id);
    this.run(CLEAR_FILES, archiveId);
    this.run(CLEAR_SESSIONS, archiveId);
    // Order matters: `file_manifest.archive_id` and `sessions.archive_id` are ON DELETE RESTRICT
    // (§3.15), so the row cannot go until nothing points at it.
    this.run(DELETE_ARCHIVE, archiveId);
    return sessions;
  }

  list(): ArchiveRecord[] {
    return this.all<{
      readonly id: number;
      readonly audit_id: number;
      readonly archive_root: string;
      readonly claude_dir: string;
      readonly session_count: number;
      readonly file_count: number;
      readonly bytes_moved: number;
      readonly range_from_ts: number | null;
      readonly range_to_ts: number | null;
      readonly reachable: number;
      readonly last_reachable_at: number | null;
      readonly created_at: number;
    }>(SELECT_ALL).map((row) => ({
      id: row.id,
      auditId: row.audit_id,
      archiveRoot: row.archive_root,
      claudeDir: row.claude_dir,
      sessionCount: row.session_count,
      fileCount: row.file_count,
      bytesMoved: row.bytes_moved,
      rangeFromTs: row.range_from_ts,
      rangeToTs: row.range_to_ts,
      reachable: row.reachable === 1,
      lastReachableAt: row.last_reachable_at,
      createdAt: row.created_at,
    }));
  }

  /**
   * §4.8 `archives:candidates` — read-only, never mutates, never mints a token.
   *
   * ⚠️ Sessions already archived are excluded (`archive_id IS NULL`): an archived session's
   * transcript is not in `<claudeDir>` to move, and re-archiving it would be a second move of
   * something the app already moved.
   */
  candidates(olderThanTs: number, projectIds: number[] | null): ArchiveCandidateRecord[] {
    const rows = this.all<{ id: string; display_name: string; last_ts: number }>(CANDIDATES, {
      olderThanTs,
    });
    const out: ArchiveCandidateRecord[] = [];
    for (const row of rows) {
      const fileSet = this.sessionFileSet(row.id);
      if (fileSet === null) continue;
      if (projectIds !== null && !projectIds.includes(fileSet.projectId)) continue;
      out.push({
        id: row.id,
        displayName: row.display_name,
        lastTs: row.last_ts,
        bytes: fileSet.files.bytes,
      });
    }
    return out;
  }

  /**
   * The complete file set of one session — its transcript **and** its whole `subagents/`
   * directory (INV-20). `null` when the session is unknown or has no transcript row.
   *
   * ⚠️ The subagents directory is derived from the transcript's rel_path
   * (`projects/<enc>/<sid>.jsonl` → `projects/<enc>/<sid>/subagents`), which is §5.4 rule 4's
   * layout, and the manifest is queried by that prefix rather than through `subagent_runs`.
   * A subagent transcript that has not been parsed yet still has to move with its session.
   */
  sessionFileSet(sessionId: string): {
    readonly projectId: number;
    readonly archiveId: number | null;
    readonly files: SessionFileSet;
  } | null {
    const row = this.one<{
      session_id: string;
      transcript_rel_path: string | null;
      first_ts: number | null;
      last_ts: number | null;
      project_id: number;
      archive_id: number | null;
    }>(SESSION_FILE_SET, sessionId);
    if (row === undefined || row.transcript_rel_path === null) return null;

    const transcriptRelPath = row.transcript_rel_path;
    const subagentsRelDir = subagentsDirFor(transcriptRelPath);
    const manifest = this.all<{ rel_path: string; size_bytes: number }>(MANIFEST_UNDER, {
      exact: transcriptRelPath,
      prefix: `${escapeLike(subagentsRelDir)}/%`,
    });

    return {
      projectId: row.project_id,
      archiveId: row.archive_id,
      files: {
        sessionId: row.session_id,
        transcriptRelPath,
        subagentsRelDir,
        manifestRelPaths: manifest.map((file) => file.rel_path),
        bytes: manifest.reduce((total, file) => total + file.size_bytes, 0),
        firstTs: row.first_ts,
        lastTs: row.last_ts,
      },
    };
  }
}

/**
 * `projects/<encoded>/<session-id>.jsonl` → `projects/<encoded>/<session-id>/subagents`.
 * §5.4 rule 4 / ADR-020's layout, in one place so the move and the annotation cannot disagree.
 */
export function subagentsDirFor(transcriptRelPath: string): string {
  const withoutExtension = transcriptRelPath.endsWith('.jsonl')
    ? transcriptRelPath.slice(0, -'.jsonl'.length)
    : transcriptRelPath;
  return `${withoutExtension}/subagents`;
}

/** `LIKE` treats `%` and `_` as wildcards; a rel_path prefix must match literally. */
function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
