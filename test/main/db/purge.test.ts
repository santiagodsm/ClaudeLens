// The purge. DESIGN §3.18, ADR-026/033, INV-12/INV-18, §12.2's `db-migration-review` rule.
//
// ⚠️ This is the test that catches a silent shrink of lifetime totals. A purge that removes a
// RETAINED row does not crash and does not warn — it just makes every all-time number smaller
// than it was yesterday, permanently, with no marker. Same for a purge that truncates
// `price_rows`: hand-corrected rates have no other source, and the totals that used them
// change without anything failing.

import { describe, expect, it } from 'vitest';
import {
  GUARDED_TABLES,
  NEVER_PURGED_TABLES,
  PURGE_STATEMENTS,
  RETAINED_GUARD,
  auditPurgeStatements,
  deleteTargetTable,
  purge,
} from '../../../src/main/db/purge';
import { PERSISTENCE_CLASS_BY_TABLE } from '../../../src/main/db/repositories/base';
import { useSandbox } from '../../support/sandbox';
import { countRows, dumpTable, seedAcrossArchiveBoundary, useTestDatabases } from './helpers';

describe('PURGE_STATEMENTS — the guard clause (§12.2, ADR-033)', () => {
  it('carries an `archive_id IS NULL` guard on every delete from a guarded fact table', () => {
    // §12.2's mechanical rule, restated as a test: "any deletion from events, sessions,
    // tool_calls, subagent_runs, file_touches or file_manifest without an
    // `archive_id IS NULL` guard is a BLOCKING finding."
    const unguarded = PURGE_STATEMENTS.filter((statement) => {
      const table = deleteTargetTable(statement);
      return (
        table !== null && GUARDED_TABLES.includes(table) && !statement.includes(RETAINED_GUARD)
      );
    });

    expect(unguarded).toEqual([]);
  });

  it('touches every guarded table exactly through a guarded statement', () => {
    // Not just "no unguarded statement" — the guarded tables must actually be covered, so a
    // silently dropped statement is caught too.
    const guardedTargets = PURGE_STATEMENTS.map(deleteTargetTable).filter(
      (table): table is string => table !== null && GUARDED_TABLES.includes(table),
    );
    expect(guardedTargets.toSorted()).toEqual([...GUARDED_TABLES].toSorted());
  });

  it('names no USER table anywhere (INV-12)', () => {
    for (const statement of PURGE_STATEMENTS) {
      for (const table of NEVER_PURGED_TABLES) {
        expect(statement).not.toMatch(new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, 'i'));
      }
    }
  });

  it('deletes only from tables classified DERIVED (ADR-026, encoded not commented)', () => {
    for (const statement of PURGE_STATEMENTS) {
      const table = deleteTargetTable(statement);
      if (table === null) continue;
      expect(PERSISTENCE_CLASS_BY_TABLE[table as keyof typeof PERSISTENCE_CLASS_BY_TABLE]).toBe(
        'DERIVED',
      );
    }
  });

  it('reports the failure the audit exists to catch', () => {
    // The audit must actually fire; a checker that never reports is worse than none.
    const findings = auditPurgeStatements([
      'DELETE FROM events',
      'DELETE FROM price_rows',
      'DELETE FROM prompts',
    ]);
    // ⚠️ ADR-041 — a fully-unguarded delete now trips BOTH guards: it spares neither archived nor
    // retained-orphan rows. Each is its own blocking finding, weighted identically (§3.18, §12.2).
    expect(findings).toEqual([
      { statement: 'DELETE FROM events', table: 'events', reason: 'missing-archive-guard' },
      { statement: 'DELETE FROM events', table: 'events', reason: 'missing-orphan-guard' },
      { statement: 'DELETE FROM price_rows', table: 'price_rows', reason: 'never-purged-table' },
    ]);
    expect(auditPurgeStatements(PURGE_STATEMENTS)).toEqual([]);
  });

  it('follows §3.18 order exactly', () => {
    expect(PURGE_STATEMENTS.map(deleteTargetTable)).toEqual([
      'events',
      'tool_calls',
      'file_touches',
      'subagent_runs',
      'prompts',
      'sessions',
      'file_manifest',
      'projects',
      'harness_nodes',
      'harness_edges',
      // ADR-039 — added by migration 0004, beside the two tables it belongs with. §3.18's list is
      // transcribed literally everywhere else in this file; this is the one entry §3.18 predates.
      'harness_run_agents',
      'bloat_flags',
      'stats_cache_days',
      'meta',
    ]);
  });
});

describe('INV-20 is what makes the events predicate safe (§3.18 ⟷ §5.7 ACT-07 rule 1)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  /**
   * The events statement guards on `file_manifest.archive_id`; every other fact-table
   * statement guards on `sessions.archive_id`. This query finds every row where those two
   * disagree — an event of an ARCHIVED session parsed from an UNARCHIVED file. Such a row
   * would be deleted by statement 1 and would shrink an archived session's totals silently.
   *
   * It must always come back empty, and the only thing making that true is INV-20.
   */
  const splitRows = (db: ReturnType<typeof dbs.openMigrated>): unknown[] =>
    db
      .prepare(
        `SELECT e.event_key
         FROM   events e
         JOIN   sessions s      ON s.id = e.session_id
         JOIN   file_manifest f ON f.id = e.source_file_id
         WHERE  s.archive_id IS NOT NULL
           AND  f.archive_id IS NULL`,
      )
      .all();

  it('holds on a dataset that straddles the boundary, before and after a purge', () => {
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);

    // The fixture archives a session together with its transcript AND its subagent
    // transcript (manifest rows 2 and 5), which is exactly what ACT-07 guarantees.
    expect(splitRows(db)).toEqual([]);

    purge(db);

    expect(splitRows(db)).toEqual([]);
  });

  it('detects the split the moment it is manufactured — the check is not vacuous', () => {
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);

    // Simulate the partial archive INV-20 forbids: un-archive the subagent transcript while
    // its session stays archived, then attach an archived-session event to it.
    db.prepare(
      'UPDATE file_manifest SET archive_id = NULL, archive_rel_path = NULL WHERE id = 5',
    ).run();
    db.prepare(
      `INSERT INTO events (event_key, session_id, project_id, source_file_id, line_no, ts, type, origin)
       VALUES ('evt-split', 's-archived', 2, 5, 1, 1, 'assistant', 'subagent')`,
    ).run();

    expect(splitRows(db)).toHaveLength(1);

    // And this is the consequence the comment in purge.ts warns about: statement 1 deletes a
    // RETAINED session's event. Recorded so the cost of breaking INV-20 is visible, not
    // inferred.
    purge(db);
    expect(db.prepare("SELECT event_key FROM events WHERE event_key = 'evt-split'").all()).toEqual(
      [],
    );
  });
});

describe('purge() across the archive boundary (INV-12, INV-18)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('deletes every DERIVED row, keeps every RETAINED row, and never touches USER tables', () => {
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);

    // The four USER tables, captured before, compared after (INV-12).
    const before = {
      price_rows: dumpTable(db, 'price_rows'),
      settings: dumpTable(db, 'settings'),
      audit_log: dumpTable(db, 'audit_log'),
      archives: dumpTable(db, 'archives'),
    };

    purge(db);

    // ---- USER: byte-identical ------------------------------------------------------
    expect(dumpTable(db, 'price_rows')).toEqual(before.price_rows);
    expect(dumpTable(db, 'settings')).toEqual(before.settings);
    expect(dumpTable(db, 'audit_log')).toEqual(before.audit_log);
    expect(dumpTable(db, 'archives')).toEqual(before.archives);
    // Stated as counts too, so the failure message names the table if a dump ever changes.
    expect(countRows(db, 'price_rows')).toBe(2);
    expect(countRows(db, 'settings')).toBe(1);
    expect(countRows(db, 'audit_log')).toBe(1);
    expect(countRows(db, 'archives')).toBe(1);

    // ---- RETAINED: survives (ADR-033) ---------------------------------------------
    const ids = (table: string, column: string): unknown[] =>
      db
        .prepare<Record<string, unknown>>(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`)
        .all()
        .map((row) => row['id']);

    expect(ids('sessions', 'id')).toEqual(['s-archived']);
    expect(ids('file_manifest', 'id')).toEqual([2, 5]); // the archived transcript + its subagent
    expect(ids('events', 'event_key')).toEqual(['evt-archived']);
    expect(ids('tool_calls', 'id')).toEqual([2]);
    expect(ids('file_touches', 'id')).toEqual([2]);
    expect(ids('subagent_runs', 'id')).toEqual([2]);
    // §3.18: "keep archived projects" — p2 owns the archived session, p1 does not.
    expect(ids('projects', 'id')).toEqual([2]);

    // The archived rows still carry their archive annotation, unchanged.
    expect(
      db
        .prepare<{ archive_id: number | null; archive_rel_path: string | null }>(
          'SELECT archive_id, archive_rel_path FROM file_manifest WHERE id = 2',
        )
        .get(),
    ).toEqual({ archive_id: 1, archive_rel_path: 'p2/s-archived.jsonl' });

    // ---- DERIVED: gone -------------------------------------------------------------
    expect(countRows(db, 'prompts')).toBe(0);
    expect(countRows(db, 'harness_nodes')).toBe(0);
    expect(countRows(db, 'harness_edges')).toBe(0);
    expect(countRows(db, 'bloat_flags')).toBe(0);
    expect(countRows(db, 'stats_cache_days')).toBe(0);
    expect(countRows(db, 'meta')).toBe(0);
  });

  it('moves no number that the archived rows contribute to (INV-18)', () => {
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);

    const archivedTokens = (): number => {
      const row = db
        .prepare<{ total: number | null }>(
          `SELECT SUM(tok_input + tok_output + tok_cache_write + tok_cache_read) AS total
           FROM events WHERE session_id = 's-archived'`,
        )
        .get();
      return row?.total ?? 0;
    };

    // Hand-computed from the fixture: the archived event carries 30 input + 40 output,
    // and no cache tokens. 30 + 40 + 0 + 0 = 70.
    expect(archivedTokens()).toBe(70);

    purge(db);

    expect(archivedTokens()).toBe(70);
  });

  it('is idempotent — a second purge finds nothing left to remove', () => {
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);

    const first = purge(db);
    const second = purge(db);

    expect(first.totalDeleted).toBeGreaterThan(0);
    expect(second.totalDeleted).toBe(0);
  });

  it('runs in one transaction on an empty database without error', () => {
    const db = dbs.openMigrated();
    expect(purge(db).totalDeleted).toBe(0);
    expect(db.inTransaction).toBe(false);
  });

  it('reports what it removed, per table', () => {
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);

    const outcome = purge(db);

    // Two of three events are live (evt-live and evt-sub-live); one is RETAINED.
    expect(outcome.deletedRows['events']).toBe(2);
    expect(outcome.deletedRows['sessions']).toBe(1);
    expect(outcome.deletedRows['file_manifest']).toBe(3);
    expect(outcome.deletedRows['prompts']).toBe(2);
  });
});
