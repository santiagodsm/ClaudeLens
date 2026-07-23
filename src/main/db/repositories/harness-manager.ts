// Harness Manager queries — DESIGN §4.5 `q:skills`, `q:claudeMdFiles`, `q:plugins`,
// `q:memories`; §6.9; §5.9 M-13.
//
// ⚠️ **INV-13 — this whole file ignores the global filter, and says so in its signatures.**
// "Harness Manager invocation counts, 'last used', 'never used' and the runtime overlay are
// computed over the **full dataset**." No method here takes a `GlobalFilter`, which is what makes
// INV-13 a compile-time property (§4.5's ⛔ channels are typed the same way). §6.9's reason, in
// its own words: "A skill deleted because it looked unused this month is exactly the irreversible
// mistake this rule prevents."
//
// ⚠️ These four channels read `harness_nodes` / `harness_edges`, which **E10's scanner
// populates**. Until it runs they return empty results — which is the correct answer to "what
// skills are installed" when nothing has been scanned, and is not the same as zero invocations
// for a skill that exists.

import { Repository } from './base';
import type { SqliteDatabase } from '../sqlite';

/** §4.5 `SkillRow`, before `neverUsed` is derived. */
export interface SkillRecord {
  readonly name: string;
  readonly source: 'user' | 'plugin';
  readonly pluginName: string | null;
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly invocations: number;
  readonly lastUsedTs: number | null;
}

/** §4.5 `q:claudeMdFiles` row. */
export interface ClaudeMdRecord {
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly backups: { relPath: string; sizeBytes: number }[];
}

/** §4.5 `MarketplaceRow`. */
export interface MarketplaceRecord {
  readonly id: number;
  readonly name: string;
  readonly relPath: string | null;
  readonly sizeBytes: number;
  readonly mtimeMs: number | null;
  readonly enabled: boolean | null;
  readonly pluginCount: number;
}

/** §4.5 `PluginRow`. */
export interface PluginRecord {
  readonly id: number;
  readonly name: string;
  readonly marketplaceName: string | null;
  readonly relPath: string | null;
  readonly sizeBytes: number;
  readonly mtimeMs: number | null;
  readonly enabled: boolean | null;
}

/** §4.5 `q:memories` row. */
export interface MemoryRecord {
  readonly relPath: string;
  readonly projectId: number | null;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly entryCount: number;
}

/** §6.9 / ADR-039 — an agent definition declared inside a project's `.claude/agents/**`. */
export interface ProjectAgentRecord {
  readonly name: string;
  readonly relPath: string;
  readonly sizeBytes: number;
}

/** §6.9 / ADR-039 — a `CLAUDE.md` (or `.claude/CLAUDE.md`) declared inside a project. */
export interface ProjectClaudeMdRecord {
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/**
 * §6.9 / ADR-039 — one project's own harness, as the repository reads it, before `neverUsed` is
 * derived and the skills are sorted (the service does both, exactly as it does for `skills()`).
 */
export interface ProjectHarnessRecord {
  readonly projectId: number;
  readonly displayName: string;
  readonly encodedName: string;
  readonly skills: SkillRecord[];
  readonly agents: ProjectAgentRecord[];
  readonly claudeMd: ProjectClaudeMdRecord[];
  readonly memories: MemoryRecord[];
  readonly plugins: { marketplaces: MarketplaceRecord[]; plugins: PluginRecord[] };
}

export class HarnessManagerRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /**
   * §4.5 `q:skills` ⛔ — M-13 over the FULL dataset.
   *
   * `invocations` joins `harness_nodes(kind='skill').name` to `tool_calls.skill_name` (§3.10),
   * and `neverUsed` is derived by the caller from `invocations === 0` so the two cannot disagree.
   * §5.11 BR-03's "installed but never invoked" reads the same number.
   *
   * ⚠️⚠️ **ADR-039 — two node populations are excluded here, and both exclusions are safety, not
   * tidiness.**
   *
   *   · `project_id IS NOT NULL` — a skill declared in `<project>/.claude/skills/**`. It lives
   *     OUTSIDE the Claude data directory, its `rel_path` is relative to the project, and §6.9
   *     wires every row of this table to the guarded-action catalogue. Listing it here would put
   *     a Delete button beside a file ACT-01 has no business touching, and BR-03 (which reads
   *     this same list) would count it as bloat inside someone else's repository. Project harness
   *     nodes appear on the Harness Map and nowhere else.
   *
   *   · `source = 'transcript'` — a skill known only because a transcript shows it running. It is
   *     a real vertex of the Map, but it is not *installed under this directory*, and "installed
   *     but never used" is a claim about what is on disk. Counting it would also make BR-03
   *     structurally impossible for it — it ran, by definition — while still sizing it at 0 bytes.
   */
  skills(): SkillRecord[] {
    return this.all<{
      readonly name: string;
      readonly source: string;
      readonly plugin_name: string | null;
      readonly rel_path: string | null;
      readonly size_bytes: number;
      readonly invocations: number;
      readonly last_used_ts: number | null;
    }>(
      `SELECT n.name AS name, n.source AS source, plugin.name AS plugin_name,
              n.rel_path AS rel_path, n.size_bytes AS size_bytes,
              COALESCE((SELECT COUNT(*) FROM tool_calls tc
                         WHERE tc.tool_name = 'Skill' AND tc.skill_name = n.name), 0) AS invocations,
              (SELECT MAX(tc.ts) FROM tool_calls tc
                WHERE tc.tool_name = 'Skill' AND tc.skill_name = n.name) AS last_used_ts
       FROM   harness_nodes n
       LEFT JOIN harness_nodes plugin ON plugin.id = n.plugin_id
       WHERE  n.kind = 'skill' AND n.project_id IS NULL AND n.source <> 'transcript'
       ORDER BY n.name`,
    ).map((row) => ({
      name: row.name,
      // §4.5 narrows `SkillRow.source` to 'user' | 'plugin'; §3.10's CHECK also allows
      // 'builtin' | 'transcript', which cannot be a skill node. Anything unexpected is reported
      // as `'user'` only when it literally is; otherwise 'plugin' is inferred from `plugin_id`.
      source: row.plugin_name === null ? 'user' : 'plugin',
      pluginName: row.plugin_name,
      relPath: row.rel_path ?? '',
      sizeBytes: row.size_bytes,
      invocations: row.invocations,
      lastUsedTs: row.last_used_ts,
    }));
  }

  /**
   * §4.5 `q:claudeMdFiles` ⛔ — every `CLAUDE.md` with its sibling backups (§6.9, BR-01).
   *
   * The backup set is `*.bak` / `*.plaud-bak` in the same directory, which is exactly what §5.11
   * BR-01 and BR-06 name. ⚠️ INV-14: nothing under the backup root is ever returned, so the app
   * cannot flag or list its own safety net.
   */
  claudeMdFiles(backupRootPrefix: string): ClaudeMdRecord[] {
    const files = this.all<{
      readonly rel_path: string;
      readonly size_bytes: number;
      readonly mtime_ms: number;
    }>(
      `SELECT rel_path, size_bytes, mtime_ms FROM file_manifest
       WHERE  kind = 'claude_md' AND rel_path NOT LIKE ? ESCAPE '\\'
       ORDER BY rel_path`,
      `${escapeLike(backupRootPrefix)}%`,
    );
    const backups = this.all<{
      readonly rel_path: string;
      readonly size_bytes: number;
    }>(
      `SELECT rel_path, size_bytes FROM file_manifest
       WHERE  (rel_path LIKE '%.bak' OR rel_path LIKE '%.plaud-bak')
         AND  rel_path NOT LIKE ? ESCAPE '\\'`,
      `${escapeLike(backupRootPrefix)}%`,
    );
    return files.map((file) => ({
      relPath: file.rel_path,
      sizeBytes: file.size_bytes,
      mtimeMs: file.mtime_ms,
      backups: backups
        .filter((backup) => directoryOf(backup.rel_path) === directoryOf(file.rel_path))
        .map((backup) => ({ relPath: backup.rel_path, sizeBytes: backup.size_bytes })),
    }));
  }

  /** §4.5 `q:plugins` ⛔ — marketplaces and plugins, "enabled vs merely cached" (§6.9, BR-04). */
  plugins(): { marketplaces: MarketplaceRecord[]; plugins: PluginRecord[] } {
    const marketplaces = this.all<{
      readonly id: number;
      readonly name: string;
      readonly rel_path: string | null;
      readonly size_bytes: number;
      readonly mtime_ms: number | null;
      readonly enabled: number | null;
      readonly plugin_count: number;
    }>(
      // `pluginCount` is the number of `contains` marketplace → plugin edges (§3.10's table).
      `SELECT n.id, n.name, n.rel_path, n.size_bytes, n.mtime_ms, n.enabled,
              COALESCE((SELECT COUNT(*) FROM harness_edges he
                         JOIN harness_nodes p ON p.id = he.to_id
                        WHERE he.from_id = n.id AND he.kind = 'contains' AND p.kind = 'plugin'), 0)
                AS plugin_count
       FROM   harness_nodes n
       WHERE  n.kind = 'marketplace' AND n.project_id IS NULL
       ORDER BY n.name`,
    ).map((row) => ({
      id: row.id,
      name: row.name,
      relPath: row.rel_path,
      sizeBytes: row.size_bytes,
      mtimeMs: row.mtime_ms,
      enabled: row.enabled === null ? null : row.enabled === 1,
      pluginCount: row.plugin_count,
    }));

    const plugins = this.all<{
      readonly id: number;
      readonly name: string;
      readonly marketplace_name: string | null;
      readonly rel_path: string | null;
      readonly size_bytes: number;
      readonly mtime_ms: number | null;
      readonly enabled: number | null;
    }>(
      `SELECT n.id, n.name,
              (SELECT m.name FROM harness_edges he JOIN harness_nodes m ON m.id = he.from_id
                WHERE he.to_id = n.id AND he.kind = 'contains' AND m.kind = 'marketplace'
                LIMIT 1) AS marketplace_name,
              n.rel_path, n.size_bytes, n.mtime_ms, n.enabled
       FROM   harness_nodes n
       WHERE  n.kind = 'plugin' AND n.project_id IS NULL
       ORDER BY n.name`,
    ).map((row) => ({
      id: row.id,
      name: row.name,
      marketplaceName: row.marketplace_name,
      relPath: row.rel_path,
      sizeBytes: row.size_bytes,
      mtimeMs: row.mtime_ms,
      enabled: row.enabled === null ? null : row.enabled === 1,
    }));

    return { marketplaces, plugins };
  }

  /**
   * §4.5 `q:memories` ⛔ — every `MEMORY.md`, its project, size, mtime and entry count.
   *
   * ⚠️⚠️ **`entryCount` had no source, and E10 added one rather than fabricating a zero.** §4.5
   * declares `entryCount: number`, but §3.10's `harness_nodes` DDL declared no such column, §3.2's
   * `file_manifest` has none, and **no section of DESIGN.md defines what an "entry" of a
   * `MEMORY.md` is**. Computing it requires reading the file, which is the scanner's job, not a
   * query's. Migration `0003-harness-node-entry-count.sql` adds `entry_count` (a NEW numbered
   * file — `0001` and `0002` are merged and immutable, ADR-007) and
   * `src/main/harness/scan.ts` `entryCountOf()` states the counting rule mechanically: **an entry
   * is a markdown list item**. `NULL` means "not counted" and is reported as `0` only for a node
   * the scanner has not yet visited — §6.9 renders the definition beside the number.
   *
   * `projectId` is resolved through `file_manifest` → `sessions` → `projects` when the memory
   * lives under a `projects/<encoded>/…` path, and is genuinely `NULL` for a top-level
   * `MEMORY.md`, which belongs to no project.
   */
  memories(): MemoryRecord[] {
    return this.all<{
      readonly rel_path: string | null;
      readonly project_id: number | null;
      readonly size_bytes: number;
      readonly mtime_ms: number | null;
      readonly entry_count: number | null;
    }>(
      `SELECT n.rel_path AS rel_path,
              (SELECT p.id FROM projects p
                WHERE n.rel_path LIKE 'projects/' || p.encoded_name || '/%'
                LIMIT 1) AS project_id,
              n.size_bytes AS size_bytes, n.mtime_ms AS mtime_ms, n.entry_count AS entry_count
       FROM   harness_nodes n
       WHERE  n.kind = 'memory' AND n.project_id IS NULL
       ORDER BY n.rel_path`,
    ).map((row) => ({
      relPath: row.rel_path ?? '',
      projectId: row.project_id,
      sizeBytes: row.size_bytes,
      mtimeMs: row.mtime_ms ?? 0,
      entryCount: row.entry_count ?? 0,
    }));
  }

  /**
   * §6.9 / ADR-039 — each project's OWN harness, grouped for the Harness Manager's per-project
   * sections. The inverse selection of the four methods above: those take `project_id IS NULL`
   * (the `~/.claude`-level harness); this takes `project_id IS NOT NULL`.
   *
   * ⚠️⚠️ **Read-only, and this method is the reason it stays that way.** ADR-039 excludes project
   * nodes from `q:skills` / `q:memories` / `q:plugins` and from Bloat Radar precisely because a
   * project file is outside the Claude data directory and must never sit beside a Delete button.
   * This method reproduces none of that wiring: it returns the nodes for *display*, the renderer
   * attaches no action to them, and no guarded action can name a project-relative path. A project
   * skill is shown under its project — never counted as bloat, never actioned.
   *
   * ⚠️ **`invocations` is the SAME M-13 count as `skills()`** — a join of the skill's `name` to
   * `tool_calls.skill_name` over the FULL dataset (§5.9 M-13, INV-13). A metric is defined once
   * (CLAUDE.md §1); inventing a project-scoped invocation count here would be a second, undefined
   * metric. The per-project actionability the user asked for comes from *which section* a skill
   * appears in, not from a different number.
   */
  projectHarness(): ProjectHarnessRecord[] {
    const projects = this.all<{
      readonly id: number;
      readonly display_name: string;
      readonly encoded_name: string;
    }>(
      `SELECT DISTINCT n.project_id AS id, p.display_name AS display_name,
              p.encoded_name AS encoded_name
       FROM   harness_nodes n
       JOIN   projects p ON p.id = n.project_id
       WHERE  n.project_id IS NOT NULL
       ORDER BY p.display_name, p.encoded_name, n.project_id`,
    );

    const skills = this.all<{
      readonly project_id: number;
      readonly name: string;
      readonly plugin_name: string | null;
      readonly rel_path: string | null;
      readonly size_bytes: number;
      readonly invocations: number;
      readonly last_used_ts: number | null;
    }>(
      // Same M-13 subquery as `skills()`; §2.1 "Skill invocation" is a `Skill` tool call.
      `SELECT n.project_id AS project_id, n.name AS name, plugin.name AS plugin_name,
              n.rel_path AS rel_path, n.size_bytes AS size_bytes,
              COALESCE((SELECT COUNT(*) FROM tool_calls tc
                         WHERE tc.tool_name = 'Skill' AND tc.skill_name = n.name), 0) AS invocations,
              (SELECT MAX(tc.ts) FROM tool_calls tc
                WHERE tc.tool_name = 'Skill' AND tc.skill_name = n.name) AS last_used_ts
       FROM   harness_nodes n
       LEFT JOIN harness_nodes plugin ON plugin.id = n.plugin_id
       WHERE  n.kind = 'skill' AND n.project_id IS NOT NULL AND n.source <> 'transcript'
       ORDER BY n.name`,
    );

    const agents = this.all<{
      readonly project_id: number;
      readonly name: string;
      readonly rel_path: string | null;
      readonly size_bytes: number;
    }>(
      `SELECT project_id, name, rel_path, size_bytes FROM harness_nodes
       WHERE  kind = 'agent' AND project_id IS NOT NULL
       ORDER BY name`,
    );

    const claudeMd = this.all<{
      readonly project_id: number;
      readonly rel_path: string | null;
      readonly size_bytes: number;
      readonly mtime_ms: number | null;
    }>(
      `SELECT project_id, rel_path, size_bytes, mtime_ms FROM harness_nodes
       WHERE  kind = 'claude_md' AND project_id IS NOT NULL
       ORDER BY rel_path`,
    );

    const memories = this.all<{
      readonly project_id: number;
      readonly rel_path: string | null;
      readonly size_bytes: number;
      readonly mtime_ms: number | null;
      readonly entry_count: number | null;
    }>(
      `SELECT project_id, rel_path, size_bytes, mtime_ms, entry_count FROM harness_nodes
       WHERE  kind = 'memory' AND project_id IS NOT NULL
       ORDER BY rel_path`,
    );

    const marketplaces = this.all<{
      readonly project_id: number;
      readonly id: number;
      readonly name: string;
      readonly rel_path: string | null;
      readonly size_bytes: number;
      readonly mtime_ms: number | null;
      readonly enabled: number | null;
      readonly plugin_count: number;
    }>(
      `SELECT n.project_id AS project_id, n.id AS id, n.name AS name, n.rel_path AS rel_path,
              n.size_bytes AS size_bytes, n.mtime_ms AS mtime_ms, n.enabled AS enabled,
              COALESCE((SELECT COUNT(*) FROM harness_edges he
                         JOIN harness_nodes p ON p.id = he.to_id
                        WHERE he.from_id = n.id AND he.kind = 'contains' AND p.kind = 'plugin'), 0)
                AS plugin_count
       FROM   harness_nodes n
       WHERE  n.kind = 'marketplace' AND n.project_id IS NOT NULL
       ORDER BY n.name`,
    );

    const pluginRows = this.all<{
      readonly project_id: number;
      readonly id: number;
      readonly name: string;
      readonly marketplace_name: string | null;
      readonly rel_path: string | null;
      readonly size_bytes: number;
      readonly mtime_ms: number | null;
      readonly enabled: number | null;
    }>(
      `SELECT n.project_id AS project_id, n.id AS id, n.name AS name,
              (SELECT m.name FROM harness_edges he JOIN harness_nodes m ON m.id = he.from_id
                WHERE he.to_id = n.id AND he.kind = 'contains' AND m.kind = 'marketplace'
                LIMIT 1) AS marketplace_name,
              n.rel_path AS rel_path, n.size_bytes AS size_bytes, n.mtime_ms AS mtime_ms,
              n.enabled AS enabled
       FROM   harness_nodes n
       WHERE  n.kind = 'plugin' AND n.project_id IS NOT NULL
       ORDER BY n.name`,
    );

    return projects.map((project) => ({
      projectId: project.id,
      displayName: project.display_name,
      encodedName: project.encoded_name,
      skills: skills
        .filter((row) => row.project_id === project.id)
        .map((row) => ({
          name: row.name,
          source: row.plugin_name === null ? ('user' as const) : ('plugin' as const),
          pluginName: row.plugin_name,
          relPath: row.rel_path ?? '',
          sizeBytes: row.size_bytes,
          invocations: row.invocations,
          lastUsedTs: row.last_used_ts,
        })),
      agents: agents
        .filter((row) => row.project_id === project.id)
        .map((row) => ({ name: row.name, relPath: row.rel_path ?? '', sizeBytes: row.size_bytes })),
      claudeMd: claudeMd
        .filter((row) => row.project_id === project.id)
        .map((row) => ({
          relPath: row.rel_path ?? '',
          sizeBytes: row.size_bytes,
          mtimeMs: row.mtime_ms ?? 0,
        })),
      memories: memories
        .filter((row) => row.project_id === project.id)
        .map((row) => ({
          relPath: row.rel_path ?? '',
          projectId: project.id,
          sizeBytes: row.size_bytes,
          mtimeMs: row.mtime_ms ?? 0,
          entryCount: row.entry_count ?? 0,
        })),
      plugins: {
        marketplaces: marketplaces
          .filter((row) => row.project_id === project.id)
          .map((row) => ({
            id: row.id,
            name: row.name,
            relPath: row.rel_path,
            sizeBytes: row.size_bytes,
            mtimeMs: row.mtime_ms,
            enabled: row.enabled === null ? null : row.enabled === 1,
            pluginCount: row.plugin_count,
          })),
        plugins: pluginRows
          .filter((row) => row.project_id === project.id)
          .map((row) => ({
            id: row.id,
            name: row.name,
            marketplaceName: row.marketplace_name,
            relPath: row.rel_path,
            sizeBytes: row.size_bytes,
            mtimeMs: row.mtime_ms,
            enabled: row.enabled === null ? null : row.enabled === 1,
          })),
      },
    }));
  }
}

/** `LIKE` treats `%` and `_` as wildcards; a rel_path prefix must match literally. */
function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function directoryOf(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index < 0 ? '' : relPath.slice(0, index);
}
