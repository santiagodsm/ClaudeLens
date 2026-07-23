/**
 * §6.1 / §6.2 — "Everything themable via a single `data-theme` switch" (FRONTEND §9), and
 * "the theme root carries `data-theme`" (§6.2 test hooks).
 *
 * `data-motion` is applied by the same hook, for the same reason: both are root attributes the
 * token layer keys off, and having one owner means there is exactly one place a stale attribute
 * could come from.
 */

import { useEffect } from 'react';
import type { ThemePreference } from '../../shared/ipc-contract';
import { useAppStore } from '../store/app-store';
import { PREFERS_DARK, PREFERS_REDUCED_MOTION, useMediaQuery } from './use-media-query';

/** The two values `data-theme` can ever take. `'system'` is a preference, not a theme. */
export type ResolvedTheme = 'dark' | 'light';

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  // FRONTEND §1 — "dark-first, light-aware". A system with no stated preference gets dark.
  return systemPrefersDark ? 'dark' : 'light';
}

/** The resolved theme, without any side effect. Components use this to pick a chart palette. */
export function useResolvedTheme(): ResolvedTheme {
  const preference = useAppStore((state) => state.theme);
  const systemPrefersDark = useMediaQuery(PREFERS_DARK);
  return resolveTheme(preference, systemPrefersDark);
}

/**
 * P-31 / FRONTEND §7 — whether non-essential animation is disabled right now.
 * The `reduceMotionOverride` setting outranks the media query in **both** directions: `'full'`
 * re-enables motion for a user whose OS says reduce, and `'reduce'` disables it for a user
 * whose OS says nothing.
 */
export function useMotionDisabled(): boolean {
  const preference = useAppStore((state) => state.reduceMotion);
  const systemPrefersReduce = useMediaQuery(PREFERS_REDUCED_MOTION);
  if (preference === 'reduce') return true;
  if (preference === 'full') return false;
  return systemPrefersReduce;
}

/**
 * Applies `data-theme` and `data-motion` to `<html>`. Mounted once, by the app root.
 *
 * ⚠️ A theme change is a chrome change, not a data change: it must not re-run a query and must
 * not re-animate a chart (§6.12 — entrance animations run on first mount only).
 */
export function useThemeRoot(): ResolvedTheme {
  const theme = useResolvedTheme();
  const motionPreference = useAppStore((state) => state.reduceMotion);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    if (motionPreference === 'system') root.removeAttribute('data-motion');
    else root.setAttribute('data-motion', motionPreference);
  }, [motionPreference]);

  return theme;
}
