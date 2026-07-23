// Byte accounting and the partial-final-line rule (§5.3, STACK ADR-009).
//
// ⚠️ "A partial final line (an append caught mid-write) is **not** consumed: the offset
// advances only to the last complete newline, so the remainder is read on the next cycle."
// Getting this wrong does not crash — it half-parses a record, counts a bad line, and never
// comes back for the real one.

import { appendFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readJsonlLines, type RawLine } from '../../../src/main/parse/jsonl-reader';
import { useSandbox } from '../../support/sandbox';

async function readAll(
  path: string,
  startByteOffset = 0,
  startLineNo = 0,
): Promise<{ lines: RawLine[]; result: Awaited<ReturnType<typeof readJsonlLines>> }> {
  const lines: RawLine[] = [];
  const result = await readJsonlLines(path, { startByteOffset, startLineNo }, (line) =>
    lines.push(line),
  );
  return { lines, result };
}

describe('readJsonlLines', () => {
  const sandbox = useSandbox();

  it('numbers lines from 1 and consumes a well-terminated file entirely', async () => {
    const path = sandbox.resolve('a.jsonl');
    await writeFile(path, '{"a":1}\n{"a":2}\n{"a":3}\n');
    const { lines, result } = await readAll(path);

    expect(lines).toEqual([
      { lineNo: 1, text: '{"a":1}' },
      { lineNo: 2, text: '{"a":2}' },
      { lineNo: 3, text: '{"a":3}' },
    ]);
    expect(result.linesParsed).toBe(3);
    expect(result.byteOffset).toBe(24); // 3 × (7 content + 1 newline)
    expect(result.partialTail).toBe(false);
  });

  it('⚠️ leaves a partial final line unconsumed, and the offset short of the file', async () => {
    const path = sandbox.resolve('b.jsonl');
    await writeFile(path, '{"a":1}\n{"a":2}\n{"a":3');
    const { lines, result } = await readAll(path);

    // Only the two complete lines. The fragment is not handed to the parser at all, so it
    // never becomes a bad line — it is UNREAD, which is a different fact from unreadable.
    expect(lines.map((line) => line.text)).toEqual(['{"a":1}', '{"a":2}']);
    expect(result.linesParsed).toBe(2);
    expect(result.byteOffset).toBe(16); // stops before the 6-byte fragment
    expect(result.partialTail).toBe(true);
  });

  it('resumes from a byte offset and keeps line numbers absolute', async () => {
    const path = sandbox.resolve('c.jsonl');
    await writeFile(path, '{"a":1}\n{"a":2}\n');
    const first = await readAll(path);
    expect(first.result.byteOffset).toBe(16);

    await appendFile(path, '{"a":3}\n{"a":4}\n');
    const second = await readAll(path, first.result.byteOffset, first.result.linesParsed);

    // ⚠️ ADR-019's fallback `event_key` is `<rel_path>#<line_no>`, so line numbers MUST keep
    // counting across the resume. Restarting at 1 would collide the appended records' keys
    // with the ones already stored, and the append would silently ingest nothing.
    expect(second.lines).toEqual([
      { lineNo: 3, text: '{"a":3}' },
      { lineNo: 4, text: '{"a":4}' },
    ]);
    expect(second.result.byteOffset).toBe(32);
    expect(second.result.linesParsed).toBe(4);
  });

  it('completes a previously partial line on the next pass, exactly once', async () => {
    const path = sandbox.resolve('d.jsonl');
    await writeFile(path, '{"a":1}\n{"a":2');
    const first = await readAll(path);
    expect(first.lines.map((line) => line.text)).toEqual(['{"a":1}']);

    await appendFile(path, '}\n');
    const second = await readAll(path, first.result.byteOffset, first.result.linesParsed);
    expect(second.lines).toEqual([{ lineNo: 2, text: '{"a":2}' }]);
    expect(second.result.partialTail).toBe(false);
  });

  it('accounts for multi-byte characters in bytes, not characters', async () => {
    const path = sandbox.resolve('e.jsonl');
    // 'é' is 2 bytes in UTF-8; '😀' is 4. A character-based offset would drift and then
    // resume mid-codepoint on the next cycle.
    await writeFile(path, '{"a":"é"}\n{"a":"😀"}\n');
    const { result } = await readAll(path);
    expect(result.byteOffset).toBe(Buffer.byteLength('{"a":"é"}\n{"a":"😀"}\n', 'utf8'));
    expect(result.linesParsed).toBe(2);
  });

  it('handles an empty file and an offset already at the end', async () => {
    const path = sandbox.resolve('f.jsonl');
    await writeFile(path, '');
    const empty = await readAll(path);
    expect(empty.lines).toEqual([]);
    expect(empty.result.byteOffset).toBe(0);

    await writeFile(path, '{"a":1}\n');
    const atEnd = await readAll(path, 8, 1);
    expect(atEnd.lines).toEqual([]);
    expect(atEnd.result.byteOffset).toBe(8);
    expect(atEnd.result.linesParsed).toBe(1);
  });

  it('stops between lines when cancelled, without consuming what it did not emit', async () => {
    const path = sandbox.resolve('g.jsonl');
    await writeFile(path, '{"a":1}\n{"a":2}\n{"a":3}\n{"a":4}\n');
    const seen: RawLine[] = [];
    let emitted = 0;
    const result = await readJsonlLines(
      path,
      { startByteOffset: 0, startLineNo: 0, isCancelled: () => emitted >= 1 },
      (line) => {
        seen.push(line);
        emitted += 1;
      },
    );

    expect(result.cancelled).toBe(true);
    // The offset covers exactly what was emitted, so the next cycle re-reads only what it
    // must — and ADR-019 makes even that harmless.
    expect(result.byteOffset).toBe(seen.length * 8);
    expect(result.linesParsed).toBe(seen.length);
  });
});
