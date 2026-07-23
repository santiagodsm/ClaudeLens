// Streaming line iteration with byte accounting. STACK ADR-009, DESIGN §5.3.
//
// `node:readline` over `fs.createReadStream`, one line at a time. **A whole file is never
// `JSON.parse`d and never held in memory** — the reference dataset is ~1 GB across 2,064
// files and P-05 caps the worker at 512 MB RSS. Node core only: no `stream-json`, no
// `ndjson` (ADR-009's rejected list).
//
// ⚠️ The one hard rule here is §5.3's last paragraph: **a partial final line — an append
// caught mid-write — is not consumed.** The offset advances only to the last complete
// newline, so the remainder is read on the next cycle. Getting this wrong does not crash; it
// half-parses a record, counts a bad line, and then never comes back for the real one.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** One complete, newline-terminated line. Partial tails never reach a caller. */
export interface RawLine {
  /** 1-based physical line number within the file, continuing across appends. */
  readonly lineNo: number;
  readonly text: string;
}

export interface ReadJsonlOptions {
  /** §3.2 `byte_offset` — bytes already consumed; the resume point (§5.3). */
  readonly startByteOffset: number;
  /** §3.2 `lines_parsed` — complete lines already consumed, so `lineNo` stays absolute. */
  readonly startLineNo: number;
  /** Cooperative cancellation (§5.2 `CANCELLING`). Checked between lines. */
  readonly isCancelled?: () => boolean;
}

export interface ReadJsonlResult {
  /**
   * The new `file_manifest.byte_offset`: the end of the last COMPLETE line.
   * ⚠️ Never the file size when the tail was partial (§5.3).
   */
  readonly byteOffset: number;
  /** The new `file_manifest.lines_parsed` — complete lines consumed, including bad ones. */
  readonly linesParsed: number;
  /** True when the read stopped because `isCancelled()` went true. */
  readonly cancelled: boolean;
  /** True when the file ended with an unterminated tail that was deliberately left unread. */
  readonly partialTail: boolean;
}

/**
 * Streams the complete lines of `absolutePath` from `startByteOffset`, calling `onLine` for
 * each, and reports where the offset may safely advance to.
 *
 * ⚠️ **Byte accounting model.** JSONL here is `\n`-delimited (ADR-009: "the format here is
 * strictly one object per line — verified in HANDOFF §4"), so a complete line costs
 * `Buffer.byteLength(text) + 1` bytes. At end of stream the accounting is reconciled against
 * the stream's own `bytesRead`, which is authoritative: if the terminator was present the
 * offset is set to the exact end of file, and if it was not, the tail's bytes are left
 * unconsumed. Any accumulated disagreement therefore cannot outlive one file, and because
 * ingest is idempotent on `event_key` (ADR-019), re-reading bytes is harmless where losing
 * them would not be.
 */
export async function readJsonlLines(
  absolutePath: string,
  options: ReadJsonlOptions,
  onLine: (line: RawLine) => void,
): Promise<ReadJsonlResult> {
  const stream = createReadStream(absolutePath, { start: options.startByteOffset });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  let byteOffset = options.startByteOffset;
  let lineNo = options.startLineNo;
  let cancelled = false;
  let partialTail = false;
  // readline emits the trailing unterminated fragment as an ordinary line, so the last one
  // seen is always held back until end-of-stream proves whether it had a terminator.
  let held: string | null = null;

  try {
    for await (const line of reader) {
      if (options.isCancelled?.() === true) {
        cancelled = true;
        break;
      }
      if (held !== null) {
        lineNo += 1;
        byteOffset += Buffer.byteLength(held, 'utf8') + 1;
        onLine({ lineNo, text: held });
      }
      held = line;
    }

    if (!cancelled && held !== null) {
      const totalBytes = options.startByteOffset + stream.bytesRead;
      const terminatorBytes = totalBytes - byteOffset - Buffer.byteLength(held, 'utf8');
      if (terminatorBytes > 0) {
        // Terminated: the line is complete and the file's bytes are fully accounted for.
        lineNo += 1;
        byteOffset = totalBytes;
        onLine({ lineNo, text: held });
      } else {
        // §5.3 — a partial final line is NOT consumed. The offset stays before it and the
        // remainder is read next cycle, once the writer has finished.
        partialTail = true;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return { byteOffset, linesParsed: lineNo, cancelled, partialTail };
}
