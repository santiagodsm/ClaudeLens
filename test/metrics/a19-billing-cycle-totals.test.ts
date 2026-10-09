// A-19 (PROGRESS.md amendment log) — **per-billing-cycle totals** (§4.5 `q:billingCycleTotals`).
//
// The card this feeds compares one billing cycle against the next, so every number in a row has
// to be the SAME number the rest of the app reports for that same window — otherwise picking a
// cycle at the top of the app and reading the card beside it shows two answers to one question,
// which is CLAUDE.md §1's worst outcome wearing a comparison's clothes. This fixture pins that
// directly: each row is hand-computed here, AND each row is checked against the existing
// unbounded-scope queries restricted to the same window.
//
// ⚠️ `TZ = America/New_York`, pinned, because the whole point is local calendar boundaries
// (ADR-021) and because it has a daylight-saving rule — one of the fixture's cycles straddles the
// 8 March 2026 spring-forward, which is precisely where "add 24 h" and "the next local midnight"
// disagree. Every expected value below is inline and hand-computed with the arithmetic in a
// comment; `toMatchSnapshot()` is banned under `test/metrics/**`.
//
// ── The fixture, in LOCAL time, anchor day 15 ────────────────────────────────────────────────
//
//   cycle '2026-01'  [15 Jan – 14 Feb]   sess-a19-a  20 Jan 10:00 EST  in 5 out 10 read 100
//                                                    20 Jan 10:20 EST  in 7 out 20
//   cycle '2026-02'  [15 Feb – 14 Mar]   sess-a19-b  15 Feb 00:00 EST  in 1 out 1   ← EXACTLY on
//                                                                                     the boundary
//                                        sess-a19-c   8 Mar 01:30 EST  out 2        ← before DST
//                                                     8 Mar 03:30 EDT  out 3        ← after DST
//   cycle '2026-03'  [15 Mar – 14 Apr]   sess-a19-d  20 Mar 10:00 EDT  in 50 out 100 read 1000
//                                                    20 Mar 10:10 EDT  in 60 out 200
//                                        sess-a19-f  25 Mar 10:00 EDT  out 7        ← unpriced
//                                                                                     model, in a
//                                                                                     cycle whose
//                                                                                     other records
//                                                                                     ARE priced
//   cycle '2026-04'  [15 Apr – 14 May]   — nothing happened —
//   cycle '2026-05'  [15 May – 14 Jun]   sess-a19-e  20 May 10:00 EDT  in 3 out 5   ← unpriced
//                                                    20 May 10:05 EDT  in 4 out 6      model
//   cycle '2026-06'  [15 Jun – 14 Jul]   — nothing happened, and it is the one `now` is inside —
//
// ⚠️ March is the case that matters most on screen and the one the fixture originally lacked: a
// cycle that is PARTIALLY priced, so its row carries a real `$` **and** a disclosure saying the
// figure excludes records. A fixture in which every cycle is all-priced or all-unpriced would let
// a row that dropped its own disclosure pass unnoticed, which is a `$` that looks complete and is
// not (INV-10, CLAUDE.md §1).
//
// ⚠️ 25 March is deliberately a day of its own. Active time partitions by (local day, project), so
// a record added to 20 March would have opened a gap and changed March's hand-computed seconds;
// alone on its own day it contributes 0 s, and the active-time expectations below are untouched.

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { isDbError } from '../../src/main/db/errors';
import { billingCycleKey } from '../../src/shared/billing-cycle';
import type { BillingCycleRow } from '../../src/shared/ipc-contract';
import { at, loadFixture, type MetricsFixture } from './support/metrics-harness';
import { DST_TZ, assertDstTimezonePinned, usePinnedTimezone } from './support/pinned-tz';

/** `$1.00 / Mtok` on every class = 1_000_000 picoUSD per token (ADR-023). */
const ONE_USD_PER_MTOK_PICO = 1_000_000;

/** The billing day the fixture is written around, and the app's own default (§3.13). */
const ANCHOR = 15;

/**
 * 20 Jun 2026, 12:00 local (EDT, UTC-4) → 16:00Z. Inside `[15 Jun, 15 Jul)`, five days in.
 * ⚠️ Passed explicitly: nothing in this build reads a clock it was not handed (ADR-021).
 */
const NOW = Date.UTC(2026, 5, 20, 16);

function priceTheKnownModel(fixture: MetricsFixture): void {
  const insert = fixture.db.prepare(
    `INSERT INTO price_rows (model, token_class, rate_picousd_per_token, valid_from, valid_to,
       source, created_at, updated_at)
     VALUES (?, ?, ?, 0, NULL, 'manual', 0, 0)`,
  );
  for (const tokenClass of ['input', 'output', 'cache_write', 'cache_write_1h', 'cache_read']) {
    insert.run('claude-test-1', tokenClass, ONE_USD_PER_MTOK_PICO);
  }
  // ⚠️ `claude-unpriced-1` is deliberately given NO rows: the May cycle exists to prove that a
  // cycle whose every record is unpriced reports `null`, not `0` (INV-09, §6.4).
}

describe('A-19 — one row per billing cycle, over real parsed data', () => {
  const sandbox = useSandbox();
  usePinnedTimezone(DST_TZ);

  it('buckets every record into the right cycle, in local time', async () => {
    assertDstTimezonePinned();
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    priceTheKnownModel(fixture);

    const totals = fixture.analytics.billingCycleTotals(at(15), ANCHOR, NOW);

    expect(totals.anchorDay).toBe(ANCHOR);
    expect(totals.truncated).toBe(0);

    // Six cycles, newest first: the first record is 20 Jan 2026 and `now` is 20 Jun 2026, so the
    // list runs [15 Jun, 15 Jul) back to [15 Jan, 15 Feb) inclusive — six windows.
    expect(totals.cycles).toHaveLength(6);
    expect(totals.cycles.map((row) => billingCycleKey(row))).toEqual([
      '2026-06',
      '2026-05',
      '2026-04',
      '2026-03',
      '2026-02',
      '2026-01',
    ]);

    // The partition property, on the payload the renderer receives: no gap, no overlap. The
    // Feb→Mar pair crosses the daylight-saving change and still meets exactly.
    for (let index = 0; index + 1 < totals.cycles.length; index += 1) {
      expect(totals.cycles[index]?.from).toBe(totals.cycles[index + 1]?.to);
    }
    expect(totals.cycles[5]?.from).toBe(Date.UTC(2026, 0, 15, 5)); // 15 Jan 00:00 EST
    expect(totals.cycles[4]?.from).toBe(Date.UTC(2026, 1, 15, 5)); // 15 Feb 00:00 EST
    expect(totals.cycles[3]?.from).toBe(Date.UTC(2026, 2, 15, 4)); // 15 Mar 00:00 EDT — an hour
    //                                                                over from January's offset
  });

  it('puts a record exactly on a boundary in the NEWER cycle', async () => {
    assertDstTimezonePinned();
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    priceTheKnownModel(fixture);
    const rows = byKey(fixture.analytics.billingCycleTotals(at(15), ANCHOR, NOW).cycles);

    // `a19-b1` is at 2026-02-15T05:00:00Z = 15 Feb 2026 00:00:00.000 EST — the first instant of
    // the February cycle. §4.2's window is inclusive at `from`, so it belongs to February.
    //
    // February's totals: b1 (in 1, out 1) + c1 (out 2) + c2 (out 3)
    //   input  = 1                    output = 1 + 2 + 3 = 6
    //   tokens = 2 + 2 + 3 = 7  →  7 × 1_000_000 picoUSD = 7_000_000 picoUSD = 7_000 nanoUSD
    expect(rows.get('2026-02')).toMatchObject({
      inputTokens: 1,
      outputTokens: 6,
      costNanoUsd: 7_000,
    });

    // ⚠️ And January must NOT contain it. January is a19-a1 + a19-a2 alone:
    //   input  = 5 + 7 = 12          output = 10 + 20 = 30      cache read = 100
    //   tokens = (5 + 10 + 100) + (7 + 20) = 115 + 27 = 142
    //   cost   = 142 × 1_000_000 picoUSD = 142_000_000 picoUSD = 142_000 nanoUSD ($0.000142)
    expect(rows.get('2026-01')).toMatchObject({
      inputTokens: 12,
      outputTokens: 30,
      cacheReadTokens: 100,
      costNanoUsd: 142_000,
      sessions: 1,
    });
    // Had the boundary been read as exclusive at `from`, January would carry b1's 2 tokens too.
    expect(rows.get('2026-01')?.costNanoUsd).not.toBe(144_000);
  });

  it('reports a cycle whose every record is unpriced as NO dollar figure, never $0.00', async () => {
    assertDstTimezonePinned();
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    priceTheKnownModel(fixture);
    const totals = fixture.analytics.billingCycleTotals(at(15), ANCHOR, NOW);
    const rows = byKey(totals.cycles);

    // May holds two records from `claude-unpriced-1`, for which no price row exists. INV-09 makes
    // the WHOLE record uncosted, so the cycle has nothing costed at all.
    //   ⚠️ `costNanoUsd` is `null` — not `0`. §6.4: "it never shows `$0.00`".
    //   The tokens are still real and still counted (M-02 does not depend on pricing):
    //   input = 3 + 4 = 7 ; output = 5 + 6 = 11.
    expect(rows.get('2026-05')).toMatchObject({
      costNanoUsd: null,
      uncostedRecords: 2,
      inputTokens: 7,
      outputTokens: 11,
      sessions: 1,
    });
    expect(rows.get('2026-05')?.costNanoUsd).not.toBe(0);

    // INV-10 — the envelope carries the disclosure that names WHICH model, and its record count
    // is the sum of the per-cycle counts when nothing was truncated. Three records have no price:
    // May's two, and the one in March.
    expect(totals.uncosted.records).toBe(3);
    expect(totals.uncosted.byModel.map((row) => row.model)).toEqual(['claude-unpriced-1']);
    expect(totals.cycles.reduce((sum, row) => sum + row.uncostedRecords, 0)).toBe(
      totals.uncosted.records,
    );
    // …and nothing was left out of the list, so there is nothing for the excluded totals to hold.
    expect(totals.excluded).toEqual({
      cycles: 0,
      records: 0,
      costNanoUsd: null,
      uncostedRecords: 0,
      outputTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      activeSeconds: 0,
    });
  });

  it('reports a PARTIALLY priced cycle as a real figure that says what it leaves out', async () => {
    assertDstTimezonePinned();
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    priceTheKnownModel(fixture);
    const totals = fixture.analytics.billingCycleTotals(at(15), ANCHOR, NOW);
    const march = byKey(totals.cycles).get('2026-03');

    // ⚠️ **The state that matters most on screen**: a `$` that is real AND incomplete. March holds
    // d1 + d2 on the priced model and f1 on the unpriced one, so the figure covers two records
    // out of three and the row has to carry the count of the third with it (INV-10, §6.4) —
    // otherwise the card shows a confident dollar amount for a cycle it only partly measured.
    //   costed tokens = (50 + 100 + 1000) + (60 + 200) = 1150 + 260 = 1410
    //   cost          = 1410 × 1_000_000 picoUSD = 1_410_000_000 picoUSD = 1_410_000 nanoUSD
    //   ⚠️ f1's 7 output tokens ARE counted — M-02 does not depend on pricing — so the tokens
    //     and the money in this row deliberately describe different populations, which is exactly
    //     what `uncostedRecords` is on the row to explain.
    expect(march).toMatchObject({
      costNanoUsd: 1_410_000,
      uncostedRecords: 1,
      outputTokens: 307, // 100 + 200 + 7
      inputTokens: 110, //  50 + 60
      cacheReadTokens: 1000,
      sessions: 2,
    });

    // Neither of the two degenerate readings: not `null` (something WAS priced), and not a figure
    // that quietly includes the unpriced record's tokens at some rate (INV-09 is all-or-nothing
    // per record, so f1 contributes nothing at all to the money).
    expect(march?.costNanoUsd).not.toBeNull();
    expect(march?.costNanoUsd).not.toBe(1_417_000);

    // …and the same window read through the Overview tiles agrees on both halves at once.
    const tiles = fixture.analytics.overviewTiles(
      at(15, { projectIds: null, from: march?.from ?? 0, to: march?.to ?? 0 }),
    );
    expect(tiles.costNanoUsd).toBe(1_410_000);
    expect(tiles.uncosted.records).toBe(1);
  });

  it('keeps a cycle in which nothing happened, with measured zeros and no dollar figure', async () => {
    assertDstTimezonePinned();
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    priceTheKnownModel(fixture);
    const rows = byKey(fixture.analytics.billingCycleTotals(at(15), ANCHOR, NOW).cycles);

    // April holds nothing. It is PRESENT, because dropping it would put March next to May on a
    // chart of consecutive cycles and silently close the gap the user is looking for.
    //   Every count is a measured zero — the query examined the cycle and found nothing — while
    //   the money is `null`, because "no records could be costed" is what null means here.
    expect(rows.get('2026-04')).toMatchObject({
      costNanoUsd: null,
      uncostedRecords: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      sessions: 0,
      activeSeconds: 0,
      inProgress: false,
    });
    // ⚠️ An empty cycle and an all-unpriced cycle are told apart by the fields, not by the money:
    // both report no `$`, and only one of them has tokens and uncosted records.
    expect(rows.get('2026-04')?.outputTokens).toBe(0);
    expect(rows.get('2026-05')?.outputTokens).toBe(11);
  });

  it('marks the cycle the clock is inside, and says how far through it is', async () => {
    assertDstTimezonePinned();
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    priceTheKnownModel(fixture);
    const rows = byKey(fixture.analytics.billingCycleTotals(at(15), ANCHOR, NOW).cycles);

    // `now` is 20 Jun 2026 12:00 EDT, inside [15 Jun, 15 Jul). 15 Jun is day 1, so the 20th is
    // day 6 of the 30 calendar days from 15 June to 14 July inclusive.
    expect(rows.get('2026-06')).toMatchObject({
      inProgress: true,
      elapsedDays: 6,
      totalDays: 30,
    });
    // Every other cycle is finished, and a finished cycle has lived all of its days.
    for (const [key, row] of rows) {
      if (key === '2026-06') continue;
      expect(row.inProgress).toBe(false);
      expect(row.elapsedDays).toBe(row.totalDays);
    }
    // The February cycle is 28 calendar days (15 Feb – 14 Mar) even though it spans the
    // spring-forward and is therefore 27 days and 23 hours of elapsed UTC.
    expect(rows.get('2026-02')?.totalDays).toBe(28);
    expect((rows.get('2026-02')?.to ?? 0) - (rows.get('2026-02')?.from ?? 0)).toBe(2_415_600_000);
  });

  it('reports M-07 binding (C) per cycle — the same reading, restricted', async () => {
    assertDstTimezonePinned();
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    priceTheKnownModel(fixture);
    const rows = byKey(fixture.analytics.billingCycleTotals(at(15), ANCHOR, NOW).cycles);

    // ── Hand-computed active time, idle threshold 15 min ────────────────────────────────────
    // January, working day 2026-01-20: 10:00 → 10:20 is a 20-minute gap, CAPPED at 15 minutes.
    //   0 + 900 s = 900 s.
    expect(rows.get('2026-01')?.activeSeconds).toBe(900);
    // February holds two working days:
    //   2026-02-15 — one event, so 0 s (the first event of a partition contributes 0).
    //   2026-03-08 — 01:30 EST then 03:30 EDT. ⚠️ Two hours by the wall clock, ONE hour of real
    //     elapsed time, because the clocks moved forward at 02:00. Either way the gap exceeds the
    //     threshold and is capped: 0 + 900 s = 900 s.
    //   Binding (C) = 0 + 900 = 900 s.
    expect(rows.get('2026-02')?.activeSeconds).toBe(900);
    // March, working day 2026-03-20: 10:00 → 10:10 is 10 minutes, under the cap. 600 s.
    expect(rows.get('2026-03')?.activeSeconds).toBe(600);
    // May, working day 2026-05-20: 10:00 → 10:05 = 300 s. ⚠️ Unpriced records still have active
    // time — active time is about moments, not money (ADR-035).
    expect(rows.get('2026-05')?.activeSeconds).toBe(300);

    // ⚠️ **The assertion that matters most**: each cycle's number is binding (C) over that cycle's
    // own window, computed by the repository the rest of the app uses, not by a second formula.
    for (const row of rows.values()) {
      expect(row.activeSeconds).toBe(
        fixture.active.bindingCSeconds(at(15, { projectIds: null, from: row.from, to: row.to })),
      );
    }
  });

  it('agrees, cycle by cycle, with the Overview tiles for the same window', async () => {
    assertDstTimezonePinned();
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    priceTheKnownModel(fixture);
    const totals = fixture.analytics.billingCycleTotals(at(15), ANCHOR, NOW);

    // ⚠️ This is the invariant the whole feature rests on. Choosing a cycle at the top of the app
    // sets the global filter to `[from, to)` and every screen re-queries; the card's row for that
    // same cycle must be the same numbers. Two answers to one question is the defect this
    // project exists to prevent (CLAUDE.md §1), so it is asserted rather than argued.
    for (const row of totals.cycles) {
      const tiles = fixture.analytics.overviewTiles(
        at(15, { projectIds: null, from: row.from, to: row.to }),
      );
      expect(row.costNanoUsd).toBe(tiles.costNanoUsd);
      expect(row.outputTokens).toBe(tiles.outputTokens);
      expect(row.cacheReadTokens).toBe(tiles.cacheReadTokens);
      expect(row.sessions).toBe(tiles.sessions);
      expect(row.activeSeconds).toBe(tiles.activeSeconds);
      expect(row.uncostedRecords).toBe(tiles.uncosted.records);
    }

    // …and the cycles account for the whole dataset: the costed totals add up to the all-time
    // figure. 142_000 + 7_000 + 1_410_000 = 1_559_000 nanoUSD ($0.001559).
    //   March: (50 + 100 + 1000) + (60 + 200) = 1150 + 260 = 1410 tokens → 1_410_000 nanoUSD.
    //
    // ⚠️⚠️ **This equality is a fact about THIS fixture, not a general invariant, and a future
    // failure of it must not be read as a costing bug.** Money is summed in picoUSD and converted
    // once per figure (§3.11, ADR-023), and `picoToNanoUsd` rounds half-up — so converting each
    // cycle and adding is not in general the same as adding and converting once. The residue is
    // at most ±0.5 nanoUSD per cycle, i.e. ±0.0000000005 USD, and it is NOT a defect to be
    // "fixed": rounding a rate or carrying a fraction across the wire would be worse.
    // It holds exactly here because every rate in this fixture is 1_000_000 picoUSD/token, so
    // every cycle's picoUSD total is an exact multiple of 1000 and no conversion rounds at all.
    // A fixture with an odd rate would need a tolerance here instead.
    const summed = totals.cycles.reduce((sum, row) => sum + (row.costNanoUsd ?? 0), 0);
    expect(summed).toBe(1_559_000);
    expect(summed).toBe(fixture.analytics.overviewTiles(at(15)).costNanoUsd);
  });

  it('honours the project selection and ignores nothing else — there is nothing else to ignore', async () => {
    assertDstTimezonePinned();
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    priceTheKnownModel(fixture);

    // An empty project selection selects NOTHING (never "all projects", `scope.ts`), so there is
    // no first record and therefore no cycle to report. ⚠️ Not "every cycle with zeros": the app
    // has no data in scope at all, and inventing a calendar for it would be a promise the data
    // cannot keep.
    const none = fixture.analytics.billingCycleTotals(
      at(15, { projectIds: [], from: null, to: null }),
      ANCHOR,
      NOW,
    );
    expect(none.cycles).toEqual([]);
    expect(none.truncated).toBe(0);

    // Naming the fixture's one project reproduces the unfiltered answer exactly.
    const scoped = fixture.analytics.billingCycleTotals(
      at(15, { projectIds: [fixture.projectId('-work-demo-alpha')], from: null, to: null }),
      ANCHOR,
      NOW,
    );
    expect(scoped.cycles).toEqual(fixture.analytics.billingCycleTotals(at(15), ANCHOR, NOW).cycles);
  });

  it('moves every boundary when the anchor day moves — 1 and 28', async () => {
    assertDstTimezonePinned();
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    priceTheKnownModel(fixture);

    // ── Anchor 1: a cycle IS a calendar month. The 15 Feb record now opens no cycle; it sits in
    // the middle of February, and the 8 March pair sits in March instead of with it.
    //   '2026-02' = b1 alone                 → input 1, output 1, tokens 2  → 2_000 nanoUSD
    //   '2026-03' = c1 + c2 + d1 + d2 + f1   → output 2 + 3 + 100 + 200 + 7 = 312
    //                                          f1 is unpriced, so the money counts the other four:
    //                                          tokens 2 + 3 + 1150 + 260 = 1415 → 1_415_000 nanoUSD
    const first = byKey(fixture.analytics.billingCycleTotals(at(15), 1, NOW).cycles);
    expect(first.get('2026-02')).toMatchObject({ outputTokens: 1, costNanoUsd: 2_000 });
    expect(first.get('2026-03')).toMatchObject({
      outputTokens: 312,
      costNanoUsd: 1_415_000,
      uncostedRecords: 1,
    });
    // January is unchanged — both records are on the 20th, which is inside January either way.
    expect(first.get('2026-01')?.costNanoUsd).toBe(142_000);
    // The cycle containing `now` (20 Jun) is [1 Jun, 1 Jul): 30 days, and the 20th is day 20.
    expect(first.get('2026-06')).toMatchObject({
      inProgress: true,
      elapsedDays: 20,
      totalDays: 30,
    });

    // ── Anchor 28: the 20 Jan records fall in the cycle that opened 28 Dec 2025, and the whole
    // calendar shifts back by one key. '2025-12' = a19-a1 + a19-a2 = 142_000 nanoUSD.
    const last = byKey(fixture.analytics.billingCycleTotals(at(15), 28, NOW).cycles);
    expect(last.get('2025-12')).toMatchObject({ outputTokens: 30, costNanoUsd: 142_000 });
    // 15 Feb falls in [28 Jan, 28 Feb) — keyed '2026-01', the month that cycle OPENS in, which is
    // the January key even though every record in it is February's. That is the key rule doing its
    // job, and it is why the label names real dates rather than a month name (§1a).
    expect(last.get('2026-01')).toMatchObject({ outputTokens: 1, costNanoUsd: 2_000 });
    // [28 Feb, 28 Mar) swallows the 8 March pair, the 20 March pair and the 25 March record,
    // because all of them are before the 28th:
    //   output = 2 + 3 + 100 + 200 + 7 = 312
    //   tokens = 2 + 3 + 1150 + 260 = 1415 (f1 unpriced) → 1_415_000 nanoUSD
    expect(last.get('2026-02')).toMatchObject({ outputTokens: 312, costNanoUsd: 1_415_000 });
    // ⚠️ February's cycle under anchor 28 is [28 Feb, 28 Mar) — 28 days, because every month has
    // a 28th. This is the fact that caps the setting at 28 rather than 31.
    expect(last.get('2026-02')?.totalDays).toBe(28);

    // Whatever the anchor, the cycles still account for the same total spend — the boundaries
    // moved, the data did not. 1_559_000 nanoUSD under every anchor.
    for (const rows of [first, last]) {
      expect([...rows.values()].reduce((sum, row) => sum + (row.costNanoUsd ?? 0), 0)).toBe(
        1_559_000,
      );
    }
  });

  it('rejects an anchor day the settings layer would never have stored — one path, one code', async () => {
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    // ⚠️ Rejected, not clamped: a clamped anchor would move every boundary in the payload and
    // report a confident set of totals over months the user never asked about (§3.13, §1).
    //
    // ⚠️ **And rejected in ONE place, with ONE §4.1 code.** An illegal day used to meet two
    // different guards depending on which line ran first: the shared calendar's bare `RangeError`
    // (which §4.1 flattens to `E_INTERNAL` — "something broke") or the repositories'
    // `E_INVALID_SETTING` (which names the setting the user can fix). The calendar ran first, so
    // the specific error was unreachable and a test matching only the message pinned neither.
    // The day is now checked before the calendar is built, so the specific code is the live one.
    for (const illegal of [0, 31, 15.5, Number.NaN]) {
      const error = thrownBy(() => fixture.analytics.billingCycleTotals(at(15), illegal, NOW));
      expect(isDbError(error) && error.code).toBe('E_INVALID_SETTING');
      expect(isDbError(error) && error.retryable).toBe(false);
      expect(String(error)).toMatch(/1 to 28/);
      // ⚠️ Explicitly NOT the generic throw: a `RangeError` here would reach the user as
      // "something went wrong" instead of "that billing day is not one this app can use".
      expect(error instanceof RangeError).toBe(false);
    }
  });

  it('says what the cycles it did NOT list contain, not merely how many there are', async () => {
    assertDstTimezonePinned();
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    priceTheKnownModel(fixture);

    // The cap is 120 cycles. Reading the same fixture as though the clock were 20 Feb 2036 puts
    // the newest cycle at [15 Feb 2036, 15 Mar 2036), and 2026-01 → 2036-02 inclusive is
    //   (2036 − 2026) × 12 + (1 − 0) + 1 = 120 + 1 + 1 = 122 cycles,
    // so the two OLDEST — January and February 2026 — fall outside the list. Every record in them
    // is real, was counted by the envelope's disclosure, and appears in no row.
    const far = fixture.analytics.billingCycleTotals(at(15), ANCHOR, Date.UTC(2036, 1, 20, 17));
    expect(far.truncated).toBe(2);
    expect(far.cycles).toHaveLength(120);
    expect(byKey(far.cycles).get('2026-01')).toBeUndefined();
    expect(byKey(far.cycles).get('2026-03')?.costNanoUsd).toBe(1_410_000);

    // ⚠️ **The point of the test.** What is missing is measured, in the payload:
    //   January  a1 + a2  → 2 records, 142_000 nanoUSD, in 12, out 30, read 100, 900 s
    //   February b1 + c1 + c2 → 3 records, 7_000 nanoUSD, in 1, out 6, read 0, 900 s
    expect(far.excluded).toEqual({
      cycles: 2,
      records: 5,
      costNanoUsd: 149_000, // 142_000 + 7_000
      uncostedRecords: 0, // every record in these two cycles had a price
      outputTokens: 36, // 30 + 6
      inputTokens: 13, // 12 + 1
      cacheReadTokens: 100,
      activeSeconds: 1_800, // 900 + 900
    });

    // …so the two things a screen can otherwise not reconcile now reconcile exactly.
    const listedCost = far.cycles.reduce((sum, row) => sum + (row.costNanoUsd ?? 0), 0);
    expect(listedCost).toBe(1_410_000);
    expect(listedCost + (far.excluded.costNanoUsd ?? 0)).toBe(
      fixture.analytics.overviewTiles(at(15)).costNanoUsd,
    );
    const listedUncosted = far.cycles.reduce((sum, row) => sum + row.uncostedRecords, 0);
    expect(listedUncosted + far.excluded.uncostedRecords).toBe(far.uncosted.records);
  });

  it('accounts for EVERY record when the cap leaves the whole dataset out', async () => {
    assertDstTimezonePinned();
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    priceTheKnownModel(fixture);

    // The extreme case, and the one that used to be silent. At a clock of 20 May 2036 the newest
    // cycle is [15 May 2036, 15 Jun 2036) and 2026-01 → 2036-05 is
    //   (2036 − 2026) × 12 + (4 − 0) + 1 = 120 + 4 + 1 = 125 cycles,
    // so all five cycles holding data are dropped. Every listed row is empty, while the envelope's
    // disclosure still counts all three unpriced records — a screen showing "3 records had no
    // price" above 120 rows of nothing, explained only by "5 older cycles are not shown".
    const far = fixture.analytics.billingCycleTotals(at(15), ANCHOR, Date.UTC(2036, 4, 20, 16));
    expect(far.truncated).toBe(5);
    expect(far.cycles.every((row) => row.costNanoUsd === null && row.outputTokens === 0)).toBe(
      true,
    );
    expect(far.uncosted.records).toBe(3);

    //   10 records in the fixture: 7 priced (a×2, b, c×2, d×2) and 3 not (e×2, f).
    //   output = 30 + 6 + 307 + 11 = 354      input = 12 + 1 + 110 + 7 = 130
    //   cache read = 100 + 1000 = 1100        active = 900 + 900 + 600 + 300 = 2700 s
    expect(far.excluded).toEqual({
      cycles: 5,
      records: 10,
      costNanoUsd: 1_559_000,
      uncostedRecords: 3,
      outputTokens: 354,
      inputTokens: 130,
      cacheReadTokens: 1_100,
      activeSeconds: 2_700,
    });
    // Nothing is unexplained: the whole all-time total and the whole disclosure are accounted for
    // by what the payload says it left out (§4.6).
    expect(far.excluded.costNanoUsd).toBe(fixture.analytics.overviewTiles(at(15)).costNanoUsd);
    expect(far.excluded.uncostedRecords).toBe(far.uncosted.records);
  });

  it('bucketed in LOCAL time, not UTC — the boundaries prove which reading was used', async () => {
    assertDstTimezonePinned();
    const fixture = await loadFixture(sandbox, 'a19-cycles');
    priceTheKnownModel(fixture);
    const rows = byKey(fixture.analytics.billingCycleTotals(at(15), ANCHOR, NOW).cycles);

    // Local midnight of the anchor day is 05:00Z in EST and 04:00Z in EDT. A query that bucketed
    // at UTC midnight would have moved every one of these six windows by five hours, and the two
    // spring cycles by four — the payload's own boundaries are the proof of which was used.
    expect(rows.get('2026-02')?.from).toBe(Date.UTC(2026, 1, 15, 5));
    expect(rows.get('2026-02')?.from).not.toBe(Date.UTC(2026, 1, 15));
    expect(rows.get('2026-03')?.from).toBe(Date.UTC(2026, 2, 15, 4));

    // And the record on the boundary lands the same way round: 2026-02-15T05:00Z is the FIRST
    // instant of the February cycle locally, while under a UTC reading it would be five hours
    // into it and the boundary case would stop being one.
    expect(rows.get('2026-02')?.from).toBe(
      fixture.db.prepare<{ ts: number }>("SELECT ts FROM events WHERE event_key = 'a19-b1'").get()
        ?.ts,
    );
  });
});

describe('A-19 — a session that spans a cycle boundary', () => {
  const sandbox = useSandbox();
  usePinnedTimezone(DST_TZ);

  it('counts it in BOTH cycles, so the per-cycle counts must never be added up', async () => {
    assertDstTimezonePinned();
    // `a19-cycle-span` holds ONE session with two records either side of a boundary:
    //   2026-02-15T04:30Z = 14 Feb 2026 23:30 EST  → cycle [15 Jan, 15 Feb)
    //   2026-02-15T05:30Z = 15 Feb 2026 00:30 EST  → cycle [15 Feb, 15 Mar)
    const fixture = await loadFixture(sandbox, 'a19-cycle-span');
    const totals = fixture.analytics.billingCycleTotals(at(15), ANCHOR, NOW);
    const rows = byKey(totals.cycles);

    // ⚠️ The documented behaviour, asserted rather than described: a cycle in which the user
    // worked reports the session, and both of these cycles are cycles in which the user worked.
    // Dropping it from either would report that cycle as emptier than it was — the same rule that
    // counts a session spanning local midnight in both working days (M-08).
    expect(rows.get('2026-01')?.sessions).toBe(1);
    expect(rows.get('2026-02')?.sessions).toBe(1);
    // Each cycle keeps only its own record's tokens; the session is shared, the records are not.
    expect(rows.get('2026-01')).toMatchObject({ inputTokens: 1, outputTokens: 2 });
    expect(rows.get('2026-02')).toMatchObject({ inputTokens: 3, outputTokens: 4 });

    // ⚠️⚠️ **The corollary, pinned here because it is what a surface could get wrong.** The
    // dataset holds exactly ONE session, and the per-cycle counts add up to two. `Σ sessions` is
    // therefore not a number of sessions and must never be rendered as a total — a caption reading
    // "2 sessions" over a dataset with one is a silently wrong number (CLAUDE.md §1). The type in
    // `src/shared/ipc-contract.ts` says so where a caller will read it.
    const stored = fixture.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions').get();
    expect(stored?.n).toBe(1);
    expect(totals.cycles.reduce((sum, row) => sum + row.sessions, 0)).toBe(2);
  });
});

/** Whatever `fn` threw, so an expectation can inspect its §4.1 code and not only its message. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw, and nothing was thrown');
}

/** The rows keyed by the cycle they cover, so an expectation can name a month, not an index. */
function byKey(cycles: readonly BillingCycleRow[]): Map<string, BillingCycleRow> {
  return new Map(cycles.map((row) => [billingCycleKey(row), row]));
}
