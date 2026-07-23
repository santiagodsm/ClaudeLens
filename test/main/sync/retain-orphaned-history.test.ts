// ADR-041 — permanent history retention for ORPHANED transcripts.
//
// ⚠️ This is the feature's headline test, and it is the twin of `engine.test.ts`'s ARCHIVED
// case: when a transcript disappears from `<claudeDir>` and the setting is ON, its parsed
// history must SURVIVE the next sync, byte-identical — not silently vanish the way `MISSING`
// used to make it (§5.3, INV-18). With the setting OFF the old delete-and-cascade behaviour
// stands, so a user who wants a pure mirror keeps it (§3.13).
//
// The whole point is a NUMBER that does not move. Every assertion here is hand-anchored against
// the fixture (f03-append/base: sess-a = 5 events, sess-b = 2 events, 7 total) so a regression
// is a wrong count, not a blessed snapshot (CLAUDE.md §1).

import { rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsRepository } from '../../../src/main/db/repositories/analytics';
import { purge } from '../../../src/main/db/purge';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';
import { useSandbox } from '../../support/sandbox';
import { createSyncHarness, fixturePath } from '../../support/sync-harness';

const BETA = 'projects/-work-demo-beta/sess-b.jsonl'; // sess-b, 2 events, no subagents
const UNFILTERED = { filter: { projectIds: null, from: null, to: null }, idleGapMinutes: 15 };

const abs = (root: string, rel: string): string => join(root, ...rel.split('/'));

interface Totals {
  readonly events: number;
  readonly sessions: number;
  readonly toolCalls: number;
  readonly tokens: number;
}

/** Every lifetime aggregate the archived case pins, over the WHOLE dataset (INV-18). */
function totals(db: SqliteDatabase): Totals {
  const one = (sql: string): number => db.prepare<{ n: number | null }>(sql).get()?.n ?? -1;
  return {
    events: one('SELECT COUNT(*) AS n FROM events'),
    sessions: one('SELECT COUNT(DISTINCT session_id) AS n FROM events'),
    toolCalls: one('SELECT COUNT(*) AS n FROM tool_calls'),
    tokens: one(
      'SELECT COALESCE(SUM(tok_input + tok_output + tok_cache_write + tok_cache_read), 0) AS n FROM events',
    ),
  };
}

describe('ADR-041 — orphan retention (the headline)', () => {
  const sandbox = useSandbox();

  it('setting ON: a deleted transcript keeps its history, byte-identical totals (INV-18)', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const harness = createSyncHarness({
      claudeDir: root,
      dbPath: sandbox.resolve('lens.db'),
      retainOrphanedHistory: true,
    });
    await harness.runSync();

    const before = totals(harness.db);
    expect(before).toEqual({ events: 7, sessions: 2, toolCalls: 5, tokens: before.tokens });

    // The file simply vanishes — not archived, no audit entry, no `archives` row. This is the
    // exact event that used to shrink every total on the next sync.
    await rm(abs(root, BETA));
    await harness.runSync();

    // ⚠️ Not one number moved. sess-b's 2 events, its session, its tool calls and its tokens are
    // all still here, because the file is now RETAINED, not MISSING.
    expect(totals(harness.db)).toEqual(before);

    // The manifest row survives and is marked; so is its session.
    expect(
      harness.db
        .prepare<{ retained_orphan: number }>(
          'SELECT retained_orphan FROM file_manifest WHERE rel_path = ?',
        )
        .get(BETA)?.retained_orphan,
    ).toBe(1);
    expect(
      harness.db
        .prepare<{ retained_orphan: number }>(
          "SELECT retained_orphan FROM sessions WHERE id = 'sess-b'",
        )
        .get()?.retained_orphan,
    ).toBe(1);
  });

  it('setting OFF: the same deletion removes the rows (pure mirror preserved)', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const harness = createSyncHarness({
      claudeDir: root,
      dbPath: sandbox.resolve('lens.db'),
      retainOrphanedHistory: false,
    });
    await harness.runSync();
    expect(totals(harness.db).events).toBe(7);

    await rm(abs(root, BETA));
    await harness.runSync();

    // sess-b's 2 events cascaded away: 7 − 2 = 5. Nothing is marked retained.
    expect(totals(harness.db).events).toBe(5);
    expect(
      harness.db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM file_manifest WHERE rel_path = ?')
        .get(BETA)?.n,
    ).toBe(0);
    expect(
      harness.db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE retained_orphan = 1')
        .get()?.n,
    ).toBe(0);
  });

  it('re-appearance: a returned file clears its marker with no double-count (ADR-019 dedup)', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const stash = sandbox.resolve('stash-sess-b.jsonl');
    const harness = createSyncHarness({
      claudeDir: root,
      dbPath: sandbox.resolve('lens.db'),
      retainOrphanedHistory: true,
    });
    await harness.runSync();
    const before = totals(harness.db);

    // Vanish (retained), then come back (restored file / remounted volume).
    await cp(abs(root, BETA), stash);
    await rm(abs(root, BETA));
    await harness.runSync();
    expect(
      harness.db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE retained_orphan = 1')
        .get()?.n,
    ).toBe(1);

    await cp(stash, abs(root, BETA));
    await harness.runSync();

    // ⚠️ The aggregate is IDENTICAL to never-having-lost-it — the returning events dedup against
    // the retained ones by `event_key` (ADR-019), so nothing is counted twice.
    expect(totals(harness.db)).toEqual(before);
    // Both markers cleared: the file is an ordinary tracked file again.
    expect(
      harness.db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM file_manifest WHERE retained_orphan = 1')
        .get()?.n,
    ).toBe(0);
    expect(
      harness.db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE retained_orphan = 1')
        .get()?.n,
    ).toBe(0);
  });

  it('purge-and-rebuild preserves the retained-orphan rows (the data-loss test)', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const harness = createSyncHarness({
      claudeDir: root,
      dbPath: sandbox.resolve('lens.db'),
      retainOrphanedHistory: true,
    });
    await harness.runSync();

    await rm(abs(root, BETA));
    await harness.runSync();
    const retainedEvents = harness.db
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM events WHERE source_file_id IN
           (SELECT id FROM file_manifest WHERE retained_orphan = 1)`,
      )
      .get()?.n;
    expect(retainedEvents).toBe(2);

    // A `claudeDir` change / rebuild. The purge must spare retained-orphan rows exactly as it
    // spares archived ones — the whole reason the guard grew a second clause (§3.18, ADR-041).
    purge(harness.db);

    // sess-b is gone from disk, so a rebuild can NEVER reproduce it. It survives only because the
    // purge left it alone.
    expect(
      harness.db
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-b'")
        .get()?.n,
    ).toBe(2);
    expect(
      harness.db
        .prepare<{ retained_orphan: number }>(
          "SELECT retained_orphan FROM sessions WHERE id = 'sess-b'",
        )
        .get()?.retained_orphan,
    ).toBe(1);
    // The live session's rows WERE purged (they are derivable and would be re-synced).
    expect(
      harness.db
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-a'")
        .get()?.n,
    ).toBe(0);
  });
});

describe('ADR-041 — the §4.6 disclosure', () => {
  const sandbox = useSandbox();

  it('counts retained-orphan sessions and events, and is UNAFFECTED by the global filter', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const harness = createSyncHarness({
      claudeDir: root,
      dbPath: sandbox.resolve('lens.db'),
      retainOrphanedHistory: true,
    });
    await harness.runSync();
    await rm(abs(root, BETA));
    await harness.runSync();

    const analytics = new AnalyticsRepository(harness.db);
    expect(analytics.disclosures(UNFILTERED).retainedOrphanSessions).toBe(1);
    expect(analytics.disclosures(UNFILTERED).retainedOrphanEvents).toBe(2);

    // ⚠️ INV-13-style: a filter that excludes everything (a project id that matches nothing) must
    // NOT change the caveat — it describes the stored dataset, not the current window. If it
    // could be filtered away, a user whose orphaned sessions fell outside the range would see
    // totals with no marker beside them.
    const filtered = { filter: { projectIds: [-999], from: null, to: null }, idleGapMinutes: 15 };
    expect(analytics.disclosures(filtered).retainedOrphanSessions).toBe(1);
    expect(analytics.disclosures(filtered).retainedOrphanEvents).toBe(2);
  });
});

describe('ADR-041 — the honest compaction limit (chosen option (b))', () => {
  const sandbox = useSandbox();
  let stash = '';

  beforeEach(() => {
    stash = sandbox.resolve('compact-src.jsonl');
  });
  afterEach(async () => {
    await rm(stash, { force: true });
  });

  it('does NOT retain messages dropped by an in-place compaction — feature is whole-file only', async () => {
    const { writeFile } = await import('node:fs/promises');
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const harness = createSyncHarness({
      claudeDir: root,
      dbPath: sandbox.resolve('lens.db'),
      retainOrphanedHistory: true,
    });
    await harness.runSync();
    expect(totals(harness.db).events).toBe(7);

    // Compaction: the file is REWRITTEN in place, smaller — old messages dropped, the file stays.
    // This is SHRANK (§5.3), not MISSING, so ADR-041's retention does not apply: the file's rows
    // are re-parsed from scratch and the dropped messages are gone. This test DOCUMENTS that
    // limit honestly (ADR-041 chose option (b)); it does not hide it behind a passing feature.
    await writeFile(
      abs(root, BETA),
      '{"type":"user","uuid":"b-compacted","timestamp":"2024-05-01T09:00:00.000Z","message":{"role":"user"}}\n',
    );
    await harness.runSync();

    // sess-b's two ORIGINAL events are gone (dropped by the compaction and NOT retained); one new
    // event took their place. 7 − 2 + 1 = 6. If retention ever grows to cover compaction, THIS is
    // the number that must change, and this test is where the decision gets re-made deliberately.
    expect(totals(harness.db).events).toBe(6);
    expect(
      harness.db
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE event_key = 'b1'")
        .get()?.n,
    ).toBe(0);
    // And it is NOT falsely marked retained — the file is present, just smaller.
    expect(
      harness.db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE retained_orphan = 1')
        .get()?.n,
    ).toBe(0);
  });
});
