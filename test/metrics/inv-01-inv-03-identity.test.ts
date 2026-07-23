// INV-01 and INV-03 (§5.10) — event identity and idempotence.
//
//   INV-01 "Every event row has exactly one `session_id` and one `project_id`, both non-null
//           and both resolvable."
//   INV-03 "Ingesting the same file twice, or the same record from two files, changes no
//           aggregate. (`event_key` idempotence, ADR-019.)"
//
// ⚠️ ADR-019 exists because "double-counting is the single highest-impact correctness risk in
// this project (~72% of output tokens ride on subagent attribution)". Both of INV-03's cases
// are exercised below, because they fail differently: a re-parse replays one file's own
// records, while two files carrying the same `uuid` is cross-file duplication that
// `UNIQUE(source_file_id, line_no)` would not have caught at all.

import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { createSyncHarness, fixturePath } from '../support/sync-harness';

interface Aggregates {
  readonly events: number;
  readonly toolCalls: number;
  readonly fileTouches: number;
  readonly output: number;
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly mainOutput: number;
  readonly subagentOutput: number;
}

function aggregates(db: ReturnType<typeof createSyncHarness>['db']): Aggregates {
  const row = db
    .prepare<Aggregates>(
      `SELECT (SELECT COUNT(*) FROM events)       AS events,
              (SELECT COUNT(*) FROM tool_calls)   AS toolCalls,
              (SELECT COUNT(*) FROM file_touches) AS fileTouches,
              (SELECT COALESCE(SUM(tok_output),0)      FROM events) AS output,
              (SELECT COALESCE(SUM(tok_input),0)       FROM events) AS input,
              (SELECT COALESCE(SUM(tok_cache_write),0) FROM events) AS cacheWrite,
              (SELECT COALESCE(SUM(tok_cache_read),0)  FROM events) AS cacheRead,
              (SELECT COALESCE(SUM(tok_output),0) FROM events WHERE origin = 'main')     AS mainOutput,
              (SELECT COALESCE(SUM(tok_output),0) FROM events WHERE origin = 'subagent') AS subagentOutput`,
    )
    .get();
  if (row === undefined) throw new Error('no aggregate row');
  return row;
}

describe('INV-01 / INV-03 — event identity and idempotence', () => {
  const sandbox = useSandbox();

  it('INV-01: every event resolves to exactly one session and one project', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    const check = harness.db
      .prepare<{ total: number; resolvable: number }>(
        `SELECT (SELECT COUNT(*) FROM events) AS total,
                (SELECT COUNT(*) FROM events e
                   JOIN sessions s ON s.id = e.session_id
                   JOIN projects p ON p.id = e.project_id
                  WHERE e.session_id IS NOT NULL AND e.project_id IS NOT NULL) AS resolvable`,
      )
      .get();
    // 7 events in the base fixture: sess-a 3 + run-1 2 + sess-b 2.
    expect(check?.total).toBe(7);
    expect(check?.resolvable).toBe(check?.total);

    // ⚠️ ADR-020 — a subagent event's session is the PARENT session, not a session of its
    // own. There is no `sessions` row for `run-1`, and there must never be one.
    const bySession = harness.db
      .prepare<{ session_id: string; origin: string; n: number }>(
        'SELECT session_id, origin, COUNT(*) AS n FROM events GROUP BY session_id, origin ORDER BY session_id, origin',
      )
      .all();
    expect(bySession).toEqual([
      { session_id: 'sess-a', origin: 'main', n: 3 },
      { session_id: 'sess-a', origin: 'subagent', n: 2 },
      { session_id: 'sess-b', origin: 'main', n: 2 },
    ]);
    expect(harness.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(
      2,
    );
  });

  it('INV-03: re-parsing the same file from byte 0 changes no aggregate', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();
    const before = aggregates(harness.db);

    // Force the pathological case ADR-019 names: a **replayed append**. The manifest is
    // rewound WITHOUT deleting the file's rows, so the next cycle re-reads every line and
    // re-inserts every record. `ON CONFLICT(event_key) DO NOTHING` must absorb all of it.
    harness.db
      .prepare('UPDATE file_manifest SET byte_offset = 0, lines_parsed = 0, mtime_ms = 0')
      .run();
    await harness.runSync();

    expect(aggregates(harness.db)).toEqual(before);
    // Non-trivially: the fixture actually has tokens and tool calls to double.
    expect(before.events).toBe(7);
    expect(before.output).toBeGreaterThan(0);
    expect(before.toolCalls).toBeGreaterThan(0);
    // INV-02's shape, which idempotence is a precondition for: main + subagent = total.
    expect(before.mainOutput + before.subagentOutput).toBe(before.output);
  });

  it('INV-03: the same record met in two files is counted once', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();
    const before = aggregates(harness.db);

    // A second transcript file, at a different rel_path, carrying the SAME uuids. This is
    // the case §5.12 rules on: "Two files containing the same `uuid` → first ingested wins;
    // second is ignored", and the case ADR-019 says a (file, line) key would miss entirely.
    await cp(
      join(root, 'projects', '-work-demo-alpha', 'sess-a.jsonl'),
      join(root, 'projects', '-work-demo-alpha', 'sess-a-copy.jsonl'),
    );
    await harness.runSync();

    expect(aggregates(harness.db)).toEqual(before);

    // The duplicate file is legitimately a new session (§2.1: a session IS its file) and a
    // new manifest row — but it contributed no events, and totals did not move.
    expect(
      harness.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM file_manifest').get()?.n,
    ).toBe(5);
    expect(
      harness.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM events e JOIN file_manifest fm ON fm.id = e.source_file_id
            WHERE fm.rel_path = 'projects/-work-demo-alpha/sess-a-copy.jsonl'`,
        )
        .get()?.n,
    ).toBe(0);
  });
});
