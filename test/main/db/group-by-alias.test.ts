// A-19 — the SQLite semantics `groupedSql` in `src/main/db/repositories/cost.ts` rests on.
//
// A-19 needed the billing-cycle grouping to be an EXPRESSION rather than a column, and expressions
// with a `?` in them cannot be repeated in `GROUP BY` without repeating the bind parameter, so the
// clause became `GROUP BY key` — the SELECT alias, which is `CAST(<column> AS TEXT)`. That change
// applies to `model`, `project`, `day` and `session` as well, which A-19 never intended to touch:
// four channels that group every `$` in the app quietly started grouping on a cast.
//
// It is equivalent. These tests are why we know rather than believe it, and they are here so that
// a SQLite version bump under the dual-ABI loader cannot change it back without a red test.
//
// ⚠️ `:memory:` is deliberate and permitted: CLAUDE.md §6 allows it for pure SQL-shape tests, and
// nothing here touches the manifest, byte offsets, the WAL or migrations.

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/main/db/driver';

interface Group {
  readonly key: string | null;
  readonly n: number;
}

/** The two clauses, over one table, so only the `GROUP BY` differs. */
function bothWays(column: string, table: string): { onColumn: Group[]; onAlias: Group[] } {
  const db = openDatabase(':memory:');
  try {
    db.exec(table);
    const select = `SELECT CAST(${column} AS TEXT) AS key, COUNT(*) AS n FROM t`;
    return {
      onColumn: db.prepare<Group>(`${select} GROUP BY ${column} ORDER BY key`).all(),
      onAlias: db.prepare<Group>(`${select} GROUP BY key ORDER BY key`).all(),
    };
  } finally {
    db.close();
  }
}

describe('A-19 — grouping on the SELECT alias partitions exactly as grouping on the column', () => {
  it('keeps a declared collation, so a NOCASE column still folds case after the CAST', () => {
    // SQLite: "a column name preceded by one or more unary '+' operators and/or CAST operators is
    // still considered a column name" when the collating function is assigned. If that ever
    // stopped holding, a NOCASE column would split into three groups under the alias and stay one
    // under the column — the exact silent re-partition this file exists to catch.
    const groups = bothWays(
      'a',
      `CREATE TABLE t(a TEXT COLLATE NOCASE);
       INSERT INTO t VALUES ('Ab'), ('aB'), ('ab');`,
    );
    expect(groups.onColumn).toEqual([{ key: 'Ab', n: 3 }]);
    expect(groups.onAlias).toEqual(groups.onColumn);
  });

  it('leaves an ordinary TEXT column case-sensitive under both clauses', () => {
    // `events.model` and `events.session_id` are plain TEXT with no declared collation, so three
    // spellings are three groups — before the change and after it.
    const groups = bothWays(
      'a',
      `CREATE TABLE t(a TEXT);
       INSERT INTO t VALUES ('Ab'), ('aB'), ('ab');`,
    );
    expect(groups.onColumn).toHaveLength(3);
    expect(groups.onAlias).toEqual(groups.onColumn);
  });

  it('cannot merge two distinct values of a TEXT column, because affinity converts on the way in', () => {
    // The one way a CAST could re-partition: two values that differ as STORED but agree as text —
    // the integer 5 and the string '5' would be two groups on the column and one on the cast.
    // TEXT affinity rules it out: a numeric written to a TEXT column is converted to text before
    // it is stored, so there is no integer 5 left in the table to differ from '5'.
    const db = openDatabase(':memory:');
    try {
      db.exec(`CREATE TABLE t(a TEXT); INSERT INTO t VALUES (5), ('5'), (5.5);`);
      expect(db.prepare<{ k: string }>('SELECT DISTINCT typeof(a) AS k FROM t').all()).toEqual([
        { k: 'text' },
      ]);
      const select = 'SELECT CAST(a AS TEXT) AS key, COUNT(*) AS n FROM t';
      expect(db.prepare<Group>(`${select} GROUP BY a ORDER BY key`).all()).toEqual(
        db.prepare<Group>(`${select} GROUP BY key ORDER BY key`).all(),
      );
    } finally {
      db.close();
    }
  });

  it('is injective on an INTEGER key, and keeps NULL as its own group', () => {
    // `unit_id` (ADR-040) is an INTEGER primary key; `model` is nullable.
    const groups = bothWays(
      'a',
      `CREATE TABLE t(a INTEGER);
       INSERT INTO t VALUES (1), (1), (2), (NULL);`,
    );
    expect(groups.onColumn).toEqual([
      { key: null, n: 1 },
      { key: '1', n: 2 },
      { key: '2', n: 1 },
    ]);
    expect(groups.onAlias).toEqual(groups.onColumn);
  });
});
