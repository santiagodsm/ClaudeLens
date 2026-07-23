// §5.5 rule 7 / INV-14, stated over the WHOLE catalogue rather than over a sample.
//
// ⚠️ "No target may resolve inside the backup root — `E_ACTION_TARGET_FORBIDDEN` (INV-14). The one
// exception is `clear-backups`, whose targets are *only* inside it." The `guarded-action-review`
// gate asks for this per action, so the assertion below iterates `ACTION_CATALOGUE` itself: a
// hypothetical eighth entry would be covered the moment it is added, without anyone remembering to
// extend a list here.
//
// Also pinned here: §5.5 rule 3's typed-confirmation trigger set, and §5.6's watcher bracket
// around ACT-07 and its undo.

import { mkdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ACTION_CATALOGUE } from '../../../src/main/actions/catalogue';
import {
  assertTargetsAllowed,
  typedConfirmFor,
  type ResolvedTarget,
} from '../../../src/main/actions/targets';
import { BACKUP_ROOT_NAME } from '../../../src/main/config/paths';
import { useSandbox } from '../../support/sandbox';
import { createActionHarness } from '../../support/action-harness';
import { createSyncHarness, fixturePath } from '../../support/sync-harness';

const CLAUDE_DIR = '/sandbox/claude';

function target(relPath: string): ResolvedTarget {
  return { relPath, sizeBytes: 0, kind: 'directory' };
}

/**
 * The §4.1 error CODE a guard raises, or `null` when it allowed the target.
 *
 * ⚠️ Asserted on the code, never on the message: "the renderer never branches on `message`, only
 * on `code`" (§4.1 rule 2), and a test that pins the wording would fail on a copy edit while
 * passing on a weakened guard.
 */
function refusalCode(
  actionType: Parameters<typeof assertTargetsAllowed>[0],
  targets: ResolvedTarget[],
): string | null {
  try {
    assertTargetsAllowed(actionType, CLAUDE_DIR, targets);
    return null;
  } catch (cause) {
    return (cause as { code?: string }).code ?? 'E_UNEXPECTED';
  }
}

describe('⚠️ INV-14 over the whole catalogue (§5.5 rule 7)', () => {
  const insideBackupRoot = target(`${BACKUP_ROOT_NAME}/2026-01-01T00-00-00.000Z-1`);
  const outsideBackupRoot = target('skills/orphan');

  for (const spec of Object.values(ACTION_CATALOGUE)) {
    const label = `${spec.id} ${spec.actionType}`;

    if (spec.targetsAreTheBackupRoot) {
      it(`${label} — the ONE exception: its targets are only inside the backup root`, () => {
        expect(refusalCode(spec.actionType, [insideBackupRoot])).toBeNull();
        // …and it may not reach anything else. "Clearing backups may only remove restore points."
        expect(refusalCode(spec.actionType, [outsideBackupRoot])).toBe('E_ACTION_TARGET_FORBIDDEN');
      });
      continue;
    }

    it(`${label} — refuses a target inside the backup root`, () => {
      expect(refusalCode(spec.actionType, [insideBackupRoot])).toBe('E_ACTION_TARGET_FORBIDDEN');
      // The backup root itself, and a file deep inside a restore point, both refuse.
      expect(refusalCode(spec.actionType, [target(BACKUP_ROOT_NAME)])).toBe(
        'E_ACTION_TARGET_FORBIDDEN',
      );
      expect(
        refusalCode(spec.actionType, [target(`${BACKUP_ROOT_NAME}/x-1/projects/-a/s.jsonl`)]),
      ).toBe('E_ACTION_TARGET_FORBIDDEN');
      // …while an ordinary target passes, so the assertion is not vacuously refusing everything.
      expect(refusalCode(spec.actionType, [outsideBackupRoot])).toBeNull();
    });

    it(`${label} — refuses a target that escapes the Claude data directory`, () => {
      expect(refusalCode(spec.actionType, [target('../elsewhere')])).toBe(
        'E_ACTION_TARGET_FORBIDDEN',
      );
    });
  }

  it('a name that merely STARTS with the backup root’s name is not inside it', () => {
    // `.claude-lens-backups-old/` is a user directory that happens to share a prefix. Refusing it
    // would be wrong in the other direction — the containment check is on path segments.
    expect(
      refusalCode('delete-duplicate-config-backups', [
        target(`${BACKUP_ROOT_NAME}-old/config.bak`),
      ]),
    ).toBeNull();
  });
});

describe('§5.5 rule 3 — when typed confirmation is required', () => {
  it('requires it for settings.json, any CLAUDE.md, anything under projects/, and clear-backups', () => {
    const cases: { relPath: string; phrase: string }[] = [
      { relPath: 'settings.json', phrase: 'settings.json' },
      { relPath: 'settings.local.json', phrase: 'settings.local.json' },
      { relPath: 'a/CLAUDE.md', phrase: 'CLAUDE.md' },
      { relPath: 'projects/-a/anything.bak', phrase: 'anything.bak' },
    ];
    for (const item of cases) {
      const typed = typedConfirmFor('delete-duplicate-config-backups', [target(item.relPath)], 0);
      expect(typed).toEqual({ required: true, phrase: item.phrase });
    }
    // §5.5 rule 3's two named phrases.
    expect(typedConfirmFor('clear-backups', [], 0)).toEqual({
      required: true,
      phrase: 'clear backups',
    });
    // §5.7's table — ACT-07's phrase is neither a basename nor `clear backups`.
    expect(typedConfirmFor('archive-sessions', [], 3)).toEqual({
      required: true,
      phrase: 'archive 3 sessions',
    });
  });

  it('does not require it for an ordinary delete-class target', () => {
    expect(typedConfirmFor('delete-orphan-skill-folders', [target('skills/orphan')], 0)).toEqual({
      required: false,
      phrase: null,
    });
    expect(typedConfirmFor('clear-plugin-cache', [target('plugins/m/stale')], 0)).toEqual({
      required: false,
      phrase: null,
    });
  });
});

describe('§5.6 — every execution is bracketed with suspendWatcher/resumeWatcher', () => {
  const sandbox = useSandbox();

  it('brackets ACT-07 and its undo, exactly once each', async () => {
    const claudeDir = await sandbox.copyFixture(fixturePath('f03-append/base'), 'claude');
    const archiveRoot = sandbox.resolve('archive');
    await mkdir(archiveRoot, { recursive: true });
    const dbPath = sandbox.resolve('lens.db');

    const sync = createSyncHarness({ claudeDir, dbPath });
    await sync.runSync('full');
    sync.db.close();

    const h = createActionHarness({ claudeDir, dbPath, archiveRoot });
    const payload = { sessionIds: ['sess-a'] };
    const preview = await h.actions.preview({ actionType: 'archive-sessions', payload });
    // ⚠️ Preview does NOT suspend: it mutates nothing, so there is nothing for the watcher to
    // race, and suspending on a dialog the user may cancel would stop the app noticing a
    // transcript being appended to while they read it.
    expect(h.watcherCalls).toEqual([]);

    const result = await h.actions.execute({
      actionType: 'archive-sessions',
      payload,
      confirmToken: preview.confirmToken,
    });
    expect(h.watcherCalls).toEqual(['suspend', 'resume']);

    await h.actions.undoLast({ auditId: result.auditId });
    expect(h.watcherCalls).toEqual(['suspend', 'resume', 'suspend', 'resume']);
  });

  it('resumes even when the action refuses before doing anything', async () => {
    const claudeDir = await sandbox.copyFixture(fixturePath('f03-append/base'), 'claude2');
    const h = createActionHarness({ claudeDir, dbPath: sandbox.resolve('lens2.db') });
    await expect(
      h.actions.execute({
        actionType: 'delete-orphan-skill-folders',
        payload: {},
        confirmToken: 'never-minted',
      }),
    ).rejects.toMatchObject({ code: 'E_ACTION_NOT_CONFIRMED' });
    // A suspended watcher that never resumes would silently stop the app noticing new work.
    expect(h.watcherCalls).toEqual(['suspend', 'resume']);
  });
});
