/**
 * §4.8 / §6.9 — the manual "Rescan" affordance shared by the Harness Manager and the Harness Map.
 *
 * ⚠️ Harness files change while the app is open, and §6.9's scan is a user-initiated hygiene
 * action — so both surfaces offer a Rescan button. The app also scans once, on its own, the first
 * time a dataset becomes ready (SM-1's `onReady`, wired in `src/main/index.ts`); this hook is the
 * *manual* path for everything after that.
 *
 * ⚠️ There is nothing to invalidate by hand here. `harness:scan` runs in the main process and, on
 * completion, emits `evt:dataChanged` with the `harness` and `bloat` scopes (`onScanned`). That
 * push both re-queries every harness surface (§7.4, `query-scopes.ts`) AND updates
 * `lastHarnessScanAt` in the store — so the button does not poke the cache, and the "last scanned"
 * time it shows is the same one the first-ready scan produces.
 */

import { useCallback, useState } from 'react';
import type { AppError } from '../../shared/ipc-contract';
import { invokeWith } from '../lib/ipc';
import { useAppStore } from '../store/app-store';

export interface HarnessScanState {
  /** Kicks off `harness:scan`. Safe to call again; a second click while busy is ignored. */
  rescan: () => void;
  /** A scan is in flight (this surface's button). */
  scanning: boolean;
  /** The last scan's error, or `null`. Cleared when a new scan starts. */
  error: AppError | null;
  /** When the harness was last scanned this session, or `null` if it has not been. */
  lastScannedAt: number | null;
}

export function useHarnessScan(): HarnessScanState {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const lastScannedAt = useAppStore((state) => state.lastHarnessScanAt);

  const rescan = useCallback(() => {
    // Re-entry is prevented at the button (`disabled={scanning}`), so this stays a plain effect
    // rather than a side-effecting state updater.
    setError(null);
    setScanning(true);
    void invokeWith('harness:scan', undefined).then((result) => {
      setScanning(false);
      // ⚠️ On success there is deliberately nothing to do: the main process's `evt:dataChanged`
      // (harness + bloat scopes) re-queries every surface and records the scan time. A failed
      // scan surfaces here without touching any number already on screen (CLAUDE.md §1).
      if (!result.ok) setError(result.error);
    });
  }, []);

  return { rescan, scanning, error, lastScannedAt };
}
