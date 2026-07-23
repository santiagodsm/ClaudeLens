// The §4.7 canonical price-document validator.
//
// "The canonical price-document shape — what `resources/price-seed.json` contains and what a
// fetched document must validate against. Anything else is rejected with `E_FETCH_SHAPE`, and the
// existing price table is left completely intact." (§4.7, §5.8 rule 3.)
//
// ⚠️ This module is PURE and does no I/O. That is the point: SM-6 rule 3 says "any failure leaves
// `price_rows` byte-identical: validation completes before a single write", and the only way to
// make that structurally true rather than remembered is to have validation be a total function
// from bytes to either a fully-converted document or an error, with no database in scope. The
// fetch path and the seed path both call it, and neither can start writing early.
//
// ⚠️ Every rate is converted to picoUSD/token HERE, during validation, using `src/shared/money.ts`.
// A rate that the storage unit cannot hold exactly is a validation failure, not a rounding
// opportunity (ADR-023 as amended, fixture F-10).

import type {
  ErrorCode,
  PriceDocument,
  PriceDocumentModel,
  TokenClass,
} from '../../shared/ipc-contract';
import { usdPerMillionToPicoUsdPerToken } from '../../shared/money';
import { PricingError, type PricingErrorCode } from './errors';

/**
 * `src/shared/money.ts` returns a `Result` carrying a §4.1 `ErrorCode`; only two of them are
 * reachable from `usdPerMillionToPicoUsdPerToken`, and both are in `PricingErrorCode`. Narrowing
 * rather than casting means a third code added to `money.ts` surfaces here as
 * `E_INTERNAL` — visible — instead of being asserted away.
 */
function asPricingErrorCode(code: ErrorCode): PricingErrorCode {
  return code === 'E_PRICE_PRECISION' || code === 'E_INVALID_SETTING' ? code : 'E_INTERNAL';
}

/** §4.7 — the schema string this build understands. A different one is not this format. */
export const PRICE_DOCUMENT_SCHEMA = 'claude-lens/price-table@1';

/**
 * §4.7 / §3.11 — exactly **five**, each priced independently and **stored, never derived**.
 *
 * ⚠️ ADR-024 records the user's explicit rejection of deriving cache rates from the base input
 * rate by the usual multipliers: "it breaks silently the moment a model deviates from the ratio,
 * and with 3.1B cache reads against 64.2M output tokens the error is a multiple, not a rounding."
 * All five are therefore REQUIRED in the document. A model missing one is a shape error, not an
 * invitation to compute it.
 *
 * ⚠️ **AMENDED 2026-07-22 (A-05) — `cache_write_1h` joins the set, and it is REQUIRED like the
 * rest.** `cache_write` keeps its meaning and is the **5-minute** class. Today's published page
 * puts the 1-hour rate at exactly 2x input for every seeded model, and that is precisely the
 * observation ADR-024 forbids turning into arithmetic: it is seeded as a stored rate. A document
 * that omits it is rejected with `E_FETCH_SHAPE` naming the missing field, and `price_rows` is
 * left completely intact (§5.8 rule 3) — the loudest, safest failure available, and the same one
 * the four original classes have always had.
 */
export const TOKEN_CLASSES: readonly TokenClass[] = [
  'input',
  'output',
  'cache_write',
  'cache_write_1h',
  'cache_read',
];

/** One model entry, fully converted to storage units and to epoch ms. */
export interface ValidatedPriceEntry {
  readonly model: string;
  readonly tokenClass: TokenClass;
  readonly ratePicoUsdPerToken: number;
  /** UTC epoch ms. `undefined` means "the document did not date it" — the caller supplies now. */
  readonly effectiveFrom: number | undefined;
}

export interface ValidatedPriceDocument {
  readonly schema: typeof PRICE_DOCUMENT_SCHEMA;
  readonly generatedAt: string;
  readonly entries: readonly ValidatedPriceEntry[];
}

function shapeError(detail: string): PricingError {
  return new PricingError(
    'E_FETCH_SHAPE',
    'That document is not a Claude Lens price table.',
    // §5.8: the price table is untouched either way, so this is safe to retry after the user
    // fixes the URL — but not automatically (§4.1 rule 3).
    { retryable: false, detail: `${detail} (expected the §4.7 claude-lens/price-table@1 shape)` },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ADR-021: every timestamp in this application is UTC epoch ms, and **no timestamp ever defaults
 * to "now"** silently (fixture F-07). An `effectiveFrom` that is present but unparseable is an
 * error; an absent one returns `undefined` so the CALLER makes the "defaults to fetch time"
 * decision explicitly, at the one place §4.7 says it may.
 */
function parseEffectiveFrom(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw shapeError(`${where}.effectiveFrom is not a string`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw shapeError(`${where}.effectiveFrom is not an ISO 8601 timestamp: ${value}`);
  }
  return parsed;
}

function validateModelEntry(raw: unknown, index: number): ValidatedPriceEntry[] {
  const where = `models[${String(index)}]`;
  if (!isRecord(raw)) throw shapeError(`${where} is not an object`);

  const model = raw['model'];
  // ADR-025: the EXACT raw `message.model` string. Not trimmed, not lower-cased, not normalized
  // — any of which would be a guess about a naming convention the vendor controls.
  if (typeof model !== 'string' || model.length === 0) {
    throw shapeError(`${where}.model is not a non-empty string`);
  }

  const rates = raw['rates'];
  if (!isRecord(rates)) throw shapeError(`${where}.rates is not an object`);

  const effectiveFrom = parseEffectiveFrom(raw['effectiveFrom'], where);

  return TOKEN_CLASSES.map((tokenClass): ValidatedPriceEntry => {
    const usdPerMillion = rates[tokenClass];
    if (typeof usdPerMillion !== 'number') {
      // All four are required — see TOKEN_CLASSES above and ADR-024.
      throw shapeError(`${where}.rates.${tokenClass} is missing or not a number`);
    }
    const converted = usdPerMillionToPicoUsdPerToken(usdPerMillion);
    if (!converted.ok) {
      // ⚠️ Reported with the SPECIFIC code `src/shared/money.ts` chose — `E_PRICE_PRECISION` for
      // a rate finer than six decimal places of USD/Mtok, `E_INVALID_SETTING` for one outside the
      // storable range. §5.8 says "shape mismatch ⇒ E_FETCH_SHAPE", and a JSON number IS the
      // right shape; what fails here is representability, which has its own §4.1 code and its own
      // sentence in Settings. Either way this happens during validation, so `price_rows` is
      // untouched (§5.8 rule 3).
      throw new PricingError(asPricingErrorCode(converted.error.code), converted.error.message, {
        retryable: false,
        detail: `${where}.rates.${tokenClass}: ${converted.error.detail ?? ''}`,
      });
    }
    return {
      model,
      tokenClass,
      ratePicoUsdPerToken: converted.data,
      effectiveFrom,
    };
  });
}

/**
 * Validates a parsed JSON value against §4.7 and converts every rate to picoUSD/token.
 *
 * Throws `PricingError`. Never returns a partially-validated document: the caller either gets
 * every entry or none, which is what lets `applyDocument` open its transaction knowing the whole
 * document is already good.
 */
export function validatePriceDocument(raw: unknown): ValidatedPriceDocument {
  if (!isRecord(raw)) throw shapeError('the document is not a JSON object');

  if (raw['schema'] !== PRICE_DOCUMENT_SCHEMA) {
    throw shapeError(`schema is ${JSON.stringify(raw['schema'])}, not "${PRICE_DOCUMENT_SCHEMA}"`);
  }

  const generatedAt = raw['generatedAt'];
  if (typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt))) {
    throw shapeError('generatedAt is not an ISO 8601 timestamp');
  }

  const models = raw['models'];
  if (!Array.isArray(models)) throw shapeError('models is not an array');
  if (models.length === 0) throw shapeError('models is empty');

  const entries = models.flatMap((entry, index) => validateModelEntry(entry, index));
  return { schema: PRICE_DOCUMENT_SCHEMA, generatedAt, entries };
}

/** Parses JSON text and validates it. A parse failure is a shape failure. */
export function parsePriceDocument(text: string): ValidatedPriceDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw shapeError(
      `the response body is not valid JSON: ${cause instanceof Error ? cause.message : 'parse failed'}`,
    );
  }
  return validatePriceDocument(parsed);
}

/** Narrowing helper for callers that hold an already-typed document (the bundled seed). */
export function isPriceDocument(value: unknown): value is PriceDocument {
  try {
    validatePriceDocument(value);
    return true;
  } catch {
    return false;
  }
}

export type { PriceDocument, PriceDocumentModel };
