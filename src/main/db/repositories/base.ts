// The repository seam. STACK ADR-008, DESIGN §3.1.9.
//
// "Every read goes through a repository interface in `src/main/db/repositories/`. No view,
// component, hook or store touches SQL." That boundary is enforced mechanically by ESLint
// (SQL text may exist only under `src/main/db/**`; the renderer may not import
// `src/main/**`), so this file is not the enforcement — it is the ergonomics that make the
// enforced version pleasant enough that nobody wants to route around it.
//
// What lives here:
//   · the persistence classification (ADR-026/033) as a value, not a comment
//   · `assertSafeAggregate` — INV-11's DB-layer error minting over the ONE shared predicate
//     `isSafeAggregate` in `src/shared/money.ts` (A-10)
//   · `Repository`, a statement-caching base with typed row access
//
// What deliberately does NOT live here: the analytics queries. §5.9's M-01…M-20 are E4's,
// and each arrives as its own repository with its own golden fixture (§12.2). This file is
// the seam they plug into, nothing more.

import { isSafeAggregate } from '../../../shared/money';
import { DbError } from '../errors';
import type { SqlParam, SqliteDatabase, SqliteRunResult, SqliteStatement } from '../sqlite';

// ---------------------------------------------------------------------------------------
// Persistence classes — DESIGN §2.2, ADR-026 as amended by ADR-033.
// ---------------------------------------------------------------------------------------

/**
 * ⚠️ This is a value, not documentation. `purge.ts` refuses to delete from any table that is
 * not `DERIVED` here, which is what makes ADR-026's rule mechanical: "making the class a
 * column rather than a convention means the mistake is impossible to make accidentally,
 * visible in review when made deliberately, and mechanically checkable by a gate."
 *
 *   DERIVED  — rebuildable from the Claude data directory. May be purged and rebuilt.
 *   USER     — hand-entered or historical, no other source. Never purged (INV-12).
 *
 * RETAINED is not a table class: it is a ROW class, carried by TWO independent markers on
 * `file_manifest` and `sessions` — `archive_id IS NOT NULL` (the file was MOVED out by ACT-07,
 * ADR-033) and `retained_orphan = 1` (the file DISAPPEARED and its history is kept, ADR-041).
 * Both are roads into the same class: structurally derived, but no longer derivable, because a
 * rescan of `<claudeDir>` will never reproduce a moved-away or deleted file. A DERIVED table can
 * hold RETAINED rows, which is exactly why the purge predicate is a column test and not a table
 * list, and why it now tests BOTH markers (§3.18).
 */
export type PersistenceClass = 'DERIVED' | 'USER';

export const PERSISTENCE_CLASS_BY_TABLE = {
  // DERIVED — §2.2 row 1
  file_manifest: 'DERIVED',
  projects: 'DERIVED',
  sessions: 'DERIVED',
  events: 'DERIVED',
  tool_calls: 'DERIVED',
  subagent_runs: 'DERIVED',
  file_touches: 'DERIVED',
  prompts: 'DERIVED',
  harness_nodes: 'DERIVED',
  harness_edges: 'DERIVED',
  // ADR-039 — one parsed fact per subagent run (its agent type), replaced whole on every scan
  // alongside the two tables above. DERIVED: it is re-readable from the `agent-*.meta.json`
  // sidecars in the Claude data directory and holds nothing the user typed.
  harness_run_agents: 'DERIVED',
  bloat_flags: 'DERIVED',
  stats_cache_days: 'DERIVED',
  meta: 'DERIVED', // §3.17: anything a rebuild can recompute belongs here
  // USER — §2.2 row 3. Never purged, never dropped, carried across every migration.
  price_rows: 'USER',
  // A-05, migration 0005 — the pre-image of `price_rows` as it stood before the `token_class`
  // CHECK was widened. ADR-026 says `price_rows` is never dropped and is carried across every
  // migration, and SQLite cannot ALTER a CHECK, so 0005 renames the original aside and copies
  // every row into the new definition. The original SURVIVES, untouched, as the only in-database
  // pre-image of a USER table this project has ever rewritten (§9.4). Nothing reads it; it is
  // USER class so that no purge and no rebuild can ever remove it.
  price_rows_pre_0005: 'USER',
  // ADR-040, migration 0007 — the user's own statement that two `projects/<encoded-path>`
  // folders are one project. ⚠️ USER class for the same reason `price_rows` is: it is
  // hand-entered and has NO OTHER SOURCE. A rescan of `<claudeDir>` can never reproduce it,
  // because the fact it records is not on disk — it is in the user's head. A purge that took it
  // would silently un-merge every group and move every project-shaped number, with no error.
  // ⚠️ Membership keys on `encoded_name`, never `projects.id` (§3.19); that is what makes these
  // rows survive the purge-and-rebuild that renumbers every project.
  project_groups: 'USER',
  project_group_members: 'USER',
  settings: 'USER', // §3.13, and why `electron-store` is not used (ADR-030)
  audit_log: 'USER',
  archives: 'USER',
} as const satisfies Record<string, PersistenceClass>;

export type TableName = keyof typeof PERSISTENCE_CLASS_BY_TABLE;

/** The rows of `file_manifest` and `sessions` that a purge must never touch (ADR-033). */
export const RETAINED_MARKER_COLUMN = 'archive_id';

/**
 * ⚠️ ADR-041 — the SECOND RETAINED marker, present on the same two tables as `archive_id`. A row
 * with `retained_orphan = 1` came from a file that VANISHED from `<claudeDir>` (not moved), so it
 * has no `archives` row and nothing to undo, yet it is exactly as un-derivable as an archived row
 * and must survive every purge (§3.18) the same way.
 */
export const RETAINED_ORPHAN_MARKER_COLUMN = 'retained_orphan';

/** Tables carrying the RETAINED marker columns (both `archive_id` and `retained_orphan`). */
export const RETAINED_MARKER_TABLES: readonly TableName[] = ['file_manifest', 'sessions'];

// ---------------------------------------------------------------------------------------
// INV-11 — the bound on every numeric aggregate that crosses IPC.
// ---------------------------------------------------------------------------------------

/**
 * INV-11: "Every numeric aggregate crossing IPC is `<= Number.MAX_SAFE_INTEGER`; the
 * repository asserts this and returns `E_INTERNAL` rather than a silently-rounded number."
 *
 * ⚠️ This is the whole project's rule in one function. `tok_*` sums and picoUSD totals are
 * 64-bit in SQLite (§3.5, §3.11) but `number` on the wire, and a value above 2^53−1 does not
 * fail — it ROUNDS. A plausible, wrong total with nothing crashing is the worst possible
 * outcome (CLAUDE.md §1), so the bound is asserted rather than trusted.
 *
 * ⚠️ A-10: the *arithmetic* of INV-11 is defined exactly once, in `isSafeAggregate`
 * (`src/shared/money.ts`) — including the `bigint` case, which `safeIntegers` can produce.
 * This function is only the DB layer's error minting: the same predicate, raised as
 * `DbError('E_INTERNAL')` so `withResult()` reports it under §4.1 rule 1. Do not re-derive
 * the bound here; fix it in the shared predicate and both layers move together.
 */
export function assertSafeAggregate(value: number | bigint, label: string): number {
  if (!isSafeAggregate(value)) {
    throw new DbError('E_INTERNAL', safeAggregateMessage(value, label), { retryable: false });
  }
  return Number(value);
}

/**
 * ⚠️ The message names **which** half of `isSafeAggregate` refused the value.
 *
 * `isSafeAggregate` is `Number.isSafeInteger` for a `number`, and that predicate rejects two
 * genuinely different things: a magnitude past `2^53−1`, and a value that is not whole. Reporting
 * both as "too large to report exactly" is itself a small silently-wrong number — on 2026-07-22
 * a fractional `activeSeconds` of `12180.862` was reported as "too large", and the diagnosis that
 * followed began by looking for an eleven-order-of-magnitude overflow that did not exist. The
 * refusal was right; only its reason was wrong. INV-11's own wording is preserved verbatim for
 * the magnitude case, which is the case INV-11 is about.
 */
function safeAggregateMessage(value: number | bigint, label: string): string {
  if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
    return (
      `The computed total for "${label}" came out as ${String(value)}, which is not a whole ` +
      'number. Every aggregate this application reports is an exact integer count in its ' +
      'storage unit, so a fractional value means the arithmetic behind it is wrong; it was not ' +
      'reported at all rather than rounded into looking right (INV-11).'
    );
  }
  return (
    `The computed total for "${label}" is too large to report exactly, so it was not ` +
    'reported at all. A rounded number here would be wrong without looking wrong (INV-11).'
  );
}

/** `SUM()` over no rows is `NULL` in SQLite. Zero rows means zero — never a substituted value. */
export function sumToSafeNumber(value: number | bigint | null, label: string): number {
  if (value === null) return 0;
  return assertSafeAggregate(value, label);
}

/**
 * A 64-bit SQL sum carried out of SQLite **without narrowing it** — §3.11, ADR-023.
 *
 * ⚠️ **AMENDED 2026-07-22.** This exists because `sumToSafeNumber` was applied to the picoUSD
 * money sums, which is the one place it must never be applied. §3.11 states the rule and the
 * reason: "SQL sums in picoUSD (64-bit) … the repository then converts to nanoUSD … **before**
 * the value crosses IPC, because picoUSD totals can approach `Number.MAX_SAFE_INTEGER`
 * (9.007e15) on a dataset only a few times larger". `9.007e15` picoUSD is **$9,007** of lifetime
 * spend — so asserting INV-11 on the picoUSD value turned every user past that into a hard
 * `E_INTERNAL` on the Overview tiles, at the one boundary the design says not to assert at.
 *
 * The unit that must be safe is **nanoUSD**, three orders further out. So the picoUSD sum stays a
 * `bigint` from SQLite to `picoToNanoUsd`, and INV-11 is asserted on the result.
 *
 * A `number` here means the statement was NOT read in `safeIntegers` mode and the driver has
 * already rounded, so it is checked rather than trusted: a `number` that is not a safe integer
 * is a value that was corrupted one frame below, and reporting it would be exactly the silently
 * wrong number CLAUDE.md §1 forbids.
 *
 * ⚠️ Token-count sums are NOT this. §3.5 gives them their headroom argument and they stay
 * `number` via `sumToSafeNumber`; this is only for the money path, where the unit is 1e12 per
 * dollar.
 */
export function sumToBigInt(value: number | bigint | null, label: string): bigint {
  if (value === null) return 0n;
  if (typeof value === 'bigint') return value;
  return BigInt(assertSafeAggregate(value, label));
}

// ---------------------------------------------------------------------------------------
// The repository base.
// ---------------------------------------------------------------------------------------

/**
 * A repository owns one connection and caches its prepared statements.
 *
 * Statement caching is not premature optimisation: P-08 gives every repository method
 * backing a view a 200 ms p95 budget, and that budget is the numeric DuckDB trigger
 * (ADR-005). Re-preparing SQL per call would spend part of the budget measuring the wrong
 * thing.
 *
 * Subclasses hold their SQL as module-level string constants and expose typed methods. They
 * never return a raw row shape to a caller outside `src/main/db/**`.
 */
export abstract class Repository {
  protected readonly db: SqliteDatabase;
  readonly #statements = new Map<string, SqliteStatement<unknown>>();

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /** Prepares once per SQL string, per repository instance. */
  protected statement<Row>(sql: string): SqliteStatement<Row> {
    const cached = this.#statements.get(sql);
    if (cached !== undefined) return cached as SqliteStatement<Row>;
    const prepared = this.db.prepare<Row>(sql);
    this.#statements.set(sql, prepared);
    return prepared;
  }

  /**
   * The same statement, in `safeIntegers` mode: every 64-bit INTEGER column arrives as a
   * `bigint` rather than a pre-rounded `number` (§3.11, ADR-023).
   *
   * ⚠️ Use this for the **money** sums and nothing else. A picoUSD total must not touch a JS
   * `number` before `picoToNanoUsd` (see `sumToBigInt`); token counts have their own headroom
   * argument in §3.5 and stay `number`.
   *
   * Cached separately from the plain statement — the same SQL in the two modes returns two
   * different row shapes, so one cache entry could not serve both.
   */
  protected exactStatement<Row>(sql: string): SqliteStatement<Row> {
    const key = `safeIntegers:${sql}`;
    const cached = this.#statements.get(key);
    if (cached !== undefined) return cached as SqliteStatement<Row>;
    const prepared = this.db.prepare<Row>(sql).safeIntegers(true);
    this.#statements.set(key, prepared);
    return prepared;
  }

  /** `all()` in `safeIntegers` mode. */
  protected allExact<Row>(sql: string, ...params: SqlParam[]): Row[] {
    return this.exactStatement<Row>(sql).all(...params);
  }

  /** `one()` in `safeIntegers` mode. Never a substituted default (CLAUDE.md §1). */
  protected oneExact<Row>(sql: string, ...params: SqlParam[]): Row | undefined {
    return this.exactStatement<Row>(sql).get(...params);
  }

  /** Every row the statement produces, typed. */
  protected all<Row>(sql: string, ...params: SqlParam[]): Row[] {
    return this.statement<Row>(sql).all(...params);
  }

  /** The first row, or `undefined`. Never a substituted default (CLAUDE.md §1). */
  protected one<Row>(sql: string, ...params: SqlParam[]): Row | undefined {
    return this.statement<Row>(sql).get(...params);
  }

  /** A non-SELECT statement. Returns the driver's `{ changes, lastInsertRowid }`. */
  protected run(sql: string, ...params: SqlParam[]): SqliteRunResult {
    return this.statement<never>(sql).run(...params);
  }

  /** Runs `body` inside a transaction; rolls back on throw. */
  protected transaction<Result>(body: () => Result): Result {
    return this.db.transaction(body)();
  }
}
