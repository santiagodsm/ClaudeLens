// F-14 (§5.9.1) — **Active time when event timestamps are not on whole seconds.**
//
// ⚠️ **This fixture exists because F-01, F-11 and F-12 were all green while `q:sessions` was hard
// broken on real data, and the reason is a blind spot they share by construction: every committed
// fixture before this one places every event on a whole minute** (`…:00.000Z`). Real transcripts
// carry millisecond timestamps, so every real gap sum has a sub-second residue and every fixture
// gap sum is an exact multiple of 1000. Any bug that only shows up in the ms→s conversion is
// therefore invisible to all of them — and one was:
//
//   `better-sqlite3` binds every JS `number` as a SQLite **REAL** (`typeof(?)` is `'real'` even for
//   `900000`). SQLite's scalar `min(X, Y)` returns whichever argument is smaller **with that
//   argument's own type**, so `MIN(gap, ?)` returned a REAL exactly when the idle cap won, `SUM()`
//   over the mix returned a REAL, and `sessionAggregateSql`'s `… / 1000` silently became
//   floating-point division instead of the integer division `msToSeconds()` and M-09's generated
//   `span_seconds` both do. `SessionRow.activeSeconds` came back fractional; INV-11's predicate is
//   `Number.isSafeInteger`, which refuses a non-integer, and `q:sessions` returned `E_INTERNAL` for
//   33 of the reporting user's 75 sessions. On whole-minute fixtures the REAL division lands on an
//   exact integer and nothing is visible.
//
// So this fixture is the same shape as F-12 — one project, one local day, two sessions, so all
// three M-07 bindings are exercised at once — with two deliberate changes:
//   · every timestamp carries a **non-zero millisecond component**, and every partition's gap sum
//     is NOT a multiple of 1000, so a floating-point division cannot pass;
//   · one gap sits at **899_750 ms**, 250 ms *under* the 15-minute cap, and another at
//     **300_250 ms**, 250 ms *over* the 5-minute cap — so the comparison is pinned to be in
//     milliseconds. A cap compared in seconds or minutes gets both of those backwards.
//
// Every expected value below is hand-computed inline, in milliseconds, from the two event lists
// (§5.9, STACK ADR-012). `toMatchSnapshot()` is banned here.

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { at, loadFixture } from './support/metrics-harness';
import { assertTimezonePinned, usePinnedTimezone } from './support/pinned-tz';

// ── The fixture, transcribed (UTC; TZ is pinned to Asia/Tokyo, so this is local 09:00–10:00) ──
//
//   sess-f14-a   00:00:00.000   00:05:00.250   00:25:00.750
//   sess-f14-b   00:40:00.500   00:42:00.900   01:00:00.900
//
// The six inter-event gaps of the merged, timestamp-ordered stream (ADR-035), in ms:
//   g1  00:00:00.000 → 00:05:00.250      300_250      (  5m 00.250s)
//   g2  00:05:00.250 → 00:25:00.750    1_200_500      ( 20m 00.500s)
//   g3  00:25:00.750 → 00:40:00.500      899_750      ( 14m 59.750s)  ← 250 ms UNDER the 15m cap
//   g4  00:40:00.500 → 00:42:00.900      120_400      (  2m 00.400s)
//   g5  00:42:00.900 → 01:00:00.900    1_080_000      ( 18m 00.000s)
// g3 is the inter-session gap; g1, g2 belong to session A and g4, g5 to session B.

describe('F-14 — M-07 on millisecond timestamps (the real-transcript shape)', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('binding (A) — SessionRow.activeSeconds is a whole number of seconds', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f14-subsecond-active');

    // ── Hand-computed expected values, cap = 15m = 900_000 ms ────────────────────────────
    // Session A, PARTITION BY session_id: first event contributes 0, then
    //   g1 = min(  300_250, 900_000) =   300_250
    //   g2 = min(1_200_500, 900_000) =   900_000   ← the cap wins: this is the REAL-typed term
    //   active_ms = 300_250 + 900_000 = 1_200_250
    //   activeSeconds = trunc(1_200_250 / 1000) = 1_200
    // ⚠️ Under floating-point division this is 1_200.25 — refused by INV-11, never rendered.
    //
    // Session B:
    //   g4 = min(  120_400, 900_000) =   120_400
    //   g5 = min(1_080_000, 900_000) =   900_000   ← the cap wins again
    //   active_ms = 120_400 + 900_000 = 1_020_400
    //   activeSeconds = trunc(1_020_400 / 1000) = 1_020        (float: 1_020.4)
    //
    // M-09 spans, from the stored first_ts/last_ts (threshold- and partition-independent):
    //   A: 00:25:00.750 − 00:00:00.000 = 1_500_750 ms → span_seconds = 1_500
    //   B: 01:00:00.900 − 00:40:00.500 = 1_200_400 ms → span_seconds = 1_200
    const page = fixture.analytics.sessions(at(15), { limit: 10 }, 'firstTs', 'asc');
    const rows = page.page.rows;
    expect(rows.map((row) => row.id)).toEqual(['sess-f14-a', 'sess-f14-b']);

    expect(rows[0]?.activeSeconds).toBe(1_200);
    expect(rows[0]?.spanSeconds).toBe(1_500);
    expect(rows[1]?.activeSeconds).toBe(1_020);
    expect(rows[1]?.spanSeconds).toBe(1_200);

    // ⚠️ The property the bug violated, stated as a property. `Number.isSafeInteger` is INV-11's
    // predicate, and a fractional second is what actually failed it — not a large magnitude.
    for (const row of rows) {
      expect(Number.isInteger(row.activeSeconds)).toBe(true);
      expect(row.activeSeconds).toBeLessThanOrEqual(row.spanSeconds);
    }

    // The drill-down reads the same SQL through a different entry point (`sessionRow`), so it is
    // asserted too — it was equally broken and equally invisible.
    expect(fixture.analytics.sessionDetail('sess-f14-a', 15)?.activeSeconds).toBe(1_200);
    expect(fixture.analytics.sessionDetail('sess-f14-b', 15)?.activeSeconds).toBe(1_020);

    // `ActiveTimeRepository.bySession()` is the *other* implementation of binding (A) — it
    // truncates in JS rather than in SQL. The two must agree; they did not, and nothing said so.
    expect(
      fixture.active
        .bySession(at(15))
        .toSorted((left, right) => left.sessionId.localeCompare(right.sessionId))
        .map((row) => row.activeSeconds),
    ).toEqual([1_200, 1_020]);
  });

  it('bindings (B) and (C) — the working-day group and its sum (INV-21)', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f14-subsecond-active');

    // ── Hand-computed expected value, cap = 15m = 900_000 ms ─────────────────────────────
    // Binding (B): PARTITION BY (2024-05-01, alpha) — one merged stream of all six events.
    //   g1 = min(  300_250, 900_000) =   300_250
    //   g2 = min(1_200_500, 900_000) =   900_000
    //   g3 = min(  899_750, 900_000) =   899_750   ← 250 ms under the cap: NOT capped, and the
    //                                                inter-session gap ADR-036 says to count
    //   g4 = min(  120_400, 900_000) =   120_400
    //   g5 = min(1_080_000, 900_000) =   900_000
    //   active_ms = 300_250 + 900_000 + 899_750 + 120_400 + 900_000 = 3_120_400
    //   activeSeconds = trunc(3_120_400 / 1000) = 3_120          (float: 3_120.4)
    //   spanSeconds   = trunc((01:00:00.900 − 00:00:00.000) / 1000)
    //                 = trunc(3_600_900 / 1000) = 3_600
    //
    // Under the per-session sum ADR-036 rejected: 1_200 + 1_020 = 2_220 s. Different number, so
    // this fixture discriminates the binding as well as the arithmetic.
    const workingDays = fixture.analytics.workingDays(at(15), { limit: 100 });
    expect(workingDays.rows).toHaveLength(1);
    expect(workingDays.rows[0]?.day).toBe('2024-05-01');
    expect(workingDays.rows[0]?.sessions).toBe(2);
    expect(workingDays.rows[0]?.activeSeconds).toBe(3_120);
    expect(workingDays.rows[0]?.spanSeconds).toBe(3_600);
    expect(workingDays.rows[0]?.activeSeconds).not.toBe(2_220); // the rejected per-session sum

    const overview = fixture.analytics.overviewTiles(at(15));
    expect(overview.activeSeconds).toBe(3_120);

    // INV-21 as the invariant, not as three equal literals.
    const sumOfRows = workingDays.rows.reduce((total, row) => total + row.activeSeconds, 0);
    expect(overview.activeSeconds).toBe(sumOfRows);
    expect(fixture.analytics.projectCards(at(15)).rows[0]?.activeSeconds).toBe(sumOfRows);

    // INV-22(d) — one project in scope, so the overlap disclosure is exactly 0 (M-20).
    expect(overview.overlapSeconds).toBe(0);
  });

  it('pins the cap comparison to milliseconds, 250 ms either side of the threshold', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f14-subsecond-active');

    // ── cap = 5m = 300_000 ms ────────────────────────────────────────────────────────────
    // g1 = 300_250 is 250 ms OVER this cap, so it caps; g4 = 120_400 does not.
    //   g1 → 300_000 · g2 → 300_000 · g3 → 300_000 · g4 → 120_400 · g5 → 300_000
    //   active_ms = 4 × 300_000 + 120_400 = 1_320_400 → trunc/1000 = 1_320
    // ⚠️ If the cap were compared in seconds or minutes against a millisecond gap, EVERY gap here
    // would cap and the answer would be 5 × 300_000 = 1_500_000 ms = 1_500 s. Asserted against.
    expect(fixture.analytics.overviewTiles(at(5)).activeSeconds).toBe(1_320);
    expect(fixture.analytics.overviewTiles(at(5)).activeSeconds).not.toBe(1_500);
    //   session A: 300_000 + 300_000 = 600_000 → 600
    //   session B: 120_400 + 300_000 = 420_400 → 420
    expect(
      fixture.analytics
        .sessions(at(5), { limit: 10 }, 'firstTs', 'asc')
        .page.rows.map((row) => row.activeSeconds),
    ).toEqual([600, 420]);

    // ── cap = 30m = 1_800_000 ms ─────────────────────────────────────────────────────────
    // Nothing caps, so binding (B) collapses to the group's own span, exactly:
    //   300_250 + 1_200_500 + 899_750 + 120_400 + 1_080_000 = 3_600_900 → trunc/1000 = 3_600
    expect(fixture.analytics.overviewTiles(at(30)).activeSeconds).toBe(3_600);
    // …and each session's active time equals its own span — the boundary case of the
    // `activeSeconds <= spanSeconds` assertion in `session-stats.ts`, which must NOT fire on
    // equality. A `<` there instead of a `<=` turns this red.
    const uncapped = fixture.analytics.sessions(at(30), { limit: 10 }, 'firstTs', 'asc').page.rows;
    expect(uncapped.map((row) => row.activeSeconds)).toEqual([1_500, 1_200]);
    expect(uncapped.map((row) => row.spanSeconds)).toEqual([1_500, 1_200]);
  });

  it('refuses a binding-(A) active time longer than the session itself', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f14-subsecond-active');

    // ⚠️ The permanent assertion in `session-stats.ts`, proved to be wired rather than assumed.
    // `activeSeconds <= spanSeconds` is a true property of M-07 binding (A) — every term is a gap
    // between two of that session's own events — so the only way to observe it firing is to
    // corrupt the span. Collapsing `last_ts` onto `first_ts` makes M-09's generated
    // `span_seconds` 0 while binding (A) still measures 1_200 s, which is precisely the shape of
    // "the number is impossible" that INV-11 could only report as "the number is big".
    fixture.db.exec(`UPDATE sessions SET last_ts = first_ts WHERE id = 'sess-f14-a'`);
    expect(() => fixture.analytics.sessions(at(15), { limit: 10 }, 'firstTs', 'asc')).toThrow(
      /longer than the session itself/,
    );
  });

  it('records the driver behaviour the bug rested on, so removing the CAST turns this red', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f14-subsecond-active');

    // ⚠️ Not a metric assertion — a recorded fact about the seam, in the manner of F-12's
    // "literal two-event reading" test. `better-sqlite3` binds a JS number as REAL, and SQLite's
    // two-argument `min()` propagates the *winning argument's* type. Both halves are asserted, so
    // if a driver upgrade ever changes either one, the reason `CAPPED_GAP_MS` casts is re-checked
    // rather than assumed to still hold.
    const probe = fixture.db
      .prepare<{
        bound: string;
        gap_wins: string;
        cap_wins: string;
        cap_wins_cast: string;
      }>(
        `SELECT typeof(?)                                 AS bound,
                typeof(MIN(1, ?))                         AS gap_wins,
                typeof(MIN(9999999, ?))                   AS cap_wins,
                typeof(MIN(9999999, CAST(? AS INTEGER)))  AS cap_wins_cast`,
      )
      .get(900_000, 900_000, 900_000, 900_000);
    expect(probe).toEqual({
      bound: 'real', // ← the driver detail that started it
      gap_wins: 'integer',
      cap_wins: 'real', // ← one REAL in the SUM makes `… / 1000` float division
      cap_wins_cast: 'integer', // ← what `CAPPED_GAP_MS` guarantees
    });

    // And the consequence, end to end: an integer-typed sum makes `… / 1000` integer division.
    const sums = fixture.db
      .prepare<{ t_real: string; v_real: number; t_int: string; v_int: number }>(
        `WITH gapped AS (
           SELECT ts - LAG(ts) OVER (PARTITION BY session_id ORDER BY ts, id) AS gap FROM events
         )
         SELECT typeof(COALESCE(SUM(MIN(gap, ?)), 0) / 1000)                   AS t_real,
                COALESCE(SUM(MIN(gap, ?)), 0) / 1000                           AS v_real,
                typeof(COALESCE(SUM(MIN(gap, CAST(? AS INTEGER))), 0) / 1000)  AS t_int,
                COALESCE(SUM(MIN(gap, CAST(? AS INTEGER))), 0) / 1000          AS v_int
         FROM gapped`,
      )
      .get(900_000, 900_000, 900_000, 900_000);
    // Per-session sums are 1_200_250 and 1_020_400 ms; over both partitions, 2_220_650 ms.
    expect(sums?.t_real).toBe('real');
    expect(sums?.v_real).toBe(2_220.65); // ← what shipped: refused by INV-11, and rightly so
    expect(sums?.t_int).toBe('integer');
    expect(sums?.v_int).toBe(2_220); // ← trunc(2_220_650 / 1000), which is the metric
  });
});
