// `src/main/config/paths.ts` — INV-17, INV-19, §9.3, and the ADR-018 production tripwire.
//
// ⚠️ Nothing in this file creates, reads or writes anything under the real `<home>/.claude`.
// The tripwire assertions are pure string work: a path is composed and handed to a predicate
// that throws. That is deliberate — a test that proves the delete-guard works by touching the
// directory it guards is not a test, it is the incident.

import { describe, expect, it } from 'vitest';
import { basename, join } from 'node:path';
import {
  BACKUP_ROOT_NAME,
  DATABASE_FILE_NAME,
  LOG_FILE_NAME,
  archiveRootProblem,
  assertDatabaseOutsideClaudeDir,
  assertE2eStartupSafety,
  backupRoot,
  databasePath,
  isSameOrInside,
  isUnderBackupRoot,
  isUnderRealClaudeHome,
  logFilePath,
  pinUserDataDir,
  realClaudeHome,
  realHomeDir,
  suggestedClaudeDataDir,
  USER_DATA_DIR_NAME,
  userDataPinTarget,
} from '../../../src/main/config/paths';
import { useSandbox } from '../../support/sandbox';

/** Restores `CLAUDE_LENS_E2E` however the assertion below leaves it. */
function withE2eFlag<T>(value: string | undefined, body: () => T): T {
  const previous = process.env['CLAUDE_LENS_E2E'];
  if (value === undefined) delete process.env['CLAUDE_LENS_E2E'];
  else process.env['CLAUDE_LENS_E2E'] = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env['CLAUDE_LENS_E2E'];
    else process.env['CLAUDE_LENS_E2E'] = previous;
  }
}

describe('the Claude data directory is resolved, never written as a literal (INV-17)', () => {
  const sandbox = useSandbox();

  it('derives ~/.claude from os.homedir() rather than a hard-coded string', () => {
    // The property, not the value: the suggestion must be a child of whatever home is, so it
    // follows a changed HOME and cannot be a literal committed to a public repo (P-33).
    expect(realClaudeHome()).toBe(join(realHomeDir(), '.claude'));
    expect(suggestedClaudeDataDir()).toBe(realClaudeHome());
    expect(isSameOrInside(realHomeDir(), realClaudeHome())).toBe(true);
  });

  it('recognises the real Claude home and anything beneath it', () => {
    expect(isUnderRealClaudeHome(realClaudeHome())).toBe(true);
    expect(isUnderRealClaudeHome(join(realClaudeHome(), 'projects', 'x'))).toBe(true);
    // A sibling whose name merely starts with the same characters is NOT inside it.
    expect(isUnderRealClaudeHome(`${realClaudeHome()}-backup`)).toBe(false);
    expect(isUnderRealClaudeHome(sandbox.path)).toBe(false);
  });
});

describe('the ADR-018 production tripwire (CLAUDE_LENS_E2E=1)', () => {
  const sandbox = useSandbox();

  it('refuses a Claude data directory under the real <home>/.claude', () => {
    // ⚠️ ADR-013's Vitest `setupFiles` tripwire does NOT cover `pnpm run e2e`, which launches
    // the real app in a process where setup files never load. This assertion is the production
    // half; neither is complete alone.
    withE2eFlag('1', () => {
      expect(() =>
        assertE2eStartupSafety({
          claudeDataDir: join(realClaudeHome(), 'projects'),
          userDataDir: sandbox.path,
        }),
      ).toThrow(/inside the real Claude data directory/);
    });
  });

  it('refuses a userData directory under the real <home>/.claude', () => {
    // The database lives in `app.getPath('userData')` and is not covered by the data-dir rule
    // (ADR-018 extension 2): it gets its own assertion.
    withE2eFlag('1', () => {
      expect(() =>
        assertE2eStartupSafety({
          claudeDataDir: sandbox.resolve('claude-fixture'),
          userDataDir: join(realClaudeHome(), 'userdata'),
        }),
      ).toThrow(/inside the real Claude data directory/);
    });
  });

  it('accepts sandboxed paths under the flag, and is inert without it', () => {
    withE2eFlag('1', () => {
      expect(() =>
        assertE2eStartupSafety({
          claudeDataDir: sandbox.resolve('claude-fixture'),
          userDataDir: sandbox.resolve('userdata'),
        }),
      ).not.toThrow();
    });

    // Without the flag the assertion does not run at all — a developer's real app must be
    // able to point at their real `~/.claude`, which is the entire product.
    withE2eFlag(undefined, () => {
      expect(() =>
        assertE2eStartupSafety({
          claudeDataDir: join(realClaudeHome(), 'projects'),
          userDataDir: join(realClaudeHome(), 'userdata'),
        }),
      ).not.toThrow();
    });
  });
});

describe('§9.3 / §9.4 — pinning userData so setName never moves the database', () => {
  // ⚠️⚠️ The single most important property in this change: after `app.setName('Claude Lens')`,
  // `app.getPath('userData')` must still resolve to the EXISTING `<appData>/claude-lens` folder
  // (lowercase, no space), where the 213 MB database and all USER-class data already live. The pin
  // is what guarantees it, and it is a pure function of `appData`, so it is testable without
  // Electron. `appData` (`~/Library/Application Support`) does not depend on the app name.
  const appData = join('/Users', 'someone', 'Library', 'Application Support');

  it('pins userData to <appData>/claude-lens — lowercase, no space, name-independent', () => {
    const target = userDataPinTarget({
      appDataDir: appData,
      e2e: false,
      userDataDirOverridden: false,
    });
    expect(target).toBe(join(appData, USER_DATA_DIR_NAME));
    expect(USER_DATA_DIR_NAME).toBe('claude-lens');
    // The database therefore stays byte-identical to where it is today — NOT under "Claude Lens".
    expect(databasePath(target ?? '')).toBe(join(appData, 'claude-lens', 'claude-lens.db'));
    // The pinned folder name itself is lowercase with no space — the display name never leaks in.
    expect(basename(target ?? '')).toBe('claude-lens');
    expect(basename(target ?? '')).not.toContain('Claude Lens');
    expect(basename(target ?? '')).not.toContain(' ');
  });

  it('does NOT fire under E2E or an explicit --user-data-dir (ADR-018 sandbox wins)', () => {
    // The E2E launcher redirects userData to a fresh sandbox; the pin must leave that alone, or a
    // test run would be dragged onto the developer's real database.
    expect(
      userDataPinTarget({ appDataDir: appData, e2e: true, userDataDirOverridden: false }),
    ).toBe(null);
    expect(
      userDataPinTarget({ appDataDir: appData, e2e: false, userDataDirOverridden: true }),
    ).toBe(null);
  });

  it('pinUserDataDir calls app.setPath(userData) with the pinned path in a normal run', () => {
    // A structural fake of the Electron `app` surface — no window, no binary. `withE2eFlag(undefined)`
    // guarantees the E2E gate is off so this exercises the real-run branch deterministically.
    withE2eFlag(undefined, () => {
      let setTo: { name: string; value: string } | null = null;
      const target = pinUserDataDir({
        getPath: () => appData,
        setPath: (name, value) => {
          setTo = { name, value };
        },
        commandLine: { hasSwitch: () => false },
      });
      expect(target).toBe(join(appData, 'claude-lens'));
      expect(setTo).toEqual({ name: 'userData', value: join(appData, 'claude-lens') });
    });
  });

  it('pinUserDataDir is a no-op when --user-data-dir is present (never calls setPath)', () => {
    withE2eFlag(undefined, () => {
      let setPathCalls = 0;
      const target = pinUserDataDir({
        getPath: () => appData,
        setPath: () => {
          setPathCalls += 1;
        },
        commandLine: { hasSwitch: (name) => name === 'user-data-dir' },
      });
      expect(target).toBe(null);
      expect(setPathCalls).toBe(0);
    });
  });

  it('pinUserDataDir is a no-op under CLAUDE_LENS_E2E=1 (ADR-018 sandbox wins)', () => {
    withE2eFlag('1', () => {
      let setPathCalls = 0;
      const target = pinUserDataDir({
        getPath: () => appData,
        setPath: () => {
          setPathCalls += 1;
        },
        commandLine: { hasSwitch: () => false },
      });
      expect(target).toBe(null);
      expect(setPathCalls).toBe(0);
    });
  });
});

describe('§9.3 — the database is never inside the Claude data directory', () => {
  const sandbox = useSandbox();

  it('names the two app files', () => {
    expect(DATABASE_FILE_NAME).toBe('claude-lens.db');
    expect(LOG_FILE_NAME).toBe('claude-lens.log');
    expect(databasePath(sandbox.path)).toBe(sandbox.resolve('claude-lens.db'));
    expect(logFilePath(sandbox.path)).toBe(sandbox.resolve('claude-lens.log'));
  });

  it('refuses a Claude data directory that would contain the database', () => {
    // It would then be scanned into `file_manifest`, watched (so every WAL commit resyncs the
    // file the resync is writing), and flagged as bloat by the app itself.
    const claudeDir = sandbox.resolve('claude');
    expect(() =>
      assertDatabaseOutsideClaudeDir(join(claudeDir, 'claude-lens.db'), claudeDir),
    ).toThrow(/outside the Claude data directory/);
    expect(() =>
      assertDatabaseOutsideClaudeDir(sandbox.resolve('userData/claude-lens.db'), claudeDir),
    ).not.toThrow();
  });
});

describe('INV-14 / INV-19 — the backup root and the archive root', () => {
  const sandbox = useSandbox();

  it('places restore points at <claudeDir>/.claude-lens-backups', () => {
    expect(BACKUP_ROOT_NAME).toBe('.claude-lens-backups');
    const claudeDir = sandbox.resolve('claude');
    expect(backupRoot(claudeDir)).toBe(join(claudeDir, BACKUP_ROOT_NAME));
    expect(isUnderBackupRoot(claudeDir, join(claudeDir, BACKUP_ROOT_NAME, 'x-1', 'a.md'))).toBe(
      true,
    );
    expect(isUnderBackupRoot(claudeDir, join(claudeDir, 'projects', 'a.jsonl'))).toBe(false);
  });

  it('rejects an archive root inside claudeDir, above it, or equal to the backup root', () => {
    const claudeDir = sandbox.resolve('claude');
    expect(archiveRootProblem(join(claudeDir, 'archive'), claudeDir)).toBe('inside-claude-dir');
    expect(archiveRootProblem(claudeDir, claudeDir)).toBe('inside-claude-dir');
    expect(archiveRootProblem(sandbox.path, claudeDir)).toBe('parent-of-claude-dir');
    expect(archiveRootProblem(backupRoot(claudeDir), claudeDir)).toBe('is-backup-root');
    expect(archiveRootProblem('relative/path', claudeDir)).toBe('not-absolute');
    // A sibling directory on any volume is fine — including one that is not mounted (§9.3).
    expect(archiveRootProblem(sandbox.resolve('elsewhere'), claudeDir)).toBeNull();
  });
});
