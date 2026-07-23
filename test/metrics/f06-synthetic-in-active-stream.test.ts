// F-06 (§5.9.1), E4's half — **`<synthetic>` events are INCLUDED in M-07's stream** while
// remaining excluded from every token, cost and model statistic (M-01).
//
// E3's `f06-synthetic-exclusion.test.ts` proves the exclusion. This proves the inclusion, which
// is the other half of the same sentence in M-07: "Synthetic events (M-01) are excluded from
// token statistics but **are** included here: they are real moments in the stream" (ADR-035).
//
// The fixture (`test/fixtures/f06-synthetic`) is deliberately shaped so the two readings give
// different numbers:
//   09:00 real · 09:05 <synthetic> · 09:10 real · 09:15 <synthetic>

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { at, loadFixture } from './support/metrics-harness';
import { usePinnedTimezone } from './support/pinned-tz';

describe('F-06 (E4 half) — synthetic events count as moments, not as tokens', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('includes <synthetic> timestamps in M-07 while excluding their tokens (M-01)', async () => {
    const fixture = await loadFixture(sandbox, 'f06-synthetic');
    const context = at(15);

    // ── Hand-computed expected value ────────────────────────────────────────────────────
    // Stream WITH synthetics (the decided reading): 09:00, 09:05, 09:10, 09:15
    //   0 + 5m + 5m + 5m = 15m = 900 s
    // Stream WITHOUT synthetics (the rejected reading): 09:00, 09:10
    //   0 + 10m = 10m = 600 s
    expect(fixture.active.bySession(context)[0]?.activeSeconds).toBe(900);
    expect(fixture.active.bySession(context)[0]?.activeSeconds).not.toBe(600);
    expect(fixture.analytics.overviewTiles(context).activeSeconds).toBe(900);

    // …and the same events are still absent from every token statistic (M-01).
    // Output tokens: 200 (claude-test-1) + 11 (claude-test-2) = 211. The adversarial synthetic
    // carries 888 output tokens, so an unfiltered sum would be 1_099.
    const tiles = fixture.analytics.overviewTiles(context);
    expect(tiles.outputTokens).toBe(211);
    expect(tiles.outputTokens).not.toBe(1_099);

    // …and they are DISCLOSED rather than silently dropped (§4.6).
    expect(fixture.analytics.disclosures(context).syntheticEvents).toBe(2);
  });

  it('keeps `<synthetic>` out of the model timeline (M-01 covers model statistics too)', async () => {
    const fixture = await loadFixture(sandbox, 'f06-synthetic');
    const timeline = fixture.analytics.modelMixTimeline(at(15), 'day');
    expect(timeline.series.map((series) => series.model)).toEqual([
      'claude-test-1',
      'claude-test-2',
    ]);
  });
});
