// Gives the `shared` Vitest project (node, threads — STACK ADR-012) something real to run.

import { describe, expect, it } from 'vitest';
import { APP_NAME, APP_VERSION } from '../../src/shared/version';

describe('src/shared/version', () => {
  it('states the product name once, for the window title and the shell', () => {
    expect(APP_NAME).toBe('Claude Lens');
  });

  it('states a semver-shaped version that `docs-sync` keeps in step with package.json', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
