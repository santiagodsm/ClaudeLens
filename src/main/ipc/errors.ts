// §4.1 rule 1 / ADR-031 — the ONE `withResult()` wrapper.
//
//   "Every handler is wrapped by one `withResult()` helper — an uncaught throw becomes
//    `E_INTERNAL` with the stack in `detail`, logged to the main-process log, never shown raw."
//
// ⚠️ **No exception ever crosses the IPC boundary.** Electron serialises a thrown `Error` into
// a lossy string, so error *codes* would not survive and the renderer would end up matching on
// message text — which §4.1 rule 2 forbids. The envelope is what keeps `code` authoritative.
//
// ⚠️ **There is no "warning" channel** (§4.1 rule 4). A partial or incomplete result is
// expressed in the SUCCESS payload as a disclosure (§4.6), never as an error. That is the
// load-bearing half: if "N records uncosted" were an error, a caller could swallow it and
// render a confident wrong total.

import type {
  AppError,
  ErrorCode,
  IpcChannel,
  IpcHandler,
  IpcRequest,
  IpcResponse,
  Result,
} from '../../shared/ipc-contract';
import { isDbError } from '../db/errors';
import { isPricingError } from '../pricing/errors';
import type { Logger } from '../log/logger';

/** A wrapped handler: it takes the request and always resolves, never rejects. */
export type WrappedHandler<C extends IpcChannel> = (
  request: IpcRequest<C>,
) => Promise<Result<IpcResponse<C>>>;

/**
 * The handler layer's own error type, in the same shape and for the same reason as
 * `DbError` (§4.1): throw something that already CARRIES its code, so `withResult()` maps a
 * real, specific failure rather than flattening it into `E_INTERNAL`.
 *
 * It exists because §4.3's directory codes (`E_NO_DIR`, `E_DIR_NOT_FOUND`, `E_DIR_INVALID`,
 * `E_DIR_UNREADABLE`) and §4.8's archive codes are raised above the database seam, where
 * neither `DbError` nor `PricingError` can reach.
 */
export class HandlerError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly detail: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly retryable?: boolean; readonly detail?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HandlerError';
    this.code = code;
    // §4.1 rule 3 — default false: a caller must not retry automatically unless told it may.
    this.retryable = options?.retryable ?? false;
    this.detail = options?.detail;
  }

  toAppError(): AppError {
    const error: AppError = { code: this.code, message: this.message, retryable: this.retryable };
    return this.detail === undefined ? error : { ...error, detail: this.detail };
  }
}

/** Type guard, so callers branch on `code` and never on `message` (§4.1 rule 2). */
export function isHandlerError(value: unknown): value is HandlerError {
  return value instanceof HandlerError;
}

function stackOf(cause: unknown): string {
  if (cause instanceof Error) return cause.stack ?? `${cause.name}: ${cause.message}`;
  return String(cause);
}

/**
 * §4.1 — map anything thrown into the closed error enum.
 *
 * Errors that already carry a §4.1 code keep it: `DbError` and `PricingError` exist precisely
 * so a real, specific failure is not flattened into a generic one. Everything else is
 * `E_INTERNAL` with the stack in `detail` — rendered only behind "Details" (§4.1), never as
 * the user-facing sentence.
 */
export function toAppError(cause: unknown): AppError {
  if (isHandlerError(cause)) return cause.toAppError();
  if (isPricingError(cause)) return cause.toAppError();
  if (isDbError(cause)) {
    return {
      code: cause.code,
      message: cause.message,
      detail: stackOf(cause),
      retryable: cause.retryable,
    };
  }
  return {
    code: 'E_INTERNAL',
    message: 'Something went wrong inside Claude Lens.',
    detail: stackOf(cause),
    retryable: false,
  };
}

/**
 * The wrapper. Applied to **every** channel by `registerIpc`, including handlers that already
 * return a `Result` of their own (the §4.7 pricing slice does): a `Result` passes straight
 * through, so double-wrapping is a no-op rather than a second envelope.
 */
export function withResult<C extends IpcChannel>(
  channel: C,
  handler: IpcHandler<C>,
  logger: Logger,
): WrappedHandler<C> {
  return async (request: IpcRequest<C>): Promise<Result<IpcResponse<C>>> => {
    try {
      return await handler(request);
    } catch (cause) {
      const error = toAppError(cause);
      // §4.1 rule 1 — "logged to the main-process log, never shown raw". The stack goes to
      // the log AND to `detail`; §7.3's redaction runs over both on the way to the file.
      logger.error(error.message, {
        code: error.code,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
        fields: { channel },
      });
      return { ok: false, error };
    }
  };
}

/**
 * The honest answer for a channel whose repository has not been written yet.
 *
 * ⚠️ **Never a zero, never an empty row set.** A zero the renderer cannot distinguish from a
 * real zero is precisely this project's defining bug (CLAUDE.md §1). E7's renderer degrades an
 * error to an `ErrorState`; it degrades a fabricated empty payload to a confident, wrong,
 * beautifully rendered screen.
 */
export function notImplemented(channel: IpcChannel, owner: string): Result<never> {
  return {
    ok: false,
    error: {
      code: 'E_INTERNAL',
      message: 'This part of Claude Lens is not built yet.',
      detail:
        `The channel "${channel}" has no implementation in this build (${owner}). ` +
        'It deliberately returns an error rather than an empty or zeroed payload: a zero the ' +
        'renderer cannot tell apart from a real zero is the failure this project exists to ' +
        'prevent (CLAUDE.md §1, DESIGN §4.1).',
      retryable: false,
    },
  };
}

/** A handler that is not implemented yet, typed so the channel map still compiles. */
export function notImplementedHandler<C extends IpcChannel>(
  channel: C,
  owner: string,
): IpcHandler<C> {
  return () => notImplemented(channel, owner);
}
