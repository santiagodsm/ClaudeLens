// The dual-ABI loader and the one place a SQLite connection is opened.
// STACK ADR-005 (SQLite via better-sqlite3, main process and parse worker only) and
// STACK ADR-006 (two installs, one selected at load). DESIGN §3.1.7 (connection pragmas).

import { createRequire } from 'node:module';
import type { DatabaseConstructor, SqliteDatabase, SqliteOpenOptions } from './sqlite';

/**
 * ⚠️ STACK ADR-006 — the single decision that determines whether `npm run check` can be green.
 *
 * `better-sqlite3` is a NAN/V8 addon, not N-API, so one compiled `.node` cannot serve two
 * runtimes. The app runs under Electron (ABI 146); Vitest runs under Node (ABI 137). The
 * package is therefore installed twice under two names — `better-sqlite3` built for Node and
 * `better-sqlite3-electron` (`npm:better-sqlite3@12.11.1`) rebuilt for Electron by the
 * `postinstall` hook — and this seam picks the right one. Two install paths means two
 * `build/Release/better_sqlite3.node` files that never contend.
 *
 * Do not "simplify" this to a single import. The naive setup rebuilds in place and every
 * SQLite test then fails with NODE_MODULE_VERSION mismatch — a failure an agent will
 * correctly read as environmental, and then incorrectly read the same way about the next
 * real one. E0 verified both binaries load; this is the seam that keeps them apart.
 */
export const NODE_ABI_MODULE_ID = 'better-sqlite3';
export const ELECTRON_ABI_MODULE_ID = 'better-sqlite3-electron';

/** `require` is renamed deliberately: the driver name must stay a runtime value, not an import. */
const requireNative = createRequire(import.meta.url);

/** Which install this process must load. `process.versions.electron` is the whole test. */
export function nativeModuleId(): string {
  return process.versions.electron ? ELECTRON_ABI_MODULE_ID : NODE_ABI_MODULE_ID;
}

/** Resolves the ABI-correct `better-sqlite3` constructor. */
export function loadDatabaseConstructor(): DatabaseConstructor {
  const loaded: unknown = requireNative(nativeModuleId());
  return loaded as DatabaseConstructor;
}

/**
 * DESIGN §3.1.7 — the connection pragmas, applied on EVERY connection.
 *
 * Every one of these is per-connection state in SQLite except `journal_mode`, which is
 * persistent — it is re-stated here anyway so that a connection is correct on its own terms
 * and a test that opens a fresh file gets WAL without depending on who opened it first.
 *
 *   foreign_keys = ON     — OFF by default in SQLite. The whole ON DELETE CASCADE story of
 *                           §3.1.5 is inert without it, and a purge would silently orphan.
 *   journal_mode = WAL    — STACK ADR-005. Readers do not block the sync writer.
 *   synchronous = NORMAL  — the WAL-appropriate durability point.
 *   busy_timeout = 5000   — the main process, the parse worker and the watcher all hold
 *                           connections; SQLITE_BUSY must be waited out, not surfaced.
 */
export const CONNECTION_PRAGMAS: readonly string[] = [
  'foreign_keys = ON',
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'busy_timeout = 5000',
];

/** Opens a connection and applies the §3.1.7 pragmas. The only way to get a `SqliteDatabase`. */
export function openDatabase(path: string, options?: SqliteOpenOptions): SqliteDatabase {
  const Database = loadDatabaseConstructor();
  const db = new Database(path, options);
  for (const pragma of CONNECTION_PRAGMAS) {
    db.pragma(pragma);
  }
  return db;
}
