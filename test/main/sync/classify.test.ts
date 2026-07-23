// SM-3 (§5.3) — the per-file classification table, row by row.
//
// The table is small enough to test exhaustively, and it must be: `ARCHIVED` is one row in a
// document, and the cost of losing it is every lifetime total silently shrinking on the first
// sync after an archive (INV-18).

import { describe, expect, it } from 'vitest';
import {
  actionFor,
  classifyHashedFile,
  classifyJsonlFile,
  type ManifestState,
} from '../../../src/main/sync/classify';

const live = (over: Partial<ManifestState> = {}): ManifestState => ({
  byteOffset: 100,
  mtimeMs: 1_000,
  contentHash: null,
  archiveId: null,
  retainedOrphan: false,
  ...over,
});

describe('§5.3 — JSONL classification', () => {
  it('NEW — not in file_manifest', () => {
    expect(classifyJsonlFile(null, { sizeBytes: 10, mtimeMs: 1 })).toBe('NEW');
    expect(actionFor('NEW', null)).toEqual({ kind: 'parse', startByteOffset: 0, reset: false });
  });

  it('GREW — size > byte_offset and mtime >= manifest.mtime (the append fast-path)', () => {
    const manifest = live();
    expect(classifyJsonlFile(manifest, { sizeBytes: 150, mtimeMs: 1_000 })).toBe('GREW');
    expect(classifyJsonlFile(manifest, { sizeBytes: 150, mtimeMs: 2_000 })).toBe('GREW');
    // ⚠️ Seeks to the RECORDED offset; the already-consumed bytes are never re-read.
    expect(actionFor('GREW', manifest)).toEqual({
      kind: 'parse',
      startByteOffset: 100,
      reset: false,
    });
  });

  it('SHRANK — size < byte_offset', () => {
    const manifest = live();
    expect(classifyJsonlFile(manifest, { sizeBytes: 50, mtimeMs: 2_000 })).toBe('SHRANK');
    expect(classifyJsonlFile(manifest, { sizeBytes: 50, mtimeMs: 10 })).toBe('SHRANK');
    expect(actionFor('SHRANK', manifest)).toEqual({
      kind: 'parse',
      startByteOffset: 0,
      reset: true,
    });
  });

  it('REWROTE — same size, newer mtime ("a same-size rewrite is a rewrite")', () => {
    const manifest = live();
    expect(classifyJsonlFile(manifest, { sizeBytes: 100, mtimeMs: 1_001 })).toBe('REWROTE');
    expect(actionFor('REWROTE', manifest)).toEqual({
      kind: 'parse',
      startByteOffset: 0,
      reset: true,
    });
  });

  it('UNCHANGED — same size, mtime not newer', () => {
    const manifest = live();
    expect(classifyJsonlFile(manifest, { sizeBytes: 100, mtimeMs: 1_000 })).toBe('UNCHANGED');
    expect(classifyJsonlFile(manifest, { sizeBytes: 100, mtimeMs: 999 })).toBe('UNCHANGED');
    expect(actionFor('UNCHANGED', manifest)).toEqual({ kind: 'skip' });
  });

  it('MISSING — in manifest, absent on disk, archive_id IS NULL', () => {
    expect(classifyJsonlFile(live(), null)).toBe('MISSING');
    expect(actionFor('MISSING', live())).toEqual({ kind: 'delete' });
  });

  it('grew but the mtime moved backwards falls into REWROTE, not GREW', () => {
    // ⚠️ §5.3 has no row for this: `GREW` requires `mtime >= manifest.mtime` and the other
    // rows require `size <= offset`. Re-parsing whole cannot lose or duplicate a record
    // (ADR-019); trusting the offset behind a rewound clock could skip real lines.
    expect(classifyJsonlFile(live(), { sizeBytes: 150, mtimeMs: 500 })).toBe('REWROTE');
  });
});

describe('§5.3 — RETAINED_ORPHAN: a gone file kept, not deleted (ADR-041)', () => {
  it('MISSING becomes RETAINED_ORPHAN only when retention is ON', () => {
    // Setting OFF (the default option) → old behaviour, the file is deleted.
    expect(classifyJsonlFile(live(), null)).toBe('MISSING');
    expect(classifyJsonlFile(live(), null, { retainOrphans: false })).toBe('MISSING');
    // Setting ON → the transition: keep it.
    expect(classifyJsonlFile(live(), null, { retainOrphans: true })).toBe('RETAINED_ORPHAN');
    // The transition marks the manifest and its sessions; that write is `retain-orphan`.
    expect(actionFor('RETAINED_ORPHAN', live())).toEqual({ kind: 'retain-orphan' });
  });

  it('an ALREADY-retained file stays retained whatever the setting says', () => {
    // ⚠️ Turning retention off never retroactively destroys history already preserved
    // (non-goal #4). An already-marked, still-missing file is RETAINED_ORPHAN even with the
    // setting OFF, and its action is a pure `skip` — nothing more to write.
    const orphan = live({ retainedOrphan: true });
    expect(classifyJsonlFile(orphan, null, { retainOrphans: false })).toBe('RETAINED_ORPHAN');
    expect(classifyJsonlFile(orphan, null, { retainOrphans: true })).toBe('RETAINED_ORPHAN');
    expect(actionFor('RETAINED_ORPHAN', orphan)).toEqual({ kind: 'skip' });
  });

  it('ARCHIVED still wins over orphan retention — an archived file is never an orphan', () => {
    // Both markers set is a contradiction the classifier resolves in archiving's favour; the
    // repository refuses to mark an archived file anyway (`retainOrphan` guards `archive_id IS
    // NULL`), so this precedence and that guard agree.
    const both = live({ archiveId: 7, retainedOrphan: true });
    expect(classifyJsonlFile(both, null, { retainOrphans: true })).toBe('ARCHIVED');
  });

  it('a retained file that is BACK on disk classifies as an ordinary file', () => {
    // Reappearance: the manifest still says retained, but the file is present. Classification
    // treats it as the ordinary GREW/UNCHANGED/etc it now is; `planSync` clears the marker.
    const orphan = live({ retainedOrphan: true });
    expect(
      classifyJsonlFile(orphan, { sizeBytes: 150, mtimeMs: 1_000 }, { retainOrphans: true }),
    ).toBe('GREW');
    expect(classifyJsonlFile(orphan, { sizeBytes: 100, mtimeMs: 1_000 })).toBe('UNCHANGED');
  });
});

describe('§5.3 — ARCHIVED: never parsed, never deleted, never MISSING (INV-18)', () => {
  const archived = live({ archiveId: 7 });

  it('wins over every other row, whatever the file on disk looks like', () => {
    // ⚠️ The §5.3 rows are not mutually exclusive as written; the ⚠️ paragraph under the
    // table settles precedence absolutely. Each case below ALSO matches another row.
    expect(classifyJsonlFile(archived, null)).toBe('ARCHIVED'); // would be MISSING
    expect(classifyJsonlFile(archived, { sizeBytes: 150, mtimeMs: 2_000 })).toBe('ARCHIVED'); // GREW
    expect(classifyJsonlFile(archived, { sizeBytes: 50, mtimeMs: 2_000 })).toBe('ARCHIVED'); // SHRANK
    expect(classifyJsonlFile(archived, { sizeBytes: 100, mtimeMs: 2_000 })).toBe('ARCHIVED'); // REWROTE
    expect(classifyHashedFile(archived, null)).toBe('ARCHIVED');
  });

  it('maps to skip — not delete, and not parse', () => {
    // Deleting would cascade the archived session's events away and shrink every lifetime
    // total; parsing would read a file the app deliberately moved out of `<claudeDir>`.
    expect(actionFor('ARCHIVED', archived)).toEqual({ kind: 'skip' });
  });
});

describe('§5.3 — non-JSONL config files use content_hash', () => {
  it('UNCHANGED only when both hashes are present and equal', () => {
    const manifest = live({ contentHash: 'abc' });
    expect(classifyHashedFile(manifest, { sizeBytes: 1, mtimeMs: 9, contentHash: 'abc' })).toBe(
      'UNCHANGED',
    );
    // A churned mtime with the same content is still UNCHANGED — that is the whole point of
    // hashing these files rather than trusting their mtimes (§3.2).
    expect(
      classifyHashedFile(manifest, { sizeBytes: 1, mtimeMs: 999_999, contentHash: 'abc' }),
    ).toBe('UNCHANGED');
  });

  it('REWROTE when the hash differs, or when either side has none', () => {
    const manifest = live({ contentHash: 'abc' });
    expect(classifyHashedFile(manifest, { sizeBytes: 1, mtimeMs: 9, contentHash: 'zzz' })).toBe(
      'REWROTE',
    );
    // "Cannot prove unchanged" re-reads a small file; it never assumes unchanged, which
    // would freeze stale content in the database.
    expect(classifyHashedFile(manifest, { sizeBytes: 1, mtimeMs: 9, contentHash: null })).toBe(
      'REWROTE',
    );
    expect(
      classifyHashedFile(live({ contentHash: null }), {
        sizeBytes: 1,
        mtimeMs: 9,
        contentHash: 'abc',
      }),
    ).toBe('REWROTE');
  });
});
