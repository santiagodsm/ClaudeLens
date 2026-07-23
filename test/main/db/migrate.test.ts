// Migration 0001 and the runner. DESIGN §3.1.7, §3.18, §9.6. STACK ADR-006/007/013.

import { describe, expect, it } from 'vitest';
import { CONNECTION_PRAGMAS, nativeModuleId } from '../../../src/main/db/driver';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  currentSchemaVersion,
  migrate,
} from '../../../src/main/db/migrate';
import { isDbError } from '../../../src/main/db/errors';
import { RECOMPUTE_PROJECT_DISPLAY_NAMES } from '../../../src/main/db/repositories/ingest-repo';
import { useSandbox } from '../../support/sandbox';
import { T0, useTestDatabases } from './helpers';

/**
 * Every table §3.2–§3.17 declares, in the creation order migration 0001 uses, plus every table a
 * later numbered migration adds. `harness_run_agents` arrives with 0004 (ADR-039) and is sorted
 * in below rather than appended, because the assertion compares a sorted list.
 */
const EXPECTED_TABLES = [
  'harness_run_agents',
  'file_manifest',
  'projects',
  'sessions',
  'events',
  'tool_calls',
  'subagent_runs',
  'file_touches',
  'prompts',
  'harness_nodes',
  'harness_edges',
  'price_rows',
  // A-05, migration 0005 — the renamed-aside pre-image of `price_rows`. It exists because
  // ADR-026 forbids dropping a USER table and SQLite cannot ALTER a CHECK constraint.
  'price_rows_pre_0005',
  // ADR-040, migration 0007 — the user's "these folders are the same project". Both USER class.
  'project_groups',
  'project_group_members',
  'bloat_flags',
  'settings',
  'audit_log',
  'archives',
  'stats_cache_days',
  'meta',
];

describe('the dual-ABI driver (STACK ADR-006)', () => {
  it('resolves the Node-ABI install when not running under Electron', () => {
    // Vitest's `main` project runs under Node (ABI 137); the app runs under Electron (146).
    // This assertion is the seam: if it ever reads 'better-sqlite3-electron' here, every
    // SQLite test in the suite is about to fail with NODE_MODULE_VERSION mismatch.
    expect(process.versions.electron).toBeUndefined();
    expect(nativeModuleId()).toBe('better-sqlite3');
  });
});

describe('connection pragmas (§3.1.7)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('applies all four on a fresh connection, before any migration', () => {
    // A real file, not ':memory:' — WAL does not exist in an in-memory database (ADR-013).
    const db = dbs.openRaw();

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('applies them on every connection, not just the first', () => {
    dbs.openRaw('shared.db');
    const second = dbs.openRaw('shared.db');
    expect(second.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(second.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('names the four pragmas §3.1.7 requires and no others', () => {
    expect([...CONNECTION_PRAGMAS]).toEqual([
      'foreign_keys = ON',
      'journal_mode = WAL',
      'synchronous = NORMAL',
      'busy_timeout = 5000',
    ]);
  });
});

describe('migrate() (STACK ADR-007)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('applies every migration cleanly from an empty file and sets user_version', () => {
    const db = dbs.openRaw();
    expect(currentSchemaVersion(db)).toBe(0);

    const outcome = migrate(db);

    // A-09 added `0002-tool-call-description.sql`, E10 `0003-harness-node-entry-count.sql`,
    // ADR-039 `0004-project-harness.sql`, A-05 `0005-cache-write-1h.sql` and §3.3
    // `0006-project-display-name-from-cwd.sql`. `0001` is merged and therefore immutable
    // (STACK ADR-007, §3.18), so a schema change is a new file and the latest version moves.
    // ⚠️ Asserted against the registry rather than against a copy of it: this suite and
    // `MIGRATIONS` are edited by different changes, and a hand-copied list here means the next
    // migration lands with a red test that says nothing about the migration. What matters — and
    // what is asserted — is that EVERY registered file applied, in order, and that the version
    // the database ends at is the one the code expects.
    expect(outcome).toEqual({
      from: 0,
      to: LATEST_SCHEMA_VERSION,
      applied: MIGRATIONS.map((migration) => migration.name),
    });
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    // The registry is dense and ascending (asserted separately), so the latest version is the
    // number of files. ADR-040 took it to 7.
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
  });

  it('renames existing projects after their real folder in 0006 (§3.3 amended 2026-07-22)', () => {
    // ⚠️ The bug this migration exists for: decoding `encoded_name` is lossy, so a folder whose
    // own name contains a hyphen was named after its last chunk only — `Home-Media-Server`
    // showed as "Server". A database that already holds those names must be corrected at upgrade,
    // not on some future day when a file happens to change.
    //
    // The upgrade is simulated honestly: migrations 0001–0005 are applied, the legacy rows are
    // written as the old code would have written them, and then `migrate()` applies 0006 alone.
    const db = dbs.openRaw();
    const upTo5 = db.transaction((): void => {
      for (const migration of MIGRATIONS.filter((m) => m.version <= 5)) db.exec(migration.sql);
      db.exec('PRAGMA user_version = 5');
    });
    upTo5();

    db.prepare(
      `INSERT INTO file_manifest (id, rel_path, kind, size_bytes, mtime_ms, byte_offset,
         lines_parsed, bad_lines, content_hash, first_seen_at, last_seen_at, parsed_at)
       VALUES (1, 'projects/-work-demo-Home-Media-Server/s.jsonl', 'transcript', 1, ?, 1, 1, 0,
               NULL, ?, ?, ?)`,
    ).run(T0, T0, T0, T0);
    db.prepare(
      // 'Server' and 'Booth' are exactly what the old rule stored; 'Alone' has no events with a cwd.
      `INSERT INTO projects (id, encoded_name, display_name, color_index)
       VALUES (1, '-work-demo-Home-Media-Server', 'Server', 0),
              (2, '-work-demo-Photo-Booth', 'Booth', 1),
              (3, '-work-demo-No-Cwd-Alone', 'Alone', 2)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, project_id, transcript_file_id) VALUES ('s1', 1, 1), ('s2', 2, 1), ('s3', 3, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO events (id, event_key, session_id, project_id, source_file_id, line_no, ts,
         type, origin, cwd)
       VALUES (1, 'e1', 's1', 1, 1, 1, ?, 'user', 'main', '/work/demo/Home-Media-Server'),
              (2, 'e2', 's2', 2, 1, 2, ?, 'user', 'main', '/work/demo/Photo-Booth/packages/ui'),
              (3, 'e3', 's3', 3, 1, 3, ?, 'user', 'main', NULL)`,
    ).run(T0, T0, T0);

    const outcome = migrate(db);

    // Everything above 5 applies; what this case is about is that 0006 is among them and did its
    // work. Naming the whole list here would make the next migration break a test about names.
    expect(outcome.applied).toContain('0006-project-display-name-from-cwd.sql');
    expect(outcome.from).toBe(5);
    expect(outcome.to).toBe(LATEST_SCHEMA_VERSION);
    expect(
      db
        .prepare<{
          encoded_name: string;
          display_name: string;
        }>('SELECT encoded_name, display_name FROM projects ORDER BY id')
        .all(),
    ).toEqual([
      { encoded_name: '-work-demo-Home-Media-Server', display_name: 'Home-Media-Server' },
      // The `cwd` is two levels below the project root and still names the root.
      { encoded_name: '-work-demo-Photo-Booth', display_name: 'Photo-Booth' },
      // No `cwd` anywhere: untouched, so the pre-existing fallback survives the upgrade.
      { encoded_name: '-work-demo-No-Cwd-Alone', display_name: 'Alone' },
    ]);
    // Nothing was purged to achieve it (§3.18, ADR-026): the events are all still there.
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(3);
  });

  it('carries the finalize rule verbatim in 0006, so there is one rule (ADR-007)', () => {
    // The same statement runs at FINALIZING for every future cycle. If the live rule is ever
    // changed, this fails — and it should: a changed rule needs its own numbered migration,
    // because 0006 is merged and immutable.
    const migration = MIGRATIONS.find((m) => m.name === '0006-project-display-name-from-cwd.sql');
    expect(migration?.sql).toContain(RECOMPUTE_PROJECT_DISPLAY_NAMES);
  });

  it('adds harness_nodes.entry_count in 0003 rather than editing 0001 (E10, ADR-007)', () => {
    // ⚠️ §6.9's memory browser and §4.5's `q:memories` both promise an entry count that
    // §3.10's DDL never declared. E10 adds the column rather than fabricating a zero
    // (CLAUDE.md §1), in a NEW numbered file because `0001` and `0002` are merged.
    const db = dbs.openMigrated();
    const columns = db
      .prepare<{ name: string }>('PRAGMA table_info(harness_nodes)')
      .all()
      .map((row) => row.name);
    expect(columns).toContain('entry_count');
    // Nullable: NULL means "not counted", which is the honest value for every non-memory node.
    db.prepare(
      `INSERT INTO harness_nodes (kind, name, source, size_bytes) VALUES ('tool', 'Edit', 'builtin', 0)`,
    ).run();
    expect(
      db.prepare<{ entry_count: number | null }>('SELECT entry_count FROM harness_nodes').get()
        ?.entry_count,
    ).toBeNull();
  });

  it('adds tool_calls.description in 0002 rather than editing 0001 (A-09, ADR-007)', () => {
    // §3.6 (amended) / §3.7 — the column §3.7 and §5.4 rule 9 both assumed. It must arrive
    // as its own numbered file: `0001-initial.sql` is committed, and editing a merged
    // migration leaves already-migrated databases silently divergent from new ones.
    const initial = MIGRATIONS.find((migration) => migration.version === 1);
    const toolCallsDdl = /CREATE TABLE tool_calls \(([\s\S]*?)\n\);/.exec(initial?.sql ?? '');
    expect(toolCallsDdl).not.toBeNull();
    expect(toolCallsDdl?.[1]).not.toContain('description');
    expect(MIGRATIONS.map((migration) => migration.name)).toContain(
      '0002-tool-call-description.sql',
    );

    const db = dbs.openMigrated();
    const columns = db
      .prepare<{
        name: string;
      }>("SELECT ii.name AS name FROM pragma_table_info('tool_calls') ii")
      .all()
      .map((row) => row.name);
    expect(columns).toContain('description');
    expect(columns).toContain('subagent_type');
  });

  it('creates every table of §3.2–§3.17', () => {
    const db = dbs.openMigrated();
    const tables = db
      .prepare<{
        name: string;
      }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    expect(tables.toSorted()).toEqual([...EXPECTED_TABLES].toSorted());
  });

  it('creates the partial and WITHOUT ROWID structures the design leans on', () => {
    const db = dbs.openMigrated();
    const indexes = db
      .prepare<{
        name: string;
        sql: string | null;
      }>("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
      .all();
    const byName = new Map(indexes.map((row) => [row.name, row.sql ?? '']));

    // The partial indexes, each of which encodes a rule rather than an optimisation.
    expect(byName.get('idx_events_priceable')).toContain('is_synthetic = 0');
    expect(byName.get('uq_events_uuid')).toContain('WHERE uuid IS NOT NULL');
    expect(byName.get('uq_price_rows_open')).toContain('WHERE valid_to IS NULL');
    expect(byName.get('idx_file_manifest_archive')).toContain('archive_id IS NOT NULL');
    expect(byName.get('idx_sessions_archive')).toContain('archive_id IS NOT NULL');
    expect(byName.get('idx_audit_log_undoable')).toContain('backup_present = 1');

    // §3.4, §3.13, §3.16, §3.17 are WITHOUT ROWID.
    const withoutRowid = db
      .prepare<{
        name: string;
      }>("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%WITHOUT ROWID%'")
      .all()
      .map((row) => row.name);
    expect(withoutRowid.toSorted()).toEqual(['meta', 'sessions', 'settings', 'stats_cache_days']);
  });

  it('is a no-op when run twice', () => {
    const db = dbs.openMigrated();
    const before = currentSchemaVersion(db);

    const second = migrate(db);

    expect(second).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION, applied: [] });
    expect(currentSchemaVersion(db)).toBe(before);
  });

  it('leaves a database untouched and reports E_DB_MIGRATION_FAILED when a migration fails', () => {
    // ⚠️ §9.6 / ADR-026: the failure path must not drop anything. Standing in for a broken
    // future migration: a database that already owns the name `settings`, so 0001 fails
    // partway through — after several CREATE TABLEs have already run.
    const db = dbs.openRaw();
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, mine TEXT NOT NULL)');
    db.prepare("INSERT INTO settings (key, mine) VALUES ('theme', 'precious-user-data')").run();

    let thrown: unknown;
    try {
      migrate(db);
    } catch (error) {
      thrown = error;
    }

    expect(isDbError(thrown)).toBe(true);
    expect(isDbError(thrown) ? thrown.code : null).toBe('E_DB_MIGRATION_FAILED');
    expect(isDbError(thrown) ? thrown.retryable : null).toBe(false);

    // Rolled back in full: no version bump, no half-built schema, USER data intact.
    expect(currentSchemaVersion(db)).toBe(0);
    const tables = db
      .prepare<{
        name: string;
      }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(['settings']);
    expect(
      db.prepare<{ mine: string }>("SELECT mine FROM settings WHERE key = 'theme'").get(),
    ).toEqual({ mine: 'precious-user-data' });
  });

  it('registers migrations in ascending, gap-free order with unique file names', () => {
    // STACK ADR-007: merged files are immutable and every change is a NEW numbered file.
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual(versions.toSorted((a, b) => a - b));
    expect(versions).toEqual(versions.map((_value, index) => index + 1));
    expect(new Set(MIGRATIONS.map((migration) => migration.name)).size).toBe(MIGRATIONS.length);
  });

  it('carries no "drop and rebuild" path in the migration SQL (ADR-026)', () => {
    for (const migration of MIGRATIONS) {
      expect(migration.sql).not.toMatch(/\bDROP\s+TABLE\b/i);
      expect(migration.sql).not.toMatch(/\bDROP\s+DATABASE\b/i);
      expect(migration.sql).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(migration.sql).not.toMatch(/\bTRUNCATE\b/i);
    }
  });

  it('stores no aggregate column (ADR-027)', () => {
    // If a `total_tokens`-shaped column ever appears, the design has been misread: every
    // count, sum, cost and active time is computed at query time from the fact tables.
    const db = dbs.openMigrated();
    const columns = db
      .prepare<{
        name: string;
      }>(
        "SELECT DISTINCT ii.name AS name FROM sqlite_master m JOIN pragma_table_info(m.name) ii WHERE m.type = 'table'",
      )
      .all()
      .map((row) => row.name);

    for (const column of columns) {
      expect(column).not.toMatch(/^(total_|sum_|count_)/);
    }
    expect(columns).not.toContain('total_tokens');
    expect(columns).not.toContain('active_seconds');
  });

  it('writes nothing to a migrated database on a second run', () => {
    const db = dbs.openMigrated();
    db.prepare(
      'INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('theme', '"dark"', T0, T0);

    migrate(db);

    expect(
      db
        .prepare<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'theme'")
        .get(),
    ).toEqual({ value_json: '"dark"' });
  });
});
