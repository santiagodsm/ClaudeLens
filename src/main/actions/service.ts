// SM-4, the guarded-action lifecycle — DESIGN §5.5, §5.7, §4.8, ADR-032/033/034.
//
//   States: PREVIEWED · CONFIRM_PENDING · TYPED_CONFIRM_PENDING · BACKING_UP · EXECUTING ·
//           COMPLETED · FAILED_PARTIAL · FAILED · UNDOING · UNDONE · ABORTED
//
// The four rules this file exists to make true, each testable:
//
//   1. ⚠️ **Backup strictly precedes mutation. If backup fails, NOTHING is mutated, ever**
//      (INV-07, §5.5 rule 1). `#backup()` runs before `#mutate()` and a throw from it goes
//      straight to `FAILED` with `E_ACTION_BACKUP_FAILED`; no mutation code has run.
//   2. ⚠️ **The confirm token binds the preview to the execution** (INV-06, §5.5 rule 2). Targets
//      are re-resolved at execute time and the token is redeemed against the NEW list.
//   3. ⚠️ **`FAILED_PARTIAL` triggers no automatic recovery** (§5.5 rule 4). The result reports
//      "N of M"; the app never auto-restores and never auto-deletes.
//   4. ⚠️ **Every terminal state writes exactly one `audit_log` row** — including `FAILED`
//      (§5.5 rule 6). `ABORTED` writes none: nothing happened and nothing was promised, so
//      cancelling a dialog never reaches this file at all.
//
// ⚠️ **Every execution is bracketed with `suspendWatcher()` / `resumeWatcher()`** (§5.6). The
// restore point the action writes into `<claudeDir>` is itself a filesystem event, and the resync
// it would trigger races the mutation the restore point exists to protect.
//
// ⚠️ **Nothing is ever auto-deleted, including the app's own backups** (§1.6 non-goal 4, OQ-103).
// There is no retention policy, no age cap, no size cap and no pruning anywhere in this file.
// ACT-06 removes restore points and it is a guarded action with typed confirmation of its own.

import { access, mkdir, rm, stat, copyFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ActionExecuteResult,
  ActionPreview,
  ActionResult,
  ActionType,
  ActionUndoResult,
  ArchiveCandidates,
  ArchiveRow,
  AuditEntry,
  AuditStatus,
  BackupsSummary,
  Page,
  Paged,
} from '../../shared/ipc-contract';
import { archiveDestination, archiveRootProblem } from '../config/paths';
import { AuditLogRepository, type AuditRecord } from '../db/repositories/audit-log';
import { ArchivesRepository } from '../db/repositories/archives-repo';
import { pageFrom } from '../db/repositories/scope';
import type { SqliteDatabase } from '../db/sqlite';
import { entryKind } from '../harness/tree';
import { HandlerError } from '../ipc/errors';
import type { Logger } from '../log/logger';
import { isKnownActionType, specFor } from './catalogue';
import { ConfirmTokenStore } from './confirm-token';
import {
  filesUnder,
  movePath,
  readRestorePoint,
  removeRestorePoint,
  restoreFromCopy,
  restoreFromMove,
  restorePointRelPath,
  writeCopyRestorePoint,
  writeMoveManifest,
  type MoveManifest,
  type MoveManifestEntry,
} from './restore-point';
import {
  assertTargetsAllowed,
  resolveTargets,
  typedConfirmFor,
  type ResolvedTarget,
} from './targets';

export interface ActionServiceDeps {
  readonly db: SqliteDatabase;
  readonly logger: Logger;
  /** §5.1 — `null` until the user has configured one. INV-17: never resolved implicitly. */
  readonly claudeDir: () => string | null;
  /** §3.13 — `null` ⇒ ACT-07 unavailable. */
  readonly archiveRoot: () => string | null;
  /** §5.6 — the seam `src/main/ipc/dataset.ts` exposes. Both are called, always, in pairs. */
  readonly suspendWatcher: () => void;
  readonly resumeWatcher: () => void;
  readonly now: () => number;
  /** §4.9 `evt:actionCompleted`. Emitted once, at the terminal state. */
  readonly onActionCompleted: (payload: { auditId: number; status: AuditStatus }) => void;
  /** Test seam for INV-06's 5-minute expiry. */
  readonly tokenTtlMs?: number;
}

interface Mutation {
  readonly succeeded: string[];
  readonly skipped: string[];
  readonly failed: { relPath: string; reason: string }[];
  readonly bytesAffected: number;
  /** ACT-07 only — what the terminal transaction has to annotate. */
  readonly archive?: {
    readonly archiveId: number;
    readonly destinationRoot: string;
    readonly sessionIds: string[];
    readonly files: MoveManifestEntry[];
    readonly rangeFromTs: number | null;
    readonly rangeToTs: number | null;
  };
}

export class ActionService {
  readonly #deps: ActionServiceDeps;
  readonly #audit: AuditLogRepository;
  readonly #archives: ArchivesRepository;
  readonly #tokens: ConfirmTokenStore;
  /** One action at a time: `reserveId()` and the restore-point path both depend on it. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ActionServiceDeps) {
    this.#deps = deps;
    this.#audit = new AuditLogRepository(deps.db);
    this.#archives = new ArchivesRepository(deps.db);
    this.#tokens = new ConfirmTokenStore(deps.now, deps.tokenTtlMs);
  }

  // -------------------------------------------------------------------------------------
  // §4.8 `action:preview`
  // -------------------------------------------------------------------------------------

  /**
   * Resolves the targets, checks the guards, and mints the token bound to the exact list
   * (INV-06). ⚠️ It mutates nothing — not the filesystem, not the database.
   */
  async preview(request: { actionType: unknown; payload: unknown }): Promise<ActionPreview> {
    const actionType = this.#requireKnownAction(request.actionType);
    const claudeDir = this.#requireClaudeDir();
    if (actionType === 'archive-sessions') await this.#requireUsableArchiveRoot(claudeDir);

    const resolved = await resolveTargets(
      { claudeDir, archives: this.#archives },
      actionType,
      request.payload,
    );
    assertTargetsAllowed(actionType, claudeDir, resolved.targets);

    const typed = typedConfirmFor(actionType, resolved.targets, resolved.sessionIds.length);
    return {
      actionType,
      targets: [...resolved.targets],
      totalBytes: resolved.targets.reduce((total, target) => total + target.sizeBytes, 0),
      requiresTypedConfirm: typed.required,
      typedConfirmPhrase: typed.phrase,
      confirmToken: this.#tokens.mint(actionType, resolved.targets),
      warnings: [...resolved.warnings],
    };
  }

  // -------------------------------------------------------------------------------------
  // §4.8 `action:execute` — SM-4 from CONFIRM_PENDING to a terminal state
  // -------------------------------------------------------------------------------------

  execute(request: {
    actionType: unknown;
    payload: unknown;
    confirmToken: string;
  }): Promise<ActionExecuteResult> {
    return this.#serialize(() => this.#execute(request));
  }

  async #execute(request: {
    actionType: unknown;
    payload: unknown;
    confirmToken: string;
  }): Promise<ActionExecuteResult> {
    // ADR-032's dispatcher rule, before anything else happens.
    const actionType = this.#requireKnownAction(request.actionType);
    const claudeDir = this.#requireClaudeDir();
    const startedAt = this.#deps.now();

    // §5.6 — SUSPENDED for the whole execution, WATCHING again afterwards, whatever happens.
    this.#deps.suspendWatcher();
    try {
      if (actionType === 'archive-sessions') await this.#requireUsableArchiveRoot(claudeDir);

      // ⚠️ INV-06 — the targets are resolved AGAIN, from the filesystem as it is now.
      const resolved = await resolveTargets(
        { claudeDir, archives: this.#archives },
        actionType,
        request.payload,
      );
      assertTargetsAllowed(actionType, claudeDir, resolved.targets);

      const refusal = this.#tokens.redeem(request.confirmToken, actionType, resolved.targets);
      if (refusal !== null) {
        // ⚠️ No audit row: the state is ABORTED, and "ABORTED writes none — nothing happened and
        // nothing was promised" (§5.5 rule 6). Nothing has been backed up or mutated.
        throw new HandlerError(
          'E_ACTION_NOT_CONFIRMED',
          'What this action would change is not what you confirmed, so nothing was changed. ' +
            'Run the check again and review the new list.',
          { detail: `confirm token refused: ${refusal} (INV-06)` },
        );
      }

      const auditId = this.#audit.reserveId();
      const backupRelPath = restorePointRelPath(auditId, startedAt);

      // ---- BACKING_UP ------------------------------------------------------------------
      // ⚠️ Strictly before EXECUTING. A throw here has mutated nothing.
      let backupBytes = 0;
      let moveManifest: MoveManifest | null = null;
      try {
        if (actionType === 'archive-sessions') {
          moveManifest = await this.#buildMoveManifest(claudeDir, auditId, resolved.targets);
          backupBytes = (await writeMoveManifest(claudeDir, backupRelPath, moveManifest))
            .backupBytes;
        } else if (actionType === 'clear-backups') {
          // §5.7 — "Backs up: nothing — this *is* the backups." There is no restore point for
          // removing restore points, which is precisely why ACT-06 requires a typed phrase.
          backupBytes = 0;
        } else {
          backupBytes = (
            await writeCopyRestorePoint(claudeDir, backupRelPath, auditId, resolved.targets)
          ).backupBytes;
        }
      } catch (cause) {
        this.#recordFailure(actionType, claudeDir, resolved.targets, auditId, startedAt, cause);
        throw cause;
      }

      // ---- EXECUTING -------------------------------------------------------------------
      const mutation = await this.#mutate(actionType, claudeDir, resolved, moveManifest);

      const status: AuditStatus =
        mutation.failed.length === 0 && mutation.succeeded.length > 0
          ? 'completed'
          : mutation.succeeded.length > 0
            ? 'failed_partial'
            : mutation.failed.length === 0
              ? // Nothing failed and nothing succeeded: every target was skipped. There is
                // nothing to undo, but the attempt is still recorded (§5.5 rule 6).
                'completed'
              : 'failed';

      const hasRestorePoint = actionType !== 'clear-backups' && mutation.succeeded.length > 0;

      this.#deps.db.transaction((): void => {
        this.#audit.record({
          id: auditId,
          actionType,
          status,
          claudeDir,
          targetSummary: specFor(actionType).summarize(mutation.succeeded.length),
          // §3.14 — "the rel_paths ACTUALLY acted on".
          targets: mutation.succeeded,
          bytesAffected: mutation.bytesAffected,
          backupRelPath: hasRestorePoint ? backupRelPath : null,
          backupBytes: hasRestorePoint ? backupBytes : 0,
          backupPresent: hasRestorePoint,
          startedAt,
          finishedAt: this.#deps.now(),
          undoOfId: null,
          errorCode: mutation.failed.length > 0 ? 'E_ACTION_PARTIAL' : null,
          errorDetail:
            mutation.failed.length > 0
              ? mutation.failed.map((entry) => `${entry.relPath}: ${entry.reason}`).join('; ')
              : null,
          now: this.#deps.now(),
        });

        if (actionType === 'clear-backups' && mutation.succeeded.length > 0) {
          // §3.14 — the entries whose restore point this removed keep their history and lose
          // their undo claim. ⚠️ No `audit_log` row is deleted.
          this.#audit.withdrawAllBackups(this.#deps.now());
        }

        const archive = mutation.archive;
        if (archive !== undefined && archive.sessionIds.length > 0) {
          this.#archives.recordArchive(
            {
              id: archive.archiveId,
              auditId,
              archiveRoot: archive.destinationRoot,
              claudeDir,
              sessionCount: archive.sessionIds.length,
              fileCount: archive.files.length,
              bytesMoved: mutation.bytesAffected,
              rangeFromTs: archive.rangeFromTs,
              rangeToTs: archive.rangeToTs,
              now: this.#deps.now(),
            },
            archive.files.map((file) => ({
              relPath: file.originalRelPath,
              archiveRelPath: file.archiveRelPath,
            })),
            archive.sessionIds,
          );
        }
      })();

      this.#deps.onActionCompleted({ auditId, status });
      return {
        auditId,
        status,
        result: {
          succeeded: mutation.succeeded,
          skipped: mutation.skipped,
          failed: mutation.failed,
          backupRelPath: hasRestorePoint ? backupRelPath : null,
          backupBytes: hasRestorePoint ? backupBytes : 0,
        } satisfies ActionResult,
      };
    } finally {
      // §5.6 — `SUSPENDED | action reaches a terminal state | WATCHING`, with one explicit
      // incremental sync. Runs on the failure paths too: a suspended watcher that never resumes
      // would silently stop the app noticing new transcripts.
      this.#deps.resumeWatcher();
    }
  }

  // -------------------------------------------------------------------------------------
  // §4.8 `action:undoLast` — §5.5 rule 5
  // -------------------------------------------------------------------------------------

  undoLast(request: { auditId: number }): Promise<ActionUndoResult> {
    return this.#serialize(() => this.#undoLast(request));
  }

  async #undoLast(request: { auditId: number }): Promise<ActionUndoResult> {
    const claudeDir = this.#requireClaudeDir();
    const candidate = this.#audit.latestUndoable();
    if (candidate === undefined || candidate.id !== request.auditId) {
      throw new HandlerError(
        'E_ACTION_NOTHING_TO_UNDO',
        'That action can no longer be undone. Only the most recent action that still has its ' +
          'restore point can be reversed.',
        {
          detail:
            candidate === undefined
              ? 'no audit entry matches status=completed AND undone_at IS NULL AND backup_present=1'
              : `the most recent undoable entry is ${String(candidate.id)}, not ${String(request.auditId)}`,
        },
      );
    }
    if (candidate.backupRelPath === null) {
      throw new HandlerError(
        'E_ACTION_BACKUP_MISSING',
        'That action has no restore point, so it cannot be undone.',
      );
    }

    const startedAt = this.#deps.now();
    this.#deps.suspendWatcher();
    try {
      const manifest = await readRestorePoint(claudeDir, candidate.backupRelPath);
      let restored: number;
      if (manifest.kind === 'move') {
        // ⚠️ Verifies size and mtime for EVERY entry before moving a single file back, and
        // refuses with `E_ARCHIVE_VERIFY_FAILED` on any mismatch (ADR-034, §5.5 rule 1).
        restored = await restoreFromMove(manifest);
        // §5.7 ACT-07 rule 5 — "clears the annotations, restoring the exact prior state".
        this.#archives.clearArchive(manifest.archiveId);
      } else {
        restored = await restoreFromCopy(claudeDir, candidate.backupRelPath, manifest);
      }

      // §5.5 rule 5 — a NEW entry with `undo_of_id` set; the original gets `undone_at`.
      const undoId = this.#audit.reserveId();
      this.#deps.db.transaction((): void => {
        this.#audit.record({
          id: undoId,
          actionType: candidate.actionType,
          status: 'undone',
          claudeDir,
          targetSummary: `undo of #${String(candidate.id)}: ${candidate.targetSummary}`,
          targets: candidate.targets,
          bytesAffected: candidate.bytesAffected,
          // ⚠️ The undo entry names the restore point it read, and marks it NOT present: the
          // restore point still exists on disk (nothing is ever auto-deleted), but this entry is
          // not itself undoable — there is no "redo" in v1 (§11.5).
          backupRelPath: candidate.backupRelPath,
          backupBytes: candidate.backupBytes,
          backupPresent: false,
          startedAt,
          finishedAt: this.#deps.now(),
          undoOfId: candidate.id,
          errorCode: null,
          errorDetail: null,
          now: this.#deps.now(),
        });
        this.#audit.markUndone(candidate.id, this.#deps.now());
      })();

      this.#deps.onActionCompleted({ auditId: undoId, status: 'undone' });
      return { auditId: undoId, status: 'undone', restored };
    } finally {
      this.#deps.resumeWatcher();
    }
  }

  // -------------------------------------------------------------------------------------
  // §4.8 read-only channels
  // -------------------------------------------------------------------------------------

  auditList(page: Page): Paged<AuditEntry> {
    const rows = this.#audit.listAll().map(toAuditEntry);
    return pageFrom(rows, page, (row) => [row.startedAt, row.id]);
  }

  backupsSummary(): BackupsSummary {
    return this.#audit.backupSummary();
  }

  archivesList(): { rows: ArchiveRow[] } {
    return { rows: this.#archives.list() };
  }

  /** §4.8 — read-only. "It never mutates and never mints a token; `action:preview` does that." */
  archiveCandidates(request: {
    olderThanTs: number;
    projectIds: number[] | null;
  }): ArchiveCandidates {
    const sessions = this.#archives.candidates(request.olderThanTs, request.projectIds);
    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        displayName: session.displayName,
        lastTs: session.lastTs,
        bytes: session.bytes,
      })),
      totalBytes: sessions.reduce((total, session) => total + session.bytes, 0),
    };
  }

  // -------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------

  #serialize<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(body, body);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #requireKnownAction(value: unknown): ActionType {
    // ⚠️ ADR-032 — "An action type not in this table cannot be executed."
    if (!isKnownActionType(value)) {
      throw new HandlerError(
        'E_ACTION_UNKNOWN',
        'Claude Lens does not have an action by that name.',
        {
          detail:
            `unknown action type: ${JSON.stringify(value)}. The catalogue is CLOSED (§5.7, ` +
            'ADR-032); adding an entry is a design change, not an implementation detail.',
        },
      );
    }
    return value;
  }

  #requireClaudeDir(): string {
    const claudeDir = this.#deps.claudeDir();
    if (claudeDir === null) {
      throw new HandlerError('E_NO_DIR', 'No Claude data directory is configured yet.');
    }
    return resolve(claudeDir);
  }

  /** §5.7 ACT-07 preconditions, plus INV-19's containment rules from `paths.ts`. */
  async #requireUsableArchiveRoot(claudeDir: string): Promise<string> {
    const archiveRoot = this.#deps.archiveRoot();
    if (archiveRoot === null || archiveRoot === '') {
      throw new HandlerError(
        'E_ARCHIVE_NO_ROOT',
        'Choose a folder to archive into before archiving anything.',
      );
    }
    // ⚠️ INV-19 — never inside `claudeDir`, never a parent of it, never the backup root.
    // The predicate lives in `paths.ts` and is not re-derived here.
    const problem = archiveRootProblem(archiveRoot, claudeDir);
    if (problem !== null) {
      throw new HandlerError(
        'E_ARCHIVE_ROOT_INVALID',
        'That archive folder cannot be used: it must sit outside your Claude data directory.',
        { detail: `archiveRoot rejected: ${problem} (INV-19)` },
      );
    }
    try {
      if (!(await stat(archiveRoot)).isDirectory()) throw new Error('not a directory');
      await access(archiveRoot, fsConstants.W_OK);
    } catch (cause) {
      throw new HandlerError(
        'E_ARCHIVE_ROOT_INVALID',
        'That archive folder is missing or cannot be written to.',
        { cause },
      );
    }
    return resolve(archiveRoot);
  }

  /**
   * §5.5 rule 6 — a `FAILED` terminal state writes exactly one row too. The backup failed, so
   * `backup_rel_path` is NULL and `backup_present` is 0: the entry does not claim an undo it
   * cannot honour.
   */
  #recordFailure(
    actionType: ActionType,
    claudeDir: string,
    targets: readonly ResolvedTarget[],
    auditId: number,
    startedAt: number,
    cause: unknown,
  ): void {
    const error = cause instanceof HandlerError ? cause : null;
    this.#audit.record({
      id: auditId,
      actionType,
      status: 'failed',
      claudeDir,
      targetSummary: `${specFor(actionType).summarize(targets.length)} — not changed`,
      // ⚠️ Empty: §3.14's `targets_json` is "the rel_paths ACTUALLY acted on", and none were.
      targets: [],
      bytesAffected: 0,
      backupRelPath: null,
      backupBytes: 0,
      backupPresent: false,
      startedAt,
      finishedAt: this.#deps.now(),
      undoOfId: null,
      errorCode: error?.code ?? 'E_ACTION_BACKUP_FAILED',
      errorDetail: error?.detail ?? (cause instanceof Error ? cause.message : String(cause)),
      now: this.#deps.now(),
    });
    this.#deps.onActionCompleted({ auditId, status: 'failed' });
  }

  /** ACT-07's restore point: the manifest, built from the tree as it is right now. */
  async #buildMoveManifest(
    claudeDir: string,
    auditId: number,
    targets: readonly ResolvedTarget[],
  ): Promise<MoveManifest> {
    const archiveRoot = await this.#requireUsableArchiveRoot(claudeDir);
    const archiveId = this.#archives.reserveId();
    // §9.3 — `<archiveRoot>/<claudeDirBasename>-<archiveId>/…`, from `paths.ts`.
    const destinationRoot = archiveDestination(archiveRoot, claudeDir, archiveId);

    // §5.7 ACT-07 rule 2 — "Destination collisions are refused up front; nothing is moved."
    if ((await entryKind(destinationRoot)) !== null) {
      throw new HandlerError(
        'E_ARCHIVE_COLLISION',
        'Something already exists where these transcripts would go, so nothing was moved.',
        { detail: `destination already exists: ${destinationRoot}` },
      );
    }

    const entries: MoveManifestEntry[] = [];
    for (const target of targets) {
      for (const file of await filesUnder(claudeDir, target.relPath)) {
        entries.push({
          originalRelPath: file.relPath,
          // §5.7 ACT-07 rule 1 — "preserving the relative layout under
          // `archiveRoot/<claudeDirBasename>-<archiveId>/`". So the path under the destination
          // root IS the original rel_path, and `archives.archive_root` is that destination root
          // (§3.2: `archive_rel_path` is "relative to archives.archive_root").
          archiveRelPath: file.relPath,
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs,
        });
      }
    }

    return {
      kind: 'move',
      auditId,
      archiveId,
      claudeDir,
      archiveRoot: destinationRoot,
      entries,
    };
  }

  async #mutate(
    actionType: ActionType,
    claudeDir: string,
    resolved: { targets: readonly ResolvedTarget[]; sessionIds: readonly string[] },
    moveManifest: MoveManifest | null,
  ): Promise<Mutation> {
    if (actionType === 'archive-sessions') {
      if (moveManifest === null) throw new Error('unreachable: move class without a manifest');
      return this.#archiveSessions(claudeDir, resolved, moveManifest);
    }
    if (actionType === 'restore-claude-md')
      return this.#restoreClaudeMd(claudeDir, resolved.targets);
    return this.#deleteTargets(actionType, claudeDir, resolved.targets);
  }

  /** ACT-01, ACT-02, ACT-03, ACT-05, ACT-06 — the delete class. */
  async #deleteTargets(
    actionType: ActionType,
    claudeDir: string,
    targets: readonly ResolvedTarget[],
  ): Promise<Mutation> {
    const succeeded: string[] = [];
    const skipped: string[] = [];
    const failed: { relPath: string; reason: string }[] = [];
    let bytesAffected = 0;

    for (const target of targets) {
      const absolute = resolve(join(claudeDir, target.relPath));
      if ((await entryKind(absolute)) === null) {
        // Vanished since the token was minted. Reported, never treated as success.
        skipped.push(target.relPath);
        continue;
      }
      try {
        if (actionType === 'clear-backups') {
          await removeRestorePoint(claudeDir, target.relPath);
        } else {
          await rm(absolute, { recursive: true, force: false });
        }
        succeeded.push(target.relPath);
        bytesAffected += target.sizeBytes;
      } catch (cause) {
        // ⚠️ §5.5 rule 4 — recorded and reported. Nothing is retried, restored or cleaned up.
        failed.push({ relPath: target.relPath, reason: reasonOf(cause) });
      }
    }
    return { succeeded, skipped, failed, bytesAffected };
  }

  /**
   * ACT-04 — "the sole write of file *content*, and it is a whole-file copy of a file the user
   * already has — never authored content" (§5.7, §1.6 non-goal 2).
   *
   * The resolved list carries two entries (the `CLAUDE.md` and the backup it is restored from),
   * because the user is approving "overwrite this with that" and both sizes are part of the
   * decision. Only the `CLAUDE.md` is written, and only it is recorded as acted on.
   */
  async #restoreClaudeMd(claudeDir: string, targets: readonly ResolvedTarget[]): Promise<Mutation> {
    const destination = targets.find((target) => isClaudeMd(target.relPath));
    const source = targets.find((target) => !isClaudeMd(target.relPath));
    if (destination === undefined || source === undefined) {
      return {
        succeeded: [],
        skipped: [],
        failed: [{ relPath: targets[0]?.relPath ?? '?', reason: 'the pair no longer resolves' }],
        bytesAffected: 0,
      };
    }
    try {
      await copyFile(
        resolve(join(claudeDir, source.relPath)),
        resolve(join(claudeDir, destination.relPath)),
      );
      return {
        succeeded: [destination.relPath],
        skipped: [source.relPath],
        failed: [],
        bytesAffected: source.sizeBytes,
      };
    } catch (cause) {
      return {
        succeeded: [],
        skipped: [],
        failed: [{ relPath: destination.relPath, reason: reasonOf(cause) }],
        bytesAffected: 0,
      };
    }
  }

  /**
   * ACT-07 — the move class.
   *
   * ⚠️⚠️ **Session granularity, whole file set, always** (INV-20, §5.7 ACT-07 rule 1). A session's
   * transcript and its whole `subagents/` directory move as ONE unit. If any part of a session's
   * move fails, the parts that moved are put back **within that same unit** and the session is
   * reported as failed and NOT annotated.
   *
   * ⚠️ That reverse move is not the "automatic recovery" §5.5 rule 4 forbids: it does not read
   * the restore point, it does not touch any other action's targets, and it happens before a
   * single row is annotated. It exists because INV-20 declares the unit indivisible — half a
   * session on each side of the archive boundary is the state that makes `purge.ts`'s `events`
   * predicate unsafe. If the reverse move itself fails, the database is still left untouched for
   * that session (nothing is annotated, so the session stays live), and the failure is reported
   * with both paths so the user can finish it by hand.
   */
  async #archiveSessions(
    claudeDir: string,
    resolved: { targets: readonly ResolvedTarget[]; sessionIds: readonly string[] },
    manifest: MoveManifest,
  ): Promise<Mutation> {
    const succeeded: string[] = [];
    const skipped: string[] = [];
    const failed: { relPath: string; reason: string }[] = [];
    const archivedSessions: string[] = [];
    const archivedFiles: MoveManifestEntry[] = [];
    let bytesAffected = 0;
    let rangeFromTs: number | null = null;
    let rangeToTs: number | null = null;

    await mkdir(manifest.archiveRoot, { recursive: true });

    for (const sessionId of resolved.sessionIds) {
      const fileSet = this.#archives.sessionFileSet(sessionId);
      if (fileSet === null) {
        failed.push({ relPath: sessionId, reason: 'the session left the database mid-action' });
        continue;
      }
      const unit = resolved.targets.filter(
        (target) =>
          target.relPath === fileSet.files.transcriptRelPath ||
          target.relPath === fileSet.files.subagentsRelDir,
      );

      const moved: ResolvedTarget[] = [];
      let unitFailure: string | null = null;
      for (const target of unit) {
        try {
          await movePath(
            resolve(join(claudeDir, target.relPath)),
            join(manifest.archiveRoot, target.relPath),
          );
          moved.push(target);
        } catch (cause) {
          unitFailure = reasonOf(cause);
          break;
        }
      }

      if (unitFailure !== null) {
        for (const target of moved) {
          try {
            await movePath(
              join(manifest.archiveRoot, target.relPath),
              resolve(join(claudeDir, target.relPath)),
            );
          } catch (cause) {
            failed.push({
              relPath: target.relPath,
              reason: `moved to the archive but could not be put back: ${reasonOf(cause)}`,
            });
          }
        }
        for (const target of unit) failed.push({ relPath: target.relPath, reason: unitFailure });
        continue;
      }

      archivedSessions.push(sessionId);
      for (const target of unit) {
        succeeded.push(target.relPath);
        bytesAffected += target.sizeBytes;
        for (const entry of manifest.entries) {
          if (
            entry.originalRelPath === target.relPath ||
            entry.originalRelPath.startsWith(`${target.relPath}/`)
          ) {
            archivedFiles.push(entry);
          }
        }
      }
      const { firstTs, lastTs } = fileSet.files;
      if (firstTs !== null)
        rangeFromTs = rangeFromTs === null ? firstTs : Math.min(rangeFromTs, firstTs);
      if (lastTs !== null) rangeToTs = rangeToTs === null ? lastTs : Math.max(rangeToTs, lastTs);
    }

    return {
      succeeded,
      skipped,
      failed,
      bytesAffected,
      archive: {
        archiveId: manifest.archiveId,
        destinationRoot: manifest.archiveRoot,
        sessionIds: archivedSessions,
        files: archivedFiles,
        rangeFromTs,
        rangeToTs,
      },
    };
  }
}

/**
 * Which of ACT-04's two resolved targets is the file being overwritten.
 *
 * ⚠️ Matched on the exact basename, not on a suffix: a suffix test would make
 * `notes.local.md` a CLAUDE.md, and ACT-04 is the one action in the catalogue that WRITES file
 * content. The two names are `classifyFileKind`'s (`src/main/parse/source-file.ts`), which is the
 * single source of what counts as a `claude_md`.
 */
function isClaudeMd(relPath: string): boolean {
  const basename = relPath.slice(relPath.lastIndexOf('/') + 1);
  return basename === 'CLAUDE.md' || basename === 'CLAUDE.local.md';
}

function reasonOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/** §4.8 `AuditEntry` — the §3.14 row as the renderer sees it (§6.10 card 6). */
export function toAuditEntry(record: AuditRecord): AuditEntry {
  return {
    id: record.id,
    actionType: record.actionType,
    status: record.status,
    claudeDir: record.claudeDir,
    targetSummary: record.targetSummary,
    targets: record.targets,
    bytesAffected: record.bytesAffected,
    backupRelPath: record.backupRelPath,
    backupBytes: record.backupBytes,
    backupPresent: record.backupPresent,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    undoneAt: record.undoneAt,
    undoOfId: record.undoOfId,
    errorCode: record.errorCode,
    errorDetail: record.errorDetail,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
