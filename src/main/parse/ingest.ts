// DESIGN §5.2 rule 3 — "Every file is committed in its own transaction."
//
// This module joins the two halves of the epic: the pure §5.4 parser (which has never seen a
// database) and the §3.3–§3.16 schema (which has never seen a file). It owns no SQL — every
// statement lives in `src/main/db/repositories/**` (STACK ADR-008).
//
// ⚠️ **Read/parse is streamed; the write is one synchronous transaction.** `better-sqlite3`
// is synchronous and a transaction cannot span an `await`, so one file's normalized records
// are accumulated and then committed together. Memory is bounded by ONE FILE, never by the
// dataset (STACK ADR-009, P-05): the reference set averages ~470 KB per transcript. A crash
// or a cancel therefore leaves the manifest consistent with exactly what was committed, and
// the next cycle resumes from the recorded byte offset (§5.2 rule 3).
//
// ⚠️ **No timestamp-proximity heuristic exists anywhere in this file.** Subagent attribution
// is the path (ADR-020). Spawn linkage is the run's own `agent-*.meta.json` sidecar, then
// §3.7's `parent_uuid` → `uuid` chain, and nothing else (§3.7 as amended 2026-07-22). A run
// that resolves by neither stays unlinked, is counted and is disclosed (§4.6).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { languageForExtension } from '../../shared/language-map';
import { colorIndexFor } from '../../shared/color-index';
import type { IngestRepository, RecordSubagentMetaInput } from '../db/repositories/ingest-repo';
import type { ManifestRepository } from '../db/repositories/manifest-repo';
import { readJsonlLines } from './jsonl-reader';
import { hasCacheSplitMismatch, parseLine } from './parse-line';
import {
  describeSourceFile,
  displayNameForEncodedProject,
  type TranscriptSource,
} from './source-file';
import { isEmptySubagentMeta, readSubagentMeta } from './subagent-meta';
import type { ParsedEvent, ParsedPrompt } from './types';

export interface IngestRepositories {
  readonly ingest: IngestRepository;
  readonly manifest: ManifestRepository;
}

/** One unit of parse work, produced by §5.3's classification. */
export interface IngestFileInput {
  /** INV-17 — the root is a parameter. No module resolves `claudeDir` implicitly. */
  readonly claudeDir: string;
  readonly relPath: string;
  readonly manifestId: number;
  /** §3.2 `byte_offset` — 0 for NEW/SHRANK/REWROTE, the stored value for GREW. */
  readonly startByteOffset: number;
  /** §3.2 `lines_parsed` — carried forward so `<rel_path>#<line_no>` stays stable (ADR-019). */
  readonly startLineNo: number;
  /** §3.2 `bad_lines` — carried forward; `recordParse` writes absolutes, not deltas. */
  readonly startBadLines: number;
  /**
   * §3.2 `cache_split_mismatches` (A-05) — carried forward for the same reason as
   * `startBadLines`. Optional so that a caller written before A-05 keeps compiling and starts
   * from `0`, which is the correct value for a file that has never been parsed.
   */
  readonly startCacheSplitMismatches?: number;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly now: number;
  readonly isCancelled?: () => boolean;
}

export interface IngestFileResult {
  readonly relPath: string;
  /** Rows actually written to `events`/`prompts` — deduplicated records are not counted. */
  readonly recordsIngested: number;
  /** ADR-019 in action: records already present under the same `event_key`. */
  readonly recordsDeduplicated: number;
  /** §5.4 rule 1 — this file's total, absolute. */
  readonly badLines: number;
  /** §5.4 rule 8 (A-05) — this file's total, absolute. Counted, never fatal, disclosed (§4.6). */
  readonly cacheSplitMismatches: number;
  readonly linesParsed: number;
  readonly byteOffset: number;
  readonly cancelled: boolean;
  /** §5.3 — the tail was caught mid-write and deliberately left for the next cycle. */
  readonly partialTail: boolean;
}

const EMPTY_RESULT = (input: IngestFileInput): IngestFileResult => ({
  relPath: input.relPath,
  recordsIngested: 0,
  recordsDeduplicated: 0,
  badLines: input.startBadLines,
  cacheSplitMismatches: input.startCacheSplitMismatches ?? 0,
  linesParsed: input.startLineNo,
  byteOffset: input.startByteOffset,
  cancelled: false,
  partialTail: false,
});

/**
 * Parses one file and commits it. Returns the counters the sync cycle reports and the
 * manifest values that were written.
 */
export async function ingestFile(
  repos: IngestRepositories,
  input: IngestFileInput,
): Promise<IngestFileResult> {
  const source = describeSourceFile(input.relPath);
  if (source === null) return EMPTY_RESULT(input);
  if (source.kind === 'stats_cache') return ingestStatsCache(repos, input);

  const absolutePath = join(input.claudeDir, ...input.relPath.split('/'));
  const events: ParsedEvent[] = [];
  const prompts: ParsedPrompt[] = [];
  let badLines = input.startBadLines;
  // §5.4 rule 8 (A-05). A record whose `ephemeral_5m + ephemeral_1h` disagrees with its own
  // `cache_creation_input_tokens` is still a perfectly good event — it has a timestamp, a model
  // and a flat cache-write total — so it is stored, and only its SPLIT is marked not-known. The
  // count is the disclosure (§4.6), exactly as `bad_lines` is for a line that cannot be read.
  let cacheSplitMismatches = input.startCacheSplitMismatches ?? 0;

  const read = await readJsonlLines(
    absolutePath,
    {
      startByteOffset: input.startByteOffset,
      startLineNo: input.startLineNo,
      ...(input.isCancelled === undefined ? {} : { isCancelled: input.isCancelled }),
    },
    (line) => {
      const parsed = parseLine(source, line.lineNo, line.text);
      // §5.4 rule 1 / rule 2 — counted, skipped, never fatal, disclosed (§4.6).
      if (parsed.outcome === 'bad') badLines += 1;
      else if (parsed.outcome === 'event') {
        if (hasCacheSplitMismatch(parsed.event.tokens)) cacheSplitMismatches += 1;
        events.push(parsed.event);
      } else prompts.push(parsed.prompt);
    },
  );

  // §5.2 rule 3 — one transaction per file, covering the rows AND the manifest update, so
  // the offset can never be ahead of the data it claims to have consumed.
  const written = repos.ingest.inTransaction(() => {
    const counts =
      source.kind === 'history'
        ? writePrompts(repos.ingest, input.manifestId, prompts)
        : writeEvents(repos.ingest, input.manifestId, source, events);
    repos.manifest.recordParse({
      id: input.manifestId,
      byteOffset: read.byteOffset,
      linesParsed: read.linesParsed,
      badLines,
      cacheSplitMismatches,
      sizeBytes: input.sizeBytes,
      mtimeMs: input.mtimeMs,
      contentHash: null, // §3.2 — JSONL is never hashed; change detection is size+mtime.
      now: input.now,
    });
    return counts;
  });

  return {
    relPath: input.relPath,
    recordsIngested: written.inserted,
    recordsDeduplicated: written.deduplicated,
    badLines,
    cacheSplitMismatches,
    linesParsed: read.linesParsed,
    byteOffset: read.byteOffset,
    cancelled: read.cancelled,
    partialTail: read.partialTail,
  };
}

interface WriteCounts {
  readonly inserted: number;
  readonly deduplicated: number;
}

/**
 * §3.3–§3.8 — the transcript write path.
 *
 * Order matters and is structural: the project must exist before the session, the session
 * before the events, and — for a subagent transcript — the `subagent_runs` row before the
 * events that point at it (`events.subagent_run_id`, §3.5).
 */
function writeEvents(
  ingest: IngestRepository,
  manifestId: number,
  source: TranscriptSource,
  events: readonly ParsedEvent[],
): WriteCounts {
  // §3.3 — upserted by `encoded_name` even when the file turned out to be empty, so a
  // project directory that exists is a project (§2.1 "Project": exactly one directory).
  const projectId = ingest.upsertProject({
    encodedName: source.encodedProject,
    displayName: displayNameForEncodedProject(source.encodedProject),
    colorIndex: colorIndexFor(source.encodedProject),
  });

  // §3.4 — `transcript_file_id` is set only by the session's own MAIN transcript. A subagent
  // file may create the session row first (ADR-020: attribution is the path); the parent
  // transcript fills the column in whenever it arrives.
  ingest.upsertSession({
    sessionId: source.sessionId,
    projectId,
    transcriptFileId: source.origin === 'main' ? manifestId : null,
  });

  // §3.7 — one run per subagent transcript file. Created before its events so they can
  // carry `subagent_run_id`; `first_ts`/`last_ts` and the spawn link are set at finalize.
  const subagentRunId =
    source.kind === 'subagent_transcript'
      ? ingest.upsertSubagentRun(source.sessionId, projectId, manifestId)
      : null;

  let inserted = 0;
  let deduplicated = 0;

  for (const event of events) {
    const row = ingest.insertEvent({
      eventKey: event.eventKey,
      sessionId: event.sessionId,
      projectId,
      sourceFileId: manifestId,
      lineNo: event.lineNo,
      ts: event.ts,
      type: event.type,
      role: event.role,
      origin: event.origin,
      subagentRunId,
      uuid: event.uuid,
      parentUuid: event.parentUuid,
      // Migration 0011 — stored so §4.6 can COUNT records that share an API call. ⚠️ The insert
      // below is still `ON CONFLICT(event_key) DO NOTHING`: these are not a second dedup key and
      // no record is dropped, merged or re-counted because of them.
      messageId: event.messageId,
      requestId: event.requestId,
      isSidechain: event.isSidechain ? 1 : 0,
      model: event.model,
      isSynthetic: event.isSynthetic ? 1 : 0,
      isApiError: event.isApiError ? 1 : 0,
      tokInput: event.tokens.input,
      tokOutput: event.tokens.output,
      tokCacheWrite: event.tokens.cacheWrite,
      // A-05 — `null` only when §5.4 rule 8's sum assertion failed. NULL is "not known" and is
      // never read as zero by anything that reports it (§4.6, migration 0005).
      tokCacheWrite1h: event.tokens.cacheWrite1h,
      tokCacheRead: event.tokens.cacheRead,
      gitBranch: event.gitBranch,
      cliVersion: event.cliVersion,
      cwd: event.cwd,
    });
    if (row.inserted) inserted += 1;
    else deduplicated += 1;

    for (const call of event.toolCalls) {
      // §3.6 — idempotent on (event_id, ordinal), so this is safe for a deduplicated event
      // too: the second file's copy of the same record writes nothing new.
      const toolCallId = ingest.insertToolCall({
        eventId: row.id,
        sessionId: event.sessionId,
        projectId,
        origin: event.origin,
        ts: event.ts,
        ordinal: call.ordinal,
        toolName: call.toolName,
        toolUseId: call.toolUseId,
        skillName: call.skillName,
        subagentType: call.subagentType,
        // §3.6 (amended, A-09) / §5.4 rule 9 — `Agent` only. §3.7 reads it back at
        // FINALIZING to label the spawned run; it is stored, never re-derived from memory.
        description: call.description,
        targetPath: call.targetPath,
        isWriteClass: call.isWriteClass ? 1 : 0,
      });

      // §3.8 — file touches are DERIVED FROM write-class tool calls (ADR-028: `file-history/`
      // is not parsed in v1). A write-class call that named no path produces no touch; it is
      // still a tool call and still counts in M-12.
      if (!call.isWriteClass || call.targetPath === null) continue;
      const basename = basenameOf(call.targetPath);
      const extension = extensionOf(basename);
      ingest.insertFileTouch({
        toolCallId,
        sessionId: event.sessionId,
        projectId,
        ts: event.ts,
        path: call.targetPath,
        basename,
        extension,
        language: languageForExtension(extension),
        toolName: call.toolName,
      });
    }
  }

  return { inserted, deduplicated };
}

/** §3.9 — `history.jsonl`. `project_id` is resolved at finalize, never here (INV-04). */
function writePrompts(
  ingest: IngestRepository,
  manifestId: number,
  prompts: readonly ParsedPrompt[],
): WriteCounts {
  let inserted = 0;
  let deduplicated = 0;
  for (const prompt of prompts) {
    const wrote = ingest.insertPrompt({
      sourceFileId: manifestId,
      lineNo: prompt.lineNo,
      ts: prompt.ts,
      rawProject: prompt.rawProject,
      sessionId: prompt.sessionId,
      displayPreview: prompt.displayPreview,
      displayChars: prompt.displayChars,
    });
    if (wrote) inserted += 1;
    else deduplicated += 1;
  }
  return { inserted, deduplicated };
}

/**
 * §3.16 — `stats-cache.json`, stored as day-keyed objects, verbatim.
 *
 * ⚠️ §11.4: the file's field-level schema "is not documented in any verified source". This
 * therefore reads exactly the one thing DESIGN_INPUT §2 verifies — that it contains per-day
 * entries — and stores nothing else. **No value from this table is ever summed into,
 * substituted into or reconciled against a displayed metric** (ADR-029); its only consumer is
 * day-presence in M-16. A shape this does not recognise stores zero days, which understates
 * `DataCoverage.statsCacheDays` and can move no other number.
 *
 * This is the one file read whole rather than streamed, and legitimately so: it is a single
 * small JSON document, not line-delimited (ADR-009 governs JSONL).
 */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

async function ingestStatsCache(
  repos: IngestRepositories,
  input: IngestFileInput,
): Promise<IngestFileResult> {
  const absolutePath = join(input.claudeDir, ...input.relPath.split('/'));
  let days: [string, unknown][] = [];
  let badLines = input.startBadLines;
  try {
    const parsed: unknown = JSON.parse(await readFile(absolutePath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      days = Object.entries(parsed).filter(
        ([key, value]) => DAY_KEY.test(key) && typeof value === 'object' && value !== null,
      );
    }
  } catch {
    // §5.4 rule 1's principle, applied to the one non-JSONL parsed file: counted, never fatal.
    badLines += 1;
  }

  repos.ingest.inTransaction(() => {
    for (const [day, value] of days) {
      repos.ingest.upsertStatsCacheDay(day, JSON.stringify(value), input.manifestId);
    }
    repos.manifest.recordParse({
      id: input.manifestId,
      // Not line-delimited: the byte offset is meaningless here, and §5.3 hashes non-JSONL
      // files instead. The hash is supplied by the scanner and written by the caller's
      // classification, so nothing is stored that would resume a byte-wise read.
      byteOffset: 0,
      linesParsed: days.length,
      badLines,
      // A `stats-cache.json` has no transcript records, so it can carry no split to disagree
      // with. Carried forward rather than zeroed, for the same reason `badLines` is.
      cacheSplitMismatches: input.startCacheSplitMismatches ?? 0,
      sizeBytes: input.sizeBytes,
      mtimeMs: input.mtimeMs,
      contentHash: null,
      now: input.now,
    });
  });

  return {
    relPath: input.relPath,
    recordsIngested: days.length,
    recordsDeduplicated: 0,
    badLines,
    cacheSplitMismatches: input.startCacheSplitMismatches ?? 0,
    linesParsed: days.length,
    byteOffset: 0,
    cancelled: false,
    partialTail: false,
  };
}

/**
 * §5.2 FINALIZING — every cross-file derivation, recomputed from current table contents.
 *
 * ⚠️ This is the step that makes INV-04 hold. Session bounds, project bounds, run bounds,
 * prompt→project resolution and spawn linkage all depend on rows from OTHER files, so a
 * value accumulated while parsing one file would differ between a cold parse and an append.
 * Recomputing after every file is committed makes the result a pure function of the data.
 *
 * ⚠️ §3.7 (AMENDED 2026-07-22) — reading the `agent-*.meta.json` sidecars happens HERE, not
 * in `writeEvents`, and that placement is the whole INV-04 argument. A run's spawn point is a
 * fact about a DIFFERENT file (the parent transcript's `Agent` call), so recording it while
 * parsing the subagent transcript would make the answer depend on which file the cycle
 * happened to reach first. Read at FINALIZING and recomputed from current table contents, an
 * append and a cold parse agree.
 *
 * `claudeDir` is a parameter (INV-17). Nothing here resolves a root.
 */
export async function finalizeIngest(repos: IngestRepositories, claudeDir: string): Promise<void> {
  await readSubagentSidecars(repos.ingest, claudeDir);
  repos.ingest.finalize();
}

/**
 * §3.7 (AMENDED 2026-07-22) — the run's own `subagents/<run-id>.meta.json`, read into
 * `subagent_runs.meta_*`. Returns how many runs were probed, which is bookkeeping for tests,
 * never a displayed number.
 *
 * ⚠️ WHY A PROBE AND NOT A PARSE-TIME READ. Only runs whose `meta_agent_type` is still NULL
 * are opened, so the steady-state cost is zero once every sidecar has been read once — and,
 * more importantly, a database that was populated BEFORE migration 0008 fills itself in on
 * the next ordinary sync instead of demanding a rebuild. A run that genuinely has no sidecar
 * is re-probed each cycle; that is one failed `open()` per such run, and it is the price of
 * picking up a sidecar that appears later. Archived transcripts are excluded by the query
 * itself — they are never re-read (§5.3 `ARCHIVED`, ADR-034).
 *
 * ⚠️ Reads are sequential on purpose. A missing sidecar is the common case for old data, and
 * a fan-out of thousands of concurrent `open()` calls against a directory the watcher is also
 * touching buys nothing measurable and risks EMFILE.
 */
export async function readSubagentSidecars(
  ingest: IngestRepository,
  claudeDir: string,
): Promise<number> {
  const pending = ingest.subagentRunsMissingMeta();
  if (pending.length === 0) return 0;

  const rows: RecordSubagentMetaInput[] = [];
  for (const run of pending) {
    const meta = await readSubagentMeta(claudeDir, run.relPath);
    // Nothing known: leave the row exactly as it is, so the next cycle probes it again.
    // Writing three NULLs over three NULLs would be a no-op with extra steps.
    if (isEmptySubagentMeta(meta)) continue;
    rows.push({
      id: run.id,
      agentType: meta.agentType,
      toolUseId: meta.toolUseId,
      description: meta.description,
    });
  }
  ingest.recordSubagentMeta(rows);
  return rows.length;
}

/** The last `/`-separated segment. The path is a tool argument, stored verbatim (§3.8). */
function basenameOf(path: string): string {
  const index = path.lastIndexOf('/');
  const tail = index === -1 ? path : path.slice(index + 1);
  return tail === '' ? path : tail;
}

/** §3.8 — "lowercased, no dot; NULL when the basename has none". A dotfile has none. */
function extensionOf(basename: string): string | null {
  const index = basename.lastIndexOf('.');
  if (index <= 0 || index === basename.length - 1) return null;
  return basename.slice(index + 1).toLowerCase();
}
