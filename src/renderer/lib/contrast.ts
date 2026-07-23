/**
 * WCAG 2.1 relative luminance and contrast ratio (P-29, FRONTEND §2 "verify — don't eyeball").
 *
 * Lives in `src/renderer/lib` rather than in the test, because §8.7 makes the contrast bar a
 * property of the product, not of the suite: any component that has to pick a foreground for a
 * surface at runtime (a legend swatch label, a treemap tile label) asks this module, and the
 * automated assertion in `test/renderer/contrast.test.ts` asks the same one. One implementation,
 * so the test cannot pass while the app does something else.
 *
 * Pure arithmetic — no DOM, no colour library, no dependency.
 */

/** §8.7 P-29 — body text. */
export const BODY_TEXT_MIN_RATIO = 4.5;

/** §8.7 P-29 — large text and hero numbers. */
export const LARGE_TEXT_MIN_RATIO = 3;

/** A colour as three channels in `[0,1]`. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parses `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA`. Alpha is parsed but ignored: a contrast
 * ratio is only defined between two opaque colours, and silently compositing an unknown
 * backdrop would be a guess.
 *
 * Throws on anything else — a colour the checker cannot read must fail loudly, not default.
 */
export function parseHex(hex: string): Rgb {
  const body = hex.trim().replace(/^#/, '');
  const expand = body.length === 3 || body.length === 4;
  if (!/^[0-9a-fA-F]+$/.test(body) || ![3, 4, 6, 8].includes(body.length)) {
    throw new RangeError(`parseHex: not a hex colour: ${hex}`);
  }
  const channel = (index: number): number => {
    const slice = expand
      ? body.slice(index, index + 1).repeat(2)
      : body.slice(index * 2, index * 2 + 2);
    return parseInt(slice, 16) / 255;
  };
  return { r: channel(0), g: channel(1), b: channel(2) };
}

/** WCAG 2.1 sRGB channel linearisation. */
function linearise(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance, in `[0,1]`. */
export function relativeLuminance(colour: Rgb): number {
  const r = linearise(colour.r);
  const g = linearise(colour.g);
  const b = linearise(colour.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, in `[1, 21]`. Symmetric in its arguments. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(parseHex(foreground));
  const b = relativeLuminance(parseHex(background));
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Whether a pair clears the P-29 bar for its text size. */
export function meetsContrast(
  foreground: string,
  background: string,
  minimum: number = BODY_TEXT_MIN_RATIO,
): boolean {
  return contrastRatio(foreground, background) >= minimum;
}
