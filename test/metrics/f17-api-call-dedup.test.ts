// F-17 (§5.9.1, ADR-042) — **one row per API call.** Claude Code writes one assistant API call as
// several JSONL lines that share one `message.id` and repeat — or, while streaming, progressively
// accumulate — the same `usage`. Every metric that SUMS token usage or costs it must count each
// call ONCE, using its final line's authoritative usage. This is the fixture that pins that, and it
// is the one fixture whose expected numbers MOVED when the rule was applied (they had to — the
// behaviour changed). Every expected value below is hand-computed, with the arithmetic in a comment,
// exactly as CLAUDE.md §1 requires; `toMatchSnapshot()` is banned here.
//
// ⚠️ **The fixture must DISCRIMINATE.** A fixture in which every call is a single line would pass
// whether or not the collapse exists. `sess-dedup.jsonl` therefore carries:
//   · msgA — a 3-line STREAMING call whose usage VARIES across its lines (output 10 → 40 → 90):
//     the naive per-line sum triple-counts it, and picking any non-final line gets it wrong.
//   · msgB — a 2-line call with IDENTICAL repeated usage (the common non-streaming repeat).
//   · msgC — a single-line call (the trivial case, must be untouched).
//   · n7, n8 — two assistant records that state NO `message.id`: each is its OWN call and they must
//     NOT be folded together (folding NULL keys would collapse unrelated calls and shrink totals).
//   · n0 — a `user` record (no id, no usage): proves the per-line MESSAGE count is left alone.
//
// The parser is the real one (STACK ADR-013): `message.id` → `events.message_id`, absent → NULL.

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { API_CALL_ROWS_CTE } from '../../src/main/db/repositories/api-call-usage';
import { CostRepository } from '../../src/main/db/repositories/cost';
import { EventStatsRepository } from '../../src/main/db/repositories/event-stats';
import { ALL, at, loadFixture } from './support/metrics-harness';
import { usePinnedTimezone } from './support/pinned-tz';

/** `$1.00 / Mtok` on every class = 1_000_000 picoUSD per token (ADR-023). */
const ONE_USD_PER_MTOK_PICO = 1_000_000;

describe('F-17 — one API call is summed once, at its final line (ADR-042)', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('collapses repeated/streaming usage to one row per call; leaves per-line counts alone', async () => {
    const fixture = await loadFixture(sandbox, 'f17-api-call-dedup');
    const events = new EventStatsRepository(fixture.db);
    const context = at(15);

    // ── Storage is NOT deduplicated (ADR-019 unchanged) ──────────────────────────────────
    // 9 lines → 9 rows: 1 user + 8 assistant. `event_key` differs on every one; the dedup is a
    // QUERY-time projection, so a rebuild reproduces these 9 rows byte-for-byte.
    expect(fixture.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(9);

    // ── The seam: one row per API call ───────────────────────────────────────────────────
    // message_id groups:  msgA {n1,n2,n3}, msgB {n4,n5}, msgC {n6}
    // message_id IS NULL: n0 (user), n7, n8  — each its OWN call
    // ADR-042: each group → its FINAL line (greatest line_no); each NULL row stays separate.
    //   6 calls total: msgA→n3, msgB→n5, msgC→n6, and n0, n7, n8.
    const dedupCount = fixture.db
      .prepare<{ n: number }>(`WITH ${API_CALL_ROWS_CTE} SELECT COUNT(*) AS n FROM api_call_rows`)
      .get()?.n;
    expect(dedupCount).toBe(6);

    // The three NULL-keyed rows are each kept — NOT folded into one. This is the assertion that a
    // pre-migration database (every row NULL) is counted line-for-line, not silently merged.
    const nullCalls = fixture.db
      .prepare<{ n: number }>(
        `WITH ${API_CALL_ROWS_CTE} SELECT COUNT(*) AS n FROM api_call_rows WHERE message_id IS NULL`,
      )
      .get()?.n;
    expect(nullCalls).toBe(3);

    // The surviving row of each multi-line group is its LAST line, by line_no.
    const survivors = fixture.db
      .prepare<{ uuid: string }>(
        `WITH ${API_CALL_ROWS_CTE}
         SELECT uuid FROM api_call_rows WHERE message_id IS NOT NULL ORDER BY message_id`,
      )
      .all()
      .map((row) => row.uuid);
    expect(survivors).toEqual(['n3', 'n5', 'n6']); // msgA→n3, msgB→n5, msgC→n6

    // ── Cross-check (ADR-042): for a CUMULATIVE-streaming call, the per-class MAX across the
    //    group equals the FINAL line's values. If they ever diverged that is a finding to
    //    SURFACE, not to average over. msgA is the streaming call. ─────────────────────────
    //   msgA lines:  input 100,100,100 · output 10,40,90 · cache_write 0,0,20 · cache_read 1000×3
    //   per-class MAX =  input 100 · output 90 · cache_write 20 · cache_read 1000
    //   final line n3 =  input 100 · output 90 · cache_write 20 · cache_read 1000   → they AGREE
    const maxRow = fixture.db
      .prepare<{ mi: number; mo: number; mcw: number; mcr: number }>(
        `SELECT MAX(tok_input) AS mi, MAX(tok_output) AS mo,
                MAX(tok_cache_write) AS mcw, MAX(tok_cache_read) AS mcr
           FROM events WHERE message_id = 'msgA'`,
      )
      .get();
    const finalRow = fixture.db
      .prepare<{ i: number; o: number; cw: number; cr: number }>(
        `SELECT tok_input AS i, tok_output AS o, tok_cache_write AS cw, tok_cache_read AS cr
           FROM events WHERE message_id = 'msgA' ORDER BY line_no DESC LIMIT 1`,
      )
      .get();
    expect(maxRow).toEqual({ mi: 100, mo: 90, mcw: 20, mcr: 1000 });
    expect({ i: maxRow?.mi, o: maxRow?.mo, cw: maxRow?.mcw, cr: maxRow?.mcr }).toEqual(finalRow);

    // ── Deduped token totals (M-02/M-04), from the FINAL line of each call ────────────────
    //   A(n3)  input 100  output 90  cache_write 20  cache_read 1000
    //   B(n5)  input  50  output  7  cache_write  0  cache_read  200
    //   C(n6)  input   8  output  5  cache_write  3  cache_read    0
    //   D1(n7) input   4  output  2  cache_write  0  cache_read    0
    //   D2(n8) input   6  output  3  cache_write  0  cache_read    0   (n0 user: no usage)
    //   input       = 100 + 50 + 8 + 4 + 6      = 168
    //   output      =  90 +  7 + 5 + 2 + 3      = 107
    //   cache_write =  20 +  0 + 3 + 0 + 0      =  23
    //   cache_read  = 1000 + 200 + 0 + 0 + 0    = 1200
    const totals = events.tokenTotals(context);
    expect(totals.input).toBe(168);
    expect(totals.output).toBe(107);
    expect(totals.cacheWrite).toBe(23);
    expect(totals.cacheRead).toBe(1200);

    // Discrimination — the NAIVE per-line sum (what shipped before ADR-042). If the seam were
    // bypassed these are the numbers that would appear, so asserting the deduped total differs
    // from them proves the fixture exercises the collapse rather than passing incidentally.
    //   naive output = (10+40+90) + (7+7) + 5 + 2 + 3 = 140 + 14 + 5 + 2 + 3 = 164
    //   naive input  = 100×3 + 50×2 + 8 + 4 + 6       = 300 + 100 + 18       = 418
    const naive = fixture.db
      .prepare<{ i: number; o: number }>(
        `SELECT COALESCE(SUM(tok_input),0) AS i, COALESCE(SUM(tok_output),0) AS o
           FROM events WHERE is_synthetic = 0`,
      )
      .get();
    expect(naive).toEqual({ i: 418, o: 164 });
    expect(totals.output).not.toBe(naive?.o);

    // ── Per-line metrics are UNCHANGED (ADR-042 dedupes SUMS only) ────────────────────────
    // M-11 message count = every row with role in (assistant,user) = 8 assistant + 1 user = 9.
    // NOT the 6 deduped calls: a message count is a count of records, and deduping it would be a
    // second wrong number in the opposite direction. This is the pinned per-line invariant.
    expect(events.counts(context).messages).toBe(9);
  });

  it('costs each API call once (M-05)', async () => {
    const fixture = await loadFixture(sandbox, 'f17-api-call-dedup');
    const insert = fixture.db.prepare(
      `INSERT INTO price_rows (model, token_class, rate_picousd_per_token, valid_from, valid_to,
         source, created_at, updated_at)
       VALUES (?, ?, ?, 0, NULL, 'manual', 0, 0)`,
    );
    for (const tokenClass of ['input', 'output', 'cache_write', 'cache_write_1h', 'cache_read']) {
      insert.run('claude-test-1', tokenClass, ONE_USD_PER_MTOK_PICO);
    }

    // M-05 over the DEDUPED population, at $1/Mtok on every class. Per costed call, tokens summed:
    //   A(n3)  100 + 90 + 20 + 1000 = 1210
    //   B(n5)   50 +  7 +  0 +  200 =  257
    //   C(n6)    8 +  5 +  3 +    0 =   16
    //   D1(n7)   4 +  2 +  0 +    0 =    6
    //   D2(n8)   6 +  3 +  0 +    0 =    9
    //   deduped tokens = 1210 + 257 + 16 + 6 + 9 = 1498
    //   cost = 1498 × 1_000_000 picoUSD = 1_498_000_000 picoUSD  (→ 1_498_000 nanoUSD, $0.001498)
    // The naive per-line cost would be 4_005 tokens → 4_005_000_000 picoUSD, ~2.7× higher.
    const result = new CostRepository(fixture.db).totals(ALL);
    expect(result.costPicoUsd).toBe(1_498_000_000n);
    // 5 costed CALLS (A,B,C,D1,D2), not 8 costed lines. The user row (no model, no tokens) is not
    // priceable, so it is neither costed nor uncosted (M-01/M-06).
    expect(result.costedEvents).toBe(5);
    expect(result.uncostedEvents).toBe(0);
  });
});
