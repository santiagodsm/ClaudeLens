#!/usr/bin/env node
// Runs immediately after `electron-vite build`, inside `pnpm run build`.
//
// STACK ADR-010, and this is the whole reason it exists: esbuild does not typecheck and
// rollup does not warn, so an externalization mistake ships a build that PASSES and then
// throws at runtime. chokidar 5 is ESM-only; electron-vite's `externalizeDepsPlugin` is on
// by default in the scaffolded template, and an externalized ESM-only package `require()`d
// from a CJS main bundle fails the moment the watcher starts — long after `pnpm run check`
// went green.
//
// The assertion is stated over the EMITTED BUNDLE rather than over the config, because the
// config is what someone edits and the bundle is what actually runs.
//
//   · `better-sqlite3` / `better-sqlite3-electron` — the only permitted externals. One
//     package installed twice under two names for the two ABIs (STACK ADR-006); a compiled
//     .node cannot be bundled.
//   · everything else, chokidar above all — must be bundled.
//
// ⚠️ AMENDED 2026-07-22 (integration pass). The native-addon half of this gate asserted the
// wrong shape: it fired on `src/main` SOURCE text and then demanded a static
// `require("better-sqlite3")` in the BUNDLE — the one shape ADR-006 exists to prevent.
// `src/main/db/driver.ts` resolves the module id at RUNTIME
// (`process.versions.electron ? 'better-sqlite3-electron' : 'better-sqlite3'`) through
// `createRequire`, which is precisely why `pnpm run check` can be green under Node's ABI
// while the app runs under Electron's. Rollup therefore never emits — and never can emit —
// a static require for it, so the old assertion was red on a correct tree.
//
// What the gate must actually prove is narrower and stronger, and is what it now asserts:
//   (1) the addon is NOT INLINED — better-sqlite3's own body never enters the bundle; and
//   (2) the addon is still REACHABLE — the specifier survives, either as a real external
//       `require()` or as ADR-006's pair of module-id constants behind `createRequire`.
// Neither of those is satisfiable by a bundle that swallowed the package.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { extname, join } from 'node:path';

const MAIN_OUT = 'out/main';
const MAIN_SRC = 'src/main';
const PERMITTED_EXTERNALS = new Set(['better-sqlite3', 'better-sqlite3-electron']);

/**
 * Proof that better-sqlite3's BODY landed in the bundle rather than its specifier.
 * `better_sqlite3.node` is the addon filename `lib/database.js` hands to `bindings()`; it
 * exists in that file and nowhere else in this dependency tree, so it is a fact about the
 * bundle, not a heuristic. Observed by probe: inlining the addon grows `parse-worker.cjs`
 * from 35 kB to 67 kB, emits this string, and makes the specifier disappear entirely.
 */
const ADDON_INLINED_MARKER = /better_sqlite3\.node/;

// Externalized automatically by electron-vite for every Electron target; not our business.
const ALWAYS_EXTERNAL = new Set([
  'electron',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const problems = [];
const fail = (message) => problems.push(message);

function filesUnder(dir, extensions) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full, extensions));
    else if (extensions.includes(extname(entry.name))) found.push(full);
  }
  return found;
}

const readAll = (files) => files.map((file) => readFileSync(file, 'utf8')).join('\n');

/** Bare specifiers the bundle still reaches for at runtime — i.e. its actual externals. */
function externalsOf(source) {
  const specifiers = new Set();
  const patterns = [
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    // ⚠️ AMENDED 2026-07-22 (E6). The bare `\bfrom\s*["']…["']` this used to be matched any
    // property access spelled `x["from"]` in ordinary bundled code, capturing everything up to
    // the next quote as a "package name". It was latent until `src/main/index.ts` began
    // importing `src/main/db/settings-repo.ts`, whose §4.2 `GlobalFilter` validator reads
    // `candidate['from']` — at which point `pnpm run build` failed with a garbage specifier and
    // a message about `rollupOptions.external`, i.e. red on a correct tree, pointing at the
    // wrong file. A gate that cries wolf is the failure mode this whole script exists to
    // prevent, so the pattern now requires an actual `import`/`export … from` statement.
    /(?:^|[\s;}])(?:import|export)\b[^;\n]{0,400}?\bfrom\s*["']([^"']+)["']/gm,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (ALWAYS_EXTERNAL.has(specifier) || ALWAYS_EXTERNAL.has(packageName)) continue;
      specifiers.add(packageName);
    }
  }
  return specifiers;
}

// --- the build actually produced three bundles -----------------------------

for (const dir of [MAIN_OUT, 'out/preload', 'out/renderer']) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    fail(`${dir}/ was not emitted. Run \`electron-vite build\` before this script.`);
  }
}

if (problems.length === 0) {
  const mainBundleFiles = filesUnder(MAIN_OUT, ['.js', '.cjs', '.mjs']);
  if (mainBundleFiles.length === 0) fail(`${MAIN_OUT}/ contains no JavaScript.`);

  const bundleText = readAll(mainBundleFiles);
  const sourceText = readAll(filesUnder(MAIN_SRC, ['.ts', '.tsx', '.mts', '.cts']));
  const actualExternals = externalsOf(bundleText);

  // --- nothing but the native addon is external ----------------------------

  for (const external of actualExternals) {
    if (PERMITTED_EXTERNALS.has(external)) continue;
    const because =
      external === 'chokidar'
        ? 'chokidar 5 is ESM-only (STACK ADR-010). Externalized, it is `require()`d from a ' +
          'CJS main bundle and throws at runtime — after this build passed. It must be BUNDLED.'
        : `Only ${[...PERMITTED_EXTERNALS].join(' and ')} may be external ` +
          '(STACK ADR-006/ADR-010); everything else is bundled. ' +
          'Check `rollupOptions.external` in electron.vite.config.ts.';
    fail(`main bundle externalizes "${external}". ${because}`);
  }

  // --- positive assertions, live as soon as src/main imports these ---------
  // Until then, a bundle with no reference to either is correct rather than unverified.

  if (/["']chokidar["']/.test(sourceText)) {
    if (actualExternals.has('chokidar')) {
      fail('chokidar must be bundled, not externalized (STACK ADR-010).');
    } else if (!/chokidar|readdirp/.test(bundleText)) {
      fail(
        'src/main imports chokidar but no trace of it appears in the main bundle. ' +
          'It was neither bundled nor externalized, which means it was dropped.',
      );
    }
  }

  // --- the native addon: never inlined, and still reachable ----------------
  //
  // (1) Never inlined. Stated over the bundle alone and unconditional — an inlined addon
  //     body is wrong no matter what src/main says, and this is the half that catches
  //     someone "simplifying" the driver to a single static import.

  if (ADDON_INLINED_MARKER.test(bundleText)) {
    fail(
      "the main bundle contains better-sqlite3's own module body " +
        `(matched ${ADDON_INLINED_MARKER}). A compiled NAN addon cannot be bundled ` +
        '(STACK ADR-006): `bindings()` would then hunt for a .node file that no longer ' +
        'sits beside the code loading it. Both install names must stay in ' +
        '`rollupOptions.external` in electron.vite.config.ts, and the driver must keep ' +
        'resolving the module id at runtime rather than importing it.',
    );
  }

  // (2) Still reachable. Only two shapes are permitted, and only one of them can occur
  //     under ADR-006:
  //       (a) a real external — rollup left a bare `require("better-sqlite3…")` standing; or
  //       (b) ADR-006's dual-ABI loader — BOTH module-id constants survive into the bundle
  //           and are handed to a `createRequire` handle at runtime. `src/main/db/driver.ts`
  //           does exactly this, which is why (a) is never observed and why demanding it
  //           was this gate's own defect.
  //     If neither holds, the specifier is gone: the addon was inlined (already reported
  //     above) or tree-shaken away, and the app opens no database at all.

  if (/["']better-sqlite3(-electron)?["']/.test(sourceText)) {
    const externalized = [...actualExternals].some((name) => PERMITTED_EXTERNALS.has(name));
    const bothModuleIdsSurvive = [...PERMITTED_EXTERNALS].every((id) =>
      new RegExp(`["']${id}["']`).test(bundleText),
    );
    const viaCreateRequire = /\bcreateRequire\b/.test(bundleText);

    if (!externalized && !(bothModuleIdsSurvive && viaCreateRequire)) {
      const detail = bothModuleIdsSurvive
        ? 'both module ids survive but nothing in the bundle calls `createRequire`, so ' +
          'neither is ever loaded'
        : 'the module ids do not both survive into the bundle';
      fail(
        'src/main references better-sqlite3, but the main bundle neither externalizes it ' +
          `nor reaches it through ADR-006's dual-ABI loader — ${detail}. ` +
          'A compiled NAN addon cannot be bundled (STACK ADR-006); it must be reached as a ' +
          'runtime module id (`process.versions.electron ? … : …`) via `createRequire`, or ' +
          'left external.',
      );
    }
  }
}

if (problems.length > 0) {
  console.error('\ncheck-bundle-externals: the main bundle violates STACK ADR-010.\n');
  for (const problem of problems) console.error(`  ✖ ${problem}\n`);
  process.exit(1);
}

console.log(
  'check-bundle-externals: main bundle clean — native addon not inlined and still reachable ' +
    `(${[...PERMITTED_EXTERNALS].join(' / ')}, ADR-006); nothing else externalized.`,
);
