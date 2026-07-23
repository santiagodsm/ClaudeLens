/**
 * A `matchMedia` subscription that survives an environment without `matchMedia`.
 *
 * jsdom does not implement it, and neither does a window torn down mid-effect. Returning
 * `false` there is safe for every caller in this app: `prefers-color-scheme: dark` falling back
 * to light and `prefers-reduced-motion: reduce` falling back to "not reduced" are both the
 * conservative reading, and both are overridable by an explicit setting (§3.13).
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect`: a media query IS an external
 * store, and subscribing to it that way means no state is ever set synchronously inside an
 * effect (which React 19's compiler-aware lint rules correctly reject as a cascading render).
 */

import { useCallback, useSyncExternalStore } from 'react';

function supported(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!supported()) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => {
        list.removeEventListener('change', onChange);
      };
    },
    [query],
  );

  const getSnapshot = useCallback(
    () => (supported() ? window.matchMedia(query).matches : false),
    [query],
  );

  // The third argument is the server snapshot; there is no server (STACK ADR-003), but the
  // signature requires one and `false` is the same conservative answer as above.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** §6.1 — the system half of `ThemePreference: 'system'`. */
export const PREFERS_DARK = '(prefers-color-scheme: dark)';

/** P-31 / FRONTEND §7. */
export const PREFERS_REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
