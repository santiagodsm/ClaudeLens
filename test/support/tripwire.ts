// STACK ADR-013 mechanism 3 — the home-directory tripwire.
//
// Loaded as a `setupFiles` entry by EVERY Vitest project (see vitest.config.ts). It
// resolves the real home directory ONCE, at load, and throws immediately if any path handed
// to a scanner, a parser or a guarded action resolves under `<home>/.claude`.
//
// This app deletes files. A test that resolves the real `~/.claude` is not a flaky test, it
// is data loss on the author's own machine.
//
// ⚠️ This mechanism is Vitest-only and does NOT cover `pnpm run e2e`, which launches the real
// application in a separate process where setup files never load. STACK ADR-018 extends it:
// the same assertion lives in `src/main/config/paths.ts` as production code under
// `CLAUDE_LENS_E2E=1`. Read ADR-013 and ADR-018 together; neither is complete alone.
//
// The real `os.homedir()` call is imported from `src/main/config/paths.ts` rather than made
// here, so that INV-17 stays literally true: the call appears in exactly one file.

import { realClaudeHome, assertNotUnderRealClaudeHome } from '../../src/main/config/paths';

/** Resolved once, at setup-file load, exactly as ADR-013 specifies. */
export const REAL_CLAUDE_HOME: string = realClaudeHome();

/**
 * Throws if `candidate` resolves to the real `<home>/.claude` or anything beneath it.
 * Returns the resolved path so it can be used inline:
 *
 *   const root = assertSandboxed('claudeDir', sandbox.resolve('claude'));
 */
export function assertSandboxed(label: string, candidate: string): string {
  return assertNotUnderRealClaudeHome(label, candidate);
}

declare global {
  // `var` is required here: it is the only declaration form that augments globalThis.
  var __claudeLensTripwire: typeof assertSandboxed | undefined;
}

// Exposed globally so a scanner/parser/action entry point landed by a later epic can assert
// its injected root without importing test code (STACK ADR-013).
globalThis.__claudeLensTripwire = assertSandboxed;

// `CLAUDE_LENS_DATA_DIR` is INJECTED in tests, never defaulted. If something has already set
// it — a stray shell export, a launcher, a fixture helper — it is checked before a single
// test runs, rather than after the first delete.
const injectedDataDir = process.env['CLAUDE_LENS_DATA_DIR'];
if (injectedDataDir !== undefined && injectedDataDir !== '') {
  assertSandboxed('CLAUDE_LENS_DATA_DIR', injectedDataDir);
}
