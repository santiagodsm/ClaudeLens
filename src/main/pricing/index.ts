// The seven §4.7 pricing channels, typed against `src/shared/ipc-contract.ts`.
//
// ⚠️ `PricingHandlers` is `Pick<IpcHandlerMap, PricingChannel>` — a slice of the ONE channel map
// (ADR-031). A renamed channel, a changed request shape or a changed response shape is a
// `typecheck` failure in this file rather than a runtime disagreement between two processes
// (§4 preamble: "this file must be COMPLETE, not a subset: a channel that lives only in a handler
// is a channel the compiler cannot police").
//
// ⚠️ No exception crosses the boundary (§4.1, ADR-031). `#withResult` is this epic's local
// wrapper: a `PricingError` or `DbError` becomes its own §4.1 code; anything else becomes
// `E_INTERNAL` with the stack in `detail`, never shown raw.
//
// ⚠️ NOTHING HERE RUNS ON ITS OWN. There is no timer, no launch hook, no lazy fetch-on-miss.
// §5.8 rule 1: "Only the user starts this." Every function below is invoked by an `invoke` from
// the renderer and by nothing else. `seedIfEmpty` is the one exception and it is deliberately
// LOCAL-ONLY — it loads the bundled `resources/price-seed.json`, which is not a network call.

import type {
  AppError,
  IpcHandlerMap,
  ObservedModelRow,
  Result,
  SettingsSnapshot,
} from '../../shared/ipc-contract';
import { isDbError } from '../db/errors';
import type { SqliteDatabase } from '../db/sqlite';
import { CostRepository } from '../db/repositories/cost';
import { CostCalculator } from './cost';
import { isPricingError } from './errors';
import { fetchPriceTable, type FetchImpl } from './fetch-price-table';
import { PriceRepo } from './price-repo';
import { loadPriceSeed } from './seed';

/** The §4.7 channels, named so the `Pick` below cannot drift from the table in §4.7. */
export type PricingChannel =
  | 'pricing:list'
  | 'pricing:upsertRate'
  | 'pricing:setDates'
  | 'pricing:deleteRow'
  | 'pricing:fetch'
  | 'pricing:resetToSeed'
  | 'pricing:models';

export type PricingHandlers = Pick<IpcHandlerMap, PricingChannel>;

export interface PricingDeps {
  readonly db: SqliteDatabase;
  /** Reads `priceFetchUrl` (§3.13). Injected rather than imported so this module never resolves a path or opens a file. */
  readonly settings: Pick<SettingsSnapshot, 'priceFetchUrl'> | (() => string);
  /** ⚠️ Injected so tests are deterministic and no timestamp ever defaults to "now" implicitly (ADR-021, F-07). */
  readonly now?: (() => number) | undefined;
  /** ⚠️ Test seam for the single egress point. Production passes nothing and the global `fetch` is used. */
  readonly fetchImpl?: FetchImpl | undefined;
  /** §4.9 `evt:pricingChanged` — emitted after ANY write to `price_rows` (§5.8 rule 4). */
  readonly onPricingChanged?: ((payload: { at: number }) => void) | undefined;
}

function toAppError(cause: unknown): AppError {
  if (isPricingError(cause)) return cause.toAppError();
  if (isDbError(cause)) {
    return { code: cause.code, message: cause.message, retryable: cause.retryable };
  }
  // §4.1 rule 1: an uncaught throw becomes E_INTERNAL with the stack in `detail`, never raw.
  return {
    code: 'E_INTERNAL',
    message: 'Something went wrong reading or writing the price table.',
    retryable: false,
    detail: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
  };
}

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function withResult<T>(body: () => T): Result<T> {
  try {
    return ok(body());
  } catch (cause) {
    return { ok: false, error: toAppError(cause) };
  }
}

async function withResultAsync<T>(body: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await body());
  } catch (cause) {
    return { ok: false, error: toAppError(cause) };
  }
}

/**
 * Everything the pricing epic exposes, in one object: the repositories (for E4's analytics and
 * E6's wiring) and the seven typed handlers.
 */
export class PricingService {
  readonly prices: PriceRepo;
  readonly cost: CostCalculator;
  readonly #models: CostRepository;
  readonly #deps: PricingDeps;

  constructor(deps: PricingDeps) {
    this.#deps = deps;
    this.prices = new PriceRepo(deps.db);
    this.cost = new CostCalculator(deps.db);
    this.#models = new CostRepository(deps.db);
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #priceFetchUrl(): string {
    const { settings } = this.#deps;
    return typeof settings === 'function' ? settings() : settings.priceFetchUrl;
  }

  #announce(at: number, wrote: boolean): void {
    if (wrote) this.#deps.onPricingChanged?.({ at });
  }

  /**
   * §3.11: the seed "is loaded on first run as rows with `source='seed'`".
   *
   * ⚠️ Additive through the SAME auto-versioning path as `pricing:resetToSeed`, so calling it on a
   * non-empty table is safe and writes nothing when nothing differs. It reads a bundled file; it
   * is NOT a fetch, and it does not violate §5.8 rule 1.
   */
  seedIfEmpty(): { applied: number; unchanged: number } {
    const at = this.#now();
    const result = this.prices.applyDocument(loadPriceSeed(), {
      source: 'seed',
      sourceUrl: null,
      now: at,
    });
    this.#announce(at, result.applied.length > 0);
    return { applied: result.applied.length, unchanged: result.unchanged };
  }

  /**
   * §4.7 `pricing:models` — "every distinct `model` string observed in `events`, with `priced`
   * telling the user whether any covering row exists. This is what makes an unpriced model
   * VISIBLE rather than silent" (ADR-025).
   */
  observedModels(): ObservedModelRow[] {
    return this.#models.observedModels().map((row): ObservedModelRow => ({
      model: row.model,
      events: row.events,
      firstTs: row.firstTs,
      lastTs: row.lastTs,
      priced: row.priced,
    }));
  }

  handlers(): PricingHandlers {
    return {
      'pricing:list': (req) =>
        withResult(() => ({
          rows: this.prices.list({ model: req.model, includeHistory: req.includeHistory }),
        })),

      // §5.8 rule 5: a manual edit enters at APPLYING and follows the identical path.
      // ⚠️ A rate finer than six decimal places of USD/Mtok is REJECTED with E_PRICE_PRECISION,
      // never rounded (ADR-023 amended, fixture F-10).
      'pricing:upsertRate': (req) =>
        withResult(() => {
          const at = this.#now();
          const result = this.prices.upsertRate(
            {
              model: req.model,
              tokenClass: req.tokenClass,
              usdPerMillion: req.usdPerMillion,
              note: req.note,
            },
            at,
          );
          this.#announce(at, result.versioned);
          return result;
        }),

      // §3.11 "Hand-corrected effective dates" — through the same INV-08 assertion.
      // ⚠️ Gaps are legal: a gap means the records inside it are uncosted and disclosed.
      'pricing:setDates': (req) =>
        withResult(() => {
          const at = this.#now();
          const result = this.prices.setDates(
            { id: req.id, validFrom: req.validFrom, validTo: req.validTo },
            at,
          );
          this.#announce(at, true);
          return result;
        }),

      'pricing:deleteRow': (req) =>
        withResult(() => {
          const at = this.#now();
          const result = this.prices.deleteRow({ id: req.id });
          this.#announce(at, true);
          return result;
        }),

      // SM-6 end to end. ⚠️ Any failure returns before `applyDocument` is called, so `price_rows`
      // is byte-identical (§5.8 rule 3): the fetch resolves to a fully validated document or it
      // throws, and only the success path opens a transaction.
      'pricing:fetch': () =>
        withResultAsync(async () => {
          const sourceUrl = this.#priceFetchUrl();
          const document = await fetchPriceTable(sourceUrl, { fetchImpl: this.#deps.fetchImpl });
          const at = this.#now();
          const result = this.prices.applyDocument(document, {
            source: 'fetch',
            sourceUrl,
            now: at,
          });
          this.#announce(at, result.applied.length > 0);
          return { applied: result.applied, unchanged: result.unchanged, sourceUrl };
        }),

      // §3.11: "additive through the same auto-versioning path and NEVER DELETES a `manual` row".
      // `applyDocument` has no delete in it at all, so that is structural.
      'pricing:resetToSeed': () =>
        withResult(() => {
          const at = this.#now();
          const result = this.prices.applyDocument(loadPriceSeed(), {
            source: 'seed',
            sourceUrl: null,
            now: at,
          });
          this.#announce(at, result.applied.length > 0);
          return { applied: result.applied, unchanged: result.unchanged };
        }),

      'pricing:models': () => withResult(() => ({ rows: this.observedModels() })),
    };
  }
}

export { CostCalculator, type CostResult } from './cost';
export { PricingError, isPricingError, type PricingErrorCode } from './errors';
export { fetchPriceTable, type FetchImpl } from './fetch-price-table';
export { PriceRepo } from './price-repo';
export {
  parsePriceDocument,
  validatePriceDocument,
  TOKEN_CLASSES,
  PRICE_DOCUMENT_SCHEMA,
  type ValidatedPriceDocument,
} from './price-document';
export { loadPriceSeed, PRICE_SEED_TEXT } from './seed';
