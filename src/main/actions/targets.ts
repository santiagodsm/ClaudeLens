// Target resolution for the closed catalogue — DESIGN §5.7's `Targets` column, §5.5 rules 3 and
// 7, INV-06, INV-14.
//
// ⚠️⚠️ **Resolution is a pure function of (actionType, payload, filesystem, database).** It runs
// twice — once for `action:preview` and once, identically, for `action:execute` — and INV-06 is
// exactly the statement that the two runs agree. Anything non-deterministic here (a clock, an
// unsorted `readdir`, a "best effort" fallback) would make the confirm token fail spuriously or,
// far worse, succeed against a list the user never saw.
//
// ⚠️⚠️ **INV-14 / §5.5 rule 7 — no target may resolve inside the backup root**
// (`E_ACTION_TARGET_FORBIDDEN`). "The one exception is `clear-backups`, whose targets are *only*
// inside it." `assertTargetsAllowed` enforces both halves: the six other actions must produce
// nothing inside it, and ACT-06 must produce nothing outside it.
//
// ⚠️ Every path is checked for containment in `claudeDir` as well. A target list is the input to
// a delete, and `..` in a payload must not be able to walk out of the root.

import { join, resolve } from 'node:path';
import type { ActionPreview, ActionType } from '../../shared/ipc-contract';
import { backupRoot, isSameOrInside, isUnderBackupRoot } from '../config/paths';
import { HandlerError } from '../ipc/errors';
import { CONFIG_BACKUP_SUFFIXES, STRAY_BACKUP_DIR_NAME } from '../harness/bloat-radar';
import { entryKind, sizeOnDisk, walkTree } from '../harness/tree';
import type { ArchivesRepository } from '../db/repositories/archives-repo';
import { specFor } from './catalogue';

/** One resolved target, in the shape §4.8's `ActionPreview` carries. */
export type ResolvedTarget = ActionPreview['targets'][number];

export interface ResolvedTargets {
  readonly targets: readonly ResolvedTarget[];
  /** §4.8 `ActionPreview.warnings` — e.g. "3 targets no longer exist and will be skipped". */
  readonly warnings: readonly string[];
  /** ACT-07 only: the sessions whose file sets these targets are. Empty otherwise. */
  readonly sessionIds: readonly string[];
}

export interface ResolveDeps {
  readonly claudeDir: string;
  readonly archives: ArchivesRepository;
}

// ---------------------------------------------------------------------------------------
// Payload shapes. §4.8 spells out only `ArchiveSessionsPayload`; the other six are derived
// from §5.7's `Targets` column and from the `action_payload` each §5.11 rule emits (§3.12).
// ---------------------------------------------------------------------------------------

function relPathList(payload: unknown, field = 'relPaths'): readonly string[] | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[field];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    out.push(entry);
  }
  return out;
}

function relPathField(payload: unknown, field: string): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'string' && value !== '' ? value : null;
}

function sessionIdsOf(payload: unknown): string[] {
  const value = relPathList(payload, 'sessionIds');
  if (value === null) {
    throw new HandlerError(
      'E_ACTION_TARGET_GONE',
      'Archiving needs an explicit list of sessions, and none was given.',
      { detail: 'ACT-07 payload must be { sessionIds: string[] } (§4.8 ArchiveSessionsPayload)' },
    );
  }
  // Deduplicated and sorted so preview and execute hash identically whatever order the UI sent.
  return [...new Set(value)].toSorted();
}

function basenameOf(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index < 0 ? relPath : relPath.slice(index + 1);
}

function directoryOf(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index < 0 ? '' : relPath.slice(0, index);
}

/**
 * A rel_path that resolves to something inside `claudeDir`, or `null`.
 *
 * ⚠️ The refusal is not cosmetic: `..` in a payload is the one way a renderer-supplied string
 * could point a delete at a path outside the root the user configured.
 */
function containedAbsolute(claudeDir: string, relPath: string): string | null {
  if (relPath === '' || relPath.startsWith('/')) return null;
  const absolute = resolve(join(claudeDir, relPath));
  return isSameOrInside(claudeDir, absolute) ? absolute : null;
}

/**
 * Describes one payload-named path, or `null` when it is simply not on disk.
 *
 * ⚠️ A path that would **escape** `claudeDir` is a different failure and gets a different code:
 * `E_ACTION_TARGET_FORBIDDEN`, thrown here rather than folded into "no longer there". `..` in a
 * renderer-supplied string is the one way a delete could be pointed outside the root the user
 * configured, and it must be refused as a boundary violation, not reported as an absence.
 */
async function describe(claudeDir: string, relPath: string): Promise<ResolvedTarget | null> {
  const absolute = containedAbsolute(claudeDir, relPath);
  if (absolute === null) {
    throw new HandlerError(
      'E_ACTION_TARGET_FORBIDDEN',
      'That target is outside your Claude data directory, so Claude Lens will not touch it.',
      { detail: `target escapes claudeDir: ${relPath}` },
    );
  }
  const kind = await entryKind(absolute);
  if (kind === null) return null;
  return { relPath, sizeBytes: await sizeOnDisk(absolute), kind };
}

const byRelPath = (left: ResolvedTarget, right: ResolvedTarget): number =>
  left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0;

// ---------------------------------------------------------------------------------------
// §5.7's seven rows.
// ---------------------------------------------------------------------------------------

/** ACT-01 — "directories under `skills/` with no `SKILL.md` and 0 B of content". */
async function orphanSkillFolders(claudeDir: string): Promise<ResolvedTarget[]> {
  const tree = await walkTree(claudeDir);
  const out: ResolvedTarget[] = [];
  for (const directory of tree.directories) {
    if (basenameOf(directoryOf(directory.relPath)) !== 'skills') continue;
    const contents = tree.files.filter((file) => file.relPath.startsWith(`${directory.relPath}/`));
    if (contents.some((file) => basenameOf(file.relPath) === 'SKILL.md')) continue;
    if (contents.reduce((total, file) => total + file.sizeBytes, 0) !== 0) continue;
    out.push({ relPath: directory.relPath, sizeBytes: 0, kind: 'directory' });
  }
  return out;
}

/** ACT-02 — "cached plugin/marketplace directories that are not enabled in `settings.json`". */
async function disabledPluginDirectories(claudeDir: string): Promise<ResolvedTarget[]> {
  // The scan already answers "which plugin directories are not enabled" (BR-04); re-deriving it
  // here would be a second implementation of the same rule.
  const { scanHarness } = await import('../harness/scan');
  const scan = await scanHarness(claudeDir);
  const out: ResolvedTarget[] = [];
  for (const node of scan.nodes) {
    if (node.kind !== 'plugin' || node.enabled !== false || node.relPath === null) continue;
    out.push({ relPath: node.relPath, sizeBytes: node.sizeBytes, kind: 'directory' });
  }
  return out;
}

/** ACT-03 — "`*.bak`, `*.plaud-bak`, and directories named `backups/` **outside** the backup root". */
async function strayConfigBackups(claudeDir: string): Promise<ResolvedTarget[]> {
  // `walkTree` excludes the backup root, which is where "outside the backup root" comes from.
  const tree = await walkTree(claudeDir);
  const directories = tree.directories.filter(
    (directory) => basenameOf(directory.relPath) === STRAY_BACKUP_DIR_NAME,
  );
  const files = tree.files.filter(
    (file) =>
      CONFIG_BACKUP_SUFFIXES.some((suffix) => file.relPath.endsWith(suffix)) &&
      // A `.bak` already inside a `backups/` directory is covered by that directory's target;
      // listing it twice would double-count the bytes in the confirm dialog.
      !directories.some((directory) => file.relPath.startsWith(`${directory.relPath}/`)),
  );
  const out: ResolvedTarget[] = files.map((file) => ({
    relPath: file.relPath,
    sizeBytes: file.sizeBytes,
    kind: 'file' as const,
  }));
  for (const directory of directories) {
    out.push({
      relPath: directory.relPath,
      sizeBytes: tree.files
        .filter((file) => file.relPath.startsWith(`${directory.relPath}/`))
        .reduce((total, file) => total + file.sizeBytes, 0),
      kind: 'directory',
    });
  }
  return out;
}

/** ACT-06 — "every restore point under the backup root". The one INV-14 exception. */
async function restorePoints(claudeDir: string): Promise<ResolvedTarget[]> {
  const root = backupRoot(claudeDir);
  if ((await entryKind(root)) !== 'directory') return [];
  // ⚠️ `excludeBackupRoot: false`, because the walk STARTS at the backup root. The exclusion is
  // relative to `claudeDir` and would otherwise be meaningless here.
  const tree = await walkTree(root, { excludeBackupRoot: false });
  const topLevel = tree.directories.filter((directory) => !directory.relPath.includes('/'));
  return Promise.all(
    topLevel.map(async (directory) => ({
      // Rel paths stay relative to `claudeDir` everywhere in this application (§3.1.4).
      relPath: `${backupRootRelName()}/${directory.relPath}`,
      sizeBytes: await sizeOnDisk(join(root, directory.relPath)),
      kind: 'directory' as const,
    })),
  );
}

function backupRootRelName(): string {
  // Derived from `paths.ts` rather than restated, so the constant has one home (§9.3).
  return backupRoot('/').slice(1);
}

/**
 * ACT-07 — "the transcript file **and the whole `subagents/` directory** of every named session".
 *
 * ⚠️⚠️ **INV-20 — session granularity, whole file set, always.** Both entries are emitted for
 * every session, together, and `execute` moves them as one unit. "A session's files are never
 * split across the two roots — that is what keeps the roll-up and the dedup story intact"
 * (§5.7 ACT-07 rule 1, ADR-034).
 */
async function sessionFileSets(
  deps: ResolveDeps,
  sessionIds: readonly string[],
): Promise<{ targets: ResolvedTarget[]; warnings: string[]; resolved: string[] }> {
  const targets: ResolvedTarget[] = [];
  const warnings: string[] = [];
  const resolved: string[] = [];

  for (const sessionId of sessionIds) {
    const fileSet = deps.archives.sessionFileSet(sessionId);
    if (fileSet === null) {
      throw new HandlerError(
        'E_ACTION_TARGET_GONE',
        'One of the sessions to archive is no longer in the database.',
        { detail: `unknown session: ${sessionId}` },
      );
    }
    if (fileSet.archiveId !== null) {
      // §5.7 ACT-07 preconditions — "every named session currently live".
      throw new HandlerError(
        'E_ACTION_TARGET_GONE',
        'One of the sessions to archive has already been archived.',
        { detail: `session ${sessionId} already carries archive_id ${String(fileSet.archiveId)}` },
      );
    }

    const transcript = await describe(deps.claudeDir, fileSet.files.transcriptRelPath);
    if (transcript === null) {
      throw new HandlerError(
        'E_ACTION_TARGET_GONE',
        'One of the sessions to archive has no transcript file on disk any more.',
        { detail: `missing transcript: ${fileSet.files.transcriptRelPath}` },
      );
    }
    targets.push(transcript);

    const subagents = await describe(deps.claudeDir, fileSet.files.subagentsRelDir);
    if (subagents !== null) {
      targets.push(subagents);
    } else {
      // Not a warning about data loss: a session with no subagent runs simply has no such
      // directory. Stated so the confirm dialog's target list is self-explaining.
      warnings.push(`${sessionId} has no subagents/ directory; only its transcript moves.`);
    }
    resolved.push(sessionId);
  }

  return { targets, warnings, resolved };
}

/**
 * Restricts a resolved set to the rel_paths a payload named, when it named any.
 *
 * ⚠️ Strictly narrowing, never widening: a payload can only ever pick from what the rule itself
 * resolved. That is what keeps ACT-01/02/03 from becoming "the generic `delete(paths[])` action"
 * ADR-032 rejected by name.
 */
function narrow(
  all: readonly ResolvedTarget[],
  payload: unknown,
): { targets: ResolvedTarget[]; warnings: string[] } {
  const requested = relPathList(payload);
  if (requested === null || requested.length === 0) return { targets: [...all], warnings: [] };
  const available = new Set(all.map((target) => target.relPath));
  const missing = requested.filter((relPath) => !available.has(relPath));
  const warnings =
    missing.length === 0
      ? []
      : [
          `${String(missing.length)} target${missing.length === 1 ? '' : 's'} no longer ` +
            'match this rule and will be skipped.',
        ];
  return {
    targets: all.filter((target) => requested.includes(target.relPath)),
    warnings,
  };
}

/** §5.7's seven rows, dispatched. Deterministic and sorted, so INV-06's hash is stable. */
export async function resolveTargets(
  deps: ResolveDeps,
  actionType: ActionType,
  payload: unknown,
): Promise<ResolvedTargets> {
  const { claudeDir } = deps;

  switch (actionType) {
    case 'delete-orphan-skill-folders': {
      const narrowed = narrow(await orphanSkillFolders(claudeDir), payload);
      return {
        targets: narrowed.targets.toSorted(byRelPath),
        warnings: narrowed.warnings,
        sessionIds: [],
      };
    }
    case 'clear-plugin-cache': {
      const narrowed = narrow(await disabledPluginDirectories(claudeDir), payload);
      return {
        targets: narrowed.targets.toSorted(byRelPath),
        warnings: narrowed.warnings,
        sessionIds: [],
      };
    }
    case 'delete-duplicate-config-backups': {
      const narrowed = narrow(await strayConfigBackups(claudeDir), payload);
      return {
        targets: narrowed.targets.toSorted(byRelPath),
        warnings: narrowed.warnings,
        sessionIds: [],
      };
    }
    case 'restore-claude-md': {
      const relPath = relPathField(payload, 'relPath');
      const backupRelPath = relPathField(payload, 'backupRelPath');
      if (relPath === null || backupRelPath === null) {
        throw new HandlerError(
          'E_ACTION_TARGET_GONE',
          'Restoring a CLAUDE.md needs both the file and the backup to restore from.',
          { detail: 'ACT-04 payload must be { relPath, backupRelPath }' },
        );
      }
      const target = await describe(claudeDir, relPath);
      const source = await describe(claudeDir, backupRelPath);
      if (target === null || source === null || target.kind !== 'file' || source.kind !== 'file') {
        throw new HandlerError(
          'E_ACTION_TARGET_GONE',
          'That CLAUDE.md or its backup is no longer where the scan found it.',
          { detail: `ACT-04: ${relPath} ← ${backupRelPath}` },
        );
      }
      // ⚠️ The BACKUP is part of the bound list even though it is not deleted: the user is
      // approving "overwrite this with that", and the size of `that` is half the decision (§6.9).
      return { targets: [target, source].toSorted(byRelPath), warnings: [], sessionIds: [] };
    }
    case 'delete-empty-claude-md': {
      const relPath = relPathField(payload, 'relPath');
      if (relPath === null) {
        throw new HandlerError('E_ACTION_TARGET_GONE', 'No CLAUDE.md was named.', {
          detail: 'ACT-05 payload must be { relPath }',
        });
      }
      const target = await describe(claudeDir, relPath);
      if (target === null || target.kind !== 'file') {
        throw new HandlerError('E_ACTION_TARGET_GONE', 'That CLAUDE.md is no longer there.', {
          detail: `ACT-05: ${relPath}`,
        });
      }
      if (target.sizeBytes !== 0) {
        // §5.7 ACT-05 — "one **0-byte** CLAUDE.md". A file that has since gained content is not
        // this action's target, and deleting it would destroy exactly what BR-01 exists to save.
        throw new HandlerError(
          'E_ACTION_TARGET_GONE',
          'That CLAUDE.md is no longer empty, so it is not this action’s target any more.',
          { detail: `ACT-05: ${relPath} is ${String(target.sizeBytes)} bytes` },
        );
      }
      return { targets: [target], warnings: [], sessionIds: [] };
    }
    case 'clear-backups': {
      const targets = await restorePoints(claudeDir);
      return { targets: targets.toSorted(byRelPath), warnings: [], sessionIds: [] };
    }
    case 'archive-sessions': {
      const sessionIds = sessionIdsOf(payload);
      if (sessionIds.length === 0) {
        throw new HandlerError('E_ACTION_TARGET_GONE', 'No sessions were named to archive.', {
          detail: 'ACT-07 payload carried an empty sessionIds list',
        });
      }
      const found = await sessionFileSets(deps, sessionIds);
      return {
        targets: found.targets.toSorted(byRelPath),
        warnings: found.warnings,
        sessionIds: found.resolved,
      };
    }
  }
}

/**
 * §5.5 rule 7 / INV-14, both directions.
 *
 * ⚠️ This is the last line between "Bloat Radar found a stale directory" and "the app deleted its
 * own restore points". It runs at preview AND at execute — the second call is the one that
 * matters, because the filesystem can change in between.
 */
export function assertTargetsAllowed(
  actionType: ActionType,
  claudeDir: string,
  targets: readonly ResolvedTarget[],
): void {
  const spec = specFor(actionType);
  for (const target of targets) {
    const absolute = containedAbsolute(claudeDir, target.relPath);
    if (absolute === null) {
      throw new HandlerError(
        'E_ACTION_TARGET_FORBIDDEN',
        'That target is outside your Claude data directory, so Claude Lens will not touch it.',
        { detail: `target escapes claudeDir: ${target.relPath}` },
      );
    }
    const inside = isUnderBackupRoot(claudeDir, absolute);
    if (inside && !spec.targetsAreTheBackupRoot) {
      throw new HandlerError(
        'E_ACTION_TARGET_FORBIDDEN',
        "That target is inside Claude Lens's own restore-point folder, which only " +
          '“Clear backups” may touch.',
        { detail: `${spec.id} target inside the backup root: ${target.relPath} (INV-14)` },
      );
    }
    if (!inside && spec.targetsAreTheBackupRoot) {
      throw new HandlerError(
        'E_ACTION_TARGET_FORBIDDEN',
        'Clearing backups may only remove restore points, and that target is not one.',
        { detail: `ACT-06 target outside the backup root: ${target.relPath} (INV-14)` },
      );
    }
  }
}

export interface TypedConfirm {
  readonly required: boolean;
  readonly phrase: string | null;
}

/**
 * §5.5 rule 3, transcribed: "**Typed confirmation** is required when any target is
 * `settings.json`, any `CLAUDE.md`, anything under `projects/`, or when the action is
 * `clear-backups`. The user types the exact `typedConfirmPhrase` (the basename, or
 * `clear backups`)."
 *
 * ACT-07's phrase is `archive N sessions` (§5.7's table), which is the one case where the phrase
 * is neither a basename nor the literal `clear backups`.
 *
 * ⚠️ When several targets trigger the rule, the phrase is the basename of the FIRST in sorted
 * order. §5.5 says "the basename" and the multi-target case is not spelled out; a deterministic
 * choice is required because the renderer must be able to display exactly what to type. The list
 * is already sorted, so preview and the dialog cannot disagree.
 */
export function typedConfirmFor(
  actionType: ActionType,
  targets: readonly ResolvedTarget[],
  sessionCount: number,
): TypedConfirm {
  if (actionType === 'clear-backups') return { required: true, phrase: 'clear backups' };
  if (actionType === 'archive-sessions') {
    return { required: true, phrase: `archive ${String(sessionCount)} sessions` };
  }

  const sensitive = targets.find(
    (target) =>
      basenameOf(target.relPath) === 'settings.json' ||
      basenameOf(target.relPath) === 'settings.local.json' ||
      basenameOf(target.relPath) === 'CLAUDE.md' ||
      basenameOf(target.relPath) === 'CLAUDE.local.md' ||
      target.relPath === 'projects' ||
      target.relPath.startsWith('projects/'),
  );
  if (sensitive !== undefined) {
    return { required: true, phrase: basenameOf(sensitive.relPath) };
  }
  // The catalogue row can still demand it even when no target does (ACT-04/05, §5.7).
  if (specFor(actionType).alwaysTypedConfirm) {
    const first = targets[0];
    return { required: true, phrase: first === undefined ? null : basenameOf(first.relPath) };
  }
  return { required: false, phrase: null };
}
