// Project groups — "these two folders are the same project", said by the user.
// DESIGN §2.1 ("Project group", "Project unit"), §3.19, §6.8, §6.10, ADR-040.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ (1) ZERO INFERENCE IS INTACT. §2.1 "Project" forbids the APP deciding that two
//     `projects/<encoded-path>` directories are one project. Nothing in this file — or anywhere
//     that reads it — guesses, suggests or auto-detects a grouping. There is no name matching,
//     no path-similarity score, no "these look the same" hint, and the only writer is the
//     user's own explicit action. A wrong grouping is visible to the person who made it and is
//     undone with one click; a wrong INFERENCE would be invisible. That difference is the whole
//     of ADR-040.
//
// ⚠️ (2) MEMBERSHIP KEYS ON `encoded_name`, NEVER ON `projects.id`. `projects` is DERIVED
//     (§2.2) and §3.18's purge deletes every un-archived row; ingest re-inserts them with
//     DIFFERENT surrogate ids. A membership table storing `project_id` would silently re-point
//     every group at the wrong projects after any rebuild. `encoded_name` is the identity
//     (§3.3, `UNIQUE`) and is a property of the directory, so it survives. Ids are resolved
//     HERE, at query time.
//
// ⚠️ (3) THE UNIT ID SPACE. Every project-shaped metric groups by a **project unit**: the
//     project's own id when it is in no group, and `-groupId` when it is. `projects.id` is a
//     rowid alias and is therefore always `>= 1`, so the negative half of the integer line is
//     free and a unit id can never collide with a project id. `0` is used by neither.
//
// ⚠️ (4) THE GROUPING IS APPLIED WHERE THE PARTITION IS FORMED, NOT AFTERWARDS. `PROJECT_UNIT_CTE`
//     is joined inside the innermost `scoped` CTE of `active-time.ts`, so M-08's partition is
//     `(local day, UNIT)` rather than `(local day, project)`. Summing two projects' finished
//     active-time results instead would give a different — and wrong — number, because gaps
//     BETWEEN the two former projects on the same day belong inside one partition once they are
//     one project, and must be capped-and-counted rather than dropped. That is the same class of
//     mistake fixture F-12 exists to catch, and F-16 pins it for grouping.

import { Repository } from './base';
import { DbError } from '../errors';
import type { SqliteDatabase } from '../sqlite';
import { colorIndexFor } from '../../../shared/color-index';

/**
 * The unit-resolution CTE, written once.
 *
 * Produces one row per project with the unit it reports under. `LEFT JOIN`, so a project in no
 * group is its own unit; `LEFT JOIN` again on the group, so a membership row whose group is gone
 * (impossible under the FK, but free to be safe about) still resolves to the project itself.
 *
 * ⚠️ The join is `m.encoded_name = p.encoded_name` — string identity (§3.3), never `projects.id`.
 * ⚠️ A membership row naming a folder that is not currently in `projects` simply produces no row
 * here. That is the correct behaviour between a purge and the sync that follows it, and when a
 * drive is unmounted: the group is intact, one of its folders is not present, and nothing is
 * deleted on the app's own initiative.
 */
export const PROJECT_UNIT_CTE = `project_unit AS (
  SELECT p.id                                                       AS project_id,
         CASE WHEN g.id IS NULL THEN p.id ELSE -g.id END            AS unit_id,
         COALESCE(g.name, p.display_name)                           AS unit_name,
         COALESCE(g.color_index, p.color_index)                     AS unit_color_index,
         CASE WHEN g.id IS NULL THEN p.encoded_name ELSE NULL END    AS unit_encoded_name
  FROM   projects p
  LEFT   JOIN project_group_members m ON m.encoded_name = p.encoded_name
  LEFT   JOIN project_groups        g ON g.id = m.group_id
)`;

/**
 * The unit id for a project id, as a scalar sub-select, for the few queries that cannot afford a
 * join (they already have five CTEs). Same rule as `PROJECT_UNIT_CTE`, expressed inline.
 *
 * ⚠️ Stated in terms of `PROJECT_UNIT_CTE`'s own logic and asserted equal to it by
 * `test/main/db/project-groups.test.ts`, so the two spellings cannot drift.
 */
export function unitIdExpression(projectIdExpression: string): string {
  return `COALESCE((SELECT -g.id FROM project_group_members m
                      JOIN project_groups g ON g.id = m.group_id
                      JOIN projects p2 ON p2.encoded_name = m.encoded_name
                     WHERE p2.id = ${projectIdExpression}), ${projectIdExpression})`;
}

/** One member folder of a group, or the single folder of an ungrouped project. */
export interface ProjectGroupMemberRow {
  /** §3.3 — the identity. Present even when the folder is not currently in `projects`. */
  readonly encodedName: string;
  /** The project's own id, or `null` when no project row currently carries this name. */
  readonly projectId: number | null;
  /** `null` when the folder is not currently present (§3.19). */
  readonly displayName: string | null;
}

/** §4.5 `ProjectGroup`, in row form. */
export interface ProjectGroupRow {
  readonly id: number;
  readonly name: string;
  readonly colorIndex: number;
  readonly createdAt: number;
  readonly members: ProjectGroupMemberRow[];
}

/** Display facts for one project unit — a group, or a project standing alone. */
export interface ProjectUnitName {
  readonly displayName: string;
  /** `null` for a group: a group is not a directory and has no encoded name of its own. */
  readonly encodedName: string | null;
  readonly colorIndex: number;
  /** `null` when this unit is a plain project. */
  readonly groupId: number | null;
}

/** §3.19 — the maximum length of a group name, so a pasted paragraph cannot become a legend. */
export const MAX_GROUP_NAME_LENGTH = 120;

export class ProjectGroupsRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Every group, newest first, each with its member folders. §4.5 `groups:list`. */
  list(): ProjectGroupRow[] {
    const groups = this.all<{
      readonly id: number;
      readonly name: string;
      readonly color_index: number;
      readonly created_at: number;
    }>(
      `SELECT id, name, color_index, created_at
       FROM   project_groups
       ORDER BY created_at DESC, id DESC`,
    );
    const members = new Map<number, ProjectGroupMemberRow[]>();
    for (const row of this.all<{
      readonly group_id: number;
      readonly encoded_name: string;
      readonly project_id: number | null;
      readonly display_name: string | null;
    }>(
      // ⚠️ LEFT JOIN. A member whose folder is not currently in `projects` is REPORTED, not
      // hidden and not deleted: "the group is intact, that folder is not here right now" is a
      // different statement from "that folder was never in the group" (CLAUDE.md §1).
      `SELECT m.group_id AS group_id, m.encoded_name AS encoded_name,
              p.id AS project_id, p.display_name AS display_name
       FROM   project_group_members m
       LEFT   JOIN projects p ON p.encoded_name = m.encoded_name
       ORDER BY m.group_id, m.encoded_name`,
    )) {
      const list = members.get(row.group_id) ?? [];
      list.push({
        encodedName: row.encoded_name,
        projectId: row.project_id,
        displayName: row.display_name,
      });
      members.set(row.group_id, list);
    }
    return groups.map((row) => ({
      id: row.id,
      name: row.name,
      colorIndex: row.color_index,
      createdAt: row.created_at,
      members: members.get(row.id) ?? [],
    }));
  }

  /**
   * Creates one group over two or more folders. §4.5 `groups:create`.
   *
   * ⚠️ `encodedNames` are §3.3 identities supplied by the user's selection, and they are NOT
   * required to resolve to a current `projects` row — see the class header. What IS required is
   * that there are at least two of them and that none is already in another group (§3.19: a
   * project belongs to at most one group), because both of those are things the user can see and
   * fix, and silently absorbing either would change a grouping they did not ask for.
   */
  create(name: string, encodedNames: readonly string[], now: number): ProjectGroupRow[] {
    const cleanName = assertName(name);
    const unique = [...new Set(encodedNames)];
    if (unique.length < 2) {
      throw new DbError(
        'E_INVALID_SETTING',
        'Choose at least two projects before saying they are the same project.',
        { retryable: false },
      );
    }
    this.transaction(() => {
      const taken = this.#alreadyGrouped(unique);
      if (taken.length > 0) {
        throw new DbError(
          'E_INVALID_SETTING',
          `${taken.length === 1 ? 'One of those projects is' : 'Some of those projects are'} ` +
            'already part of another group. Split that group first.',
          { retryable: false },
        );
      }
      const result = this.run(
        `INSERT INTO project_groups (name, color_index, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        cleanName,
        // §3.3's rule applied to the group's name: hue is a pure function of what it is called.
        colorIndexFor(cleanName),
        now,
        now,
      );
      const groupId = Number(result.lastInsertRowid);
      for (const encodedName of unique) {
        this.run(
          `INSERT INTO project_group_members (encoded_name, group_id, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
          encodedName,
          groupId,
          now,
          now,
        );
      }
    });
    return this.list();
  }

  /** §4.5 `groups:rename`. The hue follows the name (§3.3's rule), so it is recomputed. */
  rename(groupId: number, name: string, now: number): ProjectGroupRow[] {
    const cleanName = assertName(name);
    const changed = this.run(
      `UPDATE project_groups SET name = ?, color_index = ?, updated_at = ? WHERE id = ?`,
      cleanName,
      colorIndexFor(cleanName),
      now,
      groupId,
    );
    if (changed.changes === 0) {
      throw new DbError('E_INVALID_SETTING', 'That group no longer exists.', { retryable: false });
    }
    return this.list();
  }

  /**
   * §4.5 `groups:ungroup` — splits the group back apart.
   *
   * ⚠️ **This restores the prior state exactly, and it does so by construction rather than by
   * effort.** The grouping was only ever a label: no event moved, no `projects` row was removed,
   * no `project_id` was rewritten. Deleting the group (members cascade) leaves the database
   * byte-identical to what it was before the group existed, so every figure returns to its
   * pre-group value. `test/metrics/f16-grouped-active-time.test.ts` asserts that rather than
   * trusting it.
   */
  ungroup(groupId: number): ProjectGroupRow[] {
    const changed = this.run('DELETE FROM project_groups WHERE id = ?', groupId);
    if (changed.changes === 0) {
      throw new DbError('E_INVALID_SETTING', 'That group no longer exists.', { retryable: false });
    }
    return this.list();
  }

  /**
   * Unit id → its display facts, for every unit currently resolvable.
   *
   * A group with no currently-present member still appears: it is a real thing the user made,
   * and a chart that quietly forgot it would be hiding the user's own decision. Rows are keyed by
   * unit id, which is `-groupId` for a group.
   */
  unitNames(): Map<number, ProjectUnitName> {
    const map = new Map<number, ProjectUnitName>();
    for (const row of this.all<{
      readonly id: number;
      readonly display_name: string;
      readonly encoded_name: string;
      readonly color_index: number;
    }>(
      `WITH ${PROJECT_UNIT_CTE}
       SELECT DISTINCT u.unit_id AS id, u.unit_name AS display_name,
              COALESCE(u.unit_encoded_name, '') AS encoded_name,
              u.unit_color_index AS color_index
       FROM   project_unit u`,
    )) {
      map.set(row.id, {
        displayName: row.display_name,
        // '' is the SQL-side stand-in for "a group has no folder of its own"; it becomes `null`
        // here and never reaches a payload as an empty string (CLAUDE.md §1a).
        encodedName: row.encoded_name === '' ? null : row.encoded_name,
        colorIndex: row.color_index,
        groupId: row.id < 0 ? -row.id : null,
      });
    }
    for (const group of this.all<{
      readonly id: number;
      readonly name: string;
      readonly color_index: number;
    }>('SELECT id, name, color_index FROM project_groups')) {
      const unitId = -group.id;
      if (map.has(unitId)) continue;
      map.set(unitId, {
        displayName: group.name,
        encodedName: null,
        colorIndex: group.color_index,
        groupId: group.id,
      });
    }
    return map;
  }

  /**
   * The project ids that make up each unit id currently present in `projects`.
   *
   * Used to expand a `GlobalFilter` whose `projectIds` are unit ids (§4.2 as amended) into the
   * real `events.project_id` values the scope clause tests against.
   */
  membersByUnit(): Map<number, number[]> {
    const map = new Map<number, number[]>();
    for (const row of this.all<{ readonly unit_id: number; readonly project_id: number }>(
      `WITH ${PROJECT_UNIT_CTE}
       SELECT unit_id, project_id FROM project_unit`,
    )) {
      const list = map.get(row.unit_id) ?? [];
      list.push(row.project_id);
      map.set(row.unit_id, list);
    }
    return map;
  }

  /**
   * §4.2 — unit ids → real project ids.
   *
   * ⚠️ A unit id that resolves to no project expands to NOTHING rather than to everything. §4.2's
   * empty-selection rule is the same one `scope.ts` and `cost.ts` state: an empty selection
   * selects nothing, because silently widening it is how a scoped number becomes a global one.
   * A group whose folders are all absent therefore shows an empty view, not the whole dataset.
   */
  expandUnitIds(unitIds: readonly number[]): number[] {
    const members = this.membersByUnit();
    const out: number[] = [];
    for (const unitId of unitIds) {
      for (const projectId of members.get(unitId) ?? []) out.push(projectId);
    }
    return [...new Set(out)];
  }

  #alreadyGrouped(encodedNames: readonly string[]): string[] {
    const placeholders = encodedNames.map(() => '?').join(', ');
    return this.all<{ readonly encoded_name: string }>(
      `SELECT encoded_name FROM project_group_members WHERE encoded_name IN (${placeholders})`,
      ...encodedNames,
    ).map((row) => row.encoded_name);
  }
}

/** A group name is the user's own words; it is trimmed and bounded, never generated. */
function assertName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new DbError('E_INVALID_SETTING', 'Give the group a name.', { retryable: false });
  }
  if (trimmed.length > MAX_GROUP_NAME_LENGTH) {
    throw new DbError(
      'E_INVALID_SETTING',
      `That name is longer than ${String(MAX_GROUP_NAME_LENGTH)} characters.`,
      { retryable: false },
    );
  }
  return trimmed;
}
