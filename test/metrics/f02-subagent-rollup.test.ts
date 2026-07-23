// F-02 (§5.9.1) — **Subagent roll-up totals.** INV-02 exactly:
// `SUM(metric WHERE origin='main') + SUM(metric WHERE origin='subagent') = SUM(metric)`
// for M-02 (output tokens), M-04 (the four classes), M-11 (messages) and M-12 (tool calls) —
// "and that no event is counted twice".
//
// ⚠️ §5.10 calls INV-02 "the headline correctness risk". The failure it guards is subtle: a
// subagent transcript is a separate FILE whose records are stored once in `events` with
// `session_id` = the **parent** and `origin='subagent'` (ADR-020). Get the ingest wrong and the
// same work is either double-counted (once per file) or dropped from the roll-up.

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { at, loadFixture } from './support/metrics-harness';
import { usePinnedTimezone } from './support/pinned-tz';

describe('F-02 — main + subagent = total, exactly (INV-02)', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('splits M-02, M-04, M-11 and M-12 without losing or duplicating anything', async () => {
    const fixture = await loadFixture(sandbox, 'f02-rollup');
    const context = at(15);

    // The fixture, stated once so every expected value below is checkable by eye:
    //   MAIN transcript `sess-f02.jsonl`
    //     u1  user       (no usage)                                    → 1 message
    //     m1  assistant  in 100  out 200  cw 10  cr 1000 · 2 tool_use  → 1 message, 2 tool calls
    //     m2  assistant  in   7  out  11  cw  0  cr    3              → 1 message
    //   SUBAGENT transcript `sess-f02/subagents/run-1.jsonl`
    //     s1  assistant  in  20  out  30  cw  4  cr  500 · 1 tool_use  → 1 message, 1 tool call
    //     s2  user       (no usage)                                    → 1 message
    //     s3  assistant  in   1  out   2  cw  0  cr    0 · 1 tool_use  → 1 message, 1 tool call
    const split = fixture.analytics.originSplit(context);

    // M-02 — output tokens.  main 200 + 11 = 211 · subagent 30 + 2 = 32 · total 243
    expect(split.main.output).toBe(211);
    expect(split.subagent.output).toBe(32);
    // M-04 — the four classes, always four numbers, never one.
    //   input       main 107 · sub 21  · total 128
    //   cacheWrite  main  10 · sub  4  · total  14
    //   cacheRead   main 1003 · sub 500 · total 1503
    expect(split.main).toMatchObject({ input: 107, cacheWrite: 10, cacheRead: 1_003 });
    expect(split.subagent).toMatchObject({ input: 21, cacheWrite: 4, cacheRead: 500 });
    // M-11 — messages (`role IN ('assistant','user')`), both origins. main 3 · subagent 3
    expect(split.main.messages).toBe(3);
    expect(split.subagent.messages).toBe(3);
    // M-12 — tool calls, `Agent` and `Skill` included. main 2 (Agent, Read) · subagent 2
    expect(split.main.toolCalls).toBe(2);
    expect(split.subagent.toolCalls).toBe(2);

    // ⚠️ INV-02 as the invariant, against the UNPARTITIONED totals — not against restated
    // literals, so a change to the fixture cannot make the equality vacuous.
    const tiles = fixture.analytics.overviewTiles(context);
    const cache = fixture.analytics.cacheEfficiency(context);
    const fingerprint = fixture.analytics.toolFingerprint(context);

    expect(split.main.output + split.subagent.output).toBe(tiles.outputTokens); // M-02
    expect(split.main.input + split.subagent.input).toBe(cache.inputTokens); // M-04
    expect(split.main.cacheWrite + split.subagent.cacheWrite).toBe(cache.cacheWriteTokens);
    expect(split.main.cacheRead + split.subagent.cacheRead).toBe(cache.cacheReadTokens);
    expect(split.main.toolCalls + split.subagent.toolCalls).toBe(fingerprint.total); // M-12
    expect(split.main.toolCalls + split.subagent.toolCalls).toBe(tiles.toolCalls);

    // M-11 against the session row, which computes messages independently of the origin split.
    const sessions = fixture.analytics.sessions(context, { limit: 10 }, 'firstTs', 'asc');
    expect(sessions.page.rows).toHaveLength(1);
    expect(split.main.messages + split.subagent.messages).toBe(sessions.page.rows[0]?.messages);
  });

  it('stores every record exactly once — no event is counted twice (ADR-019/ADR-020)', async () => {
    const fixture = await loadFixture(sandbox, 'f02-rollup');

    // 6 records across two files, all attributed to ONE session by the path (§5.4 rule 5).
    const rows = fixture.db
      .prepare<{ events: number; keys: number; sessions: number }>(
        `SELECT COUNT(*) AS events, COUNT(DISTINCT event_key) AS keys,
                COUNT(DISTINCT session_id) AS sessions FROM events`,
      )
      .get();
    expect(rows).toEqual({ events: 6, keys: 6, sessions: 1 });

    // The subagent's records live under the PARENT session id, with `origin='subagent'` — the
    // single fact that makes the roll-up above a roll-up rather than two disjoint datasets.
    expect(
      fixture.db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM events WHERE origin = 'subagent' AND session_id = 'sess-f02'",
        )
        .get()?.n,
    ).toBe(3);
  });
});
