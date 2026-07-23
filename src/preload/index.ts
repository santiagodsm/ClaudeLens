// The contextBridge surface, and nothing else (STACK ADR-003, DESIGN §4 preamble).
//
// Runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Those three
// are set on the BrowserWindow in the main process; this file is written on the assumption
// that they hold, and it exposes nothing that would be dangerous if they did not: no module
// loader, no path, no fs handle, not `ipcRenderer` itself — only two closures over the typed
// channel map in `src/shared/ipc-contract.ts`.
//
// ⚠️ **No exception ever crosses the boundary** (ADR-031, §4.1). `ipcRenderer.invoke` rejects
// when the main side has no handler registered for a channel, and when a handler throws before
// `withResult()` can wrap it. Both are converted here into a `Result` with `code: 'E_INTERNAL'`,
// so the renderer's only two outcomes are `{ ok: true }` and `{ ok: false, error }` — it branches
// on `code`, never on `message` (§4.1 rule 2), and it never sees a rejected promise.
//
// That matters right now, not eventually: no `q:*` handler exists yet. A view calling one gets
// a real `AppError` and renders an ErrorState, which is the honest degradation. It must never
// get zeroes (CLAUDE.md §1).

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  AppError,
  IpcChannel,
  IpcInvoke,
  IpcRequestArgs,
  IpcResponse,
  PushChannel,
  PushListener,
  PushPayload,
  PushSubscribe,
  Result,
} from '../shared/ipc-contract';
import { APP_VERSION } from '../shared/version';

function describe(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

/**
 * One sentence, user-facing, never a stack trace (§4.1). `retryable: false`: a channel with no
 * handler does not acquire one by being called again, and §4.1 rule 3 forbids callers from
 * retrying a non-retryable error automatically.
 */
function bridgeFailure(channel: string, cause: unknown): AppError {
  return {
    code: 'E_INTERNAL',
    message: 'That part of the app could not be reached.',
    detail: `ipc invoke '${channel}' rejected: ${describe(cause)}`,
    retryable: false,
  };
}

/**
 * §4 preamble — the renderer-side call surface. Typed as `IpcInvoke`, so adding a channel to
 * `IpcChannels` and forgetting it here is impossible: the map is the single source and this is
 * one generic pass-through over it.
 *
 * The channel string is not checked against a runtime allowlist, because the contract is a
 * types-only module (it emits no runtime values by design) and a hand-maintained runtime copy
 * of the channel list is exactly the drift ADR-031 exists to prevent. The property is supplied
 * from the other end instead: the main process registers handlers for the contract's channels
 * and no others, so an unknown channel has no handler and resolves to the `E_INTERNAL` result
 * above rather than reaching anything.
 */
const invoke: IpcInvoke = async <C extends IpcChannel>(
  channel: C,
  ...request: IpcRequestArgs<C>
): Promise<Result<IpcResponse<C>>> => {
  try {
    return (await ipcRenderer.invoke(channel, ...request)) as Result<IpcResponse<C>>;
  } catch (cause) {
    return { ok: false, error: bridgeFailure(channel, cause) };
  }
};

/**
 * §4.9 / §7.4 — push only, no polling, no reconnection logic. The returned function
 * unsubscribes; the renderer calls it from a `useEffect` cleanup.
 *
 * ⚠️ The `IpcRendererEvent` is dropped deliberately. It carries `sender` and `ports`, which are
 * handles into Electron internals; the renderer's vocabulary is the payload and nothing else
 * (INV-16).
 */
const subscribe: PushSubscribe = <C extends PushChannel>(
  channel: C,
  listener: PushListener<C>,
): (() => void) => {
  const forward = (_event: IpcRendererEvent, payload: PushPayload<C>): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, forward);
  return () => {
    ipcRenderer.off(channel, forward);
  };
};

const api = {
  version: APP_VERSION,
  invoke,
  subscribe,
} as const;

export type ClaudeLensApi = typeof api;

contextBridge.exposeInMainWorld('claudeLens', api);
