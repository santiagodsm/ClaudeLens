// A whole sync stack over one sandbox directory and one real SQLite file.
//
// STACK ADR-013 mechanism 2: "One SQLite file per test … `:memory:` is permitted **only** for
// pure SQL-shape unit tests; anything exercising the file manifest, byte offsets, WAL,
// migrations or the incremental fast-path must use a real file, because those are precisely
// the behaviours an in-memory DB does not have." Everything E3 does is on that list.
//
// This file is not a test (the `main` project collects only `*.{test,spec}.ts`).

import { utimes } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import type { SyncState } from '../../src/shared/ipc-contract';
import { openDatabase } from '../../src/main/db/driver';
import { migrate } from '../../src/main/db/migrate';
import { IngestRepository } from '../../src/main/db/repositories/ingest-repo';
import { ManifestRepository } from '../../src/main/db/repositories/manifest-repo';
import type { SqliteDatabase } from '../../src/main/db/sqlite';
import { SyncCycle } from '../../src/main/sync/cycle';
import { createSyncWork } from '../../src/main/sync/engine';

/** A fixed instant. Nothing in these tests depends on a clock (CLAUDE.md §1). */
export const FIXED_NOW = 1_720_000_000_000;

/** The tables E3 writes, in FK-safe dump order. `meta` is E6's bookkeeping, not E3's. */
export const INGESTED_TABLES = [
  'file_manifest',
  'projects',
  'sessions',
  'events',
  'tool_calls',
  'subagent_runs',
  'file_touches',
  'prompts',
  'stats_cache_days',
] as const;

export type IngestedTable = (typeof INGESTED_TABLES)[number];

/** Absolute path of a committed fixture tree. Fixtures are READ-ONLY inputs (ADR-013). */
export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

export interface SyncHarness {
  readonly db: SqliteDatabase;
  readonly cycle: SyncCycle;
  /** Every `evt:sync` payload emitted, in order (§4.9). */
  readonly emitted: SyncState[];
  /** Runs one full cycle and waits for it, including any coalesced follow-up. */
  runSync(kind?: 'incremental' | 'full'): Promise<void>;
}

export interface HarnessOptions {
  readonly claudeDir: string;
  readonly dbPath: string;
  readonly now?: () => number;
  /**
   * ADR-041 / §3.13 `retainOrphanedHistory`. Defaults to TRUE — the app's default: a transcript
   * that vanishes keeps its parsed history. Pass `false` to exercise the pure-mirror path where a
   * `MISSING` transcript is deleted and cascaded (§5.3).
   */
  readonly retainOrphanedHistory?: boolean;
}

/** Opens a migrated database and wires SM-2 over `claudeDir`. Closed after the test. */
export function createSyncHarness(options: HarnessOptions): SyncHarness {
  const db = openDatabase(options.dbPath);
  migrate(db);
  const emitted: SyncState[] = [];
  const work = createSyncWork({
    claudeDir: options.claudeDir,
    manifest: new ManifestRepository(db),
    ingest: new IngestRepository(db),
    now: options.now ?? ((): number => FIXED_NOW),
    // ADR-041 — default TRUE (keep history), exactly like production's setting default.
    retainOrphanedHistory: () => options.retainOrphanedHistory ?? true,
  });
  const cycle = new SyncCycle({
    work,
    now: options.now ?? ((): number => FIXED_NOW),
    emit: (state) => emitted.push(state),
    // 0 ms so unit tests observe every progress frame; P-22's 250 ms default is asserted
    // separately in `cycle.test.ts`.
    progressIntervalMs: 0,
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  return {
    db,
    cycle,
    emitted,
    async runSync(kind: 'incremental' | 'full' = 'incremental'): Promise<void> {
      cycle.start(kind);
      await cycle.settled();
    },
  };
}

/** Every row of one table, ordered deterministically so two databases can be compared. */
export function dumpTable(db: SqliteDatabase, table: IngestedTable): unknown[] {
  // `table` comes from the constant above, never from input.
  const orderBy =
    table === 'sessions'
      ? 'id'
      : table === 'stats_cache_days'
        ? 'day'
        : table === 'file_manifest'
          ? 'rel_path'
          : table === 'events'
            ? 'event_key'
            : table === 'projects'
              ? 'encoded_name'
              : table === 'prompts'
                ? 'source_file_id, line_no'
                : table === 'tool_calls'
                  ? 'event_id, ordinal'
                  : table === 'file_touches'
                    ? 'tool_call_id'
                    : 'transcript_file_id';
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
}

/** Every ingested table, table-by-table. The unit of INV-04's comparison. */
export function dumpAll(db: SqliteDatabase): Record<IngestedTable, unknown[]> {
  const dump = {} as Record<IngestedTable, unknown[]>;
  for (const table of INGESTED_TABLES) dump[table] = dumpTable(db, table);
  return dump;
}

/**
 * Every ingested table with its **surrogate keys replaced by natural keys**.
 *
 * ⚠️ This is what INV-04's "over every table" has to mean. `id INTEGER PRIMARY KEY` is a
 * rowid alias assigned by insertion order, and a cold parse inserts a file's rows in a
 * different order than an append does — identity is `event_key` (ADR-019), `rel_path`
 * (§3.2), `encoded_name` (§3.3) and `(event_id, ordinal)` (§3.6), not the rowid. Comparing
 * rowids would fail on a difference that carries no information; dropping the columns
 * without substituting the natural key would stop comparing the foreign keys at all, which
 * is where a real append bug would hide.
 */
export function dumpNormalized(db: SqliteDatabase): Record<IngestedTable, unknown[]> {
  const query = (sql: string): unknown[] => db.prepare(sql).all();
  return {
    file_manifest: query(
      `SELECT rel_path, kind, size_bytes, mtime_ms, byte_offset, lines_parsed, bad_lines,
              content_hash, first_seen_at, last_seen_at, parsed_at, archive_id, archive_rel_path
         FROM file_manifest ORDER BY rel_path`,
    ),
    projects: query(
      `SELECT encoded_name, display_name, color_index, first_ts, last_ts
         FROM projects ORDER BY encoded_name`,
    ),
    sessions: query(
      `SELECT s.id, p.encoded_name AS project, fm.rel_path AS transcript, s.first_ts, s.last_ts,
              s.span_seconds, s.git_branch, s.cli_version, s.is_partial, s.archive_id
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         LEFT JOIN file_manifest fm ON fm.id = s.transcript_file_id
        ORDER BY s.id`,
    ),
    events: query(
      `SELECT e.event_key, e.session_id, p.encoded_name AS project, fm.rel_path AS source,
              e.line_no, e.ts, e.type, e.role, e.origin, sfm.rel_path AS subagent_run_file,
              e.uuid, e.parent_uuid, e.is_sidechain, e.model, e.is_synthetic, e.is_api_error,
              e.tok_input, e.tok_output, e.tok_cache_write, e.tok_cache_read,
              e.git_branch, e.cli_version, e.cwd
         FROM events e
         JOIN projects p ON p.id = e.project_id
         JOIN file_manifest fm ON fm.id = e.source_file_id
         LEFT JOIN subagent_runs sr ON sr.id = e.subagent_run_id
         LEFT JOIN file_manifest sfm ON sfm.id = sr.transcript_file_id
        ORDER BY e.event_key`,
    ),
    tool_calls: query(
      // `description` (§3.6 as amended by A-09) is listed here so it falls inside INV-04's
      // append≡cold comparison rather than outside it.
      `SELECT e.event_key, tc.session_id, p.encoded_name AS project, tc.origin, tc.ts, tc.ordinal,
              tc.tool_name, tc.tool_use_id, tc.skill_name, tc.subagent_type, tc.description,
              tc.target_path, tc.is_write_class
         FROM tool_calls tc
         JOIN events e ON e.id = tc.event_id
         JOIN projects p ON p.id = tc.project_id
        ORDER BY e.event_key, tc.ordinal`,
    ),
    subagent_runs: query(
      // ⚠️ `meta_agent_type` / `meta_tool_use_id` / `meta_description` (§3.7 as amended
      // 2026-07-22, migration 0008) are listed here so the run's own `agent-*.meta.json`
      // sidecar falls INSIDE INV-04's append≡cold comparison rather than outside it. The
      // sidecar is read at FINALIZING, so an implementation that recorded it while parsing
      // one file would show up here as a difference.
      `SELECT sr.session_id, p.encoded_name AS project, fm.rel_path AS transcript,
              se.event_key AS spawn_event, ste.event_key AS spawn_tool_event,
              stc.ordinal AS spawn_tool_ordinal, sr.subagent_type, sr.description,
              sr.meta_agent_type, sr.meta_tool_use_id, sr.meta_description,
              sr.first_ts, sr.last_ts
         FROM subagent_runs sr
         JOIN projects p ON p.id = sr.project_id
         JOIN file_manifest fm ON fm.id = sr.transcript_file_id
         LEFT JOIN events se ON se.id = sr.spawn_event_id
         LEFT JOIN tool_calls stc ON stc.id = sr.spawn_tool_call_id
         LEFT JOIN events ste ON ste.id = stc.event_id
        ORDER BY fm.rel_path`,
    ),
    file_touches: query(
      `SELECT e.event_key, tc.ordinal, ft.session_id, p.encoded_name AS project, ft.ts, ft.path,
              ft.basename, ft.extension, ft.language, ft.tool_name
         FROM file_touches ft
         JOIN tool_calls tc ON tc.id = ft.tool_call_id
         JOIN events e ON e.id = tc.event_id
         JOIN projects p ON p.id = ft.project_id
        ORDER BY e.event_key, tc.ordinal`,
    ),
    prompts: query(
      `SELECT fm.rel_path AS source, pr.line_no, pr.ts, p.encoded_name AS project, pr.raw_project,
              pr.session_id, pr.display_preview, pr.display_chars
         FROM prompts pr
         JOIN file_manifest fm ON fm.id = pr.source_file_id
         LEFT JOIN projects p ON p.id = pr.project_id
        ORDER BY fm.rel_path, pr.line_no`,
    ),
    stats_cache_days: query(
      `SELECT sc.day, sc.raw_json, fm.rel_path AS source
         FROM stats_cache_days sc
         JOIN file_manifest fm ON fm.id = sc.source_file_id
        ORDER BY sc.day`,
    ),
  };
}

/** One aggregate per table, so a comparison failure names the table that differs. */
export function countsByTable(db: SqliteDatabase): Record<IngestedTable, number> {
  const counts = {} as Record<IngestedTable, number>;
  for (const table of INGESTED_TABLES) {
    counts[table] = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
  }
  return counts;
}

/**
 * Pins a file's mtime.
 *
 * §5.3 classifies on `(size_bytes, mtime_ms)`, and a real clock would make the manifest rows
 * of two otherwise identical runs differ by whatever the wall time was. Pinning it is what
 * lets INV-04's comparison be byte-for-byte across EVERY column rather than a subset.
 */
export async function pinMtime(absolutePath: string, epochMs: number): Promise<void> {
  const seconds = epochMs / 1000;
  await utimes(absolutePath, seconds, seconds);
}
