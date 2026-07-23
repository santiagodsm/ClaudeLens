// Proves STACK ADR-013 mechanism 3 actually throws. A tripwire nobody has fired is a
// tripwire you believe you have and don't — and the subsystem behind it deletes files.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REAL_CLAUDE_HOME, assertSandboxed } from './tripwire';
import { useSandbox } from './sandbox';

describe('the home-directory tripwire', () => {
  const sandbox = useSandbox();

  it('throws for the real Claude data directory itself', () => {
    expect(() => assertSandboxed('claudeDir', REAL_CLAUDE_HOME)).toThrow(
      /resolved inside the real Claude data directory/,
    );
  });

  it('throws for anything beneath the real Claude data directory', () => {
    for (const relative of ['projects', 'skills/x/SKILL.md', 'history.jsonl']) {
      expect(() => assertSandboxed('claudeDir', join(REAL_CLAUDE_HOME, relative))).toThrow(
        /Refusing to continue/,
      );
    }
  });

  it('throws for a traversal that resolves back into the real Claude data directory', () => {
    const sneaky = join(REAL_CLAUDE_HOME, 'projects', '..', 'skills');
    expect(() => assertSandboxed('claudeDir', sneaky)).toThrow();
  });

  it('names the offending path, so the failure is actionable', () => {
    expect(() => assertSandboxed('claudeDir', REAL_CLAUDE_HOME)).toThrow(
      new RegExp(REAL_CLAUDE_HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('permits a sandbox path, and returns it resolved', () => {
    const root = sandbox.resolve('claude-fixture');
    expect(assertSandboxed('claudeDir', root)).toBe(root);
  });

  it('permits a sibling directory whose name merely starts the same way', () => {
    // `<home>/.claude-lens-backups` is NOT under `<home>/.claude`; a naive startsWith()
    // without the separator check would wrongly reject it.
    expect(() => assertSandboxed('archiveRoot', `${REAL_CLAUDE_HOME}-lens-backups`)).not.toThrow();
  });

  it('is installed on globalThis for entry points landed by later epics', () => {
    expect(globalThis.__claudeLensTripwire).toBe(assertSandboxed);
  });
});
