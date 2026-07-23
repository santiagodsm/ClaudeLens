// F-16 — **"I moved the project, so these two folders are the same project."** ADR-040, §3.19.
//
// The fixture that pins the one thing grouping genuinely changes: the ACTIVE-TIME PARTITION.
//
// ⚠️⚠️ **Grouping must be applied when the partition is formed, not by adding up two projects'
// finished results.** Once two folders are one project, a gap between them on the same local day
// is a gap INSIDE one partition: M-07 caps it at the idle threshold and COUNTS it, exactly as
// ADR-036 binding (C) already counts an intra-day inter-session gap. Summing the two ungrouped
// values instead silently drops that gap. It is the same class of mistake fixture F-12 exists to
// catch, and this file catches it the same way — with a `not.toBe()` on the naive sum.
//
// ⚠️ §5.9.1's warning on F-12 applies here word for word: **a fixture whose two projects are
// active on DIFFERENT days passes under both readings and proves nothing.** Both projects here
// are active on the same pinned local day (`TZ = Asia/Tokyo`, ADR-021).
//
// The fixture (`test/fixtures/f16-moved-project`), idle threshold 15 minutes:
//   · `-work-demo-family-app-old` — local 09:00, 09:10, 09:20
//   · `-work-demo-family-app-new` — local 09:50, 10:00, 10:10
//
// ⚠️ Nothing in this file, and nothing in the code it exercises, INFERS the grouping. The two
// folder names are deliberately similar and that similarity is never read: the group is created
// by an explicit call carrying the two `encoded_name`s a user would have ticked (§2.1, zero
// inference). The last test in this file asserts that no grouping appears on its own.

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { at, loadFixture, unitFilter, type MetricsFixture } from './support/metrics-harness';
import { assertTimezonePinned, usePinnedTimezone } from './support/pinned-tz';
import { purge } from '../../src/main/db/purge';

const OLD = '-work-demo-family-app-old';
const NEW = '-work-demo-family-app-new';
const T0 = 1_714_521_600_000; // 2024-05-01T00:00:00Z, which is 09:00 in Asia/Tokyo

/** The one grouping this file ever makes. The names are the USER's choice, always. */
function groupTheTwoFolders(fixture: MetricsFixture): number {
  const rows = fixture.groups.create('Family App', [OLD, NEW], T0);
  expect(rows).toHaveLength(1);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the fixture could not create the group');
  return id;
}

/** ADR-040 — a group's unit id is `-groupId`; `projects.id` is a rowid alias and never negative. */
function unitIdOf(groupId: number): number {
  return -groupId;
}

describe('F-16 — grouping changes the active-time partition, not the numbers underneath', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('computes active time over the MERGED partition, not the sum of the two projects', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f16-moved-project');

    // ── Hand-computed expected values, cap = 15m ────────────────────────────────────────
    //
    // UNGROUPED — two partitions on `2024-05-01`, one per project:
    //   old : 09:00 → 09:10 = 10m ; 09:10 → 09:20 = 10m            = 20m = 1_200 s
    //   new : 09:50 → 10:00 = 10m ; 10:00 → 10:10 = 10m            = 20m = 1_200 s
    //   binding (C) total   = 1_200 + 1_200                        = 40m = 2_400 s
    //
    // GROUPED — ONE partition on `2024-05-01`, the merged timestamp-ordered stream
    // 09:00, 09:10, 09:20, 09:50, 10:00, 10:10:
    //   09:00              first event of the partition            →  0
    //   09:00 → 09:10      10m                                     → 10m
    //   09:10 → 09:20      10m                                     → 10m
    //   09:20 → 09:50      30m > 15m, CAPPED and COUNTED           → 15m   ← the whole point
    //   09:50 → 10:00      10m                                     → 10m
    //   10:00 → 10:10      10m                                     → 10m
    //   TOTAL              10 + 10 + 15 + 10 + 10                  = 55m = 3_300 s
    //
    // The two readings therefore disagree by exactly the capped inter-folder gap, 15m = 900 s.
    const context = at(15);

    const before = fixture.analytics.overviewTiles(context);
    expect(before.activeSeconds).toBe(2_400);

    groupTheTwoFolders(fixture);

    const after = fixture.analytics.overviewTiles(context);
    expect(after.activeSeconds).toBe(3_300);
    // ⚠️ THE ASSERTION THIS FIXTURE EXISTS FOR. Adding the two projects' finished results gives
    // 2_400 s, and an implementation that grouped after the fact would produce exactly that.
    expect(after.activeSeconds).not.toBe(2_400);
    expect(after.activeSeconds - before.activeSeconds).toBe(900);
  });

  it('holds INV-21 under grouping: the tile equals the sum of the working-day rows', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f16-moved-project');
    const context = at(15);

    // Ungrouped: two rows of 1_200 s on the one day.
    const rowsBefore = fixture.analytics.workingDays(context, { limit: 100 }).rows;
    expect(rowsBefore).toHaveLength(2);
    expect(rowsBefore.map((row) => row.activeSeconds).toSorted()).toEqual([1_200, 1_200]);
    expect(fixture.analytics.overviewTiles(context).activeSeconds).toBe(
      rowsBefore.reduce((total, row) => total + row.activeSeconds, 0),
    );

    const groupId = groupTheTwoFolders(fixture);

    // Grouped: ONE row, 3_300 s, named by the user's own words and keyed by the unit id.
    const rowsAfter = fixture.analytics.workingDays(context, { limit: 100 }).rows;
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0]?.day).toBe('2024-05-01');
    expect(rowsAfter[0]?.projectId).toBe(unitIdOf(groupId));
    expect(rowsAfter[0]?.displayName).toBe('Family App');
    expect(rowsAfter[0]?.activeSeconds).toBe(3_300);
    // M-08 `spanSeconds` = last − first within the merged group = 09:00 → 10:10 = 70m.
    expect(rowsAfter[0]?.spanSeconds).toBe(4_200);
    expect(rowsAfter[0]?.sessions).toBe(2);

    // ⚠️ INV-21 stated as the invariant, not as two equal literals: the tile IS the sum of the
    // rows for the same filter, exactly — under the grouping.
    const tile = fixture.analytics.overviewTiles(context).activeSeconds;
    expect(tile).toBe(rowsAfter.reduce((total, row) => total + row.activeSeconds, 0));

    // …and the project card, which is binding (C) restricted to the unit (INV-21's second
    // sentence). One card now, not two.
    const cards = fixture.analytics.projectCards(context);
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0]?.projectId).toBe(unitIdOf(groupId));
    expect(cards.rows[0]?.activeSeconds).toBe(tile);
    // ⚠️ A group is not a directory, so it has no folder name of its own — never an empty string.
    expect(cards.rows[0]?.encodedName).toBeNull();
    expect(cards.rows[0]?.groupId).toBe(groupId);
    // Nothing is hidden: both folders travel with the card, each with the numbers it has alone.
    expect(cards.rows[0]?.members.map((m) => m.encodedName).toSorted()).toEqual([NEW, OLD]);
    expect(cards.rows[0]?.members.map((m) => m.activeSeconds).toSorted()).toEqual([1_200, 1_200]);
    // …which is 2_400 s and deliberately NOT the card's 3_300 s. §6.8 says so on screen.
    expect(
      cards.rows[0]?.members.reduce((total, member) => total + member.activeSeconds, 0),
    ).not.toBe(cards.rows[0]?.activeSeconds);
  });

  it('drops the cross-project overlap, and a scope of one group reports 0 (INV-22(d))', async () => {
    assertTimezonePinned();
    // F-13's fixture: alpha 09:00/09:10/09:20 and beta 09:05/09:15/09:25 INTERLEAVE (so their
    // covered intervals genuinely intersect), and gamma 10:00/10:10/10:20 is disjoint.
    const fixture = await loadFixture(sandbox, 'f13-overlap');
    const context = at(15);

    // ── Hand-computed, ungrouped ────────────────────────────────────────────────────────
    //   alpha  [09:00,09:10]+[09:10,09:20] = 20m
    //   beta   [09:05,09:15]+[09:15,09:25] = 20m
    //   gamma  [10:00,10:10]+[10:10,10:20] = 20m
    //   binding (C) total = 60m = 3_600 s
    //   M-19 union        = [09:00,09:25] ∪ [10:00,10:20] = 25m + 20m = 45m = 2_700 s
    //   M-20 overlap      = 3_600 − 2_700                             = 15m =   900 s
    const before = fixture.active.overlap(context);
    expect(before.activeSeconds).toBe(3_600);
    expect(before.overlapSeconds).toBe(900);

    // The user says alpha and beta are the same project — the two that were double-counted.
    const groupId = fixture.groups.create(
      'One project',
      ['-work-demo-alpha', '-work-demo-beta'],
      T0,
    )[0]?.id;
    if (groupId === undefined) throw new Error('the fixture could not create the group');

    // ── Hand-computed, grouped ──────────────────────────────────────────────────────────
    //   the group's merged stream is 09:00, 09:05, 09:10, 09:15, 09:20, 09:25 — five 5m gaps
    //                     = 25m = 1_500 s
    //   gamma             = 20m = 1_200 s
    //   binding (C) total = 45m = 2_700 s
    //   M-19 union        = [09:00,09:25] ∪ [10:00,10:20] = 45m = 2_700 s  (unchanged: the union
    //                       is a measure of clock time and does not care how it is partitioned)
    //   M-20 overlap      = 2_700 − 2_700 = 0
    const after = fixture.active.overlap(context);
    expect(after.activeSeconds).toBe(2_700);
    expect(after.dedupMs).toBe(before.dedupMs); // the union is untouched by the label
    expect(after.overlapSeconds).toBe(0);
    // ⚠️ Non-negative, always (INV-22(b)) — and reached by the arithmetic, not by a clamp.
    expect(after.overlapSeconds).toBeGreaterThanOrEqual(0);

    // INV-22(d) — a scope containing ONE project reports overlap 0, and a group IS one project.
    const groupOnly = at(15, unitFilter(fixture, [-groupId]));
    const scoped = fixture.active.overlap(groupOnly);
    expect(scoped.activeSeconds).toBe(1_500);
    expect(scoped.overlapSeconds).toBe(0);
    // …and the tile carries it, because INV-23 makes the disclosure mandatory.
    expect(fixture.analytics.overviewTiles(groupOnly).overlapSeconds).toBe(0);
  });

  it('makes the group the unit everywhere a project appears', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f16-moved-project');
    const context = at(15);
    const groupId = groupTheTwoFolders(fixture);
    const unit = unitIdOf(groupId);

    // The treemap (§6.4 `q:tokensByProject`) — one slice, both folders' output.
    const treemap = fixture.analytics.tokensByProject(context);
    expect(treemap.rows).toHaveLength(1);
    expect(treemap.rows[0]?.projectId).toBe(unit);
    expect(treemap.rows[0]?.displayName).toBe('Family App');
    // Six events, one output token each (the fixture), all under one project now.
    expect(treemap.rows[0]?.outputTokens).toBe(6);

    // The sessions table (§6.5) — both sessions report the group as their project.
    const sessions = fixture.analytics.sessions(context, { limit: 100 }, 'firstTs', 'asc');
    expect(sessions.page.rows).toHaveLength(2);
    expect(sessions.page.rows.map((row) => row.projectId)).toEqual([unit, unit]);
    expect(sessions.page.rows.map((row) => row.displayName)).toEqual(['Family App', 'Family App']);

    // The tool-mix-by-project panel (§6.6) keys on the unit too. The fixture has no tool calls,
    // so the assertion that carries weight is that nothing reports a raw project id.
    for (const project of fixture.analytics.toolMixByProject(context, 5).projects) {
      expect(project.projectId).toBe(unit);
    }

    // The file panel (§6.8) accepts the unit id and resolves it to the folders it stands for.
    expect(() => fixture.analytics.fileMetrics(context, { limit: 10 }, unit)).not.toThrow();
  });

  it('splits back apart and restores every figure exactly', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f16-moved-project');
    const context = at(15);

    // A full before-picture: not one number, but every project-shaped payload this change can
    // reach. "Restores the prior state exactly" is only worth asserting if it is asserted wide.
    const snapshot = (): string =>
      JSON.stringify({
        tiles: fixture.analytics.overviewTiles(context),
        workingDays: fixture.analytics.workingDays(context, { limit: 100 }),
        cards: fixture.analytics.projectCards(context),
        treemap: fixture.analytics.tokensByProject(context),
        cost: fixture.analytics.costBreakdown(context, 'project'),
        sessions: fixture.analytics.sessions(context, { limit: 100 }, 'firstTs', 'asc'),
        disclosures: fixture.analytics.disclosures(context),
      });

    const before = snapshot();
    const groupId = groupTheTwoFolders(fixture);
    expect(snapshot()).not.toBe(before); // the grouping really did move numbers

    fixture.groups.ungroup(groupId);

    // ⚠️ Byte-identical. The grouping was a label over real data: no event moved, no `projects`
    // row was removed, no `project_id` was rewritten, so there is nothing to reconstruct.
    expect(snapshot()).toBe(before);
    expect(fixture.groups.list()).toHaveLength(0);
  });

  it('survives a purge and rebuild, because membership keys on encoded_name (§3.19)', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f16-moved-project');
    const context = at(15);
    const groupId = groupTheTwoFolders(fixture);
    expect(fixture.analytics.overviewTiles(context).activeSeconds).toBe(3_300);

    const idsBefore = fixture.db
      .prepare<{ id: number; encoded_name: string }>(
        'SELECT id, encoded_name FROM projects ORDER BY encoded_name',
      )
      .all();
    expect(idsBefore).toHaveLength(2);

    // ⚠️ THE TRAP. §3.18's purge deletes every un-archived `projects` row; the rows come back
    // with DIFFERENT surrogate ids. A membership table keyed on `projects.id` would now point at
    // whatever landed on those ids — a merge nobody asked for, with nothing to see.
    purge(fixture.db);
    expect(fixture.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM projects').get()?.n).toBe(
      0,
    );
    // USER class: the group is still there after the purge, untouched (INV-12, ADR-026).
    expect(fixture.groups.list()).toHaveLength(1);
    expect(
      fixture.groups
        .list()[0]
        ?.members.map((m) => m.encodedName)
        .toSorted(),
    ).toEqual([NEW, OLD]);

    // Rebuild: re-insert the two projects the way ingest does, which hands out NEW ids. The ids
    // are deliberately pushed past the originals so a stale id-keyed membership could not match
    // by accident.
    fixture.db
      .prepare(
        `INSERT INTO projects (id, encoded_name, display_name, color_index)
         VALUES (101, ?, 'family-app-new', 0), (102, ?, 'family-app-old', 1)`,
      )
      .run(NEW, OLD);
    for (const row of idsBefore) {
      expect([101, 102]).not.toContain(row.id);
    }

    // The group still names the same two folders, now resolved to the NEW ids.
    const resolved = fixture.groups.expandUnitIds([unitIdOf(groupId)]).toSorted();
    expect(resolved).toEqual([101, 102]);
    const listed = fixture.groups.list()[0];
    expect(listed?.name).toBe('Family App');
    expect(listed?.members.map((m) => m.projectId).toSorted()).toEqual([101, 102]);
    expect(listed?.members.every((m) => m.displayName !== null)).toBe(true);
  });

  it('never suggests, guesses or auto-detects a grouping (§2.1, zero inference)', async () => {
    assertTimezonePinned();
    // The two folder names differ by three characters and encode two paths one `mv` apart —
    // exactly the case a name-matching heuristic would "helpfully" merge.
    const fixture = await loadFixture(sandbox, 'f16-moved-project');
    const context = at(15);

    expect(fixture.groups.list()).toEqual([]);
    // Two cards, two working-day rows, two of everything: the app has drawn no conclusion.
    expect(fixture.analytics.projectCards(context).rows).toHaveLength(2);
    expect(fixture.analytics.workingDays(context, { limit: 100 }).rows).toHaveLength(2);
    expect(fixture.analytics.overviewTiles(context).activeSeconds).toBe(2_400);
    for (const card of fixture.analytics.projectCards(context).rows) {
      expect(card.groupId).toBeNull();
      expect(card.members).toHaveLength(1);
    }

    // ⚠️ And there is no surface that could offer one: the repository's method names are the
    // whole vocabulary, and none of them is a suggestion. A "candidates"/"similar"/"suggested"
    // method appearing here later is the thing this assertion is guarding against.
    const surface = Object.getOwnPropertyNames(
      Object.getPrototypeOf(fixture.groups) as object,
    ).toSorted();
    expect(surface).toEqual([
      'constructor',
      'create',
      'expandUnitIds',
      'list',
      'membersByUnit',
      'rename',
      'ungroup',
      'unitNames',
    ]);
  });
});
