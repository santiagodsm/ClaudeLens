/**
 * STACK ADR-018 — the Playwright config for the Electron smoke suite.
 *
 * ⚠️ **`pnpm run e2e` is NOT part of `pnpm run check` and must never be added to it.** `check`'s
 * defining property is that it is self-contained-green off `pnpm install` alone; this suite needs a
 * built app, the Electron binary and an **interactive macOS GUI session** (there is no Xvfb
 * equivalent on macOS). Folding it in makes `check` inherit all three, and a `check` that fails
 * environmentally teaches agents to disbelieve it — which is worse than having no check.
 *
 * ⚠️ **No `projects` block and no browser here.** Playwright downloads no browser binaries for
 * this repo (ADR-018 precondition 4, verified against the published tarball); Electron
 * automation drives `node_modules/.bin/electron`. Adding a `chromium` project would introduce a
 * network requirement this project does not have.
 *
 * ⚠️ **`forbidOnly` and zero retries.** A smoke gate that retries is a gate that reports a flake
 * as a pass; either the window opens and the eight views render, or the answer is no.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // One Electron app at a time: each spec launches a real window and a real SQLite file, and
  // parallel windows on one GUI session make focus-dependent behaviour non-deterministic.
  workers: 1,
  fullyParallel: false,
  // ⚠️ Never retry. See the header — a retried smoke test launders a flake into a pass.
  retries: 0,
  forbidOnly: true,
  // Generous, because the first run includes a full parse of the fixture tree in a cold process.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    // No `baseURL`, no browser, no tracing of a page that does not exist. The Electron
    // application handle comes from `e2e/support/launch.ts`, per spec.
    actionTimeout: 15_000,
  },
});
