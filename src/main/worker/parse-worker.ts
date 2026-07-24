// The parse worker. DESIGN §7.2, STACK ADR-009.
//
// "Parse worker (`worker_threads`, owned by main) — Streaming `node:readline` ingest, its own
// SQLite handle. Worker↔main messages are structured-clone only." (§7.2)
//
// ⚠️ The worker exists for ONE reason, stated in ADR-009: "A worker thread is required
// because the main process also serves IPC and must stay responsive with a live progress
// indicator." Every design choice here serves that — the worker replies per file so progress
// is real rather than interpolated, and it never blocks on anything the main thread owns.
//
// ⚠️ **Its own SQLite handle** (§7.2). It opens the database itself, with the §3.1.7 pragmas,
// and never receives a connection: a `better-sqlite3` handle is not structured-cloneable, and
// sharing one across threads is undefined behaviour in a NAN addon (ADR-006).
//
// This module is import-safe on the main thread: the wiring at the bottom runs only when
// `parentPort` is non-null, so tests can drive `createParseWorkerRuntime` directly.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../db/driver';
import { IngestRepository } from '../db/repositories/ingest-repo';
import { ManifestRepository } from '../db/repositories/manifest-repo';
import type { SqliteDatabase } from '../db/sqlite';
import { finalizeIngest, ingestFile, type IngestRepositories } from '../parse/ingest';
import type { ParseWorkerConfig, ParseWorkerRequest, ParseWorkerResponse } from './protocol';

export interface ParseWorkerRuntime {
  /** Handles one request. Returns the reply, or `null` for requests that have none. */
  handle(request: ParseWorkerRequest): Promise<ParseWorkerResponse | null>;
  close(): void;
}

export interface ParseWorkerRuntimeOptions extends ParseWorkerConfig {
  /** Injected in tests so the runtime can be driven against an already-open sandbox file. */
  readonly openDb?: (dbPath: string) => SqliteDatabase;
  readonly now?: () => number;
}

/**
 * The worker's whole behaviour, with no `worker_threads` dependency, so it is testable
 * without spawning a thread and reusable in-process when a caller wants no worker at all.
 */
export function createParseWorkerRuntime(options: ParseWorkerRuntimeOptions): ParseWorkerRuntime {
  const db = (options.openDb ?? openDatabase)(options.dbPath);
  const repos: IngestRepositories = {
    ingest: new IngestRepository(db),
    manifest: new ManifestRepository(db),
  };
  const now = options.now ?? Date.now;
  let cancelled = false;

  return {
    async handle(request: ParseWorkerRequest): Promise<ParseWorkerResponse | null> {
      switch (request.type) {
        case 'cancel':
          cancelled = true;
          return null;
        case 'close':
          db.close();
          return null;
        case 'parse':
          try {
            const result = await ingestFile(repos, {
              claudeDir: options.claudeDir,
              relPath: request.file.relPath,
              manifestId: request.file.manifestId,
              startByteOffset: request.file.startByteOffset,
              startLineNo: request.file.startLineNo,
              startBadLines: request.file.startBadLines,
              startCacheSplitMismatches: request.file.startCacheSplitMismatches,
              sizeBytes: request.file.sizeBytes,
              mtimeMs: request.file.mtimeMs,
              now: now(),
              isCancelled: () => cancelled,
            });
            return {
              type: 'parsed',
              id: request.id,
              ok: true,
              result: {
                relPath: result.relPath,
                recordsIngested: result.recordsIngested,
                recordsDeduplicated: result.recordsDeduplicated,
                badLinesDelta: result.badLines - request.file.startBadLines,
                cancelled: result.cancelled,
              },
            };
          } catch (cause) {
            // Never rethrown across the thread boundary: an unhandled throw in a worker
            // terminates it, and a terminated worker mid-cycle is indistinguishable from a
            // hang. One file's failure is data the cycle reports (§4.1, ADR-031).
            return { type: 'parsed', id: request.id, ok: false, message: describe(cause) };
          }
        case 'finalize':
          try {
            // §3.7 (amended 2026-07-22) — FINALIZING also reads each subagent run's own
            // `agent-*.meta.json`, so it needs the root the worker was configured with
            // (INV-17: the root is always a parameter).
            await finalizeIngest(repos, options.claudeDir);
            cancelled = false;
            return { type: 'finalized', id: request.id, ok: true };
          } catch (cause) {
            return { type: 'finalized', id: request.id, ok: false, message: describe(cause) };
          }
      }
    },
    close(): void {
      if (db.open) db.close();
    },
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

// ---------------------------------------------------------------------------------------
// Worker entry. Runs only inside a `worker_threads` thread.
// ---------------------------------------------------------------------------------------

if (!isMainThread && parentPort !== null) {
  const port = parentPort;
  const config = workerData as ParseWorkerConfig;
  const runtime = createParseWorkerRuntime(config);

  port.on('message', (message: ParseWorkerRequest) => {
    void runtime
      .handle(message)
      .then((response) => {
        if (response !== null) port.postMessage(response);
      })
      .catch((cause: unknown) => {
        port.postMessage({
          type: 'parsed',
          id: -1,
          ok: false,
          message: describe(cause),
        } satisfies ParseWorkerResponse);
      });
  });

  port.postMessage({ type: 'ready' } satisfies ParseWorkerResponse);
}
