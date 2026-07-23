// The ONLY os.homedir() caller in the application (INV-17, STACK ADR-015). ESLint's
// `no-restricted-properties` rule is off for this single file and nowhere else.
//
// It is also where the ADR-018 E2E tripwire lives as production code: ADR-013's Vitest
// `setupFiles` assertion cannot cover `npm run e2e`, which launches the real application in
// a separate process where setup files never load. This file is the one place every path
// resolution already goes through, so the assertion cannot be reached by accident.
// ⚠️ Read ADR-013 and ADR-018 together; neither is complete alone.
//
// ⚠️ Three placement rules live here as functions rather than as prose, because each one is a
// data-safety property and prose does not fail a build:
//
//   1. `~/.claude` is resolved from `os.homedir()`, never written as a literal (INV-17).
//   2. The database is NEVER inside the Claude data directory (§9.3) — it would then be
//      scanned, watched, flagged and counted as bloat by the app itself.
//   3. `archiveRoot` is never inside `<claudeDir>`, never a parent of it, and never the
//      backup root (INV-19, ADR-034).

import * as os from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

/**
 * Restore points live at `<claudeDir>/.claude-lens-backups/<iso>-<auditId>/` (DESIGN §9.3).
 * Named here because the same constant is excluded from the watcher, from Bloat Radar and
 * from analytics (INV-14, OQ-103) — without that exclusion the app flags its own safety net
 * as bloat and offers to delete it.
 */
export const BACKUP_ROOT_NAME = '.claude-lens-backups';

/** The Claude data directory's conventional basename. `~/.claude` is a setting, not a constant. */
const CLAUDE_DIR_NAME = '.claude';

/** §9.3 — `app.getPath('userData')/claude-lens.db` (+ `-wal`, `-shm`). Never committed. */
export const DATABASE_FILE_NAME = 'claude-lens.db';

/**
 * ⚠️⚠️ §9.3, §9.4 — the folder `app.getPath('userData')` MUST resolve to, permanently.
 *
 * The user's real 213 MB database lives at `<appData>/claude-lens/claude-lens.db`. That folder
 * name is `package.json`'s `name` — the value `app.getName()` returns *before* the display name is
 * changed. The instant `app.setName('Claude Lens')` runs, Electron would otherwise re-derive
 * `userData` to `<appData>/Claude Lens/` — a DIFFERENT, empty folder — and the app would silently
 * re-parse ~1 GB into it and **orphan the USER-class data that has no other source**: hand-edited
 * prices, project groups, orphan-retention markers, the archives table and the audit log (§9.4,
 * ADR-026). That is exactly the invisible data loss this project exists to prevent (§1). Pinning
 * `userData` to this constant, derived from `appData` (which does NOT depend on the app name),
 * makes the path byte-identical across this rename and any future one.
 */
export const USER_DATA_DIR_NAME = 'claude-lens';

/** §7.3, §9.3 — `app.getPath('logs')/claude-lens.log`, rotated at 5 MB × 3 files. */
export const LOG_FILE_NAME = 'claude-lens.log';

/**
 * The real home directory of the user running this process.
 *
 * Every other module — including `test/support/tripwire.ts` — imports this rather than
 * calling `os.homedir()` itself, which is what keeps INV-17 literally true: the call
 * appears in exactly one file.
 */
export function realHomeDir(): string {
  return os.homedir();
}

/**
 * The real `<home>/.claude`. This is the directory the application must never resolve to in
 * a test or an E2E run, because the app has a delete subsystem (STACK ADR-013).
 */
export function realClaudeHome(): string {
  return resolve(realHomeDir(), CLAUDE_DIR_NAME);
}

/**
 * §3.13 — the value Onboarding offers as a *suggestion* when `claudeDir` is unset.
 *
 * ⚠️ It is a suggestion and never a fallback. `claudeDir` is `null` until the user confirms a
 * path (§5.1 `NO_DIR`), because it is the input to a delete subsystem: guessing there is
 * categorically different from guessing a theme. Nothing in this codebase may call this
 * function to "recover" from a missing or corrupt `claudeDir` setting.
 */
export function suggestedClaudeDataDir(): string {
  return realClaudeHome();
}

/** True if `candidate` is the real `<home>/.claude` or anything beneath it. */
export function isUnderRealClaudeHome(candidate: string): boolean {
  return isSameOrInside(realClaudeHome(), candidate);
}

/**
 * Throws if `candidate` resolves to the real `<home>/.claude` or beneath it.
 * The message names the offending path so the failure is actionable rather than mysterious.
 */
export function assertNotUnderRealClaudeHome(label: string, candidate: string): string {
  const resolved = resolve(candidate);
  if (isUnderRealClaudeHome(resolved)) {
    throw new Error(
      `[claude-lens] ${label} resolved inside the real Claude data directory. ` +
        'Refusing to continue: this application deletes files, and every test and E2E run ' +
        'must operate on a sandbox (STACK ADR-013/ADR-018, INV-17). ' +
        `Set CLAUDE_LENS_DATA_DIR to a directory under the OS temp root. Offending ${label}: ${resolved}`,
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------------------
// Containment predicates — one implementation, used by §9.3 and INV-19 alike.
// ---------------------------------------------------------------------------------------

/** True if `child` is `parent` itself or anything beneath it. Both are resolved first. */
export function isSameOrInside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const candidate = resolve(child);
  return candidate === root || candidate.startsWith(root + sep);
}

/** True if `candidate` is `<claudeDir>/.claude-lens-backups` or anything beneath it (INV-14). */
export function isUnderBackupRoot(claudeDir: string, candidate: string): boolean {
  return isSameOrInside(backupRoot(claudeDir), candidate);
}

/** §9.3 — `<claudeDir>/.claude-lens-backups`. */
export function backupRoot(claudeDir: string): string {
  return join(resolve(claudeDir), BACKUP_ROOT_NAME);
}

// ---------------------------------------------------------------------------------------
// §9.3 — where the app's own files live
// ---------------------------------------------------------------------------------------

/** §9.3 — `app.getPath('userData')/claude-lens.db`. */
export function databasePath(userDataDir: string): string {
  return join(resolve(userDataDir), DATABASE_FILE_NAME);
}

/** §7.3, §9.3 — `app.getPath('logs')/claude-lens.log`. */
export function logFilePath(logsDir: string): string {
  return join(resolve(logsDir), LOG_FILE_NAME);
}

// ---------------------------------------------------------------------------------------
// §9.3 / §9.4 — pinning userData so a display-name change never moves the database
// ---------------------------------------------------------------------------------------

export interface UserDataPinInput {
  /**
   * `app.getPath('appData')` — `~/Library/Application Support` on macOS. It is derived from the
   * OS, NOT from the app name, so pinning against it is robust to `app.setName` (this rename and
   * any future one).
   */
  readonly appDataDir: string;
  /**
   * True under `CLAUDE_LENS_E2E=1`. The E2E launcher points `userData` at a fresh sandbox via
   * `--user-data-dir` (ADR-018) — the pin must NOT fire then, or it would drag the test run onto
   * the developer's real database.
   */
  readonly e2e: boolean;
  /**
   * True when the process was launched with an explicit `--user-data-dir` override (the E2E
   * launcher's second protection, ADR-018). An explicit override always wins over the pin.
   */
  readonly userDataDirOverridden: boolean;
}

/**
 * ⚠️⚠️ §9.3, §9.4 — the folder `userData` must be pinned to, or `null` when the pin must NOT fire.
 *
 * Returns `<appData>/claude-lens` for a normal run — the existing lowercase, no-space location the
 * 213 MB database already lives in — so `app.setName('Claude Lens')` cannot move it. Returns `null`
 * under E2E or an explicit `--user-data-dir`, because those deliberately redirect `userData` to a
 * sandbox and the pin must respect that (ADR-018). Pure and electron-free, so the data-safety
 * property is unit-testable without a running app.
 */
export function userDataPinTarget(input: UserDataPinInput): string | null {
  if (input.e2e || input.userDataDirOverridden) return null;
  return join(resolve(input.appDataDir), USER_DATA_DIR_NAME);
}

/** The minimal Electron `app` surface the pin needs; a structural type keeps this file electron-free. */
export interface UserDataPinApp {
  getPath(name: 'appData'): string;
  setPath(name: 'userData', value: string): void;
  commandLine: { hasSwitch(name: string): boolean };
}

/**
 * ⚠️⚠️ §9.3, §9.4 — pin `app.getPath('userData')` to its existing `<appData>/claude-lens` location
 * so changing the display name to "Claude Lens" never moves the database. Call this ONCE at
 * startup, **before `app.whenReady()` and before any `app.setName(...)`**. No-op under E2E or an
 * explicit `--user-data-dir` (ADR-018). Returns the pinned path, or `null` when it left `userData`
 * untouched — handy for a startup log line.
 */
export function pinUserDataDir(app: UserDataPinApp): string | null {
  const target = userDataPinTarget({
    appDataDir: app.getPath('appData'),
    e2e: process.env['CLAUDE_LENS_E2E'] === '1',
    userDataDirOverridden: app.commandLine.hasSwitch('user-data-dir'),
  });
  if (target !== null) app.setPath('userData', target);
  return target;
}

/**
 * §9.3 — ⚠️ **the database is never placed inside the Claude data directory.**
 *
 * It would then be scanned into `file_manifest`, watched (so every WAL commit would trigger a
 * resync of the file the resync is writing), flagged by Bloat Radar as a large unexplained
 * file, and counted as bloat by the app itself. The failure is a feedback loop, not a tidiness
 * complaint, which is why this is an assertion and not a lint rule.
 */
export function assertDatabaseOutsideClaudeDir(databaseFile: string, claudeDir: string): string {
  const resolvedDb = resolve(databaseFile);
  if (isSameOrInside(claudeDir, resolvedDb)) {
    throw new Error(
      '[claude-lens] the database must live outside the Claude data directory (DESIGN §9.3). ' +
        `Refusing to open ${resolvedDb} against a Claude data directory at ${resolve(claudeDir)}: ` +
        'the app would scan, watch and flag its own database as bloat.',
    );
  }
  return resolvedDb;
}

// ---------------------------------------------------------------------------------------
// INV-19 — the archive-root validation predicate
// ---------------------------------------------------------------------------------------

/**
 * Why an archive root is unacceptable, or `null` when the containment rules pass.
 *
 * ⚠️ Containment only. Existence and writability are filesystem questions the §4.3 handler
 * answers; this module resolves paths and never touches a disk, so the predicate is testable
 * without a directory and cannot be tempted into creating one.
 */
export type ArchiveRootProblem =
  'not-absolute' | 'inside-claude-dir' | 'parent-of-claude-dir' | 'is-backup-root';

/**
 * INV-19 — "`archiveRoot` is never inside `<claudeDir>`, never a parent of it, never the
 * backup root". An archive inside the directory it was archived out of is not an archive
 * (ADR-034): the next scan walks it straight back in, and Bloat Radar offers to delete it.
 */
export function archiveRootProblem(
  archiveRoot: string,
  claudeDir: string | null,
): ArchiveRootProblem | null {
  if (!archiveRoot.startsWith('/')) return 'not-absolute';
  if (claudeDir === null) return null;
  if (isUnderBackupRoot(claudeDir, archiveRoot)) return 'is-backup-root';
  if (isSameOrInside(claudeDir, archiveRoot)) return 'inside-claude-dir';
  if (isSameOrInside(archiveRoot, claudeDir)) return 'parent-of-claude-dir';
  return null;
}

/** §3.15 — `<archiveRoot>/<claudeDirBasename>-<archiveId>/…` (§9.3). */
export function archiveDestination(
  archiveRoot: string,
  claudeDir: string,
  archiveId: number,
): string {
  return join(resolve(archiveRoot), `${basename(resolve(claudeDir))}-${String(archiveId)}`);
}

// ---------------------------------------------------------------------------------------
// STACK ADR-018 extension 1 — the production tripwire
// ---------------------------------------------------------------------------------------

export interface E2eStartupPaths {
  /** The configured Claude data directory, if one has been injected. */
  readonly claudeDataDir: string | undefined;
  /** Electron's `app.getPath('userData')` — where `claude-lens.db` lives (DESIGN §9.3). */
  readonly userDataDir: string;
}

/**
 * STACK ADR-018 extension 1 — the startup assertion.
 *
 * When `CLAUDE_LENS_E2E=1`, resolving either the Claude data directory or `userData` to a
 * path under the real `<home>/.claude` is fatal. The caller exits non-zero; it never
 * degrades, never warns, never continues.
 *
 * ⚠️ ADR-013's Vitest `setupFiles` tripwire does **not** cover this path: E2E launches the
 * real application in a separate process where setup files never load. This is the one
 * context in the project where a mistake reaches the delete subsystem.
 */
export function assertE2eStartupSafety(paths: E2eStartupPaths): void {
  if (process.env['CLAUDE_LENS_E2E'] !== '1') return;

  if (paths.claudeDataDir !== undefined) {
    assertNotUnderRealClaudeHome('CLAUDE_LENS_DATA_DIR', paths.claudeDataDir);
  }
  assertNotUnderRealClaudeHome('userData directory', paths.userDataDir);
}
