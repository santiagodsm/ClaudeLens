/**
 * The shell (§6.2) and its test hooks (STACK ADR-018).
 *
 * The hooks asserted here are the ones the E2E smoke suite selects on: `app-shell`,
 * `view-<id>`, `view-<id>-primary`, and `data-theme` on the theme root. **The smoke suite
 * selects on these, never on copy or styling** — so this suite pins them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../../src/renderer/App';
import { NAV_ITEMS } from '../../src/renderer/shell/nav';
import type { SettingsSnapshot } from '../../src/shared/ipc-contract';
import { useAppStore } from '../../src/renderer/store/app-store';
import {
  bootstrapPayload,
  installBridge,
  renderRouted,
  resetStore,
  uninstallBridge,
} from './harness';

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetStore();
});

function bootedBridge(): ReturnType<typeof installBridge> {
  // §4.3 — `settings:set` returns the FULL new snapshot. The stub echoes the write, because a
  // stub that returned the old snapshot would silently revert every optimistic update and make
  // the test assert the opposite of the shipped behaviour.
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

describe('the shell', () => {
  it('renders the app-shell hook', async () => {
    bootedBridge();
    renderRouted(<App />);
    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
  });

  it('has exactly eight nav items, in the §6.2 order, with the §6.2 labels', async () => {
    bootedBridge();
    renderRouted(<App />);
    await screen.findByTestId('app-shell');

    const nav = screen.getByRole('navigation', { name: 'Views' });
    const links = Array.from(nav.querySelectorAll('a'));

    expect(links).toHaveLength(8);
    expect(links.map((link) => link.textContent)).toEqual([
      'Overview',
      'Tokens & Cost',
      'Sessions & Time',
      'Tools & Agents',
      'Graphs',
      'Projects & Code',
      'Harness Manager',
      'Settings',
    ]);
    // …and the source of truth agrees, so a view added without a nav entry is caught too.
    expect(NAV_ITEMS).toHaveLength(8);
    expect(NAV_ITEMS.map((item) => item.id)).toEqual([
      'overview',
      'tokens',
      'sessions',
      'tools',
      'graphs',
      'projects',
      'harness',
      'settings',
    ]);
  });

  it('marks the active item with aria-current and the violet→cyan bar', async () => {
    bootedBridge();
    renderRouted(<App />, '/tokens');
    await screen.findByTestId('view-tokens');

    expect(screen.getByTestId('nav-tokens')).toHaveAttribute('aria-current', 'page');
    const bar = screen.getByTestId('nav-tokens-active-bar');
    expect(bar.getAttribute('style')).toContain('var(--grad-violet-cyan)');
    expect(bar.getAttribute('style')).toContain('var(--glow)');
  });

  it('routes to every one of the eight views', async () => {
    for (const item of NAV_ITEMS) {
      bootedBridge();
      renderRouted(<App />, item.path);
      expect(await screen.findByTestId(`view-${item.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`view-${item.id}-primary`)).toBeInTheDocument();
      cleanup();
      resetStore();
    }
  });

  it('renders the top bar with the four §6.2 controls', async () => {
    bootedBridge();
    renderRouted(<App />);
    await screen.findByTestId('app-shell');

    expect(screen.getByTestId('app-topbar')).toBeInTheDocument();
    expect(screen.getByTestId('project-filter')).toBeInTheDocument();
    expect(screen.getByTestId('date-range-filter')).toBeInTheDocument();
    expect(screen.getByTestId('refresh-button')).toBeInTheDocument();
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
    // P-30 — every icon button carries an aria-label.
    expect(screen.getByTestId('refresh-button')).toHaveAttribute('aria-label', 'Refresh');
    expect(screen.getByTestId('theme-toggle')).toHaveAccessibleName();
  });
});

describe('the theme toggle (§6.1, §6.2)', () => {
  it('flips data-theme on the root element', async () => {
    bootedBridge();
    renderRouted(<App />);
    await screen.findByTestId('app-shell');

    // `theme: 'system'` with the jsdom matchMedia stub reporting no preference resolves light.
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    });

    fireEvent.click(screen.getByTestId('theme-toggle'));
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    });

    fireEvent.click(screen.getByTestId('theme-toggle'));
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    });
  });

  it('writes data-motion only when the reduce-motion override is explicit (P-31)', async () => {
    bootedBridge();
    renderRouted(<App />);
    await screen.findByTestId('app-shell');
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false);

    await act(async () => {
      await useAppStore.getState().setReduceMotion('reduce');
    });
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-motion', 'reduce');
    });
  });
});

describe('onboarding is a state of the shell, not a ninth view (§6.2)', () => {
  it('disables the sidebar and top bar and shows the directory picker', async () => {
    installBridge({
      'app:bootstrap': () => ({
        ok: true,
        data: bootstrapPayload({ dirStatus: 'unset' }, { claudeDir: null }),
      }),
    });
    renderRouted(<App />);

    expect(await screen.findByTestId('onboarding')).toBeInTheDocument();
    expect(screen.getByTestId('app-shell')).toHaveAttribute('data-dir-status', 'unset');
    expect(screen.getByTestId('app-sidebar')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('app-topbar')).toHaveAttribute('data-disabled', 'true');

    // The validation rule is stated, verbatim (§6.2).
    expect(screen.getByText('must contain projects/ and/or history.jsonl')).toBeInTheDocument();

    // Still eight nav items — onboarding did not add a ninth.
    expect(screen.getByRole('navigation', { name: 'Views' }).querySelectorAll('a')).toHaveLength(8);
    // …and no view rendered behind it.
    expect(screen.queryByTestId('view-overview')).toBeNull();
  });
});

describe('peripheral-vision rules (§6.2, §1.3 moment 2)', () => {
  it('a push event never steals focus and never opens a toast or modal', async () => {
    const bridge = bootedBridge();
    renderRouted(<App />);
    await screen.findByTestId('app-shell');

    const refresh = screen.getByTestId('refresh-button');
    refresh.focus();
    expect(document.activeElement).toBe(refresh);

    act(() => {
      bridge.emit('evt:sync', {
        phase: 'parsing',
        kind: 'incremental',
        startedAt: 1,
        filesTotal: 10,
        filesDone: 4,
        recordsIngested: 100,
        badLines: 0,
        queuedRescan: false,
        lastCompletedAt: null,
        lastDurationMs: null,
        error: null,
      });
      bridge.emit('evt:dataChanged', { at: 2, scopes: ['events'] });
    });

    // Focus is exactly where the user left it, and nothing was added on top of the shell.
    expect(document.activeElement).toBe(refresh);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // The sync state DID change — the update is silent, not absent.
    await waitFor(() => {
      expect(screen.getByTestId('sync-status')).toHaveAttribute('data-phase', 'parsing');
    });
  });

  it('reports a bootstrap failure as an error, never as an empty app', async () => {
    installBridge({}); // no handlers at all — the state the app is in before E8…E12
    renderRouted(<App />);

    const error = await screen.findByTestId('bootstrap-error');
    expect(error).toHaveAttribute('data-error-code', 'E_INTERNAL');
    expect(screen.queryByTestId('view-overview')).toBeNull();
  });
});
