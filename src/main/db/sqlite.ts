// The typed surface of `better-sqlite3` that this application actually uses.
//
// `better-sqlite3@12.11.1` ships no type declarations and `@types/better-sqlite3` is not a
// dependency of this project (CLAUDE.md §7: no new dependency without an ADR). Declaring the
// narrow surface here is not a workaround — it is the seam doing its job. Two things follow
// from it that a `@types` package would not give us:
//
//   1. The dual-ABI loader (STACK ADR-006) resolves ONE of two module names at runtime and
//      both must satisfy the same contract. That contract is this file.
//   2. Nothing outside `src/main/db/**` can reach a driver type, so widening the surface is
//      a visible edit here rather than an invisible one at a call site (STACK ADR-008).
//
// Only what is used is declared. Adding a method here is the correct way to start using one.

/** A value SQLite can bind or return. `Uint8Array` covers BLOB; `bigint` covers `safeIntegers`. */
export type SqlValue = number | bigint | string | Uint8Array | null;

/** One bound parameter: positional, or a named-parameter object. */
export type SqlParam = SqlValue | Record<string, SqlValue | undefined>;

/** The result of a non-SELECT statement. */
export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/** A prepared statement, parameterised by the row shape its caller expects back. */
export interface SqliteStatement<Row = unknown> {
  run(...params: SqlParam[]): SqliteRunResult;
  get(...params: SqlParam[]): Row | undefined;
  all(...params: SqlParam[]): Row[];
  /** Streams rows without materialising them — used by the §5.9 aggregate paths. */
  iterate(...params: SqlParam[]): IterableIterator<Row>;
  /** Return the first column of each row rather than an object. */
  pluck(toggle?: boolean): SqliteStatement<Row>;
  /**
   * Return every 64-bit INTEGER column as a `bigint` instead of a `number`.
   *
   * ⚠️ §3.11 / ADR-023 — this is what lets a picoUSD sum leave SQLite **unnarrowed**. SQLite
   * sums money in 64-bit integers, and a picoUSD total passes `Number.MAX_SAFE_INTEGER`
   * (9.007e15 pico = $9,007 of lifetime spend) long before it passes `2^63`. Without this the
   * driver hands back a `number` that has already been rounded, and the only honest thing left
   * to do is refuse to report it (INV-11). With it, the value reaches `picoToNanoUsd` intact and
   * the bound is asserted where §3.11 says it should be — on the **nanoUSD** result.
   *
   * Returns the same statement, so it composes: `db.prepare(sql).safeIntegers(true)`.
   */
  safeIntegers(toggle?: boolean): SqliteStatement<Row>;
}

/**
 * `better-sqlite3`'s transaction wrapper. The returned function runs `fn` inside a
 * transaction and rolls back on throw — which is what makes "a failed migration leaves the
 * database untouched" (§9.6) a property of the driver rather than of our error handling.
 */
export interface SqliteTransaction<Args extends unknown[], Result> {
  (...args: Args): Result;
  deferred(...args: Args): Result;
  immediate(...args: Args): Result;
  exclusive(...args: Args): Result;
}

export interface SqliteDatabase {
  /** The path this connection was opened at. `':memory:'` for an in-memory database. */
  readonly name: string;
  readonly open: boolean;
  readonly inTransaction: boolean;
  prepare<Row = unknown>(sql: string): SqliteStatement<Row>;
  exec(sql: string): SqliteDatabase;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
  ): SqliteTransaction<Args, Result>;
  close(): SqliteDatabase;
}

export interface SqliteOpenOptions {
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
  readonly timeout?: number;
  /**
   * STACK ADR-006's documented escape hatch: an explicit path to the compiled `.node` file,
   * for the case where a bundler relocates it away from the package's `build/Release`.
   */
  readonly nativeBinding?: string;
}

/** The constructor exported by whichever of the two ABI-specific installs was loaded. */
export type DatabaseConstructor = new (path: string, options?: SqliteOpenOptions) => SqliteDatabase;
