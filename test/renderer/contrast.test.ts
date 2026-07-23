/**
 * P-29 — "WCAG AA in both themes, **verified not eyeballed**: body text ≥ 4.5:1, large numbers
 * ≥ 3:1. An automated contrast assertion runs over every token pair in `tokens.css` as part of
 * the test suite."
 *
 * This file is that assertion. It parses `src/renderer/styles/tokens.css` — the one file the
 * design allows a raw colour literal — so it measures the shipped values rather than a copy of
 * them, and every foreground token is checked against all three surfaces in **both** themes.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ AMENDED 2026-07-22 (A-06) — this suite used to PIN a table of measured failures
 * (`KNOWN_BELOW_BAR`): §6.1 declared the accent/semantic/categorical hues identically in both
 * theme blocks, they were tuned for the near-black dark surfaces, and in LIGHT theme every hue
 * but violet fell below 3:1 (amber 1.67:1, cyan 1.81:1) while `--text-faint` cleared 4.5:1 in
 * NEITHER theme. The user approved darkening the light-theme hues (dark theme unchanged) and
 * raising `--text-faint` in both themes. The pins are gone: this suite now asserts the TARGET
 * for every foreground against every surface in both themes and FAILS if any pair regresses.
 * The values live in `tokens.css`; the ratios they achieve are the assertions below.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BODY_TEXT_MIN_RATIO,
  LARGE_TEXT_MIN_RATIO,
  contrastRatio,
} from '../../src/renderer/lib/contrast';

// Repo-relative, resolved against the Vitest root. Not a personal path and not a sandbox
// path — it is the source file under test (P-33, STACK ADR-013).
const TOKENS_CSS = 'src/renderer/styles/tokens.css';

type ThemeName = 'dark' | 'light';

/**
 * Resolves each theme's colour tokens the way the browser's cascade does, from the shipped
 * file — so a token renamed or dropped shows up as a missing key here rather than a silently
 * skipped assertion (see the completeness test at the bottom).
 *
 * ⚠️ Specificity, not source order, decides the winner. `:root[data-theme='light']` (0,1,1)
 * out-ranks a bare `:root` (0,0,1), so a light-theme override wins **wherever** it sits in the
 * file — and A-06's light categorical overrides sit ABOVE the bare `:root` ramp they replace.
 * A naive "last declaration wins" parse would let the later bare-`:root` ramp clobber them and
 * measure colours the browser never renders. So: bare-`:root` blocks form the base for both
 * themes (that is the design's mechanism — the dark palette is the default, inherited by light
 * unless overridden), and `[data-theme='light']` blocks are layered on top of the light theme
 * only.
 */
function readThemes(): Record<ThemeName, Record<string, string>> {
  const css = readFileSync(TOKENS_CSS, 'utf8');
  const base: Record<string, string> = {};
  const lightOverride: Record<string, string> = {};

  // Every `:root…{ … }` block, with its selector, in source order.
  const blocks = css.matchAll(/(:root[^{]*)\{([^}]*)\}/g);
  for (const block of blocks) {
    const selector = block[1] ?? '';
    const body = block[2] ?? '';
    // A block scoped to the light attribute is a light-only override (higher specificity);
    // everything else — bare `:root` and the shared `:root, :root[data-theme='dark']` block —
    // is the base the dark theme uses and the light theme inherits from.
    const isLightOverride = selector.includes("data-theme='light'");
    const target = isLightOverride ? lightOverride : base;
    for (const declaration of body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
      const name = declaration[1];
      const value = declaration[2];
      if (name === undefined || value === undefined) continue;
      target[name] = value;
    }
  }

  return {
    dark: { ...base },
    light: { ...base, ...lightOverride },
  };
}

const THEMES = readThemes();

/** The three surfaces any foreground can sit on (§6.1). */
const SURFACES = ['--bg-app', '--bg-surface', '--bg-surface-2'] as const;

/**
 * Body-tier text: P-29 requires ≥ 4.5:1. `--text-faint` is here — not in the mark tier — because
 * it colours real text: de-emphasised micro captions (`--text-micro`, 0.6875rem ≈ 11 px), which
 * is small text under WCAG, not large. A-06 darkened it (light) / lightened it (dark) until it
 * clears 4.5:1 on every surface in both themes; legibility wins over the aesthetic of faintness.
 */
const BODY_FOREGROUNDS = ['--text-primary', '--text-muted', '--text-faint'] as const;

/**
 * Mark tier: accent, semantic and categorical hues, used as fills, strokes, borders, gradient
 * stops, dots and large numbers — never as body copy (FRONTEND §8: meaning is never carried by
 * colour alone). P-29 requires ≥ 3:1 against every surface each may sit on, in both themes.
 * A-06 darkened these for the LIGHT theme (dark theme unchanged) so every one now clears 3:1.
 */
const MARK_FOREGROUNDS = [
  '--accent',
  '--accent-2',
  '--accent-3',
  '--ok',
  '--warn',
  '--danger',
  '--info',
  '--c1',
  '--c2',
  '--c3',
  '--c4',
  '--c5',
  '--c6',
  '--c7',
  '--c8',
] as const;

function measure(theme: ThemeName, foreground: string, surface: string): number {
  const tokens = THEMES[theme];
  const fg = tokens[foreground];
  const bg = tokens[surface];
  if (fg === undefined || bg === undefined) {
    throw new Error(`tokens.css is missing ${foreground} or ${surface} for the ${theme} theme`);
  }
  return contrastRatio(fg, bg);
}

describe('P-29 — token contrast, measured from tokens.css, in both themes', () => {
  const themes: ThemeName[] = ['dark', 'light'];

  it('parses both theme blocks out of the shipped token file', () => {
    for (const theme of themes) {
      for (const token of [...SURFACES, ...BODY_FOREGROUNDS, ...MARK_FOREGROUNDS]) {
        expect(THEMES[theme][token], `${theme}: ${token}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  for (const theme of themes) {
    // Body-tier text must clear 4.5:1 on every surface it can sit on, in both themes.
    for (const foreground of BODY_FOREGROUNDS) {
      for (const surface of SURFACES) {
        it(`${theme}: body text ${foreground} on ${surface} ≥ 4.5:1`, () => {
          expect(measure(theme, foreground, surface)).toBeGreaterThanOrEqual(BODY_TEXT_MIN_RATIO);
        });
      }
    }

    // Mark-tier hues must clear 3:1 on every surface, in both themes. No exceptions, no pins.
    for (const foreground of MARK_FOREGROUNDS) {
      for (const surface of SURFACES) {
        it(`${theme}: mark ${foreground} on ${surface} ≥ 3:1`, () => {
          expect(measure(theme, foreground, surface)).toBeGreaterThanOrEqual(LARGE_TEXT_MIN_RATIO);
        });
      }
    }
  }

  it('checks every foreground token against every surface, in both themes', () => {
    // Completeness, so nobody can quieten this suite by deleting a case: 2 themes ×
    // (3 body + 15 mark) foregrounds × 3 surfaces = 108 measured pairs, every one asserted
    // at its tier's threshold above.
    const pairs =
      themes.length * (BODY_FOREGROUNDS.length + MARK_FOREGROUNDS.length) * SURFACES.length;
    expect(pairs).toBe(108);
    for (const theme of themes) {
      for (const foreground of [...BODY_FOREGROUNDS, ...MARK_FOREGROUNDS]) {
        for (const surface of SURFACES) {
          expect(measure(theme, foreground, surface)).toBeGreaterThan(1);
        }
      }
    }
  });
});
