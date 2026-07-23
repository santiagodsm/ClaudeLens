// `project_groups` / `project_group_members` — DESIGN §3.19, ADR-040.
//
// The arithmetic these tables change lives in `test/metrics/f16-grouped-active-time.test.ts`.
// This file is about the tables themselves: their persistence class, the identity they key on,
// and the two rules a user can actually break.

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/main/db/driver';
import { migrate } from '../../../src/main/db/migrate';
import { purge, NEVER_PURGED_TABLES } from '../../../src/main/db/purge';
import { PERSISTENCE_CLASS_BY_TABLE } from '../../../src/main/db/repositories/base';
import {
  PROJECT_UNIT_CTE,
  ProjectGroupsRepository,
  MAX_GROUP_NAME_LENGTH,
} from '../../../src/main/db/repositories/project-groups';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';
import { useSandbox, type Sandbox } from '../../support/sandbox';

const T0 = 1_714_521_600_000;

/** One migrated database with two projects, inserted the way ingest inserts them. */
function seed(sandbox: Sandbox, name = 'groups'): SqliteDatabase {
  const db = openDatabase(sandbox.resolve(`${name}.db`));
  migrate(db);
  db.prepare(
    `INSERT INTO projects (id, encoded_name, display_name, color_index)
     VALUES (1, '-work-demo-alpha', 'alpha', 0),
            (2, '-work-demo-alpha-moved', 'alpha-moved', 1),
            (3, '-work-demo-beta', 'beta', 2)`,
  ).run();
  return db;
}

describe('project groups are USER class and key on encoded_name (§3.19, ADR-040)', () => {
  const sandbox = useSandbox();

  it('classifies both tables USER and refuses to purge either (ADR-026, INV-12)', () => {
    expect(PERSISTENCE_CLASS_BY_TABLE.project_groups).toBe('USER');
    expect(PERSISTENCE_CLASS_BY_TABLE.project_group_members).toBe('USER');
    // `purge()` audits its own statements before executing one; naming either table there is a
    // blocking finding, exactly as it is for `price_rows`.
    expect(NEVER_PURGED_TABLES).toContain('project_groups');
    expect(NEVER_PURGED_TABLES).toContain('project_group_members');
  });

  it('leaves both tables completely untouched across a purge', () => {
    const db = seed(sandbox, 'purge');
    const groups = new ProjectGroupsRepository(db);
    groups.create('Family App', ['-work-demo-alpha', '-work-demo-alpha-moved'], T0);

    const rowsBefore = db
      .prepare<{ encoded_name: string; group_id: number; created_at: number }>(
        'SELECT encoded_name, group_id, created_at FROM project_group_members ORDER BY encoded_name',
      )
      .all();
    const groupBefore = db
      .prepare<{ id: number; name: string; color_index: number; updated_at: number }>(
        'SELECT id, name, color_index, updated_at FROM project_groups',
      )
      .all();

    purge(db);

    // ⚠️ Byte-identical, including the timestamps: a purge does not "refresh" a USER row either.
    expect(
      db
        .prepare<{ encoded_name: string; group_id: number; created_at: number }>(
          'SELECT encoded_name, group_id, created_at FROM project_group_members ORDER BY encoded_name',
        )
        .all(),
    ).toEqual(rowsBefore);
    expect(
      db
        .prepare<{ id: number; name: string; color_index: number; updated_at: number }>(
          'SELECT id, name, color_index, updated_at FROM project_groups',
        )
        .all(),
    ).toEqual(groupBefore);
  });

  it('stores no project_id anywhere, because a rebuild renumbers them (§3.3)', () => {
    const db = seed(sandbox, 'identity');
    const columns = db
      .prepare<{ name: string }>('PRAGMA table_info(project_group_members)')
      .all()
      .map((row) => row.name);
    // ⚠️ The whole shape of the table in one assertion. A `project_id` column here would survive
    // review and then silently re-point every group after the next purge-and-rebuild.
    expect(columns).toEqual(['encoded_name', 'group_id', 'created_at', 'updated_at']);
    expect(columns).not.toContain('project_id');
    // The membership key is also the PRIMARY KEY, which is what makes "at most one group per
    // project" a property of the schema rather than of a check someone could forget.
    expect(
      db
        .prepare<{ pk: number; name: string }>('PRAGMA table_info(project_group_members)')
        .all()
        .filter((row) => row.pk > 0)
        .map((row) => row.name),
    ).toEqual(['encoded_name']);
  });

  it('refuses a second group for a project that is already in one', () => {
    const db = seed(sandbox, 'twice');
    const groups = new ProjectGroupsRepository(db);
    groups.create('Family App', ['-work-demo-alpha', '-work-demo-alpha-moved'], T0);
    expect(() =>
      groups.create('Something else', ['-work-demo-alpha', '-work-demo-beta'], T0),
    ).toThrow(/already part of another group/);
    // The refusal changed nothing: one group, two members, the original name.
    expect(groups.list()).toHaveLength(1);
    expect(groups.list()[0]?.name).toBe('Family App');
  });

  it('refuses a group of fewer than two projects, an empty name and a huge name', () => {
    const db = seed(sandbox, 'validation');
    const groups = new ProjectGroupsRepository(db);
    expect(() => groups.create('Solo', ['-work-demo-alpha'], T0)).toThrow(/at least two/);
    // Duplicates do not make two.
    expect(() => groups.create('Solo', ['-work-demo-alpha', '-work-demo-alpha'], T0)).toThrow(
      /at least two/,
    );
    expect(() => groups.create('   ', ['-work-demo-alpha', '-work-demo-beta'], T0)).toThrow(
      /Give the group a name/,
    );
    expect(() =>
      groups.create(
        'x'.repeat(MAX_GROUP_NAME_LENGTH + 1),
        ['-work-demo-alpha', '-work-demo-beta'],
        T0,
      ),
    ).toThrow(/longer than/);
    expect(groups.list()).toEqual([]);
  });

  it('renames, recolours from the new name, and splits apart', () => {
    const db = seed(sandbox, 'rename');
    const groups = new ProjectGroupsRepository(db);
    const created = groups.create('Family App', ['-work-demo-alpha', '-work-demo-alpha-moved'], T0);
    const id = created[0]?.id ?? 0;
    const colourBefore = created[0]?.colorIndex;

    const renamed = groups.rename(id, '  The Family App  ', T0 + 1);
    // Trimmed, never stored with the user's stray spaces.
    expect(renamed[0]?.name).toBe('The Family App');
    // §3.3's rule applied to the name: the hue is a pure function of what it is called, so a
    // different name may well be a different hue. What matters is that it is derived, not random.
    expect(typeof renamed[0]?.colorIndex).toBe('number');
    expect(renamed[0]?.colorIndex).toBeGreaterThanOrEqual(0);
    expect(renamed[0]?.colorIndex).toBeLessThanOrEqual(7);
    expect(colourBefore).toBeGreaterThanOrEqual(0);

    expect(groups.ungroup(id)).toEqual([]);
    // The members cascaded; nothing was left behind to re-point at something later.
    expect(
      db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM project_group_members').get()?.n,
    ).toBe(0);
    // Ungrouping something that is already gone is refused rather than reported as success.
    expect(() => groups.ungroup(id)).toThrow(/no longer exists/);
  });

  it('reports a member whose folder is not currently present, and never deletes it', () => {
    const db = seed(sandbox, 'absent');
    const groups = new ProjectGroupsRepository(db);
    const id = groups.create('Family App', ['-work-demo-alpha', '-work-demo-gone'], T0)[0]?.id ?? 0;

    // ⚠️ `-work-demo-gone` names no `projects` row — the state between a purge and the sync that
    // follows it, and what an unmounted drive looks like. It is REPORTED, not hidden: "the group
    // is intact and that folder is not here right now" is a different statement from "that
    // folder was never in the group".
    const listed = groups.list()[0];
    expect(listed?.members.map((m) => m.encodedName).toSorted()).toEqual([
      '-work-demo-alpha',
      '-work-demo-gone',
    ]);
    expect(listed?.members.find((m) => m.encodedName === '-work-demo-gone')?.projectId).toBeNull();
    expect(
      listed?.members.find((m) => m.encodedName === '-work-demo-gone')?.displayName,
    ).toBeNull();

    // It resolves to the one folder that IS present — never to "everything" (§4.2).
    expect(groups.expandUnitIds([-id])).toEqual([1]);
    expect(groups.expandUnitIds([-9_999])).toEqual([]);
  });

  it('gives a group a negative unit id that can never collide with a projects.id', () => {
    const db = seed(sandbox, 'units');
    const groups = new ProjectGroupsRepository(db);
    const id =
      groups.create('Family App', ['-work-demo-alpha', '-work-demo-alpha-moved'], T0)[0]?.id ?? 0;

    const units = db
      .prepare<{ project_id: number; unit_id: number; unit_encoded_name: string | null }>(
        `WITH ${PROJECT_UNIT_CTE} SELECT project_id, unit_id, unit_encoded_name FROM project_unit ORDER BY project_id`,
      )
      .all();
    expect(units).toEqual([
      { project_id: 1, unit_id: -id, unit_encoded_name: null },
      { project_id: 2, unit_id: -id, unit_encoded_name: null },
      { project_id: 3, unit_id: 3, unit_encoded_name: '-work-demo-beta' },
    ]);
    // `projects.id` is a rowid alias and is always >= 1, so the negative half of the line is free.
    for (const unit of units) expect(unit.unit_id).not.toBe(0);
    expect(new Set(units.map((u) => u.unit_id)).size).toBe(2);

    // A group's display facts come from the group; an ungrouped project's from §3.3.
    const names = groups.unitNames();
    expect(names.get(-id)?.displayName).toBe('Family App');
    expect(names.get(-id)?.encodedName).toBeNull();
    expect(names.get(-id)?.groupId).toBe(id);
    expect(names.get(3)?.displayName).toBe('beta');
    expect(names.get(3)?.encodedName).toBe('-work-demo-beta');
    expect(names.get(3)?.groupId).toBeNull();
  });
});
