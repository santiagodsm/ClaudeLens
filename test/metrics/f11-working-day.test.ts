// F-11 (§5.9.1) — **Working-day aggregation.** "M-08 inherits M-07's event set; a session
// crossing local midnight contributes to both days by each event's own local date, under a
// pinned `TZ`." ADR-021, M-08.
//
// `TZ = Asia/Tokyo` (UTC+9, no DST), so local midnight is 15:00Z. The fixture is ONE session
// whose events straddle it:
//   main     2024-05-01T14:20Z → local 2024-05-01 23:20
//   subagent 2024-05-01T14:35Z → local 2024-05-01 23:35   ← the ADR-035 discriminator
//   main     2024-05-01T14:50Z → local 2024-05-01 23:50
//   main     2024-05-01T15:10Z → local 2024-05-02 00:10
//   main     2024-05-01T15:20Z → local 2024-05-02 00:20

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { at, loadFixture } from './support/metrics-harness';
import { assertTimezonePinned, usePinnedTimezone } from './support/pinned-tz';

describe('F-11 — M-08 buckets by each event’s own local date (ADR-021)', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('splits one session across local midnight into two working days', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f11-midnight');
    const context = at(15);

    // One session, two working-day rows — the point of M-08's "contributes to **both** days".
    expect(fixture.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(
      1,
    );

    const rows = fixture.analytics
      .workingDays(context, { limit: 100 })
      .rows.slice()
      .sort((left, right) => left.day.localeCompare(right.day));
    expect(rows.map((row) => row.day)).toEqual(['2024-05-01', '2024-05-02']);

    // ── Hand-computed expected value ────────────────────────────────────────────────────
    // 2024-05-01 partition: 23:20, 23:35, 23:50 (the middle one is the SUBAGENT event)
    //   0 + 15m + 15m = 30m = 1_800 s ; span 23:20 → 23:50 = 30m = 1_800 s ; 1 session
    // 2024-05-02 partition: 00:10, 00:20
    //   0 + 10m       = 10m =   600 s ; span 00:10 → 00:20 = 10m =   600 s ; 1 session
    expect(rows[0]).toMatchObject({
      day: '2024-05-01',
      activeSeconds: 1_800,
      spanSeconds: 1_800,
      sessions: 1,
    });
    expect(rows[1]).toMatchObject({
      day: '2024-05-02',
      activeSeconds: 600,
      spanSeconds: 600,
      sessions: 1,
    });

    // ⚠️ M-08 "inheriting M-07's event set exactly" is what makes day 1 read 30m. Drop the
    // subagent event and the 23:20 → 23:50 stretch is a single 30m gap capped at 15m — half the
    // number. Asserted against, because that is the failure ADR-035 exists to prevent.
    expect(rows[0]?.activeSeconds).not.toBe(900);

    // Binding (C) = 1_800 + 600 = 2_400 s. ⚠️ NOT 3_300: the 23:50 → 00:10 gap crosses a
    // partition boundary and therefore contributes 0, exactly like a partition start.
    const tiles = fixture.analytics.overviewTiles(context);
    expect(tiles.activeSeconds).toBe(2_400);
    expect(tiles.activeSeconds).not.toBe(3_300);

    // INV-21 — the tile is the sum of the rows, for the same filter, exactly.
    expect(tiles.activeSeconds).toBe(rows.reduce((total, row) => total + row.activeSeconds, 0));

    // …and the session's own binding-(A) figure is a THIRD number, on purpose (M-09/M-10):
    // one stream 23:20 → 00:20 with cap 15m: 15 + 15 + 15 + 10 = 55m = 3_300 s.
    expect(fixture.active.bySession(context)[0]?.activeSeconds).toBe(3_300);
  });

  it('buckets in local time, not UTC — the two readings name different days', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f11-midnight');

    // Every event is on 2024-05-01 in UTC. Bucketing in UTC would produce ONE working day of
    // 55 minutes; ADR-021 requires two, "so a marathon that runs 22:00→02:00 lands where the
    // human thinks it did".
    const utcDays = fixture.db
      .prepare<{ day: string }>(
        "SELECT DISTINCT date(ts/1000, 'unixepoch') AS day FROM events ORDER BY day",
      )
      .all();
    expect(utcDays.map((row) => row.day)).toEqual(['2024-05-01']);
    expect(fixture.analytics.workingDays(at(15), { limit: 100 }).rows).toHaveLength(2);
  });
});
