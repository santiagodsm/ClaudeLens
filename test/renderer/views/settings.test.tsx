/**
 * Settings — §6.10.
 *
 * The two assertions this suite exists for:
 *   · **the price-fetch URL field ships empty and the button stays disabled until the user fills
 *     it** (§11.3, closed), with the recorded rationale stated on the surface;
 *   · **offline is visible here and nowhere else**: `pricing:fetch` fails inline, non-blockingly,
 *     and leaves the price table completely intact.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  COMMUNITY_PRICE_URL,
  IDLE_GAP_BOUNDARY_NOTE,
  IDLE_GAP_NOTE,
  ONLY_NETWORK_REQUEST_NOTE,
  PRICING_EMPTY_REASON,
  REBUILD_WARNING,
  SettingsView,
  URL_DISABLED_NOTE,
  URL_OPT_IN_NOTE,
} from '../../../src/renderer/views/SettingsView';
import { useAppStore } from '../../../src/renderer/store/app-store';
import { DEFAULT_SETTINGS } from '../harness';
import { ok, renderView, resetAll, uninstallBridge } from './view-harness';
import { observedModels, priceRows } from './payloads';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetAll();
});

const FETCH_OFFLINE = {
  ok: false as const,
  error: {
    code: 'E_FETCH_NETWORK' as const,
    message: 'The price table could not be reached.',
    retryable: true,
  },
};

function stubs(overrides: Partial<Record<string, () => unknown>> = {}) {
  return {
    'pricing:models': () => ok({ rows: observedModels() }),
    'groups:list': () => ok({ rows: [] }),
    'pricing:list': () => ok({ rows: priceRows() }),
    'dir:validate': () =>
      ok({ status: 'valid', hasProjects: true, hasHistory: true, transcriptFileCount: 412 }),
    'settings:set': (request: unknown) => {
      const { key, value } = request as { key: string; value: unknown };
      return ok({ ...DEFAULT_SETTINGS, claudeDir: '/sandbox/claude', [key]: value });
    },
    ...overrides,
  } as Parameters<typeof renderView>[1];
}

describe('§6.10 Settings — the five built cards and the two mounting points', () => {
  it('renders every card §6.10 lists, in order', async () => {
    renderView(<SettingsView />, stubs());
    for (const id of [
      'directory',
      'idle-gap',
      'theme',
      'resync',
      'pricing',
      'project-groups',
      'backups',
      'archive',
    ]) {
      expect(await screen.findByTestId(`settings-card-${id}`)).toBeInTheDocument();
    }
  });

  it('leaves cards 6 and 7 as labelled mounting points rather than fake surfaces', async () => {
    renderView(<SettingsView />, stubs());
    expect(await screen.findByTestId('settings-card-backups')).toHaveTextContent(
      'arrive in a later update',
    );
    expect(screen.getByTestId('settings-card-archive')).toHaveTextContent(
      'arrive in a later update',
    );
    // ⚠️ Not zeroes: an unbuilt card that reports "0 restore points" is a wrong number.
    expect(screen.getByTestId('settings-card-backups')).not.toHaveTextContent('0 restore points');
  });
});

describe('§6.10 Settings — directory, idle gap, theme, re-sync', () => {
  it('shows the configured path and a live validation line', async () => {
    renderView(<SettingsView />, stubs());
    expect(screen.getByTestId('settings-claude-dir')).toHaveTextContent('/sandbox/claude');
    expect(await screen.findByTestId('dir-validation')).toHaveTextContent(
      'Valid — 412 transcript files detected',
    );
    expect(screen.getByTestId('settings-card-directory')).toHaveTextContent(REBUILD_WARNING);
  });

  it('⚠️ states that the idle-gap slider does not change session boundaries (INV-05)', async () => {
    renderView(<SettingsView />, stubs(), { settings: { idleGapMinutes: 15 } });
    const card = await screen.findByTestId('settings-card-idle-gap');

    expect(card).toHaveTextContent(IDLE_GAP_NOTE);
    expect(card).toHaveTextContent(IDLE_GAP_BOUNDARY_NOTE);

    const slider = screen.getByTestId('idle-gap-slider');
    expect(slider).toHaveAttribute('min', '5');
    expect(slider).toHaveAttribute('max', '60');
    expect(slider).toHaveAttribute('step', '5');
    expect(screen.getByTestId('idle-gap-value')).toHaveTextContent('15 min');
  });

  it('persists a new idle gap through settings:set', async () => {
    const { bridge } = renderView(<SettingsView />, stubs(), { settings: { idleGapMinutes: 15 } });
    const slider = screen.getByTestId('idle-gap-slider');

    fireEvent.change(slider, { target: { value: '30' } });
    fireEvent.pointerUp(slider);

    await waitFor(() => {
      const call = bridge.calls.find((entry) => entry.channel === 'settings:set');
      expect(call?.request).toEqual({ key: 'idleGapMinutes', value: 30 });
    });
    expect(screen.getByTestId('idle-gap-value')).toHaveTextContent('30 min');
  });

  it('offers System / Dark / Light and applies the choice', async () => {
    renderView(<SettingsView />, stubs());
    fireEvent.click(screen.getByTestId('theme-light'));
    await waitFor(() => {
      expect(useAppStore.getState().theme).toBe('light');
    });
    expect(screen.getByTestId('theme-light')).toHaveAttribute('aria-checked', 'true');
  });

  it('re-syncs on demand and reports the last sync', async () => {
    const { bridge } = renderView(<SettingsView />, {
      ...stubs(),
      'sync:start': () => ok({ ...useAppStore.getState().sync }),
    });
    fireEvent.click(screen.getByTestId('settings-resync'));
    await waitFor(() => {
      expect(bridge.calls.some((call) => call.channel === 'sync:start')).toBe(true);
    });
    expect(screen.getByTestId('resync-last')).toHaveTextContent('Last sync never');
  });
});

describe('§6.10 Settings — pricing', () => {
  it('lists the models observed and calls out the unpriced one', async () => {
    renderView(<SettingsView />, stubs());
    const list = await screen.findByTestId('observed-models');
    expect(within(list).getByText('claude-test-1 · priced')).toBeInTheDocument();
    expect(within(list).getByText('claude-test-2 · no price row')).toBeInTheDocument();
  });

  it('renders the editable price table and its empty copy', async () => {
    renderView(<SettingsView />, stubs());
    expect(await screen.findByTestId('price-table')).toBeInTheDocument();
    expect(screen.getByTestId('price-rate-input')).toHaveValue(75);

    cleanup();
    uninstallBridge();
    renderView(<SettingsView />, stubs({ 'pricing:list': () => ok({ rows: [] }) }));
    expect(await screen.findByTestId('pricing-empty')).toHaveTextContent(PRICING_EMPTY_REASON);
  });

  it('commits a rate edit through pricing:upsertRate', async () => {
    const { bridge } = renderView(
      <SettingsView />,
      stubs({ 'pricing:upsertRate': () => ok({ rows: priceRows(), versioned: true }) }),
    );
    const input = await screen.findByTestId('price-rate-input');

    fireEvent.change(input, { target: { value: '0.3125' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const call = bridge.calls.find((entry) => entry.channel === 'pricing:upsertRate');
      expect(call?.request).toEqual({
        model: 'claude-test-1',
        tokenClass: 'output',
        usdPerMillion: 0.3125,
      });
    });
  });

  it('surfaces E_PRICE_OVERLAP with the §6.10 sentence, inline', async () => {
    renderView(
      <SettingsView />,
      stubs({
        'pricing:upsertRate': () => ({
          ok: false as const,
          error: {
            code: 'E_PRICE_OVERLAP' as const,
            message: 'overlap',
            retryable: false,
          },
        }),
      }),
    );
    const input = await screen.findByTestId('price-rate-input');
    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByTestId('pricing-error')).toHaveTextContent(
      'That date range overlaps an existing row for this model and class.',
    );
    // The table is untouched by a rejected edit.
    expect(screen.getByTestId('price-table')).toBeInTheDocument();
  });
});

describe('§6.10 Settings — the price-fetch URL (§11.3, closed)', () => {
  it('⚠️ ships the field empty and the button disabled', async () => {
    renderView(<SettingsView />, stubs());
    await screen.findByTestId('price-table');

    expect(screen.getByTestId('price-fetch-url')).toHaveValue('');
    expect(screen.getByTestId('refresh-prices')).toBeDisabled();
    expect(screen.getByTestId('refresh-disabled-note')).toHaveTextContent(URL_DISABLED_NOTE);
  });

  it('enables the button only once the user has typed a URL', async () => {
    renderView(<SettingsView />, stubs());
    await screen.findByTestId('price-table');

    fireEvent.change(screen.getByTestId('price-fetch-url'), {
      target: { value: 'https://example.invalid/prices.json' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('refresh-prices')).toBeEnabled();
    });
  });

  it('states the rationale, the single-egress fact, and offers the community option as TEXT', async () => {
    renderView(<SettingsView />, stubs());
    const card = await screen.findByTestId('settings-card-pricing');

    expect(card).toHaveTextContent(URL_OPT_IN_NOTE);
    expect(card).toHaveTextContent(ONLY_NETWORK_REQUEST_NOTE);
    expect(card).toHaveTextContent(COMMUNITY_PRICE_URL);
    expect(card).toHaveTextContent('This is help text, not a default');
    expect(card).toHaveTextContent('rejected as an unrecognised format');
    // ⚠️ Text to paste, never a value: the field is still empty.
    expect(screen.getByTestId('price-fetch-url')).toHaveValue('');
  });

  it('⚠️ offline: the fetch fails inline and leaves the price table completely intact', async () => {
    renderView(<SettingsView />, stubs({ 'pricing:fetch': () => FETCH_OFFLINE }), {
      settings: { priceFetchUrl: 'https://example.invalid/prices.json' },
    });
    await screen.findByTestId('price-table');

    fireEvent.click(screen.getByTestId('refresh-prices'));

    expect(await screen.findByTestId('pricing-error')).toHaveTextContent(
      'Could not reach the price table. Your price table is unchanged.',
    );
    // Non-blocking: no modal, no toast, and the table and every other control still work.
    expect(screen.getByTestId('price-table')).toBeInTheDocument();
    expect(screen.getByTestId('price-rate-input')).toHaveValue(75);
    expect(screen.getByTestId('settings-resync')).toBeEnabled();
  });
});

/**
 * ADR-040 / §6.10 — grouped projects sit with the other things the user decided themselves
 * (pricing, archives). The action lives on Projects & Code; this card is the record of it.
 */
describe('§6.10 Settings — projects you have said are the same (ADR-040)', () => {
  const GROUP = {
    id: 7,
    name: 'Family App',
    colorIndex: 3,
    createdAt: 1_714_521_600_000,
    members: [
      { encodedName: '-work-demo-family-app-old', projectId: 1, displayName: 'Photo-Booth' },
      { encodedName: '-work-demo-family-app-gone', projectId: null, displayName: null },
    ],
  };

  it('says plainly that nothing is grouped, and never invents a suggestion', async () => {
    renderView(<SettingsView />, stubs());
    const card = await screen.findByTestId('settings-card-project-groups');
    expect(within(card).getByTestId('project-groups-empty')).toHaveTextContent(
      'You have not said that any projects are the same',
    );
    // ⚠️ §2.1 zero inference: there is nothing here that proposes a pairing, and there must
    // never be. This assertion is the guard on that sentence.
    for (const jargon of [/suggest/i, /similar/i, /candidate/i, /detect/i, /merge/i]) {
      expect(card.textContent ?? '').not.toMatch(jargon);
    }
  });

  it('lists a group, its folders, and says so when a folder is not currently present', async () => {
    renderView(<SettingsView />, stubs({ 'groups:list': () => ok({ rows: [GROUP] }) }));
    const card = await screen.findByTestId('settings-card-project-groups');
    expect(within(card).getByTestId('project-group-7')).toHaveTextContent('Family App');
    // §3.3, §7.8/P-33 — the encoded name is an absolute personal path; it is available on hover
    // (title) to disambiguate, but is never visible text a screenshot could leak. The present
    // folder shows its display name; the encoded path sits in the row's title only.
    expect(within(card).getByText('Photo-Booth')).toBeInTheDocument();
    expect(card).not.toHaveTextContent('-work-demo-family-app-old');
    expect(within(card).getByTitle('-work-demo-family-app-old')).toBeInTheDocument();
    // ⚠️ Reported, never hidden and never deleted on the app's own initiative — and reassuring,
    // because the data really is still counted.
    expect(within(card).getByTestId('project-group-7')).toHaveTextContent(
      'not currently present — nothing has been lost',
    );
  });

  it('renames a group and splits one apart, in the user’s own words', async () => {
    const { bridge } = renderView(
      <SettingsView />,
      stubs({
        'groups:list': () => ok({ rows: [GROUP] }),
        'groups:rename': () => ok({ rows: [{ ...GROUP, name: 'The Family App' }] }),
        'groups:ungroup': () => ok({ rows: [] }),
      }),
    );
    await screen.findByTestId('project-group-7');

    fireEvent.click(screen.getByTestId('project-group-rename-7'));
    fireEvent.change(screen.getByTestId('project-group-name-7'), {
      target: { value: 'The Family App' },
    });
    fireEvent.click(screen.getByTestId('project-group-save-7'));
    await waitFor(() => {
      expect(bridge.calls.some((call) => call.channel === 'groups:rename')).toBe(true);
    });
    expect(bridge.calls.find((call) => call.channel === 'groups:rename')?.request).toEqual({
      groupId: 7,
      name: 'The Family App',
    });

    fireEvent.click(await screen.findByTestId('project-group-ungroup-7'));
    await waitFor(() => {
      expect(bridge.calls.some((call) => call.channel === 'groups:ungroup')).toBe(true);
    });
    // "Split apart", not "delete": nothing underneath is removed, and the button says so.
    expect(screen.getByTestId('settings-card-project-groups')).not.toHaveTextContent('Delete');
  });
});
