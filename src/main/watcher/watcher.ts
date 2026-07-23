// SM-5 — DESIGN §5.6, the watcher lifecycle. STACK ADR-010 (chokidar@5).
//
//   STOPPED ──dataset READY/READY_EMPTY──> WATCHING
//   WATCHING ──fs event──> DEBOUNCING ──500 ms quiet──> WATCHING + one incremental sync
//   WATCHING ──window closed / app quit──> STOPPED          (watcher closed)
//   WATCHING ──guarded action executing──> SUSPENDED        (our own writes)
//   SUSPENDED ──action terminal──> WATCHING + one explicit incremental sync
//
// Four properties this file exists to hold, each with its citation:
//
//   · **One recursive watch on `claudeDir`**, not a per-file fleet — P-16 caps descriptors at
//     64 regardless of tree size (STACK ADR-010).
//   · **The backup root is ignored** (INV-14). Without it the app resyncs on its own restore
//     points, and every guarded action triggers a rescan of the thing it just wrote.
//   · **Only the parsed file kinds** reach the debouncer. A `file-history/` write or a
//     `.DS_Store` is not a reason to re-parse anything (ADR-028).
//   · **No background process survives the window** (§1.6 non-goal 7, §7.6, P-18). `stop()` is
//     called from `window-all-closed` and from `before-quit`, and it closes the watch.
//
// ⚠️ There is exactly ONE queue in this system and it is `SyncCycle`'s `queuedRescan` boolean
// (§5.2 rule 2). This file debounces and then calls `start('incremental')` once; it never
// accumulates a list of its own. A second queue here is how a busy directory ends up
// scheduling one cycle per event and never reaching idle.

import { watch } from 'chokidar';
import { BACKUP_ROOT_NAME } from '../config/paths';
import { classifyFileKind, PARSED_FILE_KINDS } from '../parse/source-file';

/** §5.6 — "Start/extend a 500 ms timer". STACK ADR-010: "debounced ~500 ms". */
export const WATCH_DEBOUNCE_MS = 500;

/** §5.6 states, transcribed. */
export type WatcherState = 'STOPPED' | 'WATCHING' | 'DEBOUNCING' | 'SUSPENDED';

/** The subset of `chokidar`'s `FSWatcher` SM-5 uses. Narrow, so a fake is honest. */
export interface WatchHandle {
  on(event: 'all', listener: (event: string, path: string) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  close(): Promise<void>;
}

export type WatchFactory = (root: string, ignored: (path: string) => boolean) => WatchHandle;

export interface WatcherDeps {
  /** INV-17 — the root is a parameter, always. */
  readonly claudeDir: string;
  /**
   * Called once per quiet period, and once on return from `SUSPENDED`. It is
   * `SyncCycle.start('incremental')`; coalescing is entirely that object's business (§5.2).
   */
  readonly onChange: () => void;
  /**
   * The watch root became unreadable or disappeared. §5.1: the dataset stays `READY`, the
   * watcher stops, `evt:dirStatus` is emitted, and **cached data keeps rendering with a
   * banner saying it is stale** — never a blank screen and never zeroes.
   */
  readonly onDirectoryLost?: (cause: unknown) => void;
  readonly debounceMs?: number;
  /** Test seam. Production passes nothing and real chokidar is used (STACK ADR-010). */
  readonly watchFactory?: WatchFactory;
  /** Injected timers, so the 500 ms debounce is testable without waiting 500 ms. */
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * Whether a path under `root` is ignored by the watch.
 *
 * Exported and pure, because INV-14 is a testable assertion ("no path under
 * `<claudeDir>/.claude-lens-backups/` appears … in the watcher's event stream") and a
 * predicate buried in an options object is not one.
 *
 * Directories are never ignored by kind — only by the backup rule — because chokidar must be
 * allowed to descend into `projects/<encoded>/` to see the transcripts inside it. Kind
 * filtering happens on the event, in `#onEvent`, where a real file path is in hand.
 */
export function isIgnoredWatchPath(root: string, path: string): boolean {
  const rel = toRelative(root, path);
  if (rel === null) return false;
  if (rel === '') return false;
  const segments = rel.split('/');
  // INV-14 — `<claudeDir>/.claude-lens-backups/**` never reaches the event stream.
  return segments[0] === BACKUP_ROOT_NAME;
}

/**
 * Whether an event on this path is a reason to re-parse. Only the §3.2 kinds the sync cycle
 * parses count (`SYNC_SCAN_KINDS` is the same set); everything else — `file-history/`
 * snapshots (ADR-028), `.DS_Store`, editor swap files — is discovered and ignored.
 *
 * ⚠️ A directory event carries no kind, so it is not a trigger on its own: the file event
 * that follows it is. This is what keeps a `git checkout` inside a project from producing a
 * resync per directory.
 */
export function isWatchTrigger(root: string, path: string): boolean {
  if (isIgnoredWatchPath(root, path)) return false;
  const rel = toRelative(root, path);
  if (rel === null || rel === '') return false;
  return PARSED_FILE_KINDS.has(classifyFileKind(rel));
}

function toRelative(root: string, path: string): string | null {
  const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
  if (path === normalizedRoot) return '';
  if (!path.startsWith(`${normalizedRoot}/`)) return null;
  return path.slice(normalizedRoot.length + 1);
}

const defaultWatchFactory: WatchFactory = (root, ignored) =>
  // STACK ADR-010 — ONE recursive watch on the root. `ignoreInitial` because the sync cycle
  // has already scanned the tree; replaying it as N add events would trigger a resync of a
  // directory that just finished being read (P-16, P-18).
  //
  // `awaitWriteFinish` is chokidar's atomic-write handling: editors and the Claude CLI write
  // then rename, and without it a transcript is parsed mid-write. Reimplementing that is how
  // a watcher starts missing appends (ADR-010).
  watch(root, {
    ignored: (path: string) => ignored(path),
    ignoreInitial: true,
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

export class Watcher {
  readonly #deps: WatcherDeps;
  readonly #debounceMs: number;
  readonly #setTimer: (callback: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  #state: WatcherState = 'STOPPED';
  #handle: WatchHandle | null = null;
  #timer: unknown = null;

  constructor(deps: WatcherDeps) {
    this.#deps = deps;
    this.#debounceMs = deps.debounceMs ?? WATCH_DEBOUNCE_MS;
    this.#setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimer =
      deps.clearTimer ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
  }

  state(): WatcherState {
    return this.#state;
  }

  /** §5.6 — `STOPPED → WATCHING` when the dataset reaches `READY` / `READY_EMPTY`. */
  start(): void {
    if (this.#state !== 'STOPPED') return;
    const factory = this.#deps.watchFactory ?? defaultWatchFactory;
    const root = this.#deps.claudeDir;
    const handle = factory(root, (path) => isIgnoredWatchPath(root, path));
    handle.on('all', (_event: string, path: string) => {
      this.#onEvent(path);
    });
    handle.on('error', (cause: unknown) => {
      // §5.1 — the directory disappeared or became unreadable. The dataset stays READY.
      this.#deps.onDirectoryLost?.(cause);
      void this.stop();
    });
    this.#handle = handle;
    this.#state = 'WATCHING';
  }

  /**
   * §5.6 — `WATCHING → STOPPED` on window closed / app quit.
   * ⚠️ **No background process survives** (§1.6 non-goal 7, §7.6, P-18).
   */
  async stop(): Promise<void> {
    this.#cancelTimer();
    this.#state = 'STOPPED';
    const handle = this.#handle;
    this.#handle = null;
    if (handle !== null) await handle.close();
  }

  /**
   * §5.6 — `WATCHING → SUSPENDED` while a guarded action executes.
   * ⚠️ The app's own writes must not trigger a resync: a restore point is written into
   * `<claudeDir>` by ACT-01…07, and a resync on it would race the mutation it is protecting.
   */
  suspend(): void {
    if (this.#state === 'STOPPED') return;
    this.#cancelTimer();
    this.#state = 'SUSPENDED';
  }

  /** §5.6 — `SUSPENDED → WATCHING`, with **one** explicit incremental sync. */
  resume(): void {
    if (this.#state !== 'SUSPENDED') return;
    this.#state = 'WATCHING';
    // "One explicit incremental sync" — unconditional, because a guarded action's whole
    // purpose is to have changed the tree, and the manifest must be reconciled against it.
    this.#deps.onChange();
  }

  // -------------------------------------------------------------------------------------

  #onEvent(path: string): void {
    if (this.#state === 'STOPPED') return;
    // ⚠️ SUSPENDED drops the event on purpose: it is our own write. `resume()` runs one
    // explicit incremental sync that covers everything the action did (§5.6).
    if (this.#state === 'SUSPENDED') return;
    if (!isWatchTrigger(this.#deps.claudeDir, path)) return;

    // §5.6 — "Start/extend a 500 ms timer". Extend, so a burst of appends across a busy
    // directory produces one sync at the end rather than one per file.
    this.#cancelTimer();
    this.#state = 'DEBOUNCING';
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      if (this.#state !== 'DEBOUNCING') return;
      this.#state = 'WATCHING';
      this.#deps.onChange();
    }, this.#debounceMs);
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    this.#clearTimer(this.#timer);
    this.#timer = null;
  }
}
