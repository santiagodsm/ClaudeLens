/**
 * Shared harness for the six analytics-view suites.
 *
 * ⚠️ **Component tests only: the IPC layer is stubbed and no database is ever opened**
 * (STACK ADR-012 — the `renderer` project is jsdom + Testing Library). Every stub returns the
 * same `Result` envelope the preload produces (ADR-031), so a test can never observe a shape the
 * app cannot.
 *
 * The views are rendered directly rather than through `AppShell`, so the store is seeded here
 * with the state a booted shell would have put there (§7.4: sync, disclosures, filter, theme,
 * plus `settings`, `coverage` and `dirStatus`).
 */

import type { ReactElement } from 'react';
import type { RenderResult } from '@testing-library/react';
import type {
  DataCoverage,
  SettingsSnapshot,
  UncostedSummary,
} from '../../../src/shared/ipc-contract';
import { ALL_TIME_ALL_PROJECTS, useAppStore } from '../../../src/renderer/store/app-store';
import type { ChannelStubs, InstalledBridge } from '../harness';
import { DEFAULT_SETTINGS, IDLE_SYNC, installBridge, renderRouted, resetStore } from '../harness';

export { installBridge, resetStore, uninstallBridge } from '../harness';
export type { ChannelStubs, InstalledBridge } from '../harness';

/** A `Result` success, typed loosely because the stub table is keyed by channel name. */
export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

/** A retryable failure — the shape a `q:*` handler returns when the database is busy (§4.1). */
export const DB_BUSY = {
  ok: false as const,
  error: {
    code: 'E_DB_BUSY' as const,
    message: 'The database is busy.',
    detail: 'SQLITE_BUSY',
    retryable: true,
  },
};

export interface BootOptions {
  settings?: Partial<SettingsSnapshot>;
  coverage?: Partial<DataCoverage>;
}

const ZERO_COVERAGE: DataCoverage = {
  transcriptsFrom: null,
  transcriptsTo: null,
  promptsFrom: null,
  promptsTo: null,
  partialBefore: null,
  statsCacheDays: 0,
};

/**
 * Seeds the store as a booted shell would, and disables non-essential motion.
 *
 * P-31 — running with `reduceMotionOverride: 'reduce'` exercises the real reduced-motion path
 * AND removes the mid-flight `opacity: 0` an entrance animation legitimately puts on a card for
 * its first frame, which would otherwise make every assertion a race.
 */
export function bootStore(options: BootOptions = {}): void {
  useAppStore.setState({
    bootstrap: 'ready',
    dirStatus: 'valid',
    schemaVersion: 1,
    sync: IDLE_SYNC,
    filter: ALL_TIME_ALL_PROJECTS,
    settings: { ...DEFAULT_SETTINGS, claudeDir: '/sandbox/claude', ...options.settings },
    coverage: { ...ZERO_COVERAGE, ...options.coverage },
    reduceMotion: 'reduce',
    theme: 'system',
  });
}

/** Install the bridge, seed the store, render inside a router. One call per test. */
export function renderView(
  ui: ReactElement,
  stubs: ChannelStubs,
  options: BootOptions = {},
): { bridge: InstalledBridge; view: RenderResult } {
  const bridge = installBridge(stubs);
  bootStore(options);
  return { bridge, view: renderRouted(ui) };
}

/** Puts the store back to its declared launch state between tests. */
export function resetAll(): void {
  resetStore();
}

export const NO_UNCOSTED: UncostedSummary = { records: 0, byModel: [] };
