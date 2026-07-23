// SM-3 — DESIGN §5.3, the per-file classification table, transcribed.
//
// Pure: manifest row in, stat in, class out. No filesystem, no database, no clock — so the
// table can be tested exhaustively, which is the only way to know the `ARCHIVED` row is
// really there.
//
// ⚠️ **The `ARCHIVED` row is the single most important line in that table.** A manifest row
// with `archive_id IS NOT NULL` is never parsed, never deleted and never classified
// `MISSING`. Without it, the first sync after an archive sees the transcripts gone from
// `<claudeDir>`, classifies them `MISSING`, cascades their rows away, and **silently shrinks
// every lifetime total** (§5.3, INV-18, ADR-033/034). The file's absence is expected: the app
// moved it, deliberately, with an audit entry — this is the one place §5.12's
// "filesystem wins" rule is deliberately inverted, and it is safe precisely because the
// inversion is keyed on a column the app itself set.
//
// ⚠️ **`RETAINED_ORPHAN` is the second door into the same safety (ADR-041, §5.3 amended).** When
// `retainOrphanedHistory` is ON, a transcript that is `MISSING` (gone from `<claudeDir>`, and NOT
// archived) is not deleted: its manifest row is marked `retained_orphan = 1` and every parsed row
// is KEPT, exactly as for `ARCHIVED`. Unlike archiving there is no moved file, no `archives` row
// and nothing to undo — the file is simply gone — which is why it is its OWN marker, not
// `archive_id`. When the setting is OFF the old `MISSING` (delete + cascade) behaviour stands.

/** §5.3 — the closed class set. `RETAINED_ORPHAN` added by ADR-041. */
export type FileClass =
  'NEW' | 'GREW' | 'SHRANK' | 'REWROTE' | 'UNCHANGED' | 'ARCHIVED' | 'MISSING' | 'RETAINED_ORPHAN';

/** The §5.3 inputs from `file_manifest` (§3.2). `null` = the file is not in the manifest. */
export interface ManifestState {
  readonly byteOffset: number;
  readonly mtimeMs: number;
  readonly contentHash: string | null;
  /** ⚠️ Non-NULL = RETAINED via archiving (ADR-033). The first thing every branch below tests. */
  readonly archiveId: number | null;
  /** ⚠️ True = RETAINED via orphaning (ADR-041). Only ever read when the file is absent on disk. */
  readonly retainedOrphan: boolean;
}

/** How SM-3 should treat a `MISSING` transcript (ADR-041, §3.13 `retainOrphanedHistory`). */
export interface ClassifyOptions {
  /**
   * ON: an absent, non-archived, retention-ELIGIBLE file becomes `RETAINED_ORPHAN` (its history
   * is kept) rather than `MISSING` (deleted). OFF: the old `MISSING` behaviour stands.
   *
   * ⚠️ This gates only the TRANSITION from live to retained. A file already marked
   * `retained_orphan = 1` is `RETAINED_ORPHAN` regardless of this flag — turning the setting off
   * never retroactively destroys history that was already preserved (ADR-041, non-goal #4).
   */
  readonly retainOrphans: boolean;
}

const DEFAULT_OPTIONS: ClassifyOptions = { retainOrphans: false };

/** The §5.3 inputs from disk. `null` = absent on disk. */
export interface DiskState {
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  /** sha256, for the non-JSONL config files §5.3's last paragraph covers. */
  readonly contentHash?: string | null;
}

/** What the sync cycle must actually do with a file, derived from its class. */
export type FileAction =
  /** Parse from `startByteOffset`, then advance the offset. */
  | { readonly kind: 'parse'; readonly startByteOffset: number; readonly reset: boolean }
  /** §5.3 UNCHANGED / ARCHIVED — touch `last_seen_at` at most; never read the file. */
  | { readonly kind: 'skip' }
  /** §5.3 MISSING — delete the manifest row; the cascade removes its rows. */
  | { readonly kind: 'delete' }
  /**
   * ADR-041 — the file is gone and retention is ON: mark `retained_orphan = 1` on the manifest
   * row and on every session it fed, and KEEP every parsed row. Distinct from `skip` because a
   * write happens; distinct from `delete` because nothing is removed.
   */
  | { readonly kind: 'retain-orphan' };

/**
 * §5.3 for a `*.jsonl` file.
 *
 * ⚠️ **Row precedence.** The §5.3 rows are not mutually exclusive as written — an archived
 * file that is still readable on disk also satisfies `GREW`, and an archived file that is
 * gone also satisfies `MISSING`. The ⚠️ paragraph under the table resolves it absolutely
 * ("never parsed, never deleted, never classified `MISSING`"), so `ARCHIVED` is tested first
 * and nothing else can reach an archived row.
 */
export function classifyJsonlFile(
  manifest: ManifestState | null,
  disk: DiskState | null,
  options: ClassifyOptions = DEFAULT_OPTIONS,
): FileClass {
  if (manifest !== null && manifest.archiveId !== null) return 'ARCHIVED';
  if (manifest === null) return 'NEW';
  if (disk === null) {
    // ⚠️ ADR-041 — the file is absent. If it is ALREADY retained-orphan, it stays that way
    // whatever the setting says (turning retention off never destroys preserved history). If it
    // is not yet retained, the setting decides: keep it (RETAINED_ORPHAN) or delete it (MISSING).
    // A rescan will never reproduce a deleted file, so this is the branch that used to shrink
    // every lifetime total silently — the whole reason this feature exists (§5.3, INV-18).
    if (manifest.retainedOrphan || options.retainOrphans) return 'RETAINED_ORPHAN';
    return 'MISSING';
  }

  if (disk.sizeBytes < manifest.byteOffset) return 'SHRANK';

  if (disk.sizeBytes === manifest.byteOffset) {
    // "a same-size rewrite is a rewrite"
    return disk.mtimeMs > manifest.mtimeMs ? 'REWROTE' : 'UNCHANGED';
  }

  // size > offset
  if (disk.mtimeMs >= manifest.mtimeMs) return 'GREW';

  // ⚠️ §5.3 has no row for "grew, but the mtime went BACKWARDS" — `GREW` requires
  // `mtime_ms >= manifest.mtime_ms` and the other four rows require `size <= offset`. Rather
  // than invent a fast path for a file whose clock disagrees with its length, this falls into
  // `REWROTE`: delete the file's rows, reset the offset, re-parse whole. That is the same
  // action `SHRANK` takes and it cannot lose or duplicate a record (ADR-019). Reported as a
  // gap in the table rather than silently folded into `GREW`.
  return 'REWROTE';
}

/**
 * §5.3's last paragraph — "Non-JSONL config files (`SKILL.md`, `CLAUDE.md`, `settings.json`,
 * plugin manifests, `MEMORY.md`) use `content_hash` instead of byte offsets: unchanged hash
 * ⇒ skip."
 *
 * `content_hash` is `NULL` for JSONL because hashing 1 GB per sync would defeat the point
 * (§3.2); these files are small and their mtimes churn, so the hash is the cheap answer.
 */
export function classifyHashedFile(
  manifest: ManifestState | null,
  disk: DiskState | null,
): FileClass {
  if (manifest !== null && manifest.archiveId !== null) return 'ARCHIVED';
  if (manifest === null) return 'NEW';
  if (disk === null) return 'MISSING';
  // A missing hash on either side is "we cannot prove it is unchanged", which re-reads a
  // small file — never "assume unchanged", which would freeze stale content in the database.
  if (
    manifest.contentHash !== null &&
    disk.contentHash !== null &&
    disk.contentHash !== undefined &&
    manifest.contentHash === disk.contentHash
  ) {
    return 'UNCHANGED';
  }
  return 'REWROTE';
}

/**
 * The action §5.3's "Action" column prescribes for a class.
 *
 * ⚠️ `ARCHIVED` maps to `skip` — **not** to `delete`, and not to `parse`. §5.3: "Sync only
 * stats the archive root to refresh `archives.reachable` / `last_reachable_at`."
 */
export function actionFor(fileClass: FileClass, manifest: ManifestState | null): FileAction {
  switch (fileClass) {
    case 'NEW':
      return { kind: 'parse', startByteOffset: 0, reset: false };
    case 'GREW':
      // The append fast-path: seek to the recorded offset, parse only the new lines.
      return { kind: 'parse', startByteOffset: manifest?.byteOffset ?? 0, reset: false };
    case 'SHRANK':
    case 'REWROTE':
      // "Delete all rows with `source_file_id`, reset offset to 0, re-parse whole file."
      return { kind: 'parse', startByteOffset: 0, reset: true };
    case 'UNCHANGED':
    case 'ARCHIVED':
      return { kind: 'skip' };
    case 'MISSING':
      return { kind: 'delete' };
    case 'RETAINED_ORPHAN':
      // ADR-041 — if the marker is ALREADY set, nothing to write: this is a still-missing file we
      // retained on a previous sync, so it is a pure `skip` (like `ARCHIVED`). If it is not yet
      // set, this is the transition: mark it and keep every row.
      return manifest?.retainedOrphan === true ? { kind: 'skip' } : { kind: 'retain-orphan' };
  }
}
