// src/shared/color-index.ts — the categorical hue assignment, stated ONCE.
//
// §3.3: "`color_index = FNV1a32(encoded_name) mod 8`, indexing the categorical ramp in §6.1.
// A pure function of the name, so hues survive a full rebuild. … The same function assigns
// model and tool hues (§6.1)."
//
// It lives in `src/shared/**` because three consumers need the identical answer and a second
// implementation would be a silently different colour: ingest writes `projects.color_index`
// (§3.3), the analytics repositories hand `colorIndex` to `ModelSeries`/`ToolFingerprint`
// payloads (§4.5), and the renderer maps `0..7` onto `--c1..--c8` (§6.1).
//
// ⚠️ Collisions are possible and acceptable: FRONTEND §6 forbids encoding meaning by colour
// alone, so every series carries a label (§3.3). Do not "improve" the hash to avoid them —
// stability across a full rebuild is the property that matters, not distinctness.

/** §6.1 — the categorical ramp has exactly eight slots, `--c1 … --c8`. */
export const COLOR_RAMP_SIZE = 8;

/**
 * FNV-1a, 32-bit, over the UTF-16 code units of `value`.
 *
 * `Math.imul` performs the 32-bit multiply exactly; `>>> 0` keeps the accumulator unsigned.
 * A plain `hash * PRIME` would lose the low bits to float rounding above 2^53 and produce a
 * different — and machine-dependent — hue.
 */
export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** §3.3 — `FNV1a32(name) mod 8`, always in `0..7` (the `projects.color_index` CHECK). */
export function colorIndexFor(name: string): number {
  return fnv1a32(name) % COLOR_RAMP_SIZE;
}
