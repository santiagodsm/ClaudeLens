// `audit_log` — DESIGN §3.14, §4.8 `audit:list`, §5.5 rule 6, §7.7.
//
// ⚠️ **No row of `audit_log` is ever deleted.** There is no `DELETE FROM audit_log` in this
// repository, in `purge.ts`, or anywhere else in the codebase — the table is USER class
// (ADR-026, INV-12) and it is the only record of what this application did to the user's files.
// `clear-backups` (ACT-06) sets `backup_present = 0` on the entries whose restore point it
// removed; the entry survives as history with its undo capability honestly withdrawn (§3.14).
//
// ⚠️ **Exactly one row per terminal state** (§5.5 rule 6), including `FAILED`. `ABORTED` writes
// none: nothing happened and nothing was promised. That is why this repository offers `record()`
// — a single insert of an already-finished action — and no `begin()`/`update()` pair. A partially
// written audit row would be a claim the code could not stand behind.

import { Repository } from './base';
import type { SqliteDatabase } from '../sqlite';
import type { ActionType, AuditStatus, ErrorCode } from '../../../shared/ipc-contract';

/** §3.14, column-for-column. Everything a terminal state knows, written once. */
export interface AuditRecordInput {
  /** Reserved by `reserveId()` **before** the restore point is written, because §9.3 names the
   *  restore point `<claudeDir>/.claude-lens-backups/<iso>-<auditId>/`. */
  readonly id: number;
  readonly actionType: ActionType;
  readonly status: AuditStatus;
  /** Absolute, deliberately — the first of §3.1.4's two exceptions. */
  readonly claudeDir: string;
  readonly targetSummary: string;
  /** The rel_paths **actually acted on**, not the ones previewed (§3.14). */
  readonly targets: readonly string[];
  readonly bytesAffected: number;
  readonly backupRelPath: string | null;
  readonly backupBytes: number;
  readonly backupPresent: boolean;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly undoOfId: number | null;
  readonly errorCode: ErrorCode | null;
  readonly errorDetail: string | null;
  readonly now: number;
}

/** §3.14 as read back, with `targets_json` decoded. */
export interface AuditRecord {
  readonly id: number;
  readonly actionType: ActionType;
  readonly status: AuditStatus;
  readonly claudeDir: string;
  readonly targetSummary: string;
  readonly targets: string[];
  readonly bytesAffected: number;
  readonly backupRelPath: string | null;
  readonly backupBytes: number;
  readonly backupPresent: boolean;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly undoneAt: number | null;
  readonly undoOfId: number | null;
  readonly errorCode: ErrorCode | null;
  readonly errorDetail: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface AuditRow {
  readonly id: number;
  readonly action_type: string;
  readonly status: string;
  readonly claude_dir: string;
  readonly target_summary: string;
  readonly targets_json: string;
  readonly bytes_affected: number;
  readonly backup_rel_path: string | null;
  readonly backup_bytes: number;
  readonly backup_present: number;
  readonly started_at: number;
  readonly finished_at: number | null;
  readonly undone_at: number | null;
  readonly undo_of_id: number | null;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

const COLUMNS = `id, action_type, status, claude_dir, target_summary, targets_json,
                 bytes_affected, backup_rel_path, backup_bytes, backup_present, started_at,
                 finished_at, undone_at, undo_of_id, error_code, error_detail, created_at,
                 updated_at`;

const NEXT_ID = 'SELECT COALESCE(MAX(id), 0) + 1 AS next FROM audit_log';

const INSERT_ROW = `INSERT INTO audit_log
  (id, action_type, status, claude_dir, target_summary, targets_json, bytes_affected,
   backup_rel_path, backup_bytes, backup_present, started_at, finished_at, undone_at,
   undo_of_id, error_code, error_detail, created_at, updated_at)
  VALUES (@id, @actionType, @status, @claudeDir, @targetSummary, @targetsJson, @bytesAffected,
          @backupRelPath, @backupBytes, @backupPresent, @startedAt, @finishedAt, NULL,
          @undoOfId, @errorCode, @errorDetail, @now, @now)`;

const SELECT_BY_ID = `SELECT ${COLUMNS} FROM audit_log WHERE id = ?`;

const SELECT_ALL = `SELECT ${COLUMNS} FROM audit_log ORDER BY started_at DESC, id DESC`;

/**
 * §5.5 rule 5 — "Undo is available for the most recent entry matching
 * `status='completed' AND undone_at IS NULL AND backup_present=1`, across restarts."
 * The predicate is §3.14's `idx_audit_log_undoable` partial index, verbatim.
 */
const SELECT_LATEST_UNDOABLE = `SELECT ${COLUMNS} FROM audit_log
   WHERE status = 'completed' AND undone_at IS NULL AND backup_present = 1
   ORDER BY started_at DESC, id DESC LIMIT 1`;

const MARK_UNDONE = 'UPDATE audit_log SET undone_at = @at, updated_at = @at WHERE id = @id';

/**
 * ACT-06 (§3.14, §5.7) — the ONLY mutation `clear-backups` makes to this table. The row stays;
 * only the claim "you can undo this" is withdrawn, because the bytes that backed it are gone.
 */
const WITHDRAW_BACKUP = `UPDATE audit_log
   SET backup_present = 0, updated_at = @at
 WHERE backup_present = 1 AND backup_rel_path IS NOT NULL`;

/** §4.8 `backups:summary` — over the entries that still have a restore point on disk. */
const BACKUP_SUMMARY = `SELECT COUNT(*) AS restore_points,
                               COALESCE(SUM(backup_bytes), 0) AS total_bytes,
                               MIN(started_at) AS oldest_ts,
                               MAX(started_at) AS newest_ts
                          FROM audit_log
                         WHERE backup_present = 1 AND backup_rel_path IS NOT NULL`;

const SELECT_LIVE_BACKUP_PATHS = `SELECT id, backup_rel_path, backup_bytes FROM audit_log
   WHERE backup_present = 1 AND backup_rel_path IS NOT NULL ORDER BY id`;

export interface BackupSummaryRecord {
  readonly restorePoints: number;
  readonly totalBytes: number;
  readonly oldestTs: number | null;
  readonly newestTs: number | null;
}

export interface LiveBackupRecord {
  readonly id: number;
  readonly backupRelPath: string;
  readonly backupBytes: number;
}

export class AuditLogRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /**
   * The id the next audit entry will carry, reserved before anything is written to disk.
   *
   * ⚠️ The restore point's path embeds it (§9.3), so it must be known *before* the backup runs
   * and the backup must run before any mutation (INV-07). Reserving rather than inserting is what
   * keeps §5.5 rule 6 literally true — one row, at the terminal state, and none before.
   * Guarded actions are serialised one at a time by `ActionService`, so the reservation cannot race.
   */
  reserveId(): number {
    return this.one<{ next: number }>(NEXT_ID)?.next ?? 1;
  }

  record(input: AuditRecordInput): number {
    this.run(INSERT_ROW, {
      id: input.id,
      actionType: input.actionType,
      status: input.status,
      claudeDir: input.claudeDir,
      targetSummary: input.targetSummary,
      targetsJson: JSON.stringify(input.targets),
      bytesAffected: input.bytesAffected,
      backupRelPath: input.backupRelPath,
      backupBytes: input.backupBytes,
      backupPresent: input.backupPresent ? 1 : 0,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      undoOfId: input.undoOfId,
      errorCode: input.errorCode,
      errorDetail: input.errorDetail,
      now: input.now,
    });
    return input.id;
  }

  byId(id: number): AuditRecord | undefined {
    const row = this.one<AuditRow>(SELECT_BY_ID, id);
    return row === undefined ? undefined : toRecord(row);
  }

  /** Every entry, newest first. `audit:list` pages this with the shared keyset helper (§4.2). */
  listAll(): AuditRecord[] {
    return this.all<AuditRow>(SELECT_ALL).map(toRecord);
  }

  latestUndoable(): AuditRecord | undefined {
    const row = this.one<AuditRow>(SELECT_LATEST_UNDOABLE);
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * §5.5 rule 5 — "the original entry gets `undone_at`".
   *
   * ⚠️ The status stays `completed`. §3.14's `idx_audit_log_undoable` filters on
   * `status = 'completed' AND undone_at IS NULL`, and the second half of that predicate is
   * redundant unless an undone entry keeps its original status — so the index itself says which
   * of the two readings §5.5 rule 5 intends. The `undone` status belongs to the NEW entry the
   * undo writes, which carries `undo_of_id`.
   */
  markUndone(id: number, at: number): void {
    this.run(MARK_UNDONE, { id, at });
  }

  /** ACT-06 — §3.14. Returns how many entries had their undo capability withdrawn. */
  withdrawAllBackups(at: number): number {
    return this.run(WITHDRAW_BACKUP, { at }).changes;
  }

  backupSummary(): BackupSummaryRecord {
    const row = this.one<{
      readonly restore_points: number;
      readonly total_bytes: number;
      readonly oldest_ts: number | null;
      readonly newest_ts: number | null;
    }>(BACKUP_SUMMARY);
    return {
      restorePoints: row?.restore_points ?? 0,
      totalBytes: row?.total_bytes ?? 0,
      oldestTs: row?.oldest_ts ?? null,
      newestTs: row?.newest_ts ?? null,
    };
  }

  /** The restore points ACT-06 would clear. Rel paths under the backup root (§3.14). */
  liveBackups(): LiveBackupRecord[] {
    return this.all<{
      readonly id: number;
      readonly backup_rel_path: string;
      readonly backup_bytes: number;
    }>(SELECT_LIVE_BACKUP_PATHS).map((row) => ({
      id: row.id,
      backupRelPath: row.backup_rel_path,
      backupBytes: row.backup_bytes,
    }));
  }
}

function toRecord(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    actionType: row.action_type as ActionType,
    status: row.status as AuditStatus,
    claudeDir: row.claude_dir,
    targetSummary: row.target_summary,
    targets: JSON.parse(row.targets_json) as string[],
    bytesAffected: row.bytes_affected,
    backupRelPath: row.backup_rel_path,
    backupBytes: row.backup_bytes,
    backupPresent: row.backup_present === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    undoneAt: row.undone_at,
    undoOfId: row.undo_of_id,
    errorCode: row.error_code === null ? null : (row.error_code as ErrorCode),
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
