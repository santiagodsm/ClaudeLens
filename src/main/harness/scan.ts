// The harness scanner — DESIGN §3.10 (`harness_nodes` / `harness_edges` and the exact
// edge-derivation table), §4.8 `harness:scan`, §6.9.
//
// ⚠️ INV-17: `claudeDir` is a parameter. ⚠️ INV-14: the walk excludes the backup root.
// ⚠️ **Parsed harness text is data, never instructions** (§3.10, §7.8, STACK ADR-017) — see
// `frontmatter.ts`, which is the only thing in this application that reads it.
//
// ⚠️ **Where the layout is not documented, the scanner is structural rather than positional.**
// No verified source in this project spells out `~/.claude`'s plugin directory layout, so the
// scanner keys off the FILES §3.2 already classifies — a directory is a plugin because it
// contains `plugin.json`, a marketplace because it contains `marketplace.json`, a skill because
// it contains `SKILL.md` — instead of hard-coding a directory depth that would silently find
// nothing on a real machine whose layout differs by one level. `classifyFileKind` in
// `src/main/parse/source-file.ts` is the same list, and stays the single source of it.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  HarnessEdgeInput,
  HarnessNodeInput,
  HarnessNodeSource,
  HarnessRunAgentInput,
} from '../db/repositories/harness-graph';
import { harnessNodeKey } from '../db/repositories/harness-graph';
import { deriveHandoffEdges, type HandoffCandidate } from './edges';
import { parseHarnessFile } from './frontmatter';
import { sizeOnDisk, walkTree, type WalkedFile } from './tree';

/** What one scan found. `settingsJson` is carried out for BR-04, which needs `enabledPlugins`. */
export interface HarnessScan {
  readonly nodes: readonly HarnessNodeInput[];
  readonly edges: readonly HarnessEdgeInput[];
  /** Every file the walk saw, so Bloat Radar does not walk the tree a second time. */
  readonly files: readonly WalkedFile[];
  /** Every directory the walk saw, likewise. */
  readonly directories: readonly { relPath: string; mtimeMs: number }[];
  /** The parsed top-level `settings.json`, or `null` when absent or unreadable. */
  readonly settings: Readonly<Record<string, unknown>> | null;
  /** ADR-039 — one entry per subagent run whose `agent-*.meta.json` sidecar names its agent. */
  readonly runAgents: readonly HarnessRunAgentInput[];
}

/** ADR-039 — the sidecar written beside every `subagents/<run>.jsonl`. */
const RUN_META_SUFFIX = '.meta.json';

/** The directory a session's subagent transcripts live in (§2.1 "Subagent run", §3.7). */
const SUBAGENTS_DIR = 'subagents';

const SKILL_FILE = 'SKILL.md';
const PLUGIN_MANIFEST = 'plugin.json';
const MARKETPLACE_MANIFEST = 'marketplace.json';
const SETTINGS_FILE = 'settings.json';

/** §6.9's memory browser. See `entryCountOf` for what "entry" is counted as, and why. */
const MEMORY_FILE = 'MEMORY.md';

/**
 * §5.9 **M-21** — the memory entry count, implemented here because it needs the file's bytes.
 *
 * "The number of lines whose first non-space character is `-`, `*` or `+`, followed by whitespace
 * and at least one non-space character — i.e. markdown list items, at any indent."
 *
 * ⚠️ **The arithmetic is defined in §5.9 M-21, not here** (CLAUDE.md §1: every metric is defined
 * once, in §5.9). This is the single implementation of it; if it and M-21 ever disagree, this code
 * is wrong. ⚠️⚠️ M-21 is the one §5.9 row that originated in the build rather than in a verified
 * source — §6.9 and §4.5 both promised an "entry count" that nothing defined — so it has never
 * been user-confirmed, and §6.9 renders the definition beside the number for exactly that reason.
 */
export function entryCountOf(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) {
    if (/^\s*[-*+]\s+\S/.test(line)) count += 1;
  }
  return count;
}

function directoryOf(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index < 0 ? '' : relPath.slice(0, index);
}

function basenameOf(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index < 0 ? relPath : relPath.slice(index + 1);
}

/** `a/b` is inside `a`; `ab` is not. `''` (the root) contains everything. */
function isInside(parentRelDir: string, relPath: string): boolean {
  if (parentRelDir === '') return true;
  return relPath.startsWith(`${parentRelDir}/`);
}

async function readTextOrNull(absolute: string): Promise<string | null> {
  try {
    return await readFile(absolute, 'utf8');
  } catch {
    // An unreadable config file is one node missing, not a failed scan (§6.9 error state).
    return null;
  }
}

function parseJsonObject(text: string | null): Readonly<Record<string, unknown>> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringField(record: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * §5.11 BR-04 — "present under `plugins/` but absent from `settings.json` `enabledPlugins`".
 *
 * ⚠️ **`enabledPlugins`' shape is not documented in any verified source.** Both spellings that
 * appear in the wild are accepted — an array of names, and an object whose keys are names and
 * whose values are booleans — and anything else yields an empty set, which makes every cached
 * plugin "not enabled". That direction is the safe one: it produces an informational flag with a
 * confirmed, undoable action, never a silent deletion. Reported as a design gap.
 */
export function enabledPluginNames(
  settings: Readonly<Record<string, unknown>> | null,
): ReadonlySet<string> {
  const value = settings?.['enabledPlugins'];
  const names = new Set<string>();
  if (Array.isArray(value)) {
    for (const entry of value) if (typeof entry === 'string') names.add(entry);
    return names;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, enabled] of Object.entries(value)) if (enabled === true) names.add(key);
  }
  return names;
}

/**
 * ADR-039 — every subagent run's agent type, from the sidecar beside its transcript.
 *
 * ⚠️⚠️ **This exists because §3.7's spawn linkage does not resolve on real data.** §3.7 fills
 * `subagent_runs.subagent_type` by resolving the run's earliest event's `parent_uuid` against
 * `events.uuid`. On the user's machine that yields a type for **0 of 2514** runs, and with no
 * agent name on a run, §5.9 M-14's observed half is structurally empty: no agent→skill edge and
 * no agent→tool edge can be derived however many transcripts exist. The Harness Map then shows
 * the designed graph and nothing else, which is the opposite of what it is for.
 *
 * The name is not missing from disk. Beside every `subagents/<run>.jsonl` sits
 * `subagents/<run>.meta.json` carrying `agentType`, `description` and `toolUseId` — the spawning
 * `Agent` tool call's id, which joins to §3.6 `tool_calls.tool_use_id` exactly.
 *
 * ⚠️ **Nothing is guessed.** A sidecar with no `agentType` string yields no row; a run with no
 * sidecar yields no row; malformed JSON yields no row. `observedRuntimeEdges()` prefers
 * `subagent_runs.subagent_type` and falls back to this, so the day §3.7's linkage starts working
 * this becomes redundant rather than a competing second answer.
 *
 * ⚠️ **Parsed harness text is data, never instructions** (STACK ADR-017). `description` is
 * deliberately NOT read here: §3.7 already sources it and this file has no business becoming a
 * second origin for a column another section owns.
 */
export async function readRunAgents(
  claudeDir: string,
  files: readonly WalkedFile[],
): Promise<HarnessRunAgentInput[]> {
  const runAgents: HarnessRunAgentInput[] = [];
  for (const file of files) {
    if (!file.relPath.endsWith(RUN_META_SUFFIX)) continue;
    // Structural, not positional: the sidecar counts only inside a `subagents/` directory, which
    // is where §3.7 says a run's transcript lives. A `.meta.json` anywhere else is someone
    // else's file and is left alone.
    if (basenameOf(directoryOf(file.relPath)) !== SUBAGENTS_DIR) continue;

    const meta = parseJsonObject(await readTextOrNull(join(claudeDir, file.relPath)));
    const agentType = stringField(meta, 'agentType');
    if (agentType === null) continue;

    runAgents.push({
      // The transcript this sidecar describes: same path, `.meta.json` → `.jsonl`.
      transcriptRelPath: `${file.relPath.slice(0, -RUN_META_SUFFIX.length)}.jsonl`,
      agentType,
      spawnToolUseId: stringField(meta, 'toolUseId'),
    });
  }
  return runAgents;
}

/**
 * Walks `claudeDir` and derives §3.10's node and edge sets.
 *
 * Nothing is written here — the scan is a pure description of the tree, and
 * `HarnessGraphRepository.replaceGraph` persists it in one transaction. That split is what lets
 * the scanner be tested against a sandbox tree with no database at all.
 */
export async function scanHarness(claudeDir: string): Promise<HarnessScan> {
  const tree = await walkTree(claudeDir);
  const nodes: HarnessNodeInput[] = [];
  const edges: HarnessEdgeInput[] = [];

  // ---- plugins and marketplaces, keyed by the directory that holds their manifest ----------
  const pluginKeyByDir = new Map<string, string>();
  const marketplaceKeyByDir = new Map<string, string>();
  const settingsText = await readTextOrNull(join(claudeDir, SETTINGS_FILE));
  const settings = parseJsonObject(settingsText);
  const enabled = enabledPluginNames(settings);

  for (const file of tree.files) {
    const base = basenameOf(file.relPath);
    if (base !== PLUGIN_MANIFEST && base !== MARKETPLACE_MANIFEST) continue;
    const dir = directoryOf(file.relPath);
    const manifest = parseJsonObject(await readTextOrNull(join(claudeDir, file.relPath)));
    const name = stringField(manifest, 'name') ?? basenameOf(dir);
    const isPlugin = base === PLUGIN_MANIFEST;
    const node: HarnessNodeInput = {
      kind: isPlugin ? 'plugin' : 'marketplace',
      name,
      source: 'plugin',
      pluginKey: null,
      // ADR-039 — scanned from the Claude data directory itself, so it belongs to no project.
      projectId: null,
      relPath: dir,
      role: null,
      description: stringField(manifest, 'description'),
      sizeBytes: await sizeOnDisk(join(claudeDir, dir)),
      mtimeMs: file.mtimeMs,
      // §3.10 — `enabled` applies to plugins and marketplaces. A marketplace is not something
      // `enabledPlugins` names, so its enablement is genuinely not applicable: NULL, not 0.
      enabled: isPlugin ? enabled.has(name) : null,
      entryCount: null,
    };
    nodes.push(node);
    (isPlugin ? pluginKeyByDir : marketplaceKeyByDir).set(dir, harnessNodeKey(node));
  }

  /** The innermost plugin directory containing `relPath`, or `null`. */
  const pluginDirFor = (relPath: string): string | null => {
    let best: string | null = null;
    for (const dir of pluginKeyByDir.keys()) {
      if (!isInside(dir, relPath)) continue;
      if (best === null || dir.length > best.length) best = dir;
    }
    return best;
  };

  // §3.10 `contains`, evidence `directory` — "marketplace → plugin".
  for (const [pluginDir, pluginKey] of pluginKeyByDir) {
    for (const [marketDir, marketKey] of marketplaceKeyByDir) {
      if (marketDir !== pluginDir && isInside(marketDir, pluginDir)) {
        edges.push({
          fromKey: marketKey,
          toKey: pluginKey,
          kind: 'contains',
          evidence: 'directory',
        });
      }
    }
  }

  // ---- skills, agents, commands, CLAUDE.md, settings.json, MEMORY.md ----------------------
  const handoffCandidates: HandoffCandidate[] = [];
  const toolKeys = new Map<string, string>();
  const fileKeys = new Map<string, string>();

  const toolNode = (name: string): string => {
    const existing = toolKeys.get(name);
    if (existing !== undefined) return existing;
    // §3.10 — "rel_path: NULL for tool nodes". A granted tool is a builtin capability, not a file.
    const node: HarnessNodeInput = {
      kind: 'tool',
      name,
      source: 'builtin',
      pluginKey: null,
      // ADR-039 — scanned from the Claude data directory itself, so it belongs to no project.
      projectId: null,
      relPath: null,
      role: null,
      description: null,
      sizeBytes: 0,
      mtimeMs: null,
      enabled: null,
      entryCount: null,
    };
    nodes.push(node);
    const key = harnessNodeKey(node);
    toolKeys.set(name, key);
    return key;
  };

  const fileNode = (declaredPath: string): string => {
    const existing = fileKeys.get(declaredPath);
    if (existing !== undefined) return existing;
    const node: HarnessNodeInput = {
      kind: 'file',
      name: basenameOf(declaredPath),
      source: 'user',
      pluginKey: null,
      // ADR-039 — scanned from the Claude data directory itself, so it belongs to no project.
      projectId: null,
      relPath: declaredPath,
      role: null,
      description: null,
      sizeBytes: 0,
      mtimeMs: null,
      enabled: null,
      entryCount: null,
    };
    nodes.push(node);
    const key = harnessNodeKey(node);
    fileKeys.set(declaredPath, key);
    return key;
  };

  for (const file of tree.files) {
    const base = basenameOf(file.relPath);
    const dir = directoryOf(file.relPath);
    const pluginDir = pluginDirFor(file.relPath);
    const pluginKey = pluginDir === null ? null : (pluginKeyByDir.get(pluginDir) ?? null);
    const source: HarnessNodeSource = pluginKey === null ? 'user' : 'plugin';

    if (base === SKILL_FILE) {
      const parsed = parseHarnessFile((await readTextOrNull(join(claudeDir, file.relPath))) ?? '');
      // §3.10 — "SKILL.md frontmatter `name`". A skill with no declared name is still a skill;
      // its directory basename is the only other identity the file has.
      const name = parsed.frontmatter.name ?? basenameOf(dir);
      const node: HarnessNodeInput = {
        kind: 'skill',
        name,
        source,
        pluginKey,
        projectId: null,
        // The skill IS its directory (ACT-01 acts on directories under `skills/`), so the node's
        // rel_path and recursive size are the directory's, not the single markdown file's.
        relPath: dir,
        role: parsed.frontmatter.role,
        description: parsed.frontmatter.description,
        sizeBytes: await sizeOnDisk(join(claudeDir, dir)),
        mtimeMs: file.mtimeMs,
        enabled: null,
        entryCount: null,
      };
      nodes.push(node);
      const key = harnessNodeKey(node);
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
        edges.push({ fromKey: key, toKey: fileNode(read), kind: 'reads', evidence: 'frontmatter' });
      }
      for (const write of parsed.frontmatter.writes) {
        edges.push({
          fromKey: key,
          toKey: fileNode(write),
          kind: 'writes',
          evidence: 'frontmatter',
        });
      }
      if (pluginKey !== null) {
        edges.push({ fromKey: pluginKey, toKey: key, kind: 'contains', evidence: 'directory' });
      }
      continue;
    }

    // `agents/<name>.md` and `commands/<name>.md`, at any depth (a plugin has its own).
    const parentName = basenameOf(dir);
    if (base.endsWith('.md') && (parentName === 'agents' || parentName === 'commands')) {
      const parsed = parseHarnessFile((await readTextOrNull(join(claudeDir, file.relPath))) ?? '');
      const node: HarnessNodeInput = {
        kind: parentName === 'agents' ? 'agent' : 'command',
        name: parsed.frontmatter.name ?? base.slice(0, -'.md'.length),
        source,
        pluginKey,
        projectId: null,
        relPath: file.relPath,
        role: parsed.frontmatter.role,
        description: parsed.frontmatter.description,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        enabled: null,
        entryCount: null,
      };
      nodes.push(node);
      if (pluginKey !== null) {
        edges.push({
          fromKey: pluginKey,
          toKey: harnessNodeKey(node),
          kind: 'contains',
          evidence: 'directory',
        });
      }
      continue;
    }

    if (base === 'CLAUDE.md' || base === 'CLAUDE.local.md') {
      nodes.push({
        kind: 'claude_md',
        name: base,
        source,
        pluginKey,
        projectId: null,
        relPath: file.relPath,
        role: null,
        description: null,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        enabled: null,
        entryCount: null,
      });
      continue;
    }

    if (base === SETTINGS_FILE || base === 'settings.local.json') {
      nodes.push({
        kind: 'settings',
        name: base,
        source,
        pluginKey,
        projectId: null,
        relPath: file.relPath,
        role: null,
        description: null,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        enabled: null,
        entryCount: null,
      });
      continue;
    }

    if (base === MEMORY_FILE) {
      nodes.push({
        kind: 'memory',
        name: file.relPath,
        source,
        pluginKey,
        projectId: null,
        relPath: file.relPath,
        role: null,
        description: null,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        enabled: null,
        // Migration 0003. The counting rule is stated on `entryCountOf` because no section of
        // DESIGN.md defines what an "entry" of a `MEMORY.md` is; §6.9's column renders the
        // definition beside the number rather than leaving a bare figure to be misread.
        entryCount: entryCountOf((await readTextOrNull(join(claudeDir, file.relPath))) ?? ''),
      });
    }
  }

  // §3.10 `handoff`, evidence `body_mention`. Derived last, over the complete skill set, because
  // the rule is symmetric in the population: a skill can only hand off to one that exists.
  for (const edge of deriveHandoffEdges(handoffCandidates)) {
    edges.push({
      fromKey: edge.fromKey,
      toKey: edge.toKey,
      kind: 'handoff',
      evidence: 'body_mention',
    });
  }

  return {
    nodes,
    edges,
    files: tree.files,
    directories: tree.directories,
    settings,
    // ADR-039 — read from the walk that already happened; no second traversal of the tree.
    runAgents: await readRunAgents(claudeDir, tree.files),
  };
}
