// ACT-07 `archive-sessions` — §5.7 (in full), §5.5 rule 1, §3.15, ADR-033, ADR-034,
// INV-07, INV-19, INV-20.
//
// The `guarded-action-review` gate (§12.2) requires, for ACT-07 specifically:
//   · the restore point is a **verified move manifest** (INV-07)
//   · a session's transcript and `subagents/` **never split across roots** (INV-20)
//   · `archiveRoot` is **never inside or a parent of** `claudeDir` (INV-19)
//   · **no metric changes across the archive** (INV-18 — fixture F-04, `test/metrics/`)
//   · **nothing under the archive root is ever deleted by the app**
//
// ⚠️ STACK ADR-013 — sandbox + one real SQLite file per test; the real `~/.claude` is unreachable
// by construction and nothing here works around the tripwire.

import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOVE_MANIFEST_NAME, type MoveManifest } from '../../../src/main/actions/restore-point';
import { entryKind, walkTree } from '../../../src/main/harness/tree';
import { useSandbox } from '../../support/sandbox';
import { createActionHarness, type ActionHarness } from '../../support/action-harness';
import { createSyncHarness, fixturePath } from '../../support/sync-harness';

/**
 * The F-03 fixture tree is exactly the shape ACT-07 needs: `sess-a` has a transcript AND a
 * `subagents/` directory (the INV-20 case), `sess-b` has a transcript only.
 */
const SESSION_WITH_SUBAGENTS = 'sess-a';
const SESSION_WITHOUT_SUBAGENTS = 'sess-b';

interface Fixture {
  readonly claudeDir: string;
  readonly archiveRoot: string;
  readonly h: ActionHarness;
}

async function syncedFixture(sandbox: {
  resolve: (...s: string[]) => string;
  copyFixture: (dir: string, dest?: string) => Promise<string>;
}): Promise<Fixture> {
  const claudeDir = await sandbox.copyFixture(fixturePath('f03-append/base'), 'claude');
  // ⚠️ INV-19 — a sibling of `claudeDir`, never inside it and never a parent of it.
  const archiveRoot = sandbox.resolve('archive');
  await mkdir(archiveRoot, { recursive: true });

  const sync = createSyncHarness({ claudeDir, dbPath: sandbox.resolve('lens.db') });
  await sync.runSync('full');
  sync.db.close();

  const h = createActionHarness({ claudeDir, dbPath: sandbox.resolve('lens.db'), archiveRoot });
  return { claudeDir, archiveRoot, h };
}

async function archive(h: ActionHarness, sessionIds: string[]): Promise<{ auditId: number }> {
  const payload = { sessionIds };
  const preview = await h.actions.preview({ actionType: 'archive-sessions', payload });
  const result = await h.actions.execute({
    actionType: 'archive-sessions',
    payload,
    confirmToken: preview.confirmToken,
  });
  expect(result.status).toBe('completed');
  return { auditId: result.auditId };
}

describe('ACT-07 — the move class (ADR-034)', () => {
  const sandbox = useSandbox();

  it('previews the whole file set of every named session, with the ACT-07 typed phrase', async () => {
    const { h } = await syncedFixture(sandbox);
    const preview = await h.actions.preview({
      actionType: 'archive-sessions',
      payload: { sessionIds: [SESSION_WITH_SUBAGENTS, SESSION_WITHOUT_SUBAGENTS] },
    });

    // ⚠️ INV-20 — the transcript AND the whole `subagents/` directory, together, for every
    // session that has one. `sess-b` has none, which the preview says in a warning rather than
    // leaving the user to wonder.
    expect(preview.targets.map((target) => target.relPath).toSorted()).toEqual([
      'projects/-work-demo-alpha/sess-a.jsonl',
      'projects/-work-demo-alpha/sess-a/subagents',
      'projects/-work-demo-beta/sess-b.jsonl',
    ]);
    expect(preview.warnings.join(' ')).toContain(SESSION_WITHOUT_SUBAGENTS);
    // §5.7's table — `archive N sessions`, the one phrase that is neither a basename nor
    // `clear backups`.
    expect(preview.requiresTypedConfirm).toBe(true);
    expect(preview.typedConfirmPhrase).toBe('archive 2 sessions');
    expect(preview.totalBytes).toBeGreaterThan(0);
  });

  it('⚠️ INV-07 — the restore point is a VERIFIED move manifest, not file copies', async () => {
    const { h, claudeDir } = await syncedFixture(sandbox);
    const { auditId } = await archive(h, [SESSION_WITH_SUBAGENTS]);

    const entry = h.actions.auditList({ limit: 10 }).rows.find((row) => row.id === auditId);
    const backupRelPath = entry?.backupRelPath ?? '';
    expect(backupRelPath).not.toBe('');

    // ⚠️ ADR-034 — the restore point holds a manifest and NOTHING ELSE. Copying the bytes would
    // "permanently consume, in a restore point that is never pruned, exactly the disk the user
    // was trying to free".
    const contents = await walkTree(join(claudeDir, backupRelPath), { excludeBackupRoot: false });
    expect(contents.files.map((file) => file.relPath)).toEqual([MOVE_MANIFEST_NAME]);
    expect(contents.directories).toEqual([]);

    const manifest = JSON.parse(
      await readFile(join(claudeDir, backupRelPath, MOVE_MANIFEST_NAME), 'utf8'),
    ) as MoveManifest;
    expect(manifest.kind).toBe('move');
    // §5.5 rule 1 — "every `{ originalRelPath, archiveRelPath, sizeBytes, mtimeMs }` pair".
    expect(manifest.entries.map((entryRow) => entryRow.originalRelPath).toSorted()).toEqual([
      'projects/-work-demo-alpha/sess-a.jsonl',
      'projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl',
    ]);
    for (const file of manifest.entries) {
      expect(file.sizeBytes).toBeGreaterThan(0);
      expect(file.mtimeMs).toBeGreaterThan(0);
      // The bytes are at the destination the instant the move completes — that is what makes a
      // manifest sufficient to reverse the action.
      const moved = await stat(join(manifest.archiveRoot, file.archiveRelPath));
      expect(moved.size).toBe(file.sizeBytes);
    }
  });

  it('⚠️ INV-20 — a session’s transcript and subagents/ are never split across the two roots', async () => {
    const { h, claudeDir, archiveRoot } = await syncedFixture(sandbox);
    await archive(h, [SESSION_WITH_SUBAGENTS]);

    // Nothing of `sess-a` remains under `<claudeDir>` …
    expect(await entryKind(join(claudeDir, 'projects/-work-demo-alpha/sess-a.jsonl'))).toBeNull();
    expect(
      await entryKind(join(claudeDir, 'projects/-work-demo-alpha/sess-a/subagents')),
    ).toBeNull();
    // … and both halves are under the archive root, in the original layout (§5.7 rule 1).
    const archived = await walkTree(archiveRoot, { excludeBackupRoot: false });
    expect(archived.files.map((file) => file.relPath.replace(/^[^/]+\//, '')).toSorted()).toEqual([
      'projects/-work-demo-alpha/sess-a.jsonl',
      'projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl',
    ]);
    // `sess-b` was not named and did not move.
    expect(await entryKind(join(claudeDir, 'projects/-work-demo-beta/sess-b.jsonl'))).toBe('file');

    // …and the DATABASE agrees: every manifest row of the archived session carries the same
    // `archive_id`. This is the predicate `purge.ts`'s `events` statement depends on.
    const rows = h.db
      .prepare<{ rel_path: string; archive_id: number | null }>(
        'SELECT rel_path, archive_id FROM file_manifest ORDER BY rel_path',
      )
      .all();
    const archivedIds = new Set(
      rows.filter((row) => row.rel_path.includes('sess-a')).map((row) => row.archive_id),
    );
    expect(archivedIds.size).toBe(1);
    expect([...archivedIds][0]).not.toBeNull();
    expect(rows.find((row) => row.rel_path.includes('sess-b'))?.archive_id).toBeNull();
  });

  it('annotates and NEVER deletes: no events, tool_calls, subagent_runs or file_touches row moves', async () => {
    const { h } = await syncedFixture(sandbox);
    const counts = (): Record<string, number> =>
      Object.fromEntries(
        ['events', 'tool_calls', 'subagent_runs', 'file_touches', 'prompts', 'sessions'].map(
          (table) => [
            table,
            h.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1,
          ],
        ),
      );
    const before = counts();
    await archive(h, [SESSION_WITH_SUBAGENTS]);
    // §5.7 ACT-07 rule 3, literally: "No `events`, `tool_calls`, `subagent_runs` or
    // `file_touches` row is touched."
    expect(counts()).toEqual(before);

    // §3.15 — the permanent record of what was archived and where.
    const archives = h.actions.archivesList().rows;
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatchObject({
      sessionCount: 1,
      fileCount: 2,
      reachable: true,
    });
    expect(archives[0]?.bytesMoved).toBeGreaterThan(0);
    expect(archives[0]?.rangeFromTs).not.toBeNull();
    // §6.10 card 7 — an archive you cannot find is a delete with extra steps, so the absolute
    // destination is recorded.
    expect(archives[0]?.archiveRoot.startsWith('/')).toBe(true);
  });

  it('undo verifies size and mtime, moves everything back, and clears the annotations', async () => {
    const { h, claudeDir, archiveRoot } = await syncedFixture(sandbox);
    const beforeBytes = await readFile(
      join(claudeDir, 'projects/-work-demo-alpha/sess-a.jsonl'),
      'utf8',
    );
    const { auditId } = await archive(h, [SESSION_WITH_SUBAGENTS]);

    const undo = await h.actions.undoLast({ auditId });
    expect(undo.status).toBe('undone');
    expect(undo.restored).toBe(2);

    // Byte-identical, back where it was.
    expect(await readFile(join(claudeDir, 'projects/-work-demo-alpha/sess-a.jsonl'), 'utf8')).toBe(
      beforeBytes,
    );
    expect(
      await entryKind(join(claudeDir, 'projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl')),
    ).toBe('file');

    // §5.7 rule 5 — "clears the annotations, restoring the exact prior state".
    const stillArchived = h.db
      .prepare<{ n: number }>(
        'SELECT COUNT(*) AS n FROM file_manifest WHERE archive_id IS NOT NULL',
      )
      .get();
    expect(stillArchived?.n).toBe(0);
    expect(
      h.db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE archive_id IS NOT NULL')
        .get()?.n,
    ).toBe(0);
    expect(h.actions.archivesList().rows).toEqual([]);

    // ⚠️ The archive DIRECTORY is left behind, empty of the moved files but not removed: the app
    // never deletes anything under the archive root (§5.7 ACT-07 rule 4).
    expect(await entryKind(archiveRoot)).toBe('directory');
  });

  it('⚠️ refuses to undo with E_ARCHIVE_VERIFY_FAILED when an archived file changed', async () => {
    const { h, archiveRoot, claudeDir } = await syncedFixture(sandbox);
    const { auditId } = await archive(h, [SESSION_WITH_SUBAGENTS]);

    const archived = await walkTree(archiveRoot, { excludeBackupRoot: false });
    const transcript = archived.files.find((file) => file.relPath.endsWith('sess-a.jsonl'));
    expect(transcript).toBeDefined();
    await writeFile(join(archiveRoot, transcript?.relPath ?? ''), 'edited by hand\n', 'utf8');

    // ADR-034: "undo depends on the destination still being intact, which is why it verifies
    // size and mtime and refuses on mismatch."
    await expect(h.actions.undoLast({ auditId })).rejects.toMatchObject({
      code: 'E_ARCHIVE_VERIFY_FAILED',
    });

    // ⚠️ And it refused before moving ANYTHING: verification runs over the whole manifest first,
    // so a mismatch cannot leave a half-restored tree behind.
    expect(await entryKind(join(claudeDir, 'projects/-work-demo-alpha/sess-a.jsonl'))).toBeNull();
    expect(
      await entryKind(join(claudeDir, 'projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl')),
    ).toBeNull();
    expect(await entryKind(join(archiveRoot, transcript?.relPath ?? ''))).toBe('file');
    expect(h.actions.archivesList().rows).toHaveLength(1);
  });

  it('refuses to undo when only the MTIME moved, even at identical size', async () => {
    const { h, archiveRoot } = await syncedFixture(sandbox);
    const { auditId } = await archive(h, [SESSION_WITH_SUBAGENTS]);
    const archived = await walkTree(archiveRoot, { excludeBackupRoot: false });
    const first = archived.files[0];
    expect(first).toBeDefined();
    const target = join(archiveRoot, first?.relPath ?? '');
    const when = new Date(Date.now() + 60_000);
    await utimes(target, when, when);

    await expect(h.actions.undoLast({ auditId })).rejects.toMatchObject({
      code: 'E_ARCHIVE_VERIFY_FAILED',
    });
  });

  it('⚠️ the app never deletes anything under the archive root — no action can target it', async () => {
    const { h, archiveRoot } = await syncedFixture(sandbox);
    await archive(h, [SESSION_WITH_SUBAGENTS]);
    const afterArchive = await walkTree(archiveRoot, { excludeBackupRoot: false });
    expect(afterArchive.files.length).toBe(2);

    // Every other catalogue entry, run to completion against the same tree. §5.7 ACT-07 rule 4:
    // "There is no 'clear archive' action in v1." The archive root is not inside `claudeDir`, so
    // no rule's walk and no action's resolution can even name it.
    for (const actionType of [
      'delete-orphan-skill-folders',
      'clear-plugin-cache',
      'delete-duplicate-config-backups',
      'clear-backups',
    ] as const) {
      const preview = await h.actions.preview({ actionType, payload: {} });
      for (const target of preview.targets) {
        expect(join(archiveRoot, target.relPath)).not.toBe(target.relPath);
        expect(target.relPath.startsWith('/')).toBe(false);
      }
      if (preview.targets.length > 0) {
        await h.actions.execute({ actionType, payload: {}, confirmToken: preview.confirmToken });
      }
      h.setNow(Date.now() + 1000);
    }

    // ⚠️ Byte-for-byte identical afterwards.
    const afterEverything = await walkTree(archiveRoot, { excludeBackupRoot: false });
    expect(afterEverything.files).toEqual(afterArchive.files);
  });

  it('refuses a destination collision up front, moving nothing (§5.7 rule 2)', async () => {
    const { h, claudeDir, archiveRoot } = await syncedFixture(sandbox);
    // The destination is `<archiveRoot>/<claudeDirBasename>-<archiveId>` — occupy it.
    await mkdir(join(archiveRoot, 'claude-1'), { recursive: true });

    const payload = { sessionIds: [SESSION_WITH_SUBAGENTS] };
    const preview = await h.actions.preview({ actionType: 'archive-sessions', payload });
    await expect(
      h.actions.execute({
        actionType: 'archive-sessions',
        payload,
        confirmToken: preview.confirmToken,
      }),
    ).rejects.toMatchObject({ code: 'E_ARCHIVE_COLLISION' });

    expect(await entryKind(join(claudeDir, 'projects/-work-demo-alpha/sess-a.jsonl'))).toBe('file');
    // The collision is detected while building the restore point, so it is a backup-phase
    // failure: one audit row, nothing mutated (§5.5 rule 1, rule 6).
    const rows = h.actions.auditList({ limit: 10 }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'failed',
      targets: [],
      errorCode: 'E_ARCHIVE_COLLISION',
    });
  });

  it('refuses to archive a session twice', async () => {
    const { h } = await syncedFixture(sandbox);
    await archive(h, [SESSION_WITH_SUBAGENTS]);
    await expect(
      h.actions.preview({
        actionType: 'archive-sessions',
        payload: { sessionIds: [SESSION_WITH_SUBAGENTS] },
      }),
    ).rejects.toMatchObject({ code: 'E_ACTION_TARGET_GONE' });
  });

  it('archives:candidates is read-only, excludes archived sessions and mints no token', async () => {
    const { h } = await syncedFixture(sandbox);
    const all = h.actions.archiveCandidates({ olderThanTs: Date.now(), projectIds: null });
    expect(all.sessions.map((session) => session.id).toSorted()).toEqual([
      SESSION_WITH_SUBAGENTS,
      SESSION_WITHOUT_SUBAGENTS,
    ]);
    expect(all.totalBytes).toBe(all.sessions.reduce((sum, s) => sum + s.bytes, 0));
    // `sess-a`'s bytes include its subagent transcript — the whole file set (INV-20).
    const sessA = all.sessions.find((session) => session.id === SESSION_WITH_SUBAGENTS);
    expect(sessA?.bytes).toBe(1133 + 598);

    await archive(h, [SESSION_WITH_SUBAGENTS]);
    const after = h.actions.archiveCandidates({ olderThanTs: Date.now(), projectIds: null });
    expect(after.sessions.map((session) => session.id)).toEqual([SESSION_WITHOUT_SUBAGENTS]);

    // The cut-off is honoured, and an empty project filter selects nothing rather than everything.
    expect(h.actions.archiveCandidates({ olderThanTs: 0, projectIds: null }).sessions).toEqual([]);
    expect(
      h.actions.archiveCandidates({ olderThanTs: Date.now(), projectIds: [] }).sessions,
    ).toEqual([]);
  });
});

describe('⚠️ INV-19 — archiveRoot containment (ADR-034, `paths.ts`)', () => {
  const sandbox = useSandbox();

  it('refuses an archive root INSIDE claudeDir', async () => {
    const { h, claudeDir } = await syncedFixture(sandbox);
    const inside = join(claudeDir, 'archive-here');
    await mkdir(inside, { recursive: true });
    h.setArchiveRoot(inside);
    await expect(
      h.actions.preview({
        actionType: 'archive-sessions',
        payload: { sessionIds: [SESSION_WITH_SUBAGENTS] },
      }),
    ).rejects.toMatchObject({ code: 'E_ARCHIVE_ROOT_INVALID' });
    // ADR-034: "the destination is inside `<claudeDir>` … so the sessions would vanish from
    // every chart: a silent shrink by construction."
  });

  it('refuses an archive root that is a PARENT of claudeDir', async () => {
    const { h, claudeDir } = await syncedFixture(sandbox);
    h.setArchiveRoot(join(claudeDir, '..'));
    await expect(
      h.actions.preview({
        actionType: 'archive-sessions',
        payload: { sessionIds: [SESSION_WITH_SUBAGENTS] },
      }),
    ).rejects.toMatchObject({ code: 'E_ARCHIVE_ROOT_INVALID' });
  });

  it('refuses the backup root, and refuses when no root is set at all', async () => {
    const { h, claudeDir } = await syncedFixture(sandbox);
    h.setArchiveRoot(join(claudeDir, '.claude-lens-backups'));
    await expect(
      h.actions.preview({
        actionType: 'archive-sessions',
        payload: { sessionIds: [SESSION_WITH_SUBAGENTS] },
      }),
    ).rejects.toMatchObject({ code: 'E_ARCHIVE_ROOT_INVALID' });

    h.setArchiveRoot(null);
    await expect(
      h.actions.preview({
        actionType: 'archive-sessions',
        payload: { sessionIds: [SESSION_WITH_SUBAGENTS] },
      }),
    ).rejects.toMatchObject({ code: 'E_ARCHIVE_NO_ROOT' });
  });

  it('refuses a root that does not exist', async () => {
    const { h, archiveRoot } = await syncedFixture(sandbox);
    await rm(archiveRoot, { recursive: true, force: true });
    await expect(
      h.actions.preview({
        actionType: 'archive-sessions',
        payload: { sessionIds: [SESSION_WITH_SUBAGENTS] },
      }),
    ).rejects.toMatchObject({ code: 'E_ARCHIVE_ROOT_INVALID' });
  });
});
