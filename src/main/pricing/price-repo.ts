// The `price_rows` repository — DESIGN §3.11, §5.8, ADR-023/024/025.
//
// ⚠️ "This is the schema's trickiest part and squarely in silently-wrong-number territory."
//
// This module owns the POLICY of §3.11. The SQL it is expressed in lives in
// `src/main/db/repositories/price-rows.ts`, because SQL text exists only under `src/main/db/**`
// (INV-16, lint-enforced). Three rules, and each has a fixture:
//
//   1. NON-OVERLAP (INV-08, ADR-024). SQLite has no exclusion constraint, so every insert and
//      every re-dating asserts, INSIDE THE SAME WRITE TRANSACTION, that no other row with the
//      same `(model, token_class)` satisfies `valid_from < :newValidTo AND :newValidFrom
//      < valid_to`, treating NULL as +∞. Otherwise: abort with `E_PRICE_OVERLAP`.
//   2. AUTO-VERSIONING (§3.11, §5.8 rule 4). On a fetch OR a manual edit, compare the incoming
//      rate with the currently-valid row. If ANY value differs, close the old row and open a new
//      one. If nothing differs, WRITE NOTHING. History accrues with no user effort.
//   3. HAND-CORRECTABLE EFFECTIVE DATES. `valid_from`/`valid_to` are directly editable through
//      the same overlap assertion. ⚠️ GAPS ARE LEGAL — a gap means the records inside it are
//      uncosted and disclosed (INV-09), not an error, and nothing here tries to close one.
//
// ⚠️ Nothing in this file deletes a row except `deleteRow`, which backs the explicit §4.7
// `pricing:deleteRow` channel. `resetToSeed` and `fetch` route through `applyDocument`, which is
// purely additive — so "`pricing:resetToSeed` … never deletes a `manual` row" (§3.11) is a
// property of the code shape, not a check someone has to remember to write.

import type { PriceChange, PriceRow, PriceSource, TokenClass } from '../../shared/ipc-contract';
import { picoUsdPerTokenToUsdPerMillion, usdPerMillionToPicoUsdPerToken } from '../../shared/money';
import {
  PriceRowsRepository,
  type NewPriceRow,
  type StoredPriceRow,
} from '../db/repositories/price-rows';
import type { SqliteDatabase } from '../db/sqlite';
import { PricingError } from './errors';
import {
  TOKEN_CLASSES,
  type ValidatedPriceDocument,
  type ValidatedPriceEntry,
} from './price-document';

/** No row is excluded when probing for overlap on a brand-new row. `id` is `INTEGER PRIMARY KEY`, so 0 is never used. */
const NO_EXCLUDED_ROW = 0;

const PRICE_SOURCES: readonly PriceSource[] = ['seed', 'fetch', 'manual'];

function isTokenClass(value: string): value is TokenClass {
  return (TOKEN_CLASSES as readonly string[]).includes(value);
}

function isPriceSource(value: string): value is PriceSource {
  return (PRICE_SOURCES as readonly string[]).includes(value);
}

/**
 * §4.7's wire shape. `usdPerMillion` is `rate_picousd_per_token / 1e6` — the ONE place the
 * storage unit becomes the presentation unit, using `src/shared/money.ts`.
 *
 * A stored `token_class` or `source` outside its CHECK constraint means the table has been
 * hand-edited past the schema; that is a fault, and it is reported rather than coerced.
 */
function toWire(row: StoredPriceRow): PriceRow {
  if (!isTokenClass(row.tokenClass)) {
    throw new PricingError('E_INTERNAL', 'A stored price row has an unknown token class.', {
      detail: `price_rows.id=${String(row.id)} token_class=${row.tokenClass}`,
    });
  }
  if (!isPriceSource(row.source)) {
    throw new PricingError('E_INTERNAL', 'A stored price row has an unknown source.', {
      detail: `price_rows.id=${String(row.id)} source=${row.source}`,
    });
  }
  return {
    id: row.id,
    model: row.model,
    tokenClass: row.tokenClass,
    usdPerMillion: picoUsdPerTokenToUsdPerMillion(row.ratePicoUsdPerToken),
    validFrom: row.validFrom,
    validTo: row.validTo,
    source: row.source,
    sourceUrl: row.sourceUrl,
    note: row.note,
  };
}

export interface UpsertRateRequest {
  readonly model: string;
  readonly tokenClass: TokenClass;
  readonly usdPerMillion: number;
  readonly note?: string | undefined;
}

export interface SetDatesRequest {
  readonly id: number;
  readonly validFrom: number;
  readonly validTo: number | null;
}

export interface ApplyDocumentOptions {
  readonly source: PriceSource;
  readonly sourceUrl: string | null;
  /** Used for `created_at`/`updated_at`, and as the effective date of any entry the document did not date (§4.7). */
  readonly now: number;
  /** `price_rows.note`, written onto any row this application opens. */
  readonly note?: string | null | undefined;
}

export interface ApplyResult {
  readonly applied: PriceChange[];
  readonly unchanged: number;
}

export class PriceRepo {
  readonly #rows: PriceRowsRepository;

  constructor(db: SqliteDatabase) {
    this.#rows = new PriceRowsRepository(db);
  }

  // -------------------------------------------------------------------------------------
  // §4.7 `pricing:list`
  // -------------------------------------------------------------------------------------

  list(request: { model?: string | undefined; includeHistory: boolean }): PriceRow[] {
    return this.#rows.list(request.model, request.includeHistory).map(toWire);
  }

  /** §3.11's join, for callers that need one rate. `undefined` = unpriced, never `0`. */
  rateAt(model: string, tokenClass: TokenClass, ts: number): number | undefined {
    return this.#rows.rateAt(model, tokenClass, ts);
  }

  // -------------------------------------------------------------------------------------
  // INV-08 / ADR-024 — the non-overlap assertion.
  // -------------------------------------------------------------------------------------

  /**
   * ⚠️ Callers MUST already be inside `#rows.withTransaction`. ADR-024: the assertion and the
   * write it guards are one unit, or the assertion proves nothing.
   */
  #assertNoOverlap(
    model: string,
    tokenClass: string,
    validFrom: number,
    validTo: number | null,
    excludeId: number,
  ): void {
    // §3.11 DDL: CHECK (valid_to IS NULL OR valid_to > valid_from). Checked here too so the user
    // gets `E_PRICE_RANGE` and a sentence, rather than a raw SQLITE_CONSTRAINT.
    if (validTo !== null && validTo <= validFrom) {
      throw new PricingError('E_PRICE_RANGE', 'A price row must end after it starts.', {
        detail: `validFrom=${String(validFrom)} validTo=${String(validTo)}`,
      });
    }
    const clash = this.#rows.findOverlapping(model, tokenClass, validFrom, validTo, excludeId);
    if (clash !== undefined) {
      throw new PricingError(
        'E_PRICE_OVERLAP',
        'That date range overlaps an existing row for this model and class.',
        {
          detail:
            `${model}/${tokenClass}: [${String(validFrom)}, ${String(validTo ?? Infinity)}) ` +
            `overlaps row ${String(clash.id)} [${String(clash.validFrom)}, ` +
            `${String(clash.validTo ?? Infinity)}) (INV-08)`,
        },
      );
    }
  }

  #insertChecked(row: NewPriceRow, now: number): number {
    this.#assertNoOverlap(row.model, row.tokenClass, row.validFrom, row.validTo, NO_EXCLUDED_ROW);
    return this.#rows.insert(row, now);
  }

  // -------------------------------------------------------------------------------------
  // §3.11 / §5.8 rule 4 — auto-versioning. ONE implementation, used by fetch, reset AND
  // manual edit, because §5.8 rule 5 says manual entry "enters at APPLYING and follows the
  // identical path — manual entry is a first-class path, not a fallback".
  // -------------------------------------------------------------------------------------

  /**
   * Applies one incoming rate at `effectiveFrom`. Returns the change it made, or `null` when
   * nothing differed (§3.11: "If nothing differs, nothing is written").
   *
   * ⚠️ Must run inside a transaction. The three cases:
   *
   *   (a) A row covers `effectiveFrom` and its rate is IDENTICAL → write nothing.
   *   (b) A row covers `effectiveFrom` and its rate DIFFERS → close it at `effectiveFrom` and
   *       open a new row `[effectiveFrom, oldValidTo)`. Carrying the old row's `valid_to` (rather
   *       than always `NULL`) is what lets a document containing several dated periods for the
   *       same model land correctly: a later row that already exists is not overwritten and not
   *       overlapped.
   *   (c) No row covers `effectiveFrom` — the table is empty here, or `effectiveFrom` falls in a
   *       gap → insert `[effectiveFrom, nextRowStart)`. ⚠️ It does NOT reach backwards to fill
   *       the gap before `effectiveFrom`: gaps are legal, and an uncosted record disclosed by
   *       name is the designed outcome, not something to paper over.
   *
   * ⚠️ Degenerate case, called out because it is the only place versioning declines to act: if
   * the covering row STARTS at exactly `effectiveFrom`, closing it would set
   * `valid_to = valid_from` — a zero-length range, forbidden by the §3.11 CHECK and meaningless
   * as history. Rather than delete the row (which `resetToSeed` may never do to a `manual` row)
   * or rewrite it in place (which would silently discard a rate the user typed), this leaves it
   * alone and reports nothing. The user re-dates it in Settings, which is a first-class path.
   */
  #applyOne(
    entry: ValidatedPriceEntry,
    effectiveFrom: number,
    options: ApplyDocumentOptions,
  ): PriceChange | null {
    const covering = this.#rows.rowCovering(entry.model, entry.tokenClass, effectiveFrom);

    if (covering !== undefined && covering.ratePicoUsdPerToken === entry.ratePicoUsdPerToken) {
      return null; // (a) nothing differs.
    }

    const change: PriceChange = {
      model: entry.model,
      tokenClass: entry.tokenClass,
      fromUsdPerMillion:
        covering === undefined
          ? null
          : picoUsdPerTokenToUsdPerMillion(covering.ratePicoUsdPerToken),
      toUsdPerMillion: picoUsdPerTokenToUsdPerMillion(entry.ratePicoUsdPerToken),
      effectiveFrom,
    };

    if (covering !== undefined) {
      if (covering.validFrom === effectiveFrom) {
        return null; // the degenerate case above: decline, never destroy.
      }
      // (b) Close first, THEN insert. `uq_price_rows_open` allows at most one open-ended row per
      // (model, token_class) and SQLite checks a unique index per statement, so the order is
      // load-bearing when the old row was the open one.
      const newValidTo = covering.validTo;
      this.#rows.closeAt(covering.id, effectiveFrom, options.now);
      this.#insertChecked(
        {
          model: entry.model,
          tokenClass: entry.tokenClass,
          ratePicoUsdPerToken: entry.ratePicoUsdPerToken,
          validFrom: effectiveFrom,
          validTo: newValidTo,
          source: options.source,
          sourceUrl: options.sourceUrl,
          note: options.note ?? null,
        },
        options.now,
      );
      return change;
    }

    // (c) No covering row.
    const nextStart = this.#rows.nextValidFromAfter(entry.model, entry.tokenClass, effectiveFrom);
    this.#insertChecked(
      {
        model: entry.model,
        tokenClass: entry.tokenClass,
        ratePicoUsdPerToken: entry.ratePicoUsdPerToken,
        validFrom: effectiveFrom,
        validTo: nextStart,
        source: options.source,
        sourceUrl: options.sourceUrl,
        note: options.note ?? null,
      },
      options.now,
    );
    return change;
  }

  /**
   * §5.8 `APPLYING` — "runs the auto-versioning of §3.11 inside one transaction, then emits
   * `evt:pricingChanged`. The response reports every change so the user can see what moved."
   *
   * ⚠️ The document is ALREADY fully validated and converted (`price-document.ts`) before this is
   * called, which is what makes SM-6 rule 3 structural: there is no path from a malformed
   * document to a partially-written table.
   *
   * Entries are applied in ascending `effectiveFrom` order so that a document describing several
   * periods for one model builds its history forwards, each period closing the one before it.
   */
  applyDocument(document: ValidatedPriceDocument, options: ApplyDocumentOptions): ApplyResult {
    const dated = document.entries.map((entry) => ({
      entry,
      // §4.7: `effectiveFrom` is "optional; defaults to fetch time". The default is applied HERE,
      // explicitly, by the caller's clock — never inside the validator, and never by `Date.now()`
      // buried in a query (ADR-021, fixture F-07).
      effectiveFrom: entry.effectiveFrom ?? options.now,
    }));
    dated.sort((a, b) => a.effectiveFrom - b.effectiveFrom);

    return this.#rows.withTransaction((): ApplyResult => {
      const applied: PriceChange[] = [];
      let unchanged = 0;
      for (const item of dated) {
        const change = this.#applyOne(item.entry, item.effectiveFrom, options);
        if (change === null) unchanged += 1;
        else applied.push(change);
      }
      return { applied, unchanged };
    });
  }

  // -------------------------------------------------------------------------------------
  // §4.7 `pricing:upsertRate` — the manual edit. §5.8 rule 5: identical path.
  // -------------------------------------------------------------------------------------

  upsertRate(request: UpsertRateRequest, now: number): { rows: PriceRow[]; versioned: boolean } {
    // ⚠️ Rejected, never rounded (ADR-023 amended, fixture F-10): a 7-decimal USD/Mtok input
    // comes back as `E_PRICE_PRECISION` from `src/shared/money.ts` and never reaches the table.
    const converted = usdPerMillionToPicoUsdPerToken(request.usdPerMillion);
    if (!converted.ok) {
      const code = converted.error.code;
      throw new PricingError(
        code === 'E_PRICE_PRECISION' || code === 'E_INVALID_SETTING' ? code : 'E_INTERNAL',
        converted.error.message,
        { detail: converted.error.detail },
      );
    }

    const entry: ValidatedPriceEntry = {
      model: request.model,
      tokenClass: request.tokenClass,
      ratePicoUsdPerToken: converted.data,
      effectiveFrom: now,
    };

    const result = this.#rows.withTransaction(() =>
      this.#applyOne(entry, now, {
        source: 'manual',
        sourceUrl: null,
        now,
        note: request.note ?? null,
      }),
    );

    return {
      rows: this.list({ model: request.model, includeHistory: true }),
      versioned: result !== null,
    };
  }

  // -------------------------------------------------------------------------------------
  // §4.7 `pricing:setDates` — hand-corrected effective dates, same overlap assertion.
  // -------------------------------------------------------------------------------------

  setDates(request: SetDatesRequest, now: number): { rows: PriceRow[] } {
    const model = this.#rows.withTransaction((): string => {
      const existing = this.#rows.byId(request.id);
      if (existing === undefined) {
        throw new PricingError('E_PRICE_NOT_FOUND', 'That price row no longer exists.', {
          detail: `price_rows.id=${String(request.id)}`,
        });
      }
      // ⚠️ The row re-dates itself, so it is excluded from its own overlap probe — otherwise
      // every edit would collide with the row being edited. Every OTHER row still applies
      // (INV-08), including an open-ended one, which is the NULL-as-+∞ case.
      this.#assertNoOverlap(
        existing.model,
        existing.tokenClass,
        request.validFrom,
        request.validTo,
        existing.id,
      );
      this.#rows.setDates(request.id, request.validFrom, request.validTo, now);
      return existing.model;
    });

    return { rows: this.list({ model, includeHistory: true }) };
  }

  // -------------------------------------------------------------------------------------
  // §4.7 `pricing:deleteRow` — the only delete path in the pricing layer.
  // -------------------------------------------------------------------------------------

  deleteRow(request: { id: number }): { rows: PriceRow[] } {
    const model = this.#rows.withTransaction((): string => {
      const existing = this.#rows.byId(request.id);
      if (existing === undefined) {
        throw new PricingError('E_PRICE_NOT_FOUND', 'That price row no longer exists.', {
          detail: `price_rows.id=${String(request.id)}`,
        });
      }
      this.#rows.deleteById(request.id);
      return existing.model;
    });
    return { rows: this.list({ model, includeHistory: true }) };
  }
}
