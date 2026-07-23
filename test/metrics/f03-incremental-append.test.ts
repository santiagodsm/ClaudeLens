// F-03 (§5.9.1) — **incremental append == cold parse.** INV-04, across EVERY table.
//
//   "For any fixture F and any append A: `parse(F) then append(A) then sync` ≡
//    `parse(F+A) from scratch`, over every table." (INV-04)
//
// This is the append fast-path's correctness proof. §5.3 exists to avoid re-reading ~1 GB on
// every sync (P-02/P-03); the price of that shortcut is that the fast path can produce a
// different database than the slow one, and nothing in the UI would look wrong if it did.
//
// ⚠️ The comparison is **table-by-table and total**, not event counts. An append bug that
// leaves `sessions.last_ts` stale, or a subagent run unlinked, or a `file_touches` row
// missing, changes no event count at all.
//
// Expected values below are hand-computed from the fixture with the arithmetic in a comment
// (STACK ADR-012). `toMatchSnapshot()` is banned in this directory by lint.

import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import {
  countsByTable,
  createSyncHarness,
  dumpNormalized,
  fixturePath,
  INGESTED_TABLES,
  pinMtime,
} from '../support/sync-harness';

// 2024-05-01T09:00:00.000Z — the fixture's own era, pinned so `(size, mtime)` is a fact of
// the test rather than of the wall clock (§5.3 classifies on both).
const MTIME_BASE = 1_714_554_000_000;
// +1 h. Strictly greater, which is what makes the appended files classify GREW (§5.3).
const MTIME_APPENDED = 1_714_557_600_000;

const APPEND_TARGETS = [
  ['sess-a.jsonl', 'projects/-work-demo-alpha/sess-a.jsonl'],
  ['run-1.jsonl', 'projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl'],
  ['history.jsonl', 'history.jsonl'],
] as const;

/** The one file that is never appended to — it must classify UNCHANGED in the append run. */
const UNTOUCHED_FILE = 'projects/-work-demo-beta/sess-b.jsonl';

const BASE_FILES = [
  'history.jsonl',
  'projects/-work-demo-alpha/sess-a.jsonl',
  'projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl',
  UNTOUCHED_FILE,
] as const;

async function pinAll(root: string, files: readonly string[], mtime: number): Promise<void> {
  for (const relPath of files) await pinMtime(join(root, ...relPath.split('/')), mtime);
}

async function applyAppends(root: string): Promise<void> {
  for (const [source, target] of APPEND_TARGETS) {
    const fragment = await readFile(join(fixturePath('f03-append/append'), source), 'utf8');
    await appendFile(join(root, ...target.split('/')), fragment);
  }
}

describe('F-03 — incremental append == cold parse (INV-04)', () => {
  const sandbox = useSandbox();

  it('produces an identical database table-by-table and in total', async () => {
    // ---- Run A: parse(F), append(A), sync -------------------------------------------
    const rootA = await sandbox.copyFixture(fixturePath('f03-append/base'), 'a-root');
    await pinAll(rootA, BASE_FILES, MTIME_BASE);
    const runA = createSyncHarness({ claudeDir: rootA, dbPath: sandbox.resolve('a.db') });
    await runA.runSync();

    await applyAppends(rootA);
    await pinAll(
      rootA,
      APPEND_TARGETS.map(([, target]) => target),
      MTIME_APPENDED,
    );
    await pinMtime(join(rootA, ...UNTOUCHED_FILE.split('/')), MTIME_BASE);
    await runA.runSync();

    // ---- Run B: parse(F+A) from scratch ---------------------------------------------
    const rootB = await sandbox.copyFixture(fixturePath('f03-append/base'), 'b-root');
    await applyAppends(rootB);
    await pinAll(
      rootB,
      APPEND_TARGETS.map(([, target]) => target),
      MTIME_APPENDED,
    );
    await pinMtime(join(rootB, ...UNTOUCHED_FILE.split('/')), MTIME_BASE);
    const runB = createSyncHarness({ claudeDir: rootB, dbPath: sandbox.resolve('b.db') });
    await runB.runSync();

    // ---- The fixture is non-trivial ---------------------------------------------------
    // A vacuously-equal comparison of two empty databases would pass; assert the shape
    // first, with every number hand-counted from the fixture files.
    //
    //   events        = sess-a 5 (a1..a5) + run-1 3 (s1..s3) + sess-b 2 (b1,b2)      = 10
    //   projects      = -work-demo-alpha, -work-demo-beta                            =  2
    //   sessions      = sess-a, sess-b                                               =  2
    //   tool_calls    = a2:{Agent,Write} 2 + a4:{Edit} 1 + s1:{Read} 1 + b2:{Skill×2} 2 = 6
    //   file_touches  = write-class calls that named a path: a2/Write, a4/Edit       =  2
    //   subagent_runs = one per subagent transcript file                             =  1
    //   prompts       = history.jsonl 2 base + 1 appended                            =  3
    //   file_manifest = 4 discovered files                                           =  4
    const expectedCounts = {
      file_manifest: 4,
      projects: 2,
      sessions: 2,
      events: 10,
      tool_calls: 6,
      subagent_runs: 1,
      file_touches: 2,
      prompts: 3,
      stats_cache_days: 0,
    };
    expect(countsByTable(runB.db)).toEqual(expectedCounts);
    expect(countsByTable(runA.db)).toEqual(expectedCounts);

    // ---- INV-04, table by table -------------------------------------------------------
    const appended = dumpNormalized(runA.db);
    const cold = dumpNormalized(runB.db);
    for (const table of INGESTED_TABLES) {
      expect(appended[table], `table ${table} differs between append and cold parse`).toEqual(
        cold[table],
      );
    }

    // ---- …and in total ----------------------------------------------------------------
    expect(appended).toEqual(cold);

    // ---- The equal content is the CROSS-FILE content, which is where an append breaks ---
    // Every assertion below is a value derived from more than one file, recomputed at
    // FINALIZING (§5.2). Two identical-but-wrong databases would still pass the comparison
    // above; these pin the values themselves.
    expect(appended.subagent_runs).toEqual([
      {
        session_id: 'sess-a',
        project: '-work-demo-alpha',
        transcript: 'projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl',
        // §3.7 — structural linkage: run-1's earliest event (s1) has parentUuid 'a2', and
        // a2 is an assistant event carrying an `Agent` tool call. No proximity heuristic.
        spawn_event: 'a2',
        spawn_tool_event: 'a2',
        spawn_tool_ordinal: 1, // the Agent item is index 1 of message.content[] (§3.6)
        subagent_type: 'reviewer',
        // §3.7 — the same linked `Agent` call supplies both labels. `description` lands in
        // `tool_calls.description` (§3.6 as amended by A-09, migration 0002) and is read back
        // here at FINALIZING; it is covered by the append≡cold comparison above rather than
        // pinned as NULL, which is the point of the ruling. a2's Agent input is
        // `{"subagent_type":"reviewer","description":"check the diff"}`.
        description: 'check the diff',
        // §3.7 (amended 2026-07-22, migration 0008) — this fixture predates the
        // `agent-*.meta.json` sidecar and deliberately still has none, which is what makes
        // this row the standing proof that §3.7's ORIGINAL `parent_uuid` → `uuid` rule is
        // still live and still fills all four columns when the chain is actually there. On
        // the reporting user's real data it never is; here it is, and it wins nothing it
        // should not.
        meta_agent_type: null,
        meta_tool_use_id: null,
        meta_description: null,
        first_ts: 1_714_554_360_000, // 2024-05-01T09:06:00.000Z
        last_ts: 1_714_554_960_000, // 2024-05-01T09:16:00.000Z — the APPENDED line
      },
    ]);

    // §3.4 — session bounds span both origins and both files: first is the parent's 09:00,
    // last is the parent's appended 09:20 (09:00:00Z = 1_714_554_000_000; +20 min = +1_200_000).
    // `cli_version` is "last non-null observed", which the append changed from 1.2.3 to 1.2.5.
    expect(appended.sessions).toEqual([
      {
        id: 'sess-a',
        project: '-work-demo-alpha',
        transcript: 'projects/-work-demo-alpha/sess-a.jsonl',
        first_ts: 1_714_554_000_000,
        last_ts: 1_714_555_200_000,
        span_seconds: 1_200,
        git_branch: 'main',
        cli_version: '1.2.5',
        is_partial: 0,
        archive_id: null,
      },
      {
        id: 'sess-b',
        project: '-work-demo-beta',
        transcript: 'projects/-work-demo-beta/sess-b.jsonl',
        first_ts: 1_714_553_940_000, // 08:59
        last_ts: 1_714_554_060_000, // 09:01
        span_seconds: 120,
        git_branch: 'feature',
        cli_version: '1.2.4',
        is_partial: 0,
        archive_id: null,
      },
    ]);

    // §5.4 rule 9 — a `Skill` whose input carries none of `skill`/`command`/`name` still
    // counts as a tool call, with `skill_name` NULL (M-12 would otherwise undercount).
    const skills = appended.tool_calls.filter(
      (row) => (row as { tool_name: string }).tool_name === 'Skill',
    );
    expect(skills.map((row) => (row as { skill_name: string | null }).skill_name)).toEqual([
      'dataviz',
      null,
    ]);

    // §3.6 (A-09) / §5.4 rule 9 — `description` is an `Agent`-only field, exactly like
    // `subagent_type`. Every other tool call must leave it NULL; a parser that copied
    // `input.description` for all tools would still satisfy the append≡cold comparison.
    expect(
      appended.tool_calls.map((row) => {
        const call = row as { tool_name: string; description: string | null };
        return [call.tool_name, call.description];
      }),
      // Dump order is (event_key, ordinal): a2{Agent,Write}, a4{Edit}, b2{Skill,Skill}, s1{Read}.
    ).toEqual([
      ['Agent', 'check the diff'],
      ['Write', null],
      ['Edit', null],
      ['Skill', null],
      ['Skill', null],
      ['Read', null],
    ]);

    // §3.9 — `pastedContents` is never stored, in any form. The whole database is searched.
    const dbText = JSON.stringify(appended);
    expect(dbText).not.toContain('BULK PASTED MATERIAL');
    expect(dbText).not.toContain('pastedContents');

    // §5.4 rule 5 / §5.12 — the record body's `sessionId` says 'WRONG-ON-PURPOSE'; the file
    // path says 'sess-a'. The path wins, everywhere.
    expect(dbText).not.toContain('WRONG-ON-PURPOSE');
  });

  it('takes the append fast-path rather than re-reading the file', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    await pinAll(root, BASE_FILES, MTIME_BASE);
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('c.db') });
    await harness.runSync();

    const before = harness.db
      .prepare<{ byte_offset: number; lines_parsed: number }>(
        'SELECT byte_offset, lines_parsed FROM file_manifest WHERE rel_path = ?',
      )
      .get('projects/-work-demo-alpha/sess-a.jsonl');
    // The base transcript has 3 lines; the offset is its whole length.
    expect(before?.lines_parsed).toBe(3);

    await applyAppends(root);
    await pinAll(
      root,
      APPEND_TARGETS.map(([, target]) => target),
      MTIME_APPENDED,
    );
    await harness.runSync();

    const after = harness.db
      .prepare<{ byte_offset: number; lines_parsed: number }>(
        'SELECT byte_offset, lines_parsed FROM file_manifest WHERE rel_path = ?',
      )
      .get('projects/-work-demo-alpha/sess-a.jsonl');
    // 3 base lines + 2 appended = 5, and the offset advanced past the appended bytes only.
    expect(after?.lines_parsed).toBe(5);
    expect(after?.byte_offset).toBeGreaterThan(before?.byte_offset ?? 0);

    // ⚠️ ADR-019's fallback key `<rel_path>#<line_no>` is only stable if `line_no` keeps
    // counting across the append. The appended records carry uuids, so assert the numbering
    // directly: the two appended events are physical lines 4 and 5, not 1 and 2.
    const lineNumbers = harness.db
      .prepare<{ line_no: number }>(
        `SELECT line_no FROM events WHERE event_key IN ('a4','a5') ORDER BY line_no`,
      )
      .all();
    expect(lineNumbers.map((row) => row.line_no)).toEqual([4, 5]);
  });

  it('does not consume a partial final line (§5.3)', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    await pinAll(root, BASE_FILES, MTIME_BASE);
    const transcript = join(root, 'projects', '-work-demo-alpha', 'sess-a.jsonl');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('d.db') });
    await harness.runSync();

    // An append caught mid-write: a complete record, then a fragment with no newline.
    const fragment = await readFile(join(fixturePath('f03-append/append'), 'sess-a.jsonl'), 'utf8');
    const [firstLine = ''] = fragment.split('\n');
    await appendFile(transcript, `${firstLine}\n{"type":"assistant","uuid":"partial`);
    await pinMtime(transcript, MTIME_APPENDED);
    await harness.runSync();

    const row = harness.db
      .prepare<{
        byte_offset: number;
        lines_parsed: number;
        bad_lines: number;
        size_bytes: number;
      }>(
        'SELECT byte_offset, lines_parsed, bad_lines, size_bytes FROM file_manifest WHERE rel_path = ?',
      )
      .get('projects/-work-demo-alpha/sess-a.jsonl');

    // The complete 4th line was consumed; the fragment was NOT, and produced no bad line —
    // it is unread, not unreadable. The offset therefore stops short of the file size.
    expect(row?.lines_parsed).toBe(4);
    expect(row?.bad_lines).toBe(0);
    expect(row?.byte_offset).toBeLessThan(row?.size_bytes ?? 0);

    // Completing the write lets the next cycle pick the record up, exactly once.
    await appendFile(transcript, '","timestamp":"2024-05-01T09:25:00.000Z","message":{}}\n');
    await pinMtime(transcript, MTIME_APPENDED + 1000);
    await harness.runSync();

    const final = harness.db
      .prepare<{
        byte_offset: number;
        lines_parsed: number;
        size_bytes: number;
        bad_lines: number;
      }>(
        'SELECT byte_offset, lines_parsed, size_bytes, bad_lines FROM file_manifest WHERE rel_path = ?',
      )
      .get('projects/-work-demo-alpha/sess-a.jsonl');
    expect(final?.lines_parsed).toBe(5);
    expect(final?.bad_lines).toBe(0);
    expect(final?.byte_offset).toBe(final?.size_bytes);
    expect(
      harness.db
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE event_key = 'partial'")
        .get()?.n,
    ).toBe(1);
  });
});
