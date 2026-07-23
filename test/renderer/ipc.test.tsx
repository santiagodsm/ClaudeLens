/**
 * The IPC seam (§4.1, §7.4, ADR-031) and the `useQuery` hook every view gets its four states
 * from (§6.12).
 *
 * ⚠️ The load-bearing assertion in this file: **a missing handler surfaces as an error, never
 * as zeroes or fabricated data.** No `q:*` handler exists yet, so this is the app's actual
 * behaviour today, not a hypothetical.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { AppError, OverviewTiles } from '../../src/shared/ipc-contract';
import { invoke, presentError, subscribe } from '../../src/renderer/lib/ipc';
import { stableStringify, useQuery } from '../../src/renderer/hooks/use-query';
import { entranceProps } from '../../src/renderer/lib/motion';
import { resolveTheme } from '../../src/renderer/hooks/use-theme';
import { ALL_TIME_ALL_PROJECTS, useAppStore } from '../../src/renderer/store/app-store';
import { installBridge, resetStore, uninstallBridge } from './harness';

const TILES: OverviewTiles = {
  outputTokens: 1_200_000,
  costNanoUsd: null,
  activeSeconds: 77_820,
  toolCalls: 4_210,
  sessions: 61,
  cacheReadTokens: 9_000_000,
  distinctTools: 17,
  uncosted: { records: 12, byModel: [] },
  overlapSeconds: 0,
};

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetStore();
});

describe('invoke — no exception ever crosses the boundary (ADR-031)', () => {
  it('resolves to an AppError when the bridge is absent', async () => {
    uninstallBridge();
    const result = await invoke('q:overviewTiles', ALL_TIME_ALL_PROJECTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_INTERNAL');
    expect(result.error.retryable).toBe(false);
  });

  it('resolves to an AppError when no handler is registered', async () => {
    installBridge({});
    const result = await invoke('q:overviewTiles', ALL_TIME_ALL_PROJECTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_INTERNAL');
  });

  it('returns the payload untouched on success', async () => {
    installBridge({ 'q:overviewTiles': () => ({ ok: true, data: TILES }) });
    const result = await invoke('q:overviewTiles', ALL_TIME_ALL_PROJECTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(TILES);
  });

  it('subscribe is a no-op rather than a throw when the bridge is absent', () => {
    uninstallBridge();
    const unsubscribe = subscribe('evt:sync', () => undefined);
    expect(() => {
      unsubscribe();
    }).not.toThrow();
  });
});

describe('presentError — the renderer branches on code, never on message (§4.1 rule 2)', () => {
  it('maps a code to a title and an action without reading the message', () => {
    const a: AppError = { code: 'E_NO_DIR', message: 'anything at all', retryable: false };
    const b: AppError = {
      code: 'E_NO_DIR',
      message: 'something completely different',
      retryable: false,
    };
    expect(presentError(a)).toEqual(presentError(b));
    expect(presentError(a).action).toBe('pick-directory');
  });

  it('never offers retry for a non-retryable error (§4.1 rule 3)', () => {
    const notRetryable: AppError = { code: 'E_SYNC_FAILED', message: 'x', retryable: false };
    expect(presentError(notRetryable).action).toBeNull();

    const retryable: AppError = { code: 'E_SYNC_FAILED', message: 'x', retryable: true };
    expect(presentError(retryable).action).toBe('retry');
  });

  it('still produces a usable state for an unmapped code', () => {
    const unknown: AppError = { code: 'E_ARCHIVE_COLLISION', message: 'x', retryable: false };
    expect(presentError(unknown).title).toBe('Something went wrong');
  });
});

describe('stableStringify — the (channel, args) key of §7.4', () => {
  it('is insensitive to key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('distinguishes different values, and treats void as an empty key', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    expect(stableStringify(undefined)).toBe('');
  });
});

describe('useQuery — the four states (§6.12)', () => {
  it('starts loading, then surfaces data', async () => {
    installBridge({ 'q:overviewTiles': () => ({ ok: true, data: TILES }) });
    const { result } = renderHook(() => useQuery('q:overviewTiles', ALL_TIME_ALL_PROJECTS));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toEqual(TILES);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a missing handler as an error and NEVER as zeroes', async () => {
    installBridge({});
    const { result } = renderHook(() => useQuery('q:overviewTiles', ALL_TIME_ALL_PROJECTS));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error?.code).toBe('E_INTERNAL');
    // ⚠️ The whole point: no substituted payload, no zero-filled tiles.
    expect(result.current.data).toBeNull();
  });

  it('does not fire while disabled', async () => {
    const bridge = installBridge({ 'q:overviewTiles': () => ({ ok: true, data: TILES }) });
    const { result } = renderHook(() =>
      useQuery('q:overviewTiles', ALL_TIME_ALL_PROJECTS, { enabled: false }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(bridge.calls).toHaveLength(0);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('re-queries only when a scope it depends on changes (§7.4)', async () => {
    const bridge = installBridge({ 'q:overviewTiles': () => ({ ok: true, data: TILES }) });
    const { result } = renderHook(() => useQuery('q:overviewTiles', ALL_TIME_ALL_PROJECTS));
    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });
    expect(bridge.calls).toHaveLength(1);

    // `q:overviewTiles` does not depend on the `harness` scope.
    act(() => {
      useAppStore.getState().applyDataChanged(['harness']);
    });
    expect(bridge.calls).toHaveLength(1);

    // …but it does depend on `events`.
    act(() => {
      useAppStore.getState().applyDataChanged(['events']);
    });
    await waitFor(() => {
      expect(bridge.calls).toHaveLength(2);
    });
  });

  it('keeps the previous payload on screen while refreshing in place (§6.2)', async () => {
    installBridge({ 'q:overviewTiles': () => ({ ok: true, data: TILES }) });
    const { result } = renderHook(() => useQuery('q:overviewTiles', ALL_TIME_ALL_PROJECTS));
    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    act(() => {
      useAppStore.getState().applyDataChanged(['events']);
    });
    // The instant after invalidation: loading is true AND the old numbers are still there.
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual(TILES);
  });

  it('drops stale data when a query fails rather than leaving it unowned', async () => {
    let fail = false;
    installBridge({
      'q:overviewTiles': () =>
        fail
          ? { ok: false, error: { code: 'E_DB_BUSY', message: 'busy', retryable: true } }
          : { ok: true, data: TILES },
    });
    const { result } = renderHook(() => useQuery('q:overviewTiles', ALL_TIME_ALL_PROJECTS));
    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    fail = true;
    act(() => {
      useAppStore.getState().applyDataChanged(['events']);
    });
    await waitFor(() => {
      expect(result.current.error?.code).toBe('E_DB_BUSY');
    });
    expect(result.current.data).toBeNull();
  });
});

describe('store — §7.4 holds only sync, disclosures, filter and theme', () => {
  it('hydrates from app:bootstrap and holds no domain rows', async () => {
    installBridge({
      'app:bootstrap': () => ({
        ok: true,
        data: {
          schemaVersion: 3,
          settings: {
            claudeDir: '/sandbox/claude',
            idleGapMinutes: 20,
            theme: 'dark' as const,
            priceFetchUrl: '',
            archiveRoot: null,
            lastGlobalFilter: { projectIds: [4], from: 100, to: 200 },
            sidebarCollapsed: true,
            reduceMotionOverride: 'full' as const,
          },
          dirStatus: 'valid' as const,
          sync: {
            phase: 'idle' as const,
            kind: null,
            startedAt: null,
            filesTotal: 0,
            filesDone: 0,
            recordsIngested: 0,
            badLines: 0,
            queuedRescan: false,
            lastCompletedAt: 1_800_000_000_000,
            lastDurationMs: 840,
            error: null,
          },
          coverage: {
            transcriptsFrom: null,
            transcriptsTo: null,
            promptsFrom: null,
            promptsTo: null,
            partialBefore: null,
            statsCacheDays: 0,
          },
          disclosures: {
            uncosted: { records: 7, byModel: [] },
            badLines: 2,
            syntheticEvents: 0,
            unlinkedSubagentRuns: 1,
            partialBefore: null,
            filesMissingSinceLastSync: 0,
            activeOverlapSeconds: 0,
          },
        },
      }),
    });

    await act(async () => {
      await useAppStore.getState().runBootstrap();
    });

    const state = useAppStore.getState();
    expect(state.bootstrap).toBe('ready');
    expect(state.theme).toBe('dark');
    expect(state.reduceMotion).toBe('full');
    expect(state.sidebarCollapsed).toBe(true);
    expect(state.filter).toEqual({ projectIds: [4], from: 100, to: 200 });
    expect(state.disclosures?.uncosted.records).toBe(7);

    // §7.4 — nothing resembling a result set is stored.
    expect(Object.keys(state)).not.toContain('rows');
    expect(Object.keys(state)).not.toContain('sessions');
    expect(Object.keys(state)).not.toContain('projects');
  });

  it('reports a failed bootstrap rather than assuming an empty dataset', async () => {
    installBridge({});
    await act(async () => {
      await useAppStore.getState().runBootstrap();
    });
    const state = useAppStore.getState();
    expect(state.bootstrap).toBe('error');
    expect(state.bootstrapError?.code).toBe('E_INTERNAL');
    expect(state.settings).toBeNull();
    expect(state.sync).toBeNull();
  });
});

describe('motion and theme resolution (FRONTEND §7, P-31)', () => {
  it('disables entrance animation entirely when motion is off', () => {
    expect(entranceProps(0, true)).toEqual({ initial: false });
  });

  it('staggers series by ~40 ms when motion is on', () => {
    const first = entranceProps(0, false);
    const third = entranceProps(2, false);
    expect(first.transition?.delay).toBe(0);
    expect(third.transition?.delay).toBeCloseTo(0.08, 5); // 2 × 40 ms
    expect(first.transition?.duration).toBeCloseTo(0.5, 5); // 400–600 ms band
    expect(first.initial).toEqual({ opacity: 0, y: 8 }); // 8 px slide
  });

  it('resolves the theme preference against the system setting', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});
