// The main-process half of the parse worker: lifecycle, request/response pairing, and the
// `SyncWork` adapter SM-2 dispatches through. DESIGN §7.2, §5.2, STACK ADR-009.
//
// ⚠️ The main process keeps SCANNING and FINALIZING-orchestration and hands only PARSING to
// the worker. That split is what keeps the window responsive with a live progress indicator
// (ADR-009): scanning is `stat`-only and cheap, while parsing is the ~1 GB of streaming reads
// that would otherwise freeze the UI for the whole of P-01's budget.
//
// One request/response round trip per file. It is chattier than a single batch message and
// deliberately so: progress is then a fact reported by the thread doing the work, not a
// number the main process interpolates between two events.

import { Worker } from 'node:worker_threads';
import {
  needsFinalize,
  type CycleSummary,
  type PlannedFile,
  type ScanPhaseResult,
  type SyncRunContext,
  type SyncWork,
} from '../sync/engine';
import {
  isParseWorkerResponse,
  type ParseWorkerConfig,
  type ParseWorkerFileResult,
  type ParseWorkerRequest,
  type ParseWorkerResponse,
} from './protocol';

export interface ParseWorkerClientOptions extends ParseWorkerConfig {
  /**
   * Absolute path (or `file:` URL) of the built worker entry.
   *
   * ⚠️ Passed in, never resolved here: this module must not know where the bundler put the
   * chunk, and INV-17's rule — every entry point takes its root as a parameter — has the same
   * shape for the worker's own location.
   */
  readonly workerEntry: string | URL;
}

/** A live worker thread plus the pending requests it owes replies to. */
export class ParseWorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, (response: ParseWorkerResponse) => void>();
  #nextId = 1;
  #terminated = false;

  constructor(options: ParseWorkerClientOptions) {
    const config: ParseWorkerConfig = { dbPath: options.dbPath, claudeDir: options.claudeDir };
    this.#worker = new Worker(options.workerEntry, { workerData: config });
    this.#worker.on('message', (message: unknown) => {
      if (!isParseWorkerResponse(message) || message.type === 'ready') return;
      const resolve = this.#pending.get(message.id);
      if (resolve === undefined) return;
      this.#pending.delete(message.id);
      resolve(message);
    });
    // A worker that dies owes every outstanding reply. Rejecting them turns a silent hang
    // into a FAILED cycle, which §5.2 rule 4 makes safe: nothing already ingested is lost.
    this.#worker.on('error', (cause) => this.#failAll(describe(cause)));
    this.#worker.on('exit', (code) => {
      this.#terminated = true;
      if (this.#pending.size > 0) this.#failAll(`parse worker exited with code ${code}`);
    });
  }

  /** §5.2 rule 3 — one file, one transaction, inside the worker. */
  async parseFile(file: PlannedFile): Promise<ParseWorkerFileResult> {
    const response = await this.#request((id) => ({ type: 'parse', id, file }));
    if (response.type !== 'parsed' || !response.ok) {
      throw new Error(response.type === 'parsed' ? response.message : 'unexpected worker reply');
    }
    return response.result;
  }

  /** §5.2 FINALIZING — the cross-file derivations, on the worker's own connection. */
  async finalize(): Promise<void> {
    const response = await this.#request((id) => ({ type: 'finalize', id }));
    if (response.type !== 'finalized' || !response.ok) {
      throw new Error(response.type === 'finalized' ? response.message : 'unexpected worker reply');
    }
  }

  /** §5.2 `CANCELLING` — cooperative. Fire-and-forget; the worker stops between lines. */
  cancel(): void {
    if (this.#terminated) return;
    this.#post({ type: 'cancel' });
  }

  /** SM-5: no background work survives the window (§1.6 non-goal 7, §7.6). */
  async close(): Promise<void> {
    if (this.#terminated) return;
    this.#post({ type: 'close' });
    await this.#worker.terminate();
  }

  #request(build: (id: number) => ParseWorkerRequest): Promise<ParseWorkerResponse> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<ParseWorkerResponse>((resolve, reject) => {
      if (this.#terminated) {
        reject(new Error('parse worker is not running'));
        return;
      }
      this.#pending.set(id, resolve);
      this.#post(build(id));
    });
  }

  #post(request: ParseWorkerRequest): void {
    // Structured-clone only (§7.2): every `ParseWorkerRequest` member is a plain object.
    this.#worker.postMessage(request);
  }

  #failAll(message: string): void {
    for (const [id, resolve] of this.#pending) {
      resolve({ type: 'parsed', id, ok: false, message });
    }
    this.#pending.clear();
  }
}

/**
 * Wraps a `SyncWork` so that PARSING and FINALIZING run in the worker while SCANNING stays
 * on the main thread. `scan` is delegated unchanged — it is `stat`-only and writes only
 * manifest bookkeeping (§5.3), which is well inside the main process's budget (P-02).
 */
export function workerBackedSyncWork(local: SyncWork, client: ParseWorkerClient): SyncWork {
  return {
    scan: (context: SyncRunContext): Promise<ScanPhaseResult> => local.scan(context),
    async parseFile(file: PlannedFile, context: SyncRunContext) {
      if (context.isCancelled()) client.cancel();
      return client.parseFile(file);
    },
    async finalize(_context: SyncRunContext, summary: CycleSummary): Promise<void> {
      if (needsFinalize(summary)) await client.finalize();
    },
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}
