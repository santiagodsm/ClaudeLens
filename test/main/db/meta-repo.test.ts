// The `meta` repository. DESIGN §3.17, ADR-026/027.

import { describe, expect, it } from 'vitest';
import { isDbError } from '../../../src/main/db/errors';
import { META_KEYS, META_PERSISTENCE_CLASS, MetaRepository } from '../../../src/main/db/meta-repo';
import { purge } from '../../../src/main/db/purge';
import { PERSISTENCE_CLASS_BY_TABLE } from '../../../src/main/db/repositories/base';
import { SettingsRepository } from '../../../src/main/db/settings-repo';
import { useSandbox } from '../../support/sandbox';
import { T0, countRows, useTestDatabases } from './helpers';

describe('meta is DERIVED class (§3.17, ADR-026)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('is encoded as a value, not a comment', () => {
    expect(META_PERSISTENCE_CLASS).toBe('DERIVED');
    expect(PERSISTENCE_CLASS_BY_TABLE.meta).toBe('DERIVED');
  });

  it('is purged while settings — USER class — is not: the distinction, observed', () => {
    // ⚠️ This is the whole reason §3.17 spells the classes out. Both tables are key/value
    // with the same shape; only the class tells them apart, and a purge acts on the class.
    const db = dbs.openMigrated();
    const meta = new MetaRepository(db);
    const settings = new SettingsRepository(db);

    meta.set('badLineTotal', 12, T0);
    meta.set('lastSyncKind', 'full', T0);
    settings.set('theme', 'dark', T0);

    purge(db);

    expect(countRows(db, 'meta')).toBe(0);
    expect(meta.get('badLineTotal')).toBeUndefined();
    expect(settings.get('theme')).toBe('dark');
    expect(countRows(db, 'settings')).toBe(1);
  });
});

describe('MetaRepository (§3.17)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('declares exactly the keys §3.17 names', () => {
    expect([...META_KEYS].toSorted()).toEqual([
      'badLineTotal',
      'claudeDirFingerprint',
      'lastFullParseAt',
      'lastSyncCompletedAt',
      'lastSyncDurationMs',
      'lastSyncKind',
      'recordCounts',
      'unlinkedSubagentRuns',
    ]);
  });

  it('returns undefined for a key that has never been written — never a default', () => {
    // "Never synced" and "synced, result was zero" are different facts (CLAUDE.md §1).
    const repo = new MetaRepository(dbs.openMigrated());
    expect(repo.get('lastSyncCompletedAt')).toBeUndefined();
    expect(repo.get('badLineTotal')).toBeUndefined();
    expect(repo.snapshot()).toEqual({});
  });

  it('round-trips scalars and the recordCounts object', () => {
    const repo = new MetaRepository(dbs.openMigrated());

    repo.set('lastSyncCompletedAt', T0, T0);
    repo.set('lastSyncDurationMs', 4321, T0);
    repo.set('lastSyncKind', 'incremental', T0);
    repo.set('claudeDirFingerprint', 'a'.repeat(64), T0);
    repo.set('recordCounts', { events: 5, sessions: 2, projects: 1, toolCalls: 3, prompts: 4 }, T0);
    repo.set('badLineTotal', 7, T0);
    repo.set('unlinkedSubagentRuns', 1, T0);

    expect(repo.get('lastSyncKind')).toBe('incremental');
    expect(repo.get('recordCounts')).toEqual({
      events: 5,
      sessions: 2,
      projects: 1,
      toolCalls: 3,
      prompts: 4,
    });
    expect(repo.snapshot()).toEqual({
      lastSyncCompletedAt: T0,
      lastSyncDurationMs: 4321,
      lastSyncKind: 'incremental',
      claudeDirFingerprint: 'a'.repeat(64),
      recordCounts: { events: 5, sessions: 2, projects: 1, toolCalls: 3, prompts: 4 },
      badLineTotal: 7,
      unlinkedSubagentRuns: 1,
    });
  });

  it('writes several keys atomically and updates in place', () => {
    const db = dbs.openMigrated();
    const repo = new MetaRepository(db);

    repo.setMany({ badLineTotal: 1, lastSyncKind: 'full' }, T0);
    repo.setMany({ badLineTotal: 2 }, T0 + 1000);

    expect(countRows(db, 'meta')).toBe(2);
    expect(repo.get('badLineTotal')).toBe(2);
    expect(repo.get('lastSyncKind')).toBe('full');
  });

  it('rejects an unknown key and a wrongly typed value', () => {
    const repo = new MetaRepository(dbs.openMigrated());
    const codeOf = (fn: () => unknown): string | null => {
      try {
        fn();
      } catch (error) {
        return isDbError(error) ? error.code : `unexpected:${String(error)}`;
      }
      return null;
    };

    expect(codeOf(() => repo.set('totalTokens' as never, 1 as never, T0))).toBe('E_INTERNAL');
    expect(codeOf(() => repo.set('lastSyncKind', 'partial' as never, T0))).toBe('E_INTERNAL');
    expect(codeOf(() => repo.set('badLineTotal', -1, T0))).toBe('E_INTERNAL');
  });

  it('ignores a key in the table that this build does not know', () => {
    const db = dbs.openMigrated();
    db.prepare('INSERT INTO meta (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      'someFutureKey',
      '"whatever"',
      T0,
    );
    expect(new MetaRepository(db).snapshot()).toEqual({});
  });

  it('clears a key rather than writing a substitute value', () => {
    const repo = new MetaRepository(dbs.openMigrated());
    repo.set('badLineTotal', 3, T0);
    repo.clear('badLineTotal');
    expect(repo.get('badLineTotal')).toBeUndefined();
  });
});
