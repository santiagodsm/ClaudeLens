// The pricing layer's error type. DESIGN §4.1, ADR-031.
//
// Same shape and same reasoning as `src/main/db/errors.ts`: no exception ever crosses the IPC
// boundary, so the layer throws something that already CARRIES its §4.1 code and the handler
// wrapper maps it rather than flattening a specific failure into `E_INTERNAL`.
//
// ⚠️ `PricingErrorCode` is NARROWED from §4.1's closed enum with `Extract`, never restated
// (`src/shared/ipc-contract.ts` is the one definition). A code renamed or removed in §4.1 drops
// out of this union and every `new PricingError(...)` that used it fails to compile.
//
// The subset is exactly what §5.8's state machine and §3.11's assertions can raise, plus
// `E_INVALID_SETTING` (an unusable `priceFetchUrl`, or a rate outside the storable range —
// `src/shared/money.ts` already returns that code) and `E_INTERNAL`.

import type { AppError, ErrorCode } from '../../shared/ipc-contract';

/** The subset of §4.1 `ErrorCode` values the pricing layer can raise. */
export type PricingErrorCode = Extract<
  ErrorCode,
  | 'E_PRICE_OVERLAP'
  | 'E_PRICE_PRECISION'
  | 'E_PRICE_RANGE'
  | 'E_PRICE_NOT_FOUND'
  | 'E_FETCH_NO_URL'
  | 'E_FETCH_NETWORK'
  | 'E_FETCH_HTTP'
  | 'E_FETCH_TIMEOUT'
  | 'E_FETCH_SHAPE'
  | 'E_INVALID_SETTING'
  | 'E_INTERNAL'
>;

/** An error carrying a §4.1 code, so the IPC wrapper can report it precisely. */
export class PricingError extends Error {
  readonly code: PricingErrorCode;
  /** §4.1: whether the same call may succeed if repeated unchanged. */
  readonly retryable: boolean;
  /** §4.1 `AppError.detail` — developer detail, rendered only behind "Details". */
  readonly detail: string | undefined;

  constructor(
    code: PricingErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly retryable?: boolean;
      readonly detail?: string;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PricingError';
    this.code = code;
    // ⚠️ Default false. §4.1 rule 3: a `retryable: false` error must not be retried
    // automatically by any caller, and SM-6 rule 2 forbids retrying a fetch at all.
    this.retryable = options?.retryable ?? false;
    this.detail = options?.detail;
  }

  /** The §4.1 wire form. */
  toAppError(): AppError {
    const error: AppError = { code: this.code, message: this.message, retryable: this.retryable };
    return this.detail === undefined ? error : { ...error, detail: this.detail };
  }
}

/** Type guard, so callers branch on `code` and never on `message` (§4.1 rule 2). */
export function isPricingError(value: unknown): value is PricingError {
  return value instanceof PricingError;
}
