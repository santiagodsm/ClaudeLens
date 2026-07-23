/**
 * STACK ADR-018 — the Electron launcher for the smoke suite, and the three safety extensions.
 *
 * ⚠️⚠️ **This is the one context in the project where a mistake reaches the delete subsystem.**
 * ADR-013's Vitest `setupFiles` tripwire does not run here: `npm run e2e` launches the real
 * application in a **separate process**, where no Vitest setup file ever loads. Read ADR-013 and
 * ADR-018 together; neither is complete alone. Three protections, all required, all present here:
 *
 *   1. **The production tripwire** — `assertE2eStartupSafety()` in `src/main/config/paths.ts`
 *      exits non-zero if either the Claude data directory or `userData` resolves under the real
 *      `<home>/.claude`. It is armed by `CLAUDE_LENS_E2E=1`, which this file sets.
 *   2. **This launcher asserts before spawning.** A fresh sandbox per spec, under `os.tmpdir()`,
 *      checked with a containment test — and it refuses to launch otherwise. `--user-data-dir`
 *      is redirected so the run cannot touch the developer's real `claude-lens.db`, which lives
 *      in `app.getPath('userData')` and is **not** under `~/.claude`, so protection 1 does not
 *      cover it.
 *   3. **The suite is read-only by construction** — see `e2e/*.spec.ts`. No spec invokes a
 *      guarded action. That is the strongest of the three, because it removes the capability
 *      rather than guarding it.
 *
 * ⚠️ **It fails loudly rather than skipping** (§12.2). A missing build, a missing Electron
 * binary or an unsafe sandbox throws with an actionable message. A silently-skipped gate reads
 * as coverage, which is worse than no gate.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/** The repository root, from this file's own location. Never a configured path. */
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Every E2E sandbox lives under this one root, so a stray one is findable and removable. */
const SANDBOX_ROOT_NAME = 'claude-lens-e2e';

/** ADR-018 precondition 1 — `e2e` runs against the build output, never against source. */
const MAIN_BUNDLE = join(REPO_ROOT, 'out', 'main', 'index.cjs');

/** ADR-018 precondition 2 — installed by `npm ci` via the existing `electron` devDependency. */
const ELECTRON_BINARY = join(REPO_ROOT, 'node_modules', '.bin', 'electron');

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly window: Page;
  /** The synthetic Claude data directory the app is pointed at. Under `os.tmpdir()`, always. */
  readonly claudeFixtureDir: string;
  /** Console messages of severity `error`, collected for ADR-018's "no console error" clause. */
  readonly consoleErrors: string[];
  close(): Promise<void>;
}

/** True if `child` is `parent` itself or anything beneath it. Resolved on both sides. */
function isSameOrInside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const candidate = resolve(child);
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * ⚠️ Protection 2, stated as an assertion rather than a convention. Called immediately before
 * the spawn, on the exact strings that are about to be handed to the app.
 */
function assertUnderTmp(label: string, candidate: string): string {
  const resolved = resolve(candidate);
  if (!isSameOrInside(tmpdir(), resolved)) {
    throw new Error(
      `[claude-lens e2e] ${label} is not under os.tmpdir() and the app will not be launched. ` +
        'This application deletes files; every E2E run operates on a sandbox (STACK ADR-018 ' +
        `extension 2, ADR-013). Refusing: ${resolved}`,
    );
  }
  return resolved;
}

/** ADR-018's preconditions, checked with a message that says what to run (§12.2). */
function assertPreconditions(): void {
  if (!existsSync(MAIN_BUNDLE)) {
    throw new Error(
      `[claude-lens e2e] no build output at ${MAIN_BUNDLE}. ` +
        '`npm run e2e` runs `npm run build` first; run it, or run the build by hand. ' +
        'The smoke suite tests the built app, never source (STACK ADR-018 precondition 1).',
    );
  }
  if (!existsSync(ELECTRON_BINARY)) {
    throw new Error(
      `[claude-lens e2e] no Electron binary at ${ELECTRON_BINARY}. Run \`npm ci\`. ` +
        '(STACK ADR-018 precondition 2 — the binary comes from the `electron` devDependency; ' +
        'Playwright downloads no browsers for this project.)',
    );
  }
}

/**
 * A tiny synthetic Claude data directory, written into the sandbox at run time.
 *
 * ⚠️ **Synthetic, and generated rather than committed.** P-33 forbids real `.claude` content and
 * any personal path in a tracked file; generating it here keeps the repo clean and keeps the
 * fixture from drifting into a second, unversioned copy of `test/fixtures/**`.
 *
 * It satisfies §4.3's validation rule ("must contain `projects/` and/or `history.jsonl`") and
 * carries enough for a sync to produce events, a session, a project, a subagent run, tool calls
 * and a prompt — so the eight views render content rather than empty states.
 */
async function writeClaudeFixture(dir: string): Promise<void> {
  const project = join(dir, 'projects', '-work-demo-alpha');
  await mkdir(join(project, 'sess-e2e', 'subagents'), { recursive: true });

  const transcript = [
    '{"type":"user","uuid":"e2e-u1","timestamp":"2026-03-02T09:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"go"}]}}',
    '{"type":"assistant","uuid":"e2e-m1","timestamp":"2026-03-02T09:01:00.000Z","message":{"role":"assistant","model":"claude-test-1","usage":{"input_tokens":100,"output_tokens":200,"cache_creation_input_tokens":10,"cache_read_input_tokens":1000},"content":[{"type":"tool_use","id":"e2e-t1","name":"Agent","input":{"subagent_type":"worker","description":"sub work"}},{"type":"tool_use","id":"e2e-t2","name":"Read","input":{"file_path":"src/demo.ts"}}]}}',
    '{"type":"assistant","uuid":"e2e-m2","timestamp":"2026-03-02T09:12:00.000Z","message":{"role":"assistant","model":"claude-test-1","usage":{"input_tokens":7,"output_tokens":11,"cache_creation_input_tokens":0,"cache_read_input_tokens":3},"content":[{"type":"tool_use","id":"e2e-t3","name":"Edit","input":{"file_path":"src/demo.ts"}}]}}',
  ].join('\n');
  await writeFile(join(project, 'sess-e2e.jsonl'), `${transcript}\n`, 'utf8');

  const subagent = [
    '{"type":"assistant","uuid":"e2e-s1","timestamp":"2026-03-02T09:03:00.000Z","message":{"role":"assistant","model":"claude-test-1","usage":{"input_tokens":20,"output_tokens":30,"cache_creation_input_tokens":4,"cache_read_input_tokens":500},"content":[{"type":"tool_use","id":"e2e-t4","name":"Grep","input":{}}]},"parentUuid":"e2e-m1"}',
  ].join('\n');
  await writeFile(join(project, 'sess-e2e', 'subagents', 'run-1.jsonl'), `${subagent}\n`, 'utf8');

  // §3.9 — one prompt, so the graph inspector has a preview to show. No `pastedContents`.
  await writeFile(
    join(dir, 'history.jsonl'),
    '{"display":"add a demo module","timestamp":1772442000000,"project":"/work/demo/alpha","sessionId":"sess-e2e"}\n',
    'utf8',
  );

  // §6.9 / BR-01 — something for the Harness Manager and the Harness Map to find.
  await mkdir(join(dir, 'skills', 'demo-skill'), { recursive: true });
  await writeFile(
    join(dir, 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: A synthetic skill for the smoke suite.\nallowed-tools: [Read, Grep]\n---\n\nIt reads and greps.\n',
    'utf8',
  );
  await writeFile(join(dir, 'CLAUDE.md'), '# synthetic smoke-suite harness file\n', 'utf8');
}

/**
 * Launches the built app against a fresh sandbox, and returns the first window.
 *
 * ⚠️ `CLAUDE_LENS_DATA_DIR` is **injected, never defaulted** (ADR-013 belt 2). The main process
 * reads it in exactly two places: `assertE2eStartupSafety()`, and — only under
 * `CLAUDE_LENS_E2E=1` — the directory picker, so onboarding runs its real flow without a native
 * dialog no automation can drive.
 */
export async function launchApp(): Promise<LaunchedApp> {
  assertPreconditions();

  const root = join(tmpdir(), SANDBOX_ROOT_NAME);
  await mkdir(root, { recursive: true });
  const sandbox = await mkdtemp(join(root, 'run-'));

  // ⚠️ Assert BEFORE building anything inside it, and again on the exact values passed to the app.
  assertUnderTmp('the E2E sandbox', sandbox);
  const claudeFixtureDir = assertUnderTmp('CLAUDE_LENS_DATA_DIR', join(sandbox, 'claude-fixture'));
  const userDataDir = assertUnderTmp('--user-data-dir', join(sandbox, 'userdata'));

  await mkdir(claudeFixtureDir, { recursive: true });
  await mkdir(userDataDir, { recursive: true });
  await writeClaudeFixture(claudeFixtureDir);

  const app = await electron.launch({
    executablePath: ELECTRON_BINARY,
    cwd: REPO_ROOT,
    // `.` is the packaged entry point — `package.json`'s `main`, i.e. `out/main/index.cjs`.
    // `--user-data-dir` is protection 2's second half: `app.getPath('userData')` is where
    // `claude-lens.db` lives (§9.3), and it is NOT under `~/.claude`.
    args: ['.', `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      CLAUDE_LENS_E2E: '1',
      CLAUDE_LENS_DATA_DIR: claudeFixtureDir,
      // The dev server must not be picked up: this suite drives the BUILT renderer (ADR-018).
      ELECTRON_RENDERER_URL: '',
    },
  });

  const window = await app.firstWindow();
  const consoleErrors: string[] = [];
  window.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  window.on('pageerror', (error) => {
    consoleErrors.push(`pageerror: ${error.message}`);
  });

  return {
    app,
    window,
    claudeFixtureDir,
    consoleErrors,
    async close(): Promise<void> {
      await app.close();
      // The sandbox is under `os.tmpdir()` and was asserted so before anything was written to it.
      await rm(sandbox, { recursive: true, force: true });
    },
  };
}

/**
 * Drives §6.2's onboarding to completion and waits for the first sync to finish.
 *
 * ⚠️ The real flow: the real button, the real `dir:pick`, the real `settings:set claudeDir`, the
 * real §5.1 transition and the real parser. Nothing is stubbed. The only concession to
 * automation is that the *dialog* returns `CLAUDE_LENS_DATA_DIR` instead of opening a native
 * panel — see `src/main/index.ts`.
 */
export async function completeOnboarding(launched: LaunchedApp): Promise<void> {
  const { window } = launched;
  await window.getByTestId('app-shell').waitFor({ state: 'visible' });
  const onboarding = window.getByTestId('onboarding');
  if (await onboarding.isVisible()) {
    await window.getByTestId('pick-directory').click();
  }
  // §5.1 — the shell leaves the onboarding state only when `dirStatus` becomes `valid`.
  await window.getByTestId('app-shell').and(window.locator('[data-dir-status="valid"]')).waitFor();
  // §4.4 — the sync cycle returns to `idle` when it is done. `sync-status` is the sidebar footer.
  await window.getByTestId('view-overview').waitFor({ state: 'visible' });
}
