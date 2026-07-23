// §4.6 (A-05) — the three cache-write-split disclosures, as DATA in the success payload.
//
// ⚠️ The point of this suite is the ARCHIVED case, and it is worth stating why it needs its own
// count and its own sentence rather than being folded into the other one.
//
// After migration 0005 every already-parsed cache-writing event carries `tok_cache_write_1h IS
// NULL` — "the split is not known" — and is costed entirely at the 5-minute rate, which is what it
// cost before the migration. For a LIVE session that is temporary: DERIVED data is rebuildable, a
// re-sync re-reads the transcript and fills the split in. ⚠️⚠️ For an ARCHIVED session it is
// permanent. Its transcripts have left the Claude data directory, §5.3 `ARCHIVED` never re-parses
// them, and §9.4 says the database is the only live representation of that history — so its
// 1-hour cache writes can never be recovered and it will be understated forever. Telling that user
// to "re-sync" would be advice that cannot work.
//
// The user currently has no archives, so this is prevention rather than repair, which is the only
// time it can be added cheaply — and the only time a test can prove it without waiting for the
// damage.

import { describe, expect, it } from 'vitest';
import { AnalyticsRepository } from '../../../src/main/db/repositories/analytics';
import { useSandbox } from '../../support/sandbox';
import { T0, seedAcrossArchiveBoundary, useTestDatabases } from './helpers';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';

const UNFILTERED = { filter: { projectIds: null, from: null, to: null }, idleGapMinutes: 15 };

let nextId = 100;

/**
 * One event on an existing session. `cacheWrite1h` is written verbatim: `null` is SQL NULL, which
 * is precisely what migration 0005 leaves every pre-existing row carrying.
 */
function addEvent(
  db: SqliteDatabase,
  sessionId: string,
  projectId: number,
  fileId: number,
  cacheWrite: number,
  cacheWrite1h: number | null,
): void {
  nextId += 1;
  db.prepare(
    `INSERT INTO events (id, event_key, session_id, project_id, source_file_id, line_no, ts,
       type, role, origin, uuid, is_sidechain, model, is_synthetic, is_api_error,
       tok_input, tok_output, tok_cache_write, tok_cache_write_1h, tok_cache_read)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'assistant', 'assistant', 'main', ?, 0, 'model-a', 0, 0,
             0, 0, ?, ?, 0)`,
  ).run(
    nextId,
    `evt-${String(nextId)}`,
    sessionId,
    projectId,
    fileId,
    nextId,
    T0,
    `u-${String(nextId)}`,
    cacheWrite,
    cacheWrite1h,
  );
}

describe('§4.6 (A-05) — the cache-write-split disclosures', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('⚠️⚠️ counts an ARCHIVED session’s unknown splits separately — they can never be recovered', () => {
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);

    // Two archived cache-writing events with an unknown split: permanently understated.
    addEvent(db, 's-archived', 2, 2, 5_000, null);
    addEvent(db, 's-archived', 2, 2, 1_200, null);
    // One live one: recoverable by a re-sync.
    addEvent(db, 's-live', 1, 1, 900, null);
    // A live event that HAS been re-parsed: nothing to disclose about it at all.
    addEvent(db, 's-live', 1, 1, 700, 300);
    // ⚠️ And an event with no cache writes at all, whose NULL split is meaningless: it must not
    // inflate either count, or the disclosure would name records the user cannot act on.
    addEvent(db, 's-live', 1, 1, 0, null);

    const disclosures = new AnalyticsRepository(db).disclosures(UNFILTERED);

    expect(disclosures.cacheSplitArchivedEvents).toBe(2);
    expect(disclosures.cacheSplitUnknownEvents).toBe(1);
    // The two counts are disjoint by construction (`archive_id IS NULL` vs `IS NOT NULL`), so an
    // archived record is never also offered as something a re-sync will fix.
    expect(disclosures.cacheSplitUnknownEvents).not.toBe(3);
  });

  it('reports nothing at all once every cache-writing event carries a real split', () => {
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);
    addEvent(db, 's-archived', 2, 2, 5_000, 0);
    addEvent(db, 's-live', 1, 1, 700, 300);

    const disclosures = new AnalyticsRepository(db).disclosures(UNFILTERED);

    // ⚠️ `0` here means "there is nothing to disclose", and it is reached because the rows carry
    // an explicit 0 rather than a NULL — the difference between "no 1-hour writes" and "we do not
    // know". A build that stored `0` for both would report 0 here while still understating.
    expect(disclosures.cacheSplitUnknownEvents).toBe(0);
    expect(disclosures.cacheSplitArchivedEvents).toBe(0);
    expect(disclosures.cacheSplitMismatches).toBe(0);
  });

  it('counts §5.4 rule 8’s sum-assertion failures from the manifest, like bad lines', () => {
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);
    db.prepare('UPDATE file_manifest SET cache_split_mismatches = ? WHERE id = ?').run(3, 1);
    db.prepare('UPDATE file_manifest SET cache_split_mismatches = ? WHERE id = ?').run(2, 3);

    expect(new AnalyticsRepository(db).disclosures(UNFILTERED).cacheSplitMismatches).toBe(5);
  });

  it('does not let a date filter hide the caveat while the $ figure stays understated', () => {
    // ⚠️ These counts are deliberately UNFILTERED. If they honoured the `GlobalFilter`, a user
    // whose stale rows happened to fall outside the current range would see a cost figure that is
    // still understated with nothing beside it saying so — a caveat that disappears while the
    // thing it qualifies does not (§6.12, INV-10).
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);
    addEvent(db, 's-archived', 2, 2, 5_000, null);

    const analytics = new AnalyticsRepository(db);
    const windowed = analytics.disclosures({
      filter: { projectIds: null, from: T0 + 10_000_000, to: T0 + 20_000_000 },
      idleGapMinutes: 15,
    });

    expect(windowed.cacheSplitArchivedEvents).toBe(1);
  });
});
