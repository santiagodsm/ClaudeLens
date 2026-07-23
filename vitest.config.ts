import { defineConfig } from 'vitest/config';

/**
 * STACK ADR-012 — three projects, split by process, because main and renderer are
 * genuinely different runtimes and one config cannot serve both.
 *
 *   project    environment   pool      scope
 *   main       node          forks     src/main/**, parser, worker, SQLite, migrations,
 *                                      pricing, guarded actions, integration tests
 *   renderer   jsdom         threads   src/renderer/** components and hooks
 *   shared     node          threads   src/shared/** — IPC types, pure functions, formatters
 *
 * `pool: 'forks'` for `main` is deliberate and non-default: that project loads a NAN-based
 * native addon (ADR-006) and drives real files, and child-process isolation avoids the
 * addon-in-worker-isolate class of problem entirely.
 *
 * `projects` — not the `workspace` field, which is deprecated since Vitest 3.2.
 */

// e2e/ runs under Playwright via `npm run e2e` and is excluded from every glob here
// (STACK ADR-018). It is not a Vitest project and must never become one.
const ALWAYS_EXCLUDE = [
  '**/node_modules/**',
  '**/out/**',
  '**/dist/**',
  '**/coverage/**',
  'e2e/**',
  '**/e2e/**',
  'test/fixtures/**',
];

// STACK ADR-013 mechanism 3: loaded by EVERY project. Resolves the real os.homedir()
// once and throws immediately if any path handed to a scanner, parser or guarded action
// resolves under <home>/.claude. This app deletes files.
const TRIPWIRE = './test/support/tripwire.ts';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          pool: 'forks',
          setupFiles: [TRIPWIRE],
          include: [
            'src/main/**/*.{test,spec}.ts',
            'test/support/**/*.{test,spec}.ts',
            'test/main/**/*.{test,spec}.ts',
            'test/metrics/**/*.{test,spec}.ts',
            'test/integration/**/*.{test,spec}.ts',
          ],
          exclude: ALWAYS_EXCLUDE,
        },
      },
      {
        // Vite's esbuild cannot discover `jsx` from the root solution tsconfig, which has no
        // compilerOptions. Stated here so .tsx transforms identically under Vitest and under
        // `electron-vite build` (see electron.vite.config.ts).
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          pool: 'threads',
          setupFiles: [TRIPWIRE, './test/support/renderer-setup.ts'],
          include: [
            'src/renderer/**/*.{test,spec}.{ts,tsx}',
            'test/renderer/**/*.{test,spec}.{ts,tsx}',
          ],
          exclude: ALWAYS_EXCLUDE,
        },
      },
      {
        test: {
          name: 'shared',
          environment: 'node',
          pool: 'threads',
          setupFiles: [TRIPWIRE],
          include: ['src/shared/**/*.{test,spec}.ts', 'test/shared/**/*.{test,spec}.ts'],
          exclude: ALWAYS_EXCLUDE,
        },
      },
    ],

    // STACK ADR-014: coverage is reported, never thresholded. A coverage percentage is a
    // proxy the PRD distrusts — a 90% line-coverage gate passes on a suite with zero correct
    // expected values. `golden-fixture-review` is the real bar. Do not add `thresholds`.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/renderer/main.tsx'],
    },
  },
});
