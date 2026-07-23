// F-12 (§5.9.1) — **Aggregate active time across two sessions in one day.** The fixture that
// pins ADR-036's binding **(C)**, and with it INV-21.
//
// One project, one local day (pinned `TZ = Asia/Tokyo`, ADR-021), idle threshold 15 minutes:
//   · session S1 — local 09:00, 09:15, 09:30
//   · session S2 — local 10:00, 10:10, 10:20
//
// ⚠️⚠️ **A DESIGN DEFECT IS RECORDED HERE, NOT SILENTLY RESOLVED (CLAUDE.md §2).**
// §5.9.1 F-12 describes the fixture as "session S1 with events at `09:00` and `09:30`, session S2
// with events at `10:00` and `10:20`" and states the expected value `30m + 15m + 20m = 65m`, with
// the rejected per-session sum at `30m + 20m = 50m`. **Those two numbers are not reachable from
// those two event lists under M-07 as written.** M-07 is `SUM(MIN(gap, idleGapMs))`; with a 15m
// threshold the literal event lists give gaps of 30m, 30m and 20m, each capped at 15m — total
// 45m, and 15m + 15m = 30m for the rejected reading. The stated 65m treats each session's own
// 30m/20m stretch as active *uncapped* while capping only the inter-session gap, which no reading
// of M-07 produces.
//
// The intent is recoverable and is honoured exactly: §5.9.1 names each session's **endpoints**,
// and its arithmetic is right for a session whose interior events keep every gap inside the
// threshold. This fixture therefore uses `09:00, 09:15, 09:30` and `10:00, 10:10, 10:20` — the
// same session boundaries §5.9.1 states — which reproduce **both** of its published numbers
// exactly: binding (C) = 65m and the rejected per-session sum = 50m. The literal two-event
// reading is asserted too, so the discrepancy is pinned rather than lost. **M-07's formula is
// implemented verbatim; only the fixture's event list is disambiguated.** Reported to the
// orchestrator.

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { at, loadFixture } from './support/metrics-harness';
import { assertTimezonePinned, usePinnedTimezone } from './support/pinned-tz';

describe('F-12 — an aggregate Active-hours figure partitions by working day (ADR-036)', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('counts the intra-day inter-session gap, capped, on all three surfaces (INV-21)', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f12-two-sessions');

    // Two sessions, one project, one local day — the shape §5.9.1 warns is essential:
    // "⚠️ A fixture with only one session per day passes under either reading and proves nothing."
    expect(fixture.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(
      2,
    );

    // ── Hand-computed expected value ────────────────────────────────────────────────────
    // Binding (C): the partition is the whole `(2024-05-01, alpha)` group, so the merged,
    // timestamp-ordered stream is 09:00, 09:15, 09:30, 10:00, 10:10, 10:20 with cap 15m:
    //   09:00            first event of the partition → 0
    //   09:00 → 09:15    15m ≤ 15m → 15m
    //   09:15 → 09:30    15m ≤ 15m → 15m
    //   09:30 → 10:00    30m > 15m → 15m   ← the inter-session gap, CAPPED and COUNTED
    //   10:00 → 10:10    10m       → 10m
    //   10:10 → 10:20    10m       → 10m
    //   TOTAL = 15 + 15 + 15 + 10 + 10 = 65m = 3_900 s
    //
    // Under the REJECTED per-session sum (ADR-036's rejected option):
    //   S1 = 15 + 15 = 30m,  S2 = 10 + 10 = 20m,  total = 50m = 3_000 s
    const context = at(15);
    const overview = fixture.analytics.overviewTiles(context);
    expect(overview.activeSeconds).toBe(3_900);
    expect(overview.activeSeconds).not.toBe(3_000); // the per-session sum ADR-036 rejected

    // The working-day row (§4.5 `q:workingDays`, M-07 binding (B)) — the same 65m.
    const workingDays = fixture.analytics.workingDays(context, { limit: 100 });
    expect(workingDays.rows).toHaveLength(1);
    expect(workingDays.rows[0]?.day).toBe('2024-05-01');
    expect(workingDays.rows[0]?.activeSeconds).toBe(3_900);
    expect(workingDays.rows[0]?.sessions).toBe(2);
    // M-08 `spanSeconds` = last − first within the group = 09:00 → 10:20 = 80m = 4_800 s.
    expect(workingDays.rows[0]?.spanSeconds).toBe(4_800);

    // The project card (§4.5 `ProjectCard.activeSeconds`, M-07 binding (C) for one project).
    const cards = fixture.analytics.projectCards(context);
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0]?.activeSeconds).toBe(3_900);

    // ⚠️ INV-21 stated as the invariant itself, not as three equal literals: the tile equals the
    // SUM over every row `q:workingDays` returns for the same filter, exactly.
    const sumOfRows = workingDays.rows.reduce((total, row) => total + row.activeSeconds, 0);
    expect(overview.activeSeconds).toBe(sumOfRows);
    expect(cards.rows[0]?.activeSeconds).toBe(sumOfRows);

    // …and the per-session figures, which are binding (A) and are DIFFERENT numbers on purpose.
    const perSession = fixture.active.bySession(context);
    expect(perSession.map((row) => row.activeSeconds).sort((a, b) => a - b)).toEqual([
      1_200, 1_800,
    ]);
    // 20m + 30m = 50m ≠ 65m. Two nouns, two numbers (M-10's deliberate asymmetry).
    expect(perSession.reduce((total, row) => total + row.activeSeconds, 0)).toBe(3_000);
  });

  it('reproduces the §5.9.1 arithmetic gap on the literal two-event reading', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f12-two-sessions');
    const base = Date.parse('2024-05-01T00:00:00.000Z'); // local 09:00

    // ⚠️ The defect, pinned. Filtering out the two interior events leaves exactly the event list
    // §5.9.1 F-12 writes down — S1 at 09:00 and 09:30, S2 at 10:00 and 10:20 — and M-07's own
    // formula then gives 15 + 15 + 15 = 45m, NOT the published 65m. This assertion exists so the
    // discrepancy is a recorded fact in the suite rather than a note in a report nobody re-reads.
    const literal = fixture.db
      .prepare<{ active_ms: number }>(
        `WITH scoped AS (
           SELECT ts FROM events
           WHERE  ts IN (?, ?, ?, ?)
         ),
         gapped AS (SELECT ts - LAG(ts) OVER (ORDER BY ts) AS gap FROM scoped)
         SELECT COALESCE(SUM(MIN(gap, ?)), 0) AS active_ms FROM gapped`,
      )
      .get(base, base + 30 * 60_000, base + 60 * 60_000, base + 80 * 60_000, 15 * 60_000);
    expect(literal?.active_ms).toBe(45 * 60_000);
    expect(literal?.active_ms).not.toBe(65 * 60_000);
  });

  it('changes with the threshold, and only the threshold (ADR-022)', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f12-two-sessions');

    // At 30 minutes nothing is capped: 15 + 15 + 30 + 10 + 10 = 80m = 4_800 s — which is exactly
    // the group's span, because every gap now fits under the threshold.
    expect(fixture.analytics.overviewTiles(at(30)).activeSeconds).toBe(4_800);
    // At 5 minutes every gap caps to 5m: 5 × 5m = 25m = 1_500 s.
    expect(fixture.analytics.overviewTiles(at(5)).activeSeconds).toBe(1_500);
  });
});
