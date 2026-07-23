import { defineConfig } from 'electron-vite';
import tailwindcss from '@tailwindcss/vite';

/**
 * STACK ADR-010: `better-sqlite3` is the ONLY external. Everything else — chokidar
 * above all — is bundled into the main-process output.
 *
 * chokidar 5 is ESM-only. electron-vite's `externalizeDepsPlugin` is on by default in
 * the scaffolded template and would externalize it; an externalized ESM-only package
 * `require()`d from a CJS main bundle throws at runtime, *after* the build passes.
 * That is why this config sets `rollupOptions.external` explicitly instead of using
 * `externalizeDepsPlugin`, and why `scripts/check-bundle-externals.mjs` re-asserts it
 * against the emitted bundle on every `npm run build`.
 *
 * Both install names are listed because they are the same package installed twice under
 * two names for the two ABIs (STACK ADR-006). A compiled `.node` cannot be bundled.
 */
const NATIVE_EXTERNALS = ['better-sqlite3', 'better-sqlite3-electron'];

/**
 * Main and preload are emitted as CommonJS, with an explicit `.cjs` extension because
 * package.json declares `"type": "module"`.
 *
 * Two reasons, both load-bearing:
 *   · STACK ADR-010 states the failure model in terms of "an externalized ESM-only package
 *     `require()`d from a CJS main bundle". CJS main is the model the ADR is written against
 *     and the one `better-sqlite3` — a CJS NAN addon loaded through `bindings` — is safest in.
 *   · A sandboxed preload (`sandbox: true`, STACK ADR-003) cannot be an ES module. Electron
 *     only loads ESM preloads when the sandbox is off, which is not an option here.
 *
 * Left to itself, electron-vite emits ESM for both because of `"type": "module"`, and
 * `__dirname` then silently does not exist in a bundle that built cleanly.
 */
const CJS_OUTPUT = { format: 'cjs' as const, entryFileNames: '[name].cjs' };

/**
 * ⚠️ `externalizeDeps: false` is the load-bearing line, and it is not the one you would guess.
 *
 * electron-vite applies `externalizeDepsPlugin` to main and preload **by default** —
 * `build.externalizeDeps` defaults to `true`, and the plugin adds EVERY key of
 * `package.json#dependencies` (plus a `^(dep1|dep2|…)/.+` subpath regex) to
 * `rollupOptions.external`. Setting `rollupOptions.external` yourself does not undo that:
 * electron-vite merges the two arrays, so your list is additive, not authoritative.
 *
 * Verified empirically while scaffolding: with `external: ['better-sqlite3', …]` and nothing
 * else, `import { watch } from 'chokidar'` still emitted `require("chokidar")` into the CJS
 * main bundle — the exact ADR-010 failure, in a build that reported success. Turning the
 * option off makes the external list mean what it says.
 */
const BUNDLE_EVERYTHING_BUT_NATIVE = {
  build: {
    // ADR-010: the externals list is ours, not package.json's.
    externalizeDeps: false,
    rollupOptions: {
      external: NATIVE_EXTERNALS,
      output: CJS_OUTPUT,
    },
  },
};

/**
 * DESIGN §7.2 — the main process owns a `worker_threads` parse worker, so the main target
 * emits TWO chunks: the process entry and the worker entry.
 *
 * The worker cannot be reached through the main bundle: `new Worker(path)` needs a real file
 * on disk that Node can load on its own. Leaving it out produces a build that passes and an
 * app whose first sync throws `ERR_MODULE_NOT_FOUND` — the ADR-010 failure mode, one layer
 * up. `parse-worker.cjs` is emitted beside `index.cjs`; the main process passes its absolute
 * path to `ParseWorkerClient` (which never resolves its own location — INV-17's shape).
 */
const MAIN_ENTRIES = {
  index: 'src/main/index.ts',
  'parse-worker': 'src/main/worker/parse-worker.ts',
};

export default defineConfig({
  main: {
    ...BUNDLE_EVERYTHING_BUT_NATIVE,
    build: {
      ...BUNDLE_EVERYTHING_BUT_NATIVE.build,
      rollupOptions: {
        ...BUNDLE_EVERYTHING_BUT_NATIVE.build.rollupOptions,
        input: MAIN_ENTRIES,
      },
    },
  },
  preload: BUNDLE_EVERYTHING_BUT_NATIVE,
  renderer: {
    // Tailwind 4 is CSS-first. There is deliberately NO `tailwind.config.js` (STACK ADR-004,
    // DESIGN §6.1) — the token layer lives in `src/renderer/styles/tokens.css`.
    plugins: [tailwindcss()],
    // The root `tsconfig.json` is a solution file with no `compilerOptions`, so esbuild
    // cannot discover `jsx` from it. Stated here so `.tsx` transforms the same way in
    // `electron-vite build`, `electron-vite dev` and the Vitest `renderer` project.
    esbuild: {
      jsx: 'automatic',
    },
  },
});
