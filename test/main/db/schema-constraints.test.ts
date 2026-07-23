// The constraints §3 leans on, proven to bite. DESIGN §3.4–§3.11, ADR-019/024/027.
//
// Each of these is a rule the design states in prose AND encodes in DDL. The test is here
// because the prose is not what runs: if `uq_price_rows_open` were ever dropped, two
// open-ended rates would coexist and every cost using that model would silently pick one.

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../../support/sandbox';
import { T0, countRows, useTestDatabases } from './helpers';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';

/** The minimum FK-satisfying spine: one manifest row, one project, one session. */
function seedSpine(db: SqliteDatabase): void {
  db.prepare(
    `INSERT INTO file_manifest (id, rel_path, kind, size_bytes, mtime_ms, first_seen_at, last_seen_at)
     VALUES (1, 'projects/p/s.jsonl', 'transcript', 10, ?, ?, ?)`,
  ).run(T0, T0, T0);
  db.prepare(
    `INSERT INTO projects (id, encoded_name, display_name, color_index) VALUES (1, '-p', 'p', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (id, project_id, transcript_file_id, first_ts, last_ts)
     VALUES ('s', 1, 1, ?, ?)`,
  ).run(T0, T0 + 90_000);
}

const INSERT_EVENT = `INSERT INTO events (event_key, session_id, project_id, source_file_id, line_no, ts, type, origin)
VALUES (?, 's', 1, 1, ?, ?, 'assistant', 'main')`;

describe('events.event_key (§3.5, ADR-019)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('is UNIQUE, so a second insert of the same key is rejected', () => {
    const db = dbs.openMigrated();
    seedSpine(db);
    db.prepare(INSERT_EVENT).run('evt-1', 1, T0);

    expect(() => db.prepare(INSERT_EVENT).run('evt-1', 2, T0)).toThrow(/UNIQUE constraint failed/);
  });

  it('makes ON CONFLICT DO NOTHING idempotent — re-ingest changes no count (INV-03)', () => {
    const db = dbs.openMigrated();
    seedSpine(db);
    const ingest = db.prepare(`${INSERT_EVENT} ON CONFLICT(event_key) DO NOTHING`);

    const first = ingest.run('evt-1', 1, T0);
    const second = ingest.run('evt-1', 1, T0);
    // The same record met again in a second file: different line, same key.
    const third = ingest.run('evt-1', 99, T0);

    expect(first.changes).toBe(1);
    expect(second.changes).toBe(0);
    expect(third.changes).toBe(0);
    expect(countRows(db, 'events')).toBe(1);
  });
});

describe('price_rows (§3.11)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  const insertPrice = (db: SqliteDatabase) =>
    db.prepare(
      `INSERT INTO price_rows (model, token_class, rate_picousd_per_token, valid_from, valid_to,
         source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
    );

  it('permits at most ONE open-ended row per (model, token_class) — uq_price_rows_open', () => {
    const db = dbs.openMigrated();
    const insert = insertPrice(db);
    insert.run('model-a', 'input', 3_000_000, T0, null, T0, T0);

    expect(() => insert.run('model-a', 'input', 4_000_000, T0 + 1, null, T0, T0)).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('permits an open-ended row per token class and per model', () => {
    const db = dbs.openMigrated();
    const insert = insertPrice(db);
    insert.run('model-a', 'input', 3_000_000, T0, null, T0, T0);
    insert.run('model-a', 'output', 15_000_000, T0, null, T0, T0);
    insert.run('model-b', 'input', 1_000_000, T0, null, T0, T0);

    expect(countRows(db, 'price_rows')).toBe(3);
  });

  it('permits many CLOSED rows per key — history accrues (auto-versioning, §3.11)', () => {
    const db = dbs.openMigrated();
    const insert = insertPrice(db);
    insert.run('model-a', 'input', 3_000_000, T0, T0 + 1000, T0, T0);
    insert.run('model-a', 'input', 3_500_000, T0 + 1000, T0 + 2000, T0, T0);
    insert.run('model-a', 'input', 4_000_000, T0 + 2000, null, T0, T0);

    expect(countRows(db, 'price_rows')).toBe(3);
  });

  it('accepts exactly the four token classes and rejects anything else', () => {
    const db = dbs.openMigrated();
    const insert = insertPrice(db);

    for (const tokenClass of ['input', 'output', 'cache_write', 'cache_read']) {
      insert.run('model-a', tokenClass, 1_000_000, T0, null, T0, T0);
    }
    expect(countRows(db, 'price_rows')).toBe(4);

    for (const bad of ['reasoning', 'INPUT', 'cache-write', '']) {
      expect(() => insert.run('model-b', bad, 1_000_000, T0, null, T0, T0)).toThrow(
        /CHECK constraint failed/,
      );
    }
  });

  it('rejects a negative rate and an inverted validity range', () => {
    const db = dbs.openMigrated();
    const insert = insertPrice(db);

    expect(() => insert.run('model-a', 'input', -1, T0, null, T0, T0)).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insert.run('model-a', 'input', 1_000_000, T0, T0, T0, T0)).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('stores $0.3125/Mtok exactly — the reason the unit is picoUSD (ADR-023 amended)', () => {
    const db = dbs.openMigrated();
    // $0.3125 per 1M tokens × 1e6 = 312_500 picoUSD/token. In nanoUSD it would be 312.5,
    // which is not an integer — rounding a RATE multiplies into every total that uses it.
    insertPrice(db).run('model-a', 'cache_write', 312_500, T0, null, T0, T0);

    const row = db
      .prepare<{ rate_picousd_per_token: number }>(
        'SELECT rate_picousd_per_token FROM price_rows WHERE token_class = ?',
      )
      .get('cache_write');
    expect(row?.rate_picousd_per_token).toBe(312_500);
  });
});

describe('tool_calls (§3.6)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('is UNIQUE on (event_id, ordinal), which is what makes ingest idempotent', () => {
    const db = dbs.openMigrated();
    seedSpine(db);
    db.prepare(INSERT_EVENT).run('evt-1', 1, T0);
    const insert = db.prepare(
      `INSERT INTO tool_calls (event_id, session_id, project_id, origin, ts, ordinal, tool_name)
       VALUES (1, 's', 1, 'main', ?, ?, ?)`,
    );

    insert.run(T0, 0, 'Edit');
    insert.run(T0, 1, 'Read'); // a different ordinal in the same message: legal
    expect(() => insert.run(T0, 0, 'Edit')).toThrow(/UNIQUE constraint failed/);
    expect(countRows(db, 'tool_calls')).toBe(2);
  });

  it('constrains origin to the two values of ADR-020', () => {
    const db = dbs.openMigrated();
    seedSpine(db);
    db.prepare(INSERT_EVENT).run('evt-1', 1, T0);

    expect(() =>
      db
        .prepare(
          `INSERT INTO tool_calls (event_id, session_id, project_id, origin, ts, ordinal, tool_name)
           VALUES (1, 's', 1, 'sidechain', ?, 0, 'Edit')`,
        )
        .run(T0),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('sessions.span_seconds (§3.4, ADR-027)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('computes as a generated column rather than being stored', () => {
    const db = dbs.openMigrated();
    seedSpine(db); // first_ts = T0, last_ts = T0 + 90_000

    const row = db
      .prepare<{ span_seconds: number | null }>("SELECT span_seconds FROM sessions WHERE id = 's'")
      .get();
    // 90_000 ms / 1000 = 90 s. Hand-computed, not snapshotted.
    expect(row?.span_seconds).toBe(90);

    // It tracks its inputs: a generated column cannot drift from them (ADR-027).
    db.prepare('UPDATE sessions SET last_ts = ? WHERE id = ?').run(T0 + 150_000, 's');
    expect(
      db
        .prepare<{ span_seconds: number | null }>(
          "SELECT span_seconds FROM sessions WHERE id = 's'",
        )
        .get()?.span_seconds,
    ).toBe(150);
  });

  it('cannot be written directly', () => {
    const db = dbs.openMigrated();
    seedSpine(db);
    expect(() => db.prepare('UPDATE sessions SET span_seconds = 1 WHERE id = ?').run('s')).toThrow(
      /cannot be assigned|generated column/i,
    );
  });
});

describe('ON DELETE CASCADE from file_manifest (§3.1.5)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('removes everything parsed from that file', () => {
    const db = dbs.openMigrated();
    seedSpine(db);
    db.prepare(INSERT_EVENT).run('evt-1', 1, T0);
    db.prepare(
      `INSERT INTO tool_calls (id, event_id, session_id, project_id, origin, ts, ordinal, tool_name)
       VALUES (1, 1, 's', 1, 'main', ?, 0, 'Edit')`,
    ).run(T0);
    db.prepare(
      `INSERT INTO file_touches (tool_call_id, session_id, project_id, ts, path, basename, tool_name)
       VALUES (1, 's', 1, ?, 'src/a.ts', 'a.ts', 'Edit')`,
    ).run(T0);
    db.prepare(
      `INSERT INTO prompts (source_file_id, line_no, ts, display_preview, display_chars)
       VALUES (1, 1, ?, 'hi', 2)`,
    ).run(T0);
    db.prepare(
      `INSERT INTO stats_cache_days (day, raw_json, source_file_id) VALUES ('2026-07-01', '{}', 1)`,
    ).run();

    db.prepare('DELETE FROM file_manifest WHERE id = 1').run();

    // The event went, and its tool call and file touch went with it, two levels down.
    expect(countRows(db, 'events')).toBe(0);
    expect(countRows(db, 'tool_calls')).toBe(0);
    expect(countRows(db, 'file_touches')).toBe(0);
    expect(countRows(db, 'prompts')).toBe(0);
    expect(countRows(db, 'stats_cache_days')).toBe(0);
    // §3.4: the session's transcript link is SET NULL, not cascaded — the session survives.
    expect(countRows(db, 'sessions')).toBe(1);
    expect(
      db
        .prepare<{ transcript_file_id: number | null }>(
          "SELECT transcript_file_id FROM sessions WHERE id = 's'",
        )
        .get()?.transcript_file_id,
    ).toBeNull();
  });

  it('is only possible because foreign_keys = ON is applied on every connection (§3.1.7)', () => {
    const db = dbs.openMigrated();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    seedSpine(db);
    expect(() => db.prepare(INSERT_EVENT).run('evt-orphan', 1, T0)).not.toThrow();
    // A dangling FK is refused rather than silently accepted.
    expect(() =>
      db
        .prepare(
          `INSERT INTO events (event_key, session_id, project_id, source_file_id, line_no, ts, type, origin)
           VALUES ('evt-bad', 'no-such-session', 1, 1, 1, ?, 'assistant', 'main')`,
        )
        .run(T0),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('archives is protected by ON DELETE RESTRICT (§3.15)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('refuses to delete an archives row while a file or session still points at it', () => {
    const db = dbs.openMigrated();
    db.prepare(
      `INSERT INTO audit_log (id, action_type, status, claude_dir, target_summary, targets_json,
         started_at, created_at, updated_at)
       VALUES (1, 'archive-sessions', 'completed', '/sandbox/.claude', '1 session', '[]', ?, ?, ?)`,
    ).run(T0, T0, T0);
    db.prepare(
      `INSERT INTO archives (id, audit_id, archive_root, claude_dir, session_count, file_count,
         bytes_moved, created_at, updated_at)
       VALUES (1, 1, '/sandbox/archive', '/sandbox/.claude', 1, 1, 10, ?, ?)`,
    ).run(T0, T0);
    db.prepare(
      `INSERT INTO file_manifest (id, rel_path, kind, size_bytes, mtime_ms, first_seen_at,
         last_seen_at, archive_id, archive_rel_path)
       VALUES (1, 'projects/p/s.jsonl', 'transcript', 10, ?, ?, ?, 1, 'p/s.jsonl')`,
    ).run(T0, T0, T0);

    expect(() => db.prepare('DELETE FROM archives WHERE id = 1').run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});
