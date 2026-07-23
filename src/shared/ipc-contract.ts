// src/shared/ipc-contract.ts — THE typed channel map (DESIGN §4, ADR-031).
//
// There is no HTTP API, no port, no server (STACK ADR-003). Both the main process and the
// renderer compile against this one file, so IPC drift is a `typecheck` failure inside
// `npm run check` — which is exactly why `api-contract-sync` is `no` in the gate manifest
// (§4 preamble, ADR-031). It follows that this file must be COMPLETE, not a subset: a
// channel that lives only in a handler is a channel the compiler cannot police.
//
// Nothing here is environment-bound: no `node:`, no `electron`, no DOM. `src/shared/**` is
// imported by main, preload and renderer alike (INV-16, tsconfig.shared.json `"types": []`).
//
// This module is types-only apart from nothing at all — it emits no runtime values by design.

// ---------------------------------------------------------------------------
// §4.1 — The error contract, defined once, used everywhere
// ---------------------------------------------------------------------------

/**
 * The uniform envelope. **No exception ever crosses the IPC boundary** (ADR-031): every
 * `invoke` handler is wrapped by one `withResult()` helper and an uncaught throw becomes
 * `E_INTERNAL` with the stack in `detail`.
 *
 * ⚠️ Incompleteness is **never** an error. A partial or incomplete result is expressed in the
 * success payload as a disclosure (§4.6) — that is what keeps disclosures impossible to
 * swallow (§4.1 rule 4, CLAUDE.md §1).
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

/** §4.1 */
export interface AppError {
  code: ErrorCode; // the closed enum below
  message: string; // one sentence, user-facing, never a stack trace
  detail?: string; // developer detail; rendered only behind "Details"
  retryable: boolean; // whether the same call may succeed if repeated unchanged
}

/**
 * §4.1 — the CLOSED error enum, transcribed verbatim.
 *
 * The renderer never branches on `message`, only on `code` (§4.1 rule 2). `retryable: false`
 * errors must not be retried automatically by any caller (§4.1 rule 3).
 */
export type ErrorCode =
  // configuration & directory
  | 'E_NO_DIR' // claudeDir is not set
  | 'E_DIR_NOT_FOUND' // configured path does not exist or is not a directory
  | 'E_DIR_INVALID' // exists but has neither projects/ nor history.jsonl
  | 'E_DIR_UNREADABLE' // permission denied
  | 'E_UNKNOWN_SETTING'
  | 'E_INVALID_SETTING'
  // sync
  | 'E_SYNC_BUSY' // a sync cycle is already running and this request is not queueable
  | 'E_SYNC_CANCELLED'
  | 'E_SYNC_FAILED'
  // database
  | 'E_DB_MIGRATION_FAILED'
  | 'E_DB_CORRUPT'
  | 'E_DB_BUSY'
  // pricing
  | 'E_PRICE_OVERLAP' // the edit would overlap an existing validity range (INV-08)
  | 'E_PRICE_PRECISION' // rate has more than three decimal places of USD/Mtok
  | 'E_PRICE_RANGE' // valid_to <= valid_from
  | 'E_PRICE_NOT_FOUND'
  | 'E_FETCH_NO_URL'
  | 'E_FETCH_NETWORK'
  | 'E_FETCH_HTTP'
  | 'E_FETCH_TIMEOUT'
  | 'E_FETCH_SHAPE' // response did not validate against the §4.7 schema
  // guarded actions
  | 'E_ACTION_UNKNOWN' // action_type not in the closed catalogue (ADR-032)
  | 'E_ACTION_TARGET_GONE'
  | 'E_ACTION_TARGET_FORBIDDEN' // e.g. inside the backup root
  | 'E_ACTION_NOT_CONFIRMED'
  | 'E_ACTION_BACKUP_FAILED'
  | 'E_ACTION_PARTIAL'
  | 'E_ACTION_NOTHING_TO_UNDO'
  | 'E_ACTION_BACKUP_MISSING'
  // archiving (ACT-07)
  | 'E_ARCHIVE_NO_ROOT' // archiveRoot is not set
  | 'E_ARCHIVE_ROOT_INVALID' // missing, unwritable, or inside/parent of claudeDir (INV-19)
  | 'E_ARCHIVE_UNREACHABLE' // the archive root is not currently readable (undo only)
  | 'E_ARCHIVE_COLLISION' // a file already exists at the destination path
  | 'E_ARCHIVE_VERIFY_FAILED' // moved file's size/mtime does not match the move manifest
  // generic
  | 'E_INTERNAL';

// ⚠️ The `E_PRICE_PRECISION` comment above says "three decimal places" because §4.1 says so
// verbatim. ADR-023 was AMENDED the same day to **six** decimal places of USD/Mtok
// (picoUSD/token); §3.11 and §5.9 F-10 both state six. The authoritative number is SIX, and
// `src/shared/money.ts` implements six. The stale comment is transcribed rather than silently
// corrected, per CLAUDE.md §2 ("cite, do not re-argue"); it is reported, not fixed here.

// ---------------------------------------------------------------------------
// §4.2 — Shared request types
// ---------------------------------------------------------------------------

/** §4.2 — the top-bar `(project set, date range)` selection (§2.1 "Global filter"). */
export interface GlobalFilter {
  // ⚠️ **Project UNIT ids** (ADR-040), not always `projects.id`: a group is `-groupId`. They are
  // expanded to the real project ids exactly once, in `DatasetService.queryContext()`, so no
  // repository has to know about grouping to be filtered correctly.
  projectIds: number[] | null; // null = all projects
  from: number | null; // UTC epoch ms, inclusive; null = unbounded
  to: number | null; // UTC epoch ms, exclusive; null = unbounded
}

/**
 * §4.2 — `limit: 1..500`, default 100. `limit > 500` is rejected with `E_INVALID_SETTING`.
 * Cursors are opaque, server-built strings encoding the last row's sort key; **the renderer
 * never constructs one.**
 */
export interface Page {
  cursor?: string;
  limit: number;
}

/** §4.2 — no IPC response may exceed 2 MB (§8.6); a handler that would returns a page. */
export interface Paged<T> {
  rows: T[];
  nextCursor: string | null;
  totalKnown: number | null;
}

// ---------------------------------------------------------------------------
// §4.3 — Bootstrap and settings
// ---------------------------------------------------------------------------

/** §4.3 */
export type DirStatus = 'unset' | 'valid' | 'not_found' | 'invalid' | 'unreadable';

/** §4.3 */
export interface DirValidation {
  status: DirStatus;
  hasProjects: boolean;
  hasHistory: boolean;
  transcriptFileCount: number; // counted, not estimated; 0 is legal
  reason?: string; // present when status !== 'valid'
}

/** §4.3 — §5.9 M-16 */
export interface DataCoverage {
  transcriptsFrom: number | null;
  transcriptsTo: number | null;
  promptsFrom: number | null;
  promptsTo: number | null;
  partialBefore: number | null; // ms; prompts exist before this, transcripts do not
  statsCacheDays: number;
}

/**
 * §4.3 references `SettingsSnapshot` but does not spell it out.
 * **Derived from the §3.13 `settings` key table** (the eight keys, their declared types and
 * their defaults) — one field per key, so `SettingKey` cannot drift from the snapshot.
 * Unknown keys are ignored on read and rejected on write with `E_UNKNOWN_SETTING` (§3.13);
 * an invalid value never reaches the table (`E_INVALID_SETTING`).
 */
export interface SettingsSnapshot {
  claudeDir: string | null; // default null ⇒ onboarding (§6.2). Validated on set.
  idleGapMinutes: number; // default 15; 5–60, step 5. Active time ONLY (INV-05).
  theme: ThemePreference; // default 'system'; applied as data-theme (§6.1)
  priceFetchUrl: string; // default ''. Ships empty by decision (§11.3, §7.5).
  archiveRoot: string | null; // default null ⇒ ACT-07 unavailable. Validated (INV-19).
  lastGlobalFilter: GlobalFilter; // restored on launch; never written mid-interaction
  sidebarCollapsed: boolean; // default false (FRONTEND §4)
  reduceMotionOverride: ReduceMotionPreference; // default 'system' (FRONTEND §7)
  // ⚠️ ADR-041 (2026-07-22). When TRUE (the default), a transcript that disappears from the
  // Claude data directory keeps its parsed history instead of being deleted (§5.3 `MISSING`
  // becomes retained-orphan, §2.2 RETAINED). Default TRUE because the app's bar is "never
  // destroys data" (PRD "What matters" #4) and it "never auto-deletes anything" (non-goal #4);
  // deleting derived history because a file vanished is the same violation. FALSE restores the
  // pure-mirror delete-and-cascade behaviour (§3.13).
  retainOrphanedHistory: boolean; // default true (ADR-041)
}

/** §3.13 */
export type ThemePreference = 'system' | 'dark' | 'light';

/** §3.13 (FRONTEND §7) */
export type ReduceMotionPreference = 'system' | 'reduce' | 'full';

/**
 * §4.3 / §3.13 — the closed set of writable setting keys. Keyed off `SettingsSnapshot` so a
 * key added to one is a compile error in the other.
 */
export type SettingKey = keyof SettingsSnapshot;

/** §4.3 — `app:bootstrap` response. */
export interface AppBootstrap {
  schemaVersion: number;
  settings: SettingsSnapshot;
  dirStatus: DirStatus;
  sync: SyncState;
  coverage: DataCoverage;
  disclosures: Disclosures;
}

/** §4.3 — `dir:pick` response. Cancellation is data, not an error. */
export type DirPickResult =
  { cancelled: true } | { cancelled: false; path: string; validation: DirValidation };

// ---------------------------------------------------------------------------
// §4.4 — Sync
// ---------------------------------------------------------------------------

/** §4.4 (§5.2 SM-2) */
export type SyncPhase = 'idle' | 'scanning' | 'parsing' | 'finalizing' | 'cancelling' | 'failed';

/** §4.4 */
export type SyncKind = 'incremental' | 'full';

/**
 * §4.4 — `sync:start` while a cycle is running does **not** fail: it sets `queuedRescan` and
 * returns the current state. `E_SYNC_BUSY` is reserved for `kind: 'full'` requested during a
 * running cycle, which cannot be coalesced.
 */
export interface SyncState {
  phase: SyncPhase;
  kind: SyncKind | null;
  startedAt: number | null;
  filesTotal: number;
  filesDone: number;
  recordsIngested: number;
  badLines: number;
  queuedRescan: boolean; // a watcher event arrived mid-cycle (§5.2)
  lastCompletedAt: number | null;
  lastDurationMs: number | null;
  error: AppError | null;
}

// ---------------------------------------------------------------------------
// §4.5 — Analytics queries: shared payload types
// ---------------------------------------------------------------------------

/**
 * §4.5 — §5.9 M-04: always **five** numbers, never one.
 *
 * ⚠️ **AMENDED 2026-07-22 (A-05) — four became five.** `cacheWrite` is the **5-minute** class
 * (`message.usage.cache_creation.ephemeral_5m_input_tokens`) and `cacheWrite1h` is the 1-hour
 * one. They are priced independently — 1.25x input and 2x input on today's published page — and
 * both are **stored, never derived** from each other (§1.7, ADR-024).
 */
export interface TokenBreakdown {
  input: number;
  output: number;
  /** The **5-minute** cache-write class. Not "all cache writes" — add `cacheWrite1h` for that. */
  cacheWrite: number;
  /** The **1-hour** cache-write class (A-05). Rows whose split is unknown contribute `0`. */
  cacheWrite1h: number;
  cacheRead: number;
}

/**
 * §4.5.
 *
 * ⚠️ **`archiveId` / `archiveRoot` are provenance, not a metric** (§4.5 as amended 2026-07-22
 * (E9); §3.4, ADR-033). §6.5's Degraded row requires archived sessions to carry a **neutral**
 * "archived" badge *naming the archive root*, and no §4.5 payload could support it: `isPartial`
 * was the only provenance a session carried, and `archives:list` (§4.8) knows the archive roots
 * and their date ranges but not which session ids belong to them. These two fields close that
 * gap from the columns that already hold the answer — `sessions.archive_id` joined to
 * `archives.archive_root` (the DESTINATION directory, §3.2 as amended by E10).
 *
 * ⚠️ They are the **only** fields on this row that an ACT-07 changes. INV-18 is untouched: every
 * number here is byte-identical before and after archiving, which is exactly why the badge is
 * neutral rather than a warning.
 */
export interface SessionRow {
  id: string;
  projectId: number;
  displayName: string;
  colorIndex: number;
  primaryModel: string | null;
  firstTs: number;
  lastTs: number;
  spanSeconds: number;
  activeSeconds: number; // M-07 binding (A), single session
  messages: number;
  toolCalls: number;
  subagentRuns: number;
  tokens: TokenBreakdown;
  costNanoUsd: number | null;
  isPartial: boolean;
  archiveId: number | null; // null = live (§3.4 `sessions.archive_id`, ADR-033)
  archiveRoot: string | null; // the destination directory; null = live (§3.15, §9.3)
}

/** §4.5 */
export type SessionSort =
  'firstTs' | 'activeSeconds' | 'spanSeconds' | 'outputTokens' | 'messages' | 'toolCalls';

/** §4.5 — one linked-or-unlinked subagent run inside a session drill-down (§3.7). */
export interface SessionDetailSubagentRun {
  id: number;
  subagentType: string | null;
  description: string | null;
  firstTs: number;
  lastTs: number;
  linked: boolean;
  tokens: TokenBreakdown;
}

/**
 * §4.5.
 *
 * ⚠️ **The one place §4.5 does not compile as written, resolved rather than guessed.** §4.5
 * declares `interface SessionDetail extends SessionRow` while redeclaring `subagentRuns` from
 * `number` (the count, on `SessionRow`) to the object array below. TypeScript rejects a widening
 * redeclaration in an `extends` clause, so the literal transcription is not a legal type.
 * Resolution: `extends Omit<SessionRow, 'subagentRuns'>`. That keeps **every field name §4.5
 * writes**, keeps the drill-down's list (which is plainly the intent of §6.5's drill-down), and
 * changes no wire shape — a `SessionDetail` still carries exactly the §4.5 field set. Reported
 * as a design defect rather than silently reinterpreted (CLAUDE.md §2).
 */
export interface SessionDetail extends Omit<SessionRow, 'subagentRuns'> {
  gitBranch: string | null;
  cliVersion: string | null;
  originSplit: { main: TokenBreakdown; subagent: TokenBreakdown };
  toolCounts: { toolName: string; count: number }[];
  subagentRuns: SessionDetailSubagentRun[];
  uncosted: UncostedSummary;
}

/**
 * §4.5 — one **project unit** (§2.1, ADR-040).
 *
 * ⚠️ `projectId` is a unit id, not always a `projects.id`: it is the project's own id when the
 * project stands alone, and `-groupId` when the user has said this folder is the same project as
 * another. `projects.id` is a rowid alias and always `>= 1`, so the two spaces never collide.
 * Everything downstream — the filter, the treemap, the cost breakdown, the leaderboard — speaks
 * unit ids, because the user asked for a group to behave as one project everywhere.
 */
export interface ProjectCard {
  projectId: number;
  displayName: string;
  /** ⚠️ `null` for a group: a group is not a directory and has no folder name of its own. */
  encodedName: string | null;
  colorIndex: number;
  sessions: number;
  outputTokens: number;
  costNanoUsd: number | null;
  toolCalls: number;
  activeSeconds: number; // M-07 binding (C) over the UNIT's working days (ADR-040)
  editSparkline: number[]; // 12 buckets of edit counts over the filtered range
  /** Non-null when the user grouped these folders together (§3.19). */
  groupId: number | null;
  /**
   * The folders inside this card, each with the numbers it has **on its own**. One entry for a
   * lone project, N for a group.
   * ⚠️ **`members[].activeSeconds` does NOT sum to `activeSeconds`, and must never be presented
   * as if it did** (ADR-040): once two folders are one project, the gaps between them on a shared
   * day fall inside one partition and are capped-and-counted instead of being dropped. §6.8 says
   * this on screen, in plain words.
   */
  members: ProjectCardMember[];
}

/** §4.5 — one folder inside a `ProjectCard` (§6.8). */
export interface ProjectCardMember {
  projectId: number;
  displayName: string;
  encodedName: string;
  colorIndex: number;
  outputTokens: number;
  sessions: number;
  toolCalls: number;
  /** This folder's own active time, as if it had never been grouped (ADR-040). */
  activeSeconds: number;
}

/**
 * §4.5 — one group the user created: "these folders are the same project" (§3.19, ADR-040).
 *
 * ⚠️ Membership is a list of `encoded_name`s, which is the project identity (§3.3). It is NEVER
 * a list of `projects.id`: `projects` is DERIVED and a purge-and-rebuild renumbers every row, so
 * an id-keyed group would silently re-point at the wrong folders after a rebuild.
 */
export interface ProjectGroup {
  id: number;
  name: string;
  colorIndex: number;
  createdAt: number;
  members: ProjectGroupMember[];
}

/** §4.5 — one folder named by a group. */
export interface ProjectGroupMember {
  /** §3.3 — the identity, always present. */
  encodedName: string;
  /** `null` when no project with that folder name is currently present. */
  projectId: number | null;
  /** `null` when the folder is not currently present — shown as such, never hidden. */
  displayName: string | null;
}

/** §4.5 — ⛔ INV-13: `invocations` and `lastUsedTs` are ALL TIME, never filtered. */
export interface SkillRow {
  name: string;
  source: 'user' | 'plugin';
  pluginName: string | null;
  relPath: string;
  sizeBytes: number;
  invocations: number; // ALL TIME, never filtered (INV-13)
  lastUsedTs: number | null; // ALL TIME
  neverUsed: boolean;
}

/** §4.5 */
/**
 * ⚠️ AMENDED 2026-07-22 (E12) — `meta`, the string-carrying half of a graph node.
 *
 * §4.5 gave `GraphNode` a `metrics: Record<string, number>` and nothing else that can hold text.
 * Two things §3.9/§3.10/§6.7 require of the §6.7 inspector therefore had **no route to the
 * renderer at all**:
 *
 *   1. **The prompt preview.** §3.9 and §6.7 both say the graph inspector is the only place in
 *      the app a prompt preview (≤280 chars) may appear, and `NodeInspector` implements and
 *      tests the cap — but no §4.5 payload carried the text, so the feature was unreachable in
 *      the running app. `prompts.display_preview` now arrives as `meta.promptPreview`.
 *   2. **`description`, `rel_path` and `source`** — all three are columns of §3.10's
 *      `harness_nodes` and all three are what the Harness Map inspector's "key/value rows"
 *      (§6.7) are for. `GraphNode` dropped every one of them.
 *
 * ⚠️ **The 280-character cap is enforced in the repository, not here and not in the component.**
 * It is a product boundary (§1.6 non-goal 1 — this is not a transcript reader; §3.9 —
 * `pastedContents` is never stored in any form), so no oversized text may cross IPC in the first
 * place. `NodeInspector`'s own `slice` stays as a second, independent guard at the only surface
 * that renders it.
 *
 * ⚠️ `Record<string, string>` and not a fixed shape, deliberately: the four tabs describe
 * genuinely different objects, and a union of four node types would put the tab's identity into
 * the wire format, which §4.5 does not do. Every value is inert text rendered into a text node
 * (§3.10, ADR-017).
 */
export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  colorIndex: number;
  role?: string;
  metrics: Record<string, number>;
  /**
   * Text-valued facts about the node. Absent when the node has none.
   *
   * ⚠️ The one key with a rule attached is **`promptPreview`**: it is `prompts.display_preview`,
   * capped at 280 characters **by the repository that produced it** (§3.9). No other key on any
   * node carries transcript text.
   *
   * ⚠️ This module stays **types-only** and emits no runtime values (see `src/preload/index.ts`),
   * so the cap is not a constant here. The main side reads `PROMPT_PREVIEW_CHARS` from
   * `src/main/parse/parse-line.ts` — §3.9's one definition — and the renderer keeps its own
   * independent guard at the single surface that renders it.
   */
  meta?: Record<string, string>;
}

/**
 * §4.5 — ⚠️ `designed` and `observed` are separate fields **on purpose**. The Harness Map's
 * whole value is designed-vs-actual; collapsing them into one number destroys it.
 * `designed: false, observed > 0` is a legal and interesting state — a call that happens but
 * is not declared (§5.9 M-14).
 */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  evidence?: 'frontmatter' | 'body_mention' | 'directory';
  designed: boolean;
  observed: number; // observed = runtime overlay
}

/** §4.5 */
export interface TraceSpan {
  id: string;
  kind: 'main' | 'subagent' | 'tool';
  label: string;
  startTs: number;
  endTs: number;
  depth: number;
}

// ---------------------------------------------------------------------------
// §4.5 — Analytics queries: per-channel response payloads
// ---------------------------------------------------------------------------
//
// ⚠️ AMENDED 2026-07-22 (E1) — three §4.5 rows carried a `$` figure with no `UncostedSummary`:
// `q:tokensByProject`, `q:projectCards` and `q:sessions`. **INV-10 wins and the field is added
// to all three**, because §1.5 makes a disclosure "a first-class query result, not a log line"
// and INV-10 states the rule absolutely — "it is impossible to render a cost without having its
// disclosure in hand". The §4.5 rows are an incomplete transcription of a rule stated twice
// elsewhere in stronger terms, not a deliberate exception, and the failure mode of leaving them
// alone is precisely the one this project exists to prevent: a `$` figure rendered with no way
// to know it was incomplete. Adding a field is a superset change; no consumer breaks.
// DESIGN §4.5 carries the matching amendment note.
//
// Two deliberate NON-additions, recorded here so nobody "completes the pattern" later:
//
//   · `q:projectCards` gets NO `overlapSeconds`. §6.8 proves M-20 is identically `0` for a
//     single-project scope (one partition per local day; distinct days' covered intervals
//     cannot intersect) — INV-22(d). The disclosure would always read "0 hours".
//   · `q:sessions` gets NO `overlapSeconds` either, and this is the non-obvious half:
//     `SessionRow.activeSeconds` is M-07 binding **(A)**, a single session, not binding (C).
//     INV-23 binds only multi-session binding-(C) figures, so it does not reach this payload.

/**
 * §4.5 `q:overviewTiles` (§6.3).
 * ⚠️ `activeSeconds` uses **M-07 binding (C)**: the sum of M-08 working-day values over the
 * filter (INV-21). `overlapSeconds` is **M-20**, its mandatory companion disclosure (INV-23).
 */
export interface OverviewTiles {
  outputTokens: number;
  costNanoUsd: number | null;
  activeSeconds: number;
  toolCalls: number;
  sessions: number;
  cacheReadTokens: number;
  distinctTools: number;
  uncosted: UncostedSummary; // INV-10
  overlapSeconds: number; // M-20, INV-23
}

/** §4.5 `q:activityCalendar` (§6.3) */
export interface ActivityCalendar {
  days: { day: string; messages: number }[];
}

/** §4.5 — the bucket granularity shared by the two timeline queries. */
export type TimelineBucket = 'day' | 'week';

/** §4.5 — one model's series within a timeline. */
export interface ModelSeries {
  model: string;
  colorIndex: number;
  data: number[];
}

/**
 * §4.5 `q:modelMixTimeline` (§6.3, §6.4) and `q:tokensByModel` (§6.4 — "same shape as above").
 * One type, so the two channels cannot drift.
 */
export interface ModelTimeline {
  buckets: string[];
  series: ModelSeries[];
}

/** §4.5 `q:tokensByModel` request mode. */
export type TokensByModelMode = 'all' | 'output_only';

/** §4.5 `q:tokensByProject` (§6.4 treemap) */
export interface TokensByProject {
  rows: {
    projectId: number;
    displayName: string;
    colorIndex: number;
    outputTokens: number;
    costNanoUsd: number | null;
  }[];
  /** INV-10 (AMENDED 2026-07-22, E1) — the rows carry `$`, so the envelope carries the
   *  disclosure. It is impossible to render one without the other. */
  uncosted: UncostedSummary;
}

/** §4.5 `q:cacheEfficiency` (§6.4 gauge) — `hitRatio` is §5.9 M-18, a ratio in [0,1]. */
export interface CacheEfficiency {
  cacheReadTokens: number;
  inputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  hitRatio: number;
}

/** §4.5 `q:costBreakdown` request grouping. */
export type CostBreakdownBy = 'model' | 'project' | 'day';

/** §4.5 `q:costBreakdown` (§6.4) */
export interface CostBreakdown {
  rows: { key: string; costNanoUsd: number; tokensByClass: TokenBreakdown }[];
  uncosted: UncostedSummary; // INV-10
}

/** §4.5 `q:sessionHistogram` (§6.5) */
export interface SessionHistogram {
  buckets: { label: string; lowerSeconds: number; upperSeconds: number | null; count: number }[];
}

/** §4.5 `q:rhythmHeatmap` (§6.5) */
export interface RhythmHeatmap {
  cells: { weekday: number; hour: number; events: number }[];
}

/**
 * §4.5 `q:workingDays` (§6.5 marathons).
 * ⚠️ **M-07 binding (B)**; these rows are the summands of binding (C) (INV-21).
 */
export interface WorkingDayRow {
  day: string;
  projectId: number;
  displayName: string;
  colorIndex: number;
  activeSeconds: number;
  spanSeconds: number;
  sessions: number;
}

/** §4.5 `q:sessions` sort direction. */
export type SortDirection = 'asc' | 'desc';

/**
 * §4.5 `q:sessions` (§6.5) — a page of sessions plus its disclosure.
 *
 * `Paged<T>` is the shared envelope of §4.2 and is deliberately NOT widened to carry a
 * disclosure: most paged payloads have no `$` figure, and putting `uncosted` on all of them
 * would make it optional, which is exactly the swallowable shape INV-10 exists to forbid.
 * This channel gets its own response type that embeds the page instead (AMENDED 2026-07-22, E1).
 *
 * ⚠️ No `overlapSeconds` here, and that is not an omission: `SessionRow.activeSeconds` is M-07
 * binding **(A)** — one session — not binding (C). INV-23 binds only multi-session
 * Active-hours figures, so it does not reach this payload.
 */
export interface SessionsPage {
  page: Paged<SessionRow>;
  /** INV-10 — `SessionRow.costNanoUsd` is a `$` figure, so the page carries its disclosure. */
  uncosted: UncostedSummary;
}

/** §4.5 `q:toolFingerprint` (§6.6) — §5.9 M-12 includes `Agent` and `Skill`. */
export interface ToolFingerprint {
  total: number;
  distinct: number;
  rows: { toolName: string; count: number; colorIndex: number }[];
}

/** §4.5 — one side of the origin split (§5.9 M-17). */
export type OriginTotals = TokenBreakdown & { messages: number; toolCalls: number };

/**
 * §4.5 `q:originSplit` (§6.6, §6.4) — the moment-of-value number.
 * `main + subagent` must equal the unpartitioned total exactly (INV-02).
 */
export interface OriginSplit {
  main: OriginTotals;
  subagent: OriginTotals;
  unlinkedRuns: number;
}

/** §4.5 `q:toolMixByProject` (§6.6) */
export interface ToolMixByProject {
  projects: {
    projectId: number;
    displayName: string;
    parts: { toolName: string; count: number; colorIndex: number }[];
  }[];
}

/**
 * §4.5 `q:projectCards` (§6.8).
 *
 * ⚠️ **No `overlapSeconds`, and this is provable rather than assumed** — do not "complete the
 * pattern" later. `ProjectCard.activeSeconds` is M-07 binding (C), but binding (C) restricted to
 * ONE project has exactly one partition per local day, and distinct days' covered intervals
 * cannot intersect, so M-20 is identically `0` for a single-project scope (INV-22(d)). §6.8
 * states this and omits the disclosure for exactly that reason: it would always read "0 hours".
 */
export interface ProjectCards {
  rows: ProjectCard[];
  /** INV-10 (AMENDED 2026-07-22, E1) — `ProjectCard.costNanoUsd` is a `$` figure. */
  uncosted: UncostedSummary;
}

/** §4.5 `groups:*` — every group the user has made, newest first. */
export interface ProjectGroups {
  rows: ProjectGroup[];
}

/** §4.5 `q:fileMetrics` (§6.8) — §5.9 M-15; `language` is `null` when unmapped ("other"). */
export interface FileMetricRow {
  path: string;
  basename: string;
  language: string | null;
  edits: number;
  lastTs: number;
}

/** §4.5 — the node/edge pair returned by `q:harnessGraph` and `q:toolTransition` (§6.7). */
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** §4.5 `q:executionTrace` (§6.7) — `unlinkedRuns` is a disclosure (§3.7, §4.6). */
export interface ExecutionTrace extends Graph {
  timeline: TraceSpan[];
  unlinkedRuns: number;
}

/** §4.5 `q:flowSankey` (§6.7) */
export interface FlowSankey {
  nodes: GraphNode[];
  links: { source: string; target: string; value: number }[];
}

/** §4.5 `q:skills` sort (§6.9). */
export type SkillSort = 'never_used' | 'invocations' | 'size' | 'name';

/** §4.5 `q:claudeMdFiles` (§6.9 CLAUDE.md inspector; BR-01's headline row). */
export interface ClaudeMdFiles {
  rows: {
    relPath: string;
    sizeBytes: number;
    mtimeMs: number;
    backups: { relPath: string; sizeBytes: number }[];
  }[];
}

/**
 * §4.5 references `MarketplaceRow` but does not spell it out.
 * **Derived from the §3.10 `harness_nodes` DDL** (`kind='marketplace'`: `id`, `name`,
 * `rel_path`, `size_bytes`, `mtime_ms`, `enabled`) plus the §6.9 surface description
 * "Plugins & marketplaces — enabled vs merely cached, with disk cost each". `pluginCount`
 * is the number of `contains` edges marketplace → plugin (§3.10 edge-derivation table).
 * `enabled` is `boolean | null` because the column is `NULL where not applicable`.
 */
export interface MarketplaceRow {
  id: number;
  name: string;
  relPath: string | null;
  sizeBytes: number;
  mtimeMs: number | null;
  enabled: boolean | null;
  pluginCount: number;
}

/**
 * §4.5 references `PluginRow` but does not spell it out.
 * **Derived from the §3.10 `harness_nodes` DDL** (`kind='plugin'`) plus §6.9 and BR-04
 * ("present under `plugins/` but absent from `settings.json` `enabledPlugins`" — which is
 * exactly `enabled = 0`, the "cached but not enabled" case the view exists to show).
 * `marketplaceName` comes from the `contains` marketplace → plugin edge (§3.10).
 */
export interface PluginRow {
  id: number;
  name: string;
  marketplaceName: string | null;
  relPath: string | null;
  sizeBytes: number;
  mtimeMs: number | null;
  enabled: boolean | null;
}

/** §4.5 `q:plugins` (§6.9) */
export interface PluginsAndMarketplaces {
  marketplaces: MarketplaceRow[];
  plugins: PluginRow[];
}

/** §4.5 `q:memories` (§6.9 memory browser) */
export interface Memories {
  rows: {
    relPath: string;
    projectId: number | null;
    sizeBytes: number;
    mtimeMs: number;
    entryCount: number;
  }[];
}

/**
 * §6.9 / ADR-039 — one project's own harness, for the Harness Manager's per-project sections.
 *
 * ⚠️ **Read-only by construction.** Every `relPath` here is relative to the PROJECT directory, not
 * the Claude data directory, so nothing in a project group is ever a guarded-action target —
 * ACT-01…07 operate only within the Claude data directory and ADR-039 does not widen them. The
 * renderer renders these rows with no action button, exactly as it must.
 *
 * ⚠️ ⛔ INV-13 — `invocations`, "last used" and "never used" are ALL TIME. This payload carries no
 * `GlobalFilter`, the same compile-time property as the four ⛔ channels above; grouping by which
 * project OWNS a node is not the same as filtering the counts by project.
 */
export interface ProjectHarnessAgent {
  name: string;
  relPath: string;
  sizeBytes: number;
}

/** §6.9 — a project's own `CLAUDE.md` / `.claude/CLAUDE.md`. No sibling-backup set: a project's
 * files are never walked for backups (they are outside the Claude data directory, ADR-039). */
export interface ProjectHarnessClaudeMd {
  relPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** §6.9 / ADR-039 — one project section's contents, grouped under its display name. */
export interface ProjectHarnessGroup {
  /** `projects.id` of the project this harness was declared in (§3.3). */
  projectId: number;
  /** §3.3 — the full folder name; cosmetic, never an identity. The naming fix already landed. */
  displayName: string;
  /** §3.3 — the project's identity, used to attribute Bloat Radar flags by their `location`. */
  encodedName: string;
  skills: SkillRow[];
  agents: ProjectHarnessAgent[];
  claudeMd: ProjectHarnessClaudeMd[];
  memories: Memories['rows'];
  plugins: PluginsAndMarketplaces;
}

/** §4.5 `q:harnessProjects` — §6.9's per-project sections (ADR-039). ⛔ INV-13 — all time. */
export interface HarnessProjects {
  rows: ProjectHarnessGroup[];
}

// ---------------------------------------------------------------------------
// §4.6 — Disclosures: incompleteness as data, never as a log line
// ---------------------------------------------------------------------------

/** §4.6 — §5.9 M-06. `records: 0` means the `$` figure is complete. */
export interface UncostedSummary {
  records: number; // 0 means the $ figure is complete
  byModel: { model: string; records: number; fromTs: number; toTs: number }[];
}

/** §4.6 */
export interface Disclosures {
  uncosted: UncostedSummary;
  badLines: number; // malformed JSON lines skipped across all files
  syntheticEvents: number; // <synthetic> assistant events excluded from stats
  unlinkedSubagentRuns: number;
  partialBefore: number | null; // prompts exist before this; transcripts do not
  filesMissingSinceLastSync: number;
  activeOverlapSeconds: number; // M-20; 0 means the Active-hours figure double-counts nothing
  /**
   * ⚠️ **A-05, 2026-07-22.** Cache-writing events stored before the 5-minute/1-hour split was
   * captured (`events.tok_cache_write_1h IS NULL`), in **live** sessions. Their whole cache-write
   * count is still costed at the 5-minute rate, which understates them. DERIVED data is
   * rebuildable, so this one is **recoverable**: a re-sync or a rebuild fills the split in.
   * `0` means every live cache-writing event carries a real split.
   */
  cacheSplitUnknownEvents: number;
  /**
   * ⚠️⚠️ **A-05 — the irreversible half.** The same condition, in **archived** sessions
   * (`archive_id IS NOT NULL`). Archived transcripts have left the Claude data directory and are
   * never re-parsed (§5.3 `ARCHIVED`, §9.4, ADR-034), so their 1-hour share can **never** be
   * recovered and they stay costed at the 5-minute rate permanently. Disclosed with its own
   * sentence for exactly that reason: a re-sync will not change this number.
   */
  cacheSplitArchivedEvents: number;
  /**
   * §5.4 rule 8 — records whose `ephemeral_5m + ephemeral_1h` did not equal their own
   * `cache_creation_input_tokens`. The parser trusts neither half, keeps the flat total in the
   * 5-minute class, marks the split unknown, and counts the record here (`file_manifest`).
   */
  cacheSplitMismatches: number;
  /**
   * ⚠️ ADR-041 (2026-07-22) — sessions kept from transcripts that are no longer in the Claude
   * data directory. Plain-language: *"N sessions kept from files no longer in your Claude folder
   * — their history is preserved here."* Their events, tokens, tool calls and active time still
   * count toward every total (INV-18); this number only explains WHY some sessions have no file
   * behind them. `0` means every session still has its transcript (or was archived, which is a
   * different disclosure). Computed UNFILTERED, like the A-05 counts above: it describes the
   * stored dataset, so a date range that excluded the orphaned sessions must not make the caveat
   * vanish (INV-13-style).
   *
   * ⚠️ Scope is WHOLE-FILE disappearance only. In-place compaction (a transcript Claude rewrites,
   * dropping old messages but keeping the file) is NOT covered by this count and its dropped
   * messages are not retained — see ADR-041's honest limit.
   */
  retainedOrphanSessions: number;
  /** ADR-041 — events kept from those orphaned transcripts. The session count above is the one a
   * human reads; this is its event-level companion, also UNFILTERED. */
  retainedOrphanEvents: number;
}

// ---------------------------------------------------------------------------
// §4.7 — Pricing
// ---------------------------------------------------------------------------

/**
 * §4.7 / §3.11 — exactly **five**, each priced independently and stored, never derived (§2.1).
 *
 * ⚠️ **AMENDED 2026-07-22 (A-05).** `cache_write` is the **5-minute** class and `cache_write_1h`
 * the 1-hour one. The 1.25x / 2x relationship to `input` holds for every model in today's seed,
 * and that is an observation, not a licence to compute one rate from another (ADR-024).
 */
export type TokenClass = 'input' | 'output' | 'cache_write' | 'cache_write_1h' | 'cache_read';

/** §4.7 / §3.11 — bi-temporal, half-open `[validFrom, validTo)` (ADR-024). */
export interface PriceRow {
  id: number;
  model: string;
  tokenClass: TokenClass;
  usdPerMillion: number; // presentation form; rate_picousd_per_token / 1e6 (ADR-023)
  validFrom: number;
  validTo: number | null;
  source: PriceSource;
  sourceUrl: string | null;
  note: string | null;
}

/** §4.7 / §3.11 `price_rows.source` CHECK. */
export type PriceSource = 'seed' | 'fetch' | 'manual';

/** §4.7 — one auto-versioning change applied by a fetch or a reset-to-seed (§3.11, §5.8). */
export interface PriceChange {
  model: string;
  tokenClass: TokenClass;
  fromUsdPerMillion: number | null;
  toUsdPerMillion: number;
  effectiveFrom: number;
}

/** §4.7 — one distinct `message.model` string observed in `events`, priced or not. */
export interface ObservedModelRow {
  model: string;
  events: number;
  firstTs: number;
  lastTs: number;
  priced: boolean;
}

/**
 * §4.7 — the canonical price-document shape: what `resources/price-seed.json` contains and
 * what a fetched document must validate against. Anything else is rejected with
 * `E_FETCH_SHAPE` and the existing price table is left completely intact (§5.8 rule 3).
 * Typed here, in `shared`, so the seed file and the fetch validator cannot drift.
 */
export interface PriceDocument {
  schema: 'claude-lens/price-table@1';
  generatedAt: string; // ISO 8601
  models: PriceDocumentModel[];
}

/** §4.7 — all **five** classes required (A-05); USD per 1,000,000 tokens. */
export interface PriceDocumentModel {
  model: string; // <exact message.model string> (ADR-025: no normalization)
  rates: Record<TokenClass, number>;
  effectiveFrom?: string; // optional; defaults to fetch time
}

// ---------------------------------------------------------------------------
// §4.8 — Harness scan, guarded actions, audit, backups, archives
// ---------------------------------------------------------------------------

/** §4.8 `harness:scan` */
export interface HarnessScanSummary {
  nodes: number;
  edges: number;
  flags: number;
  scannedAt: number;
  /**
   * ⚠️ AMENDED 2026-07-22 (ADR-039) — how many projects' own `.claude/` harnesses were read.
   *
   * `projects/<encoded-path>/` encodes the project's real directory by replacing `/` with `-`,
   * which is lossy: a directory whose own name contains `-` decodes to a path that is not where
   * it lives. Exactly one candidate path is decoded and checked; when it does not land, the
   * project is skipped and counted here rather than searched for (§2.1 "zero inference").
   *
   * Two counts rather than one, because "0 of 17" and "6 of 17" are different answers and a bare
   * "6 projects" hides which. §4.6's rule: incompleteness is data in the success payload, never a
   * log line.
   */
  projectsResolved: number;
  projectsSkipped: number;
}

/**
 * §5.11 — the CLOSED Bloat Radar rule set. `bloat_flags.rule_id` is `TEXT` in the §3.12 DDL
 * with the comment `BR-01 … BR-06 (§5.11)`; typed closed here because §5.11 says the set is.
 */
export type BloatRuleId = 'BR-01' | 'BR-02' | 'BR-03' | 'BR-04' | 'BR-05' | 'BR-06';

/** §3.12 `bloat_flags.severity` CHECK. Always paired with text, never colour alone (§6.9). */
export type BloatSeverity = 'high' | 'medium' | 'low';

/**
 * §4.8 references `BloatFlag` but does not spell it out.
 * **Derived column-for-column from the §3.12 `bloat_flags` DDL**, with the §5.11 rule table
 * and the §6.9 flag-card description for the field meanings. `actionType: null` renders as a
 * flag with **no button** and the label "no automatic action in v1" (BR-03, §3.12, §11.2).
 */
export interface BloatFlag {
  id: number;
  ruleId: BloatRuleId;
  severity: BloatSeverity;
  title: string;
  location: string; // rel_path or rel_path glob, relative to claudeDir
  sizeBytes: number;
  itemCount: number;
  rationale: string; // "why flagged", rendered verbatim
  actionType: ActionType | null; // NULL = no action in v1
  actionPayload: unknown; // validated against that action's payload schema (§3.12)
  detectedAt: number;
}

/** §4.8 `bloat:list` (§6.9 header badge `N issues · X reclaimable`). */
export interface BloatList {
  rows: BloatFlag[];
  totalReclaimableBytes: number;
}

/** §4.8 / §5.7 — the CLOSED catalogue (ADR-032). Anything else: `E_ACTION_UNKNOWN`. */
export type ActionType =
  | 'delete-orphan-skill-folders' // ACT-01
  | 'clear-plugin-cache' // ACT-02
  | 'delete-duplicate-config-backups' // ACT-03
  | 'restore-claude-md' // ACT-04
  | 'delete-empty-claude-md' // ACT-05
  | 'clear-backups' // ACT-06
  | 'archive-sessions'; // ACT-07 — move-class (ADR-034)

/**
 * §4.8 — ACT-07 payload. Sessions are named explicitly; the UI resolves a criterion into this
 * list and the user sees every one of them in the preview before a token is minted.
 */
export interface ArchiveSessionsPayload {
  sessionIds: string[];
}

/**
 * §4.8 — ⚠️ `confirmToken` is the mechanism that makes "confirm" real (INV-06). It is minted
 * by `action:preview`, bound to the exact resolved target list and to a hash of it,
 * single-use, and expires after 5 minutes. `action:execute` re-resolves the targets and
 * refuses with `E_ACTION_NOT_CONFIRMED` if the list changed since the preview.
 * **An action can never execute against a target the user did not see.**
 */
export interface ActionPreview {
  actionType: ActionType;
  targets: { relPath: string; sizeBytes: number; kind: 'file' | 'directory' }[];
  totalBytes: number;
  requiresTypedConfirm: boolean; // §5.7
  typedConfirmPhrase: string | null; // exactly what the user must type
  confirmToken: string; // opaque, single-use, bound to this exact target list
  warnings: string[]; // e.g. "3 targets no longer exist and will be skipped"
}

/** §4.8 */
export interface ActionResult {
  succeeded: string[];
  skipped: string[];
  failed: { relPath: string; reason: string }[];
  backupRelPath: string | null;
  backupBytes: number;
}

/** §4.8 / §3.14 `audit_log.status` CHECK. */
export type AuditStatus = 'completed' | 'failed_partial' | 'failed' | 'undone';

/** §4.8 `action:execute` */
export interface ActionExecuteResult {
  auditId: number;
  status: AuditStatus;
  result: ActionResult;
}

/** §4.8 `action:undoLast` — undo is explicit and never automatic (ADR-032). */
export interface ActionUndoResult {
  auditId: number;
  status: 'undone';
  restored: number;
}

/**
 * §4.8 references `AuditEntry` but does not spell it out.
 * **Derived column-for-column from the §3.14 `audit_log` DDL**, with §6.10 card 6 for what
 * the Settings surface renders ("action, targets, bytes, restore point and undo state").
 * `targets` is the decoded `targets_json` — the rel_paths ACTUALLY acted on. `backupPresent`
 * is the `0/1` column: `clear-backups` (ACT-06) sets it to `0` so the entry survives as
 * history with its undo capability honestly withdrawn. **No row is ever deleted** (§3.14).
 */
export interface AuditEntry {
  id: number;
  actionType: ActionType;
  status: AuditStatus;
  claudeDir: string; // absolute path at the time of the action (§3.1.4 exception)
  targetSummary: string; // human-readable, e.g. '24 orphaned skill folders'
  targets: string[]; // decoded targets_json
  bytesAffected: number;
  backupRelPath: string | null; // '.claude-lens-backups/<iso>-<id>'; null if nothing copied
  backupBytes: number;
  backupPresent: boolean;
  startedAt: number;
  finishedAt: number | null;
  undoneAt: number | null;
  undoOfId: number | null;
  errorCode: ErrorCode | null;
  errorDetail: string | null;
  createdAt: number;
  updatedAt: number;
}

/** §4.8 `backups:summary` (§6.10 card 6) */
export interface BackupsSummary {
  restorePoints: number;
  totalBytes: number;
  oldestTs: number | null;
  newestTs: number | null;
}

/**
 * §4.8 / §3.15 — ⚠️ **an archive you cannot find is a delete with extra steps.** This list is
 * the answer to "where did my transcripts go?" and is never pruned (§6.10 card 7).
 * `reachable: false` is informational only: the parsed rows are RETAINED and stand on their
 * own, so no metric changes (ADR-033, INV-18).
 */
export interface ArchiveRow {
  id: number;
  auditId: number;
  archiveRoot: string;
  claudeDir: string;
  sessionCount: number;
  fileCount: number;
  bytesMoved: number;
  rangeFromTs: number | null;
  rangeToTs: number | null;
  reachable: boolean;
  lastReachableAt: number | null;
  createdAt: number;
}

/**
 * §4.8 — `archives:candidates` is a **read-only** helper that turns "sessions older than X"
 * into the explicit session list ACT-07 requires. It never mutates and never mints a token;
 * `action:preview` does that.
 */
export interface ArchiveCandidates {
  sessions: { id: string; displayName: string; lastTs: number; bytes: number }[];
  totalBytes: number;
}

// ---------------------------------------------------------------------------
// §4.5 / §4.6 / §4.7 / §4.8 — THE CHANNEL MAP
// ---------------------------------------------------------------------------

/**
 * Every `invoke` channel in the application, with its request and response types, so that a
 * handler's contract is derivable from the channel name alone. Main-side registration keys off
 * `IpcHandlerMap` and renderer-side calls key off `IpcInvoke`, so **changing one side alone is
 * a compile error** (§4 preamble, ADR-031).
 *
 * The wire value is always `Result<IpcResponse<C>>` — never a bare payload, never a throw.
 *
 * ⛔ marks the channels that IGNORE the global filter (INV-13): Harness Manager counts,
 * "last used", "never used" and the runtime overlay are computed over the **full dataset**
 * and the UI labels them "all time". Their request types deliberately do not include
 * `GlobalFilter`, which is what makes INV-13 a compile-time property rather than a convention.
 */
export interface IpcChannels {
  // ---- §4.3 Bootstrap and settings ----
  'app:bootstrap': { req: void; res: AppBootstrap };
  'settings:get': { req: void; res: SettingsSnapshot };
  /** `key = 'claudeDir'` validates first and, on success, triggers the purge-and-full-sync
   *  transition of §5.1. It never partially applies. Response is the full new snapshot. */
  'settings:set': { req: { key: SettingKey; value: unknown }; res: SettingsSnapshot };
  'dir:pick': { req: void; res: DirPickResult };
  'dir:validate': { req: { path: string }; res: DirValidation };

  // ---- §4.4 Sync ----
  'sync:start': { req: { kind: SyncKind }; res: SyncState };
  'sync:cancel': { req: void; res: SyncState };
  'sync:state': { req: void; res: SyncState };

  // ---- §4.5 Analytics queries ----
  'q:overviewTiles': { req: GlobalFilter; res: OverviewTiles };
  'q:activityCalendar': { req: GlobalFilter & { weeks: number }; res: ActivityCalendar };
  'q:modelMixTimeline': { req: GlobalFilter & { bucket: TimelineBucket }; res: ModelTimeline };
  'q:tokensByModel': {
    req: GlobalFilter & { mode: TokensByModelMode; bucket: TimelineBucket };
    res: ModelTimeline;
  };
  'q:tokensByProject': { req: GlobalFilter; res: TokensByProject };
  'q:cacheEfficiency': { req: GlobalFilter; res: CacheEfficiency };
  'q:costBreakdown': { req: GlobalFilter & { by: CostBreakdownBy }; res: CostBreakdown };
  'q:sessionHistogram': { req: GlobalFilter; res: SessionHistogram };
  'q:rhythmHeatmap': { req: GlobalFilter; res: RhythmHeatmap };
  'q:workingDays': { req: GlobalFilter & Page; res: Paged<WorkingDayRow> };
  'q:sessions': {
    req: GlobalFilter & Page & { sort: SessionSort; dir: SortDirection };
    res: SessionsPage;
  };
  'q:sessionDetail': { req: { sessionId: string }; res: SessionDetail };
  'q:toolFingerprint': { req: GlobalFilter; res: ToolFingerprint };
  'q:originSplit': { req: GlobalFilter; res: OriginSplit };
  'q:toolMixByProject': { req: GlobalFilter & { topN: number }; res: ToolMixByProject };
  'q:projectCards': { req: GlobalFilter; res: ProjectCards };
  /**
   * §4.5 / §6.10 — the user's project groups (ADR-040).
   *
   * ⚠️ **Nothing on this surface suggests a grouping.** There is no "candidates", "suggested" or
   * "similar projects" channel here and there must never be one: §2.1's zero-inference rule
   * forbids the app deciding that two folders are one project. The user names the group and picks
   * its members, always.
   * ⚠️ `create` and `rename` take the user's own words; `ungroup` splits the group back apart and
   * restores every figure exactly, because the grouping was only ever a label over real data.
   */
  'groups:list': { req: void; res: ProjectGroups };
  'groups:create': { req: { name: string; encodedNames: string[] }; res: ProjectGroups };
  'groups:rename': { req: { groupId: number; name: string }; res: ProjectGroups };
  'groups:ungroup': { req: { groupId: number }; res: ProjectGroups };
  'q:fileMetrics': { req: GlobalFilter & { projectId?: number } & Page; res: Paged<FileMetricRow> };
  /** ⛔ INV-13 — ignores the global filter; the runtime overlay is over the full dataset. */
  'q:harnessGraph': { req: { tab: 'harness' }; res: Graph };
  'q:executionTrace': { req: { sessionId: string }; res: ExecutionTrace };
  'q:toolTransition': { req: GlobalFilter; res: Graph };
  'q:flowSankey': { req: GlobalFilter; res: FlowSankey };
  /** ⛔ INV-13 — invocations, "last used" and "never used" are all time. */
  'q:skills': { req: Page & { sort: SkillSort }; res: Paged<SkillRow> };
  /** ⛔ INV-13 */
  'q:claudeMdFiles': { req: void; res: ClaudeMdFiles };
  /** ⛔ INV-13 */
  'q:plugins': { req: void; res: PluginsAndMarketplaces };
  /** ⛔ INV-13 */
  'q:memories': { req: void; res: Memories };
  /**
   * ⛔ INV-13 — ADR-039 — each project's OWN skills, agents, CLAUDE.md and memory, grouped for
   * §6.9's per-project sections. Read-only: every path is project-relative, so no row here is ever
   * a guarded-action target. Counts are all time; this request carries no `GlobalFilter`.
   */
  'q:harnessProjects': { req: void; res: HarnessProjects };

  // ---- §4.6 Disclosures ----
  'q:disclosures': { req: GlobalFilter; res: Disclosures };
  'q:uncosted': { req: GlobalFilter; res: UncostedSummary };

  // ---- §4.7 Pricing ----
  'pricing:list': { req: { model?: string; includeHistory: boolean }; res: { rows: PriceRow[] } };
  'pricing:upsertRate': {
    req: { model: string; tokenClass: TokenClass; usdPerMillion: number; note?: string };
    res: { rows: PriceRow[]; versioned: boolean };
  };
  'pricing:setDates': {
    req: { id: number; validFrom: number; validTo: number | null };
    res: { rows: PriceRow[] };
  };
  'pricing:deleteRow': { req: { id: number }; res: { rows: PriceRow[] } };
  'pricing:fetch': {
    req: void;
    res: { applied: PriceChange[]; unchanged: number; sourceUrl: string };
  };
  'pricing:resetToSeed': { req: void; res: { applied: PriceChange[]; unchanged: number } };
  'pricing:models': { req: void; res: { rows: ObservedModelRow[] } };

  // ---- §4.8 Harness scan, guarded actions, audit, backups, archives ----
  'harness:scan': { req: void; res: HarnessScanSummary };
  'bloat:list': { req: void; res: BloatList };
  'action:preview': { req: { actionType: ActionType; payload: unknown }; res: ActionPreview };
  'action:execute': {
    req: { actionType: ActionType; payload: unknown; confirmToken: string };
    res: ActionExecuteResult;
  };
  'action:undoLast': { req: { auditId: number }; res: ActionUndoResult };
  'audit:list': { req: Page; res: Paged<AuditEntry> };
  'backups:summary': { req: void; res: BackupsSummary };
  'archives:list': { req: void; res: { rows: ArchiveRow[] } };
  'archives:candidates': {
    req: { olderThanTs: number; projectIds: number[] | null };
    res: ArchiveCandidates;
  };
}

/** Every `invoke` channel name. Keying with anything else is a compile error. */
export type IpcChannel = keyof IpcChannels;

/** The request type of one channel, derived from its name. */
export type IpcRequest<C extends IpcChannel> = IpcChannels[C]['req'];

/** The response `data` type of one channel, derived from its name. */
export type IpcResponse<C extends IpcChannel> = IpcChannels[C]['res'];

/**
 * A main-side handler. It returns `Result<T>` — never throws across the boundary; the one
 * `withResult()` wrapper turns an uncaught throw into `E_INTERNAL` (§4.1 rule 1, ADR-031).
 */
export type IpcHandler<C extends IpcChannel> = (
  req: IpcRequest<C>,
) => Result<IpcResponse<C>> | Promise<Result<IpcResponse<C>>>;

/**
 * The complete main-side registration table. It is a mapped type over `IpcChannel`, so
 * omitting a channel — or handling one that does not exist — fails `typecheck`.
 */
export type IpcHandlerMap = { [C in IpcChannel]: IpcHandler<C> };

/** `void`-request channels take no second argument; every other channel requires one. */
export type IpcRequestArgs<C extends IpcChannel> =
  IpcRequest<C> extends void ? [] : [req: IpcRequest<C>];

/** The renderer-side call surface exposed over `contextBridge` (§4 preamble). */
export type IpcInvoke = <C extends IpcChannel>(
  channel: C,
  ...req: IpcRequestArgs<C>
) => Promise<Result<IpcResponse<C>>>;

// ---------------------------------------------------------------------------
// §4.9 — Push events (main → renderer)
// ---------------------------------------------------------------------------

/** §4.9 — lets the renderer invalidate only affected queries. */
export type DataScope =
  'events' | 'sessions' | 'projects' | 'tools' | 'prompts' | 'harness' | 'bloat';

/**
 * §4.9 — one `evt:` channel each, delivered main → renderer. The renderer subscribes in the
 * preload; **there is no polling.**
 *
 * ⚠️ **No push event ever focuses, raises or animates the window** (§1.3 moment 2, §6.2).
 * `evt:dataChanged` causes a silent re-query and an in-place number update, nothing more.
 */
export interface PushChannels {
  /** Every phase transition, and at most **4 Hz** while parsing (§8.5 — no visual thrash). */
  'evt:sync': SyncState;
  /** A sync cycle finished having written anything. */
  'evt:dataChanged': { at: number; scopes: DataScope[] };
  /** Any write to `price_rows`. */
  'evt:pricingChanged': { at: number };
  /** A guarded action reached a terminal state. */
  'evt:actionCompleted': { auditId: number; status: AuditStatus };
  /** The watched directory disappeared or became unreadable. */
  'evt:dirStatus': DirStatus;
  /** Migration failure or DB corruption — the renderer shows the blocking screen (§6.11). */
  'evt:fatal': AppError;
}

/** Every push channel name. */
export type PushChannel = keyof PushChannels;

/** The payload of one push channel, derived from its name. */
export type PushPayload<C extends PushChannel> = PushChannels[C];

/** A renderer-side subscriber. */
export type PushListener<C extends PushChannel> = (payload: PushPayload<C>) => void;

/** The preload's subscribe surface; the returned function unsubscribes. */
export type PushSubscribe = <C extends PushChannel>(
  channel: C,
  listener: PushListener<C>,
) => () => void;

/** The complete main-side emitter table, mapped so a missing emitter is a compile error. */
export type PushEmitterMap = { [C in PushChannel]: (payload: PushPayload<C>) => void };
