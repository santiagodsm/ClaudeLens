/**
 * The app mark — the aperture, shared with the macOS launcher icon (ADR-038).
 *
 * ⚠️ The geometry below is **copied verbatim** from `resources/icon.svg`: the same centre
 * (512,512), the same blade circle (r=200), the same hexagonal opening, the same six blade
 * separators and the same barrel (r=318, 76 wide). Only two things change, and both are
 * deliberate:
 *
 *  1. **Colour comes from the token layer, never from a literal.** `resources/icon.svg` carries
 *     raw hex because `sips`/`iconutil` consume it outside the renderer and cannot resolve a
 *     custom property. In here a raw hex/rgb/hsl literal is a lint error — `tokens.css` is the
 *     only file allowed one (§6.1, `design-token-lint`) — so the gradient reads `--accent` →
 *     `--accent-2` and everything cut out of the blades reads `--bg-surface`. The real benefit
 *     is not lint: the mark then **follows the theme**, so the aperture's gaps stay the colour
 *     of the sidebar in light mode instead of staying stuck on the dark app surface. The
 *     launcher icon is fixed-dark by necessity; this one is not.
 *
 *     ⚠️ The gradient stops are set through `style`, not through a `stop-color` attribute:
 *     `var()` is only substituted in a CSS declaration, and a presentation attribute of
 *     `stop-color="var(--accent)"` silently paints nothing.
 *
 *  2. **The macOS icon tile and the baked-in glow are dropped.** The 824×824 rounded rect and
 *     the `radialGradient` halo exist to fill the Dock's icon grid; inside the app the mark
 *     sits directly on the sidebar surface, and the halo is the real `--glow` token as a
 *     box-shadow on the circular mark itself. The viewBox is cropped to the mark's own bounding
 *     box (r=356 about the centre → `156 156 712 712`) so that the drawing fills the space it
 *     is given. Cropping moves nothing; every coordinate is still the launcher's coordinate.
 *
 * ⚠️ **Small-size legibility.** `resources/icon.svg` records that the launcher needed two
 * rebuilds because the barrel and the blades fused at 16 px, and that its 16-unit separators
 * are *expected* to vanish at that size. The sidebar mark is 24 px, where 16 units is 0.54 px —
 * the same failure, one size up: the separators would grey the blade band instead of cutting
 * it. So the separators are drawn with `vector-effect="non-scaling-stroke"` at 1 px, which is
 * one device pixel at every rendered size. The lines themselves are unchanged — same endpoints,
 * same six of them — only their width stops shrinking below what a screen can show. That is
 * what keeps this an aperture rather than a doughnut at sidebar size.
 *
 * ⚠️ §6.2 peripheral vision: this mark never animates, pulses or spins. The Refresh spinner is
 * the only thing permitted to move while the app is idle.
 */

import { useId } from 'react';
import type { JSX, SVGProps } from 'react';

export interface AppMarkProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'aria-label'> {
  /**
   * An accessible name, for when the mark stands alone — a collapsed sidebar hides the
   * wordmark, and a mark with no name there announces as nothing at all. Omit it whenever
   * adjacent text already names the app, and the mark is marked decorative instead (P-30,
   * FRONTEND §8: meaning is never carried twice).
   */
  label?: string;
}

/** The blade annulus and, by the even-odd rule, the hexagonal opening punched out of it. */
const BLADES =
  'M 312 512 A 200 200 0 1 0 712 512 A 200 200 0 1 0 312 512 Z ' +
  'M 512 416 L 595.14 464 L 595.14 560 L 512 608 L 428.86 560 L 428.86 464 Z';

/** Each hexagon side, extended past its vertex to the blade circle. Six blades, six cuts. */
const SEPARATORS = [
  'M 595.14 464 L 711.10 530.95',
  'M 595.14 560 L 595.14 693.90',
  'M 512 608 L 396.04 674.95',
  'M 428.86 560 L 312.90 493.05',
  'M 428.86 464 L 428.86 330.10',
  'M 512 416 L 627.96 349.05',
];

export function AppMark({ label, style, ...props }: AppMarkProps): JSX.Element {
  // Two marks on one page (sidebar + onboarding, say) must not share a gradient id.
  const gradientId = `app-mark-lens-${useId()}`;

  return (
    <svg
      viewBox="156 156 712 712"
      width="1em"
      height="1em"
      data-testid="app-mark"
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      focusable="false"
      // §6.1 — `--glow` on a hero element. The mark's outer edge IS the viewBox edge, so a pill
      // radius makes the halo circular and concentric with the barrel.
      style={{ boxShadow: 'var(--glow)', borderRadius: 'var(--radius-pill)', ...style }}
      {...props}
    >
      <defs>
        {/* grad-violet-cyan at 135°, as one continuous field so the barrel and the blades are
            lit by the same gradient rather than by two of them. */}
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="180"
          y1="180"
          x2="844"
          y2="844"
        >
          <stop offset="0" style={{ stopColor: 'var(--accent)' }} />
          <stop offset="1" style={{ stopColor: 'var(--accent-2)' }} />
        </linearGradient>
      </defs>

      <path fillRule="evenodd" fill={`url(#${gradientId})`} d={BLADES} />

      {/* Cut in the surface colour, so the blades separate against whatever the mark sits on
          and the cuts invert correctly with the theme. */}
      <g fill="none" strokeLinecap="butt" strokeWidth="1" style={{ stroke: 'var(--bg-surface)' }}>
        {SEPARATORS.map((d) => (
          // `vector-effect` is not an inherited property, so it goes on each path, not the group.
          <path key={d} d={d} vectorEffect="non-scaling-stroke" />
        ))}
      </g>

      <circle
        cx="512"
        cy="512"
        r="318"
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth="76"
      />
    </svg>
  );
}
