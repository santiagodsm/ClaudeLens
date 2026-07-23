// Project-level harness — DESIGN §2.1 "Harness" (as amended by ADR-039), §3.10, §6.7.
//
// ⚠️⚠️ **WHY THIS FILE EXISTS.** §2.1 defined the harness as the `~/.claude` surface, so the
// scanner walked only the Claude data directory. On a machine whose `skills/`, `agents/` and
// `commands/` are all empty at that level — and whose skills and agents all live in project-level
// `<project>/.claude/` directories — §3.10 produced zero nodes and §6.7's Harness Map rendered
// empty. That was a scope gap, not a defect. The user asked for the missing half in these words:
//
//   "there may not be a harness at this level but the projects have a harness. the intent was to
//    see in the projects how one orchestrator agent calls skills, calls subagents, agents, and
//    those call tools, etc."
//
// ⚠️⚠️ **STRICTLY READ-ONLY, AND OUTSIDE THE GUARDED-ACTION CATALOGUE.** Nothing under a project
// directory is ever written, moved, renamed or deleted by this application. This module opens
// files for reading and stats them; it imports nothing that mutates. ACT-01…07 (§5.7, ADR-032)
// operate only within the Claude data directory and ADR-039 does not widen their reach by one
// path. Every node produced here carries a non-null `projectId`, which is the marker every
// consumer filters on: excluded from `q:skills` / `q:memories` / `q:plugins`, from Bloat Radar,
// from `file_manifest`, from analytics and from the watcher — the same exclusion the backup root
// gets (INV-14).
//
// ⚠️ **Parsed harness text is data, never instructions** (§3.10, §7.8, STACK ADR-017). These are
// files full of agent prompts. They are rendered and counted; never executed, never interpolated
// into anything executable, never sent anywhere. There is one network egress point in this
// application and it is not reachable from here (INV-15).
//
// ⚠️ INV-17 — every root is a parameter. Nothing here calls `os.homedir()` or reads a setting.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessEdgeInput, HarnessNodeInput } from '../db/repositories/harness-graph';
import { harnessNodeKey } from '../db/repositories/harness-graph';
import { isSameOrInside } from '../config/paths';
import { deriveHandoffEdges, type HandoffCandidate } from './edges';
import { parseHarnessFile } from './frontmatter';
import { entryKind, sizeOnDisk, walkTree } from './tree';

/** The directory a project keeps its harness in, relative to the project root. */
export const PROJECT_HARNESS_DIR = '.claude';

/** The project's own top-level memory file — the main loop's instructions (§2.1 "Harness"). */
export const PROJECT_CLAUDE_MD = 'CLAUDE.md';

/** Why one project's harness was not read. Every value is a **disclosure**, never a log line. */
export type ProjectSkipReason =
  /** The encoded name does not decode to exactly one absolute path. */
  | 'ambiguous-encoding'
  /** It decodes to exactly one path, and that path is not a directory on this machine. */
  | 'directory-absent'
  /** The directory exists but holds neither `.claude/` nor a root `CLAUDE.md`. */
  | 'no-harness'
  /** It resolves to the Claude data directory itself, or to a parent of it. */
  | 'overlaps-claude-dir';

export interface ResolvedProject {
  readonly projectId: number;
  readonly encodedName: string;
  /**
   * The absolute project directory. ⚠️ Read from, never written to, and it never leaves the main
   * process: nothing puts it on an IPC payload, in a log line or in a file (§3.5, §7.8).
   */
  readonly projectDir: string;
  /**
   * How the directory was established. `cwd` is the exact route — a recorded `events.cwd` whose
   * re-encoding reproduces this project's `encoded_name`. `decoded` is the lossy fallback, used
   * only when no recorded `cwd` matches.
   */
  readonly via: 'cwd' | 'decoded';
}

export interface SkippedProject {
  readonly encodedName: string;
  readonly reason: ProjectSkipReason;
}

export interface ProjectResolution {
  readonly resolved: readonly ResolvedProject[];
  readonly skipped: readonly SkippedProject[];
}

/**
 * §3.3's `encoded_name` → **exactly one** candidate absolute path, or `null`.
 *
 * ⚠️⚠️ **This is the crux of ADR-039, and it must not be a guess.** `projects/<encoded-path>/`
 * encodes the real project directory by replacing `/` with `-`. That encoding is **lossy**: a
 * directory whose own name contains `-` (or `.`) encodes to a name that decodes to a different
 * path. `-work-demo-Photo-Booth` decodes to `/work/demo/Photo/Booth`,
 * which is not where `Photo-Booth` lives.
 *
 * ⚠️ **Exactly one candidate is produced, and no other is ever tried.** Reading the path the data
 * itself encodes is not inference; enumerating the 2^n re-segmentations of a hyphenated name and
 * stat-ing each until one exists would be — and §2.1's Project entry is emphatic: *"Zero
 * inference: no on-disk probing, no symlink resolution, no worktree merging, no repo-root
 * detection."* When the single decode does not land, the project is skipped and disclosed. A
 * silently wrong project harness — one repository's skills drawn under another's name — is
 * exactly the class of silently-wrong output CLAUDE.md §1 rates as the worst outcome.
 *
 * `null` means the decode is ambiguous on its face:
 *   · it does not start with `-`, so it names no absolute path;
 *   · it contains `--`, which decodes to an empty path segment. `-work-demo--claude` is the
 *     encoding of `/work/demo/.claude`, but it decodes to `/work/demo//claude`, and
 *     `/work/demo/claude` may be a real and completely unrelated directory. Two readings, no way
 *     to choose: skip.
 */
export function decodeEncodedProjectPath(encodedName: string): string | null {
  if (!encodedName.startsWith('-')) return null;
  const decoded = encodedName.replaceAll('-', '/');
  // Every segment between the leading `/` and the end must be non-empty.
  const segments = decoded.slice(1).split('/');
  if (segments.length === 0 || segments.some((segment) => segment === '')) return null;
  return decoded;
}

/**
 * §3.3's encoding, in the **forward** direction: every character outside `[A-Za-z0-9]` becomes
 * `-`. Unlike the decode above, this direction is exact — which is the whole point.
 *
 * ⚠️ It is used only to CHECK a candidate, never to produce one:
 * `encodedProjectNameFor(cwd) === project.encoded_name` is an equality between two recorded
 * values, so a `cwd` that satisfies it *is* the directory this project's transcripts were written
 * from. No path is constructed, guessed or searched for. That is what lets ADR-039 resolve the
 * hyphenated names the decode cannot: `/…/demo/Photo-Booth` encodes to
 * `-…-demo-Photo-Booth` and matches, where decoding that same name yields `…/Photo/Booth`.
 *
 * ⚠️ Deliberately a **local** definition rather than an import of `encodeProjectPath`
 * (`src/main/parse/source-file.ts`). That function replaces only `/`, because §3.9's job is to
 * match `prompts.raw_project` against a project row; this one has to reproduce the directory name
 * Claude Code actually writes, which also folds `.` and every other non-alphanumeric character.
 * They are two different questions and merging them would break one of them silently.
 */
export function encodedProjectNameFor(absolutePath: string): string {
  return absolutePath.replaceAll(/[^A-Za-z0-9]/g, '-');
}

/**
 * Which of the known projects have a readable harness on this machine, and which do not.
 *
 * ⚠️ **Exactly one candidate path per project**, established by one of two routes and never by a
 * search:
 *
 *   1. a recorded `events.cwd` whose re-encoding equals this project's `encoded_name`
 *      (`encodedProjectNameFor`) — exact, because both sides are stored values;
 *   2. failing that, `decodeEncodedProjectPath` — the lossy inverse, which lands only when no
 *      segment of the real path contained a hyphen or a dot.
 *
 * ⚠️ One `lstat` on that candidate, plus one on its `.claude` and one on its `CLAUDE.md`. Nothing
 * is enumerated, globbed or searched for.
 *
 * ⚠️ A project that resolves **into or around the Claude data directory** is skipped. `~/.claude`
 * is itself a project on a machine where the user has run Claude Code from their home directory,
 * and reading `<home>/.claude` as "a project's harness" would scan the configured root a second
 * time under a project id — double-counting every node and dragging the backup root in behind it
 * (INV-14).
 */
export async function resolveProjectHarnessDirs(
  claudeDir: string,
  projects: readonly {
    readonly id: number;
    readonly encodedName: string;
    /** Distinct `events.cwd` values recorded for this project (§3.5). May be empty. */
    readonly cwds?: readonly string[];
  }[],
): Promise<ProjectResolution> {
  const resolved: ResolvedProject[] = [];
  const skipped: SkippedProject[] = [];

  for (const project of projects) {
    // ⚠️ The exact route first. A recorded `cwd` whose re-encoding reproduces this project's
    // `encoded_name` IS the directory its transcripts were written from — an equality between two
    // stored columns, with nothing constructed and nothing searched for. It resolves the
    // hyphenated names the decode below cannot: on the reporting user's machine it lifts the
    // resolvable set from 5 of 13 to 11 of 13.
    const matches = [
      ...new Set(
        (project.cwds ?? []).filter(
          (cwd) => cwd.startsWith('/') && encodedProjectNameFor(cwd) === project.encodedName,
        ),
      ),
    ];
    // ⚠️ Two distinct directories can encode to the same name (`/a/b-c` and `/a/b/c`). When both
    // are recorded there is no way to choose, and choosing anyway would draw one repository's
    // harness under another's name. Skip, and count it.
    if (matches.length > 1) {
      skipped.push({ encodedName: project.encodedName, reason: 'ambiguous-encoding' });
      continue;
    }
    const via: 'cwd' | 'decoded' = matches.length === 1 ? 'cwd' : 'decoded';
    const candidate = matches[0] ?? decodeEncodedProjectPath(project.encodedName);
    if (candidate === null) {
      skipped.push({ encodedName: project.encodedName, reason: 'ambiguous-encoding' });
      continue;
    }
    if (isSameOrInside(claudeDir, candidate) || isSameOrInside(candidate, claudeDir)) {
      skipped.push({ encodedName: project.encodedName, reason: 'overlaps-claude-dir' });
      continue;
    }
    if ((await entryKind(candidate)) !== 'directory') {
      skipped.push({ encodedName: project.encodedName, reason: 'directory-absent' });
      continue;
    }
    const hasHarnessDir = (await entryKind(join(candidate, PROJECT_HARNESS_DIR))) === 'directory';
    const hasClaudeMd = (await entryKind(join(candidate, PROJECT_CLAUDE_MD))) === 'file';
    if (!hasHarnessDir && !hasClaudeMd) {
      skipped.push({ encodedName: project.encodedName, reason: 'no-harness' });
      continue;
    }
    resolved.push({
      projectId: project.id,
      encodedName: project.encodedName,
      projectDir: candidate,
      via,
    });
  }

  return { resolved, skipped };
}

/**
 * One project's harness: the §3.10 nodes and edges declared under `<project>/.claude/**` plus the
 * project's own root `CLAUDE.md`.
 *
 * ⚠️ **It deliberately returns no file list.** `HarnessScan.files` is what Bloat Radar walks
 * (§5.11) and what `q:claudeMdFiles` reports; a project file that reached either would become
 * sizeable, flaggable and — for the rules that carry an action — deletable. There is no path from
 * this function's return value to a guarded action, and that is structural rather than a filter
 * someone can forget.
 *
 * ⚠️ Only the project's `.claude` subtree is walked, never the project itself. Walking a source
 * repository would be slow, would pull the user's code into the app's working set for no analytic
 * gain, and is not what §2.1's "Harness" means.
 */
export async function scanProjectHarness(
  project: ResolvedProject,
): Promise<{ nodes: HarnessNodeInput[]; edges: HarnessEdgeInput[] }> {
  const nodes: HarnessNodeInput[] = [];
  const edges: HarnessEdgeInput[] = [];
  const handoffCandidates: HandoffCandidate[] = [];
  const toolKeys = new Map<string, string>();
  const fileKeys = new Map<string, string>();
  const { projectId, projectDir } = project;

  /** Every node from this file is project-scoped, `source: 'user'`, and carries no plugin. */
  const base = {
    source: 'user',
    pluginKey: null,
    projectId,
    enabled: null,
    entryCount: null,
  } as const;

  const push = (node: HarnessNodeInput): string => {
    nodes.push(node);
    return harnessNodeKey(node);
  };

  const toolNode = (name: string): string => {
    const existing = toolKeys.get(name);
    if (existing !== undefined) return existing;
    // §3.10 — "rel_path: NULL for tool nodes". A granted tool is a builtin capability, not a file,
    // so it is NOT project-scoped: `Read` is the same `Read` in every project, and one tool node
    // per project would shatter the Map into disconnected islands.
    const key = push({
      kind: 'tool',
      name,
      source: 'builtin',
      pluginKey: null,
      projectId: null,
      relPath: null,
      role: null,
      description: null,
      sizeBytes: 0,
      mtimeMs: null,
      enabled: null,
      entryCount: null,
    });
    toolKeys.set(name, key);
    return key;
  };

  const fileNode = (declaredPath: string): string => {
    const existing = fileKeys.get(declaredPath);
    if (existing !== undefined) return existing;
    // A declared `metadata.reads` / `metadata.writes` path IS project-relative, so unlike a tool
    // node this one is scoped: two projects that both read `DESIGN.md` read two different files.
    const key = push({
      ...base,
      kind: 'file',
      name: basenameOf(declaredPath),
      relPath: declaredPath,
      role: null,
      description: null,
      sizeBytes: 0,
      mtimeMs: null,
    });
    fileKeys.set(declaredPath, key);
    return key;
  };

  // ---- the project's own CLAUDE.md — the main loop's instructions -------------------------
  const claudeMdAbs = join(projectDir, PROJECT_CLAUDE_MD);
  if ((await entryKind(claudeMdAbs)) === 'file') {
    const size = await sizeOnDisk(claudeMdAbs);
    push({
      ...base,
      kind: 'claude_md',
      name: PROJECT_CLAUDE_MD,
      relPath: PROJECT_CLAUDE_MD,
      role: null,
      description: null,
      sizeBytes: size,
      mtimeMs: null,
    });
  }

  // ---- <project>/.claude/** ----------------------------------------------------------------
  const harnessRoot = join(projectDir, PROJECT_HARNESS_DIR);
  if ((await entryKind(harnessRoot)) === 'directory') {
    const tree = await walkTree(harnessRoot);
    for (const file of tree.files) {
      // rel_path is relative to the PROJECT, so it reads the way the user's own repository does.
      const relPath = `${PROJECT_HARNESS_DIR}/${file.relPath}`;
      const fileBase = basenameOf(file.relPath);
      const dir = directoryOf(file.relPath);
      const parentName = basenameOf(dir);

      if (fileBase === 'SKILL.md') {
        const parsed = parseHarnessFile(await readTextOrEmpty(join(harnessRoot, file.relPath)));
        const name = parsed.frontmatter.name ?? basenameOf(dir);
        const key = push({
          ...base,
          kind: 'skill',
          name,
          // The skill IS its directory (§3.10), so size is the directory's, recursive.
          relPath: `${PROJECT_HARNESS_DIR}/${dir}`,
          role: parsed.frontmatter.role,
          description: parsed.frontmatter.description,
          sizeBytes: await sizeOnDisk(join(harnessRoot, dir)),
          mtimeMs: file.mtimeMs,
        });
        handoffCandidates.push({ key, name, body: parsed.body });

        for (const tool of parsed.frontmatter.allowedTools) {
          edges.push({
            fromKey: key,
            toKey: toolNode(tool),
            kind: 'tool_grant',
            evidence: 'frontmatter',
          });
        }
        for (const read of parsed.frontmatter.reads) {
          edges.push({
            fromKey: key,
            toKey: fileNode(read),
            kind: 'reads',
            evidence: 'frontmatter',
          });
        }
        for (const write of parsed.frontmatter.writes) {
          edges.push({
            fromKey: key,
            toKey: fileNode(write),
            kind: 'writes',
            evidence: 'frontmatter',
          });
        }
        continue;
      }

      if (fileBase.endsWith('.md') && (parentName === 'agents' || parentName === 'commands')) {
        const parsed = parseHarnessFile(await readTextOrEmpty(join(harnessRoot, file.relPath)));
        push({
          ...base,
          kind: parentName === 'agents' ? 'agent' : 'command',
          name: parsed.frontmatter.name ?? fileBase.slice(0, -'.md'.length),
          relPath,
          role: parsed.frontmatter.role,
          description: parsed.frontmatter.description,
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs,
        });
        continue;
      }

      if (fileBase === 'CLAUDE.md' || fileBase === 'CLAUDE.local.md') {
        push({
          ...base,
          kind: 'claude_md',
          // ⚠️ A `<project>/.claude/CLAUDE.md` is NOT the project's root `CLAUDE.md`, and the two
          // must stay distinguishable: §5.9 M-14's rule O-3 draws the orchestrator edge from a
          // node named exactly `CLAUDE.md` at the project root. `rel_path` differs, so
          // `uq_harness_nodes` keeps them apart, and the name here carries the location.
          name: relPath,
          relPath,
          role: null,
          description: null,
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs,
        });
        continue;
      }

      if (fileBase === 'settings.json' || fileBase === 'settings.local.json') {
        push({
          ...base,
          kind: 'settings',
          name: relPath,
          relPath,
          role: null,
          description: null,
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs,
        });
      }
    }
  }

  // §3.10 `handoff`, evidence `body_mention` — derived over this project's skills only. A skill
  // can only hand off to one that exists, and a skill in another repository does not exist here.
  for (const edge of deriveHandoffEdges(handoffCandidates)) {
    edges.push({
      fromKey: edge.fromKey,
      toKey: edge.toKey,
      kind: 'handoff',
      evidence: 'body_mention',
    });
  }

  return { nodes, edges };
}

/** An unreadable config file is one node missing, not a failed scan (§6.9 error state). */
async function readTextOrEmpty(absolute: string): Promise<string> {
  try {
    return await readFile(absolute, 'utf8');
  } catch {
    return '';
  }
}

function directoryOf(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index < 0 ? '' : relPath.slice(0, index);
}

function basenameOf(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index < 0 ? relPath : relPath.slice(index + 1);
}
