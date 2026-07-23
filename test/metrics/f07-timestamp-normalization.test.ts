// F-07 (§5.9.1) — **timestamp normalization.** "ISO 8601 Z vs ms-epoch both land on the same
// epoch ms; no timestamp ever defaults to 'now'."
//
// §5.4 rule 2: "Transcript `timestamp` is ISO 8601 Z → epoch ms. `history.jsonl` `timestamp`
// is already ms epoch → used as is. A record with no parseable timestamp is skipped and
// counted as a bad line. **No timestamp is ever defaulted to 'now.'**"
//
// ⚠️ A defaulted timestamp is the purest form of this project's worst failure: the record
// looks present, the totals look complete, and the event lands on the wrong day forever —
// silently, in a chart that renders perfectly (CLAUDE.md §1, ADR-021).

import { describe, expect, it } from 'vitest';
import { isoToEpochMs, epochMsAsIs } from '../../src/main/parse/parse-line';
import { useSandbox } from '../support/sandbox';
import { createSyncHarness, fixturePath } from '../support/sync-harness';

// 2024-05-01T09:00:00.000Z. Date.UTC(2024, 4, 1) = 1_714_521_600_000;
// + 9 h × 3_600_000 ms = 32_400_000  =>  1_714_554_000_000.
const NINE_AM_UTC = 1_714_554_000_000;

// Every fixture instant is in 2024; the test runs in a much later year. Any value at or past
// this bound could only have come from a clock, which rule 2 forbids.
const WELL_BEFORE_NOW = Date.UTC(2025, 0, 1);

describe('F-07 — timestamp normalization', () => {
  const sandbox = useSandbox();

  it('maps ISO 8601 Z and ms-epoch onto the same instant', () => {
    // Pure-function level, before any file or database is involved (STACK ADR-009).
    expect(isoToEpochMs('2024-05-01T09:00:00.000Z')).toBe(NINE_AM_UTC);
    expect(isoToEpochMs('2024-05-01T09:00:00Z')).toBe(NINE_AM_UTC); // no fractional part
    expect(isoToEpochMs('2024-05-01T11:00:00+02:00')).toBe(NINE_AM_UTC); // same instant
    expect(epochMsAsIs(NINE_AM_UTC)).toBe(NINE_AM_UTC); // history.jsonl: used AS IS

    // The two forms are not interchangeable across file kinds (§5.4 rule 2 states which is
    // which). Neither is coerced into the other, and neither guesses.
    expect(isoToEpochMs(NINE_AM_UTC)).toBeNull();
    expect(epochMsAsIs('2024-05-01T09:00:00.000Z')).toBeNull();
    expect(isoToEpochMs('not a date at all')).toBeNull();
    expect(isoToEpochMs(undefined)).toBeNull();
    // ⚠️ Not a seconds-vs-milliseconds heuristic: a plausible seconds value stays what the
    // file said it was. Unit sniffing would move records by 54 years, invisibly.
    expect(epochMsAsIs(1_714_554)).toBe(1_714_554);
  });

  it('lands both file kinds on the same stored epoch ms, and never invents one', async () => {
    const root = await sandbox.copyFixture(fixturePath('f07-timestamps'), 'root');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    // sess-ts.jsonl, 6 physical lines:
    //   t1  "2024-05-01T09:00:00.000Z"   -> 1_714_554_000_000
    //   t2  "2024-05-01T09:00:00Z"       -> 1_714_554_000_000  (same instant, no millis)
    //   t3  "2024-05-01T11:00:00+02:00"  -> 1_714_554_000_000  (same instant, offset form)
    //   t4  1714554000000 (a number)     -> bad: a transcript timestamp is ISO (rule 2)
    //   t5  absent                       -> bad
    //   t6  "not a date at all"          -> bad
    const events = harness.db
      .prepare<{ event_key: string; ts: number }>(
        'SELECT event_key, ts FROM events ORDER BY event_key',
      )
      .all();
    expect(events).toEqual([
      { event_key: 't1', ts: NINE_AM_UTC },
      { event_key: 't2', ts: NINE_AM_UTC },
      { event_key: 't3', ts: NINE_AM_UTC },
    ]);

    // history.jsonl, 2 lines:
    //   line 1  1714554000000            -> 1_714_554_000_000, used as is
    //   line 2  "2024-05-01T09:00:00Z"   -> bad: history timestamps are ms epoch (rule 2)
    const prompts = harness.db
      .prepare<{ ts: number; display_preview: string }>(
        'SELECT ts, display_preview FROM prompts ORDER BY line_no',
      )
      .all();
    expect(prompts).toEqual([{ ts: NINE_AM_UTC, display_preview: 'already ms epoch' }]);

    // The ISO transcript and the ms-epoch history line name the SAME instant.
    expect(events[0]?.ts).toBe(prompts[0]?.ts);

    // Three bad lines in the transcript, one in history — counted and disclosed, not dropped.
    const badLines = harness.db
      .prepare<{ rel_path: string; bad_lines: number; lines_parsed: number }>(
        'SELECT rel_path, bad_lines, lines_parsed FROM file_manifest ORDER BY rel_path',
      )
      .all();
    expect(badLines).toEqual([
      { rel_path: 'history.jsonl', bad_lines: 1, lines_parsed: 2 },
      { rel_path: 'projects/-work-demo-alpha/sess-ts.jsonl', bad_lines: 3, lines_parsed: 6 },
    ]);
    expect(harness.cycle.state().badLines).toBe(4);

    // ⚠️ **Nothing defaulted to "now."** Every stored instant is the fixture's own, and the
    // whole database is decades away from the clock this test runs on.
    const bounds = harness.db
      .prepare<{ maxEventTs: number | null; maxPromptTs: number | null }>(
        `SELECT (SELECT MAX(ts) FROM events)  AS maxEventTs,
                (SELECT MAX(ts) FROM prompts) AS maxPromptTs`,
      )
      .get();
    expect(bounds?.maxEventTs).toBe(NINE_AM_UTC);
    expect(bounds?.maxPromptTs).toBe(NINE_AM_UTC);
    expect(bounds?.maxEventTs).toBeLessThan(WELL_BEFORE_NOW);
    // The unparseable records left no row at all — not a row with a substituted timestamp.
    expect(
      harness.db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM events WHERE event_key IN ('t4','t5','t6')",
        )
        .get()?.n,
    ).toBe(0);
  });
});
