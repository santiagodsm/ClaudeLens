/**
 * §6.2 — "Top bar (64 px, sticky, blurred): view title, global project filter, global
 * date-range filter, Refresh button (spinner + last-parsed time), theme toggle."
 *
 * ⚠️ **A-19 — the date-range filter IS the billing-cycle picker now, and the relative presets are
 * gone.** The user asked for it in as many words: "the de facto filter on all the pages should be
 * by billing cycle, so that I could choose another billing cycle or all. It should be a control at
 * the top, not only in Overview, and it affects all the pages" (2026-08-18). `Last 7 days` and
 * `Last 30 days` were removed by that decision, not by oversight. The control still writes the
 * ordinary §4.2 `from`/`to` of the global filter, so all eight views follow with no per-view work.
 *
 * ⚠️ Peripheral-vision rules (§6.2, §1.3 moment 2), all of which live here:
 *   · **The Refresh spinner is the only thing that moves while idle.** Nothing else in this bar
 *     animates except a 120 ms hover colour change.
 *   · **No toast, no modal, no sound, ever appears unbidden.** A failed refresh updates the
 *     sync state, which the sidebar footer shows. It does not pop anything.
 *   · **The window never takes focus** — nothing here calls `focus()`, and there is no
 *     `autoFocus` on any control.
 */

import { useEffect } from 'react';
import type { JSX } from 'react';
import { parseRangeChoice, rangeChoiceForCycle } from '../../shared/range-choice';
import {
  DEFAULT_BILLING_CYCLE_DAY,
  currentBillingCycle,
  currentCycleOptionLabel,
  cycleLabel,
  cyclesBetween,
  otherWindowOptionLabel,
  truncatedCyclesNote,
} from '../lib/billing-cycle';
import { cx } from '../lib/cx';
import { formatClock } from '../lib/format';
import { useAppStore } from '../store/app-store';
import { useCycleClock } from '../hooks/use-cycle-clock';
import { useResolvedTheme } from '../hooks/use-theme';
import { MoonIcon, RefreshIcon, SunIcon } from '../components/icons';
import { Spinner } from '../components/LoadingState';
import { ProjectFilter } from './ProjectFilter';

export interface TopBarProps {
  title: string;
  /** §6.2 — `dirStatus === 'unset'` renders the top bar disabled. */
  disabled: boolean;
  /**
   * A-19 — the instant the cycle list is built against. Optional and injected only by tests; the
   * shipped app reads the wall clock itself (below). ⚠️ It never reaches a query: the choice it
   * helps resolve becomes two fixed local midnights before anything downstream sees it, so no
   * query is ever parameterised by "now" (CLAUDE.md §1, ADR-021).
   */
  now?: number;
}

/** The one option that is not a billing cycle. */
const ALL_TIME_LABEL = 'All time';

/**
 * The value of the row that appears only while the app's date range came from somewhere other
 * than this control. It is not a `RangeChoice` — there is nothing to persist and nothing to
 * resolve — which is why it is a bare string the change handler refuses.
 */
const OTHER_VALUE = 'other';

export function TopBar({ title, disabled, now }: TopBarProps): JSX.Element {
  const filter = useAppStore((state) => state.filter);
  const setFilter = useAppStore((state) => state.setFilter);
  const setRangeChoice = useAppStore((state) => state.setRangeChoice);
  // A-19 — the picker's own selection, held beside the window it resolved to. `null` means the
  // window came from somewhere else and is shown as its real dates instead (see the store).
  const storedChoice = useAppStore((state) => state.rangeChoice);
  const refresh = useAppStore((state) => state.refresh);
  const sync = useAppStore((state) => state.sync);
  const setTheme = useAppStore((state) => state.setTheme);
  const theme = useResolvedTheme();
  // A-18/A-19 — the anchor day of the user's Claude bill, and the first instant the dataset
  // covers (M-16, delivered once by `app:bootstrap`). ⚠️ The list of cycles is built from these
  // two values and the clock; it costs NO query, which is why the picker cannot be a loading
  // state and cannot go stale relative to the numbers under it.
  const anchorDay = useAppStore(
    (state) => state.settings?.billingCycleDay ?? DEFAULT_BILLING_CYCLE_DAY,
  );
  const transcriptsFrom = useAppStore((state) => state.coverage?.transcriptsFrom ?? null);

  // ⚠️ **The clock the whole app's time filter now hangs off**, and the only reading of it in this
  // bar: it advances when the current cycle ends and at no other time (`useCycleClock`).
  const at = useCycleClock(anchorDay, now);
  const currentCycle = currentBillingCycle(anchorDay, at);
  const filterFrom = filter.from;
  const filterTo = filter.to;
  // ⚠️ An UNBOUNDED window is "All time" whoever set it — that reading needs no clock and no
  // stored choice, so a window nothing claims is still named correctly rather than as "other".
  // ⚠️ It wins over the stored choice as well: the two cannot disagree today, and if they ever
  // did, the window on screen is the fact and the stored word is the claim.
  const selected = filterFrom === null && filterTo === null ? 'all' : storedChoice;

  /**
   * ⚠️ **The rollover.** When the clock crosses into a new cycle and the selection is "this
   * billing cycle", the window has to move with it — otherwise every screen goes on counting the
   * cycle that closed at midnight while this control still calls it the current one, and totals
   * that stopped moving read as "I have spent nothing this month" (CLAUDE.md §1). Re-resolving the
   * SAME choice is what moves it; the equality check means it cannot loop, and a user parked on an
   * earlier cycle is untouched because their choice is not this one.
   */
  useEffect(() => {
    if (selected !== 'cycle:current') return;
    if (filterFrom === currentCycle.from && filterTo === currentCycle.to) return;
    setRangeChoice('cycle:current', at);
  }, [selected, filterFrom, filterTo, currentCycle.from, currentCycle.to, setRangeChoice, at]);

  // Every cycle the dataset reaches back to, newest first, plus what the cap left out (§4.6).
  const series = cyclesBetween(anchorDay, transcriptsFrom, at);
  // ⚠️ The current cycle is listed FIRST and by its own label, whether or not the dataset holds a
  // record in it: it is the app's default window and a picker that could not offer it would have
  // no way back from a chosen one. The rest follow in the series' own newest-first order.
  const earlier = series.cycles.filter((cycle) => cycle.from !== currentCycle.from);
  const truncatedNote = truncatedCyclesNote(series.truncated);

  const options: { value: string; label: string }[] = [
    { value: 'cycle:current', label: currentCycleOptionLabel(currentCycle) },
    ...earlier.map((cycle) => ({ value: rangeChoiceForCycle(cycle), label: cycleLabel(cycle) })),
    { value: 'all', label: ALL_TIME_LABEL },
  ];

  /**
   * ⚠️⚠️ **The held choice is re-validated against the list that was actually built, every
   * render, and this is a general rule rather than a patch for one case.** A `<select>` whose
   * `value` matches no `<option>` silently displays its FIRST one — so a choice that stops being
   * offerable makes this control describe a window the app is not filtered to, which is the one
   * thing the control must never do (CLAUDE.md §1a).
   *
   * It stops being offerable whenever the list is rebuilt around it: changing the billing day in
   * Settings moves every boundary, so a held `cycle:<date>` names a window that is no longer one
   * of this user's cycles, and the bar read "This billing cycle (Aug 03 – now)" over an app
   * filtered to Jul 15 – Aug 14. `'cycle:current'` and `'all'` are rebuilt with the list and
   * always match; only a specific past cycle can fall out of it.
   *
   * The honest rendering is the one this control already has for a window it did not set: the
   * real dates, named as dates.
   */
  const listed = selected !== null && options.some((option) => option.value === selected);
  if (!listed) {
    options.unshift({ value: OTHER_VALUE, label: otherWindowOptionLabel(filter.from, filter.to) });
  }

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
          {/* §1a — what this control does, in words, for a screen reader and for the label. */}
          <span className="sr-only">Which billing cycle to show</span>
          <select
            data-testid="cycle-filter"
            aria-label="Which billing cycle to show"
            disabled={disabled}
            value={listed && selected !== null ? selected : OTHER_VALUE}
            onChange={(event) => {
              const choice = parseRangeChoice(event.target.value);
              // Re-selecting the "some other dates" row is a no-op rather than a guess: it names
              // the window already in force, and there is nothing to resolve it to.
              if (choice === undefined) return;
              setRangeChoice(choice, at);
            }}
            className="rounded-control border border-border bg-bg-surface px-3 py-2 text-small text-text-primary"
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {/* §4.6 — the cap is reported where the shortened list is read, never applied in
              silence. It is a static line, so it cannot shift the bar's layout (§6.2). */}
          {truncatedNote !== null && (
            <span data-testid="cycle-filter-truncated" className="text-micro text-text-faint">
              {truncatedNote}
            </span>
          )}
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
