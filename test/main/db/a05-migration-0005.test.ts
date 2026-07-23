// Migration 0005 — the fifth token class (A-05). STACK ADR-007, DESIGN §3.5, §3.11, §3.18, §9.6.
//
// Three things are under test, and only the first is about the new columns:
//
//   1. the migration applies cleanly and the new schema is exactly what §3.5 / §3.11 now say;
//   2. ⚠️ `0001`–`0004` are UNTOUCHED — the change arrived in a new numbered file, which is what
//      ADR-007 means by "merged migration files are immutable". A database that has only ever
//      seen `0001`–`0003` must NOT already have the column;
//   3. ⚠️⚠️ the RETAINED guard still holds afterwards (INV-18, ADR-033). 0005 is the only
//      migration in this project that rewrites a USER table rather than adding to it, so "did the
//      archived rows survive?" is a question that has to be asked out loud, not assumed.

import { describe, expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  currentSchemaVersion,
  migrate,
} from '../../../src/main/db/migrate';
import { purge } from '../../../src/main/db/purge';
import { useSandbox } from '../../support/sandbox';
import { T0, countRows, dumpTable, seedAcrossArchiveBoundary, useTestDatabases } from './helpers';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';

/** The identifiers A-05 introduced. None of them may appear in an earlier migration file. */
const A05_IDENTIFIERS = ['tok_cache_write_1h', 'cache_write_1h', 'cache_split_mismatches'];

function columnsOf(db: SqliteDatabase, table: string): { name: string; notnull: number }[] {
  return db
    .prepare<{ name: string; notnull: number }>(`SELECT name, "notnull" FROM pragma_table_info(?)`)
    .all(table);
}

describe('migration 0005 — the fifth token class (A-05)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('applies cleanly and lands at the version the code expects', () => {
    const db = dbs.openRaw();
    const outcome = migrate(db);

    expect(outcome.applied).toContain('0005-cache-write-1h.sql');
    // Version-agnostic on purpose: later migrations must be free to land without editing this
    // assertion, but 0005 must always be one of the files a fresh database applies.
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
  });

  it('adds `events.tok_cache_write_1h` NULLABLE, because NULL is "not known"', () => {
    const db = dbs.openMigrated();
    const column = columnsOf(db, 'events').find((c) => c.name === 'tok_cache_write_1h');

    expect(column).toBeDefined();
    // ⚠️ NOT NULL would have forced a default, and a default of `0` on a pre-existing row is a
    // CLAIM — "this row had no 1-hour cache writes" — that nothing in the data supports. NULL is
    // "not counted", exactly as `harness_nodes.entry_count` uses it (migration 0003), and §4.6
    // reports how many such rows there are instead of the app quietly asserting zero.
    expect(column?.notnull).toBe(0);

    // The other four keep their §3.5 shape: NOT NULL, defaulted to 0.
    for (const name of ['tok_input', 'tok_output', 'tok_cache_write', 'tok_cache_read']) {
      expect(columnsOf(db, 'events').find((c) => c.name === name)?.notnull).toBe(1);
    }
  });

  it('adds `file_manifest.cache_split_mismatches`, mirroring `bad_lines`', () => {
    const db = dbs.openMigrated();
    const column = columnsOf(db, 'file_manifest').find((c) => c.name === 'cache_split_mismatches');
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(1); // a count, always known, starts at 0
  });

  it('admits `cache_write_1h` into price_rows.token_class and still rejects anything else', () => {
    const db = dbs.openMigrated();
    const insert = db.prepare(
      `INSERT INTO price_rows (model, token_class, rate_picousd_per_token, valid_from, valid_to,
         source, created_at, updated_at)
       VALUES (?, ?, 1, 0, NULL, 'manual', 0, 0)`,
    );

    expect(() => {
      insert.run('m', 'cache_write_1h');
    }).not.toThrow();
    // The CHECK is still a CLOSED set — widened by exactly one value, not removed (ADR-025's
    // principle applied to the class name: no fuzzy matching, no open vocabulary).
    expect(() => {
      insert.run('m', 'cache_write_2h');
    }).toThrow();
  });

  it('⚠️ carries every price row across the CHECK widening, id included', () => {
    // §3.11 `price_rows` is USER class: hand-corrected rates and effective dates have NO other
    // source (ADR-026, §9.4). SQLite cannot ALTER a CHECK, so 0005 renames the original table
    // aside and copies every row into the new definition — and this is the assertion that the
    // copy is faithful rather than approximately faithful.
    const db = dbs.openRaw();
    db.exec(MIGRATIONS[0]?.sql ?? '');
    db.exec(MIGRATIONS[1]?.sql ?? '');
    db.exec(MIGRATIONS[2]?.sql ?? '');
    db.exec(MIGRATIONS[3]?.sql ?? '');
    db.exec('PRAGMA user_version = 4');

    db.prepare(
      `INSERT INTO price_rows (id, model, token_class, rate_picousd_per_token, valid_from,
         valid_to, source, source_url, note, created_at, updated_at)
       VALUES (7,  'model-a', 'input',       5000000, ?, NULL, 'seed',   NULL, NULL,             ?, ?),
              (11, 'model-a', 'cache_write',  312500, ?, NULL, 'manual', NULL, 'hand-corrected', ?, ?)`,
    ).run(T0, T0, T0, T0, T0, T0);
    const before = dumpTable(db, 'price_rows');

    migrate(db);

    expect(dumpTable(db, 'price_rows')).toEqual(before);
    // ⚠️ And the pre-image survives, untouched: ADR-026 says `price_rows` is never dropped and is
    // carried across every migration, so 0005 renames rather than destroys. The surviving table
    // is the only in-database record of what the USER table held before the rewrite (§9.4).
    expect(dumpTable(db, 'price_rows_pre_0005')).toEqual(before);
    // The two indexes came back under their original names (§3.11).
    const indexes = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'price_rows'",
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toContain('idx_price_rows_cover');
    expect(indexes).toContain('uq_price_rows_open');
  });

  it('⚠️ left 0001–0004 alone: none of them mentions anything A-05 introduced (ADR-007)', () => {
    for (const migration of MIGRATIONS.filter((m) => m.version < 5)) {
      for (const identifier of A05_IDENTIFIERS) {
        expect(migration.sql).not.toContain(identifier);
      }
    }
    // …and 0005 is where all three of them live.
    const latest = MIGRATIONS.find((m) => m.version === 5);
    for (const identifier of A05_IDENTIFIERS) {
      expect(latest?.sql).toContain(identifier);
    }
  });

  it('⚠️ a database stopped at 0003 does NOT have the column — it arrives via 0005', () => {
    // The concrete form of "0001 is immutable": if the column had been added by editing 0001, a
    // partially-migrated database would already have it, and every already-shipped database would
    // silently diverge from a freshly created one (ADR-007, §3.18).
    const db = dbs.openRaw();
    db.exec(MIGRATIONS[0]?.sql ?? '');
    db.exec(MIGRATIONS[1]?.sql ?? '');
    db.exec(MIGRATIONS[2]?.sql ?? '');
    db.exec('PRAGMA user_version = 3');

    expect(columnsOf(db, 'events').map((c) => c.name)).not.toContain('tok_cache_write_1h');

    migrate(db);

    expect(columnsOf(db, 'events').map((c) => c.name)).toContain('tok_cache_write_1h');
    // Every pre-existing row is NOT KNOWN, never 0 — that is the whole disclosure mechanism.
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
  });

  it('⚠️⚠️ leaves the RETAINED rows alone, before and after a purge (INV-18, ADR-033)', () => {
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);

    // Give the archived session a cache-writing event with an UNKNOWN split — the exact row A-05
    // can never repair, and therefore the exact row a careless migration or purge would erase
    // without anything failing.
    db.prepare(
      `INSERT INTO events (id, event_key, session_id, project_id, source_file_id, line_no, ts,
         type, role, origin, uuid, is_sidechain, model, is_synthetic, is_api_error,
         tok_input, tok_output, tok_cache_write, tok_cache_write_1h, tok_cache_read)
       VALUES (99, 'evt-archived-cw', 's-archived', 2, 2, 2, ?, 'assistant', 'assistant', 'main',
               'u-archived-cw', 0, 'model-a', 0, 0, 0, 0, 5000, NULL, 0)`,
    ).run(T0);

    const archivedBefore = db
      .prepare(`SELECT * FROM events WHERE session_id = 's-archived' ORDER BY id`)
      .all();
    expect(archivedBefore).toHaveLength(2);

    purge(db);

    // Byte-identical, NULL split included: a purge that "helpfully" defaulted it to 0 would be
    // asserting something about data it can never re-read (§5.3 `ARCHIVED`, §9.4).
    expect(
      db.prepare(`SELECT * FROM events WHERE session_id = 's-archived' ORDER BY id`).all(),
    ).toEqual(archivedBefore);
    expect(countRows(db, 'price_rows')).toBeGreaterThan(0);
    expect(countRows(db, 'price_rows_pre_0005')).toBe(0); // empty here, but never deleted either
  });
});
