// The database layer's error type.
//
// DESIGN §4.1, ADR-031: no exception ever crosses the IPC boundary. Every `invoke` handler
// returns `Result<T>`, and an uncaught throw becomes `E_INTERNAL`. The database layer's job
// is therefore to throw something that already CARRIES its §4.1 code, so the handler wrapper
// maps it rather than flattening a real, specific failure into a generic one.
//
// ⚠️ `DbErrorCode` is NARROWED from §4.1's closed enum with `Extract`, never restated. There
// is exactly one definition of `ErrorCode` — `src/shared/ipc-contract.ts` — so a code renamed
// or removed in §4.1 drops out of this union and every `new DbError(...)` that used it fails
// to compile, rather than drifting behind a comment nobody re-reads. The subset stays
// explicit because the database layer genuinely cannot raise, say, an `E_ARCHIVE_*`, and a
// handler mapping DB failures should not have to consider one.

import type { ErrorCode } from '../../shared/ipc-contract';

/** The subset of §4.1 `ErrorCode` values the database layer can raise. */
export type DbErrorCode = Extract<
  ErrorCode,
  | 'E_DB_MIGRATION_FAILED'
  | 'E_DB_CORRUPT'
  | 'E_DB_BUSY'
  | 'E_UNKNOWN_SETTING'
  | 'E_INVALID_SETTING'
  | 'E_INTERNAL'
>;

/** An error carrying a §4.1 code, so the IPC wrapper can report it precisely. */
export class DbError extends Error {
  readonly code: DbErrorCode;
  /** §4.1: whether the same call may succeed if repeated unchanged. */
  readonly retryable: boolean;

  constructor(
    code: DbErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly retryable?: boolean },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DbError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

/** Type guard, so callers branch on `code` and never on `message` (§4.1 rule 2). */
export function isDbError(value: unknown): value is DbError {
  return value instanceof DbError;
}
