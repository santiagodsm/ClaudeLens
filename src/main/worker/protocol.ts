// The worker↔main message vocabulary. DESIGN §7.2, STACK ADR-009.
//
// ⚠️ **Structured-clone only.** Every type below is a plain object of primitives and arrays:
// no class instance, no function, no `Error`, no `Map`, no SQLite handle. A `postMessage`
// that carries something unclonable throws `DataCloneError` at runtime, in the middle of the
// one operation the PRD budgets for (P-01) — so the vocabulary is declared once, here, and
// both ends compile against it.
//
// Errors cross as `{ ok: false, message }`, never as a thrown `Error`: an `Error` clones its
// message and name but loses its prototype and its `cause`, which produces a "worker failed"
// with no detail at exactly the wrong moment.

import type { PlannedFile } from '../sync/engine';

/** Handed to the worker at construction, on `workerData`. */
export interface ParseWorkerConfig {
  /** §9.3 — `app.getPath('userData')/claude-lens.db`. The worker opens its OWN handle. */
  readonly dbPath: string;
  /** INV-17 — the root is a parameter, even across a thread boundary. */
  readonly claudeDir: string;
}

/** main → worker. */
export type ParseWorkerRequest =
  | { readonly type: 'parse'; readonly id: number; readonly file: PlannedFile }
  | { readonly type: 'finalize'; readonly id: number }
  /** §5.2 `CANCELLING` — cooperative; the worker stops between lines and between files. */
  | { readonly type: 'cancel' }
  | { readonly type: 'close' };

/** One file's outcome, mirroring `FileParseResult` (§5.2's progress counters). */
export interface ParseWorkerFileResult {
  readonly relPath: string;
  readonly recordsIngested: number;
  readonly badLinesDelta: number;
  readonly cancelled: boolean;
}

/** worker → main. */
export type ParseWorkerResponse =
  | { readonly type: 'ready' }
  | {
      readonly type: 'parsed';
      readonly id: number;
      readonly ok: true;
      readonly result: ParseWorkerFileResult;
    }
  | { readonly type: 'parsed'; readonly id: number; readonly ok: false; readonly message: string }
  | { readonly type: 'finalized'; readonly id: number; readonly ok: true }
  | {
      readonly type: 'finalized';
      readonly id: number;
      readonly ok: false;
      readonly message: string;
    };

/** Narrowing helper shared by both ends; the wire is `unknown` until it is checked. */
export function isParseWorkerResponse(value: unknown): value is ParseWorkerResponse {
  if (typeof value !== 'object' || value === null) return false;
  const type: unknown = (value as { type?: unknown }).type;
  return type === 'ready' || type === 'parsed' || type === 'finalized';
}
