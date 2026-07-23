// F-13 (§5.9.1) — **Cross-project overlap, both cases, and it must discriminate.**
// M-19, M-20, INV-22, INV-23, ADR-037.
//
// ⚠️ §5.9.1: "it must discriminate; **a fixture whose overlap happens to be 0 proves nothing**."
// The fixture therefore carries three projects on one pinned local day (`TZ = Asia/Tokyo`,
// ADR-021), idle threshold 15 minutes:
//   · alpha   — local 09:00, 09:10, 09:20
//   · beta    — local 09:05, 09:15, 09:25   (interleaved with alpha → non-zero overlap)
//   · gamma   — local 10:00, 10:10, 10:20   (disjoint from alpha → zero overlap)
// so the SAME fixture exercises the non-zero case, the zero case and the single-project case.
//
// ⚠️ M-19 is **not** "M-07 with one global partition". That reading gives a NEGATIVE overlap;
// ADR-037's worked counterexample is reproduced as its own test at the bottom of this file, on
// its own fixture, so the wrong implementation cannot pass.

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { at, loadFixture, type MetricsFixture } from './support/metrics-harness';
import { assertTimezonePinned, usePinnedTimezone } from './support/pinned-tz';

const MINUTE = 60;

function filterOn(
  fixture: MetricsFixture,
  ...encodedNames: string[]
): {
  projectIds: number[];
  from: null;
  to: null;
} {
  return { projectIds: encodedNames.map((name) => fixture.projectId(name)), from: null, to: null };
}

describe('F-13 — cross-project overlap is disclosed, exact and never negative (ADR-037)', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('overlapping case: total 40m, union 25m, overlap 15m', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f13-overlap');
    const context = at(15, filterOn(fixture, '-work-demo-alpha', '-work-demo-beta'));

    // ── Hand-computed expected value ────────────────────────────────────────────────────
    // Covered intervals, `Cᵢ = [tᵢ − min(gᵢ, 15m), tᵢ]` (M-19), per (day, project) partition:
    //   alpha : [09:00,09:10] + [09:10,09:20]  = 20m
    //   beta  : [09:05,09:15] + [09:15,09:25]  = 20m
    // M-07 binding (C) total  = 20m + 20m                     = 40m = 2_400 s
    // M-19 union              = [09:00,09:25]                 = 25m = 1_500 s
    // M-20 overlap = 40m − 25m                                = 15m =   900 s
    const overlap = fixture.active.overlap(context);
    expect(overlap.activeSeconds).toBe(40 * MINUTE);
    expect(overlap.dedupMs).toBe(25 * 60_000);
    expect(overlap.overlapSeconds).toBe(15 * MINUTE);

    // ⚠️ INV-22(a) — `overlapSeconds = (M-07 binding (C) total) − M-19`, exactly.
    expect(overlap.overlapSeconds).toBe(overlap.activeSeconds - overlap.dedupMs / 1000);
    // ⚠️ INV-22(b) — never negative.
    expect(overlap.overlapSeconds).toBeGreaterThanOrEqual(0);
    // ⚠️ INV-22(c) — M-19 (25m) ≤ the elapsed wall-clock span of the scope (09:00 → 09:25 = 25m).
    expect(fixture.active.elapsedMs(context)).toBe(25 * 60_000);
    expect(overlap.dedupMs).toBeLessThanOrEqual(fixture.active.elapsedMs(context));

    // ⚠️ INV-23 — the payload that carries the binding-(C) figure carries its overlap.
    const tiles = fixture.analytics.overviewTiles(context);
    expect(tiles.activeSeconds).toBe(40 * MINUTE);
    expect(tiles.overlapSeconds).toBe(15 * MINUTE);
    // …and `q:disclosures` reports the SAME number for the same filter, so the tile's sub-line
    // and the disclosures panel can never say different things (§4.6).
    expect(fixture.analytics.disclosures(context).activeOverlapSeconds).toBe(15 * MINUTE);

    // ⚠️ INV-21 still holds in the presence of overlap: the tile is the sum of the working-day
    // rows. Two projects on one day → two rows of 20m each.
    const rows = fixture.analytics.workingDays(context, { limit: 100 }).rows;
    expect(rows.map((row) => row.activeSeconds)).toEqual([20 * MINUTE, 20 * MINUTE]);
    expect(tiles.activeSeconds).toBe(rows.reduce((total, row) => total + row.activeSeconds, 0));
  });

  it('zero case: two disjoint projects give total 40m, union 40m, overlap 0', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f13-overlap');
    const context = at(15, filterOn(fixture, '-work-demo-alpha', '-work-demo-gamma'));

    // alpha : [09:00,09:20] = 20m · gamma : [10:00,10:20] = 20m — no instant is in both.
    // total = 40m, union = 40m, overlap = 0.
    const overlap = fixture.active.overlap(context);
    expect(overlap.activeSeconds).toBe(40 * MINUTE);
    expect(overlap.dedupMs).toBe(40 * 60_000);
    expect(overlap.overlapSeconds).toBe(0);

    // §6.3: `overlapSeconds === 0` → the tile renders NOTHING extra. The payload still carries
    // the field (INV-23); it is the value `0` that suppresses the line, not a missing key.
    const tiles = fixture.analytics.overviewTiles(context);
    expect(tiles.overlapSeconds).toBe(0);
    expect(Object.hasOwn(tiles, 'overlapSeconds')).toBe(true);
  });

  it('single-project scope returns overlap 0 (INV-22(d))', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f13-overlap');
    const context = at(15, filterOn(fixture, '-work-demo-alpha'));

    // One project ⇒ exactly one partition per local day, and distinct days' covered intervals
    // cannot intersect, so M-20 is identically 0 — which is WHY §6.8 omits the disclosure from
    // the project card.
    const overlap = fixture.active.overlap(context);
    expect(overlap.activeSeconds).toBe(20 * MINUTE);
    expect(overlap.dedupMs).toBe(20 * 60_000);
    expect(overlap.overlapSeconds).toBe(0);
    expect(fixture.analytics.overviewTiles(context).overlapSeconds).toBe(0);
  });

  it('all three projects: total 60m, union 45m, overlap 15m', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f13-overlap');
    const context = at(15);

    // alpha 20m + beta 20m + gamma 20m = 60m.
    // Union = [09:00,09:25] (25m) ∪ [10:00,10:20] (20m) = 45m. Overlap = 60 − 45 = 15m.
    const overlap = fixture.active.overlap(context);
    expect(overlap.activeSeconds).toBe(60 * MINUTE);
    expect(overlap.dedupMs).toBe(45 * 60_000);
    expect(overlap.overlapSeconds).toBe(15 * MINUTE);
  });
});

describe("F-13 — ADR-037's worked counterexample: the obvious formulation of M-19 is wrong", () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('yields +5m, not the −5m the naive one-global-stream reading gives', async () => {
    assertTimezonePinned();
    const fixture = await loadFixture(sandbox, 'f13-counterexample');
    const context = at(15);

    // ADR-037, verbatim — cap 15m, two projects on one day, delta at 09:00 & 09:30, epsilon at
    // 09:10 & 09:40:
    //   binding (C), per-(day, project) sum : 15m + 15m                       = 30m
    //   ✗ naive "one global stream" M-07    : 09:00,09:10,09:30,09:40
    //                                         → 10 + 15 + 10                  = 35m → overlap −5m
    //   ✓ union of covered intervals        : [09:15,09:30] ∪ [09:25,09:40]
    //                                         = [09:15,09:40]                 = 25m → overlap +5m
    const overlap = fixture.active.overlap(context);
    expect(overlap.activeSeconds).toBe(30 * MINUTE);
    expect(overlap.dedupMs).toBe(25 * 60_000);
    expect(overlap.overlapSeconds).toBe(5 * MINUTE);

    // ⚠️ The whole point: the naive reading would produce 35m here, and 30 − 35 = −5m, breaking
    // INV-22(b) on a two-event-per-project fixture. Both halves are asserted so the wrong
    // implementation cannot be green.
    expect(overlap.dedupMs).not.toBe(35 * 60_000);
    expect(overlap.overlapSeconds).toBeGreaterThan(0);
  });
});
