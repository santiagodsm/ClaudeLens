<!-- GATE: BACKLOG CLEAR -->

# DESIGN — Claude Lens

> Step 3 of the Project Setup Kit. Inputs: `PRD.md` (authoritative on product), `STACK.md`
> (authoritative on technology and versions; ADR-001…ADR-018 LOCKED), `OPEN_QUESTIONS.md`, and the
> frozen historical inputs under `docs/source/` plus
> `Claude Lens frontend prototype/Claude Lens.dc.html` (the visual target).
>
> **ADR numbering continues at ADR-019.** One namespace across `STACK.md` and this file.
>
> **Terminology, per OQ-008:** bare **"harness"** always means the user's `~/.claude` configuration
> surface that the product analyzes. *This repository's* own kit-generated build system is always
> written **"the build harness."**
>
> **Gate status: BACKLOG CLEAR.** Amended 2026-07-20 after the user answered the two blocking
> questions raised at step 3 and closed one deferrable:
> **OQ-013** — active time **includes** subagent events (§5.9 M-07, ADR-035);
> **OQ-014** — archiving is **in v1**, moving transcripts outside the Claude data directory while
> **retaining** their parsed rows (§5.7 ACT-07, ADR-033, ADR-034);
> **§11.3** — the price-fetch URL ships empty with documented suggestions (§6.10).
> §11.1, §11.2 and §11.3 are now closed and kept as history.
>
> **Amended again 2026-07-21** after `plan-lint` found a genuine design gap: **§5.9 M-07 carried an
> unfilled `PARTITION BY <scope>` placeholder** bound in only two places, leaving the Overview
> *Active hours* tile with nothing to cite. The user bound it — an aggregate partitions by
> **working day** (§11.8, **ADR-036**, INV-21, fixture F-12) — and then closed that binding's one
> honest residual by **disclosing the cross-project overlap beside the figure rather than changing it**
> (§11.9, **ADR-037**, M-19/M-20, INV-22/INV-23, fixture F-13).
> **Four DEFERRABLE entries remain and none blocks planning.**
>
> ⚠️ **ADR-023 was amended in the same pass** on a verified external fact: a real published cache rate
> (`3.125e-07` USD/token) is **not representable** in the nanoUSD unit originally locked. The unit is
> now **picoUSD per token**. See ADR-023's amendment note — this is exactly the class of silent
> rounding the project exists to prevent.

**Section map** — §1 Product · §2 Domain model · §3 Data design · §4 IPC contracts · §5 Behavior ·
§6 Surfaces · §7 Cross-cutting · §8 Non-functional · §9 Infrastructure · §10 ADRs (LOCKED) ·
§11 Not yet specified · §12 Definition of done.

---

# §1 — Product

## §1.1 Purpose

Claude Lens is a local, offline, single-user **Electron** desktop app that reads a Claude Code data
directory (default `~/.claude`, always a setting — never a literal path), parses it into an embedded
**SQLite** database in the main process, and renders it as a vibrant analytics dashboard across
**eight views**. On top of the analytics it provides four interactive graph views of harness workflow
and a **guarded Harness Manager** with a **Bloat Radar** that can delete and clean — always behind
confirm, automatic backup, undo, and an audit trail.

It ships as source. `pnpm install && pnpm run dev`. There is no packaged build (STACK ADR-016).

## §1.2 Users

Exactly one person per installation: a heavy solo Claude Code user with ~1 GB of transcripts and a
sprawling harness they cannot see the shape of. Single user, single machine, one dataset at a time.
No accounts, no tenancy, no permission model (STACK ADR-017). The repo is public, so *other* people
run it — each of them also a single user pointed at their own directory. **No personal path and no
personal data may appear in any committed file** (STACK ADR-015, `pnpm run guard`).

## §1.3 The daily loop (what the architecture is optimised for)

The trigger is **"the app is already open,"** and only that (OQ-001).

| # | Moment | Frequency | Design consequence |
|---|---|---|---|
| 1 | Cold launch, incremental sync | **once a day** | The launch path may cost more than the glance path, but it is budgeted (§8.2). |
| 2 | **Idle-but-live, nine hours** | continuous | The `chokidar` watcher and the append fast-path are **core architecture** (STACK ADR-009/010). Steady-state idle CPU and flat memory are product properties with numeric targets (§8.4). Nothing may flash, jump, or steal focus (§6.2). |
| 3 | **The glance** — 3–8 s, no interaction | many times a day | Overview hero tiles must be **correct and current without being asked**. The most frequent interaction in the product. |
| 4 | The drill — 30–90 s | a few times a week | Tokens & Cost (first among equals), then Sessions & Time. Every query ≤ 200 ms (§8.3). |
| 5 | Harness hygiene — 5–10 min | weekly-ish | Harness Manager → Bloat Radar → guarded action. |
| 6 | The graphs | rarely, high payoff | Four graph tabs, one shell (§6.7). |

## §1.4 The moment of value

**The main-loop vs subagent compute split** — ~72% of output tokens were spent by agents the user
never watched. Visible nowhere else. **Tokens & Cost is first among equals** among the eight views,
and the split is also surfaced on Tools & Agents (§6.6).

## §1.5 The defining quality bar

**A silently wrong number.** The app shows a plausible total that is incorrect and nothing crashes.
This is a **gate, not a hope** (STACK ADR-012, `golden-fixture-review`), and it shapes this document
structurally, not only its test section:

- Every metric is defined once, in §5.9, as arithmetic a fixture can pin.
- Aggregates that could diverge from their source are **not stored** (§3.1.8, ADR-027).
- Money is integer arithmetic end to end (ADR-023).
- Usage with no covering price row is **excluded and disclosed**, never zero-filled (ADR-024).
- Every disclosure — *N records uncosted*, *N subagent runs unlinked*, *N malformed lines skipped*,
  *partial data before &lt;date&gt;* — is a first-class query result, not a log line (§4.6).
- Golden fixtures use **inline hand-computed expected values, never `toMatchSnapshot()`**
  (STACK ADR-012). An auto-written snapshot is a machine for blessing the bug.

## §1.6 Explicit non-goals (v1)

Carried from `PRD.md`; restated here because downstream agents cite §1.6, not the PRD.

1. **Not a transcript reader or search tool.** No message viewer, no full-text search. Session
   drill-down shows metadata and structure, never a chat log. Prompt text appears only as a
   ≤280-character preview in the graph inspector (§3.9, §6.7).
2. **Deletes, but never authors.** The Harness Manager removes and cleans. It never writes or edits
   the *content* of `SKILL.md`, `CLAUDE.md`, agent definitions, `settings.json`, or memories. The one
   adjacent case is `restore-claude-md`, which **copies an existing backup file over a target** — a
   whole-file restore, never authored content (§5.7, ACT-04).
3. **No diff rendering.** `file-history/` produces **metrics only** — files touched, edit counts,
   languages. No diff viewer, no syntax highlighting, and **no hook toward one** (OQ-104 stays
   RESERVED).
4. **The app never auto-deletes anything, including its own backups.** No retention policy, no age
   cap, no size cap, no silent pruning. `clear-backups` is itself a guarded action (§5.7, ACT-06).
5. Not a team or multi-machine tool. *(HANDOFF §2.)*
6. No packaged distribution — no signing, no notarization, no `.dmg`, no auto-update, no store.
   *(STACK ADR-016.)*
7. **Not a monitor.** No alerting, no thresholds, no notifications, no menu-bar widget, **no
   background process when the window is closed.** The watcher runs only while a window is open
   (§5.6).
8. No export. No CSV, no PDF, no report generation, no share, no screenshot feature.
9. **macOS only in v1** — no CI matrix, no cross-platform branching, no support claim. But no
   gratuitous lock-in: `node:path` APIs, `os.homedir()` confined to one file (STACK ADR-015), no
   literal separators, no macOS-only native APIs.

> Two former candidates were **rejected by the user and are now requirements**: dollar costs (§3.11,
> §5.8) and "zero network, ever" (§7.5 — exactly one egress point). They must never reappear as
> non-goals anywhere downstream.

## §1.7 In scope beyond the source documents

Recorded so nobody "simplifies" them back out.

- **Real dollar cost, bi-temporally priced.** **Five** independently priced token classes per model
  (⚠️ **AMENDED 2026-07-22, A-05** — four became five; see §2.1 "Token class"), each with
  effective-dated rows, rates **stored not derived**; usage joins to the row valid at
  **each record's own timestamp**, never today's price. §3.11, §5.8, ADR-023/024/025.
  ⚠️ **The "stored not derived" half of that sentence is unchanged and is the load-bearing half.**
  A-05's fifth class, 1-hour cache writes, happens to be exactly **2× input** for every model in
  today's seed, and 5-minute cache writes exactly **1.25× input**. That is an *observation about a
  published page*, not a licence to compute one rate from another — the user rejected precisely
  that in the PRD, and ADR-024 records why: "it breaks silently the moment a model deviates from
  the ratio." Every one of the five rates is a stored `price_rows` row.
- ⚠️ **There is no official, stable, machine-readable Anthropic pricing endpoint.** This is *why* the
  design looks like this: a bundled JSON seed, every row editable in Settings, and a
  **user-triggered** fetch from a Settings-configured URL. Without this fact recorded, a later agent
  will "simplify" by assuming an official API exists.
- **Exactly one network egress point in the entire application** —
  `src/main/pricing/fetch-price-table.ts`, the user-triggered price fetch (STACK ADR-015).
  Everything else offline; the app is **fully functional with no network at all** (§7.5).
- ⚠️ **`<claudeDir>/.claude-lens-backups/` is excluded from Bloat Radar, from all analytics, from the
  file manifest and from the watcher** (§5.11, INV-14). It lives inside the scanned directory;
  without an explicit exclusion the app flags its own safety net as reclaimable and offers to delete
  it.

---

# §2 — Domain model

## §2.1 Glossary — the ubiquitous language

One canonical word per concept. `Avoid:` is the list a reviewer greps for. `Code:` is the anchor that
makes the term citable. Promoted from `PRD.md` "Domain language (draft)" and extended.

**Claude data directory** — the configured filesystem root the app reads. Defaults to `~/.claude`
resolved via `os.homedir()` (never a literal), chosen in Settings via a native picker, validated
(must contain `projects/` and/or `history.jsonl`), persisted.
  Avoid: the claude folder, data dir, home dir, `~/.claude` (as a hardcoded value)
  Code: setting key `claudeDir` (§3.13); `src/main/config/paths.ts` is the only file permitted to
  call `os.homedir()` (STACK ADR-015)

**Project** — exactly one `projects/<encoded-path>` directory under the Claude data directory.
**Zero inference:** no on-disk probing, no symlink resolution, no worktree merging, no repo-root
detection. Git worktrees and moved folders legitimately appear as sibling projects.
  ⚠️ **AMENDED 2026-07-22 (ADR-040) — the user may DECLARE two folders to be one project; the app
  still never INFERS it.** This paragraph previously ended "No merge toggle in v1", and that
  clause — and only that clause — is superseded. Everything before it stands, unweakened: **nothing
  in this application may guess, suggest or auto-detect a grouping** — no name matching, no path
  similarity, no candidates list. What the user can now do is say, in their own words and by
  ticking the cards themselves, *"these two folders are the same project"* (§3.19, §6.8). The
  distinction is the one that matters: a wrong inference merges unrelated work silently and nobody
  knows; a wrong declaration is visible to the person who made it, listed under their own name for
  it, and undone with one click that restores every figure exactly. A **Project** is still one
  directory; what changes is which **Project unit** it reports under.
  Avoid: repo, codebase, workspace, folder
  Code: table `projects`, type `Project` (§3.3)

**Project group** — a set of **Projects** the *user* has declared to be one project, with a name
they chose. It is a **label over real data**: no event moves, no `projects` row is removed, no
`project_id` is rewritten, and splitting it apart restores every figure exactly. ⚠️ Its membership
is a set of `encoded_name`s (§3.3 — the identity), **never** `projects.id`, because `projects` is
DERIVED and a rebuild renumbers every row (ADR-040 Trap 1). USER class: never purged (§2.2).
  Avoid: merge, alias, link, cluster, entity; and on screen, all four — the UI says "these are the
  same project"
  Code: tables `project_groups`, `project_group_members` (§3.19, ADR-040)

**Project unit** — the thing every project-shaped metric groups by: the **Project group** when the
project is in one, and the **Project** itself otherwise. It is what `ProjectCard.projectId`,
`WorkingDayRow.projectId`, `SessionRow.projectId` and `GlobalFilter.projectIds` all carry. Its id
is `projects.id` for a lone project and `-groupId` for a group; `projects.id` is a rowid alias and
always `>= 1`, so the two can never collide.
  ⚠️ **This is the noun M-07's partition takes**, not "project": merging two folders changes the
  partition, which is why the grouping is applied where the partition is formed rather than by
  adding two finished results afterwards (ADR-040 Trap 2, fixture F-16).
  Avoid: project (bare, when a group may be meant), bucket, group (bare)
  Code: `PROJECT_UNIT_CTE` in `src/main/db/repositories/project-groups.ts`

**Session** — exactly one transcript file, `projects/<encoded>/<session-id>.jsonl`, identified by its
`sessionId`. One file, one row. **Session identity is fixed by the file and never changes when the
idle-gap threshold moves.**
  Avoid: conversation, chat, working period, a day, run
  Code: table `sessions`, type `Session` (§3.4)

**Working day** — the day-level grouping of one project's activity: the pair
`(local calendar date, project)`. This is what the prototype's "Longest marathons" board shows
(`2026-07-12 · Photo-Booth · 21h 37m active`). A distinct noun with its own aggregation — **not** a
session, and not a table.
  Avoid: session, marathon (UI copy for the leaderboard only, never a schema or code term), day
  Code: computed by `workingDays()` over `events` grouped by local date (§5.9 M-08, ADR-021)

**Event** — one JSON object on one line of one transcript file, normalized. The fact row of the whole
system. Stored exactly once, deduplicated by **event key**.
  Avoid: record, row, message, line, entry
  Code: table `events`, type `EventRow` (§3.5, ADR-019)

**Event key** — the global identity of an event: its `uuid` when the record has one, otherwise
`<rel_path>#<line_no>`. Ingest is idempotent on this key.
  Avoid: id, uuid (bare), hash
  Code: `events.event_key UNIQUE` (§3.5, ADR-019)

**Origin** — whether an event came from the session's own transcript (`main`) or from one of its
subagent transcripts (`subagent`). The column that makes the roll-up splittable without
double-counting.
  Avoid: source, side, sidechain (the raw field name, not the concept), kind
  Code: `events.origin`, `tool_calls.origin` (§3.5, ADR-020)

**Subagent run** — one execution of a subagent: a transcript file under
`projects/<proj>/<session-id>/subagents/*.jsonl`, plus the `Agent` tool call that spawned it when
that link resolves structurally. Belongs to exactly one **Session** and is **not** itself a Session.
  Avoid: agent, sidechain, child session, sub-session, task
  Code: table `subagent_runs`, type `SubagentRun` (§3.7)

**Agent definition** — an agent *kind*: a `.claude/agents/*.md` file, or a `subagent_type` value
observed in an `Agent` tool call. Distinct from a **Subagent run**, which is the instance. Never
write bare "agent" for either.
  Avoid: agent, agent type, persona
  Code: `harness_nodes.kind = 'agent'` (§3.10)

**Roll-up** — the rule that a Session's headline token and message totals **include** its Subagent
runs. One session is one unit of work, whatever it spawned. Guaranteed by construction: every event
is stored once and attributed to its owning Session, carrying its **Origin**.
  Avoid: aggregation, inclusion, merge
  Code: enforced by `events.session_id` + `events.event_key` (§3.5, ADR-019/020, INV-01/INV-02)

**Tool call** — one `tool_use` content item inside an assistant event. **Includes** `Agent` and
`Skill` dispatches — those are tools. Wherever the UI says "tool calls," that is what it means.
  Avoid: action, invocation, step, command
  Code: table `tool_calls`, type `ToolCall` (§3.6)

**Skill invocation** — a **Tool call** whose `tool_name` is `Skill`. A subset of tool calls, not a
peer. Cross-referenced against the installed skill set to produce "installed but never used."
  Avoid: skill run, skill use, skill call
  Code: `tool_calls.skill_name IS NOT NULL` (§3.6, §5.9 M-13)

**Write-class tool call** — a **Tool call** whose tool writes a file path: `Edit`, `MultiEdit`,
`Write`, `NotebookEdit`. The sole source of file metrics in v1 (ADR-028).
  Avoid: edit, file op, mutation
  Code: `tool_calls.is_write_class = 1` (§3.6)

**File touch** — one write-class tool call resolved to a path, basename, extension and language. The
unit of Projects & Code metrics.
  Avoid: edit, change, diff, churn event
  Code: table `file_touches` (§3.8)

**Edit count** — the number of **file touches** against a path or project. Deliberately *not* called
churn: it counts operations, never lines, and the UI must label it "edits," never "lines changed"
(§1.6 non-goal 3).
  Avoid: churn, lines changed, delta, LOC
  Code: `COUNT(*)` over `file_touches` (§5.9 M-15)

**Prompt** — one line of top-level `history.jsonl`: a user prompt with a millisecond-epoch timestamp
and a project. Spans further back than transcripts, which is what makes **partial-data periods**
visible.
  Avoid: message, user turn, input
  Code: table `prompts` (§3.9)

**Synthetic event** — an assistant event whose `message.model` is the literal `<synthetic>`, with
zero usage. **Excluded from every token, cost and model statistic**; counted and disclosed.
  Avoid: fake record, placeholder, null model
  Code: `events.is_synthetic = 1` (§3.5, §5.9 M-01)

**Span** — a Session's `last_ts − first_ts`. Threshold-independent.
  Avoid: duration, length, wall time
  Code: `sessions.span_seconds` (generated column, §3.4)

**Active time** — the sum of inter-event gaps within a scope, each gap capped at the **idle-gap
threshold**. ⚠️ **The scope's event set includes events of BOTH origins** — a session's active time
is computed over its own events *and* its subagent runs' events, merged and ordered by timestamp
(OQ-013, ADR-035). Computed at query time, never stored, so moving the threshold is always correct
and never moves a session boundary.
  Avoid: duration, working time, real time, focus time, main-loop time
  Code: `activeSeconds()` window-function CTE (§5.9 M-07, ADR-022, ADR-035)

**Archive** — one completed move of a chosen set of **Sessions**' transcript files out of the Claude
data directory to the **archive root**, with their parsed rows **retained** in the database so
historical analytics are unchanged. A **guarded action** (ACT-07), fully undoable.
  Avoid: cleanup, purge, offload, backup, export
  Code: table `archives`, `ActionType 'archive-sessions'` (§3.15, §5.7, ADR-034)

**Archived session** — a **Session** whose transcript files now live under the **archive root**. Its
rows are **RETAINED** (§2.2): never purged, never rebuilt, never re-parsed, and never deleted because
their source file is absent from the Claude data directory.
  Avoid: old session, cold session, removed session, deleted session
  Code: `sessions.archive_id IS NOT NULL` (§3.4, ADR-033)

**Archive root** — the user-chosen directory, **outside the Claude data directory**, that holds
archived transcripts. Never scanned by Bloat Radar, never watched, never walked by analytics, and
⚠️ **never written to or deleted from by the app except by ACT-07 and its undo.**
  Avoid: archive folder, cold storage, the backup root (a different thing entirely)
  Code: setting key `archiveRoot`, `archives.archive_root` (§3.13, §3.15, INV-19)

**Idle-gap threshold** — the configurable cap applied to each inter-event gap when computing **active
time**. Default 15 minutes; range 5–60 in 5-minute steps (prototype Settings). Affects active time
**only** — never session identity, never span, never token totals.
  Avoid: idle timeout, session gap, split threshold
  Code: setting key `idleGapMinutes` (§3.13, INV-05)

**Partial-data period** — a date range in which **prompts** exist but transcript coverage does not, so
token and tool metrics are structurally incomplete. Marked in the UI, never rendered as zero.
  Avoid: gap, missing data, empty period
  Code: `dataCoverage()` (§5.9 M-16, §4.3)

**Cost proxy** — output tokens. The always-honest, always-available cost signal and the **primary
headline metric**, because it needs no price data to be correct. Cache-read tokens (billions) are
cheap re-reads and are **never** summed into a headline "total tokens" without an explicit label.
  Avoid: cost, spend, usage, tokens (bare, when output is meant)
  Code: `SUM(events.tok_output)` (§5.9 M-02)

**Token class** — one of exactly **five**: **input**, **output**, **cache_write**,
**cache_write_1h**, **cache_read**. Each is priced independently and **stored, never derived** from
another. `cache_write` is the **5-minute** cache-write class; `cache_write_1h` is the **1-hour**
one.
  Avoid: token type, usage type, category; "cache write" unqualified when one of the two is meant
  Code: `price_rows.token_class` CHECK constraint (§3.11); `events.tok_cache_write` /
  `events.tok_cache_write_1h` (§3.5); `TokenClass`, `TokenBreakdown` (§4.5, §4.7)

> ⚠️ **AMENDED 2026-07-22 (A-05) — "exactly four" became "exactly five", by user decision.**
>
> **The decision.** The user approved adding a fifth token class for **1-hour cache writes**.
> Every place in this document that said four — §1.7, §3.5, §3.11, §4.6, §4.7, §5.4 rule 8, §5.9
> M-04/M-05, §6.3, §6.4, §6.10, §11.3 — now says five and carries this block or a pointer to it.
>
> **The evidence, verified against the user's real data before anything was written.**
> `message.usage.cache_creation` is present as `{ephemeral_5m_input_tokens,
> ephemeral_1h_input_tokens}` on **all 133,701** of their cache-writing events, and sums
> **exactly** to `cache_creation_input_tokens` in every one of them. The discriminator was
> therefore already in the source; `src/main/parse/parse-line.ts` mapped only the flat total to
> `tok_cache_write` and discarded the split. This is a fact about the data, not an inference from
> the API docs, and it is what makes a fifth *stored* class implementable rather than aspirational.
>
> **The measured cost of not having it.** Cache writes bill at **1.25× input for 5-minute** and
> **2× input for 1-hour**, so costing every write at the 5-minute rate understates the total.
> Measured shortfall on the user's dataset: **$415.07**. On Opus 4.8 alone, **95,000,592 of
> 735,645,522** cache-write tokens are 1-hour — **12.91%** — worth **$356.25**.
>
> ⚠️ **§1.7's rule still holds, unweakened: rates are STORED, never derived.** The 1.25× / 2×
> multipliers currently hold for every model on the published page. That is an observation, and it
> is explicitly **not** a licence to compute one rate from another — the user rejected exactly that
> in the PRD, and ADR-024 records the reason ("it breaks silently the moment a model deviates from
> the ratio"). `resources/price-seed.json` therefore carries a stored `cache_write_1h` rate for
> every seeded model, sourced from the same published page as the other four, and §4.7's document
> validator **requires** it rather than filling it in.
>
> **Naming, decided once.** `cache_write` keeps its meaning and is now explicitly the 5-minute
> class — which is what the seed has always put in it. Renaming it would have meant rewriting
> USER-class `price_rows` data, including hand-corrected rates and effective dates (ADR-026), for
> no gain in correctness.

**Price row** — a rate for one model, one **token class**, over one half-open validity range
`[valid_from, valid_to)`. The unit of the price table and of its history. Rates are integers in
**nanoUSD per token**.
  Avoid: price, rate (bare), tariff, pricing entry
  Code: table `price_rows` (§3.11, ADR-023/024)

**Cost** — a dollar figure derived by joining usage to the **price row valid at the record's own
timestamp**. Secondary to the **cost proxy**, and **always** accompanied by its uncosted disclosure.
  Avoid: estimate, spend, dollars, price
  Code: `costNanoUsd()` (§5.9 M-05, §5.8)

**Uncosted record** — a usage event for which **any** token class with a non-zero count has no
covering **price row**. Excluded from `$` totals in its entirety and disclosed as *"N records
uncosted (model X, date range Y)."* Never zero-filled, never substituted.
  Avoid: unpriced, missing price, skipped
  Code: `uncostedSummary()` (§5.9 M-06, §4.6, INV-09)

**Harness** — **the user's Claude Code configuration surface that this app analyzes**: `CLAUDE.md`
files, `skills/**/SKILL.md`, agent definitions, plugins, marketplaces, `settings.json`, memories. The
sidebar item stays "Harness Manager"; Bloat Radar is unchanged.
  ⚠️ **AMENDED 2026-07-22 (ADR-039) — it is TWO surfaces, and only one of them is actionable.**
  The definition above described only the **Claude data directory**, and on a machine whose
  `skills/`, `agents/` and `commands/` are empty at that level — because its skills and agents live
  in project-level `.claude/` directories — it made the Harness Map (§6.7) correctly empty over a
  dataset that fully described the orchestration the user asked to see. The harness is therefore
  also, **per project**, `<project>/.claude/**` and that project's own root `CLAUDE.md`, reached by
  resolving `projects/<encoded-path>` to **exactly one** candidate path and verifying it — a
  recorded `events.cwd` whose re-encoding matches, or failing that the lossy `-` → `/` decode
  (ADR-039; never searching for it — §2.1 "Project", zero inference).
  ⛔ **The project half is READ-ONLY and outside the guarded-action catalogue.** Nothing under a
  project directory is ever written, moved or deleted; ACT-01…07 still operate only within the
  Claude data directory. Project nodes are excluded from Bloat Radar, from analytics, from
  `file_manifest` and from the watcher — the same exclusion the **backup root** gets (INV-14) — and
  appear on the **Harness Map only**, never in the Harness Manager's actionable lists.
  Avoid: config, setup, environment
  Code: tables `harness_nodes` (`project_id IS NOT NULL` ⇒ project-scoped, ADR-039),
  `harness_edges` (§3.10); `src/main/harness/projects.ts`

**Build harness** — ⚠️ **this repository's own** kit-generated build system (`CLAUDE.md` +
`.claude/**`, produced at step 5). **Always qualified** — "the build harness" or "the kit harness",
never bare "harness" — in DESIGN.md, PLAN.md, skills, agents, and commit messages. Bare "harness"
always means the analyzed `~/.claude` surface. This is the collision §2.1 exists to prevent.
  Avoid: harness (bare), the skills, the agents, our harness
  Code: not a runtime concept; it appears in no table and no type

**Harness node** — one vertex of the Harness Map: a skill, agent definition, command, tool, file,
plugin, marketplace, memory, `CLAUDE.md` or `settings.json`.
  Avoid: node (bare), entity, item
  Code: table `harness_nodes` (§3.10)

**Harness edge** — one directed relationship between harness nodes, carrying its **evidence**:
`frontmatter` (declared), `body_mention` (named in prose), or `directory` (structural containment).
  Avoid: edge (bare), link, relation
  Code: table `harness_edges` (§3.10)

**Runtime overlay** — the observed frequency painted onto a **harness edge** by joining it to **tool
calls**, producing designed-vs-actual in one picture. Computed at query time, never stored.
  Avoid: weight, actual, frequency (bare)
  Code: `harnessGraph()` (§5.9 M-14, §4.5)

**Bloat flag** — one detected issue carrying a rule id, a location, a disk size, a severity, a
rationale, and either a recommended **guarded action** or an explicit "no action in v1". The app's own
**backup root** can never produce one.
  Avoid: warning, problem, issue, finding
  Code: table `bloat_flags` (§3.12, §5.11)

**Guarded action** — a mutating operation on the Claude data directory, from a **closed catalogue**:
confirm → backup to the **backup root** → execute → undoable → written to the **audit trail**.
`clear-backups` is itself a guarded action.
  Avoid: cleanup, delete, fix, operation
  Code: table `audit_log`, `src/main/actions/**` (§3.14, §5.7, ADR-032)

**Backup root** — `<claudeDir>/.claude-lens-backups/`. Every guarded action writes a **restore point**
here before mutating. ⚠️ Excluded from Bloat Radar, from all analytics, from the file manifest and
from the watcher.
  Avoid: backups folder, trash, archive
  Code: constant `BACKUP_ROOT_NAME` in `src/main/config/paths.ts` (§5.11, INV-14)

**Restore point** — one timestamped subdirectory of the **backup root** holding the pre-mutation copy
of everything one guarded action touched. Never auto-deleted; counted and sized in Settings.
  Avoid: backup (bare), snapshot, checkpoint
  Code: `audit_log.backup_rel_path` (§3.14)

**Audit entry** — one row of the permanent, user-owned record of a guarded action: what, where, when,
how many bytes, which restore point, and whether it was undone.
  Avoid: log, history, event
  Code: table `audit_log` (§3.14) — **user data, never purged** (ADR-026)

**Sync** — reconciling the SQLite cache to the current contents of the Claude data directory. The
files are the source of truth and are read-only; the **derived** half of the database can be deleted
and rebuilt at any time. The **user** half cannot (ADR-026).
  Avoid: import, update, refresh the data, ingest (as a noun)
  Code: `src/main/sync/**`, type `SyncState` (§5.2)

**Sync cycle** — one complete pass of the sync state machine: scan → classify → parse → finalize.
  Avoid: run, pass, job, refresh
  Code: `SyncState.phase` (§5.2)

**Append fast-path** — the incremental branch taken when a file has **grown**: seek to the saved byte
offset and parse only the new lines. What makes an actively-growing session sync in milliseconds. Its
result must be **provably identical** to a from-scratch parse (INV-04).
  Avoid: incremental parse, tail, delta sync
  Code: `file_manifest.byte_offset` (§3.2, §5.3)

**Global filter** — the top-bar `(project set, date range)` selection applied to every analytics
query. ⚠️ It is **not** applied to Harness Manager invocation counts or to "installed but never used"
(INV-13).
  Avoid: filter (bare), scope, selection
  Code: type `GlobalFilter` (§4.2)

## §2.2 What is canonical vs derived

The Claude data directory is the **only** source of truth for observations. The database is **two**
things at once, and confusing them destroys user data (STACK ADR-007):

| Class | Meaning | Tables / rows | On schema change / `claudeDir` change |
|---|---|---|---|
| **DERIVED** | Rebuildable by re-reading the Claude data directory. Safe to purge. | `file_manifest`, `projects`, `sessions`, `events`, `tool_calls`, `subagent_runs`, `prompts`, `file_touches` — **only rows whose `archive_id IS NULL`** — plus `harness_nodes`, `harness_edges`, `bloat_flags`, `stats_cache_days`, `meta` | May be purged and rebuilt |
| **RETAINED** | Parsed observations whose source file is **no longer in the Claude data directory**, by EITHER of two roads: **moved out by ACT-07** (`archive_id IS NOT NULL`, ADR-033) or **disappeared and kept** (`retained_orphan = 1`, ADR-041). Structurally derived, but **no longer derivable** — a rescan of `<claudeDir>` will never reproduce them. | Rows of `file_manifest`, `sessions`, `events`, `tool_calls`, `subagent_runs`, `file_touches` carrying `archive_id IS NOT NULL` **or** `retained_orphan = 1` | **Must survive. Never purged, never rebuilt, never re-parsed.** |
| **USER** | Hand-entered or historical. **No other source exists.** | `price_rows`, `settings`, `audit_log`, `archives`, `project_groups`, `project_group_members` | **Must be migrated. Never purged.** |

⚠️ **`project_groups` / `project_group_members` are USER for the same reason `price_rows` is
(ADR-040):** the fact they record — *"these two folders are the same project"* — is not on disk and
never was. A rescan of `<claudeDir>` cannot reproduce it, because it lives in the user's head. A
purge that took them would silently un-merge every group and move every project-shaped number, with
no error and nothing to see. ⚠️ This is also why their membership keys on `encoded_name` rather than
`projects.id`: the purge renumbers `projects`, so a group that survived by id would come back
pointing at the wrong folders — a merge nobody asked for (ADR-040 Trap 1, §3.19).

⚠️ `DESIGN_INPUT.md` §3.3's "SQLite is a derived cache that can be deleted and rebuilt at any time" is
**true of the DERIVED class and false of the RETAINED and USER classes.** A "drop and re-sync on
schema change" silently destroys hand-corrected price history — textbook silently-wrong-number
territory. This is why migrations (STACK ADR-007) are mandatory and `db-migration-review` is a real
gate. See ADR-026.

⚠️ **RETAINED exists because of OQ-014.** Archiving keeps the rows and moves the files, so a
`<claudeDir>` rescan would find no source for them. Without this class, a full re-sync, a
schema-change rebuild, or any drop-and-rebuild path would **silently erase archived history and shrink
lifetime totals** — the same failure as the price-history case, arriving through a different door. The
class is not documentation: it is a column (`archive_id`) that the purge predicate and
`db-migration-review` both key on (§3.18, ADR-033).

⚠️ **AMENDED 2026-07-22 (ADR-041) — RETAINED now has a SECOND entry road, and it is a SECOND
column.** A transcript that simply **disappears** from `<claudeDir>` (Claude deletes it, the user
deletes it) is exactly as un-derivable as an archived one — a rescan will never reproduce a file
that no longer exists — but it has **no `archives` row, no moved file and nothing to undo.** Under
`retainOrphanedHistory` (§3.13, default TRUE) its history is kept: `file_manifest.retained_orphan`
and `sessions.retained_orphan` mark it, the purge (§3.18) spares it, and §5.3's `MISSING` branch
sets it instead of deleting. It is a **distinct** column precisely because it is a distinct fact:
`archive_id` promises a recoverable location (ADR-034) that an orphan does not have, so reusing it
would be a lie in the schema. Both roads land in the same class and both are guarded by the same
purge predicate — now testing **both** markers, not one (ADR-041).

## §2.3 Entity relationships

```
Claude data directory (1) ──< file_manifest (N)

projects (1) ──< sessions (1) ──< events (N)        events.origin ∈ {main, subagent}
                    │              │  └── event_key UNIQUE  (dedup; ADR-019)
                    │              └──< tool_calls (N) ──< file_touches (0..1)
                    └──< subagent_runs (N) ──< events (N, origin='subagent')
                              └── spawn point via events.parent_uuid → events.uuid (best effort)

projects (1) ──< prompts (N)     (a prompt may name a session that has no transcript)

harness_nodes (N) ──< harness_edges (N) >── harness_nodes (N)
harness_nodes(kind='skill').name ⟷ tool_calls.skill_name   (runtime overlay, query-time)
harness_nodes(kind='tool').name  ⟷ tool_calls.tool_name    (runtime overlay, query-time)

bloat_flags (N) ── 0..1 ─> guarded-action type (closed catalogue, §5.7)
audit_log   (N) ── 0..1 ─> restore point under the backup root
price_rows  (N)  keyed (model, token_class, [valid_from, valid_to))  — joined to events at query time
```

**Cardinality rules that carry correctness weight:**

- One event belongs to exactly one session and exactly one project. Never zero, never two.
- A subagent run belongs to exactly one session, determined **structurally by its directory path**,
  never by a heuristic. Its *spawn point* link is best-effort and **disclosed when unresolved**.
- A prompt may reference a `sessionId` with no transcript. That is a **partial-data period**, not an
  error; the prompt row is retained with `session_id` unresolved.
- A price row covers exactly one `(model, token_class)` over one half-open interval. Intervals for
  the same key **must not overlap** (INV-08). Gaps between them are legal and produce **uncosted
  records**.

---

# §3 — Data design

**Engine:** SQLite via `better-sqlite3@12.11.1`, in the main process and the parse worker only, WAL
mode, at `app.getPath('userData')/claude-lens.db` (STACK ADR-005/006). Migrations are hand-written
numbered SQL applied in order inside a transaction, keyed on `PRAGMA user_version` (STACK ADR-007).
**§3.2–§3.17 is migration `0001` and must match it exactly.**

⚠️ **AMENDED 2026-07-22 (E2).** This line previously read "§3.2–§3.16", which was a typo: it
contradicted §3.18's "Migration `0001` is exactly §3.2–§3.17" and silently excluded §3.17 `meta`.
Building `0001` to the narrower range would have left `meta` uncreated while §3.18's purge still
deletes from it — a purge that fails on a missing table on the first `claudeDir` change. §3.18 was
authoritative; the range is §3.2–§3.17 and migration `0001` creates all seventeen tables.

## §3.1 Standard columns and conventions

Stated once, applied everywhere. A table that deviates says so in its own subsection.

1. **Time is `INTEGER` UTC epoch milliseconds.** No TEXT dates, no local time stored, no ISO strings
   in columns. Calendar bucketing happens at query time in the machine's local timezone (ADR-021).
2. **Booleans are `INTEGER NOT NULL DEFAULT 0 CHECK (col IN (0,1))`.**
3. **Surrogate keys are `INTEGER PRIMARY KEY`** (rowid alias). `AUTOINCREMENT` is never used.
   `sessions` is the one exception: its natural key is the `sessionId` string.
4. **Paths in DERIVED tables are POSIX-style and relative to the Claude data directory**, so the
   database never embeds an absolute personal path. Two deliberate exceptions, each justified in
   place: `audit_log.claude_dir` (§3.14) and `file_touches.path` (§3.8).
5. **Every DERIVED row traceable to a file carries `source_file_id REFERENCES file_manifest(id) ON
   DELETE CASCADE`.** Deleting a manifest row deletes everything parsed from that file.
6. **USER tables carry `created_at INTEGER NOT NULL` and `updated_at INTEGER NOT NULL`.**
7. **Connection pragmas, on every connection:** `foreign_keys = ON`, `journal_mode = WAL`,
   `synchronous = NORMAL`, `busy_timeout = 5000`.
8. **No aggregate that could diverge from its source is stored** (ADR-027). Counts, sums, active
   time, cost and runtime overlays are computed at query time. Generated columns are used where an
   aggregate is a pure function of stored columns in the same row.
9. **All SQL lives under `src/main/db/**` and is reachable only through a repository function**
   (STACK ADR-008, ESLint-enforced). No view, component, hook or store touches SQL.

## §3.2 `file_manifest` — DERIVED — incremental-sync bookkeeping

```sql
CREATE TABLE file_manifest (
  id            INTEGER PRIMARY KEY,
  rel_path      TEXT    NOT NULL UNIQUE,        -- POSIX, relative to claudeDir
  kind          TEXT    NOT NULL CHECK (kind IN (
                  'transcript','subagent_transcript','history','stats_cache',
                  'skill_md','agent_md','claude_md','settings_json','plugin_manifest',
                  'memory_md','other')),
  size_bytes    INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  byte_offset   INTEGER NOT NULL DEFAULT 0,     -- bytes already consumed; resume point (§5.3)
  lines_parsed  INTEGER NOT NULL DEFAULT 0,
  bad_lines     INTEGER NOT NULL DEFAULT 0,     -- malformed JSON lines skipped; disclosed (§4.6)
  cache_split_mismatches INTEGER NOT NULL DEFAULT 0, -- A-05, migration 0005; §5.4 rule 8; §4.6
  content_hash  TEXT,                           -- sha256; non-JSONL config files only
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  parsed_at     INTEGER,
  -- Archive annotation (ADR-033/034). NULL = live. Non-NULL = RETAINED.
  archive_id       INTEGER REFERENCES archives(id) ON DELETE RESTRICT,
  archive_rel_path TEXT,                         -- POSIX, relative to archives.archive_root
  -- Orphan retention (ADR-041, migration 0009). 0 = live/purged. 1 = the file DISAPPEARED from
  -- <claudeDir> and its history is RETAINED — a SECOND road into the RETAINED class, distinct
  -- from archive_id because there is no archives row and nothing to undo (§2.2, §5.3).
  retained_orphan  INTEGER NOT NULL DEFAULT 0 CHECK (retained_orphan IN (0, 1)),
  -- API-call-id coverage (migration 0011). The number of LEADING lines of this file whose records
  -- were ingested before the app read message.id. An event was examined iff
  -- events.line_no > api_ids_from_line. 0 = the whole file was read by a build that reads the id.
  api_ids_from_line INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_file_manifest_kind    ON file_manifest(kind);
CREATE INDEX idx_file_manifest_archive ON file_manifest(archive_id) WHERE archive_id IS NOT NULL;
CREATE INDEX idx_file_manifest_retained_orphan ON file_manifest(retained_orphan) WHERE retained_orphan = 1;
```

⚠️ **AMENDED 2026-07-22 (ADR-041) — `retained_orphan`, the second RETAINED marker.** Added by
migration **0009** (0001–0008 immutable, ADR-007). It is deliberately NOT part of `archive_id`: a
row with `retained_orphan = 1` came from a transcript that **vanished** rather than one the app
moved, so it has no `archives` row, no recoverable location and no undo. The purge predicate
(§3.18) spares `archive_id IS NOT NULL` **or** `retained_orphan = 1`; §5.3's `MISSING` branch sets
it when `retainOrphanedHistory` is on; and it is cleared if the file ever returns (§5.3).

⚠️⚠️ **AMENDED 2026-07-24 (migration 0011) — `api_ids_from_line`, THE HONESTY COLUMN.** It exists
so that **"we checked and found nothing" and "we never checked" can never be the same number.**

`events.message_id` (§3.5) is NULL both for a record that states no API-call id and for every row
ingested before migration 0011. A count that could not tell those apart would report *"0 records
repeat an API call"* for a database in which **nothing was ever examined** — a plausible number
meaning the opposite of what it says, which is CLAUDE.md §1's worst outcome arriving dressed as a
disclosure. So the boundary is recorded, per file, as a **line watermark** rather than a boolean,
because a boolean is wrong under the append fast-path:

| §5.3 classification | What happens to the watermark | Why it is exact |
|---|---|---|
| **GREW** (append) | untouched | the appended lines sit above it; a per-file boolean would have claimed the older lines were checked too |
| **NEW**, or a row re-created after a purge | `DEFAULT 0` | the whole file was read by a build that reads the id |
| **SHRANK / REWROTE** | reset to `0` alongside `byte_offset` | the file is re-read from line 1 by this build |
| **ARCHIVED** / `retained_orphan = 1` | frozen at migration time | those transcripts are never re-parsed (§5.3, ADR-034/041), so their records can **never** be checked — which is why §4.6 gives them their own count and their own sentence |

The migration backfills `api_ids_from_line = lines_parsed`, the only correct value for an existing
row: every line that file has contributed so far was read by a build that did not look.

⚠️ **AMENDED 2026-07-22 (E10) — what `archives.archive_root` holds, so `archive_rel_path` has one
reading.** §3.2 says `archive_rel_path` is "relative to `archives.archive_root`" while §9.3 puts the
files at `<archiveRoot>/<claudeDirBasename>-<archiveId>/`. Those two are only consistent under one
reading, and it is now stated: **`archives.archive_root` stores the DESTINATION directory** — the
`<archiveRoot>/<claudeDirBasename>-<archiveId>` path, not the user's `archiveRoot` setting. Two
things follow, both wanted. §5.7 ACT-07 rule 1's "preserving the relative layout" becomes literal —
`archive_rel_path == rel_path` — and §6.10 card 7 shows the user the exact folder their transcripts
are in rather than the folder above it, which is what "an archive you cannot find is a delete with
extra steps" (§3.15) actually asks for. The `archiveRoot` **setting** keeps its own meaning and is
what INV-19 validates.

⚠️ **`rel_path` is never rewritten by archiving.** It stays the file's original path relative to the
Claude data directory — that is its identity, that is what `UNIQUE` protects, and that is what undo
needs to put the file back. Archiving only *annotates*: it sets `archive_id` and `archive_rel_path`.
This is also what makes **byte-offset integrity** free: a move preserves bytes exactly, so
`byte_offset` and `lines_parsed` stay valid and meaningful, and because archived files are never
re-parsed (§5.3) they are never re-read from either root.

`content_hash` is `NULL` for JSONL — hashing 1 GB per sync would defeat the point. JSONL change
detection uses `(size_bytes, mtime_ms)` plus the SHRANK/REWROTE branch (§5.3). Small config files
(`SKILL.md`, `CLAUDE.md`, `settings.json`, plugin manifests, `MEMORY.md`) are hashed, because their
mtimes churn and re-parsing them is cheap only if we can tell that nothing changed.

## §3.3 `projects` — DERIVED

```sql
CREATE TABLE projects (
  id           INTEGER PRIMARY KEY,
  encoded_name TEXT    NOT NULL UNIQUE,   -- literal directory name under projects/ — the identity
  display_name TEXT    NOT NULL,          -- decoded, for display ONLY; never an identity (OQ-007)
  color_index  INTEGER NOT NULL CHECK (color_index BETWEEN 0 AND 7),
  first_ts     INTEGER,
  last_ts      INTEGER
);
```

`display_name` is the last path-like segment of the decoded `encoded_name`. It is cosmetic. **Two
projects may share a `display_name`; they are still two projects** (worktrees are siblings, OQ-007)
and the UI disambiguates with the encoded name in a tooltip.

> ⚠️ **AMENDED 2026-07-22 — the sentence above is WRONG, and `display_name` is now derived from
> `events.cwd`. User-reported, reproduced against their own data.**
>
> **What was wrong.** Claude encodes a project path by replacing every non-alphanumeric character
> with `-`. That encoding is **lossy and ambiguous**: `-work-demo-Photo-Booth` is what
> `/work/demo/Photo-Booth` encodes to *and* what `/work/demo/Photo/Booth` encodes to, and nothing in
> the string says which. "The last path-like segment of the decoded name" therefore returns the last
> *hyphenated chunk*, not the folder. For example:
>
> | shown | `encoded_name` | the folder it actually is |
> |---|---|---|
> | `Booth` | `-work-…-demo-Photo-Booth` | `Photo-Booth` |
> | `Server` | `-work-…-demo-Home-Media-Server` | `Home-Media-Server` |
> | `Site` | `-work-…-demo-Portfolio-Site` | `Portfolio-Site` |
>
> The name should be the folder name, not only the last word: you can have many projects
> shown as "Server" when the real name of the project is `Home-Media-Server`. No decoder can fix this — the
> characters are not in the encoded name to recover.
>
> **The rule now.** `display_name` is the **basename of `events.cwd`**, re-derived at FINALIZING
> (§5.2) from the project's own events, never accumulated:
>
> 1. The encoding is character-for-character, so a project's root path is exactly the first
>    `length(encoded_name)` characters of any `cwd` inside it. That prefix is **anchored** when it
>    re-encodes to `encoded_name` (every alphanumeric matching literally, every `-` standing over a
>    non-alphanumeric). Anchoring is what makes `cwd` a *disambiguation of the identity* rather than
>    a second, competing source for it.
> 2. A `cwd` **deeper** than the root still anchors — the user `cd`s into a subdirectory mid-session,
>    which is real and was observed. The basename of the raw `cwd` would have named one of the user's
>    projects after its `website/` subfolder.
> 3. Events may disagree. The winner is the **most frequent** anchored root, ties broken
>    **lexicographically ascending** — a total order over stored values, so an append and a cold
>    parse agree (INV-04).
> 4. **No anchor, no change:** a project whose events carry no usable `cwd` keeps the
>    insert-time fallback, which is the old decoded-`encoded_name` behaviour. **No project is ever
>    left unnamed.**
>
> **What has NOT changed.** `encoded_name` is still the identity; `display_name` is still cosmetic;
> **two projects may still share one** and are still two projects. This fix makes that *more* common
> and correctly so — two separate `Photo-Booth` directories now both read `Photo-Booth`, and
> the UI still disambiguates with the encoded name in a tooltip.
>
> ⚠️ **Privacy (§7.8, P-33).** `cwd` is an absolute personal path and **only its basename** may be
> rendered or cross IPC. The derivation strips the prefix inside SQL; no absolute path is returned,
> logged, or written to a committed file. §3.8 sets the same precedent for `file_touches.path`.
>
> **Where it lives.** `RECOMPUTE_PROJECT_DISPLAY_NAMES` in
> `src/main/db/repositories/ingest-repo.ts`, run by FINALIZING. Migration **0006** carries the same
> statement so databases that already hold the wrong names are corrected at upgrade rather than at
> the next parse; it re-derives stored values and **purges nothing** — `0001`–`0005` are immutable
> (ADR-007), no event is touched, and RETAINED rows keep working (an archived session's events carry
> their `cwd` and take part exactly as live ones do).

`color_index = FNV1a32(encoded_name) mod 8`, indexing the categorical ramp in §6.1. A pure function of
the name, so hues survive a full rebuild (FRONTEND §1.3, "stable hue everywhere"). Collisions are
possible and acceptable, because FRONTEND §6 forbids encoding meaning by colour alone — every series
carries a label. The same function assigns model and tool hues (§6.1).

## §3.4 `sessions` — DERIVED

```sql
CREATE TABLE sessions (
  id                 TEXT    PRIMARY KEY,        -- sessionId == transcript file basename
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  transcript_file_id INTEGER REFERENCES file_manifest(id) ON DELETE SET NULL,
  first_ts           INTEGER,
  last_ts            INTEGER,
  span_seconds       INTEGER GENERATED ALWAYS AS ((last_ts - first_ts) / 1000) VIRTUAL,
  git_branch         TEXT,                       -- last non-null observed
  cli_version        TEXT,                       -- last non-null observed
  is_partial         INTEGER NOT NULL DEFAULT 0 CHECK (is_partial IN (0,1)),
  archive_id         INTEGER REFERENCES archives(id) ON DELETE RESTRICT,  -- NULL = live (ADR-033)
  -- Orphan retention (ADR-041, migration 0009). 1 = at least one of this session's source files
  -- disappeared and its history is RETAINED; the purge (§3.18) must spare the SESSION row too, or
  -- the sessions delete would cascade the kept events away (§3.5 ON DELETE CASCADE).
  retained_orphan    INTEGER NOT NULL DEFAULT 0 CHECK (retained_orphan IN (0,1))
) WITHOUT ROWID;
CREATE INDEX idx_sessions_project_first_ts ON sessions(project_id, first_ts);
CREATE INDEX idx_sessions_last_ts          ON sessions(last_ts);
CREATE INDEX idx_sessions_archive          ON sessions(archive_id) WHERE archive_id IS NOT NULL;
CREATE INDEX idx_sessions_retained_orphan  ON sessions(retained_orphan) WHERE retained_orphan = 1;
```

An **archived session** (`archive_id IS NOT NULL`) is RETAINED: it and everything reachable from it
survive every purge, rebuild and migration (§3.18). ⚠️ **AMENDED 2026-07-22 (ADR-041) — a session
is ALSO RETAINED when `retained_orphan = 1`.** It is marked (migration 0009) when at least one of
its source transcripts disappears from `<claudeDir>` and `retainOrphanedHistory` is on (§5.3), and
it is spared by the purge exactly as an archived session is. Unlike archiving, orphaning can be
**partial** — a session's main transcript can vanish while a subagent file survives — so the
session-grain marker (used by the `tool_calls`/`file_touches`/`subagent_runs` purge guards) and the
file-grain `file_manifest.retained_orphan` (used by the `events` guard) are **deliberately not
equivalent**: only events from a vanished file are spared, live-file events are re-derived (§3.18).
⚠️ **Archiving changes no metric.** An archived
session's events, tokens, tool calls and active time contribute to every total exactly as before —
that is the entire point of the option chosen in OQ-014. The only observable differences are that its
transcript no longer sits in the Claude data directory and that the UI marks it archived.

**No token totals, message counts, tool-call counts, active time or primary model are stored here.**
All are computed at query time from `events` and `tool_calls` (ADR-027). This is what makes the
roll-up impossible to get wrong by drift: there is exactly one number, and it is the `SUM`.

`is_partial = 1` when prompts reference this `sessionId` but no transcript file exists for it
(§5.9 M-16).

## §3.5 `events` — DERIVED — the fact table

```sql
CREATE TABLE events (
  id              INTEGER PRIMARY KEY,
  event_key       TEXT    NOT NULL UNIQUE,      -- uuid, else '<rel_path>#<line_no>'  (ADR-019)
  session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_file_id  INTEGER NOT NULL REFERENCES file_manifest(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,
  ts              INTEGER NOT NULL,             -- UTC epoch ms, normalized on ingest (ADR-021)
  type            TEXT    NOT NULL,             -- raw record `type`, verbatim
  role            TEXT,                         -- 'assistant' | 'user' | NULL
  origin          TEXT    NOT NULL CHECK (origin IN ('main','subagent')),   -- ADR-020
  subagent_run_id INTEGER REFERENCES subagent_runs(id) ON DELETE SET NULL,
  uuid            TEXT,
  parent_uuid     TEXT,
  message_id      TEXT,                         -- message.id, verbatim (migration 0011); NULL if absent
  request_id      TEXT,                         -- requestId, verbatim (migration 0011); NULL if absent
  is_sidechain    INTEGER NOT NULL DEFAULT 0 CHECK (is_sidechain IN (0,1)),
  model           TEXT,                         -- raw message.model, verbatim (ADR-025); NULL if absent
  is_synthetic    INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  is_api_error    INTEGER NOT NULL DEFAULT 0 CHECK (is_api_error IN (0,1)),
  tok_input       INTEGER NOT NULL DEFAULT 0,   -- message.usage.input_tokens
  tok_output      INTEGER NOT NULL DEFAULT 0,   -- message.usage.output_tokens
  tok_cache_write INTEGER NOT NULL DEFAULT 0,   -- 5-MINUTE cache writes (A-05); see below
  tok_cache_write_1h INTEGER,                   -- 1-HOUR cache writes (A-05, migration 0005)
                                                -- ⚠️ NULLABLE: NULL = "the split is not known"
  tok_cache_read  INTEGER NOT NULL DEFAULT 0,   -- message.usage.cache_read_input_tokens
  git_branch      TEXT,
  cli_version     TEXT,
  cwd             TEXT
);

CREATE INDEX idx_events_session_ts  ON events(session_id, ts);
CREATE INDEX idx_events_project_ts  ON events(project_id, ts);
CREATE INDEX idx_events_ts          ON events(ts);
CREATE INDEX idx_events_file        ON events(source_file_id);
CREATE INDEX idx_events_origin      ON events(session_id, origin);
CREATE INDEX idx_events_parent_uuid ON events(parent_uuid) WHERE parent_uuid IS NOT NULL;
CREATE UNIQUE INDEX uq_events_uuid  ON events(uuid) WHERE uuid IS NOT NULL;

-- Migration 0011 — the grouped count §4.6's repeated-API-call disclosure makes. Partial on the
-- same population the count uses, so it costs nothing for the rows that have no id.
CREATE INDEX idx_events_message_id ON events(message_id, id)
  WHERE message_id IS NOT NULL AND is_synthetic = 0
    AND (tok_input + tok_output + tok_cache_write
         + COALESCE(tok_cache_write_1h, 0) + tok_cache_read) > 0;

-- Partial index over exactly the population that is priced and counted in model stats.
-- The <synthetic> exclusion made structural rather than remembered.
CREATE INDEX idx_events_priceable ON events(model, ts, id)
  WHERE is_synthetic = 0
    AND model IS NOT NULL
    AND (tok_input + tok_output + tok_cache_write
         + COALESCE(tok_cache_write_1h, 0) + tok_cache_read) > 0;
```

> ⚠️ **AMENDED 2026-07-22 (A-05) — the fifth token column, and why it is the only nullable one.**
>
> `tok_cache_write` now holds `message.usage.cache_creation.ephemeral_5m_input_tokens` and
> `tok_cache_write_1h` holds `ephemeral_1h_input_tokens` (§5.4 rule 8, §2.1 "Token class").
> Migration **0005** adds the column; `0001`–`0004` are immutable (ADR-007).
>
> ⚠️ **`tok_cache_write_1h` is `INTEGER` with no `NOT NULL` and no default, unlike the other four,
> and that is the entire disclosure mechanism.** Every row that existed before migration 0005 gets
> **NULL**, meaning *"this row was parsed before the split was captured; its 1-hour share is not
> known."* It is the same use of NULL as `harness_nodes.entry_count` (migration 0003) and it is
> **never read as zero** by anything that reports it.
>
> **What that buys, in the two places it matters.** The cost path reads `COALESCE(…, 0)`, which
> reproduces the pre-A-05 arithmetic bit for bit — those rows keep costing exactly what they cost
> before the migration, so **no number moves under the user on upgrade** — and §4.6 gains
> `cacheSplitUnknownEvents` / `cacheSplitArchivedEvents`, so "N records are still using the old,
> understated split" is **data in the payload** rather than an invisible fact (CLAUDE.md §1). A
> `NOT NULL DEFAULT 0` column could not have told the two apart: "no 1-hour writes" and "we do not
> know" would have been the same byte.
>
> **The parser never writes NULL.** It writes the real split, or `0` when the record carries no
> `cache_creation` object at all — a known fact about that source record, not an unknown about the
> row. The one exception is §5.4 rule 8's mismatch case, which is counted and disclosed.
>
> The priceable partial index above gains the new column for the same reason it has the others: an
> event whose only tokens are 1-hour cache writes must be inside it. `cost.ts`'s `PRICEABLE`
> predicate mirrors this index verbatim and the two are changed together.

> ⚠️⚠️ **AMENDED 2026-07-24 (migration 0011) — `message_id` and `request_id`: the API call a
> record came from, stored so repeated usage becomes MEASURABLE. It changes no number.**
>
> **The observation.** Claude Code commonly writes one assistant turn — text plus its tool calls —
> as **several JSONL lines** that share one `message.id` and repeat the identical `message.usage`,
> each carrying its own distinct `uuid`. Line identity (ADR-019, below) is therefore behaving
> exactly as specified: `event_key` differs, the `ON CONFLICT DO NOTHING` correctly does not fire,
> and those lines really are distinct records. But every one of them is summed into M-02/M-04/M-05,
> so **one API call is charged N times.** This is the most plausible single explanation for a
> lifetime total larger than it should be, and it is what made a $200/month subscriber read
> $17,726.65 as money spent.
>
> **What migration 0011 deliberately did NOT do — and what ADR-042 then did.** 0011 changed no
> number: it added the columns and a per-file watermark so the effect could be **sized against real
> data** before anything was decided (a metric change sized by intuition is exactly the silently-wrong
> number CLAUDE.md §1 forbids). ⚠️ **AMENDED 2026-07-24 (ADR-042) — it has now been sized and acted
> on.** On the reference dataset 187,870 costed rows are 85,234 distinct calls; §5.9 M-02/M-04/M-05
> now sum each API call ONCE, at its final line's usage, **at query time** (this migration's storage
> and `event_key` are untouched). The full rule and its consequences are the ⚠️ block below §5.9's
> table and ADR-042; §4.6's `repeatedApiCalls` disclosure remains, now reporting which records could
> and could not be collapsed.
>
> ⚠️ **NEITHER COLUMN IS PART OF EVENT IDENTITY.** `event_key` is unchanged and ingest is still
> `ON CONFLICT(event_key) DO NOTHING`. Grouping by `message_id` is a **query-time observation**
> about rows that all legitimately exist. It is not a second dedup key, and no record is dropped,
> merged or re-counted because of it.
>
> ⚠️ **Both are NULLABLE with no default and NO placeholder is ever written** — same shape and same
> reason as `tok_cache_write_1h` above. A sentinel would put a word in the data the transcript does
> not contain, and would make every pre-migration row look like a checked one. How "states no id"
> is told apart from "was never read" is `file_manifest.api_ids_from_line` (§3.2).

**Ingest is `INSERT ... ON CONFLICT(event_key) DO NOTHING`** (ADR-019). Re-parsing a file, replaying
an append, or meeting the same record in two files can never double-count.

⚠️ **What that sentence does and does not claim, stated because it was misread as covering more
than it does.** It is about **one record met twice** — the same `event_key`, so the same line of the
same file, or a record duplicated across two files. It says nothing about **several distinct records
that share one API call**: those have different `event_key`s, are correctly stored as separate rows,
and are each counted. That second thing is measured and disclosed (migration 0011, §4.6), not
deduplicated.

`tok_*` are plain 64-bit `INTEGER`. The largest observed accumulator is ~3.1e9 cache reads and sums
stay far below `2^63`, so **`BigInt` is not used at the SQL layer**. Sums crossing the IPC boundary
are `number` and the repository asserts `<= Number.MAX_SAFE_INTEGER` (9.007e15) before serialising
(INV-11). This is a choice, not a default (STACK ADR-009).

`cwd` is retained for provenance only, is never rendered, and never leaves the database.

> ⚠️ **AMENDED 2026-07-22 — `cwd` is now the source of the project's display name, and the
> "never rendered" clause is narrowed to "only its basename".**
>
> **Why the constraint had to move.** §3.3 derived `display_name` by decoding `encoded_name`, and
> that encoding replaces every non-alphanumeric character with `-` — it is lossy and ambiguous, so
> `Home-Media-Server` was displayed as "Server" and `Photo-Booth` as "Booth" on real
> data. `cwd` is the **only unambiguous record of the folder's real name** we hold, and it is already
> populated. Deriving the name from it is strictly more correct than decoding an encoding that cannot
> be decoded. The full amendment, including the anchoring rule and the fallback, is in §3.3.
>
> **The rule, stated as a constraint:** `cwd` is still never rendered and still never leaves the
> database **as a path**. Exactly one thing derived from it may be shown — the **basename** of the
> project root, as `projects.display_name`. That is the whole exemption:
>
> - ⚠️ **No absolute path may cross IPC**, be logged, or be written into a committed file (§7.8,
>   P-33). The derivation strips everything up to the final `/` inside SQL, so no `cwd` prefix is
>   ever selected out of the database in the first place.
> - The column keeps its provenance role. Nothing joins, groups, filters or counts on it, and it is
>   **not** an identity: `encoded_name` remains the project's identity (§3.3).
>
> §3.8 already set this precedent for `file_touches.path`, which is likewise an absolute personal
> path that is stored and rendered basename-first. §7.8 is unchanged and intact — the repository, the
> logs and the IPC surface still carry no personal path.

## §3.6 `tool_calls` — DERIVED

```sql
CREATE TABLE tool_calls (
  id             INTEGER PRIMARY KEY,
  event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id     TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  origin         TEXT    NOT NULL CHECK (origin IN ('main','subagent')),
  ts             INTEGER NOT NULL,
  ordinal        INTEGER NOT NULL,        -- index of the tool_use item within message.content[]
  tool_name      TEXT    NOT NULL,        -- includes 'Agent' and 'Skill' (§2.1)
  tool_use_id    TEXT,                    -- content item `id` when present
  skill_name     TEXT,                    -- tool_name='Skill' -> the invoked skill name
  subagent_type  TEXT,                    -- tool_name='Agent' -> input.subagent_type
  description    TEXT,                    -- tool_name='Agent' -> input.description  (A-09)
  target_path    TEXT,                    -- write-class only -> input.file_path / notebook_path
  is_write_class INTEGER NOT NULL DEFAULT 0 CHECK (is_write_class IN (0,1)),
  UNIQUE (event_id, ordinal)
);
CREATE INDEX idx_tool_calls_name_ts    ON tool_calls(tool_name, ts);
CREATE INDEX idx_tool_calls_session_ts ON tool_calls(session_id, ts, ordinal);
CREATE INDEX idx_tool_calls_project_ts ON tool_calls(project_id, ts);
CREATE INDEX idx_tool_calls_skill      ON tool_calls(skill_name) WHERE skill_name IS NOT NULL;
```

`is_write_class = 1` iff `tool_name IN ('Edit','MultiEdit','Write','NotebookEdit')`. That set is a
single exported constant in `src/shared/tool-taxonomy.ts`, so §3.8 and §5.9 M-15 cannot drift apart.
`UNIQUE (event_id, ordinal)` makes tool-call ingest idempotent alongside ADR-019.

⚠️ **AMENDED 2026-07-22 (E3) — this DDL declared no `description` column, and two other sections
read one.** §3.7 states that `subagent_runs.description` comes "from the spawning `Agent` tool call,
when linked", and §5.4 rule 9 already extracts it ("For `Agent`, `subagent_type` **and
`description`** come from `input`") — but with no column here the value had nowhere to land, so
`subagent_runs.description` was deterministically `NULL`. That is not a cosmetic gap: §4.5's
`SessionDetail.subagentRuns[].description` and §6.5's session drill-down both render the field, so
amending §3.7 to drop it would have silently removed something two other sections promise. The
column is therefore added, **beside `subagent_type`, which was already here and which it exactly
parallels** — same tool, same `input` object, same linkage.

**The fix is migration `0002-tool-call-description.sql`, not an edit to `0001`.** STACK ADR-007 makes
merged migration files immutable and `0001-initial.sql` is committed; editing it would leave every
already-migrated database silently divergent from a freshly-created one, which is this document's own
failure mode aimed at the schema. §3 preamble's "§3.2–§3.17 **is** migration `0001`" therefore still
holds as written — this DDL block is now the schema after `0002`, and `db-migration-review` (§12.2)
diffs it against the migration set rather than against `0001` alone.

⚠️ The value is **not** carried across files in memory. `subagent_runs.description` is recomputed at
FINALIZING (§5.2) from the linked `tool_calls` row, the same recompute-from-current-table-contents
path every other cross-file value uses. Filling it opportunistically from whatever the current parse
pass happened to hold would have made the column depend on file order — INV-04.

## §3.7 `subagent_runs` — DERIVED

```sql
CREATE TABLE subagent_runs (
  id                 INTEGER PRIMARY KEY,
  session_id         TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  transcript_file_id INTEGER NOT NULL UNIQUE REFERENCES file_manifest(id) ON DELETE CASCADE,
  spawn_event_id     INTEGER REFERENCES events(id) ON DELETE SET NULL,      -- NULL = unlinked
  spawn_tool_call_id INTEGER REFERENCES tool_calls(id) ON DELETE SET NULL,
  subagent_type      TEXT,           -- the run's agent type, when known (see AMENDED below)
  description        TEXT,           -- the spawn label, when known (see AMENDED below)
  first_ts           INTEGER,
  last_ts            INTEGER,
  -- ⚠️ AMENDED 2026-07-22, migration 0008 — the run's own `<run-id>.meta.json`, VERBATIM.
  -- Parsed facts, not answers: the four columns above are recomputed from these at FINALIZING.
  meta_agent_type    TEXT,           -- sidecar `agentType`
  meta_tool_use_id   TEXT,           -- sidecar `toolUseId` -> tool_calls.tool_use_id
  meta_description   TEXT            -- sidecar `description`
);
CREATE INDEX idx_subagent_runs_session ON subagent_runs(session_id, first_ts);
CREATE INDEX idx_subagent_runs_type    ON subagent_runs(subagent_type) WHERE subagent_type IS NOT NULL;
-- migration 0008
CREATE INDEX idx_subagent_runs_meta_tool_use
  ON subagent_runs(meta_tool_use_id) WHERE meta_tool_use_id IS NOT NULL;
CREATE INDEX idx_subagent_runs_meta_pending
  ON subagent_runs(id) WHERE meta_agent_type IS NULL;
CREATE INDEX idx_tool_calls_tool_use          -- on §3.6 `tool_calls`
  ON tool_calls(tool_use_id) WHERE tool_use_id IS NOT NULL;
```

**Session attribution is structural** — from the path `projects/<proj>/<session-id>/subagents/*.jsonl`
— and is never inferred. **Spawn linkage is best-effort and also structural.** ⚠️ **No
timestamp-proximity or nearest-preceding heuristic is ever used.** Runs that do not resolve keep
`spawn_event_id IS NULL` and are **disclosed** in Execution Trace as *"N subagent runs could not be
linked to a spawn point"* (§4.6, §6.7). Totals are unaffected, because attribution is structural and
linkage is only a label.

### ⚠️ AMENDED 2026-07-22 — the specified linkage rule resolves **0 of 2,514** runs on real data

**What was specified.** "The run's earliest event's `parent_uuid` is resolved against `events.uuid`;
if that event is an assistant event carrying an `Agent` tool call, `spawn_event_id`,
`spawn_tool_call_id`, `subagent_type` and `description` are filled."

**What it does.** Nothing. Not intermittently — **never**. Measured on the reporting user's dataset:

| Fact | Count |
|---|---|
| `subagent_runs` rows | 2,516 |
| …whose earliest event carries a `parent_uuid` at all | **0** |
| subagent-origin events with `parent_uuid IS NULL` | 2,515 — exactly one per run |
| subagent events whose `parent_uuid` resolves to a **main-loop** event | **0** |
| runs with `subagent_type` filled, before this amendment | **0** |

⚠️ **The rule was not mis-implemented. It was written over an edge that does not exist.** A subagent
transcript's first event is the head of its own chain; the uuid chain is *per-file* and never crosses
the file boundary. No query fixes that, and pretending otherwise would leave a permanent, silent gap
where §5.9 M-14's runtime overlay and §6.7's Execution Trace both read.

**What the disk actually carries.** Every `subagents/<run-id>.jsonl` has a sibling
**`<run-id>.meta.json`** carrying `agentType`, `description` and `toolUseId` — the spawning `Agent`
call's `tool_use_id`, which joins to §3.6 `tool_calls.tool_use_id` exactly.

⚠️ **The sidecar is *more* structural than the uuid chain, not less.** It sits inside the run's own
directory, beside the transcript it describes — the same kind of evidence ADR-020 already prefers over
the record-level `isSidechain` flag: *where the file is*, not what a record claims about itself.
Reading it is not a fallback to a weaker signal.

⚠️ **It is not a competing source of truth.** Where both exist they agree, everywhere:

| Comparison | Agree | Disagree |
|---|---|---|
| sidecar `agentType` vs the linked `Agent` call's `subagent_type` | 2,334 | **0** |
| sidecar `description` vs the linked `Agent` call's `description` | 2,438 | **0** |
| runs the sidecar names that the `Agent` call does **not** (`input` had no `subagent_type`) | 104 | — |

**The precedence, stated once** (implemented by `RESOLVE_SPAWN_LINKS`, a full recompute over current
table contents at FINALIZING — §5.2, INV-04):

1. `spawn_tool_call_id` ← the `Agent` tool call whose `tool_use_id` equals the sidecar's `toolUseId`;
   `spawn_event_id` ← that call's event. `tool_name = 'Agent'` is required — a `toolUseId` pointing at
   something that is not an `Agent` call is **not** a spawn point, and the honest answer is "unlinked".
2. Otherwise, the original `parent_uuid` → `uuid` chain above, unchanged. It is kept because it is
   deterministic, costs nothing once the sidecar half has run, and would start working with no code
   change if a future on-disk layout began writing that edge.
3. `subagent_type` ← sidecar `agentType`, else the linked call's `subagent_type`.
   `description` ← sidecar `description`, else the linked call's `description`.

⚠️ **Partial knowledge is kept, never rounded up or down.** A sidecar that names an `agentType` and no
`toolUseId` (the nested `subagents/workflows/<wf>/` runs — 77 of them) fills the **label** and leaves
the **link** `NULL`. So does a `toolUseId` that matches no tool call. Such a run is still counted as
unlinked and still disclosed: "unlinked" is a statement about `spawn_event_id`, not about whether
anything is known.

⚠️ **What did NOT change, and must not.** Session attribution is still the path and only the path
(ADR-020, §5.4 rules 4–5). Linkage is still best-effort, still **disclosed when it genuinely fails**
(§4.6, §6.6, §6.7), and still contains **no** timestamp proximity, **no** nearest-preceding rule and
**no** "the only `Agent` call in that window". That prohibition is why the totals are trustworthy, and
it is why the disclosure count does not go to zero.

⚠️ **Totals were never affected — before the amendment or after it.** Attribution is structural and
linkage is only a label, so every displayed quantity is byte-identical whether a run links or not.
That claim is now executable rather than argued: a golden fixture syncs the same tree twice, once with
every sidecar deleted, and asserts the origin split, the token classes, the tool-call counts, the
per-session run attribution and the session bounds are identical across the two.

**Result on the reporting user's data:** 2,438 of 2,516 runs now carry `spawn_event_id`,
`spawn_tool_call_id`, `subagent_type` and `description`; 2,515 carry `subagent_type`. The disclosure
falls from **2,516 to 78**, and 78 is the honest floor: 77 nested workflow runs whose sidecar states no
`toolUseId`, and one transcript with no sidecar at all.

## §3.8 `file_touches` — DERIVED

```sql
CREATE TABLE file_touches (
  id           INTEGER PRIMARY KEY,
  tool_call_id INTEGER NOT NULL UNIQUE REFERENCES tool_calls(id) ON DELETE CASCADE,
  session_id   TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ts           INTEGER NOT NULL,
  path         TEXT    NOT NULL,   -- verbatim from the tool input; may be absolute (§3.1.4 exception)
  basename     TEXT    NOT NULL,
  extension    TEXT,               -- lowercased, no dot; NULL when the basename has none
  language     TEXT,               -- from the §5.9 M-15 extension map; NULL when unmapped
  tool_name    TEXT    NOT NULL
);
CREATE INDEX idx_file_touches_project_ts ON file_touches(project_id, ts);
CREATE INDEX idx_file_touches_session    ON file_touches(session_id);
CREATE INDEX idx_file_touches_language   ON file_touches(language) WHERE language IS NOT NULL;
```

`path` may be an absolute path from the user's own machine — it is a tool argument, not something we
construct. It is stored (the database is never committed) but is **rendered basename-first**, with the
full path only in a hover title. The `file-history/` directory itself is **not parsed** in v1
(ADR-028); its disk size is still measured for Bloat Radar.

## §3.9 `prompts` — DERIVED

```sql
CREATE TABLE prompts (
  id              INTEGER PRIMARY KEY,
  source_file_id  INTEGER NOT NULL REFERENCES file_manifest(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,
  ts              INTEGER NOT NULL,     -- normalized from ms epoch (HANDOFF §4)
  project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  raw_project     TEXT,                 -- literal `project` value, kept when it matches no project
  session_id      TEXT,                 -- NOT a FK: may name a session with no transcript
  display_preview TEXT,                 -- first 280 characters of `display`
  display_chars   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_file_id, line_no)
);
CREATE INDEX idx_prompts_ts      ON prompts(ts);
CREATE INDEX idx_prompts_project ON prompts(project_id, ts);
```

⚠️ **`pastedContents` is never stored, in any form.** It is bulk pasted material with no analytic
value; storing it would grow the database without bound and widen the personal-data surface for no
benefit. `display_preview` is capped at 280 characters and is shown **only** in the graph inspector
(§6.7) — never as a list, never searchable (§1.6 non-goal 1).

## §3.10 `harness_nodes` / `harness_edges` — DERIVED

```sql
CREATE TABLE harness_nodes (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN (
                'skill','agent','command','tool','file','plugin','marketplace',
                'memory','claude_md','settings')),
  name        TEXT NOT NULL,        -- SKILL.md frontmatter `name`, tool name, or file basename
  source      TEXT NOT NULL CHECK (source IN ('user','plugin','builtin','transcript')),
  plugin_id   INTEGER REFERENCES harness_nodes(id) ON DELETE CASCADE,
  rel_path    TEXT,                 -- relative to claudeDir; NULL for tool nodes
  role        TEXT,                 -- metadata.role, e.g. 'orchestrator'
  description TEXT,
  size_bytes  INTEGER NOT NULL DEFAULT 0,   -- on-disk size of rel_path, recursive for directories
  mtime_ms    INTEGER,
  enabled     INTEGER CHECK (enabled IN (0,1)),  -- plugins/marketplaces; NULL where not applicable
  entry_count INTEGER,               -- M-21; NULL = not counted. Migration 0003 (E10), see below
  file_id     INTEGER REFERENCES file_manifest(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_harness_nodes ON harness_nodes(kind, name, source, COALESCE(rel_path, ''));
CREATE INDEX idx_harness_nodes_kind ON harness_nodes(kind);

CREATE TABLE harness_edges (
  id       INTEGER PRIMARY KEY,
  from_id  INTEGER NOT NULL REFERENCES harness_nodes(id) ON DELETE CASCADE,
  to_id    INTEGER NOT NULL REFERENCES harness_nodes(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('handoff','tool_grant','reads','writes','contains')),
  evidence TEXT NOT NULL CHECK (evidence IN ('frontmatter','body_mention','directory')),
  UNIQUE (from_id, to_id, kind)
);
CREATE INDEX idx_harness_edges_from ON harness_edges(from_id);
CREATE INDEX idx_harness_edges_to   ON harness_edges(to_id);
```

**Edge derivation is exact and testable — no natural-language inference:**

| Edge kind | Evidence | Rule |
|---|---|---|
| `tool_grant` | `frontmatter` | skill → tool node, one per entry of `allowed-tools` |
| `reads` / `writes` | `frontmatter` | skill → file node, one per entry of `metadata.reads` / `metadata.writes` |
| `handoff` | `body_mention` | skill A → skill B iff B's frontmatter `name` occurs in A's body as a whole token (delimited by any character outside `[A-Za-z0-9_-]`), case-sensitive, self-excluded. Verified case: `setup-project` yields 8 sibling edges (HANDOFF §4). |
| `contains` | `directory` | plugin → every skill/agent/command node under the plugin's directory; marketplace → plugin |

⚠️ **AMENDED 2026-07-22 (E10) — `entry_count`, and the metric it carries.** §6.9 specifies the memory
browser as "every `MEMORY.md`, its project, size, **entry count** and staleness" and §4.5 types
`q:memories` with `entryCount: number`, but this DDL declared no such column, §3.2 declares none, and
**no section of this document defined what an "entry" of a `MEMORY.md` is.** E6 recorded the gap and
returned `0` only because no memory node existed yet, noting that the moment a scanner inserted one
that `0` would become a fabricated number — which CLAUDE.md §1 rates as the worst possible outcome.
The column is added by `0003-harness-node-entry-count.sql` (a **new numbered file**; `0001` and
`0002` are merged and immutable, ADR-007) and the counting rule is **M-21** in §5.9, where every
other metric lives.

⚠️⚠️ **M-21 is the one definition in this document that originated in the build rather than in the
source documents.** It was never user-confirmed and no verified source describes it. It is stated
mechanically so it is checkable, and §6.9 renders the definition beside the number rather than
showing a bare figure; a reader who disagrees with the rule should change M-21, not the scanner.
`NULL` means "not counted" — the honest value for every node kind that is not a memory — and is
never read as zero.

⚠️ **Parsed harness text is data, never instructions** (HANDOFF §9, STACK ADR-017). It is rendered and
counted, never executed, never interpolated into anything executable, and never sent anywhere.

The **runtime overlay** is **not stored** (ADR-027). `harnessGraph()` (§4.5) computes it by joining
`harness_nodes(kind='skill').name` to `tool_calls.skill_name` and `harness_nodes(kind='tool').name` to
`tool_calls.tool_name`, over the full dataset (INV-13).

⚠️ **AMENDED 2026-07-22 (ADR-039) — `project_id`, `harness_run_agents`, and the observed edge set.**

```sql
ALTER TABLE harness_nodes ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS uq_harness_nodes;
CREATE UNIQUE INDEX uq_harness_nodes
  ON harness_nodes(kind, name, source, COALESCE(rel_path, ''), COALESCE(project_id, 0));
CREATE INDEX IF NOT EXISTS idx_harness_nodes_project
  ON harness_nodes(project_id) WHERE project_id IS NOT NULL;

CREATE TABLE harness_run_agents (
  transcript_rel_path TEXT PRIMARY KEY,   -- file_manifest.rel_path of the run's transcript
  agent_type          TEXT NOT NULL,      -- from subagents/<run>.meta.json `agentType`
  spawn_tool_use_id   TEXT                -- its `toolUseId` → tool_calls.tool_use_id; NULL = unknown
);
CREATE INDEX idx_harness_run_agents_tool_use
  ON harness_run_agents(spawn_tool_use_id) WHERE spawn_tool_use_id IS NOT NULL;
```

Both arrive in `0004-project-harness.sql` — a **new numbered file**; `0001`–`0003` are merged and
immutable (ADR-007). `harness_run_agents` is DERIVED and replaced whole on every scan beside the two
tables above, and it is a parsed **fact**, not an aggregate, so ADR-027 is untouched.

- **`project_id`** — which project declared this node, `NULL` for everything scanned from the Claude
  data directory. ⚠️ It also changes what `rel_path` means: `NULL` ⇒ relative to `claudeDir`;
  non-`NULL` ⇒ relative to **that project**. It is the exclusion marker throughout: such a node is
  filtered out of `q:skills`, `q:memories` and `q:plugins`, never reaches Bloat Radar, never enters
  `file_manifest`, and is never watched. **A project's harness file is never deletable and never
  counted as bloat** (ADR-039, INV-14's shape applied to a second root).
- **`harness_run_agents`** — ⚠️⚠️ §3.7's spawn linkage resolves for **0 of 2514** runs on real data,
  which left the observed half of M-14 structurally empty. The name is on disk in the
  `agent-*.meta.json` sidecar beside each run. Every rule below reads
  `COALESCE(subagent_runs.subagent_type, harness_run_agents.agent_type)` — §3.7 first — so this
  becomes redundant, not contradictory, when the linkage is fixed.

**The observed edge set (`designed: false`), exact and testable, no natural-language inference:**

| Rule | From | To | Kind | Rule |
|---|---|---|---|---|
| **O-1** | `agent` A | `skill` S · `tool` T | `handoff` · `tool_grant` | a tool call inside a run whose agent type is A. `Agent` calls carrying a `subagent_type` are excluded — O-2 draws those |
| **O-2** | `agent` A | `agent` B | `handoff` | an `Agent` call with `subagent_type = B` inside a run whose agent type is A |
| **O-3** | `claude_md` named exactly `CLAUDE.md`, `project_id = P` | `agent` B | `handoff` | a **main-loop** `Agent` call with `subagent_type = B` and `tool_calls.project_id = P` |

An **unlinked, unnamed** run contributes nothing to any of them: no edge is invented (ADR-020).
Main-loop **tool** calls still produce no edge — §3.6 records no skill for one — and are shown on the
node overlay instead. ⚠️ O-3 carries the one semantic assumption in this table (that a project's own
root `CLAUDE.md` is what dispatched from the main loop); ADR-039 states it in full.

An `agent` node's `metrics.observed` is the count of **spawns** of that agent (`tool_calls` with
`tool_name = 'Agent'` and that `subagent_type`), never the calls it then made — those are its
outgoing edges. §2.1's **Agent definition** already named this join ("…**or** a `subagent_type` value
observed in an `Agent` tool call"); before ADR-039 it had no implementation and every agent node
reported `0`. `skill` and `agent` nodes join `source = 'transcript'` alongside `tool` nodes, so the
Map is populated even when no configuration file exists anywhere.

⚠️ **AMENDED 2026-07-23 — `version`, and the label the Harness Map draws (§6.7 / §1a).**

```sql
ALTER TABLE harness_nodes ADD COLUMN version TEXT;   -- 0010-harness-node-version.sql
```

Node identity is `(kind, name, source, rel_path, project_id)` (`uq_harness_nodes`, above), so two
on-disk entities that legitimately share a `name:` are two DISTINCT nodes. The concrete case: a
plugin cache holds two **versions** of one plugin side by side, each shipping a skill whose
frontmatter `name` is the same. Both are correct, distinct vertices — this is **not** a dedup, and
dropping one would be wrong, because two *different* plugins may also ship a same-named skill and
that must keep working. But `harnessGraph()` (§4.5) drew each node with `label = name`, so the two
rendered as two **identical** labels the user could not tell apart.

The fix disambiguates the **label**, never the node set. `version` is the plugin manifest's own
`version`, read by the scanner from `plugin.json` / `marketplace.json` (the robust source — a skill
directory may sit several levels below `plugin.json`, so a path segment is not) and stored on the
plugin / marketplace node; `NULL` for every other node and for a manifest that declares none, and
never read as a version of `0`. `harnessGraph()` reads it — directly for a plugin node, via
`plugin_id` for the skills a plugin contains — and qualifies **only** the labels that actually
collide, with a **plain** distinguisher: `setup-project (0.4.0)` vs `setup-project (0.5.0)`. A
unique label keeps its bare name (§1a: suffixing everything trades ambiguity for clutter). When a
version does not separate a colliding pair — two *different* plugins, or a project-level collision —
the qualifier falls back through the plugin name, the project name, then plain words for the
node's source, in that order; it is never an internal identifier, a `source` enum value, a
`rel_path` or a key (§1a). `version` is **not** part of node identity — two plugin versions already
differ by `rel_path` — so `uq_harness_nodes` is unchanged. The rule lives in
`src/main/db/repositories/harness-labels.ts`; golden cases in `test/metrics/harness-node-label.test.ts`.

## §3.11 `price_rows` — USER — bi-temporal, five token classes

⚠️ **This is the schema's trickiest part and squarely in silently-wrong-number territory.**

```sql
CREATE TABLE price_rows (
  id                     INTEGER PRIMARY KEY,
  model                  TEXT    NOT NULL,     -- EXACT raw message.model string (ADR-025)
  token_class            TEXT    NOT NULL CHECK (token_class IN
                           ('input','output','cache_write','cache_write_1h','cache_read')),
  rate_picousd_per_token INTEGER NOT NULL CHECK (rate_picousd_per_token >= 0),  -- ADR-023 (amended)
  valid_from             INTEGER NOT NULL,     -- UTC epoch ms, INCLUSIVE
  valid_to               INTEGER,              -- UTC epoch ms, EXCLUSIVE; NULL = still in effect
  source                 TEXT    NOT NULL CHECK (source IN ('seed','fetch','manual')),
  source_url             TEXT,                 -- set when source='fetch'
  note                   TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- The covering index for the bi-temporal join (STACK ADR-007).
CREATE INDEX idx_price_rows_cover
  ON price_rows(model, token_class, valid_from, valid_to, rate_picousd_per_token);

-- At most ONE open-ended row per (model, token_class). Enforced by the engine, not by review.
CREATE UNIQUE INDEX uq_price_rows_open
  ON price_rows(model, token_class) WHERE valid_to IS NULL;
```

> ⚠️ **AMENDED 2026-07-22 (A-05) — `cache_write_1h` joins the CHECK, and the widening had to be
> done without dropping the table.**
>
> The decision, the evidence and the measured $415.07 shortfall are recorded once, in §2.1 "Token
> class"; this block records only what it cost the schema.
>
> ⚠️ **SQLite cannot `ALTER` a CHECK constraint, and ADR-026 says of `price_rows`: "never
> truncated, never dropped, and carried across every migration."** The usual SQLite rebuild ends by
> destroying the original table, which is not available here — this is the one table in the
> database whose contents have no other source (§9.4), and `migrate.test.ts` enforces the
> prohibition as a textual guard over every migration's SQL. Migration **0005** therefore rebuilds
> by **rename-aside**: it drops the two indexes, renames `price_rows` to `price_rows_pre_0005`,
> creates the new `price_rows` with the widened CHECK, copies every row across column by column
> **including `id`**, and recreates both indexes under their original names.
>
> ⚠️ **`price_rows_pre_0005` survives on purpose and is classified USER**, so no purge and no
> rebuild can remove it (ADR-026, INV-12). Nothing in the application reads it. It is the only
> in-database pre-image of a USER table this project has ever rewritten, and it costs a few hundred
> rows — see §9.4, which is where the backup story for the USER half lives.
>
> ⚠️ **The rate is still stored, never derived.** 1-hour is 2× input and 5-minute 1.25× input for
> every model in today's seed. That is an observation about a published page; ADR-024 records the
> user's explicit rejection of computing one from the other, and A-05 does not reopen it.

**Units (ADR-023, amended 2026-07-20).** `rate_picousd_per_token = USD per 1M tokens × 1e6`.
`$15.00/Mtok → 15_000_000`; `$1.50/Mtok → 1_500_000`; `$0.3125/Mtok → 312_500`.

⚠️ **Why picoUSD and not nanoUSD.** A real published cache-write rate is `3.125e-07` USD/token
(= `$0.3125/Mtok`), verified against a live community price table on 2026-07-20. In nanoUSD/token that
is `312.5` — **not an integer**, so the originally-locked nanoUSD unit would have had to round it, and
rounding a *rate* multiplies straight into every total that uses it. picoUSD represents it exactly.
Settings accepts USD/Mtok to **six** decimal places and rejects anything finer with
`E_PRICE_PRECISION` rather than rounding silently.

**Arithmetic and the two units.** SQL sums in picoUSD (64-bit): the reference dataset's worst case is
~6.42e7 output tokens at `$75/Mtok` = 4.8e15 picoUSD, three orders inside `2^63`. The repository then
converts to **nanoUSD** (integer division, round-half-up) **before** the value crosses IPC, because
picoUSD totals can approach `Number.MAX_SAFE_INTEGER` (9.007e15) on a dataset only a few times larger,
while the same total in nanoUSD (4.8e12) has three orders of headroom. `costNanoUsd` stays the wire
type everywhere in §4. USD is produced **once**, at the presentation edge, by dividing by 1e9.
INV-11 asserts the bound rather than trusting it.

⚠️ **AMENDED 2026-07-22 — the two-unit rule was implemented correctly at the wire boundary and
violated at the SQL boundary. picoUSD is now carried as `bigint` end to end.**

Found by running the app against a real ~1 GB dataset: all four Overview hero tiles were empty and
`q:overviewTiles` returned `E_INTERNAL` — *"`costPicoUsd` is too large to report exactly, so it was
not reported at all"*. INV-11 did its job; it was simply asserted in the wrong unit.

`costToWire()` was right — `assertSafeAggregate(picoToNanoUsd(costPicoUsd), 'costNanoUsd')`:
**convert, then assert.** But `CostRepository.totals()` and `totalsGroupedBy()` called
`sumToSafeNumber(row.cost_picousd, 'costPicoUsd')`, narrowing the picoUSD sum to a JS `number` and
asserting INV-11 on it *as it left SQL* — before `costToWire` ever saw it. The paragraph above is
what that broke, and it says why in its own terms: the whole reason to convert **before** the value
crosses IPC is that picoUSD legitimately outgrows `Number.MAX_SAFE_INTEGER` while nanoUSD does not.
`9.007e15` picoUSD is **$9,007** of lifetime spend. The app was hard-broken for every user past it,
on the 3-second glance surface, with the money path's own guard as the messenger.

**Resolution: a picoUSD sum is never narrowed to a `number`.** It leaves SQLite as a `bigint`
(better-sqlite3's `safeIntegers` mode, via `Repository.exactStatement`), stays a `bigint` through
`CostTotals.costPicoUsd` and `CostGroupRow.costPicoUsd`, and is converted once by `picoToNanoUsd`,
which is BigInt arithmetic already. INV-11 is asserted on the **nanoUSD result and nowhere else** —
the guard is moved, not removed, and it still refuses a nanoUSD total past the bound (~$9,007,199 of
costed spend). The `bigint` parameter type on `costToWire` is what now makes the mistake unwritable:
a picoUSD sum cannot be a `number` in the first place. ⚠️ **Token-count sums are not this** — §3.5
gives them their own headroom argument and they stay `number` via `sumToSafeNumber`. This is only
the money path, where the unit is 1e12 per dollar.

⚠️ **Why 890 tests were green, which is the lesson worth keeping.** The committed fixtures are
deliberately tiny, and even the reference-scale perf database came in at `4,705,207,215,000,000`
picoUSD ≈ 4.7e15 — **about half the limit.** The synthetic dataset was big enough to measure
performance and not big enough to overflow, so nothing in the suite ever crossed the boundary. **A
fixture under the threshold proves nothing.** The regression fixture
(`test/fixtures/inv11-money-boundary/`, driven by `test/integration/inv11-money-boundary.test.ts`)
crosses it deliberately — three events at an absurd rate rather than by volume, so it stays inside
the 256 KB fixture budget — and pins hand-computed exact nanoUSD values on `q:overviewTiles`,
`q:costBreakdown` and `q:tokensByProject`, each against the figure a lossy `Number` narrowing would
have produced instead.

**Non-overlap (ADR-024).** SQLite has no exclusion constraint, so the repository enforces it inside
the same write transaction: before inserting or re-dating a row it asserts that no other row with the
same `(model, token_class)` satisfies `valid_from < :newValidTo AND :newValidFrom < valid_to`
(treating `NULL` as `+∞`), and aborts with `E_PRICE_OVERLAP` otherwise (INV-08).

**Auto-versioning.** On a fetch **or a manual edit**, the incoming rate is compared with the
currently-valid row for that `(model, token_class)`. If **any** value differs, the old row's
`valid_to` is set to `now` and a new row is opened with `valid_from = now`, `valid_to = NULL`. If
nothing differs, nothing is written. History accrues with no user effort (§5.8).

**Hand-corrected effective dates.** `valid_from` and `valid_to` are directly editable, for the common
case where a price changed before the user noticed and the auto-generated boundary is in the wrong
place. Edits pass through the same overlap assertion. **Gaps are legal** — a gap simply means the
records inside it are **uncosted** and disclosed (INV-09).

**The join, stated once and used everywhere:**

```sql
-- The rate applicable to one event and one token class. No row ⇒ that class is unpriced.
SELECT pr.rate_picousd_per_token
FROM   price_rows pr
WHERE  pr.model       = :model
  AND  pr.token_class = :class
  AND  pr.valid_from <= :ts
  AND  (pr.valid_to IS NULL OR pr.valid_to > :ts)
```

**Seed.** `resources/price-seed.json` ships in the repo, correct as of build date, in the canonical
shape of §4.7. It is loaded on first run as rows with `source='seed'`, and is re-loadable on demand
via `pricing:resetToSeed`, which is **additive through the same auto-versioning path** and never
deletes a `manual` row.

## §3.12 `bloat_flags` — DERIVED

```sql
CREATE TABLE bloat_flags (
  id             INTEGER PRIMARY KEY,
  rule_id        TEXT    NOT NULL,      -- BR-01 … BR-06 (§5.11)
  severity       TEXT    NOT NULL CHECK (severity IN ('high','medium','low')),
  title          TEXT    NOT NULL,
  location       TEXT    NOT NULL,      -- rel_path or rel_path glob, relative to claudeDir
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  item_count     INTEGER NOT NULL DEFAULT 1,
  rationale      TEXT    NOT NULL,      -- "why flagged", rendered verbatim
  action_type    TEXT,                  -- a §5.7 catalogue id, or NULL = no action in v1
  action_payload TEXT,                  -- JSON, validated against that action's payload schema
  detected_at    INTEGER NOT NULL,
  UNIQUE (rule_id, location)
);
CREATE INDEX idx_bloat_flags_severity ON bloat_flags(severity, size_bytes DESC);
```

`bloat_flags` is fully replaced on each harness scan (`DELETE` then insert, one transaction), so a
resolved issue disappears. `action_type IS NULL` renders as a flag with **no button** and the label
"no automatic action in v1" (§6.8, §11.2).

⚠️ **AMENDED 2026-07-22 (E10) — one `action_type` per flag, and BR-01 names two.** §5.11's BR-01 row
offers "ACT-04 **or** ACT-05", which this table cannot represent: there is exactly one
`action_type` column and one `action_payload`. **The non-destructive action wins the button.** BR-01
therefore emits `action_type = 'restore-claude-md'` (ACT-04) with
`{ relPath, backupRelPath }`, and names ACT-05 in its `rationale`, which §6.9 renders verbatim.
The reason is the asymmetry of the two mistakes: restoring content the user still had is reversible
and is itself a guarded, undoable action, while deleting a file the user might still want is the
irreversible half. A flag may not carry a second button, and adding a second column is a design
change, not an implementation detail.

## §3.13 `settings` — USER

```sql
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT    NOT NULL,     -- JSON-encoded scalar or object
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
```

All app state persists here. **`electron-store` is not used** (ADR-030) — contradicting
`HANDOFF.md` §3 deliberately: one persistence store, one migration chain, one backup story.

| Key | Type | Default | Notes |
|---|---|---|---|
| `claudeDir` | `string \| null` | `null` | Absolute path. `null` ⇒ onboarding (§6.2). Validated on set. |
| `idleGapMinutes` | `number` | `15` | 5–60, step 5. Affects **active time only** (INV-05). |
| `theme` | `'system' \| 'dark' \| 'light'` | `'system'` | Applied as `data-theme` on the root element (§6.1). |
| `priceFetchUrl` | `string` | `''` | **Ships empty by decision** (§11.3, closed). The single egress target (§7.5). Settings offers verified suggestions to paste (§6.10). |
| `archiveRoot` | `string \| null` | `null` | Absolute path. `null` ⇒ ACT-07 unavailable. **Validated: must exist, be writable, and be neither inside nor a parent of `claudeDir`, and never the backup root** (INV-19). |
| `lastGlobalFilter` | `GlobalFilter` | all projects, full range | Restored on launch; never written mid-interaction. |
| `sidebarCollapsed` | `boolean` | `false` | FRONTEND §4. |
| `reduceMotionOverride` | `'system' \| 'reduce' \| 'full'` | `'system'` | FRONTEND §7. |
| `retainOrphanedHistory` | `boolean` | `true` | **ADR-041.** TRUE ⇒ a transcript that disappears from `<claudeDir>` keeps its parsed history (§5.3 `MISSING` → retained-orphan). FALSE ⇒ pure-mirror delete-and-cascade. |

⚠️ **AMENDED 2026-07-22 (ADR-041) — `retainOrphanedHistory`, and why its default is TRUE.** The
app's stated bar is *"never destroys data"* (PRD "What matters" #4) and non-goal #4 is *"never
auto-deletes anything"*. Deleting a session's derived history because its file vanished is the same
violation the app already refuses for the user's own files, so **retain-by-default is the
value-consistent choice, not a surprise** — the same reasoning that makes the app never re-derive an
archived session away (§3.4, ADR-033). It is a *setting* only so a user who wants a literal mirror of
`<claudeDir>` can turn it OFF; turning it off never retroactively destroys history already preserved
(that would be the auto-delete the setting exists to avoid), it only stops NEW disappearances being
kept (§5.3).

Unknown keys are ignored on read and rejected on write (`E_UNKNOWN_SETTING`). Every value is validated
against its declared type before persisting; an invalid value never reaches the table.

## §3.14 `audit_log` — USER — the guarded-action trail

```sql
CREATE TABLE audit_log (
  id              INTEGER PRIMARY KEY,
  action_type     TEXT    NOT NULL,     -- a §5.7 catalogue id
  status          TEXT    NOT NULL CHECK (status IN
                    ('completed','failed_partial','failed','undone')),
  claude_dir      TEXT    NOT NULL,     -- absolute path at the time of the action (§3.1.4 exception)
  target_summary  TEXT    NOT NULL,     -- human-readable, e.g. '24 orphaned skill folders'
  targets_json    TEXT    NOT NULL,     -- JSON array of rel_paths ACTUALLY acted on
  bytes_affected  INTEGER NOT NULL DEFAULT 0,
  backup_rel_path TEXT,                 -- '.claude-lens-backups/<iso>-<id>'; NULL if nothing copied
  backup_bytes    INTEGER NOT NULL DEFAULT 0,
  backup_present  INTEGER NOT NULL DEFAULT 1 CHECK (backup_present IN (0,1)),
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  undone_at       INTEGER,
  undo_of_id      INTEGER REFERENCES audit_log(id),
  error_code      TEXT,
  error_detail    TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_audit_log_started  ON audit_log(started_at DESC);
CREATE INDEX idx_audit_log_undoable ON audit_log(started_at DESC)
  WHERE status = 'completed' AND undone_at IS NULL AND backup_present = 1;
```

`backup_present` is set to `0` by `clear-backups` (ACT-06) for every entry whose restore point it
removed — the entry survives as history with its undo capability honestly withdrawn. **No row of
`audit_log` is ever deleted.**

⚠️ **AMENDED 2026-07-22 (E10) — the index above decides what §5.5 rule 5 left unsaid.** §5.5 rule 5
says an undone action's original entry "gets `undone_at`" but never says whether its `status` also
becomes `'undone'`. `idx_audit_log_undoable`'s predicate settles it: `status = 'completed' AND
undone_at IS NULL` has a **redundant second clause unless the original entry keeps
`status = 'completed'`**. So it does, and it gains `undone_at`. The `'undone'` status belongs to the
**new** entry the undo writes, the one carrying `undo_of_id`. Both rows survive forever.

## §3.15 `archives` — USER — the permanent record of what was archived and where

```sql
CREATE TABLE archives (
  id             INTEGER PRIMARY KEY,
  audit_id       INTEGER NOT NULL REFERENCES audit_log(id),   -- the ACT-07 entry that created it
  archive_root   TEXT    NOT NULL,     -- ABSOLUTE path, outside claudeDir (§3.1.4 exception)
  claude_dir     TEXT    NOT NULL,     -- the claudeDir the files were moved OUT of
  session_count  INTEGER NOT NULL,
  file_count     INTEGER NOT NULL,
  bytes_moved    INTEGER NOT NULL,
  range_from_ts  INTEGER,              -- earliest event ts among the archived sessions
  range_to_ts    INTEGER,              -- latest
  last_reachable_at INTEGER,           -- last sync at which archive_root was readable; NULL = never
  reachable      INTEGER NOT NULL DEFAULT 1 CHECK (reachable IN (0,1)),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_archives_created ON archives(created_at DESC);
```

⚠️ **AMENDED 2026-07-22 (E10) — an undone archive's row is removed, and that is not a contradiction
of the sentence below.** "Never purged, never dropped, never auto-deleted" is about the app never
discarding the record of an archive **that exists**. ACT-07's undo (§5.7 rule 5) moves every file
back and is required to restore "the exact prior state"; after it, the archive does not exist, and
this table has **no column that can express "undone"** — `reachable` means "the volume is not
mounted", which would be a different and false claim. Keeping the row would tell the user their
transcripts are somewhere they are not, which is the same failure this table exists to prevent, in
the other direction. The row is therefore deleted **by the undo**, after its `ON DELETE RESTRICT`
annotations are cleared — never by a purge, a migration, a retention policy or a timer. The history
is preserved where §3.14 says it is preserved: the original entry keeps `undone_at`, the undo writes
a new entry with `undo_of_id`, and neither is ever deleted.

**USER class: never purged, never dropped, never auto-deleted.** This table is the answer to
*"where did my transcripts go?"* — ⚠️ **an archive you cannot find is a delete with extra steps.** It
is surfaced permanently in Settings (§6.10) with the absolute path, the session count, the date range,
the byte count, and whether the root is currently reachable.

`reachable = 0` (the archive lives on an unmounted external volume, say) is **informational only**. It
never causes a row to be deleted, never marks data partial, and never changes a metric — the parsed
rows are RETAINED and stand on their own. The `ON DELETE RESTRICT` on both referencing columns means a
migration cannot remove an `archives` row while any file or session still points at it.

## §3.16 `stats_cache_days` — DERIVED — coverage metadata only

```sql
CREATE TABLE stats_cache_days (
  day            TEXT    PRIMARY KEY,      -- exactly as the file keys it
  raw_json       TEXT    NOT NULL,         -- the per-day object, verbatim
  source_file_id INTEGER NOT NULL REFERENCES file_manifest(id) ON DELETE CASCADE
) WITHOUT ROWID;
```

⚠️ **`stats-cache.json`'s field-level schema is not documented in any verified source.** This table
therefore stores only what *is* verified — that the file contains per-day entries (DESIGN_INPUT §2) —
and keeps each day's object verbatim. **No value from this table is ever summed into, substituted
into, or reconciled against a displayed metric** (ADR-029). Its only use is day-presence, which feeds
`dataCoverage()` (§5.9 M-16). See §11.4.

## §3.17 `meta` — DERIVED — sync bookkeeping

```sql
CREATE TABLE meta (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
```

Keys: `lastSyncCompletedAt`, `lastSyncDurationMs`, `lastSyncKind` (`'full' | 'incremental'`),
`lastFullParseAt`, `claudeDirFingerprint` (sha256 of the absolute `claudeDir`, used to detect a
directory change), `recordCounts` (`{events, sessions, projects, toolCalls, prompts}`),
`badLineTotal`, `unlinkedSubagentRuns`.

**`meta` is DERIVED; `settings` is USER.** Anything a rebuild can recompute belongs here, and nothing
else does (ADR-026).

## §3.18 Migration and purge rules

- Migration `0001` is exactly §3.2–§3.17. Every later schema change is a new numbered file; **merged
  migration files are immutable** (STACK ADR-007).
- **Purge** (`claudeDir` changed, or an explicit rebuild) runs inside one transaction, in FK-safe
  order, then triggers a full sync. It deletes **only DERIVED rows**, and the predicate is one
  column everywhere. ⚠️ **AMENDED 2026-07-24 (A-16) — "an explicit rebuild" now has a trigger:**
  the `sync:rebuild` channel (§4.4), reached from §6.10's *Read your transcripts again from the
  start* control. It runs this exact statement list then one `kind: 'full'` cycle —
  `DatasetService.rebuildDerived()` — and is **not** a guarded action (it mutates no file; §5.7 is
  unchanged). The guard argument below is unchanged and applies to it identically.

  ```sql
  -- The ONLY deletion predicate a purge may use. RETAINED rows survive, by EITHER marker:
  -- archive_id IS NOT NULL (moved out, ADR-033) OR retained_orphan = 1 (vanished, ADR-041).
  DELETE FROM events      WHERE source_file_id IN (SELECT id FROM file_manifest WHERE archive_id IS NULL AND retained_orphan = 0);
  DELETE FROM tool_calls  WHERE session_id     IN (SELECT id FROM sessions      WHERE archive_id IS NULL AND retained_orphan = 0);
  DELETE FROM file_touches WHERE session_id    IN (SELECT id FROM sessions      WHERE archive_id IS NULL AND retained_orphan = 0);
  DELETE FROM subagent_runs WHERE session_id   IN (SELECT id FROM sessions      WHERE archive_id IS NULL AND retained_orphan = 0);
  DELETE FROM prompts;                                    -- always fully rebuildable
  DELETE FROM sessions      WHERE archive_id IS NULL AND retained_orphan = 0;
  DELETE FROM file_manifest WHERE archive_id IS NULL AND retained_orphan = 0;
  DELETE FROM projects WHERE id NOT IN (SELECT project_id FROM sessions);  -- keep archived + retained-orphan projects
  DELETE FROM harness_nodes; DELETE FROM harness_edges;
  DELETE FROM bloat_flags;   DELETE FROM stats_cache_days; DELETE FROM meta;
  ```

  ⚠️ **AMENDED 2026-07-22 (ADR-041) — every guarded predicate now tests BOTH markers.** Orphan
  retention keeps the history of a transcript that vanished from `<claudeDir>` (§5.3), and those
  rows are RETAINED (§2.2). A purge that spared archived rows but not retained-orphan ones would
  destroy exactly the history this feature exists to keep — a silent shrink of every lifetime total
  (INV-18). So `retained_orphan = 0` joins `archive_id IS NULL` on every guarded delete, and the
  mechanical rule below is extended: a missing orphan guard is a blocking finding, identical in
  weight to a missing archive guard. ⚠️ The `events` guard (file-grain) and the
  `tool_calls`/`file_touches`/`subagent_runs`/`sessions` guards (session-grain) are **deliberately
  not equivalent for orphans**, because orphaning can be partial (§3.4): a retained-orphan session
  may own events from a still-live file, and those events are correctly deleted here and re-derived
  on rebuild, while the session row and its truly-orphaned events survive.

- **`price_rows`, `settings`, `audit_log`, `archives`, `project_groups` and
  `project_group_members` are never touched by a purge** (ADR-026, INV-12), and **no RETAINED row
  is ever touched by a purge** (ADR-033, INV-18).
- ⚠️ **AMENDED 2026-07-22 (ADR-040) — the `projects` deletion above is exactly why project groups
  key on `encoded_name`.** `DELETE FROM projects …` removes every un-archived project row and
  ingest re-inserts them with **different surrogate ids**. A membership table storing `project_id`
  would therefore re-point every group at whatever landed on those integers after any rebuild —
  silently, and in the direction of a bigger number. Membership stores the `encoded_name` (§3.3,
  the identity), which survives the purge because it is a property of the directory, and ids are
  resolved at query time. `test/metrics/f16-grouped-active-time.test.ts` purges, rebuilds with
  deliberately different ids, and asserts the group still names the same two folders.
- ⚠️ **A `claudeDir` change does not un-archive anything.** Archived sessions belong to the
  `claude_dir` recorded on their `archives` row; pointing the app at a different directory leaves them
  RETAINED and visible, tagged with the directory they came from.
- There is **no** "drop the database and re-sync" path anywhere in the codebase.
  `db-migration-review` gates this, and its checkable rule is: **a migration that deletes from
  `events`, `sessions`, `tool_calls`, `subagent_runs`, `file_touches` or `file_manifest` without an
  `archive_id IS NULL` guard is a blocking finding.** ⚠️ **AMENDED 2026-07-22 (ADR-041):** the same
  delete without a `retained_orphan = 0` guard is **equally** a blocking finding. Both markers, or
  the delete is unsafe. `auditPurgeStatements()` (`src/main/db/purge.ts`) enforces both and a test
  asserts it over `PURGE_STATEMENTS`.

## §3.19 `project_groups` / `project_group_members` — USER — "these two folders are the same project"

⚠️ **ADDED 2026-07-22 (ADR-040), migration `0007-project-groups.sql`.** `0001`–`0006` are merged and
immutable (STACK ADR-007), so this is a new numbered file.

```sql
CREATE TABLE project_groups (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),  -- the user's own words
  color_index INTEGER NOT NULL CHECK (color_index BETWEEN 0 AND 7),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_project_groups_name ON project_groups(name COLLATE NOCASE);

CREATE TABLE project_group_members (
  encoded_name TEXT    PRIMARY KEY,                             -- ⚠️ THE IDENTITY (§3.3)
  group_id     INTEGER NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_project_group_members_group ON project_group_members(group_id);
```

⚠️ **`encoded_name`, never `projects.id`.** `projects` is DERIVED and §3.18's purge renumbers every
row; a membership row keyed on the surrogate id would silently re-point at the wrong folders after
any rebuild. The full argument is ADR-040 Trap 1.

⚠️ **`encoded_name` is also the PRIMARY KEY**, which is a deliberate deviation from §3.1.3
("surrogate keys are `INTEGER PRIMARY KEY`") for the same reason `sessions` deviates: the natural
key is the right key. It is what makes **"a project belongs to at most one group"** a property of
the schema rather than of a check someone can forget.

⚠️ **No foreign key to `projects`, on purpose.** `ON DELETE CASCADE` would delete the user's groups
during a purge; `ON DELETE RESTRICT` would make the purge fail. A membership row naming a folder
that is not currently present is legal and is **shown as such** — "not currently present — nothing
has been lost" — and is never removed on the app's own initiative.

`color_index` follows §3.3's rule applied to the group's name: `FNV1a32(name) mod 8`, computed by
`colorIndexFor` at write time and recomputed on rename, so the hue is a pure function of what the
user called it and SQL and TypeScript never own two different rules for one string.

**Archived (RETAINED) projects group normally.** Grouping reads only `projects.encoded_name`, and an
archived project keeps its row (§3.18 keeps archived projects); no metric changes and no archived
row is touched (INV-18).

**The unit resolution, stated once**, as `PROJECT_UNIT_CTE` in
`src/main/db/repositories/project-groups.ts`:

```sql
project_unit AS (
  SELECT p.id                                                    AS project_id,
         CASE WHEN g.id IS NULL THEN p.id ELSE -g.id END          AS unit_id,
         COALESCE(g.name, p.display_name)                         AS unit_name,
         COALESCE(g.color_index, p.color_index)                   AS unit_color_index,
         CASE WHEN g.id IS NULL THEN p.encoded_name ELSE NULL END AS unit_encoded_name
  FROM   projects p
  LEFT   JOIN project_group_members m ON m.encoded_name = p.encoded_name
  LEFT   JOIN project_groups        g ON g.id = m.group_id
)
```

⚠️ Every project-shaped query imports this constant rather than restating the join — the same rule
CLAUDE.md §1 applies to metrics. A second spelling of it is how one query ends up ungrouped while
the rest are not, which is two numbers behind one word on two screens.

⚠️ **Nothing writes these tables except the four `groups:*` channels (§4.5), and none of them
suggests a grouping.** There is no `candidates`, `similar` or `suggested` channel and there must
never be one: §2.1's zero-inference rule is unchanged.

---

# §4 — Contracts (typed IPC)

**There is no HTTP API, no port, no server** (STACK ADR-003). The contract is a single typed channel
map in `src/shared/ipc-contract.ts`, compiled against by both the main process and the renderer, so
drift is a `typecheck` failure inside `pnpm run check` — which is why `api-contract-sync` is `no` in
the gate manifest. The preload exposes it over `contextBridge` with `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`.

## §4.1 The error contract — defined once, used everywhere

**No exception ever crosses the IPC boundary** (ADR-031). Every `invoke` handler returns:

```ts
export type Result<T> =
  | { ok: true;  data: T }
  | { ok: false; error: AppError };

export interface AppError {
  code: ErrorCode;          // the closed enum below
  message: string;          // one sentence, user-facing, never a stack trace
  detail?: string;          // developer detail; rendered only behind "Details"
  retryable: boolean;       // whether the same call may succeed if repeated unchanged
}
```

```ts
export type ErrorCode =
  // configuration & directory
  | 'E_NO_DIR'              // claudeDir is not set
  | 'E_DIR_NOT_FOUND'       // configured path does not exist or is not a directory
  | 'E_DIR_INVALID'         // exists but has neither projects/ nor history.jsonl
  | 'E_DIR_UNREADABLE'      // permission denied
  | 'E_UNKNOWN_SETTING' | 'E_INVALID_SETTING'
  // sync
  | 'E_SYNC_BUSY'           // a sync cycle is already running and this request is not queueable
  | 'E_SYNC_CANCELLED' | 'E_SYNC_FAILED'
  // database
  | 'E_DB_MIGRATION_FAILED' | 'E_DB_CORRUPT' | 'E_DB_BUSY'
  // pricing
  | 'E_PRICE_OVERLAP'       // the edit would overlap an existing validity range (INV-08)
  | 'E_PRICE_PRECISION'     // rate has more than six decimal places of USD/Mtok
  | 'E_PRICE_RANGE'         // valid_to <= valid_from
  | 'E_PRICE_NOT_FOUND'
  | 'E_FETCH_NO_URL' | 'E_FETCH_NETWORK' | 'E_FETCH_HTTP' | 'E_FETCH_TIMEOUT'
  | 'E_FETCH_SHAPE'         // response did not validate against the §4.7 schema
  // guarded actions
  | 'E_ACTION_UNKNOWN'      // action_type not in the closed catalogue (ADR-032)
  | 'E_ACTION_TARGET_GONE' | 'E_ACTION_TARGET_FORBIDDEN'  // e.g. inside the backup root
  | 'E_ACTION_NOT_CONFIRMED' | 'E_ACTION_BACKUP_FAILED' | 'E_ACTION_PARTIAL'
  | 'E_ACTION_NOTHING_TO_UNDO' | 'E_ACTION_BACKUP_MISSING'
  // archiving (ACT-07)
  | 'E_ARCHIVE_NO_ROOT'        // archiveRoot is not set
  | 'E_ARCHIVE_ROOT_INVALID'   // missing, unwritable, or inside/parent of claudeDir (INV-19)
  | 'E_ARCHIVE_UNREACHABLE'    // the archive root is not currently readable (undo only)
  | 'E_ARCHIVE_COLLISION'      // a file already exists at the destination path
  | 'E_ARCHIVE_VERIFY_FAILED'  // moved file's size/mtime does not match the move manifest
  // generic
  | 'E_INTERNAL';
```

⚠️ **`E_PRICE_PRECISION` corrected 2026-07-22 (E1).** Its comment read *"more than **three** decimal
places of USD/Mtok"* — the pre-amendment number, left stale when ADR-023 was amended on 2026-07-20.
The limit is **six**: ADR-023's amendment note, §3.11 ("Settings accepts USD/Mtok to **six** decimal
places") and fixture F-10 all say six, and six decimal places of USD/Mtok is exactly one picoUSD per
token — the finest rate the storage unit holds. `src/shared/money.ts` implements six. Corrected
rather than left to be discovered, because a three-decimal reading would **reject `$0.3125/Mtok`**,
the very rate that forced the amendment.

**Rules.** (1) Every handler is wrapped by one `withResult()` helper — an uncaught throw becomes
`E_INTERNAL` with the stack in `detail`, logged to the main-process log, never shown raw. (2) The
renderer never branches on `message`, only on `code`. (3) `retryable: false` errors must not be
retried automatically by any caller. (4) There is no separate "warning" channel: a partial or
incomplete result is expressed **in the success payload** as a disclosure (§4.6), never as an error —
that is what keeps disclosures impossible to swallow.

## §4.2 Shared request types

```ts
export interface GlobalFilter {
  projectIds: number[] | null;   // null = all projects. ⚠️ PROJECT UNIT ids (ADR-040), not always
                                 //    `projects.id`: a group is `-groupId`.
  from: number | null;           // UTC epoch ms, inclusive; null = unbounded
  to:   number | null;           // UTC epoch ms, exclusive; null = unbounded
}

export interface Page { cursor?: string; limit: number }   // limit: 1..500, default 100
export interface Paged<T> { rows: T[]; nextCursor: string | null; totalKnown: number | null }
```

`limit > 500` is rejected with `E_INVALID_SETTING`. Cursors are opaque, server-built strings encoding
the last row's sort key; the renderer never constructs one. **No IPC response may exceed 2 MB**
(§8.6); a handler that would exceed it returns a page instead.

## §4.3 Bootstrap and settings

| Channel | Request | Response `data` |
|---|---|---|
| `app:bootstrap` | `void` | `{ schemaVersion: number; settings: SettingsSnapshot; dirStatus: DirStatus; sync: SyncState; coverage: DataCoverage; disclosures: Disclosures }` |
| `settings:get` | `void` | `SettingsSnapshot` |
| `settings:set` | `{ key: SettingKey; value: unknown }` | `SettingsSnapshot` (the full new snapshot) |
| `dir:pick` | `void` | `{ cancelled: true } \| { cancelled: false; path: string; validation: DirValidation }` |
| `dir:validate` | `{ path: string }` | `DirValidation` |

```ts
type DirStatus = 'unset' | 'valid' | 'not_found' | 'invalid' | 'unreadable';
interface DirValidation {
  status: DirStatus;
  hasProjects: boolean; hasHistory: boolean;
  transcriptFileCount: number;    // counted, not estimated; 0 is legal
  reason?: string;                // present when status !== 'valid'
}
interface DataCoverage {          // §5.9 M-16
  transcriptsFrom: number | null; transcriptsTo: number | null;
  promptsFrom: number | null;     promptsTo: number | null;
  partialBefore: number | null;   // ms; prompts exist before this, transcripts do not
  statsCacheDays: number;
}
```

`settings:set` with `key = 'claudeDir'` validates first and, on success, triggers the purge-and-full-sync
transition of §5.1. It never partially applies.

## §4.4 Sync

| Channel | Request | Response `data` |
|---|---|---|
| `sync:start` | `{ kind: 'incremental' \| 'full' }` | `SyncState` |
| `sync:cancel` | `void` | `SyncState` |
| `sync:state` | `void` | `SyncState` |
| `sync:rebuild` *(A-16)* | `void` | `SyncState` |

```ts
interface SyncState {
  phase: 'idle' | 'scanning' | 'parsing' | 'finalizing' | 'cancelling' | 'failed';
  kind: 'incremental' | 'full' | null;
  startedAt: number | null;
  filesTotal: number; filesDone: number;
  recordsIngested: number; badLines: number;
  // ⚠️ ADR-019 — records this cycle offered that were ALREADY stored under the same event_key,
  // so nothing was written twice. NOT the repeated-API-call count (§4.6, migration 0011): that
  // one is several genuinely DISTINCT records sharing one API call, which line identity
  // correctly does not treat as duplicates. This is per-cycle; that one describes the dataset.
  recordsDeduplicated: number;
  queuedRescan: boolean;              // a watcher event arrived mid-cycle (§5.2)
  lastCompletedAt: number | null; lastDurationMs: number | null;
  error: AppError | null;
}
```

`sync:start` while a cycle is running does **not** fail: it sets `queuedRescan` and returns the
current state. `E_SYNC_BUSY` is reserved for `kind: 'full'` requested during a running cycle, which
cannot be coalesced.

⚠️ **AMENDED 2026-07-24 — `kind: 'full'` does NOT force a re-parse, and this is written down
because the name implies otherwise.** `kind` reaches `SyncRunContext` and nothing in the scan or
parse phase reads it: classification is §5.3's, driven by size and mtime, so an already-parsed file
is still `UNCHANGED` or `GREW`. The only thing `'full'` changes is that it refuses to be coalesced
into a running cycle. **The one path that re-parses everything is the §3.18 purge.**

⚠️ **AMENDED 2026-07-24 (A-16) — `sync:rebuild` is that path, finally given a trigger.** §3.18 has
always said the purge runs on "`claudeDir` changed, **or an explicit rebuild**", and §6.11 has
always named a *Rebuild derived data* control; until A-16 the only *live* trigger was a change of
Claude data directory (§5.1), so a line committed under an older build was never read again and
anything the app learned to record afterwards never reached it — which is exactly why migration
0011's repeated-API-call disclosure could name no remedy. `sync:rebuild` runs the **same pair**
§5.1's fingerprint-changed row runs — `purge()` (DERIVED only, both RETAINED markers guarded per
ADR-033/041, no USER table named per INV-12) then one `kind: 'full'` cycle — on the user's own
explicit request, and reports progress and cancels on `evt:sync` / `sync:cancel` like any cycle.
It is `E_SYNC_BUSY` while a cycle runs (the purge would delete manifest rows that cycle is writing)
and `E_NO_DIR` with no directory configured.

⚠️ **`sync:rebuild` is NOT a guarded action, and the ACT-01…07 catalogue (§5.7) is unchanged.**
Guarded actions mutate the user's filesystem and each backs up what it destroys (§5.5 rule 1); this
writes no file, moves no file and deletes nothing that has another source — every row it removes is
re-derived from transcripts it never opens for writing. A restore point would hold a copy of data
the transcripts already hold, so there is nothing to back up and no `audit_log` row to write, the
same reasoning that keeps the §5.1 purge itself out of the catalogue. It stays **user-initiated and
never automatic** (ADR-032: "no automatic recovery, ever").

⚠️ **The honest limit, which the UI states in plain words (§1a) and a test asserts on the data:**
archived transcripts (§5.3 `ARCHIVED`) and vanished-but-retained ones (`retained_orphan = 1`,
ADR-041) are **never re-read**, so their `api_ids_from_line` watermark cannot move and their
records stay uncheckable forever. A rebuild reaches everything except those, and the control must
not imply a clean sweep — the same discipline as A-05's archived cache-split sentence.

## §4.5 Analytics queries

Every method takes `GlobalFilter` unless marked ⛔ (INV-13: Harness Manager ignores the global
filter). Every method is a repository function behind the seam (STACK ADR-008) and is subject to the
200 ms budget (§8.3).

| Channel | Request | Response `data` | View |
|---|---|---|---|
| `q:overviewTiles` | `GlobalFilter` | `{ outputTokens: number; costNanoUsd: number \| null; activeSeconds: number; toolCalls: number; sessions: number; cacheReadTokens: number; distinctTools: number; uncosted: UncostedSummary; overlapSeconds: number }` — ⚠️ `activeSeconds` uses **M-07 binding (C)**: the sum of M-08 working-day values over the filter (INV-21). `overlapSeconds` is **M-20**, its mandatory companion disclosure (INV-23) | §6.3 |
| `q:activityCalendar` | `GlobalFilter & { weeks: number }` | `{ days: { day: string; messages: number }[] }` | §6.3 |
| `q:modelMixTimeline` | `GlobalFilter & { bucket: 'day' \| 'week' }` | `{ buckets: string[]; series: { model: string; colorIndex: number; data: number[] }[] }` | §6.3, §6.4 |
| `q:tokensByModel` | `GlobalFilter & { mode: 'all' \| 'output_only'; bucket: 'day' \| 'week' }` | same shape as above | §6.4 |
| `q:tokensByProject` | `GlobalFilter` | `{ rows: { projectId: number; displayName: string; colorIndex: number; outputTokens: number; costNanoUsd: number \| null }[] }` | §6.4 treemap |
| `q:cacheEfficiency` | `GlobalFilter` | `{ cacheReadTokens: number; inputTokens: number; cacheWriteTokens: number; outputTokens: number; hitRatio: number }` | §6.4 gauge |
| `q:costBreakdown` | `GlobalFilter & { by: 'model' \| 'project' \| 'day' }` | `{ rows: { key: string; costNanoUsd: number; tokensByClass: TokenBreakdown }[]; uncosted: UncostedSummary }` | §6.4 |
| `q:sessionHistogram` | `GlobalFilter` | `{ buckets: { label: string; lowerSeconds: number; upperSeconds: number \| null; count: number }[] }` | §6.5 |
| `q:rhythmHeatmap` | `GlobalFilter` | `{ cells: { weekday: number; hour: number; events: number }[] }` | §6.5 |
| `q:workingDays` | `GlobalFilter & Page` | `Paged<{ day: string; projectId: number; displayName: string; colorIndex: number; activeSeconds: number; spanSeconds: number; sessions: number }>` — ⚠️ **M-07 binding (B)**; these rows are the summands of binding (C) | §6.5 marathons |
| `q:sessions` | `GlobalFilter & Page & { sort: SessionSort; dir: 'asc' \| 'desc' }` | `Paged<SessionRow>` | §6.5 |
| `q:sessionDetail` | `{ sessionId: string }` | `SessionDetail` | §6.5 drill-down |
| `q:toolFingerprint` | `GlobalFilter` | `{ total: number; distinct: number; rows: { toolName: string; count: number; colorIndex: number }[] }` | §6.6 |
| `q:originSplit` | `GlobalFilter` | `{ main: TokenBreakdown & { messages: number; toolCalls: number }; subagent: TokenBreakdown & { messages: number; toolCalls: number }; unlinkedRuns: number }` | §6.6, §6.4 |
| `q:toolMixByProject` | `GlobalFilter & { topN: number }` | `{ projects: { projectId: number; displayName: string; parts: { toolName: string; count: number; colorIndex: number }[] }[] }` | §6.6 |
| `q:projectCards` | `GlobalFilter` | `{ rows: ProjectCard[] }` | §6.8 |
| `q:fileMetrics` | `GlobalFilter & { projectId?: number } & Page` | `Paged<{ path: string; basename: string; language: string \| null; edits: number; lastTs: number }>` | §6.8 |
| `groups:list` | `void` | `{ rows: ProjectGroup[] }` | §6.10 |
| `groups:create` | `{ name: string; encodedNames: string[] }` | `{ rows: ProjectGroup[] }` | §6.8 |
| `groups:rename` | `{ groupId: number; name: string }` | `{ rows: ProjectGroup[] }` | §6.10 |
| `groups:ungroup` | `{ groupId: number }` | `{ rows: ProjectGroup[] }` | §6.10 |
| `q:harnessGraph` ⛔ | `{ tab: 'harness' }` | `{ nodes: GraphNode[]; edges: GraphEdge[] }` | §6.7 |
| `q:executionTrace` | `{ sessionId: string }` | `{ nodes: GraphNode[]; edges: GraphEdge[]; timeline: TraceSpan[]; unlinkedRuns: number }` | §6.7 |
| `q:toolTransition` | `GlobalFilter` | `{ nodes: GraphNode[]; edges: GraphEdge[] }` | §6.7 |
| `q:flowSankey` | `GlobalFilter` | `{ nodes: GraphNode[]; links: { source: string; target: string; value: number }[] }` | §6.7 |
| `q:skills` ⛔ | `Page & { sort: 'never_used' \| 'invocations' \| 'size' \| 'name' }` | `Paged<SkillRow>` | §6.9 |
| `q:claudeMdFiles` ⛔ | `void` | `{ rows: { relPath: string; sizeBytes: number; mtimeMs: number; backups: { relPath: string; sizeBytes: number }[] }[] }` | §6.9 |
| `q:plugins` ⛔ | `void` | `{ marketplaces: MarketplaceRow[]; plugins: PluginRow[] }` | §6.9 |
| `q:memories` ⛔ | `void` | `{ rows: { relPath: string; projectId: number \| null; sizeBytes: number; mtimeMs: number; entryCount: number }[] }` | §6.9 |

⚠️ **ADDED 2026-07-22 (ADR-040) — the four `groups:*` channels, and the one thing they must never
grow.** `groups:create` takes **`encodedNames`**, the §3.3 identities, and never `projectIds`:
`projects` is DERIVED and a rebuild renumbers every row, so a group sent by id would re-point at the
wrong folders (ADR-040 Trap 1). ⚠️ **There is no `groups:candidates`, `groups:suggested` or
`groups:similar` channel and there must never be one** — §2.1's zero-inference rule forbids the app
deciding that two folders are one project. The user names the group and picks its members. All four
mutations announce `evt:dataChanged` with the `projects`, `events`, `sessions` and `tools` scopes, so
every open view re-queries and no screen is left disagreeing with another about what a project is.

```ts
interface ProjectGroup {
  id: number;
  name: string;              // the user's own words; never generated, never completed
  colorIndex: number;        // §3.3's rule applied to the name
  createdAt: number;
  members: ProjectGroupMember[];
}
interface ProjectGroupMember {
  encodedName: string;       // ⚠️ the identity (§3.3), always present
  projectId: number | null;  // null = no project with that folder name is currently present
  displayName: string | null;// null = same; shown as "not currently present", never hidden
}
```

⚠️ **AMENDED 2026-07-22 (ADR-040) — `ProjectCard` gained `groupId`, `members`, and a NULLABLE
`encodedName`.** A group is not a directory and has no folder name of its own; `null` is the honest
value and `""` would read as "a folder with no name". `members` carries each folder with the numbers
it has **on its own**, so a group hides nothing — and ⚠️ **`members[].activeSeconds` does NOT sum to
`activeSeconds`**, because merging two folders turns the gaps between them on a shared day into
capped-and-counted intra-partition gaps (ADR-040 Trap 2). §6.8 states that on screen, in plain words,
beside the numbers.

⚠️ **AMENDED 2026-07-22 (E1) — three rows above carried a `$` figure with no `UncostedSummary`.**
`q:tokensByProject`, `q:projectCards` and `q:sessions` each expose `costNanoUsd` while the table gave
them no disclosure, which **INV-10 forbids in absolute terms** — *"it is impossible to render a cost
without having its disclosure in hand"* — and which §1.5 forbids again by making a disclosure a
first-class query result rather than a log line. Those three rows were an incomplete transcription of
a rule stated twice elsewhere in stronger terms, not a deliberate exception, so the invariant wins and
**each response envelope now carries `uncosted: UncostedSummary`**, required and never optional (an
optional disclosure is a swallowable one). It is a superset change: no consumer breaks. The failure
mode of leaving them alone is the one this document exists to prevent — a `$` figure rendered with no
way to know it was incomplete.

- `q:tokensByProject` → `{ rows: […]; uncosted: UncostedSummary }`
- `q:projectCards` → `{ rows: ProjectCard[]; uncosted: UncostedSummary }`
- `q:sessions` → `{ page: Paged<SessionRow>; uncosted: UncostedSummary }`. ⚠️ **`Paged<T>` (§4.2) is
  deliberately NOT widened.** It is the shared envelope of payloads that mostly carry no `$` figure;
  putting `uncosted` on all of them would force it optional. This one channel embeds the page instead.

⚠️ **Two deliberate NON-additions, recorded so nobody "completes the pattern" later.** Neither takes
an `overlapSeconds`, and in both cases that is provable rather than assumed:

- **`q:projectCards`** — `ProjectCard.activeSeconds` *is* M-07 binding (C), but binding (C) restricted
  to **one project unit** has exactly one partition per local day, and distinct days' covered intervals
  cannot intersect, so M-20 is identically `0` (**INV-22(d)**). §6.8 already states this and omits the
  disclosure for that reason: it would always read "0 hours". ⚠️ ADR-040 does not weaken this: a group
  is one unit, so a grouped card's overlap is `0` for exactly the same reason a lone project's is.
- **`q:sessions`** — the non-obvious half: `SessionRow.activeSeconds` is M-07 binding **(A)**, a single
  session, not binding (C). **INV-23 binds only multi-session binding-(C) figures**, so it does not
  reach this payload at all.

```ts
interface TokenBreakdown { input: number; output: number; cacheWrite: number; cacheRead: number }

interface SessionRow {
  id: string; projectId: number; displayName: string; colorIndex: number;
  primaryModel: string | null; firstTs: number; lastTs: number;
  spanSeconds: number; activeSeconds: number;   // M-07 binding (A), single session
  messages: number; toolCalls: number; subagentRuns: number;
  tokens: TokenBreakdown; costNanoUsd: number | null;
  isPartial: boolean;
  archiveId: number | null;     // AMENDED (E9) — null = live; §3.4 sessions.archive_id, ADR-033
  archiveRoot: string | null;   // AMENDED (E9) — the DESTINATION directory (§3.15, §9.3); null = live
}
type SessionSort = 'firstTs' | 'activeSeconds' | 'spanSeconds' | 'outputTokens' | 'messages' | 'toolCalls';

interface SessionDetail extends Omit<SessionRow, 'subagentRuns'> {
  gitBranch: string | null; cliVersion: string | null;
  originSplit: { main: TokenBreakdown; subagent: TokenBreakdown };
  toolCounts: { toolName: string; count: number }[];
  subagentRuns: { id: number; subagentType: string | null; description: string | null;
                  firstTs: number; lastTs: number; linked: boolean;
                  tokens: TokenBreakdown }[];
  uncosted: UncostedSummary;
}

interface ProjectCard {
  projectId: number; displayName: string; encodedName: string; colorIndex: number;
  sessions: number; outputTokens: number; costNanoUsd: number | null;
  toolCalls: number; activeSeconds: number;     // M-07 binding (C), summed over this project's working days
  editSparkline: number[];      // 12 buckets of edit counts over the filtered range
}

interface SkillRow {
  name: string; source: 'user' | 'plugin'; pluginName: string | null;
  relPath: string; sizeBytes: number;
  invocations: number;          // ALL TIME, never filtered (INV-13)
  lastUsedTs: number | null;    // ALL TIME
  neverUsed: boolean;
}

interface GraphNode { id: string; kind: string; label: string; colorIndex: number;
                      role?: string; metrics: Record<string, number>;
                      meta?: Record<string, string> }   // ⚠️ AMENDED (E12) — see below
interface GraphEdge { id: string; source: string; target: string; kind: string;
                      evidence?: 'frontmatter' | 'body_mention' | 'directory';
                      designed: boolean; observed: number }   // observed = runtime overlay
interface TraceSpan { id: string; kind: 'main' | 'subagent' | 'tool';
                      label: string; startTs: number; endTs: number; depth: number }
```

⚠️ **AMENDED 2026-07-22 (E1):** `SessionDetail` is declared `extends Omit<SessionRow, 'subagentRuns'>`
because that one field narrows from a **count** on `SessionRow` to the **run list** below, and
TypeScript rejects a widening redeclaration in an `extends` clause — `extends SessionRow` did not
compile. Every field name is unchanged and the wire shape is unchanged.

⚠️ **AMENDED 2026-07-22 (E9) — `SessionRow` gained `archiveId` and `archiveRoot`, because §6.5
required a badge no payload could support.** §6.5's Degraded row says, in absolute terms: *"Archived
sessions carry a neutral 'archived' `Badge` **naming the archive root** — neutral, not a warning,
because their numbers are complete and unchanged (INV-18)."* As §4.5 stood, `SessionRow` and
`SessionDetail` carried `isPartial` and **nothing else about provenance**, so the renderer had no
way to know whether a session was archived, let alone where its transcripts went. The badge could
not be built, and E8/E9 correctly declined to build it rather than approximate it.

- **The data existed and simply never made it into the payload.** `sessions.archive_id` is a column
  (§3.4, ADR-033) and `archives.archive_root` holds the destination directory (§3.15, §3.2 as
  amended by E10). Two fields, one `LEFT JOIN`, no new source of truth: `archiveId: number | null`
  (`null` = live) and `archiveRoot: string | null` (`null` = live). `SessionDetail` inherits both
  through its existing `extends Omit<SessionRow, 'subagentRuns'>`, so the drill-down and the table
  row cannot disagree.
- **⚠️ Rejected: inferring membership from `archives:list`.** §4.8 gives the renderer the archive
  roots and their `range_from_ts`/`range_to_ts`, and a session whose dates fall inside one of those
  ranges *looks* like a member. It is not evidence: the range describes what was archived in one
  ACT-07, and a live session from the same week overlaps it exactly as well. That reading would put
  a **guess presented as a fact** on the one badge whose entire job is to reassure the user their
  numbers are intact — the §1.1 failure with a friendly colour. Membership is a stored column or it
  is not known.
- **⚠️ The join is `LEFT`, and INV-18 is untouched.** A live session must yield `null`/`null`, never
  drop out of `q:sessions`: an inner join would shrink the session table to whatever had been
  archived, with nothing failing. These are the **only** two fields on the row an ACT-07 changes,
  and they are **provenance, not a metric** — every number beside them is byte-identical before and
  after (INV-18, §5.7). F-04 therefore compares the metrics for byte-identity while asserting the
  `null → value → null` provenance transition **explicitly**, so the deliberate change can neither
  break the invariance comparison nor hide inside it. That is also why the badge is neutral: a
  `--warn` or `--danger` treatment would state something false.

⚠️ **`GraphEdge.designed` and `GraphEdge.observed` are separate fields on purpose.** The Harness Map's
whole value is designed-vs-actual; collapsing them into one number destroys it. `designed: false,
observed > 0` is a legal and interesting state (a call that happens but is not declared).

⚠️ **AMENDED 2026-07-22 (E12) — `GraphNode` gained `meta?: Record<string, string>`, because §4.5
could carry no text on a node and two other sections require it.** As §4.5 stood, a `GraphNode`'s
only payload beyond its identity was `metrics: Record<string, number>`. Two consequences, both of
them a *promise made elsewhere in this document that no payload could keep*:

- **The prompt preview was unreachable in the running app.** §3.9 says `display_preview` "is shown
  **only** in the graph inspector (§6.7) — never as a list, never searchable", and §6.7 says "the
  inspector is where a **prompt preview** may appear (≤280 chars, §3.9) — the only place in the app
  that shows any prompt text". The renderer implements the cap and tests it. But **no §4.5 payload
  carried the text**, so the feature could not appear on screen at all, and every test still passed
  — the component was tested in isolation against a prop nothing supplied. It now arrives as
  `meta.promptPreview` on the **session** node of `q:executionTrace`, which is the node a prompt
  belongs to (`prompts.session_id`, §3.9). One preview, for one selected session, reachable only by
  clicking that node.
- **`description`, `rel_path` and `source` were dropped between `harness_nodes` and the Harness Map
  inspector.** All three are columns of §3.10 and all three are what §6.7's "key/value rows" are
  for; "installed by a plugin" versus "you wrote this" is a different answer on the one view where
  the difference decides whether a user deletes something. They arrive as `meta.description`,
  `meta.relPath` and `meta.source` on `q:harnessGraph`'s nodes.

⚠️⚠️ **The 280-character cap is enforced in the REPOSITORY, not in the component.** It is a product
boundary (§1.6 non-goal 1 — this is not a transcript reader; §3.9 — `pastedContents` is never stored
in any form), not a display nicety. A cap applied only at the render surface has already let the
text cross IPC, enter the renderer's memory and become available to any later consumer of the
payload. `GraphStatsRepository.sessionPromptPreview` truncates in SQL, using §3.9's own constant;
`NodeInspector` keeps its independent `slice` as a second guard at the only surface that renders it.
Both directions are tested: an over-long `display_preview` written straight into the table comes back
at exactly 280 and **not** equal to the original.

⚠️ **A key whose value is absent is OMITTED, never emitted as `''`.** An empty "Description" row, or
an empty quote block, is a positive claim — "this node has no description", "the user sent an empty
prompt" — and is a different statement from "the column is NULL". Same rule as everywhere else in
this document: never zero-fill, never substitute (CLAUDE.md §1).

⚠️ `Record<string, string>` rather than a fixed shape, deliberately: the four tabs describe genuinely
different objects, and a union of four node types would put the tab's identity into the wire format,
which §4.5 does not otherwise do. Every value is inert text rendered into a text node — parsed
harness text is data, never instructions (§3.10, ADR-017), asserted by a test that puts markup in a
`description` and requires it to produce characters and no element.

## §4.6 Disclosures — incompleteness as data, never as a log line

```ts
interface UncostedSummary {
  records: number;                       // 0 means the $ figure is complete
  byModel: { model: string; records: number; fromTs: number; toTs: number }[];
}

interface Disclosures {
  uncosted: UncostedSummary;
  badLines: number;                      // malformed JSON lines skipped across all files
  syntheticEvents: number;               // <synthetic> assistant events excluded from stats
  unlinkedSubagentRuns: number;
  partialBefore: number | null;          // prompts exist before this; transcripts do not
  filesMissingSinceLastSync: number;
  activeOverlapSeconds: number;          // M-20; 0 means the Active-hours figure double-counts nothing
  // ⚠️ A-05 (2026-07-22). Cache-writing events still carrying the pre-split cache-write total
  // (`events.tok_cache_write_1h IS NULL`), partitioned by whether anything can be done about it.
  cacheSplitUnknownEvents: number;       // LIVE sessions — recoverable by a re-sync/rebuild
  cacheSplitArchivedEvents: number;      // ⚠️⚠️ ARCHIVED sessions — NEVER recoverable (§9.4)
  cacheSplitMismatches: number;          // §5.4 rule 8's sum assertion failed; split not trusted
  // ⚠️ ADR-041 — "N sessions kept from files no longer in your Claude folder." Whole-file
  // disappearance only (NOT in-place compaction). UNFILTERED, like the A-05 counts.
  retainedOrphanSessions: number;
  retainedOrphanEvents: number;
  // ⚠️⚠️ Migration 0011 — repeated API calls, MEASURED and not yet acted on. `records` alone is
  // unreadable: `checkedRecords` is the denominator and `checkedRecords === 0` is the
  // "NOT MEASURED" state, which must never be shown as "none found".
  repeatedApiCalls: RepeatedApiCalls;
}

interface RepeatedApiCalls {
  records: number;             // records sharing an API-call id with another record, over the checked half
  checkedRecords: number;      // the denominator. 0 = nothing has been examined
  uncheckedRecords: number;    // read before the app recorded the id; re-readable in principle
  uncheckableRecords: number;  // ⚠️⚠️ archived / vanished transcripts — NEVER checkable
}
```

⚠️ **AMENDED 2026-07-22 (A-05) — three new disclosures, and why they are three and not one.**

Migration 0005 leaves every already-parsed cache-writing event with an **unknown** 1-hour share
(§3.5). Those events keep costing exactly what they cost before — nothing moves under the user —
but they are **understated**, and an understatement nobody is told about is the silently wrong
number this project exists to prevent (CLAUDE.md §1). So it is disclosed, in three counts because
there are three different facts with three different remedies:

- **`cacheSplitUnknownEvents`** — live sessions. DERIVED data is rebuildable: a re-sync or a
  rebuild re-reads the transcript and fills the split in. The disclosure **names that remedy**,
  which is the difference between a caveat and an apology. ⚠️ Nothing is auto-purged and no
  re-parse is triggered on the user's behalf.
- ⚠️⚠️ **`cacheSplitArchivedEvents`** — archived sessions (`archive_id IS NOT NULL`). Their
  transcripts have left the Claude data directory and are **never re-parsed** (§5.3 `ARCHIVED`,
  ADR-034), so their 1-hour share can **never** be recovered: they stay costed at the 5-minute
  rate permanently. It gets its **own count and its own sentence** because folding it into the
  first would tell the user to re-sync something a re-sync cannot touch. See §9.4.
- **`cacheSplitMismatches`** — a source record whose `ephemeral_5m + ephemeral_1h` did not equal
  its own `cache_creation_input_tokens` (§5.4 rule 8). Counted in `file_manifest`, exactly as
  `bad_lines` is.

⚠️ **All three are computed UNFILTERED, deliberately.** They describe the stored dataset, not the
`GlobalFilter` window. If they honoured the filter, a user whose stale rows happened to fall
outside the current range would see a cost figure that is still understated with nothing beside it
saying so — a caveat that disappears while the thing it qualifies does not.

⚠️ **AMENDED 2026-07-22 (ADR-041) — `retainedOrphanSessions` / `retainedOrphanEvents`.** Sessions
and events kept from transcripts that are **no longer in the Claude data directory** because the
file disappeared (`retained_orphan = 1`, §3.2/§3.4). Plain-language, for the eventual UI: *"N
sessions kept from files no longer in your Claude folder — their history is preserved here."* These
sessions' numbers still count toward every total (INV-18); the disclosure only explains why some
sessions have no file behind them. **Computed UNFILTERED**, for the same reason as the A-05 counts:
a date range that excluded the orphaned sessions must not make the caveat vanish. ⚠️ The count's
scope is **whole-file disappearance only** — an in-place compaction that drops old messages while
keeping the file is not counted here and its dropped turns are not retained (ADR-041's honest limit,
§11.10). The eventual per-session "kept" badge is a separate follow-up.

⚠️⚠️ **AMENDED 2026-07-24 (migration 0011) — `repeatedApiCalls`, and why it is FOUR numbers.**

Claude Code writes one assistant turn as several JSONL lines that share one `message.id` and repeat
the identical `usage` (§3.5). Every one of them is summed, so one API call is counted more than
once. ⚠️ **No metric changed** — §5.9 is untouched and no displayed figure moved. This disclosure
exists so the effect can be **sized** before anything is decided about it.

The count could not be one number, and the reason is the whole point of the field:

- **`records` on its own is not evidence.** Rows ingested before the migration carry no id, so a
  bare `0` is identical whether nothing repeats or nothing was ever examined. **`checkedRecords` is
  the denominator, and `checkedRecords === 0` is the NOT-MEASURED state.** ⚠️ A renderer that shows
  *"0 repeated records"* there is asserting a finding the app never made — the same defect as a
  silently wrong number, and `test/renderer/views/repeated-api-calls.test.tsx` is what fails when
  someone "simplifies" the two states into one.
- **`uncheckedRecords` vs `uncheckableRecords` follows A-05's split exactly.** The second is
  archived or vanished transcripts, which are never re-read (§5.3, ADR-034/041), so it gets its own
  count and its own sentence.
- ⚠️ **Neither line promises a re-sync, and that is deliberate.** A sync resumes from the stored
  byte offset and never re-reads a committed line (§5.2 rule 3, §5.3 `GREW`); `kind: 'full'` only
  refuses to coalesce (§4.4) and does not force a re-parse. The one path that re-parses everything
  is the §3.18 purge, triggered solely by a change of Claude data directory (§5.1) — **there is no
  rebuild control in the UI.** So the copy states the reach of the check honestly (*"the app does
  not re-read transcripts it has already read"*) instead of naming a remedy the user cannot reach.
  Advice that cannot work is worse than none (§9.4's principle, A-05's archived sentence).

**All four are computed UNFILTERED**, for the same reason as the A-05 counts above.

| Channel | Request | Response `data` |
|---|---|---|
| `q:disclosures` | `GlobalFilter` | `Disclosures` |
| `q:uncosted` | `GlobalFilter` | `UncostedSummary` |

**Rule (INV-10):** any payload carrying a `$` figure carries its `UncostedSummary` in the same
response. It is impossible to render a cost without having its disclosure in hand.

**Rule (INV-23):** the same rule for time — **any payload carrying a multi-session Active-hours figure
(M-07 binding (C)) carries its `overlapSeconds` (M-20) in the same response.** One pattern, applied
to both of the app's disclosable quantities: the figure stays as defined and the response makes its
caveat impossible to lose (ADR-037).

## §4.7 Pricing

| Channel | Request | Response `data` |
|---|---|---|
| `pricing:list` | `{ model?: string; includeHistory: boolean }` | `{ rows: PriceRow[] }` |
| `pricing:upsertRate` | `{ model: string; tokenClass: TokenClass; usdPerMillion: number; note?: string }` | `{ rows: PriceRow[]; versioned: boolean }` |
| `pricing:setDates` | `{ id: number; validFrom: number; validTo: number \| null }` | `{ rows: PriceRow[] }` |
| `pricing:deleteRow` | `{ id: number }` | `{ rows: PriceRow[] }` |
| `pricing:fetch` | `void` | `{ applied: PriceChange[]; unchanged: number; sourceUrl: string }` |
| `pricing:resetToSeed` | `void` | `{ applied: PriceChange[]; unchanged: number }` |
| `pricing:models` | `void` | `{ rows: { model: string; events: number; firstTs: number; lastTs: number; priced: boolean }[] }` |

```ts
// ⚠️ AMENDED 2026-07-22 (A-05) — five, not four. `cache_write` is the 5-MINUTE class.
type TokenClass = 'input' | 'output' | 'cache_write' | 'cache_write_1h' | 'cache_read';
interface PriceRow {
  id: number; model: string; tokenClass: TokenClass;
  usdPerMillion: number;             // presentation form; rate_picousd_per_token / 1e6 (ADR-023)
  validFrom: number; validTo: number | null;
  source: 'seed' | 'fetch' | 'manual'; sourceUrl: string | null; note: string | null;
}
interface PriceChange { model: string; tokenClass: TokenClass;
                        fromUsdPerMillion: number | null; toUsdPerMillion: number; effectiveFrom: number }
```

**The canonical price-document shape** — what `resources/price-seed.json` contains and what a fetched
document must validate against. Anything else is rejected with `E_FETCH_SHAPE`, and the existing price
table is left completely intact.

```jsonc
{
  "schema": "claude-lens/price-table@1",
  "generatedAt": "2026-07-20T00:00:00.000Z",
  "models": [
    {
      "model": "<exact message.model string>",
      "rates": {                       // all FIVE classes required; USD per 1,000,000 tokens
        "input": 15.0, "output": 75.0,
        "cache_write": 18.75,          // the 5-MINUTE class (A-05)
        "cache_write_1h": 30.0,        // the 1-HOUR class (A-05) — stored, never derived
        "cache_read": 1.5
      },
      "effectiveFrom": "2026-01-01T00:00:00.000Z"   // optional; defaults to fetch time
    }
  ]
}
```

⚠️ **AMENDED 2026-07-22 (A-05) — `cache_write_1h` is a REQUIRED key of `rates`, like the other
four.** A document that omits it is rejected with `E_FETCH_SHAPE` **naming the missing field**, and
the existing price table is left completely intact (§5.8 rule 3) — the loudest, safest failure
available, and exactly the treatment the original four have always had. It is deliberately *not*
optional-with-a-default: a default would be a derived rate wearing a shape's clothes (ADR-024).
The `schema` string is unchanged at `claude-lens/price-table@1`, because the error a reader needs
is "your document is missing `rates.cache_write_1h`", not "your document is not a price table".

`pricing:models` is what makes an unpriced model **visible rather than silent**: it lists every
distinct `model` string observed in `events`, with `priced` telling the user whether any covering row
exists. This is the Settings-side counterpart of the uncosted disclosure.

## §4.8 Harness scan, guarded actions, audit, backups

| Channel | Request | Response `data` |
|---|---|---|
| `harness:scan` | `void` | `{ nodes: number; edges: number; flags: number; scannedAt: number; projectsResolved: number; projectsSkipped: number }` |
| `bloat:list` | `void` | `{ rows: BloatFlag[]; totalReclaimableBytes: number }` |
| `action:preview` | `{ actionType: ActionType; payload: unknown }` | `ActionPreview` |
| `action:execute` | `{ actionType: ActionType; payload: unknown; confirmToken: string }` | `{ auditId: number; status: AuditStatus; result: ActionResult }` |
| `action:undoLast` | `{ auditId: number }` | `{ auditId: number; status: 'undone'; restored: number }` |
| `audit:list` | `Page` | `Paged<AuditEntry>` |
| `backups:summary` | `void` | `{ restorePoints: number; totalBytes: number; oldestTs: number \| null; newestTs: number \| null }` |
| `archives:list` | `void` | `{ rows: ArchiveRow[] }` |
| `archives:candidates` | `{ olderThanTs: number; projectIds: number[] \| null }` | `{ sessions: { id: string; displayName: string; lastTs: number; bytes: number }[]; totalBytes: number }` |

```ts
interface ArchiveRow {
  id: number; auditId: number;
  archiveRoot: string; claudeDir: string;
  sessionCount: number; fileCount: number; bytesMoved: number;
  rangeFromTs: number | null; rangeToTs: number | null;
  reachable: boolean; lastReachableAt: number | null;
  createdAt: number;
}
```

`archives:candidates` is a **read-only** helper that turns "sessions older than X" into the explicit
session list ACT-07 requires. It never mutates and never mints a token; `action:preview` does that.

⚠️ **AMENDED 2026-07-22 (ADR-039) — `harness:scan` gained `projectsResolved` / `projectsSkipped`.**
`projects/<encoded-path>` encodes the project's real directory lossily, so exactly one candidate is
decoded and checked; when it does not land the project is **skipped**, and a skip is a disclosure
(§4.6: incompleteness is data in the success payload, never a log line). Two counts rather than one,
because "0 of 17" and "6 of 17" are different answers and a bare "6 projects" hides which. ⚠️ Neither
field carries a path: no absolute project path crosses IPC, is logged, or is written to any tracked
file (§7.8).

```ts
type ActionType =
  | 'delete-orphan-skill-folders'   // ACT-01
  | 'clear-plugin-cache'            // ACT-02
  | 'delete-duplicate-config-backups' // ACT-03
  | 'restore-claude-md'             // ACT-04
  | 'delete-empty-claude-md'        // ACT-05
  | 'clear-backups'                 // ACT-06
  | 'archive-sessions';             // ACT-07 — move-class (ADR-034)

// ACT-07 payload. Sessions are named explicitly; the UI resolves a criterion into this list
// and the user sees every one of them in the preview before a token is minted.
interface ArchiveSessionsPayload { sessionIds: string[] }

interface ActionPreview {
  actionType: ActionType;
  targets: { relPath: string; sizeBytes: number; kind: 'file' | 'directory' }[];
  totalBytes: number;
  requiresTypedConfirm: boolean;     // §5.7
  typedConfirmPhrase: string | null; // exactly what the user must type
  confirmToken: string;              // opaque, single-use, bound to this exact target list
  warnings: string[];                // e.g. "3 targets no longer exist and will be skipped"
}
interface ActionResult { succeeded: string[]; skipped: string[]; failed: { relPath: string; reason: string }[];
                         backupRelPath: string | null; backupBytes: number }
type AuditStatus = 'completed' | 'failed_partial' | 'failed' | 'undone';
```

⚠️ **`confirmToken` is the mechanism that makes "confirm" real** (INV-06). It is minted by
`action:preview`, bound to the exact resolved target list and to a hash of it, single-use, and expires
after 5 minutes. `action:execute` re-resolves the targets and refuses with
`E_ACTION_NOT_CONFIRMED` if the list changed since the preview. **An action can never execute against
a target the user did not see.**

## §4.9 Push events (main → renderer)

Delivered on one `evt:` channel each. The renderer subscribes in the preload; there is no polling.

| Channel | Payload | Emitted when |
|---|---|---|
| `evt:sync` | `SyncState` | Every phase transition, and at most **4 Hz** while parsing (§8.5 — no visual thrash) |
| `evt:dataChanged` | `{ at: number; scopes: DataScope[] }` | A sync cycle finished having written anything. `scopes` lets the renderer invalidate only affected queries. |
| `evt:pricingChanged` | `{ at: number }` | Any write to `price_rows` |
| `evt:actionCompleted` | `{ auditId: number; status: AuditStatus }` | A guarded action reached a terminal state |
| `evt:dirStatus` | `DirStatus` | The watched directory disappeared or became unreadable |
| `evt:fatal` | `AppError` | Migration failure or DB corruption — the renderer shows the blocking error screen (§6.11) |

```ts
type DataScope = 'events' | 'sessions' | 'projects' | 'tools' | 'prompts' | 'harness' | 'bloat';
```

⚠️ **No push event ever focuses, raises or animates the window** (§1.3 moment 2, §6.2).
`evt:dataChanged` causes a silent re-query and an in-place number update, nothing more.

---

# §5 — Behavior

## §5.1 SM-1 — Dataset lifecycle

States: `NO_DIR` · `VALIDATING` · `READY_EMPTY` · `READY` · `FATAL`. Terminal: `FATAL` only.

| From | Event | To | Effects |
|---|---|---|---|
| *(boot)* | migrations applied, `claudeDir` null | `NO_DIR` | Onboarding surface (§6.2) |
| *(boot)* | migrations applied, `claudeDir` set | `VALIDATING` | — |
| *(boot)* | migration throws | `FATAL` | `evt:fatal E_DB_MIGRATION_FAILED`; **no purge, no rebuild** (ADR-026) |
| `NO_DIR` | `settings:set claudeDir` valid | `VALIDATING` | — |
| `VALIDATING` | validation ok, fingerprint unchanged | `READY` | Start watcher (SM-6), `sync:start incremental` |
| `VALIDATING` | validation ok, fingerprint **changed** | `READY_EMPTY` | **Purge DERIVED only** (§3.17), then `sync:start full` |
| `VALIDATING` | validation fails | `NO_DIR` | `dirStatus` carries the reason; existing data is retained, not purged |
| `READY_EMPTY` | first sync completes with ≥1 event | `READY` | — |
| `READY` | directory disappears / unreadable | `READY` | `evt:dirStatus`; watcher stops; **cached data keeps rendering, banner says it is stale** |
| `READY` | `settings:set claudeDir` (new path) | `VALIDATING` | — |
| any | DB reports corruption | `FATAL` | `evt:fatal E_DB_CORRUPT`; §6.11 offers *rebuild DERIVED* and *export price rows*, never a silent drop |

⚠️ A failed validation **never** purges. Pointing the app at a bad path must not cost the user their
data (ADR-026).

## §5.2 SM-2 — Sync cycle

States: `IDLE` · `SCANNING` · `PARSING` · `FINALIZING` · `CANCELLING` · `FAILED`.
Terminal within a cycle: `IDLE` and `FAILED`.

```
IDLE ──start──> SCANNING ──classified──> PARSING ──all files done──> FINALIZING ──> IDLE
  ^                 │                        │                            │
  │                 └── nothing to do ───────┴────────────────────────────┘
  │
  ├── watcher/manual start while ≠ IDLE  ⇒  queuedRescan = true, stay in current phase
  ├── cancel ⇒ CANCELLING ⇒ IDLE  (already-committed files stay committed; the manifest is consistent)
  └── unrecoverable error ⇒ FAILED ⇒ (manual retry) ⇒ SCANNING
```

Rules:

1. **At most one cycle at a time.** The watcher never starts a second; it sets `queuedRescan`.
2. On reaching `IDLE` with `queuedRescan`, the machine immediately starts one more incremental cycle
   and clears the flag. **Coalescing, not queueing** — N events during a cycle produce exactly one
   follow-up cycle.
3. **Every file is committed in its own transaction.** A cancel or a crash leaves the manifest
   consistent with what was ingested; the next cycle resumes from the recorded byte offsets.
4. `FAILED` retains all previously ingested data. A failed sync never truncates anything.
5. Progress is emitted at most 4 Hz (§8.5).

## §5.3 SM-3 — Per-file classification (the append fast-path)

For each `*.jsonl` discovered under the Claude data directory, excluding the **backup root**:

| Condition | Class | Action |
|---|---|---|
| not in `file_manifest` | `NEW` | Parse from byte 0; insert manifest row |
| `size_bytes > manifest.byte_offset` and `mtime_ms >= manifest.mtime_ms` | `GREW` | **Append fast-path**: seek to `byte_offset`, parse only new lines, advance the offset |
| `size_bytes < manifest.byte_offset` | `SHRANK` | Delete all rows with `source_file_id`, reset offset to 0, re-parse whole file |
| `size_bytes == manifest.byte_offset` and `mtime_ms > manifest.mtime_ms` | `REWROTE` | Same as `SHRANK` — a same-size rewrite is a rewrite |
| `size_bytes == manifest.byte_offset` and `mtime_ms <= manifest.mtime_ms` | `UNCHANGED` | Skip; touch `last_seen_at` only |
| **in manifest with `archive_id IS NOT NULL`** | **`ARCHIVED`** | ⚠️ **Never parsed, never deleted, never classified `MISSING`.** Sync only stats the archive root to refresh `archives.reachable` / `last_reachable_at`. Unreachable is informational (§3.15). |
| in manifest, absent on disk, `archive_id IS NULL`, `retainOrphanedHistory` **ON** (or already `retained_orphan = 1`) | **`RETAINED_ORPHAN`** | ⚠️ **ADR-041.** Keep every row. Mark `file_manifest.retained_orphan = 1` and every session it fed `sessions.retained_orphan = 1`. Never deleted by a later purge (§3.18). |
| in manifest, absent on disk, `archive_id IS NULL`, `retainOrphanedHistory` **OFF** | `MISSING` | Delete the manifest row (cascade removes its rows); count in `filesMissingSinceLastSync` |
| in manifest, **back on disk**, `retained_orphan = 1` | (reclassify) | ⚠️ **ADR-041.** The file returned. Clear `retained_orphan` on it and on any session with no other orphaned file, then classify normally (`GREW`/`UNCHANGED`/…). Re-ingest is idempotent (`event_key`, ADR-019), so no double-count. |

A partial final line (an append caught mid-write) is **not** consumed: the offset advances only to the
last complete newline, so the remainder is read on the next cycle. `chokidar`'s `awaitWriteFinish`
reduces how often this happens; the offset rule makes it harmless when it does (STACK ADR-010).

⚠️ **The `ARCHIVED` row is the single most important line in this table.** Without it, the first sync
after an archive would see the transcripts missing from `<claudeDir>`, classify them `MISSING`, cascade
their rows away, and **silently shrink every lifetime total** — the exact failure OQ-014's option C
exists to avoid. It is covered by a dedicated golden fixture (§5.9 F-04).

⚠️ **AMENDED 2026-07-22 (ADR-041) — `RETAINED_ORPHAN` closes the same failure's second door.** The
`ARCHIVED` row protects files the app **moved**; `RETAINED_ORPHAN` protects files that **vanished**
(Claude or the user deleted them). Before this feature, a deleted transcript was `MISSING` on the
very next sync and its history was cascaded away — the identical silent shrink, arriving without an
archive. Under `retainOrphanedHistory` (default ON) the `MISSING` branch instead marks the file and
its sessions RETAINED (`retained_orphan = 1`) and keeps every row; the purge spares them (§3.18); and
if the file ever returns its marker is cleared and ordinary tracking resumes, with `event_key` dedup
(ADR-019) making the re-ingest idempotent. **Compaction is out of scope** — a transcript rewritten
smaller in place is `SHRANK`/`REWROTE`, not `MISSING`, so its dropped turns are still re-parsed away;
that limit is stated honestly in ADR-041 and §11.10, not half-handled. Covered by
`test/main/sync/retain-orphaned-history.test.ts` and `test/main/db/retain-orphan-purge.test.ts`.

**INV-04 makes this testable:** appending K lines to a fixture and syncing must produce exactly the
same database contents as parsing the whole file from scratch — a required golden fixture.

Non-JSONL config files (`SKILL.md`, `CLAUDE.md`, `settings.json`, plugin manifests, `MEMORY.md`) use
`content_hash` instead of byte offsets: unchanged hash ⇒ skip.

## §5.4 Parse rules (normalization, stated once)

Applied by a **pure, injectable function over a line iterator** so golden fixtures drive it without
touching a real directory (STACK ADR-009/ADR-013).

1. One JSON object per line. A line that fails `JSON.parse` increments `file_manifest.bad_lines`,
   is skipped, and is **never fatal**. Bad lines are disclosed (§4.6).
2. **Timestamps.** Transcript `timestamp` is ISO 8601 Z → epoch ms. `history.jsonl` `timestamp` is
   already ms epoch → used as is. A record with no parseable timestamp is skipped and counted as a
   bad line. **No timestamp is ever defaulted to "now."**
3. **`event_key`** = `uuid` when present and non-empty, else `<rel_path>#<line_no>` (ADR-019).
4. **`origin`** = `'subagent'` iff the source file is under `.../<session-id>/subagents/`, else
   `'main'`. `isSidechain` is stored but is **not** the origin decision — the path is (ADR-020).
5. **`session_id`** = for a main transcript, the file basename without `.jsonl`; for a subagent
   transcript, the name of the parent directory. **Never from the record body**, which may disagree.
6. **`project_id`** = the `projects/<encoded>` directory, upserted by `encoded_name`.
7. **`is_synthetic`** = `message.model === '<synthetic>'`. Such events are stored (so they can be
   counted and disclosed) and excluded from every token, cost and model statistic (M-01).
8. **Tokens** map 1:1: `input_tokens`→`tok_input`, `output_tokens`→`tok_output`,
   `cache_read_input_tokens`→`tok_cache_read`. Absent fields are `0`, never `NULL`.
   ⚠️ **AMENDED 2026-07-22 (A-05) — cache writes are TWO classes and come from
   `message.usage.cache_creation`, not from the flat total.** The three cases are exhaustive and
   none of them is a fallthrough:
   **(1) No `cache_creation` object** (older records): the flat `cache_creation_input_tokens` goes
   to `tok_cache_write` (5-minute) and `tok_cache_write_1h` is **`0`**. ⚠️ This is *exactly* what
   the parser did before A-05, so such a record costs precisely what it always did — a documented
   fallback, not a regression, and `0` is the documented value for "the source did not split it".
   **(2) The split is present and `ephemeral_5m + ephemeral_1h == cache_creation_input_tokens`**:
   both are taken as given. This held on **all 133,701** cache-writing events of the reference
   dataset (§2.1 "Token class").
   **(3) The split is present and does NOT sum to the flat total**: the record contradicts itself
   and there is no honest way to pick a winner, so ⚠️ **neither half is trusted.** The flat total
   — the aggregate this application has always billed on — stays in `tok_cache_write`, the 1-hour
   share is stored as **`NULL` = not known**, and the record is counted in
   `file_manifest.cache_split_mismatches` and **disclosed** (§4.6). Silently believing either
   number would be a plausible total that is wrong, which is the one outcome CLAUDE.md §1 rates
   worse than a crash. The sum assertion runs only when the flat total is actually stated: a record
   carrying the split and no aggregate has nothing to contradict, and is case (2).
9. **Tool calls** come from `message.content[]` items with `type === 'tool_use'`, in array order
   (`ordinal`). `name`→`tool_name`. For `Skill`, `skill_name` is `input.skill ?? input.command ?? input.name`,
   whichever is present first; if none is, `skill_name` stays `NULL` and the call still counts as a
   tool call. For `Agent`, `subagent_type` and `description` come from `input`. For write-class tools,
   `target_path` is `input.file_path ?? input.notebook_path`.
10. **Prompts**: `display` truncated to 280 chars; `pastedContents` discarded (§3.9).
11. Unknown `type` values are stored verbatim and counted; they are never dropped and never guessed at.
12. ⚠️ **AMENDED 2026-07-22 — the subagent run's own sidecar, `subagents/<run-id>.meta.json`.**
    A file this parser reads that is **not** a transcript and produces **no events**. `agentType`,
    `toolUseId` and `description` are stored verbatim in `subagent_runs.meta_*` (§3.7, migration
    0008); every derived column is recomputed from them at FINALIZING, never during parsing.
    **Each field is taken independently** — a document stating only `agentType` (the nested
    `subagents/workflows/<wf>/` shape, 77 on the reference dataset) yields exactly that, because
    discarding the whole document over one absent field would throw away the only name those runs
    will ever have. A non-string, empty or whitespace-only value is `NULL` = *not stated*, never the
    empty string, which would render as a blank label that looks like an answer. A missing,
    unreadable or malformed sidecar is rule 1's principle applied unchanged: **less knowledge, never
    a failure and never a guess** — the run stays unlinked, is counted and is disclosed (§4.6).
    ⚠️ It is read **only** to fill `subagent_runs`. It sets no `origin`, no `session_id` and no
    `project_id`: rules 4–6 remain the path's answer alone (ADR-020), and no total depends on it.
13. ⚠️ **The API call the record came from** (migration 0011): `message.id` → `events.message_id`
    and the record's own `requestId` → `events.request_id`, **verbatim, or `NULL` when the record
    states none — never a placeholder.** Read and stored, and that is **all**: `event_key` is still
    rule 3's `uuid ?? '<rel_path>#<line_no>'` (ADR-019), so this changes no identity, no dedup and
    no token sum. Several records of one assistant turn share a `message.id` while each carries its
    own `uuid`; storing it is what lets §4.6 **count** that rather than guess at it, and the
    arithmetic decision is deliberately deferred until it can be sized against real data.

## §5.5 SM-4 — Guarded action lifecycle

States: `PREVIEWED` · `CONFIRM_PENDING` · `TYPED_CONFIRM_PENDING` · `BACKING_UP` · `EXECUTING` ·
`COMPLETED` · `FAILED_PARTIAL` · `FAILED` · `UNDOING` · `UNDONE` · `ABORTED`.
Terminal: `COMPLETED`, `FAILED_PARTIAL`, `FAILED`, `UNDONE`, `ABORTED`.

```
action:preview ─> PREVIEWED ─> CONFIRM_PENDING ─┬─ cancel ─────────────> ABORTED
                                                └─ needs typed confirm ─> TYPED_CONFIRM_PENDING
                                                                            ├─ mismatch ─> (stay)
                                                                            └─ match ────┐
                          confirm (token valid) ─────────────────────────────────────────┤
                                                                                         v
                                                                                    BACKING_UP
                                        backup fails ──> FAILED (E_ACTION_BACKUP_FAILED; NOTHING mutated)
                                                                                         │ backup ok
                                                                                         v
                                                                                     EXECUTING
                          ┌── every target succeeded ──> COMPLETED ──> UNDOING ──> UNDONE
                          ├── some succeeded ─────────> FAILED_PARTIAL   (no automatic anything)
                          └── none succeeded ─────────> FAILED
```

Rules — these are the trust story, and each is testable:

1. **Backup strictly precedes mutation.** If backup fails, nothing is mutated, ever (INV-07).
   ⚠️ **Move-class actions (ACT-07 only) write a *move manifest* instead of file copies.** A move
   destroys nothing — the bytes exist at the destination the moment the operation completes — so
   copying hundreds of megabytes into a restore point that is *never pruned* (§1.6 non-goal 4) would
   permanently consume exactly the disk the user was trying to free, defeating the action's purpose.
   The restore point instead contains `move-manifest.json`: every
   `{ originalRelPath, archiveRelPath, sizeBytes, mtimeMs }` pair. Undo replays it in reverse and
   **verifies size and mtime before moving each file back**, refusing with `E_ARCHIVE_VERIFY_FAILED`
   if anything changed. The invariant is unchanged in substance: **a restore point always exists and
   is always sufficient to reverse the action** (INV-07).
2. **The confirm token binds the preview to the execution.** Targets are re-resolved at execute time;
   any change aborts with `E_ACTION_NOT_CONFIRMED` (INV-06).
3. **Typed confirmation** is required when any target is `settings.json`, any `CLAUDE.md`, anything
   under `projects/`, or when the action is `clear-backups`. The user types the exact
   `typedConfirmPhrase` (the basename, or `clear backups`). Everything else uses a plain confirm.
   ⚠️ **AMENDED 2026-07-22 (E10):** when **several** targets trigger the rule, the phrase is the
   basename of the **first target in sorted rel_path order**. This rule said "the basename" and the
   multi-target case has an answer or the dialog cannot tell the user what to type; the resolved
   list is already sorted (INV-06 hashes it), so the preview and the dialog cannot disagree.
   ⚠️ The comparison is **exact** — no trimming, no case folding. A forgiving typed confirmation
   confirms less than it claims to.
4. **`FAILED_PARTIAL` triggers no automatic recovery.** The UI reports "N of M removed; restore point
   available" and offers a manual restore. The app never auto-restores and never auto-deletes
   (§1.6 non-goal 4).
   ⚠️⚠️ **AMENDED 2026-07-22 (E10) — this rule and INV-20 point opposite ways for ACT-07, and INV-20
   wins inside a session.** If a session's transcript moves and its `subagents/` directory then
   fails, rule 4 read alone says "report and stop", which leaves half a session on each side of the
   archive boundary — exactly the state INV-20 forbids and exactly what makes §3.18's `events` purge
   predicate unsafe. **Resolution:** the failing session's own already-moved files are moved back,
   and the session is reported failed and **not annotated**. This is not the automatic recovery rule
   4 forbids: it does not read the restore point, it touches no other target and no other session,
   and it happens **before a single row is annotated**. If that reverse move also fails, nothing is
   annotated — so the database stays consistent, the purge predicates stay safe, and both paths are
   reported to the user, who finishes it by hand. Sessions that moved cleanly are unaffected and are
   annotated normally; the action lands in `FAILED_PARTIAL` as rule 4 prescribes.
5. **Undo restores from the restore point** and writes a **new** audit entry with `undo_of_id` set;
   the original entry gets `undone_at`. Undo is available for the most recent entry matching
   `status='completed' AND undone_at IS NULL AND backup_present=1`, across restarts. Restoring an
   older restore point is not in v1 (§11.5).
6. **Every terminal state writes exactly one `audit_log` row** — including `FAILED` and `ABORTED`
   (ABORTED writes none: nothing happened and nothing was promised).
   ⚠️ **AMENDED 2026-07-22 (E10) — this rule contradicts itself as written**: it says "including …
   `ABORTED`" and then says ABORTED writes none. **The parenthetical is the rule.** `ABORTED` writes
   **no** row: cancelling a dialog, an expired token and a refused `confirmToken` all leave the
   filesystem and `audit_log` untouched, because nothing happened and nothing was promised. Every
   other terminal state — `COMPLETED`, `FAILED_PARTIAL`, `FAILED`, `UNDONE` — writes exactly one.
7. ⛔ **No target may resolve inside the backup root** — `E_ACTION_TARGET_FORBIDDEN` (INV-14). The one
   exception is `clear-backups`, whose targets are *only* inside it.

## §5.6 SM-5 — Watcher lifecycle

States: `STOPPED` · `WATCHING` · `DEBOUNCING` · `SUSPENDED`.

| From | Event | To | Effects |
|---|---|---|---|
| `STOPPED` | dataset reaches `READY` / `READY_EMPTY` | `WATCHING` | One recursive `chokidar` watch on `claudeDir`, ignoring the **backup root** and everything not matching the parsed-file kinds |
| `WATCHING` | fs event | `DEBOUNCING` | Start/extend a 500 ms timer |
| `DEBOUNCING` | 500 ms quiet | `WATCHING` | `sync:start incremental` (or set `queuedRescan`) |
| `WATCHING` | window closed / app quit | `STOPPED` | **Watcher closed. No background process survives** (§1.6 non-goal 7) |
| `WATCHING` | a guarded action is executing | `SUSPENDED` | The app's own writes must not trigger a resync |
| `SUSPENDED` | action reaches a terminal state | `WATCHING` | One explicit incremental sync |

## §5.7 The guarded-action catalogue (CLOSED — ADR-032)

An action type not in this table **cannot be executed**: the dispatcher rejects it with
`E_ACTION_UNKNOWN`. Adding one is a design change, not an implementation detail.

| Id | `ActionType` | Targets | Backs up | Typed confirm | Source flag |
|---|---|---|---|---|---|
| ACT-01 | `delete-orphan-skill-folders` | directories under `skills/` with no `SKILL.md` and 0 B of content | the whole directory | no | BR-02 |
| ACT-02 | `clear-plugin-cache` | cached plugin/marketplace directories that are not enabled in `settings.json` | the whole directory | no | BR-04 |
| ACT-03 | `delete-duplicate-config-backups` | files matching `*.bak`, `*.plaud-bak`, and directories named `backups/` **outside** the backup root | each file | no | BR-06 |
| ACT-04 | `restore-claude-md` | one `CLAUDE.md`, overwritten by one selected sibling backup file | the current `CLAUDE.md` | **yes** (basename) | BR-01 |
| ACT-05 | `delete-empty-claude-md` | one 0-byte `CLAUDE.md` | the file (0 B, still recorded) | **yes** (basename) | BR-01 |
| ACT-06 | `clear-backups` | every restore point under the backup root | nothing — this *is* the backups | **yes** (`clear backups`) | Settings §6.10 |
| **ACT-07** | **`archive-sessions`** | the transcript file **and the whole `subagents/` directory** of every named session | **move manifest**, not copies (§5.5 rule 1) | **yes** (`archive N sessions`) | BR-05 |

ACT-04 is the sole write of file *content*, and it is a whole-file copy of a file the user already
has — never authored content (§1.6 non-goal 2). ACT-06 sets `backup_present = 0` on every affected
audit entry (§3.14) and is itself audited.

**ACT-07 — archiving, in full.** Preconditions: `archiveRoot` set and valid (`E_ARCHIVE_NO_ROOT` /
`E_ARCHIVE_ROOT_INVALID`), and every named session currently live. Then:

1. **Session granularity, whole file set, always.** For each session the action moves its transcript
   **and its entire `<session-id>/subagents/` directory together**, preserving the relative layout
   under `archiveRoot/<claudeDirBasename>-<archiveId>/`. ⚠️ **A session's files are never split across
   the two roots** — that is what keeps the roll-up (INV-02) and the dedup story (§11.6) intact.
2. Destination collisions are refused up front (`E_ARCHIVE_COLLISION`); nothing is moved.
3. Move, verify, then **annotate — never delete**: set `file_manifest.archive_id` /
   `archive_rel_path` and `sessions.archive_id`; insert the `archives` row; write the audit entry.
   **No `events`, `tool_calls`, `subagent_runs` or `file_touches` row is touched.**
4. **The app never deletes anything under the archive root**, ever, on its own initiative or
   otherwise. There is no "clear archive" action in v1 (contrast ACT-06, which exists only because the
   backup root is the app's own). Managing the archive root afterwards is the user's, in Finder.
5. Undo moves everything back and clears the annotations, restoring the exact prior state.

⚠️ **AMENDED 2026-07-22 (E10) — three points where rules 1–5 needed a reading, resolved here rather
than in code comments.**

- **Rule 5 is the specific case over rule 4's general one.** Moving a file back necessarily removes
  it from where it was, so an undo does take files out of the archive root. On the same volume this
  is a `rename` and the question does not arise; across volumes (an external disk, the case ADR-033
  designed for) it is a copy followed by removing the source. **`rename` is preferred and the
  copy-then-remove path is entered only on `EXDEV`.** Rule 4 continues to mean what it says for
  everything that is not this undo: no retention, no cap, no pruning, no "clear archive" action, and
  no deletion on the app's own initiative at any time.
- **Rule 5 removes the `archives` row.** "Restoring the exact prior state" and §3.15's "never
  auto-deleted" only reconcile one way, because no column can express "this archive was undone" —
  see the amendment note in §3.15. The audit trail keeps both entries forever.
- **The destination the files move to is what `archives.archive_root` records** — see the amendment
  note in §3.2. Rule 1's "preserving the relative layout under `archiveRoot/<claudeDirBasename>-<archiveId>/`"
  therefore means `file_manifest.archive_rel_path` equals the file's original `rel_path`, exactly.

⚠️ **Archiving changes no number.** Totals, active time, cost, graphs and the session table are
identical before and after — the sessions are simply badged "archived" (§6.5). This is the whole
substance of the option chosen in OQ-014, and it is enforced by INV-18 and fixture F-04.

## §5.8 SM-6 — Price refresh lifecycle

States: `IDLE` · `FETCHING` · `VALIDATING` · `APPLYING` · `APPLIED` · `FAILED`.

```
IDLE ──user clicks Refresh prices──> FETCHING ──HTTP 200──> VALIDATING ──shape ok──> APPLYING ──> APPLIED ──> IDLE
        │                                │                       │                       │
        │ no URL configured              │ network/timeout/HTTP   │ shape mismatch        │ overlap
        └──> FAILED E_FETCH_NO_URL       └──> FAILED E_FETCH_*    └──> FAILED E_FETCH_SHAPE└──> FAILED E_PRICE_OVERLAP
```

Rules:

1. **Only the user starts this.** No fetch on launch, on a timer, on a cache miss, or on a price gap.
2. **One request, 10 s timeout, no retry, no redirect chain beyond 3 hops, `GET` only.** It is the
   only outbound call in the application (§7.5).
3. **Any failure leaves `price_rows` byte-identical.** Validation completes before a single write.
4. `APPLYING` runs the auto-versioning of §3.11 inside one transaction, then emits
   `evt:pricingChanged`. The response reports every change so the user can see what moved.
5. `pricing:upsertRate` (manual edit) enters at `APPLYING` and follows the identical path — **manual
   entry is a first-class path, not a fallback**.

## §5.9 Metric definitions — the single source of arithmetic

⚠️ **Every metric here gets a golden fixture with an inline hand-computed expected value**
(STACK ADR-012, `golden-fixture-review`). `toMatchSnapshot()` is banned in `test/metrics/**`.

| Id | Metric | Definition |
|---|---|---|
| **M-01** | Countable population | `events` with `is_synthetic = 0`. Synthetic events are excluded from every token, cost and model statistic, and are counted in `Disclosures.syntheticEvents`. |
| **M-02** | **Output tokens** (cost proxy) | `SUM(tok_output)` over M-01 within scope, ⚠️ **summed over the one-row-per-API-call population (ADR-042, see the ⚠️ block below the table)**, not over raw lines. **The primary headline number.** |
| **M-03** | Cache reads | `SUM(tok_cache_read)` over the one-row-per-API-call population (ADR-042). **Never** added into a "total tokens" figure without an explicit adjacent label (HANDOFF §5). |
| **M-04** | Token breakdown | The **five** class sums, always reported as five numbers, never one, ⚠️ **each summed over the one-row-per-API-call population (ADR-042, block below)**. ⚠️ **AMENDED 2026-07-22 (A-05)** — four became five: `cache_write` is the **5-minute** class and `cache_write_1h` the **1-hour** one (§2.1 "Token class"). A surface that shows a single "cache write" column is showing two differently-priced quantities added together. `tok_cache_write_1h IS NULL` (a row parsed before the split existed, §3.5) contributes **0** to the sum and **1** to §4.6's `cacheSplitUnknownEvents`; it is never reported as a known zero. |
| **M-05** | **Cost** | `SUM over API CALLS, over the five classes, of tokens_c × rate(model, c, call.ts)`, in nanoUSD. ⚠️ **AMENDED 2026-07-24 (ADR-042) — the unit of summation is the API CALL, not the JSONL line** (block below): each call is costed once, at its final line's authoritative usage, so a call written as several lines is not charged N times. ⚠️ An API call is costed **only if every class with a non-zero count has a covering price row**; otherwise the **entire call** is uncosted and contributes nothing (INV-09). ⚠️ **AMENDED 2026-07-22 (A-05)** — the fifth class is `cache_write_1h`, priced by its own stored row (2× input on today's page; **never derived** — §1.7, ADR-024). Costing every cache write at the 5-minute rate understated the reference dataset by **$415.07**. A call with a non-zero `tok_cache_write_1h` and no covering `cache_write_1h` row is **entirely uncosted**, exactly like any other class. A call whose split is **not known** is costed with `COALESCE(tok_cache_write_1h, 0)` — reproducing the pre-A-05 arithmetic exactly, so no number moves on upgrade — and is **disclosed**, never excluded: dropping those calls would erase the user's whole lifetime total the moment they upgraded. |
| **M-06** | Uncosted summary | Count of **API calls** excluded by M-05, grouped by `model` with `MIN(ts)`/`MAX(ts)`. Rendered as *"N records uncosted (model X, date range Y)"* next to every `$` figure (INV-10). ⚠️ Since ADR-042 this counts calls, not lines, so it agrees with the deduplicated M-05 population it qualifies. |
| **M-07** | **Active time** | `SUM(MIN(ts − LAG(ts) OVER (PARTITION BY <partition> ORDER BY ts), idleGapMs))`, the **first event of each partition contributing 0**. Computed at query time (ADR-022). **Two things fully determine this metric, and both are pinned:**<br>⚠️ **(1) The event set (ADR-035):** ALL events of the partition, of **BOTH origins** — `origin IN ('main','subagent')` — merged into one timestamp-ordered stream *before* gaps are taken. Synthetic events (M-01) are excluded from token statistics but **are** included here: they are real moments in the stream.<br>⚠️ **(2) The partition (ADR-036). There are exactly three bindings, and every surface in this document uses one of them — there is no unbound case:**<br>**(A) Single session** → `PARTITION BY session_id`. Used by `SessionRow.activeSeconds`, session drill-down, the session-length histogram, `SessionSort='activeSeconds'`, and M-10.<br>**(B) Working day** → `PARTITION BY (local calendar date of ts, project_id)`. This is M-08. Used by the marathon leaderboard. ⚠️ **AMENDED 2026-07-22 (ADR-040): the second column is the *project unit* (§2.1), not the raw `events.project_id`** — the project itself unless the user has declared it the same project as another folder, in which case it is their group. The grouping is applied **where the partition is formed** (the innermost `scoped` CTE), never by summing two projects' finished results afterwards: once two folders are one project a gap between them on the same local day is an INTRA-partition gap and is capped-and-counted, and adding the two ungrouped results drops it. Fixture **F-16** pins the difference with a `not.toBe()` on the naive sum.<br>**(C) Any aggregate spanning more than one session** → **the sum of (B) over every working-day group in scope.** Not one global stream, and not a sum over sessions. Used by the Overview *Active hours* tile and by `ProjectCard.activeSeconds`. Intra-day inter-session gaps are capped at the idle threshold and **counted**, exactly like any other gap.<br>**Filter boundaries:** each partition's stream is restricted to the `GlobalFilter` window first; the first event *of the restricted stream* contributes 0, so a filter cut behaves exactly like a partition start.<br>⚠️ **(3) The unit (added 2026-07-22).** M-07 is computed **entirely in integer epoch milliseconds** — the storage unit — and converted to seconds **once**, by truncation, at the point the value leaves the repository: `activeSeconds = trunc(activeMs / 1000)`, the same rule M-09's generated `span_seconds` uses, so active time and span always agree about what a second is. **No intermediate value in the gap-and-cap arithmetic may be a floating-point number.** This is the same "compute exactly in the storage unit, convert at the edge" rule ADR-023 applies to money and §5.10's E4 amendment applies to M-20, and it is stated here because it was violated: see the amendment below §5.9.1's fixture table. |
| **M-08** | Working day | Group events by `(local calendar date of ts, project unit)` (ADR-021; ⚠️ **unit**, not raw project — ADR-040) — this is M-07 binding **(B)**. `activeSeconds` per M-07 over that group, ⚠️ **inheriting M-07's event set exactly: both origins, merged and ordered by timestamp before gapping.** `spanSeconds` = last − first within the group; `sessions` = distinct `session_id`. A session spanning midnight contributes its events to **both** days, by each event's own local date. ⚠️ **M-08 is also the unit of aggregation for binding (C)** — every multi-session Active-hours figure in the product is a sum of M-08 values, which is what makes the Overview tile and this leaderboard agree by construction (INV-21). |
| **M-09** | Session span | `sessions.span_seconds` = `(last_ts − first_ts)/1000`. Threshold-independent, and **partition-independent** — it reads two stored columns of one session row and never gaps anything, so M-07's bindings do not apply to it. |
| **M-10** | Longest session | By **active time** under M-07 binding **(A)**, single session, both origins. Longest-by-span (M-09) is shown separately and explicitly labelled (HANDOFF §5). ⚠️ Note the deliberate asymmetry: "longest **session**" ranks sessions (A), while the marathon leaderboard ranks **working days** (B). They are different nouns and may name different winners; §6.5 labels each. |
| **M-11** | Session message count | `COUNT(*)` over M-01 events of the session with `role IN ('assistant','user')`, **including** `origin='subagent'` (roll-up, §2.1). |
| **M-12** | Tool calls | `COUNT(*)` over `tool_calls` in scope. **Includes `Agent` and `Skill`.** Distinct tools = `COUNT(DISTINCT tool_name)`. |
| **M-13** | Skill invocations | `tool_calls` with `tool_name = 'Skill'`, grouped by `skill_name`. "Installed but never used" = a `harness_nodes(kind='skill')` row whose `name` matches no `skill_name` **over the full dataset** (INV-13). |
| **M-14** | Runtime overlay | Per `harness_edges` row: `observed` = count of matching tool calls over the full dataset; `designed` = the edge exists in `harness_edges`. Reported as two fields (§4.5). |
| **M-15** | File metrics | Over `file_touches`: **files touched** = `COUNT(DISTINCT path)`; **edit count** = `COUNT(*)`; **languages** = `COUNT(*) GROUP BY language`. Extension→language map is a constant table in `src/shared/language-map.ts` (`ts/tsx→TypeScript`, `js/jsx/mjs/cjs→JavaScript`, `py→Python`, `rs→Rust`, `go→Go`, `md→Markdown`, `json→JSON`, `sql→SQL`, `css→CSS`, `html→HTML`, `sh/zsh/bash→Shell`, `yml/yaml→YAML`, `toml→TOML`; anything else → `NULL`, surfaced as "other"). **Never called churn, never presented as lines changed.** |
| **M-16** | Data coverage | `transcriptsFrom` = `MIN(events.ts)`; `promptsFrom` = `MIN(prompts.ts)`. `partialBefore` = `transcriptsFrom` when `promptsFrom < transcriptsFrom`, else `null`. Any chart bucket earlier than `partialBefore` renders with the partial-data treatment (§6.12) and **never as zero**. |
| **M-17** | Origin split | M-02/M-04/M-11/M-12 partitioned by `events.origin`. The moment-of-value number. **`main + subagent` must equal the unpartitioned total exactly** (INV-02). ⚠️ Since ADR-042 the TOKEN parts (M-02/M-04) are summed per API call and the COUNT parts (M-11/M-12) per line; INV-02 still holds exactly for both because every line of a call shares one `origin`. |
| **M-18** | Cache hit ratio | `tok_cache_read / (tok_cache_read + tok_input)` over M-01, ⚠️ **both sums over the one-row-per-API-call population (ADR-042)** so numerator and denominator agree with M-03/M-02, as a ratio in `[0,1]`; `0` when the denominator is 0. Labelled "of input served from cache" (prototype §6.4). |
| **M-19** | **Deduplicated active time** ⚠️ *internal — never displayed* | The measure of the **union** of covered intervals across every partition in scope. **Covered interval:** for each partition, order its events `t₀ < t₁ < … < tₙ` (event set per ADR-035); for each `i ≥ 1` with gap `gᵢ = tᵢ − tᵢ₋₁` and cap `c = idleGapMs`, the covered interval is `Cᵢ = [tᵢ − min(gᵢ, c), tᵢ]`. Within one partition the `Cᵢ` are provably disjoint (`gᵢ > c ⇒ tᵢ − c > tᵢ₋₁`), so their measure sums to exactly M-07 — M-19 is therefore a **restatement** of M-07, not a second definition of it. **M-19 = measure(⋃ of all `Cᵢ` over all partitions in scope)**, computed by a sort-and-merge sweep over the intervals. ⚠️ **This quantity has no surface and exists only so M-20 can be computed. It must not be "optimised away": deleting it breaks INV-22 and fixture F-13.** ⚠️ **It is NOT "M-07 with one global partition"** — that reading is wrong and gives a *negative* overlap, because a coarser partition has longer gaps that the cap truncates harder (worked counterexample in ADR-037). |
| **M-20** | **Cross-project overlap** (the disclosed quantity) | `M-20 = (M-07 binding (C) total for the scope) − (M-19 for the same scope)`, in seconds. It is the portion of the Active-hours figure attributable to two or more projects being active in the same clock interval, i.e. the double-counted part. **Exactly `0`** when no two partitions' covered intervals intersect — which includes, by construction, any scope containing **at most one project** (one partition per day, and days are disjoint). ⚠️ **AMENDED 2026-07-22 (ADR-040): "one project" means one *project unit*, so a scope containing one GROUP and nothing else also reports `0`** — a group is one project. Grouping two projects that overlapped in time therefore *reduces* M-20, correctly: what was double-counted across two partitions is now one partition's own time, counted once. M-19 itself does not move — the union is a measure of clock time and does not care how it is partitioned — so the drop appears entirely in binding (C). Fixture **F-16** asserts 15m → 0 over F-13's own fixture. Never negative (INV-22). Rendered as *"N hours of this total overlap across projects"* beside the Overview *Active hours* tile (§6.3, ADR-037). |

| **M-21** | **Memory entry count** ⚠️ *originated in the build, not in the source documents* | Over one `MEMORY.md`: the number of lines whose **first non-space character is `-`, `*` or `+`, followed by whitespace and at least one non-space character** — i.e. markdown list items, at any indent. Computed by the harness scanner and stored in `harness_nodes.entry_count` (§3.10, migration `0003`); `NULL` means "not counted" and is **never** read as zero. Rendered by §6.9's memory browser **with the definition beside it** ("Entries are counted as markdown list items"). ⚠️⚠️ **This is the only metric in §5.9 that was not carried from a verified source or a user decision.** §6.9 and §4.5 both promise an "entry count" and no source document, DDL or metric defined one; E10 stated a mechanical, testable rule rather than leave a number nothing stands behind (CLAUDE.md §1). It has never been user-confirmed. A reader who disagrees should change **this row**, which is the only place the arithmetic lives. Golden case with inline hand-computed values: `test/main/harness/scan.test.ts` ("M-21 — memory entry count"). |

> ⚠️⚠️ **AMENDED 2026-07-24 (ADR-042) — THE POPULATION EVERY TOKEN SUM AND COST IS TAKEN OVER:
> ONE ROW PER API CALL, NOT ONE PER JSONL LINE.** Stated once here; M-02, M-03, M-04, M-05, M-06,
> M-17 (token half) and M-18 all refer to it and none re-states the arithmetic.
>
> **The rule.** Claude Code writes one assistant API call as several JSONL lines that share one
> `message.id`/`requestId` and repeat — or, while streaming, progressively accumulate — the same
> `usage`. Line identity (ADR-019) is correct and each line is a real, separately-stored row, but a
> naive `SUM(tok_*)` charges one call N times. On the reference dataset 187,870 costed rows are
> **85,234 distinct calls**; cache-read 24.0B→12.0B, cache-write 778M→291M, output 91M→68M, and the
> headline cost roughly halves. So every token sum and every cost is taken over the **one-row-per-call**
> projection defined by these three clauses, applied **at query time** (storage is unchanged):
>
> 1. Group the M-01 population by `message_id`. (`message_id` and `request_id` are 1:1 in the data;
>    `message_id` is the key.)
> 2. Within a group the lines can DISAGREE (streaming: partial early, cumulative last). The
>    authoritative usage is the **final line's** — the greatest `line_no` in the group (calls never
>    span files). ⚠️ **Cross-check:** for cumulative-streaming usage the per-class `MAX` over the
>    group equals the final line's values; if they ever diverge that is a finding to surface, not to
>    average over (fixture F-17 asserts the agreement).
> 3. Rows with `message_id IS NULL` are **each their own call** — never folded together. This keeps
>    a record that genuinely states no id a single call, and it keeps a pre-migration database (every
>    row NULL, ingested before the app read the field) counted line-for-line rather than silently
>    merged. Such rows are **not deduplicated** until a rebuild fills their ids in (§3.18), which is
>    exactly what §4.6's `repeatedApiCalls` unchecked/uncheckable counts disclose.
>
> **What this does NOT touch.** Only token-usage SUMS and cost. Counts of records (M-11 messages,
> M-12 tool calls, subagent-turn counts), event MOMENTS (M-07/M-08 active time — about timestamps,
> not usage — the M-16 coverage bounds, §6.3's calendar, §6.5's rhythm heatmap) and per-model event
> mixes are genuinely per-line and are summed over raw `events`. The seam is one shared CTE,
> `src/main/db/repositories/api-call-usage.ts`, so the rule lives in exactly one place (CLAUDE.md §1).
> `event_key` and ingest are unchanged — this is not an identity change (ADR-019 stands; ADR-042).

## §5.9.1 Required golden fixtures (named, so `golden-fixture-review` has a checklist)

Every fixture below uses an **inline hand-computed expected value with the arithmetic in a comment**.
`toMatchSnapshot()` is banned in `test/metrics/**` (STACK ADR-012).

| Id | Fixture | Must prove |
|---|---|---|
| **F-01** | **Active time across a subagent run** — a parent session with events at `t=0, 5m`, then a **40-minute gap during which a subagent transcript has events every 2 minutes**, then a parent event at `t=45m`. Idle threshold 15m. | ⚠️ **The single fixture that pins OQ-013.** Under M-07 as decided (both origins) the 40-minute stretch is filled by subagent events, so no gap exceeds the cap and active time is the full ~45m. Under the rejected main-only reading it would be `5m + 15m = 20m`. **A fixture built only from main-loop sessions would pass under either reading and prove nothing** — this one must contain a parent session with a long subagent run inside it, and its expected value must be the number the two readings disagree about. |
| F-02 | Subagent roll-up totals | INV-02 exactly: `main + subagent = total` for M-02, M-04, M-11, M-12; and that no event is counted twice. |
| F-03 | Incremental append == cold parse | INV-04 across every table. |
| **F-04** | **Archive retains everything** — parse a fixture, archive one session, re-sync, then **purge and full-rebuild**, then undo. | Totals identical at every step; the archived session's rows still present after both the re-sync and the rebuild; its manifest row classified `ARCHIVED` not `MISSING`; and undo restoring the exact prior state. **This is the fixture that catches a silent shrink of lifetime totals.** ⚠️ **AMENDED 2026-07-22 (E10) — the comparison runs at BOTH layers.** INV-18 says "every aggregate in §5.9", and the numbers a user reads are the §4.5 **channel payloads**, not the repository rows behind them: a channel pages, sorts, joins display names, folds four repositories into one tile and attaches disclosures, and any of those could lose a property the repositories keep. F-04 therefore compares the repository layer **and** every §4.5/§4.6 payload shape, and asserts each payload is a real payload before comparing it — two identical error envelopes comparing equal five times would prove nothing. The fixture must also contain a session with a **`subagents/` directory** (so the archived session's totals genuinely straddle a roll-up, INV-02/INV-20) and one without. |
| F-05 | Malformed JSON lines | Counted, skipped, never fatal, disclosed. |
| F-06 | `<synthetic>` exclusion | Excluded from tokens/cost/model stats (M-01), **included** in M-07's stream, counted in disclosures. |
| F-07 | Timestamp normalization | ISO 8601 Z vs ms-epoch both land on the same epoch ms; no timestamp ever defaults to "now". |
| F-08 | Costing across a **price change** | Usage before and after the boundary costed at its own row's rate; half-open `[from, to)` means the boundary instant belongs to exactly one row. |
| F-09 | Costing with **no applicable price row** | The record is **entirely** excluded from `$` (INV-09) *and* surfaced in `UncostedSummary` — never zero-filled, never substituted. |
| **F-10** | **Rate precision** — a rate of `$0.3125/Mtok` (`3.125e-07` USD/token, a real published value) | Stored exactly as `312500` picoUSD/token and round-tripped through Settings without loss; a 7-decimal input is **rejected** with `E_PRICE_PRECISION` rather than rounded (ADR-023 as amended). |
| F-11 | Working-day aggregation | M-08 inherits M-07's event set; a session crossing local midnight contributes to both days by each event's own local date, under a pinned `TZ`. |
| **F-12** | **Aggregate active time across two sessions in one day** — one project, one local day, **session S1** with events at `09:00`, `09:15`, `09:30`, **session S2** with events at `10:00`, `10:10`, `10:20`. Idle threshold 15m. ⚠️ **AMENDED 2026-07-22 (E4)** — see the block below the table; the session **boundaries** are unchanged. | ⚠️ **The fixture that pins ADR-036's binding (C).** Under (C) the partition is the whole `(day, project)` group, so the merged stream is `09:00, 09:15, 09:30, 10:00, 10:10, 10:20` and the `09:30 → 10:00` inter-session gap is 30m, capped at 15m and **counted**: `15m + 15m + 15m + 10m + 10m = 65m`. Under the rejected per-session sum it would be `30m + 20m = 50m`. The test must assert the Overview tile **and** the working-day row **and** the project card all return `65m` for this fixture — that is INV-21. ⚠️ **A fixture with only one session per day passes under either reading and proves nothing.** |
| **F-13** | **Cross-project overlap, both cases** — ⚠️ **it must discriminate; a fixture whose overlap happens to be 0 proves nothing.** *Overlapping case:* one local day, threshold 15m, **project A** events at `09:00, 09:10, 09:20` and **project B** events at `09:05, 09:15, 09:25`. *Zero case:* the same A, with B shifted to `10:00, 10:10, 10:20`. | **Overlapping:** A's covered intervals are `[09:00,09:10]`+`[09:10,09:20]` = 20m; B's are `[09:05,09:15]`+`[09:15,09:25]` = 20m; binding (C) total = **40m**. Union = `[09:00,09:20] ∪ [09:05,09:25]` = `[09:00,09:25]` = **25m** (M-19). **Overlap (M-20) = 40 − 25 = 15m.** Also assert `M-19 (25m) ≤ elapsed span (25m)` per INV-22(c). **Zero case:** total 40m, union 40m (disjoint), **overlap = 0**, and the tile renders **no** disclosure line. Third assertion: a single-project scope returns overlap `0` (INV-22(d)). |
| **F-14** | **Active time on millisecond timestamps** ⚠️ **ADDED 2026-07-22 — the shape every other fixture is missing.** One project, one local day, threshold 15m: **session A** at `00:00:00.000`, `00:05:00.250`, `00:25:00.750` and **session B** at `00:40:00.500`, `00:42:00.900`, `01:00:00.900` (UTC, `TZ` pinned). Gaps: `300_250`, `1_200_500`, `899_750`, `120_400`, `1_080_000` ms. | ⚠️ **The fixture that pins the ms→seconds conversion, and the only one whose gap sums are not exact multiples of 1000.** Binding **(A)**: A = `300_250 + 900_000` = `1_200_250` ms → **1_200 s**; B = `120_400 + 900_000` = `1_020_400` ms → **1_020 s**. Binding **(B)/(C)**: `300_250 + 900_000 + 899_750 + 120_400 + 900_000` = `3_120_400` ms → **3_120 s**, span `3_600_900` ms → **3_600 s**. ⚠️ **Every fixture before this one places every event on a whole minute, so every gap sum divides exactly by 1000 and a floating-point ms→s conversion is invisible in all of them** — which is how `q:sessions` shipped broken on real data with F-01/F-11/F-12 green (§5.9 M-07's 2026-07-22 amendment). It also pins the cap's **unit**: `899_750` is 250 ms under the 15m cap and `300_250` is 250 ms over the 5m cap, so a cap compared in seconds or minutes gets both backwards. `test/metrics/f14-subsecond-active-time.test.ts`. |
| **F-15** | **1-hour cache writes are priced separately** ⚠️ **ADDED 2026-07-22 (A-05) — and it must DISCRIMINATE.** One model at the real published Opus 4.8 rate set: `input` $5, `output` $25, `cache_write` **$6.25**, `cache_write_1h` **$10**, `cache_read` $0.5 per Mtok. Three events: `e1` 1,000,000 5-minute writes only; `e2` 1,000,000 **1-hour** writes only (deliberately the same token COUNT as `e1`); `e3` every class non-zero at once — 100,000 input, 20,000 output, 400,000 5-minute, 600,000 1-hour, 2,000,000 cache reads. | ⚠️⚠️ **A fixture that priced the two cache-write classes the SAME would pass under the old single-class model, under the new one, and under a build that swapped the two columns — it would prove nothing.** These two rates differ, so the readings disagree on a number. Hand-computed picoUSD: `e1` `1_000_000 × 6_250_000 = 6_250_000_000_000`; `e2` `1_000_000 × 10_000_000 = 10_000_000_000_000`; `e3` `500_000_000_000 + 500_000_000_000 + 2_500_000_000_000 + 6_000_000_000_000 + 1_000_000_000_000 = 10_500_000_000_000`. **Total `26_750_000_000_000` pico → `26_750_000_000` nanoUSD ($26.75).** ⚠️ The pre-A-05 reading — every cache write at the 5-minute rate — gives `20_750_000_000_000` pico → **$20.75**, and the fixture asserts that value is NOT produced. Also pins INV-09 for the new class (a non-zero 1-hour count with no covering row leaves the WHOLE event uncosted) and the not-known case (a NULL split costs exactly what it did before A-05 and is disclosed, not excluded). `test/main/pricing/a05-cache-write-1h-costing.test.ts`. |
| **F-16** | **Two projects the user has said are the same, active on the SAME local day** ⚠️ **ADDED 2026-07-22 (ADR-040) — and it must DISCRIMINATE.** `TZ = Asia/Tokyo`, threshold 15m: `-work-demo-family-app-old` at local `09:00, 09:10, 09:20` and `-work-demo-family-app-new` at local `09:50, 10:00, 10:10`. The user groups them by name. | ⚠️⚠️ **A fixture whose two projects are active on DIFFERENT days passes under both readings and proves nothing** — the same warning F-12 carries. Ungrouped: two partitions, `10+10 = 20m` and `10+10 = 20m`, binding (C) = **40m = 2_400 s**. Grouped: ONE partition over the merged stream `09:00, 09:10, 09:20, 09:50, 10:00, 10:10` — `10 + 10 + 15(capped from 30) + 10 + 10` = **55m = 3_300 s**. The test asserts `3_300` **and** `not.toBe(2_400)`, so an implementation that grouped by summing two finished results fails. It also asserts INV-21 under the grouping (tile = sum of working-day rows), that M-20 drops to `0` and that a single-group scope reports `0` (INV-22(d)), that a purge-and-rebuild with **deliberately different `projects.id`s** leaves the group naming the same two folders (§3.19's `encoded_name` trap), that ungrouping restores seven payloads byte-identically, and that **nothing auto-suggests a grouping** over two folder names three characters apart. `test/metrics/f16-grouped-active-time.test.ts`. |
| **F-17** | **One row per API call** ⚠️ **ADDED 2026-07-24 (ADR-042) — the fixture whose expected numbers MOVED, and it must DISCRIMINATE.** One session, parsed by the real parser so `message.id` → `message_id`: a 3-line STREAMING call `msgA` whose usage VARIES (output `10 → 40 → 90`, cache_write `0,0,20`, the last line authoritative); a 2-line repeat `msgB` (identical usage); a single-line `msgC`; two assistant records `n7`,`n8` with NO `message.id` (each its own call); and a `user` record `n0`. | ⚠️⚠️ **A fixture in which every call is a single line passes with or without the collapse and proves nothing.** 9 stored rows → **6 calls** (msgA→n3, msgB→n5, msgC→n6, n0, n7, n8); the three NULL-keyed rows stay separate. Deduped M-04: input `100+50+8+4+6 = 168`, output `90+7+5+2+3 = 107`, cache_write `20+0+3 = 23`, cache_read `1000+200 = 1200` — asserted against the NAIVE per-line sums (input `418`, output `164`) with `not.toBe`, so bypassing the seam fails. Cross-check: per-class `MAX` over `msgA` = final line n3 (`100/90/20/1000`). Cost at `$1/Mtok` all classes: deduped tokens `1210+257+16+6+9 = 1498` → `1_498_000_000` picoUSD, `costedEvents = 5` (not 8 lines). ⚠️ Per-line invariant PINNED: the M-11 message count stays `9` (8 assistant + 1 user), NOT the 6 calls — proof the collapse touches usage sums only. `test/metrics/f17-api-call-dedup.test.ts`. |

⚠️ **AMENDED 2026-07-22 (E4) — F-12's published event list did not yield its published expected
value, and the expected value was right.**

F-12 previously specified "**session S1** with events at `09:00` and `09:30`, **session S2** with
events at `10:00` and `10:20`" and stated `30m + 15m + 20m = 65m`, with the rejected per-session sum
at `30m + 20m = 50m`. **Those numbers are not reachable from those four events under M-07 as
written.** M-07 is `SUM(MIN(gap, idleGapMs))`; that event list gives gaps of **30m, 30m and 20m**,
each capped at 15m, for a total of **45m** — and `15m + 15m = 30m` for the per-session reading. The
stated arithmetic counts each session's own 30m and 20m stretch **uncapped** while capping only the
`09:30 → 10:00` inter-session gap, which no reading of M-07 produces. No threshold reconciles them
either: at `T ≥ 30m` the total is 80m, at `T = 15m` it is 45m; 65m is unreachable.

**The expected value was correct and the event list was incomplete.** F-12 named each session's
**endpoints**, and its arithmetic is exactly right for a session whose interior events keep every gap
inside the threshold. The row above therefore now states the full event lists —
`09:00, 09:15, 09:30` and `10:00, 10:10, 10:20` — which preserve the session boundaries F-12 already
named and reproduce **both** published numbers exactly: binding (C) = **65m** and the rejected
per-session sum = **50m**.

⚠️ **M-07's formula was NOT changed, and neither was ADR-036.** Only the fixture's event list is
disambiguated. `test/metrics/f12-aggregate-active-time.test.ts` additionally pins the literal
two-event reading in its own assertion (`45m`, and `not.toBe(65m)`), so the discrepancy is a recorded
fact in the suite rather than a note in a report nobody re-reads.

Found the way §11.8 says these things get found: by hand-computing an expected value and being unable
to reach it (STACK ADR-012). Had the fixture been written to make the published number pass, the only
way to do it would have been to stop capping intra-session gaps — silently redefining M-07 to match a
slip in its own test, which is precisely the failure §1.5 exists to prevent.

⚠️ **AMENDED 2026-07-22 (E4) — M-07 was computed in floating point for one of its three bindings,
and every committed fixture was blind to it. Fixture F-14 above is the fix to the blind spot.**

Found by running `q:sessions` against a real ~1 GB dataset: it returned `E_INTERNAL` —
*"the computed total for `activeSeconds` is too large to report exactly"* — for **33 of the 75
sessions in that database**. ⚠️ **The value was not large.** The largest `activeSeconds` in the whole
dataset was `77_842.97`, about 21.6 hours against its own 79_548-second span. INV-11's predicate is
`Number.isSafeInteger`, which refuses two different things — a magnitude past `2^53−1` **and a value
that is not whole** — and it was the second. The refusal was correct; only its message was wrong.

**The mechanism, which is a property of the seam and not of the arithmetic.** `better-sqlite3` binds
every JS `number` as a SQLite **REAL**: `typeof(?)` is `'real'` even for `900000`. SQLite's scalar
`min(X, Y)` returns *whichever argument is smaller, carrying that argument's own type*, so
`MIN(gap, ?)` returned an INTEGER when the gap won and a **REAL exactly when the idle cap won**;
`SUM()` over a set containing one REAL is a REAL. `ActiveTimeRepository` survived this because it
carries milliseconds out to JS and truncates there (`Math.trunc(ms / 1000)`), which is exact for
integral doubles. `SessionStatsRepository`'s **hand-copied second implementation** of M-07 binding
(A) divided by 1000 *inside SQL*, where the same REAL made it floating-point division. So bindings
(B) and (C) were numerically correct throughout — the Overview tile, the marathon leaderboard and
the project cards were never wrong — and binding (A) produced a fractional value that was **refused,
not rendered**. ⚠️ Worth stating plainly, because it is the one piece of good news: no user was ever
shown a wrong-but-plausible active time. The 42 sessions whose gaps never hit the cap were exactly
right, and the other 33 errored.

**Two design consequences, both now stated above rather than left to the implementation.**
**(1)** M-07 gains an explicit **unit** clause: the metric is computed in integer milliseconds and
converted to seconds once, by truncation, at the repository edge. **(2)** §5.9.1 gains **F-14**,
because the reason F-01, F-11 and F-12 were all green is a blind spot they share by construction —
*every event in every committed fixture sits on a whole minute*, so every fixture's gap sum divides
exactly by 1000 and the floating-point division lands on an integer. A fixture regime built entirely
from round timestamps cannot see a unit-conversion bug. F-14 is the same shape as F-12 with
millisecond timestamps and sums that are deliberately not multiples of 1000.

**The implementation rule that follows, recorded so it is not re-derived:** M-07's capped-gap
expression exists **once**, as `CAPPED_GAP_MS` in `src/main/db/repositories/active-time.ts`, and it
casts — `MIN(gap, CAST(? AS INTEGER))`. Every site that needs it imports it. The second copy is what
allowed the two implementations to drift, and CLAUDE.md §1's "every metric is defined once" is the
rule that was actually broken here; the floating point was only how it showed up.

⚠️ **A new permanent assertion, and why it is not gold-plating.** `SessionRow.activeSeconds <=
SessionRow.spanSeconds` is now asserted in the repository. It is a true property of binding (A) —
every term is a gap between two of that session's own events, and `sessions.first_ts`/`last_ts` are
`MIN/MAX(events.ts)` over both origins — it holds under any filter and survives truncation, and it
costs one comparison per row. It is worth having because of *how* this bug was reported: an
overflow guard on an unrelated invariant, naming a value that was not large, one layer away from the
metric. This assertion fails in the metric's own terms and names the session.

## §5.10 Invariants (testable assertions)

| Id | Assertion |
|---|---|
| INV-01 | Every event row has exactly one `session_id` and one `project_id`, both non-null and both resolvable. |
| INV-02 | For any scope: `SUM(metric WHERE origin='main') + SUM(metric WHERE origin='subagent') = SUM(metric)`, exactly, for M-02, M-04, M-11 and M-12. **The headline correctness risk; dedicated fixture.** |
| INV-03 | Ingesting the same file twice, or the same record from two files, changes no aggregate. (`event_key` idempotence, ADR-019.) |
| INV-04 | For any fixture F and any append A: `parse(F) then append(A) then sync` ≡ `parse(F+A) from scratch`, over every table. |
| INV-05 | Changing `idleGapMinutes` changes **only** active-time results. `sessions` row count, session ids, spans, token totals and tool counts are byte-identical before and after. |
| INV-06 | `action:execute` succeeds only with a `confirmToken` minted by a `action:preview` whose resolved target list hashes identically. |
| INV-07 | For every `audit_log` row with `status IN ('completed','failed_partial')` and at least one succeeded target, `backup_rel_path` is non-null and that restore point exists on disk at write time **and is sufficient to reverse the action** — file copies for delete-class actions, a verified `move-manifest.json` for move-class (ACT-07). |
| INV-08 | No two `price_rows` with the same `(model, token_class)` have overlapping `[valid_from, valid_to)` ranges. |
| INV-09 | An event contributes to a `$` total iff every token class with a non-zero count has a covering price row. No partial costing, ever. |
| INV-10 | Every IPC payload containing a `$` figure also contains its `UncostedSummary`. |
| INV-11 | Every numeric aggregate crossing IPC is `<= Number.MAX_SAFE_INTEGER`; the repository asserts this and returns `E_INTERNAL` rather than a silently-rounded number. ⚠️ **AMENDED 2026-07-22 (E4):** the assertion is `Number.isSafeInteger`, which also refuses a value that is not **whole** — every aggregate this application reports is an exact integer count in its storage unit, so a fractional one means the arithmetic behind it is wrong and it is equally unreportable. The two cases must be **reported distinctly**: a message saying "too large" about a value of `12_180.862` sent a real diagnosis looking for an eleven-order-of-magnitude overflow that did not exist (§5.9 M-07's amendment). |
| INV-12 | A purge or migration never writes to, truncates, or drops `price_rows`, `settings` or `audit_log`. |
| INV-13 | Harness Manager invocation counts, "last used", "never used" and the runtime overlay are computed over the **full dataset** and are unaffected by the global filter. The UI labels them "all time". |
| INV-14 | No path under `<claudeDir>/.claude-lens-backups/` appears in `file_manifest`, in any analytics query result, in any `bloat_flags` row, or in the watcher's event stream — except as the target of ACT-06. |
| INV-15 | No `fetch`/`XMLHttpRequest`/`WebSocket`/`http`/`https`/`net` reference exists outside `src/main/pricing/fetch-price-table.ts` (STACK ADR-015, enforced by `pnpm run lint`). |
| INV-16 | The renderer imports nothing from `src/main/**`, `better-sqlite3*`, `node:fs`, `node:path` or `electron` (STACK ADR-008/015). |
| INV-17 | Every scanner, parser and action entry point takes its root directory as a parameter; no module resolves `claudeDir` implicitly (STACK ADR-013). |
| **INV-18** | **No purge, rebuild, migration or sync deletes a row whose `archive_id IS NOT NULL`, and archiving changes no metric.** Every aggregate in §5.9 returns byte-identical results immediately before and immediately after an ACT-07, and again after a full purge-and-rebuild (fixture F-04, ADR-033). |
| **INV-19** | `archiveRoot` is never inside `<claudeDir>`, never a parent of it, never the backup root, and never inside the repository. No Bloat Radar rule, analytics query, file-manifest scan or watcher subscription ever walks it (ADR-034). |
| **INV-20** | A session's transcript and its `subagents/` directory are always on the same side of the archive boundary — never split between `<claudeDir>` and the archive root (§5.7 ACT-07 rule 1). |
| **INV-21** | **Active hours agree across surfaces.** For any `GlobalFilter`, `q:overviewTiles.activeSeconds` equals the sum of `activeSeconds` over every row `q:workingDays` returns for that same filter, exactly. Likewise `ProjectCard.activeSeconds` equals the sum over that project's rows. ⚠️ Two "active hours" that disagree behind the same word on two screens is the discrepancy this invariant exists to make impossible (ADR-036, fixture F-12). ⚠️ **AMENDED 2026-07-22 (ADR-040): it holds UNDER THE GROUPING, over project units** — one grouped card, one working-day row, one tile, all equal — and is asserted by fixture **F-16** rather than assumed to follow. |
| **INV-22** | **The overlap disclosure is exact, non-negative, and bounded.** For any `GlobalFilter`: **(a)** `overlapSeconds = (M-07 binding (C) total) − M-19`, exactly; **(b)** `overlapSeconds >= 0`; **(c)** `M-19 <= ` the elapsed wall-clock span of the scope — the deduplicated figure can never exceed the time that actually passed; **(d)** `overlapSeconds = 0` whenever the scope contains at most one **project unit** — ⚠️ which since ADR-040 includes a scope containing exactly one **group**, because a group is one project (fixture F-16). (ADR-037, fixtures F-13 and F-16.) |
| **INV-23** | **Every multi-session Active-hours payload carries its overlap.** Any IPC response containing an M-07 binding (C) figure also contains its `overlapSeconds` (M-20) — the time-side twin of INV-10. It is impossible to render an aggregate Active-hours number without having its disclosure in hand. |

⚠️ **AMENDED 2026-07-22 (E4) — INV-22 is stated in seconds, and it must be *computed* in
milliseconds. Doing the subtraction after converting can produce `−1`.**

INV-21 requires the Overview tile to equal the sum of the working-day rows **exactly**, so M-07
binding (C) is `Σ floor(msᵍ / 1000)` — each group converted, then summed. M-19 is a single union
measure, so its seconds figure is `floor(unionMs / 1000)`. Both are correct, and they are not
subtractable: on sub-second residue `floor(unionMs/1000)` can exceed `Σ floor(msᵍ/1000)` by one
second even when the two projects genuinely never overlap — yielding `overlapSeconds = −1` and
breaking **INV-22(b)** on data whose true overlap is `0`. Two events one second apart in two projects
are enough.

**Resolution: the subtraction happens in the storage unit and converts once** —
`overlapSeconds = trunc((Σ msᵍ − unionMs) / 1000)`. This is the same rule ADR-023 applies to money
("SQL sums in picoUSD; the repository converts once, before the value crosses IPC"), applied to time,
and it makes non-negativity a **property of the arithmetic** — `measure(⋃ Cᵢ) ≤ Σ measure(Cᵢ)`,
elementary — rather than something enforced afterwards.

⚠️ **A `Math.max(0, …)` clamp was the obvious alternative and is explicitly rejected.** It would
produce the same `0` here while also silently absorbing a *real* sign error in M-19 — the exact
worked failure ADR-037 preserves its counterexample for. A clamp turns "this implementation is wrong"
into "this number looks fine", which is the failure mode §1.5 names as the worst possible outcome. If
`Σ msᵍ − unionMs` is ever negative, that is a bug in M-19 and it must surface, not be floored away.

Consequence to be aware of when reading INV-22(a) literally: `overlapSeconds` and
`(binding (C) seconds) − (M-19 seconds)` may differ by at most one second on residue. The identity
holds exactly in milliseconds, which is the unit the quantity is defined and computed in.

## §5.11 Bloat Radar rules (CLOSED set)

Each rule produces `bloat_flags` rows with `what · where · size · why · recommended action`.
⚠️ **Every rule's file walk excludes the backup root** (INV-14) — without this the app flags its own
safety net.

| Id | Rule | Severity | Detection | Action |
|---|---|---|---|---|
| BR-01 | Empty `CLAUDE.md` while a sibling backup has content | high | a `CLAUDE.md` of 0 B with a sibling `*.bak`/`*.plaud-bak` of > 0 B | ACT-04 or ACT-05 |
| BR-02 | Orphaned skill folders | high | a directory under `skills/` with no `SKILL.md` and 0 B of file content | ACT-01 |
| BR-03 | Installed skill never invoked | medium | `harness_nodes(kind='skill')` with M-13 invocations = 0 **over the full dataset** (INV-13) | **none in v1** — informational (§11.2) |
| BR-04 | Plugin/marketplace cached but not enabled | medium | present under `plugins/` but absent from `settings.json` `enabledPlugins` | ACT-02 |
| BR-05 | Oversized transcript storage | low | total bytes of `projects/**/*.jsonl` above a **reported**, not enforced, threshold; the flag states the size, the session count and the date range | **ACT-07** (archive) — resolved by OQ-014 |
| BR-06 | Duplicate/backup config files piling up | low | `*.bak`, `*.plaud-bak`, directories named `backups/`, all outside the backup root | ACT-03 |

BR-03 is deliberately actionless: deleting a skill because it shows zero invocations is exactly the
kind of irreversible act this app must not make easy, and the "never used" claim is only as good as
the transcript window. It is surfaced, sized and explained; the user acts outside the app.

⚠️ **AMENDED 2026-07-22 (E10) — three things this table left underspecified, resolved here.**

- **BR-01 names two actions and `bloat_flags` has one `action_type`.** The **non-destructive one
  wins the button**: BR-01 emits ACT-04 (`restore-claude-md`) with `{ relPath, backupRelPath }` and
  names ACT-05 in its `rationale`, which §6.9 renders verbatim. Restoring content the user still has
  is reversible and is itself a guarded, undoable action; deleting a file they might still want is
  the irreversible half. See the amendment note in §3.12.

- **BR-05's threshold is a named constant, reported and never enforced.**
  `BR05_REPORTED_THRESHOLD_BYTES = 500 MB` (`src/main/harness/bloat-radar.ts`). This document named
  no number, so E10 stated one. ⚠️ **Nothing is capped, pruned, trimmed or deleted at any size**
  (§1.6 non-goal 4): crossing the threshold produces an informational `low`-severity flag whose only
  action is ACT-07, which is confirmed, typed, undoable and **deletes nothing**. BR-05 also carries
  `action_payload = NULL` — ACT-07 needs an explicit session list and this rule cannot know it, so
  §6.9's *Archive…* button opens the chooser (`archives:candidates`) and the user sees every
  resolved session before a `confirmToken` is minted (§4.8).

- **BR-04's input, `settings.json` `enabledPlugins`, has no documented shape** — registered here the
  way §11.3 and §11.4 register such gaps. No verified source describes it. The implementation
  accepts the two spellings that occur in practice — an array of plugin names, and an object whose
  keys are names and whose values are booleans — and treats **anything else as "none enabled"**.
  ⚠️ **That failure direction is the point and is deliberate:** an unrecognised shape produces a
  `medium` informational flag whose action (ACT-02) is confirmed and undoable, never a silent
  deletion, and never a plugin silently reclassified as enabled and therefore invisible. The cost of
  being wrong in this direction is a flag the user dismisses; the cost of being wrong in the other
  is a cache cleared without the user being told it was in doubt.

## §5.12 Permission and conflict rules

**There is no permission model** (STACK ADR-017): one user, one machine, local files, no accounts,
no authorization dimension anywhere in the IPC contract. This is stated so no agent adds one.

Conflict resolution — where two sources could disagree, the winner is fixed:

| Conflict | Winner | Why |
|---|---|---|
| Record body `sessionId` vs the file path | **File path** (§5.4 rule 5) | A session *is* its file (OQ-005). |
| `isSidechain` vs the `subagents/` path | **Path** (`origin`) | Structural beats declared (ADR-020). |
| `stats-cache.json` vs parsed events | **Parsed events, always** | `stats-cache` is never summed into anything (ADR-029). |
| Two files containing the same `uuid` | **First ingested wins; second is ignored** | Dedup by `event_key` (ADR-019); totals are identical either way. |
| Fetched price vs a hand-edited row | **Neither overwrites** — a differing fetch closes the current row and opens a new one | History accrues; nothing is lost (§3.11). |
| Filesystem vs database, always | **Filesystem** | The files are the source of truth; the DERIVED half is a cache (§2.2). |
| ⚠️ **Archived session's file absent from `<claudeDir>`** | **Database wins — the rows stand** | The file was moved *by the app, deliberately, with an audit entry*. Absence is expected, not evidence of deletion. Applying the filesystem-wins rule here would silently erase archived history (§5.3 `ARCHIVED`, INV-18). This is the **one** place the general rule above is deliberately inverted, and it is safe precisely because the inversion is keyed on a column the app itself set. |
| Archive root unreachable (unmounted volume) | **Neither — nothing changes** | `archives.reachable` flips to 0 for display only. No row is deleted, no period is marked partial, no metric moves (§3.15). |

---

# §6 — Surfaces

`docs/source/FRONTEND.md` is **binding and carried verbatim**. The prototype
(`Claude Lens frontend prototype/Claude Lens.dc.html`) is **authoritative for the screen inventory,
sidebar nav, per-view layout, tile/chart composition, and the exact CSS custom properties**. ⚠️ Every
number in the prototype is generated by a seeded PRNG — **shapes are the contract; numbers are not.**
The prototype is a reference artifact, not a stack input: it is a React-in-template DSL, and
`support.js` is framework runtime only.

## §6.1 The token layer (one file, `src/renderer/styles/tokens.css`)

Tailwind 4 is CSS-first: **there is no `tailwind.config.js`**. FRONTEND §2's `theme.extend.colors`
note is a v3 idiom. The token **values below are binding verbatim**; only the mechanism changes —
they are declared once under `:root` / `:root[data-theme="light"]` and surfaced to Tailwind via
`@theme` (STACK ADR-004). **That single-file rule is what makes `design-token-lint` runnable: no raw
hex/rgb/hsl literal and no raw px spacing value may appear anywhere outside this file.**

```css
:root, :root[data-theme="dark"] {
  --bg-app:#0B0D12; --bg-surface:#12151C; --bg-surface-2:#1A1F2B; --border:#232936;
  --text-primary:#F2F4F8; --text-muted:#9AA4B2; --text-faint:#5B6472;
  --accent:#7C5CFF; --accent-2:#22D3EE; --accent-3:#F471B5;
  --ok:#34D399; --warn:#FBBF24; --danger:#F87171; --info:#60A5FA;
  --glow:0 0 24px rgba(124,92,255,0.45);
  --shadow:0 8px 24px rgba(0,0,0,0.4);
}
:root[data-theme="light"] {
  --bg-app:#F7F8FA; --bg-surface:#FFFFFF; --bg-surface-2:#F0F2F6; --border:#E2E6EC;
  --text-primary:#0E1116; --text-muted:#55606E; --text-faint:#8A94A3;
  --accent:#7C5CFF; --accent-2:#22D3EE; --accent-3:#F471B5;
  --ok:#34D399; --warn:#FBBF24; --danger:#F87171; --info:#60A5FA;
  --glow:0 0 24px rgba(124,92,255,0.45);
  --shadow:0 8px 24px rgba(20,30,60,0.08);
}
/* Categorical ramp — index 0..7, assigned by FNV1a32(name) mod 8 (§3.3). Order matters. */
--c1:#7C5CFF /*violet*/  --c2:#22D3EE /*cyan*/   --c3:#34D399 /*emerald*/ --c4:#60A5FA /*blue*/
--c5:#F471B5 /*pink*/    --c6:#FBBF24 /*amber*/  --c7:#FB7185 /*rose*/    --c8:#A78BFA /*lilac*/
/* Gradients */
--grad-violet-cyan: linear-gradient(135deg,#7C5CFF 0%,#22D3EE 100%);
--grad-pink-violet: linear-gradient(135deg,#F471B5 0%,#7C5CFF 100%);
/* Spacing scale (px): 4 8 12 16 24 32 48.  Radius: cards 16, controls 10, pills 999. */
/* Type scale (rem): display 2.5 / h1 2 / h2 1.5 / h3 1.25 / body 0.95 / small 0.8125 / micro 0.6875 */
```

Semantic colours (`--ok/--warn/--danger/--info`) are **reserved and kept out of the categorical
rotation**. Fonts: Inter (UI) and JetBrains Mono (ids, paths, tokens, graph labels), with
`font-variant-numeric: tabular-nums` on every number. ⚠️ **Fonts are bundled locally as woff2** — the
prototype's Google Fonts `<link>` is a remote asset fetch and would violate the single-egress rule
(§7.5, INV-15); it must not be carried over. `--glow` is used sparingly, on active and hero elements
only. Area charts: fill = series hue at 0.35 alpha → transparent, stroke = full hue, 1.5 px.
Contrast: body ≥ 4.5:1, large numbers ≥ 3:1, **in both themes, verified not eyeballed** (§8.7).

⚠️ **AMENDED 2026-07-22 (A-06) — the eight categorical hues + the four semantic colours carry
darker LIGHT-theme overrides; dark theme is unchanged.** The block above declares
`--accent-2/3`, `--ok/--warn/--danger/--info` and `--c1…--c8` **identically in both theme
blocks**, but those values were tuned against the near-black dark surfaces. The automated P-29
assertion (§8.7, `test/renderer/contrast.test.ts`) showed that in **light** theme every one of
them except violet (`--accent`/`--c1`) fell below the 3:1 mark-tier bar against `#FFFFFF` —
amber 1.67:1, cyan 1.81:1, emerald 1.92:1, `--danger` 2.77:1 — and that `--text-faint` cleared
4.5:1 in **neither** theme (best 3.25:1). The user approved the fix:

- **Light theme only** gains darker overrides of `--accent-2/3`, `--ok/--warn/--danger/--info`
  and `--c2…--c8`, each keeping its **hue family** (hue held constant; `--c8` lilac shifts 4°)
  and now clearing **≥ 3:1** on all three light surfaces. `--accent`/`--c1` (violet) already
  passed and is left as-is. **Dark theme values are byte-for-byte unchanged.**
- **`--text-faint`** is raised in **both** themes to the minimum that clears **4.5:1** on every
  surface (light `#8A94A3`→`#636E7E`, dark `#5B6472`→`#7E8898`) — it colours micro captions,
  which are small text, so legibility outranks the aesthetic of faintness. This is the one
  dark-theme value the amendment changes.
- **The stable-hue-per-series contract (§3.3) is preserved.** The categorical ramp is indexed
  by position; the index→series mapping is untouched. A series is hue #3 in both themes — #3 is
  simply rendered darker in light. Only the *rendered value per theme* changed, never the index,
  and nothing keys off the literal hex. Distinctness holds: the light ramp's closest pair is
  ΔE 27.1, matching the dark ramp's own closest pair (`--c5`/`--c7`, 27.2). This closes A-06.

**Component primitives** (FRONTEND §5, built bespoke — no component library, STACK ADR-004):
`StatTile`, `ChartCard`, `DataTable`, `GraphCanvas`, `Badge/Pill`, `Gauge`, `HeatmapCell`, plus the
three mandatory state components `EmptyState`, `LoadingState`, `ErrorState`.

## §6.2 The shell — always present

**Sidebar** (240 px, collapsible, sticky): app mark, `~/.claude` monospace subtitle showing the
configured directory's basename, the **eight** nav items in this order and with these labels —
Overview · Tokens & Cost · Sessions & Time · Tools & Agents · Graphs · Projects & Code ·
Harness Manager · Settings. Active item gets a 3 px violet→cyan bar plus a subtle glow. Footer shows
sync status (`● synced` in `--ok`) and `last parse <duration> · <dataset size>`.

**Top bar** (64 px, sticky, blurred): view title, global project filter, global date-range filter,
Refresh button (spinner + last-parsed time), theme toggle.

**Content**: 12-column grid, 24 px gutter, max-width 1480 px, centred, `overflow-y: auto`.

⚠️ **Peripheral-vision rules** (§1.3 moment 2), all testable: the window never takes focus; no push
event triggers a layout animation; number updates are in-place with no entrance animation; the
Refresh spinner is the **only** thing that moves while idle; no toast, no modal, no sound, ever
appears unbidden.

**Onboarding** is a state of the shell, not a ninth view: with `dirStatus = 'unset'`, the sidebar and
top bar render disabled and the content area shows the directory picker with the validation rule
stated ("must contain `projects/` and/or `history.jsonl`"). Choosing a valid directory transitions to
Overview and starts a full sync.

**Test hooks** (STACK ADR-018): every view root carries `data-testid="view-<id>"` and its primary
content region `data-testid="view-<id>-primary"`, with ids `overview`, `tokens`, `sessions`, `tools`,
`graphs`, `projects`, `harness`, `settings`. The shell carries `data-testid="app-shell"`; the theme
root carries `data-theme`. **The smoke suite selects on these, never on copy or styling.**

## §6.3 Overview — `view-overview`

**Hero row — four `StatTile`s** in a 4-column grid, each with a hue-gradient top border:

| Tile | Value | Sub-line |
|---|---|---|
| Output tokens | M-02 | `cost proxy · <M-03> cache reads` |
| **Cost** | M-05, in USD | the standing list-price line (below), then the M-06 uncosted disclosure or `all records costed`, then the A-05 cache-split lines when they have anything to say |
| Active hours | M-07 **binding (C)** — the sum of M-08 working-day values over the filter (ADR-036) | `idle gaps >Nm removed · summed per project-day`, **plus the M-20 overlap disclosure when non-zero** (below) |
| Tool calls | M-12 | `<distinct> distinct tools` |

⚠️ The prototype's first tile is `Sessions`; `PRD.md` "The daily loop" step 3 names the glance tiles
as **output tokens, dollar cost, active hours, tool calls**. The PRD wins — dollar cost is the newer
requirement and the glance is what the tile row exists for. The session count moves to the
Sessions & Time header, where the prototype already shows it.

⚠️ **The Active-hours overlap disclosure (M-20, ADR-037), stated exactly, since it is the tile's
second disclosure and follows the same convention as the Cost tile's:**

- **`overlapSeconds === 0` → render nothing extra.** The sub-line stays as above. Deliberately *not*
  a positive confirmation like the Cost tile's "all records costed": this is the 3-second wordless
  glance surface (§1.3 moment 3), and a reassurance nobody asked for is noise on the one screen whose
  rule is that nothing moves or accretes.
- **`overlapSeconds > 0` → append, directly beneath the number and never in a tooltip** (§6.12):
  *"N hours of this total overlap across projects."* Formatted to the same precision as the tile.
- The figure itself **never changes** — this is the uncosted-records pattern applied to time: the
  number stays as defined and the caveat travels with it (INV-23).

⚠️ **AMENDED 2026-07-22 — the Cost tile carries a STANDING list-price line, and it is the one
disclosure on this screen that does NOT follow the `overlapSeconds === 0` precedent.**

The user approved a short line, adjacent to every `$`, stating that these are **API list-price
equivalents** and that a subscription bill will differ. Their own lifetime total reads
**$17,726.65**, which without framing invites exactly one conclusion: that they spent it. M-05 is
computed against `price_rows`, which hold **published API list rates** — it is a faithful answer to
"what would this have cost on the API", and it is not a bill.

- **Copy, one muted line:** *"API list-price equivalent — a subscription bill will differ."*
- **Placement:** directly beneath the number, in normal flow, **never in a tooltip and never only
  in a footer** (§6.12).
- ⚠️ **Always rendered, in every state — including the `costNanoUsd === null` state where no `$`
  is shown at all.** It is a *standing* caveat, not a data-dependent one: unlike M-20's overlap
  line and unlike the A-05 cache-split lines below, there is no value of the data that makes it
  untrue, so there is no state in which withholding it is honest. A future edit that "completes
  the pattern" by making it conditional is a regression, and
  `test/renderer/views/list-price-disclosure.test.tsx` is what fails when it happens.
- **§6.2 is satisfied by its constancy, not by an exception to it.** The rule this screen lives
  under is that nothing moves or accretes; a line present from first paint that never changes
  cannot shift layout. A *conditional* line is the thing that would.

⚠️ **The A-05 cache-split lines (§4.6) render here too, beneath the M-06 line, and they ARE
data-dependent** — each appears only when its count is non-zero, exactly like M-20's. Two of them
matter here: the recoverable one names the remedy (*re-sync*), and ⚠️⚠️ the **archived** one
deliberately does not, because for an archived session there is none (§9.4).

Below: **Activity** calendar heatmap (26 weeks × 7, violet sequential ramp, `q:activityCalendar`),
then **Model mix over time** (stacked gradient area with interactive legend, `q:modelMixTimeline`).

| State | Presentation |
|---|---|
| Loading | Tiles render skeleton bars; charts render their frame with a shimmer. **Layout never shifts** when data arrives. |
| Empty (`READY_EMPTY`, no events) | `EmptyState`: "No transcripts found in this directory yet" + the configured path + a Refresh button. **Not zeroes.** |
| Error | `ErrorState` per card with the `AppError.message`, a Details disclosure, and Retry. One failing card never blanks the view. |
| Offline | **Identical.** Nothing on this view uses the network (§7.5). |
| Degraded | `partialBefore` set ⇒ the calendar and the timeline hatch the pre-transcript region and label it "prompts only — no transcript detail" (§6.12). Uncosted records ⇒ the Cost tile shows its disclosure. **`overlapSeconds > 0` ⇒ the Active-hours tile shows its overlap disclosure** (above). The two disclosures are independent and may appear together. |

## §6.4 Tokens & Cost — `view-tokens` — **first among equals**

Top control row: a segmented toggle **All tokens** / **Cost proxy (output only)**, with the standing
note *"Cache reads are cheap re-reads — output tokens are the honest cost signal."*

- **Left (2fr):** stacked area by model over time; title flips with the toggle
  (`Output tokens by model` / `All tokens by model`).
- **Right (1fr):** radial **cache-efficiency gauge** (M-18), gradient stroke, with the caption naming
  the two real numbers ("only X output tokens billed against Y cache reads").
- **Full width:** treemap, **output tokens by project**, tiles in project hues with labels inside.
- **Full width (new, from §1.7):** the **Cost panel** — cost by model and by project (`q:costBreakdown`),
  each row showing the **five** token classes and the dollar figure, with the M-06 disclosure
  pinned directly beneath the total, never in a tooltip.
  ⚠️ **AMENDED 2026-07-22 (A-05).** The two cache-write classes are two columns, labelled
  **`Cache write 5m`** and **`Cache write 1h`** — a single "Cache write" column beside a second one
  would be ambiguous, and a single column holding their sum would be adding two differently-priced
  quantities (M-04). The same standing **list-price line** §6.3 specifies renders here, as the
  first line of this panel's disclosure block, in every state including "no pricing configured",
  followed by the M-06 line and the A-05 cache-split lines.
- **Right rail:** the **origin split** donut (M-17) — subagent vs main-loop share of output tokens.
  This is the moment of value and it appears here as well as on Tools & Agents.

| State | Presentation |
|---|---|
| Loading | Skeletons per card; the toggle is interactive immediately and re-queries on change. |
| Empty | Per-card `EmptyState` naming what is missing ("no assistant events in this range"). |
| Error | Per card. |
| Offline | Identical. |
| **Degraded — the important one** | If `UncostedSummary.records > 0`, the Cost panel renders the figure **with** the disclosure line and a link to Settings → Pricing. If **no** price row covers **any** record, the panel renders *"No pricing configured — showing tokens only"* and **shows no `$` at all.** ⚠️ It never shows `$0.00`. |

## §6.5 Sessions & Time — `view-sessions`

Header carries the session count ("N sessions · click a row to inspect"). Then, per the prototype:
a two-up row of **Session length distribution** (histogram by active time, **M-07 binding (A)** — one
bucket per session) and **Rhythm**
(hour × weekday heatmap, cyan sequential); then **Longest marathons** — the **working day**
leaderboard (M-08), rank · date · project · gradient bar · active · span, subtitled *"ranked by
active time (idle gaps >Nm removed)"* — ⚠️ these rows are **working days** (M-07 binding **(B)**), not
sessions, and the card subtitle says so; then the **Sessions** table (binding **(A)** throughout,
including the `Active` column and its sort): Session · Project · Model ·
Msgs · Output · Active · Span, sortable, sticky header, row click → drill-down.

**Session drill-down** is a right-hand drawer (not a route): identity, project, model, branch, CLI
version, span vs active, the five token classes (A-05), cost with disclosure, the origin split, the tool
histogram, and the list of subagent runs with `linked` shown honestly. ⚠️ **No message content
anywhere** (§1.6 non-goal 1).

⚠️ **AMENDED 2026-07-24 — the drawer's cost carries the FULL disclosure block §6.3 specifies, not
just the completeness line.** This was a spec gap and it shipped as a defect: §6.12 binds the
standing list-price caveat to every `$`, but §6.3 and §6.4 were the only sections that said so, so
this drawer rendered a bold dollar figure captioned only *"all records costed"* — which reads as an
assertion that the figure is a complete and correct bill. The block, in order: the **standing
list-price line** (always, in every state including `costNanoUsd === null`, where the figure is `—`
and there is no `$`), then the M-06 uncosted line or *"all records costed"*, then the A-05
cache-split lines when they have anything to say.

| State | Presentation |
|---|---|
| Loading | Table renders 8 skeleton rows at final row height. |
| Empty | "No sessions in this range" + a control to clear the global filter. |
| Error | Per card; the table keeps the last good page and shows a retry strip. |
| Offline | Identical. |
| Degraded | Sessions with `isPartial` carry a `Badge` reading "partial" with a tooltip explaining that prompts exist but the transcript does not. Marathon rows whose day precedes `partialBefore` are hatched. **Archived sessions carry a neutral "archived" `Badge`** naming the archive root — neutral, not a warning, because their numbers are complete and unchanged (INV-18). |

## §6.6 Tools & Agents — `view-tools`

- **Left (1.4fr):** **Tool fingerprint** — horizontal gradient bars per tool, subtitled with total
  calls and distinct tool count. Label reminds that `Agent` and `Skill` are tools (§2.1).
- **Right (1fr):** **Main-loop vs subagents** — the M-17 donut with both percentages, the absolute
  subagent output-token figure in the centre, and the message/tool-call counts beneath.
- **Full width:** **Tool mix per project** — small multiples, one stacked pill per project.

| State | Presentation |
|---|---|
| Loading | Bars animate from zero width once, on first load only. |
| Empty | "No tool calls in this range." |
| Error | Per card. |
| Offline | Identical. |
| Degraded | If `unlinkedSubagentRuns > 0`, the donut card footnotes *"N subagent runs could not be linked to a spawn point — totals are unaffected."* ⚠️ Totals genuinely are unaffected (§3.7), and saying so is part of the disclosure. |

## §6.7 Graphs & Harness Flow — `view-graphs`

One shell, **four tabs**, exactly as the prototype: **Harness Map · Execution Trace · Tool Transition
· Flow Sankey**. No fifth graph (OQ-101 closed). The shell is: a tab pill row; a full-bleed canvas
with zoom +/− controls top-left and a filter-chip legend bottom-left; and a fixed 300 px **inspector**
rail on the right (label · kind · key/value rows · explanatory note).

| Tab | Renders | Library (STACK ADR-011) |
|---|---|---|
| Harness Map | `q:harnessGraph` — orchestrator (filled + glow) / worker skill (outlined) / tool (pill) / file (dashed rect); **edge thickness ∝ `observed`**, dashed where `designed && observed === 0`, and highlighted where `!designed && observed > 0` | `@xyflow/react` |
| Execution Trace | `q:executionTrace` for one selected session — spawn tree main-loop → subagent runs → tool calls, plus a timeline band per span | `@xyflow/react` + custom timeline |
| Tool Transition | `q:toolTransition` — Markov graph over consecutive tool calls within a session, deterministic layout | `cytoscape` |
| Flow Sankey | `q:flowSankey` — project → model → skill/tool, band width ∝ output tokens | `d3-sankey` layout, our own SVG |

Interactions on all four: pan, zoom, click-node-to-inspect, and the global project/date filter.
The inspector is where a **prompt preview** may appear (≤280 chars, §3.9) — the only place in the app
that shows any prompt text.

| State | Presentation |
|---|---|
| Loading | Canvas shows a centred spinner with the node/edge count once known. |
| Empty | Per tab: Harness Map "no skills or agents found under this directory"; Execution Trace "select a session"; Tool Transition "fewer than two consecutive tool calls in range"; Sankey "no costed or counted flows in range". |
| Error | `ErrorState` fills the canvas; the tab row stays usable. |
| Offline | Identical. |
| Degraded | Execution Trace shows unlinked runs as **detached** nodes in a clearly-labelled "unlinked" lane rather than guessing a parent (§3.7). Harness Map legend distinguishes designed-only, observed-only and both. |

## §6.8 Projects & Code — `view-projects`

A 3-column grid of project cards, each: hue top-bar and dot, name, then a 2×2 of Sessions · Output ·
Tool calls · Active (⚠️ **M-07 binding (C)** — the sum of that project's working-day values over the
filter, so a project card and the leaderboard agree, INV-21. ⚠️ **No overlap disclosure here, and this
is provable rather than assumed:** binding (C) restricted to one project has exactly one partition per
local day, and distinct days' covered intervals cannot intersect, so M-20 is identically `0` for a
single-project scope — INV-22(d). The disclosure would always read "0 hours" and is therefore
omitted), then a **files-touched** sparkline (12 buckets of **edit counts**, M-15).
Clicking a card opens the **file metrics** panel: files touched, edit count per file, and the
language mix. ⚠️ **Labelled "edits", never "lines changed"; no diff is rendered anywhere**
(§1.6 non-goal 3).

⚠️ **AMENDED 2026-07-22 (ADR-040) — this is where the user says two folders are the same project.**

Each card carries a **real checkbox** (selection is a tick, never a background tint — FRONTEND §8).
Tick two or more and a bar appears offering **"These are the same project"**; the user types a name
and saves. From then on those folders are one **project unit** (§2.1) and count as one project
everywhere — one card here, one slice in the treemap, one row in the leaderboard, one entry in the
project filter, one project column in the sessions table.

⚠️ **The bar never appears on its own initiative and never proposes a pairing.** §2.1's
zero-inference rule is unchanged: there is no "these look similar", no candidates list and no name
matching anywhere on this screen. The user ticks the cards.

A grouped card shows its name, the hue derived from that name, and **"N folders"** where a lone
project shows its encoded name (a group is not a directory and has no folder name of its own —
`ProjectCard.encodedName` is `null`, never `""`). Under the badge, in plain words:
*"You said these N folders are the same project. Open the card to see them."*

Opening a grouped card adds a **Folders** panel above the file metrics: one row per folder with its
own sessions, output, tool calls and active time — *"Each folder's own numbers, as if you had never
said they were the same project."* ⚠️ **The panel must state, in plain words and beside the numbers,
that the folders' active times do not add up to the card's**, and why:

> *"These folder times do not add up to the 55m on the card, and that is correct. Now that the
> folders are one project, time spent moving between them on the same day counts as time on that
> project instead of being dropped at each folder's edge."*

That sentence is **not optional** (§1a). A reader who adds the column and compares gets a different
number, and two columns that look like they should add up and do not are a defect of the same
family as a wrong number.

⚠️ **The Active figure on a grouped card is M-07 binding (C) over the UNIT** — the grouping is
applied where the partition is formed, not by adding the members' figures (ADR-040 Trap 2, fixture
F-16). The member column is the `folders` half of `byWorkingDayViews()`, which has exactly this one
caller and is never a surface's headline number.

⚠️ The overlap disclosure stays absent, and the proof is unchanged and now stronger: binding (C)
restricted to one **unit** has exactly one partition per local day, so M-20 is identically `0`
(INV-22(d)) — for a group exactly as for a lone project.

⚠️ **AMENDED 2026-07-24 — the card's `$` is labelled and captioned, like every other money
surface.** Another spec gap that shipped as a defect: the card rendered a bare `formatCost(...)`
under the sparkline, with **no label at all**, among four labelled siblings. A number with no
answer to "what is this" is §1a's failure, and an unframed dollar figure is §6.3's.

- The figure takes the **same `<dt>/<dd>` label its siblings take**, reading **`Cost`**, and is
  rendered in **every** state — `—` when nothing is costed (§6.4: no `$` at all, never `$0.00`), so
  the card cannot change height as data arrives.
- Beneath it, in the same caption slot the Active metric uses for its idle-gap note, the
  **standing list-price line** §6.3 specifies, verbatim.
- ⚠️ **Only that line, not the full block** — and the reason is stated so it is not "completed"
  later. The block runs to three-to-five lines; repeated down a 3-column grid of cards it would be
  more caveat than card, and §6.8's loading row promises skeleton cards at final height. The
  standing line is the only unconditionally-true one, so it is the only one that must be on every
  card. The data-dependent lines are **not** dropped: the M-06 uncosted line renders once beneath
  the grid (INV-10, already specified), and the full block renders in the project-detail drawer
  that a card click opens — one click, and no screen, away.

⚠️ **The rule §6.12 states — a disclosure adjacent to every `$` — is enumerated and tested in
`test/renderer/views/list-price-disclosure.test.tsx`, which names all five money surfaces**
(§6.3 tile, §6.4 panel, §6.5 session drawer, §6.8 card, §6.8 project-detail drawer). That suite
previously imported two views and therefore defended two views, which is how three surfaces
drifted. A sixth money surface added without its caveat fails there.

| State | Presentation |
|---|---|
| Loading | Skeleton cards at final height. |
| Empty | "No projects found under `projects/`." |
| Error | Per card. A failed `groups:create` is stated **on the bar where the action was taken**, in the main process's own words, and the user's selection is kept — never silently cleared. |
| Offline | Identical. Grouping is a local database write and needs no network. |
| Degraded | A project with events but zero file touches shows "no file edits recorded in this range" rather than an empty sparkline. Ticking a project that is already in a group and saving is refused with "Some of those projects are already part of another group. Split that group first." |

## §6.9 Harness Manager — `view-harness`

⚠️ **This view ignores the global filter entirely** (INV-13) and says so: every count is badged
"all time". A skill deleted because it looked unused this month is exactly the irreversible mistake
this rule prevents.

- **Bloat Radar** — a header badge (`N issues · X reclaimable`) and a 2-column grid of flag cards:
  severity pill, title, monospace location, size, rationale, and **either** an action button **or**
  the muted label "no automatic action in v1" (BR-03, BR-05). Severity is paired with text, never
  colour alone (FRONTEND §8).
- **Skills** — table: Skill · Source · Invocations · Last used · Size, sorted by installed-but-never-used,
  with a `--danger`-tinted count chip for zero.
- **CLAUDE.md inspector** — every `CLAUDE.md` with size, mtime and its sibling backups; the empty-file-
  with-non-empty-backup case is the headline row (BR-01).
- **Plugins & marketplaces** — enabled vs merely cached, with disk cost each.
- **Memory browser** — every `MEMORY.md`, its project, size, entry count and staleness.

**Confirm dialog** (`data-testid="confirm-dialog"`): states the action, lists **every** target with
its size, states that a restore point will be written first and where, and requires either a plain
confirm or the exact typed phrase (§5.5 rule 3). Cancel is the default focus.

| State | Presentation |
|---|---|
| Loading | Skeleton cards; the scan runs in the main process and reports progress. |
| Empty | "No issues found" — a genuine, celebratory empty state, not an error. |
| Error | Per panel. A failed harness scan never blocks the analytics views. |
| Offline | Identical. |
| Degraded | If a flag's targets have disappeared since the scan, the action button is disabled with "targets changed — rescan" rather than executing against a stale list (INV-06). BR-05's **Archive…** button is disabled with "Choose an archive location in Settings" when `archiveRoot` is unset. |

**BR-05's archive flow** (ACT-07): the button opens a chooser — "sessions last active before
&lt;date&gt;", optionally scoped by project — which calls `archives:candidates` and lists **every**
resolved session with its size before anything is minted. The confirm dialog states plainly, in the
user's own terms: *"These transcripts move to &lt;archiveRoot&gt;. Every chart keeps counting them.
Nothing is deleted, and this is undoable."* Typed confirmation is required (§5.5 rule 3).

## §6.10 Settings — `view-settings`

Max-width 720 px, stacked cards, per the prototype plus the §1.7 additions:

1. **Claude data directory** — current path (monospace), *Choose folder…*, and a live validation line
   ("Valid — N transcript files detected" in `--ok`, or the specific failure). Changing it warns that
   the derived cache will be rebuilt and that **price history, settings and the audit trail are kept**.
2. **Idle-gap threshold** — slider 5–60, step 5, showing the current value; note: "Gaps longer than
   this are removed from active time." ⚠️ Plus, explicitly: "This does not change session boundaries."
3. **Theme** — System / Dark / Light.
4. **Re-sync data** — incremental refresh with the last-sync time and duration.
4a. **Read your transcripts again from the start** *(new 2026-07-24, A-16)* — the `sync:rebuild`
   control (§4.4): throw away everything derived and re-parse every transcript from line 1, so a
   record ingested before the app learned to notice something gets noticed. Sits beside the
   incremental *Re-sync* it is the heavy opposite of; **not a ninth nav item** (§6.2 locks eight).
   ⚠️ **Explicit and two-step** — the button opens a confirm ("Read every transcript again from the
   beginning? Nothing in your Claude data directory is changed or deleted."), never one click
   (ADR-032). While it runs it shows **plain-words** progress (never a phase name — §1a) and a
   **Stop**; anything already re-read stays read (§5.2 rules 3–4). The card, in plain words (§1a):
   what it does, what is **kept** (price table, settings, archives, the audit trail, project
   groups — none come from transcripts), and — in its own paragraph, never a footnote — **what it
   can never reach**: archived and vanished transcripts are never re-read, so whatever the app did
   not record for them the first time stays unknown, and this cannot bring it back. A refusal
   states plainly that nothing was cleared and nothing started.
5. **Pricing** *(new)* — the price table: model · token class · USD per 1M · effective from · to ·
   source. Every row editable; effective dates editable; add/delete row; **Reset to bundled seed**.
   Above it, the models-observed list (`pricing:models`) with unpriced models called out. Below it,
   the **price-fetch URL** field and a **Refresh prices** button, with the standing note that this is
   the **only** network request the application ever makes and that the app works fully without it.

   ⚠️ **The URL field ships empty and the button stays disabled until the user fills it** (§11.3,
   closed). Recorded rationale, which the help text states in one line: **no third-party trust is
   baked into a published repo — the user opts into a dependency rather than inheriting one.** The
   guaranteed-correct path is always the bundled seed plus manual editing.

   Beneath the field, static help text offers a verified starting point the user may paste:

   > *A community-maintained option, verified 2026-07-20 to exist and to carry the four ORIGINAL
   > token classes (⚠️ A-05's fifth, `cache_write_1h`, is required like the rest, and a document
   > without it is rejected by name rather than having its 1-hour rate guessed at):* `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
   > *(LiteLLM's `model_prices_and_context_window.json`). It uses its own field names —
   > `input_cost_per_token`, `output_cost_per_token`, `cache_creation_input_token_cost`,
   > `cache_read_input_token_cost`, all in USD per token — and **carries no effective dates**, so
   > Claude Lens dates any change it applies at the moment you fetch. Adapting that shape to the
   > document format Claude Lens expects (§4.7) is a separate, opt-in step.*

   ⚠️ **This is help text, not a default.** Nothing is fetched, and no adapter for that shape ships in
   v1 (§11.3) — a raw fetch of it fails cleanly with `E_FETCH_SHAPE`, leaving the price table intact.

5a. **Projects you have said are the same** *(new 2026-07-22, ADR-040)* — the management half of
   grouping; the action itself lives on §6.8, where the cards are. Placed here, with pricing and
   archives, because it is one of the things the **user decided** rather than something observed.
   ⚠️ **No ninth navigation item** — the user rejected one explicitly.

   The card lists every group: its name and hue, how many folders it holds, **Rename**, **Split
   apart**, and the folders themselves by encoded name. ⚠️ A folder that is **not currently
   present** — the state between a purge and the sync that follows it, and what an unmounted drive
   looks like — is shown as *"not currently present — nothing has been lost"* and is **never
   removed on the app's own initiative** (§3.19).

   Standing copy, in plain words (§1a): *"When you move a project to a new folder, Claude Code sees
   two projects. Tell Claude Lens they are the same one on the Projects & Code screen, and they
   count as one project everywhere. Nothing on disk changes, and you can split them apart again
   here."* And beneath: *"Splitting a group apart puts every number back exactly as it was. Claude
   Lens never decides on its own that two folders are the same project — you do."*

   ⚠️ **"Split apart", never "Delete".** Nothing underneath is removed, and the button must not
   claim otherwise. ⚠️ **Nothing on this card suggests a grouping** and nothing behind any button
   on it may (§2.1).

6. **Backups & audit** *(new)* — restore-point count and total size, the audit trail (paged, newest
   first, each entry showing action, targets, bytes, restore point and undo state), an **Undo last
   action** control, and an explicit **Clear backups** button that goes through the standard
   confirm-and-audit flow with typed confirmation (ACT-06).
7. **Archive** *(new, from OQ-014)* — the **archive root** picker (validated per INV-19, with the
   reason shown on rejection), and the permanent list of archives (`archives:list`): date, absolute
   path in monospace and selectable, session count, date range, bytes moved, and a reachability
   badge. ⚠️ **This list is the answer to "where did my transcripts go?" and is never pruned.** An
   unreachable archive shows a muted "not currently reachable" badge and an explicit reassurance that
   **its data is still fully counted** — because it is (§3.15).

| State | Presentation |
|---|---|
| Loading | Fields render disabled with skeleton values. |
| Empty | Pricing with no rows: "No price rows — load the bundled seed or add one." Audit with no entries: "No guarded actions have been taken." Grouped projects with none: "You have not said that any projects are the same. To do that, tick two or more projects on the Projects & Code screen." ⚠️ Never a list of proposals. |
| Error | Inline under the field that failed, using the specific `ErrorCode` message (e.g. `E_PRICE_OVERLAP` → "That date range overlaps an existing row for this model and class."). |
| **Offline** | **The only place offline is visible.** *Refresh prices* fails with `E_FETCH_NETWORK`, shows a non-blocking inline error, and **leaves the price table completely intact**. Every other control works — including archiving, which is a purely local file move. |
| Degraded | `priceFetchUrl` empty ⇒ the Refresh button is disabled with "Set a price-table URL to enable fetching", with the help text above. `archiveRoot` unset ⇒ the archive action is unavailable everywhere with "Choose an archive location in Settings". An archive root that is unreachable ⇒ shown, never hidden, and never treated as data loss. |

## §6.11 Blocking surfaces

`FATAL` (§5.1) replaces the whole content area: what failed, the schema version, and two explicit
choices — **Rebuild derived data** (purges DERIVED only, §3.17) and **Show my price rows** (so the
user can copy them out before doing anything). ⚠️ **There is no "reset the database" button**, because
that path would take `price_rows` and `audit_log` with it (ADR-026).

## §6.12 Cross-view state rules

- **Loading, empty, error and offline are specified for every view above.** A view that renders zero
  where it does not know is a defect, not a style choice.
- **Partial-data treatment**, used identically everywhere: diagonal hatching over the affected chart
  region, a muted caption naming the boundary date, and the value suppressed rather than zeroed.
- **Disclosures render adjacent to the number they qualify**, never in a tooltip and never only in a
  footer (INV-10).
- ⚠️ **AMENDED 2026-07-22 — a disclosure is either DATA-DEPENDENT or STANDING, and the two have
  opposite render-at-zero rules.** Both kinds obey the adjacency rule above; they differ only in
  when they appear.
  **Data-dependent** — M-06 uncosted records, M-20 cross-project overlap, A-05's cache-split
  counts, M-16's partial-data caption: each renders only when it has something to say. §6.3's
  reasoning governs: on the 3-second glance surface "a reassurance nobody asked for is noise."
  **Standing** — the list-price caveat on every `$` figure (§6.3, §6.4, §6.5, §6.8 — ⚠️ *every*
  one of the five money surfaces, enumerated in §6.8 and asserted surface-by-surface in
  `test/renderer/views/list-price-disclosure.test.tsx`): true of the number in
  every state, under every filter, so it renders in **every** state, including the states where
  the number itself is absent. ⚠️ A standing caveat must **not** be given the data-dependent rule
  "for consistency": there is no data that makes it untrue, so there is no state in which
  withholding it is honest. A standing caveat is also the only kind that cannot disturb layout,
  because it never appears or disappears.
- **Motion** (FRONTEND §7): view transition 200 ms fade + 8 px slide; chart entrance 400–600 ms
  ease-out with ~40 ms series stagger; hover 120 ms; drawer 240 ms.
  ⚠️ Entrance animations run on **first mount only** — a live data update never re-animates a chart
  (§1.3 moment 2). `prefers-reduced-motion: reduce` disables all non-essential animation, overridable
  by `reduceMotionOverride`.
- **Accessibility** (FRONTEND §8): WCAG AA contrast in both themes, focus-visible rings on every
  interactive element, full keyboard navigation for the sidebar, tables and graph node selection,
  `aria-label` on every icon button, and **meaning never carried by colour alone** — severity, model
  and series identity always pair colour with text or shape.

---

# §7 — Cross-cutting

## §7.1 Authentication and authorization

**Not applicable: single user, single machine, local files, no accounts, no tenancy** (STACK ADR-017).
There is no auth dimension anywhere in the IPC contract, no permission model, no session management.
Stated explicitly so no later agent adds one.

## §7.2 Process topology

Three processes and one worker thread, no more:

| Process | Owns |
|---|---|
| **Main** (Node) | Filesystem, SQLite, the watcher, guarded actions, pricing, the parse worker's lifecycle, every IPC handler |
| **Preload** | The `contextBridge` surface only — the typed channel map and nothing else |
| **Renderer** (Chromium) | React 19, Zustand, React Router, all five chart/graph libraries. **Touches no filesystem, no database, no network** (INV-16) |
| **Parse worker** (`worker_threads`, owned by main) | Streaming `node:readline` ingest, its own SQLite handle. Worker↔main messages are structured-clone only |

`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`. **No server, no port, no
localhost listener** (STACK ADR-003) — which is also what makes the single-egress rule mechanically
checkable: with no listener, every socket in the app is an outbound one.

## §7.3 Error handling and logging

One `withResult()` wrapper around every handler (§4.1). Main-process logs go to
`app.getPath('logs')/claude-lens.log`, rotated at 5 MB × 3 files, containing timestamps, error codes
and stack traces. ⚠️ **Logs never contain prompt text, file contents, or the absolute Claude data
directory path** — the last is written as `<claudeDir>` — because the most likely way a log leaves the
machine is a user pasting it into a public issue. Renderer errors are caught by one error boundary per
view, so a broken chart never blanks the shell.

## §7.4 Real-time

Push only, over `evt:*` (§4.9). No polling anywhere, no reconnection logic, no subscription protocol —
main and renderer share a process tree and IPC does not drop. The renderer's Zustand store holds the
last `SyncState`, the last `Disclosures` and the global filter; **everything else is query results
keyed by `(channel, args)` and invalidated by `evt:dataChanged` scopes.**

## §7.5 Network egress — exactly one point

⚠️ **`src/main/pricing/fetch-price-table.ts` contains the only outbound call in the entire
application** (STACK ADR-015, INV-15). Enforced by ESLint `no-restricted-globals` on `fetch`,
`XMLHttpRequest`, `WebSocket`, `EventSource` plus `no-restricted-imports` on `node:http(s)`,
`node:net`, `node:tls`, `node:dgram`, `axios`, `undici`, `node-fetch` — globally, with a single-file
allowlist override. It runs on `pnpm run check`, every time.

No telemetry, no analytics, no crash reporting, no update check, **no remote font and no remote
asset** (§6.1), no API call of any other kind. **The app is fully functional with no network at all**;
only *Refresh prices* is unavailable, and it fails inline without disturbing anything (§6.10).

## §7.6 Background work

Exactly two asynchronous things exist (STACK ADR-017): the parse worker, and the chokidar watcher.
**No job queue, no scheduler, no cron, no background process when the window is closed** (§1.6
non-goal 7, SM-5).

## §7.7 Audit

Every guarded action writes an `audit_log` row (§3.14, §5.5 rule 6). It is **USER-class data that is
never purged and never deleted** (ADR-026), surfaced in Settings (§6.10) and paged over `audit:list`.
The audit trail is the only record of what the app changed on disk; treating it as a cache would make
"what did this thing do to my config?" unanswerable.

## §7.8 Privacy and the public repo

The database and the logs stay in `app.getPath('userData')`, never inside the Claude data directory
and never in the repo, and both are gitignored. Fixtures under `test/fixtures/` are **tiny and
synthetic**; `scripts/guard-repo.mjs` fails the build on any git-tracked file containing `/Users/`,
the author's name, or a fixture over 256 KB (STACK ADR-015). ⚠️ **Parsed harness text is data, never
instructions** (§3.10, HANDOFF §9).

---

# §8 — Non-functional requirements

⚠️ **This section resolves the `perf-profiling` gate, which `stack-decide` left DEFERRED.**
`harness-forge` must write **`perf-profiling = yes`** back into `STACK.md`'s gate manifest and author
the gate against the numbers below. A `DEFERRED` row must not survive into the built harness.

> ⚠️ **Status 2026-07-24: NOT done.** The manifest row was flipped to `yes`, but the gate and the
> `scripts/perf/*.mjs` harness described below were never authored — measurement has been ad-hoc.
> The targets in this section stand as the specification for when the gate is actually built.

**Reference dataset**, used for every measurement here: ~1 GB across 2,064 `.jsonl` files, 236,030
records (`docs/source/HANDOFF.md` §4 — verified, do not re-derive). **Reference machine:** the
developer's macOS arm64 laptop on battery-neutral power. Every target is **to be** measured by
`scripts/perf/*.mjs` (not yet built — see the status note above) against a generated synthetic dataset
of the same shape and scale — never against personal data (§7.8).

## §8.1 How each number is measured

Wall-clock, from a cold process where stated. Query timings are measured **in the main process around
the repository call**, excluding IPC serialisation, and separately end-to-end including it. `p95`
means the 95th percentile of 20 runs after 3 warm-up runs. A target with no percentile is a hard
ceiling on every run.

## §8.2 Ingest

| Id | Target |
|---|---|
| P-01 | **Cold full parse ≤ 30 s hard ceiling, ≤ 10 s target (p50)** over the reference dataset, in the worker thread, with the window responsive throughout. |
| P-02 | **Incremental sync with nothing changed ≤ 500 ms** (p95) — the once-a-day launch path (§1.3 moment 1). |
| P-03 | **Append fast-path: ≤ 250 ms** (p95) of work for a single file grown by ≤ 100 lines, measured from cycle start to `evt:dataChanged`. |
| P-04 | **End-to-end append latency ≤ 1,000 ms** (p95) from the filesystem write to the number changing on screen — 500 ms debounce plus P-03 plus render. |
| P-05 | **Parse worker RSS ≤ 512 MB peak** during P-01. Streaming means no file is ever fully resident (STACK ADR-009). |
| P-06 | **Database size ≤ 250 MB** for the reference dataset, including indexes. |
| P-07 | **Zero records lost or duplicated** at any scale — INV-03/INV-04. Not a perf target but measured in the same run, because a fast parser that drops rows is the failure this project fears most. |

## §8.3 Query — and the DuckDB trigger

| Id | Target |
|---|---|
| P-08 | ⚠️ **Every repository method backing a view returns in ≤ 200 ms (p95) on the full dataset.** This is the numeric trigger from OQ-102/STACK ADR-005: **exceeding it reopens the DuckDB question.** It is a condition to measure against, not a promise to switch — STACK ADR-008's seam is what makes measure-then-decide cheap. |
| P-09 | The **cost query** (M-05, the bi-temporal five-class join over the full dataset — four until A-05) ≤ 200 ms (p95). Called out separately because it is the most expensive query in the app and the most likely to fire P-08. |
| P-10 | `q:sessions` first page ≤ 100 ms (p95); any paged query ≤ 100 ms (p95) per page. |
| P-11 | End-to-end IPC round trip for any `q:*` ≤ 250 ms (p95), including serialisation. |
| P-12 | The full harness scan (skills, plugins, `CLAUDE.md`, memories, disk sizes, Bloat Radar) ≤ 3 s. |

## §8.4 Steady state — the nine-hour window

These exist because the common path is "already open for nine hours" (§1.3 moment 2), and a watcher
that leaks or spins is a **product defect, not a performance nit**.

| Id | Target |
|---|---|
| P-13 | **Mean CPU < 0.5%** across main + renderer + GPU over a 60-minute idle window with the watcher active, sampled at 1 Hz. **No single sample above 5%** absent a real filesystem event. |
| P-14 | **Main-process RSS growth < 50 MB over 9 hours** idle-but-live, with a synthetic append rate of ~500 events/hour. Measured as `RSS(t=9h) − RSS(t=1h)`, so warm-up is excluded. |
| P-15 | **Renderer JS heap growth < 50 MB over the same 9 hours**, with no monotonic growth trend in the last 4 hours. Detached-DOM-node count must not grow across 100 view switches. |
| P-16 | **Watcher file descriptors ≤ 64**, regardless of tree size — one recursive watch, not a per-file fleet (STACK ADR-010). |
| P-17 | **No timer fires more often than 1 Hz while idle.** The 500 ms debounce timer exists only between a filesystem event and its sync. |
| P-18 | **Zero unbounded growth in the database from idling.** Nine idle hours with no filesystem change writes zero rows. |

## §8.5 Interaction

| Id | Target |
|---|---|
| P-19 | **Cold launch to Overview first meaningful paint ≤ 1,500 ms** with a populated database (excludes P-02, which runs after paint). |
| P-20 | **View switch ≤ 150 ms (p95)** to first paint with cached data; ≤ 400 ms (p95) including a fresh query. |
| P-21 | **No renderer main-thread task exceeds 50 ms** during a sync. The UI never blocks (HANDOFF §2.4). |
| P-22 | **Sync progress emits at most 4 Hz** (§4.9) — enough to look alive, slow enough not to thrash a peripheral-vision window. |
| P-23 | **Graph canvases stay interactive at 30 fps** during pan/zoom with the largest real graph (~33 tool nodes, ~2,000 subagent runs in a trace, capped at 500 rendered nodes with an explicit "showing top 500" label). |
| P-24 | **Confirm dialog appears ≤ 100 ms** after the action button; `action:preview` resolves ≤ 500 ms for ≤ 1,000 targets. |
| P-25 | **Backup of ≤ 100 MB of targets completes ≤ 5 s**, with progress. |
| P-26 | **Price fetch: 10 s timeout, one attempt, no retry** (§5.8). |
| P-36 | **ACT-07 archives ≥ 200 MB of transcripts in ≤ 20 s** on the same volume, with progress, and its **database work is ≤ 200 ms** — archiving only annotates `file_manifest` and `sessions`, so the row count touched is O(files), not O(events) (§5.7). A cross-volume move degrades to copy-then-delete and is budgeted at disk speed, with the copy verified before the source is removed. |
| P-37 | **Post-archive sync ≤ P-02** (500 ms with nothing else changed): archived manifest entries are stat-only and are never re-parsed (§5.3 `ARCHIVED`). |

## §8.6 Payload limits

| Id | Target |
|---|---|
| P-27 | **No IPC response exceeds 2 MB.** A handler that would exceed it pages instead (§4.2). |
| P-28 | **The renderer never holds more than 5,000 rows of any single result set**, and never the full dataset (HANDOFF §2.4). Session detail is fetched on demand. |

## §8.7 Accessibility, security, privacy

| Id | Target |
|---|---|
| P-29 | **WCAG AA in both themes, verified not eyeballed**: body text ≥ 4.5:1, large numbers ≥ 3:1. An automated contrast assertion runs over every token pair in `tokens.css` as part of the test suite. ⚠️ **AMENDED 2026-07-22 (A-06):** the assertion found the design's own binding hues failed in **light** theme (every accent/semantic/categorical hue but violet below 3:1) and `--text-faint` failed 4.5:1 in **both** themes. Fixed by darker **light-theme-only** overrides of the hues and a raised `--text-faint` in both themes — see §6.1's AMENDED block. Dark theme hues unchanged; the stable-hue-per-series contract is preserved (only the rendered value changes per theme, not the index). The test now **asserts the targets and fails on any regression** — the earlier `KNOWN_BELOW_BAR` pin table is removed. |
| P-30 | Full keyboard navigation of sidebar, tables and graph selection; visible focus rings on every interactive element; `aria-label` on every icon button. |
| P-31 | `prefers-reduced-motion: reduce` disables all non-essential animation (FRONTEND §7). |
| P-32 | **Exactly one network egress point**, proven by `pnpm run lint` on every run (INV-15). |
| P-33 | **Zero personal paths or personal data in any git-tracked file**, proven by `pnpm run guard` on every run. |
| P-34 | **The real `~/.claude` is unreachable from any test**, by three independent mechanisms (STACK ADR-013/018). This app deletes files; this is a safety property, not a preference. |
| P-35 | `pnpm audit --omit=dev` reports no unresolved high or critical advisory in runtime dependencies (`dependency-security-audit`, outside `check` because it needs network). |

---

# §9 — Infrastructure

## §9.1 Environments

**One: the developer's machine.** There is no staging, no production, no CI, no container, no
orchestration (STACK ADR-016). `pnpm run dev` is development; `pnpm run build` produces bundles that
`pnpm run e2e` drives; nothing is deployed anywhere.

## §9.2 Distribution — there is no deploy target

Clone, `pnpm install`, `pnpm run dev`. No `electron-builder`, no `electron-forge`, no packaging
dependency installed at all, no signing, no notarization, no `.dmg`, no auto-update, no store, no
release binary (STACK ADR-016).

⚠️ **AMENDED 2026-07-22 (ADR-038) — there is now a double-clickable app, and every sentence above
is still true.** `pnpm run launcher` generates **`Claude Lens.app`**: an `Info.plist`, a ~70 KB
executable and an `.icns`, which resolves this repository at run time and starts *its* Electron
binary against *its* `out/`. It adds **no dependency** — a `.app` is a directory, and `sips`,
`iconutil` and `codesign` ship with macOS. ⚠️ **Amended again the same day:** that executable is a
**compiled Mach-O** built from the committed `resources/launcher.c`, and the bundle is **ad-hoc
signed** (`codesign -s -`), because macOS TCC attributes file access to an executable's *code
identity* and a `#!/bin/bash` bundle has none — see ADR-038. No certificate and no Apple Developer
account are involved; with no C compiler present it falls back to the shell script and warns. It
is a **build output**: gitignored, never committed, because it
records an absolute path to the checkout and P-33 fails the build on exactly that. It is **not a
distribution artifact** and the distribution story is unchanged: clone, `pnpm install`,
`pnpm run dev`. `--install` copies it into `/Applications` and is never what a bare invocation does.
`pnpm run launcher` is **outside `pnpm run check`** for STACK ADR-018's reason; its tests are inside.
⚠️ ADR-016's *"$99/yr Apple Developer Program prerequisite"* applies to shipping to **other
people**, not to this — see ADR-038 for what was verified.

The **release act** is publishing source that strangers `pnpm install`, so `release-runbook` verifies
exactly that: a **cold clone on a machine with no prior state** runs `pnpm install && pnpm run check` green —
which is where STACK ADR-006's dual-ABI native install is most likely to fail and is this project's
only real release risk — **plus one `pnpm run e2e` run**, because a cold clone that type-checks but
whose window does not open is not a release.

## §9.3 File locations

| What | Where | Committed? |
|---|---|---|
| Database | `app.getPath('userData')/claude-lens.db` (+ `-wal`, `-shm`) | Never. Gitignored. |
| Logs | `app.getPath('logs')/claude-lens.log` | Never. |
| Restore points | `<claudeDir>/.claude-lens-backups/<iso>-<auditId>/` | Never — outside the repo entirely |
| ⚠️ *(amendment)* | **`<iso>` has its `:` replaced by `-`** — see the note below | |
| **Archived transcripts** | `<archiveRoot>/<claudeDirBasename>-<archiveId>/…` — user-chosen, **outside `<claudeDir>`**, may be an external volume | Never. ⚠️ **Never scanned, never watched, never auto-deleted** (INV-19) |
| Price seed | `resources/price-seed.json` | **Yes** — it ships with the app |
| Fixtures | `test/fixtures/**` | **Yes** — tiny, synthetic, ≤ 256 KB each |

⚠️ **AMENDED 2026-07-22 (E10) — a literal ISO instant cannot be a folder name here.** An ISO 8601
instant contains `:`, and macOS renders a literal `:` in a filename as `/` in Finder — the one tool
§5.7 ACT-07 rule 4 and §9.4 tell the user to manage these folders with. The colons are replaced by
`-`, so a restore point is `.claude-lens-backups/2026-07-22T09-15-00.000Z-7/`. The
`<iso>-<auditId>` shape is otherwise unchanged, and the `auditId` — which is unique and is the join
back to `audit_log` — is what actually identifies the folder.

⚠️ **The database is never placed inside the Claude data directory** — it would then be scanned,
flagged, watched, and counted as bloat by the app itself.

## §9.4 Backup and restore

The user's data is the Claude data directory, which the app treats as read-only except through the
guarded-action catalogue. The app's own backup story is the **restore point** mechanism (§5.5, §3.14):
written before every mutation, never pruned, surfaced with a total size and count in Settings, and
removable only through the confirmed, audited `clear-backups`.

The database itself needs no backup for its DERIVED half — that is what "derived" means. Its **USER**
half (`price_rows`, `settings`, `audit_log`, `archives`) has no other source, which is why §6.11
offers "show my price rows" instead of a reset button, and why `db-migration-review` is a real gate.

⚠️ **The RETAINED half changes the backup story and must be said out loud.** After any ACT-07, the
parsed rows for archived sessions exist **only** in `claude-lens.db`. The transcripts still exist
under the archive root, but Claude Lens will not re-read them (§5.3), so the database is the only live
representation of that history. Two consequences: **(1)** losing `claude-lens.db` costs archived
analytics until the user manually moves those files back into `<claudeDir>` and re-syncs — which the
`archives` table tells them exactly how to do, and which is why that table is USER-class and lists
absolute paths; **(2)** `db-migration-review` must treat any migration touching RETAINED rows as a
blocking finding (§3.18). This is the price of the option chosen in OQ-014, and it is bounded and
recoverable rather than silent.

⚠️⚠️ **AMENDED 2026-07-22 (A-05) — a THIRD consequence, and the one genuinely irreversible thing
that change introduces. It is recorded here because it is a backup-and-restore fact, not a pricing
one: it is about what the database is the only copy of.**

A-05 gave cache writes two independently priced classes (§2.1 "Token class"). Every event parsed
before migration 0005 carries `events.tok_cache_write_1h IS NULL` — "the split is not known" — and
is costed entirely at the 5-minute rate, which **understates** it. For a **live** session that is
temporary: the transcript is still under `<claudeDir>`, DERIVED data is rebuildable, and a re-sync
or a rebuild fills the split in. ⚠️⚠️ **For an ARCHIVED session it is permanent.**

The mechanism is the one this section already describes, applied to a new column. After an ACT-07
the parsed rows are the only live representation of that history: the transcripts still exist under
the archive root, but Claude Lens **will not re-read them** (§5.3 `ARCHIVED`, ADR-034). There is
therefore no operation inside the application that can ever fill in an archived session's 1-hour
cache-write share. Those sessions stay costed at the 5-minute rate **forever**, and that
understatement is completely invisible unless it is disclosed.

**Therefore:** §4.6 carries `cacheSplitArchivedEvents` as a **separate count with its own
sentence**, distinct from the recoverable `cacheSplitUnknownEvents`, and §6.3/§6.4 render them as
two lines. The recoverable one names its remedy; the archived one says the data can no longer be
recovered and offers none — because telling a user to re-sync an archived session is advice that
cannot work. ⚠️ Nothing is auto-purged and no re-parse is triggered on the user's behalf.

⚠️ **The user has no archives today, so this is prevention rather than repair — which is the only
moment it can be done cheaply.** Once a session is archived under a build that discards the split,
the information is gone; adding the disclosure afterwards would announce a loss instead of
preventing one. The manual escape hatch is unchanged and is exactly the one consequence **(1)**
already documents: move the archived files back into `<claudeDir>` — `archives` is USER class and
lists the absolute paths for precisely this reason — and re-sync.

⚠️ **One further backup fact from the same migration.** 0005 is the only migration in this project
that **rewrites** a USER table rather than adding to it: SQLite cannot `ALTER` a CHECK constraint,
and `price_rows.token_class` had to admit a fifth value. ADR-026 forbids dropping that table, so
0005 renames it aside and copies every row into the new definition, leaving **`price_rows_pre_0005`**
in place permanently — an in-database pre-image of the USER half's most irreplaceable table,
classified USER so that no purge and no rebuild can remove it (§3.11).

## §9.5 Secrets

**None.** No API key, no token, no credential, no `.env` file, nothing in the keychain. The one
network call is an unauthenticated `GET` to a user-supplied URL. If a story ever needs a secret, that
is a design change, not a configuration change.

## §9.6 Schema and data migrations

Numbered SQL files under `src/main/db/migrations/`, applied in order inside a transaction by a ~40-line
runner keyed on `PRAGMA user_version` (STACK ADR-007). Merged files are immutable. A failed migration
leaves the database untouched and puts the app in `FATAL` (§5.1) — **it never falls back to dropping
and rebuilding**, because that path destroys hand-corrected price history (ADR-026).

---

# §10 — ADRs (LOCKED)

Continuing `STACK.md`'s sequence, which ended at **ADR-018**. One namespace for this project; do not
restart at ADR-001. Each ADR below passed the test: **a competent engineer could plausibly have
chosen differently, AND getting it wrong is expensive to reverse.** Choices that failed that test are
written into their sections and are not ADRs.

### ADR-019 — Event identity is `event_key`, and ingest is idempotent on it  [LOCKED 2026-07-20]

- **Decision:** every event carries `event_key TEXT NOT NULL UNIQUE` = its `uuid` when present, else
  `<rel_path>#<line_no>`. Ingest is `INSERT ... ON CONFLICT(event_key) DO NOTHING`.
- **Because:** double-counting is the single highest-impact correctness risk in this project (~72% of
  output tokens ride on subagent attribution, OQ-006), and the raw data has three independent ways to
  present the same record twice: a re-parse after a rewrite, a replayed append, and the open question
  of whether a sidechain record appears in both the parent transcript and the `subagents/` file. **We
  do not need to answer that last question**, because dedup by key makes the answer irrelevant. Making
  identity structural also makes INV-03 and INV-04 mechanically testable rather than argued.
- **Rejected:** *`UNIQUE(source_file_id, line_no)` only.* Real cost of rejecting: simpler, no fallback
  branch, and file deletion cleanly removes exactly its own rows. Real cost of accepting: it makes
  cross-file duplication invisible — the totals would be silently doubled and no test would catch it.
  *Trusting `uuid` to always exist* — `HANDOFF.md` §4 says "common fields", not "always present", and a
  `NOT NULL UNIQUE` on a sometimes-absent field fails ingest on real data.
- **Constrains:** §3.5 DDL, §5.4 rule 3, INV-03. A file deletion removes rows by `source_file_id`, so a
  record that was deduplicated in favour of another file's copy is removed with that file; a full
  re-sync repairs it. Recorded as §11.6.
- **Revisit if:** the `<rel_path>#<line_no>` fallback ever collides in practice, which would mean
  `rel_path` is not stable — a bigger problem than this ADR.

### ADR-020 — Subagent events are stored once and attributed to the parent session, with an `origin` column  [LOCKED 2026-07-20]

- **Decision:** events from `projects/<proj>/<session-id>/subagents/*.jsonl` are stored in the same
  `events` table, with `session_id` = the **parent** session, and `origin = 'subagent'`. There are no
  separate session rows for subagent runs. Session attribution comes from the **directory path**, never
  from `isSidechain` and never from a heuristic. Spawn-point linkage is a separate, best-effort,
  structural resolution via `parent_uuid` → `uuid`, and is **disclosed when it fails**.
- **Because:** OQ-006 decided that a session's headline totals **include** its subagent runs and that
  the parent↔child link is **always stored** so any view can split it. Storing once with a partition
  column satisfies both with a single `SUM`, and makes INV-02 (`main + subagent = total`, exactly) a
  one-line assertion. Separating *attribution* (structural, must be right) from *linkage* (best-effort,
  may be absent) is what stops a labelling gap from becoming a totals gap.
- **Rejected:** *Subagent runs as their own `sessions` rows, rolled up at query time* — real cost of
  rejecting: the Execution Trace would have a natural home for per-run metadata. Real cost of
  accepting: two entities called "session" that must be summed carefully every single time, which is
  precisely the double-count this project cannot afford. *Trusting `isSidechain`* — a record-level flag
  that may disagree with the file it lives in; the path cannot.
- **Constrains:** §3.5, §3.7, §5.4 rules 4–5, INV-01/INV-02, M-17, and every view that shows the split.
- **Revisit if:** the on-disk layout stops putting subagent transcripts under the session directory.

### ADR-021 — Timestamps stored as UTC epoch ms; all calendar bucketing in local time at query time  [LOCKED 2026-07-20]

- **Decision:** `INTEGER` UTC epoch milliseconds in every column. Every calendar grouping — activity
  calendar, working day, rhythm heatmap, daily buckets — is computed at query time in the **machine's
  local timezone**, via `datetime(ts/1000, 'unixepoch', 'localtime')`. No local time is ever stored.
- **Because:** the product's day-shaped metrics are about *when the person was working*, and a
  marathon that runs 22:00→02:00 must land where the human thinks it did. Storing local time makes
  every historical row wrong the moment the machine crosses a DST boundary or moves timezone; storing
  UTC and bucketing late keeps one canonical value and one presentation rule. This is a classic
  silently-wrong-number source and the app's worst failure mode is exactly that.
- **Rejected:** *Storing a precomputed local `YYYY-MM-DD` alongside `ts`* — real cost of rejecting: the
  calendar queries get marginally slower and need an index expression. Real cost of accepting: two
  representations that disagree after any timezone change, with no way to tell which is right.
  *Bucketing in UTC* — simpler and portable, but produces a "day" the user does not recognise, which
  is a wrong number in the only sense that matters here.
- **Constrains:** §3.1.1, M-08, M-16, every date-bucketed query, and the golden fixtures, which must
  pin an explicit `TZ` so they are reproducible.
- **Revisit if:** the app ever needs to compare two machines' data — it will not (§1.6 non-goal 5).

### ADR-022 — Active time is computed at query time from event timestamps, never stored  [LOCKED 2026-07-20]

- **Decision:** active time is a window-function CTE over `events` — `SUM(MIN(gap, idleGapMs))` —
  evaluated per request with the current `idleGapMinutes`. No `active_seconds` column exists on any
  table. Session identity, span, token totals and tool counts are all independent of the threshold.
- **Because:** the threshold is a live Settings slider (prototype §6.10), and OQ-005 made it explicit
  that moving it must **not** change session boundaries. A stored value is either recomputed on every
  slider move (a full-table write to answer a read) or stale — and a stale active-hours figure is a
  wrong hero tile. Computing late makes INV-05 ("changing the threshold changes only active time")
  directly testable.
- **Rejected:** *Storing `active_seconds` at the default threshold and recomputing only on change* —
  real cost of rejecting: one extra window function per query. Real cost of accepting: a column whose
  correctness depends on a setting recorded somewhere else, which is how a silently wrong number gets
  born. *Storing a per-session gap histogram* — supports any threshold cheaply, but is lossy at bucket
  boundaries and would need its own fixture regime to prove it is not.
- **Constrains:** §3.4 (no aggregate columns), M-07, M-08, M-10, INV-05, P-08.
  ⚠️ This ADR fixes *when and how* active time is computed. It does **not** fix *over which events*
  (**ADR-035**, resolving §11.1) or *over which partition* (**ADR-036**, resolving §11.8). All three
  are required to determine M-07; read them together.
- **Revisit if:** P-08 fires on the active-time query specifically, which would be a reason to
  materialise per-session gap sums — behind the seam, and with fixtures proving equivalence.

### ADR-023 — Money is an integer picoUSD-per-token rate; no floating point anywhere in the cost path  [LOCKED 2026-07-20 · **AMENDED 2026-07-20**]

> ⚠️ **Amendment (same day, before any code existed).** This ADR originally locked **nanoUSD** per
> token with a three-decimal-place limit on USD/Mtok input. While verifying a community price source
> for §11.3, a **real published rate** was found that the locked unit cannot represent:
> `cache_creation_input_token_cost = 3.125e-07` USD/token (`$0.3125/Mtok`) → **`312.5` nanoUSD/token,
> not an integer.** The unit is therefore **picoUSD per token**, and the input limit is **six** decimal
> places of USD/Mtok. The decision's *reasoning* is unchanged and is strengthened: a rounded **rate**
> multiplies into every total that uses it, which is strictly worse than a rounded total. Recorded as
> an amendment rather than a superseding ADR because nothing had been built against the original, and
> because the fact that forced it is the useful part. Fixture **F-10** pins it.

- **Decision:** `price_rows.rate_picousd_per_token INTEGER` = USD per 1M tokens × 1e6. All cost
  arithmetic — multiply, sum, group — is integer. SQL sums in picoUSD; the repository converts to
  **nanoUSD** (integer division, round-half-up) before the value crosses IPC, so `costNanoUsd` is the
  wire type everywhere in §4 and stays far inside `Number.MAX_SAFE_INTEGER` (INV-11). USD is produced
  **once**, at the presentation edge, by dividing by 1e9. Settings accepts USD/Mtok to six decimal
  places and **rejects** finer input (`E_PRICE_PRECISION`) rather than rounding it away.
- **Because:** the dataset carries 3.1e9 cache-read tokens against 6.42e7 output tokens. Summing
  `tokens × rate` in IEEE-754 doubles across hundreds of thousands of rows accumulates error that is
  invisible, unreproducible, and lands in the one figure the user is most likely to quote. Integer
  nanoUSD represents every real Anthropic rate exactly ($15.00 → 15000, $1.50 → 1500, $0.30 → 300)
  and the largest plausible total (4.65e12) sits four orders of magnitude inside `2^63`.
- **Rejected:** *`REAL` USD per million, converted at read time* — real cost of rejecting: the seed
  JSON and the Settings form both speak USD/Mtok, so there is one conversion at each edge. Real cost of
  accepting: non-associative addition, so the same data grouped two ways gives two different totals —
  a silently wrong number that reviewers will rationalise as "floating point, it's fine."
  *SQLite `DECIMAL`* — does not exist; SQLite has no fixed-point type. *nanoUSD* — see the amendment
  above; it cannot represent a rate that is already published in the wild.
- **Constrains:** §3.11, §4.7, M-05, M-06, F-10, and every `$` in §6.
- **Revisit if:** a published rate ever needs finer than six decimal places of USD per million tokens
  (i.e. finer than one picoUSD per token). The amendment above is what this line is for.

### ADR-024 — Bi-temporal price rows with half-open ranges; usage joins at the record's own timestamp  [LOCKED 2026-07-20]

- **Decision:** `[valid_from, valid_to)`, half-open, `valid_to IS NULL` meaning "still in effect". At
  most one open row per `(model, token_class)`, enforced by a partial unique index. Non-overlap of
  closed rows is asserted by the repository **inside the same write transaction** (SQLite has no
  exclusion constraint). Usage joins to the row valid at **each record's own timestamp**, never
  today's. A record with **any** non-zero token class lacking a covering row is **entirely uncosted**,
  excluded from `$` totals and disclosed.
- **Because:** this is the literal user requirement (OQ-012.2, PRD "In scope"), and the strict
  all-or-nothing costing rule is what stops the subtler failure: a record priced on three of its four
  classes would produce a number that is confidently wrong rather than honestly absent. Half-open
  ranges make adjacency unambiguous — a price change at instant T belongs to exactly one row, with no
  double-count and no gap at the boundary.
- **Rejected:** *Closed `[valid_from, valid_to]` ranges* — real cost of rejecting: reads more naturally
  in the UI. Real cost of accepting: the boundary instant matches two rows, so a record at exactly the
  change time is costed twice or ambiguously. *Costing partial records at whatever rates exist* — real
  cost of rejecting: fewer records excluded, a fuller-looking total. That is exactly the wrongness the
  user named. *Deriving cache rates from the input rate by the usual multipliers* — explicitly rejected
  by the user: it breaks silently the moment a model deviates from the ratio, and with 3.1B cache reads
  against 64.2M output tokens the error is a multiple, not a rounding.
- **Constrains:** §3.11, §5.8, M-05/M-06, INV-08/INV-09/INV-10, §6.4's degraded state.
- **Revisit if:** never in v1. A second pricing dimension (region, tier, batch) would reopen it.

### ADR-025 — Pricing keys on the exact raw model string; no normalization, aliasing or fuzzy matching  [LOCKED 2026-07-20]

- **Decision:** `events.model` stores `message.model` verbatim. `price_rows.model` matches it with
  `=`, case-sensitive, byte-for-byte. There is no alias table, no prefix match, no version-stripping,
  no "closest model" fallback. `pricing:models` lists every observed model string with whether it is
  priced, so an unmatched model is **visible in Settings**, not just implied by an uncosted count.
- **Because:** every normalization scheme is a guess about a naming convention that the vendor
  controls and can change. A wrong guess substitutes one model's rate for another's and produces a
  plausible, entirely fabricated `$`. Exact matching fails **loudly and safely**: unmatched records
  become uncosted, are excluded, and are disclosed by name and date range — the user then fixes it with
  one Settings edit, which is a first-class path (OQ-012.1), not a fallback.
- **Rejected:** *Normalizing to a model family (e.g. stripping a date suffix)* — real cost of
  rejecting: the user hand-adds a row when a new model id appears. Real cost of accepting: a silently
  substituted rate, which is the project's defining failure. *Fuzzy/prefix matching* — same failure,
  with less warning.
- **Constrains:** §3.5, §3.11, §4.7, M-05/M-06, §6.10's models-observed list.
- **Revisit if:** the user asks for aliasing — which would be a user-visible mapping table they
  maintain, still explicit, never inferred.

### ADR-026 — Two persistence classes in one database: DERIVED is purgeable, USER never is  [LOCKED 2026-07-20]

- **Decision:** every table is classified DERIVED or USER (§2.2). Purge — on `claudeDir` change or an
  explicit rebuild — truncates **only** the DERIVED tables. `price_rows`, `settings` and `audit_log`
  are never truncated, never dropped, and are carried across every migration. There is **no
  drop-and-rebuild path in the codebase**, and §6.11's fatal screen offers no reset button.
- **Because:** `DESIGN_INPUT.md` §3.3 says the database "can be deleted and rebuilt at any time",
  which is true of parsed observations and **false** of hand-edited rates, hand-corrected effective
  dates, and the guarded-action trail. Those have no other source. A well-meaning agent implementing
  "just drop and re-sync on schema change" would silently destroy price history — squarely the stated
  worst failure, and undetectable afterwards. Naming the classes in the schema makes the mistake
  impossible to make accidentally and reviewable when made deliberately.
- **Rejected:** *Two database files, one derived and one user* — real cost of rejecting: the purge is a
  `DELETE` list rather than a file unlink, and the classification lives in a document instead of the
  filesystem. Real cost of accepting: two connections, two migration chains, no foreign keys between
  them, and a second thing to back up. Genuinely close; rejected because the seam (STACK ADR-008) makes
  the one-file version safe and `db-migration-review` gates the rest. *Storing settings and prices in
  JSON files outside the DB* — no transactions, no constraint enforcement for INV-08.
- **Constrains:** §2.2, §3.11/§3.13/§3.14/§3.15, §3.18, §5.1, §6.11, §9.4, §9.6, INV-12, and the
  `db-migration-review` gate.
- **Revisit if:** never in v1. This is a data-safety property.
- ⚠️ **Amended by ADR-033 (2026-07-20):** a **third class, RETAINED**, was added when OQ-014 resolved
  in favour of archiving-with-retained-rows. The two-class split above is necessary but no longer
  sufficient — archived rows are structurally DERIVED yet not derivable. ADR-026's reasoning is
  unchanged; its table is superseded by §2.2's three-class table.

### ADR-027 — Query-time aggregation only; no materialized rollup tables in v1  [LOCKED 2026-07-20]

- **Decision:** no stored counts, sums, active times, costs or runtime overlays anywhere. `sessions`
  holds identity and immutable facts only; every number in every view is a `SELECT` over `events`,
  `tool_calls`, `file_touches` and `price_rows`, computed on request. Generated columns are used only
  where the value is a pure function of other columns in the same row (`sessions.span_seconds`).
- **Because:** a stored aggregate has exactly two states — correct, or silently stale — and the
  incremental sync writes into these tables continuously all day, which is the condition under which
  drift is most likely and least visible. With ~236K events and the §3 indexes, the whole workload is
  well inside P-08's 200 ms. This choice is *what makes* the 200 ms budget the DuckDB trigger it is
  supposed to be: there is nothing to blame but the engine.
- **Rejected:** *A `daily_rollup` table maintained on ingest* — real cost of rejecting: some queries
  do more work per call. Real cost of accepting: every roll-up is a second implementation of a metric
  defined in §5.9, needing its own fixtures and its own invalidation, and disagreeing with the primary
  one exactly when someone changes a metric definition. *Materialised views* — SQLite has none.
- **Constrains:** §3.4, §3.10, §5.9, P-08/P-09.
- **Revisit if:** P-08 fires. The seam (STACK ADR-008) means a rollup — or DuckDB — is contained to
  `src/main/db/`, and any rollup added must be proven equivalent to its §5.9 definition by fixture.

### ADR-028 — `file-history/` is not parsed in v1; file metrics derive from write-class tool calls  [LOCKED 2026-07-20]

- **Decision:** the 39 MB of before/after snapshots under `file-history/` is **not parsed**. Files
  touched, edit counts and language mix come from `Edit`/`MultiEdit`/`Write`/`NotebookEdit` tool inputs
  in the transcripts (§3.8, M-15). `file-history/`'s disk size is still measured for Bloat Radar.
- **Because:** the required v1 deliverable is *metrics only — files touched, churn, languages*
  (OQ-104), and every one of those is derivable from a **documented, verified** source: `HANDOFF.md`
  §4 specifies `tool_use` items with `name` and `input`. The `file-history/` directory's internal
  format is documented **nowhere** — not in `HANDOFF.md` §4, not in `DESIGN_INPUT.md` §2 — so parsing
  it would mean inventing a schema and writing fixtures against a guess. Same metrics, verified source,
  no invention. It also keeps the app further from the diff viewer that is a firm non-goal.
- **Rejected:** *Parsing `file-history/` after discovering its format at build time* — real cost of
  rejecting: line-level churn is unavailable, so "edit count" is operations rather than lines, which
  §2.1 and §6.8 label honestly. Real cost of accepting: a parser for an undocumented format, a
  schema-discovery story inside a build, and 39 MB of ingest for a metric we can already compute.
  *Skipping file metrics entirely* — they are in scope (OQ-104) and cheap from this source.
- **Constrains:** §3.8, M-15, §6.8, and the `file-history` non-goal boundary (§1.6 non-goal 3).
- **Revisit if:** the post-v1 diff question (OQ-104, still RESERVED) is ever answered yes — at which
  point the format must be established first, not assumed.

### ADR-029 — `stats-cache.json` is coverage metadata only and is never summed into a displayed metric  [LOCKED 2026-07-20]

- **Decision:** `stats-cache.json` is ingested as verbatim per-day objects into `stats_cache_days`
  (§3.15). Its only use is day-presence, feeding `dataCoverage()`. **No value from it is ever summed
  into, substituted into, cross-filled from, or reconciled against any number the app displays.**
- **Because:** `HANDOFF.md` §4 calls it "cross-check / backfill, not the primary source", and
  `PRD.md` names it among the files parsed — so it is in scope, but as what? Backfilling the
  pre-transcript era from it would create a **second source of truth** for the headline metrics, with
  no way for a user to tell which source a given number came from. That is precisely the silently
  wrong number. Marking the period **partial** instead is honest and is what
  `DESIGN_INPUT.md` §1 already asked for ("partial-data markers").
- **Rejected:** *Backfilling daily totals for the pre-transcript window* — real cost of rejecting: the
  activity calendar is genuinely emptier before the transcript era. Real cost of accepting: two
  provenances silently blended in one chart. *Not ingesting it at all* — contradicts `PRD.md` "What",
  and loses a cheap, honest coverage signal.
- **Constrains:** §3.15, M-16, §6.3/§6.12's partial-data treatment, §5.12's conflict table.
- **Revisit if:** the user asks for pre-transcript token totals — which would be a deliberate, labelled
  second series, never a silent blend.

### ADR-030 — All application state persists in the SQLite `settings` table; `electron-store` is not used  [LOCKED 2026-07-20]

- **Decision:** one persistence store. `settings` is a table (§3.13), not a JSON file. No
  `electron-store` dependency is installed.
- **Because:** `HANDOFF.md` §3 and `DESIGN_INPUT.md` §4.8 both name `electron-store`, so this
  contradicts the source documents deliberately and must be recorded or an agent will install it.
  Settings are USER-class data with the same durability requirement as `price_rows` and `audit_log`
  (ADR-026): one migration chain, one transaction boundary, one thing to protect. A second store means
  a second migration story, a second corruption mode, and a settings value that can disagree with the
  database it configures — for example a `claudeDir` in JSON that does not match the
  `claudeDirFingerprint` in `meta`, which decides whether to purge.
- **Rejected:** *`electron-store`* — real cost of rejecting: settings are unreadable without opening
  the database, and are unavailable before migrations run (mitigated: nothing needs them earlier).
  Real cost of accepting: a second persistence system for eight scalar values.
- **Constrains:** §3.13, §5.1, §9.3, and the dependency list.
- **Revisit if:** a setting is ever needed before the database can be opened — which would be a
  bootstrap problem, not a preference.

### ADR-031 — One typed IPC channel map with a uniform `Result<T>` envelope; no exception crosses the boundary  [LOCKED 2026-07-20]

- **Decision:** `src/shared/ipc-contract.ts` declares every channel, request and response type. Both
  processes compile against it, so drift is a `typecheck` failure. Every handler returns
  `Result<T>` through one `withResult()` wrapper; an uncaught throw becomes `E_INTERNAL`. Incompleteness
  is expressed **in the success payload** as a disclosure, never as an error.
- **Because:** it is what makes `api-contract-sync = no` correct in the gate manifest — there is no
  generated artifact to diff, because the compiler is the gate (STACK ADR-003). The envelope matters
  separately: Electron serialises a thrown `Error` into a lossy string, so error **codes** would not
  survive, and the renderer would end up matching on message text. The disclosure rule is the
  load-bearing half — if "N records uncosted" were an error, a caller could swallow it and render a
  confident wrong total.
- **Rejected:** *Letting handlers throw and catching in the preload* — real cost of rejecting: every
  handler needs a wrapper (one line). Real cost of accepting: lost error codes and a renderer that
  branches on prose. *tRPC or a codegen'd contract* — a build step and a dependency to replace a
  TypeScript interface that already type-checks both sides.
- **Constrains:** all of §4, §7.3, INV-10, and the `api-contract-sync = no` manifest row.
- **Revisit if:** a second consumer of the data appears (a CLI, a second window). It will not in v1.

### ADR-032 — Guarded actions come from a closed catalogue; failure never triggers automatic recovery  [LOCKED 2026-07-20]

- **Decision:** six action types exist (§5.7). The dispatcher rejects anything else with
  `E_ACTION_UNKNOWN`; adding one is a design change. Execution requires a `confirmToken` minted by a
  preview and bound to the exact resolved target list. Backup strictly precedes mutation. A partial
  failure lands in `FAILED_PARTIAL` and **the app does nothing further on its own** — it reports and
  offers a manual restore. Nothing is ever auto-deleted, auto-restored or auto-pruned, including
  backups.
- **Because:** this app deletes files in the user's real config directory, and its entire trust story
  is "confirm before touching anything." An open-ended action interface means the next agent can add a
  destructive operation without a design review; a closed catalogue makes every addition visible.
  The token binding closes the real gap between "the user approved a list" and "the code deleted a
  list" — without it, a rescan between preview and execute silently changes what gets deleted. And
  auto-recovery is itself an unconfirmed mutation: restoring over a half-deleted tree can destroy
  something the user changed in between (OQ-103's reasoning applied to the failure path).
- **Rejected:** *A generic `delete(paths[])` action with a confirm dialog* — real cost of rejecting:
  each new cleanup needs a catalogue entry, a preview builder and a test. Real cost of accepting: the
  Bloat Radar becomes an arbitrary-path deleter one careless story away. *Auto-rollback on partial
  failure* — real cost of rejecting: the user has manual work after a rare partial failure. Real cost
  of accepting: an unconfirmed write, in the one code path where the app has already proven it is not
  in full control of the filesystem. *Retention/pruning of backups* — explicitly rejected by the user
  (OQ-103): pruning is an unconfirmed delete.
- **Constrains:** §3.12, §3.14, §4.8, §5.5, §5.7, §5.11, §6.9, INV-06/INV-07/INV-14, and the
  `guarded-action-review` gate.
- **Revisit if:** the catalogue needs a seventh entry — which is this ADR working, not failing.
- ⚠️ **Amended by ADR-034 (2026-07-20):** the catalogue is now **seven** entries — OQ-014 added
  **ACT-07 `archive-sessions`**, the first **move-class** action, which carries a move manifest instead
  of file copies (§5.5 rule 1). This is precisely the "revisit if" above firing as designed: the
  addition went through a design decision and an ADR, which is the whole point of a closed catalogue.
  The catalogue remains closed at seven.

### ADR-033 — A third persistence class, RETAINED: archived rows survive every purge, rebuild and migration  [LOCKED 2026-07-20]

- **Decision:** rows whose source file has been moved out of the Claude data directory by ACT-07 are
  **RETAINED** (§2.2): structurally derived, but **no longer derivable**. The class is not prose — it
  is the column `archive_id`, present on `file_manifest` and `sessions`, and it is the **only**
  predicate a purge is permitted to use (§3.18). RETAINED rows are never purged, never rebuilt, never
  re-parsed, and never deleted because their source is absent from `<claudeDir>` (§5.3 `ARCHIVED`).
  `archives` itself is USER-class. `db-migration-review` gets a mechanical rule: a migration that
  deletes from a fact table without an `archive_id IS NULL` guard is a blocking finding.
- **Because:** OQ-014 chose to keep the parsed rows when transcripts are moved out. That single
  decision breaks ADR-026's two-class model, because the rows are now in the worst possible position —
  they *look* rebuildable (they sit in DERIVED tables, they came from files) but a rescan of
  `<claudeDir>` will never reproduce them. Every existing rebuild path would therefore delete them:
  a `claudeDir` change, a schema-change rebuild, or the ordinary `MISSING` branch of the sync
  classifier on the very next sync after archiving. The result would be **lifetime totals silently
  shrinking by whatever was archived, with no marker and no error** — the project's defining failure,
  arriving through a different door than the price-history one ADR-026 closed. Making the class a
  column rather than a convention means the mistake is impossible to make accidentally, visible in
  review when made deliberately, and mechanically checkable by a gate.
- **Rejected:** *Treating archived rows as USER-class outright* — real cost of rejecting: one more
  class to explain. Real cost of accepting: it is untrue in a way that misleads. These rows were never
  hand-entered and *can* be reconstructed by moving the files back and re-syncing, which is exactly
  what the `archives` table exists to enable; calling them USER would imply they are irreplaceable and
  would discourage building the un-archive path. *An exemption flag inside DERIVED with no schema
  presence* (a documented rule, enforced by review) — real cost of rejecting: nothing. Real cost of
  accepting: on a multi-month build where agents repeatedly lose context, an unenforced data-safety
  rule has a half-life measured in weeks, and the failure is undetectable. *Keeping the archive root
  as a second scanned sync root, so the rows stay genuinely derivable* — genuinely attractive and the
  closest call here: it would have preserved the two-class model exactly. **Rejected because the
  archive may live on an external volume**, and an unmounted volume would then present as thousands of
  `MISSING` files, deleting the very history the user archived to preserve. Reachability must never be
  load-bearing for correctness.
- **Constrains:** §2.2, §3.2, §3.4, §3.15, §3.18, §5.3, §9.4, INV-18, fixture F-04, ADR-026 (amended),
  and the `db-migration-review` gate's checkable rule.
- **Revisit if:** archiving is ever removed from the product, which would delete this class with it.

### ADR-034 — Archiving is a move-class guarded action with a manifest-only restore point; archived files are never re-read and never auto-deleted  [LOCKED 2026-07-20]

- **Decision:** **ACT-07 `archive-sessions`** joins the catalogue as its seventh and only *move-class*
  entry. It moves a named set of sessions' transcripts — **each session's transcript and its whole
  `subagents/` directory together, never split** (INV-20) — to a user-chosen `archiveRoot` that is
  validated to be outside `<claudeDir>` and is never scanned, watched or walked (INV-19). It carries
  the full guarded treatment: preview, `confirmToken` bound to the resolved list, typed confirmation,
  audit entry, undo. Its restore point is a verified **`move-manifest.json`**, not file copies. The
  app **never deletes anything under the archive root**, and no v1 action removes archived files.
- **Because:** three things had to be true at once and only this shape achieves all three.
  **(1) Backup-before-mutate must survive.** A move destroys nothing — the bytes exist at the
  destination the instant the operation completes — so the *substance* of INV-07 ("a restore point
  exists and is sufficient to reverse the action") is met by a manifest. Copying the bytes as well
  would permanently consume, in a restore point that is **never pruned** (§1.6 non-goal 4), exactly
  the disk the user was trying to free — an action that makes the problem worse the more you use it.
  **(2) Session granularity is not a convenience, it is the correctness boundary.** Splitting a
  session's transcript from its `subagents/` files across two roots would put half of a roll-up on
  each side of the archive boundary, which is how INV-02 and the §11.6 dedup story break.
  **(3) Archived transcripts are user data the app moved**, so the "never auto-delete" rule (OQ-103)
  applies to them with no exception — including no retention, no cap, and no "clear archive" action.
  Contrast ACT-06, which may clear the *backup* root only because that root is the app's own creation.
- **Rejected:** *Copy-then-delete with a full byte backup* — real cost of rejecting: the restore point
  is a manifest rather than bytes, so undo depends on the destination still being intact, which is why
  it verifies size and mtime and refuses on mismatch. Real cost of accepting: archiving 500 MB
  permanently costs 500 MB of un-prunable backup, i.e. the feature cannot achieve its own purpose.
  *Compressing transcripts in place inside `<claudeDir>`* — reclaims space without a second root, but
  **breaks the byte offsets the entire incremental sync depends on** (§3.2, §5.3) and turns every
  archived file into a re-parse. *Deleting archived transcripts after a successful move* — irreversible
  data loss dressed as hygiene, in the app whose whole trust story is confirm-before-touching.
  *Archiving into `.claude-lens-backups/`* — the destination is inside `<claudeDir>` and excluded from
  analytics (INV-14), so the sessions would vanish from every chart: a silent shrink by construction.
- **Constrains:** §3.2, §3.4, §3.13, §3.15, §4.1, §4.8, §5.3, §5.5, §5.7, §5.11 (BR-05), §6.9, §6.10,
  §9.3, §9.4, P-36/P-37, INV-07/INV-19/INV-20, fixture F-04, ADR-032 (amended), and the
  `guarded-action-review` gate.
- **Revisit if:** the user asks to remove archived files from within the app — which would be an
  eighth catalogue entry, a new ADR, and a deliberate exception to "never auto-delete", not a tweak.

### ADR-035 — Active time is computed over events of BOTH origins  [LOCKED 2026-07-20]

- **Decision:** a scope's **active time** (M-07) is computed over **all** its events —
  `origin IN ('main','subagent')` — merged into one timestamp-ordered stream before gaps are taken and
  capped. This applies identically to a session (M-07), to a **working day** (M-08), and to
  longest-session ranking (M-10), so the same rule produces every active-time number in the product.
  Synthetic events are excluded from token statistics but **included** in this stream.
- **Because:** OQ-006 fixed the roll-up rule for "headline token and message totals" but never named
  the event set for active time, and `HANDOFF.md` §5's definition ("sum of inter-event gaps, each
  capped at the idle threshold") does not either. **That silence was the trap**, and it was raised as
  a blocking question rather than guessed. The user's answer, in their framing: they were at the
  keyboard while those subagents ran, so it is real time on task, and it is consistent with the
  roll-up already decided for tokens and messages. The structural argument that settled it: **adding
  events to a stream can only ever shrink gaps, never invent them**, so the inclusive reading cannot
  over-count — whereas the main-only reading demonstrably under-counts, capping a genuine 40-minute
  working stretch at the 15-minute threshold purely because the work happened in a subagent.
- **Rejected:** *Main-loop events only* — real cost of rejecting: "active" no longer means "the main
  loop was visibly ticking", which is a defensible thing to want to measure. Real cost of accepting:
  the Overview's *Active hours* hero tile, the marathon leaderboard and longest-session ranking would
  all systematically under-report exactly the sessions the product exists to illuminate — the
  subagent-heavy ones — and `PRD.md` names "bad idle-gap math inflating active hours" as a canonical
  silently-wrong-number. *Reporting both, with one as the hero number* — real cost of rejecting: a
  main-loop-only figure is genuinely interesting. Rejected for v1 because two "active hours" on one
  screen is an invitation to quote the wrong one, and the origin split (M-17) already answers "how much
  of this was subagents?" precisely, in tokens, where it is unambiguous.
- **Constrains:** §2.1 (**Active time**), M-07, M-08, M-10, ADR-022 (which fixes *when and how*; this
  fixes *over what*), the Overview active-hours tile (§6.3), the marathon leaderboard (§6.5),
  `ProjectCard.activeSeconds` (§6.8), and **fixture F-01**, which must contain a parent session with a
  long subagent run inside it — a fixture built only from main-loop sessions passes under either
  reading and proves nothing.
- **Revisit if:** the user asks to see main-loop-only active time, which would be an additional
  labelled metric, never a redefinition of this one.

### ADR-036 — An aggregate Active-hours figure partitions by working day, not by session  [LOCKED 2026-07-21]

- **Decision:** M-07's partition has **exactly three bindings**, stated in M-07 itself so no surface is
  left to infer one: **(A)** a single session; **(B)** a working day, `(local date, project_id)`, which
  is M-08; and **(C) any figure spanning more than one session — the sum of (B) over the working-day
  groups in scope.** Binding (C) is **not** a sum over sessions and **not** one global stream. Intra-day
  inter-session gaps are therefore capped at the idle threshold and **counted**, exactly like any other
  gap. Consequently the Overview *Active hours* tile and the working-day leaderboard **agree by
  construction** for the same filter (INV-21), as does `ProjectCard.activeSeconds`.
- **Because:** M-07 shipped with a literal unfilled `PARTITION BY <scope>` placeholder that the design
  bound in only two places — a session, and M-08's group. The Overview tile is a **third** binding and
  had nothing to cite. This survived a full design pass and was caught only when a hand-computed
  expected value for that tile was actually attempted, which is precisely the argument for
  hand-computed fixtures over snapshots (STACK ADR-012). ⚠️ **The failure it would have caused is the
  one this project exists to prevent:** an engineer picking the per-session reading would have passed
  every acceptance criterion, `golden-fixture-review`, and code review, and shipped a tile that
  diverges on **any day with two sessions in one project** — which §1.3 describes as the *normal* day —
  by up to ~60 minutes on a five-session day. Worse, with no register entry, `docs-sync` would then have
  recorded whichever reading was picked **as if it had always been the design**.
  ⚠️ **AMENDED 2026-07-22 (E4):** the "~60 minutes on a five-session day" figure appears to rest on
  the same arithmetic slip corrected in §5.9.1 F-12 — counting a session's own elapsed stretch
  *uncapped* — and has **not** been re-derived. The *direction* of the divergence is unaffected and
  this ADR's decision does not depend on the magnitude, but **anyone relying on that number must
  re-derive it.** What *is* derivable under M-07 as written: binding (C)'s stream over a
  `(day, project)` group has exactly `sessions − 1` more gap terms than the per-session sum, every
  term is capped at `idleGapMinutes`, and adding events to a stream can only shrink the gaps that
  were already there (ADR-035's own structural argument) — so the divergence is bounded above by
  `(sessions − 1) × idleGapMinutes`, i.e. `4 × 15m = 60m` on a five-session day at the default
  threshold, and is smaller whenever an inter-session gap is shorter than the cap. The published
  figure coincides with that ceiling but was not computed from it; **treat 60m as an upper bound,
  not an expected value.**
  The user's rationale, preserved so it is not re-litigated: it is consistent with their own reasoning
  on OQ-013 — *"I was at the keyboard"*. Closing one session at 10:00 and opening another at 10:05 in
  the same project is real time on task, and because every gap is capped it cannot invent unbounded
  time. Agreement between the tile and the leaderboard was the decisive property.
- **Rejected:** *Sum over sessions (partition by `session_id`, then add).* Genuinely defensible and it
  never overstates — it simply drops every inter-session gap. Real cost of rejecting: the aggregate
  ignores real time spent between two sessions of the same project minutes apart. Real cost of
  accepting: **the Overview total becomes silently lower than the working-day leaderboard for the same
  period — two correct-looking numbers that disagree**, which is the worst kind of discrepancy to have
  to explain to yourself six weeks later. *One global stream over all events in scope.* The simplest
  reading, and the only one that can never exceed wall-clock time. Rejected because it disagrees with
  the leaderboard in the other direction and was not the user's choice; its one genuine advantage over
  (C) is recorded honestly in §11.9 rather than buried. *Different bindings per surface* — rejected
  outright by the user: two different numbers behind the same word on two screens, in a project whose
  stated worst failure is a silently wrong number.
- **Constrains:** §5.9 M-07 (the three bindings), M-08, M-09, M-10, `q:overviewTiles`, `q:workingDays`,
  `SessionRow.activeSeconds`, `ProjectCard.activeSeconds`, §6.3's tile and its sub-line, §6.5's
  leaderboard and histogram, §6.8's project cards, **INV-21**, and **fixture F-12**.
- **Read with:** **ADR-022** (active time is computed at query time, never stored) and **ADR-035** (the
  event set is both origins). This is the second time this one metric has needed pinning; all three
  ADRs are required to determine M-07, and none of them is sufficient alone.
- **Revisit if:** the user asks for a wall-clock-capped "hours at the keyboard" figure that cannot
  exceed elapsed time — see §11.9. That would be an **additional, differently-labelled** metric, never
  a redefinition of this one.

### ADR-037 — Cross-project overlap is disclosed beside the Active-hours figure, not corrected out of it  [LOCKED 2026-07-21]

- **Decision:** the Active-hours figure stays **exactly** as ADR-036 defines it (M-07 binding (C)).
  Its cross-project double-counting is quantified as **M-20** and rendered beside it as
  *"N hours of this total overlap across projects"* whenever it is non-zero, and not rendered at all
  when it is zero. Computing M-20 requires **M-19**, the deduplicated figure, as an **internal**
  quantity that is never displayed. ⚠️ **ADR-036 is unchanged; this is purely additive.**
- **Because:** it is **the pattern this design already uses for uncosted records** — the number stays
  as defined and stays honest by *disclosing*, not by quietly changing. That consistency is the main
  argument: a reader who has learned how the uncosted disclosure works already understands this one,
  and INV-23 is deliberately the exact twin of INV-10. It also adds **no second competing headline
  number**, which matters because the user rejected "different bindings per surface" on ADR-036 an
  hour earlier, and a second time-metric on the same screen is close to the same failure in a
  different costume.
- ⚠️ **The definition of M-19 is the load-bearing part of this ADR, and the obvious formulation is
  wrong.** "M-07 with one global partition" is *not* the deduplicated figure and must never be
  implemented as such: capping is applied per partition, so a coarser partition has longer gaps that
  the cap truncates harder, and the "deduplicated" total can come out **larger** than the per-project
  sum. Worked counterexample, cap 15m, two projects on one day — **A** at `09:00, 09:30`; **B** at
  `09:10, 09:40`:
  | Quantity | Value |
  |---|---|
  | binding (C), per-(day, project) sum | `15m + 15m` = **30m** |
  | ✗ naive "one global stream" M-07 | events `09:00, 09:10, 09:30, 09:40` → `10 + 15 + 10` = **35m** → overlap = **−5m** |
  | ✓ union of covered intervals | `[09:15,09:30] ∪ [09:25,09:40]` = `[09:15,09:40]` = **25m** → overlap = **+5m** |

  The naive reading breaks INV-22(b) on a two-event-per-project fixture. M-19 is therefore defined as
  the **measure of the union of covered intervals** (§5.9 M-19), which is well-defined, always ≤ the
  elapsed span, and yields a non-negative overlap by the elementary fact that the measure of a union
  never exceeds the sum of the measures.
- **Rejected:** *Label only* — the tile already says "summed per project-day", and that was judged
  insufficient: a figure larger than the number of hours that elapsed still reads as a bug at a glance,
  and the glance is the product's most frequent interaction (§1.3 moment 3). *A separate "hours at the
  keyboard" metric showing M-19 directly* — real cost of rejecting: the user never sees a true
  wall-clock figure. Real cost of accepting: two numbers about time on one screen, each needing its own
  name, definition, fixtures and explanation of why they differ — the thing ADR-036 rejected.
  *Reopening ADR-036 to make the tile show M-19* — costs the tile↔leaderboard agreement (INV-21) that
  ADR-036 was chosen for, trading one discrepancy for another. *Suppressing the disclosure when it is
  small* — a threshold nobody can justify, and the failure mode is the disclosure vanishing exactly
  when it is closest to the noise floor.
- **Worth preserving, because it is the honest framing:** this concern was **not introduced by
  ADR-036.** The per-session reading ADR-036 rejected has the *identical* property — any partitioned
  sum double-counts concurrency — and only the "one global stream" reading avoids it. For a
  single-project day, binding (C) and a deduplicated stream are **identical**; they diverge only on
  genuinely concurrent multi-project work.
- **Constrains:** §5.9 M-19, M-20; §4.5 `q:overviewTiles.overlapSeconds`; §4.6 `Disclosures.activeOverlapSeconds`
  and INV-23; §6.3's tile and its zero/non-zero rendering; §6.8 (no disclosure, by INV-22(d));
  **INV-22**, **INV-23**; **fixture F-13**.
- **Read with:** ADR-036 (which partition) and ADR-035 (which events). M-19 inherits ADR-035's event
  set unchanged.
- **Revisit if:** the user asks to see the deduplicated figure itself. M-19 already exists and is
  tested, so that is a labelling and surfacing story, not a computation one — which is a further reason
  to keep it as a defined, named metric rather than an inline expression.

### ADR-038 — A thin macOS launcher: a ~1 MB `.app` that starts this repository's Electron against `out/`  [LOCKED 2026-07-22]

> ⚠️ **AMENDED 2026-07-22 — the executable is a compiled, ad-hoc-signed Mach-O, not a shell
> script. Read this before the text below; where the two disagree, this is right.**
>
> **What went wrong.** The bundle shipped, the user double-clicked it on a repository living on
> an external USB volume, and got the `denied` dialog — correctly, and with exactly the right
> diagnosis. Then it dead-ended: **System Settings → Privacy & Security → Files and Folders has
> no `+` button.** That list is populated *only* by apps that have already made a successful TCC
> request; Claude Lens had never appeared in it, so there was nothing to switch on. The advice
> "grant it under Files and Folders" was unactionable, which is a failure of the same family as
> a plausible wrong number: confident, specific, and leading nowhere.
>
> **Root cause: the bundle had no code identity.** macOS TCC attributes a file-access permission
> to an **executable's code identity** — its code signature, ultimately its cdhash.
> `Contents/MacOS/claude-lens` was a `#!/bin/bash` script and `codesign -dv` on the installed
> bundle reported *"code object is not signed at all"*. For a script-backed bundle the kernel
> execs `/bin/bash`, so the request is attributed to bash or is never well formed. **An unsigned,
> script-backed bundle has nothing for TCC to remember** — which is why it never prompted, never
> got listed, and why even a Full Disk Access grant may not persist across launches.
>
> **The fix.** `Contents/MacOS/claude-lens` is now a small **compiled Mach-O** built by `clang`
> from the committed **`resources/launcher.c`** (universal `arm64` + `x86_64`, ~70 KB, no library
> beyond libSystem, no dependency), and the finished bundle is **ad-hoc signed** with
> `codesign -s - --force` — **after** the icon, `Info.plist` and the repo pointer are in place,
> because the signature seals `Info.plist` and `Contents/Resources`. Verified on this machine:
> `codesign -dv` reports `Signature=adhoc`, `flags=0x2(adhoc)`, `Identifier=app.claude-lens.launcher`,
> and `codesign --verify --strict` exits 0. Every behaviour of the shell version is preserved
> verbatim and still tested: the `ok`/`missing`/`denied`/`mismatch` classification with its
> read-not-stat probe, all five failure dialogs, `CLAUDE_LENS_LAUNCHER_NO_DIALOG`, and the TTY
> suppression. **The repository is still resolved at run time** (`_NSGetExecutablePath` +
> `realpath`, then the bundle's `repo-root` pointer) — no absolute path is baked into any
> committed file, and the compiled binary's strings are checked for one (P-33, `guard`).
>
> ⚠️ **This inverts one sentence below.** The original text said *"on Apple silicon a Mach-O must
> carry at least an ad-hoc signature to execute — our executable is a shell script, so it does not
> apply."* That reasoning is now backwards. Being a script did not *avoid* a signing requirement;
> it **avoided having a code identity**, and a code identity is precisely what the TCC-on-an-
> external-volume case needs. The ad-hoc signature was never the cost — it is free, needs no
> certificate and no Apple Developer account — it is the thing that was missing. Everything else
> in that paragraph stands: no quarantine bit on a locally built bundle, so Gatekeeper never
> assesses it, and the $99/yr remains the price of *someone else's* download.
>
> **The honest new cost.** Building the **best** launcher now needs a C compiler — the free Xcode
> Command Line Tools (`xcode-select --install`), not Xcode and not an Apple account. Building a
> **working** launcher does not: with no compiler, `pnpm run launcher` falls back to the original
> shell script and prints a warning that names the exact consequence (no code identity → never
> listed under Files and Folders → cannot be granted access to an external or network volume).
> It **warns, it never fails** — a cold clone without Command Line Tools must still get a working
> launcher, which is ADR-016's standing concern, and `pnpm run launcher` is opt-in and outside
> `pnpm run check` so nothing in the gate depends on a toolchain. The launcher tests accept either
> shape, deciding which to demand by *actually compiling* a probe rather than by `which`, so
> `check` stays self-contained-green on a machine with no compiler.
>
> **A second, smaller cost:** an ad-hoc signature's designated requirement is its cdhash, so
> **rebuilding the launcher changes its identity and any TCC grant must be given again.** That is
> the price of not having a stable signing certificate, and it is the honest trade against $99/yr.
>
> **Constrains additionally:** `resources/launcher.c` (committed, the single source of the
> launcher's behaviour); `scripts/make-launcher.mjs` (compile → assemble → sign, in that order).

- **Decision:** `pnpm run launcher` generates **`Claude Lens.app`** — `Contents/Info.plist`, one
  compiled ad-hoc-signed executable at `Contents/MacOS/claude-lens` (see the amendment above;
  originally a 4 KB shell script, now built from `resources/launcher.c`), and
  `Contents/Resources/icon.icns`
  built from the committed `resources/icon.svg`. It contains **no application code**: it
  resolves this repository at run time and `exec`s `node_modules/electron/dist/…/Electron`
  against `out/`. **`--install` copies it into `/Applications`; a bare invocation never does**,
  because that is the one step that writes outside the repository. The bundle and the icon work
  directory are **build outputs — gitignored, never committed** (§9.2 amendment). Wired as
  `pnpm run launcher`, and **deliberately outside `pnpm run check`**, for the same reason and on
  the same boundary as `pnpm run e2e` (STACK ADR-018): `check` is self-contained-green on
  `pnpm install` and nothing else, and this needs macOS-only tooling plus a prior `electron-vite
  build`. Its *tests* are inside `check`, because they need neither.
- **Who fired the trigger, and which one.** STACK **ADR-016** ended with *"Revisit if: the user
  asks for a double-clickable app."* **The user asked, on 2026-07-22.** This is that revisit,
  recorded as a new ADR rather than an edit, because ADR-016 is LOCKED and a locked decision
  that quietly changes shape is worse than one that is openly amended.
- ⚠️ **What is still true of ADR-016, and is not weakened by one word of this:** no
  `electron-builder`, no `electron-forge`, **no packaging dependency installed at all** — this
  adds **zero** npm dependencies, because a `.app` is a directory with a plist in it and macOS
  ships `sips`, `iconutil`, `codesign` and (with the free Command Line Tools) `clang`. **No
  signing *certificate*, no Apple Developer account** — the amendment above adds an *ad-hoc*
  signature, which costs nothing and identifies nobody. No notarization. No `.dmg`. No
  auto-update. No store. No release binary. No CI release job. **The distribution story is
  unchanged and remains
  `git clone && pnpm install && pnpm run dev`**; the launcher is a convenience for the one machine
  that already has the repository, and it is not a distributable artifact. `release-runbook`
  still gates a cold clone running `pnpm install && pnpm run check`, and does not gate this.
- ⚠️ **ADR-016's stated cost was wrong, and correcting it is part of this decision.** ADR-016
  called a double-clickable app *"a scope change with a $99/yr Apple Developer Program
  prerequisite."* **That is true only for giving the app to somebody else.** Verified on this
  machine (macOS 26.5, arm64) against the bundle this script actually generates:
  | Check | Result |
  |---|---|
  | `codesign -dv "Claude Lens.app"` | *was* `code object is not signed at all` — no certificate, no account, no notarization. ⚠️ **Now `Signature=adhoc`** (see the amendment): still no certificate, no account, no notarization, and the rest of this table is unchanged by it |
  | `xattr -lr "Claude Lens.app"` | `com.apple.provenance` only — **no `com.apple.quarantine`** |
  | `spctl -a -t exec "Claude Lens.app"` | `rejected: source=no usable signature` |
  | Double-click / `open` | **launches, first time, no Gatekeeper prompt, no right-click→Open dance** |

  The last two rows are the whole point and they only look contradictory. `com.apple.quarantine`
  is applied by the *downloading agent* — browser, Mail, AirDrop, `curl -O` — not by the
  filesystem, and **Gatekeeper enforces its assessment only on quarantined files.** A bundle
  built locally by `sips`, `iconutil` and `writeFile` is never quarantined, so `spctl`'s verdict
  is never consulted. The $99/yr is the price of *someone else's* download not being blocked. It
  is not the price of a `.app` on the machine that built it. ⚠️ **The caveat that stood here was
  reasoned backwards; see the amendment at the top.** It read: *"on Apple silicon a Mach-O must
  carry at least an ad-hoc signature to execute — our executable is a shell script, so it does not
  apply."* True as stated, wrong as a conclusion. Being a script did not let us skip a chore; it
  left the bundle **with no code identity**, and TCC has nothing else to attach a
  Files-and-Folders permission to. The executable is now a Mach-O and the bundle is ad-hoc signed
  deliberately. It costs `codesign -s -` — which, as the original sentence already said, is free.
  (The Electron binary it starts remains linker-signed ad hoc by its own npm package; unchanged.)
- **Honest cost — three real things, all of them the price of "thin":**
  1. **It breaks if the repository moves.** The bundle built in place resolves its repository
     from its own location at run time and survives the whole checkout being moved or renamed;
     the copy in `/Applications` cannot, and falls back to the path recorded when it was
     generated. Moving the repository means rerunning `pnpm run launcher -- --install`.
  2. **It is not distributable.** Sending it to anyone is sending a ~70 KB binary that points at
     a directory on *your* disk (a 5 KB shell script, before the amendment). That is not a
     regression — nothing was distributable before either.
  3. **It must be regenerated after an Electron version bump or an `pnpm install`,** which wipes
     `node_modules`. The launcher does not silently paper over this: a missing Electron binary
     is a dialog naming the path it expected.
  4. ⚠️ **(added by the amendment) The best launcher needs a C compiler, and a rebuild resets any
     TCC grant.** The free Xcode Command Line Tools, not Xcode and not an Apple account; with no
     compiler the shell launcher still works and the script says exactly what is lost. And
     because an ad-hoc signature's identity *is* its cdhash, every rebuild is a new identity —
     a Privacy & Security grant has to be given again after `pnpm run launcher`.
  5. ⚠️ **(added by the amendment) It starts `out/`, so it runs whatever was last built.** For
     anyone actively developing this repository — which is everyone who has it — the default
     state between a source edit and the next `pnpm run build` is a launcher that opens the app
     perfectly and silently runs the *previous* build. Nothing crashes, nothing looks wrong, and
     the numbers on screen were computed by older code: the desktop form of a silently wrong
     number. **The launcher therefore detects it and never fixes it.** Before exec it compares
     `out/main/index.cjs`'s mtime against the newest file under `src/` and against
     `package.json`; if source is newer it shows a dialog naming both timestamps and the file
     that is ahead, gives `pnpm run build`, and offers **Open anyway** / **Cancel** — running a
     stale build deliberately is legitimate, running one unknowingly is not. It does **not**
     build, for the reason the original decision already gave: a build can fail and this window
     cannot show you why. It is bounded (`src/` only, `node_modules` and dot-directories skipped,
     symlinks not followed, depth and entry caps) and **fails open**: any scan it cannot complete
     launches normally, because a staleness check that refuses to open the app is worse than the
     staleness. Suppressed by `CLAUDE_LENS_LAUNCHER_NO_DIALOG` and a TTY like every other path,
     which is how both directions are tested.
- ⚠️ **Failing loudly is the load-bearing behaviour, not the icon.** A launcher that bounces
  once in the Dock and dies is the desktop equivalent of a silently wrong number (CLAUDE.md §1):
  the user gets no information and no way to act, and — unlike a terminal — there is nowhere for
  a log line to go. Every failure path therefore ends in a native `display dialog` naming what
  happened and the exact command that fixes it, and exits non-zero: repository not found,
  repository unreadable, `out/` not built, Electron binary missing, `exec` refused. Suppressed
  by `CLAUDE_LENS_LAUNCHER_NO_DIALOG` and when stderr is a terminal, which is how the tests
  exercise all of it without a window server.
- ⚠️ **One of those paths was found by shipping it, and it is the most valuable line here.**
  The first real double-click failed — correctly, loudly — with *"cannot find its source
  repository"*, on a repository that was plainly there. Cause: **a double-clicked app may
  `stat` files on an external or network volume but is refused permission to read them** until
  the user grants access in Privacy & Security, while the same files opened from Terminal are
  already allowed. `[ -f ]` cannot see the difference; only an actual read can. The launcher
  therefore classifies a candidate as `ok`/`missing`/`denied`/`mismatch` and gives `denied` its
  own message about System Settings, because telling somebody to regenerate their launcher when
  the real problem is a privacy setting is confident, actionable and wrong — the same failure
  class this project exists to avoid. ⚠️ **And the message itself then dead-ended, which is the
  amendment above.** It said "grant it under Files and Folders, or add it under Full Disk Access"
  — but Files and Folders has **no `+` button**, and the bundle had no code identity to be listed
  by or granted to in the first place. The classification was right; the remedy was not
  reachable. The message now says plainly that Files and Folders cannot be added to by hand, that
  Full Disk Access is the list with the `+`, and that the grant only takes effect on a fresh
  launch — and the executable it describes is now one macOS can actually attribute a decision to.
- **The icon is part of the designed system, not decoration.** `resources/icon.svg` is committed,
  synthetic, ~3 KB: a six-blade camera aperture in the §6.1 `--grad-violet-cyan` ramp
  (`#7C5CFF` → `#22D3EE`) with the `--glow` halo, on `--bg-app` `#0B0D12`. It is rasterised from
  the vector at each of the ten iconset renditions, so the 16 px Dock image is a true 16 px
  render. **It was designed against real 16 px output rather than judged at 1024**, and two
  drafts failed there: a 30-unit ring/blade gap (0.47 px) fused into a blob, and letting the
  glow show inside the barrel washed the same gap out a second way. The shipped geometry keeps
  four bands legible at Dock size and the blade separators are allowed to vanish. **It is never
  the default Electron atom:** verified via `lsappinfo`, a LaunchServices-launched bundle keeps
  its own identity across the `exec` (`CFBundleIdentifier app.claude-lens.launcher`,
  `LSDisplayName Claude Lens`), so the Dock shows this icon and this name. ⚠️ Running Electron
  straight from a shell — `pnpm run dev`, `pnpm run e2e` — does **not** go through LaunchServices
  and still shows Electron's own identity. That is unchanged behaviour, not a regression, and
  fixing it would mean changing the application rather than the launcher.
- **Rejected:** ***`electron-builder` and a self-contained ~250 MB bundle*** — the obvious
  answer, and the one ADR-016 removed on purpose. Real cost of rejecting: the artifact is not
  self-contained, so it breaks if the repository moves and cannot be handed to anyone (see the
  three costs above). Real cost of accepting: a packaging dependency, its lockfile subtree and
  its security-audit surface back in a project that deliberately has none; ~250 MB of duplicated
  Electron per build; a `.dmg` that is either unsigned — putting every user through the exact
  Gatekeeper right-click dance ADR-016 rejected, and this launcher genuinely avoids — or signed,
  which is where the $99/yr actually applies; and a standing invitation for a later agent to
  "finish" the release pipeline. **All of that to package an app whose only user is the person
  who cloned it.** *Adding the launcher to `pnpm run check`* — inherits macOS-only tooling and a
  prior build; STACK ADR-018's argument applies verbatim and a flaky `check` is worse than none.
  *Copying into `/Applications` by default* — it writes outside the repository, onto the user's
  system; opt-in or nothing. *Committing the generated `.app`* — it records an absolute path to
  the checkout, and P-33 fails the build on exactly that, correctly. *Patching Electron.app's own
  `Info.plist` and `electron.icns` in `node_modules` so `pnpm run dev` also shows the mark* —
  technically safe (that bundle is linker-signed with no sealed resources, so editing it breaks
  nothing) and rejected anyway: mutating `node_modules` from a build script is a surprise that
  survives no `pnpm install`, and it buys cosmetics in a developer command.
- **Constrains:** §9.2 (amended); `.gitignore`; `resources/icon.svg` as the single source of the
  mark; `resources/launcher.c` as the single source of the launcher's behaviour;
  `test/main/launcher/make-launcher.test.ts`, which asserts the bundle is well formed, the
  `.icns` round-trips through `iconutil`, `CFBundleVersion` equals `package.json`'s, the
  generated executable contains **no** absolute path in its *bytes*, the bundle carries a
  verified **ad-hoc signature**, the executable is a **Mach-O wherever a compiler exists** (and a
  valid shell script where one does not), and the failure paths exit non-zero — none of it
  touching `/Applications` or opening a window.
- **Read with:** STACK **ADR-016** (which this amends and does not replace) and **ADR-018**
  (which drew this exact boundary first).
- **Revisit if:** somebody asks for an app they can send to another person. That is a genuinely
  different decision — it needs signing, notarization and the $99/yr this ADR just established is
  *not* required here — and it is a PRD change, not a script change.

### ADR-039 — The harness includes each project's own `.claude/`, and the runtime overlay is built from observed calls  [LOCKED 2026-07-22]

**Status:** LOCKED · **Date:** 2026-07-22 · **Deciders:** the user, explicitly

#### The problem, and how it was found

The Harness Map (§6.7) rendered empty on the user's machine. It was **not** a rendering defect and
not a scanner bug: there was genuinely nothing to scan. Verified directly:

```
~/.claude/skills    0 entries
~/.claude/agents    0 entries
~/.claude/commands  0 entries
~/.claude/plugins   7 entries
~/.claude/CLAUDE.md present (0 bytes)
```

Their skills and agents all live in **project-level `.claude/` directories** inside each repository
— `<project>/.claude/skills/**`, `<project>/.claude/agents/**` — which are outside the Claude data
directory §2.1 defined as *the* harness. So §3.10 correctly produced almost no nodes, §6.7 correctly
rendered "no skills or agents found under this directory", and the user correctly said that was not
what they wanted to see:

> *"there may not be a harness at this level but the projects have a harness. the intent was to see
> in the projects how one orchestrator agent calls skills, calls subagents, agents, and those call
> tools, etc."*

**This is a scope gap, not a defect.** §2.1's "Harness" entry was doing exactly what it said. The
decision below widens what it says, and states the price.

#### Decision

Two halves. The **observed** half needed no scope change at all and carries most of the value; the
**designed** half is the actual extension.

**(a) Observed — build the Map from the transcripts.** §3.10's `harness_nodes.source` CHECK already
admits `'transcript'`, and §2.1's **Agent definition** already reads "a `.claude/agents/*.md` file,
**or a `subagent_type` value observed in an `Agent` tool call**" — a second definition that had
never been implemented. Three node kinds therefore gain a transcript-only form: `tool` (already
built), `skill` (from `tool_calls.skill_name`) and `agent` (from `tool_calls.subagent_type` and from
the sidecar below). A name already declared on disk is **never duplicated** — declared wins, and the
transcript node fills only the gap, because splitting the runtime count off the designed node
destroys the one thing the Harness Map exists for.

§5.9 M-14's `observed` edge set gains two rules beside E11's, all three exact and testable:

| Rule | From | To | When |
|---|---|---|---|
| **O-1** (E11, widened) | `agent` A | `skill` S / `tool` T | a call inside a run whose agent type is A. `Agent` calls carrying a `subagent_type` are excluded and handled by O-2 |
| **O-2** (new) | `agent` A | `agent` B | an `Agent` call with `subagent_type = B` inside a run whose agent type is A |
| **O-3** (new) | `claude_md` `CLAUDE.md` of project P | `agent` B | a **main-loop** `Agent` call with `subagent_type = B` whose `tool_calls.project_id` is P |

An `agent` node's own `metrics.observed` becomes the count of **spawns** of that agent, never the
calls it then made — those are its outgoing edges, and folding them in would silently turn a node
overlay into an edge overlay.

⚠️ **O-3 is the one semantic assumption in this document's edge derivation, and it is stated rather
than buried.** The *join* is exact — `tool_calls.project_id` and the project a `claude_md` node was
scanned from are the same recorded column. The *claim* is that a project's own root `CLAUDE.md` is
what dispatched from the main loop. E11 declined to draw main-loop edges at all because §3.6 records
no skill for a main-loop tool call; that reasoning still holds and no main-loop **tool** edge is
drawn. O-3 is narrower: only `Agent` calls, only to the project's own root `CLAUDE.md` (never a
user-level one, which would make a single node the source of every spawn in the dataset, and never
`CLAUDE.local.md`, which would double every edge). A reader who disagrees should change O-3, not the
query.

**(b) Designed — read `<project>/.claude/**` and the project's root `CLAUDE.md`.**

⚠️⚠️ **Resolving the project path is the crux, and it is not a guess.** **Exactly one** candidate
path is produced per project, by one of two routes, and it is then checked once.

**Route 1 — `events.cwd`, and it is exact.** `projects/<encoded-path>/` is the project directory
with every non-alphanumeric character replaced by `-`. That direction is a function; its inverse is
not. But §3.5 already stores `events.cwd`, so the candidate does not have to be *derived* at all —
it can be **recognised**: a recorded `cwd` whose re-encoding reproduces this project's
`encoded_name` **is** the directory its transcripts were written from. An equality between two
stored columns. Nothing is constructed and nothing is searched for. ⚠️ Reading `cwd` here does not
weaken §3.5's "never rendered, never leaves the database": the value is consumed inside the main
process to decide which directory to open, and it is never rendered, logged, or put on an IPC
payload. If **two distinct** recorded directories encode to the same name (`/x/a-b` and `/x/a/b`
both give `-x-a-b`), there is no way to choose: **skipped, counted `ambiguous-encoding`.**

**Route 2 — the lossy decode, only when route 1 finds nothing.** `-` → `/`, once, with no
alternatives. The name must begin with `-` and contain no empty segment (`--` decodes to `//`, and
both readings can name a real directory — `-work-demo--claude` is `/work/demo/.claude` *and*
plausibly `/work/demo/claude`). Otherwise: **skipped, counted `ambiguous-encoding`.**

The single candidate is then checked:

1. it must be an existing directory. Otherwise: **skipped, counted `directory-absent`.**
2. it must hold `.claude/` or a root `CLAUDE.md`. Otherwise: **skipped, counted `no-harness`.**
3. it must not be, contain or sit inside the Claude data directory. Otherwise: **skipped, counted
   `overlaps-claude-dir`** — `~/.claude` is itself a project on a machine where Claude Code has
   been run from the home directory, and reading it as a project's harness would scan the
   configured root twice and drag the backup root in behind it (INV-14).

**No other candidate is ever produced.** Enumerating the re-segmentations of a hyphenated name and
stat-ing each until one exists would be precisely the **on-disk probing** §2.1's Project entry
forbids ("Zero inference: no on-disk probing, no symlink resolution, no worktree merging, no
repo-root detection"). Recognising a path the data records, or reading the one the encoding names,
is not inference; searching the filesystem for it is. Measured on the user's own machine: the decode
alone resolves **5 of 13**; adding route 1 resolves **11 of 13** — including
`…/demo/Photo-Booth`, `…/demo/Portfolio-Site` and `…/demo/Home-Media-Server`, every one
of which the decode gets wrong. **A skip is a disclosure, never a silent approximation** —
`harness:scan` returns `projectsResolved` and `projectsSkipped` (§4.8, amended).

#### The honest cost

**The app now reads directories outside the configured root.** Everything below is a consequence,
and each one is asserted by a test rather than promised by this paragraph.

- ⛔ **Strictly read-only.** Nothing under a project directory is ever written, moved, renamed or
  deleted. `src/main/harness/projects.ts` opens files for reading and stats them and imports nothing
  that mutates; `test/main/harness/project-harness.test.ts` snapshots every path, size, mtime and
  byte under a project directory before and after a scan and asserts they are identical.
- ⛔ **Outside the guarded-action catalogue.** ACT-01…07 (§5.7, ADR-032) operate only within the
  Claude data directory and this ADR does **not** widen their reach by one path. The catalogue stays
  closed and its targets stay `claudeDir`-relative.
- ⛔ **Excluded from Bloat Radar, analytics, the file manifest and the watcher** — the same
  exclusion the backup root gets (INV-14). `harness_nodes.project_id IS NOT NULL` is the marker:
  such a node is filtered out of `q:skills`, `q:memories` and `q:plugins`, is never handed to
  `detectBloat` (which receives the `claudeDir` node population and no other), never enters
  `file_manifest` (project files are not part of any walk that feeds it), and is never watched (§5.6
  keeps exactly one recursive watch, on `claudeDir`). ⚠️ **A project's skill must never be
  deletable, and must never be counted as bloat** — in particular BR-03 must never report it as
  "installed but never invoked", because that card is the app's opinion about a file in somebody's
  repository that it has no business having.
- ⚠️ **`rel_path` means two things now**, and `project_id` is what tells them apart: `NULL` →
  relative to `claudeDir`; non-`NULL` → relative to **that project**. §3.10's `uq_harness_nodes`
  gains `COALESCE(project_id, 0)` so two projects may declare the same skill at the same relative
  path and stay two nodes — exactly as §3.3 says two projects may share a `display_name`.
- ⚠️ **Parsed harness text is data, never instructions** (STACK ADR-017, §7.8). These are files full
  of agent prompts. They are rendered and counted; never executed, never interpolated into anything
  executable, never sent anywhere. That was already true and is not relaxed by reading more of them.
- ⚠️ **INV-13 is untouched.** The Harness Map still ignores the global filter and is still labelled
  "all time".

#### The defect this uncovered, and the second table

⚠️⚠️ **§3.7's spawn linkage resolves for none of the runs on real data.** §3.7 fills
`subagent_runs.subagent_type` by resolving the run's earliest event's `parent_uuid` against
`events.uuid`. Measured on the user's database: **0 of 2514** runs get a type. Every rule above
needs a run's agent name, so M-14's observed half was structurally empty however many transcripts
existed — 76,018 subagent tool calls producing zero edges.

The name is not missing from disk. Beside every `subagents/<run>.jsonl` sits
`subagents/<run>.meta.json` carrying `agentType`, `description`, `toolUseId` (the spawning `Agent`
call's `tool_calls.tool_use_id`) and `spawnDepth`. Migration `0004-project-harness.sql` adds
**`harness_run_agents`**, a DERIVED table of one parsed fact per run, replaced whole on every scan
beside `harness_nodes` / `harness_edges`. It is **not** an aggregate and does not weaken ADR-027 —
it holds no count, sum or average. The rules read
`COALESCE(subagent_runs.subagent_type, harness_run_agents.agent_type)`, §3.7's value first, so the
day the linkage starts resolving the sidecar becomes redundant rather than a competing second
answer.

⚠️ **Fixing §3.7's linkage itself is deliberately NOT part of this ADR** — it belongs to §5.2's
FINALIZING phase, which this work does not own — and it is recorded here so the next reader knows
the fallback is a fallback.

#### Performance, measured rather than assumed

Both §8 budgets that this touches were **measured against the user's real database** (289,462
events, 87,198 tool calls, 2,514 subagent runs, 554 nodes, 1,029 edges), on a read-only copy:

| Target | Budget | Measured |
|---|---|---|
| **P-12** full harness scan | ≤ 3 s | **≈ 0.6 s** (three consecutive scans: 622 / 601 / 586 ms) |
| **P-11** any `q:*` round trip | ≤ 250 ms p95 | **≈ 170 ms** for `q:harnessGraph` (169 / 172 / 171 ms) |

⚠️ P-11 **failed first, at 530 ms**, and the fix is structural rather than an index alone: each
observed rule now aggregates its tool calls into a `calls` CTE *before* resolving node ids, so the
two index seeks run once per distinct `(project, name)` pair — a few hundred — instead of once per
tool call. `idx_harness_nodes_lookup ON harness_nodes(kind, name, project_id)` (migration 0004) is
the index those seeks use. Node and edge counts are identical before and after, which is what makes
it a restructure rather than a change of answer.

#### Alternatives rejected

- **Leave the Harness Map empty and document it.** Rejected by the user in as many words. It is
  also the wrong answer on the evidence: the orchestration they wanted to see was already fully
  recorded in the transcripts, as *observed fact*, which is stronger than a config file's
  declaration.
- **Search the filesystem for a project directory matching a hyphenated encoded name.** Rejected:
  §2.1's "zero inference". A wrong match would draw one repository's skills under another's name —
  a silently wrong picture, which CLAUDE.md §1 rates as the worst possible outcome. Skipping and
  disclosing is the honest failure. ⚠️ Route 1 above is **not** this: it checks an equality against
  a value the transcripts already recorded, and touches the filesystem only to confirm that the
  one path it recognised exists.
- **Resolve only through `events.cwd` and drop the decode.** Rejected: a project whose events carry
  no `cwd` — an older transcript format, or a project whose rows were parsed before the column was
  populated — would become permanently unresolvable, and the decode still lands for every path
  with no hyphen or dot in it. Two routes, tried in order of exactness, with `ResolvedProject.via`
  recording which one answered.
- **Walk the whole project directory, not just `.claude/`.** Rejected: slow, drags the user's source
  into the app's working set for no analytic gain, and is not what §2.1's "Harness" means.
- **Let project skills into the Harness Manager so they can be managed too.** Rejected outright.
  §6.9's table is wired to the guarded-action catalogue; a row there is a Delete button. The app
  reads project harnesses; it does not administer them.
- **Add `'project'` to `harness_nodes.source`.** Rejected: SQLite cannot ALTER a CHECK, the rewrite
  would touch a table for no gain, and `project_id IS NOT NULL` already answers the question
  precisely while also carrying *which* project.

- **Constrains:** §2.1 ("Harness", amended), §3.10 (amended), §4.8 (`HarnessScanSummary` amended),
  §5.9 M-14, §6.7, §6.9, INV-13, INV-14; migration `0004-project-harness.sql`;
  `src/main/harness/projects.ts`, `src/main/harness/scan.ts`, `src/main/harness/service.ts`,
  `src/main/db/repositories/{harness-graph,graph-stats,harness-manager,analytics}.ts`.
- **Read with:** ADR-020 (never guess a spawn point — O-1/O-2 refuse to attribute an unnamed run),
  ADR-027 (no stored aggregates — `harness_run_agents` holds facts, not counts), ADR-032 (the closed
  action catalogue, which this does not widen) and STACK ADR-017 (parsed harness text is inert).
- **Revisit if:** §3.7's `parent_uuid` linkage is fixed, at which point `harness_run_agents` should
  be measured for redundancy and removed rather than left as a second source; or if `events.cwd`
  becomes reliably present for every project, at which point route 2 (the lossy decode) can be
  measured for redundancy and the disclosure counts should approach zero.

### ADR-040 — The user may DECLARE that two project folders are the same project; the app still never INFERS it  [LOCKED 2026-07-22]

**Status:** LOCKED · **Date:** 2026-07-22 · **Deciders:** the user, explicitly

#### The request

> Let me group a project's metrics: when the same project has lived in two folders (for example
> after moving a repository), let me declare that those two folders are the same project.

Claude Code keys a project on `projects/<encoded-path>`. Moving a repository from one directory to
another therefore produces **two** projects with two separate histories, and every project-shaped
figure in this application splits along that seam: two cards, two treemap slices, two rows in the
marathon leaderboard, two cost bars, and — most importantly — **two active-time partitions**. On the
reporting user's own machine this is not hypothetical; it is why they asked.

#### ⚠️ This is a scope change against a locked decision, and it is recorded as one

§2.1 "Project" says, and continues to say:

> **Zero inference:** no on-disk probing, no symlink resolution, no worktree merging, no repo-root
> detection. Git worktrees and moved folders legitimately appear as sibling projects. No merge
> toggle in v1.

**What that forbade was the app inferring that two folders are one project. This is the user
declaring it.** The two are different in the way that actually matters here:

- A wrong **inference** merges unrelated work silently. Nobody chose it, nobody is told, and the
  first sign of it is a number that is too big for a reason no one can reconstruct. That is
  CLAUDE.md §1's worst outcome, arriving through a helpful-looking door.
- A wrong **declaration** is visible to the person who made it — it is in Settings under their own
  name for it, with the folders listed — and it is undone with one click, restoring every figure
  exactly, because nothing underneath was ever changed.

⚠️ **The zero-inference rule is therefore unweakened, and is restated as a prohibition on the new
feature:** nothing built for this ADR may guess, suggest or auto-detect a grouping. No name
matching, no path similarity, no edit-distance, no "these look like the same project" hint, no
candidates list, and no channel that could grow one. **The user names the group and picks its
members, always.** `test/metrics/f16-grouped-active-time.test.ts` and
`test/renderer/views/projects.test.tsx` both assert this directly, over a fixture whose two folder
names differ by three characters — exactly the pair a heuristic would pounce on.

The last clause of §2.1's paragraph — *"No merge toggle in v1"* — is the one sentence this ADR
supersedes. §2.1 is amended in place and points here.

#### Decision

1. **A new noun, `Project group`** (§2.1): a set of **Projects** the user has declared to be one
   project. And a second, `Project unit`: the thing every project-shaped metric groups by — the
   **Project group** when the project is in one, otherwise the **Project** itself.
2. **Two new USER-class tables** (§3.19, migration `0007-project-groups.sql`): `project_groups` and
   `project_group_members`.
3. **⚠️ Membership keys on `encoded_name`, never on `projects.id`.** See the trap below.
4. **The unit id space.** A unit id is `projects.id` for an ungrouped project and `-groupId` for a
   group. `projects.id` is a rowid alias and is always `>= 1`, so the negative half of the integer
   line is free and the two can never collide; `0` is used by neither. `GlobalFilter.projectIds`
   carries unit ids and is expanded to real project ids in exactly one place,
   `DatasetService.queryContext()`.
5. **The group is the unit everywhere a project appears** — the Overview tile, the working-day
   leaderboard, the project cards, the treemap, the cost breakdown, the tool mix, the sessions
   table's project column, the Flow Sankey's first stage, and the global project filter.
6. **The folders stay visible underneath.** `ProjectCard.members` carries each folder with the
   numbers it has *on its own*, and §6.8 renders them when a group's card is opened.
7. **Ungrouping restores the prior state exactly** — asserted, not asserted-to-be-obvious, by a
   byte-comparison of seven payloads before and after.

#### ⚠️ Trap 1 — membership on `projects.id` would silently re-point every group

`projects` is **DERIVED** (§2.2). §3.18's purge runs `DELETE FROM projects WHERE id NOT IN (SELECT
project_id FROM sessions)` and ingest re-inserts the rows afterwards — **with different surrogate
ids**, because `id` is an `INTEGER PRIMARY KEY` rowid alias handed out by SQLite, not a fact about
the folder.

A `project_group_members(project_id)` column would therefore, after any `claudeDir` change or
explicit rebuild, name whichever projects happened to land on those integers. **That is a merge
nobody asked for, with no error, no marker and no way for the user to see it** — the exact failure
this document is built to prevent, reached by a column choice that looks perfectly ordinary in
review.

`encoded_name` is the identity (§3.3, `UNIQUE`) and is a property of the directory on disk, so it
survives every purge and rebuild unchanged. It is also the **primary key** of the membership table,
which makes "a project belongs to at most one group" a property of the schema rather than of a
check someone can forget. Ids are resolved at query time by `PROJECT_UNIT_CTE`.

⚠️ **There is deliberately no foreign key to `projects`.** `ON DELETE CASCADE` would delete the
user's groups during a purge; `ON DELETE RESTRICT` would make the purge fail. Either way a USER
fact would be governed by a DERIVED table's lifetime, which ADR-026 exists to prevent. A membership
row naming a folder that is not currently present is legal, meaningful and **shown** ("not currently
present — nothing has been lost"), never deleted on the app's own initiative.

#### ⚠️ Trap 2 — grouping changes active-time arithmetic, and it must change it in the right place

M-07 binding **(C)** partitions by `(local day, project)` and sums those groups (M-08, ADR-036).
Merging two projects **changes the partition**: a gap *between* the two former folders on the same
local day is now *inside* one partition, so it is capped at the idle threshold and **counted**,
instead of being two separate streams that each drop it at their edge. That is the correct
behaviour — they are one project — and it has three consequences that are stated here rather than
left to be rediscovered:

- ⚠️ **The grouping is applied when the partition is FORMED, not by summing two projects' finished
  results.** `PROJECT_UNIT_CTE` is joined inside the innermost `scoped` CTE of
  `src/main/db/repositories/active-time.ts`. Summing afterwards gives a different, wrong number, and
  it is the same class of mistake fixture F-12 exists to catch. **F-16** pins it with a
  hand-computed expected value and a `not.toBe()` on the naive sum.
- **INV-21 still holds** — the Overview figure equals the sum of the working-day rows *under the
  grouping* — and is verified by a test, not by inspection.
- **M-20 also changes.** Fewer distinct projects means fewer distinct partitions and therefore less
  overlap; a scope containing one group and nothing else reports overlap **`0`** by INV-22(d),
  because a group is one project. F-16 asserts the drop over F-13's own fixture: 15m → 0.

⚠️ A **second, differently-partitioned** reading of M-07 exists and has exactly one caller: the
`folders` half of `ActiveTimeRepository.byWorkingDayViews()`, which computes each folder's own
active time for §6.8's member list. It is computed only over the folders the user actually grouped,
because for every other folder the two partitions are the same partition and the unit row already
*is* the folder row — a de-duplication of work, never of meaning.
**It is not a surface's number and it never sums to the group's.** §6.8 states
that on screen, in plain words, beside the list — because two columns of numbers that look like
they should add up and do not are a defect of the same family as a wrong number (CLAUDE.md §1a).

#### The honest costs

- **A third partition-shaped concept exists.** M-07 already had three bindings and two of them are
  routinely confused; the unit adds a *column* choice on top of the partition choice. Mitigated by
  putting the unit in exactly one SQL constant that every project-shaped query imports, but it is a
  real increase in what a reader has to hold.
- **`ProjectCard.encodedName` became nullable.** A group is not a directory and has no folder name,
  and §3.3's "the encoded name disambiguates two projects sharing a display name" no longer has an
  answer for a group. The filter and the card fall back to listing the folders, which is longer.
- **The Harness Map and the harness half of §6.7 are NOT grouped.** ADR-039 scopes harness nodes to
  a real project *directory*: `<project>/.claude/**` belongs to that folder and to no other. A group
  is an analytics unit, not a directory, so grouping it there would attach one folder's skills to
  another folder's path. Left per-directory deliberately; recorded here so the asymmetry is a
  decision rather than an oversight.
- **A group can outlive its folders.** Deleting a project directory leaves a membership row naming
  nothing. It is shown as such and never auto-removed, which means the Settings list can accumulate
  entries the user has to tidy themselves. Auto-removal was rejected: it would delete a user's
  decision because a drive was unmounted.
- **Two groups cannot be nested or overlapped.** A project is in at most one group. This was chosen
  for the schema's sake and because the request does not need more; a project that is genuinely two
  things at once has no representation.

#### Rejected

- **Inferring the grouping** (name similarity, `events.cwd` proximity, git remote). Rejected
  outright and permanently: it is the thing §2.1 forbids, and every variant of it fails the same
  way — silently, in the direction of a bigger number.
- **Suggesting a grouping for confirmation.** Superficially safe, and rejected: a suggestion the
  user accepts without checking is an inference with a click on it, and the suggestion itself has to
  come from a heuristic that §2.1 does not permit us to write.
- **Rewriting `events.project_id` to point at one surviving project.** It would make every query
  work with no changes at all — and it is destructive, irreversible without a re-parse, and it
  breaks the promise that ungrouping restores the prior state exactly. Rejected on ADR-026 grounds:
  a DERIVED row rewritten from a USER decision is no longer derivable.
- **A ninth navigation item for grouping.** Rejected by the user: the action belongs where the
  project cards are, and the management belongs with the other things they decided themselves.
- **Storing the group's active time.** Rejected by ADR-027 — no stored aggregates, ever.

- **Constrains:** §2.1 ("Project", amended; "Project group" and "Project unit", new), §2.2 (USER
  row), §3.3, §3.18, §3.19 (new), §4.2 (`GlobalFilter`), §4.5 (`ProjectCard`, `ProjectCardMember`,
  `ProjectGroup`, `groups:list|create|rename|ungroup`), §5.9 M-07/M-08/M-20, §5.9.1 fixture
  **F-16**, INV-12, INV-21, INV-22, §6.8, §6.10; migration `0007-project-groups.sql`;
  `src/main/db/repositories/project-groups.ts` and every project-shaped query that imports
  `PROJECT_UNIT_CTE`.
- **Read with:** **ADR-036** (the partition this changes), **ADR-037** (the overlap it reduces),
  **ADR-026** (why the tables are USER and never purged) and **ADR-033** (the class system they join).
- **Revisit if:** the user asks for a project to belong to more than one group, or for a group of
  groups. Both are genuinely different decisions about what a project *is*, and both are PRD
  changes rather than schema changes.

### ADR-041 — A second road into RETAINED: history from a VANISHED transcript is kept, not deleted  [LOCKED 2026-07-22]

- **Decision:** when a transcript disappears from `<claudeDir>` — Claude deletes it, the user
  deletes it, a volume unmounts — its parsed history is **kept**, not deleted. §5.3's `MISSING`
  branch, under the new setting `retainOrphanedHistory` (§3.13, **default TRUE**), marks the
  manifest row `file_manifest.retained_orphan = 1` and every session it fed
  `sessions.retained_orphan = 1`, and keeps every `events` / `tool_calls` / `subagent_runs` /
  `file_touches` row — exactly as `ARCHIVED` does. Those rows are **RETAINED** (§2.2): structurally
  derived but no longer derivable, because a rescan will never reproduce a file that is gone. The
  purge predicate (§3.18) spares them alongside archived rows — **both markers, not one** — and
  `auditPurgeStatements` / `db-migration-review` treat a missing `retained_orphan = 0` guard as a
  blocking finding, identical in weight to a missing `archive_id IS NULL`. New migration
  **0009-retain-orphaned-history.sql** (0001–0008 immutable, ADR-007). When the setting is OFF the
  old delete-and-cascade behaviour stands, so a user who wants a pure mirror of `<claudeDir>` keeps
  it. `retainedOrphanSessions` / `retainedOrphanEvents` join §4.6, computed **unfiltered**.
- **Because:** this is the same failure ADR-033 closed for archiving, arriving through a second
  door. Until now the very next sync after a transcript vanished classified it `MISSING`, deleted
  its manifest row, cascaded its rows away, and **silently shrank every lifetime total** — the
  project's defining failure (CLAUDE.md §1). The app's stated bar is *"never destroys data"* (PRD
  "What matters" #4) and non-goal #4 is *"never auto-deletes anything"*; deleting a session's
  derived history because its file disappeared is the same violation the app already refuses for
  the user's own files, so **retain-by-default is the value-consistent choice, not a surprise.** It
  is a *marker distinct from `archive_id`* because the two are not the same fact: `archive_id`
  implies an `archives` row and a recoverable location (ADR-034), whereas an orphan has **no
  archive root, no moved file, no `archives` row and nothing to undo** — the file is simply gone.
  Reusing `archive_id` would have claimed a recoverable location that does not exist, which is the
  "an archive you cannot find is a delete with extra steps" failure (§3.15) inverted.
- **Rejected:** *Reusing `archive_id` for orphans* — real cost of rejecting: a second marker on two
  tables and a second clause in every purge guard. Real cost of accepting: `sessions.archive_id`
  would point at an `archives` row that does not exist, breaking `ON DELETE RESTRICT`, §3.15's undo
  and the Settings archive list — a lie in the schema. *A documented rule instead of a column* —
  the exact trap ADR-033 named: on a multi-month build an unenforced data-safety rule has a
  half-life of weeks and its failure is undetectable; the column makes the mistake mechanically
  checkable. *Extending retention to in-place compaction (SHRANK/REWROTE)* — see the honest limit
  below.
- ⚠️ **The honest limit — compaction is NOT covered (option (b)).** When Claude *compacts* a
  transcript in place — rewriting the file smaller, dropping old messages but keeping the file —
  §5.3 classifies it `SHRANK`/`REWROTE`, deletes the file's rows and re-parses, so the dropped
  messages **are lost.** That is a partial version of the very thing this feature prevents, and it
  was considered: `event_key` dedup (ADR-019) makes a re-parse-**and-merge** (keep old events by
  key, add new ones) *possible*. It was **deliberately not done in v1**, because a compaction can
  also *edit* content, not only drop it, and merge-by-key would then freeze a stale token count or
  model against a uuid that the source rewrote — a silently wrong number, which CLAUDE.md §1 rates
  worse than the loss it would prevent. This feature is therefore scoped to **whole-file
  disappearance (`MISSING`) only**, the disclosure wording says so in words, and the limit is
  stated here rather than half-handled. §11.10 carries the compaction question openly.
- **Constrains:** §2.2, §3.2, §3.4, §3.13, §3.18, §4.6, §5.3, INV-18, ADR-026/033 (the class they
  extend), the `db-migration-review` gate; migration `0009-retain-orphaned-history.sql`;
  `src/main/sync/classify.ts`, `src/main/sync/engine.ts`, `src/main/db/purge.ts`,
  `src/main/db/repositories/manifest-repo.ts`, and the disclosure in
  `src/main/db/repositories/analytics.ts`.
- **Read with:** **ADR-033** (the class this joins), **ADR-034** (archiving, which it is NOT),
  **ADR-019** (the dedup that makes re-appearance idempotent) and **ADR-026** (the purge rule).
- **Revisit if:** the user asks for compaction-dropped messages to be retained too (option (a),
  §11.10), or for a way to bulk-forget retained-orphan history — either would be a deliberate new
  decision, not a tweak.

### ADR-042 — Token and cost totals sum one row per API call, deduplicated at query time  [LOCKED 2026-07-24]

**Status:** LOCKED · **Date:** 2026-07-24 · **Deciders:** the user, explicitly

- **Decision:** every token-usage SUM and every cost in §5.9 (M-02, M-03, M-04, M-05, M-06, the token
  half of M-17, and M-18) is taken over a **one-row-per-API-call** projection of `events`, not over
  raw JSONL lines. The projection: **(1)** group the M-01 population by `message_id`; **(2)** within a
  group the authoritative usage is the **final line's** — greatest `line_no`, calls never spanning
  files — because streaming lines carry partial-then-cumulative usage and an arbitrary line is wrong;
  **(3)** rows with `message_id IS NULL` are **each their own call**, never folded. It is computed
  **entirely at query time**, in one shared CTE (`src/main/db/repositories/api-call-usage.ts`) that
  every summing query reads instead of `events`; a covering index is added by
  **migration 0012-api-call-dedup-index.sql** (0001–0011 immutable, ADR-007). ⚠️ **Storage is
  unchanged. `event_key` and ingest (`ON CONFLICT DO NOTHING`) are untouched (ADR-019 stands): each
  line is still its own row, and a rebuild reproduces them byte-for-byte and recomputes the dedup.**
  Counts of records (M-11 messages, M-12 tool calls, subagent-turn counts) and event moments (M-07/M-08
  active time, M-16 coverage, the §6.3/§6.5 calendars) are per-line and are **not** deduplicated.
- **Because:** migration 0011 measured the effect it could no longer be sized by intuition (CLAUDE.md
  §1): on the reference dataset **187,870 costed rows are 85,234 distinct calls** — cache-read
  24.0B→12.0B, cache-write 778M→291M, output 91M→68M, and the headline cost roughly halves. A total
  that charges one API call N times is a silently wrong number, the project's defining failure, and it
  is now provably large. Summing per call, at the final line's usage, is the arithmetic that matches
  what the provider actually billed. **Query-time, not storage:** doing it in the fact table would
  fight ADR-019's line identity, make a rebuild non-idempotent, and bake a decision into bytes that a
  future correction could not revisit; a CTE keeps the raw records — which §4.6's disclosure still
  reports on — and lets the rule live in exactly one place (CLAUDE.md §1's "every metric defined once").
- **Rejected:** *Deduplicating in `events` at ingest (drop all but the final line)* — destroys the
  per-line records §4.6 discloses, makes `event_key`/ADR-019 a half-truth, and turns a rebuild into a
  lossy operation; the whole point of RETAINED/rebuild invariance (ADR-033, F-04) is that nothing is
  silently dropped. *Picking `MAX` per class instead of the final line* — equal to the final line for
  cumulative streaming (the cross-check F-17 pins), but it would silently paper over a non-monotonic
  disagreement that the design wants surfaced as a finding, not averaged. *Choosing an arbitrary line*
  — wrong by construction: 45,895 of 85,234 calls vary across their lines. *Folding `message_id IS NULL`
  rows together* — would collapse unrelated calls and, worse, silently shrink a pre-migration database
  (every row NULL) the instant it upgraded; each NULL row stays its own call until a rebuild fills the
  ids in, which §4.6 discloses as the unchecked/uncheckable population.
- **Constrains:** §3.5, §5.9 M-02/M-03/M-04/M-05/M-06/M-17/M-18, §4.6 (the `repeatedApiCalls`
  disclosure wording), INV-02 (still exact — a call's lines share one origin), the
  `golden-fixture-review` gate; migration `0012-api-call-dedup-index.sql`;
  `src/main/db/repositories/api-call-usage.ts` (the seam) and the summing queries in `cost.ts`,
  `event-stats.ts`, `session-stats.ts`, `project-stats.ts`, `graph-stats.ts`; fixture **F-17**.
- **Read with:** **ADR-019** (line identity, which this does NOT change), **ADR-023** (the picoUSD
  cost path it feeds), **ADR-027** (query-time aggregation only — this is exactly that), and migration
  **0011** (which measured the effect and deferred the decision to here).
- **Revisit if:** Claude Code stops repeating `usage` across a call's lines (the dedup becomes a
  no-op but harmless), or a case appears where the final line is NOT authoritative — either is a
  deliberate new decision, and F-17's cross-check is the tripwire that would catch the latter.

---

# §11 — Not yet specified (the honest register)

Every entry is classified **BLOCKING** or **DEFERRABLE**. Every entry is a future story, not a TODO.
An entry is closed only by real specification — never by quietly writing the missing part into §3 or
§5 later without saying so. **Closed entries are kept, not deleted: the history of what was once
unknown is worth keeping.**

**No BLOCKING entries remain.** Four DEFERRABLE entries stand and none blocks planning.

## §11.1 — Which events a session's active time is computed over

**Status:** ✅ **SPECIFIED in §5.9 M-07, M-08, M-10 and ADR-035** (was BLOCKING, resolved 2026-07-20
by OQ-013).
**Resolution:** **both origins.** Active time is computed over all a scope's events —
`origin IN ('main','subagent')` — merged into one timestamp-ordered stream before gaps are capped.
The user's framing: they were at the keyboard while those subagents ran, so it is real time on task,
and it is consistent with the roll-up already decided for tokens and messages. The structural argument
that settled it: adding events to a stream can only shrink gaps, never invent them, so the inclusive
reading cannot over-count, while main-only demonstrably under-counts.
**Kept as history because:** the ambiguity was real and invisible — `HANDOFF.md` §5 defines active
time without naming its event set, and OQ-006 fixed the roll-up only for "token and message totals".
Anyone who re-reads those two sources will find the same silence and may re-derive the wrong answer.
M-07 now states the set explicitly, and **fixture F-01 pins the number the two readings disagree
about**, so a regression cannot pass quietly.

## §11.2 — "Archive old sessions" — the guarded action, and BR-05's action

**Status:** ✅ **SPECIFIED in §5.7 ACT-07, §3.15, §3.18, ADR-033, ADR-034** (was BLOCKING, resolved
2026-07-20 by OQ-014).
**Resolution:** archiving is **in v1**, as the "keep the rows" option: transcripts move to a
user-chosen `archiveRoot` outside the Claude data directory, and their parsed rows are **RETAINED** so
every metric is unchanged. Full guarded treatment, fully undoable, never auto-deleted.
**Kept as history because:** the reason this was blocking is exactly the consequence that had to be
engineered around, and it is not obvious from the resolution alone. Retaining rows whose source file
has left `<claudeDir>` breaks ADR-026's two-class persistence model — the rows *look* rebuildable and
are not — so every existing rebuild path would have deleted them and **shrunk lifetime totals
silently**. That is why ADR-033 introduces a third class as a *column* rather than a convention, why
§5.3 has an `ARCHIVED` classification that must never fall through to `MISSING`, and why F-04 tests a
full purge-and-rebuild rather than just the happy path. A future agent tempted to "simplify" the
`archive_id` guards should read this entry first.

## §11.3 — The default price-table fetch URL, and any third-party document adapter

**Status:** ✅ **SPECIFIED in §3.13 and §6.10** (was DEFERRABLE, resolved 2026-07-20 by the user).
**Resolution:** `priceFetchUrl` **ships empty** and the fetch button stays disabled until the user
fills it. Settings shows static help text naming a **verified** community-maintained source the user
may paste. Recorded rationale: **no third-party trust is baked into a published repo — the user opts
into a dependency rather than inheriting one.** The guaranteed-correct path remains the bundled seed
plus manual editing, which is the offline guarantee anyway.
**Verified 2026-07-20, not recalled:** LiteLLM's `model_prices_and_context_window.json`
(`https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`) was
fetched and confirmed to exist, to be valid JSON, and to carry the four ORIGINAL token classes for
Claude models as `input_cost_per_token`, `output_cost_per_token`, `cache_creation_input_token_cost`
and `cache_read_input_token_cost`, **in USD per token**. ⚠️ **AMENDED 2026-07-22 (A-05)** — there is
now a fifth class, `cache_write_1h`, and this source was verified before it existed: whether it
carries a 1-hour cache-write rate is **unverified**, and an adapter must not invent one (ADR-024).
⚠️ Two further facts that matter downstream: it carries
**no effective-date field**, so any change it produces is dated at fetch time (§5.8); and its shape is
**not** §4.7's canonical shape, so a raw fetch of it fails cleanly with `E_FETCH_SHAPE`.
**Remaining, and deliberately separate:** an **adapter** for that shape is not in v1. It is its own
small story, kept out of the fetch story so it cannot smuggle a schema guess into it. Nothing depends
on it — the field simply stays empty until someone writes it or pastes a §4.7-shaped document.
⚠️ This is also where the ADR-023 amendment came from: verifying the source surfaced a real
`3.125e-07` USD/token rate that the originally-locked nanoUSD unit could not represent.

## §11.4 — `stats-cache.json`'s field-level schema

**Status:** NOT SPECIFIED — **DEFERRABLE**
**Why:** verified sources establish that the file contains daily activity and lifetime token totals
(`DESIGN_INPUT.md` §2) but document no field names. §3.15 therefore stores each day's object verbatim
and uses only day-presence, and ADR-029 forbids any of its values reaching a displayed metric.
**Blocks:** nothing. Coverage marking works from day-presence alone.
**Needs:** the real shape, established by inspection against real data, **if** a cross-check panel is
ever wanted. It is not in the eight views (OQ-101 closed), so there is no v1 story for it.

## §11.5 — Restoring an arbitrary older restore point, and un-archiving an older archive

**Status:** NOT SPECIFIED — **DEFERRABLE**
**Why:** `DESIGN_INPUT.md` §6.3 specifies "undo for the last action", and §5.5 implements exactly
that. Restore points accumulate forever (OQ-103) and Settings shows their count and total size, which
makes "restore that one from Tuesday" an obvious next want — but the semantics of restoring an old
point over a tree that has changed since are not specified, and guessing them in a delete-capable app
is not acceptable. **OQ-014 extends this entry rather than creating a new one:** ACT-07's *undo* is
specified, but **un-archiving an archive from three months ago** — after the tree has moved on — has
the identical unspecified conflict semantics.
**Blocks:** nothing. Single-level undo is fully specified for every action including ACT-07. The
audit trail records every restore point's path, and `archives` records every archive root's absolute
path and contents, so a user can move files back by hand today and re-sync.
**Needs:** one decision on conflict semantics (overwrite / merge / refuse-if-changed), applied to both
cases, then a story. The two should be specified together — they are the same problem.

## §11.6 — Reconciling a deduplicated event when its winning source file is deleted

**Status:** NOT SPECIFIED — **DEFERRABLE** ⚠️ *(safety argument weakened by OQ-014 — see below)*
**Why:** ADR-019 dedupes by `event_key`, and §3.5 deletes rows by `source_file_id` when a file
disappears. If the same record genuinely existed in two files, the copy that lost the dedup race is
not re-inserted when the winner's file is removed, so that event vanishes until a full re-sync.
Whether this can happen at all depends on whether sidechain records are duplicated between a parent
transcript and its `subagents/` file — which no verified source states either way.
**What OQ-014 changed, stated plainly rather than left to be discovered:** archiving does **not**
make this worse in the common case — ACT-07 deletes no manifest rows and no events, moves each
session's transcript and `subagents/` directory **together** (INV-20), and the `ARCHIVED`
classification never falls through to `MISSING` (§5.3). But it **does remove the universal repair**:
`sync:start { kind: 'full' }` no longer re-reads archived files, so a duplicate whose *winner* was a
live file and whose *loser* sits in an archived file is no longer self-healing. Reaching that state
requires all three of: real cross-file duplication, **across two different sessions** (INV-20 rules
out the within-session case), and deletion of the live winner. The consequence is a small undercount,
never a loss of archived history.
**Blocks:** nothing, and no story invents anything — the behaviour is fully specified (dedup by key;
`MISSING` deletes by `source_file_id`; archived files are never re-read). It is a known, bounded,
documented residual rather than a hole.
**Needs:** first, an observation of whether cross-file duplication occurs in real data at all — which
would also retire ADR-019's motivating uncertainty. If it does, the closing move is already identified:
a **read-only reconcile pass** over *reachable* archived files during a full re-sync, re-asserting
their `event_key`s without re-parsing them into rows, skipped silently when the archive root is
unreachable.

## §11.7 — Graph rendering above the node cap

**Status:** NOT SPECIFIED — **DEFERRABLE**
**Why:** §8.5 P-23 caps rendered nodes at 500 with a "showing top 500" label, but the *ranking* used to
choose the top 500 is specified only for the Harness Map (by `observed`) and not for Execution Trace
(a session with hundreds of subagent runs) or Tool Transition.
**Blocks:** nothing. The cap and the label are specified, and every graph in the reference dataset is
well under it — 33 tool nodes, and the largest observed spawn tree is far below 500.
**Needs:** a ranking rule per graph, when a real dataset first exceeds the cap.

## §11.8 — The partition for an Active-hours figure spanning more than one session

**Status:** ✅ **SPECIFIED in §5.9 M-07 binding (C), M-08, INV-21, fixture F-12 and ADR-036**
(was an **unregistered** under-specification, resolved 2026-07-21).
**Resolution:** the partition is **M-08's `(local date, project_id)` group, summed** — not a sum over
sessions, not one global stream. Intra-day inter-session gaps are capped and counted, so the Overview
tile and the working-day leaderboard agree by construction.
**Kept as history, and this entry is the point of the section:** M-07 shipped with a literal unfilled
`PARTITION BY <scope>` placeholder. The design bound it in two places — a session, and M-08 — and the
Overview *Active hours* tile is a **third** that had nothing to cite. ⚠️ **The absence of this entry
from the register was itself the defect.** Had an engineer picked the per-session reading, they would
have passed every acceptance criterion, `golden-fixture-review` and code review, shipped a tile that
diverges on any day with two sessions in one project, and then `docs-sync` would have canonised the
guess **as if it had always been the design** — with nothing left to detect it. It was found only
because someone was forced to hand-compute an expected value for that tile, which is the whole case
for banning `toMatchSnapshot()` in `test/metrics/**` (STACK ADR-012).
**Lesson worth carrying:** a metric definition containing a `<placeholder>` is not a definition. Any
future §5.9 entry with an unbound symbol is a register entry until every surface that uses it names
its binding.

## §11.9 — Active hours can exceed elapsed wall-clock time when projects overlap

**Status:** ✅ **SPECIFIED in §5.9 M-19 and M-20, §4.6 INV-23, §6.3, INV-22, fixture F-13 and
ADR-037** (was DEFERRABLE, resolved 2026-07-21).
**Resolution:** **keep the figure exactly as ADR-036 defines it and disclose the overlap beside it** —
*"N hours of this total overlap across projects"*, rendered when non-zero, nothing when zero.
**ADR-036 is unchanged; the change is purely additive.**
**Rationale the user accepted:** it is **the same pattern the design already uses for uncosted
records** — the figure stays honest by *disclosing*, not by changing — and that consistency is the
main argument, since a reader who has learned one disclosure already understands the other (INV-23 is
the deliberate twin of INV-10). It also adds **no second competing headline number**, which would be
close to the "different per surface" failure the user rejected on ADR-036 an hour earlier.
**Rejected:** label-only (the tile already said "summed per project-day", but a figure larger than the
hours that elapsed still reads as a bug at a glance); a separate "hours at the keyboard" metric (two
numbers about time on one screen, each needing its own name, definition and fixtures); and reopening
ADR-036 (costs the tile↔leaderboard agreement it was chosen for).
**Kept as history, because two things here are easy to get wrong later:**
**(1)** The concern was **not introduced by ADR-036** — the per-session reading it rejected has the
identical property, since *any* partitioned sum double-counts concurrency, and only a deduplicated
stream avoids it. For a single-project day, binding (C) and a deduplicated stream are **identical**.
**(2)** ⚠️ **The obvious formulation of the deduplicated figure is wrong.** "M-07 with one global
partition" yields a **negative** overlap on a two-event-per-project fixture, because capping is applied
per partition and a coarser partition's longer gaps are truncated harder. M-19 is the **union measure
of covered intervals**; the worked counterexample is preserved in ADR-037 so nobody re-derives the
broken version. This was caught by computing it before writing it, not after.

## §11.10 — Retaining messages dropped by an in-place compaction

⚠️ **ADDED 2026-07-22 (ADR-041).** Orphan retention (ADR-041) keeps the parsed history of a
transcript that **disappears whole** from `<claudeDir>`. It does **not** keep messages dropped by an
**in-place compaction** — Claude rewriting a transcript smaller, keeping the file but discarding old
turns. §5.3 sees that as `SHRANK`/`REWROTE`, deletes the file's rows and re-parses, so the dropped
turns are gone. This is deliberately unspecified for v1 and stated as a known limit, not hidden: the
§4.6 disclosure names its own scope as "files no longer in your Claude folder", and ADR-041 records
why merge-on-re-parse (option (a)) was rejected — a compaction can *edit*, not only drop, and
merging by `event_key` (ADR-019) would freeze a stale token count or model against a uuid the source
rewrote, which is a silently wrong number (CLAUDE.md §1). Resolving this means first establishing,
against real data, whether a compaction ever *changes* a retained uuid's usage rather than only
*removing* uuids — the same "establish the format before assuming it" discipline as ADR-028. Until
then the honest answer is the whole-file scope, disclosed. A test in
`test/main/sync/retain-orphaned-history.test.ts` pins the current behaviour so a future change to it
is a deliberate decision, not a drift.

---

# §12 — Definition of done (continuous gates)

These hold at **every** epic boundary, not once at the end. `pnpm run check` proves most of them
mechanically; the rest are dispatched gates from `STACK.md`'s manifest.

## §12.1 Mechanical, on every `pnpm run check`

| # | Assertion | Proven by |
|---|---|---|
| 1 | No personal path, no personal data, no fixture > 256 KB in any git-tracked file | `guard` (P-33) |
| 2 | Formatting is clean repo-wide | `format:check` |
| 3 | **Exactly one network egress point** exists in the source | `lint` (INV-15, P-32) |
| 4 | **The renderer imports no `src/main/**`, no `better-sqlite3`, no `node:fs`/`node:path`/`electron`; SQL text exists only under `src/main/db/**`** | `lint` (INV-16) |
| 5 | `os.homedir()` appears only in `src/main/config/paths.ts` | `lint` (INV-17) |
| 6 | **The IPC contract has not drifted** — main and renderer compile against one channel map | `typecheck` (ADR-031) |
| 7 | Both bundles build, with `better-sqlite3` external and chokidar bundled | `build` |
| 8 | Every test passes across the three Vitest projects | `test` |
| 9 | No `toMatchSnapshot()` under `test/metrics/**` | `lint` (STACK ADR-012) |

## §12.2 Dispatched gates (tier `full`)

| Gate | Holds continuously |
|---|---|
| `regression-run` | The full suite is green at every epic boundary, not only on the story just written. |
| `code-review` | Every story cites the DESIGN section it implements; ADR numbers are cited, never re-argued. |
| `docs-sync` | `DESIGN.md`, `PLAN.md`, `STACK.md` and the public `README.md` match the code. A metric definition changed in code and not in §5.9 is a defect. |
| `db-migration-review` | Every schema change is a new numbered file; merged files are immutable; **no migration or purge touches `price_rows`, `settings`, `audit_log` or `archives`** (INV-12, ADR-026); and ⚠️ **any deletion from `events`, `sessions`, `tool_calls`, `subagent_runs`, `file_touches` or `file_manifest` without an `archive_id IS NULL` guard is a blocking finding** (INV-18, ADR-033). |
| `design-token-lint` | No raw hex/rgb/hsl literal and no raw px spacing value outside `src/renderer/styles/tokens.css` (§6.1). |
| `dependency-security-audit` | `pnpm audit --omit=dev` clean of high/critical (P-35). |
| `golden-fixture-review` | **Every story adding or changing a parser path, a metric definition, or a costing rule lands a fixture with a hand-computed inline expected value.** The named checklist is **§5.9.1 F-01…F-11**, and in particular: **F-01** active time across a subagent run (pins ADR-035 — a main-loop-only fixture proves nothing), **F-02** subagent roll-up (INV-02), **F-03** incremental == cold parse (INV-04), **F-04** archive survives re-sync *and* purge-and-rebuild (INV-18), **F-08/F-09** costing across a price change and with no applicable price row, **F-10** rate precision at `$0.3125/Mtok` (ADR-023 as amended), **F-12** aggregate active time across two sessions in one day (pins ADR-036's binding (C) and INV-21 — a one-session-per-day fixture proves nothing), **F-13** cross-project overlap in both the non-zero and zero cases (pins ADR-037, M-19/M-20 and INV-22 — a fixture whose overlap is incidentally zero proves nothing)., **F-14** active time on millisecond timestamps (pins M-07's unit clause — every other fixture places every event on a whole minute, so none of them can see a ms→seconds conversion bug). |
| `guarded-action-review` | Every story touching `src/main/actions/**` demonstrates, with a test: confirm → **backup before mutate** → undo → audit entry; the backup-root exclusion from Bloat Radar, analytics and the watcher (INV-14); and that **nothing is ever auto-deleted, including backups**. For **ACT-07** additionally: the restore point is a verified move manifest (INV-07), a session's transcript and `subagents/` never split across roots (INV-20), `archiveRoot` is never inside or a parent of `claudeDir` (INV-19), **no metric changes across the archive** (INV-18), and **nothing under the archive root is ever deleted by the app**. |
| `perf-profiling` | ⚠️ **Specified by §8; gate NOT yet built (status 2026-07-24).** Targets **P-01…P-37** (35 in §8.2–§8.7 plus P-36/P-37 for ACT-07 archiving) are measurable and failable, but no `scripts/perf/` harness or `.claude/skills/perf-profiling/` gate exists yet — measurement has been ad-hoc. P-08 (200 ms) is the DuckDB trigger; P-13/P-14/P-15 are the nine-hour steady-state targets that the always-open trigger makes load-bearing. |
| `e2e-smoke` | `pnpm run e2e` at epic boundaries: the app launches, onboarding accepts a fixture directory, a sync completes, **all eight views navigate and render** without an error boundary or console error, and the theme toggle flips `data-theme`. Read-only by construction — it never invokes a guarded action. **Fails loudly; never skips.** |
| `release-runbook` | A **cold clone on a machine with no prior state** runs `pnpm install && pnpm run check` green, plus one `pnpm run e2e` run. Authored from STACK ADR-016 + ADR-006 — **not** a substituted deployment template; there is no deploy target. |

## §12.3 Product-level done

- Every metric in §5.9 has a golden fixture with an inline hand-computed expected value.
- Every view in §6 renders its loading, empty, error and offline states, verified against an empty
  directory and against a directory with no covering price rows.
- Every `$` figure in the running app is accompanied by its uncosted disclosure (INV-10), and a `$0.00`
  never appears where the truth is "no pricing configured."
- The guarded-action cycle round-trips on a sandbox tree: preview → confirm → backup → delete → undo →
  restored, with the audit entry correct at every step.
- **Archiving round-trips and moves no number:** archive a session, re-sync, purge and rebuild, then
  undo — every §5.9 metric is byte-identical at each step, the session shows an "archived" badge in
  between, and Settings names where its transcripts went (INV-18, F-04).
- The app survives a nine-hour idle window inside P-13/P-14/P-15, and appending to a transcript while
  it is open moves the numbers within P-04 **without stealing focus or re-animating a chart**.
- `README.md` explains what it is, prerequisites, `pnpm install && pnpm run dev`, how to set the data
  directory, the measured parse time, the source-only distribution note, and the single-egress
  guarantee. No personal path appears in it.
