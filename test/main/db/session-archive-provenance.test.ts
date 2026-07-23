// §4.5 `SessionRow.archiveId` / `archiveRoot` — the provenance §6.5's neutral "archived" badge
// needs, and the `LEFT` join that must never become an inner one.
//
// ⚠️ **This file exists for one failure mode.** `sessions.archive_id` is NULL for every live
// session (§3.4, ADR-033). Join `archives` on it with an inner join and `q:sessions` quietly
// returns only the sessions that have been archived — the table shrinks, nothing throws, no
// number is visibly wrong, and the user sees a shorter list they have no reason to distrust.
// That is CLAUDE.md §1's failure exactly, arriving through a two-letter edit. Both assertions
// below are therefore made with a live session AND an archived session in the same database:
// with only one kind present, an inner join passes and proves nothing.
//
// ⚠️ These fields are provenance, NOT metrics. INV-18 ("archiving changes no number") is asserted
// by F-04; nothing here weakens it. What is asserted here is the complementary half — that the
// two fields the archive legitimately *does* change carry the truth from the columns that hold
// it, rather than being inferred from an `archives:list` date range (§4.5 as amended (E9)).

import { describe, expect, it } from 'vitest';
import { SessionStatsRepository } from '../../../src/main/db/repositories/session-stats';
import type { QueryContext } from '../../../src/main/db/repositories/scope';
import { useSandbox } from '../../support/sandbox';
import { seedAcrossArchiveBoundary, useTestDatabases } from './helpers';

/** All time, all projects — provenance is not a windowed fact. */
const ALL_TIME: QueryContext = {
  filter: { projectIds: null, from: null, to: null },
  idleGapMinutes: 15,
};

/** What `seedAcrossArchiveBoundary()` writes: `s-live` is live, `s-archived` is archive 1. */
const ARCHIVE_ROOT = '/sandbox/archive';

describe('§4.5 SessionRow — archive provenance (§6.5 Degraded, ADR-033)', () => {
  const sandbox = useSandbox();
  const databases = useTestDatabases(sandbox);

  it('⚠️ LEFT joins `archives`: the live session survives and reports null/null', () => {
    const db = databases.openMigrated();
    seedAcrossArchiveBoundary(db);
    const sessions = new SessionStatsRepository(db);

    const rows = sessions.sessionPage(ALL_TIME, { limit: 50 }, 'firstTs', 'asc').rows;

    // ⚠️ The load-bearing line. An inner join returns ONE row here and every assertion below
    // about the archived session still passes.
    expect(rows.map((row) => row.id).toSorted()).toEqual(['s-archived', 's-live']);

    const live = rows.find((row) => row.id === 's-live');
    expect(live).toMatchObject({ archiveId: null, archiveRoot: null });

    const archived = rows.find((row) => row.id === 's-archived');
    expect(archived).toMatchObject({ archiveId: 1, archiveRoot: ARCHIVE_ROOT });
  });

  it('reports the same provenance through the drill-down, so the two surfaces cannot disagree', () => {
    const db = databases.openMigrated();
    seedAcrossArchiveBoundary(db);
    const sessions = new SessionStatsRepository(db);

    // §4.5 `q:sessionDetail` takes no `GlobalFilter`; the badge in the drawer and the badge in
    // the table row are the same fact and must be read from the same columns.
    expect(sessions.sessionRow('s-live', 15)).toMatchObject({
      archiveId: null,
      archiveRoot: null,
    });
    expect(sessions.sessionRow('s-archived', 15)).toMatchObject({
      archiveId: 1,
      archiveRoot: ARCHIVE_ROOT,
    });
  });
});
