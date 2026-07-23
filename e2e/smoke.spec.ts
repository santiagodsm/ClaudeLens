/**
 * STACK ADR-018 — the smoke suite's first half: the app launches, onboarding accepts a fixture
 * directory, a sync completes against it, and the theme toggle flips `data-theme`.
 *
 * ⚠️ **A smoke suite and nothing more.** Not an interaction suite, not a visual-regression
 * suite, and **not where metric correctness is verified** — that belongs to the golden fixtures
 * (§5.9.1), which are cheaper, faster and far more precise. Nothing here asserts a number.
 *
 * ⚠️ **Read-only by construction** (ADR-018 extension 3). No spec in `e2e/` invokes a guarded
 * action: no delete, no backup, no undo, no clear-backups. The Harness Manager view is asserted
 * to *render*, not to *act*. That removes the capability rather than guarding it, which is why
 * it is the strongest of the three protections.
 *
 * ⚠️ **Selects on ADR-018's `data-testid` hooks only** — `app-shell`, `view-<id>`,
 * `view-<id>-primary`, `theme-toggle`. Never on copy and never on styling: both churn, and a
 * gate that breaks on a wording change is a gate that gets deleted.
 */

import { expect, test } from '@playwright/test';
import { completeOnboarding, launchApp, type LaunchedApp } from './support/launch';

let launched: LaunchedApp;

test.beforeEach(async () => {
  // ⚠️ A fresh sandbox per spec (ADR-018 extension 2). `launchApp` asserts it is under
  // `os.tmpdir()` before the app is spawned, and throws rather than skipping if it is not.
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.close();
});

test('the app launches and a window appears', async () => {
  const { window } = launched;
  await expect(window.getByTestId('app-shell')).toBeVisible();
  // §6.11's blocking screen must NOT be what came up. A FATAL dataset renders this instead of
  // the shell, and it would otherwise satisfy "a window appeared".
  await expect(window.getByTestId('fatal-surface')).toHaveCount(0);
});

test('onboarding accepts a fixture directory and a sync completes against it', async () => {
  const { window } = launched;

  // §6.2 — onboarding is a state of the shell, not a ninth view.
  await expect(window.getByTestId('onboarding')).toBeVisible();
  await expect(window.getByTestId('app-shell')).toHaveAttribute('data-dir-status', 'unset');

  await completeOnboarding(launched);

  // §5.1 — a valid directory transitions the shell out of onboarding and starts a sync.
  await expect(window.getByTestId('app-shell')).toHaveAttribute('data-dir-status', 'valid');
  await expect(window.getByTestId('onboarding')).toHaveCount(0);

  // §4.4 / §6.2 — the sidebar footer reports the completed cycle. Waiting on the footer rather
  // than a fixed sleep, so the assertion is about the sync and not about the clock.
  await expect(window.getByTestId('sync-status')).toBeVisible();

  // The Overview's primary region rendered, which it can only do once a `q:*` channel answered.
  await expect(window.getByTestId('view-overview-primary')).toBeVisible();
});

test('the theme toggle flips data-theme', async () => {
  const { window } = launched;
  await completeOnboarding(launched);

  const root = window.locator('html');
  const before = await root.getAttribute('data-theme');
  expect(before === 'dark' || before === 'light').toBe(true);

  await window.getByTestId('theme-toggle').click();
  await expect(root).toHaveAttribute('data-theme', before === 'dark' ? 'light' : 'dark');

  // …and back, so the toggle is a toggle rather than a one-way switch.
  await window.getByTestId('theme-toggle').click();
  await expect(root).toHaveAttribute('data-theme', before ?? 'dark');
});

test('⚠️ the window logs no console error during a normal launch', async () => {
  await completeOnboarding(launched);
  // ADR-018's clause, applied to the launch path itself. A preload boundary violation, a
  // missing IPC handler or a `node:` import jsdom tolerated all surface here and nowhere in
  // `npm run check`.
  expect(launched.consoleErrors).toEqual([]);
});
