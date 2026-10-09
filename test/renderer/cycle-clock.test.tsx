/**
 * A-19 — **the clock that advances when a billing cycle ends** (`use-cycle-clock.ts`).
 *
 * The app is left open for days, and the whole time filter hangs off this hook: an instant
 * captured once at mount goes stale the moment the anchor day's local midnight passes, leaving
 * every screen counting the cycle that closed under a control still calling it the current one —
 * totals that stopped moving, read as "I have spent nothing this month" (CLAUDE.md §1).
 *
 * ⚠️ **What this suite exists for is the re-arm.** A billing cycle is longer than `setTimeout`'s
 * signed 32-bit millisecond limit, so a distant boundary is waited for in capped hops and EVERY
 * hop has to arm the next one. A hop that fires without moving the reading it stores must still
 * re-arm; when the stored reading was a bare number, an unchanged one made the state update a
 * no-op, React bailed out, the effect never re-ran and the clock stopped for good.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { useCycleClock } from '../../src/renderer/hooks/use-cycle-clock';
import { currentBillingCycle } from '../../src/renderer/lib/billing-cycle';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** ⚠️ `setTimeout`'s signed 32-bit limit, mirrored from the hook: ~24.8 days. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** A fixed instant, so nothing here depends on when the suite runs. */
const NOW = Date.UTC(2026, 7, 20, 12);

function Probe({ anchorDay = 15 }: { anchorDay?: number }): JSX.Element {
  return <span data-testid="clock">{String(useCycleClock(anchorDay))}</span>;
}

function reading(): number {
  return Number(screen.getByTestId('clock').textContent);
}

describe('A-19 — the cycle clock re-arms itself', () => {
  /**
   * ⚠️ Timers are faked; `Date` is NOT, and `Date.now` is pinned separately. That is what makes
   * the timer fire at an instant where the clock reads exactly what the hook already stored —
   * the one case in which the old implementation stopped arming timers altogether.
   */
  it('⚠️ arms the next hop even when the reading it takes is identical to the last', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(Date, 'now').mockReturnValue(NOW);

    render(<Probe />);
    expect(reading()).toBe(NOW);
    // The boundary is a month away, so the first wait is a capped hop rather than the whole gap.
    expect(currentBillingCycle(15, NOW).to - NOW).toBeGreaterThan(MAX_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(MAX_TIMEOUT_MS);
    });

    // The hop fired, the clock read the same instant — and a timer is armed for the next hop.
    expect(reading()).toBe(NOW);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('follows the clock across the boundary and never invents an instant', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const closing = currentBillingCycle(15, NOW);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(closing.to - 1);

    render(<Probe />);
    expect(reading()).toBe(closing.to - 1);

    // One millisecond later the next cycle has opened; the handler re-READS the clock rather
    // than assuming how much time went by.
    clock.mockReturnValue(closing.to);
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(reading()).toBe(closing.to);
    expect(currentBillingCycle(15, reading()).from).toBe(closing.to);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('⚠️ arms no timer at all when a test injects the instant', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    function Injected(): JSX.Element {
      return <span data-testid="clock">{String(useCycleClock(15, NOW))}</span>;
    }
    render(<Injected />);
    expect(reading()).toBe(NOW);
    // A pinned test can never be overtaken by the machine's own time.
    expect(vi.getTimerCount()).toBe(0);
  });
});
