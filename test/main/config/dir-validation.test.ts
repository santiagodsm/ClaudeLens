// §4.3 `dir:validate` — the four statuses, and the counted transcript total.

import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCodeForDirStatus, validateClaudeDir } from '../../../src/main/config/dir-validation';
import { BACKUP_ROOT_NAME } from '../../../src/main/config/paths';
import { useSandbox } from '../../support/sandbox';

describe('validateClaudeDir (§4.3)', () => {
  const sandbox = useSandbox();

  it('reports not_found for a path that does not exist', async () => {
    const result = await validateClaudeDir(sandbox.resolve('nope'));
    expect(result.status).toBe('not_found');
    expect(result.reason).toBeTypeOf('string');
    expect(result.transcriptFileCount).toBe(0);
  });

  it('reports not_found for a file rather than a directory', async () => {
    const file = sandbox.resolve('a-file');
    await writeFile(file, 'x');
    expect((await validateClaudeDir(file)).status).toBe('not_found');
  });

  it('reports invalid for a directory with neither projects/ nor history.jsonl', async () => {
    const dir = sandbox.resolve('empty');
    await mkdir(dir, { recursive: true });
    const result = await validateClaudeDir(dir);
    expect(result.status).toBe('invalid');
    expect(result.hasProjects).toBe(false);
    expect(result.hasHistory).toBe(false);
  });

  it('accepts a directory with history.jsonl alone', async () => {
    const dir = sandbox.resolve('history-only');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'history.jsonl'), '');
    const result = await validateClaudeDir(dir);
    expect(result.status).toBe('valid');
    expect(result.hasHistory).toBe(true);
    expect(result.hasProjects).toBe(false);
    // ⚠️ 0 is a LEGAL answer (§4.3) — a valid directory with no transcripts is READY_EMPTY,
    // not an error, and the count is never estimated to make it look better.
    expect(result.transcriptFileCount).toBe(0);
  });

  it('counts transcripts, and never counts the backup root (INV-14)', async () => {
    const dir = sandbox.resolve('claude');
    await mkdir(join(dir, 'projects', '-work-a'), { recursive: true });
    await mkdir(join(dir, 'projects', '-work-a', 's1', 'subagents'), { recursive: true });
    await mkdir(join(dir, BACKUP_ROOT_NAME, 'iso-1', 'projects'), { recursive: true });
    await writeFile(join(dir, 'projects', '-work-a', 's1.jsonl'), '');
    await writeFile(join(dir, 'projects', '-work-a', 's1', 'subagents', 'r1.jsonl'), '');
    await writeFile(join(dir, 'projects', '-work-a', 'notes.md'), '');
    // A restore point full of transcripts must not inflate the count — the app would then be
    // counting its own safety net as the user's data.
    await writeFile(join(dir, BACKUP_ROOT_NAME, 'iso-1', 'projects', 'old.jsonl'), '');

    const result = await validateClaudeDir(dir);
    expect(result.status).toBe('valid');
    expect(result.hasProjects).toBe(true);
    expect(result.transcriptFileCount).toBe(2);
  });
});

describe('errorCodeForDirStatus (§4.1)', () => {
  it('maps each non-valid status to its own closed-enum code', () => {
    // The renderer branches on `code`, never on `message` (§4.1 rule 2), so each status must
    // survive as a distinct code rather than collapsing into one generic failure.
    expect(errorCodeForDirStatus('unset')).toBe('E_NO_DIR');
    expect(errorCodeForDirStatus('not_found')).toBe('E_DIR_NOT_FOUND');
    expect(errorCodeForDirStatus('invalid')).toBe('E_DIR_INVALID');
    expect(errorCodeForDirStatus('unreadable')).toBe('E_DIR_UNREADABLE');
  });
});
