// Bloat Radar — §5.11's CLOSED rule set BR-01…BR-06, §3.12, §6.9.
//
// ⚠️ The two properties this file exists to pin:
//   · **INV-14** — no rule's walk sees `<claudeDir>/.claude-lens-backups/`, so the app can never
//     flag its own safety net as reclaimable.
//   · **BR-03 is actionless** — `action_type IS NULL`, no button, by design (§5.11, §11.2).

import { describe, expect, it } from 'vitest';
import { BACKUP_ROOT_NAME } from '../../../src/main/config/paths';
import { BloatFlagsRepository } from '../../../src/main/db/repositories/bloat-flags';
import { HarnessService } from '../../../src/main/harness/service';
import { useSandbox } from '../../support/sandbox';
import { writeTree } from '../../support/action-harness';
import { useTestDatabases } from '../db/helpers';

const SCANNED_AT = 1_760_000_000_000;

describe('§5.11 — the closed rule set', () => {
  const sandbox = useSandbox();
  const dbs = useTestDatabases(sandbox);

  async function scan(
    files: Record<string, string>,
    thresholdBytes = 64,
  ): Promise<{ service: HarnessService; claudeDir: string }> {
    const claudeDir = sandbox.resolve('claude');
    await writeTree(claudeDir, files);
    const service = new HarnessService({
      db: dbs.openMigrated(),
      claudeDir: () => claudeDir,
      now: () => SCANNED_AT,
      transcriptThresholdBytes: thresholdBytes,
    });
    await service.scan();
    return { service, claudeDir };
  }

  it('BR-01 — empty CLAUDE.md with a non-empty sibling backup, offering the RESTORE action', async () => {
    const { service } = await scan({
      'CLAUDE.md': '',
      'CLAUDE.md.bak': '# the real rules\n',
      'projects/-a/keep.jsonl': '{}',
    });
    const flag = service.bloatList().rows.find((row) => row.ruleId === 'BR-01');
    expect(flag?.severity).toBe('high');
    expect(flag?.location).toBe('CLAUDE.md');
    // ⚠️ §5.11 offers "ACT-04 or ACT-05" but §3.12 carries ONE action_type. The non-destructive
    // one is wired to the button; the destructive alternative is named in the rationale only.
    expect(flag?.actionType).toBe('restore-claude-md');
    expect(flag?.actionPayload).toEqual({ relPath: 'CLAUDE.md', backupRelPath: 'CLAUDE.md.bak' });
    expect(flag?.rationale).toContain('ACT-05');
  });

  it('BR-02 — an orphaned skill folder needs BOTH no SKILL.md and 0 B of content', async () => {
    const { service } = await scan({
      'skills/orphan/': '',
      'skills/orphan/empty.txt': '',
      'skills/real/SKILL.md': '---\nname: real\n---\nbody\n',
      // Not orphaned: no SKILL.md, but it holds bytes. §5.11 says "and", not "or".
      'skills/leftovers/notes.md': 'still has content',
    });
    const flags = service.bloatList().rows.filter((row) => row.ruleId === 'BR-02');
    expect(flags.map((flag) => flag.location)).toEqual(['skills/orphan']);
    expect(flags[0]?.actionType).toBe('delete-orphan-skill-folders');
  });

  it('BR-03 — installed but never invoked is surfaced, sized and explained, with NO action', async () => {
    const { service } = await scan({ 'skills/unused/SKILL.md': '---\nname: unused\n---\nbody\n' });
    const flag = service.bloatList().rows.find((row) => row.ruleId === 'BR-03');
    expect(flag?.severity).toBe('medium');
    expect(flag?.sizeBytes).toBeGreaterThan(0);
    // ⚠️⚠️ THE assertion for BR-03. §5.11: "deleting a skill because it shows zero invocations is
    // exactly the kind of irreversible act this app must not make easy". `null` renders as a card
    // with no button and the label "no automatic action in v1" (§3.12, §6.9).
    expect(flag?.actionType).toBeNull();
    expect(flag?.rationale).toContain('all time');
  });

  it('BR-04 — cached but not enabled; an enabled plugin is not flagged', async () => {
    const { service } = await scan({
      'settings.json': '{"enabledPlugins":["live"]}',
      'plugins/m/live/plugin.json': '{"name":"live"}',
      'plugins/m/stale/plugin.json': '{"name":"stale"}',
    });
    const flags = service.bloatList().rows.filter((row) => row.ruleId === 'BR-04');
    expect(flags.map((flag) => flag.location)).toEqual(['plugins/m/stale']);
    expect(flags[0]?.actionType).toBe('clear-plugin-cache');
  });

  it('BR-05 — reported, not enforced; its action opens a chooser rather than carrying a payload', async () => {
    const { service } = await scan(
      { 'projects/-a/s1.jsonl': 'x'.repeat(200), 'projects/-a/s2.jsonl': 'y'.repeat(200) },
      64,
    );
    const flag = service.bloatList().rows.find((row) => row.ruleId === 'BR-05');
    expect(flag?.severity).toBe('low');
    expect(flag?.sizeBytes).toBe(400);
    expect(flag?.itemCount).toBe(2);
    expect(flag?.actionType).toBe('archive-sessions');
    // ⚠️ ACT-07's payload is an explicit session list and the rule cannot know it — §6.9's
    // Archive… button calls `archives:candidates` first and the user sees every session.
    expect(flag?.actionPayload).toBeNull();
    // §1.6 non-goal 4 — nothing is capped, pruned or deleted at any size.
    expect(flag?.rationale).toContain('reported, not enforced');
  });

  it('BR-06 — stray backups outside the backup root, counted once each', async () => {
    const { service } = await scan({
      'a/config.bak': 'aa',
      'a/other.plaud-bak': 'bbb',
      'a/backups/old.json': 'cccc',
    });
    const flag = service.bloatList().rows.find((row) => row.ruleId === 'BR-06');
    expect(flag?.itemCount).toBe(3);
    expect(flag?.sizeBytes).toBe(9);
    expect(flag?.actionType).toBe('delete-duplicate-config-backups');
  });

  it('⚠️ INV-14 — nothing under the backup root is EVER flagged, by any rule', async () => {
    const stamp = '2026-01-01T00-00-00.000Z-1';
    const { service } = await scan({
      // Every shape that would trip a rule, all of it inside the app's own restore point.
      [`${BACKUP_ROOT_NAME}/${stamp}/CLAUDE.md`]: '',
      [`${BACKUP_ROOT_NAME}/${stamp}/CLAUDE.md.bak`]: '# content\n',
      [`${BACKUP_ROOT_NAME}/${stamp}/skills/orphan/empty.txt`]: '',
      [`${BACKUP_ROOT_NAME}/${stamp}/backups/old.json`]: 'x',
      [`${BACKUP_ROOT_NAME}/${stamp}/projects/-a/big.jsonl`]: 'z'.repeat(4096),
      // One real finding outside it, so a green result cannot be "the scan found nothing at all".
      'a/real.bak': 'yy',
    });

    const rows = service.bloatList().rows;
    expect(rows.map((row) => row.ruleId)).toContain('BR-06');
    for (const row of rows) {
      expect(row.location).not.toContain(BACKUP_ROOT_NAME);
      const payload = JSON.stringify(row.actionPayload ?? null);
      expect(payload).not.toContain(BACKUP_ROOT_NAME);
    }
    // The 4 KB transcript inside the restore point did not cross the 64 B threshold, because the
    // rule never saw it.
    expect(rows.some((row) => row.ruleId === 'BR-05')).toBe(false);
  });

  it('⚠️ the repository refuses a backup-root location even if a rule ever produced one', () => {
    // Belt and braces with the walk exclusion: two independent mechanisms, because "the app
    // flags its own safety net and offers to delete it" is not a failure worth one guard.
    const repo = new BloatFlagsRepository(dbs.openMigrated('guard.db'));
    expect(() =>
      repo.replaceAll(
        [
          {
            ruleId: 'BR-06',
            severity: 'low',
            title: 'x',
            location: `${BACKUP_ROOT_NAME}/2026-01-01T00-00-00.000Z-1`,
            sizeBytes: 1,
            itemCount: 1,
            rationale: 'x',
            actionType: 'delete-duplicate-config-backups',
            actionPayload: null,
          },
        ],
        SCANNED_AT,
      ),
    ).toThrow(/INV-14/);
  });

  it('replaces the whole table on each scan, so a resolved issue disappears (§3.12)', async () => {
    const claudeDir = sandbox.resolve('claude-replace');
    await writeTree(claudeDir, { 'a/config.bak': 'aa' });
    const service = new HarnessService({
      db: dbs.openMigrated('replace.db'),
      claudeDir: () => claudeDir,
      now: () => SCANNED_AT,
    });
    await service.scan();
    expect(service.bloatList().rows.some((row) => row.ruleId === 'BR-06')).toBe(true);

    await writeTree(claudeDir, { 'a/config.bak': '' });
    const { rm } = await import('node:fs/promises');
    await rm(sandbox.resolve('claude-replace', 'a', 'config.bak'));
    await service.scan();
    expect(service.bloatList().rows.some((row) => row.ruleId === 'BR-06')).toBe(false);
  });

  it('counts only actionable, non-archive flags as reclaimable (§5.11)', async () => {
    const { service } = await scan(
      {
        'skills/unused/SKILL.md': '---\nname: unused\n---\nbody\n', // BR-03, actionless
        'a/config.bak': 'aa', // BR-06, 2 bytes, actionable
        'projects/-a/s1.jsonl': 'x'.repeat(200), // BR-05, archived not freed
      },
      64,
    );
    const list = service.bloatList();
    expect(list.rows).toHaveLength(3);
    // ⚠️ Neither BR-03's bytes (no button) nor BR-05's (moved, not freed) are promised back.
    expect(list.totalReclaimableBytes).toBe(2);
  });
});
