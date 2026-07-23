// The Harness Manager's main-process half — DESIGN §4.8 `harness:scan` / `bloat:list`, §4.5's
// four ⛔ channels (`q:skills`, `q:claudeMdFiles`, `q:plugins`, `q:memories`), §6.9.
//
// ⚠️⚠️ **INV-13 — every number this service produces is ALL TIME.** Not one method takes a
// `GlobalFilter`, and the five §4.5 channels are typed without one (E1), so this is a
// compile-time property rather than a convention. §6.9's reason, in its own words: "A skill
// deleted because it looked unused this month is exactly the irreversible mistake this rule
// prevents." The UI badges every count "all time".
//
// ⚠️ INV-14 — the scan's walk excludes `<claudeDir>/.claude-lens-backups/`, so the app never
// sees, counts, flags or offers to delete its own safety net.
//
// ⚠️ A failed harness scan never blocks the analytics views (§6.9): it is a per-panel error, and
// the scan itself degrades to "fewer nodes" rather than to an exception wherever it can.

import type {
  BloatList,
  ClaudeMdFiles,
  HarnessProjects,
  HarnessScanSummary,
  Memories,
  Page,
  Paged,
  PluginsAndMarketplaces,
  SkillRow,
  SkillSort,
} from '../../shared/ipc-contract';
import { BACKUP_ROOT_NAME } from '../config/paths';
import { BloatFlagsRepository } from '../db/repositories/bloat-flags';
import { HarnessGraphRepository, harnessNodeKey } from '../db/repositories/harness-graph';
import { HarnessManagerRepository } from '../db/repositories/harness-manager';
import { pageFrom } from '../db/repositories/scope';
import type { SqliteDatabase } from '../db/sqlite';
import { HandlerError } from '../ipc/errors';
import { detectBloat } from './bloat-radar';
import { resolveProjectHarnessDirs, scanProjectHarness } from './projects';
import { scanHarness } from './scan';
import type {
  HarnessEdgeInput,
  HarnessNodeInput,
  HarnessNodeKind,
} from '../db/repositories/harness-graph';

export interface HarnessServiceDeps {
  readonly db: SqliteDatabase;
  /** §5.1 — `null` until the user configures one. INV-17: never resolved implicitly. */
  readonly claudeDir: () => string | null;
  readonly now: () => number;
  /** §4.9 — `evt:dataChanged` with the `harness` and `bloat` scopes, after a scan wrote. */
  readonly onScanned?: (payload: { at: number }) => void;
  /** Test seam for BR-05's reported threshold; production uses the module constant. */
  readonly transcriptThresholdBytes?: number;
}

export class HarnessService {
  readonly #deps: HarnessServiceDeps;
  readonly #graph: HarnessGraphRepository;
  readonly #flags: BloatFlagsRepository;
  readonly #manager: HarnessManagerRepository;

  constructor(deps: HarnessServiceDeps) {
    this.#deps = deps;
    this.#graph = new HarnessGraphRepository(deps.db);
    this.#flags = new BloatFlagsRepository(deps.db);
    this.#manager = new HarnessManagerRepository(deps.db);
  }

  /**
   * §4.8 `harness:scan` — walk, derive §3.10's nodes and edges, then run §5.11's closed rule set.
   *
   * The order matters: BR-03 reads invocation counts that join against the skill nodes this scan
   * has just written, so the graph is persisted first and the flags second. Both replacements are
   * whole-table (§3.10, §3.12), each in its own transaction.
   */
  async scan(): Promise<HarnessScanSummary> {
    const claudeDir = this.#requireClaudeDir();
    const scannedAt = this.#deps.now();

    const scan = await scanHarness(claudeDir);

    // ⚠️⚠️ ADR-039 — the project half. `directoryNodes` is everything scanned from `claudeDir`
    // and is the ONLY population Bloat Radar ever sees; `projectNodes` is everything read from a
    // project directory and never reaches it. Keeping them as two named arrays rather than one
    // filtered list is deliberate: the exclusion is then visible at the call site instead of
    // being a predicate someone can forget to repeat.
    const directoryNodes = this.#withTranscriptNodes([...scan.nodes], scan.runAgents);
    const projects = await resolveProjectHarnessDirs(claudeDir, this.#graph.projectIdentities());
    const projectNodes: HarnessNodeInput[] = [];
    const projectEdges: HarnessEdgeInput[] = [];
    for (const project of projects.resolved) {
      const scanned = await scanProjectHarness(project);
      projectNodes.push(...scanned.nodes);
      projectEdges.push(...scanned.edges);
    }

    const nodes = [...directoryNodes, ...projectNodes];
    // `harnessNodeKey` is imported so the edge/node key contract is used, not re-derived; a
    // duplicate key would be dropped by `uq_harness_nodes` rather than silently doubling a vertex.
    const keys = new Set(nodes.map((node) => harnessNodeKey(node)));
    const edges = [...scan.edges, ...projectEdges].filter(
      (edge) => keys.has(edge.fromKey) && keys.has(edge.toKey),
    );

    this.#graph.replaceGraph(nodes, edges, scan.runAgents);

    // BR-03's counts come from the manager repository, whose signature has no filter (INV-13).
    // ⚠️ ADR-039 — `skills()` already excludes project-scoped and transcript-only nodes, so no
    // skill outside the Claude data directory can reach a Bloat Radar rule through this list.
    const skills = this.#manager.skills().map((skill) => ({
      name: skill.name,
      relPath: skill.relPath,
      sizeBytes: skill.sizeBytes,
      invocations: skill.invocations,
    }));

    const flagCount = this.#flags.replaceAll(
      detectBloat({
        // ⚠️⚠️ `directoryNodes`, never `nodes`. Bloat Radar sizes things, calls them reclaimable
        // and attaches guarded actions to them; `scan.files` and `scan.directories` come from the
        // walk of `claudeDir` alone, and the node list handed alongside them must match that
        // scope, or BR-04 could flag something inside a repository this app must never write to.
        scan: { ...scan, nodes: directoryNodes },
        skills,
        corpus: this.#flags.transcriptCorpus(),
        ...(this.#deps.transcriptThresholdBytes === undefined
          ? {}
          : { transcriptThresholdBytes: this.#deps.transcriptThresholdBytes }),
      }),
      scannedAt,
    );

    const counts = this.#graph.counts();
    this.#deps.onScanned?.({ at: scannedAt });
    return {
      nodes: counts.nodes,
      edges: counts.edges,
      flags: flagCount,
      scannedAt,
      // §4.6's rule applied to ADR-039: a project whose directory could not be resolved from its
      // encoded name is INCOMPLETENESS, and incompleteness is data in the success payload — never
      // a log line and never an error (CLAUDE.md §1). §6.9's header renders it beside the counts.
      projectsResolved: projects.resolved.length,
      projectsSkipped: projects.skipped.length,
    };
  }

  /**
   * §3.10 / ADR-039 — the vertices only the transcripts know about, added where the database is
   * in reach rather than invented by the filesystem scanner.
   *
   * §3.10's runtime overlay joins `harness_nodes(kind='tool').name` to `tool_calls.tool_name` and
   * `harness_nodes(kind='skill').name` to `tool_calls.skill_name`, and §2.1 defines an **agent
   * definition** as "a `.claude/agents/*.md` file, **or a `subagent_type` value observed in an
   * `Agent` tool call**". All three kinds therefore have a transcript-only form, and
   * `source = 'transcript'` is in §3.10's CHECK for exactly this.
   *
   * ⚠️⚠️ **A name already declared on disk is never duplicated.** If a project declares
   * `story-implementer` and the transcripts show it running, adding a second `transcript` node of
   * that name would split the runtime count off the designed node and destroy the one thing the
   * Harness Map exists for — designed-vs-actual in one picture. Declared wins; a transcript node
   * fills only the gap.
   *
   * ⚠️ This is what makes the Map useful with **zero** configuration files, which is the state the
   * user's Claude data directory was actually in.
   */
  #withTranscriptNodes(
    scanned: HarnessNodeInput[],
    runAgents: readonly { readonly agentType: string }[],
  ): HarnessNodeInput[] {
    const nodes = [...scanned];
    const declaredNames = (kind: HarnessNodeKind): Set<string> =>
      new Set(nodes.filter((node) => node.kind === kind).map((node) => node.name));

    const add = (kind: HarnessNodeKind, names: readonly string[], declared: Set<string>): void => {
      for (const name of names) {
        if (declared.has(name)) continue;
        declared.add(name);
        nodes.push({
          kind,
          name,
          source: 'transcript',
          pluginKey: null,
          // A transcript node belongs to no project: the same skill may have run in several, and
          // §3.10 gives it one identity. Where it ran is a question for the Flow Sankey (§6.7).
          projectId: null,
          relPath: null,
          role: null,
          description: null,
          sizeBytes: 0,
          mtimeMs: null,
          enabled: null,
          entryCount: null,
          // Migration 0010 — a transcript-only node has no plugin manifest to read a version from.
          version: null,
        });
      }
    };

    add('tool', this.#graph.observedToolNames(), declaredNames('tool'));
    add('skill', this.#graph.observedSkillNames(), declaredNames('skill'));
    // The scan's own sidecars are unioned in because `harness_run_agents` still holds the PREVIOUS
    // scan's rows at this point — the replacement happens inside `replaceGraph`.
    const agentNames = new Set([
      ...this.#graph.observedAgentNames(),
      ...runAgents.map((run) => run.agentType),
    ]);
    add('agent', [...agentNames].toSorted(), declaredNames('agent'));

    return nodes;
  }

  /** §4.8 `bloat:list` — §6.9's header badge is `N issues · X reclaimable`. */
  bloatList(): BloatList {
    const rows = this.#flags.list();
    return {
      rows: rows.map((row) => ({
        id: row.id,
        ruleId: row.ruleId,
        severity: row.severity,
        title: row.title,
        location: row.location,
        sizeBytes: row.sizeBytes,
        itemCount: row.itemCount,
        rationale: row.rationale,
        actionType: row.actionType,
        actionPayload: row.actionPayload,
        detectedAt: row.detectedAt,
      })),
      // ⚠️ "Reclaimable" counts only flags that HAVE an action. BR-03 is actionless by design and
      // BR-05's bytes are archived, not freed — adding either would promise disk back that no
      // button in this application will hand over (§5.11, §3.12).
      totalReclaimableBytes: rows
        .filter((row) => row.actionType !== null && row.ruleId !== 'BR-05')
        .reduce((total, row) => total + row.sizeBytes, 0),
    };
  }

  /** §4.5 `q:skills` ⛔ — invocations and "last used" are ALL TIME (INV-13). */
  skills(request: Page & { sort: SkillSort }): Paged<SkillRow> {
    const rows: SkillRow[] = this.#manager.skills().map((skill) => ({
      name: skill.name,
      source: skill.source,
      pluginName: skill.pluginName,
      relPath: skill.relPath,
      sizeBytes: skill.sizeBytes,
      invocations: skill.invocations,
      lastUsedTs: skill.lastUsedTs,
      // Derived from `invocations` so the two can never disagree (§4.5, §5.11 BR-03).
      neverUsed: skill.invocations === 0,
    }));
    return pageFrom(sortSkills(rows, request.sort), request, (row) => [row.relPath, row.name]);
  }

  /** §4.5 `q:claudeMdFiles` ⛔ — §6.9's inspector; BR-01's headline row. */
  claudeMdFiles(): ClaudeMdFiles {
    // INV-14 — the prefix the repository filters on, from `paths.ts` rather than a literal.
    return { rows: this.#manager.claudeMdFiles(`${BACKUP_ROOT_NAME}/`) };
  }

  /** §4.5 `q:plugins` ⛔ — "enabled vs merely cached, with disk cost each" (§6.9). */
  plugins(): PluginsAndMarketplaces {
    const result = this.#manager.plugins();
    return { marketplaces: [...result.marketplaces], plugins: [...result.plugins] };
  }

  /** §4.5 `q:memories` ⛔ — see migration 0003 for what `entryCount` counts, and why. */
  memories(): Memories {
    return { rows: this.#manager.memories().map((row) => ({ ...row })) };
  }

  /**
   * §4.5 `q:harnessProjects` ⛔ — ADR-039 — each project's OWN skills, agents, CLAUDE.md and
   * memory, grouped for §6.9's per-project sections. `neverUsed` is derived and skills are sorted
   * "installed but never used" here, exactly as `skills()` does for the shared list — the same
   * derivation so the two can never disagree (§5.11 BR-03). Read-only: no row here is a
   * guarded-action target (paths are project-relative; ACT-01…07 stay inside the Claude dir).
   */
  projectHarness(): HarnessProjects {
    return {
      rows: this.#manager.projectHarness().map((group) => ({
        projectId: group.projectId,
        displayName: group.displayName,
        encodedName: group.encodedName,
        skills: sortSkills(
          group.skills.map((skill) => ({
            name: skill.name,
            source: skill.source,
            pluginName: skill.pluginName,
            relPath: skill.relPath,
            sizeBytes: skill.sizeBytes,
            invocations: skill.invocations,
            lastUsedTs: skill.lastUsedTs,
            neverUsed: skill.invocations === 0,
          })),
          'never_used',
        ),
        agents: group.agents.map((agent) => ({ ...agent })),
        claudeMd: group.claudeMd.map((file) => ({ ...file })),
        memories: group.memories.map((row) => ({ ...row })),
        plugins: {
          marketplaces: [...group.plugins.marketplaces],
          plugins: [...group.plugins.plugins],
        },
      })),
    };
  }

  #requireClaudeDir(): string {
    const claudeDir = this.#deps.claudeDir();
    if (claudeDir === null) {
      throw new HandlerError('E_NO_DIR', 'No Claude data directory is configured yet.');
    }
    return claudeDir;
  }
}

/**
 * §4.5 `SkillSort`. `never_used` is the default §6.9 asks for — "sorted by
 * installed-but-never-used" — which puts the zero-invocation skills first and orders the rest by
 * how little they are used, so the table reads as a single ranking rather than two.
 */
function sortSkills(rows: readonly SkillRow[], sort: SkillSort): SkillRow[] {
  const byName = (left: SkillRow, right: SkillRow): number =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  switch (sort) {
    case 'never_used':
      return [...rows].toSorted(
        (left, right) => left.invocations - right.invocations || byName(left, right),
      );
    case 'invocations':
      return [...rows].toSorted(
        (left, right) => right.invocations - left.invocations || byName(left, right),
      );
    case 'size':
      return [...rows].toSorted(
        (left, right) => right.sizeBytes - left.sizeBytes || byName(left, right),
      );
    case 'name':
      return [...rows].toSorted(byName);
  }
}
