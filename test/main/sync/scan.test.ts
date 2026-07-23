// The directory walk — INV-14 (the backup root is invisible), INV-17 (the root is a
// parameter), §3.2 (the `kind` enum).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_ROOT_NAME } from '../../../src/main/config/paths';
import { scanClaudeDirectory, SYNC_HASH_KINDS, SYNC_SCAN_KINDS } from '../../../src/main/sync/scan';
import { useSandbox } from '../../support/sandbox';

async function write(root: string, relPath: string, body: string): Promise<void> {
  const segments = relPath.split('/');
  const file = segments.pop() ?? '';
  if (segments.length > 0) await mkdir(join(root, ...segments), { recursive: true });
  await writeFile(join(root, ...segments, file), body);
}

async function buildTree(root: string): Promise<void> {
  await write(root, 'history.jsonl', '{}\n');
  await write(root, 'stats-cache.json', '{}');
  await write(root, 'projects/-work-demo-alpha/sess-a.jsonl', '{}\n');
  await write(root, 'projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl', '{}\n');
  await write(root, 'skills/alpha/SKILL.md', '# alpha\n');
  await write(root, 'agents/reviewer.md', '# reviewer\n');
  await write(root, 'CLAUDE.md', '# harness\n');
  await write(root, 'settings.json', '{}');
  await write(root, 'projects/-work-demo-alpha/memory/MEMORY.md', '# memory\n');
  await write(root, 'file-history/snapshot.bin', 'x');
  // ⚠️ INV-14 — the app's own restore points. Two levels deep, and a `.jsonl` inside, so a
  // rule that only skipped by extension or only at depth 1 would still expose it.
  await write(
    root,
    `${BACKUP_ROOT_NAME}/2024-05-01-1/projects/-work-demo-alpha/sess-a.jsonl`,
    '{}\n',
  );
  await write(root, `${BACKUP_ROOT_NAME}/2024-05-01-1/CLAUDE.md`, '# backed up\n');
}

describe('scanClaudeDirectory', () => {
  const sandbox = useSandbox();

  it('excludes the backup root from the manifest entirely (INV-14)', async () => {
    const root = sandbox.resolve('claude');
    await mkdir(root, { recursive: true });
    await buildTree(root);

    const result = await scanClaudeDirectory(root);
    const paths = result.files.map((file) => file.relPath);

    // Not one path, of any kind, from under the backup root. The app must never see its own
    // safety net — otherwise Bloat Radar offers to delete it and the watcher resyncs on the
    // app's own writes.
    expect(paths.some((path) => path.startsWith(`${BACKUP_ROOT_NAME}/`))).toBe(false);
    expect(paths.some((path) => path.includes(BACKUP_ROOT_NAME))).toBe(false);
    // The identically-named file OUTSIDE the backup root is still there, so the exclusion is
    // scoped to the root rather than to a filename.
    expect(paths).toContain('projects/-work-demo-alpha/sess-a.jsonl');
  });

  it('classifies every file into the §3.2 kind enum', async () => {
    const root = sandbox.resolve('claude');
    await mkdir(root, { recursive: true });
    await buildTree(root);

    const result = await scanClaudeDirectory(root);
    const byPath = new Map(result.files.map((file) => [file.relPath, file.kind]));
    expect(byPath.get('history.jsonl')).toBe('history');
    expect(byPath.get('stats-cache.json')).toBe('stats_cache');
    expect(byPath.get('projects/-work-demo-alpha/sess-a.jsonl')).toBe('transcript');
    expect(byPath.get('projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl')).toBe(
      'subagent_transcript',
    );
    expect(byPath.get('skills/alpha/SKILL.md')).toBe('skill_md');
    expect(byPath.get('agents/reviewer.md')).toBe('agent_md');
    expect(byPath.get('CLAUDE.md')).toBe('claude_md');
    expect(byPath.get('settings.json')).toBe('settings_json');
    expect(byPath.get('projects/-work-demo-alpha/memory/MEMORY.md')).toBe('memory_md');
    // ADR-028 — `file-history/` is not parsed in v1. It is still discovered and classified,
    // because Bloat Radar measures its size (§5.11).
    expect(byPath.get('file-history/snapshot.bin')).toBe('other');
  });

  it('filters to the parsed kinds and hashes only the non-JSONL ones', async () => {
    const root = sandbox.resolve('claude');
    await mkdir(root, { recursive: true });
    await buildTree(root);

    const result = await scanClaudeDirectory(root, {
      kinds: SYNC_SCAN_KINDS,
      hashKinds: SYNC_HASH_KINDS,
    });
    expect(result.files.map((file) => file.relPath)).toEqual([
      'history.jsonl',
      'projects/-work-demo-alpha/sess-a.jsonl',
      'projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl',
      'stats-cache.json',
    ]);
    // §3.2 — "`content_hash` is `NULL` for JSONL — hashing 1 GB per sync would defeat the
    // point." Only `stats-cache.json` is hashed.
    const hashed = result.files.filter((file) => file.contentHash !== null);
    expect(hashed.map((file) => file.relPath)).toEqual(['stats-cache.json']);
    // sha256('{}') — a fixed, verifiable value, not whatever the code produced.
    expect(hashed[0]?.contentHash).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });

  it('reports an unreadable subtree as data rather than throwing (§4.6)', async () => {
    const root = sandbox.resolve('missing-entirely');
    const result = await scanClaudeDirectory(root);
    expect(result.files).toEqual([]);
    expect(result.unreadable).toEqual(['.']);
  });

  it('takes its root as a parameter — two roots, two results (INV-17)', async () => {
    const first = sandbox.resolve('one');
    const second = sandbox.resolve('two');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await write(first, 'history.jsonl', '{}\n');
    await write(second, 'projects/-work-demo-beta/sess-b.jsonl', '{}\n');

    expect((await scanClaudeDirectory(first)).files.map((file) => file.relPath)).toEqual([
      'history.jsonl',
    ]);
    expect((await scanClaudeDirectory(second)).files.map((file) => file.relPath)).toEqual([
      'projects/-work-demo-beta/sess-b.jsonl',
    ]);
  });
});
