// The migration runner. STACK ADR-007, DESIGN §3.18, §9.6.
//
// ⚠️ THE RULE THIS FILE EXISTS TO ENFORCE (§9.6, ADR-026):
// A failed migration leaves the database UNTOUCHED and surfaces `E_DB_MIGRATION_FAILED`.
// It never falls back to dropping and rebuilding. `price_rows`, `settings`, `audit_log` and
// `archives` are USER class with no other source (§2.2), and rows with
// `archive_id IS NOT NULL` are RETAINED and no longer derivable (ADR-033) — a
// drop-and-re-sync would silently destroy hand-corrected price history and shrink lifetime
// totals, which is this project's defining failure. There is no such path here, and there
// must be none anywhere else either (`db-migration-review`, §12.2).

import initialSql from './migrations/0001-initial.sql?raw';
import toolCallDescriptionSql from './migrations/0002-tool-call-description.sql?raw';
import harnessEntryCountSql from './migrations/0003-harness-node-entry-count.sql?raw';
import projectHarnessSql from './migrations/0004-project-harness.sql?raw';
import cacheWrite1hSql from './migrations/0005-cache-write-1h.sql?raw';
import projectDisplayNameSql from './migrations/0006-project-display-name-from-cwd.sql?raw';
import projectGroupsSql from './migrations/0007-project-groups.sql?raw';
import subagentSpawnSidecarSql from './migrations/0008-subagent-spawn-sidecar.sql?raw';
import retainOrphanedHistorySql from './migrations/0009-retain-orphaned-history.sql?raw';
import harnessNodeVersionSql from './migrations/0010-harness-node-version.sql?raw';
import apiCallIdSql from './migrations/0011-api-call-id.sql?raw';
import apiCallDedupIndexSql from './migrations/0012-api-call-dedup-index.sql?raw';
import { DbError } from './errors';
import type { SqliteDatabase } from './sqlite';

/** One numbered migration file. `version` is what `PRAGMA user_version` becomes once applied. */
export interface Migration {
  readonly version: number;
  /** The file's basename, for the failure message and for `db-migration-review`. */
  readonly name: string;
  readonly sql: string;
}

/**
 * The ordered registry. A new schema change is a NEW entry with a NEW numbered file;
 * ⚠️ merged migration files are IMMUTABLE (STACK ADR-007, §3.18). Editing `0001-initial.sql`
 * after it has shipped leaves already-migrated databases silently divergent from new ones.
 */
export const MIGRATIONS: readonly Migration[] = [
  // §3.2–§3.17 is migration 0001 and must match it exactly (§3 preamble, §3.18).
  { version: 1, name: '0001-initial.sql', sql: initialSql },
  // A-09 — `tool_calls.description`, the column §3.7 and §5.4 rule 9 both assumed and §3.6
  // never declared. A new file rather than an edit to 0001, because 0001 is merged (ADR-007).
  { version: 2, name: '0002-tool-call-description.sql', sql: toolCallDescriptionSql },
  // E10 — `harness_nodes.entry_count`, the number §6.9's memory browser and §4.5's
  // `q:memories` both promise and §3.10's DDL never declared. See the file header for the
  // counting rule and for why it is stated rather than inferred.
  { version: 3, name: '0003-harness-node-entry-count.sql', sql: harnessEntryCountSql },
  // ADR-039 — `harness_nodes.project_id` and `harness_run_agents`. The harness now includes each
  // project's own `<project>/.claude/**` and root `CLAUDE.md`, and the runtime overlay reads a
  // run's agent type from the `agent-*.meta.json` sidecar when §3.7's spawn linkage does not
  // resolve. See the file header for both, and for why nothing under a project directory may be
  // written, flagged or counted as bloat.
  { version: 4, name: '0004-project-harness.sql', sql: projectHarnessSql },
  // A-05 — the FIFTH token class. `events.tok_cache_write_1h`,
  // `file_manifest.cache_split_mismatches`, and `cache_write_1h` admitted into
  // `price_rows.token_class`'s CHECK. See the file header for the evidence, the naming rule and
  // why the new token column is nullable. 0001–0004 are untouched (ADR-007).
  { version: 5, name: '0005-cache-write-1h.sql', sql: cacheWrite1hSql },
  // §3.3/§3.5 (amended 2026-07-22) — the project name is the folder's real name, re-derived
  // from `events.cwd`, because decoding `encoded_name` is lossy and named `Home-Media-Server`
  // "Server". No schema change: it re-derives values that are already stored, deletes nothing and
  // re-parses nothing. The same statement runs at FINALIZING; this file only corrects databases
  // that already exist. See the file header.
  { version: 6, name: '0006-project-display-name-from-cwd.sql', sql: projectDisplayNameSql },
  // ADR-040 / §3.19 — `project_groups` and `project_group_members`, both USER class. The user
  // can say "these two folders are the same project"; the app still never guesses one.
  // ⚠️ Membership keys on `encoded_name`, never on `projects.id`, because `projects` is DERIVED
  // and a rebuild gives every folder a new id. See the file header for the full reasoning.
  { version: 7, name: '0007-project-groups.sql', sql: projectGroupsSql },
  // §3.7/§5.4 (amended 2026-07-22) — `subagent_runs.meta_agent_type` / `meta_tool_use_id` /
  // `meta_description`, the run's own `agent-*.meta.json` sidecar stored verbatim. §3.7's
  // `parent_uuid` → `uuid` rule resolves for 0 of 2,514 runs on real data because a subagent
  // transcript's first event has no `parent_uuid` at all; the sidecar is the structural source
  // that does resolve. Attribution is unchanged, linkage is still disclosed when it genuinely
  // fails, and no heuristic was added. See the file header.
  { version: 8, name: '0008-subagent-spawn-sidecar.sql', sql: subagentSpawnSidecarSql },
  // ADR-041 / §2.2 / §3.2 / §3.4 / §3.18 (amended 2026-07-22) — permanent history retention for
  // ORPHANED transcripts. `file_manifest.retained_orphan` and `sessions.retained_orphan`, a
  // SECOND road into the RETAINED class distinct from `archive_id`: the file is gone, not moved,
  // so there is no `archives` row and nothing to undo. The purge (§3.18) now spares these rows
  // alongside archived ones, so a `claudeDir` change or a rebuild no longer silently shrinks
  // lifetime totals when a file has vanished. See the file header and ADR-041.
  { version: 9, name: '0009-retain-orphaned-history.sql', sql: retainOrphanedHistorySql },
  // §6.7 / §1a — `harness_nodes.version`. A plugin cache can hold two versions of the same plugin
  // side by side, each shipping a same-named skill; both are genuinely distinct nodes (§3.10 node
  // identity), so both survive — but the Harness Map drew them with the SAME label. The plugin's
  // own version, read from `plugin.json`, is the plain distinguisher `harnessGraph()` uses to
  // qualify ONLY the labels that collide. NOT part of node identity. See the file header.
  { version: 10, name: '0010-harness-node-version.sql', sql: harnessNodeVersionSql },
  // §3.5/§3.2/§4.6 — `events.message_id` / `events.request_id`, plus `file_manifest`'s
  // `api_ids_from_line` watermark. Claude Code writes one assistant turn as several JSONL lines
  // that share one `message.id` and repeat the identical `usage`; line-level identity (ADR-019)
  // is correct and every one of those lines is counted, so one API call is charged N times.
  // ⚠️ This migration MEASURES that and changes no number: no metric definition, no costed
  // population, no token sum. The watermark exists so "none found" and "not checked" can never
  // be the same number. See the file header.
  { version: 11, name: '0011-api-call-id.sql', sql: apiCallIdSql },
  // ADR-042 / §3.5 / §5.9 M-02/M-04/M-05 — the covering index the "one row per API call" seam
  // seeks on. 0011 MEASURED repeated usage; ADR-042 now sums each call once, at query time, using
  // its final line's authoritative usage (`src/main/db/repositories/api-call-usage.ts`). This
  // index answers the seam's anti-join ("no later line of my own call exists") from the index
  // alone. Additive, changes no number by itself. See the file header. 0001–0011 untouched.
  { version: 12, name: '0012-api-call-dedup-index.sql', sql: apiCallDedupIndexSql },
];

/** The version the code expects a fully migrated database to be at. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

/** Reads `PRAGMA user_version`. 0 on a database that has never been migrated. */
export function currentSchemaVersion(db: SqliteDatabase): number {
  const value = db.pragma('user_version', { simple: true });
  return typeof value === 'number' ? value : Number(value);
}

export interface MigrationOutcome {
  readonly from: number;
  readonly to: number;
  /** Names of the files applied by this call. Empty when the database was already current. */
  readonly applied: readonly string[];
}

/**
 * Applies every migration numbered above `PRAGMA user_version`, in order, inside ONE
 * transaction (STACK ADR-007). Running it against an already-current database is a no-op.
 *
 * One transaction rather than one per file is deliberate: §9.6 promises the database is
 * untouched after a failure, and a per-file transaction would leave a half-migrated schema
 * behind when file N+1 of a set fails. `better-sqlite3` rolls the whole thing back on throw.
 *
 * `PRAGMA user_version` is set inside the same transaction as the DDL that earns it, so the
 * version can never claim a schema that is not there.
 */
export function migrate(db: SqliteDatabase): MigrationOutcome {
  const from = currentSchemaVersion(db);
  const pending = MIGRATIONS.filter((migration) => migration.version > from).toSorted(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) return { from, to: from, applied: [] };

  const apply = db.transaction((): void => {
    for (const migration of pending) {
      // `PRAGMA user_version` takes no bound parameter, so the value is interpolated. It is
      // an integer from the registry above and is asserted as one before it reaches SQL.
      if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
        throw new Error(`migration version must be a positive integer: ${migration.version}`);
      }
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${String(migration.version)}`);
    }
  });

  try {
    apply();
  } catch (cause) {
    // The transaction has already rolled back: the database is exactly as it was. We report
    // and stop. We do NOT drop, rebuild, re-sync or "recover" (§9.6, ADR-026) — the app goes
    // to FATAL (§5.1, §6.11) and the fatal screen offers no reset button.
    const names = pending.map((migration) => migration.name).join(', ');
    throw new DbError(
      'E_DB_MIGRATION_FAILED',
      'The database schema could not be updated, so no change was made to your data.' +
        ` (pending: ${names})`,
      { cause, retryable: false },
    );
  }

  const to = currentSchemaVersion(db);
  return { from, to, applied: pending.map((migration) => migration.name) };
}

/**
 * Opens-and-migrates in one step is deliberately NOT provided here: `openDatabase` is the
 * connection seam (§3.1.7 pragmas) and `migrate` is the schema seam. E6 wires them together
 * once, at startup, so there is exactly one place that decides a migration may run.
 */
export function assertSchemaCurrent(db: SqliteDatabase): void {
  const version = currentSchemaVersion(db);
  if (version !== LATEST_SCHEMA_VERSION) {
    throw new DbError(
      'E_DB_MIGRATION_FAILED',
      'The database schema is not at the version this build expects.',
      { retryable: false },
    );
  }
}
