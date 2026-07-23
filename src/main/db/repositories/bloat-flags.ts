// `bloat_flags` — DESIGN §3.12, §4.8 `bloat:list`, §5.11 (the CLOSED rule set BR-01…BR-06).
//
// ⚠️ "`bloat_flags` is fully replaced on each harness scan (DELETE then insert, one transaction),
// so a resolved issue disappears" (§3.12). A flag that outlives the thing it describes is an
// action button pointed at a file that is no longer there.
//
// ⚠️ `action_type IS NULL` is a first-class value, not a gap. BR-03 ("installed skill never
// invoked") is **deliberately actionless**: §5.11 — "deleting a skill because it shows zero
// invocations is exactly the kind of irreversible act this app must not make easy, and the
// 'never used' claim is only as good as the transcript window." §6.9 renders it as a card with
// no button and the muted label "no automatic action in v1".
//
// ⚠️ INV-14 — nothing under `<claudeDir>/.claude-lens-backups/` may ever appear in this table.
// That exclusion lives in the rule walk (`src/main/harness/bloat-radar.ts`), which is the only
// writer; this repository asserts it again before inserting, because "the app flags its own
// safety net and offers to delete it" is not a failure worth trusting to one layer.

import { Repository } from './base';
import type { SqliteDatabase } from '../sqlite';
import { DbError } from '../errors';
import { BACKUP_ROOT_NAME } from '../../config/paths';
import type { ActionType, BloatRuleId, BloatSeverity } from '../../../shared/ipc-contract';

/** One flag as a rule produces it, before it has a row id. Column-for-column with §3.12. */
export interface BloatFlagInput {
  readonly ruleId: BloatRuleId;
  readonly severity: BloatSeverity;
  readonly title: string;
  /** A rel_path or rel_path glob, relative to claudeDir (§3.12). Never absolute (§3.1.4). */
  readonly location: string;
  readonly sizeBytes: number;
  readonly itemCount: number;
  /** "Why flagged", rendered verbatim by §6.9. */
  readonly rationale: string;
  /** A §5.7 catalogue id, or `null` = **no automatic action in v1** (BR-03, BR-05 chooser). */
  readonly actionType: ActionType | null;
  /** JSON, validated against that action's payload schema by the caller (§3.12). */
  readonly actionPayload: unknown;
}

/** §3.12 as read back, with `action_payload` decoded. */
export interface BloatFlagRecord {
  readonly id: number;
  readonly ruleId: BloatRuleId;
  readonly severity: BloatSeverity;
  readonly title: string;
  readonly location: string;
  readonly sizeBytes: number;
  readonly itemCount: number;
  readonly rationale: string;
  readonly actionType: ActionType | null;
  readonly actionPayload: unknown;
  readonly detectedAt: number;
}

const DELETE_ALL = 'DELETE FROM bloat_flags';

const INSERT_FLAG = `INSERT INTO bloat_flags
  (rule_id, severity, title, location, size_bytes, item_count, rationale, action_type,
   action_payload, detected_at)
  VALUES (@ruleId, @severity, @title, @location, @sizeBytes, @itemCount, @rationale,
          @actionType, @actionPayload, @detectedAt)`;

// §3.12's index is `(severity, size_bytes DESC)`; severity is TEXT, so ordering it in SQL would
// sort alphabetically ('high' < 'low' < 'medium'), which is not the severity order §6.9 wants.
// The rank is applied here so the index still serves the scan and the order is the human one.
const SELECT_ALL = `SELECT id, rule_id, severity, title, location, size_bytes, item_count,
                           rationale, action_type, action_payload, detected_at
                      FROM bloat_flags
                     ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                              size_bytes DESC, rule_id, location`;

interface BloatFlagRow {
  readonly id: number;
  readonly rule_id: string;
  readonly severity: string;
  readonly title: string;
  readonly location: string;
  readonly size_bytes: number;
  readonly item_count: number;
  readonly rationale: string;
  readonly action_type: string | null;
  readonly action_payload: string | null;
  readonly detected_at: number;
}

/**
 * §5.11 BR-05's second input: how many sessions the transcript corpus holds and what it spans.
 *
 * ⛔ INV-13 — all time. The method takes no `GlobalFilter` and the SQL has no scope clause, so a
 * "your transcripts are large" flag cannot be produced from one month of them.
 *
 * ⚠️ Archived sessions are excluded (`archive_id IS NULL`): BR-05 describes what is on disk under
 * `<claudeDir>`, and an archived session's transcript is not. Its parsed rows are RETAINED and
 * still count in every metric (INV-18) — the two questions are different and stay different.
 */
const TRANSCRIPT_CORPUS = `SELECT COUNT(*) AS session_count, MIN(first_ts) AS range_from_ts,
                                  MAX(last_ts) AS range_to_ts
                             FROM sessions WHERE archive_id IS NULL`;

export interface TranscriptCorpusRecord {
  readonly sessionCount: number;
  readonly rangeFromTs: number | null;
  readonly rangeToTs: number | null;
}

export class BloatFlagsRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** ⛔ INV-13 — see `TRANSCRIPT_CORPUS`. */
  transcriptCorpus(): TranscriptCorpusRecord {
    const row = this.one<{
      readonly session_count: number;
      readonly range_from_ts: number | null;
      readonly range_to_ts: number | null;
    }>(TRANSCRIPT_CORPUS);
    return {
      sessionCount: row?.session_count ?? 0,
      rangeFromTs: row?.range_from_ts ?? null,
      rangeToTs: row?.range_to_ts ?? null,
    };
  }

  /** §3.12 — DELETE then insert, one transaction, so a resolved issue disappears. */
  replaceAll(flags: readonly BloatFlagInput[], detectedAt: number): number {
    for (const flag of flags) assertNotBackupRoot(flag.location);
    return this.transaction((): number => {
      this.run(DELETE_ALL);
      for (const flag of flags) {
        this.run(INSERT_FLAG, {
          ruleId: flag.ruleId,
          severity: flag.severity,
          title: flag.title,
          location: flag.location,
          sizeBytes: flag.sizeBytes,
          itemCount: flag.itemCount,
          rationale: flag.rationale,
          actionType: flag.actionType,
          actionPayload:
            flag.actionPayload === undefined ? null : JSON.stringify(flag.actionPayload),
          detectedAt,
        });
      }
      return flags.length;
    });
  }

  list(): BloatFlagRecord[] {
    return this.all<BloatFlagRow>(SELECT_ALL).map((row) => ({
      id: row.id,
      ruleId: row.rule_id as BloatRuleId,
      severity: row.severity as BloatSeverity,
      title: row.title,
      location: row.location,
      sizeBytes: row.size_bytes,
      itemCount: row.item_count,
      rationale: row.rationale,
      actionType: row.action_type === null ? null : (row.action_type as ActionType),
      actionPayload:
        row.action_payload === null ? null : (JSON.parse(row.action_payload) as unknown),
      detectedAt: row.detected_at,
    }));
  }
}

/**
 * INV-14, restated as a runtime refusal.
 *
 * The `location` column is a rel_path relative to `claudeDir`, so a restore point is flagged the
 * moment a rule's walk forgets to exclude the backup root — and the flag would carry a delete
 * action pointed at the app's own safety net.
 */
function assertNotBackupRoot(location: string): void {
  if (location === BACKUP_ROOT_NAME || location.startsWith(`${BACKUP_ROOT_NAME}/`)) {
    throw new DbError(
      'E_INTERNAL',
      'Refusing to flag a path inside the restore-point folder as bloat (INV-14).',
      { retryable: false },
    );
  }
}
