/**
 * The stable categorical hue, on the renderer side (§3.3, §6.1, FRONTEND §1.3).
 *
 * `color_index = FNV1a32(name) mod 8`. It is a pure function of the name, which is the whole
 * point: a model, project or tool keeps the same hue in every view and across a full rebuild
 * (§3.3 — "hues survive a full rebuild"). Collisions are possible and acceptable, because
 * FRONTEND §6/§8 forbid encoding meaning by colour alone — every series also carries a label.
 *
 * ⚠️ **The hash itself is NOT implemented here.** It is `src/shared/color-index.ts`, imported
 * below and re-exported so the renderer has one obvious place to reach for it. That module is
 * the single implementation for all three consumers §3.3 names — ingest writing
 * `projects.color_index`, the analytics repositories filling `colorIndex` on eight §4.5 payload
 * types, and this file mapping `0..7` onto `--c1 … --c8`. Two implementations that disagree by
 * one byte produce two different palettes for the same dataset.
 *
 * ⚠️ **Reported, not fixed here (CLAUDE.md §2).** `src/shared/color-index.ts` hashes UTF-16
 * **code units** (`charCodeAt`, unmasked), not UTF-8 **bytes**. Canonical FNV-1a is defined over
 * bytes, and the two agree for every ASCII name — including all four canonical test vectors —
 * but they diverge for any non-ASCII one: a project directory named `café` hashes to
 * `856_211_068` under the shared function and to a different value under a byte-oriented one.
 * Since the ramp is 8 wide and every series carries a label, the consequence is a different hue,
 * not a wrong number; and consistency between processes is the property that actually matters,
 * which importing the shared module guarantees. The choice of encoding should still be decided
 * deliberately rather than inherited, and unmasked `charCodeAt` XORs more than eight bits into
 * the accumulator for any code unit ≥ 256, which is not FNV-1a.
 */

import { COLOR_RAMP_SIZE, colorIndexFor, fnv1a32 } from '../../shared/color-index';

export { COLOR_RAMP_SIZE, colorIndexFor, fnv1a32 };

/** §6.1 — the categorical ramp is exactly eight entries, `--c1` … `--c8`. Alias of the above. */
export const CATEGORICAL_RAMP_SIZE = COLOR_RAMP_SIZE;

/**
 * §6.1 — the CSS custom property backing a categorical index. `--c1` … `--c8` are one-based;
 * `colorIndex` is zero-based, which is the off-by-one this function exists to own once.
 *
 * Out-of-range indices wrap rather than throw: `colorIndex` arrives over IPC from a column with
 * `CHECK (color_index BETWEEN 0 AND 7)` (§3.3), so a value outside it is a main-side defect,
 * and blanking a chart series is a worse response than reusing a hue that already carries a
 * label.
 */
export function categoricalVar(colorIndex: number): string {
  const index = ((Math.trunc(colorIndex) % COLOR_RAMP_SIZE) + COLOR_RAMP_SIZE) % COLOR_RAMP_SIZE;
  return `var(--c${String(index + 1)})`;
}

/** Convenience: the ramp variable for a name, in one call. */
export function categoricalVarFor(name: string): string {
  return categoricalVar(colorIndexFor(name));
}

/**
 * §6.1 — the two gradients, as custom-property references. Used for StatTile top borders,
 * the active-nav bar and area fills; never as a text colour (see the contrast note in
 * `test/renderer/contrast.test.ts`).
 */
export const GRADIENT = {
  violetCyan: 'var(--grad-violet-cyan)',
  pinkViolet: 'var(--grad-pink-violet)',
} as const;

/**
 * §6.3 uses a **violet** sequential ramp (the activity calendar) and §6.5 a **cyan** one (the
 * rhythm heatmap). Two ramps, one meaning — magnitude — which is why this is a parameter and
 * not a second function: a caller can never accidentally encode a *category* in a ramp.
 */
export type SequentialRamp = 'violet' | 'cyan';

const RAMP_PREFIX: Record<SequentialRamp, string> = {
  violet: '--seq',
  cyan: '--seq-cyan',
};

/**
 * FRONTEND §5 — the sequential single-hue ramp for HeatmapCell, five stops.
 * `intensity` is clamped to `[0,1]`; `NaN` is a caller defect and clamps to the empty stop
 * rather than rendering an undefined colour. The default ramp is violet (§6.3).
 */
export function sequentialVar(intensity: number, ramp: SequentialRamp = 'violet'): string {
  const prefix = RAMP_PREFIX[ramp];
  if (!Number.isFinite(intensity) || intensity <= 0) return `var(${prefix}-0)`;
  if (intensity >= 1) return `var(${prefix}-4)`;
  const stop = Math.min(4, Math.floor(intensity * 4) + 1);
  return `var(${prefix}-${String(stop)})`;
}
