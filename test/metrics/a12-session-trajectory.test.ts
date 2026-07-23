// A-12 (PROGRESS.md amendment log) — **Session efficiency over time.** The per-turn trajectory that
// lets a user see when a session is worth a `/clear` or `/compact`. Two halves are pinned here:
//
//   1. the RAW per-turn series the repository returns (query-time only, ADR-027), and
//   2. the baseline / decay / verdict math (`src/shared/trajectory.ts`), which is the ONE definition
//      the renderer colours from — imported here so the golden values are checked against the exact
//      code that ships, not a paraphrase.
//
// ⚠️ Inline hand-computed expecteds with the arithmetic in comments; no snapshot (CLAUDE.md §1).
//
// The fixture (`test/fixtures/trajectory`), stated once so every number below is checkable by eye:
//   demo-alpha  sess-traj   seven MAIN assistant turns + ONE subagent turn (excluded), 09:00–09:07:
//       ctx  1000 2000 4000 8000 16000    0  32000   (turn 6 has zero context — a divide-by-zero)
//       out   500  500  500  400   320    0    320
//     subagent (09:03): input 500, out 100, cache_read 2000  → counts to totals, excluded from turns
//   demo-beta   sess-short  TWO main turns (ctx 1000/1500, out 500/400) — too short to judge

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { ALL, at, loadFixture } from './support/metrics-harness';
import { usePinnedTimezone } from './support/pinned-tz';
import {
  analyseTrajectory,
  efficiencyLostPercent,
  efficiencyOf,
  greyReasonOf,
  isLive,
  isRecent,
  lastN,
  verdictOf,
  LIVE_WINDOW_MS,
  RECENT_WINDOW_MS,
} from '../../src/shared/trajectory';
import { SessionStatsRepository } from '../../src/main/db/repositories/session-stats';

describe('A-12 — session trajectory: the raw per-turn series', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('returns MAIN assistant turns only, in order, with the zero-context turn kept as 0', async () => {
    const fixture = await loadFixture(sandbox, 'trajectory');
    const { sessions } = fixture.analytics.contextOverhead(at(15));

    // Ordered by cache-read DESC: alpha (59000, incl. subagent) before beta (500).
    expect(sessions.map((s) => s.label)).toEqual(['alpha', 'beta']);
    const alpha = sessions[0];
    if (alpha === undefined) throw new Error('fixture regressed: no alpha session');

    // Seven MAIN turns — the subagent turn is EXCLUDED (it runs a separate context, ADR-020).
    // Discriminator: eight would mean the subagent turn leaked into the main trajectory.
    expect(alpha.turns).toHaveLength(7);
    expect(alpha.turns.map((t) => t.context)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 0, 32_000,
    ]);
    expect(alpha.turns.map((t) => t.output)).toEqual([500, 500, 500, 400, 320, 0, 320]);

    // ⚠️ The zero-context turn is carried as a real measured point (context 0), NOT dropped and NOT
    // turned into a fabricated efficiency — the renderer decides how to treat it (§1).
    expect(alpha.turns[5]).toEqual({ context: 0, output: 0 });

    // The excluded subagent turn is disclosed honestly rather than silently dropped (§4.6).
    expect(alpha.subagentTurns).toBe(1);

    // startedAt = first event (09:00 UTC); never defaulted to "now" (§1).
    expect(alpha.startedAt).toBe(Date.UTC(2024, 4, 1, 9, 0, 0));
    // lastActivityTs = the last MAIN turn (09:07), not the earlier subagent (09:03) and not the
    // start. Discriminator: it is a distinct, measured maximum, not a copy of startedAt.
    expect(alpha.lastActivityTs).toBe(Date.UTC(2024, 4, 1, 9, 7, 0));
    expect(alpha.lastActivityTs).not.toBe(alpha.startedAt);

    // Both totals roll up BOTH origins (ADR-020): the subagent's cache_read (2000) and output (100)
    // are in the session's totals. Discriminator: main-only would give 57000 / 2540.
    expect(alpha.cacheReadTokens).toBe(59_000);
    expect(alpha.cacheReadTokens).not.toBe(57_000);
    expect(alpha.outputTokens).toBe(2_640);
  });

  it('leaves both totals a real 0 with no sessions when the scope is empty', async () => {
    const fixture = await loadFixture(sandbox, 'trajectory');
    const empty = fixture.analytics.contextOverhead(at(15, { ...ALL, projectIds: [] }));
    expect(empty.outputTokens).toBe(0);
    expect(empty.sessions).toEqual([]);
  });

  it('⚠️ includes a low-cache-read session BECAUSE it is the most recent (heaviest ∪ recent)', async () => {
    // In the fixture, `beta` has a tiny cache-read (500) but the LATEST activity (10:01 > alpha's
    // 09:07). With a heaviest limit of 1, a pure heaviest list would return ONLY alpha and silently
    // drop beta — the §1 gap. The union must keep beta because it is the most-recently-active.
    const fixture = await loadFixture(sandbox, 'trajectory');
    const sessions = new SessionStatsRepository(fixture.db).heaviestAndRecentSessions(at(15), 1);

    const labels = sessions.map((s) => s.label);
    // Both present: alpha (heaviest top-1) ∪ beta (most-recent top-1).
    expect(labels).toContain('alpha');
    expect(labels).toContain('beta');
    // ⚠️ Discriminator: beta is here despite its tiny cache-read (500) — recency, not weight.
    const beta = sessions.find((s) => s.label === 'beta');
    const alpha = sessions.find((s) => s.label === 'alpha');
    expect(beta?.cacheReadTokens).toBe(500);
    expect(beta?.lastActivityTs).toBeGreaterThan(alpha?.lastActivityTs ?? 0);
    // The heaviest still leads the result (ordered cache-read DESC).
    expect(sessions[0]?.label).toBe('alpha');
  });
});

describe('A-12 — live / recent windows (presentational, boundary-pinned)', () => {
  const NOW = 1_700_000_000_000; // an arbitrary fixed instant

  it('isLive / isRecent boundaries, the one-hour constant, and the future-skew guard', () => {
    expect(LIVE_WINDOW_MS).toBe(5 * 60 * 1000);
    expect(RECENT_WINDOW_MS).toBe(60 * 60 * 1000);

    // Exactly at the 5-minute live boundary: NOT live (strict <) and NOT recent (strict >).
    expect(isLive(NOW - LIVE_WINDOW_MS, NOW)).toBe(false);
    expect(isRecent(NOW - LIVE_WINDOW_MS, NOW)).toBe(false);
    // Just past the live window → recent, not live.
    expect(isLive(NOW - LIVE_WINDOW_MS - 1, NOW)).toBe(false);
    expect(isRecent(NOW - LIVE_WINDOW_MS - 1, NOW)).toBe(true);
    // Inside the live window → live, never also recent.
    expect(isLive(NOW - 60_000, NOW)).toBe(true);
    expect(isRecent(NOW - 60_000, NOW)).toBe(false);
    // Exactly at the 60-minute recent boundary: still recent (inclusive).
    expect(isRecent(NOW - RECENT_WINDOW_MS, NOW)).toBe(true);
    // Just past the recent window → neither.
    expect(isRecent(NOW - RECENT_WINDOW_MS - 1, NOW)).toBe(false);
    expect(isLive(NOW - RECENT_WINDOW_MS - 1, NOW)).toBe(false);
    // ⚠️ A future lastActivityTs (clock skew) is neither live nor recent — never trusted.
    expect(isLive(NOW + 60_000, NOW)).toBe(false);
    expect(isRecent(NOW + 60_000, NOW)).toBe(false);
  });
});

describe('A-12 — session trajectory: baseline, decay and verdict (the shipped math)', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('lastN crops to the last N as a pure view slice — never pads, never re-measures', () => {
    const xs = [1, 2, 3, 4, 5];
    // Whole session (null) or N ≥ length → every item, unchanged.
    expect(lastN(xs, null)).toEqual([1, 2, 3, 4, 5]);
    expect(lastN(xs, 10)).toEqual([1, 2, 3, 4, 5]);
    // The last N, in order.
    expect(lastN(xs, 2)).toEqual([4, 5]);
    expect(lastN(xs, 3)).toEqual([3, 4, 5]);
    // ⚠️ It returns the SAME values, sliced — a view crop, never a fabricated or re-measured value.
    expect(lastN(xs, 10)).toHaveLength(5); // fewer than N → all, no padding
  });

  it('efficiencyLostPercent — the fixed 0–100% "lost" transform, with the ≥100% cap', () => {
    // (1 − min(decay, 1)) × 100, clamped to [0, 100].
    expect(efficiencyLostPercent(1)).toBe(0); // as efficient as its start → 0% lost
    expect(efficiencyLostPercent(0.4)).toBe(60); // the default flag (0.40 retained) → 60% lost
    expect(efficiencyLostPercent(0)).toBe(100); // no efficiency left → 100% lost
    // ⚠️ The cap that fixes the readability bug: a turn BETTER than its start (decay 2 → 200% "of
    // start") is still 0% lost, so early turns sit flat at the bottom instead of blowing the axis
    // past 100%. Discriminator: it is NOT a negative "lost".
    expect(efficiencyLostPercent(2)).toBe(0);
    expect(efficiencyLostPercent(2)).not.toBeLessThan(0);
  });

  it('excludes the zero-context turn from the ratio — it is null, never 0', () => {
    // The divide-by-zero guard, in isolation: a zero-context turn has NO efficiency.
    expect(efficiencyOf({ context: 0, output: 0 })).toBeNull();
    // Discriminator: a naive `output / context` would be NaN; a fabricated reading would be 0.
    expect(efficiencyOf({ context: 0, output: 0 })).not.toBe(0);
    expect(efficiencyOf({ context: 4_000, output: 500 })).toBe(0.125);
  });

  it('forms the baseline from the first three eligible turns and decays against it', async () => {
    const fixture = await loadFixture(sandbox, 'trajectory');
    const alpha = fixture.analytics.contextOverhead(at(15)).sessions[0];
    if (alpha === undefined) throw new Error('fixture regressed: no alpha session');

    const trajectory = analyseTrajectory(alpha.turns);

    // Six turns have context > 0; the seventh (context 0) is skipped and counted, not dropped.
    expect(trajectory.eligibleTurns).toBe(6);
    expect(trajectory.skippedZeroContext).toBe(1);
    expect(trajectory.points).toHaveLength(7);
    // The zero-context point carries a null efficiency, not a 0 (the divide-by-zero discriminator).
    expect(trajectory.points[5]?.efficiency).toBeNull();

    // baseline = median of the first three eligible efficiencies [0.5, 0.25, 0.125] = 0.25 (exact).
    expect(trajectory.baseline).toBe(0.25);
  });

  it('⚠️ a declining session is RED at the default threshold and recolours with the slider', async () => {
    const fixture = await loadFixture(sandbox, 'trajectory');
    const alpha = fixture.analytics.contextOverhead(at(15)).sessions[0];
    if (alpha === undefined) throw new Error('fixture regressed: no alpha session');
    const trajectory = analyseTrajectory(alpha.turns);

    // Verdict = band of the median decay over the last three eligible turns. Their efficiencies are
    // 0.05, 0.02, 0.01 → decays /0.25 = 0.20, 0.08, 0.04 → median 0.08. 0.08 < 0.40 → RED.
    expect(verdictOf(trajectory, 0.4)).toBe('red');
    // Discriminators: it is judged (six eligible turns), so NOT grey; and it is declining, NOT green.
    expect(verdictOf(trajectory, 0.4)).not.toBe('grey');
    expect(verdictOf(trajectory, 0.4)).not.toBe('green');

    // ⚠️ The whole point of the slider: drop the threshold below the recent decay (0.08) and the
    // same session recolours to amber — instantly, from the same raw series, no re-query.
    expect(verdictOf(trajectory, 0.05)).toBe('amber');
  });

  it('⚠️ a too-short session is GREY "too short to judge", never a fabricated red', async () => {
    const fixture = await loadFixture(sandbox, 'trajectory');
    const beta = fixture.analytics.contextOverhead(at(15)).sessions[1];
    if (beta === undefined) throw new Error('fixture regressed: no beta session');
    const trajectory = analyseTrajectory(beta.turns);

    // Two eligible turns < the five-turn gate → no verdict is invented.
    expect(trajectory.baseline).toBeNull();
    expect(greyReasonOf(trajectory)).toBe('too-short');
    expect(verdictOf(trajectory, 0.4)).toBe('grey');
    // Discriminator: the mandatory honesty guard — a short session is never painted red or green.
    expect(verdictOf(trajectory, 0.4)).not.toBe('red');
    expect(verdictOf(trajectory, 0.4)).not.toBe('green');
  });
});

describe('A-12 — the two grey reasons are load-bearing (review follow-up)', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  // The fixture (`test/fixtures/trajectory-grey`):
  //   demo-delta   sess-gate    FOUR eligible turns, outputs 500/500/500/40, cache_read → 11000
  //   demo-epsilon sess-nobase  FIVE eligible turns, first three write NOTHING, cache_read → 26000

  it('⚠️ the minimum-turns gate: a 4-eligible-turn session with a REAL baseline is grey', async () => {
    const fixture = await loadFixture(sandbox, 'trajectory-grey');
    const gate = fixture.analytics
      .contextOverhead(at(15))
      .sessions.find((s) => s.label === 'delta');
    if (gate === undefined) throw new Error('fixture regressed: no delta session');
    const trajectory = analyseTrajectory(gate.turns);

    // ⚠️ Four eligible turns, baseline = median(0.5, 0.25, 0.125) = 0.25 (> 0). So `baseline` is
    // NOT null and is NOT the reason this is grey — ONLY the five-turn gate is. Without the gate,
    // the recent decays [1.0, 0.5, 0.02] have median 0.5 → the wrong reading colours it AMBER.
    expect(trajectory.eligibleTurns).toBe(4);
    expect(trajectory.baseline).toBe(0.25);
    expect(greyReasonOf(trajectory)).toBe('too-short');
    expect(verdictOf(trajectory, 0.4)).toBe('grey');
    // ⚠️ Discriminators — the gate must be load-bearing. Remove `eligibleTurns < MIN_ELIGIBLE_TURNS`
    // and this session turns amber; so it must be NONE of the coloured verdicts.
    expect(verdictOf(trajectory, 0.4)).not.toBe('amber');
    expect(verdictOf(trajectory, 0.4)).not.toBe('red');
    expect(verdictOf(trajectory, 0.4)).not.toBe('green');
  });

  it('⚠️ a degenerate ZERO baseline is grey for the "no-baseline" reason, with turns to spare', async () => {
    const fixture = await loadFixture(sandbox, 'trajectory-grey');
    const nobase = fixture.analytics
      .contextOverhead(at(15))
      .sessions.find((s) => s.label === 'epsilon');
    if (nobase === undefined) throw new Error('fixture regressed: no epsilon session');
    const trajectory = analyseTrajectory(nobase.turns);

    // Five eligible turns — PAST the gate — but the first three wrote nothing, so the starting
    // efficiency is 0 and there is no baseline to decay from. Grey, but for a different reason.
    expect(trajectory.eligibleTurns).toBe(5);
    expect(trajectory.baseline).toBe(0);
    // ⚠️ The discriminator that stops the panel lying: this is 'no-baseline', NOT 'too-short'. A
    // reason of 'too-short' here would print "too few turns" over a session with plenty of them.
    expect(greyReasonOf(trajectory)).toBe('no-baseline');
    expect(greyReasonOf(trajectory)).not.toBe('too-short');
    expect(verdictOf(trajectory, 0.4)).toBe('grey');
    expect(verdictOf(trajectory, 0.4)).not.toBe('red');
  });
});
