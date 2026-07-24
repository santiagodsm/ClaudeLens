// DESIGN §5.4 — the parse rules, implemented once, as a PURE function over one line.
//
// ⚠️ STACK ADR-009/ADR-013: "The parser must be a pure, injectable function over a line
// iterator so golden fixtures can drive it without touching a real directory." Nothing in
// this file imports `node:fs`, opens a connection, or reads a clock. That is not a style
// preference — it is what makes F-03, F-05, F-06 and F-07 able to state an expected value.
//
// ⛔ `Date.now()` must never appear in this file. §5.4 rule 2: "No timestamp is ever
// defaulted to 'now.'" A record we cannot time is a bad line, which is disclosed (§4.6) —
// it is never a row with a plausible, invented timestamp, because that is precisely the
// silently-wrong number this project exists to prevent (CLAUDE.md §1).

import { isWriteClass } from '../../shared/tool-taxonomy';
import type { LineSource, TranscriptSource } from './source-file';
import type { BadLineReason, ParsedLine, ParsedToolCall, TokenCounts } from './types';

/** §2.1 "Synthetic event" / §5.4 rule 7 — the literal model string, not a pattern. */
export const SYNTHETIC_MODEL = '<synthetic>';

/** §3.9 — `display_preview` is the first 280 characters of `display`. */
export const PROMPT_PREVIEW_CHARS = 280;

/**
 * §5.4 rule 8 — the token classes, mapped from `message.usage`.
 *
 * ⚠️ **AMENDED 2026-07-22 (A-05).** `cacheWriteFlat` is the aggregate
 * `cache_creation_input_tokens`; the 5-minute/1-hour split lives one level down, in
 * `message.usage.cache_creation`. See `readTokens` for which of the two wins and why.
 */
const TOKEN_FIELDS = {
  input: 'input_tokens',
  output: 'output_tokens',
  cacheWriteFlat: 'cache_creation_input_tokens',
  cacheRead: 'cache_read_input_tokens',
} as const;

/**
 * §5.4 rule 8 (A-05) — the object carrying the discriminator, and its two members.
 *
 * These names are the raw shape, verified present on **all 133,701** cache-writing events of the
 * reference dataset, where they summed **exactly** to `cache_creation_input_tokens` in every case.
 * They are read verbatim; nothing here guesses at a variant spelling (ADR-025's principle).
 */
const CACHE_CREATION = 'cache_creation';
const EPHEMERAL_5M = 'ephemeral_5m_input_tokens';
const EPHEMERAL_1H = 'ephemeral_1h_input_tokens';

/**
 * §5.4 rule 9 — for `Skill`, `skill_name` is `input.skill ?? input.command ?? input.name`,
 * "whichever is present first". The order is the rule; do not sort it.
 */
const SKILL_NAME_KEYS = ['skill', 'command', 'name'] as const;

/** §5.4 rule 9 — write-class `target_path` is `input.file_path ?? input.notebook_path`. */
const TARGET_PATH_KEYS = ['file_path', 'notebook_path'] as const;

/**
 * §5.4 rule 2 — "Transcript `timestamp` is ISO 8601 Z". Accepts a trailing `Z` or an explicit
 * numeric offset; both name an unambiguous instant. It deliberately does NOT accept a bare
 * local-time string, because `Date.parse` would then apply the machine's timezone and produce
 * a different number on a different machine (ADR-021).
 */
const ISO_8601_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------------------
// Field readers. Untrusted input: every one of these returns `null` rather than a guess.
// ---------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field, or `null`. An empty string is treated as absent (§5.4 rule 3's "non-empty"). */
function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A boolean field. Only a literal `true` is true; a truthy string is not a declared flag. */
function readBoolean(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

function readObject(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

/**
 * §5.4 rule 8 — "Absent fields are `0`, never `NULL`."
 *
 * A field that is present but is not a non-negative safe integer is treated as absent. It
 * cannot be stored (the column is `INTEGER`), it cannot be rounded (INV-11's whole point),
 * and dropping the entire event over one malformed counter would lose its timestamp from
 * M-07's stream. `0` here is the documented value for "no such count", not a substitution.
 */
function readTokenCount(usage: Record<string, unknown> | null, key: string): number {
  if (usage === null) return 0;
  const value = usage[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 0;
  return value;
}

/**
 * §5.4 rule 8 (A-05) — the 5-minute / 1-hour cache-write split, with its three cases stated
 * exhaustively so none of them is a fallthrough.
 *
 * ⚠️ **1. No `cache_creation` object** (older records). The flat `cache_creation_input_tokens`
 * goes to the 5-minute class and the 1-hour class is `0`. That is **exactly** what this parser
 * did before A-05, so an older record costs precisely what it always did — a fallback, not a
 * regression, and not a guess: `0` is the documented value for "the source did not split it".
 *
 * ⚠️ **2. The split is present and sums to the flat total.** Both classes are taken as given.
 * This is the case on 100% of the reference dataset's 133,701 cache-writing events.
 *
 * ⚠️ **3. The split is present and does NOT sum to the flat total.** The record contradicts
 * itself, and there is no honest way to pick a winner — so neither half is trusted. The flat
 * total stays in the 5-minute class (the aggregate the app has always billed on, unchanged), the
 * 1-hour share becomes `null` = **not known**, and the record is counted and disclosed
 * (§4.6 `Disclosures.cacheSplitMismatches`). ⚠️ Silently believing either number here is the
 * exact shape of CLAUDE.md §1's worst outcome: a plausible total that is wrong.
 *
 * The flat total's **presence** is what decides whether case 3 can apply at all. A record that
 * carries the split but no aggregate has nothing to contradict, so it is case 2.
 */
function readCacheWriteSplit(usage: Record<string, unknown> | null): {
  cacheWrite: number;
  cacheWrite1h: number | null;
} {
  const flat = readTokenCount(usage, TOKEN_FIELDS.cacheWriteFlat);
  const split = usage === null ? null : readObject(usage, CACHE_CREATION);
  if (split === null) return { cacheWrite: flat, cacheWrite1h: 0 }; // case 1

  const ephemeral5m = readTokenCount(split, EPHEMERAL_5M);
  const ephemeral1h = readTokenCount(split, EPHEMERAL_1H);
  const flatIsStated = usage !== null && typeof usage[TOKEN_FIELDS.cacheWriteFlat] === 'number';
  if (flatIsStated && ephemeral5m + ephemeral1h !== flat) {
    return { cacheWrite: flat, cacheWrite1h: null }; // case 3
  }
  return { cacheWrite: ephemeral5m, cacheWrite1h: ephemeral1h }; // case 2
}

function readTokens(message: Record<string, unknown> | null): TokenCounts {
  const usage = message === null ? null : readObject(message, 'usage');
  const cacheWrite = readCacheWriteSplit(usage);
  return {
    input: readTokenCount(usage, TOKEN_FIELDS.input),
    output: readTokenCount(usage, TOKEN_FIELDS.output),
    cacheWrite: cacheWrite.cacheWrite,
    cacheWrite1h: cacheWrite.cacheWrite1h,
    cacheRead: readTokenCount(usage, TOKEN_FIELDS.cacheRead),
  };
}

/**
 * §5.4 rule 8 (A-05) — "the split is present but does not sum to the flat total", as a predicate.
 *
 * Stated once, here, so `ingest.ts` counts the same condition `readCacheWriteSplit` produces
 * rather than a second copy of the rule (CLAUDE.md §1).
 */
export function hasCacheSplitMismatch(tokens: TokenCounts): boolean {
  return tokens.cacheWrite1h === null;
}

/**
 * §5.4 rule 2 — ISO 8601 Z → epoch ms.
 *
 * Returns `null` for anything unparseable, and the caller turns that into a bad line. There
 * is no fallback branch here on purpose.
 */
export function isoToEpochMs(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_8601_INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * §5.4 rule 2 — "`history.jsonl` `timestamp` is already ms epoch → used as is."
 *
 * "As is" is literal: no unit sniffing, no seconds-vs-milliseconds heuristic. A value that is
 * not a non-negative safe integer is not a timestamp we can use, and the line is bad.
 */
export function epochMsAsIs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

// ---------------------------------------------------------------------------------------
// §5.4 rule 9 — tool calls
// ---------------------------------------------------------------------------------------

/**
 * The first of `keys` whose value is a non-empty string.
 *
 * §5.4 writes this as `a ?? b ?? c`. Applied to untrusted input, `??` would hand back a
 * number or an object as a "name"; requiring a string keeps the column meaningful without
 * changing the order the rule fixes.
 */
function firstString(
  input: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  if (input === null) return null;
  for (const key of keys) {
    const value = readString(input, key);
    if (value !== null) return value;
  }
  return null;
}

/**
 * §5.4 rule 9 — the `tool_use` items of `message.content[]`, **in array order**.
 *
 * ⚠️ `ordinal` is the index within `message.content[]` (§3.6's column comment), not a
 * running count of tool calls. Either would be stable; §3.6 says which, and `UNIQUE
 * (event_id, ordinal)` is what makes tool-call ingest idempotent on it.
 *
 * ⚠️ A `Skill` whose input carries none of the three name keys still counts as a tool call
 * with `skill_name = NULL` (§5.4 rule 9, M-12) — dropping it would understate M-12.
 */
export function extractToolCalls(message: Record<string, unknown> | null): ParsedToolCall[] {
  if (message === null) return [];
  const content = message['content'];
  if (!Array.isArray(content)) return [];

  const calls: ParsedToolCall[] = [];
  for (let ordinal = 0; ordinal < content.length; ordinal += 1) {
    const item: unknown = content[ordinal];
    if (!isRecord(item) || item['type'] !== 'tool_use') continue;
    const toolName = readString(item, 'name');
    // `tool_calls.tool_name` is NOT NULL and the name is the whole identity of the call
    // (M-12/M-13/M-14 all group by it). An unnamed item is not a tool call we can attribute.
    if (toolName === null) continue;

    const input = readObject(item, 'input');
    const writeClass = isWriteClass(toolName);
    calls.push({
      ordinal,
      toolName,
      toolUseId: readString(item, 'id'),
      skillName: toolName === 'Skill' ? firstString(input, SKILL_NAME_KEYS) : null,
      subagentType: toolName === 'Agent' ? firstString(input, ['subagent_type']) : null,
      description: toolName === 'Agent' ? firstString(input, ['description']) : null,
      targetPath: writeClass ? firstString(input, TARGET_PATH_KEYS) : null,
      isWriteClass: writeClass,
    });
  }
  return calls;
}

// ---------------------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------------------

function bad(reason: BadLineReason): ParsedLine {
  return { outcome: 'bad', reason };
}

/** §5.4 rule 1 — one JSON object per line; anything else is a counted, skipped bad line. */
function decodeLine(text: string): Record<string, unknown> | BadLineReason {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'malformed_json';
  }
  return isRecord(value) ? value : 'not_an_object';
}

/**
 * §5.4 — normalize one line of one file. The single entry point; `source` carries the
 * answers to rules 4, 5 and 6, which come from the path and never from the record body
 * (§5.12).
 *
 * `lineNo` is the 1-based **physical** line number within the file. It is part of the
 * `event_key` fallback (ADR-019), so the append fast-path must keep counting from where the
 * last cycle stopped — see `jsonl-reader.ts` and `file_manifest.lines_parsed`.
 */
export function parseLine(source: LineSource, lineNo: number, text: string): ParsedLine {
  const record = decodeLine(text);
  if (typeof record === 'string') return bad(record);
  return source.kind === 'history'
    ? parsePromptRecord(lineNo, record)
    : parseEventRecord(source, lineNo, record);
}

/** §5.4 rules 2–11 for a transcript record. */
function parseEventRecord(
  source: TranscriptSource,
  lineNo: number,
  record: Record<string, unknown>,
): ParsedLine {
  // Rule 2 — FIRST, because a record we cannot time never becomes a row.
  const ts = isoToEpochMs(record['timestamp']);
  if (ts === null) return bad('no_timestamp');

  const message = readObject(record, 'message');
  const model = message === null ? null : readString(message, 'model');
  const uuid = readString(record, 'uuid');

  return {
    outcome: 'event',
    event: {
      // Rule 3 (ADR-019).
      eventKey: uuid ?? `${source.relPath}#${lineNo}`,
      lineNo,
      ts,
      // Rule 11 — verbatim, never guessed at. A record with no `type` gets the empty string
      // rather than an invented label: `type` is NOT NULL, and inventing 'unknown' would put
      // a word in the data that the file does not contain.
      type: readString(record, 'type') ?? '',
      role: readRole(record, message),
      // Rules 4–6 — from the path (ADR-020).
      origin: source.origin,
      sessionId: source.sessionId,
      encodedProject: source.encodedProject,
      uuid,
      parentUuid: readString(record, 'parentUuid'),
      // Rule 13 (migration 0011) — the API call this record came from, and the request that
      // produced it. ⚠️ Read, stored and NOTHING ELSE: `eventKey` above is still `uuid ?? path#line`
      // (rule 3, ADR-019), so these change no identity, no dedup and no token sum. Several records
      // of one assistant turn share `message.id` while each carries its own `uuid`; storing it is
      // what lets §4.6 count that instead of guessing at it.
      // ⚠️ `readString` returns `null` for absent AND for empty-string, which is the right
      // conflation here: an empty id names no call. No placeholder is ever written (§3.5, 0011).
      messageId: message === null ? null : readString(message, 'id'),
      requestId: readString(record, 'requestId'),
      // Rule 4 — stored, but NOT the origin decision.
      isSidechain: readBoolean(record, 'isSidechain'),
      model,
      // Rule 7 — stored so it can be counted and disclosed (M-01, F-06).
      isSynthetic: model === SYNTHETIC_MODEL,
      isApiError: readBoolean(record, 'isApiErrorMessage'),
      // Rule 8.
      tokens: readTokens(message),
      gitBranch: readString(record, 'gitBranch'),
      // §3.5 `cli_version` ← DESIGN_INPUT §2's "CLI version". Both spellings observed in the
      // wild map to the same column; neither value is invented.
      cliVersion: readString(record, 'version') ?? readString(record, 'cliVersion'),
      cwd: readString(record, 'cwd'),
      // Rule 9.
      toolCalls: extractToolCalls(message),
    },
  };
}

/**
 * §3.5 `role -- 'assistant' | 'user' | NULL`.
 *
 * `message.role` first, falling back to the record's own `type` when that is itself one of
 * the two roles. Both are values the file states; nothing is inferred from context, and an
 * unrecognised value is `NULL` rather than a bucket (M-11 counts on this column).
 */
function readRole(
  record: Record<string, unknown>,
  message: Record<string, unknown> | null,
): 'assistant' | 'user' | null {
  const candidates = [
    message === null ? null : readString(message, 'role'),
    readString(record, 'type'),
  ];
  for (const candidate of candidates) {
    if (candidate === 'assistant' || candidate === 'user') return candidate;
  }
  return null;
}

/** §5.4 rules 2 and 10 for a `history.jsonl` record (§3.9). */
function parsePromptRecord(lineNo: number, record: Record<string, unknown>): ParsedLine {
  // Rule 2 — already ms epoch, used as is. Still never defaulted.
  const ts = epochMsAsIs(record['timestamp']);
  if (ts === null) return bad('no_timestamp');

  const display = record['display'];
  const displayText = typeof display === 'string' ? display : null;

  return {
    outcome: 'prompt',
    prompt: {
      lineNo,
      ts,
      rawProject: readString(record, 'project'),
      sessionId: readString(record, 'sessionId'),
      // Rule 10 — truncated to 280 chars. ⚠️ `pastedContents` is never read, in any form
      // (§3.9): it is not stored, not measured and not counted.
      displayPreview: displayText === null ? null : displayText.slice(0, PROMPT_PREVIEW_CHARS),
      displayChars: displayText === null ? 0 : displayText.length,
    },
  };
}
