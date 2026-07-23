// ADR-041 — the purge must spare RETAINED-ORPHAN rows exactly as it spares archived ones.
//
// ⚠️ This is the data-loss test at the SQL grain. A purge (a `claudeDir` change or a rebuild)
// that guards on `archive_id IS NULL` but forgets `retained_orphan = 0` does not crash and does
// not warn — it just deletes the history the user kept from a vanished file, and every lifetime
// total shrinks with no marker (§3.18, INV-18). The mutation case below proves the orphan clause
// is load-bearing: strip it and the retained rows die.

import { describe, expect, it } from 'vitest';
import {
  RETAINED_ORPHAN_GUARD,
  auditPurgeStatements,
  deleteTargetTable,
  purge,
} from '../../../src/main/db/purge';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';
import { useSandbox } from '../../support/sandbox';
import { T0, countRows, useTestDatabases } from './helpers';

/**
 * One live session and one RETAINED-ORPHAN session (its file vanished, its history kept). The
 * orphan session carries a full fact-table fan-out — events, tool_calls, file_touches,
 * subagent_runs — so a purge that missed any one guard shows up as a shrunk count.
 */
function seedRetainedOrphanBoundary(db: SqliteDatabase): void {
  db.transaction((): void => {
    db.prepare(
      `INSERT INTO projects (id, encoded_name, display_name, color_index, first_ts, last_ts)
       VALUES (1, '-sandbox-p', 'p', 0, ?, ?)`,
    ).run(T0, T0);

    // File 1 live; file 2 orphaned (gone from disk, retained). Both DERIVED tables.
    db.prepare(
      `INSERT INTO file_manifest (id, rel_path, kind, size_bytes, mtime_ms, byte_offset,
         lines_parsed, bad_lines, content_hash, first_seen_at, last_seen_at, parsed_at,
         archive_id, retained_orphan)
       VALUES (1, 'projects/p/s-live.jsonl',   'transcript', 100, ?, 100, 1, 0, NULL, ?, ?, ?, NULL, 0),
              (2, 'projects/p/s-orphan.jsonl', 'transcript', 200, ?, 200, 1, 0, NULL, ?, ?, ?, NULL, 1),
              (3, 'projects/p/s-orphan/subagents/x.jsonl', 'subagent_transcript', 50, ?, 50, 1, 0, NULL, ?, ?, ?, NULL, 1)`,
    ).run(T0, T0, T0, T0, T0, T0, T0, T0, T0, T0, T0, T0);

    db.prepare(
      `INSERT INTO sessions (id, project_id, transcript_file_id, first_ts, last_ts, git_branch,
         cli_version, is_partial, archive_id, retained_orphan)
       VALUES ('s-live',   1, 1, ?, ?, 'main', '1.0.0', 0, NULL, 0),
              ('s-orphan', 1, 2, ?, ?, 'main', '1.0.0', 0, NULL, 1)`,
    ).run(T0, T0 + 1000, T0, T0 + 1000);

    db.prepare(
      `INSERT INTO events (id, event_key, session_id, project_id, source_file_id, line_no, ts,
         type, role, origin, uuid, is_sidechain, model, is_synthetic, is_api_error,
         tok_input, tok_output, tok_cache_write, tok_cache_read)
       VALUES (1, 'evt-live',   's-live',   1, 1, 1, ?, 'assistant', 'assistant', 'main',     'u-live',   0, 'm', 0, 0, 10, 20, 0, 0),
              (2, 'evt-orphan', 's-orphan', 1, 2, 1, ?, 'assistant', 'assistant', 'main',     'u-orphan', 0, 'm', 0, 0, 30, 40, 0, 0),
              (3, 'evt-orphan-sub', 's-orphan', 1, 3, 1, ?, 'assistant', 'assistant', 'subagent', 'u-osub', 0, 'm', 0, 0, 1, 2, 0, 0)`,
    ).run(T0, T0, T0);

    db.prepare(
      `INSERT INTO tool_calls (id, event_id, session_id, project_id, origin, ts, ordinal,
         tool_name, tool_use_id, skill_name, subagent_type, target_path, is_write_class)
       VALUES (1, 1, 's-live',   1, 'main', ?, 0, 'Edit',  'tu-1', NULL, NULL, 'a.ts', 1),
              (2, 2, 's-orphan', 1, 'main', ?, 0, 'Write', 'tu-2', NULL, NULL, 'b.ts', 1)`,
    ).run(T0, T0);

    db.prepare(
      `INSERT INTO file_touches (id, tool_call_id, session_id, project_id, ts, path, basename,
         extension, language, tool_name)
       VALUES (1, 1, 's-live',   1, ?, 'a.ts', 'a.ts', 'ts', 'TypeScript', 'Edit'),
              (2, 2, 's-orphan', 1, ?, 'b.ts', 'b.ts', 'ts', 'TypeScript', 'Write')`,
    ).run(T0, T0);

    db.prepare(
      `INSERT INTO subagent_runs (id, session_id, project_id, transcript_file_id, spawn_event_id,
         spawn_tool_call_id, subagent_type, description, first_ts, last_ts)
       VALUES (1, 's-orphan', 1, 3, NULL, NULL, 'reviewer', NULL, ?, ?)`,
    ).run(T0, T0);
  })();
}

describe('purge() across the retained-orphan boundary (ADR-041, INV-18)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('deletes the live session and keeps every retained-orphan row', () => {
    const db = dbs.openMigrated();
    seedRetainedOrphanBoundary(db);

    purge(db);

    const ids = (table: string, column: string): unknown[] =>
      db
        .prepare<Record<string, unknown>>(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`)
        .all()
        .map((row) => row['id']);

    // ---- RETAINED-ORPHAN: survives (ADR-041) --------------------------------------
    expect(ids('sessions', 'id')).toEqual(['s-orphan']);
    expect(ids('file_manifest', 'id')).toEqual([2, 3]); // the orphan transcript + its subagent
    expect(ids('events', 'event_key')).toEqual(['evt-orphan', 'evt-orphan-sub']);
    expect(ids('tool_calls', 'id')).toEqual([2]);
    expect(ids('file_touches', 'id')).toEqual([2]);
    expect(ids('subagent_runs', 'id')).toEqual([1]);
    // §3.18 "keep archived projects" — the project owning a surviving (retained) session stays.
    expect(ids('projects', 'id')).toEqual([1]);

    // ---- the live side is gone (derivable, would be re-synced) ---------------------
    expect(
      db
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE session_id = 's-live'")
        .get()?.n,
    ).toBe(0);
  });

  it('moves no number the retained-orphan rows contribute to (INV-18)', () => {
    const db = dbs.openMigrated();
    seedRetainedOrphanBoundary(db);

    const orphanTokens = (): number =>
      db
        .prepare<{ total: number | null }>(
          `SELECT SUM(tok_input + tok_output + tok_cache_write + tok_cache_read) AS total
           FROM events WHERE session_id = 's-orphan'`,
        )
        .get()?.total ?? 0;

    // Hand-computed: evt-orphan 30+40, evt-orphan-sub 1+2 = 73.
    expect(orphanTokens()).toBe(73);
    purge(db);
    expect(orphanTokens()).toBe(73);
  });

  it('MUTATION CHECK: a purge guard missing the orphan clause destroys the kept history', () => {
    const db = dbs.openMigrated();
    seedRetainedOrphanBoundary(db);

    // The §3.18 statements as they would read if someone "simplified" them back to the
    // archive-only guard — every `retained_orphan = 0` clause stripped. This is the exact bug
    // `auditPurgeStatements` exists to catch; here we run it to show what it costs.
    const mutated = [
      'DELETE FROM events      WHERE source_file_id IN (SELECT id FROM file_manifest WHERE archive_id IS NULL)',
      'DELETE FROM tool_calls  WHERE session_id     IN (SELECT id FROM sessions      WHERE archive_id IS NULL)',
      'DELETE FROM file_touches WHERE session_id    IN (SELECT id FROM sessions      WHERE archive_id IS NULL)',
      'DELETE FROM subagent_runs WHERE session_id   IN (SELECT id FROM sessions      WHERE archive_id IS NULL)',
      'DELETE FROM sessions      WHERE archive_id IS NULL',
      'DELETE FROM file_manifest WHERE archive_id IS NULL',
    ];

    // The audit flags EVERY one of them as a blocking finding — the gate would refuse to ship it.
    for (const statement of mutated) {
      const table = deleteTargetTable(statement);
      expect(statement.includes(RETAINED_ORPHAN_GUARD)).toBe(false);
      expect(
        auditPurgeStatements([statement]).some(
          (finding) => finding.reason === 'missing-orphan-guard' && finding.table === table,
        ),
      ).toBe(true);
    }

    // And if it DID ship: run the mutated purge and watch the retained history die.
    db.transaction((): void => {
      for (const statement of mutated) db.prepare(statement).run();
    })();

    expect(countRows(db, 'events')).toBe(0); // the retained 2 events are GONE
    expect(
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE id = 's-orphan'").get()
        ?.n,
    ).toBe(0);
    // This is the silent shrink INV-18 forbids — proven by construction, not asserted by comment.
  });
});
