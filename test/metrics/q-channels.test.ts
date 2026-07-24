// Every §4.5 / §4.6 `q:*` channel, over one parsed fixture, with the two structural invariants
// that bind the payload envelopes rather than the arithmetic:
//
//   · **INV-10** — every payload containing a `$` figure also contains its `UncostedSummary`.
//   · **INV-23** — every payload containing a multi-session M-07 binding-(C) figure also contains
//     its `overlapSeconds` (M-20). And the two deliberate NON-additions (§4.5, A-01): `q:sessions`
//     (binding (A)) and `q:projectCards` (single-project ⇒ INV-22(d)) carry none.
//
// ⚠️ The cost figures here are hand-computed from a price table this test writes itself, so the
// `$` assertions are real numbers rather than "not null". E5 owns the costing; this asserts that
// the analytics façade calls it and reports both halves (§4.6).

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { CostRepository } from '../../src/main/db/repositories/cost';
import { colorIndexFor } from '../../src/shared/color-index';
import { ALL, at, loadFixture, type MetricsFixture } from './support/metrics-harness';
import { assertTimezonePinned, usePinnedTimezone } from './support/pinned-tz';

/** `$1.00 / Mtok` on all four classes = 1_000_000 picoUSD per token (ADR-023). */
const ONE_USD_PER_MTOK_PICO = 1_000_000;

function priceEverything(fixture: MetricsFixture, model: string): void {
  const insert = fixture.db.prepare(
    `INSERT INTO price_rows (model, token_class, rate_picousd_per_token, valid_from, valid_to,
       source, created_at, updated_at)
     VALUES (?, ?, ?, 0, NULL, 'manual', 0, 0)`,
  );
  for (const tokenClass of ['input', 'output', 'cache_write', 'cache_read']) {
    insert.run(model, tokenClass, ONE_USD_PER_MTOK_PICO);
  }
}

describe('§4.5 / §4.6 — every q:* channel returns its contract shape over real parsed data', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('overview, cost and the two disclosure rules', async () => {
    const fixture = await loadFixture(sandbox, 'f02-rollup');
    priceEverything(fixture, 'claude-test-1');
    const context = at(15);

    // ── Hand-computed M-05 ──────────────────────────────────────────────────────────────
    // Priceable events (M-01, model non-null, tokens > 0):
    //   m1  100 + 200 +  10 + 1000 = 1_310 tokens
    //   m2    7 +  11 +   0 +    3 =    21
    //   s1   20 +  30 +   4 +  500 =   554
    //   s3    1 +   2 +   0 +    0 =     3
    //   TOTAL                       = 1_888 tokens
    // At 1_000_000 picoUSD/token → 1_888_000_000 picoUSD → 1_888_000 nanoUSD ($0.001888).
    const tiles = fixture.analytics.overviewTiles(context);
    expect(tiles.costNanoUsd).toBe(1_888_000);
    // M-02 output tokens: 200 + 11 + 30 + 2 = 243. M-03 cache reads: 1000 + 3 + 500 = 1_503.
    expect(tiles.outputTokens).toBe(243);
    expect(tiles.cacheReadTokens).toBe(1_503);
    // M-12: 4 tool calls (Agent, Read, Grep, Read); 3 distinct names.
    expect(tiles.toolCalls).toBe(4);
    expect(tiles.distinctTools).toBe(3);
    expect(tiles.sessions).toBe(1);

    // INV-10 — the disclosure travels with the money, and says "complete" because it is.
    expect(tiles.uncosted).toEqual({ records: 0, byModel: [] });
    // INV-23 — one session, one project, so M-20 is 0; the FIELD is still present.
    expect(tiles.overlapSeconds).toBe(0);

    // §6.4's rule, asserted: with NO price row covering anything, the `$` is `null`, never `$0.00`.
    const unpriced = await loadFixture(sandbox, 'f02-rollup');
    const unpricedTiles = unpriced.analytics.overviewTiles(context);
    expect(unpricedTiles.costNanoUsd).toBeNull();
    expect(unpricedTiles.costNanoUsd).not.toBe(0);
    // …and the four events that could not be costed are named, by model and date range (M-06).
    expect(unpricedTiles.uncosted.records).toBe(4);
    expect(unpricedTiles.uncosted.byModel).toEqual([
      {
        model: 'claude-test-1',
        records: 4,
        fromTs: Date.parse('2024-05-01T09:01:00.000Z'),
        toTs: Date.parse('2024-05-01T09:05:00.000Z'),
      },
    ]);
  });

  it('every $-carrying payload carries an UncostedSummary (INV-10)', async () => {
    const fixture = await loadFixture(sandbox, 'f02-rollup');
    priceEverything(fixture, 'claude-test-1');
    const context = at(15);

    const payloads = [
      fixture.analytics.overviewTiles(context),
      fixture.analytics.tokensByProject(context),
      fixture.analytics.costBreakdown(context, 'model'),
      fixture.analytics.projectCards(context),
      fixture.analytics.sessions(context, { limit: 10 }, 'firstTs', 'asc'),
    ];
    for (const payload of payloads) {
      expect(payload).toHaveProperty('uncosted');
      expect(payload.uncosted.records).toBe(0);
      expect(Array.isArray(payload.uncosted.byModel)).toBe(true);
    }

    // §4.5's two deliberate NON-additions, asserted as absences so nobody "completes the pattern".
    expect(
      Object.hasOwn(
        fixture.analytics.sessions(context, { limit: 10 }, 'firstTs', 'asc'),
        'overlapSeconds',
      ),
    ).toBe(false);
    expect(Object.hasOwn(fixture.analytics.projectCards(context), 'overlapSeconds')).toBe(false);

    // The grouped `$` agrees with the ungrouped one — same CTE, same `costed` flag (A-10).
    const breakdown = fixture.analytics.costBreakdown(context, 'model');
    expect(breakdown.rows).toEqual([
      {
        key: 'claude-test-1',
        label: 'claude-test-1', // model grouping: label === key
        costNanoUsd: 1_888_000,
        tokensByClass: {
          input: 128,
          output: 243,
          cacheWrite: 14,
          cacheWrite1h: 0,
          cacheRead: 1_503,
        },
      },
    ]);
    expect(breakdown.rows.reduce((total, row) => total + row.costNanoUsd, 0)).toBe(
      fixture.analytics.overviewTiles(context).costNanoUsd,
    );
  });

  it('the uncosted record count equals the sum of its own byModel groups', async () => {
    // ⚠️ The identity that P-09's optimisation (a) rests on. `#uncostedSummary` derives `records`
    // from `Σ byModel.records` instead of running the four-class bi-temporal cost CTE a second
    // time purely to read `totals().uncostedEvents`. The two are the same number BY CONSTRUCTION
    // — same `classified` CTE, same `costed` flag, and `COUNT(*) … GROUP BY model` summed is
    // `COUNT(*) − SUM(costed)` — but "provably equal and never checked" is how a silently wrong
    // number gets born, so it is checked, against E5's own query, on both sides of the boundary.
    const fixture = await loadFixture(sandbox, 'f02-rollup');
    const context = at(15);
    const repo = new CostRepository(fixture.db);

    // (i) nothing priced — every priceable event is uncosted.
    const unpriced = fixture.analytics.uncosted(context);
    expect(unpriced.records).toBe(repo.totals(context.filter).uncostedEvents);
    expect(unpriced.records).toBe(unpriced.byModel.reduce((total, row) => total + row.records, 0));
    expect(unpriced.records).toBe(4);

    // (ii) partially priced — only `claude-test-2` is left uncosted, so the sum is over a proper
    // subset of the models present and a bug in the derivation would show up as a mismatch.
    const partial = await loadFixture(sandbox, 'f06-synthetic');
    priceEverything(partial, 'claude-test-1');
    const partialRepo = new CostRepository(partial.db);
    const summary = partial.analytics.uncosted(context);
    expect(summary.records).toBe(partialRepo.totals(context.filter).uncostedEvents);
    expect(summary.records).toBe(1); // only the `claude-test-2` event
    expect(summary.byModel.map((row) => row.model)).toEqual(['claude-test-2']);

    // (iii) fully priced — zero groups, zero records, and still equal.
    priceEverything(partial, 'claude-test-2');
    expect(partial.analytics.uncosted(context)).toEqual({ records: 0, byModel: [] });
    expect(partialRepo.totals(context.filter).uncostedEvents).toBe(0);
  });

  it('timelines, calendar, heatmap and cache efficiency', async () => {
    const fixture = await loadFixture(sandbox, 'f02-rollup');
    const context = at(15);

    // All six events are at 2024-05-01T09:00–09:05Z = 18:00–18:05 local (Asia/Tokyo).
    const timeline = fixture.analytics.modelMixTimeline(context, 'day');
    expect(timeline.buckets).toEqual(['2024-05-01']);
    // 4 assistant events carrying a model (the two `user` records carry none).
    expect(timeline.series.map((series) => [series.model, series.data])).toEqual([
      ['claude-test-1', [4]],
    ]);
    // §3.3 — the hue is `FNV1a32(name) mod 8`, the same pure function ingest used.
    expect(timeline.series[0]?.colorIndex).toBe(colorIndexFor('claude-test-1'));

    // `output_only` is M-02 per bucket: 243. `all` is all four classes: 128+243+14+1503 = 1_888.
    expect(fixture.analytics.tokensByModel(context, 'day', 'output_only').series[0]?.data).toEqual([
      243,
    ]);
    expect(fixture.analytics.tokensByModel(context, 'day', 'all').series[0]?.data).toEqual([1_888]);

    // Week bucket: 2024-05-01 is a Wednesday; the week starts Monday 2024-04-29.
    expect(fixture.analytics.tokensByModel(context, 'week', 'output_only').buckets).toEqual([
      '2024-04-29',
    ]);

    // M-11 messages on the calendar: 6 records, all with role assistant|user → 6.
    expect(fixture.analytics.activityCalendar(context, 26).days).toEqual([
      { day: '2024-05-01', messages: 6 },
    ]);

    // Rhythm: 2024-05-01 is a Wednesday → `%w` = 3; local hour 18.
    expect(fixture.analytics.rhythmHeatmap(context).cells).toEqual([
      { weekday: 3, hour: 18, events: 6 },
    ]);
    // ⚠️ Not `toEqual([...])` alone. `expect([]).toEqual([])` passes, and so does every assertion
    // of the form "cells is an array" — a `q:rhythmHeatmap` that silently returned zero rows over
    // a populated `events` table would sail through both, and the §6.5 card would render its axes
    // over an invisible grid. Non-emptiness is asserted as its own fact (CLAUDE.md §1).
    expect(fixture.analytics.rhythmHeatmap(context).cells.length).toBeGreaterThan(0);

    // M-18 — cacheRead / (cacheRead + input) = 1_503 / (1_503 + 128) = 1_503 / 1_631.
    const cache = fixture.analytics.cacheEfficiency(context);
    expect(cache.hitRatio).toBeCloseTo(1_503 / 1_631, 12);
    expect(cache).toMatchObject({
      cacheReadTokens: 1_503,
      inputTokens: 128,
      cacheWriteTokens: 14,
      outputTokens: 243,
    });
  });

  it('⚠️ q:rhythmHeatmap is populated over two weekdays and two hours, unbounded filter', async () => {
    // ⚠️ REGRESSION (§6.5). The Rhythm card shipped rendering its axes over an empty grid, and the
    // single-cell assertion above could not have distinguished "one cell" from "no cells" in a
    // grouping that had collapsed: one row is what a query returns when it is *nearly* broken as
    // well as when it is right. So the cell set is pinned over a fixture that straddles a local
    // midnight — two distinct `%w` values AND two distinct `%H` values — and the whole grouping is
    // reconciled against `COUNT(*)`, which is the invariant that makes "zero rows over a non-empty
    // `events` table" impossible to pass rather than merely unlikely.
    //
    // ⚠️ The filter is `ALL` — `{ projectIds: null, from: null, to: null }` — stated explicitly,
    // because it is what the app boots with (§4.2) and therefore the one case a silently
    // over-restrictive `scopeClause` would empty on first paint.
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f11-midnight');
    expect(ALL).toEqual({ projectIds: null, from: null, to: null });

    // ── Hand-computed expected values (TZ = Asia/Tokyo, UTC+9, no DST) ───────────────────
    //   14:20Z main      → 2024-05-01 23:20 local · Wed → %w = 3 · %H = 23
    //   14:35Z SUBAGENT  → 2024-05-01 23:35 local · Wed → %w = 3 · %H = 23   (rolls up, INV-02)
    //   14:50Z main      → 2024-05-01 23:50 local · Wed → %w = 3 · %H = 23
    //   15:10Z main      → 2024-05-02 00:10 local · Thu → %w = 4 · %H =  0
    //   15:20Z main      → 2024-05-02 00:20 local · Thu → %w = 4 · %H =  0
    // → (3,23) = 3 events ; (4,0) = 2 events ; 5 events total.
    const cells = fixture.analytics.rhythmHeatmap(at(15, ALL)).cells;
    expect(cells).toEqual([
      { weekday: 3, hour: 23, events: 3 },
      { weekday: 4, hour: 0, events: 2 },
    ]);
    expect(cells.length).toBeGreaterThan(0);
    expect(new Set(cells.map((cell) => cell.weekday)).size).toBe(2);
    expect(new Set(cells.map((cell) => cell.hour)).size).toBe(2);

    // ⚠️ The reconciliation. Every row of `events` lands in exactly one cell — the query filters
    // no origin and no `is_synthetic`, by design (§6.5: a rhythm cell is a moment, not a token
    // statistic) — so the cell sum IS `COUNT(*)`. An empty result over a populated table fails
    // here as `0 !== 5` rather than passing as "an array of cells".
    const events = fixture.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM events').get()?.n;
    expect(events).toBe(5);
    expect(cells.reduce((total, cell) => total + cell.events, 0)).toBe(events);

    // …and the scope clause is exercised, not merely bypassed: `from` = local midnight
    // 2024-05-02 (= 15:00Z) is half-open and inclusive, so only the Thursday cell survives.
    expect(
      fixture.analytics.rhythmHeatmap(
        at(15, {
          projectIds: null,
          from: Date.parse('2024-05-01T15:00:00.000Z'),
          to: null,
        }),
      ).cells,
    ).toEqual([{ weekday: 4, hour: 0, events: 2 }]);
  });

  it('sessions, drill-down and histogram', async () => {
    const fixture = await loadFixture(sandbox, 'f02-rollup');
    priceEverything(fixture, 'claude-test-1');
    const context = at(15);

    const page = fixture.analytics.sessions(context, { limit: 10 }, 'firstTs', 'asc');
    expect(page.page.totalKnown).toBe(1);
    expect(page.page.nextCursor).toBeNull();
    const row = page.page.rows[0];
    // Session stream 09:00 → 09:05, all gaps 1m: active = 5m = 300 s; M-09 span = 300 s.
    expect(row).toMatchObject({
      id: 'sess-f02',
      activeSeconds: 300,
      spanSeconds: 300,
      messages: 6,
      toolCalls: 4,
      subagentRuns: 1,
      costNanoUsd: 1_888_000,
      isPartial: false,
      primaryModel: 'claude-test-1',
    });
    expect(row?.tokens).toEqual({
      input: 128,
      output: 243,
      cacheWrite: 14,
      cacheWrite1h: 0,
      cacheRead: 1_503,
    });

    const detail = fixture.analytics.sessionDetail('sess-f02', 15);
    expect(detail?.originSplit.main.output).toBe(211);
    expect(detail?.originSplit.subagent.output).toBe(32);
    expect(detail?.toolCounts).toEqual([
      { toolName: 'Read', count: 2 },
      { toolName: 'Agent', count: 1 },
      { toolName: 'Grep', count: 1 },
    ]);
    expect(detail?.subagentRuns).toHaveLength(1);
    expect(detail?.subagentRuns[0]?.linked).toBe(true);
    expect(detail?.subagentRuns[0]?.tokens.output).toBe(32);
    // INV-10 on the drill-down, scoped to THIS session's rows.
    expect(detail?.uncosted).toEqual({ records: 0, byModel: [] });

    // The histogram is a fixed, closed axis; 300 s falls in `<15m`.
    const histogram = fixture.analytics.sessionHistogram(context);
    expect(histogram.buckets.map((bucket) => bucket.label)).toEqual([
      '<15m',
      '15–30m',
      '30–60m',
      '1–2h',
      '2–4h',
      '4–8h',
      '8h+',
    ]);
    expect(histogram.buckets[0]).toEqual({
      label: '<15m',
      lowerSeconds: 0,
      upperSeconds: 900,
      count: 1,
    });
    expect(histogram.buckets.reduce((total, bucket) => total + bucket.count, 0)).toBe(1);
  });

  it('tools, projects, files and graphs', async () => {
    const fixture = await loadFixture(sandbox, 'f02-rollup');
    const context = at(15);

    expect(fixture.analytics.toolFingerprint(context)).toMatchObject({
      total: 4,
      distinct: 3,
    });
    expect(
      fixture.analytics.toolFingerprint(context).rows.map((row) => [row.toolName, row.count]),
    ).toEqual([
      ['Read', 2],
      ['Agent', 1],
      ['Grep', 1],
    ]);

    expect(fixture.analytics.toolMixByProject(context, 2).projects[0]?.parts).toEqual([
      { toolName: 'Read', count: 2, colorIndex: colorIndexFor('Read') },
      { toolName: 'Agent', count: 1, colorIndex: colorIndexFor('Agent') },
    ]);

    expect(fixture.analytics.originSplit(context).unlinkedRuns).toBe(0);

    const cards = fixture.analytics.projectCards(context);
    expect(cards.rows[0]).toMatchObject({
      encodedName: '-work-demo-alpha',
      displayName: 'alpha',
      sessions: 1,
      outputTokens: 243,
      toolCalls: 4,
      activeSeconds: 300,
    });
    expect(cards.rows[0]?.editSparkline).toHaveLength(12);

    // No write-class tool call in this fixture, so M-15 has nothing to report — an empty page,
    // not a row of zeroes (§6.8's "no file edits recorded in this range").
    expect(fixture.analytics.fileMetrics(context, { limit: 10 }).rows).toEqual([]);

    // Tool transitions within the session, ordered by (ts, ordinal):
    //   Agent → Read (m1's two calls) · Read → Grep (m1 ordinal 1 → s1) · Grep → Read (s1 → s3)
    expect(
      fixture.analytics
        .toolTransition(context)
        .edges.map((edge) => [edge.source, edge.target, edge.observed]),
    ).toEqual([
      ['tool:Agent', 'tool:Read', 1],
      ['tool:Grep', 'tool:Read', 1],
      ['tool:Read', 'tool:Grep', 1],
    ]);

    // Sankey conserves: both stages sum to the same output-token total (M-02 = 243).
    const sankey = fixture.analytics.flowSankey(context);
    const sum = (prefix: string): number =>
      sankey.links
        .filter((link) => link.source.startsWith(prefix))
        .reduce((t, l) => t + l.value, 0);
    expect(sum('project:')).toBe(243);
    expect(sum('model:')).toBe(243);

    const trace = fixture.analytics.executionTrace('sess-f02');
    expect(trace.unlinkedRuns).toBe(0);
    expect(trace.timeline.filter((span) => span.kind === 'main')).toHaveLength(1);
    expect(trace.timeline.filter((span) => span.kind === 'subagent')).toHaveLength(1);
    expect(trace.timeline.filter((span) => span.kind === 'tool')).toHaveLength(4);

    // The four ⛔ Harness Manager channels answer honestly before E10's scanner has run.
    expect(fixture.analytics.harnessGraph()).toEqual({ nodes: [], edges: [] });
    expect(fixture.analytics.plugins()).toEqual({ marketplaces: [], plugins: [] });
    expect(fixture.analytics.memories().rows).toEqual([]);
    expect(fixture.analytics.claudeMdFiles('.claude-lens-backups/').rows).toEqual([]);
  });

  it('discloses everything §4.6 names, from real data', async () => {
    const fixture = await loadFixture(sandbox, 'f02-rollup');
    const context = at(15);
    const disclosures = fixture.analytics.disclosures(context, { filesMissingSinceLastSync: 2 });
    expect(disclosures).toEqual({
      uncosted: {
        records: 4,
        byModel: [
          {
            model: 'claude-test-1',
            records: 4,
            fromTs: Date.parse('2024-05-01T09:01:00.000Z'),
            toTs: Date.parse('2024-05-01T09:05:00.000Z'),
          },
        ],
      },
      badLines: 0,
      syntheticEvents: 0,
      unlinkedSubagentRuns: 0,
      partialBefore: null,
      filesMissingSinceLastSync: 2,
      activeOverlapSeconds: 0,
      // A-05 — this fixture is parsed by THIS build, so every event carries a real split and
      // `tok_cache_write_1h` is never NULL. The zeros are what "nothing to disclose" looks like;
      // the non-zero cases are pinned by `a05-cache-split-disclosure.test.ts`.
      cacheSplitUnknownEvents: 0,
      cacheSplitArchivedEvents: 0,
      cacheSplitMismatches: 0,
      // ADR-041 — no file has vanished in this fixture, so nothing is retained-orphan.
      retainedOrphanSessions: 0,
      retainedOrphanEvents: 0,
      // Migration 0011 — ⚠️ hand-checked, and the pair is the point. `f02-rollup` is parsed by
      // THIS build into a database created at schema 11, so its `file_manifest` watermark is 0
      // and every usable record is examined: 4 costable events (§5.9 M-01 minus the zero-token
      // ones) → `checkedRecords: 4`. `records: 0` therefore means "checked all four, none shares
      // an API call", NOT "not measured" — which is exactly the distinction the count exists to
      // make, and which `checkedRecords: 4` beside it is what proves.
      repeatedApiCalls: {
        records: 0,
        checkedRecords: 4,
        uncheckedRecords: 0,
        uncheckableRecords: 0,
      },
    });

    // `q:uncosted` is the same summary, from the same query.
    expect(fixture.analytics.uncosted(context)).toEqual(disclosures.uncosted);

    // M-16 coverage: transcripts only, no `history.jsonl` in this fixture ⇒ `partialBefore` null.
    expect(fixture.analytics.coverage()).toEqual({
      transcriptsFrom: Date.parse('2024-05-01T09:00:00.000Z'),
      transcriptsTo: Date.parse('2024-05-01T09:05:00.000Z'),
      promptsFrom: null,
      promptsTo: null,
      partialBefore: null,
      statsCacheDays: 0,
    });
  });

  it('pages rather than returning everything (P-27/P-28, §4.2)', async () => {
    const fixture = await loadFixture(sandbox, 'f13-overlap');
    const context = at(15);

    // Three projects × one local day = three working-day rows; ask for one at a time.
    const first = fixture.analytics.workingDays(context, { limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.totalKnown).toBe(3);
    expect(first.nextCursor).not.toBeNull();

    const second = fixture.analytics.workingDays(context, {
      limit: 1,
      cursor: first.nextCursor ?? '',
    });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.projectId).not.toBe(first.rows[0]?.projectId);

    // INV-21 is over EVERY row the channel returns, not just the first page.
    const all = fixture.analytics.workingDays(context, { limit: 500 });
    expect(fixture.analytics.overviewTiles(context).activeSeconds).toBe(
      all.rows.reduce((total, row) => total + row.activeSeconds, 0),
    );

    // `q:sessions` pages by KEYSET in SQL, not in memory: the cursor carries `(sortKey, id)`.
    const twoSessions = await loadFixture(sandbox, 'f12-two-sessions');
    const sortedContext = at(15);
    const pageOne = twoSessions.analytics.sessions(
      sortedContext,
      { limit: 1 },
      'activeSeconds',
      'desc',
    );
    expect(pageOne.page.rows.map((row) => row.activeSeconds)).toEqual([1_800]); // S1, 09:00→09:30
    expect(pageOne.page.totalKnown).toBe(2);
    expect(pageOne.page.nextCursor).not.toBeNull();
    const pageTwo = twoSessions.analytics.sessions(
      sortedContext,
      { limit: 1, cursor: pageOne.page.nextCursor ?? '' },
      'activeSeconds',
      'desc',
    );
    expect(pageTwo.page.rows.map((row) => row.activeSeconds)).toEqual([1_200]); // S2, 10:00→10:20
    expect(pageTwo.page.nextCursor).toBeNull();

    // §4.2 — `limit > 500` is rejected with `E_INVALID_SETTING`, not silently clamped.
    expect(() => fixture.analytics.workingDays(context, { limit: 501 })).toThrow(
      /between 1 and 500/,
    );
    // A cursor the server did not issue is rejected, not treated as "start from the beginning".
    expect(() =>
      fixture.analytics.workingDays(context, { limit: 10, cursor: 'not-a-cursor' }),
    ).toThrow(/opaque/);
  });

  it('an explicitly empty project selection selects nothing, not everything', async () => {
    const fixture = await loadFixture(sandbox, 'f13-overlap');
    // ⚠️ §4.2: `null` means all projects; `[]` means none. Widening `[]` to "all" is how a scoped
    // number silently becomes a global one.
    const none = at(15, { projectIds: [], from: null, to: null });
    expect(fixture.analytics.overviewTiles(none).activeSeconds).toBe(0);
    expect(fixture.analytics.overviewTiles(none).outputTokens).toBe(0);
    expect(fixture.analytics.overviewTiles(at(15, ALL)).activeSeconds).toBe(3_600);
  });
});
