// One sandboxed SQLite file, one fixture tree driven through the REAL parser, one
// `AnalyticsRepository` over the result.
//
// ⚠️ STACK ADR-013: "Fixtures reach the database through the real parser." Nothing here inserts a
// row by hand — a fixture that hand-wrote `events` would prove the arithmetic and nothing about
// whether the arithmetic is ever fed the right rows (which is where ADR-035's both-origins rule
// actually lives).
//
// This file is not a test: the `main` Vitest project collects only `*.{test,spec}.ts`.

import { AnalyticsRepository } from '../../../src/main/db/repositories/analytics';
import { ActiveTimeRepository } from '../../../src/main/db/repositories/active-time';
import { ProjectGroupsRepository } from '../../../src/main/db/repositories/project-groups';
import type { QueryContext } from '../../../src/main/db/repositories/scope';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';
import type { GlobalFilter } from '../../../src/shared/ipc-contract';
import type { Sandbox } from '../../support/sandbox';
import { createSyncHarness, fixturePath } from '../../support/sync-harness';

export interface MetricsFixture {
  readonly db: SqliteDatabase;
  readonly analytics: AnalyticsRepository;
  readonly active: ActiveTimeRepository;
  /** ADR-040 — the user's "these folders are the same project". USER class; never purged. */
  readonly groups: ProjectGroupsRepository;
  /** `projects.id` for a `projects/<encoded>` directory name (§3.3 — the identity). */
  projectId(encodedName: string): number;
}

/** Every `loadFixture()` call gets its own directory and its own SQLite file (STACK ADR-013). */
let loadCounter = 0;

/** Copies a committed fixture into the sandbox, syncs it, and opens the analytics seam over it. */
export async function loadFixture(sandbox: Sandbox, name: string): Promise<MetricsFixture> {
  // ⚠️ The counter is not cosmetic: two `loadFixture(sandbox, 'x')` calls in one test must be two
  // INDEPENDENT databases, or the second silently inherits whatever the first wrote (price rows,
  // seeded harness nodes) and an assertion about the "unpriced" case quietly stops testing it.
  loadCounter += 1;
  const suffix = `${name}-${String(loadCounter)}`;
  const root = await sandbox.copyFixture(fixturePath(name), `root-${suffix}`);
  const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve(`${suffix}.db`) });
  await harness.runSync();
  return {
    db: harness.db,
    analytics: new AnalyticsRepository(harness.db),
    active: new ActiveTimeRepository(harness.db),
    groups: new ProjectGroupsRepository(harness.db),
    projectId(encodedName: string): number {
      const row = harness.db
        .prepare<{ id: number }>('SELECT id FROM projects WHERE encoded_name = ?')
        .get(encodedName);
      if (row === undefined) throw new Error(`fixture has no project ${encodedName}`);
      return row.id;
    },
  };
}

/** The unbounded filter — `null` on all three fields is §4.2's "everything". */
export const ALL: GlobalFilter = { projectIds: null, from: null, to: null };

/** A `QueryContext` at a stated idle threshold. Never defaulted: INV-05 turns on varying it. */
export function at(idleGapMinutes: number, filter: GlobalFilter = ALL): QueryContext {
  return { filter, idleGapMinutes };
}

/**
 * ADR-040 — a filter naming **project unit** ids, expanded exactly as `DatasetService` expands
 * it at the IPC edge.
 *
 * ⚠️ The expansion is deliberately the production one (`expandUnitIds`) rather than a second
 * implementation in the test: a filter that a fixture expanded by hand would prove the arithmetic
 * and nothing about whether the app ever feeds it the right project ids.
 */
export function unitFilter(fixture: MetricsFixture, unitIds: readonly number[]): GlobalFilter {
  return { projectIds: fixture.groups.expandUnitIds(unitIds), from: null, to: null };
}
