// A-11 (PROGRESS.md amendment log) — **Context overhead.** The panel that replaced the
// cache-efficiency gauge (user directive 2026-07-22). It reports two raw token totals plus a
// leaderboard of the heaviest sessions by cache-read tokens.
//
//   contextOverhead ratio = cacheReadTokens / outputTokens
//   over the filtered, non-synthetic population (M-01); UNDEFINED when outputTokens = 0
//   (shown as "no output tokens", never 0). ⚠️ The ratio is DERIVED IN THE RENDERER, never on
//   the wire — this payload carries only the two raw totals and the leaderboard, so the golden
//   values below are the numerator, the denominator and the ordering, hand-computed.
//
// ⚠️ Inline hand-computed expecteds with the arithmetic in comments; no snapshot (CLAUDE.md §1).

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { ALL, at, loadFixture } from './support/metrics-harness';
import { usePinnedTimezone } from './support/pinned-tz';

describe('A-11 — context overhead: two raw totals and the cache-read leaderboard', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  // The fixture, stated once so every expected value below is checkable by eye. Three projects,
  // one session each, one assistant event each (all non-synthetic, model priced or not is
  // irrelevant — this metric is token counts, not money):
  //   demo-alpha  sess-inv11-a  output 300000  cache_read 90500  ts 2024-05-01T09:00:00Z
  //   demo-beta   sess-inv11-b  output 300000  cache_read 60500  ts 2024-05-01T09:01:00Z
  //   demo-gamma  sess-inv11-c  output 400000  cache_read 40500  ts 2024-05-01T09:02:00Z
  // ⚠️ `-work-demo-alpha` has no `cwd`, so its display name is the decoded last segment: 'alpha'.

  it('sums the two grounding totals and grounds them against the independent cache method', async () => {
    const fixture = await loadFixture(sandbox, 'inv11-money-boundary');
    const overhead = fixture.analytics.contextOverhead(at(15));

    // cacheReadTokens = 90500 + 60500 + 40500 = 191500
    expect(overhead.cacheReadTokens).toBe(191_500);
    // outputTokens = 300000 + 300000 + 400000 = 1000000
    expect(overhead.outputTokens).toBe(1_000_000);

    // Discriminator: the two totals are different quantities, never the same column read twice.
    expect(overhead.cacheReadTokens).not.toBe(overhead.outputTokens);

    // Grounded against the SAME totals the cache-efficiency method reads on, so the panel's
    // output figure can never disagree with the rest of the Tokens view.
    const cache = fixture.analytics.cacheEfficiency(at(15));
    expect(overhead.cacheReadTokens).toBe(cache.cacheReadTokens);
    expect(overhead.outputTokens).toBe(cache.outputTokens);
  });

  it('ranks the leaderboard by cache-read DESC — NOT by output', async () => {
    const fixture = await loadFixture(sandbox, 'inv11-money-boundary');
    const { sessions } = fixture.analytics.contextOverhead(at(15));

    // Three sessions, all inside the top ten.
    expect(sessions).toHaveLength(3);

    // Cache-read DESC: alpha (90500) > beta (60500) > gamma (40500).
    expect(sessions.map((s) => s.label)).toEqual(['alpha', 'beta', 'gamma']);
    expect(sessions.map((s) => s.cacheReadTokens)).toEqual([90_500, 60_500, 40_500]);
    // Each row carries its own output too: alpha 300000, beta 300000, gamma 400000.
    expect(sessions.map((s) => s.outputTokens)).toEqual([300_000, 300_000, 400_000]);

    // ⚠️ DISCRIMINATOR. gamma has the MOST output (400000) but the LEAST cache-read (40500). If
    // the leaderboard were ordered by output (the wrong reading), gamma would be first. It is
    // last, which is the whole point of ranking by re-read volume rather than by output.
    expect(sessions[0]?.label).not.toBe('gamma');
    expect(sessions[0]?.label).toBe('alpha');

    // The leaderboard sums back to the two totals (only three sessions, all present).
    expect(sessions.reduce((sum, s) => sum + s.cacheReadTokens, 0)).toBe(191_500);
    expect(sessions.reduce((sum, s) => sum + s.outputTokens, 0)).toBe(1_000_000);

    // startedAt is the session's own event timestamp (UTC epoch ms), never defaulted to "now".
    expect(sessions[0]?.startedAt).toBe(Date.UTC(2024, 4, 1, 9, 0, 0));

    // §1a — `key` is a session id for identity only; `label` is a project NAME, never an id or
    // an encoded path. No row's visible label is the raw session id or the encoded folder name.
    for (const s of sessions) {
      expect(s.label).not.toContain('sess-');
      expect(s.label).not.toContain('-work-');
    }
  });

  it('⚠️ returns raw 0 for output with no fabricated ratio when the scope is empty (divide-by-zero)', async () => {
    const fixture = await loadFixture(sandbox, 'inv11-money-boundary');
    // An explicit empty project selection selects nothing (scope.ts's `1 = 0`), so both totals
    // are a real, measured 0. This is the outputTokens = 0 case: the renderer shows "no output
    // tokens", but the PAYLOAD must carry the honest 0 and must NOT pre-divide it into a ratio.
    const empty = fixture.analytics.contextOverhead(at(15, { ...ALL, projectIds: [] }));

    expect(empty.outputTokens).toBe(0);
    expect(empty.cacheReadTokens).toBe(0);
    expect(empty.sessions).toEqual([]);

    // The payload carries the two raw totals only — it never fabricates a quotient (which over a
    // zero denominator would be NaN or Infinity). Ratio computation lives in the renderer.
    expect(empty).not.toHaveProperty('ratio');
    expect(empty).not.toHaveProperty('hitRatio');
  });
});
