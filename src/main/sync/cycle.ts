// SM-2 — DESIGN §5.2, the sync cycle.
//
//   IDLE ──start──> SCANNING ──classified──> PARSING ──all files done──> FINALIZING ──> IDLE
//     ├── watcher/manual start while ≠ IDLE  ⇒  queuedRescan = true, stay in current phase
//     ├── cancel ⇒ CANCELLING ⇒ IDLE  (already-committed files stay committed)
//     └── unrecoverable error ⇒ FAILED ⇒ (manual retry) ⇒ SCANNING
//
// The five rules, and where each one lives:
//
//   1. At most one cycle at a time                → `#running`
//   2. Coalescing, not queueing                   → `#state.queuedRescan`, drained once at IDLE
//   3. Every file committed in its own transaction → `ingest.ts` (§5.2 rule 3)
//   4. FAILED retains everything, never truncates  → nothing in this file deletes anything
//   5. Progress emitted at most 4 Hz               → `#emitProgress`, P-22
//
// `SyncState` is imported from `src/shared/ipc-contract.ts` and never restated: the renderer
// and this file compile against the same declaration, so drift is a `typecheck` failure
// (ADR-031).

import type { AppError, SyncKind, SyncState } from '../../shared/ipc-contract';
import type { CycleSummary, PlannedFile, SyncRunContext, SyncWork } from './engine';

/** §8.5 P-22 — "Sync progress emits at most 4 Hz." 4 Hz is one emission per 250 ms. */
export const PROGRESS_INTERVAL_MS = 250;

export interface SyncCycleDeps {
  readonly work: SyncWork;
  /** Injected clock — nothing in this build reads a clock it did not receive. */
  readonly now: () => number;
  /** `evt:sync` (§4.9). Called on every phase transition and, while parsing, ≤ 4 Hz. */
  readonly emit: (state: SyncState) => void;
  /**
   * Called once when a cycle reaches IDLE having written something — the trigger for
   * `evt:dataChanged` (§4.9). Never called for a cycle that wrote nothing (P-18).
   */
  readonly onDataChanged?: (summary: CycleSummary) => void;
  readonly progressIntervalMs?: number;
}

/** What `sync:start` learned. `busy` is §4.4's `E_SYNC_BUSY` case, never a thrown error. */
export interface SyncStartOutcome {
  /** A new cycle began. */
  readonly started: boolean;
  /** §5.2 rule 2 — the request was folded into the running cycle's single follow-up. */
  readonly coalesced: boolean;
  /** §4.4 — `kind: 'full'` during a running cycle: it cannot be coalesced. */
  readonly busy: boolean;
  readonly state: SyncState;
}

const IDLE_STATE: SyncState = {
  phase: 'idle',
  kind: null,
  startedAt: null,
  filesTotal: 0,
  filesDone: 0,
  recordsIngested: 0,
  recordsDeduplicated: 0,
  badLines: 0,
  queuedRescan: false,
  lastCompletedAt: null,
  lastDurationMs: null,
  error: null,
};

export class SyncCycle {
  readonly #deps: SyncCycleDeps;
  readonly #progressIntervalMs: number;
  #state: SyncState = IDLE_STATE;
  #running: Promise<void> | null = null;
  #cancelRequested = false;
  #lastProgressEmit = 0;

  constructor(deps: SyncCycleDeps) {
    this.#deps = deps;
    this.#progressIntervalMs = deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  }

  /** `sync:state` (§4.4). Always a fresh object: it crosses IPC by structured clone. */
  state(): SyncState {
    return { ...this.#state };
  }

  /**
   * `sync:start` (§4.4, §5.2 rules 1–2).
   *
   * ⚠️ **Coalescing, not queueing.** N watcher events during a cycle produce exactly ONE
   * follow-up cycle, because `queuedRescan` is a boolean, not a counter or a list. A queue
   * here would make a busy directory schedule a cycle per event and never reach idle.
   */
  start(kind: SyncKind): SyncStartOutcome {
    if (this.#running !== null) {
      if (kind === 'full') {
        // §4.4 — a full rebuild cannot be folded into a running incremental cycle.
        return { started: false, coalesced: false, busy: true, state: this.state() };
      }
      this.#patch({ queuedRescan: true });
      return { started: false, coalesced: true, busy: false, state: this.state() };
    }
    this.#launch(kind);
    return { started: true, coalesced: false, busy: false, state: this.state() };
  }

  /**
   * `sync:cancel` (§4.4). ⚠️ Already-committed files stay committed and the manifest stays
   * consistent with them (§5.2 rule 3); the next cycle resumes from the recorded offsets.
   * Nothing is rolled back and nothing is deleted.
   */
  cancel(): SyncState {
    if (this.#running === null) return this.state();
    this.#cancelRequested = true;
    this.#patch({ phase: 'cancelling' });
    return this.state();
  }

  /** §5.2 — `FAILED ⇒ (manual retry) ⇒ SCANNING`. Explicit, never automatic (ADR-032). */
  retry(): SyncStartOutcome {
    if (this.#state.phase !== 'failed') return this.start('incremental');
    this.#state = { ...IDLE_STATE, lastCompletedAt: this.#state.lastCompletedAt };
    return this.start('incremental');
  }

  /** Resolves when no cycle is running. Tests await it; production never needs to. */
  async settled(): Promise<void> {
    while (this.#running !== null) await this.#running;
  }

  /**
   * Whether a cycle is in flight — the same fact `start()` branches on, exposed so a caller can
   * ask BEFORE it acts rather than after (A-16).
   *
   * ⚠️ The one caller is the explicit rebuild (§3.18), and it must ask first: the purge deletes
   * the very `file_manifest` rows a running cycle is holding ids for and writing offsets into, so
   * "purge, then discover the cycle refused to start" would leave the dataset half-erased with
   * nothing rebuilding it. `start('full')` reports busy only after the fact.
   */
  busy(): boolean {
    return this.#running !== null;
  }

  // -------------------------------------------------------------------------------------

  #launch(kind: SyncKind): void {
    const startedAt = this.#deps.now();
    this.#cancelRequested = false;
    this.#lastProgressEmit = 0;
    this.#state = {
      ...IDLE_STATE,
      phase: 'scanning',
      kind,
      startedAt,
      lastCompletedAt: this.#state.lastCompletedAt,
      lastDurationMs: this.#state.lastDurationMs,
    };
    this.#deps.emit(this.state());
    this.#running = this.#run(kind, startedAt).finally(() => {
      this.#running = null;
      this.#drainQueuedRescan();
    });
  }

  /** §5.2 rule 2 — "On reaching IDLE with `queuedRescan`, … start one more incremental cycle
   *  and clears the flag." One more, not one per event. */
  #drainQueuedRescan(): void {
    if (!this.#state.queuedRescan) return;
    if (this.#state.phase === 'failed') return;
    this.#patch({ queuedRescan: false });
    this.#launch('incremental');
  }

  async #run(kind: SyncKind, startedAt: number): Promise<void> {
    const context: SyncRunContext = { kind, isCancelled: () => this.#cancelRequested };
    try {
      const scan = await this.#work().scan(context);
      if (this.#cancelRequested) return this.#finishCancelled(startedAt);

      this.#patch({ phase: 'parsing', filesTotal: scan.files.length });
      const parsed = await this.#parseAll(scan.files, context);
      if (this.#cancelRequested) return this.#finishCancelled(startedAt);

      this.#patch({ phase: 'finalizing' });
      const summary: CycleSummary = {
        filesParsed: parsed,
        recordsIngested: this.#state.recordsIngested,
        badLines: this.#state.badLines,
        filesMissing: scan.filesMissing,
        startedAt,
        finishedAt: this.#deps.now(),
      };
      await this.#work().finalize(context, summary);

      const finishedAt = this.#deps.now();
      this.#patch({
        phase: 'idle',
        kind: null,
        startedAt: null,
        lastCompletedAt: finishedAt,
        lastDurationMs: finishedAt - startedAt,
        error: null,
      });
      // §4.9 — `evt:dataChanged` only when a cycle "finished having written anything".
      // ⚠️ ADR-041 — retaining an orphan or reconciling a returned one changes the stored dataset
      // (a session's `retained_orphan` flag, and thus the §4.6 disclosure count), even when no
      // file was parsed and none was deleted. Those cycles must invalidate queries too, or the
      // "N sessions kept" caveat would lag reality until the next unrelated sync.
      if (
        parsed > 0 ||
        scan.filesMissing > 0 ||
        scan.retainedOrphans > 0 ||
        scan.orphansReturned > 0
      ) {
        this.#deps.onDataChanged?.({ ...summary, finishedAt });
      }
    } catch (cause) {
      // ⚠️ §5.2 rule 4 — FAILED retains all previously ingested data. There is deliberately
      // no rollback, no truncate and no purge on this path (ADR-026).
      this.#patch({ phase: 'failed', error: toAppError(cause) });
    }
  }

  async #parseAll(files: readonly PlannedFile[], context: SyncRunContext): Promise<number> {
    let done = 0;
    for (const file of files) {
      if (this.#cancelRequested) break;
      const result = await this.#work().parseFile(file, context);
      done += 1;
      this.#state = {
        ...this.#state,
        filesDone: done,
        recordsIngested: this.#state.recordsIngested + result.recordsIngested,
        // ADR-019 — the same record offered twice, stored once. ⚠️ NOT the repeated-API-call
        // count (§4.6, migration 0011): that one is several distinct records sharing one call,
        // which `event_key` correctly does not treat as duplicates.
        recordsDeduplicated: this.#state.recordsDeduplicated + result.recordsDeduplicated,
        badLines: this.#state.badLines + result.badLinesDelta,
      };
      this.#emitProgress();
    }
    return done;
  }

  #finishCancelled(startedAt: number): void {
    const finishedAt = this.#deps.now();
    this.#patch({
      phase: 'idle',
      kind: null,
      startedAt: null,
      lastCompletedAt: finishedAt,
      lastDurationMs: finishedAt - startedAt,
    });
  }

  #work(): SyncWork {
    return this.#deps.work;
  }

  /** Every phase transition emits immediately — a phase change is not visual thrash. */
  #patch(patch: Partial<SyncState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#lastProgressEmit = this.#deps.now();
    this.#deps.emit(this.state());
  }

  /**
   * §8.5 P-22 — at most 4 Hz while parsing. "Enough to look alive, slow enough not to thrash
   * a peripheral-vision window" (§4.9). Dropping an intermediate frame loses nothing: the
   * state is cumulative and the next emission carries it.
   */
  #emitProgress(): void {
    const now = this.#deps.now();
    if (now - this.#lastProgressEmit < this.#progressIntervalMs) return;
    this.#lastProgressEmit = now;
    this.#deps.emit(this.state());
  }
}

/** §4.1 — the error contract. A sync failure is retryable: the files have not changed. */
function toAppError(cause: unknown): AppError {
  return {
    code: 'E_SYNC_FAILED',
    message: 'The sync could not finish. Everything already ingested has been kept.',
    detail: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
    retryable: true,
  };
}
