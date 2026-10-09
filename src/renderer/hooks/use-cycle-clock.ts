/**
 * A-19 — **the clock that advances when a billing cycle ends, and at no other time.**
 *
 * ⚠️ **Why this is a hook and not a `Date.now()` in each caller.** The app is left open for days.
 * An instant captured once at mount goes stale the moment local midnight of the anchor day
 * passes: the control at the top would still say "This billing cycle" while the filter sat on the
 * cycle that had closed, and totals that stopped moving read as "I have spent nothing this month"
 * — a wrong number with nothing broken (CLAUDE.md §1). That was A-18's F1 defect, fixed once on
 * the Overview; A-19 moves the same responsibility to the top bar, where the whole app's time
 * filter now hangs off it, and one implementation is what stops the two from disagreeing.
 *
 * ⚠️ A single timeout, armed at the current cycle's exclusive end and re-armed from each new
 * reading. **No polling** and no wall-clock read during render (`react-hooks/purity`) — the first
 * reading is a lazy initializer. Firing early (see the cap) or late (a suspended machine) is
 * equally harmless: the handler re-reads the clock and the cycle is re-resolved from what it
 * finds, never from an assumption about how much time passed.
 */

import { useEffect, useState } from 'react';
import { currentBillingCycle } from '../lib/billing-cycle';

/**
 * ⚠️ `setTimeout` cannot hold a delay longer than a signed 32-bit millisecond count (~24.8 days)
 * and a billing cycle is longer than that: an uncapped delay overflows and fires **immediately**,
 * which would turn this into a spin. A distant boundary is therefore waited for in capped hops.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * @param anchorDay the day of the month the user's bill lands (§3.13 `billingCycleDay`).
 * @param injected  a fixed instant, supplied only by tests. ⚠️ When present the live clock is
 *                  never read and no timer is armed, so a pinned test cannot be overtaken by the
 *                  machine's own time.
 */
export function useCycleClock(anchorDay: number, injected?: number): number {
  /**
   * ⚠️ **A reading is `{ at, reading }` and not a bare number, so that taking the SAME reading
   * twice still re-arms the timer.** With a bare number, a timer that fired at an instant where
   * `Date.now()` equalled the stored value made `setClock` a no-op: React bailed out, the effect
   * did not re-run, and no new timer was ever armed — the clock stopped, permanently, and every
   * later cycle boundary passed unnoticed while the app went on filtering to a closed cycle
   * (CLAUDE.md §1). Unreachable in practice — the first arm is a whole cycle away and each
   * capped hop is ~24.8 days — but "unreachable" is not a property this file can promise, and
   * the cost of closing it is one counter.
   *
   * ⚠️ The counter never touches `at`: what is returned is still the instant the clock was
   * actually read, never a fabricated or nudged one (§1: never default a timestamp to "now").
   */
  const [clock, setClock] = useState<{ at: number; reading: number }>(() => ({
    at: Date.now(),
    reading: 0,
  }));
  const at = injected ?? clock.at;
  const endsAt = currentBillingCycle(anchorDay, at).to;

  useEffect(() => {
    if (injected !== undefined) return undefined;
    const delay = Math.min(Math.max(endsAt - clock.at, 0), MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      setClock((previous) => ({ at: Date.now(), reading: previous.reading + 1 }));
    }, delay);
    return () => {
      clearTimeout(timer);
    };
    // ⚠️ `clock` by identity, not `clock.at` by value: the identity changes on every reading,
    // which is what guarantees the re-arm above.
  }, [injected, clock, endsAt]);

  return at;
}
