// Bloat Radar — DESIGN §5.11, the CLOSED rule set BR-01…BR-06, and §3.12's `bloat_flags`.
//
// Each rule produces `what · where · size · why · recommended action`.
//
// ⚠️⚠️ **Every rule's file walk excludes the backup root** (INV-14, §5.11's own warning: "without
// this the app flags its own safety net"). It is excluded exactly once, in `walkTree`, which is
// the only walk any rule here sees — the rules are pure functions over that walk's output and
// have no filesystem access of their own. `BloatFlagsRepository.replaceAll` asserts it a second
// time before inserting, because a flag on a restore point would carry a delete button.
//
// ⚠️ **BR-03 is deliberately actionless.** §5.11: "deleting a skill because it shows zero
// invocations is exactly the kind of irreversible act this app must not make easy, and the
// 'never used' claim is only as good as the transcript window. It is surfaced, sized and
// explained; the user acts outside the app." `actionType: null` renders as a card with no button
// and the muted label "no automatic action in v1" (§3.12, §6.9, §11.2).
//
// ⚠️ **BR-03's counts are ALL TIME** (INV-13). They arrive from `HarnessManagerRepository.skills()`,
// whose signature takes no `GlobalFilter` — a skill deleted because it looked unused *this month*
// is the mistake INV-13 exists to prevent.

import type { BloatFlagInput } from '../db/repositories/bloat-flags';
import type { HarnessScan } from './scan';

/**
 * §5.11 BR-05 — "total bytes of `projects/**` above a **reported**, not enforced, threshold".
 *
 * ⚠️ **DESIGN names no number.** 500 MB is E10's stated value, reported as an unspecified
 * constant. It is deliberately a *reporting* threshold: crossing it produces an informational,
 * `low`-severity flag whose action is a confirmed, typed, fully undoable archive that deletes
 * nothing (ACT-07, ADR-034). Nothing is enforced, capped or pruned at any size (§1.6 non-goal 4).
 */
export const BR05_REPORTED_THRESHOLD_BYTES = 500 * 1024 * 1024;

/** §5.11 BR-01/BR-06 — the two backup suffixes both rules name, in one place. */
export const CONFIG_BACKUP_SUFFIXES: readonly string[] = ['.bak', '.plaud-bak'];

/** §5.11 BR-06 — "directories named `backups/`", outside the app's own backup root. */
export const STRAY_BACKUP_DIR_NAME = 'backups';

/** §5.11 BR-03 — one installed skill and its ALL-TIME invocation count (INV-13). */
export interface SkillUsage {
  readonly name: string;
  readonly relPath: string;
  readonly sizeBytes: number;
  /** ⛔ ALL TIME. Never filtered (INV-13). */
  readonly invocations: number;
}

/** §5.11 BR-05 — what the transcript corpus looks like, from the database, all time. */
export interface TranscriptCorpus {
  readonly sessionCount: number;
  readonly rangeFromTs: number | null;
  readonly rangeToTs: number | null;
}

export interface BloatInput {
  readonly scan: HarnessScan;
  readonly skills: readonly SkillUsage[];
  readonly corpus: TranscriptCorpus;
  /** Injected so the threshold is testable without writing 500 MB into a sandbox. */
  readonly transcriptThresholdBytes?: number;
}

function basenameOf(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index < 0 ? relPath : relPath.slice(index + 1);
}

function directoryOf(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index < 0 ? '' : relPath.slice(0, index);
}

function isConfigBackup(relPath: string): boolean {
  return CONFIG_BACKUP_SUFFIXES.some((suffix) => relPath.endsWith(suffix));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'KB'}`;
}

function isoDay(ts: number | null): string {
  return ts === null ? 'unknown' : new Date(ts).toISOString().slice(0, 10);
}

/**
 * Runs the closed rule set over one scan.
 *
 * Pure: a walk result and two database summaries in, flags out. No filesystem, no clock, no
 * database — so every rule can be tested exhaustively against a hand-built tree, which is the
 * only way to know that the backup-root exclusion is really there.
 */
export function detectBloat(input: BloatInput): BloatFlagInput[] {
  const flags: BloatFlagInput[] = [];
  const { scan } = input;
  const sizeByRelPath = new Map(scan.files.map((file) => [file.relPath, file.sizeBytes]));

  // ---- BR-01 — empty CLAUDE.md while a sibling backup has content ------------------------
  for (const file of scan.files) {
    const base = basenameOf(file.relPath);
    if (base !== 'CLAUDE.md' && base !== 'CLAUDE.local.md') continue;
    if (file.sizeBytes !== 0) continue;
    const dir = directoryOf(file.relPath);
    const siblings = scan.files.filter(
      (candidate) =>
        directoryOf(candidate.relPath) === dir &&
        isConfigBackup(candidate.relPath) &&
        candidate.sizeBytes > 0,
    );
    if (siblings.length === 0) continue;
    const best = siblings.reduce((largest, candidate) =>
      candidate.sizeBytes > largest.sizeBytes ? candidate : largest,
    );
    flags.push({
      ruleId: 'BR-01',
      severity: 'high',
      title: 'Empty CLAUDE.md with a non-empty backup beside it',
      location: file.relPath,
      // The reclaimable figure is the backup's size — restoring it is what recovers the content.
      sizeBytes: best.sizeBytes,
      itemCount: siblings.length,
      rationale:
        `${file.relPath} is 0 bytes, while ${best.relPath} beside it holds ` +
        `${formatBytes(best.sizeBytes)}. Restoring the backup copies that file over the empty ` +
        'one; nothing is authored and nothing else is touched. If the empty file is the ' +
        'intended state, deleting it (ACT-05) is the other confirmed option.',
      // ⚠️ §5.11 offers "ACT-04 or ACT-05" for this rule but §3.12 carries ONE `action_type` per
      // flag. ACT-04 (restore) is the non-destructive of the two and is chosen for the button;
      // the destructive alternative is named in the rationale rather than wired to a click.
      actionType: 'restore-claude-md',
      actionPayload: { relPath: file.relPath, backupRelPath: best.relPath },
    });
  }

  // ---- BR-02 — orphaned skill folders ------------------------------------------------------
  for (const directory of scan.directories) {
    if (directoryOf(directory.relPath) === '') continue;
    if (basenameOf(directoryOf(directory.relPath)) !== 'skills') continue;
    const contents = scan.files.filter((file) => file.relPath.startsWith(`${directory.relPath}/`));
    const hasSkillFile = contents.some((file) => basenameOf(file.relPath) === 'SKILL.md');
    const bytes = contents.reduce((total, file) => total + file.sizeBytes, 0);
    // §5.7 ACT-01 / §5.11 BR-02, verbatim: "no `SKILL.md` **and** 0 B of file content".
    if (hasSkillFile || bytes !== 0) continue;
    flags.push({
      ruleId: 'BR-02',
      severity: 'high',
      title: 'Orphaned skill folder',
      location: directory.relPath,
      sizeBytes: 0,
      itemCount: 1,
      rationale:
        `${directory.relPath} sits under a skills/ directory but contains no SKILL.md and ` +
        `${String(contents.length)} file(s) totalling 0 bytes, so nothing can load from it.`,
      actionType: 'delete-orphan-skill-folders',
      actionPayload: { relPaths: [directory.relPath] },
    });
  }

  // ---- BR-03 — installed skill never invoked (ALL TIME, INV-13) — NO ACTION ---------------
  for (const skill of input.skills) {
    if (skill.invocations !== 0) continue;
    flags.push({
      ruleId: 'BR-03',
      severity: 'medium',
      title: `Skill never invoked: ${skill.name}`,
      location: skill.relPath,
      sizeBytes: skill.sizeBytes,
      itemCount: 1,
      rationale:
        `${skill.name} has 0 recorded invocations across the whole dataset — all time, not the ` +
        'current filter (INV-13). That claim is only as good as the transcripts on disk, so ' +
        'Claude Lens offers no button here: deleting a skill on this evidence is exactly the ' +
        'irreversible act it must not make easy (§5.11). Remove it yourself if you agree.',
      // ⚠️ NULL by design (§5.11, §11.2). Do not "complete the pattern" by wiring an action.
      actionType: null,
      actionPayload: null,
    });
  }

  // ---- BR-04 — plugin cached but not enabled ----------------------------------------------
  for (const node of scan.nodes) {
    if (node.kind !== 'plugin' || node.enabled !== false || node.relPath === null) continue;
    flags.push({
      ruleId: 'BR-04',
      severity: 'medium',
      title: `Plugin cached but not enabled: ${node.name}`,
      location: node.relPath,
      sizeBytes: node.sizeBytes,
      itemCount: 1,
      rationale:
        `${node.name} is present under ${node.relPath} (${formatBytes(node.sizeBytes)}) but is ` +
        'not listed in settings.json enabledPlugins, so it is cached disk and nothing else.',
      actionType: 'clear-plugin-cache',
      actionPayload: { relPaths: [node.relPath] },
    });
  }

  // ---- BR-05 — oversized transcript storage ------------------------------------------------
  const transcriptFiles = scan.files.filter(
    (file) => file.relPath.startsWith('projects/') && file.relPath.endsWith('.jsonl'),
  );
  const transcriptBytes = transcriptFiles.reduce((total, file) => total + file.sizeBytes, 0);
  const threshold = input.transcriptThresholdBytes ?? BR05_REPORTED_THRESHOLD_BYTES;
  if (transcriptBytes > threshold) {
    flags.push({
      ruleId: 'BR-05',
      severity: 'low',
      title: 'Transcript storage is large',
      location: 'projects/**/*.jsonl',
      sizeBytes: transcriptBytes,
      itemCount: transcriptFiles.length,
      rationale:
        `${formatBytes(transcriptBytes)} across ${String(transcriptFiles.length)} transcript ` +
        `files in ${String(input.corpus.sessionCount)} sessions, ` +
        `${isoDay(input.corpus.rangeFromTs)} to ${isoDay(input.corpus.rangeToTs)}. This is ` +
        'reported, not enforced: nothing is capped, pruned or deleted at any size. Archiving ' +
        'moves the transcripts to a folder you choose and every chart keeps counting them.',
      // ⚠️ ACT-07's payload is an explicit session list and this rule cannot know it: §6.9's
      // Archive… button opens a chooser that calls `archives:candidates` first, and the user
      // sees every resolved session before `action:preview` mints a token (§4.8).
      actionType: 'archive-sessions',
      actionPayload: null,
    });
  }

  // ---- BR-06 — duplicate/backup config files piling up -------------------------------------
  const strayBackupFiles = scan.files.filter((file) => isConfigBackup(file.relPath));
  const strayBackupDirs = scan.directories.filter(
    (directory) => basenameOf(directory.relPath) === STRAY_BACKUP_DIR_NAME,
  );
  const strayDirBytes = strayBackupDirs.reduce(
    (total, directory) =>
      total +
      scan.files
        .filter((file) => file.relPath.startsWith(`${directory.relPath}/`))
        .reduce((sum, file) => sum + file.sizeBytes, 0),
    0,
  );
  const strayBytes =
    strayBackupFiles.reduce((total, file) => total + (sizeByRelPath.get(file.relPath) ?? 0), 0) +
    strayDirBytes;
  const strayCount = strayBackupFiles.length + strayBackupDirs.length;
  if (strayCount > 0) {
    flags.push({
      ruleId: 'BR-06',
      severity: 'low',
      title: 'Duplicate and backup config files',
      location: '*.bak, *.plaud-bak, backups/',
      sizeBytes: strayBytes,
      itemCount: strayCount,
      rationale:
        `${String(strayCount)} stray backup file(s) and folder(s) totalling ` +
        `${formatBytes(strayBytes)}, all outside Claude Lens's own restore-point folder — the ` +
        'app never flags or touches its own backups (INV-14). These are copies something else ' +
        'left behind.',
      actionType: 'delete-duplicate-config-backups',
      actionPayload: {
        relPaths: [
          ...strayBackupFiles.map((file) => file.relPath),
          ...strayBackupDirs.map((directory) => directory.relPath),
        ].toSorted(),
      },
    });
  }

  return flags;
}
