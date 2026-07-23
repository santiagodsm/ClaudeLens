// §3.7 / §5.4 rule 12 — spawn linkage from the run's own `agent-*.meta.json`.
// Both sections AMENDED 2026-07-22. ADR-020 is untouched by this and is asserted here too.
//
// ⚠️ WHAT THIS FILE PROVES, AND WHY THE FIXTURE IS SHAPED THE WAY IT IS.
//
// §3.7 specified spawn linkage as `parent_uuid` → `uuid`: take the run's earliest event,
// resolve its `parent_uuid` against `events.uuid`, and read the `Agent` call off the assistant
// event that comes back. On real data that resolves **0 of 2,514** runs, because a subagent
// transcript's first event has **no `parent_uuid` at all** — the uuid chain is per-file and
// does not cross the file boundary.
//
// ⚠️ Every subagent transcript in `test/fixtures/spawn-sidecar/` therefore starts with a
// `user` event carrying NO `parentUuid`, exactly like the real files. A fixture whose chain
// ALSO resolves would prove nothing about the sidecar path — it would pass with the sidecar
// code deleted. The first assertion below pins that property of the fixture so it cannot
// drift into resolving by accident.
//
// Every expected value is hand-computed from the fixture with the arithmetic in a comment
// (STACK ADR-012, CLAUDE.md §1).

import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IngestRepository } from '../../../src/main/db/repositories/ingest-repo';
import {
  EMPTY_SUBAGENT_META,
  isEmptySubagentMeta,
  parseSubagentMeta,
  subagentMetaRelPath,
} from '../../../src/main/parse/subagent-meta';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';
import { useSandbox } from '../../support/sandbox';
import {
  countsByTable,
  createSyncHarness,
  dumpNormalized,
  fixturePath,
  INGESTED_TABLES,
  pinMtime,
} from '../../support/sync-harness';

const FIXTURE = 'spawn-sidecar';
const SESSION_DIR = 'projects/-work-demo-orch/sess-sc';
const MAIN_TRANSCRIPT = 'projects/-work-demo-orch/sess-sc.jsonl';

/** The five subagent transcripts, in `rel_path` order — the order `dumpNormalized` returns. */
const RUNS = [
  'agent-dark',
  'agent-linked',
  'agent-orphan-toolid',
  'agent-untyped-call',
  'agent-workflow',
] as const;

const SIDECARS = ['agent-linked', 'agent-orphan-toolid', 'agent-untyped-call', 'agent-workflow'];

const ALL_FILES = [MAIN_TRANSCRIPT, ...RUNS.map((run) => `${SESSION_DIR}/subagents/${run}.jsonl`)];

// 2024-06-01T10:00:00.000Z. Pinned so `(size, mtime)` is a fact of the test, not of the clock.
const MTIME_BASE = 1_717_236_000_000;
const MTIME_APPENDED = MTIME_BASE + 3_600_000;

// The fixture's instants, resolved once (§3.1.1 — UTC epoch ms in every column).
const T_10_00_00 = 1_717_236_000_000;
const T_10_00_05 = 1_717_236_005_000;
const T_10_00_30 = 1_717_236_030_000;
const T_10_01_20 = 1_717_236_080_000;
const T_10_02_10 = 1_717_236_130_000;
const T_10_03_00 = 1_717_236_180_000;
const T_10_03_15 = 1_717_236_195_000;
const T_10_04_00 = 1_717_236_240_000;
const T_10_04_40 = 1_717_236_280_000;
const T_10_05_00 = 1_717_236_300_000;
const T_10_05_20 = 1_717_236_320_000;

async function pinAll(root: string, mtime: number): Promise<void> {
  for (const relPath of ALL_FILES) await pinMtime(join(root, ...relPath.split('/')), mtime);
}

/** Strips every sidecar, leaving a tree in which NOTHING can link. The control condition. */
async function stripSidecars(root: string): Promise<void> {
  for (const run of SIDECARS) {
    await rm(join(root, ...`${SESSION_DIR}/subagents/${run}.meta.json`.split('/')));
  }
}

interface RunRow {
  readonly transcript: string;
  readonly spawn_event: string | null;
  readonly spawn_tool_event: string | null;
  readonly spawn_tool_ordinal: number | null;
  readonly subagent_type: string | null;
  readonly description: string | null;
  readonly first_ts: number;
  readonly last_ts: number;
}

function runsOf(db: SqliteDatabase): RunRow[] {
  return (dumpNormalized(db).subagent_runs as RunRow[]).map((row) => ({
    transcript: row.transcript,
    spawn_event: row.spawn_event,
    spawn_tool_event: row.spawn_tool_event,
    spawn_tool_ordinal: row.spawn_tool_ordinal,
    subagent_type: row.subagent_type,
    description: row.description,
    first_ts: row.first_ts,
    last_ts: row.last_ts,
  }));
}

/**
 * ⚠️ §3.7's core claim, as an executable expression: "Totals are unaffected, because
 * attribution is structural and linkage is only a label."
 *
 * Everything a headline number is built from — the origin partition (INV-02), the token
 * classes (M-01…M-04), the tool-call count (M-12) and the per-run session attribution — and
 * NOT one column that linkage writes.
 */
function attributionTotals(db: SqliteDatabase): unknown {
  return {
    byOrigin: db
      .prepare(
        `SELECT e.origin, COUNT(*) AS events,
                SUM(e.tok_input) AS input, SUM(e.tok_output) AS output,
                SUM(e.tok_cache_write) AS cacheWrite, SUM(e.tok_cache_read) AS cacheRead
           FROM events e GROUP BY e.origin ORDER BY e.origin`,
      )
      .all(),
    toolCallsByOrigin: db
      .prepare('SELECT origin, COUNT(*) AS calls FROM tool_calls GROUP BY origin ORDER BY origin')
      .all(),
    // Session attribution is the PATH (ADR-020) — the thing that must not move.
    runsBySession: db
      .prepare(
        `SELECT sr.session_id, COUNT(*) AS runs, MIN(sr.first_ts) AS first_ts,
                MAX(sr.last_ts) AS last_ts
           FROM subagent_runs sr GROUP BY sr.session_id ORDER BY sr.session_id`,
      )
      .all(),
    sessions: db
      .prepare('SELECT id, first_ts, last_ts, span_seconds FROM sessions ORDER BY id')
      .all(),
  };
}

describe('§3.7 (amended) — the sidecar is the structural source that resolves', () => {
  const sandbox = useSandbox();

  it('fills all four columns with no uuid chain available to help', async () => {
    const root = await sandbox.copyFixture(fixturePath(FIXTURE), 'root');
    await pinAll(root, MTIME_BASE);
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('a.db') });
    await harness.runSync();

    // ---- The fixture is genuinely chain-free ------------------------------------------
    // ⚠️ This is the assertion that makes the rest of the test mean something. If a future
    // edit gives a subagent transcript a `parentUuid` that resolves, §3.7's ORIGINAL rule
    // starts filling these columns and every expectation below would pass without the
    // sidecar code existing at all.
    const firstEvents = harness.db
      .prepare<{ source: string; event_key: string; parent_uuid: string | null }>(
        `SELECT fm.rel_path AS source, e.event_key, e.parent_uuid
           FROM subagent_runs sr
           JOIN file_manifest fm ON fm.id = sr.transcript_file_id
           JOIN events e ON e.id = (
                  SELECT e2.id FROM events e2
                   WHERE e2.source_file_id = sr.transcript_file_id
                   ORDER BY e2.ts ASC, e2.line_no ASC, e2.event_key ASC LIMIT 1)
          ORDER BY fm.rel_path`,
      )
      .all();
    expect(firstEvents).toHaveLength(5);
    expect(firstEvents.every((row) => row.parent_uuid === null)).toBe(true);
    // …and no subagent event anywhere resolves to a main-loop event, which is the real
    // dataset's shape: the uuid chain does not cross the file boundary.
    expect(
      harness.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM events e JOIN events p ON p.uuid = e.parent_uuid
            WHERE e.origin = 'subagent' AND p.origin = 'main'`,
        )
        .get()?.n,
    ).toBe(0);

    // ---- The fixture is non-trivial ----------------------------------------------------
    //   file_manifest = 1 main transcript + 5 subagent transcripts             = 6
    //                   (`*.meta.json` classifies `other` and is never a manifest row)
    //   events        = main 3 + 5 runs x 2 lines                              = 13
    //   tool_calls    = main sc-m1{Read,Agent} 2 + sc-m2{Agent} 1 + sc-m3{Agent} 1
    //                   + 1 per run x 5                                        = 9
    //   subagent_runs = one per subagent transcript file                       = 5
    //   file_touches  = write-class calls naming a path: none (Read/Grep/Bash are read-class)
    expect(countsByTable(harness.db)).toEqual({
      file_manifest: 6,
      projects: 1,
      sessions: 1,
      events: 13,
      tool_calls: 9,
      subagent_runs: 5,
      file_touches: 0,
      prompts: 0,
      stats_cache_days: 0,
    });

    // ---- The four columns, per run -----------------------------------------------------
    expect(runsOf(harness.db)).toEqual([
      {
        // No sidecar on disk and no chain: unlinked, unlabelled, counted, disclosed. The
        // honest-failure path, which must keep working (§4.6).
        transcript: `${SESSION_DIR}/subagents/agent-dark.jsonl`,
        spawn_event: null,
        spawn_tool_event: null,
        spawn_tool_ordinal: null,
        subagent_type: null,
        description: null,
        first_ts: T_10_05_00,
        last_ts: T_10_05_20,
      },
      {
        // Sidecar `toolUseId` = `toolu_sc_A`, which is content[1] of `sc-m1` — an `Agent`
        // call sitting BEHIND a `Read` at content[0]. ⚠️ `spawn_tool_ordinal` is therefore 1,
        // not 0: the link resolves the tool CALL, not merely its event (§3.6 `ordinal`).
        transcript: `${SESSION_DIR}/subagents/agent-linked.jsonl`,
        spawn_event: 'sc-m1',
        spawn_tool_event: 'sc-m1',
        spawn_tool_ordinal: 1,
        subagent_type: 'story-implementer',
        description: 'implement the widget',
        first_ts: T_10_00_05,
        last_ts: T_10_00_30,
      },
      {
        // ⚠️ THE PARTIAL CASE. The sidecar names `toolu_sc_not_in_this_dataset`, which matches
        // no tool call. The LABEL is filled and the LINK is not — partial knowledge is better
        // than none and must not be all-or-nothing.
        //
        // ⚠️ NEGATIVE CONTROL: `sc-m3` carries an unclaimed `Agent` call ("story-reviewer",
        // `toolu_sc_C`) two minutes earlier. A nearest-preceding, timestamp-proximity or
        // only-candidate-in-the-window heuristic would attach it here. §3.7 forbids all three,
        // and this row is where that prohibition is executable.
        transcript: `${SESSION_DIR}/subagents/agent-orphan-toolid.jsonl`,
        spawn_event: null,
        spawn_tool_event: null,
        spawn_tool_ordinal: null,
        subagent_type: 'story-scoper',
        description: 'scope the story',
        first_ts: T_10_03_00,
        last_ts: T_10_03_15,
      },
      {
        // ⚠️ The sidecar naming an agent the `Agent` call itself does not: `sc-m2`'s input
        // carries a `description` and NO `subagent_type`, so §5.4 rule 9 stores NULL there.
        // On the reference dataset this is 104 of 2,441 runs. The sidecar wins the COALESCE
        // precisely so those runs get a name.
        transcript: `${SESSION_DIR}/subagents/agent-untyped-call.jsonl`,
        spawn_event: 'sc-m2',
        spawn_tool_event: 'sc-m2',
        spawn_tool_ordinal: 0,
        subagent_type: 'Explore',
        description: 'explore the repo',
        first_ts: T_10_01_20,
        last_ts: T_10_02_10,
      },
      {
        // ⚠️ The nested-workflow shape: `{"agentType":…,"spawnDepth":1}` and no `toolUseId`
        // whatsoever (77 such sidecars on the reference dataset). Named, not linked, and its
        // `description` stays NULL because nothing states one — never the empty string, which
        // would render as a blank label that looks like an answer.
        transcript: `${SESSION_DIR}/subagents/agent-workflow.jsonl`,
        spawn_event: null,
        spawn_tool_event: null,
        spawn_tool_ordinal: null,
        subagent_type: 'workflow-subagent',
        description: null,
        first_ts: T_10_04_00,
        last_ts: T_10_04_40,
      },
    ]);

    // ---- The unclaimed `Agent` call really is there, unattached --------------------------
    // Belt and braces on the negative control: `toolu_sc_C` exists, and no run points at it.
    expect(
      harness.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM tool_calls WHERE tool_use_id = 'toolu_sc_C'`,
        )
        .get()?.n,
    ).toBe(1);
    expect(
      harness.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM subagent_runs sr
             JOIN tool_calls tc ON tc.id = sr.spawn_tool_call_id
            WHERE tc.tool_use_id = 'toolu_sc_C'`,
        )
        .get()?.n,
    ).toBe(1 - 1);

    // ---- ADR-020 — attribution is the path, and did not move -----------------------------
    // Every run is attributed to `sess-sc`, including the three that could not be linked.
    expect(
      harness.db
        .prepare<{ session_id: string; n: number }>(
          'SELECT session_id, COUNT(*) AS n FROM subagent_runs GROUP BY session_id',
        )
        .all(),
    ).toEqual([{ session_id: 'sess-sc', n: 5 }]);
  });

  it('counts and discloses the runs that genuinely could not be linked (§4.6)', async () => {
    const root = await sandbox.copyFixture(fixturePath(FIXTURE), 'root');
    await pinAll(root, MTIME_BASE);
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('b.db') });
    await harness.runSync();

    // agent-dark (no sidecar), agent-orphan-toolid (toolUseId matches nothing) and
    // agent-workflow (sidecar carries no toolUseId) = 3. The disclosure does NOT drop to zero,
    // and it must not: three runs really do have no spawn point in this dataset.
    expect(new IngestRepository(harness.db).unlinkedSubagentRuns()).toBe(3);

    // ⚠️ Two of those three are NAMED. "Unlinked" is a statement about `spawn_event_id`, not
    // about whether anything is known — §6.6/§6.7 show the label and still count the run.
    expect(
      harness.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM subagent_runs
            WHERE spawn_event_id IS NULL AND subagent_type IS NOT NULL`,
        )
        .get()?.n,
    ).toBe(2);
  });

  it('leaves every total byte-identical whether linkage resolves or not (§3.7)', async () => {
    // ⚠️ §3.7's load-bearing claim — "Totals are unaffected, because attribution is
    // structural and linkage is only a label" — made executable. Two identical trees; one
    // has every sidecar removed, so NOTHING links in it. If a single displayed quantity
    // depended on linkage, these two would differ.
    const withMeta = await sandbox.copyFixture(fixturePath(FIXTURE), 'with-meta');
    await pinAll(withMeta, MTIME_BASE);
    const linked = createSyncHarness({ claudeDir: withMeta, dbPath: sandbox.resolve('c.db') });
    await linked.runSync();

    const withoutMeta = await sandbox.copyFixture(fixturePath(FIXTURE), 'without-meta');
    await stripSidecars(withoutMeta);
    await pinAll(withoutMeta, MTIME_BASE);
    const unlinked = createSyncHarness({ claudeDir: withoutMeta, dbPath: sandbox.resolve('d.db') });
    await unlinked.runSync();

    // The two databases genuinely differ in linkage — otherwise the comparison is vacuous.
    expect(new IngestRepository(linked.db).unlinkedSubagentRuns()).toBe(3);
    expect(new IngestRepository(unlinked.db).unlinkedSubagentRuns()).toBe(5);
    expect(
      unlinked.db
        .prepare<{ n: number }>(
          'SELECT COUNT(*) AS n FROM subagent_runs WHERE subagent_type IS NOT NULL',
        )
        .get()?.n,
    ).toBe(0);

    // …and are identical in everything a number is built from.
    expect(attributionTotals(unlinked.db)).toEqual(attributionTotals(linked.db));

    // The hand-computed values themselves, so two identical-but-wrong databases still fail.
    //   main     events 3, input 3x10 = 30, output 3x4  = 12
    //   subagent events 10 (5 runs x 2 lines); only the assistant line of each carries usage,
    //                   so input 5x20 = 100, output 5x7 = 35
    expect(attributionTotals(linked.db)).toEqual({
      byOrigin: [
        { origin: 'main', events: 3, input: 30, output: 12, cacheWrite: 0, cacheRead: 0 },
        { origin: 'subagent', events: 10, input: 100, output: 35, cacheWrite: 0, cacheRead: 0 },
      ],
      // main: sc-m1 {Read, Agent} + sc-m2 {Agent} + sc-m3 {Agent} = 4; subagent: 1 x 5 = 5.
      toolCallsByOrigin: [
        { origin: 'main', calls: 4 },
        { origin: 'subagent', calls: 5 },
      ],
      runsBySession: [
        { session_id: 'sess-sc', runs: 5, first_ts: T_10_00_05, last_ts: T_10_05_20 },
      ],
      // §3.4 — first is the parent's 10:00:00, last is agent-dark's 10:05:20 (both origins).
      // span = (T_10_05_20 - T_10_00_00) / 1000 = 320_000 / 1000 = 320 s.
      sessions: [{ id: 'sess-sc', first_ts: T_10_00_00, last_ts: T_10_05_20, span_seconds: 320 }],
    });
  });

  it('recomputes linkage at FINALIZING, so an append equals a cold parse (INV-04)', async () => {
    // ⚠️ The append is chosen to be the one that would break an accumulating implementation:
    // the subagent transcripts and their sidecars are ALL present from the first sync, and
    // the parent transcript's `Agent` calls arrive only in the second. A linkage recorded
    // while parsing the subagent file could not possibly see them.
    const [firstLine = ''] = (
      await readFile(join(fixturePath(FIXTURE), ...MAIN_TRANSCRIPT.split('/')), 'utf8')
    ).split('\n');
    const wholeMain = await readFile(
      join(fixturePath(FIXTURE), ...MAIN_TRANSCRIPT.split('/')),
      'utf8',
    );
    const tail = wholeMain.slice(firstLine.length + 1);

    // ---- Run A: sync with a truncated parent, append the rest, sync again ---------------
    const rootA = await sandbox.copyFixture(fixturePath(FIXTURE), 'a-root');
    const mainA = join(rootA, ...MAIN_TRANSCRIPT.split('/'));
    await writeFile(mainA, `${firstLine}\n`);
    await pinAll(rootA, MTIME_BASE);
    const runA = createSyncHarness({ claudeDir: rootA, dbPath: sandbox.resolve('e.db') });
    await runA.runSync();

    // Only the first `Agent` call exists yet, so exactly one run can link.
    expect(new IngestRepository(runA.db).unlinkedSubagentRuns()).toBe(4);

    await appendFile(mainA, tail);
    await pinMtime(mainA, MTIME_APPENDED);
    await runA.runSync();

    // ---- Run B: cold parse of the whole tree --------------------------------------------
    const rootB = await sandbox.copyFixture(fixturePath(FIXTURE), 'b-root');
    await pinAll(rootB, MTIME_BASE);
    await pinMtime(join(rootB, ...MAIN_TRANSCRIPT.split('/')), MTIME_APPENDED);
    const runB = createSyncHarness({ claudeDir: rootB, dbPath: sandbox.resolve('f.db') });
    await runB.runSync();

    const appended = dumpNormalized(runA.db);
    const cold = dumpNormalized(runB.db);
    for (const table of INGESTED_TABLES) {
      expect(appended[table], `table ${table} differs between append and cold parse`).toEqual(
        cold[table],
      );
    }
    expect(appended).toEqual(cold);

    // The append genuinely CHANGED linkage rather than trivially agreeing with a cold parse
    // that also linked nothing.
    expect(new IngestRepository(runA.db).unlinkedSubagentRuns()).toBe(3);
    expect(new IngestRepository(runB.db).unlinkedSubagentRuns()).toBe(3);
  });

  it('fills a database that was populated before the sidecar was ever read', async () => {
    // ⚠️ Migration 0008 leaves `meta_agent_type` NULL on every existing row, and `subagent_runs`
    // is only re-inserted when its transcript is re-parsed. If the sidecar were read at parse
    // time, an existing database would stay unlabelled until every file happened to change —
    // i.e. until a rebuild. Reading it at FINALIZING is what makes the very next ordinary sync
    // repair it, with nothing re-parsed.
    const root = await sandbox.copyFixture(fixturePath(FIXTURE), 'root');
    await pinAll(root, MTIME_BASE);
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('g.db') });
    await harness.runSync();

    // Stand in for a pre-0008 database: the rows are there, the sidecar columns are not.
    harness.db
      .prepare(
        `UPDATE subagent_runs SET meta_agent_type = NULL, meta_tool_use_id = NULL,
                meta_description = NULL, spawn_event_id = NULL, spawn_tool_call_id = NULL,
                subagent_type = NULL, description = NULL`,
      )
      .run();
    expect(new IngestRepository(harness.db).unlinkedSubagentRuns()).toBe(5);

    // One touched file is enough to make the cycle finalize (§5.2 `needsFinalize`); nothing
    // about the subagent transcripts changes.
    await appendFile(
      join(root, ...MAIN_TRANSCRIPT.split('/')),
      '{"type":"assistant","uuid":"sc-m4","timestamp":"2024-06-01T10:06:00.000Z","message":{"role":"assistant"}}\n',
    );
    await pinMtime(join(root, ...MAIN_TRANSCRIPT.split('/')), MTIME_APPENDED);
    await harness.runSync();

    expect(new IngestRepository(harness.db).unlinkedSubagentRuns()).toBe(3);
    expect(
      harness.db
        .prepare<{ subagent_type: string | null }>(
          'SELECT subagent_type FROM subagent_runs ORDER BY subagent_type',
        )
        .all()
        .map((row) => row.subagent_type),
      // SQLite sorts NULL first — `agent-dark`, the run with no sidecar, stays unlabelled.
    ).toEqual([null, 'Explore', 'story-implementer', 'story-scoper', 'workflow-subagent']);
  });
});

describe('the sidecar document itself (§5.4 rule 12)', () => {
  it('maps a transcript path to its sibling, and only for a .jsonl path', () => {
    expect(subagentMetaRelPath('projects/-p/s/subagents/agent-a1.jsonl')).toBe(
      'projects/-p/s/subagents/agent-a1.meta.json',
    );
    // Never fabricates a sidecar path for a file that cannot have one.
    expect(subagentMetaRelPath('projects/-p/s/subagents/agent-a1.meta.json')).toBeNull();
    expect(subagentMetaRelPath('history.jsonl')).toBe('history.meta.json');
  });

  it('takes each field independently, so a partial document still yields what it states', () => {
    // The nested-workflow shape, verbatim from the reference dataset.
    expect(parseSubagentMeta('{"agentType":"workflow-subagent","spawnDepth":1}')).toEqual({
      agentType: 'workflow-subagent',
      toolUseId: null,
      description: null,
    });
    expect(
      parseSubagentMeta('{"agentType":"general-purpose","description":"d","toolUseId":"t"}'),
    ).toEqual({ agentType: 'general-purpose', toolUseId: 't', description: 'd' });
  });

  it('yields less knowledge rather than a guess when the document is unusable', () => {
    // §5.4 rule 1's principle: counted-and-skipped, never fatal, never invented.
    expect(parseSubagentMeta('not json at all')).toEqual(EMPTY_SUBAGENT_META);
    expect(parseSubagentMeta('[1,2,3]')).toEqual(EMPTY_SUBAGENT_META);
    expect(parseSubagentMeta('null')).toEqual(EMPTY_SUBAGENT_META);
    // A non-string, empty or whitespace-only value is "not stated" — never the empty string,
    // which would render as a blank label that looks like an answer.
    expect(parseSubagentMeta('{"agentType":"","toolUseId":"   ","description":7}')).toEqual(
      EMPTY_SUBAGENT_META,
    );
    expect(isEmptySubagentMeta(EMPTY_SUBAGENT_META)).toBe(true);
    expect(isEmptySubagentMeta({ agentType: 'a', toolUseId: null, description: null })).toBe(false);
  });
});
