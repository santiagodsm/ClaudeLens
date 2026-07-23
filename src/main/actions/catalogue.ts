// The guarded-action catalogue — DESIGN §5.7, ADR-032 (as amended by ADR-034).
//
// ⚠️⚠️ **THE CATALOGUE IS CLOSED.** "An action type not in this table **cannot be executed**: the
// dispatcher rejects it with `E_ACTION_UNKNOWN`. Adding one is a design change, not an
// implementation detail" (§5.7). ADR-032's reasoning, because it is the reason this file is a
// table and not an `if`: "An open-ended action interface means the next agent can add a
// destructive operation without a design review; a closed catalogue makes every addition
// visible."
//
// The catalogue stands at **seven** entries. ADR-034 added ACT-07 `archive-sessions` — the first
// and only *move-class* entry — through a design decision and an ADR, "which is this ADR working,
// not failing".
//
// | Id | ActionType | Targets | Backs up | Typed confirm | Source flag |
// |----|-----------|---------|----------|---------------|-------------|
// | ACT-01 | delete-orphan-skill-folders | directories under skills/ with no SKILL.md and 0 B | the whole directory | no | BR-02 |
// | ACT-02 | clear-plugin-cache | cached plugin/marketplace dirs not enabled in settings.json | the whole directory | no | BR-04 |
// | ACT-03 | delete-duplicate-config-backups | *.bak, *.plaud-bak, backups/ OUTSIDE the backup root | each file | no | BR-06 |
// | ACT-04 | restore-claude-md | one CLAUDE.md, overwritten by one selected sibling backup | the current CLAUDE.md | yes (basename) | BR-01 |
// | ACT-05 | delete-empty-claude-md | one 0-byte CLAUDE.md | the file (0 B, still recorded) | yes (basename) | BR-01 |
// | ACT-06 | clear-backups | every restore point under the backup root | nothing — this IS the backups | yes ("clear backups") | Settings §6.10 |
// | ACT-07 | archive-sessions | transcript + whole subagents/ dir of every named session | move manifest, not copies | yes ("archive N sessions") | BR-05 |

import type { ActionType } from '../../shared/ipc-contract';

/** §5.7's `Id` column, carried so a message can cite the row rather than paraphrase it. */
export type ActionId = 'ACT-01' | 'ACT-02' | 'ACT-03' | 'ACT-04' | 'ACT-05' | 'ACT-06' | 'ACT-07';

/**
 * How an action changes the filesystem, and therefore what its restore point contains.
 *
 * ⚠️ `move` exists for ACT-07 alone (ADR-034). A move destroys nothing — the bytes are at the
 * destination the instant the operation completes — so INV-07 is met in substance by a verified
 * `move-manifest.json` rather than by file copies. Copying the bytes as well "would permanently
 * consume, in a restore point that is **never pruned**, exactly the disk the user was trying to
 * free — an action that makes the problem worse the more you use it."
 */
export type ActionClass = 'delete' | 'overwrite' | 'move';

export interface ActionSpec {
  readonly id: ActionId;
  readonly actionType: ActionType;
  readonly actionClass: ActionClass;
  /**
   * INV-14 / §5.5 rule 7 — "No target may resolve inside the backup root
   * (`E_ACTION_TARGET_FORBIDDEN`). The one exception is `clear-backups`, whose targets are
   * *only* inside it."
   */
  readonly targetsAreTheBackupRoot: boolean;
  /** §5.5 rule 3 — this action always needs a typed phrase, whatever its targets are. */
  readonly alwaysTypedConfirm: boolean;
  /** Human summary for `audit_log.target_summary` (§3.14). */
  readonly summarize: (count: number) => string;
}

/**
 * ⛔ The closed set. Keyed by `ActionType` and typed as a total `Record`, so adding a member to
 * `ActionType` without adding its row here is a **compile error** — which is what makes "the
 * catalogue is closed" a property of the build rather than of anyone's memory.
 */
export const ACTION_CATALOGUE: Readonly<Record<ActionType, ActionSpec>> = {
  'delete-orphan-skill-folders': {
    id: 'ACT-01',
    actionType: 'delete-orphan-skill-folders',
    actionClass: 'delete',
    targetsAreTheBackupRoot: false,
    alwaysTypedConfirm: false,
    summarize: (count) => `${String(count)} orphaned skill folder${count === 1 ? '' : 's'}`,
  },
  'clear-plugin-cache': {
    id: 'ACT-02',
    actionType: 'clear-plugin-cache',
    actionClass: 'delete',
    targetsAreTheBackupRoot: false,
    alwaysTypedConfirm: false,
    summarize: (count) => `${String(count)} cached plugin director${count === 1 ? 'y' : 'ies'}`,
  },
  'delete-duplicate-config-backups': {
    id: 'ACT-03',
    actionType: 'delete-duplicate-config-backups',
    actionClass: 'delete',
    targetsAreTheBackupRoot: false,
    alwaysTypedConfirm: false,
    summarize: (count) => `${String(count)} duplicate config backup${count === 1 ? '' : 's'}`,
  },
  'restore-claude-md': {
    id: 'ACT-04',
    actionType: 'restore-claude-md',
    actionClass: 'overwrite',
    targetsAreTheBackupRoot: false,
    // §5.5 rule 3 — a CLAUDE.md always requires the typed phrase; this is belt and braces with
    // the target-derived rule below, so the row cannot be weakened by a target-list change.
    alwaysTypedConfirm: true,
    summarize: () => 'one CLAUDE.md restored from its sibling backup',
  },
  'delete-empty-claude-md': {
    id: 'ACT-05',
    actionType: 'delete-empty-claude-md',
    actionClass: 'delete',
    targetsAreTheBackupRoot: false,
    alwaysTypedConfirm: true,
    summarize: () => 'one empty CLAUDE.md',
  },
  'clear-backups': {
    id: 'ACT-06',
    actionType: 'clear-backups',
    actionClass: 'delete',
    // ⚠️ The single exception to INV-14, and the reason it is safe: this root is the app's own
    // creation (ADR-034 contrasts it with the archive root, which is the user's data).
    targetsAreTheBackupRoot: true,
    alwaysTypedConfirm: true,
    summarize: (count) => `${String(count)} restore point${count === 1 ? '' : 's'}`,
  },
  'archive-sessions': {
    id: 'ACT-07',
    actionType: 'archive-sessions',
    actionClass: 'move',
    targetsAreTheBackupRoot: false,
    alwaysTypedConfirm: true,
    summarize: (count) => `${String(count)} session file set${count === 1 ? '' : 's'} archived`,
  },
};

/** Every `ActionType` in the catalogue, in `ACT-nn` order. */
export const ACTION_TYPES: readonly ActionType[] = Object.values(ACTION_CATALOGUE)
  .toSorted((left, right) => (left.id < right.id ? -1 : 1))
  .map((spec) => spec.actionType);

/**
 * ADR-032's dispatcher rule, as a type guard.
 *
 * ⚠️ The renderer's `actionType` arrives as `unknown` over IPC — the channel is typed, but a
 * type is not a runtime check. This is the runtime check, and `E_ACTION_UNKNOWN` is what an
 * unrecognised value gets.
 */
export function isKnownActionType(value: unknown): value is ActionType {
  return typeof value === 'string' && Object.hasOwn(ACTION_CATALOGUE, value);
}

export function specFor(actionType: ActionType): ActionSpec {
  return ACTION_CATALOGUE[actionType];
}
