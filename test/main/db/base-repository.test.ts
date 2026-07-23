// The repository seam. STACK ADR-008, DESIGN §3.1.9, INV-11.

import { describe, expect, it } from 'vitest';
import { isDbError } from '../../../src/main/db/errors';
import {
  PERSISTENCE_CLASS_BY_TABLE,
  RETAINED_MARKER_COLUMN,
  RETAINED_MARKER_TABLES,
  assertSafeAggregate,
  sumToSafeNumber,
} from '../../../src/main/db/repositories/base';
import { useSandbox } from '../../support/sandbox';
import { useTestDatabases } from './helpers';

// A-10: the arithmetic of INV-11 lives once, in `isSafeAggregate` (src/shared/money.ts), and
// is pinned there — including the bigint boundary. What is tested HERE is the thing only this
// layer owns: that a breach arrives as `DbError('E_INTERNAL')`, not as some other throw. The
// boundary cases are re-asserted through this wrapper so the two layers cannot drift apart
// silently — which is exactly how the duplicate implementations went unnoticed.
describe('INV-11 — the bound on every aggregate that crosses IPC', () => {
  it('passes a value inside Number.MAX_SAFE_INTEGER through unchanged', () => {
    expect(assertSafeAggregate(0, 'tokens')).toBe(0);
    expect(assertSafeAggregate(3_100_000_000, 'cacheReads')).toBe(3_100_000_000);
    expect(assertSafeAggregate(Number.MAX_SAFE_INTEGER, 'picoUsd')).toBe(Number.MAX_SAFE_INTEGER);
    expect(assertSafeAggregate(-Number.MAX_SAFE_INTEGER, 'picoUsd')).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it('accepts a bigint at the bound, because `safeIntegers` produces one (A-10)', () => {
    expect(assertSafeAggregate(0n, 'tokens')).toBe(0);
    expect(assertSafeAggregate(BigInt(Number.MAX_SAFE_INTEGER), 'picoUsd')).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(assertSafeAggregate(-BigInt(Number.MAX_SAFE_INTEGER), 'picoUsd')).toBe(
      -Number.MAX_SAFE_INTEGER,
    );
  });

  it('returns E_INTERNAL rather than a silently rounded number', () => {
    // ⚠️ 2^53 + 1 does not fail in JavaScript — it rounds to 2^53 and looks fine. That is
    // the failure this project is built to prevent (CLAUDE.md §1).
    const tooLarge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(Number(tooLarge)).toBe(Number.MAX_SAFE_INTEGER + 1); // the silent rounding, shown

    let thrown: unknown;
    try {
      assertSafeAggregate(tooLarge, 'lifetimeTokens');
    } catch (error) {
      thrown = error;
    }
    expect(isDbError(thrown)).toBe(true);
    expect(isDbError(thrown) ? thrown.code : null).toBe('E_INTERNAL');
    expect(isDbError(thrown) ? thrown.message : '').toContain('lifetimeTokens');
  });

  it('mints E_INTERNAL — never a bare RangeError — for every kind of breach', () => {
    for (const bad of [
      1.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 2,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      -BigInt(Number.MAX_SAFE_INTEGER) - 1n,
    ]) {
      let thrown: unknown;
      try {
        assertSafeAggregate(bad, 'seconds');
      } catch (error) {
        thrown = error;
      }
      expect(isDbError(thrown) ? thrown.code : null).toBe('E_INTERNAL');
    }
  });

  it('treats SUM() over no rows as zero, which is the true answer, not a substitution', () => {
    expect(sumToSafeNumber(null, 'tokens')).toBe(0);
    expect(sumToSafeNumber(42, 'tokens')).toBe(42);
    expect(sumToSafeNumber(42n, 'tokens')).toBe(42);
  });
});

describe('INV-11 against a real SUM', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('turns SQLite NULL from an empty SUM into zero', () => {
    const db = dbs.openMigrated();
    const row = db
      .prepare<{ total: number | null }>('SELECT SUM(tok_input) AS total FROM events')
      .get();
    expect(row?.total).toBeNull();
    expect(sumToSafeNumber(row?.total ?? null, 'tokIn')).toBe(0);
  });
});

describe('the persistence classification (ADR-026/033)', () => {
  it('classifies every table the migration set creates', () => {
    // 17 from migration 0001, plus `harness_run_agents` from 0004 (ADR-039), plus
    // `price_rows_pre_0005` from 0005 (A-05 — the renamed-aside pre-image of `price_rows`, kept
    // because ADR-026 forbids dropping a USER table), plus `project_groups` and
    // `project_group_members` from 0007 (ADR-040 — the user's "these folders are the same
    // project"). The count is asserted rather than the list so that adding a table without
    // classifying it fails here — `purge.ts` refuses to delete from anything this map does not
    // name (ADR-026).
    expect(Object.keys(PERSISTENCE_CLASS_BY_TABLE)).toHaveLength(21);
    expect(
      Object.entries(PERSISTENCE_CLASS_BY_TABLE)
        .filter(([, klass]) => klass === 'USER')
        .map(([table]) => table)
        .toSorted(),
    ).toEqual([
      'archives',
      'audit_log',
      'price_rows',
      'price_rows_pre_0005',
      // ⚠️ ADR-040 — hand-entered, no other source. A purge that took these would silently
      // un-merge every group the user made and move every project-shaped number.
      'project_group_members',
      'project_groups',
      'settings',
    ]);
  });

  it('names the RETAINED marker as a column on exactly the two tables that carry it', () => {
    expect(RETAINED_MARKER_COLUMN).toBe('archive_id');
    expect([...RETAINED_MARKER_TABLES].toSorted()).toEqual(['file_manifest', 'sessions']);
  });
});

describe('the RETAINED marker exists in the schema, not only in the code', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('is a real column on file_manifest and sessions (ADR-033)', () => {
    const db = dbs.openMigrated();
    for (const table of RETAINED_MARKER_TABLES) {
      const columns = db
        .prepare<{ name: string }>(`SELECT name FROM pragma_table_info(?)`)
        .all(table)
        .map((row) => row.name);
      expect(columns).toContain(RETAINED_MARKER_COLUMN);
    }
  });
});
