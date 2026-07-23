// SM-1 — DESIGN §5.1, the dataset lifecycle. The object every §4.3/§4.4 handler operates on.
//
//   States: NO_DIR · VALIDATING · READY_EMPTY · READY · FATAL.   Terminal: FATAL only.
//
// | From         | Event                                   | To          | Effects                                     |
// |--------------|-----------------------------------------|-------------|---------------------------------------------|
// | (boot)       | migrations applied, `claudeDir` null    | NO_DIR      | Onboarding surface (§6.2)                   |
// | (boot)       | migrations applied, `claudeDir` set     | VALIDATING  | —                                           |
// | (boot)       | migration throws                        | FATAL       | `evt:fatal E_DB_MIGRATION_FAILED`; ⚠️ NO purge, NO rebuild (ADR-026) |
// | NO_DIR       | `settings:set claudeDir` valid          | VALIDATING  | —                                           |
// | VALIDATING   | valid, fingerprint unchanged            | READY       | watcher (SM-5) + `sync:start incremental`   |
// | VALIDATING   | valid, fingerprint CHANGED              | READY_EMPTY | ⚠️ purge DERIVED ONLY (§3.18), then full sync |
// | VALIDATING   | validation fails                        | NO_DIR      | ⚠️ NEVER purges; existing data is retained  |
// | READY_EMPTY  | first sync completes with ≥1 event      | READY       | —                                           |
// | READY        | directory disappears / unreadable       | READY       | `evt:dirStatus`; watcher stops; ⚠️ cached data keeps rendering, banner says stale |
// | READY        | `settings:set claudeDir` (new path)     | VALIDATING  | —                                           |
// | any          | DB reports corruption                   | FATAL       | `evt:fatal E_DB_CORRUPT`                    |
//
// ⚠️ The two rows carrying the most weight, restated because getting either wrong is
// unrecoverable for the user:
//
//   · **A failed validation NEVER purges.** Pointing the app at a bad path must not cost the
//     user their data (§5.1, ADR-026). The only purge in this file is on the
//     fingerprint-changed row, and it is `purge()` from `src/main/db/purge.ts` — the §3.18
//     statement list, DERIVED only, RETAINED and USER rows untouched.
//   · **A migration failure purges nothing and rebuilds nothing** (ADR-026). It goes straight
//     to FATAL; §6.11's screen offers no reset button, because a reset would take `price_rows`
//     and `audit_log` with it.
//
// ⚠️ This module deliberately does not import `electron`. Everything Electron-specific — the
// window, the dialog, `app.getPath` — is injected by `src/main/index.ts`, which is what makes
// the whole state machine testable against a real SQLite file in a sandbox (STACK ADR-013).

import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AppBootstrap,
  AppError,
  DataScope,
  DirStatus,
  DirValidation,
  Disclosures,
  GlobalFilter,
  ProjectGroups,
  SettingKey,
  PushEmitterMap,
  SettingsSnapshot,
  SyncKind,
  SyncPhase,
  SyncState,
  UncostedSummary,
} from '../../shared/ipc-contract';
import { archiveRootProblem } from '../config/paths';
import { validateClaudeDir } from '../config/dir-validation';
import { isDbError } from '../db/errors';
import { currentSchemaVersion, migrate } from '../db/migrate';
import { MetaRepository, type MetaKey, type MetaValues } from '../db/meta-repo';
import { purge } from '../db/purge';
import { AnalyticsRepository } from '../db/repositories/analytics';
import { CostRepository } from '../db/repositories/cost';
import { ProjectGroupsRepository } from '../db/repositories/project-groups';
import type { QueryContext } from '../db/repositories/scope';
import { IngestRepository } from '../db/repositories/ingest-repo';
import { ManifestRepository } from '../db/repositories/manifest-repo';
import { SettingsRepository, type SettingsFallback } from '../db/settings-repo';
import type { SqliteDatabase } from '../db/sqlite';
import type { Logger } from '../log/logger';
import { createSyncWork, type CycleSummary, type SyncWork } from '../sync/engine';
import { SyncCycle } from '../sync/cycle';
import { Watcher, type WatchFactory } from '../watcher/watcher';
import { HandlerError } from './errors';
import { noPushEmitters } from './push';

/** §5.1's five states, transcribed. */
export type DatasetState = 'NO_DIR' | 'VALIDATING' | 'READY_EMPTY' | 'READY' | 'FATAL';

/**
 * §4.9 — the scopes a parse cycle can invalidate. `harness` and `bloat` are deliberately
 * absent: they are written by E10's harness scanner, not by the sync cycle, and claiming them
 * would make the renderer re-run queries nothing touched.
 */
export const PARSE_SCOPES: readonly DataScope[] = [
  'events',
  'sessions',
  'projects',
  'tools',
  'prompts',
];

/** A mutable view of §3.17's key set, so bookkeeping can be assembled field by field. */
type MetaPatch = { -readonly [K in MetaKey]?: MetaValues[K] };

export interface DatasetDeps {
  readonly db: SqliteDatabase;
  readonly logger: Logger;
  /** §4.9. Defaults to emitters that go nowhere, for the window-less case and for tests. */
  readonly emit?: PushEmitterMap;
  /** Injected clock — nothing in this build reads a clock it did not receive (ADR-021). */
  readonly now?: () => number;
  /** Test seam for §4.3 directory validation. */
  readonly validateDir?: (path: string) => Promise<DirValidation>;
  /** Test seam for the work SM-2 dispatches (§5.2). Production builds the real engine. */
  readonly createWork?: (claudeDir: string) => SyncWork;
  /**
   * §9.3 — the app's own placement rules, checked the moment a `claudeDir` resolves. Injected
   * because this module does not know where `app.getPath('userData')` is; `src/main/index.ts`
   * passes `assertDatabaseOutsideClaudeDir` bound to the real database path.
   * ⚠️ A database inside the Claude data directory would be scanned, watched, flagged and
   * counted as bloat by the app itself.
   */
  readonly assertClaudeDirUsable?: (claudeDir: string) => void;
  /** Test seam for SM-5's chokidar watch (STACK ADR-010). */
  readonly watchFactory?: WatchFactory;
  readonly debounceMs?: number;
  readonly progressIntervalMs?: number;
  /**
   * §4.8 / §5.1 — fired **once** after the first sync cycle that follows a (re)entry into
   * `READY` / `READY_EMPTY` completes. `src/main/index.ts` wires it to the harness scan
   * (`harness:scan`), so the Harness Map and Manager are populated the first time the app opens
   * without the user hunting for a button (§1.3 moment 6, §6.9).
   *
   * ⚠️ Why here, and why once. The scan walks `~/.claude` **and** every resolved project
   * `.claude` — P-12 budgets it at ≤ 3 s — so it is deliberately NOT part of every incremental
   * sync (§5.2) and must NOT be wired into the watcher's per-change debounce (§5.6, P-12/P-13).
   * This hook fires only after the FIRST sync following a validation, never after a
   * watcher-driven resync, so a keystroke-driven append never re-walks every project. A new
   * `claudeDir` re-arms it (its own first sync runs the scan again for the new tree). It runs
   * AFTER the metrics sync so it never delays Overview's first paint (§8.5 P-19), and the
   * observed overlay (M-14) it computes joins against `tool_calls` the sync has just written.
   */
  readonly onReady?: () => void;
}

export class DatasetService {
  readonly settings: SettingsRepository;
  readonly meta: MetaRepository;
  readonly ingest: IngestRepository;
  readonly manifest: ManifestRepository;
  readonly cost: CostRepository;
  /**
   * E4's §4.5 façade. Held here so §6.7's four graph channels can be served without a second
   * implementation of any §5.9 metric (CLAUDE.md §1) — the repository is composed, never
   * re-derived.
   */
  readonly analytics: AnalyticsRepository;
  /** ADR-040 — the user's "these folders are the same project". USER class; never purged. */
  readonly groups: ProjectGroupsRepository;

  readonly #deps: DatasetDeps;
  readonly #emit: PushEmitterMap;
  readonly #now: () => number;
  readonly #validateDir: (path: string) => Promise<DirValidation>;

  #state: DatasetState = 'NO_DIR';
  #dirStatus: DirStatus = 'unset';
  #claudeDir: string | null = null;
  #schemaVersion = 0;
  #fatal: AppError | null = null;
  #cycle: SyncCycle | null = null;
  #watcher: Watcher | null = null;
  #lastPhase: SyncPhase = 'idle';
  #runningKind: SyncKind | null = null;
  #filesMissingSinceLastSync = 0;
  /**
   * §4.8 / §5.1 — armed when a validation lands on `READY` / `READY_EMPTY` and starts that
   * dataset's first sync; disarmed by the completion of that sync, which is when `onReady`
   * fires. A watcher-driven resync never arms it, so the heavy harness scan runs once per
   * (re)validation rather than once per file change (§5.6, P-12/P-13).
   */
  #firstSyncAfterReadyPending = false;

  constructor(deps: DatasetDeps) {
    this.#deps = deps;
    this.#emit = deps.emit ?? noPushEmitters();
    this.#now = deps.now ?? Date.now;
    this.#validateDir = deps.validateDir ?? validateClaudeDir;
    this.settings = new SettingsRepository(deps.db);
    this.meta = new MetaRepository(deps.db);
    this.ingest = new IngestRepository(deps.db);
    this.manifest = new ManifestRepository(deps.db);
    this.cost = new CostRepository(deps.db);
    this.analytics = new AnalyticsRepository(deps.db);
    this.groups = new ProjectGroupsRepository(deps.db);
  }

  state(): DatasetState {
    return this.#state;
  }

  dirStatus(): DirStatus {
    return this.#dirStatus;
  }

  claudeDir(): string | null {
    return this.#claudeDir;
  }

  fatal(): AppError | null {
    return this.#fatal;
  }

  schemaVersion(): number {
    return this.#schemaVersion;
  }

  watcherState(): string {
    return this.#watcher?.state() ?? 'STOPPED';
  }

  /**
   * §5.6 — `WATCHING → SUSPENDED` while a guarded action executes, and back with **one**
   * explicit incremental sync.
   *
   * ⚠️ E10's dispatcher must bracket every ACT-01…07 execution with these two calls. Without
   * it, the restore point the action writes into `<claudeDir>` is itself an fs event, and the
   * resync it triggers races the mutation the restore point exists to protect (§5.5, ADR-032).
   * The seam is exposed here rather than left for E10 to reach into the watcher, so there is
   * one place that knows the pairing.
   */
  suspendWatcher(): void {
    this.#watcher?.suspend();
  }

  resumeWatcher(): void {
    this.#watcher?.resume();
  }

  // -------------------------------------------------------------------------------------
  // Boot — §5.1's three `(boot)` rows
  // -------------------------------------------------------------------------------------

  async boot(): Promise<void> {
    // ⚠️ Migrations first, and a throw here is TERMINAL. No purge, no rebuild, no
    // drop-and-re-sync — there is no such path in this codebase (§3.18, §9.6, ADR-026).
    try {
      const outcome = migrate(this.#deps.db);
      this.#schemaVersion = currentSchemaVersion(this.#deps.db);
      if (outcome.applied.length > 0) {
        this.#deps.logger.info('database schema migrated', {
          from: outcome.from,
          to: outcome.to,
          applied: outcome.applied.join(', '),
        });
      }
    } catch (cause) {
      this.#toFatal(cause, 'E_DB_MIGRATION_FAILED', 'The database schema could not be updated.');
      return;
    }

    let snapshot: SettingsSnapshot;
    try {
      snapshot = this.settingsSnapshot();
    } catch (cause) {
      // §5.1 "any | DB reports corruption | FATAL". Reading `settings` is the first read of
      // the session; if the table itself will not answer, the database is not usable.
      this.#toFatal(cause, 'E_DB_CORRUPT', 'The database could not be read.');
      return;
    }

    if (snapshot.claudeDir === null) {
      this.#state = 'NO_DIR';
      this.#dirStatus = 'unset';
      return;
    }

    try {
      await this.#validateAndTransition(snapshot.claudeDir);
    } catch (cause) {
      // A transition failure at boot is reported and survived — the app still starts, and the
      // renderer sees the `dirStatus` the transition left behind. §5.1 reserves FATAL for
      // migration failure and DB corruption, and this is neither.
      this.#deps.logger.error('the dataset could not be brought up at boot', {
        detail: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
      });
    }
  }

  /** Window closed / app quit — §5.6, §1.6 non-goal 7. Nothing survives. */
  async shutdown(): Promise<void> {
    await this.#watcher?.stop();
    this.#watcher = null;
  }

  // -------------------------------------------------------------------------------------
  // §4.3 — settings
  // -------------------------------------------------------------------------------------

  /**
   * §4.3 `settings:get`. Applies the E6 ruling on a corrupt PERSISTED value: fall back to the
   * documented default and log it. See `src/main/db/settings-repo.ts` for the reasoning.
   */
  settingsSnapshot(): SettingsSnapshot {
    return this.settings.snapshot((fallback) => {
      this.#logSettingFallback(fallback);
    });
  }

  #logSettingFallback(fallback: SettingsFallback): void {
    this.#deps.logger.warn('a stored setting was unusable and fell back to its default', {
      key: fallback.key,
      reason: fallback.reason,
      // ⚠️ The VALUE is never logged. A `claudeDir` is an absolute path (§7.3 forbids it) and
      // any other value is the user's configuration, not ours to publish.
      fellBackTo: fallback.key === 'claudeDir' ? 'null (onboarding)' : 'documented default',
    });
  }

  /**
   * §4.3 `settings:set`. `claudeDir` **validates first** and, on success, triggers the
   * purge-and-full-sync transition of §5.1. ⚠️ It never partially applies: validation happens
   * before a single row is written, and `SettingsRepository.set` is one transaction.
   */
  async setSetting(key: SettingKey, value: unknown): Promise<SettingsSnapshot> {
    if (key === 'claudeDir') return this.#setClaudeDir(value);
    if (key === 'archiveRoot' && value !== null) await this.#assertArchiveRootUsable(value);
    return this.settings.set(key, value, this.#now());
  }

  async #setClaudeDir(value: unknown): Promise<SettingsSnapshot> {
    if (value === null) {
      // Back to onboarding. ⚠️ No purge: the user has not told us the data is wrong, only
      // that they no longer want a directory configured (§5.1, ADR-026).
      const snapshot = this.settings.set('claudeDir', null, this.#now());
      await this.shutdown();
      this.#claudeDir = null;
      this.#state = 'NO_DIR';
      this.#dirStatus = 'unset';
      this.#emit['evt:dirStatus']('unset');
      return snapshot;
    }

    if (typeof value !== 'string' || !value.startsWith('/')) {
      throw new HandlerError(
        'E_INVALID_SETTING',
        'The Claude data directory must be an absolute path.',
      );
    }

    // ⚠️ VALIDATE FIRST. A path that does not validate is never persisted, so a mistyped
    // directory cannot leave the app pointing at nothing on the next launch — and, because
    // nothing is written, it cannot trigger the purge row of §5.1 either.
    const validation = await this.#validateDir(value);
    if (validation.status !== 'valid') {
      throw dirValidationError(validation);
    }

    await this.shutdown();
    const snapshot = this.settings.set('claudeDir', value, this.#now());
    await this.#validateAndTransition(value, validation);
    return snapshot;
  }

  /** INV-19 — containment plus the two filesystem facts §3.13 requires (exists, writable). */
  async #assertArchiveRootUsable(value: unknown): Promise<void> {
    if (typeof value !== 'string') {
      throw new HandlerError('E_INVALID_SETTING', 'The archive root must be an absolute path.');
    }
    const problem = archiveRootProblem(value, this.#claudeDir);
    if (problem !== null) {
      throw new HandlerError('E_ARCHIVE_ROOT_INVALID', archiveRootMessage(problem), {
        detail: `archiveRoot rejected: ${problem} (INV-19)`,
      });
    }
    try {
      const stats = await stat(value);
      if (!stats.isDirectory()) {
        throw new HandlerError('E_ARCHIVE_ROOT_INVALID', 'That archive root is not a directory.');
      }
      await access(value, fsConstants.W_OK);
    } catch (cause) {
      if (cause instanceof HandlerError) throw cause;
      throw new HandlerError(
        'E_ARCHIVE_ROOT_INVALID',
        'That archive root is missing or cannot be written to.',
        { cause },
      );
    }
  }

  // -------------------------------------------------------------------------------------
  // §4.3 — directory validation and the §5.1 transitions
  // -------------------------------------------------------------------------------------

  validate(path: string): Promise<DirValidation> {
    return this.#validateDir(path);
  }

  async #validateAndTransition(path: string, prevalidated?: DirValidation): Promise<void> {
    this.#state = 'VALIDATING';
    const validation = prevalidated ?? (await this.#validateDir(path));
    this.#dirStatus = validation.status;

    if (validation.status !== 'valid') {
      // ⚠️ §5.1 — "validation fails → NO_DIR; dirStatus carries the reason; existing data is
      // RETAINED, NOT PURGED." Pointing the app at a bad path must never cost the user their
      // data (ADR-026). There is deliberately no `purge()` on this branch.
      this.#state = 'NO_DIR';
      this.#emit['evt:dirStatus'](validation.status);
      this.#deps.logger.warn('the configured Claude data directory did not validate', {
        status: validation.status,
        reason: validation.reason ?? '-',
      });
      return;
    }

    const claudeDir = resolve(path);
    try {
      // §9.3 — refuse a Claude data directory that would contain our own database.
      this.#deps.assertClaudeDirUsable?.(claudeDir);
    } catch (cause) {
      this.#state = 'NO_DIR';
      this.#dirStatus = 'invalid';
      this.#emit['evt:dirStatus']('invalid');
      this.#deps.logger.error('the configured Claude data directory cannot be used', {
        code: 'E_DIR_INVALID',
        detail: cause instanceof Error ? cause.message : String(cause),
      });
      throw new HandlerError(
        'E_DIR_INVALID',
        'That directory cannot be used: Claude Lens stores its own database inside it.',
        { cause },
      );
    }
    this.#claudeDir = claudeDir;
    // §7.3 — redaction tracks the directory actually in use, so nothing written from here on
    // can contain the absolute path.
    this.#deps.logger.setClaudeDir(claudeDir);

    const fingerprint = claudeDirFingerprint(claudeDir);
    const stored = this.meta.get('claudeDirFingerprint');

    if (stored === fingerprint) {
      this.#state = 'READY';
      this.#emit['evt:dirStatus']('valid');
      this.#startWatcher(claudeDir);
      // §4.8 — arm the first-ready harness scan BEFORE the sync that will disarm it on completion.
      this.#firstSyncAfterReadyPending = true;
      this.startSync('incremental');
      return;
    }

    // §5.1 — fingerprint CHANGED. ⚠️ Purge DERIVED only (§3.18): `price_rows`, `settings`,
    // `audit_log` and `archives` are untouched (INV-12), and no RETAINED row is deleted
    // (INV-18). `purge()` audits its own statements before executing one.
    const outcome = purge(this.#deps.db);
    this.meta.set('claudeDirFingerprint', fingerprint, this.#now());
    this.#deps.logger.info('Claude data directory changed; DERIVED data purged', {
      rowsDeleted: outcome.totalDeleted,
      hadPreviousFingerprint: stored !== undefined,
    });
    this.#state = 'READY_EMPTY';
    this.#emit['evt:dirStatus']('valid');
    this.#startWatcher(claudeDir);
    // §4.8 — a changed directory is a new harness too; arm the scan for this tree's first sync.
    this.#firstSyncAfterReadyPending = true;
    this.startSync('full');
  }

  // -------------------------------------------------------------------------------------
  // §4.4 — sync
  // -------------------------------------------------------------------------------------

  syncState(): SyncState {
    return this.#cycle?.state() ?? idleSyncState(this.meta);
  }

  /**
   * §4.4 `sync:start`. Returns the current state; a coalesced request is **not** a failure.
   * `E_SYNC_BUSY` is reserved for `kind: 'full'` during a running cycle, which cannot be
   * folded into it (§4.4, §5.2 rule 2).
   */
  startSync(kind: SyncKind): SyncState {
    if (this.#claudeDir === null) {
      throw new HandlerError('E_NO_DIR', 'No Claude data directory is configured yet.');
    }
    const outcome = this.#ensureCycle(this.#claudeDir).start(kind);
    if (outcome.busy) {
      throw new HandlerError(
        'E_SYNC_BUSY',
        'A sync is already running, and a full rebuild cannot be folded into it.',
        { retryable: true },
      );
    }
    return outcome.state;
  }

  cancelSync(): SyncState {
    return this.#cycle?.cancel() ?? this.syncState();
  }

  /** Resolves when no cycle is running. Tests await it; production never needs to. */
  async settled(): Promise<void> {
    await this.#cycle?.settled();
  }

  #ensureCycle(claudeDir: string): SyncCycle {
    if (this.#cycle !== null) return this.#cycle;
    const work =
      this.#deps.createWork?.(claudeDir) ??
      createSyncWork({
        claudeDir,
        manifest: this.manifest,
        ingest: this.ingest,
        now: this.#now,
        // ADR-041 / §3.13 — read FRESH on every scan so toggling the setting takes effect on the
        // next cycle. Default TRUE (keep history) is applied by the setting layer itself.
        retainOrphanedHistory: () => this.settings.get('retainOrphanedHistory'),
      });
    this.#cycle = new SyncCycle({
      work,
      now: this.#now,
      emit: (state) => {
        this.#onSyncState(state);
      },
      onDataChanged: (summary) => {
        this.#onDataChanged(summary);
      },
      ...(this.#deps.progressIntervalMs === undefined
        ? {}
        : { progressIntervalMs: this.#deps.progressIntervalMs }),
    });
    return this.#cycle;
  }

  /**
   * §4.9 `evt:sync`. The 4 Hz cap (P-22) lives in `SyncCycle`, which throttles progress and
   * emits every phase transition immediately — one throttle, at the source.
   */
  #onSyncState(state: SyncState): void {
    if (state.kind !== null) this.#runningKind = state.kind;
    this.#emit['evt:sync'](state);
    // A cycle has completed when it returns to `idle` from anything else. `evt:dataChanged`
    // is a separate signal (below) because a cycle that wrote nothing must not invalidate a
    // single query (P-18: nine idle hours write nothing and re-query nothing).
    if (this.#lastPhase !== 'idle' && state.phase === 'idle') {
      this.#recordSyncCompletion(state);
      this.#maybeFirstReady();
    }
    this.#lastPhase = state.phase;
  }

  /**
   * §4.8 / §5.1 — the first sync following a validation has finished. If the dataset is in a
   * ready state, fire `onReady` exactly once so `index.ts` can run the harness scan now that the
   * metrics are in and Overview has painted. ⚠️ Disarmed unconditionally, so a later
   * watcher-driven resync (which does not re-arm the flag) can never trigger a second scan
   * (§5.6, P-12/P-13). A failed or throwing `onReady` must not take the sync path down — the
   * scan degrades to "the map keeps its prior data" (§6.9), never to a broken sync.
   */
  #maybeFirstReady(): void {
    if (!this.#firstSyncAfterReadyPending) return;
    this.#firstSyncAfterReadyPending = false;
    if (this.#state !== 'READY' && this.#state !== 'READY_EMPTY') return;
    try {
      this.#deps.onReady?.();
    } catch (cause) {
      this.#deps.logger.error('the first-ready hook threw; the sync cycle is unaffected', {
        detail: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
      });
    }
  }

  /** §3.17 — the sync bookkeeping E3 deliberately left to E6. */
  #recordSyncCompletion(state: SyncState): void {
    const kind = this.#runningKind ?? 'incremental';
    const at = state.lastCompletedAt ?? this.#now();
    const patch: MetaPatch = { lastSyncKind: kind };
    // ⚠️ Nothing is defaulted to "now" and nothing is zero-filled: a key whose fact is not
    // known is simply not written, and `MetaRepository.get` returns `undefined` for it, which
    // is the honest answer (§3.17, CLAUDE.md §1).
    if (state.lastCompletedAt !== null) patch.lastSyncCompletedAt = state.lastCompletedAt;
    if (state.lastDurationMs !== null) patch.lastSyncDurationMs = state.lastDurationMs;
    if (kind === 'full' && state.lastCompletedAt !== null) {
      patch.lastFullParseAt = state.lastCompletedAt;
    }
    if (this.#claudeDir !== null) {
      // Re-asserted on every cycle because the purge above deletes `meta` wholesale (§3.18).
      patch.claudeDirFingerprint = claudeDirFingerprint(this.#claudeDir);
    }
    try {
      this.meta.setMany(patch, at);
    } catch (cause) {
      this.#deps.logger.error('sync bookkeeping could not be written', {
        code: isDbError(cause) ? cause.code : 'E_INTERNAL',
        detail: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
      });
    }
  }

  /** §3.17 + §4.9 `evt:dataChanged`. Only ever called for a cycle that wrote something. */
  #onDataChanged(summary: CycleSummary): void {
    const counts = this.ingest.recordCounts();
    this.meta.setMany(
      {
        recordCounts: counts,
        badLineTotal: this.ingest.badLineTotal(),
        unlinkedSubagentRuns: this.ingest.unlinkedSubagentRuns(),
      },
      summary.finishedAt,
    );
    this.#filesMissingSinceLastSync = summary.filesMissing;

    // §5.1 — "READY_EMPTY | first sync completes with ≥1 event | READY".
    if (this.#state === 'READY_EMPTY' && counts.events > 0) this.#state = 'READY';

    // ⚠️ A silent re-query and an in-place number update, nothing more (§4.9, §6.2). This
    // never focuses, raises or animates the window.
    this.#emit['evt:dataChanged']({ at: summary.finishedAt, scopes: [...PARSE_SCOPES] });
  }

  // -------------------------------------------------------------------------------------
  // SM-5 — the watcher
  // -------------------------------------------------------------------------------------

  #startWatcher(claudeDir: string): void {
    this.#watcher = new Watcher({
      claudeDir,
      onChange: () => {
        // ⚠️ `SyncCycle.start` already coalesces (`queuedRescan`, §5.2 rule 2). There is no
        // second queue here, and a failure to start must not take the watcher down.
        try {
          this.startSync('incremental');
        } catch {
          // `E_SYNC_BUSY` on a watcher-driven start is impossible (it asks for incremental),
          // and any other failure is reported on the next `sync:state`.
        }
      },
      onDirectoryLost: (cause) => {
        void this.#onDirectoryLost(cause);
      },
      ...(this.#deps.watchFactory === undefined ? {} : { watchFactory: this.#deps.watchFactory }),
      ...(this.#deps.debounceMs === undefined ? {} : { debounceMs: this.#deps.debounceMs }),
    });
    this.#watcher.start();
  }

  /**
   * §5.1 — "READY | directory disappears / unreadable | READY".
   *
   * ⚠️ The dataset stays READY on purpose. `evt:dirStatus` is emitted, the watcher stops, and
   * **cached data keeps rendering with a banner saying it is stale** — not a blank screen, not
   * zeroes. The database still holds everything the last sync parsed; discarding it because a
   * volume was unmounted would be the app deleting the user's answers to punish the user's
   * filesystem.
   */
  async #onDirectoryLost(cause: unknown): Promise<void> {
    await this.#watcher?.stop();
    const path = this.#claudeDir;
    const status: DirStatus = path === null ? 'unset' : (await this.#validateDir(path)).status;
    this.#dirStatus = status === 'valid' ? 'valid' : status;
    this.#deps.logger.warn('the watched Claude data directory became unavailable', {
      status: this.#dirStatus,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    this.#emit['evt:dirStatus'](this.#dirStatus);
    // ⚠️ State unchanged. READY stays READY (§5.1).
  }

  // -------------------------------------------------------------------------------------
  // §5.1 — FATAL
  // -------------------------------------------------------------------------------------

  #toFatal(cause: unknown, code: 'E_DB_MIGRATION_FAILED' | 'E_DB_CORRUPT', message: string): void {
    const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    const error: AppError = {
      code: isDbError(cause) ? cause.code : code,
      message: isDbError(cause) ? cause.message : message,
      detail,
      retryable: false,
    };
    this.#state = 'FATAL';
    this.#fatal = error;
    this.#deps.logger.error(error.message, { code: error.code, detail });
    // §6.11 — the renderer shows the blocking screen. It offers *rebuild DERIVED* and
    // *export price rows*, and never a silent drop (ADR-026).
    this.#emit['evt:fatal'](error);
  }

  // -------------------------------------------------------------------------------------
  // §4.3 `app:bootstrap`
  // -------------------------------------------------------------------------------------

  /**
   * §4.3 — the app's front door.
   *
   * ⚠️ **`coverage` and `disclosures` are not E6's to invent.** `DataCoverage` is §5.9 M-16 and
   * `Disclosures.activeOverlapSeconds` is M-20; both are E4 metric arithmetic, and CLAUDE.md §1
   * says every metric is defined **once**. A second implementation here would be the A-10
   * problem repeated for a metric instead of an invariant.
   *
   * ⚠️ **AMENDED 2026-07-22 (E12).** E6 shipped this with a `notImplemented` branch for the
   * populated case, ending "the moment E4 lands, this branch is deleted and both fields come
   * from the metric layer". E4 landed; the branch is deleted. Both fields now come from
   * `AnalyticsRepository` — `coverage()` is M-16 and `disclosures()` is §4.6 — composed here,
   * never re-derived. The unbounded `GlobalFilter` is deliberate: bootstrap describes the whole
   * dataset, and the renderer re-queries `q:disclosures` once a filter exists (§4.2, §6.2).
   */
  bootstrap(): AppBootstrap {
    // §6.11 — a FATAL dataset answers with its own error, so a renderer that missed the
    // `evt:fatal` push (it subscribes after the window loads) still reaches the blocking
    // screen instead of an empty one.
    if (this.#fatal !== null) {
      throw new HandlerError(this.#fatal.code, this.#fatal.message, {
        ...(this.#fatal.detail === undefined ? {} : { detail: this.#fatal.detail }),
      });
    }

    return {
      schemaVersion: this.#schemaVersion,
      settings: this.settingsSnapshot(),
      dirStatus: this.#dirStatus,
      sync: this.syncState(),
      coverage: this.analytics.coverage(),
      disclosures: this.disclosures(this.queryContext(UNFILTERED)),
    };
  }

  /**
   * §4.6 `q:disclosures` — E4's arithmetic plus the one fact the database does not hold.
   *
   * ⚠️ `filesMissingSinceLastSync` is D-2: §5.3 deletes a `MISSING` file's manifest row and
   * §3.17's `meta` key set is closed, so the count exists only in this process, in
   * `CycleSummary.filesMissing`. It is supplied here rather than defaulted inside the
   * repository, which is what keeps the repository honest about not knowing it.
   */
  disclosures(context: QueryContext): Disclosures {
    return this.analytics.disclosures(context, {
      filesMissingSinceLastSync: this.#filesMissingSinceLastSync,
    });
  }

  /**
   * §4.6 `q:uncosted` — M-05/M-06, delegated to E5's `CostRepository`, which already
   * implements and fixture-tests them (F-09). ⚠️ Delegated, never reimplemented: a second
   * implementation of a §5.9 metric is the one thing CLAUDE.md §1 forbids outright.
   */
  uncosted(scope: {
    projectIds: number[] | null;
    from: number | null;
    to: number | null;
  }): UncostedSummary {
    // ADR-040 — `projectIds` are unit ids on the wire, exactly as everywhere else. This channel
    // does not build a `QueryContext`, so it expands them itself rather than filtering on a
    // negative id that matches no event and reporting a confident zero.
    scope = this.resolveFilter({ ...scope });
    return {
      records: this.cost.totals(scope).uncostedEvents,
      byModel: this.cost.uncostedByModel(scope),
    };
  }

  /**
   * A `GlobalFilter` plus the stored idle-gap threshold, as the analytics repositories take it.
   *
   * ⚠️ `idleGapMinutes` is read from `settings` here rather than inside a repository, because
   * ADR-022 makes active time a pure function of `(events, threshold)` evaluated per request and
   * INV-05 is only directly testable while the threshold is an argument (see `scope.ts`).
   */
  queryContext(filter: GlobalFilter): QueryContext {
    return {
      filter: this.resolveFilter(filter),
      idleGapMinutes: this.settingsSnapshot().idleGapMinutes,
    };
  }

  /**
   * §4.2 as amended by ADR-040 — a `GlobalFilter` carries **project unit** ids, and this is the
   * ONE place they become the real `events.project_id` values every repository tests against.
   *
   * ⚠️ Done here rather than inside `scopeClause` on purpose: the expansion needs the database,
   * and `scopeClause` is a pure function that twenty queries share. Doing it once, at the edge,
   * means no repository has to know that grouping exists in order to be filtered correctly.
   *
   * ⚠️ `null` stays `null` ("every project"). A non-empty selection that expands to nothing stays
   * empty and therefore selects nothing — §4.2's rule, and the reason `scope.ts` writes `1 = 0`
   * rather than dropping the clause: silently widening an empty selection is how a scoped number
   * becomes a global one.
   */
  resolveFilter(filter: GlobalFilter): GlobalFilter {
    if (filter.projectIds === null) return filter;
    return { ...filter, projectIds: this.groups.expandUnitIds(filter.projectIds) };
  }

  /**
   * §4.5 `groups:*` (ADR-040). Mutations go through here rather than through the analytics
   * façade so that a grouping change announces itself: every open view re-queries and the whole
   * app moves to the new unit at once, instead of one screen disagreeing with another.
   *
   * ⚠️ Nothing here suggests, guesses or auto-detects a grouping. The user supplies the name and
   * the folders (§2.1, zero inference).
   */
  projectGroups(): ProjectGroups {
    return this.analytics.projectGroups();
  }

  createProjectGroup(name: string, encodedNames: readonly string[]): ProjectGroups {
    return this.#announceGroups(this.groups.create(name, encodedNames, this.#now()));
  }

  renameProjectGroup(groupId: number, name: string): ProjectGroups {
    return this.#announceGroups(this.groups.rename(groupId, name, this.#now()));
  }

  ungroupProjectGroup(groupId: number): ProjectGroups {
    return this.#announceGroups(this.groups.ungroup(groupId));
  }

  #announceGroups(rows: ReturnType<ProjectGroupsRepository['list']>): ProjectGroups {
    // §4.9 — a silent re-query and an in-place number update, nothing more. `projects` is the
    // scope that changed shape; `events`, `sessions` and `tools` all report per project, so they
    // are named too. ⚠️ No file was read and no row was re-parsed: grouping is a label.
    this.#emit['evt:dataChanged']({
      at: this.#now(),
      scopes: ['projects', 'events', 'sessions', 'tools'],
    });
    return { rows };
  }
}

// ---------------------------------------------------------------------------------------

/** §3.17 — "sha256 of the absolute `claudeDir`, used to detect a directory change". */
export function claudeDirFingerprint(claudeDir: string): string {
  return createHash('sha256').update(resolve(claudeDir)).digest('hex');
}

/** §4.3 — the DirStatus → §4.1 error, with the validator's own reason as the message. */
export function dirValidationError(validation: DirValidation): HandlerError {
  const code =
    validation.status === 'not_found'
      ? 'E_DIR_NOT_FOUND'
      : validation.status === 'unreadable'
        ? 'E_DIR_UNREADABLE'
        : validation.status === 'invalid'
          ? 'E_DIR_INVALID'
          : 'E_NO_DIR';
  return new HandlerError(code, validation.reason ?? 'That directory cannot be used.');
}

function archiveRootMessage(problem: string): string {
  switch (problem) {
    case 'inside-claude-dir':
      return 'The archive root must be outside your Claude data directory.';
    case 'parent-of-claude-dir':
      return 'The archive root must not contain your Claude data directory.';
    case 'is-backup-root':
      return "The archive root must not be Claude Lens's own backup folder.";
    default:
      return 'The archive root must be an absolute path.';
  }
}

/** §4.4 — the state before any cycle has run in this process, seeded from §3.17 `meta`. */
function idleSyncState(meta: MetaRepository): SyncState {
  const stored = meta.snapshot();

  return {
    phase: 'idle',
    kind: null,
    startedAt: null,
    filesTotal: 0,
    filesDone: 0,
    recordsIngested: 0,
    // This cycle's bad-line count, and there is no cycle: 0 is the fact, not a placeholder.
    // The dataset-wide total is `meta.badLineTotal`, disclosed through §4.6, never here.
    badLines: 0,
    queuedRescan: false,
    lastCompletedAt: stored.lastSyncCompletedAt ?? null,
    lastDurationMs: stored.lastSyncDurationMs ?? null,
    error: null,
  };
}

/**
 * §4.2 — "everything". `app:bootstrap` describes the whole dataset, before any filter exists.
 * ⚠️ Not a default: the renderer's own filter reaches every `q:*` channel explicitly, and this
 * constant is used at exactly one call site (§4.2, §6.2).
 */
const UNFILTERED: GlobalFilter = { projectIds: null, from: null, to: null };
