// Path → identity. DESIGN §5.4 rules 4/5/6, §3.2 `kind`, ADR-020.
//
// ⚠️ This module is the whole of "structural beats declared" (§5.12). A transcript record
// carries its own `sessionId` and its own `isSidechain`, and BOTH may disagree with the file
// they live in. The file path wins, every time, and this is the only place that decision is
// made — so it cannot be made differently somewhere else.
//
// Pure: strings in, strings out. It never touches the filesystem and never resolves a root
// (INV-17). Every caller passes a POSIX path already made relative to the Claude data
// directory (§3.1.4).

/** §3.2 — the `file_manifest.kind` CHECK, transcribed. */
export const FILE_KINDS = [
  'transcript',
  'subagent_transcript',
  'history',
  'stats_cache',
  'skill_md',
  'agent_md',
  'claude_md',
  'settings_json',
  'plugin_manifest',
  'memory_md',
  'other',
] as const;

export type FileKind = (typeof FILE_KINDS)[number];

/**
 * The kinds this epic's parser knows how to read. Everything else is discovered, classified
 * and (for the config kinds) left to the harness scanner in E10 — never silently dropped.
 */
export const PARSED_FILE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'transcript',
  'subagent_transcript',
  'history',
  'stats_cache',
]);

/** §5.4 rule 4 / ADR-020 — the partition column, decided by the path and nothing else. */
export type Origin = 'main' | 'subagent';

/** A transcript file: `projects/<encoded>/…`. Carries the §5.4 rules 4–6 answers. */
export interface TranscriptSource {
  readonly kind: 'transcript' | 'subagent_transcript';
  readonly relPath: string;
  /** §5.4 rule 5 — from the PATH, never from the record body (§5.12). */
  readonly sessionId: string;
  /** §5.4 rule 6 — the literal `projects/<encoded>` directory name (§3.3 identity). */
  readonly encodedProject: string;
  /** §5.4 rule 4 — `'subagent'` iff under `.../<session-id>/subagents/` (ADR-020). */
  readonly origin: Origin;
}

/** Top-level `history.jsonl` — prompts, not events (§3.9). */
export interface HistorySource {
  readonly kind: 'history';
  readonly relPath: string;
}

/** Top-level `stats-cache.json` — coverage metadata only (§3.16, ADR-029). */
export interface StatsCacheSource {
  readonly kind: 'stats_cache';
  readonly relPath: string;
}

export type LineSource = TranscriptSource | HistorySource;
export type ParseSource = TranscriptSource | HistorySource | StatsCacheSource;

const HISTORY_REL_PATH = 'history.jsonl';
const STATS_CACHE_REL_PATH = 'stats-cache.json';
const PROJECTS_DIR = 'projects';
const SUBAGENTS_DIR = 'subagents';

/**
 * Splits a POSIX relative path, rejecting anything that escapes or is not relative.
 * Returns `null` rather than throwing: an odd path is a file we do not parse, not an error.
 */
function segmentsOf(relPath: string): string[] | null {
  if (relPath === '' || relPath.startsWith('/')) return null;
  const segments = relPath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return segments;
}

/**
 * §5.4 rules 4–6 — the identity of one parseable source file, or `null` when the path is not
 * one this parser reads.
 *
 * ⚠️ §5.4 rule 5 says a subagent transcript's session id is "the name of the parent
 * directory". Read literally that is `subagents`, which is not a session id. §3.7 and ADR-020
 * both spell the layout out as `projects/<proj>/<session-id>/subagents/*.jsonl`, so the
 * session id is the segment immediately **before** `subagents/`. Resolved against the two
 * sections that state the layout explicitly rather than against the shorthand.
 */
export function describeSourceFile(relPath: string): ParseSource | null {
  const segments = segmentsOf(relPath);
  if (segments === null) return null;

  if (segments.length === 1) {
    if (segments[0] === HISTORY_REL_PATH) return { kind: 'history', relPath };
    if (segments[0] === STATS_CACHE_REL_PATH) return { kind: 'stats_cache', relPath };
    return null;
  }

  if (segments[0] !== PROJECTS_DIR) return null;
  const fileName = segments[segments.length - 1] ?? '';
  if (!fileName.endsWith('.jsonl')) return null;

  const encodedProject = segments[1];
  if (encodedProject === undefined) return null;

  // `projects/<encoded>/<session-id>.jsonl` — the main transcript (§2.1 "Session").
  if (segments.length === 3) {
    return {
      kind: 'transcript',
      relPath,
      sessionId: fileName.slice(0, -'.jsonl'.length),
      encodedProject,
      origin: 'main',
    };
  }

  // `projects/<encoded>/<session-id>/subagents/…` — ADR-020. The check is on the PATH, at
  // the one position the layout puts it; a `subagents` directory anywhere else is not this.
  if (segments.length >= 5 && segments[3] === SUBAGENTS_DIR) {
    const sessionId = segments[2];
    if (sessionId === undefined || sessionId === '') return null;
    return { kind: 'subagent_transcript', relPath, sessionId, encodedProject, origin: 'subagent' };
  }

  return null;
}

/**
 * §3.2 — the manifest `kind` for any discovered path. Everything that is not one of the
 * parsed kinds still gets classified rather than dropped, because Bloat Radar (§5.11) and
 * the harness scanner (§3.10) read the same manifest.
 */
export function classifyFileKind(relPath: string): FileKind {
  const parsed = describeSourceFile(relPath);
  if (parsed !== null) return parsed.kind;

  const segments = segmentsOf(relPath);
  if (segments === null) return 'other';
  const fileName = segments[segments.length - 1] ?? '';

  if (fileName === 'SKILL.md') return 'skill_md';
  if (fileName === 'CLAUDE.md' || fileName === 'CLAUDE.local.md') return 'claude_md';
  if (fileName === 'MEMORY.md') return 'memory_md';
  if (fileName === 'settings.json' || fileName === 'settings.local.json') return 'settings_json';
  if (fileName === 'plugin.json' || fileName === 'marketplace.json') return 'plugin_manifest';
  if (segments[0] === 'agents' && fileName.endsWith('.md')) return 'agent_md';
  return 'other';
}

/**
 * §3.3 (AMENDED 2026-07-22) — the **fallback** display name, and no longer the primary one.
 *
 * The encoding replaces every non-alphanumeric character with `-`, so decoding it is lossy and
 * ambiguous: `-work-demo-my-app` decodes to a path whose last segment reads `app`, and there is
 * no way to tell that from a real folder called `my-app`. On real data that
 * named `Home-Media-Server` "Server" and `Photo-Booth` "Booth" — wrong, and wrong in a way this
 * function cannot fix, because the characters are simply gone.
 *
 * The name is therefore re-derived from `events.cwd` at FINALIZING
 * (`RECOMPUTE_PROJECT_DISPLAY_NAMES`, src/main/db/repositories/ingest-repo.ts), which is the
 * only unambiguous source. This function is what a project with **no usable `cwd`** falls back
 * to, and it is written at insert time because a project row exists before its events do. It
 * must therefore never return an empty string: no project is ever left unnamed.
 *
 * ⚠️ Unchanged: the encoded name is the identity, two projects may share a `display_name` and
 * still be two projects, and the UI disambiguates with the encoded name in a tooltip. Nothing
 * joins, groups or counts on this value.
 */
export function displayNameForEncodedProject(encodedName: string): string {
  const decoded = encodedName.replaceAll('-', '/');
  const segments = decoded.split('/').filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  // Never an empty label: an all-separator name falls back to its own identity.
  return last === undefined || last === '' ? encodedName : last;
}

/**
 * The `projects/<encoded>` directory name a filesystem path would be encoded as.
 *
 * Used **only** to resolve `prompts.raw_project` (a literal value out of `history.jsonl`) onto
 * an existing project row. §3.9 makes the failure case first-class — `project_id` stays NULL
 * and `raw_project` is kept verbatim — so this is a best-effort match, never an assertion, and
 * it never creates a project.
 */
export function encodeProjectPath(path: string): string {
  return path.replaceAll('/', '-');
}
