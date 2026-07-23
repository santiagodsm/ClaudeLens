/**
 * The renderer's entire data vocabulary (INV-16, §4 preamble, ADR-031).
 *
 * Nothing else in `src/renderer/**` talks to the outside world. There is no fetch, no fs, no
 * database, no `electron` import — only the two closures the preload put on `window.claudeLens`,
 * typed against `src/shared/ipc-contract.ts`.
 *
 * ⚠️ Three rules this module exists to make unbreakable:
 *   1. **No exception crosses the boundary** (ADR-031). Every call resolves to a `Result`.
 *   2. **The renderer branches on `code`, never on `message`** (§4.1 rule 2). `message` is
 *      display text; `code` is the closed enum.
 *   3. **A missing handler is an error, never a zero.** No `q:*` handler exists yet; calling one
 *      yields `E_INTERNAL` and the view renders an ErrorState. Substituting an empty payload
 *      here would manufacture the silently-wrong number the whole project is built against
 *      (CLAUDE.md §1).
 */

import type {
  AppError,
  ErrorCode,
  IpcChannel,
  IpcRequest,
  IpcRequestArgs,
  IpcResponse,
  PushChannel,
  PushListener,
  Result,
} from '../../shared/ipc-contract';

/**
 * The shape the preload exposes. It is declared structurally against the same contract types
 * the preload's `api` object is built from (`IpcInvoke`, `PushSubscribe`), so the two cannot
 * differ in signature. Only the three property names are stated twice; they are stated nowhere
 * else, and `src/preload/index.ts` is the other place.
 *
 * ⚠️ The renderer deliberately does not `import type` from `src/preload/**`: the preload is a
 * Node/Electron module and importing it here would drag `electron` into the renderer's
 * type graph, which INV-16 forbids on purpose.
 */
export interface ClaudeLensBridge {
  version: string;
  invoke: <C extends IpcChannel>(
    channel: C,
    ...request: IpcRequestArgs<C>
  ) => Promise<Result<IpcResponse<C>>>;
  subscribe: <C extends PushChannel>(channel: C, listener: PushListener<C>) => () => void;
}

declare global {
  interface Window {
    /**
     * `undefined` in a component test and in any window the preload did not run for. Every
     * access goes through `bridge()` below, which turns absence into an `AppError` rather
     * than a thrown `TypeError` two frames deep inside a chart.
     */
    claudeLens?: ClaudeLensBridge;
  }
}

/**
 * ⚠️ Not a real `ErrorCode` value, because §4.1's enum is closed and this condition cannot
 * occur in a shipped app — the preload always runs. It is `E_INTERNAL` on the wire; this
 * constant exists only so the message is written once.
 */
const NO_BRIDGE: AppError = {
  code: 'E_INTERNAL',
  message: 'The app is still starting up.',
  detail:
    'window.claudeLens is undefined: the preload script did not run for this window. ' +
    'In a component test, stub it with installBridge().',
  retryable: false,
};

function bridge(): ClaudeLensBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.claudeLens;
}

/** Whether the preload surface is present. Views use this only to explain themselves. */
export function isBridgeAvailable(): boolean {
  return bridge() !== undefined;
}

/**
 * The typed call. Resolves — always. A rejection here would be a bug in the preload, and it is
 * caught anyway (belt and braces: the preload converts, and so does this).
 */
export async function invoke<C extends IpcChannel>(
  channel: C,
  ...request: IpcRequestArgs<C>
): Promise<Result<IpcResponse<C>>> {
  const surface = bridge();
  if (surface === undefined) return { ok: false, error: NO_BRIDGE };
  try {
    return await surface.invoke(channel, ...request);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'E_INTERNAL',
        message: 'That part of the app could not be reached.',
        detail: `ipc invoke '${channel}' threw in the renderer: ${String(cause)}`,
        retryable: false,
      },
    };
  }
}

/**
 * `invoke` with the request supplied as a value rather than as a rest argument, which is what
 * `useQuery` needs (it round-trips the request through JSON to get a stable cache key).
 * `undefined` is the request for the contract's `void` channels.
 */
export function invokeWith<C extends IpcChannel>(
  channel: C,
  request: IpcRequest<C> | undefined,
): Promise<Result<IpcResponse<C>>> {
  const args = (request === undefined ? [] : [request]) as IpcRequestArgs<C>;
  return invoke(channel, ...args);
}

/**
 * §4.9 / §7.4 — subscribe to a push channel. Returns the unsubscribe function.
 *
 * ⚠️ A push event never focuses the window, never raises it, never animates a layout and never
 * opens a toast (§6.2 peripheral-vision rules). Everything downstream of this function is a
 * silent re-query and an in-place number update.
 */
export function subscribe<C extends PushChannel>(
  channel: C,
  listener: PushListener<C>,
): () => void {
  const surface = bridge();
  if (surface === undefined) return () => undefined;
  return surface.subscribe(channel, listener);
}

// ---------------------------------------------------------------------------
// Error presentation — the renderer branches on `code`, never on `message` (§4.1 rule 2)
// ---------------------------------------------------------------------------

/**
 * The one place an `ErrorCode` becomes an action. Views ask this instead of reading `message`,
 * which is why a wording change upstream can never change behaviour down here.
 */
export interface ErrorPresentation {
  /** Short label for the ErrorState heading. */
  title: string;
  /** What the user can do, if anything. `null` means the state is purely informational. */
  action: 'retry' | 'pick-directory' | 'open-settings' | 'open-pricing' | null;
}

const BY_CODE: Partial<Record<ErrorCode, ErrorPresentation>> = {
  E_NO_DIR: { title: 'No Claude directory selected', action: 'pick-directory' },
  E_DIR_NOT_FOUND: { title: 'That directory no longer exists', action: 'pick-directory' },
  E_DIR_INVALID: { title: 'That directory is not a Claude directory', action: 'pick-directory' },
  E_DIR_UNREADABLE: { title: 'That directory cannot be read', action: 'pick-directory' },
  E_SYNC_BUSY: { title: 'A full sync is already running', action: null },
  E_SYNC_CANCELLED: { title: 'Sync cancelled', action: 'retry' },
  E_SYNC_FAILED: { title: 'Sync failed', action: 'retry' },
  E_DB_BUSY: { title: 'The database is busy', action: 'retry' },
  E_DB_CORRUPT: { title: 'The database could not be read', action: null },
  E_DB_MIGRATION_FAILED: { title: 'The database could not be upgraded', action: null },
  E_PRICE_NOT_FOUND: { title: 'No matching price row', action: 'open-pricing' },
  E_FETCH_NO_URL: { title: 'No price-table URL configured', action: 'open-settings' },
  E_FETCH_NETWORK: { title: 'Could not reach the price table', action: 'retry' },
  E_FETCH_TIMEOUT: { title: 'The price table timed out', action: 'retry' },
  E_FETCH_HTTP: { title: 'The price table returned an error', action: 'retry' },
  E_FETCH_SHAPE: { title: 'The price table was not in the expected format', action: null },
};

/**
 * `retryable` comes from the payload and outranks the table: §4.1 rule 3 says a
 * `retryable: false` error must not be retried automatically, so the UI must not offer it
 * either. An unrecognised code still gets a usable state — never a blank one.
 */
export function presentError(error: AppError): ErrorPresentation {
  const known = BY_CODE[error.code];
  if (known === undefined) {
    return { title: 'Something went wrong', action: error.retryable ? 'retry' : null };
  }
  if (known.action === 'retry' && !error.retryable) return { title: known.title, action: null };
  return known;
}
