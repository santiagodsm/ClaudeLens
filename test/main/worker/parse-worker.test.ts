// The parse worker's runtime and its wire vocabulary (§7.2, STACK ADR-009).
//
// The runtime is exercised directly rather than through a spawned thread: `worker_threads`
// cannot load a `.ts` entry without a loader, and the behaviour worth testing is the message
// handling and the ingest it drives, not Node's ability to start a thread.
//
// ⚠️ What IS tested about the thread boundary is the part that fails at runtime rather than
// at compile time: every message must survive `structuredClone` (§7.2). A `postMessage`
// carrying something unclonable throws `DataCloneError` in the middle of P-01's budget.

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/main/db/driver';
import { migrate } from '../../../src/main/db/migrate';
import { ManifestRepository } from '../../../src/main/db/repositories/manifest-repo';
import { createParseWorkerRuntime } from '../../../src/main/worker/parse-worker';
import { isParseWorkerResponse, type ParseWorkerRequest } from '../../../src/main/worker/protocol';
import type { PlannedFile } from '../../../src/main/sync/engine';
import { useSandbox } from '../../support/sandbox';
import { fixturePath, FIXED_NOW } from '../../support/sync-harness';

const TRANSCRIPT = 'projects/-work-demo-alpha/sess-a.jsonl';

describe('the parse worker runtime', () => {
  const sandbox = useSandbox();

  it('opens its OWN database handle and ingests a file end to end', async () => {
    const claudeDir = await sandbox.copyFixture(fixturePath('f03-append/base'), 'root');
    const dbPath = sandbox.resolve('lens.db');

    // §7.2 — the worker never RECEIVES a connection: a better-sqlite3 handle is not
    // structured-cloneable, and sharing one across threads is undefined behaviour in a NAN
    // addon (ADR-006). It is handed a PATH and opens the file itself.
    const setup = openDatabase(dbPath);
    migrate(setup);
    const manifestId = new ManifestRepository(setup).insert({
      relPath: TRANSCRIPT,
      kind: 'transcript',
      sizeBytes: 0,
      mtimeMs: 0,
      contentHash: null,
      now: FIXED_NOW,
    });
    setup.close();

    const runtime = createParseWorkerRuntime({ dbPath, claudeDir, now: () => FIXED_NOW });
    const file: PlannedFile = {
      relPath: TRANSCRIPT,
      kind: 'transcript',
      fileClass: 'NEW',
      manifestId,
      startByteOffset: 0,
      startLineNo: 0,
      startBadLines: 0,
      startCacheSplitMismatches: 0,
      sizeBytes: 999,
      mtimeMs: 1,
    };

    const parsed = await runtime.handle({ type: 'parse', id: 1, file });
    expect(parsed).toEqual({
      type: 'parsed',
      id: 1,
      ok: true,
      result: { relPath: TRANSCRIPT, recordsIngested: 3, badLinesDelta: 0, cancelled: false },
    });

    expect(await runtime.handle({ type: 'finalize', id: 2 })).toEqual({
      type: 'finalized',
      id: 2,
      ok: true,
    });
    runtime.close();

    const check = openDatabase(dbPath);
    expect(check.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(3);
    // FINALIZING ran on the worker's own connection: the session bounds are recomputed.
    expect(
      check
        .prepare<{ first_ts: number | null }>("SELECT first_ts FROM sessions WHERE id = 'sess-a'")
        .get()?.first_ts,
    ).toBe(1_714_554_000_000); // 2024-05-01T09:00:00.000Z
    check.close();
  });

  it('reports one file’s failure as data instead of throwing across the boundary', async () => {
    const claudeDir = sandbox.resolve('empty-root');
    const dbPath = sandbox.resolve('lens.db');
    const setup = openDatabase(dbPath);
    migrate(setup);
    setup.close();

    const runtime = createParseWorkerRuntime({ dbPath, claudeDir, now: () => FIXED_NOW });
    // A manifest id that does not exist: the insert violates a foreign key.
    const response = await runtime.handle({
      type: 'parse',
      id: 5,
      file: {
        relPath: TRANSCRIPT,
        kind: 'transcript',
        fileClass: 'NEW',
        manifestId: 4_242,
        startByteOffset: 0,
        startLineNo: 0,
        startBadLines: 0,
        startCacheSplitMismatches: 0,
        sizeBytes: 1,
        mtimeMs: 1,
      },
    });
    runtime.close();

    // An unhandled throw would terminate the thread, and a terminated worker mid-cycle is
    // indistinguishable from a hang. The failure comes back as a value the cycle can report.
    expect(response).toMatchObject({ type: 'parsed', id: 5, ok: false });
    expect(isParseWorkerResponse(response)).toBe(true);
  });

  it('every message in the protocol survives structuredClone (§7.2)', () => {
    const file: PlannedFile = {
      relPath: TRANSCRIPT,
      kind: 'transcript',
      fileClass: 'GREW',
      manifestId: 1,
      startByteOffset: 10,
      startLineNo: 2,
      startBadLines: 0,
      startCacheSplitMismatches: 0,
      sizeBytes: 20,
      mtimeMs: 3,
    };
    const messages: ParseWorkerRequest[] = [
      { type: 'parse', id: 1, file },
      { type: 'finalize', id: 2 },
      { type: 'cancel' },
      { type: 'close' },
    ];
    for (const message of messages) {
      expect(structuredClone(message)).toEqual(message);
    }
    const responses = [
      { type: 'ready' as const },
      {
        type: 'parsed' as const,
        id: 1,
        ok: true as const,
        result: { relPath: TRANSCRIPT, recordsIngested: 1, badLinesDelta: 0, cancelled: false },
      },
      { type: 'finalized' as const, id: 2, ok: false as const, message: 'nope' },
    ];
    for (const response of responses) {
      expect(structuredClone(response)).toEqual(response);
      expect(isParseWorkerResponse(response)).toBe(true);
    }
    expect(isParseWorkerResponse({ type: 'something-else' })).toBe(false);
    expect(isParseWorkerResponse(null)).toBe(false);
  });
});
