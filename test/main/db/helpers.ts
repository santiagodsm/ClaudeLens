// Shared helpers for the E2 database tests.
//
// STACK ADR-013: every fs/DB-touching test opens with `const sandbox = useSandbox()` and gets
// ONE SQLite file, inside that sandbox. `:memory:` is reserved for pure SQL-shape assertions
// — anything touching WAL, migrations or the manifest needs a real file, because WAL and the
// byte-offset story do not exist in an in-memory database.
//
// This file is not a test (the `main` project only collects `*.{test,spec}.ts`).

import { afterEach } from 'vitest';
import { openDatabase } from '../../../src/main/db/driver';
import { migrate } from '../../../src/main/db/migrate';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';
import type { Sandbox } from '../../support/sandbox';

export interface TestDatabases {
  /** A connection with the §3.1.7 pragmas applied and no schema. */
  openRaw(fileName?: string): SqliteDatabase;
  /** A connection with migration 0001 applied. */
  openMigrated(fileName?: string): SqliteDatabase;
}

/** Opens databases inside `sandbox` and closes every one of them after the test. */
export function useTestDatabases(sandbox: Sandbox): TestDatabases {
  const opened: SqliteDatabase[] = [];

  afterEach(() => {
    while (opened.length > 0) {
      opened.pop()?.close();
    }
  });

  const openRaw = (fileName = 'claude-lens.db'): SqliteDatabase => {
    const db = openDatabase(sandbox.resolve(fileName));
    opened.push(db);
    return db;
  };

  return {
    openRaw,
    openMigrated: (fileName = 'claude-lens.db'): SqliteDatabase => {
      const db = openRaw(fileName);
      migrate(db);
      return db;
    },
  };
}

/** A fixed instant, so nothing in these tests depends on a clock (CLAUDE.md §1). */
export const T0 = 1_750_000_000_000;

/** Every table in migration 0001, for the "byte-identical" comparisons the purge test makes. */
export function dumpTable(db: SqliteDatabase, table: string): unknown[] {
  // `table` is a literal from the test's own list, never user input.
  return db.prepare(`SELECT * FROM ${table}`).all();
}

export function countRows(db: SqliteDatabase, table: string): number {
  const row = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return row?.n ?? -1;
}

/**
 * Seeds a dataset that straddles the archive boundary: for every fact table, one row that is
 * live (`archive_id IS NULL`, DERIVED) and one that is RETAINED (`archive_id IS NOT NULL`),
 * plus rows in all four USER tables.
 *
 * This shape is the point. A purge fixture with no archived rows proves nothing about
 * INV-18, and one with no USER rows proves nothing about INV-12.
 */
export function seedAcrossArchiveBoundary(db: SqliteDatabase): void {
  const seed = db.transaction((): void => {
    // USER — §3.14 / §3.15. `archives.audit_id` needs its ACT-07 entry first.
    db.prepare(
      `INSERT INTO audit_log (id, action_type, status, claude_dir, target_summary, targets_json,
         bytes_affected, backup_rel_path, backup_bytes, backup_present, started_at, finished_at,
         created_at, updated_at)
       VALUES (1, 'archive-sessions', 'completed', '/sandbox/.claude', '1 session',
               '["projects/p2/s-archived.jsonl"]', 2048, '.claude-lens-backups/x-1', 0, 1,
               ?, ?, ?, ?)`,
    ).run(T0, T0, T0, T0);

    db.prepare(
      `INSERT INTO archives (id, audit_id, archive_root, claude_dir, session_count, file_count,
         bytes_moved, range_from_ts, range_to_ts, last_reachable_at, reachable, created_at, updated_at)
       VALUES (1, 1, '/sandbox/archive', '/sandbox/.claude', 1, 2, 2048, ?, ?, ?, 1, ?, ?)`,
    ).run(T0, T0 + 60_000, T0, T0, T0);

    // USER — §3.11. Two open-ended rows for two different token classes: legal.
    db.prepare(
      `INSERT INTO price_rows (id, model, token_class, rate_picousd_per_token, valid_from,
         valid_to, source, source_url, note, created_at, updated_at)
       VALUES (1, 'model-a', 'input', 3000000, ?, NULL, 'seed', NULL, NULL, ?, ?),
              (2, 'model-a', 'cache_write', 312500, ?, NULL, 'manual', NULL, 'hand-corrected', ?, ?)`,
    ).run(T0, T0, T0, T0, T0, T0);

    // USER — §3.13.
    db.prepare(
      `INSERT INTO settings (key, value_json, created_at, updated_at) VALUES ('theme', '"dark"', ?, ?)`,
    ).run(T0, T0);

    // DERIVED/RETAINED — §3.2. 1,3,4 live; 2,5 archived.
    db.prepare(
      `INSERT INTO file_manifest (id, rel_path, kind, size_bytes, mtime_ms, byte_offset,
         lines_parsed, bad_lines, content_hash, first_seen_at, last_seen_at, parsed_at,
         archive_id, archive_rel_path)
       VALUES (1, 'projects/p1/s-live.jsonl',            'transcript',          100, ?, 100, 2, 0, NULL, ?, ?, ?, NULL, NULL),
              (2, 'projects/p2/s-archived.jsonl',        'transcript',          200, ?, 200, 2, 0, NULL, ?, ?, ?, 1,    'p2/s-archived.jsonl'),
              (3, 'history.jsonl',                       'history',             300, ?, 300, 2, 0, NULL, ?, ?, ?, NULL, NULL),
              (4, 'projects/p1/s-live/subagents/a.jsonl','subagent_transcript', 400, ?, 400, 1, 0, NULL, ?, ?, ?, NULL, NULL),
              (5, 'projects/p2/s-archived/subagents/b.jsonl','subagent_transcript', 500, ?, 500, 1, 0, NULL, ?, ?, ?, 1, 'p2/s-archived/subagents/b.jsonl')`,
    ).run(T0, T0, T0, T0, T0, T0, T0, T0, T0, T0, T0, T0, T0, T0, T0, T0, T0, T0, T0, T0);

    // DERIVED — §3.3.
    db.prepare(
      `INSERT INTO projects (id, encoded_name, display_name, color_index, first_ts, last_ts)
       VALUES (1, '-sandbox-p1', 'p1', 0, ?, ?), (2, '-sandbox-p2', 'p2', 1, ?, ?)`,
    ).run(T0, T0, T0, T0);

    // DERIVED + RETAINED — §3.4.
    db.prepare(
      `INSERT INTO sessions (id, project_id, transcript_file_id, first_ts, last_ts, git_branch,
         cli_version, is_partial, archive_id)
       VALUES ('s-live',     1, 1, ?, ?, 'main', '1.0.0', 0, NULL),
              ('s-archived', 2, 2, ?, ?, 'main', '1.0.0', 0, 1)`,
    ).run(T0, T0 + 60_000, T0, T0 + 60_000);

    // DERIVED + RETAINED — §3.5.
    db.prepare(
      `INSERT INTO events (id, event_key, session_id, project_id, source_file_id, line_no, ts,
         type, role, origin, uuid, is_sidechain, model, is_synthetic, is_api_error,
         tok_input, tok_output, tok_cache_write, tok_cache_read)
       VALUES (1, 'evt-live',     's-live',     1, 1, 1, ?, 'assistant', 'assistant', 'main',     'u-live',     0, 'model-a', 0, 0, 10, 20, 0, 0),
              (2, 'evt-archived', 's-archived', 2, 2, 1, ?, 'assistant', 'assistant', 'main',     'u-archived', 0, 'model-a', 0, 0, 30, 40, 0, 0),
              (3, 'evt-sub-live', 's-live',     1, 4, 1, ?, 'assistant', 'assistant', 'subagent', 'u-sub-live', 0, 'model-a', 0, 0,  1,  2, 0, 0)`,
    ).run(T0, T0, T0);

    // DERIVED + RETAINED — §3.6.
    db.prepare(
      `INSERT INTO tool_calls (id, event_id, session_id, project_id, origin, ts, ordinal,
         tool_name, tool_use_id, skill_name, subagent_type, target_path, is_write_class)
       VALUES (1, 1, 's-live',     1, 'main', ?, 0, 'Edit',  'tu-1', NULL, NULL, 'src/a.ts', 1),
              (2, 2, 's-archived', 2, 'main', ?, 0, 'Write', 'tu-2', NULL, NULL, 'src/b.ts', 1)`,
    ).run(T0, T0);

    // DERIVED + RETAINED — §3.8.
    db.prepare(
      `INSERT INTO file_touches (id, tool_call_id, session_id, project_id, ts, path, basename,
         extension, language, tool_name)
       VALUES (1, 1, 's-live',     1, ?, 'src/a.ts', 'a.ts', 'ts', 'TypeScript', 'Edit'),
              (2, 2, 's-archived', 2, ?, 'src/b.ts', 'b.ts', 'ts', 'TypeScript', 'Write')`,
    ).run(T0, T0);

    // DERIVED + RETAINED — §3.7.
    db.prepare(
      `INSERT INTO subagent_runs (id, session_id, project_id, transcript_file_id, spawn_event_id,
         spawn_tool_call_id, subagent_type, description, first_ts, last_ts)
       VALUES (1, 's-live',     1, 4, NULL, NULL, 'reviewer', NULL, ?, ?),
              (2, 's-archived', 2, 5, NULL, NULL, 'reviewer', NULL, ?, ?)`,
    ).run(T0, T0, T0, T0);

    // DERIVED — §3.9. Always fully rebuildable from history.jsonl.
    db.prepare(
      `INSERT INTO prompts (id, source_file_id, line_no, ts, project_id, raw_project, session_id,
         display_preview, display_chars)
       VALUES (1, 3, 1, ?, 1, '-sandbox-p1', 's-live', 'hello', 5),
              (2, 3, 2, ?, 2, '-sandbox-p2', 's-archived', 'world', 5)`,
    ).run(T0, T0);

    // DERIVED — §3.10, §3.12, §3.16, §3.17.
    db.prepare(
      `INSERT INTO harness_nodes (id, kind, name, source, rel_path, size_bytes, file_id)
       VALUES (1, 'skill', 'alpha', 'user', 'skills/alpha/SKILL.md', 10, NULL),
              (2, 'tool',  'Edit',  'builtin', NULL, 0, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO harness_edges (id, from_id, to_id, kind, evidence)
       VALUES (1, 1, 2, 'tool_grant', 'frontmatter')`,
    ).run();
    db.prepare(
      `INSERT INTO bloat_flags (id, rule_id, severity, title, location, size_bytes, item_count,
         rationale, action_type, action_payload, detected_at)
       VALUES (1, 'BR-01', 'high', 'Large directory', 'file-history', 1024, 1, 'big', NULL, NULL, ?)`,
    ).run(T0);
    db.prepare(
      `INSERT INTO stats_cache_days (day, raw_json, source_file_id) VALUES ('2026-07-01', '{}', 3)`,
    ).run();
    db.prepare(
      `INSERT INTO meta (key, value_json, updated_at) VALUES ('badLineTotal', '0', ?)`,
    ).run(T0);
  });
  seed();
}
