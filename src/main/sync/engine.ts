// The work SM-2 dispatches: scan → classify → reconcile → parse → finalize.
//
// `cycle.ts` owns the state machine and knows nothing about files; this owns the files and
// knows nothing about phases. The seam between them is `SyncWork`, which is also what lets
// the cycle run against the parse worker (§7.2) or in-process (tests) with no branch.

import { stat } from 'node:fs/promises';
import type { IngestRepository } from '../db/repositories/ingest-repo';
import type { ManifestRepository, ManifestRow } from '../db/repositories/manifest-repo';
import { finalizeIngest, ingestFile, type IngestRepositories } from '../parse/ingest';
import type { FileKind } from '../parse/source-file';
import { actionFor, classifyHashedFile, classifyJsonlFile, type FileClass } from './classify';
import { scanClaudeDirectory, SYNC_HASH_KINDS, SYNC_SCAN_KINDS, type ScannedFile } from './scan';

/** One file the cycle must parse, with everything §5.3 decided about it. */
export interface PlannedFile {
  readonly relPath: string;
  readonly kind: FileKind;
  readonly fileClass: FileClass;
  readonly manifestId: number;
  readonly startByteOffset: number;
  readonly startLineNo: number;
  readonly startBadLines: number;
  /** §3.2 `cache_split_mismatches` (A-05) — carried forward like `startBadLines`. */
  readonly startCacheSplitMismatches: number;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/** What SCANNING produced. Every count here is disclosable data, not a log line (§4.6). */
export interface ScanPhaseResult {
  readonly files: readonly PlannedFile[];
  readonly unchanged: number;
  /** §5.3 `ARCHIVED` — stat-only, never parsed, never deleted (INV-18). */
  readonly archived: number;
  /** §4.6 `filesMissingSinceLastSync` — MISSING files actually deleted (retention OFF). */
  readonly filesMissing: number;
  /** ADR-041 — transcripts NEWLY marked retained-orphan this cycle (kept, not deleted). */
  readonly retainedOrphans: number;
  /** ADR-041 — orphaned files that REAPPEARED this cycle and had their marker cleared. */
  readonly orphansReturned: number;
  readonly unreadable: readonly string[];
}

export interface FileParseResult {
  readonly relPath: string;
  readonly recordsIngested: number;
  /**
   * ADR-019 in action: records this file offered that were ALREADY present under the same
   * `event_key`, so the `ON CONFLICT DO NOTHING` fired and nothing was written twice.
   *
   * ⚠️ **This is not the repeated-API-call count and must never be presented as one** (§4.6,
   * migration 0011). This is line identity working: the same record, seen twice, stored once. The
   * other thing is several genuinely distinct records that share one API call and are each summed
   * — which `event_key` correctly does not catch, because they are not duplicates.
   *
   * ⚠️ It is a per-CYCLE number, not a property of the dataset, which is why it lives on
   * `SyncState` (§4.4) rather than in `Disclosures` (§4.6).
   */
  readonly recordsDeduplicated: number;
  readonly badLinesDelta: number;
  readonly cancelled: boolean;
}

export interface SyncRunContext {
  readonly kind: 'incremental' | 'full';
  isCancelled(): boolean;
}

export interface CycleSummary {
  readonly filesParsed: number;
  readonly recordsIngested: number;
  readonly badLines: number;
  readonly filesMissing: number;
  readonly startedAt: number;
  readonly finishedAt: number;
}

/** The three phases of work SM-2 dispatches. Implemented once, below. */
export interface SyncWork {
  scan(context: SyncRunContext): Promise<ScanPhaseResult>;
  parseFile(file: PlannedFile, context: SyncRunContext): Promise<FileParseResult>;
  finalize(context: SyncRunContext, summary: CycleSummary): Promise<void>;
}

export interface SyncEngineDeps {
  /** INV-17 — the root is a parameter, always. */
  readonly claudeDir: string;
  readonly manifest: ManifestRepository;
  readonly ingest: IngestRepository;
  readonly now: () => number;
  /** Injectable so the archive-reachability probe is testable without a mounted volume. */
  readonly statPath?: (path: string) => Promise<boolean>;
  /**
   * ADR-041 / §3.13 `retainOrphanedHistory`. Read FRESH at the start of every scan so a settings
   * change takes effect on the next cycle without a restart. Absent ⇒ TRUE, the documented
   * default: the safe answer if a caller forgets to wire it is to KEEP history, never to delete
   * it (§5.3, non-goal #4).
   */
  readonly retainOrphanedHistory?: () => boolean;
}

const defaultStatPath = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

export function createSyncWork(deps: SyncEngineDeps): SyncWork {
  const repos: IngestRepositories = { ingest: deps.ingest, manifest: deps.manifest };
  const statPath = deps.statPath ?? defaultStatPath;

  return {
    async scan(context: SyncRunContext): Promise<ScanPhaseResult> {
      const scanned = await scanClaudeDirectory(deps.claudeDir, {
        kinds: SYNC_SCAN_KINDS,
        hashKinds: SYNC_HASH_KINDS,
        isCancelled: () => context.isCancelled(),
      });
      // ADR-041 — read the setting once per scan; default TRUE (keep history) if unwired.
      const retainOrphans = deps.retainOrphanedHistory?.() ?? true;
      const plan = planSync(deps.manifest, scanned.files, deps.now(), retainOrphans);
      await refreshArchiveReachability(deps.manifest, statPath, deps.now());
      return { ...plan, unreadable: scanned.unreadable };
    },

    async parseFile(file: PlannedFile, context: SyncRunContext): Promise<FileParseResult> {
      const result = await ingestFile(repos, {
        claudeDir: deps.claudeDir,
        relPath: file.relPath,
        manifestId: file.manifestId,
        startByteOffset: file.startByteOffset,
        startLineNo: file.startLineNo,
        startBadLines: file.startBadLines,
        startCacheSplitMismatches: file.startCacheSplitMismatches,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        now: deps.now(),
        isCancelled: () => context.isCancelled(),
      });
      return {
        relPath: result.relPath,
        recordsIngested: result.recordsIngested,
        // Previously discarded here. `ingestFile` has always computed it, and a counter that is
        // computed and dropped is a counter nobody can check (CLAUDE.md §1's spirit).
        recordsDeduplicated: result.recordsDeduplicated,
        badLinesDelta: result.badLines - file.startBadLines,
        cancelled: result.cancelled,
      };
    },

    async finalize(_context: SyncRunContext, summary: CycleSummary): Promise<void> {
      // §5.2 — nothing was written, so nothing can have changed. Skipping keeps the
      // "nothing changed" launch path at P-02 (≤ 500 ms) without weakening INV-04: a
      // recomputation over unchanged data is by definition a no-op.
      //
      // ⚠️ `filesMissing` counts too. A MISSING file's deletion cascades events away, which
      // changes `sessions.first_ts`, `projects.last_ts` and `is_partial` — all cross-file
      // values. Skipping on deletions alone would leave a session advertising a `first_ts`
      // for events that no longer exist: a stale number that looks perfectly plausible.
      // ⚠️ `claudeDir` is passed because FINALIZING reads each subagent run's own
      // `agent-*.meta.json` sidecar (§3.7 as amended 2026-07-22) — the only structural source
      // that actually resolves a spawn point on real data. It is a read of files the sync
      // already discovered, inside the configured root, and it writes nothing to disk.
      if (needsFinalize(summary)) await finalizeIngest(repos, deps.claudeDir);
    },
  };
}

/**
 * Whether a cycle wrote anything the FINALIZING derivations depend on. Parsing writes rows;
 * a MISSING deletion removes them. Either changes cross-file state (§5.2).
 */
export function needsFinalize(summary: CycleSummary): boolean {
  return summary.filesParsed > 0 || summary.filesMissing > 0;
}

/**
 * §5.3 applied to a whole scan: classify every manifest row and every file on disk, delete
 * what is `MISSING`, and return what must be parsed.
 *
 * ⚠️ Manifest rows are reconciled **from the manifest side too**, not only from the disk
 * side — a row whose file is gone never appears in `scanned` and would otherwise be invisible
 * to classification. That is exactly the path an archived file takes (`ARCHIVED`, not
 * `MISSING`, INV-18).
 */
export function planSync(
  manifest: ManifestRepository,
  scanned: readonly ScannedFile[],
  now: number,
  retainOrphans = true,
): Omit<ScanPhaseResult, 'unreadable'> {
  const rows = new Map<string, ManifestRow>();
  for (const row of manifest.listAll()) rows.set(row.rel_path, row);

  const files: PlannedFile[] = [];
  let unchanged = 0;
  let archived = 0;
  let filesMissing = 0;
  let retainedOrphans = 0;
  let orphansReturned = 0;
  const seen = new Set<string>();

  for (const file of scanned) {
    seen.add(file.relPath);
    const row = rows.get(file.relPath);
    // ⚠️ ADR-041 — a file on disk whose manifest row is retained-orphan has REAPPEARED (restored,
    // remounted). Clear the marker before classifying, then let it resume as an ordinary file;
    // ADR-019 dedup makes the re-ingest idempotent, so the returning events cannot double-count
    // against the retained ones.
    if (row !== undefined && row.retained_orphan === 1) {
      manifest.clearOrphan(row.id);
      orphansReturned += 1;
    }
    const state =
      row === undefined
        ? null
        : {
            byteOffset: row.byte_offset,
            mtimeMs: row.mtime_ms,
            contentHash: row.content_hash,
            archiveId: row.archive_id,
            // Cleared above if it was set; a present file is never treated as retained.
            retainedOrphan: false,
          };
    const disk = {
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
      contentHash: file.contentHash,
    };
    const hashed = SYNC_HASH_KINDS.has(file.kind);
    const fileClass = hashed ? classifyHashedFile(state, disk) : classifyJsonlFile(state, disk);
    const action = actionFor(fileClass, state);

    if (action.kind === 'skip') {
      if (fileClass === 'ARCHIVED') archived += 1;
      else unchanged += 1;
      if (row !== undefined) manifest.touchSeen(row.id, now);
      continue;
    }
    // `delete` and `retain-orphan` cannot be reached here: both require the file to be ABSENT on
    // disk (§5.3 `MISSING` / `RETAINED_ORPHAN`), and this loop only visits files present on disk.
    // The guards also narrow `action` to the `parse` shape for the offset reads below.
    if (action.kind === 'delete' || action.kind === 'retain-orphan') continue;

    const manifestId =
      row?.id ??
      manifest.insert({
        relPath: file.relPath,
        kind: file.kind,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        contentHash: hashed ? file.contentHash : null,
        now,
      });
    if (action.reset && row !== undefined) manifest.resetForReparse(row.id);

    files.push({
      relPath: file.relPath,
      kind: file.kind,
      fileClass,
      manifestId,
      startByteOffset: action.startByteOffset,
      startLineNo: action.reset || row === undefined ? 0 : row.lines_parsed,
      startBadLines: action.reset || row === undefined ? 0 : row.bad_lines,
      // §3.2 (A-05) — carried forward exactly like `bad_lines`; `recordParse` writes absolutes.
      startCacheSplitMismatches: action.reset || row === undefined ? 0 : row.cache_split_mismatches,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
    });
  }

  // The manifest side: rows with no file on disk.
  for (const row of rows.values()) {
    if (seen.has(row.rel_path)) continue;
    // ⚠️ ADR-041 — retention applies to TRANSCRIPTS only. A vanished config file (SKILL.md,
    // CLAUDE.md, plugin manifest) or a `history.jsonl` produces harness/prompt/stats rows that are
    // rebuilt wholesale and are not guarded by the purge, so retaining them would be inconsistent
    // and pointless; they keep the old `MISSING` (delete) behaviour. Only a `transcript` or
    // `subagent_transcript` carries the events/tool_calls the purge guard protects.
    const eligible = row.kind === 'transcript' || row.kind === 'subagent_transcript';
    const fileClass = classifyJsonlFile(
      {
        byteOffset: row.byte_offset,
        mtimeMs: row.mtime_ms,
        contentHash: row.content_hash,
        archiveId: row.archive_id,
        retainedOrphan: row.retained_orphan === 1,
      },
      null,
      { retainOrphans: retainOrphans && eligible },
    );
    if (fileClass === 'ARCHIVED') {
      // ⚠️ Never parsed, never deleted, never `MISSING`. The file was moved by the app, on
      // purpose, with an audit entry (§5.12, ADR-034). Its rows stand (INV-18).
      archived += 1;
      continue;
    }
    if (fileClass === 'RETAINED_ORPHAN') {
      // ADR-041 — the file is gone and retention is ON. Keep every row; mark the file and its
      // sessions RETAINED so the purge spares them (§3.18). A row already marked on a previous
      // sync is a no-op (`retainOrphan` returns >0 only when it actually marks something), so it
      // is NOT re-counted — retention is a state, decided from current disk state each cycle, not
      // an accumulator (INV-04).
      const action = actionFor(fileClass, {
        byteOffset: row.byte_offset,
        mtimeMs: row.mtime_ms,
        contentHash: row.content_hash,
        archiveId: row.archive_id,
        retainedOrphan: row.retained_orphan === 1,
      });
      if (action.kind === 'retain-orphan' && manifest.retainOrphan(row.id) > 0) {
        retainedOrphans += 1;
      }
      continue;
    }
    if (manifest.deleteMissing(row.id) > 0) filesMissing += 1;
  }

  return { files, unchanged, archived, filesMissing, retainedOrphans, orphansReturned };
}

/**
 * §5.3 `ARCHIVED` — "Sync only stats the archive root to refresh `archives.reachable` /
 * `last_reachable_at`."
 *
 * ⚠️ Unreachable is **informational** (§3.15): no row is deleted, no period is marked
 * partial, and no metric moves. Nothing under the archive root is ever walked (INV-19) —
 * this stats the root itself and stops.
 */
export async function refreshArchiveReachability(
  manifest: ManifestRepository,
  statPath: (path: string) => Promise<boolean>,
  now: number,
): Promise<void> {
  for (const archive of manifest.archiveRoots()) {
    manifest.setArchiveReachable(archive.id, await statPath(archive.archive_root), now);
  }
}
