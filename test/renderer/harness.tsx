/**
 * Component-test harness for the `renderer` Vitest project (STACK ADR-012).
 *
 * ⚠️ No fs, no db, no Electron. The only thing stubbed is `window.claudeLens` — the
 * contextBridge surface — and it is stubbed with the SAME `Result` envelope the preload
 * produces (ADR-031), so a test can never observe a shape the app cannot. In particular a stub
 * that "fails" returns `{ ok: false, error }`; it never rejects, because nothing across that
 * boundary ever does.
 */

import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type {
  AppBootstrap,
  AppError,
  IpcChannel,
  PushChannel,
  PushListener,
  Result,
  SettingsSnapshot,
  SyncState,
} from '../../src/shared/ipc-contract';
import type { ClaudeLensBridge } from '../../src/renderer/lib/ipc';
import { ALL_TIME_ALL_PROJECTS, useAppStore } from '../../src/renderer/store/app-store';

/** A channel stub: whatever it returns is what `invoke` resolves to. */
export type ChannelStubs = Partial<Record<IpcChannel, (request: unknown) => Result<unknown>>>;

export interface InstalledBridge {
  calls: { channel: string; request: unknown }[];
  emit: <C extends PushChannel>(channel: C, payload: unknown) => void;
}

/**
 * Installs a stub bridge. Any channel without a stub resolves to `E_INTERNAL` — exactly what
 * the real preload does for a channel with no registered handler, which is the state the whole
 * app is in until E8…E12 land their handlers.
 */
export function installBridge(stubs: ChannelStubs = {}): InstalledBridge {
  const calls: { channel: string; request: unknown }[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  const bridge = {
    version: '0.0.0-test',
    invoke: (channel: string, request?: unknown) => {
      calls.push({ channel, request });
      const stub = stubs[channel as IpcChannel];
      if (stub === undefined) {
        const error: AppError = {
          code: 'E_INTERNAL',
          message: 'That part of the app could not be reached.',
          detail: `no handler registered for '${channel}'`,
          retryable: false,
        };
        return Promise.resolve({ ok: false, error });
      }
      return Promise.resolve(stub(request));
    },
    subscribe: (channel: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
  };

  window.claudeLens = bridge as unknown as ClaudeLensBridge;

  return {
    calls,
    emit: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
  };
}

export function uninstallBridge(): void {
  delete window.claudeLens;
}

/** §3.13 defaults, as a whole snapshot, so a test never has to build a partial one. */
export const DEFAULT_SETTINGS: SettingsSnapshot = {
  claudeDir: null,
  idleGapMinutes: 15,
  theme: 'system',
  priceFetchUrl: '',
  archiveRoot: null,
  lastGlobalFilter: ALL_TIME_ALL_PROJECTS,
  sidebarCollapsed: false,
  reduceMotionOverride: 'system',
  retainOrphanedHistory: true,
  efficiencyDropThreshold: 0.4, // A-12
};

export const IDLE_SYNC: SyncState = {
  phase: 'idle',
  kind: null,
  startedAt: null,
  filesTotal: 0,
  filesDone: 0,
  recordsIngested: 0,
  badLines: 0,
  queuedRescan: false,
  lastCompletedAt: null,
  lastDurationMs: null,
  error: null,
};

/** A bootstrap payload for a configured, valid directory. */
export function bootstrapPayload(
  overrides: Partial<AppBootstrap> = {},
  settings: Partial<SettingsSnapshot> = {},
): AppBootstrap {
  return {
    schemaVersion: 1,
    settings: { ...DEFAULT_SETTINGS, claudeDir: '/sandbox/claude', ...settings },
    dirStatus: 'valid',
    sync: IDLE_SYNC,
    coverage: {
      transcriptsFrom: null,
      transcriptsTo: null,
      promptsFrom: null,
      promptsTo: null,
      partialBefore: null,
      statsCacheDays: 0,
    },
    disclosures: {
      uncosted: { records: 0, byModel: [] },
      badLines: 0,
      syntheticEvents: 0,
      unlinkedSubagentRuns: 0,
      partialBefore: null,
      filesMissingSinceLastSync: 0,
      activeOverlapSeconds: 0,
      // A-05 — a booted shell with nothing to disclose. Non-zero cases are driven per test.
      cacheSplitUnknownEvents: 0,
      cacheSplitArchivedEvents: 0,
      cacheSplitMismatches: 0,
      retainedOrphanSessions: 0,
      retainedOrphanEvents: 0,
    },
    ...overrides,
  };
}

/** Puts the Zustand store back to its declared launch state between tests (§7.4). */
export function resetStore(): void {
  useAppStore.setState({
    sync: null,
    disclosures: null,
    filter: ALL_TIME_ALL_PROJECTS,
    theme: 'system',
    reduceMotion: 'system',
    sidebarCollapsed: false,
    settings: null,
    dirStatus: 'unset',
    coverage: null,
    schemaVersion: null,
    fatal: null,
    bootstrap: 'idle',
    bootstrapError: null,
    epochs: {
      events: 0,
      sessions: 0,
      projects: 0,
      tools: 0,
      prompts: 0,
      harness: 0,
      bloat: 0,
    },
  });
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-motion');
}

/** Renders inside a `MemoryRouter`, which is the only difference from the shipped tree. */
export function renderRouted(ui: ReactElement, initialPath = '/overview'): RenderResult {
  const Wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
  );
  return render(ui, { wrapper: Wrapper });
}

/** A push listener typed against the contract, for tests that assert on subscription shape. */
export type TypedListener<C extends PushChannel> = PushListener<C>;
