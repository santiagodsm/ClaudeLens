// §5.4 rules 1–11, on the pure function, with no filesystem and no database.
//
// STACK ADR-009/ADR-013: "The parser must be a pure, injectable function over a line iterator
// so golden fixtures can drive it without touching a real directory." This file is the proof
// that it is one — every case below is a string literal and a return value.

import { describe, expect, it } from 'vitest';
import {
  extractToolCalls,
  hasCacheSplitMismatch,
  parseLine,
  SYNTHETIC_MODEL,
} from '../../../src/main/parse/parse-line';
import type { HistorySource, TranscriptSource } from '../../../src/main/parse/source-file';

const MAIN: TranscriptSource = {
  kind: 'transcript',
  relPath: 'projects/-work-demo-alpha/sess-a.jsonl',
  sessionId: 'sess-a',
  encodedProject: '-work-demo-alpha',
  origin: 'main',
};

const SUB: TranscriptSource = {
  kind: 'subagent_transcript',
  relPath: 'projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl',
  sessionId: 'sess-a',
  encodedProject: '-work-demo-alpha',
  origin: 'subagent',
};

const HISTORY: HistorySource = { kind: 'history', relPath: 'history.jsonl' };

const TS = '2024-05-01T09:00:00.000Z';
const TS_MS = 1_714_554_000_000;

const line = (record: unknown): string => JSON.stringify(record);

describe('§5.4 rule 1 — one JSON object per line', () => {
  it('counts a malformed line as bad, and is never fatal', () => {
    expect(parseLine(MAIN, 1, '{"broken":')).toEqual({ outcome: 'bad', reason: 'malformed_json' });
    expect(parseLine(MAIN, 1, '')).toEqual({ outcome: 'bad', reason: 'malformed_json' });
  });

  it('counts valid JSON that is not an object as bad', () => {
    // A JSON array, string or number is a line we cannot make a record of. It is counted
    // rather than skipped silently, so the disclosure is honest (§4.6).
    expect(parseLine(MAIN, 1, '[1,2,3]')).toEqual({ outcome: 'bad', reason: 'not_an_object' });
    expect(parseLine(MAIN, 1, '"a string"')).toEqual({ outcome: 'bad', reason: 'not_an_object' });
    expect(parseLine(MAIN, 1, 'null')).toEqual({ outcome: 'bad', reason: 'not_an_object' });
  });
});

describe('§5.4 rule 3 — event_key (ADR-019)', () => {
  it('uses `uuid` when present and non-empty', () => {
    const result = parseLine(MAIN, 7, line({ type: 'user', uuid: 'abc', timestamp: TS }));
    expect(result.outcome === 'event' && result.event.eventKey).toBe('abc');
  });

  it('falls back to `<rel_path>#<line_no>` when there is none', () => {
    for (const record of [
      { type: 'user', timestamp: TS },
      { type: 'user', uuid: '', timestamp: TS },
    ]) {
      const result = parseLine(MAIN, 7, line(record));
      expect(result.outcome === 'event' && result.event.eventKey).toBe(
        'projects/-work-demo-alpha/sess-a.jsonl#7',
      );
      expect(result.outcome === 'event' && result.event.uuid).toBeNull();
    }
  });
});

describe('§5.4 rules 4 and 5 — origin and session id come from the PATH (ADR-020)', () => {
  it('ignores the record body, which may disagree (§5.12)', () => {
    const record = line({
      type: 'assistant',
      uuid: 'x',
      timestamp: TS,
      sessionId: 'A-DIFFERENT-SESSION',
      isSidechain: false,
    });
    const result = parseLine(SUB, 1, record);
    expect(result.outcome).toBe('event');
    if (result.outcome !== 'event') return;
    // ⚠️ The file is under `.../sess-a/subagents/`, so origin is 'subagent' even though the
    // record declares `isSidechain: false`. Structural beats declared.
    expect(result.event.origin).toBe('subagent');
    expect(result.event.isSidechain).toBe(false); // stored, but NOT the decision
    expect(result.event.sessionId).toBe('sess-a');
  });

  it('marks a main-transcript record `main` even when it declares isSidechain: true', () => {
    const result = parseLine(
      MAIN,
      1,
      line({ type: 'assistant', timestamp: TS, isSidechain: true }),
    );
    expect(result.outcome === 'event' && result.event.origin).toBe('main');
    expect(result.outcome === 'event' && result.event.isSidechain).toBe(true);
  });
});

describe('§5.4 rule 7 — <synthetic>', () => {
  it('flags the literal model string and nothing else', () => {
    const synthetic = parseLine(
      MAIN,
      1,
      line({ type: 'assistant', timestamp: TS, message: { model: SYNTHETIC_MODEL } }),
    );
    expect(synthetic.outcome === 'event' && synthetic.event.isSynthetic).toBe(true);
    // The raw string is kept verbatim (ADR-025: no normalization, no aliasing).
    expect(synthetic.outcome === 'event' && synthetic.event.model).toBe('<synthetic>');

    for (const model of ['synthetic', '<SYNTHETIC>', 'claude-synthetic-1', null]) {
      const other = parseLine(
        MAIN,
        1,
        line({ type: 'assistant', timestamp: TS, message: { model } }),
      );
      expect(other.outcome === 'event' && other.event.isSynthetic).toBe(false);
    }
  });
});

describe('§5.4 rule 8 — tokens map 1:1; absent is 0, never NULL', () => {
  it('maps all five fields, taking the cache-write split from `cache_creation` (A-05)', () => {
    const result = parseLine(
      MAIN,
      1,
      line({
        type: 'assistant',
        timestamp: TS,
        message: {
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 3,
            // ⚠️ A-05 — the discriminator. 2 + 1 = 3, so the split is trusted and BOTH halves are
            // captured. Before A-05 the flat `3` went to `cacheWrite` and the 1-hour share — the
            // half that bills at 2x input rather than 1.25x — was thrown away.
            cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 1 },
            cache_read_input_tokens: 4,
          },
        },
      }),
    );
    expect(result.outcome === 'event' && result.event.tokens).toEqual({
      input: 1,
      output: 2,
      cacheWrite: 2,
      cacheWrite1h: 1,
      cacheRead: 4,
    });
  });

  it('captures a 1-hour-only write, which the flat total alone cannot express', () => {
    // ⚠️ The discriminating case: `cache_creation_input_tokens` is 500 either way, so a parser
    // that reads only the flat total is indistinguishable from a correct one here — until the
    // two classes are priced differently, which is what `a05-cache-write-1h-costing` pins.
    const result = parseLine(
      MAIN,
      1,
      line({
        type: 'assistant',
        timestamp: TS,
        message: {
          usage: {
            cache_creation_input_tokens: 500,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 },
          },
        },
      }),
    );
    expect(result.outcome === 'event' && result.event.tokens.cacheWrite).toBe(0);
    expect(result.outcome === 'event' && result.event.tokens.cacheWrite1h).toBe(500);
  });

  it('falls back to the flat total with 0 in the 1-hour class when `cache_creation` is absent', () => {
    // ⚠️ A-05 case 1, and the reason it is not a regression: this is EXACTLY what the parser did
    // for every record before the split existed — the flat `cache_creation_input_tokens` in the
    // 5-minute class — so an older record costs precisely what it always did. `0` is the
    // documented value for "the source did not split it", not a guess (§5.4 rule 8).
    const result = parseLine(
      MAIN,
      1,
      line({
        type: 'assistant',
        timestamp: TS,
        message: {
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
          },
        },
      }),
    );
    expect(result.outcome === 'event' && result.event.tokens).toEqual({
      input: 1,
      output: 2,
      cacheWrite: 3,
      cacheWrite1h: 0,
      cacheRead: 4,
    });
    expect(result.outcome === 'event' && hasCacheSplitMismatch(result.event.tokens)).toBe(false);
  });

  it('trusts NEITHER half when the split does not sum to the flat total, and says so', () => {
    // ⚠️ A-05 case 3. 2 + 1 = 3, not 10: the record contradicts itself. There is no honest way to
    // pick a winner, so the flat total — the aggregate the app has always billed on — stays in the
    // 5-minute class, the 1-hour share becomes `null` (NOT KNOWN, never 0), and the record is
    // counted so `Disclosures.cacheSplitMismatches` can report it. Silently believing either
    // number would be a plausible total that is wrong (CLAUDE.md §1).
    const result = parseLine(
      MAIN,
      1,
      line({
        type: 'assistant',
        timestamp: TS,
        message: {
          usage: {
            cache_creation_input_tokens: 10,
            cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 1 },
          },
        },
      }),
    );
    expect(result.outcome === 'event' && result.event.tokens.cacheWrite).toBe(10);
    expect(result.outcome === 'event' && result.event.tokens.cacheWrite1h).toBeNull();
    expect(result.outcome === 'event' && hasCacheSplitMismatch(result.event.tokens)).toBe(true);
  });

  it('uses the split as given when the record states no flat total to contradict it', () => {
    // "When both are present" is the assertion's own precondition. With no
    // `cache_creation_input_tokens` there is nothing to disagree with, so this is case 2.
    const result = parseLine(
      MAIN,
      1,
      line({
        type: 'assistant',
        timestamp: TS,
        message: {
          usage: {
            cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 9 },
          },
        },
      }),
    );
    expect(result.outcome === 'event' && result.event.tokens.cacheWrite).toBe(7);
    expect(result.outcome === 'event' && result.event.tokens.cacheWrite1h).toBe(9);
  });

  it('gives 0 for an absent usage block and for absent fields', () => {
    const noUsage = parseLine(MAIN, 1, line({ type: 'assistant', timestamp: TS, message: {} }));
    expect(noUsage.outcome === 'event' && noUsage.event.tokens).toEqual({
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
    });
    const partial = parseLine(
      MAIN,
      1,
      line({ type: 'assistant', timestamp: TS, message: { usage: { output_tokens: 5 } } }),
    );
    expect(partial.outcome === 'event' && partial.event.tokens).toEqual({
      input: 0,
      output: 5,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
    });
  });
});

describe('§5.4 rule 9 — tool calls', () => {
  it('takes tool_use items in array order, with ordinal = index within content[]', () => {
    // §3.6's column comment: "index of the tool_use item within message.content[]". The
    // text item at index 0 therefore leaves ordinal 0 unused.
    const calls = extractToolCalls({
      content: [
        { type: 'text', text: 'thinking' },
        { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/work/a.ts' } },
        { type: 'tool_use', id: 'u2', name: 'Write', input: { file_path: '/work/b.ts' } },
      ],
    });
    expect(calls.map((call) => [call.ordinal, call.toolName])).toEqual([
      [1, 'Read'],
      [2, 'Write'],
    ]);
  });

  it('resolves Skill names in the order `skill ?? command ?? name`, first present wins', () => {
    const withAll = extractToolCalls({
      content: [
        { type: 'tool_use', name: 'Skill', input: { skill: 'a', command: 'b', name: 'c' } },
      ],
    });
    expect(withAll[0]?.skillName).toBe('a');

    const withCommand = extractToolCalls({
      content: [{ type: 'tool_use', name: 'Skill', input: { command: 'b', name: 'c' } }],
    });
    expect(withCommand[0]?.skillName).toBe('b');

    const withName = extractToolCalls({
      content: [{ type: 'tool_use', name: 'Skill', input: { name: 'c' } }],
    });
    expect(withName[0]?.skillName).toBe('c');
  });

  it('⚠️ still counts a Skill call whose input carries none of the three keys', () => {
    // §5.4 rule 9: "if none is, `skill_name` stays `NULL` and the call still counts as a
    // tool call." Dropping it would understate M-12 (tool calls) to make M-13 (skill
    // invocations) tidier — a wrong headline number in exchange for a clean breakdown.
    const calls = extractToolCalls({
      content: [{ type: 'tool_use', name: 'Skill', input: { other: 'x' } }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.skillName).toBeNull();
    expect(calls[0]?.toolName).toBe('Skill');
  });

  it('reads Agent subagent_type and description', () => {
    const calls = extractToolCalls({
      content: [
        {
          type: 'tool_use',
          id: 'u9',
          name: 'Agent',
          input: { subagent_type: 'reviewer', description: 'check the diff' },
        },
      ],
    });
    expect(calls[0]).toMatchObject({
      toolName: 'Agent',
      toolUseId: 'u9',
      subagentType: 'reviewer',
      description: 'check the diff',
      isWriteClass: false,
      targetPath: null,
    });
  });

  it('resolves write-class target_path as file_path ?? notebook_path', () => {
    const [edit] = extractToolCalls({
      content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/work/a.ts' } }],
    });
    expect(edit).toMatchObject({ isWriteClass: true, targetPath: '/work/a.ts' });

    const [notebook] = extractToolCalls({
      content: [
        { type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: '/work/n.ipynb' } },
      ],
    });
    expect(notebook).toMatchObject({ isWriteClass: true, targetPath: '/work/n.ipynb' });

    // A write-class call that named no path is still a tool call; it just touches no file.
    const [pathless] = extractToolCalls({
      content: [{ type: 'tool_use', name: 'Write', input: {} }],
    });
    expect(pathless).toMatchObject({ isWriteClass: true, targetPath: null });

    // Non-write-class tools never get a target_path, even when their input names one.
    const [read] = extractToolCalls({
      content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/work/a.ts' } }],
    });
    expect(read).toMatchObject({ isWriteClass: false, targetPath: null });
  });

  it('ignores non-tool_use content and unnamed tool_use items', () => {
    expect(extractToolCalls({ content: [{ type: 'text', text: 'x' }] })).toEqual([]);
    expect(extractToolCalls({ content: [{ type: 'tool_use', input: {} }] })).toEqual([]);
    expect(extractToolCalls({ content: 'not an array' })).toEqual([]);
    expect(extractToolCalls(null)).toEqual([]);
  });
});

describe('§5.4 rule 10 — prompts (§3.9)', () => {
  it('truncates display to 280 characters and records the true length', () => {
    const display = 'x'.repeat(500);
    const result = parseLine(HISTORY, 3, line({ display, timestamp: TS_MS, project: '/work/a' }));
    expect(result.outcome).toBe('prompt');
    if (result.outcome !== 'prompt') return;
    expect(result.prompt.displayPreview).toHaveLength(280);
    expect(result.prompt.displayChars).toBe(500);
    expect(result.prompt.rawProject).toBe('/work/a');
    expect(result.prompt.lineNo).toBe(3);
  });

  it('⚠️ never reads pastedContents, in any form', () => {
    const result = parseLine(
      HISTORY,
      1,
      line({
        display: 'hi',
        timestamp: TS_MS,
        pastedContents: { 1: { content: 'BULK MATERIAL' } },
      }),
    );
    expect(JSON.stringify(result)).not.toContain('BULK MATERIAL');
    expect(JSON.stringify(result)).not.toContain('pastedContents');
  });
});

describe('§5.4 rule 11 — unknown types are stored verbatim', () => {
  it('keeps a type nobody has seen before, and never guesses at it', () => {
    const result = parseLine(
      MAIN,
      1,
      line({ type: 'some-future-record-kind', uuid: 'q', timestamp: TS }),
    );
    expect(result.outcome === 'event' && result.event.type).toBe('some-future-record-kind');
    // …and it is not forced into a role bucket either.
    expect(result.outcome === 'event' && result.event.role).toBeNull();
  });

  it('records role from message.role, falling back to the record type', () => {
    const fromMessage = parseLine(
      MAIN,
      1,
      line({ type: 'x', timestamp: TS, message: { role: 'assistant' } }),
    );
    expect(fromMessage.outcome === 'event' && fromMessage.event.role).toBe('assistant');
    const fromType = parseLine(MAIN, 1, line({ type: 'user', timestamp: TS }));
    expect(fromType.outcome === 'event' && fromType.event.role).toBe('user');
  });

  it('keeps provenance fields verbatim', () => {
    const result = parseLine(
      MAIN,
      1,
      line({
        type: 'assistant',
        timestamp: TS,
        gitBranch: 'feature/x',
        version: '1.2.3',
        cwd: '/work/demo/alpha',
        isApiErrorMessage: true,
        parentUuid: 'p1',
      }),
    );
    expect(result.outcome === 'event' && result.event).toMatchObject({
      gitBranch: 'feature/x',
      cliVersion: '1.2.3',
      cwd: '/work/demo/alpha',
      isApiError: true,
      parentUuid: 'p1',
    });
  });
});
