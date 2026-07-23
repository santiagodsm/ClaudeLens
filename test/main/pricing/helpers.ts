// Shared fixture builders for the E5 (Pricing) tests.
//
// STACK ADR-013: every fs/DB-touching test opens with `const sandbox = useSandbox()` and gets ONE
// real SQLite file inside it. No test names a fixed path, and nothing here reaches for `~/.claude`
// — the events these helpers write are synthetic and are built from arguments only (INV-17).
//
// This file is not a test: the `main` Vitest project collects only `*.{test,spec}.ts`.

import type { SqliteDatabase } from '../../../src/main/db/sqlite';

/**
 * A fixed instant, so nothing in these tests depends on a clock (CLAUDE.md §1: never default a
 * timestamp to "now"). 2025-06-15T14:26:40.000Z.
 */
export const T0 = 1_750_000_000_000;

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

export interface EventSpec {
  readonly eventKey: string;
  readonly ts: number;
  readonly model: string | null;
  readonly input?: number;
  readonly output?: number;
  readonly cacheWrite?: number;
  /**
   * A-05 — the 1-hour class. ⚠️ `undefined` here writes SQL **NULL**, which is exactly what a row
   * migrated in from before migration 0005 carries: "the split is not known" (§4.6). A fixture
   * that wants "no 1-hour writes" must say `cacheWrite1h: 0`.
   */
  readonly cacheWrite1h?: number | null;
  readonly cacheRead?: number;
  readonly synthetic?: boolean;
  readonly projectId?: number;
}

/**
 * Creates the minimum `projects` / `sessions` / `file_manifest` rows that `events`' foreign keys
 * require (§3.2–§3.5). `PRAGMA foreign_keys = ON` is applied on every connection (§3.1.7), so
 * these are not optional scaffolding — an event with a dangling `session_id` cannot be inserted.
 */
export function seedSkeleton(db: SqliteDatabase, projectIds: readonly number[] = [1]): void {
  const run = db.transaction((): void => {
    db.prepare(
      `INSERT INTO file_manifest (id, rel_path, kind, size_bytes, mtime_ms, byte_offset,
         lines_parsed, bad_lines, first_seen_at, last_seen_at)
       VALUES (1, 'projects/p/s.jsonl', 'transcript', 10, ?, 0, 0, 0, ?, ?)`,
    ).run(T0, T0, T0);
    for (const projectId of projectIds) {
      db.prepare(
        `INSERT INTO projects (id, encoded_name, display_name, color_index, first_ts, last_ts)
         VALUES (?, ?, ?, 0, ?, ?)`,
      ).run(projectId, `-p${String(projectId)}`, `p${String(projectId)}`, T0, T0);
      db.prepare(
        `INSERT INTO sessions (id, project_id, transcript_file_id, first_ts, last_ts, is_partial)
         VALUES (?, ?, 1, ?, ?, 0)`,
      ).run(`s${String(projectId)}`, projectId, T0, T0);
    }
  });
  run();
}

/** Inserts §3.5 `events` rows. `model` is stored VERBATIM (ADR-025) — never normalized. */
export function insertEvents(db: SqliteDatabase, events: readonly EventSpec[]): void {
  const statement = db.prepare(
    `INSERT INTO events (event_key, session_id, project_id, source_file_id, line_no, ts, type,
       role, origin, is_sidechain, model, is_synthetic, is_api_error,
       tok_input, tok_output, tok_cache_write, tok_cache_write_1h, tok_cache_read)
     VALUES (?, ?, ?, 1, ?, ?, 'assistant', 'assistant', 'main', 0, ?, ?, 0, ?, ?, ?, ?, ?)`,
  );
  const run = db.transaction((): void => {
    events.forEach((event, index) => {
      const projectId = event.projectId ?? 1;
      statement.run(
        event.eventKey,
        `s${String(projectId)}`,
        projectId,
        index + 1,
        event.ts,
        event.model,
        event.synthetic === true ? 1 : 0,
        event.input ?? 0,
        event.output ?? 0,
        event.cacheWrite ?? 0,
        event.cacheWrite1h ?? null,
        event.cacheRead ?? 0,
      );
    });
  });
  run();
}

/** Every `price_rows` row, ordered, as plain objects — for the byte-identical comparisons. */
export function dumpPriceRows(db: SqliteDatabase): unknown[] {
  return db.prepare(`SELECT * FROM price_rows ORDER BY id`).all();
}

/** A §4.7 document literal, so a test can state exactly what it feeds the validator. */
export function priceDocument(
  models: {
    model: string;
    rates: {
      input: number;
      output: number;
      cache_write: number;
      cache_write_1h: number;
      cache_read: number;
    };
    effectiveFrom?: string;
  }[],
): unknown {
  return {
    schema: 'claude-lens/price-table@1',
    generatedAt: '2026-07-22T00:00:00.000Z',
    models,
  };
}

/**
 * All **five** classes at one flat rate, for fixtures where only one class is under test.
 *
 * ⚠️ A fixture built from this proves nothing about the 5-minute/1-hour distinction — every rate
 * is the same number, so swapping the two classes cannot change any total. `test/main/pricing/
 * a05-cache-write-1h-costing.test.ts` is the fixture that discriminates, and it prices the two
 * classes DIFFERENTLY on purpose.
 */
export function flatRates(usdPerMillion: number): {
  input: number;
  output: number;
  cache_write: number;
  cache_write_1h: number;
  cache_read: number;
} {
  return {
    input: usdPerMillion,
    output: usdPerMillion,
    cache_write: usdPerMillion,
    cache_write_1h: usdPerMillion,
    cache_read: usdPerMillion,
  };
}
