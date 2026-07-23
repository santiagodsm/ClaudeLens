// SM-4, the guarded-action lifecycle — §5.5, §5.7, §4.8, ADR-032, INV-06, INV-07, INV-14.
//
// This is the file `guarded-action-review` (§12.2) reads. It must demonstrate, with a test:
//   · confirm → **backup before mutate** → undo → audit entry
//   · the backup-root exclusion (INV-14)
//   · that **nothing is ever auto-deleted, including backups**
//
// ⚠️ STACK ADR-013 — sandbox + one real SQLite file per test. The real `~/.claude` is unreachable
// by construction (`test/support/tripwire.ts` + `src/main/config/paths.ts`); nothing here works
// around either, and no test names a fixed path.

import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_ROOT_NAME } from '../../../src/main/config/paths';
import { ACTION_CATALOGUE, ACTION_TYPES } from '../../../src/main/actions/catalogue';
import { COPY_MANIFEST_NAME } from '../../../src/main/actions/restore-point';
import { entryKind } from '../../../src/main/harness/tree';
import { useSandbox } from '../../support/sandbox';
import { createActionHarness, writeTree, type ActionHarness } from '../../support/action-harness';

const TREE = {
  // BR-02 / ACT-01 — two orphaned skill folders and one real skill.
  'skills/orphan-a/': '',
  'skills/orphan-a/empty.txt': '',
  'skills/orphan-b/': '',
  'skills/real/SKILL.md': '---\nname: real\n---\nbody\n',
  // BR-01 / ACT-04 / ACT-05.
  'CLAUDE.md': '',
  'CLAUDE.md.bak': '# the rules that were lost\n',
  // BR-06 / ACT-03.
  'a/config.bak': 'aa',
};

async function harnessOn(
  sandbox: { resolve: (...s: string[]) => string },
  tree: Record<string, string> = TREE,
): Promise<{ h: ActionHarness; claudeDir: string }> {
  const claudeDir = sandbox.resolve('claude');
  await writeTree(claudeDir, tree);
  const h = createActionHarness({ claudeDir, dbPath: sandbox.resolve('lens.db') });
  return { h, claudeDir };
}

describe('the catalogue is CLOSED (§5.7, ADR-032)', () => {
  const sandbox = useSandbox();

  it('holds exactly the seven §5.7 entries and nothing else', () => {
    expect(ACTION_TYPES).toEqual([
      'delete-orphan-skill-folders',
      'clear-plugin-cache',
      'delete-duplicate-config-backups',
      'restore-claude-md',
      'delete-empty-claude-md',
      'clear-backups',
      'archive-sessions',
    ]);
    // ADR-032 as amended by ADR-034: "The catalogue remains closed at seven."
    expect(Object.keys(ACTION_CATALOGUE)).toHaveLength(7);
  });

  it('rejects anything else with E_ACTION_UNKNOWN, at preview and at execute', async () => {
    const { h } = await harnessOn(sandbox);
    await expect(
      h.actions.preview({ actionType: 'delete-everything', payload: {} }),
    ).rejects.toMatchObject({ code: 'E_ACTION_UNKNOWN' });
    await expect(
      h.actions.execute({ actionType: 'rm -rf', payload: {}, confirmToken: 'x' }),
    ).rejects.toMatchObject({ code: 'E_ACTION_UNKNOWN' });
  });
});

describe('§12.3 — the full round trip on a sandbox tree', () => {
  const sandbox = useSandbox();

  it('preview → confirm → backup → delete → undo → restored, with the audit entry correct at every step', async () => {
    const { h, claudeDir } = await harnessOn(sandbox);

    // ---- PREVIEWED ------------------------------------------------------------------
    const preview = await h.actions.preview({
      actionType: 'delete-orphan-skill-folders',
      payload: {},
    });
    expect(preview.targets.map((target) => target.relPath)).toEqual([
      'skills/orphan-a',
      'skills/orphan-b',
    ]);
    expect(preview.requiresTypedConfirm).toBe(false);
    expect(preview.confirmToken).not.toBe('');
    // ⚠️ Preview mutates NOTHING.
    expect(await entryKind(join(claudeDir, 'skills/orphan-a'))).toBe('directory');
    expect(h.actions.auditList({ limit: 10 }).rows).toEqual([]);

    // ---- BACKING_UP → EXECUTING → COMPLETED -------------------------------------------
    const result = await h.actions.execute({
      actionType: 'delete-orphan-skill-folders',
      payload: {},
      confirmToken: preview.confirmToken,
    });
    expect(result.status).toBe('completed');
    expect(result.result.succeeded).toEqual(['skills/orphan-a', 'skills/orphan-b']);
    expect(result.result.failed).toEqual([]);

    // The targets are gone, the real skill is untouched.
    expect(await entryKind(join(claudeDir, 'skills/orphan-a'))).toBeNull();
    expect(await entryKind(join(claudeDir, 'skills/real/SKILL.md'))).toBe('file');

    // ⚠️ The restore point exists on disk and holds the targets (INV-07).
    const backupRelPath = result.result.backupRelPath;
    expect(backupRelPath).not.toBeNull();
    expect(backupRelPath ?? '').toContain(BACKUP_ROOT_NAME);
    expect(await entryKind(join(claudeDir, backupRelPath ?? '', 'skills/orphan-a'))).toBe(
      'directory',
    );
    expect(await entryKind(join(claudeDir, backupRelPath ?? '', COPY_MANIFEST_NAME))).toBe('file');

    // ---- the audit entry (§3.14) -------------------------------------------------------
    const afterExecute = h.actions.auditList({ limit: 10 }).rows;
    expect(afterExecute).toHaveLength(1);
    const entry = afterExecute[0];
    expect(entry).toMatchObject({
      id: result.auditId,
      actionType: 'delete-orphan-skill-folders',
      status: 'completed',
      claudeDir,
      targets: ['skills/orphan-a', 'skills/orphan-b'],
      backupRelPath,
      backupPresent: true,
      undoneAt: null,
      undoOfId: null,
      errorCode: null,
    });
    expect(entry?.targetSummary).toBe('2 orphaned skill folders');
    expect(entry?.backupBytes).toBeGreaterThan(0);
    expect(h.completed).toEqual([{ auditId: result.auditId, status: 'completed' }]);

    // ⚠️ §5.6 — the whole execution was bracketed, exactly once.
    expect(h.watcherCalls).toEqual(['suspend', 'resume']);

    // ---- UNDOING → UNDONE ---------------------------------------------------------------
    const undo = await h.actions.undoLast({ auditId: result.auditId });
    expect(undo.status).toBe('undone');
    expect(undo.restored).toBe(2);
    expect(await entryKind(join(claudeDir, 'skills/orphan-a'))).toBe('directory');
    expect(await entryKind(join(claudeDir, 'skills/orphan-a/empty.txt'))).toBe('file');
    expect(await entryKind(join(claudeDir, 'skills/orphan-b'))).toBe('directory');

    // §5.5 rule 5 — a NEW entry with `undo_of_id`; the original keeps its status and gains
    // `undone_at` (which is what §3.14's `idx_audit_log_undoable` predicate is written for).
    const afterUndo = h.actions.auditList({ limit: 10 }).rows;
    expect(afterUndo).toHaveLength(2);
    const original = afterUndo.find((row) => row.id === result.auditId);
    const undoEntry = afterUndo.find((row) => row.id === undo.auditId);
    expect(original?.status).toBe('completed');
    expect(original?.undoneAt).not.toBeNull();
    expect(undoEntry?.status).toBe('undone');
    expect(undoEntry?.undoOfId).toBe(result.auditId);

    // ⚠️ No row is ever deleted (§3.14). Both entries survive, forever.
    expect(afterUndo.map((row) => row.id).toSorted()).toEqual([result.auditId, undo.auditId]);

    // ⚠️ Nothing is auto-deleted, including the backup: the restore point is still on disk
    // after the undo (§1.6 non-goal 4).
    expect(await entryKind(join(claudeDir, backupRelPath ?? ''))).toBe('directory');

    // The same action cannot be undone twice.
    await expect(h.actions.undoLast({ auditId: result.auditId })).rejects.toMatchObject({
      code: 'E_ACTION_NOTHING_TO_UNDO',
    });
  });
});

describe('⚠️ INV-07 — backup strictly precedes mutation', () => {
  const sandbox = useSandbox();

  it('mutates NOTHING when the backup fails, and records the failure as one audit row', async () => {
    const { h, claudeDir } = await harnessOn(sandbox);
    const preview = await h.actions.preview({
      actionType: 'delete-orphan-skill-folders',
      payload: {},
    });

    // Make the restore point impossible to create: put a FILE where the backup directory must
    // go, so `mkdir` fails. Nothing else about the tree changes.
    await writeFile(join(claudeDir, BACKUP_ROOT_NAME), 'not a directory', 'utf8');

    await expect(
      h.actions.execute({
        actionType: 'delete-orphan-skill-folders',
        payload: {},
        confirmToken: preview.confirmToken,
      }),
    ).rejects.toMatchObject({ code: 'E_ACTION_BACKUP_FAILED' });

    // ⚠️⚠️ THE assertion. Every target still exists.
    expect(await entryKind(join(claudeDir, 'skills/orphan-a'))).toBe('directory');
    expect(await entryKind(join(claudeDir, 'skills/orphan-a/empty.txt'))).toBe('file');
    expect(await entryKind(join(claudeDir, 'skills/orphan-b'))).toBe('directory');

    // §5.5 rule 6 — FAILED is a terminal state and writes exactly one row, which claims no undo.
    const rows = h.actions.auditList({ limit: 10 }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'failed',
      targets: [],
      bytesAffected: 0,
      backupRelPath: null,
      backupPresent: false,
      errorCode: 'E_ACTION_BACKUP_FAILED',
    });
    // Nothing is undoable, because nothing happened.
    await expect(h.actions.undoLast({ auditId: rows[0]?.id ?? 0 })).rejects.toMatchObject({
      code: 'E_ACTION_NOTHING_TO_UNDO',
    });
    // The watcher was still restored (§5.6): a suspended watcher that never resumes would
    // silently stop the app noticing new transcripts.
    expect(h.watcherCalls).toEqual(['suspend', 'resume']);
  });
});

describe('⚠️ INV-06 — the confirm token is what makes "confirm" real', () => {
  const sandbox = useSandbox();

  it('refuses when the target list changed between preview and execute', async () => {
    const { h, claudeDir } = await harnessOn(sandbox);
    const preview = await h.actions.preview({
      actionType: 'delete-orphan-skill-folders',
      payload: {},
    });
    expect(preview.targets).toHaveLength(2);

    // A third orphan appears after the user read the dialog. Executing now would delete
    // something they never saw — which is the whole gap §4.8 says the token closes.
    await writeTree(claudeDir, { 'skills/orphan-c/': '' });

    await expect(
      h.actions.execute({
        actionType: 'delete-orphan-skill-folders',
        payload: {},
        confirmToken: preview.confirmToken,
      }),
    ).rejects.toMatchObject({ code: 'E_ACTION_NOT_CONFIRMED' });

    // ⚠️ Nothing was touched — not the new one, not the two the user DID see.
    for (const name of ['orphan-a', 'orphan-b', 'orphan-c']) {
      expect(await entryKind(join(claudeDir, 'skills', name))).toBe('directory');
    }
    // ABORTED writes no audit row: nothing happened and nothing was promised (§5.5 rule 6).
    expect(h.actions.auditList({ limit: 10 }).rows).toEqual([]);
  });

  it('refuses when a target CHANGED SIZE, not only when one appeared or vanished', async () => {
    const { h, claudeDir } = await harnessOn(sandbox, {
      'a/config.bak': 'aa',
    });
    const preview = await h.actions.preview({
      actionType: 'delete-duplicate-config-backups',
      payload: {},
    });
    expect(preview.targets).toEqual([{ relPath: 'a/config.bak', sizeBytes: 2, kind: 'file' }]);

    // §6.9's dialog "lists every target WITH ITS SIZE", so the size is part of what was approved.
    await writeFile(join(claudeDir, 'a/config.bak'), 'a much longer body', 'utf8');

    await expect(
      h.actions.execute({
        actionType: 'delete-duplicate-config-backups',
        payload: {},
        confirmToken: preview.confirmToken,
      }),
    ).rejects.toMatchObject({ code: 'E_ACTION_NOT_CONFIRMED' });
    expect(await entryKind(join(claudeDir, 'a/config.bak'))).toBe('file');
  });

  it('is single-use — a replayed token cannot execute a second time', async () => {
    const { h, claudeDir } = await harnessOn(sandbox);
    const preview = await h.actions.preview({
      actionType: 'delete-orphan-skill-folders',
      payload: {},
    });
    await h.actions.execute({
      actionType: 'delete-orphan-skill-folders',
      payload: {},
      confirmToken: preview.confirmToken,
    });
    // Recreate the tree so the target list would hash the same again; only single-use stops it.
    await writeTree(claudeDir, {
      'skills/orphan-a/': '',
      'skills/orphan-a/empty.txt': '',
      'skills/orphan-b/': '',
    });
    await expect(
      h.actions.execute({
        actionType: 'delete-orphan-skill-folders',
        payload: {},
        confirmToken: preview.confirmToken,
      }),
    ).rejects.toMatchObject({ code: 'E_ACTION_NOT_CONFIRMED' });
    expect(await entryKind(join(claudeDir, 'skills/orphan-a'))).toBe('directory');
  });

  it('expires after five minutes (§4.8)', async () => {
    const claudeDir = sandbox.resolve('claude-expiry');
    await writeTree(claudeDir, TREE);
    const h = createActionHarness({ claudeDir, dbPath: sandbox.resolve('expiry.db') });
    const preview = await h.actions.preview({
      actionType: 'delete-orphan-skill-folders',
      payload: {},
    });
    // A dialog left open over lunch does not hold a licence to delete.
    h.setNow(Date.now() + 5 * 60 * 1000 + 1);
    await expect(
      h.actions.execute({
        actionType: 'delete-orphan-skill-folders',
        payload: {},
        confirmToken: preview.confirmToken,
      }),
    ).rejects.toMatchObject({ code: 'E_ACTION_NOT_CONFIRMED' });
    expect(await entryKind(join(claudeDir, 'skills/orphan-a'))).toBe('directory');
  });

  it('refuses a token minted for a DIFFERENT action', async () => {
    const { h } = await harnessOn(sandbox);
    const preview = await h.actions.preview({
      actionType: 'delete-orphan-skill-folders',
      payload: {},
    });
    await expect(
      h.actions.execute({
        actionType: 'delete-duplicate-config-backups',
        payload: {},
        confirmToken: preview.confirmToken,
      }),
    ).rejects.toMatchObject({ code: 'E_ACTION_NOT_CONFIRMED' });
  });
});

describe('⚠️ INV-14 — the backup root is off limits to every action but ACT-06', () => {
  const sandbox = useSandbox();
  const stamp = '2026-01-01T00-00-00.000Z-1';

  it('never resolves a target inside the backup root for the six other actions', async () => {
    const { h } = await harnessOn(sandbox, {
      ...TREE,
      // Every shape that would otherwise be a target, inside the restore-point folder.
      [`${BACKUP_ROOT_NAME}/${stamp}/skills/orphan-z/keep.txt`]: '',
      [`${BACKUP_ROOT_NAME}/${stamp}/a/config.bak`]: 'zz',
      [`${BACKUP_ROOT_NAME}/${stamp}/CLAUDE.md`]: '',
    });

    for (const actionType of [
      'delete-orphan-skill-folders',
      'delete-duplicate-config-backups',
    ] as const) {
      const preview = await h.actions.preview({ actionType, payload: {} });
      for (const target of preview.targets) {
        expect(target.relPath).not.toContain(BACKUP_ROOT_NAME);
      }
    }
  });

  it('refuses point-blank when a payload names a path inside the backup root', async () => {
    const { h } = await harnessOn(sandbox, {
      ...TREE,
      [`${BACKUP_ROOT_NAME}/${stamp}/CLAUDE.md`]: '',
      [`${BACKUP_ROOT_NAME}/${stamp}/CLAUDE.md.bak`]: '# stuff\n',
    });
    // ACT-05 takes an explicit rel_path, so this is the direct attack: name a backed-up file.
    await expect(
      h.actions.preview({
        actionType: 'delete-empty-claude-md',
        payload: { relPath: `${BACKUP_ROOT_NAME}/${stamp}/CLAUDE.md` },
      }),
    ).rejects.toMatchObject({ code: 'E_ACTION_TARGET_FORBIDDEN' });

    await expect(
      h.actions.preview({
        actionType: 'restore-claude-md',
        payload: {
          relPath: `${BACKUP_ROOT_NAME}/${stamp}/CLAUDE.md`,
          backupRelPath: `${BACKUP_ROOT_NAME}/${stamp}/CLAUDE.md.bak`,
        },
      }),
    ).rejects.toMatchObject({ code: 'E_ACTION_TARGET_FORBIDDEN' });
  });

  it('refuses a payload that tries to escape the Claude data directory', async () => {
    const { h } = await harnessOn(sandbox);
    await expect(
      h.actions.preview({
        actionType: 'delete-empty-claude-md',
        payload: { relPath: '../outside/CLAUDE.md' },
      }),
    ).rejects.toMatchObject({ code: 'E_ACTION_TARGET_FORBIDDEN' });
  });

  it('ACT-06 is the one exception: its targets are ONLY inside the backup root', async () => {
    const { h, claudeDir } = await harnessOn(sandbox);
    // Produce a real restore point by running a real action first.
    const first = await h.actions.preview({
      actionType: 'delete-orphan-skill-folders',
      payload: {},
    });
    const executed = await h.actions.execute({
      actionType: 'delete-orphan-skill-folders',
      payload: {},
      confirmToken: first.confirmToken,
    });
    expect(h.actions.backupsSummary().restorePoints).toBe(1);

    const preview = await h.actions.preview({ actionType: 'clear-backups', payload: {} });
    expect(preview.targets).toHaveLength(1);
    for (const target of preview.targets) expect(target.relPath).toContain(BACKUP_ROOT_NAME);
    // §5.5 rule 3 — typed confirmation, with the exact phrase §5.5 names.
    expect(preview.requiresTypedConfirm).toBe(true);
    expect(preview.typedConfirmPhrase).toBe('clear backups');

    const cleared = await h.actions.execute({
      actionType: 'clear-backups',
      payload: {},
      confirmToken: preview.confirmToken,
    });
    expect(cleared.status).toBe('completed');
    expect(await entryKind(join(claudeDir, executed.result.backupRelPath ?? ''))).toBeNull();

    // §3.14 — the earlier entry survives as history with its undo capability honestly withdrawn.
    const rows = h.actions.auditList({ limit: 10 }).rows;
    expect(rows).toHaveLength(2);
    const original = rows.find((row) => row.id === executed.auditId);
    expect(original).toBeDefined();
    expect(original?.backupPresent).toBe(false);
    expect(original?.backupRelPath).not.toBeNull();
    // ACT-06's own entry claims no restore point of its own — it IS the backups (§5.7).
    const clearEntry = rows.find((row) => row.id === cleared.auditId);
    expect(clearEntry?.backupRelPath).toBeNull();
    expect(clearEntry?.backupPresent).toBe(false);

    expect(h.actions.backupsSummary().restorePoints).toBe(0);
    await expect(h.actions.undoLast({ auditId: executed.auditId })).rejects.toMatchObject({
      code: 'E_ACTION_NOTHING_TO_UNDO',
    });
  });
});

describe('⚠️ nothing is EVER auto-deleted, including the app’s own backups (§1.6 non-goal 4)', () => {
  const sandbox = useSandbox();

  it('accumulates restore points across actions and prunes none of them', async () => {
    const { h, claudeDir } = await harnessOn(sandbox, {
      'a/one.bak': 'a',
      'a/two.bak': 'bb',
      'a/three.bak': 'ccc',
    });

    const paths: string[] = [];
    for (const relPath of ['a/one.bak', 'a/two.bak', 'a/three.bak']) {
      const preview = await h.actions.preview({
        actionType: 'delete-duplicate-config-backups',
        payload: { relPaths: [relPath] },
      });
      const result = await h.actions.execute({
        actionType: 'delete-duplicate-config-backups',
        payload: { relPaths: [relPath] },
        confirmToken: preview.confirmToken,
      });
      expect(result.status).toBe('completed');
      paths.push(result.result.backupRelPath ?? '');
      // The clock has to move, or three restore points share one `<iso>-<auditId>` prefix.
      h.setNow(Date.now() + paths.length * 1000);
    }

    // ⚠️ THE assertion: every restore point ever written is still there. No retention policy,
    // no age cap, no size cap, no silent pruning (OQ-103, ADR-032).
    expect(new Set(paths).size).toBe(3);
    for (const path of paths) expect(await entryKind(join(claudeDir, path))).toBe('directory');
    expect(h.actions.backupsSummary().restorePoints).toBe(3);
    expect(h.actions.backupsSummary().totalBytes).toBeGreaterThan(0);

    // …and only the most recent is undoable (§5.5 rule 5, single-level undo, §11.5).
    const rows = h.actions.auditList({ limit: 10 }).rows;
    const oldest = rows.reduce((min, row) => (row.id < min.id ? row : min));
    await expect(h.actions.undoLast({ auditId: oldest.id })).rejects.toMatchObject({
      code: 'E_ACTION_NOTHING_TO_UNDO',
    });
  });

  it('reports E_ACTION_BACKUP_MISSING rather than inventing a restore when the folder is gone', async () => {
    const { h, claudeDir } = await harnessOn(sandbox);
    const preview = await h.actions.preview({
      actionType: 'delete-orphan-skill-folders',
      payload: {},
    });
    const result = await h.actions.execute({
      actionType: 'delete-orphan-skill-folders',
      payload: {},
      confirmToken: preview.confirmToken,
    });
    // The user deleted the folder in Finder. `backup_present` is a database claim the
    // filesystem can outdate, so undo checks the disk rather than trusting the column.
    await rm(join(claudeDir, result.result.backupRelPath ?? ''), { recursive: true, force: true });
    await expect(h.actions.undoLast({ auditId: result.auditId })).rejects.toMatchObject({
      code: 'E_ACTION_BACKUP_MISSING',
    });
    expect(await entryKind(join(claudeDir, 'skills/orphan-a'))).toBeNull();
  });
});

describe('§5.5 rule 3 — typed confirmation, and ACT-04/ACT-05 (the CLAUDE.md pair)', () => {
  const sandbox = useSandbox();

  it('ACT-04 restores content from a sibling backup and is fully undoable', async () => {
    const { h, claudeDir } = await harnessOn(sandbox);
    const payload = { relPath: 'CLAUDE.md', backupRelPath: 'CLAUDE.md.bak' };

    const preview = await h.actions.preview({ actionType: 'restore-claude-md', payload });
    // §5.5 rule 3 — any CLAUDE.md target requires the typed phrase, which is the basename.
    expect(preview.requiresTypedConfirm).toBe(true);
    expect(preview.typedConfirmPhrase).toBe('CLAUDE.md');
    // Both files are listed: the user is approving "overwrite this WITH that", and §6.9 requires
    // every target with its size.
    expect(preview.targets.map((target) => target.relPath)).toEqual(['CLAUDE.md', 'CLAUDE.md.bak']);

    const result = await h.actions.execute({
      actionType: 'restore-claude-md',
      payload,
      confirmToken: preview.confirmToken,
    });
    expect(result.status).toBe('completed');
    // §5.7 — "the sole write of file content, and it is a whole-file copy of a file the user
    // already has — never authored content".
    expect(await readFile(join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe(
      '# the rules that were lost\n',
    );
    expect(result.result.succeeded).toEqual(['CLAUDE.md']);

    await h.actions.undoLast({ auditId: result.auditId });
    expect(await readFile(join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('');
    expect(await readFile(join(claudeDir, 'CLAUDE.md.bak'), 'utf8')).toBe(
      '# the rules that were lost\n',
    );
  });

  it('ACT-05 records a 0-byte restore point and refuses a file that has since gained content', async () => {
    const { h, claudeDir } = await harnessOn(sandbox);

    const preview = await h.actions.preview({
      actionType: 'delete-empty-claude-md',
      payload: { relPath: 'CLAUDE.md' },
    });
    expect(preview.typedConfirmPhrase).toBe('CLAUDE.md');
    expect(preview.targets).toEqual([{ relPath: 'CLAUDE.md', sizeBytes: 0, kind: 'file' }]);

    const result = await h.actions.execute({
      actionType: 'delete-empty-claude-md',
      payload: { relPath: 'CLAUDE.md' },
      confirmToken: preview.confirmToken,
    });
    // §5.7 — "the file (0 B, still recorded)". An empty file that existed is a different state
    // from a file that never did, so undo has to be able to bring it back.
    expect((await stat(join(claudeDir, result.result.backupRelPath ?? '', 'CLAUDE.md'))).size).toBe(
      0,
    );
    await h.actions.undoLast({ auditId: result.auditId });
    expect(await entryKind(join(claudeDir, 'CLAUDE.md'))).toBe('file');

    // A file that gained content is no longer this action's target — deleting it would destroy
    // exactly what BR-01 exists to save.
    await writeFile(join(claudeDir, 'CLAUDE.md'), '# rewritten\n', 'utf8');
    await expect(
      h.actions.preview({
        actionType: 'delete-empty-claude-md',
        payload: { relPath: 'CLAUDE.md' },
      }),
    ).rejects.toMatchObject({ code: 'E_ACTION_TARGET_GONE' });
  });
});
