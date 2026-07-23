// STACK ADR-013 mechanism 1 — per-worker sandbox roots.
//
// `VITEST_POOL_ID` partitions by worker; `fs.mkdtemp` guarantees uniqueness *within* a
// worker. Together they make it impossible for two tests to share a directory, which is
// what turns SQLITE_BUSY and phantom-file failures — which look exactly like flakes — into
// something that cannot happen. A flaky check command is worse than none, because it
// teaches agents to disbelieve it.
//
// NO TEST MAY NAME A FIXED PATH. Fixtures are copied into the sandbox before any mutation,
// so `test/fixtures/**` is never written to and stays diff-clean.

import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/** Every sandbox for every worker lives under this one root, so a stray one is findable. */
export const SANDBOX_ROOT_NAME = 'claude-lens-tests';

export interface Sandbox {
  /** Absolute path to this test's private directory. Valid only inside a test body. */
  readonly path: string;
  /** Resolve a path inside the sandbox. */
  resolve(...segments: string[]): string;
  /** Copy a committed fixture tree into the sandbox before mutating it. */
  copyFixture(fixtureDir: string, destination?: string): Promise<string>;
}

/** The per-worker root: `os.tmpdir()/claude-lens-tests/w<VITEST_POOL_ID>`. */
export function workerRoot(): string {
  const poolId = process.env['VITEST_POOL_ID'] ?? '0';
  return join(tmpdir(), SANDBOX_ROOT_NAME, `w${poolId}`);
}

/**
 * Registers `beforeEach`/`afterEach` hooks that create and remove a unique directory for
 * the current test. Call it at describe scope:
 *
 *   const sandbox = useSandbox();
 *   it('...', () => { open(sandbox.resolve('lens.db')); });
 */
export function useSandbox(): Sandbox {
  let current: string | null = null;

  beforeEach(async () => {
    const root = workerRoot();
    await mkdir(root, { recursive: true });
    current = await mkdtemp(join(root, 'sbx-'));
  });

  afterEach(async () => {
    if (current === null) return;
    const doomed = current;
    current = null;
    await rm(doomed, { recursive: true, force: true });
  });

  const requirePath = (): string => {
    if (current === null) {
      throw new Error(
        'useSandbox(): the sandbox path was read outside a test body. Call useSandbox() at ' +
          'describe scope and read `.path` inside it (STACK ADR-013).',
      );
    }
    return current;
  };

  return {
    get path(): string {
      return requirePath();
    },
    resolve(...segments: string[]): string {
      return resolve(requirePath(), ...segments);
    },
    async copyFixture(fixtureDir: string, destination?: string): Promise<string> {
      const target = resolve(requirePath(), destination ?? 'fixture');
      await cp(fixtureDir, target, { recursive: true });
      return target;
    },
  };
}
