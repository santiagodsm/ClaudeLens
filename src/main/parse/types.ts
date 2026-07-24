// The normalized shapes §5.4 produces. Column-for-column with §3.5, §3.6 and §3.9, so the
// gap between "what the parser returns" and "what the row is" is a rename and nothing more.
//
// Nothing here is a database type: the parser is pure and has never seen a connection
// (STACK ADR-009). `ingest.ts` is the only module that turns these into rows.

import type { Origin } from './source-file';

/**
 * §3.5 — the **five** token classes, mapped by §5.4 rule 8. Absent is `0`, never `NULL`.
 *
 * ⚠️ **AMENDED 2026-07-22 (A-05).** `cacheWrite` is now the **5-minute** class and `cacheWrite1h`
 * the 1-hour one, read from `message.usage.cache_creation`.
 */
export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  /**
   * The 5-minute class: `cache_creation.ephemeral_5m_input_tokens` when the split is present,
   * otherwise the flat `cache_creation_input_tokens` — which is exactly what this field held
   * before A-05, so a record with no `cache_creation` object costs precisely what it always did.
   */
  readonly cacheWrite: number;
  /**
   * The 1-hour class: `cache_creation.ephemeral_1h_input_tokens`.
   *
   * ⚠️ `0` when the record carries no `cache_creation` object — the documented value for "the
   * source did not split it", and today's behaviour exactly (§5.4 rule 8).
   *
   * ⚠️ `null` means **not known**, and is written only when the split is present but does NOT
   * sum to `cache_creation_input_tokens`. Neither half is trusted, the flat total stays in
   * `cacheWrite`, and the record is counted via `hasCacheSplitMismatch()` and disclosed
   * (§4.6 `Disclosures.cacheSplitMismatches`). It is never read as zero by anything that
   * reports it, exactly like `harness_nodes.entry_count` (migration 0003).
   */
  readonly cacheWrite1h: number | null;
  readonly cacheRead: number;
}

/** §3.6 — one `tool_use` content item, normalized by §5.4 rule 9. */
export interface ParsedToolCall {
  /** §3.6 — "index of the tool_use item within message.content[]": the raw array index. */
  readonly ordinal: number;
  readonly toolName: string;
  readonly toolUseId: string | null;
  /** §5.4 rule 9 — `Skill` only; `NULL` when none of the three keys carries a name. */
  readonly skillName: string | null;
  /** §5.4 rule 9 — `Agent` only. */
  readonly subagentType: string | null;
  /**
   * §5.4 rule 9 — `Agent` only. Persisted to `tool_calls.description` (§3.6, amended by
   * ruling A-09 / migration 0002) and read back at FINALIZING to fill §3.7
   * `subagent_runs.description` for a linked run.
   */
  readonly description: string | null;
  /** §5.4 rule 9 — write-class only: `input.file_path ?? input.notebook_path`. */
  readonly targetPath: string | null;
  /** §3.6 — from `WRITE_CLASS_TOOLS` in `src/shared/tool-taxonomy.ts`, never a second list. */
  readonly isWriteClass: boolean;
}

/** §3.5 — one normalized transcript record. */
export interface ParsedEvent {
  /** §5.4 rule 3, ADR-019 — `uuid` when present and non-empty, else `<rel_path>#<line_no>`. */
  readonly eventKey: string;
  /** 1-based physical line number within the source file; stable across the append fast-path. */
  readonly lineNo: number;
  /** §5.4 rule 2, ADR-021 — UTC epoch ms. Never defaulted, never "now". */
  readonly ts: number;
  /** §5.4 rule 11 — the raw `type`, verbatim. Unknown values are stored, never guessed at. */
  readonly type: string;
  readonly role: 'assistant' | 'user' | null;
  readonly origin: Origin;
  readonly sessionId: string;
  readonly encodedProject: string;
  readonly uuid: string | null;
  readonly parentUuid: string | null;
  /**
   * §5.4 rule 13 (migration 0011) — `message.id`, the API call this record came from. Several
   * records of one assistant turn share it while each keeps its own `uuid`.
   *
   * ⚠️ **Not part of event identity.** `eventKey` above is unchanged (ADR-019) and nothing keys,
   * dedups or merges on this. `null` when the record states none — never a placeholder.
   */
  readonly messageId: string | null;
  /** §5.4 rule 13 — the record's own `requestId`, verbatim. `null` when absent. */
  readonly requestId: string | null;
  /** §5.4 rule 4 — stored, but NOT the origin decision. The path is (ADR-020). */
  readonly isSidechain: boolean;
  readonly model: string | null;
  /** §5.4 rule 7 — `message.model === '<synthetic>'`. Stored so it can be disclosed. */
  readonly isSynthetic: boolean;
  readonly isApiError: boolean;
  readonly tokens: TokenCounts;
  readonly gitBranch: string | null;
  readonly cliVersion: string | null;
  readonly cwd: string | null;
  readonly toolCalls: readonly ParsedToolCall[];
}

/** §3.9 / §5.4 rule 10 — one `history.jsonl` line. `pastedContents` never appears here. */
export interface ParsedPrompt {
  readonly lineNo: number;
  /** §5.4 rule 2 — `history.jsonl` timestamps are ALREADY ms epoch; used as is. */
  readonly ts: number;
  /** The literal `project` value; matched onto a project at finalize time, kept either way. */
  readonly rawProject: string | null;
  readonly sessionId: string | null;
  /** §3.9 — first 280 characters of `display`. */
  readonly displayPreview: string | null;
  /** The full length of `display`, so truncation is visible without storing the text. */
  readonly displayChars: number;
}

/**
 * Why a line produced no row. Every one of these increments `file_manifest.bad_lines` and is
 * disclosed (§4.6) — never logged, never thrown, never fatal (§5.4 rule 1).
 */
export type BadLineReason =
  /** `JSON.parse` threw. */
  | 'malformed_json'
  /** Valid JSON, but not a JSON object — §5.4 rule 1 is "one JSON object per line". */
  | 'not_an_object'
  /** ⚠️ §5.4 rule 2 — no parseable timestamp. The record is skipped, NEVER stamped "now". */
  | 'no_timestamp';

export type ParsedLine =
  | { readonly outcome: 'event'; readonly event: ParsedEvent }
  | { readonly outcome: 'prompt'; readonly prompt: ParsedPrompt }
  | { readonly outcome: 'bad'; readonly reason: BadLineReason };
