// The write path: §3.8 file touches, §3.9 prompt→project resolution, §3.16 stats cache.
//
// These are the derivations that are easy to get subtly wrong and impossible to see wrong in
// the UI: a language bucket, a project a prompt was filed under, a day-presence row.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useSandbox } from '../../support/sandbox';
import { createSyncHarness, fixturePath } from '../../support/sync-harness';

describe('§3.8 — file touches derived from write-class tool calls', () => {
  const sandbox = useSandbox();

  it('resolves basename, lowercased extension and the M-15 language', async () => {
    const root = sandbox.resolve('claude');
    await mkdir(join(root, 'projects', '-work-demo-alpha'), { recursive: true });
    // One assistant event, five write-class calls with different path shapes.
    const record = {
      type: 'assistant',
      uuid: 'w1',
      timestamp: '2024-05-01T09:00:00.000Z',
      message: {
        role: 'assistant',
        model: 'claude-test-1',
        content: [
          { type: 'tool_use', name: 'Write', input: { file_path: '/work/demo/alpha/src/App.TSX' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/work/demo/alpha/Makefile' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/work/demo/alpha/.env' } },
          {
            type: 'tool_use',
            name: 'NotebookEdit',
            input: { notebook_path: '/work/demo/alpha/nb.ipynb' },
          },
          { type: 'tool_use', name: 'Read', input: { file_path: '/work/demo/alpha/src/a.ts' } },
        ],
      },
    };
    await writeFile(
      join(root, 'projects', '-work-demo-alpha', 'sess-w.jsonl'),
      `${JSON.stringify(record)}\n`,
    );

    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    const touches = harness.db
      .prepare<{
        path: string;
        basename: string;
        extension: string | null;
        language: string | null;
      }>('SELECT path, basename, extension, language FROM file_touches ORDER BY id')
      .all();
    expect(touches).toEqual([
      // §3.8 — "lowercased, no dot"; M-15 maps `tsx` → TypeScript.
      {
        path: '/work/demo/alpha/src/App.TSX',
        basename: 'App.TSX',
        extension: 'tsx',
        language: 'TypeScript',
      },
      // No extension at all — `NULL`, surfaced as "other", never bucketed into a neighbour.
      { path: '/work/demo/alpha/Makefile', basename: 'Makefile', extension: null, language: null },
      // A dotfile's leading dot is not an extension.
      { path: '/work/demo/alpha/.env', basename: '.env', extension: null, language: null },
      // `ipynb` is not in M-15's table, so the language is NULL rather than a guess.
      {
        path: '/work/demo/alpha/nb.ipynb',
        basename: 'nb.ipynb',
        extension: 'ipynb',
        language: null,
      },
    ]);

    // ⚠️ `Read` is not write-class, so it touches no file — but it IS a tool call (M-12).
    expect(harness.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM tool_calls').get()?.n).toBe(
      5,
    );
    expect(
      harness.db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM tool_calls WHERE is_write_class = 1')
        .get()?.n,
    ).toBe(4);
  });
});

describe('§3.9 — prompt → project resolution happens at finalize, not at read time', () => {
  const sandbox = useSandbox();

  it('matches the encoded form of the raw project, and keeps raw_project either way', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    const prompts = harness.db
      .prepare<{ raw_project: string; encoded_name: string | null; session_id: string }>(
        `SELECT pr.raw_project, p.encoded_name, pr.session_id
           FROM prompts pr LEFT JOIN projects p ON p.id = pr.project_id
          ORDER BY pr.line_no`,
      )
      .all();
    // ⚠️ `history.jsonl` sorts BEFORE `projects/**`, so the prompts were written before the
    // projects existed. Resolving at read time would have left both of these NULL — which is
    // why §3.9's `project_id` is filled in one pass at FINALIZING.
    expect(prompts).toEqual([
      { raw_project: '/work/demo/alpha', encoded_name: '-work-demo-alpha', session_id: 'sess-a' },
      { raw_project: '/work/demo/beta', encoded_name: '-work-demo-beta', session_id: 'sess-b' },
    ]);
  });

  it('leaves project_id NULL and keeps raw_project when nothing matches (§3.9)', async () => {
    const root = sandbox.resolve('claude');
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'history.jsonl'),
      '{"display":"orphan","timestamp":1714554000000,"project":"/work/never/seen"}\n',
    );
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    // A prompt for a project with no transcripts is a partial-data period (M-16), not an
    // error and not a dropped row.
    expect(
      harness.db
        .prepare<{ project_id: number | null; raw_project: string }>(
          'SELECT project_id, raw_project FROM prompts',
        )
        .get(),
    ).toEqual({ project_id: null, raw_project: '/work/never/seen' });
  });
});

describe('§3.16 — stats-cache.json is coverage metadata only (ADR-029)', () => {
  const sandbox = useSandbox();

  it('stores each day-keyed object verbatim and nothing else', async () => {
    const root = sandbox.resolve('claude');
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'stats-cache.json'),
      JSON.stringify({
        '2024-05-01': { messages: 12, tokens: 3_400 },
        '2024-05-02': { messages: 4 },
        lastUpdated: 'not a day',
        version: 3,
      }),
    );
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    const days = harness.db
      .prepare<{ day: string; raw_json: string }>(
        'SELECT day, raw_json FROM stats_cache_days ORDER BY day',
      )
      .all();
    expect(days).toEqual([
      { day: '2024-05-01', raw_json: '{"messages":12,"tokens":3400}' },
      { day: '2024-05-02', raw_json: '{"messages":4}' },
    ]);
    // ⚠️ Its only use is day-presence (M-16). Nothing here is ever summed into, substituted
    // into or reconciled against a displayed metric — there are no events to reconcile with.
    expect(harness.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(0);
  });

  it('treats a shape it does not recognise as zero days, not as an error', async () => {
    const root = sandbox.resolve('claude');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'stats-cache.json'), '{"totals":{"tokens":999}}');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    // §11.4 — the field-level schema "is not documented in any verified source". A miss costs
    // only `DataCoverage.statsCacheDays`; ADR-029 guarantees it can move no other number.
    expect(harness.cycle.state().phase).toBe('idle');
    expect(
      harness.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM stats_cache_days').get()?.n,
    ).toBe(0);
  });
});

describe('§5.4 rule 8 (A-05) — the cache-write split reaches the row and the manifest', () => {
  const sandbox = useSandbox();

  it('stores both classes, and counts a self-contradicting record as a disclosure', async () => {
    const root = sandbox.resolve('claude');
    await mkdir(join(root, 'projects', '-work-demo-alpha'), { recursive: true });

    const usage = (extra: Record<string, unknown>): Record<string, unknown> => ({
      role: 'assistant',
      model: 'claude-test-1',
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, ...extra },
    });
    const records = [
      // (1) the split is present and consistent: 40 + 60 = 100.
      {
        type: 'assistant',
        uuid: 'a05-split',
        timestamp: '2024-05-01T09:00:00.000Z',
        message: usage({
          cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 },
        }),
      },
      // (2) no `cache_creation` at all — the pre-A-05 shape. Flat total to the 5-minute class,
      // an explicit 0 to the 1-hour one. Not NULL: the row was parsed by THIS build, so the
      // absence of a split is a known fact about the source, not an unknown about the row.
      {
        type: 'assistant',
        uuid: 'a05-flat',
        timestamp: '2024-05-01T09:01:00.000Z',
        message: usage({ cache_creation_input_tokens: 70 }),
      },
      // (3) ⚠️ the split contradicts the flat total: 1 + 1 ≠ 500.
      {
        type: 'assistant',
        uuid: 'a05-mismatch',
        timestamp: '2024-05-01T09:02:00.000Z',
        message: usage({
          cache_creation_input_tokens: 500,
          cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 },
        }),
      },
    ];
    await writeFile(
      join(root, 'projects', '-work-demo-alpha', 'sess-a05.jsonl'),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );

    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    expect(
      harness.db
        .prepare<{ uuid: string; w: number; h: number | null }>(
          'SELECT uuid, tok_cache_write AS w, tok_cache_write_1h AS h FROM events ORDER BY ts',
        )
        .all(),
    ).toEqual([
      { uuid: 'a05-split', w: 40, h: 60 },
      { uuid: 'a05-flat', w: 70, h: 0 },
      // ⚠️ Neither half of the contradiction is believed. The flat total — the aggregate this app
      // has always billed on — stays, and the 1-hour share is NULL = not known, so the row costs
      // exactly what it would have costed before A-05 and is disclosed rather than guessed at.
      { uuid: 'a05-mismatch', w: 500, h: null },
    ]);

    // Counted in the manifest, exactly like `bad_lines`, and reported through §4.6.
    expect(
      harness.db
        .prepare<{ n: number }>(
          'SELECT COALESCE(SUM(cache_split_mismatches), 0) AS n FROM file_manifest',
        )
        .get()?.n,
    ).toBe(1);
    // ⚠️ And it is NOT a bad line: the record produced a perfectly good event.
    expect(
      harness.db.prepare<{ n: number }>('SELECT SUM(bad_lines) AS n FROM file_manifest').get()?.n,
    ).toBe(0);
    expect(harness.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(3);
  });
});
