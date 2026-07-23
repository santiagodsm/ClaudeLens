// The purge, run on a `claudeDir` change or an explicit rebuild. DESIGN §3.18.
//
// ⚠️ READ §2.2 BEFORE CHANGING ANYTHING HERE. The database is three things at once:
//
//   DERIVED  — rebuildable by re-reading the Claude data directory. Safe to purge.
//   RETAINED — parsed rows whose source file is no longer derivable, by EITHER of two roads:
//              `archive_id IS NOT NULL` (the file was MOVED out by ACT-07, ADR-033) or
//              `retained_orphan = 1` (the file DISAPPEARED and its history is kept, ADR-041).
//              A rescan of <claudeDir> will never reproduce either. Both must survive
//              (ADR-033/041, INV-18). ⚠️ A purge that spares archived rows but NOT retained-orphan
//              rows destroys exactly the history this feature exists to keep — so every guard
//              below tests BOTH markers, and `auditPurgeStatements` treats a missing orphan guard
//              as a blocking finding, identical to a missing archive guard (§3.18, §12.2).
//   USER     — `price_rows`, `settings`, `audit_log`, `archives`. No other source exists.
//              NEVER touched by a purge (ADR-026, INV-12).
//
// Deleting a RETAINED row shrinks lifetime totals with no marker and no error. Truncating a
// USER table destroys hand-corrected price history. Both are the same failure — a silently
// wrong number — arriving through two different doors, and both are invisible afterwards.
//
// ⚠️ There is no "drop the database and re-sync" path here or anywhere else (§3.18, §9.6).

import { DbError } from './errors';
import { PERSISTENCE_CLASS_BY_TABLE, type TableName } from './repositories/base';
import type { SqliteDatabase } from './sqlite';

/**
 * The statements, EXACTLY as §3.18 writes them and in that order.
 *
 * §3.18's block collapses six of these onto three lines (`DELETE FROM harness_nodes;
 * DELETE FROM harness_edges;` and so on); one statement per array entry is the only
 * departure, and it is what makes the guard assertion below checkable per statement.
 *
 * The order is FK-safe on its own terms, and every ON DELETE CASCADE in §3 only ever
 * removes rows a later statement would have removed anyway — so cascades cannot reach a
 * RETAINED row: the guarded parents (`sessions`, `file_manifest`) are themselves filtered on
 * `archive_id IS NULL` before they are deleted.
 */
export const PURGE_STATEMENTS: readonly string[] = [
  // The ONLY deletion predicate a purge may use. RETAINED rows (archive_id IS NOT NULL) survive.
  //
  // ⚠️ LOAD-BEARING CROSS-SECTION DEPENDENCY — §3.18 ⟷ INV-20, which do not cite each other.
  // This statement guards on `file_manifest.archive_id`, but every OTHER fact-table statement
  // below guards on `sessions.archive_id`. The two predicates are not equivalent in general:
  // an event belonging to an ARCHIVED session but parsed from an UNARCHIVED file would match
  // here and be deleted, shrinking that archived session's totals with no marker (INV-18).
  //
  // That row cannot exist, and the reason is INV-20 alone: "a session's transcript and its
  // `subagents/` directory are always on the same side of the archive boundary — never split
  // between <claudeDir> and the archive root" (§5.7 ACT-07 rule 1). ACT-07 moves a session's
  // transcript and every subagent transcript under it as one unit and stamps `archive_id` on
  // all of them, so `sessions.archive_id IS NOT NULL` implies every manifest row its events
  // came from is also archived. The "INV-20 is what makes the events predicate safe" block in
  // `test/main/db/purge.test.ts` asserts that implication against a real archived dataset
  // rather than trusting this comment.
  //
  // ⚠️ If ACT-07 ever gains a partial-archive mode, THIS is the statement that breaks first,
  // and it breaks silently. Do not change the predicate to match §3.18's others — §3.18 is
  // transcribed literally on purpose; change ACT-07 or amend §3.18, and cite it.
  //
  // ⚠️ ADR-041 — every guarded predicate now tests BOTH RETAINED markers. `archive_id IS NULL`
  // spares archived rows; `retained_orphan = 0` spares rows kept from files that vanished. Drop
  // the orphan clause and a `claudeDir` change silently shrinks every lifetime total for every
  // deleted-but-retained transcript — the precise data loss this feature prevents (INV-18).
  //
  // ⚠️ For ORPHANS the file/session asymmetry above is DELIBERATE, not something an invariant
  // rescues. Orphaning can be partial (a session's transcript vanishes while a subagent file of
  // the same session survives), so a `retained_orphan = 1` SESSION may legitimately own events
  // parsed from a `retained_orphan = 0` FILE. This statement then deletes exactly those live-file
  // events — correctly: they are still derivable and a rebuild re-reads them — while the session
  // row and its truly-orphaned events survive (marked at the file grain here, at the session
  // grain below). The `test/main/sync/retain-orphaned-history.test.ts` mixed-session case pins it.
  'DELETE FROM events      WHERE source_file_id IN (SELECT id FROM file_manifest WHERE archive_id IS NULL AND retained_orphan = 0)',
  'DELETE FROM tool_calls  WHERE session_id     IN (SELECT id FROM sessions      WHERE archive_id IS NULL AND retained_orphan = 0)',
  'DELETE FROM file_touches WHERE session_id    IN (SELECT id FROM sessions      WHERE archive_id IS NULL AND retained_orphan = 0)',
  'DELETE FROM subagent_runs WHERE session_id   IN (SELECT id FROM sessions      WHERE archive_id IS NULL AND retained_orphan = 0)',
  'DELETE FROM prompts', // always fully rebuildable
  'DELETE FROM sessions      WHERE archive_id IS NULL AND retained_orphan = 0',
  'DELETE FROM file_manifest WHERE archive_id IS NULL AND retained_orphan = 0',
  'DELETE FROM projects WHERE id NOT IN (SELECT project_id FROM sessions)', // keep archived + retained-orphan projects
  'DELETE FROM harness_nodes',
  'DELETE FROM harness_edges',
  // ADR-039 — replaced whole by the next scan, exactly like the two above.
  'DELETE FROM harness_run_agents',
  'DELETE FROM bloat_flags',
  'DELETE FROM stats_cache_days',
  'DELETE FROM meta',
];

/**
 * The fact tables named in §12.2's mechanical rule for `db-migration-review`:
 *
 *   "any deletion from `events`, `sessions`, `tool_calls`, `subagent_runs`, `file_touches`
 *    or `file_manifest` without an `archive_id IS NULL` guard is a BLOCKING finding."
 *
 * `prompts` is deliberately absent — §3.18 deletes it unguarded because a prompt is always
 * fully rebuildable from `history.jsonl`, which archiving never moves.
 */
export const GUARDED_TABLES: readonly string[] = [
  'events',
  'sessions',
  'tool_calls',
  'subagent_runs',
  'file_touches',
  'file_manifest',
];

/** ⚠️ USER class. A purge that names one of these is a blocking finding (INV-12, ADR-026). */
export const NEVER_PURGED_TABLES: readonly string[] = [
  'price_rows',
  'settings',
  'audit_log',
  'archives',
  // ADR-040 — the user's "these two folders are the same project". Hand-entered, no other
  // source. ⚠️ These are the tables the `encoded_name` key exists to protect: a purge renumbers
  // every `projects` row, so a group that survived by id would come back pointing at the wrong
  // folders. It survives by name instead, and it survives because it is never deleted here.
  'project_groups',
  'project_group_members',
];

/** The one predicate §3.18 permits, as a literal, so the assertion below cannot drift from it. */
export const RETAINED_GUARD = 'archive_id IS NULL';

/**
 * ⚠️ ADR-041 — the SECOND guard §3.18 now requires on every guarded delete, beside `RETAINED_GUARD`.
 * A guarded statement missing THIS clause spares archived rows but destroys retained-orphan ones —
 * a silent shrink of exactly the history this feature keeps — so its absence is a blocking finding,
 * identical in weight to a missing `archive_id IS NULL` (§3.18, §12.2 `db-migration-review`).
 */
export const RETAINED_ORPHAN_GUARD = 'retained_orphan = 0';

const DELETE_TARGET = /\bDELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i;

/** The table a `DELETE FROM` statement deletes from, or `null` if it is not a delete. */
export function deleteTargetTable(statement: string): string | null {
  return DELETE_TARGET.exec(statement)?.[1]?.toLowerCase() ?? null;
}

export interface PurgeStatementFinding {
  readonly statement: string;
  readonly table: string;
  readonly reason: 'missing-archive-guard' | 'missing-orphan-guard' | 'never-purged-table';
}

/**
 * Audits a list of deletion statements against the two rules of §12.2 /
 * `db-migration-review`. Exported so a test asserts it over `PURGE_STATEMENTS` — the guard is
 * a property of the SQL, not of anyone's memory (ADR-033: "making the class a column rather
 * than a convention means the mistake is impossible to make accidentally").
 */
export function auditPurgeStatements(
  statements: readonly string[] = PURGE_STATEMENTS,
): readonly PurgeStatementFinding[] {
  const findings: PurgeStatementFinding[] = [];
  for (const statement of statements) {
    const table = deleteTargetTable(statement);
    if (table === null) continue;
    if (NEVER_PURGED_TABLES.includes(table)) {
      findings.push({ statement, table, reason: 'never-purged-table' });
      continue;
    }
    if (GUARDED_TABLES.includes(table)) {
      // Both guards are required. A statement missing either one is reported — a delete guarded on
      // `archive_id` but not `retained_orphan` (ADR-041) is exactly as dangerous as the reverse.
      if (!statement.includes(RETAINED_GUARD)) {
        findings.push({ statement, table, reason: 'missing-archive-guard' });
      }
      if (!statement.includes(RETAINED_ORPHAN_GUARD)) {
        findings.push({ statement, table, reason: 'missing-orphan-guard' });
      }
    }
  }
  return findings;
}

export interface PurgeOutcome {
  /** Rows removed per statement, in statement order. Reported, never used as a metric. */
  readonly deletedRows: Readonly<Record<string, number>>;
  readonly totalDeleted: number;
}

/**
 * Runs the §3.18 purge inside ONE transaction. Either the whole DERIVED side is cleared and
 * a full sync follows, or nothing changed at all.
 *
 * The statements are audited before a single one executes: an unguarded delete is a
 * programming error caught here rather than a shrunken total discovered months later.
 */
export function purge(db: SqliteDatabase): PurgeOutcome {
  const findings = auditPurgeStatements(PURGE_STATEMENTS);
  if (findings.length > 0) {
    throw new DbError(
      'E_INTERNAL',
      'Refusing to purge: a deletion statement is missing its archive guard.',
      { retryable: false },
    );
  }

  // ADR-026 encoded rather than commented: every table the purge names must be classified
  // DERIVED in the one table that carries the classification.
  for (const statement of PURGE_STATEMENTS) {
    const table = deleteTargetTable(statement);
    if (table === null) continue;
    if (PERSISTENCE_CLASS_BY_TABLE[table as TableName] !== 'DERIVED') {
      throw new DbError('E_INTERNAL', `Refusing to purge a non-DERIVED table: ${table}.`, {
        retryable: false,
      });
    }
  }

  const deletedRows: Record<string, number> = {};
  const run = db.transaction((): void => {
    for (const statement of PURGE_STATEMENTS) {
      const { changes } = db.prepare(statement).run();
      const table = deleteTargetTable(statement) ?? statement;
      deletedRows[table] = (deletedRows[table] ?? 0) + changes;
    }
  });
  run();

  const totalDeleted = Object.values(deletedRows).reduce((sum, count) => sum + count, 0);
  return { deletedRows, totalDeleted };
}
