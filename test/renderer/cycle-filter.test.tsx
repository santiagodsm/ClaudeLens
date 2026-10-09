/**
 * A-19 — **the billing-cycle picker at the top of the app** (§6.2, §3.13 `lastRangeChoice`).
 *
 * The user asked for it in as many words: "the de facto filter on all the pages should be by
 * billing cycle, so that I could choose another billing cycle or all. It should be a control at
 * the top, not only in Overview, and it affects all the pages" (2026-08-18).
 *
 * What this suite pins is the behaviour that would otherwise fail SILENTLY:
 *   · the list is built from the dataset's own first record — no query, so it cannot go stale;
 *   · choosing a cycle writes §4.2's `from`/`to` into the ONE global filter every view reads;
 *   · the CHOICE is what is persisted, never the two dates it resolved to (the stale-cycle trap);
 *   · **the rollover**: the app left open across the anchor day's midnight moves to the new cycle
 *     rather than sitting on the closed one under a label that still says "This billing cycle";
 *   · a window this control did not set is shown as its real dates, not as a cycle it is not.
 *
 * ⚠️ The expected windows come from `currentBillingCycle` rather than from literals: the boundary
 * arithmetic itself is proved against hand-computed values under a pinned zone in
 * `test/metrics/a18-billing-cycle.test.ts` (the `renderer` project runs on worker threads, where
 * a runtime `TZ` pin is not honoured), and what is under test here is the wiring.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { TopBar } from '../../src/renderer/shell/TopBar';
import { currentBillingCycle, cycleContaining } from '../../src/renderer/lib/billing-cycle';
import { formatDay } from '../../src/renderer/lib/format';
import { ALL_TIME_ALL_PROJECTS, useAppStore } from '../../src/renderer/store/app-store';
import type { SettingsSnapshot } from '../../src/shared/ipc-contract';
import type { RangeChoice } from '../../src/shared/range-choice';
import {
  DEFAULT_SETTINGS,
  IDLE_SYNC,
  installBridge,
  renderRouted,
  resetStore,
  uninstallBridge,
} from './harness';
import type { InstalledBridge } from './harness';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetStore();
});

/** A fixed instant, so no assertion depends on when the suite runs. */
const NOW = Date.UTC(2026, 7, 20, 12);
const CYCLE = currentBillingCycle(15, NOW);
/** The first record in the dataset — two cycles before the current one. */
const FIRST = Date.UTC(2026, 5, 20, 12);

interface Options {
  settings?: Partial<SettingsSnapshot>;
  transcriptsFrom?: number | null;
  filter?: { projectIds: number[] | null; from: number | null; to: number | null };
  /** The picker's selection, as `app:bootstrap` would have resolved and recorded it. */
  choice?: RangeChoice | null;
  /** ⚠️ `true` renders with NO injected instant — the shipped path, reading the (faked) clock. */
  live?: boolean;
}

function renderTopBar(options: Options = {}): InstalledBridge {
  const bridge = installBridge({
    'q:projectCards': () => ({
      ok: true,
      data: { rows: [], uncosted: { records: 0, byModel: [] } },
    }),
    'settings:set': () => ({ ok: true, data: DEFAULT_SETTINGS }),
  });
  useAppStore.setState({
    bootstrap: 'ready',
    dirStatus: 'valid',
    schemaVersion: 1,
    sync: IDLE_SYNC,
    filter: options.filter ?? ALL_TIME_ALL_PROJECTS,
    rangeChoice: options.choice === undefined ? null : options.choice,
    settings: { ...DEFAULT_SETTINGS, claudeDir: '/sandbox/claude', ...options.settings },
    coverage: {
      transcriptsFrom: options.transcriptsFrom === undefined ? FIRST : options.transcriptsFrom,
      transcriptsTo: NOW,
      promptsFrom: null,
      promptsTo: null,
      partialBefore: null,
      statsCacheDays: 0,
    },
    reduceMotion: 'reduce',
  });
  renderRouted(
    <TopBar title="Overview" disabled={false} now={options.live === true ? undefined : NOW} />,
  );
  return bridge;
}

function picker(): HTMLSelectElement {
  return screen.getByTestId('cycle-filter');
}

function optionValues(): string[] {
  return [...picker().options].map((option) => option.value);
}

/** Every `settings:set` write, in order, as `[key, value]`. */
function settingWrites(bridge: InstalledBridge): [string, unknown][] {
  return bridge.calls
    .filter((call) => call.channel === 'settings:set')
    .map((call) => {
      const request = call.request as { key: string; value: unknown };
      return [request.key, request.value];
    });
}

describe('A-19 — the cycle picker replaces the date-range presets', () => {
  it('lists this cycle, every earlier one with data, then all time — and nothing else', () => {
    renderTopBar();

    const previous = cycleContaining(15, CYCLE.from - 1);
    const oldest = cycleContaining(15, previous.from - 1);
    expect(optionValues()).toEqual([
      'cycle:current',
      `cycle:${String(previous.from)}`,
      `cycle:${String(oldest.from)}`,
      'all',
    ]);

    // ⚠️ The relative presets are gone by the user's own decision, not by accident.
    const labels = [...picker().options].map((option) => option.textContent ?? '');
    expect(labels[0]).toContain('This billing cycle');
    expect(labels.join(' ')).not.toContain('Last 7 days');
    expect(labels.join(' ')).not.toContain('Last 30 days');
    // The current cycle's label ends at "now": the rest of its window has not happened.
    expect(labels[0]).toContain('now');
  });

  it('⚠️ offers no cycle it has no data for, but always offers the current one', () => {
    // A dataset with nothing in it: `cyclesBetween` returns no cycles, and a picker listing ten
    // years of empty windows would be promising periods the data cannot speak for.
    renderTopBar({ transcriptsFrom: null });
    expect(optionValues()).toEqual(['cycle:current', 'all']);
  });

  it('sets the ONE global filter every view reads, keeping the project selection', async () => {
    renderTopBar({ filter: { projectIds: [7], from: null, to: null } });

    const previous = cycleContaining(15, CYCLE.from - 1);
    fireEvent.change(picker(), { target: { value: `cycle:${String(previous.from)}` } });

    await waitFor(() => {
      expect(useAppStore.getState().filter).toEqual({
        projectIds: [7], // untouched — the two selections are independent (§6.2)
        from: previous.from,
        to: previous.to,
      });
    });
  });

  it('⚠️ persists the CHOICE, never the two dates it resolved to', async () => {
    const bridge = renderTopBar();

    fireEvent.change(picker(), { target: { value: 'cycle:current' } });
    await waitFor(() => {
      expect(settingWrites(bridge)).toContainEqual(['lastRangeChoice', 'cycle:current']);
    });

    /**
     * ⚠️ This is the whole point of the setting. `lastGlobalFilter` stores absolute epoch ms, so
     * had "this billing cycle" been persisted as dates, the next launch after the anchor day
     * passed would reopen on the cycle that had CLOSED — under a control still calling it the
     * current one (CLAUDE.md §1). The stored value must therefore be the word, not the window.
     */
    const written = settingWrites(bridge).find(([key]) => key === 'lastRangeChoice');
    expect(written?.[1]).toBe('cycle:current');
    expect(String(written?.[1])).not.toContain(String(CYCLE.from));
  });

  it('resolves a stored choice at launch, and falls back when it no longer names a cycle', () => {
    // ⚠️ Resolved against THIS launch's clock, in the store's own bootstrap path.
    const previous = cycleContaining(15, CYCLE.from - 1);
    renderTopBar({
      filter: { projectIds: null, from: previous.from, to: previous.to },
      choice: `cycle:${String(previous.from)}` as RangeChoice,
    });
    expect(picker().value).toBe(`cycle:${String(previous.from)}`);

    // A window that is not one of this user's cycles is never labelled as one.
    cleanup();
    resetStore();
    renderTopBar({
      filter: { projectIds: null, from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 8) },
    });
    expect(picker().value).toBe('other');
    expect(optionValues()[0]).toBe('other');
    const other = [...picker().options][0]?.textContent ?? '';
    expect(other).not.toContain('billing cycle');
  });

  it('reports the cycles the cap left out rather than showing a shortened list', () => {
    // Ten years and a bit of data: more cycles than the cap keeps.
    renderTopBar({ transcriptsFrom: Date.UTC(2010, 0, 1) });
    expect(screen.getByTestId('cycle-filter-truncated')).toHaveTextContent(
      'older billing cycles are not shown',
    );
    // 120 cycles kept plus the "all time" row.
    expect(optionValues()).toHaveLength(121);
  });

  it('⚠️ moves to the new cycle when the app is left open across the anchor day', async () => {
    vi.useFakeTimers();
    try {
      const closing = currentBillingCycle(15, NOW);
      // One second before the anchor day's local midnight, with no injected instant: this is the
      // shipped path, reading the machine's own (faked) clock.
      vi.setSystemTime(closing.to - 1_000);
      renderTopBar({
        live: true,
        choice: 'cycle:current',
        filter: { projectIds: null, from: closing.from, to: closing.to },
      });
      expect(useAppStore.getState().filter.to).toBe(closing.to);

      // Midnight passes while nobody touches anything.
      await act(async () => {
        vi.advanceTimersByTime(1_000);
        await Promise.resolve();
      });

      // Half-open (§4.2): the next cycle opens exactly where this one closed, so the boundary
      // instant is the new `from`. Asserted rather than assumed.
      const opening = currentBillingCycle(15, closing.to);
      expect(opening.from).toBe(closing.to);
      expect(useAppStore.getState().filter).toEqual({
        projectIds: null,
        from: opening.from,
        to: opening.to,
      });
      // ⚠️ The frozen filter would still be the closed cycle, with the control saying "This
      // billing cycle" over totals that had stopped moving.
      expect(useAppStore.getState().filter.from).not.toBe(closing.from);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⚠️ does NOT move a chosen past cycle when the clock rolls over', async () => {
    vi.useFakeTimers();
    try {
      const closing = currentBillingCycle(15, NOW);
      const chosen = cycleContaining(15, closing.from - 1);
      vi.setSystemTime(closing.to - 1_000);
      renderTopBar({
        live: true,
        choice: `cycle:${String(chosen.from)}` as RangeChoice,
        filter: { projectIds: null, ...chosen },
      });

      await act(async () => {
        vi.advanceTimersByTime(1_000);
        await Promise.resolve();
      });

      // The user asked for THAT cycle. Advancing it would replace the numbers they are reading
      // with a different period's, silently.
      expect(useAppStore.getState().filter).toEqual({ projectIds: null, ...chosen });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ⚠️⚠️ **The held choice is re-validated against the list that was actually built.**
   *
   * A `<select>` whose `value` matches no `<option>` displays its FIRST one and says nothing. So
   * changing the billing day while a past cycle was chosen left the bar reading "This billing
   * cycle (Aug 03 – now)" over an app filtered to Jul 15 – Aug 14, with the view's own caption
   * correctly naming the second — two controls on one screen disagreeing, and the wrong one being
   * the one the user steers by (CLAUDE.md §1a).
   */
  it('⚠️ names the real window when the chosen cycle stops being one, after the day changes', () => {
    const chosen = cycleContaining(15, CYCLE.from - 1);
    renderTopBar({
      choice: `cycle:${String(chosen.from)}` as RangeChoice,
      filter: { projectIds: null, ...chosen },
    });
    expect(picker().value).toBe(`cycle:${String(chosen.from)}`);

    // The billing day moves in Settings. Every boundary moves with it, so the chosen window is
    // no longer one of this user's cycles and no row of the rebuilt list can name it.
    act(() => {
      useAppStore.setState({
        settings: { ...DEFAULT_SETTINGS, claudeDir: '/sandbox/claude', billingCycleDay: 3 },
      });
    });

    expect(optionValues()).not.toContain(`cycle:${String(chosen.from)}`);
    expect(picker().value).toBe('other');
    // The row that appears names the dates actually in force, and calls them nothing else.
    const shown = [...picker().options][0]?.textContent ?? '';
    expect(shown).toContain(formatDay(chosen.from));
    expect(shown).toContain(formatDay(chosen.to - 1));
    expect(shown).not.toContain('billing cycle');
    // ⚠️ And the window itself is untouched: the control describes the app, it does not steer it
    // sideways because a setting changed.
    expect(useAppStore.getState().filter).toEqual({ projectIds: null, ...chosen });
  });

  it('re-resolves "this billing cycle" against the new day rather than falling out of the list', async () => {
    renderTopBar({
      choice: 'cycle:current',
      filter: { projectIds: null, ...CYCLE },
    });

    act(() => {
      useAppStore.setState({
        settings: { ...DEFAULT_SETTINGS, claudeDir: '/sandbox/claude', billingCycleDay: 3 },
      });
    });

    const third = currentBillingCycle(3, NOW);
    await waitFor(() => {
      expect(useAppStore.getState().filter).toEqual({ projectIds: null, ...third });
    });
    expect(picker().value).toBe('cycle:current');
  });

  it('builds the list from the SETTING, not from a day baked into the control', () => {
    renderTopBar({ settings: { billingCycleDay: 3 } });
    const third = currentBillingCycle(3, NOW);
    expect(third).not.toEqual(CYCLE);

    fireEvent.change(picker(), { target: { value: 'cycle:current' } });
    expect(useAppStore.getState().filter).toEqual({
      projectIds: null,
      from: third.from,
      to: third.to,
    });
  });
});
