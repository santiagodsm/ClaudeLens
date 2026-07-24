// §4.6 / migration 0011 — the API call a record came from, and ⚠️⚠️ the distinction between
// "we checked and found none" and "we never checked".
//
// WHAT IS BEING MEASURED. Claude Code commonly writes one assistant turn — text plus its tool
// calls — as SEVERAL JSONL lines that share one `message.id` and repeat the identical
// `message.usage`, each with its own `uuid`. §3.5's line identity (ADR-019) is correct and the
// `ON CONFLICT(event_key) DO NOTHING` rightly does not fire: they are distinct records. But every
// one of them is summed into M-02/M-04/M-05, so one API call is charged N times.
//
// ⚠️ THIS SUITE PROVES THE MEASUREMENT AND THE FACT THAT NOTHING MOVED. The arithmetic decision
// is deferred (see 0011's header): no metric definition, no costed population and no token sum
// changes here, and the last test in this file asserts exactly that.
//
// ⚠️⚠️ THE TRAP. Every row ingested before migration 0011 has `message_id IS NULL`, and so does a
// record that genuinely states none. A count that could not tell those apart would report "0
// records repeat an API call" for a database in which NOTHING WAS EVER CHECKED — a plausible
// number meaning the opposite of what it says, which is CLAUDE.md §1's worst outcome arriving as
// a disclosure. `file_manifest.api_ids_from_line` is the watermark that separates them, and the
// second describe block is what pins it.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventStatsRepository } from '../../../src/main/db/repositories/event-stats';
import { useSandbox } from '../../support/sandbox';
import { createSyncHarness } from '../../support/sync-harness';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';

const TS = '2024-05-01T09:00:00.000Z';

/**
 * One transcript record. `messageId` and `requestId` are written verbatim, or omitted entirely —
 * omitted is the case that must land as SQL NULL rather than as a placeholder (§3.5, 0011).
 */
function record(uuid: string, tokens: number, messageId?: string, requestId?: string): string {
  const message: Record<string, unknown> = {
    role: 'assistant',
    model: 'claude-test-1',
    usage: { input_tokens: tokens, output_tokens: tokens },
  };
  if (messageId !== undefined) message['id'] = messageId;
  const line: Record<string, unknown> = { type: 'assistant', uuid, timestamp: TS, message };
  if (requestId !== undefined) line['requestId'] = requestId;
  return `${JSON.stringify(line)}\n`;
}

/** Writes one transcript under a project and syncs it into a fresh database. */
async function ingest(root: string, dbPath: string, lines: string): Promise<SqliteDatabase> {
  await mkdir(join(root, 'projects', '-work-demo-alpha'), { recursive: true });
  await writeFile(join(root, 'projects', '-work-demo-alpha', 'sess-a.jsonl'), lines);
  const harness = createSyncHarness({ claudeDir: root, dbPath });
  await harness.runSync();
  return harness.db;
}

describe('migration 0011 — the API-call id is read, stored, and changes no identity', () => {
  const sandbox = useSandbox();

  it('stores `message.id` and `requestId` verbatim, and NULL — never a placeholder — when absent', async () => {
    const db = await ingest(
      sandbox.resolve('claude'),
      sandbox.resolve('lens.db'),
      // Two records of ONE assistant turn: same API call, distinct uuids, identical usage.
      record('u1', 100, 'msg_A', 'req_A') +
        record('u2', 100, 'msg_A', 'req_A') +
        // A record from a different call.
        record('u3', 50, 'msg_B', 'req_B') +
        // ⚠️ A record that states neither. It must land as NULL, twice.
        record('u4', 7),
    );

    const rows = db
      .prepare<{ uuid: string; message_id: string | null; request_id: string | null }>(
        'SELECT uuid, message_id, request_id FROM events ORDER BY line_no',
      )
      .all();
    expect(rows).toEqual([
      { uuid: 'u1', message_id: 'msg_A', request_id: 'req_A' },
      { uuid: 'u2', message_id: 'msg_A', request_id: 'req_A' },
      { uuid: 'u3', message_id: 'msg_B', request_id: 'req_B' },
      // ⚠️ NULL, not '' and not 'unknown'. A sentinel would make an unstated id indistinguishable
      // from a stated one and would put a word in the data the transcript does not contain.
      { uuid: 'u4', message_id: null, request_id: null },
    ]);
  });

  it('⚠️ keeps the two records of one API call as TWO rows — the id is not a dedup key', async () => {
    const db = await ingest(
      sandbox.resolve('claude'),
      sandbox.resolve('lens.db'),
      record('u1', 100, 'msg_A') + record('u2', 100, 'msg_A'),
    );
    // ADR-019 — `event_key` is the uuid, and the uuids differ, so both records exist. Merging
    // them here would be the arithmetic change this migration deliberately does NOT make.
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(2);
    // 4 × 100 hand-computed: two records, each 100 input + 100 output, both counted. This is the
    // number the app shows today and it is UNCHANGED by this migration.
    const totals = db
      .prepare<{ t: number }>('SELECT SUM(tok_input + tok_output) AS t FROM events')
      .get();
    expect(totals?.t).toBe(400);
  });

  it('counts the repeated records, with the size of the population it checked', async () => {
    const db = await ingest(
      sandbox.resolve('claude'),
      sandbox.resolve('lens.db'),
      // msg_A: three records. msg_B: two. msg_C: one. Plus one with no id, and one with an id
      // but zero tokens — neither can repeat any usage.
      record('u1', 100, 'msg_A') +
        record('u2', 100, 'msg_A') +
        record('u3', 100, 'msg_A') +
        record('u4', 50, 'msg_B') +
        record('u5', 50, 'msg_B') +
        record('u6', 20, 'msg_C') +
        record('u7', 9) +
        record('u8', 0, 'msg_D'),
    );

    const coverage = new EventStatsRepository(db).apiCallCoverage();
    // 3 (msg_A) + 2 (msg_B) = 5 records share a call with another record. msg_C is alone,
    // msg_D carries no tokens and is outside the population, u7 states no id.
    expect(coverage.repeatedRecords).toBe(5);
    // The denominator: 7 records carry tokens (u8 has none), and this build read all of them.
    expect(coverage.checkedRecords).toBe(7);
    expect(coverage.uncheckedRecords).toBe(0);
    expect(coverage.uncheckableRecords).toBe(0);
  });
});

describe('⚠️⚠️ "none found" and "not checked" are different numbers', () => {
  const sandbox = useSandbox();

  /** Puts every already-ingested line of every file behind the watermark, as migration 0011 does
   *  to a database that existed before it. `message_id` is cleared to match: those rows really
   *  were written by a build that never read the field. */
  function pretendIngestedBefore0011(db: SqliteDatabase): void {
    db.prepare('UPDATE file_manifest SET api_ids_from_line = lines_parsed').run();
    db.prepare('UPDATE events SET message_id = NULL, request_id = NULL').run();
  }

  it('reports ZERO CHECKED — not "zero repeats" — for a database ingested before the migration', async () => {
    const db = await ingest(
      sandbox.resolve('claude'),
      sandbox.resolve('lens.db'),
      record('u1', 100, 'msg_A') + record('u2', 100, 'msg_A') + record('u3', 50, 'msg_B'),
    );
    pretendIngestedBefore0011(db);

    const coverage = new EventStatsRepository(db).apiCallCoverage();
    // ⚠️ THE WHOLE POINT. `repeatedRecords` is 0 — and so it would be if nothing repeated. What
    // makes the two readable apart is that `checkedRecords` is ALSO 0: the count speaks for no
    // records at all. A renderer that showed "0 repeated records" here would be asserting a
    // finding the app never made.
    expect(coverage.repeatedRecords).toBe(0);
    expect(coverage.checkedRecords).toBe(0);
    // All three are still re-readable — their transcript is in the Claude directory.
    expect(coverage.uncheckedRecords).toBe(3);
    expect(coverage.uncheckableRecords).toBe(0);
  });

  it('reports the checked half and the unchecked half separately when a file has grown', async () => {
    const root = sandbox.resolve('claude');
    const dbPath = sandbox.resolve('lens.db');
    const db = await ingest(root, dbPath, record('u1', 100, 'msg_A') + record('u2', 100, 'msg_A'));
    pretendIngestedBefore0011(db);

    // The append fast-path: two more records arrive, read by a build that DOES look at the id.
    // ⚠️ This is why the watermark is a line number and not a boolean on the file: a boolean set
    // by this parse would have claimed the two older lines were checked too.
    const transcript = join(root, 'projects', '-work-demo-alpha', 'sess-a.jsonl');
    await writeFile(
      transcript,
      record('u1', 100, 'msg_A') +
        record('u2', 100, 'msg_A') +
        record('u3', 50, 'msg_C') +
        record('u4', 50, 'msg_C'),
    );
    const harness = createSyncHarness({ claudeDir: root, dbPath });
    await harness.runSync();

    const coverage = new EventStatsRepository(harness.db).apiCallCoverage();
    // The two appended records share `msg_C`: found, and honestly scoped to the two checked.
    expect(coverage.repeatedRecords).toBe(2);
    expect(coverage.checkedRecords).toBe(2);
    expect(coverage.uncheckedRecords).toBe(2);
    expect(coverage.uncheckableRecords).toBe(0);
  });

  it('⚠️⚠️ separates records no rebuild can ever reach from ones a rebuild fixes', async () => {
    const db = await ingest(
      sandbox.resolve('claude'),
      sandbox.resolve('lens.db'),
      record('u1', 100, 'msg_A') + record('u2', 100, 'msg_A'),
    );
    pretendIngestedBefore0011(db);
    // The file is archived: its transcript has left the Claude data directory and §5.3 `ARCHIVED`
    // never re-parses it (ADR-034). Its records can never be checked, so promising a rebuild
    // would be advice that cannot work — A-05's precedent, applied to the same shape of problem.
    db.prepare(
      `INSERT INTO audit_log (id, action_type, status, claude_dir, target_summary, targets_json,
         bytes_affected, backup_present, started_at, finished_at, created_at, updated_at)
       VALUES (1, 'archive-sessions', 'completed', '/sandbox/claude', '1 session', '[]', 0, 1,
               0, 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO archives (id, audit_id, archive_root, claude_dir, session_count, file_count,
         bytes_moved, range_from_ts, range_to_ts, last_reachable_at, reachable, created_at,
         updated_at)
       VALUES (1, 1, '/sandbox/archive', '/sandbox/claude', 1, 1, 0, 0, 0, 0, 1, 0, 0)`,
    ).run();
    db.prepare("UPDATE file_manifest SET archive_id = 1 WHERE kind = 'transcript'").run();

    const coverage = new EventStatsRepository(db).apiCallCoverage();
    expect(coverage.checkedRecords).toBe(0);
    expect(coverage.uncheckedRecords).toBe(0);
    expect(coverage.uncheckableRecords).toBe(2);
  });

  it('a re-parse from the top clears the watermark, so re-read records count as checked', async () => {
    const root = sandbox.resolve('claude');
    const dbPath = sandbox.resolve('lens.db');
    const db = await ingest(root, dbPath, record('u1', 100, 'msg_A') + record('u2', 100, 'msg_A'));
    pretendIngestedBefore0011(db);

    // §5.3 SHRANK/REWROTE — the file is rewritten shorter, so `resetForReparse` drops its rows
    // and re-reads it from line 1 with a build that reads the id. Every line is now above the
    // watermark. Without the reset in `RESET_OFFSET` these freshly-checked rows would still be
    // reported as unchecked — an understatement, but still a number that does not mean what it
    // says (CLAUDE.md §1).
    await writeFile(
      join(root, 'projects', '-work-demo-alpha', 'sess-a.jsonl'),
      record('u1', 100, 'msg_A'),
    );
    const harness = createSyncHarness({ claudeDir: root, dbPath });
    await harness.runSync();

    const coverage = new EventStatsRepository(harness.db).apiCallCoverage();
    expect(coverage.checkedRecords).toBe(1);
    expect(coverage.uncheckedRecords).toBe(0);
    expect(coverage.repeatedRecords).toBe(0);
  });
});
