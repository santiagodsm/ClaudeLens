// §3.3 / §3.5, both AMENDED 2026-07-22 — the project's name is the folder's name.
//
// ⚠️ THE BUG. §3.3 used to say `display_name` is "the last path-like segment of the decoded
// `encoded_name`". Claude encodes a path by replacing every non-alphanumeric character with
// `-`, so decoding it cannot tell `Home-Media-Server` from `Home/Media/Server`. On the
// reporting user's machine three real projects were named after their last hyphenated chunk:
// "Server" for `Home-Media-Server`, "Booth" for `Photo-Booth`, "Site" for `Portfolio-Site`.
//
// ⚠️ EVERY FIXTURE HERE HAS A HYPHEN IN ITS FOLDER NAME, and that is the point. A project
// called `alpha` is named `alpha` by the old rule and by the new one; a test built on one
// would pass against the bug and prove nothing. Each expected value below is the FULL folder
// name, written by hand.
//
// ⚠️ PRIVACY (§7.8, P-33). `events.cwd` is an absolute personal path. Only its BASENAME may be
// rendered or cross IPC — the last test in this file is what holds that line.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectStatsRepository } from '../../../src/main/db/repositories/project-stats';
import type { QueryContext } from '../../../src/main/db/repositories/scope';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';
import { useSandbox } from '../../support/sandbox';
import { createSyncHarness, fixturePath } from '../../support/sync-harness';

/** All projects, all time — the display name does not depend on the filter. */
const ALL_TIME: QueryContext = {
  filter: { projectIds: null, from: null, to: null },
  idleGapMinutes: 15,
};

interface ProjectRow {
  readonly encoded_name: string;
  readonly display_name: string;
}

function projectRows(db: SqliteDatabase): ProjectRow[] {
  return db
    .prepare<ProjectRow>('SELECT encoded_name, display_name FROM projects ORDER BY encoded_name')
    .all();
}

describe('§3.3 (amended) — the display name is the basename of `events.cwd`', () => {
  const sandbox = useSandbox();

  it('names the three real cases by their whole folder, not their last hyphenated chunk', async () => {
    const harness = createSyncHarness({
      claudeDir: fixturePath('project-names'),
      dbPath: sandbox.resolve('lens.db'),
    });
    await harness.runSync();

    // Hand-written, one line per project. The old rule produced the value in the comment.
    // Rows come back ORDER BY encoded_name, so the synthetic names sort:
    // Home-Media-Server < No-Cwd < Photo-Booth < Portfolio-Site < Split-Root, then -work-other-.
    expect(projectRows(harness.db)).toEqual([
      // was "Server" — the user's own example.
      { encoded_name: '-work-demo-Home-Media-Server', display_name: 'Home-Media-Server' },
      // ⚠️ The fallback: these records carry no `cwd` at all, so the decoded encoded name is
      // all there is — `/work/demo/No/Cwd` → "Cwd". Wrong-looking, and deliberately kept:
      // never unnamed, and never a guess dressed up as a fact.
      { encoded_name: '-work-demo-No-Cwd', display_name: 'Cwd' },
      // was "Booth"
      { encoded_name: '-work-demo-Photo-Booth', display_name: 'Photo-Booth' },
      // was "Site". ⚠️ Every record's `cwd` is `/work/demo/Portfolio-Site/website` — a
      // SUBDIRECTORY. The basename of the raw `cwd` would be "website"; the rule anchors the
      // `cwd` against `encoded_name` first, so the project root is what gets named.
      { encoded_name: '-work-demo-Portfolio-Site', display_name: 'Portfolio-Site' },
      // Two roots anchor (`Split.Root` twice, `Split-Root` once); the most frequent wins.
      { encoded_name: '-work-demo-Split-Root', display_name: 'Split.Root' },
      // was "Booth" too — and legitimately still shares the name, see the next test.
      { encoded_name: '-work-other-Photo-Booth', display_name: 'Photo-Booth' },
    ]);
  });

  it('leaves two projects that share a name as two projects (§3.3 — identity is the encoded name)', async () => {
    const harness = createSyncHarness({
      claudeDir: fixturePath('project-names'),
      dbPath: sandbox.resolve('lens.db'),
    });
    await harness.runSync();

    const named = harness.db
      .prepare<{
        id: number;
        encoded_name: string;
      }>(
        `SELECT id, encoded_name FROM projects WHERE display_name = 'Photo-Booth' ORDER BY encoded_name`,
      )
      .all();

    // ⚠️ Two rows, two identities, one name. §3.3 allows this explicitly (worktrees are
    // siblings, OQ-007) and the UI disambiguates with the encoded name in a tooltip. The fix
    // makes the collision MORE common, and that is correct rather than a regression.
    expect(named.map((row) => row.encoded_name)).toEqual([
      '-work-demo-Photo-Booth',
      '-work-other-Photo-Booth',
    ]);
    expect(new Set(named.map((row) => row.id)).size).toBe(2);
  });

  it('breaks a tie between equally frequent roots lexicographically', async () => {
    // Not a committed fixture: this is the tie the rule has to resolve *deterministically*,
    // and it is clearest written out. One record for each of two roots that the encoding
    // cannot tell apart — '-' (0x2D) sorts before '.' (0x2E), so `Even-Split` wins.
    const root = sandbox.resolve('claude');
    const dir = join(root, 'projects', '-work-demo-Even-Split');
    await mkdir(dir, { recursive: true });
    const record = (uuid: string, ts: string, cwd: string): string =>
      `${JSON.stringify({
        type: 'user',
        uuid,
        parentUuid: null,
        timestamp: ts,
        cwd,
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      })}\n`;
    await writeFile(
      join(dir, 'sess-tie.jsonl'),
      record('t1', '2024-05-01T09:00:00.000Z', '/work/demo/Even.Split') +
        record('t2', '2024-05-01T09:01:00.000Z', '/work/demo/Even-Split'),
    );

    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    expect(projectRows(harness.db)).toEqual([
      { encoded_name: '-work-demo-Even-Split', display_name: 'Even-Split' },
    ]);
  });

  it('ignores a `cwd` that does not sit inside the project (no anchor, no rename)', async () => {
    // A `cwd` from somewhere else entirely cannot name this project: it would be a guess. The
    // fallback is the decoded encoded name — `/work/demo/Odd/One` → "One".
    const root = sandbox.resolve('claude');
    const dir = join(root, 'projects', '-work-demo-Odd-One');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'sess-odd.jsonl'),
      `${JSON.stringify({
        type: 'user',
        uuid: 'o1',
        parentUuid: null,
        timestamp: '2024-05-01T09:00:00.000Z',
        cwd: '/somewhere/else/entirely',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      })}\n`,
    );

    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    expect(projectRows(harness.db)).toEqual([
      { encoded_name: '-work-demo-Odd-One', display_name: 'One' },
    ]);
  });

  it('re-derives on every finalize, so an append and a cold parse agree (INV-04)', async () => {
    // The name is a function of the events, recomputed — never accumulated. Running the cycle
    // again over the same tree must not move it, and must not fall back to the insert-time
    // value either (the upsert deliberately does not refresh `display_name`).
    const harness = createSyncHarness({
      claudeDir: fixturePath('project-names'),
      dbPath: sandbox.resolve('lens.db'),
    });
    await harness.runSync();
    const first = projectRows(harness.db);
    await harness.runSync('full');

    expect(projectRows(harness.db)).toEqual(first);
  });
});

describe('§7.8 / P-33 — only the basename leaves the database', () => {
  const sandbox = useSandbox();

  it('puts no absolute path in any payload the renderer receives', async () => {
    const harness = createSyncHarness({
      claudeDir: fixturePath('project-names'),
      dbPath: sandbox.resolve('lens.db'),
    });
    await harness.runSync();

    const projects = new ProjectStatsRepository(harness.db);
    // Every project-shaped payload §4.5 exposes. `q:fileMetrics` is excluded on purpose: §3.8
    // states that `file_touches.path` is a tool argument and IS carried, rendered
    // basename-first with the full path in a hover title. `cwd` gets no such exemption.
    const wire = JSON.stringify({
      tokensByProject: projects.tokensByProject(ALL_TIME),
      projectCards: projects.projectCards(ALL_TIME),
    });

    // The `cwd` values that are actually in this database, verbatim.
    const cwds = harness.db
      .prepare<{ cwd: string }>('SELECT DISTINCT cwd FROM events WHERE cwd IS NOT NULL')
      .all()
      .map((row) => row.cwd);
    expect(cwds.length).toBeGreaterThan(0);
    for (const cwd of cwds) expect(wire).not.toContain(cwd);

    // Stronger, and the rule as §7.8 states it rather than as these fixtures happen to spell
    // it: no string anywhere in either payload — key or value — contains a path separator.
    expect(wire).not.toMatch(/"[^"]*\/[^"]*"/);
  });
});
