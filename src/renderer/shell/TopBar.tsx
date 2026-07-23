/**
 * §6.2 — "Top bar (64 px, sticky, blurred): view title, global project filter, global
 * date-range filter, Refresh button (spinner + last-parsed time), theme toggle."
 *
 * ⚠️ Peripheral-vision rules (§6.2, §1.3 moment 2), all of which live here:
 *   · **The Refresh spinner is the only thing that moves while idle.** Nothing else in this bar
 *     animates except a 120 ms hover colour change.
 *   · **No toast, no modal, no sound, ever appears unbidden.** A failed refresh updates the
 *     sync state, which the sidebar footer shows. It does not pop anything.
 *   · **The window never takes focus** — nothing here calls `focus()`, and there is no
 *     `autoFocus` on any control.
 */

import { useState } from 'react';
import type { JSX } from 'react';
import type { GlobalFilter } from '../../shared/ipc-contract';
import { cx } from '../lib/cx';
import { formatClock } from '../lib/format';
import { useAppStore } from '../store/app-store';
import { useResolvedTheme } from '../hooks/use-theme';
import { MoonIcon, RefreshIcon, SunIcon } from '../components/icons';
import { Spinner } from '../components/LoadingState';
import { ProjectFilter } from './ProjectFilter';

export interface TopBarProps {
  title: string;
  /** §6.2 — `dirStatus === 'unset'` renders the top bar disabled. */
  disabled: boolean;
}

const DAY_MS = 86_400_000;

/** §4.2 — `from` inclusive, `to` exclusive, both UTC epoch ms; `null` is unbounded. */
interface RangePreset {
  id: string;
  label: string;
  days: number | null;
}

const RANGE_PRESETS: readonly RangePreset[] = [
  { id: 'all', label: 'All time', days: null },
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: '90d', label: 'Last 90 days', days: 90 },
  { id: '365d', label: 'Last 12 months', days: 365 },
];

/**
 * ADR-021 — timestamps are UTC epoch ms and calendar bucketing happens in **local** time. A
 * "last 7 days" range therefore starts at local midnight seven days ago, not at `now - 7×24h`.
 */
export function rangeFor(preset: RangePreset, now: number): Pick<GlobalFilter, 'from' | 'to'> {
  if (preset.days === null) return { from: null, to: null };
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return {
    from: startOfToday.getTime() - (preset.days - 1) * DAY_MS,
    to: startOfToday.getTime() + DAY_MS,
  };
}

export function TopBar({ title, disabled }: TopBarProps): JSX.Element {
  const filter = useAppStore((state) => state.filter);
  const setFilter = useAppStore((state) => state.setFilter);
  const refresh = useAppStore((state) => state.refresh);
  const sync = useAppStore((state) => state.sync);
  const setTheme = useAppStore((state) => state.setTheme);
  const theme = useResolvedTheme();

  const [presetId, setPresetId] = useState('all');
  const syncing = sync !== null && sync.phase !== 'idle' && sync.phase !== 'failed';

  return (
    <header
      data-testid="app-topbar"
      data-disabled={disabled ? 'true' : 'false'}
      className={cx(
        'sticky top-0 z-20 flex shrink-0 items-center gap-4 border-b border-border px-6',
        'bg-bg-app/80 backdrop-blur-md',
        disabled && 'pointer-events-none opacity-40',
      )}
      style={{ height: 'var(--topbar-h)' }}
    >
      <h1 className="text-h3 font-semibold text-text-primary">{title}</h1>

      <div className="ml-auto flex items-center gap-3">
        <ProjectFilter
          disabled={disabled}
          selected={filter.projectIds}
          onChange={(projectIds) => {
            setFilter({ ...filter, projectIds });
          }}
        />

        <label className="flex items-center gap-2 text-small text-text-muted">
          <span className="sr-only">Date range</span>
          <select
            data-testid="date-range-filter"
            aria-label="Date range"
            disabled={disabled}
            value={presetId}
            onChange={(event) => {
              const preset =
                RANGE_PRESETS.find((candidate) => candidate.id === event.target.value) ??
                RANGE_PRESETS[0];
              if (preset === undefined) return;
              setPresetId(preset.id);
              setFilter({ ...filter, ...rangeFor(preset, Date.now()) });
            }}
            className="rounded-control border border-border bg-bg-surface px-3 py-2 text-small text-text-primary"
          >
            {RANGE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          data-testid="refresh-button"
          aria-label="Refresh"
          disabled={disabled}
          onClick={() => {
            void refresh();
          }}
          className="flex items-center gap-2 rounded-control border border-border px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
        >
          {/* The one moving thing while idle (§6.2) — and it only moves while a cycle runs. */}
          {syncing ? <Spinner /> : <RefreshIcon aria-hidden="true" />}
          <span className="text-text-muted">{formatClock(sync?.lastCompletedAt ?? null)}</span>
        </button>

        <button
          type="button"
          data-testid="theme-toggle"
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={() => {
            void setTheme(theme === 'dark' ? 'light' : 'dark');
          }}
          className="rounded-control border border-border p-2 text-text-muted transition-colors duration-hover hover:bg-bg-surface-2 hover:text-text-primary"
        >
          {theme === 'dark' ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
        </button>
      </div>
    </header>
  );
}
