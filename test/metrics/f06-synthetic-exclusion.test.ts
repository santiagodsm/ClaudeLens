// F-06 (§5.9.1) — **`<synthetic>` exclusion.** Stored and counted; excluded from every
// token, cost and model statistic (M-01).
//
// §5.4 rule 7: "`is_synthetic` = `message.model === '<synthetic>'`. Such events are stored
// (so they can be counted and disclosed) and excluded from every token, cost and model
// statistic (M-01)."
//
// ⚠️ **The fixture must discriminate.** §2.1 describes a synthetic event as having zero
// usage, and a fixture built only from zero-usage synthetics would pass whether the exclusion
// exists or not. This one carries BOTH: a realistic zero-usage synthetic AND an adversarial
// one with large token counts, so the M-01 population is provably filtered by
// `is_synthetic`, not incidentally by the tokens being zero.
//
// ⚠️ M-07's active-time stream is E4's fixture (F-01), not this one — but the synthetic
// events' timestamps ARE in `events`, which is what keeps ADR-035 implementable ("Synthetic
// events are excluded from token statistics but **are** included here"). Asserted below so
// this epic cannot make E4's fixture impossible.

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { createSyncHarness, fixturePath } from '../support/sync-harness';

describe('F-06 — <synthetic> is stored, counted and excluded from token/model stats', () => {
  const sandbox = useSandbox();

  it('stores every synthetic event and excludes it from M-01', async () => {
    const root = await sandbox.copyFixture(fixturePath('f06-synthetic'), 'root');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    // sess-syn.jsonl has 4 records:
    //   n1  claude-test-1   in 100  out 200  cw   5  cr  50
    //   n2  <synthetic>     in   0  out   0  cw   0  cr   0     (realistic)
    //   n3  claude-test-2   in   7  out  11  cw   0  cr   0
    //   n4  <synthetic>     in 999  out 888  cw 777  cr 666     (adversarial)
    expect(harness.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(4);

    // §4.6 `Disclosures.syntheticEvents` — counted, never dropped.
    expect(
      harness.db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE is_synthetic = 1')
        .get()?.n,
    ).toBe(2);

    // M-01 — the countable population is `is_synthetic = 0`.
    // M-02 output tokens = 200 + 11 = 211.
    // Unfiltered it would be 211 + 888 = 1_099, so this assertion discriminates.
    const output = harness.db
      .prepare<{ filtered: number; unfiltered: number }>(
        `SELECT COALESCE(SUM(CASE WHEN is_synthetic = 0 THEN tok_output ELSE 0 END), 0) AS filtered,
                COALESCE(SUM(tok_output), 0) AS unfiltered
           FROM events`,
      )
      .get();
    expect(output?.filtered).toBe(211);
    expect(output?.unfiltered).toBe(1_099);

    // M-04 — the four class sums over M-01, always four numbers, never one.
    //   input       = 100 + 7 = 107
    //   output      = 200 + 11 = 211
    //   cache write =   5 + 0  =   5
    //   cache read  =  50 + 0  =  50
    const breakdown = harness.db
      .prepare<{ input: number; output: number; cacheWrite: number; cacheRead: number }>(
        `SELECT COALESCE(SUM(tok_input),0) AS input, COALESCE(SUM(tok_output),0) AS output,
                COALESCE(SUM(tok_cache_write),0) AS cacheWrite,
                COALESCE(SUM(tok_cache_read),0) AS cacheRead
           FROM events WHERE is_synthetic = 0`,
      )
      .get();
    expect(breakdown).toEqual({ input: 107, output: 211, cacheWrite: 5, cacheRead: 50 });

    // M-01 applied to model statistics: `<synthetic>` is not a model anyone ran.
    const models = harness.db
      .prepare<{ model: string }>(
        'SELECT DISTINCT model FROM events WHERE is_synthetic = 0 ORDER BY model',
      )
      .all();
    expect(models.map((row) => row.model)).toEqual(['claude-test-1', 'claude-test-2']);

    // …and the raw model string is stored verbatim (ADR-025: no normalization, no aliasing).
    expect(
      harness.db
        .prepare<{ model: string }>('SELECT model FROM events WHERE event_key = ?')
        .get('n2')?.model,
    ).toBe('<synthetic>');
  });

  it('keeps synthetic timestamps in the event stream, so M-07 can include them (ADR-035)', async () => {
    const root = await sandbox.copyFixture(fixturePath('f06-synthetic'), 'root');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    // 09:00, 09:05, 09:10, 09:15 UTC on 2024-05-01. 09:00:00Z = 1_714_554_000_000;
    // each step is +5 min = +300_000 ms.
    const stream = harness.db
      .prepare<{ ts: number }>('SELECT ts FROM events ORDER BY ts')
      .all()
      .map((row) => row.ts);
    expect(stream).toEqual([
      1_714_554_000_000, 1_714_554_300_000, 1_714_554_600_000, 1_714_554_900_000,
    ]);
  });
});
