// F-05 (§5.9.1) — **malformed JSON lines.** "Counted, skipped, never fatal, disclosed."
//
// §5.4 rule 1: "A line that fails `JSON.parse` increments `file_manifest.bad_lines`, is
// skipped, and is **never fatal**. Bad lines are disclosed (§4.6)."
// §5.4 rule 2: "A record with no parseable timestamp is skipped and counted as a bad line."
//
// ⚠️ The failure this fixture guards against is not a crash — it is a parser that swallows a
// bad line silently, so the totals are short by an amount nobody can see. Incompleteness is
// data in the success payload (CLAUDE.md §1), which here means `bad_lines` on the manifest,
// the cycle's `SyncState.badLines`, and `Disclosures.badLines` downstream.

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { createSyncHarness, fixturePath } from '../support/sync-harness';

describe('F-05 — malformed JSON lines', () => {
  const sandbox = useSandbox();

  it('counts and skips them, ingests the rest, and never fails the cycle', async () => {
    const root = await sandbox.copyFixture(fixturePath('f05-malformed'), 'root');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    // The cycle reached IDLE. A malformed line is NEVER fatal (§5.4 rule 1) — `FAILED` here
    // would take the other four lines down with it.
    const state = harness.cycle.state();
    expect(state.phase).toBe('idle');
    expect(state.error).toBeNull();

    // sess-bad.jsonl has 5 physical lines:
    //   1  g1  valid, ISO timestamp                    -> event
    //   2      truncated JSON, no closing brace        -> bad (malformed_json)
    //   3      `[1,2,3]` — valid JSON, not an object   -> bad (not_an_object)
    //   4  g3  valid object, NO timestamp              -> bad (no_timestamp)
    //   5  g4  valid, ISO timestamp                    -> event
    // => lines_parsed 5, bad_lines 3, events 2
    const manifest = harness.db
      .prepare<{
        lines_parsed: number;
        bad_lines: number;
        byte_offset: number;
        size_bytes: number;
      }>(
        'SELECT lines_parsed, bad_lines, byte_offset, size_bytes FROM file_manifest WHERE rel_path = ?',
      )
      .get('projects/-work-demo-alpha/sess-bad.jsonl');
    expect(manifest?.lines_parsed).toBe(5);
    expect(manifest?.bad_lines).toBe(3);
    // Every line was complete, so the whole file was consumed — a bad line is skipped, not
    // a place the reader stops (§5.3's partial-tail rule is about terminators, not content).
    expect(manifest?.byte_offset).toBe(manifest?.size_bytes);

    expect(harness.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(2);

    // The two survivors are exactly the two well-formed, timestamped records.
    const keys = harness.db
      .prepare<{ event_key: string }>('SELECT event_key FROM events ORDER BY event_key')
      .all();
    expect(keys.map((row) => row.event_key)).toEqual(['g1', 'g4']);

    // ⚠️ The untimestamped record's 9,999 output tokens are NOT in the database. A parser
    // that stamped it "now" to keep it would have made a real total wrong forever.
    expect(
      harness.db
        .prepare<{ total: number }>('SELECT COALESCE(SUM(tok_output),0) AS total FROM events')
        .get()?.total,
    ).toBe(42); // g4 only: 42. g3's 9_999 is absent, not zero-filled into a row.

    // Disclosed as data: the cycle's own counter and the aggregate the §4.6 payload reads.
    expect(state.badLines).toBe(3);
    expect(
      harness.db
        .prepare<{ n: number }>('SELECT COALESCE(SUM(bad_lines),0) AS n FROM file_manifest')
        .get()?.n,
    ).toBe(3);
  });

  it('does not re-count bad lines when the file is synced again unchanged', async () => {
    const root = await sandbox.copyFixture(fixturePath('f05-malformed'), 'root');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();
    await harness.runSync();

    // §3.2 `bad_lines` is the file's absolute count, not an accumulator: a second sync of an
    // UNCHANGED file must not double a disclosure (which would read as data corruption).
    expect(
      harness.db
        .prepare<{ n: number }>('SELECT bad_lines AS n FROM file_manifest WHERE rel_path = ?')
        .get('projects/-work-demo-alpha/sess-bad.jsonl')?.n,
    ).toBe(3);
  });
});
