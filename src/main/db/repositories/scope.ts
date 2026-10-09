// The pieces every §4.5 analytics query shares: the `GlobalFilter` clause, the local-time
// calendar expressions of ADR-021, and the opaque paging cursors of §4.2.
//
// ⚠️ Stated once, on purpose. A filter clause hand-copied into twenty query files is twenty
// chances for one of them to write `e.ts <= ?` where §4.2 says the window is half-open
// `[from, to)` — and a scoped total that quietly includes one extra day is exactly the
// silently-wrong number this project exists to prevent (CLAUDE.md §1).
//
// ⚠️ ADR-021: **no local time is ever stored.** Every calendar grouping is computed here, at
// query time, from the UTC epoch-ms column via `datetime(ts/1000,'unixepoch','localtime')`.
// The fixtures pin `TZ` explicitly, which ADR-021 requires for reproducibility.

import { DbError } from '../errors';
import { MAX_BILLING_CYCLE_DAY, MIN_BILLING_CYCLE_DAY } from '../../../shared/billing-cycle';
import type { SqlParam } from '../sqlite';
import type { GlobalFilter, Page, Paged } from '../../../shared/ipc-contract';

/**
 * The request every filtered analytics query takes.
 *
 * `idleGapMinutes` travels with the filter rather than being read from `settings` inside the
 * repository, for two reasons: ADR-022 makes active time a pure function of `(events, threshold)`
 * evaluated per request, and INV-05 — "changing `idleGapMinutes` changes **only** active-time
 * results" — is only directly testable if the threshold is an argument the test can vary.
 */
export interface QueryContext {
  readonly filter: GlobalFilter;
  /** §3.13 — 5…60, step 5, default 15. Active time ONLY (INV-05). */
  readonly idleGapMinutes: number;
}

/** ADR-022 / M-07 — the cap, in the storage unit. */
export function idleGapMs(context: QueryContext): number {
  return context.idleGapMinutes * 60_000;
}

/** A composable SQL fragment with its bind parameters, in order. */
export interface ScopeSql {
  /** Zero or more ` AND …` clauses, ready to append to a `WHERE` that already has a term. */
  readonly sql: string;
  readonly params: SqlParam[];
}

/**
 * §4.2 `GlobalFilter` as SQL, over any table exposing `project_id` and a timestamp column.
 *
 * ⚠️ Three things are deliberate:
 *   · `from` is INCLUSIVE, `to` is EXCLUSIVE — the half-open window §4.2 specifies.
 *   · `projectIds: []` selects **nothing**. It is not "all projects": silently widening an
 *     empty selection is how a scoped number becomes a global one. (Same rule, same words, as
 *     `cost.ts`'s filter — the two must not disagree.)
 *   · the placeholder list makes the SQL text length-dependent, which is fine: `Repository`
 *     caches statements keyed on the SQL string, so each arity gets its own prepared statement.
 */
export function scopeClause(filter: GlobalFilter, alias: string, tsColumn = 'ts'): ScopeSql {
  const clauses: string[] = [];
  const params: SqlParam[] = [];

  if (filter.projectIds !== null) {
    if (filter.projectIds.length === 0) {
      clauses.push('1 = 0');
    } else {
      clauses.push(`${alias}.project_id IN (${filter.projectIds.map(() => '?').join(', ')})`);
      params.push(...filter.projectIds);
    }
  }
  if (filter.from !== null) {
    clauses.push(`${alias}.${tsColumn} >= ?`);
    params.push(filter.from);
  }
  if (filter.to !== null) {
    clauses.push(`${alias}.${tsColumn} < ?`);
    params.push(filter.to);
  }

  return {
    sql: clauses.length === 0 ? '' : `\n    AND ${clauses.join('\n    AND ')}`,
    params,
  };
}

// ---------------------------------------------------------------------------------------
// ADR-021 — calendar expressions, in LOCAL time, at query time.
// ---------------------------------------------------------------------------------------

/** `YYYY-MM-DD` in the machine's local timezone — M-08's day, M-16's bucket, the calendar's cell. */
export function localDate(tsExpression: string): string {
  return `date(${tsExpression}/1000, 'unixepoch', 'localtime')`;
}

/**
 * A-19 — **the billing cycle a local day belongs to**, as `YYYY-MM`: the year-month of the day
 * shifted back by `anchorDay - 1` days. The one `?` is `anchorDay - 1`.
 *
 * ⚠️ It takes an already-LOCAL date (`localDate(...)`, or the `local_day` column a CTE computed
 * with it), not a timestamp, and that is deliberate on two counts. The zone is applied exactly
 * once, by the expression ADR-021 names, so a cycle bucket and a day bucket can never be taken in
 * different zones; and the shift is then plain calendar arithmetic on a `YYYY-MM-DD` string,
 * which SQLite does by the calendar and not by 86 400 000 ms — a cycle spanning a daylight-saving
 * change is 30 days and one hour long, and a day-count that assumed 24-hour days would move its
 * boundary by a day (§3.1.1, ADR-021, CLAUDE.md §1).
 *
 * ⚠️ **Exact for every legal anchor day, because the legal range is 1…28.** Every month has a 1st
 * through a 28th, so the shifted date never falls out of a month that exists and the boundary
 * never has to be clamped. This is the same fact `MAX_BILLING_CYCLE_DAY` is 28 for.
 *
 * ⚠️ The `CAST(? AS INTEGER)` is load-bearing for the same reason as `CAPPED_GAP_MS` in
 * `active-time.ts`: `better-sqlite3` binds every JS number as a SQLite REAL, and concatenating a
 * REAL yields the modifier `'-14.0 days'` instead of `'-14 days'`. SQLite happens to accept both,
 * but a modifier string whose meaning depends on how one driver binds a number is not something
 * a calendar boundary should rest on.
 *
 * The key it produces is the year-month of the cycle's OWN start, which is what
 * `billingCycleKey()` in `src/shared/billing-cycle.ts` computes from the window — the two sides
 * of one identity, pinned by a golden test rather than trusted.
 */
export function billingCycleKeySql(localDayExpression: string): string {
  return `strftime('%Y-%m', date(${localDayExpression}, '-' || CAST(? AS INTEGER) || ' days'))`;
}

/**
 * A-19 — **the one gate on the anchor day inside the main process**, and the one error it raises.
 *
 * ⚠️ The range is re-checked here rather than trusted from the settings layer. This is the value
 * that decides which month a dollar lands in; a `0` or a `31` arriving from a caller that skipped
 * validation would move every boundary and fail nothing (§3.13, CLAUDE.md §1 — never substitute,
 * never clamp). The bounds are the shared constants the window arithmetic uses, so the SQL side
 * and the calendar side cannot disagree about what is legal.
 *
 * ⚠️ It is separate from `billingCycleShift` so that a query path which needs the day CHECKED
 * before it needs the shift — `AnalyticsRepository.billingCycleTotals` builds its calendar before
 * it touches a repository — raises this `E_INVALID_SETTING` too. The alternative was the shape
 * this had first: the calendar throwing a bare `RangeError` from `src/shared/`, which §4.1 flattens
 * to `E_INTERNAL`, so ONE illegal day produced two different error codes depending on which line
 * happened to run first, and the carefully written code below was dead on the live path.
 */
export function assertBillingCycleDay(anchorDay: number): void {
  if (
    !Number.isInteger(anchorDay) ||
    anchorDay < MIN_BILLING_CYCLE_DAY ||
    anchorDay > MAX_BILLING_CYCLE_DAY
  ) {
    throw new DbError(
      'E_INVALID_SETTING',
      `Grouping by billing cycle needs the day of the month the bill lands, a whole number ` +
        `from ${String(MIN_BILLING_CYCLE_DAY)} to ${String(MAX_BILLING_CYCLE_DAY)}; ` +
        `received ${String(anchorDay)}.`,
      { retryable: false },
    );
  }
}

/** A-19 — the single bind parameter `billingCycleKeySql` takes: `anchorDay - 1`, once checked. */
export function billingCycleShift(anchorDay: number): number {
  assertBillingCycleDay(anchorDay);
  return anchorDay - 1;
}

/**
 * The local date of the **Monday** that starts the week containing `tsExpression`.
 *
 * §4.5's `buckets: string[]` gives no format, so a week is labelled by its first day: sortable,
 * unambiguous across a year boundary (unlike `%W`, which produces a week `00`), and the same
 * `YYYY-MM-DD` shape as the `'day'` bucket so the renderer has one parser.
 * `'-6 days'` then `'weekday 1'` lands on the Monday on or before the date, including when the
 * date is itself a Monday.
 */
export function localWeekStart(tsExpression: string): string {
  return `date(${tsExpression}/1000, 'unixepoch', 'localtime', '-6 days', 'weekday 1')`;
}

/** Local hour of day, `'00'`…`'23'` (§6.5 rhythm heatmap). */
export function localHour(tsExpression: string): string {
  return `strftime('%H', ${tsExpression}/1000, 'unixepoch', 'localtime')`;
}

/** Local weekday, `'0'` = Sunday … `'6'` = Saturday — SQLite's own `%w` numbering (§6.5). */
export function localWeekday(tsExpression: string): string {
  return `strftime('%w', ${tsExpression}/1000, 'unixepoch', 'localtime')`;
}

// ---------------------------------------------------------------------------------------
// §4.2 / §8.6 — paging.
// ---------------------------------------------------------------------------------------

/** §4.2 — `limit: 1..500`, default 100. */
export const MAX_PAGE_LIMIT = 500;
export const DEFAULT_PAGE_LIMIT = 100;

/**
 * §4.2: "`limit > 500` is rejected with `E_INVALID_SETTING`."
 *
 * P-27 caps an IPC response at 2 MB and P-28 caps the renderer at 5,000 rows; a limit the
 * renderer invented is the one path by which either could be breached, so it is checked here
 * rather than trusted.
 */
export function validateLimit(page: Page): number {
  const { limit } = page;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new DbError(
      'E_INVALID_SETTING',
      `A page limit must be a whole number between 1 and ${MAX_PAGE_LIMIT} (§4.2); ` +
        `received ${String(limit)}.`,
      { retryable: false },
    );
  }
  return limit;
}

/**
 * §4.2: "Cursors are opaque, server-built strings encoding the last row's sort key; the
 * renderer never constructs one."
 *
 * Base64 of JSON. Opaque is the contract, not the encoding — the point is that the renderer
 * treats it as a token and that a malformed one is rejected rather than silently reinterpreted
 * as "start from the beginning", which would silently repeat a page.
 */
export function encodeCursor(key: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): (string | number)[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (cause) {
    throw cursorError(cause);
  }
  if (!Array.isArray(parsed)) throw cursorError(undefined);
  for (const part of parsed) {
    if (typeof part !== 'string' && typeof part !== 'number') throw cursorError(undefined);
  }
  return parsed as (string | number)[];
}

function cursorError(cause: unknown): DbError {
  return new DbError(
    'E_INVALID_SETTING',
    'That page cursor was not one this application issued, so the page it names cannot be ' +
      'resolved. Cursors are server-built and opaque (§4.2).',
    { retryable: false, cause },
  );
}

/**
 * Cuts one page out of an already-materialised, already-ordered row set.
 *
 * ⚠️ Used only where the full set must be computed anyway — `q:workingDays`, whose complete
 * row set is the *definition* of the Overview's Active-hours figure (INV-21), and `q:fileMetrics`,
 * which groups by path. It is keyset paging, not offset paging: the cursor carries the last
 * row's sort key, so a row inserted between two requests cannot shift a page boundary and hide
 * a row. Only the page crosses IPC (P-27/P-28), never the full set.
 */
export function pageFrom<Row>(
  rows: readonly Row[],
  page: Page,
  keyOf: (row: Row) => readonly (string | number)[],
): Paged<Row> {
  const limit = validateLimit(page);
  let start = 0;
  if (page.cursor !== undefined) {
    const key = JSON.stringify(decodeCursor(page.cursor));
    const index = rows.findIndex((row) => JSON.stringify(keyOf(row)) === key);
    // A cursor whose row has since disappeared resumes at the beginning of what is left rather
    // than silently returning nothing: `-1 + 1 === 0`.
    start = index + 1;
  }
  const slice = rows.slice(start, start + limit);
  const last = slice[slice.length - 1];
  const hasMore = start + slice.length < rows.length;
  return {
    rows: slice,
    nextCursor: hasMore && last !== undefined ? encodeCursor([...keyOf(last)]) : null,
    totalKnown: rows.length,
  };
}
