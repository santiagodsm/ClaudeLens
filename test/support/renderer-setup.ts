// Renderer-project setup only (STACK ADR-012): jest-dom matchers for
// @testing-library/react. The tripwire is loaded alongside this file, not by it.

import '@testing-library/jest-dom/vitest';

// jsdom 29 implements neither `matchMedia` nor `ResizeObserver`. Both are read by code the
// renderer genuinely ships — `prefers-color-scheme` / `prefers-reduced-motion` (§6.1, P-31) and
// Framer Motion's layout measurement — so the polyfills below make the component tests exercise
// the real code path instead of a jsdom-shaped variant of it.
//
// ⚠️ `matches: false` is the honest default here: it means "the OS states no preference", which
// is exactly what a headless environment has. A test that needs `reduce` sets it explicitly.

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => {
    const list: MediaQueryList = {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
    return list;
  };
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {
      /* no layout in jsdom to observe */
    }
    unobserve(): void {
      /* no layout in jsdom to observe */
    }
    disconnect(): void {
      /* no layout in jsdom to observe */
    }
  };
}
