// The `price_rows` query seam. DESIGN §3.11, ADR-023/024/025. Owned by E5 (Pricing).
//
// ⚠️ WHY THIS FILE IS HERE AND NOT UNDER `src/main/pricing/**`.
// INV-16 / CLAUDE.md §3.2: "SQL text exists only under `src/main/db/**`, behind a repository
// function", and `eslint.config.js` enforces it with `no-restricted-syntax` over `src/**` with a
// single directory exemption for `src/main/db/**`. E5's deliverable list names
// `src/main/pricing/price-repo.ts` as "the `price_rows` repository"; that module exists and owns
// the §3.11 POLICY — non-overlap enforcement, auto-versioning, hand-corrected dates. This file
// owns only the SQL those policies are expressed in. Splitting them is what the query seam is
// for, and it is not optional: a `SELECT … FROM` literal under `src/main/pricing/**` fails
// `pnpm run lint` (verified).
//
// ⚠️ `price_rows` is USER class (§2.2, ADR-026): never purged, never dropped, never truncated by
// a migration (INV-12). Nothing in this file deletes a row except `deleteById`, which exists for
// the explicit `pricing:deleteRow` channel (§4.7) and is never reached by a fetch or a reset.

import { Repository } from './base';
import type { SqlParam, SqliteDatabase } from '../sqlite';

/**
 * One stored `price_rows` row, in STORAGE units.
 *
 * ⚠️ Deliberately NOT `PriceRow` from `src/shared/ipc-contract.ts`. That is the §4.7 wire type
 * and carries `usdPerMillion`; this is the row as the `INTEGER` column holds it — picoUSD per
 * token (ADR-023 as amended). The conversion happens exactly once, at the edge, in
 * `src/main/pricing/price-repo.ts`, using `src/shared/money.ts`. Keeping the two types distinct
 * is what makes it impossible to hand a picoUSD number to a field that means USD/Mtok.
 */
export interface StoredPriceRow {
  readonly id: number;
  readonly model: string;
  readonly tokenClass: string;
  readonly ratePicoUsdPerToken: number;
  readonly validFrom: number;
  readonly validTo: number | null;
  readonly source: string;
  readonly sourceUrl: string | null;
  readonly note: string | null;
}

/** The row shape SQLite returns, before camel-casing. */
interface PriceRowRecord {
  readonly id: number;
  readonly model: string;
  readonly token_class: string;
  readonly rate_picousd_per_token: number;
  readonly valid_from: number;
  readonly valid_to: number | null;
  readonly source: string;
  readonly source_url: string | null;
  readonly note: string | null;
}

function toStored(row: PriceRowRecord): StoredPriceRow {
  return {
    id: row.id,
    model: row.model,
    tokenClass: row.token_class,
    ratePicoUsdPerToken: row.rate_picousd_per_token,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    source: row.source,
    sourceUrl: row.source_url,
    note: row.note,
  };
}

const COLUMNS = `id, model, token_class, rate_picousd_per_token, valid_from, valid_to,
                 source, source_url, note`;

// ---------------------------------------------------------------------------------------
// §3.11 — THE JOIN, STATED ONCE.
// ---------------------------------------------------------------------------------------
//
// "The rate applicable to one event and one token class. No row ⇒ that class is unpriced."
// Half-open `[valid_from, valid_to)`, `valid_to IS NULL` meaning still in effect (ADR-024), so
// the boundary instant belongs to exactly ONE row — no double-count, no gap (fixture F-08).
//
// ⚠️ This predicate is written ONCE, here, and every other place that needs it composes
// `rateAtPredicate()`. `repositories/cost.ts` interpolates it four times (once per token class)
// rather than re-typing it, because four hand-copied predicates are four chances for one of them
// to drift into `<=` on the wrong end.

/** The §3.11 range predicate, parameterised by the timestamp expression it is applied at. */
export function rateAtPredicate(tsExpression: string): string {
  return `pr.valid_from <= ${tsExpression} AND (pr.valid_to IS NULL OR pr.valid_to > ${tsExpression})`;
}

const SELECT_RATE_AT = `
SELECT pr.rate_picousd_per_token AS rate
FROM   price_rows pr
WHERE  pr.model       = ?
  AND  pr.token_class = ?
  AND  ${rateAtPredicate('?')}`;

const SELECT_ROW_COVERING = `
SELECT ${COLUMNS}
FROM   price_rows pr
WHERE  pr.model       = ?
  AND  pr.token_class = ?
  AND  ${rateAtPredicate('?')}`;

// ---------------------------------------------------------------------------------------
// INV-08 / ADR-024 — the non-overlap probe.
// ---------------------------------------------------------------------------------------
//
// "SQLite has no exclusion constraint, so the repository enforces it inside the same write
// transaction: before inserting or re-dating a row it asserts that no other row with the same
// (model, token_class) satisfies `valid_from < :newValidTo AND :newValidFrom < valid_to`
// (treating NULL as +∞), and aborts with E_PRICE_OVERLAP otherwise."
//
// NULL-as-+∞ is expressed as `(x IS NULL OR …)` rather than with a `9223372036854775807`
// sentinel: the sentinel cannot round-trip through a JS `number` bind parameter, and a sentinel
// that silently loses precision inside an overlap check is the exact failure mode INV-08 exists
// to prevent.

const SELECT_OVERLAPPING = `
SELECT ${COLUMNS}
FROM   price_rows pr
WHERE  pr.model       = ?
  AND  pr.token_class = ?
  AND  pr.id         <> ?
  AND  (? IS NULL OR pr.valid_from < ?)
  AND  (pr.valid_to IS NULL OR ? < pr.valid_to)
LIMIT 1`;

const SELECT_ALL = `SELECT ${COLUMNS} FROM price_rows pr
ORDER BY pr.model, pr.token_class, pr.valid_from`;

const SELECT_BY_MODEL = `SELECT ${COLUMNS} FROM price_rows pr WHERE pr.model = ?
ORDER BY pr.token_class, pr.valid_from`;

const SELECT_OPEN = `SELECT ${COLUMNS} FROM price_rows pr WHERE pr.valid_to IS NULL
ORDER BY pr.model, pr.token_class`;

const SELECT_OPEN_BY_MODEL = `SELECT ${COLUMNS} FROM price_rows pr
WHERE pr.valid_to IS NULL AND pr.model = ? ORDER BY pr.token_class`;

const SELECT_BY_ID = `SELECT ${COLUMNS} FROM price_rows pr WHERE pr.id = ?`;

/** The start of the next row after `ts`, so a new row can be closed at it instead of leaving an overlap. */
const SELECT_NEXT_VALID_FROM = `
SELECT MIN(pr.valid_from) AS next_valid_from
FROM   price_rows pr
WHERE  pr.model = ? AND pr.token_class = ? AND pr.valid_from > ?`;

const INSERT_ROW = `
INSERT INTO price_rows (model, token_class, rate_picousd_per_token, valid_from, valid_to,
                        source, source_url, note, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPDATE_VALID_TO = `UPDATE price_rows SET valid_to = ?, updated_at = ? WHERE id = ?`;

const UPDATE_DATES = `UPDATE price_rows SET valid_from = ?, valid_to = ?, updated_at = ? WHERE id = ?`;

const DELETE_BY_ID = `DELETE FROM price_rows WHERE id = ?`;

/** What `insert` needs. Storage units throughout. */
export interface NewPriceRow {
  readonly model: string;
  readonly tokenClass: string;
  readonly ratePicoUsdPerToken: number;
  readonly validFrom: number;
  readonly validTo: number | null;
  readonly source: string;
  readonly sourceUrl: string | null;
  readonly note: string | null;
}

export class PriceRowsRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /**
   * §3.11's join. `undefined` means **no covering row**, which means that class is unpriced —
   * never `0`, because a zero rate and an absent rate are different facts and conflating them is
   * how a `$` total becomes confidently wrong (INV-09).
   */
  rateAt(model: string, tokenClass: string, ts: number): number | undefined {
    return this.one<{ rate: number }>(SELECT_RATE_AT, model, tokenClass, ts, ts)?.rate;
  }

  /** The whole row §3.11's join selects, for the auto-versioning comparison. */
  rowCovering(model: string, tokenClass: string, ts: number): StoredPriceRow | undefined {
    const row = this.one<PriceRowRecord>(SELECT_ROW_COVERING, model, tokenClass, ts, ts);
    return row === undefined ? undefined : toStored(row);
  }

  /**
   * INV-08's probe. Returns the first row that would overlap `[validFrom, validTo)` for this
   * `(model, tokenClass)`, ignoring `excludeId` (so a row can be re-dated against its siblings).
   * `validTo === null` means +∞.
   */
  findOverlapping(
    model: string,
    tokenClass: string,
    validFrom: number,
    validTo: number | null,
    excludeId: number,
  ): StoredPriceRow | undefined {
    const row = this.one<PriceRowRecord>(
      SELECT_OVERLAPPING,
      model,
      tokenClass,
      excludeId,
      validTo,
      validTo,
      validFrom,
    );
    return row === undefined ? undefined : toStored(row);
  }

  /** §4.7 `pricing:list`. `includeHistory: false` returns only the still-in-effect rows. */
  list(model: string | undefined, includeHistory: boolean): StoredPriceRow[] {
    const params: SqlParam[] = model === undefined ? [] : [model];
    const sql = includeHistory
      ? model === undefined
        ? SELECT_ALL
        : SELECT_BY_MODEL
      : model === undefined
        ? SELECT_OPEN
        : SELECT_OPEN_BY_MODEL;
    return this.all<PriceRowRecord>(sql, ...params).map(toStored);
  }

  byId(id: number): StoredPriceRow | undefined {
    const row = this.one<PriceRowRecord>(SELECT_BY_ID, id);
    return row === undefined ? undefined : toStored(row);
  }

  /** The `valid_from` of the next row after `ts`, or `null` when this would be the last. */
  nextValidFromAfter(model: string, tokenClass: string, ts: number): number | null {
    return (
      this.one<{ next_valid_from: number | null }>(SELECT_NEXT_VALID_FROM, model, tokenClass, ts)
        ?.next_valid_from ?? null
    );
  }

  insert(row: NewPriceRow, now: number): number {
    const result = this.run(
      INSERT_ROW,
      row.model,
      row.tokenClass,
      row.ratePicoUsdPerToken,
      row.validFrom,
      row.validTo,
      row.source,
      row.sourceUrl,
      row.note,
      now,
      now,
    );
    return Number(result.lastInsertRowid);
  }

  /** Closes a row's validity range. The auto-versioning half of §3.11. */
  closeAt(id: number, validTo: number, now: number): void {
    this.run(UPDATE_VALID_TO, validTo, now, id);
  }

  /** §4.7 `pricing:setDates` — hand-corrected effective dates. Overlap is asserted by the caller. */
  setDates(id: number, validFrom: number, validTo: number | null, now: number): void {
    this.run(UPDATE_DATES, validFrom, validTo, now, id);
  }

  /** §4.7 `pricing:deleteRow`. The ONLY delete path; a fetch or reset never reaches it. */
  deleteById(id: number): number {
    return this.run(DELETE_BY_ID, id).changes;
  }

  /**
   * ADR-024: the non-overlap assertion runs "inside the same write transaction". This exposes
   * `Repository#transaction` so `price-repo.ts` can wrap probe-then-write as one unit.
   */
  withTransaction<T>(body: () => T): T {
    return this.transaction(body);
  }
}
