/**
 * §6.2 — the shell, always present. Sidebar + top bar + a 12-column content area, max-width
 * 1480 px, centred, 24 px gutter, `overflow-y: auto`. ⚠️ Exception: the Graphs view (§6.7) is a
 * full-bleed canvas and drops the width cap to use the whole area, so wide graphs render larger.
 *
 * The shell decides which of four things occupies the content area, in this order:
 *   1. **FATAL** (§6.11) — replaces the whole content area. There is no "reset the database"
 *      button, because that path would take `price_rows` and `audit_log` with it (ADR-026).
 *   2. **Bootstrap error** — an ErrorState with retry. Never an app that assumes empty.
 *   3. **Onboarding** (`dirStatus === 'unset'`) — a state of the shell, not a ninth view.
 *   4. The routed view.
 *
 * ⚠️ Peripheral-vision rules (§6.2, §1.3 moment 2), all testable:
 *   · the window never takes focus — nothing here calls `focus()` or sets `autoFocus`;
 *   · no push event triggers a layout animation — push events land in the store and change
 *     numbers in place; the only `motion` component in the shell is the per-view transition,
 *     which runs on navigation, never on data;
 *   · the Refresh spinner is the only thing that moves while idle;
 *   · no toast, no modal, no sound ever appears unbidden — there is no toast host in this tree
 *     and no `alert`, `confirm` or `Notification` anywhere in `src/renderer/**`.
 */

import { useEffect } from 'react';
import type { JSX } from 'react';
import { Outlet, useLocation } from 'react-router';
import { cx } from '../lib/cx';
import { subscribeToPushEvents, useAppStore } from '../store/app-store';
import { useThemeRoot } from '../hooks/use-theme';
import { titleForPath } from './nav';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { Onboarding } from './Onboarding';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';

export function AppShell(): JSX.Element {
  const location = useLocation();
  // §6.7 — the Graphs view is a **full-bleed canvas**, so it uses the whole content width
  // instead of the §6.2 1480 px reading-column cap. Every other view stays capped and centred.
  const isGraphs = location.pathname.startsWith('/graphs');
  const dirStatus = useAppStore((state) => state.dirStatus);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const bootstrapError = useAppStore((state) => state.bootstrapError);
  const fatal = useAppStore((state) => state.fatal);
  const runBootstrap = useAppStore((state) => state.runBootstrap);

  useThemeRoot();

  useEffect(() => {
    void runBootstrap();
    return subscribeToPushEvents();
  }, [runBootstrap]);

  const onboarding = dirStatus === 'unset';

  return (
    <div data-testid="app-shell" data-dir-status={dirStatus} className="flex h-full min-h-0">
      <Sidebar disabled={onboarding} />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={titleForPath(location.pathname)} disabled={onboarding} />

        <main
          data-testid="app-content"
          className={cx('min-h-0 flex-1 overflow-y-auto')}
          style={{ padding: 'var(--grid-gutter)' }}
        >
          <div
            className="mx-auto grid w-full grid-cols-12"
            style={{
              maxWidth: isGraphs ? 'none' : 'var(--content-max-w)',
              gap: 'var(--grid-gutter)',
            }}
          >
            {fatal !== null ? (
              <FatalSurface />
            ) : bootstrap === 'error' && bootstrapError !== null ? (
              <ErrorState
                error={bootstrapError}
                onRetry={() => {
                  void runBootstrap();
                }}
                className="col-span-12"
                data-testid="bootstrap-error"
              />
            ) : bootstrap === 'loading' || bootstrap === 'idle' ? (
              <LoadingState className="col-span-12" label="Starting Claude Lens" />
            ) : onboarding ? (
              <Onboarding />
            ) : (
              <Outlet />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * §6.11 — the blocking surface. "What failed, the schema version, and two explicit choices —
 * **Rebuild derived data** and **Show my price rows**."
 *
 * ⚠️ The two buttons are inert here: the channels they need (a rebuild action and the pricing
 * list surface) are E10/E12 work. They are rendered disabled with the reason stated, rather
 * than omitted, because a blocking screen that offers no route out is worse than one that names
 * the route and says it is not wired yet. ⚠️ **There is no "reset the database" button** and one
 * must never be added (ADR-026).
 */
function FatalSurface(): JSX.Element {
  const fatal = useAppStore((state) => state.fatal);
  const schemaVersion = useAppStore((state) => state.schemaVersion);
  if (fatal === null) return <></>;

  return (
    <section
      data-testid="fatal-surface"
      role="alert"
      className="col-span-12 flex flex-col gap-4 rounded-card border border-border bg-bg-surface p-6 shadow-card"
    >
      <h2 className="text-h2 font-semibold text-text-primary">Claude Lens cannot continue</h2>
      <p className="text-body text-text-muted">{fatal.message}</p>
      <p className="font-mono text-small text-text-faint">
        {fatal.code} · schema version {schemaVersion === null ? 'unknown' : String(schemaVersion)}
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled
          title="Lands with the guarded-action catalogue (E10)."
          className="rounded-control border border-border px-3 py-2 text-small text-text-muted disabled:opacity-60"
        >
          Rebuild derived data
        </button>
        <button
          type="button"
          disabled
          title="Lands with the pricing surface (E12)."
          className="rounded-control border border-border px-3 py-2 text-small text-text-muted disabled:opacity-60"
        >
          Show my price rows
        </button>
      </div>
    </section>
  );
}
