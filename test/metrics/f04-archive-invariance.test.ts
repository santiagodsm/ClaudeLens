// F-04 — "Archive retains everything across re-sync **and** purge-and-rebuild" (§5.9.1, §12.2).
//
// ⚠️⚠️ **INV-18: archiving changes NO number.** "Every aggregate in §5.9 returns byte-identical
// results immediately before and immediately after an ACT-07, and again after a full
// purge-and-rebuild." §5.7 says it in the user's terms: "Totals, active time, cost, graphs and
// the session table are identical before and after — the sessions are simply badged 'archived'."
//
// ⚠️ This is the fixture that catches a **silent shrink of lifetime totals**, which is this
// project's defining failure arriving through ADR-033's door. §11.2, on why the purge-and-rebuild
// step exists at all: "Retaining rows whose source file has left `<claudeDir>` breaks ADR-026's
// two-class persistence model — the rows *look* rebuildable and are not — so every existing
// rebuild path would have deleted them and shrunk lifetime totals silently."
//
// ⚠️ `toMatchSnapshot()` is BANNED under `test/metrics/**` (CLAUDE.md §1, STACK ADR-012): an
// auto-written snapshot is a machine for blessing the bug. The baseline below is pinned with
// inline hand-computed values FIRST, and only then used as the invariance reference — a snapshot
// of zeroes compared against itself four times would pass while proving nothing.
//
// ⚠️ COVERAGE. INV-18 says "**every** aggregate in §5.9", and the numbers a user actually reads
// are the §4.5 CHANNEL payloads, not the repository rows behind them. A channel that reshapes,
// pages, sorts or joins a repository result could in principle lose the property the repositories
// keep, so the comparison runs at BOTH layers:
//
//   · `metricSnapshot()`   — direct aggregates over all seven fact tables, plus every §5.9
//                            repository (M-02/03/04, M-11, M-16, M-17, M-12, M-13/14 all-time,
//                            M-07 bindings (A)/(B)/(C), M-19/M-20, M-05/M-06).
//   · `channelSnapshot()`  — every §4.5/§4.6 payload shape, through `AnalyticsRepository`, which
//                            is the exact object each channel returns.
//
// Both are compared at all five steps. `channelSnapshot()` asserts each payload is a real payload
// rather than an error, so an unimplemented channel fails loudly instead of comparing two
// identical error envelopes and proving nothing.
//
// ⚠️⚠️ **PROVENANCE vs METRIC — the one thing an archive is allowed to change** (§4.5 as amended
// 2026-07-22 (E9)). `SessionRow` now carries `archiveId` / `archiveRoot` so §6.5's neutral
// "archived" badge can name where the transcripts went. Those two fields go from `null` to a value
// at STEP 1 and back to `null` at STEP 4 — **that transition is the point of the badge**, not a
// regression. Reconciling that with INV-18 has exactly two wrong answers and one right one:
//
//   ✗ Compare the payloads as-is → F-04 goes red on a deliberate, specified change, and the next
//     agent "fixes" it by loosening an invariance assertion that is load-bearing.
//   ✗ Loosen the comparison (drop `q:sessions`, or compare only ids) → F-04 goes blind to the
//     numbers on the very payload most at risk, which is the opposite of E10's amendment.
//   ✓ **Split them.** `channelSnapshot()` strips the two provenance fields and keeps comparing
//     every metric byte-for-byte at all five steps — INV-18 unchanged, nothing dropped. The
//     stripped fields are then asserted **separately and exactly** at every step by
//     `provenanceSnapshot()`: `null → archive 1 → archive 1 → archive 1 → null`, with the root
//     equal to the `archives` row's own `archive_root`. Neither half can hide in the other, and a
//     provenance field that stopped changing — or started changing when it should not — fails.
//
// INV-18 says "every **aggregate** in §5.9 returns byte-identical results". `archiveId` is not an
// aggregate; it is the annotation ADR-033 makes, and §5.7 states the user-facing consequence in
// the same breath: totals identical, "the sessions are simply badged 'archived'".

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_ROOT_NAME } from '../../src/main/config/paths';
import { openDatabase } from '../../src/main/db/driver';
import { migrate } from '../../src/main/db/migrate';
import { purge } from '../../src/main/db/purge';
import { ActiveTimeRepository } from '../../src/main/db/repositories/active-time';
import { AnalyticsRepository } from '../../src/main/db/repositories/analytics';
import { CostRepository } from '../../src/main/db/repositories/cost';
import { EventStatsRepository } from '../../src/main/db/repositories/event-stats';
import { ProjectStatsRepository } from '../../src/main/db/repositories/project-stats';
import { SessionStatsRepository } from '../../src/main/db/repositories/session-stats';
import { ToolStatsRepository } from '../../src/main/db/repositories/tool-stats';
import type { QueryContext } from '../../src/main/db/repositories/scope';
import type { SqliteDatabase } from '../../src/main/db/sqlite';
import type { SessionsPage } from '../../src/shared/ipc-contract';
import { classifyJsonlFile } from '../../src/main/sync/classify';
import { entryKind } from '../../src/main/harness/tree';
import { useSandbox } from '../support/sandbox';
import { createActionHarness } from '../support/action-harness';
import { createSyncHarness, fixturePath } from '../support/sync-harness';

/** ⛔ All time, all projects. INV-18 is a statement about lifetime totals. */
const ALL_TIME: QueryContext = {
  filter: { projectIds: null, from: null, to: null },
  idleGapMinutes: 15,
};

const ARCHIVED_SESSION = 'sess-a';

/**
 * The REPOSITORY layer, in one comparable object.
 *
 * Direct aggregates over all seven fact tables (`events`, `tool_calls`, `file_touches`,
 * `subagent_runs`, `prompts`, `sessions`, `projects`) including the four token classes split by
 * `origin`; plus M-02/M-03/M-04 (`tokenTotals`), M-11 + session count + synthetic disclosure
 * (`counts`), M-17 (`originSplit`), M-16 (`coverage`), bad lines, M-12
 * (`ToolStats.totals`/`byTool`), M-13/M-14 all-time, M-07 bindings (A)/(B)/(C) and M-19/M-20
 * (`ActiveTime`), the working-day leaderboard, the session histogram, M-02/M-05 per project, and
 * M-05/M-06 (`CostRepository.totals`).
 *
 * `channelSnapshot()` below covers the layer above this one — the payloads the user reads.
 */
function metricSnapshot(db: SqliteDatabase): Record<string, unknown> {
  const events = new EventStatsRepository(db);
  const tools = new ToolStatsRepository(db);
  const active = new ActiveTimeRepository(db);
  const sessions = new SessionStatsRepository(db);
  const projects = new ProjectStatsRepository(db);
  const cost = new CostRepository(db);
  const query = <Row>(sql: string): Row[] => db.prepare<Row>(sql).all();

  return {
    // ---- direct table-level aggregates: the floor nothing can drop below ------------------
    tables: query(
      `SELECT 'events' AS t, COUNT(*) AS n FROM events
       UNION ALL SELECT 'tool_calls', COUNT(*) FROM tool_calls
       UNION ALL SELECT 'file_touches', COUNT(*) FROM file_touches
       UNION ALL SELECT 'subagent_runs', COUNT(*) FROM subagent_runs
       UNION ALL SELECT 'prompts', COUNT(*) FROM prompts
       UNION ALL SELECT 'sessions', COUNT(*) FROM sessions
       UNION ALL SELECT 'projects', COUNT(*) FROM projects`,
    ),
    tokensByOrigin: query(
      `SELECT origin, COUNT(*) AS events, SUM(tok_input) AS i, SUM(tok_output) AS o,
              SUM(tok_cache_write) AS cw, SUM(tok_cache_read) AS cr
         FROM events WHERE is_synthetic = 0 GROUP BY origin ORDER BY origin`,
    ),
    sessionRows: query(
      `SELECT s.id, p.encoded_name AS project, s.first_ts, s.last_ts, s.span_seconds, s.is_partial
         FROM sessions s JOIN projects p ON p.id = s.project_id ORDER BY s.id`,
    ),
    // ⚠️ Keyed by encoded_name, never by `projects.id`: a purge-and-rebuild legitimately
    // reassigns surrogate keys (§3.3 makes `encoded_name` the identity), and comparing rowids
    // would fail on a difference that carries no information.
    eventsByProject: query(
      `SELECT p.encoded_name AS project, COUNT(*) AS n, SUM(e.tok_output) AS out
         FROM events e JOIN projects p ON p.id = e.project_id
        GROUP BY p.encoded_name ORDER BY p.encoded_name`,
    ),
    toolCallsByName: query(
      `SELECT tool_name, COUNT(*) AS n FROM tool_calls GROUP BY tool_name ORDER BY tool_name`,
    ),

    // ---- §5.9 repositories, all time -------------------------------------------------------
    tokenTotals: events.tokenTotals(ALL_TIME),
    counts: events.counts(ALL_TIME),
    originSplit: events.originSplit(ALL_TIME),
    coverage: events.coverage(),
    badLines: events.badLines(),
    toolTotals: tools.totals(ALL_TIME),
    byTool: tools.byTool(ALL_TIME),
    skillsAllTime: tools.skillInvocationsAllTime().toSorted((a, b) => a.name.localeCompare(b.name)),
    toolsAllTime: tools.toolInvocationsAllTime().toSorted((a, b) => a.name.localeCompare(b.name)),
    activeBySession: active
      .bySession(ALL_TIME)
      .toSorted((a, b) => a.sessionId.localeCompare(b.sessionId)),
    activeByWorkingDay: active
      .byWorkingDay(ALL_TIME)
      .map(({ day, activeSeconds, spanSeconds, sessions: n }) => ({
        day,
        activeSeconds,
        spanSeconds,
        n,
      }))
      .toSorted((a, b) => a.day.localeCompare(b.day) || a.activeSeconds - b.activeSeconds),
    bindingCSeconds: active.bindingCSeconds(ALL_TIME),
    overlap: active.overlap(ALL_TIME),
    sessionHistogram: sessions.sessionHistogram(ALL_TIME),
    workingDayNames: sessions
      .workingDays(ALL_TIME)
      .map(({ day, displayName, activeSeconds }) => ({ day, displayName, activeSeconds }))
      .toSorted((a, b) => a.day.localeCompare(b.day) || a.displayName.localeCompare(b.displayName)),
    tokensByProject: projects
      .tokensByProject(ALL_TIME)
      .map(({ displayName, outputTokens, costNanoUsd }) => ({
        displayName,
        outputTokens,
        costNanoUsd,
      }))
      .toSorted((a, b) => a.displayName.localeCompare(b.displayName)),
    costTotals: cost.totals({ projectIds: null, from: null, to: null }),
  };
}

/** §4.2 — a page big enough that the fixture is never truncated by paging rather than by data. */
const WHOLE_PAGE = { limit: 500 } as const;

/**
 * The CHANNEL layer — every §4.5 / §4.6 payload, in the exact shape the renderer receives.
 *
 * ⚠️ This is the half INV-18 is actually about from the user's side. "Every aggregate in §5.9
 * returns byte-identical results" is a claim about the numbers on screen, and a channel does more
 * than pass a repository row through: it pages, sorts, joins display names, folds four
 * repositories into one tile, and attaches disclosures. Any of those could in principle lose the
 * invariance the repositories keep — `q:sessions`, for instance, pages over a set whose membership
 * would change if an archived session ever dropped out.
 *
 * ⚠️ Every payload is asserted to be a real payload before it is compared. An unimplemented
 * channel must fail loudly here rather than have two identical error envelopes compare equal
 * across all five steps and prove nothing.
 */
/** §4.5's two provenance fields — the only fields on a `SessionRow` an ACT-07 may change. */
interface Provenance {
  readonly archiveId: number | null;
  readonly archiveRoot: string | null;
}

/** A live session, in the shape the assertions below compare against. */
const LIVE: Provenance = { archiveId: null, archiveRoot: null };

/**
 * Removes `archiveId` / `archiveRoot` from a session payload so the remaining fields — every one
 * of which INV-18 says is byte-identical across an archive — can be compared as such.
 *
 * ⚠️ Deleting keys rather than picking the survivors is deliberate: a field added to `SessionRow`
 * later is compared for invariance by default, which is the safe direction. Only these two are
 * ever exempt, and `provenanceSnapshot()` asserts them by hand.
 */
function withoutProvenance<T extends Provenance>(payload: T): Omit<T, 'archiveId' | 'archiveRoot'> {
  const { archiveId, archiveRoot, ...rest } = payload;
  void archiveId;
  void archiveRoot;
  return rest;
}

/** The same, for a whole `q:sessions` envelope: the page, the row set and `uncosted` all survive. */
function sessionsWithoutProvenance(payload: SessionsPage): Record<string, unknown> {
  return {
    ...payload,
    page: { ...payload.page, rows: payload.page.rows.map(withoutProvenance) },
  };
}

/**
 * The provenance half, read from the SAME channel payloads the user's badge is rendered from —
 * `q:sessions` and `q:sessionDetail` — so the two surfaces cannot drift apart unnoticed.
 */
function provenanceSnapshot(db: SqliteDatabase): {
  page: Record<string, Provenance>;
  detail: Record<string, Provenance>;
} {
  const q = new AnalyticsRepository(db);
  const page: Record<string, Provenance> = {};
  const detail: Record<string, Provenance> = {};

  for (const row of q.sessions(ALL_TIME, WHOLE_PAGE, 'firstTs', 'desc').page.rows) {
    page[row.id] = { archiveId: row.archiveId, archiveRoot: row.archiveRoot };
    const one = q.sessionDetail(row.id, ALL_TIME.idleGapMinutes);
    if (one === undefined) throw new Error(`F-04: no q:sessionDetail for ${row.id}.`);
    detail[row.id] = { archiveId: one.archiveId, archiveRoot: one.archiveRoot };
  }
  return { page, detail };
}

function channelSnapshot(db: SqliteDatabase): Record<string, unknown> {
  const q = new AnalyticsRepository(db);

  // Drill-down channels are keyed on a session id, so both sessions are exercised — including
  // the one that gets archived, whose detail payload must survive the move unchanged.
  const sessionIds = db
    .prepare<{ id: string }>('SELECT id FROM sessions ORDER BY id')
    .all()
    .map((row) => row.id);

  const snapshot: Record<string, unknown> = {
    // §6.3 Overview
    'q:overviewTiles': q.overviewTiles(ALL_TIME),
    'q:activityCalendar': q.activityCalendar(ALL_TIME, 52),
    'q:modelMixTimeline': q.modelMixTimeline(ALL_TIME, 'day'),
    // §6.4 Tokens & Cost
    'q:tokensByModel:all': q.tokensByModel(ALL_TIME, 'day', 'all'),
    'q:tokensByModel:output_only': q.tokensByModel(ALL_TIME, 'week', 'output_only'),
    'q:tokensByProject': q.tokensByProject(ALL_TIME),
    'q:cacheEfficiency': q.cacheEfficiency(ALL_TIME),
    'q:costBreakdown:model': q.costBreakdown(ALL_TIME, 'model'),
    'q:costBreakdown:project': q.costBreakdown(ALL_TIME, 'project'),
    'q:costBreakdown:day': q.costBreakdown(ALL_TIME, 'day'),
    // §6.5 Sessions & Time
    'q:sessionHistogram': q.sessionHistogram(ALL_TIME),
    'q:rhythmHeatmap': q.rhythmHeatmap(ALL_TIME),
    'q:workingDays': q.workingDays(ALL_TIME, WHOLE_PAGE),
    // ⚠️ Provenance stripped, metrics kept — see the header. Every other field on every row is
    // still compared byte-for-byte, including the row SET, which is what catches an archived
    // session dropping out of the page.
    'q:sessions:firstTs': sessionsWithoutProvenance(
      q.sessions(ALL_TIME, WHOLE_PAGE, 'firstTs', 'desc'),
    ),
    'q:sessions:activeSeconds': sessionsWithoutProvenance(
      q.sessions(ALL_TIME, WHOLE_PAGE, 'activeSeconds', 'asc'),
    ),
    // §6.6 Tools & Agents
    'q:toolFingerprint': q.toolFingerprint(ALL_TIME),
    'q:originSplit': q.originSplit(ALL_TIME),
    'q:toolMixByProject': q.toolMixByProject(ALL_TIME, 10),
    // §6.8 Projects & Code
    'q:projectCards': q.projectCards(ALL_TIME),
    'q:fileMetrics': q.fileMetrics(ALL_TIME, WHOLE_PAGE),
    // §6.7 Graphs — ⛔ INV-13 for `q:harnessGraph`
    'q:harnessGraph': q.harnessGraph(),
    'q:toolTransition': q.toolTransition(ALL_TIME),
    'q:flowSankey': q.flowSankey(ALL_TIME),
    // §6.9 Harness Manager — ⛔ INV-13, all four
    'q:skills': q.skills(WHOLE_PAGE, 'never_used'),
    'q:claudeMdFiles': q.claudeMdFiles(`${BACKUP_ROOT_NAME}/`),
    'q:plugins': q.plugins(),
    'q:memories': q.memories(),
    // §4.6 Disclosures — the caveat travels with the figure, so it is compared with it
    'q:disclosures': q.disclosures(ALL_TIME),
    'q:uncosted': q.uncosted(ALL_TIME),
    coverage: q.coverage(),
  };

  for (const sessionId of sessionIds) {
    const detail = q.sessionDetail(sessionId, ALL_TIME.idleGapMinutes);
    snapshot[`q:sessionDetail:${sessionId}`] =
      detail === undefined ? undefined : withoutProvenance(detail);
    snapshot[`q:executionTrace:${sessionId}`] = q.executionTrace(sessionId);
  }

  // ⚠️ Not a formality. Without it, an unimplemented or newly-broken channel returning
  // `undefined` would compare equal to itself at every step, and F-04 would go green on a
  // channel that had stopped answering.
  for (const [channel, payload] of Object.entries(snapshot)) {
    if (payload === undefined || payload === null) {
      throw new Error(`F-04: ${channel} returned no payload, so its invariance is untested.`);
    }
  }
  return snapshot;
}

/** Both layers at once, so a step cannot be asserted at one and forgotten at the other. */
function fullSnapshot(db: SqliteDatabase): {
  metrics: Record<string, unknown>;
  channels: Record<string, unknown>;
} {
  return { metrics: metricSnapshot(db), channels: channelSnapshot(db) };
}

describe('F-04 — archiving changes no number (INV-18, ADR-033/034)', () => {
  const sandbox = useSandbox();

  it('archive → re-sync → purge-and-rebuild → undo, byte-identical at every step', async () => {
    const claudeDir = await sandbox.copyFixture(fixturePath('f03-append/base'), 'claude');
    // ⚠️ INV-19 — a sibling of `claudeDir`: never inside it, never a parent of it.
    const archiveRoot = sandbox.resolve('archive');
    await mkdir(archiveRoot, { recursive: true });
    const dbPath = sandbox.resolve('lens.db');

    // ---- STEP 0 — parse the fixture and PIN the baseline by hand ------------------------
    const sync = createSyncHarness({ claudeDir, dbPath });
    await sync.runSync('full');
    const baseline = fullSnapshot(sync.db);

    // ⚠️ Hand-computed from the committed fixture, record by record, so the four invariance
    // comparisons below are anchored to real numbers. A baseline that was itself a snapshot
    // would compare zeroes against zeroes four times and prove nothing.
    //
    // `f03-append/base`, enumerated:
    //   projects/-work-demo-alpha/sess-a.jsonl        a1 user · a2 assistant · a3 assistant  → 3
    //   projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl   s1 · s2 assistant           → 2
    //   projects/-work-demo-beta/sess-b.jsonl         b1 user · b2 assistant                 → 2
    //                                                                         events = 3+2+2 = 7
    //   tool_use blocks: a2 → Agent, Write (2) · s1 → Read (1) · b2 → Skill, Skill (2)
    //                                                                     tool_calls = 2+1+2 = 5
    //   write-class targets: only a2's Write carries a path                  file_touches = 1
    //   one subagent transcript under sess-a                                subagent_runs = 1
    //   history.jsonl: 2 records                                                  prompts = 2
    expect(baseline.metrics['tables']).toEqual([
      { t: 'events', n: 7 },
      { t: 'tool_calls', n: 5 },
      { t: 'file_touches', n: 1 },
      { t: 'subagent_runs', n: 1 },
      { t: 'prompts', n: 2 },
      { t: 'sessions', n: 2 },
      { t: 'projects', n: 2 },
    ]);

    // M-04, the four classes, hand-summed from the `usage` blocks above:
    //   input        main 100 + 50 + 1 = 151 · subagent 20 + 5 = 25            → 176
    //   output       main 200 + 75 + 2 = 277 · subagent 30 + 7 = 37            → 314
    //   cacheWrite   main 10 · subagent 0                                      →  10
    //   cacheRead    main 1000 · subagent 0                                    → 1000
    expect(baseline.metrics['tokenTotals']).toEqual({
      input: 176,
      output: 314,
      cacheWrite: 10,
      cacheWrite1h: 0,
      cacheRead: 1000,
    });

    // ⚠️ M-17 / INV-02 — the archived session's totals really are split across a roll-up, which
    // is the whole reason INV-20 exists. A main-loop-only baseline would prove nothing here.
    const split = baseline.metrics['originSplit'] as {
      main: { input: number; output: number };
      subagent: { input: number; output: number };
    };
    expect(split.main).toMatchObject({ input: 151, output: 277 });
    expect(split.subagent).toMatchObject({ input: 25, output: 37 });
    expect(split.main.output + split.subagent.output).toBe(314);

    // ⚠️ The CHANNEL layer is anchored by hand too, for the same reason the repository layer is:
    // comparing a payload against itself five times proves nothing unless the payload is first
    // shown to hold the right numbers. `distinctTools` is 4 — Agent, Write, Read, Skill — and the
    // session page must carry BOTH sessions, because the one that gets archived has to stay in it.
    const channels = baseline.channels;
    expect(channels['q:overviewTiles']).toMatchObject({
      outputTokens: 314,
      cacheReadTokens: 1000,
      toolCalls: 5,
      distinctTools: 4,
      sessions: 2,
    });
    const sessionPage = channels['q:sessions:firstTs'] as { page: { rows: { id: string }[] } };
    expect(sessionPage.page.rows.map((row) => row.id).toSorted()).toEqual(['sess-a', 'sess-b']);

    // ⚠️ The provenance baseline: nothing is archived yet, so BOTH sessions read live on BOTH
    // surfaces. Pinned by hand for the same reason every other baseline here is — a provenance
    // comparison against itself proves nothing until the starting value is known.
    expect(provenanceSnapshot(sync.db)).toEqual({
      page: { 'sess-a': LIVE, 'sess-b': LIVE },
      detail: { 'sess-a': LIVE, 'sess-b': LIVE },
    });
    // §6.7's Harness Map and §6.6's fingerprint both have to be non-empty, or their invariance
    // across the archive is a statement about two empty objects.
    expect((channels['q:toolFingerprint'] as { total: number }).total).toBe(5);
    expect(
      (channels['q:executionTrace:sess-a'] as { timeline: unknown[] }).timeline.length,
    ).toBeGreaterThan(0);
    expect(channels['q:sessionDetail:sess-a']).toBeDefined();

    const transcriptBytes = await readFile(
      join(claudeDir, 'projects/-work-demo-alpha/sess-a.jsonl'),
      'utf8',
    );
    sync.db.close();

    // ---- STEP 1 — ACT-07, on the same database file ------------------------------------
    const h = createActionHarness({ claudeDir, dbPath, archiveRoot });
    const payload = { sessionIds: [ARCHIVED_SESSION] };
    const preview = await h.actions.preview({ actionType: 'archive-sessions', payload });
    const archived = await h.actions.execute({
      actionType: 'archive-sessions',
      payload,
      confirmToken: preview.confirmToken,
    });
    expect(archived.status).toBe('completed');

    // ⚠️⚠️ IMMEDIATELY AFTER THE ARCHIVE — every number identical.
    expect(fullSnapshot(h.db)).toEqual(baseline);

    // The session is badged, not removed (§5.7, §6.5).
    const badge = h.db
      .prepare<{ id: string; archive_id: number | null }>(
        'SELECT id, archive_id FROM sessions ORDER BY id',
      )
      .all();
    expect(badge).toEqual([
      { id: 'sess-a', archive_id: 1 },
      { id: 'sess-b', archive_id: null },
    ]);
    // §6.10 card 7 — Settings names where the transcripts went.
    const destination = h.actions.archivesList().rows[0]?.archiveRoot;
    expect(destination).toContain(archiveRoot);

    // ⚠️⚠️ …and §6.5's badge names the same folder. This is the deliberate change the invariance
    // comparison above is blind to BY CONSTRUCTION, so it is asserted here exactly: `sess-a` is
    // archive 1 at the destination directory, `sess-b` is still live, on the table payload AND
    // the drill-down payload. An implementation that badged everything, badged nothing, or named
    // the user's `archiveRoot` setting instead of the destination (§3.2, amended E10) fails here.
    const archivedProvenance = { archiveId: 1, archiveRoot: destination ?? null };
    expect(provenanceSnapshot(h.db)).toEqual({
      page: { 'sess-a': archivedProvenance, 'sess-b': LIVE },
      detail: { 'sess-a': archivedProvenance, 'sess-b': LIVE },
    });
    h.db.close();

    // ---- STEP 2 — the very next sync -----------------------------------------------------
    // §5.3's `ARCHIVED` row is the single most important line in that table: the transcript is
    // gone from `<claudeDir>`, and without it the classifier calls the file MISSING, cascades
    // its events away, and every lifetime total shrinks with no marker and no error.
    const resync = createSyncHarness({ claudeDir, dbPath });
    await resync.runSync('incremental');
    expect(fullSnapshot(resync.db)).toEqual(baseline);
    // The badge survives the sync that no longer sees the file (§5.3 `ARCHIVED`).
    expect(provenanceSnapshot(resync.db)).toEqual({
      page: { 'sess-a': archivedProvenance, 'sess-b': LIVE },
      detail: { 'sess-a': archivedProvenance, 'sess-b': LIVE },
    });

    const manifest = resync.db
      .prepare<{
        rel_path: string;
        archive_id: number | null;
        byte_offset: number;
        mtime_ms: number;
      }>('SELECT rel_path, archive_id, byte_offset, mtime_ms FROM file_manifest ORDER BY rel_path')
      .all();
    const archivedRows = manifest.filter((row) => row.rel_path.includes('sess-a'));
    expect(archivedRows).toHaveLength(2);
    for (const row of archivedRows) {
      expect(row.archive_id).toBe(1);
      // ⚠️ The classification is `ARCHIVED`, **never** `MISSING` — asserted against the real
      // manifest row and the real (absent) disk state, not against a hand-made input.
      expect(
        classifyJsonlFile(
          {
            byteOffset: row.byte_offset,
            mtimeMs: row.mtime_ms,
            contentHash: null,
            archiveId: row.archive_id,
            retainedOrphan: false, // these rows are archived, not orphaned (§3.4)
          },
          null,
        ),
      ).toBe('ARCHIVED');
    }
    resync.db.close();

    // ---- STEP 3 — purge and full rebuild --------------------------------------------------
    // §11.2: "why F-04 tests a full purge-and-rebuild rather than just the happy path."
    const rebuilt = openDatabase(dbPath);
    migrate(rebuilt);
    const outcome = purge(rebuilt);
    expect(outcome.totalDeleted).toBeGreaterThan(0);
    // The RETAINED rows survived the purge itself (ADR-033) — checked before the rebuild, so a
    // green result cannot be "the rebuild happened to re-parse them", which it cannot do.
    expect(rebuilt.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(1);
    rebuilt.close();

    const full = createSyncHarness({ claudeDir, dbPath });
    await full.runSync('full');
    // ⚠️⚠️ AFTER PURGE-AND-REBUILD — still byte-identical. This is the step that fails if any
    // rebuild path drops an `archive_id IS NOT NULL` guard.
    expect(fullSnapshot(full.db)).toEqual(baseline);
    // ⚠️ …and so does the annotation. `archives` is USER-class (§3.15) and `sessions.archive_id`
    // is RETAINED (ADR-033): a purge that dropped either would leave a session the user archived
    // looking live, pointing at transcripts that are not in `<claudeDir>`.
    expect(provenanceSnapshot(full.db)).toEqual({
      page: { 'sess-a': archivedProvenance, 'sess-b': LIVE },
      detail: { 'sess-a': archivedProvenance, 'sess-b': LIVE },
    });
    full.db.close();

    // ---- STEP 4 — undo -------------------------------------------------------------------
    const undoHarness = createActionHarness({ claudeDir, dbPath, archiveRoot });
    const undo = await undoHarness.actions.undoLast({ auditId: archived.auditId });
    expect(undo.status).toBe('undone');
    expect(undo.restored).toBe(2);
    // ⚠️⚠️ AFTER UNDO — still byte-identical. Archiving and un-archiving are both no-ops on
    // every number; only the badge and the file's location ever changed.
    expect(fullSnapshot(undoHarness.db)).toEqual(baseline);
    expect(
      undoHarness.db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE archive_id IS NOT NULL')
        .get()?.n,
    ).toBe(0);
    // ⚠️ The badge goes away with the annotation, both sides. §5.7 rule 5 is "restoring the exact
    // prior state": a session whose transcript is back in `<claudeDir>` must not still tell the
    // user its transcripts live in an archive folder that no longer holds them.
    expect(provenanceSnapshot(undoHarness.db)).toEqual({
      page: { 'sess-a': LIVE, 'sess-b': LIVE },
      detail: { 'sess-a': LIVE, 'sess-b': LIVE },
    });
    undoHarness.db.close();

    // The bytes came home unchanged, and the archive root itself was never deleted.
    expect(await readFile(join(claudeDir, 'projects/-work-demo-alpha/sess-a.jsonl'), 'utf8')).toBe(
      transcriptBytes,
    );
    expect(await entryKind(archiveRoot)).toBe('directory');

    // ---- STEP 5 — one more sync after the undo, for completeness ------------------------
    const settled = createSyncHarness({ claudeDir, dbPath });
    await settled.runSync('incremental');
    expect(fullSnapshot(settled.db)).toEqual(baseline);
    expect(provenanceSnapshot(settled.db)).toEqual({
      page: { 'sess-a': LIVE, 'sess-b': LIVE },
      detail: { 'sess-a': LIVE, 'sess-b': LIVE },
    });
    settled.db.close();
  });
});
