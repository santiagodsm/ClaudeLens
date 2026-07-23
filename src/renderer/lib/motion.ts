/**
 * Motion (FRONTEND §7, §6.12, P-31).
 *
 * The numbers below mirror the `--dur-*` / `--slide-view` tokens in `tokens.css`. They are
 * duplicated as JS numbers because Framer Motion takes numbers, not CSS custom properties;
 * `tokens.css` remains the statement of record and this file cites it. Nothing else in
 * `src/renderer/**` may name a duration.
 *
 * ⚠️ Two rules, both from §6.2 / §1.3 moment 2, and both testable:
 *   · **Entrance animations run on first mount only.** A live data update never re-animates a
 *     chart, and no push event triggers a layout animation.
 *   · **The Refresh spinner is the only thing that moves while idle.**
 */

import { useMotionDisabled } from '../hooks/use-theme';

/** FRONTEND §7 — "View transition: 200ms fade+slide (8px)." */
export const VIEW_DURATION_MS = 200;
export const VIEW_SLIDE = 8;

/** FRONTEND §7 — "Chart entrance: 400–600ms ease-out, stagger series ~40ms." */
export const CHART_DURATION_MS = 500;
export const SERIES_STAGGER_MS = 40;

/** FRONTEND §7 — "Hover: 120ms." / "Drawer: 240ms slide." */
export const HOVER_DURATION_MS = 120;
export const DRAWER_DURATION_MS = 240;

/** FRONTEND §7 — ease-out for every entrance. */
export const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const MS_PER_SECOND = 1000;

/** Framer Motion works in seconds. */
export function seconds(ms: number): number {
  return ms / MS_PER_SECOND;
}

/** The props of one entrance animation. `initial: false` means "mount at rest, do not move". */
export interface EntranceProps {
  initial?: { opacity: number; y: number } | false;
  animate?: { opacity: number; y: number };
  transition?: { duration: number; ease: [number, number, number, number]; delay: number };
}

/**
 * §6.12 — "**Entrance animations run on first mount only** — a live data update never
 * re-animates a chart."
 *
 * That property comes from Framer Motion's own semantics rather than from a first-render flag:
 * `initial` is the state the element is *mounted* in, and the `initial → animate` transition
 * runs once, at mount. Re-rendering with new data does not re-run it, because neither `initial`
 * nor the `animate` target changes. The rule is therefore satisfied by **not keying a card on
 * its data** — never remount a chart when its numbers change — which is why `ChartCard`,
 * `StatTile` and `ViewShell` take no `key` derived from a payload.
 *
 * Pure, and exported so the P-31 half is testable without rendering anything.
 */
export function entranceProps(index: number, motionDisabled: boolean): EntranceProps {
  if (motionDisabled) return { initial: false };
  return {
    initial: { opacity: 0, y: VIEW_SLIDE },
    animate: { opacity: 1, y: 0 },
    transition: {
      duration: seconds(CHART_DURATION_MS),
      ease: EASE_OUT,
      delay: seconds(index * SERIES_STAGGER_MS),
    },
  };
}

/** The entrance for a card or tile. `index` produces the ~40 ms stagger of FRONTEND §7. */
export function useEntrance(index = 0): EntranceProps {
  return entranceProps(index, useMotionDisabled());
}

/** FRONTEND §7 — the 200 ms fade + 8 px slide applied on every view change. */
export function useViewTransition(): EntranceProps {
  const disabled = useMotionDisabled();
  if (disabled) return { initial: false };
  return {
    initial: { opacity: 0, y: VIEW_SLIDE },
    animate: { opacity: 1, y: 0 },
    transition: { duration: seconds(VIEW_DURATION_MS), ease: EASE_OUT, delay: 0 },
  };
}
