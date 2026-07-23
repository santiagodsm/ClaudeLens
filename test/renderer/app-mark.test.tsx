/**
 * The app mark in the sidebar (§6.2 shell, §6.1 token layer).
 *
 * Three things are worth pinning and only one of them is "does it render":
 *
 *  1. **It paints from the token layer, not from literals.** `src/renderer/styles/tokens.css` is
 *     the only file in the renderer allowed a raw hex/rgb/hsl value (§6.1, `design-token-lint`).
 *     ESLint catches a literal in the *source*; this suite catches one in the *output*, which is
 *     the thing that actually reaches the screen — an SVG assembled from a token-shaped variable
 *     holding a hex string would pass lint and fail here.
 *
 *  2. **It therefore follows the theme.** The launcher icon in `resources/icon.svg` is fixed-dark
 *     because `sips` cannot resolve a custom property; this one has no such excuse. The proof is
 *     structural rather than computed: jsdom applies no stylesheet, so what is asserted is that
 *     the mark's markup is *identical* under both `data-theme` values and contains nothing but
 *     `var()` references — i.e. every colour it shows is whatever the active theme says it is.
 *
 *  3. **Adding it did not disturb the shell.** Eight nav items, and collapse still collapses.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../src/renderer/App';
import { APP_NAME } from '../../src/shared/version';
import type { SettingsSnapshot } from '../../src/shared/ipc-contract';
import {
  bootstrapPayload,
  installBridge,
  renderRouted,
  resetStore,
  uninstallBridge,
} from './harness';

/**
 * `#` followed by exactly 3/4/6/8 hex digits and nothing word-like — the same shape
 * `design-token-lint` looks for, so the two agree on what "a raw colour" means. The gradient is
 * referenced as `url(#app-mark-lens-…)`, which deliberately does not match.
 */
const HEX_LITERAL =
  /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_])/;
const FUNCTIONAL_COLOUR = /\b(rgba?|hsla?|oklch|color-mix)\s*\(/i;

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetStore();
});

function bootedBridge(): ReturnType<typeof installBridge> {
  const settings: Record<string, unknown> = { ...bootstrapPayload().settings };
  return installBridge({
    'app:bootstrap': () => ({ ok: true, data: bootstrapPayload() }),
    'settings:set': (request) => {
      const { key, value } = request as { key: string; value: unknown };
      settings[key] = value;
      return { ok: true, data: settings as unknown as SettingsSnapshot };
    },
  });
}

async function renderShell(): Promise<HTMLElement> {
  bootedBridge();
  renderRouted(<App />);
  await screen.findByTestId('app-shell');
  return screen.getByTestId('app-sidebar');
}

describe('the app mark (§6.2)', () => {
  it('renders inside the sidebar, beside the wordmark and the directory subtitle', async () => {
    const sidebar = await renderShell();

    const mark = within(sidebar).getByTestId('app-mark');
    expect(mark).toBeInTheDocument();
    expect(mark.tagName.toLowerCase()).toBe('svg');
    // The §6.2 header block is mark + wordmark + monospace subtitle, in that order.
    expect(within(sidebar).getByText(APP_NAME)).toBeInTheDocument();
    expect(within(sidebar).getByText('claude')).toBeInTheDocument();
  });

  it('draws the launcher aperture: barrel, six blade cuts, hexagonal opening', async () => {
    const sidebar = await renderShell();
    const mark = within(sidebar).getByTestId('app-mark');

    // The geometry is `resources/icon.svg`'s, so the numbers here are the launcher's numbers.
    // A drift in either file — a re-drawn "almost the same" mark — fails this.
    expect(mark.getAttribute('viewBox')).toBe('156 156 712 712');
    const barrel = mark.querySelector('circle');
    expect(barrel?.getAttribute('r')).toBe('318');
    expect(barrel?.getAttribute('stroke-width')).toBe('76');

    const blades = mark.querySelector('path[fill-rule="evenodd"]');
    expect(blades?.getAttribute('d')).toContain('A 200 200 0 1 0 712 512');
    expect(blades?.getAttribute('d')).toContain('M 512 416 L 595.14 464');

    // Six separators, each one hairline-wide in device pixels at every rendered size — the
    // 16-unit stroke the launcher uses is 0.54 px at 24 px and greys the blades instead of
    // cutting them.
    const cuts = mark.querySelectorAll('path[vector-effect="non-scaling-stroke"]');
    expect(cuts).toHaveLength(6);
  });

  it('paints only from custom properties — no hex, no rgb, no hsl (§6.1)', async () => {
    const sidebar = await renderShell();
    const markup = within(sidebar).getByTestId('app-mark').outerHTML;

    expect(markup).not.toMatch(HEX_LITERAL);
    expect(markup).not.toMatch(FUNCTIONAL_COLOUR);

    // …and it references the tokens it is supposed to reference: the violet→cyan gradient
    // endpoints, the surface the aperture is cut out of, and the glow.
    expect(markup).toContain('var(--accent)');
    expect(markup).toContain('var(--accent-2)');
    expect(markup).toContain('var(--bg-surface)');
    expect(markup).toContain('var(--glow)');
  });

  it('is identical under both data-theme values, so it follows the theme', async () => {
    const sidebar = await renderShell();

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    });
    const light = within(sidebar).getByTestId('app-mark').outerHTML;

    fireEvent.click(screen.getByTestId('theme-toggle'));
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    });
    const dark = within(sidebar).getByTestId('app-mark').outerHTML;

    // Nothing about the mark is theme-specific: the theme moves underneath it, through the
    // custom properties. A hard-coded dark-surface fill would make these two differ, or worse,
    // make them agree on the wrong colour.
    expect(dark).toBe(light);
    expect(dark).not.toMatch(HEX_LITERAL);
  });

  it('is decorative beside the wordmark and named when it stands alone (P-30)', async () => {
    const sidebar = await renderShell();

    // Expanded: the wordmark names the app; a second announcement would be noise.
    expect(within(sidebar).getByTestId('app-mark')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    await waitFor(() => {
      expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    });

    // Collapsed: the wordmark is gone, so the mark carries the name itself.
    const collapsedMark = within(sidebar).getByTestId('app-mark');
    expect(collapsedMark).not.toHaveAttribute('aria-hidden');
    expect(collapsedMark).toHaveAttribute('role', 'img');
    expect(collapsedMark).toHaveAccessibleName(APP_NAME);
  });

  it('never animates — the Refresh spinner is the only thing that moves while idle (§6.2)', async () => {
    const sidebar = await renderShell();
    const mark = within(sidebar).getByTestId('app-mark');

    expect(mark.querySelector('animate, animateTransform, animateMotion, set')).toBeNull();
    expect(mark.outerHTML).not.toMatch(/animation|transition|@keyframes/i);
    // No animation utility, and no transition class: the mark is inert by construction.
    expect(mark.getAttribute('class')).toBe('size-6 shrink-0');
  });
});

describe('the sidebar is unchanged by the mark (§6.2)', () => {
  it('still exposes the eight nav items', async () => {
    await renderShell();
    const nav = screen.getByRole('navigation', { name: 'Views' });
    expect(nav.querySelectorAll('a')).toHaveLength(8);
  });

  it('still collapses, and the mark survives the collapse without moving', async () => {
    const sidebar = await renderShell();

    expect(sidebar).toHaveAttribute('data-collapsed', 'false');
    expect(sidebar.style.width).toBe('var(--sidebar-w)');
    // The header block's padding is what fixes the mark's position; it is the same class list
    // collapsed and expanded, so nothing shifts sideways when the labels go away.
    const header = within(sidebar).getByTestId('app-mark').parentElement;
    const headerClasses = header?.getAttribute('class');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    await waitFor(() => {
      expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    });

    expect(sidebar.style.width).toBe('var(--sidebar-collapsed-w)');
    expect(within(sidebar).getByTestId('app-mark')).toBeInTheDocument();
    expect(within(sidebar).getByTestId('app-mark').parentElement?.getAttribute('class')).toBe(
      headerClasses,
    );
    // Still eight items, still reachable; only their labels are gone.
    expect(screen.getByRole('navigation', { name: 'Views' }).querySelectorAll('a')).toHaveLength(8);
    expect(screen.queryByText(APP_NAME)).toBeNull();
  });
});
