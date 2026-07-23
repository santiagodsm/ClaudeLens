// The `settings` repository. DESIGN §3.13, §4.3, ADR-026/030.

import { describe, expect, it } from 'vitest';
import { isDbError } from '../../../src/main/db/errors';
import { PERSISTENCE_CLASS_BY_TABLE } from '../../../src/main/db/repositories/base';
import {
  SETTINGS_PERSISTENCE_CLASS,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  SettingsRepository,
  defaultsAreSafe,
  type SettingsFallback,
} from '../../../src/main/db/settings-repo';
import { useSandbox } from '../../support/sandbox';
import { T0, countRows, useTestDatabases } from './helpers';

/** Reads `error.code` without a cast at every call site. */
function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    return isDbError(error) ? error.code : `unexpected:${String(error)}`;
  }
  return null;
}

describe('settings is USER class (§2.2, ADR-026)', () => {
  it('is encoded as a value, in both places a reader will look', () => {
    expect(SETTINGS_PERSISTENCE_CLASS).toBe('USER');
    expect(PERSISTENCE_CLASS_BY_TABLE.settings).toBe('USER');
    // The counterpart that makes the distinction load-bearing (§3.17).
    expect(PERSISTENCE_CLASS_BY_TABLE.meta).toBe('DERIVED');
  });
});

describe('SettingsRepository (§3.13)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('declares exactly the keys of §3.13, with the documented defaults', () => {
    expect([...SETTING_KEYS].toSorted()).toEqual([
      'archiveRoot',
      'claudeDir',
      'idleGapMinutes',
      'lastGlobalFilter',
      'priceFetchUrl',
      'reduceMotionOverride',
      'retainOrphanedHistory',
      'sidebarCollapsed',
      'theme',
    ]);

    const repo = new SettingsRepository(dbs.openMigrated());
    expect(repo.snapshot()).toEqual({
      claudeDir: null, // null ⇒ onboarding (§6.2)
      idleGapMinutes: 15,
      theme: 'system',
      priceFetchUrl: '', // ships empty by decision (§11.3, closed)
      archiveRoot: null, // null ⇒ ACT-07 unavailable
      lastGlobalFilter: { projectIds: null, from: null, to: null },
      sidebarCollapsed: false,
      reduceMotionOverride: 'system',
      retainOrphanedHistory: true, // ADR-041 — keep history by default (never auto-deletes)
    });
    // Defaults come from the table, not from the read path inventing them.
    expect(countRows(dbs.openMigrated(), 'settings')).toBe(0);
    expect(SETTING_DEFINITIONS.idleGapMinutes.defaultValue).toBe(15);
  });

  it('round-trips every key through the table', () => {
    const repo = new SettingsRepository(dbs.openMigrated());

    repo.set('claudeDir', '/sandbox/data/.claude', T0);
    repo.set('idleGapMinutes', 30, T0);
    repo.set('theme', 'dark', T0);
    repo.set('priceFetchUrl', 'https://example.invalid/prices.json', T0);
    repo.set('archiveRoot', '/sandbox/archive', T0);
    repo.set('lastGlobalFilter', { projectIds: [1, 2], from: T0, to: T0 + 1000 }, T0);
    repo.set('sidebarCollapsed', true, T0);
    repo.set('reduceMotionOverride', 'reduce', T0);
    const snapshot = repo.set('retainOrphanedHistory', false, T0);

    expect(snapshot).toEqual({
      claudeDir: '/sandbox/data/.claude',
      idleGapMinutes: 30,
      theme: 'dark',
      priceFetchUrl: 'https://example.invalid/prices.json',
      archiveRoot: '/sandbox/archive',
      lastGlobalFilter: { projectIds: [1, 2], from: T0, to: T0 + 1000 },
      sidebarCollapsed: true,
      reduceMotionOverride: 'reduce',
      retainOrphanedHistory: false, // ADR-041 — flips off the keep-history default
    });
    expect(repo.get('idleGapMinutes')).toBe(30);
  });

  it('rejects an unknown key with E_UNKNOWN_SETTING and writes nothing', () => {
    const db = dbs.openMigrated();
    const repo = new SettingsRepository(db);

    expect(codeOf(() => repo.set('telemetryEnabled', true, T0))).toBe('E_UNKNOWN_SETTING');
    expect(codeOf(() => repo.get('theme ' as never))).toBe('E_UNKNOWN_SETTING');
    expect(countRows(db, 'settings')).toBe(0);
  });

  it('rejects an invalid value with E_INVALID_SETTING — it never reaches the table', () => {
    const db = dbs.openMigrated();
    const repo = new SettingsRepository(db);

    // §3.13: 5–60, step 5. Not clamped, not rounded (CLAUDE.md §1: never substitute).
    expect(codeOf(() => repo.set('idleGapMinutes', 7, T0))).toBe('E_INVALID_SETTING');
    expect(codeOf(() => repo.set('idleGapMinutes', 0, T0))).toBe('E_INVALID_SETTING');
    expect(codeOf(() => repo.set('idleGapMinutes', 65, T0))).toBe('E_INVALID_SETTING');
    expect(codeOf(() => repo.set('idleGapMinutes', '15', T0))).toBe('E_INVALID_SETTING');
    expect(codeOf(() => repo.set('theme', 'midnight', T0))).toBe('E_INVALID_SETTING');
    expect(codeOf(() => repo.set('sidebarCollapsed', 'true', T0))).toBe('E_INVALID_SETTING');
    expect(codeOf(() => repo.set('claudeDir', 'relative/path', T0))).toBe('E_INVALID_SETTING');
    expect(codeOf(() => repo.set('lastGlobalFilter', { projectIds: ['a'] }, T0))).toBe(
      'E_INVALID_SETTING',
    );
    // A half-open range that is not a range.
    expect(codeOf(() => repo.set('lastGlobalFilter', { from: T0, to: T0 }, T0))).toBe(
      'E_INVALID_SETTING',
    );

    expect(countRows(db, 'settings')).toBe(0);
    expect(repo.snapshot().idleGapMinutes).toBe(15);
  });

  it('accepts the boundary values of idleGapMinutes', () => {
    const repo = new SettingsRepository(dbs.openMigrated());
    expect(repo.set('idleGapMinutes', 5, T0).idleGapMinutes).toBe(5);
    expect(repo.set('idleGapMinutes', 60, T0).idleGapMinutes).toBe(60);
  });

  it('ignores an unknown key already present in the table (§3.13, read side)', () => {
    const db = dbs.openMigrated();
    db.prepare(
      'INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('someFutureKey', '"whatever"', T0, T0);

    expect(new SettingsRepository(db).snapshot().theme).toBe('system');
  });

  // ⚠️ E6 RULING, 2026-07-22. This block previously asserted that a corrupt PERSISTED value
  // raised `E_INVALID_SETTING`. §3.13 does not cover the case and it was carried as an open
  // question; the ruling is: **fall back to the documented default and report it**, with one
  // exception — `claudeDir` falls back to `null` (→ onboarding), never to a guessed path.
  //
  // Reasoning, so this is not re-litigated: §5.1 reserves `FATAL` for migration failure and DB
  // corruption, and one bad settings row must not brick an app whose entire value is being
  // glanceable. The substitution is not silent — it is reported through `onFallback` and logged
  // by `DatasetService` — so "never substitute" is honoured where it matters. But `claudeDir`
  // is the input to a **delete** subsystem (§5.7, ADR-032), so guessing there is categorically
  // different from guessing a theme.
  it('falls back to the documented default for a corrupt persisted value, and reports it', () => {
    const db = dbs.openMigrated();
    db.prepare(
      'INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('idleGapMinutes', '7', T0, T0);
    db.prepare(
      'INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('theme', 'not json at all', T0, T0);

    const repo = new SettingsRepository(db);
    const reported: SettingsFallback[] = [];
    const snapshot = repo.snapshot((fallback) => reported.push(fallback));

    expect(snapshot.idleGapMinutes).toBe(15); // §3.13 default
    expect(snapshot.theme).toBe('system'); // §3.13 default
    expect(reported).toEqual([
      { key: 'idleGapMinutes', reason: 'invalid-value' },
      { key: 'theme', reason: 'invalid-json' },
    ]);

    const single: SettingsFallback[] = [];
    expect(repo.get('idleGapMinutes', (fallback) => single.push(fallback))).toBe(15);
    expect(single).toEqual([{ key: 'idleGapMinutes', reason: 'invalid-value' }]);
  });

  it('falls back to null for a corrupt claudeDir — never to a guessed path', () => {
    // ⚠️ The other half of the ruling. `claudeDir` is the root of a delete subsystem; the only
    // acceptable fallback is "we do not know", which is onboarding (§6.2, §5.1 NO_DIR).
    const db = dbs.openMigrated();
    db.prepare(
      'INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('claudeDir', '"not-absolute"', T0, T0);

    const reported: SettingsFallback[] = [];
    const snapshot = new SettingsRepository(db).snapshot((fallback) => reported.push(fallback));

    expect(snapshot.claudeDir).toBeNull();
    expect(reported).toEqual([{ key: 'claudeDir', reason: 'invalid-value' }]);
  });

  it('no setting default is a filesystem path (the ruling, as a property)', () => {
    // A later edit that "helpfully" defaults claudeDir to a resolved home directory fails here
    // rather than shipping — which is the whole point of encoding the rule as a predicate.
    expect(defaultsAreSafe()).toBe(true);
  });

  it('updates in place rather than accumulating rows', () => {
    const db = dbs.openMigrated();
    const repo = new SettingsRepository(db);
    repo.set('theme', 'dark', T0);
    repo.set('theme', 'light', T0 + 1000);

    expect(countRows(db, 'settings')).toBe(1);
    expect(repo.get('theme')).toBe('light');
    const row = db
      .prepare<{
        created_at: number;
        updated_at: number;
      }>("SELECT created_at, updated_at FROM settings WHERE key = 'theme'")
      .get();
    // §3.1.6: USER tables carry both timestamps; `created_at` is not rewritten by an update.
    expect(row).toEqual({ created_at: T0, updated_at: T0 + 1000 });
  });
});
