/**
 * ADR-011's constraint, applied to `@xyflow/react`: "All five must read their colors from the
 * ADR-004 token layer, never from literals — which is what makes `design-token-lint` a runnable
 * gate."
 *
 * `@xyflow/react/dist/base.css` ships its own `--xy-*` defaults, and those defaults are literal
 * hex values that know nothing about our themes. Rather than fight them per element, every one
 * the library actually paints with is re-pointed at a token here, on the flow's own wrapper.
 * The library then keeps using its variables and the values come from `tokens.css` — including
 * in light theme, which the vendor defaults would otherwise ignore.
 *
 * ⚠️ Only `base.css` is imported anywhere in this build, never `style.css`: the latter carries
 * the vendor's full visual theme (node fills, control chrome, minimap), which would be a second
 * design system sitting under §6.1's.
 */

import type { CSSProperties } from 'react';

/** CSS custom properties are legal in a `CSSProperties` object; the type does not model them. */
type CustomProperties = CSSProperties & Record<`--${string}`, string>;

export const FLOW_THEME: CustomProperties = {
  '--xy-edge-stroke-default': 'var(--border)',
  '--xy-edge-stroke-selected-default': 'var(--accent)',
  '--xy-connectionline-stroke-default': 'var(--border)',
  '--xy-background-color-default': 'var(--bg-surface)',
  '--xy-node-color-default': 'var(--text-primary)',
  '--xy-node-border-default': 'var(--border)',
  '--xy-node-background-color-default': 'var(--bg-surface-2)',
  '--xy-node-boxshadow-hover-default': 'var(--ring-accent)',
  '--xy-node-boxshadow-selected-default': 'var(--ring-accent)',
  '--xy-selection-background-color-default': 'var(--tint-hover)',
  '--xy-selection-border-default': 'var(--accent)',
  '--xy-attribution-background-color-default': 'transparent',
};
