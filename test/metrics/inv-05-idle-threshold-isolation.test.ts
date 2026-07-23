// INV-05 (§5.10) — "Changing `idleGapMinutes` changes **only** active-time results. `sessions`
// row count, session ids, spans, token totals and tool counts are byte-identical before and
// after." ADR-022.
//
// ⚠️ This is the invariant that makes the threshold a live Settings slider (§6.10) instead of a
// re-ingest. It is asserted by running every affected payload at two thresholds and comparing
// the whole object minus the fields that are *supposed* to move — so a new field that
// accidentally depends on the threshold fails here rather than in six weeks.

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { at, loadFixture } from './support/metrics-harness';
import { usePinnedTimezone } from './support/pinned-tz';

describe('INV-05 — the idle threshold moves active time and nothing else', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('leaves session identity, spans, tokens and tool counts byte-identical', async () => {
    const fixture = await loadFixture(sandbox, 'f12-two-sessions');

    const page = (minutes: number): unknown =>
      fixture.analytics.sessions(at(minutes), { limit: 100 }, 'firstTs', 'asc').page.rows.map(
        // `activeSeconds` is removed because it is the ONE field allowed to differ.
        ({ activeSeconds, ...rest }) => {
          void activeSeconds;
          return rest;
        },
      );

    expect(page(5)).toEqual(page(60));

    // …and it genuinely DID move, so the comparison above is not vacuous.
    //   at 5m : each session's three events are 15m/10m apart → S1 5+5 = 10m, S2 5+5 = 10m
    //   at 60m: nothing is capped → S1 30m, S2 20m
    const active = (minutes: number): number[] =>
      fixture.active
        .bySession(at(minutes))
        .map((row) => row.activeSeconds)
        .sort((left, right) => left - right);
    expect(active(5)).toEqual([600, 600]);
    expect(active(60)).toEqual([1_200, 1_800]);
  });

  it('leaves every non-active-time Overview tile identical', async () => {
    const fixture = await loadFixture(sandbox, 'f02-rollup');

    const tiles = (minutes: number): unknown => {
      const { activeSeconds, overlapSeconds, ...rest } = fixture.analytics.overviewTiles(
        at(minutes),
      );
      void activeSeconds;
      void overlapSeconds; // M-20 is derived from active time, so it may move too.
      return rest;
    };
    expect(tiles(5)).toEqual(tiles(60));
  });

  it('leaves M-09 span alone — it is threshold- AND partition-independent', async () => {
    const fixture = await loadFixture(sandbox, 'f12-two-sessions');
    const spans = (minutes: number): number[] =>
      fixture.analytics
        .sessions(at(minutes), { limit: 100 }, 'firstTs', 'asc')
        .page.rows.map((row) => row.spanSeconds);
    // S1 09:00 → 09:30 = 1_800 s · S2 10:00 → 10:20 = 1_200 s, at any threshold (M-09).
    expect(spans(5)).toEqual([1_800, 1_200]);
    expect(spans(60)).toEqual([1_800, 1_200]);
  });

  it('leaves working-day span and session counts alone; only activeSeconds moves', async () => {
    const fixture = await loadFixture(sandbox, 'f12-two-sessions');
    const rows = (minutes: number): unknown =>
      fixture.analytics
        .workingDays(at(minutes), { limit: 100 })
        .rows.map(({ activeSeconds, ...rest }) => {
          void activeSeconds;
          return rest;
        });
    expect(rows(5)).toEqual(rows(60));
    // 5 gaps capped at 5m = 25m; uncapped = the group's span, 80m.
    expect(fixture.analytics.workingDays(at(5), { limit: 100 }).rows[0]?.activeSeconds).toBe(1_500);
    expect(fixture.analytics.workingDays(at(60), { limit: 100 }).rows[0]?.activeSeconds).toBe(
      4_800,
    );
  });
});
