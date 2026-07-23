// Proves STACK ADR-013 mechanism 1 actually holds. Without this, `useSandbox()` is a
// helper nobody has checked, and the first symptom of it being wrong is a deleted
// directory somebody cared about.

import { stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SANDBOX_ROOT_NAME, useSandbox, workerRoot } from './sandbox';

describe('useSandbox', () => {
  const sandbox = useSandbox();
  const seen: string[] = [];
  let lastPath = '';

  it('creates a directory partitioned by VITEST_POOL_ID under the OS temp root', async () => {
    seen.push(sandbox.path);

    // The worker partition — this is the half that stops two workers colliding.
    const poolId = process.env['VITEST_POOL_ID'] ?? '0';
    expect(workerRoot()).toBe([tmpdir(), SANDBOX_ROOT_NAME, `w${poolId}`].join(sep));
    expect(sandbox.path.startsWith(workerRoot() + sep)).toBe(true);

    // Never anywhere but the OS temp root.
    expect(sandbox.path.startsWith(tmpdir() + sep)).toBe(true);

    // It really exists, and it is really writable.
    await writeFile(sandbox.resolve('lens.db'), 'x');
    expect((await stat(sandbox.path)).isDirectory()).toBe(true);

    lastPath = sandbox.path;
  });

  it('gives a different directory to every test — mkdtemp uniqueness within one worker', () => {
    seen.push(sandbox.path);
    expect(sandbox.path).not.toBe(lastPath);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('removes the previous test directory in afterEach', async () => {
    expect(lastPath).not.toBe('');
    await expect(stat(lastPath)).rejects.toThrow();
  });

  afterAll(() => {
    // Two distinct paths under one worker root is the whole claim.
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});

describe('sandbox.resolve', () => {
  const sandbox = useSandbox();

  it('resolves inside the sandbox, so no test can name a fixed path by accident', () => {
    expect(sandbox.resolve('db', 'lens.db')).toBe([sandbox.path, 'db', 'lens.db'].join(sep));
    expect(sandbox.resolve('db', 'lens.db').startsWith(sandbox.path + sep)).toBe(true);
  });
});
