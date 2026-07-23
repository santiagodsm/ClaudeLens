// F-01 (§5.9.1) — **Active time across a subagent run.** The single fixture that pins ADR-035.
//
// The fixture: a parent session with assistant events at `t = 0` and `t = 5m`, then a
// **40-minute stretch during which only a subagent transcript has events** (every 2 minutes),
// then a parent event at `t = 45m`. Idle threshold 15 minutes.
//
// ⚠️ §5.9.1's own warning is why the shape matters: "**A fixture built only from main-loop
// sessions would pass under either reading and prove nothing** — this one must contain a parent
// session with a long subagent run inside it, and its expected value must be the number the two
// readings disagree about." Both numbers are asserted below: the decided one, and a `not.toBe`
// on the rejected one, so deleting `origin IN ('main','subagent')` from the query turns this test
// red rather than merely changing a number nobody re-derived.

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { ALL, at, loadFixture } from './support/metrics-harness';
import { assertTimezonePinned, usePinnedTimezone } from './support/pinned-tz';

describe('F-01 — M-07 is computed over events of BOTH origins (ADR-035)', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('counts the subagent-filled stretch as active time', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f01-subagent-active');

    // Both origins are present and both are in `events` (ADR-020: stored once, session_id =
    // parent, `origin='subagent'`). If this drifts the numbers below mean nothing.
    const origins = fixture.db
      .prepare<{ origin: string; n: number }>(
        'SELECT origin, COUNT(*) AS n FROM events GROUP BY origin ORDER BY origin',
      )
      .all();
    expect(origins).toEqual([
      { origin: 'main', n: 3 }, // t = 0, 5m, 45m
      { origin: 'subagent', n: 19 }, // t = 7m, 9m, …, 43m — 19 events, every 2 minutes
    ]);

    // ── Hand-computed expected value ────────────────────────────────────────────────────
    // Merged, timestamp-ordered stream (ADR-035), idleGapMs = 15m:
    //   t = 0                first event of the partition → contributes 0
    //   0    → 5m    gap  5m ≤ 15m → 5m
    //   5m   → 7m    gap  2m       → 2m      ┐
    //   7m   → 9m    gap  2m       → 2m      │ 19 further events at 2-minute spacing,
    //   …                                    │ i.e. 19 gaps of 2m from 5m to 43m,
    //   41m  → 43m   gap  2m       → 2m      ┘ = 38m
    //   43m  → 45m   gap  2m       → 2m
    //   TOTAL = 5m + 38m + 2m = 45m = 2_700 s
    //
    // Under the REJECTED main-only reading the stream is 0, 5m, 45m:
    //   5m + min(40m, 15m) = 5m + 15m = 20m = 1_200 s
    const bySession = fixture.active.bySession(at(15));
    expect(bySession).toHaveLength(1);
    expect(bySession[0]?.activeSeconds).toBe(2_700); // M-07 binding (A)
    expect(bySession[0]?.activeSeconds).not.toBe(1_200); // the main-only reading

    // The same 45 minutes under binding (B) — one project, one local day (2024-05-01 09:00–09:45
    // Asia/Tokyo is 2024-05-01 18:00–18:45 local, so one day) — and under binding (C).
    const days = fixture.active.byWorkingDay(at(15));
    expect(days).toHaveLength(1);
    expect(days[0]?.activeSeconds).toBe(2_700);
    expect(fixture.active.bindingCSeconds(at(15))).toBe(2_700);

    // …and on the surface that actually renders it (§6.3's Active hours tile).
    expect(fixture.analytics.overviewTiles(at(15)).activeSeconds).toBe(2_700);
  });

  it('still caps a genuine idle gap — the inclusive reading does not disable the threshold', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f01-subagent-active');

    // ⚠️ The discriminator in the other direction. At a 1-minute threshold every 2-minute gap is
    // capped, so the same stream must SHRINK — proving the cap is applied per gap and that the
    // 2_700 above is not simply "last − first".
    //   1 gap of 5m → 1m; 19 gaps of 2m → 1m each; 1 gap of 2m → 1m  = 21 gaps × 1m = 21m
    expect(fixture.active.bySession(at(1))[0]?.activeSeconds).toBe(21 * 60);
    // last − first would be 45m; it is not that.
    expect(fixture.active.bySession(at(1))[0]?.activeSeconds).not.toBe(2_700);
  });

  it('restricts each partition to the filter window first (M-07 "filter boundaries")', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f01-subagent-active');
    const base = Date.parse('2024-05-01T09:00:00.000Z');

    // Window [t=10m, t=20m). Events inside: 11m, 13m, 15m, 17m, 19m — five subagent events.
    // The first of the RESTRICTED stream contributes 0, so the total is 4 gaps × 2m = 8m = 480 s.
    // ⚠️ If the filter were applied AFTER gapping, the 9m → 11m gap would leak in and the answer
    // would be 10m. Asserted against, because that is the mistake that looks right.
    const window = { projectIds: null, from: base + 10 * 60_000, to: base + 20 * 60_000 };
    expect(fixture.active.bySession(at(15, window))[0]?.activeSeconds).toBe(480);
    expect(fixture.active.bySession(at(15, window))[0]?.activeSeconds).not.toBe(600);

    // Sanity: the unfiltered figure is unchanged by having asked a narrower question.
    expect(fixture.active.bySession(at(15, ALL))[0]?.activeSeconds).toBe(2_700);
  });
});
