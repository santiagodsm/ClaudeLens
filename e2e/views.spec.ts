/**
 * STACK ADR-018 — the smoke suite's second half: **each of the eight views navigates and renders
 * its primary content without an error boundary or a console error.**
 *
 * ⚠️ This is the spec that would have caught the E4↔E6 gap from the outside. Seventeen `q:*`
 * channels returned `notImplemented` over a finished data layer, and five of the eight views
 * rendered an `ErrorState` in the running app while every Vitest project was green. `pnpm run
 * check` cannot see that: `build` proves the bundles compile and the `renderer` project proves
 * components mount under jsdom against **stubbed** channels. Only a real window over a real main
 * process answers the question.
 *
 * ⚠️ **Read-only by construction** (ADR-018 extension 3). The Harness Manager view below is
 * asserted to *render*. It is not clicked, no action is previewed, nothing is deleted, backed up,
 * undone or cleared. There is no code path in `e2e/` that reaches a guarded action.
 *
 * ⚠️ **Selects on `nav-<id>`, `view-<id>` and `view-<id>-primary`** — E7's ADR-018 hooks. Never
 * on copy or styling.
 */

import { expect, test } from '@playwright/test';
import { completeOnboarding, launchApp, type LaunchedApp } from './support/launch';

/** §6.2's eight nav items, in order. There is no ninth — onboarding is a shell state. */
const VIEWS = [
  'overview',
  'tokens',
  'sessions',
  'tools',
  'graphs',
  'projects',
  'harness',
  'settings',
] as const;

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
  await completeOnboarding(launched);
});

test.afterEach(async () => {
  await launched.close();
});

test('all eight views navigate and render their primary content', async () => {
  const { window } = launched;

  for (const view of VIEWS) {
    await window.getByTestId(`nav-${view}`).click();

    // The view mounted…
    await expect(window.getByTestId(`view-${view}`)).toBeVisible();
    // …and its primary region rendered, which is the part that needs a channel to have answered.
    await expect(window.getByTestId(`view-${view}-primary`)).toBeVisible();

    // ⚠️ **No error boundary.** `ViewErrorBoundary` renders `view-<id>-error` when a view throws
    // on mount — the exact failure a real Chromium/Electron environment surfaces and jsdom does
    // not (a preload boundary violation, a missing handler, a `node:` import).
    await expect(window.getByTestId(`view-${view}-error`)).toHaveCount(0);
  }
});

test('⚠️ no view renders an ErrorState over the seeded dataset', async () => {
  const { window } = launched;

  // ⚠️ This is the assertion that fails when a channel is registered but not implemented. E7's
  // views degrade a channel error to an `ErrorState` — never to zeroes — so an `ErrorState` here
  // means a `q:*` channel refused over a dataset the parser has just filled. That is a defect,
  // and stating it as one is the whole point of the gate.
  //
  // ⚠️⚠️ **Selected on `[data-state="error"]`, NOT on `data-testid="error-state"`** — and that
  // distinction was found by probing, not by reading. Every view gives its per-card `ErrorState`
  // its own testid (`overview-tiles-error`, `tokens-cost-error`, …), so the default-testid
  // selector matched nothing and this test passed green with `q:overviewTiles` deliberately
  // broken. `data-state="error"` is set by `ErrorState` itself on every instance, whatever its
  // testid, so it cannot be opted out of by a card that names its own hook.
  // ⚠️ Verified by probe in both directions: with one channel reverted to a refusal, this test
  // fails and names the code; with it restored, it passes.
  for (const view of VIEWS) {
    await window.getByTestId(`nav-${view}`).click();
    await expect(window.getByTestId(`view-${view}-primary`)).toBeVisible();
    const errors = window.getByTestId(`view-${view}`).locator('[data-state="error"]');
    // Reported with the error codes, so a red run says WHICH channel refused rather than "1 ≠ 0".
    const codes = await errors.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-error-code') ?? '?'),
    );
    expect(codes, `${view} rendered an ErrorState over seeded data`).toEqual([]);
  }
});

test('⚠️ visiting every view logs no console error', async () => {
  const { window } = launched;
  for (const view of VIEWS) {
    await window.getByTestId(`nav-${view}`).click();
    await expect(window.getByTestId(`view-${view}-primary`)).toBeVisible();
  }
  expect(launched.consoleErrors).toEqual([]);
});

test('the Harness Manager renders, and is never asked to act (ADR-018 extension 3)', async () => {
  const { window } = launched;
  await window.getByTestId('nav-harness').click();
  await expect(window.getByTestId('view-harness-primary')).toBeVisible();
  // ⛔ INV-13 — every count on this view is all time, and the view says so on its own surface.
  // Asserted here because it is a *safety* label: a skill deleted because it looked unused this
  // month is the irreversible mistake the rule prevents.
  await expect(window.getByTestId('view-harness')).toContainText('all time');
  // ⚠️ Nothing below this line clicks anything. The delete subsystem is covered by Vitest
  // integration tests against sandboxes, where ADR-013's isolation fully applies.
});
