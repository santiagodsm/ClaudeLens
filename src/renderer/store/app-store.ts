/**
 * The Zustand store (§7.4, STACK ADR-004).
 *
 * ⚠️ **What this store is allowed to hold is a design decision, not a convenience.** §7.4:
 * "The renderer's Zustand store holds the last `SyncState`, the last `Disclosures` and the
 * global filter; everything else is query results keyed by `(channel, args)` and invalidated by
 * `evt:dataChanged` scopes."
 *
 * So: no rows, no aggregates, no domain objects, no client-side mirror of the database. What is
 * here beyond §7.4's three is the theme (§6.1) and the rest of `SettingsSnapshot`, which is the
 * USER persistence class (§3.13) rather than query results, plus the shell's own status fields
 * (`dirStatus`, `fatal`) that the §6.2 chrome and the §6.11 blocking surface are driven by.
 *
 * Query results live in `useQuery` (`hooks/use-query.ts`), which holds exactly one payload per
 * mounted caller and drops it on unmount. That is what keeps P-28 ("never the full dataset")
 * a structural property rather than a promise.
 */

import { create } from 'zustand';
import type {
  AppError,
  DataCoverage,
  DataScope,
  Disclosures,
  DirStatus,
  GlobalFilter,
  ReduceMotionPreference,
  SettingsSnapshot,
  SyncState,
  ThemePreference,
} from '../../shared/ipc-contract';
import { invoke, subscribe } from '../lib/ipc';

/** §4.2 — `null` everywhere means unbounded / all projects. The launch default. */
export const ALL_TIME_ALL_PROJECTS: GlobalFilter = { projectIds: null, from: null, to: null };

/** The bootstrap lifecycle, which the shell renders directly (§6.2, §6.12). */
export type BootstrapStatus = 'idle' | 'loading' | 'ready' | 'error';

/** One counter per scope. A query re-runs when any scope it depends on ticks (§4.9, §7.4). */
export type ScopeEpochs = Record<DataScope, number>;

const ZERO_EPOCHS: ScopeEpochs = {
  events: 0,
  sessions: 0,
  projects: 0,
  tools: 0,
  prompts: 0,
  harness: 0,
  bloat: 0,
};

export interface AppState {
  // ---- §7.4's permitted contents ----
  /** The last `SyncState` pushed on `evt:sync` (§4.9). */
  sync: SyncState | null;
  /** The last `Disclosures` (§4.6). Incompleteness is data, and it lives where views can see it. */
  disclosures: Disclosures | null;
  /** The top-bar `(project set, date range)` selection (§4.2, §6.2). */
  filter: GlobalFilter;
  /** §6.1 — applied as `data-theme` on the root element. */
  theme: ThemePreference;
  /** FRONTEND §7 / §3.13 — the `prefers-reduced-motion` override. */
  reduceMotion: ReduceMotionPreference;
  /** FRONTEND §4 / §3.13 — sidebar collapse, remembered across launches. */
  sidebarCollapsed: boolean;
  /**
   * The rest of the USER settings snapshot (§3.13): `claudeDir`, `archiveRoot`,
   * `idleGapMinutes`, `priceFetchUrl`. Held because §6.10 renders them; `null` until bootstrap.
   * The four fields above are hoisted out of it because §7.4 names theme and filter explicitly
   * and because the shell must be able to toggle them before a bootstrap has ever succeeded.
   */
  settings: SettingsSnapshot | null;

  // ---- Shell status (§6.2, §6.11) ----
  dirStatus: DirStatus;
  coverage: DataCoverage | null;
  schemaVersion: number | null;
  /** §6.11 — a FATAL replaces the whole content area. Never a toast (§6.2). */
  fatal: AppError | null;
  bootstrap: BootstrapStatus;
  bootstrapError: AppError | null;

  /** §7.4 — the invalidation signal `useQuery` watches. */
  epochs: ScopeEpochs;

  /**
   * §4.8 / §6.9 — when the harness was last scanned, as an epoch ms, or `null` when no scan has
   * completed this session. Captured from `evt:dataChanged`'s `at` whenever the `harness` scope
   * is present — which is emitted **only** by the scanner (`onScanned`), for both the first-ready
   * scan and a manual "Rescan". The Harness Manager and Harness Map render it as "last scanned".
   * ⚠️ Session-scoped and honest: it is when THIS app last scanned, not a stored claim; when
   * unknown the surfaces say so rather than inventing a time (CLAUDE.md §1).
   */
  lastHarnessScanAt: number | null;

  // ---- Actions ----
  runBootstrap: () => Promise<void>;
  setFilter: (filter: GlobalFilter) => void;
  setTheme: (theme: ThemePreference) => Promise<void>;
  setReduceMotion: (preference: ReduceMotionPreference) => Promise<void>;
  setSidebarCollapsed: (collapsed: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  /**
   * A-16 / §3.18 — throw away everything derived from transcripts and read them all again from
   * the beginning. Resolves to the refusal when the main process declined (nothing was deleted
   * and no cycle started), or `null` when the rebuild began.
   */
  rereadEverything: () => Promise<AppError | null>;
  /** Push-event sinks. Exported so the wiring is testable without an Electron window. */
  applySync: (sync: SyncState) => void;
  applyDataChanged: (scopes: DataScope[]) => void;
  /** §4.8 — record the moment a harness scan finished, from `evt:dataChanged`'s `at`. */
  applyHarnessScanned: (at: number) => void;
  applyDirStatus: (status: DirStatus) => void;
  applyFatal: (error: AppError) => void;
  applyDisclosures: (disclosures: Disclosures) => void;
}

export const useAppStore = create<AppState>()((set) => ({
  sync: null,
  disclosures: null,
  filter: ALL_TIME_ALL_PROJECTS,
  // §3.13 defaults, stated once here and replaced wholesale by the bootstrap snapshot.
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
  epochs: ZERO_EPOCHS,
  lastHarnessScanAt: null,

  runBootstrap: async () => {
    set({ bootstrap: 'loading', bootstrapError: null });
    const result = await invoke('app:bootstrap');
    if (!result.ok) {
      // ⚠️ No fallback snapshot, no assumed-empty dataset. A failed bootstrap is an
      // ErrorState; it is never an app that pretends to have zero of everything.
      set({ bootstrap: 'error', bootstrapError: result.error });
      return;
    }
    const data = result.data;
    set({
      bootstrap: 'ready',
      bootstrapError: null,
      schemaVersion: data.schemaVersion,
      settings: data.settings,
      dirStatus: data.dirStatus,
      sync: data.sync,
      coverage: data.coverage,
      disclosures: data.disclosures,
      theme: data.settings.theme,
      reduceMotion: data.settings.reduceMotionOverride,
      sidebarCollapsed: data.settings.sidebarCollapsed,
      // §3.13 `lastGlobalFilter` is "restored on launch; never written mid-interaction".
      filter: data.settings.lastGlobalFilter,
    });
  },

  setFilter: (filter) => {
    set({ filter });
    // §3.13 — persisted, but not awaited: the filter must apply to the next query immediately
    // and a settings write must never be able to make the UI wait.
    void invoke('settings:set', { key: 'lastGlobalFilter', value: filter });
  },

  // ⚠️ The three setters below apply the change to the store FIRST and persist afterwards.
  // The theme toggle in particular must flip `data-theme` in the same frame it is clicked,
  // and it must keep working when no main process is listening (a component test, or a
  // window opened before bootstrap resolved) — a chrome control that depends on a round trip
  // is a chrome control that hangs.
  setTheme: async (theme) => {
    set({ theme });
    await persistSetting('theme', theme, set);
  },

  setReduceMotion: async (preference) => {
    set({ reduceMotion: preference });
    await persistSetting('reduceMotionOverride', preference, set);
  },

  setSidebarCollapsed: async (collapsed) => {
    set({ sidebarCollapsed: collapsed });
    await persistSetting('sidebarCollapsed', collapsed, set);
  },

  refresh: async () => {
    const result = await invoke('sync:start', { kind: 'incremental' });
    if (result.ok) {
      set({ sync: result.data });
      return;
    }
    // §4.4 — `sync:start` while a cycle runs does not fail; a real failure is surfaced on the
    // sync state itself so the sidebar footer can show it, without a modal (§6.2).
    set((state) =>
      state.sync === null ? state : { sync: { ...state.sync, error: result.error } },
    );
  },

  rereadEverything: async () => {
    const result = await invoke('sync:rebuild');
    if (result.ok) {
      set({ sync: result.data });
      return null;
    }
    // ⚠️ Returned, not swallowed onto `SyncState.error` the way `refresh` does. A refusal here
    // means NOTHING happened — no row was deleted and no cycle started — and the card that asked
    // for it has to be able to say so where the user pressed the button (§6.10's error row),
    // rather than leaving a stale-looking sync footer as the only clue.
    return result.error;
  },

  applySync: (sync) => {
    // ⚠️ In-place update, no entrance animation, no focus, no toast (§6.2, §1.3 moment 2).
    set({ sync });
  },

  applyDataChanged: (scopes) => {
    set((state) => {
      const epochs = { ...state.epochs };
      for (const scope of scopes) epochs[scope] += 1;
      return { epochs };
    });
  },

  applyHarnessScanned: (at) => {
    set({ lastHarnessScanAt: at });
  },

  applyDirStatus: (status) => {
    set({ dirStatus: status });
  },

  applyFatal: (error) => {
    set({ fatal: error });
  },

  applyDisclosures: (disclosures) => {
    set({ disclosures });
  },
}));

type Setter = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;

/**
 * `settings:set` returns the full new snapshot (§4.3), which is what makes reconciliation a
 * replacement rather than a merge. A rejected write leaves the optimistic value in place for
 * this session only; it is not persisted, and `app:bootstrap` is authoritative next launch.
 * Nothing is invented either way.
 */
async function persistSetting<K extends keyof SettingsSnapshot>(
  key: K,
  value: SettingsSnapshot[K],
  set: Setter,
): Promise<void> {
  const result = await invoke('settings:set', { key, value });
  if (!result.ok) return;
  const snapshot = result.data;
  set({
    settings: snapshot,
    theme: snapshot.theme,
    reduceMotion: snapshot.reduceMotionOverride,
    sidebarCollapsed: snapshot.sidebarCollapsed,
  });
}

/**
 * §4.9 / §7.4 — wire every push channel to the store. Called once, from the app root.
 *
 * ⚠️ Every branch here is silent by construction: it updates state and nothing else. No focus,
 * no raise, no layout animation, no toast, no sound (§6.2 peripheral-vision rules).
 */
export function subscribeToPushEvents(): () => void {
  const store = useAppStore.getState();
  const unsubscribes = [
    subscribe('evt:sync', store.applySync),
    subscribe('evt:dataChanged', (payload) => {
      store.applyDataChanged(payload.scopes);
      // §4.8 — the `harness` scope is emitted only by a completed scan, and `at` is its scan time.
      // This is the one signal both the first-ready scan and a manual "Rescan" arrive on.
      if (payload.scopes.includes('harness')) store.applyHarnessScanned(payload.at);
    }),
    subscribe('evt:pricingChanged', () => {
      // Pricing is not a `DataScope`, but every `$` figure derives from it (§3.11).
      store.applyDataChanged(['events']);
    }),
    subscribe('evt:actionCompleted', () => {
      store.applyDataChanged(['harness', 'bloat']);
    }),
    subscribe('evt:dirStatus', store.applyDirStatus),
    subscribe('evt:fatal', store.applyFatal),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
