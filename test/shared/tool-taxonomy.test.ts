// Unit tests for src/shared/tool-taxonomy.ts — §3.6, §3.8, §5.9 M-15, §2.1.
//
// §3.6 requires the write-class set to be ONE exported constant "so §3.8 and §5.9 M-15 cannot
// drift apart". These tests pin the membership itself, because the set decides what lands in
// `file_touches` and therefore what M-15 counts.

import { describe, expect, it } from 'vitest';
import { WRITE_CLASS_TOOLS, isWriteClass } from '../../src/shared/tool-taxonomy';

describe('§3.6 — the write-class tool set', () => {
  it('is exactly the four tools §3.6 names, in order', () => {
    // §3.6: is_write_class = 1 iff tool_name IN ('Edit','MultiEdit','Write','NotebookEdit')
    expect(WRITE_CLASS_TOOLS).toEqual(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
  });

  it('has exactly four members — no fifth has crept in', () => {
    expect(WRITE_CLASS_TOOLS).toHaveLength(4);
  });

  it('holds no duplicates, so a Set built from it has the same size', () => {
    expect(new Set<string>(WRITE_CLASS_TOOLS).size).toBe(WRITE_CLASS_TOOLS.length);
  });
});

describe('isWriteClass — §3.6 / §2.1 "Write-class tool call"', () => {
  it.each(WRITE_CLASS_TOOLS)('classifies %s as write-class', (toolName) => {
    expect(isWriteClass(toolName)).toBe(true);
  });

  it.each([
    'Read', // reads a file but writes nothing
    'Glob',
    'Grep',
    'Bash', // may write via a shell command; §3.8 does not infer that (ADR-028)
    'Task',
    'Agent', // §2.1: a Tool call, and counted in M-12 — but not write-class
    'Skill',
    'WebFetch',
    'TodoWrite', // "Write" in the name, no file path (§3.6 target_path)
  ])('classifies %s as not write-class', (toolName) => {
    expect(isWriteClass(toolName)).toBe(false);
  });

  it('is case-sensitive: the transcript value is verbatim, never normalised', () => {
    expect(isWriteClass('edit')).toBe(false);
    expect(isWriteClass('EDIT')).toBe(false);
    expect(isWriteClass('multiedit')).toBe(false);
  });

  it('rejects near-misses rather than guessing', () => {
    expect(isWriteClass('')).toBe(false);
    expect(isWriteClass('Edit ')).toBe(false);
    expect(isWriteClass('NotebookEditCell')).toBe(false);
  });

  it('narrows the type when it returns true', () => {
    const toolName: string = 'MultiEdit';
    if (isWriteClass(toolName)) {
      // Compile-time proof the predicate narrows to WriteClassTool.
      const narrowed: 'Edit' | 'MultiEdit' | 'Write' | 'NotebookEdit' = toolName;
      expect(narrowed).toBe('MultiEdit');
    } else {
      throw new Error('MultiEdit must be write-class');
    }
  });
});
