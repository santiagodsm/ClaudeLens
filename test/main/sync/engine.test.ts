// §5.3 applied to a whole scan: the manifest reconcile.
//
// ⚠️ The `ARCHIVED` case is the reason this file exists. Classification is pure and tested
// exhaustively in `classify.test.ts`; what is tested HERE is that the reconcile actually
// reaches the archived rows from the MANIFEST side — they never appear in a scan, because
// their files are not in `<claudeDir>` any more. A reconcile driven only by what is on disk
// would never consider them at all, and the version that does consider them is one `AND
// archive_id IS NULL` away from deleting every archived transcript's rows (INV-18).

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useSandbox } from '../../support/sandbox';
import { createSyncHarness, fixturePath, FIXED_NOW } from '../../support/sync-harness';
import type { SqliteDatabase } from '../../../src/main/db/sqlite';

const ARCHIVE_ROOT = '/nowhere/archive-volume';
const SESSION_TRANSCRIPT = 'projects/-work-demo-beta/sess-b.jsonl';

/** ACT-07's rows, as E10 will write them: an audit entry, an archive, and the annotation. */
function archiveSessionB(db: SqliteDatabase): void {
  db.prepare(
    `INSERT INTO audit_log (id, action_type, status, claude_dir, target_summary, targets_json,
       bytes_affected, backup_rel_path, backup_bytes, backup_present, started_at, finished_at,
       created_at, updated_at)
     VALUES (1, 'archive-sessions', 'completed', '/sandbox/claude', '1 session', '[]', 0,
             NULL, 0, 1, ?, ?, ?, ?)`,
  ).run(FIXED_NOW, FIXED_NOW, FIXED_NOW, FIXED_NOW);
  db.prepare(
    `INSERT INTO archives (id, audit_id, archive_root, claude_dir, session_count, file_count,
       bytes_moved, reachable, created_at, updated_at)
     VALUES (1, 1, ?, '/sandbox/claude', 1, 1, 0, 1, ?, ?)`,
  ).run(ARCHIVE_ROOT, FIXED_NOW, FIXED_NOW);
  // §3.2 — archiving only ANNOTATES. `rel_path` is never rewritten; it stays the file's
  // original identity, which is what undo needs to put the file back.
  db.prepare(
    "UPDATE file_manifest SET archive_id = 1, archive_rel_path = 'beta/sess-b.jsonl' WHERE rel_path = ?",
  ).run(SESSION_TRANSCRIPT);
  db.prepare("UPDATE sessions SET archive_id = 1 WHERE id = 'sess-b'").run();
}

function eventCount(db: SqliteDatabase): number {
  return db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM events').get()?.n ?? -1;
}

describe('the manifest reconcile (§5.3)', () => {
  const sandbox = useSandbox();

  it('never deletes, re-parses or MISSES an archived file whose transcript is gone', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    const before = eventCount(harness.db);
    expect(before).toBe(7);
    archiveSessionB(harness.db);

    // ACT-07 moved the file out of `<claudeDir>`. Its absence is EXPECTED (§5.12): the app
    // moved it, deliberately, with an audit entry. This is the one place the general
    // "filesystem wins" rule is deliberately inverted.
    await rm(join(root, ...SESSION_TRANSCRIPT.split('/')));
    await harness.runSync();

    // ⚠️ Every lifetime total is unchanged. Without §5.3's ARCHIVED row this sync would have
    // classified the file MISSING, deleted its manifest row, cascaded its events away, and
    // silently shrunk the count from 7 to 5.
    expect(eventCount(harness.db)).toBe(before);
    expect(
      harness.db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM file_manifest WHERE rel_path = ?')
        .get(SESSION_TRANSCRIPT)?.n,
    ).toBe(1);
    expect(
      harness.db
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE id = 'sess-b'")
        .get()?.n,
    ).toBe(1);
  });

  it('refreshes archives.reachable by statting the root, and nothing else (§3.15)', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();
    archiveSessionB(harness.db);
    await rm(join(root, ...SESSION_TRANSCRIPT.split('/')));
    await harness.runSync();

    // The archive root does not exist (it names an unmounted volume), so `reachable` flips.
    const archive = harness.db
      .prepare<{ reachable: number; last_reachable_at: number | null }>(
        'SELECT reachable, last_reachable_at FROM archives WHERE id = 1',
      )
      .get();
    expect(archive?.reachable).toBe(0);
    // ⚠️ Informational ONLY: no row is deleted, no period is marked partial, no metric moves
    // (§3.15, ADR-033). `last_reachable_at` is not falsified to "now" either.
    expect(archive?.last_reachable_at).toBeNull();
    expect(eventCount(harness.db)).toBe(7);
  });

  it('deletes a genuinely MISSING file and cascades its rows (retention OFF)', async () => {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    // ⚠️ ADR-041 — this is the PURE-MIRROR path, so retention is OFF. With the default (ON) the
    // same disappearance is RETAINED instead of deleted — asserted in
    // `retain-orphaned-history.test.ts`.
    const harness = createSyncHarness({
      claudeDir: root,
      dbPath: sandbox.resolve('lens.db'),
      retainOrphanedHistory: false,
    });
    await harness.runSync();
    expect(eventCount(harness.db)).toBe(7);

    // Not archived — actually gone. The filesystem is the source of truth (§5.12).
    await rm(join(root, ...SESSION_TRANSCRIPT.split('/')));
    await harness.runSync();

    // sess-b's 2 events go with it (`events.source_file_id` is ON DELETE CASCADE, §3.1.5);
    // sess-a's 5 remain.
    expect(eventCount(harness.db)).toBe(5);
    expect(
      harness.db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM file_manifest WHERE rel_path = ?')
        .get(SESSION_TRANSCRIPT)?.n,
    ).toBe(0);
    expect(
      harness.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM tool_calls').get()?.n,
      // Base fixture tool calls: a2 {Agent, Write} + s1 {Read} + b2 {Skill, Skill} = 5.
      // sess-b's two Skill calls went with its events; 5 − 2 = 3 remain.
    ).toBe(3);

    // ⚠️ The SESSION row survives, and that is the schema's decision, not an oversight:
    // §3.4 declares `transcript_file_id … ON DELETE SET NULL`, not CASCADE. §3.4 then gives
    // the surviving row a meaning — "`is_partial = 1` when prompts reference this `sessionId`
    // but no transcript file exists for it (M-16)" — which is exactly this state. Deleting it
    // would erase the evidence that the period is partial.
    const session = harness.db
      .prepare<{ transcript_file_id: number | null; is_partial: number; first_ts: number | null }>(
        "SELECT transcript_file_id, is_partial, first_ts FROM sessions WHERE id = 'sess-b'",
      )
      .get();
    expect(session?.transcript_file_id).toBeNull();
    expect(session?.is_partial).toBe(1);
    expect(session?.first_ts).toBeNull();
  });

  it('SHRANK re-parses the whole file and keeps the manifest row identity', async () => {
    const { writeFile } = await import('node:fs/promises');
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();

    const idBefore = harness.db
      .prepare<{ id: number; first_seen_at: number }>(
        'SELECT id, first_seen_at FROM file_manifest WHERE rel_path = ?',
      )
      .get(SESSION_TRANSCRIPT);

    // Truncate to a single, different record: size < byte_offset ⇒ SHRANK.
    await writeFile(
      join(root, ...SESSION_TRANSCRIPT.split('/')),
      '{"type":"user","uuid":"b9","timestamp":"2024-05-01T09:00:00.000Z","message":{"role":"user"}}\n',
    );
    await harness.runSync();

    const after = harness.db
      .prepare<{ id: number; first_seen_at: number; lines_parsed: number }>(
        'SELECT id, first_seen_at, lines_parsed FROM file_manifest WHERE rel_path = ?',
      )
      .get(SESSION_TRANSCRIPT);
    // §3.2 — `rel_path` is the identity and the row survives the re-parse.
    expect(after?.id).toBe(idBefore?.id);
    expect(after?.first_seen_at).toBe(idBefore?.first_seen_at);
    expect(after?.lines_parsed).toBe(1);
    // The old records are gone (deleted by `source_file_id`), the new one is in: 5 + 1 = 6.
    expect(eventCount(harness.db)).toBe(6);
    expect(
      harness.db
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE event_key = 'b1'")
        .get()?.n,
    ).toBe(0);
  });
});
