/**
 * §6.2 — "Sidebar (240 px, collapsible, sticky): app mark, `~/.claude` monospace subtitle
 * showing the configured directory's basename, the eight nav items … Active item gets a 3 px
 * violet→cyan bar plus a subtle glow. Footer shows sync status (`● synced` in `--ok`) and
 * `last parse <duration> · <dataset size>`."
 *
 * ⚠️ P-30 — full keyboard navigation. The nav is a real `<nav>` of real links, so Tab and
 * Shift-Tab already work; Arrow Up/Down are added on top for roving movement, which is what
 * "full keyboard nav for sidebar" means beyond the default.
 *
 * ⚠️ §6.2 onboarding — with `dirStatus = 'unset'` the sidebar renders **disabled**. The items
 * stay visible (so the shape of the app is legible before any data exists) but are
 * `aria-disabled` and unclickable. It is a state of the shell, not a ninth view.
 */

import type { JSX, KeyboardEvent } from 'react';
import { NavLink } from 'react-router';
import { NAV_ITEMS } from './nav';
import { APP_NAME } from '../../shared/version';
import { cx } from '../lib/cx';
import { formatMillis } from '../lib/format';
import { useAppStore } from '../store/app-store';
import { AppMark } from '../components/AppMark';
import { CollapseIcon } from '../components/icons';

export interface SidebarProps {
  /** §6.2 — `dirStatus === 'unset'`. */
  disabled: boolean;
}

/**
 * The basename of the configured directory (§6.2 subtitle). Computed with a string split
 * rather than `node:path`, which INV-16 forbids in the renderer — and which would be the wrong
 * tool anyway: this is a label, not a path operation.
 */
export function directoryBasename(claudeDir: string | null): string {
  if (claudeDir === null || claudeDir.length === 0) return 'no directory selected';
  const segments = claudeDir.split('/').filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? claudeDir;
}

function onNavKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const links = Array.from(event.currentTarget.querySelectorAll('a'));
  const index = links.indexOf(document.activeElement as HTMLAnchorElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
  links[(next + links.length) % links.length]?.focus();
}

export function Sidebar({ disabled }: SidebarProps): JSX.Element {
  const collapsed = useAppStore((state) => state.sidebarCollapsed);
  const setCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const claudeDir = useAppStore((state) => state.settings?.claudeDir ?? null);
  const sync = useAppStore((state) => state.sync);

  return (
    <aside
      data-testid="app-sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-disabled={disabled ? 'true' : 'false'}
      className={cx(
        'sticky top-0 flex h-full shrink-0 flex-col border-r border-border bg-bg-surface',
        'transition-[width] duration-view',
      )}
      style={{ width: collapsed ? 'var(--sidebar-collapsed-w)' : 'var(--sidebar-w)' }}
    >
      <div className="flex items-center gap-3 p-6 pb-4">
        {/* §6.2 — the app mark, the same aperture the macOS launcher icon draws (ADR-038).
            Collapsed, the wordmark beside it is gone and the mark stands alone, so that is
            exactly when it needs an accessible name; expanded, the wordmark already says it
            and a second announcement would be noise (P-30, FRONTEND §8). */}
        <AppMark label={collapsed ? APP_NAME : undefined} className="size-6 shrink-0" />
        {!collapsed && (
          <div className="min-w-0">
            <p className="truncate text-body font-semibold text-text-primary">{APP_NAME}</p>
            <p className="truncate font-mono text-micro text-text-faint">
              {directoryBasename(claudeDir)}
            </p>
          </div>
        )}
      </div>

      <nav
        aria-label="Views"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3"
        onKeyDown={onNavKeyDown}
      >
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.id}
            to={item.path}
            data-testid={`nav-${item.id}`}
            aria-disabled={disabled ? true : undefined}
            tabIndex={disabled ? -1 : undefined}
            onClick={
              disabled
                ? (event) => {
                    event.preventDefault();
                  }
                : undefined
            }
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              cx(
                'relative flex items-center gap-3 rounded-control px-3 py-2 text-body',
                'transition-colors duration-hover',
                disabled && 'pointer-events-none opacity-40',
                isActive && !disabled
                  ? 'bg-bg-surface-2 text-text-primary'
                  : 'text-text-muted hover:bg-bg-surface-2 hover:text-text-primary',
              )
            }
          >
            {({ isActive }) => (
              <>
                {/* §6.2 — the 3 px violet→cyan active bar, plus a subtle glow. Decorative:
                    `aria-current` (set by NavLink) is what conveys "active" (FRONTEND §8). */}
                {isActive && !disabled && (
                  <span
                    aria-hidden="true"
                    data-testid={`nav-${item.id}-active-bar`}
                    className="absolute inset-y-1 left-0 rounded-pill"
                    style={{
                      width: 'var(--nav-bar-w)',
                      background: 'var(--grad-violet-cyan)',
                      boxShadow: 'var(--glow)',
                    }}
                  />
                )}
                <item.Icon aria-hidden="true" className="shrink-0 text-h3" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <footer className="border-t border-border p-6 text-micro text-text-muted">
        <SyncStatus />
        {sync?.lastDurationMs != null && !collapsed && (
          <p className="mt-1">last parse {formatMillis(sync.lastDurationMs)}</p>
        )}
        <button
          type="button"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={collapsed}
          onClick={() => {
            void setCollapsed(!collapsed);
          }}
          className="mt-3 flex items-center gap-2 rounded-control px-2 py-1 text-text-muted transition-colors duration-hover hover:bg-bg-surface-2 hover:text-text-primary"
        >
          <CollapseIcon aria-hidden="true" />
          {!collapsed && <span>Collapse</span>}
        </button>
      </footer>
    </aside>
  );
}

/**
 * §6.2 — "`● synced` in `--ok`". The dot is a redundant cue; the **word** carries the state
 * (FRONTEND §8, §6.12: meaning is never carried by colour alone).
 */
function SyncStatus(): JSX.Element {
  const sync = useAppStore((state) => state.sync);
  const phase = sync?.phase ?? null;

  // ⚠️ No phase is invented. Before the first `sync:state` or `app:bootstrap` lands there is no
  // sync state, and the footer says exactly that rather than claiming "synced".
  const { label, colour } =
    phase === null
      ? { label: 'not synced yet', colour: 'var(--text-faint)' }
      : phase === 'idle'
        ? { label: 'synced', colour: 'var(--ok)' }
        : phase === 'failed'
          ? { label: 'sync failed', colour: 'var(--danger)' }
          : { label: phase, colour: 'var(--warn)' };

  return (
    <p
      data-testid="sync-status"
      data-phase={phase ?? 'unknown'}
      className="flex items-center gap-2"
    >
      <span aria-hidden="true" style={{ color: colour }}>
        ●
      </span>
      <span>{label}</span>
    </p>
  );
}
