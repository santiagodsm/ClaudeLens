// A-16 / DESIGN §3.18 — the **explicit rebuild**: read every transcript again from the start.
//
// §3.18 has always said the purge runs on "`claudeDir` changed, **or an explicit rebuild**", and
// §6.11 has always specified a *Rebuild derived data* control. Nothing ever triggered it. So a
// line committed under an older build was never read again — incremental sync resumes from
// `byte_offset` (§5.2 rule 3, §5.3 `GREW`) and `kind: 'full'` only refuses to coalesce (§4.4) —
// and everything the app learned to record afterwards was permanently absent from that history.
//
// ⚠️⚠️ **THE THREE PROPERTIES THIS SUITE EXISTS FOR, and each has a discriminator so a pass
// cannot be an accident:**
//
//   1. It really re-reads. The control run is `sync:start { kind: 'full' }`, which is the thing
//      that LOOKS like it should do this and does not — if the rebuild assertion ever passes for
//      the wrong reason, the control passes too and the pair fails together.
//   2. RETAINED and USER data survive it. An archived session, a vanished-but-retained session,
//      a hand-corrected price row, the audit trail and a user's project group are all still there
//      afterwards, unchanged (ADR-026/033/041, INV-12/INV-18). A rebuild that quietly shrank a
//      lifetime total would be this project's defining failure with a button attached to it.
//   3. Cancelling it leaves a consistent database. Committed files stay committed, uncommitted
//      ones are simply not there yet, and the next ordinary sync converges to exactly the state an
//      uninterrupted rebuild produces (§5.2 rules 3–4).
//
// One real SQLite file per test in a sandbox, one real Claude data directory in the same sandbox,
// the real parser, the real purge and the real sync engine (STACK ADR-013).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PushEmitterMap } from '../../../src/shared/ipc-contract';
import { DatasetService, claudeDirFingerprint } from '../../../src/main/ipc/dataset';
import { isHandlerError } from '../../../src/main/ipc/errors';
import { EventStatsRepository } from '../../../src/main/db/repositories/event-stats';
import { IngestRepository } from '../../../src/main/db/repositories/ingest-repo';
import { ManifestRepository } from '../../../src/main/db/repositories/manifest-repo';
import { silentLogger } from '../../../src/main/log/logger';
import { createSyncWork, type PlannedFile, type SyncWork } from '../../../src/main/sync/engine';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';
import type { WatchHandle } from '../../../src/main/watcher/watcher';
import { useSandbox } from '../../support/sandbox';
import { T0, countRows, seedAcrossArchiveBoundary, useTestDatabases } from '../db/helpers';

const TS = '2024-05-01T09:00:00.000Z';

/** SM-5 is not under test here; a watch that never fires keeps every cycle deterministic. */
function inertWatch(): WatchHandle {
  return {
    on(): unknown {
      return this;
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function noEmitters(): PushEmitterMap {
  return {
    'evt:sync': () => undefined,
    'evt:dataChanged': () => undefined,
    'evt:pricingChanged': () => undefined,
    'evt:actionCompleted': () => undefined,
    'evt:dirStatus': () => undefined,
    'evt:fatal': () => undefined,
  };
}

/**
 * One transcript record carrying its API-call id, exactly as Claude Code writes it: several lines
 * of ONE assistant turn share `message.id` and repeat the identical usage, each with its own
 * `uuid` (migration 0011). `messageId` omitted ⇒ the field is absent from the JSON entirely.
 */
function record(uuid: string, tokens: number, messageId?: string): string {
  const message: Record<string, unknown> = {
    role: 'assistant',
    model: 'claude-test-1',
    usage: { input_tokens: tokens, output_tokens: tokens },
  };
  if (messageId !== undefined) message['id'] = messageId;
  return `${JSON.stringify({ type: 'assistant', uuid, timestamp: TS, message })}\n`;
}

/**
 * A real Claude data directory. Two transcripts in two projects, so the cancellation test has a
 * "committed" file and an "uncommitted" one to tell apart.
 *
 * `sess-a` holds one API call written as three records plus one written as two — 5 records that
 * repeat a call, hand-counted, out of the 7 that carry tokens in this file.
 */
async function makeClaudeDir(root: string): Promise<string> {
  await mkdir(join(root, 'projects', '-work-demo-alpha'), { recursive: true });
  await mkdir(join(root, 'projects', '-work-demo-beta'), { recursive: true });
  await writeFile(
    join(root, 'projects', '-work-demo-alpha', 'sess-a.jsonl'),
    record('u1', 100, 'msg_A') +
      record('u2', 100, 'msg_A') +
      record('u3', 100, 'msg_A') +
      record('u4', 50, 'msg_B') +
      record('u5', 50, 'msg_B') +
      record('u6', 20, 'msg_C') +
      // States no id at all: it must stay NULL, and it is still part of the checked population.
      record('u7', 9),
  );
  await writeFile(
    join(root, 'projects', '-work-demo-beta', 'sess-b.jsonl'),
    record('u8', 11, 'msg_D') + record('u9', 11, 'msg_D'),
  );
  await writeFile(join(root, 'history.jsonl'), '');
  return root;
}

interface Rig {
  readonly dataset: DatasetService;
  readonly db: SqliteDatabase;
  readonly claudeDir: string;
  /** §4.8 — how many times the first-sync-after-ready hook fired (the harness scan trigger). */
  readonly readyCount: () => number;
}

/**
 * A booted, READY dataset over a real directory whose transcripts are already ingested.
 * `createWork` is a seam only where a test needs one; by default the real engine runs.
 */
async function boot(
  db: SqliteDatabase,
  claudeDir: string,
  createWork?: (dir: string) => SyncWork,
): Promise<Rig> {
  db.prepare(
    'INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run('claudeDir', JSON.stringify(claudeDir), T0, T0);
  db.prepare('INSERT INTO meta (key, value_json, updated_at) VALUES (?, ?, ?)').run(
    'claudeDirFingerprint',
    JSON.stringify(claudeDirFingerprint(claudeDir)),
    T0,
  );

  let readyCount = 0;
  const dataset = new DatasetService({
    db,
    logger: silentLogger(),
    emit: noEmitters(),
    now: () => T0,
    watchFactory: () => inertWatch(),
    onReady: () => {
      readyCount += 1;
    },
    ...(createWork === undefined ? {} : { createWork }),
  });
  await dataset.boot();
  await dataset.settled();
  return { dataset, db, claudeDir, readyCount: () => readyCount };
}

/**
 * Rewinds a database to the state migration 0011 leaves an EXISTING one in: every already-parsed
 * line sits behind the watermark, and the API-call ids really are absent, because the build that
 * wrote those rows never read the field (0011's header, and its own backfill statement).
 */
function pretendIngestedBefore0011(db: SqliteDatabase): void {
  db.prepare('UPDATE file_manifest SET api_ids_from_line = lines_parsed').run();
  db.prepare('UPDATE events SET message_id = NULL, request_id = NULL').run();
}

/** The transcript watermarks — `history.jsonl` carries no events, so its watermark is 0 either
 *  way and would only cloud the "did the boundary move?" assertions. */
function watermarks(db: SqliteDatabase): { rel_path: string; api_ids_from_line: number }[] {
  return db
    .prepare<{ rel_path: string; api_ids_from_line: number }>(
      "SELECT rel_path, api_ids_from_line FROM file_manifest WHERE kind = 'transcript' ORDER BY rel_path",
    )
    .all();
}

// ---------------------------------------------------------------------------------------
// 1 — it really re-reads, and `kind: 'full'` really does not
// ---------------------------------------------------------------------------------------

describe('the explicit rebuild re-reads transcripts the app has already committed (§3.18)', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('resets the watermark and re-reads every line, so old records become checked ones', async () => {
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    const rig = await boot(dbs.openMigrated(), claudeDir);
    pretendIngestedBefore0011(rig.db);

    // The starting state, asserted rather than assumed: nothing has been checked, and that is a
    // different fact from "nothing repeats" (§4.6, 0011).
    const before = new EventStatsRepository(rig.db).apiCallCoverage();
    expect(before.checkedRecords).toBe(0);
    expect(before.repeatedRecords).toBe(0);
    expect(before.uncheckedRecords).toBe(9); // 9 records carry tokens; none was examined
    expect(watermarks(rig.db).every((row) => row.api_ids_from_line > 0)).toBe(true);

    rig.dataset.rebuildDerived();
    await rig.dataset.settled();

    // ⚠️ The watermark is 0 on every live file: a re-read file has no leading lines behind the
    // boundary, because this build read all of them (0011's `NEW` case).
    for (const row of watermarks(rig.db)) expect(row.api_ids_from_line).toBe(0);

    const after = new EventStatsRepository(rig.db).apiCallCoverage();
    // Hand-computed from `makeClaudeDir`: 9 records carry tokens (u1…u9), all re-read.
    expect(after.checkedRecords).toBe(9);
    expect(after.uncheckedRecords).toBe(0);
    expect(after.uncheckableRecords).toBe(0);
    // msg_A: 3 records · msg_B: 2 · msg_D: 2 = 7 records that share a call with another record.
    // msg_C is alone and u7 states no id, so neither is counted.
    expect(after.repeatedRecords).toBe(7);
    // ⚠️ The discriminator: 7, not 9. A rebuild that had counted every checked record as a
    // repeat would still have produced a plausible, larger, wrong number.
    expect(after.repeatedRecords).not.toBe(after.checkedRecords);
  });

  it('⚠️ the control — `kind: full` alone changes NONE of that (§4.4, amended)', async () => {
    // This is the assertion that gives the one above its meaning. `'full'` is the request whose
    // name promises a re-parse; nothing in the scan or parse phase reads it.
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    const rig = await boot(dbs.openMigrated(), claudeDir);
    pretendIngestedBefore0011(rig.db);
    const before = watermarks(rig.db);

    rig.dataset.startSync('full');
    await rig.dataset.settled();

    expect(watermarks(rig.db)).toEqual(before);
    const after = new EventStatsRepository(rig.db).apiCallCoverage();
    expect(after.checkedRecords).toBe(0);
    expect(after.uncheckedRecords).toBe(9);
  });

  it('re-arms the harness scan, because the purge emptied the tables it fills (§4.8)', async () => {
    // The purge deletes `harness_nodes`, `harness_edges`, `harness_run_agents` and `bloat_flags`
    // (§3.18) and only the first-sync-after-ready hook rebuilds them. Without the re-arm the
    // Harness Map and Bloat Radar would read empty for the rest of the session, with no error.
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    const rig = await boot(dbs.openMigrated(), claudeDir);
    expect(rig.readyCount()).toBe(1); // the boot sync

    rig.dataset.rebuildDerived();
    await rig.dataset.settled();

    expect(rig.readyCount()).toBe(2);
  });

  it('keeps the directory fingerprint, so the NEXT launch does not purge a second time', async () => {
    // `purge()` empties `meta` wholesale (§3.18). If the fingerprint were left to the cycle's own
    // bookkeeping, a rebuild that failed or was cancelled first would leave none — and §5.1 reads
    // "no stored fingerprint" as "the directory changed".
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    const rig = await boot(dbs.openMigrated(), claudeDir);

    rig.dataset.rebuildDerived();
    // ⚠️ Asserted BEFORE the cycle settles: the point is that the purge itself leaves it set.
    expect(rig.dataset.meta.get('claudeDirFingerprint')).toBe(claudeDirFingerprint(claudeDir));
    await rig.dataset.settled();
    expect(rig.dataset.meta.get('claudeDirFingerprint')).toBe(claudeDirFingerprint(claudeDir));
  });
});

// ---------------------------------------------------------------------------------------
// 2 — RETAINED and USER data survive (ADR-026/033/041, INV-12/INV-18)
// ---------------------------------------------------------------------------------------

describe('⚠️ a rebuild never costs the user data that has no other source', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('keeps every archived, retained-orphan and USER row, and the totals that rest on them', async () => {
    const db = dbs.openMigrated();
    // Live + archived rows in every fact table, plus rows in all four USER tables.
    seedAcrossArchiveBoundary(db);
    // ADR-041's second road into RETAINED: the live transcript has VANISHED and its history was
    // kept. A purge that spared archived rows but not these would destroy exactly the history
    // this feature exists to keep (§3.18's amendment).
    db.prepare('UPDATE file_manifest SET retained_orphan = 1 WHERE id = 1').run();
    db.prepare("UPDATE sessions SET retained_orphan = 1 WHERE id = 's-live'").run();
    // Both retained files were written by a pre-0011 build. ⚠️ They are never re-read, so this
    // watermark can never move — the honest limit the disclosure states in words.
    db.prepare('UPDATE file_manifest SET api_ids_from_line = lines_parsed').run();
    // ADR-040 — the user's own "these two folders are the same project", keyed on `encoded_name`.
    db.prepare(
      `INSERT INTO project_groups (id, name, color_index, created_at, updated_at)
       VALUES (1, 'One project', 3, ?, ?)`,
    ).run(T0, T0);
    db.prepare(
      `INSERT INTO project_group_members (encoded_name, group_id, created_at, updated_at)
       VALUES ('-sandbox-p1', 1, ?, ?), ('-sandbox-p2', 1, ?, ?)`,
    ).run(T0, T0, T0, T0);

    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    const rig = await boot(db, claudeDir);

    rig.dataset.rebuildDerived();
    await rig.dataset.settled();

    // RETAINED via archiving (ADR-033) — the session, its events and its manifest rows stand.
    expect(
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE id = 's-archived'").get()
        ?.n,
    ).toBe(1);
    expect(
      db
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE event_key = 'evt-archived'")
        .get()?.n,
    ).toBe(1);
    // RETAINED via orphaning (ADR-041) — the vanished transcript's history stands too.
    expect(
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE id = 's-live'").get()?.n,
    ).toBe(1);
    expect(
      db
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE event_key = 'evt-live'")
        .get()?.n,
    ).toBe(1);
    // ⚠️ Its tokens are still in the lifetime total. This is the assertion a silent shrink fails:
    // 10 + 20 (evt-live) + 30 + 40 (evt-archived) = 100, hand-computed from the seed.
    expect(
      db
        .prepare<{ t: number }>(
          `SELECT SUM(tok_input + tok_output) AS t FROM events
            WHERE event_key IN ('evt-live', 'evt-archived')`,
        )
        .get()?.t,
    ).toBe(100);

    // USER — never touched by a purge (INV-12, ADR-026). The hand-corrected rate especially:
    // it has no other source, and a total priced with it changes if it disappears.
    expect(countRows(db, 'price_rows')).toBe(2);
    expect(
      db
        .prepare<{ rate_picousd_per_token: number }>(
          "SELECT rate_picousd_per_token FROM price_rows WHERE note = 'hand-corrected'",
        )
        .get()?.rate_picousd_per_token,
    ).toBe(312_500);
    expect(countRows(db, 'audit_log')).toBe(1);
    expect(countRows(db, 'archives')).toBe(1);
    expect(countRows(db, 'project_groups')).toBe(1);
    expect(countRows(db, 'project_group_members')).toBe(2);
    // ADR-040 Trap 1 — membership survives BY NAME, across the renumbering the purge causes.
    expect(
      db
        .prepare<{ encoded_name: string }>(
          'SELECT encoded_name FROM project_group_members ORDER BY encoded_name',
        )
        .all()
        .map((row) => row.encoded_name),
    ).toEqual(['-sandbox-p1', '-sandbox-p2']);

    // ⚠️⚠️ THE HONEST LIMIT, asserted rather than only written in the UI copy: the two retained
    // files keep their old watermark, because they are never re-read (§5.3 `ARCHIVED`, ADR-041).
    // Their records stay uncheckable forever, and the disclosure says so in its own sentence.
    const retained = db
      .prepare<{ api_ids_from_line: number }>(
        `SELECT api_ids_from_line FROM file_manifest
          WHERE archive_id IS NOT NULL OR retained_orphan = 1`,
      )
      .all();
    expect(retained.length).toBeGreaterThan(0);
    for (const row of retained) expect(row.api_ids_from_line).toBeGreaterThan(0);
    expect(new EventStatsRepository(db).apiCallCoverage().uncheckableRecords).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------
// 3 — refusals, which must leave the database exactly as it was
// ---------------------------------------------------------------------------------------

describe('a refused rebuild deletes nothing', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('refuses while a cycle is running, BEFORE it purges anything', async () => {
    // ⚠️ The order is the whole point. `startSync('full')` reports busy only after the fact, so a
    // rebuild that purged first and asked afterwards would leave the dataset erased with nothing
    // rebuilding it.
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));
    const rig = await boot(dbs.openMigrated(), claudeDir);
    const events = countRows(rig.db, 'events');
    expect(events).toBeGreaterThan(0);

    rig.dataset.startSync('incremental');
    let code: string | null = null;
    try {
      rig.dataset.rebuildDerived();
    } catch (cause) {
      code = isHandlerError(cause) ? cause.code : 'not-a-handler-error';
    }
    expect(code).toBe('E_SYNC_BUSY');
    expect(countRows(rig.db, 'events')).toBe(events);

    await rig.dataset.settled();
  });

  it('refuses with no directory configured, and nothing is purged', async () => {
    const db = dbs.openMigrated();
    seedAcrossArchiveBoundary(db);
    const dataset = new DatasetService({
      db,
      logger: silentLogger(),
      emit: noEmitters(),
      now: () => T0,
      watchFactory: () => inertWatch(),
    });
    await dataset.boot();
    expect(dataset.state()).toBe('NO_DIR');

    let code: string | null = null;
    try {
      dataset.rebuildDerived();
    } catch (cause) {
      code = isHandlerError(cause) ? cause.code : 'not-a-handler-error';
    }
    expect(code).toBe('E_NO_DIR');
    expect(countRows(db, 'events')).toBe(3);
    expect(countRows(db, 'sessions')).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------
// 4 — cancellation leaves a consistent database (§5.2 rules 3–4)
// ---------------------------------------------------------------------------------------

describe('stopping a rebuild half-way', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  it('commits what it read, forgets nothing else, and the next sync converges', async () => {
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));

    // The uninterrupted answer, computed first, so "converges" is checked against a real number
    // rather than against a restated literal.
    const reference = await boot(dbs.openMigrated('reference.db'), claudeDir);
    const referenceEvents = countRows(reference.db, 'events');
    const referenceCoverage = new EventStatsRepository(reference.db).apiCallCoverage();
    expect(referenceEvents).toBe(9);

    // The interrupted run. The seam wraps the REAL engine and cancels after the first file is
    // committed, which is the state §5.2 rule 3 describes: one file done, the rest untouched.
    const db = dbs.openMigrated();
    let dataset: DatasetService | null = null;
    let cancelAfterNext = false;
    const rig = await boot(db, claudeDir, (dir) => {
      const real = createSyncWork({
        claudeDir: dir,
        manifest: new ManifestRepository(db),
        ingest: new IngestRepository(db),
        now: () => T0,
      });
      return {
        scan: (context) => real.scan(context),
        parseFile: async (file: PlannedFile, context) => {
          const result = await real.parseFile(file, context);
          // ⚠️ Cancel only AFTER a file that actually wrote events commits — `history.jsonl` is
          // empty and produces none, and cancelling after it would leave zero events committed,
          // testing a corner the "committed files stay committed" property is not about.
          if (cancelAfterNext && result.recordsIngested > 0) {
            cancelAfterNext = false;
            dataset?.cancelSync();
          }
          return result;
        },
        finalize: (context, summary) => real.finalize(context, summary),
      };
    });
    dataset = rig.dataset;
    pretendIngestedBefore0011(db);

    cancelAfterNext = true;
    rig.dataset.rebuildDerived();
    await rig.dataset.settled();

    // ⚠️ The state a cancelled cycle must leave: some transcripts re-read, the rest simply not
    // there yet. Nothing is rolled back, nothing is half-written, and the phase is back to idle.
    expect(rig.dataset.syncState().phase).toBe('idle');
    const partial = countRows(db, 'events');
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(referenceEvents);
    // Every manifest row that was re-read agrees with its events; every row that was not is at
    // offset 0 with none. Both are consistent states; a row with an advanced offset and no events
    // would not be.
    const rows = db
      .prepare<{ rel_path: string; byte_offset: number; parsed: number }>(
        `SELECT fm.rel_path, fm.byte_offset,
                (SELECT COUNT(*) FROM events e WHERE e.source_file_id = fm.id) AS parsed
           FROM file_manifest fm WHERE fm.kind = 'transcript'`,
      )
      .all();
    expect(rows.length).toBe(2);
    for (const row of rows) {
      if (row.byte_offset === 0) expect(row.parsed).toBe(0);
      else expect(row.parsed).toBeGreaterThan(0);
    }
    // ⚠️ And the watermark is already 0 everywhere — the purge dropped the rows and the scan
    // re-inserted them at the default, so a cancelled rebuild never claims an unread line was
    // checked, nor a re-read one unchecked.
    for (const row of watermarks(db)) expect(row.api_ids_from_line).toBe(0);

    // The convergence: one ordinary incremental sync finishes the job (§5.3 `GREW` from offset 0).
    rig.dataset.startSync('incremental');
    await rig.dataset.settled();

    expect(countRows(db, 'events')).toBe(referenceEvents);
    expect(new EventStatsRepository(db).apiCallCoverage()).toEqual(referenceCoverage);
  });
});
