# PRD — Claude Lens

> Interview complete, across two rounds. Everything below is either confirmed by the user or
> carried from their own pre-kit design material (`docs/source/DESIGN_INPUT.md` §1 locked decisions,
> `docs/source/HANDOFF.md` §2–§5 and §9, `docs/source/FRONTEND.md`, and the working prototype at
> `Claude Lens frontend prototype/Claude Lens.dc.html`). Locked items are not open for
> re-litigation. In round two the user elected to decide every previously-reserved item rather than
> leave it for the build, so "Deliberately undecided" is deliberately short.

## What

Claude Lens is a local **Electron + React + Vite + TypeScript** desktop app that parses a user's
Claude Code data directory (default `~/.claude`) — transcripts under `projects/**/*.jsonl`,
`history.jsonl`, `stats-cache.json`, `file-history/`, and the harness config surface — into an
**embedded SQLite** database, and renders it as a vibrant analytics dashboard: tokens and real
dollar cost, sessions and time, tools and agents, projects and code. On top of that it adds
**interactive graph views** of harness workflow ("what calls what, when") and a **guarded Harness
Manager** with a **Bloat Radar** that can delete and clean — always behind a confirm dialog, an
automatic backup, an undo, and an audit trail. It is designed to be **left open all day** on a
second monitor, live-watching the Claude data directory and updating as the user works. It ships as
source and runs via `pnpm run dev`.

## Who

One person: a heavy solo Claude Code user who runs long agentic sessions across several personal
projects and has accumulated ~1 GB of transcripts and a sprawling harness (skills, plugins,
CLAUDE.md files, memories) that they cannot see the shape of.

Single user, single machine, one dataset at a time. Not a team tool, not multi-tenant, no accounts.
The repo is shared publicly, so *other* people will run it — but each of them is also a single user
pointed at their own directory. The app must therefore be path-agnostic and contain no personal
paths or data.

## The daily loop

**The trigger is not "opening the app." The app is already open.** The user confirmed this as the
sole recurring trigger, rejecting end-of-session, cost-worry, and diagnosis. Claude Lens lives on a
second monitor next to the editor and Claude Code, from the start of the day to the end of it, and
updates itself while the user works elsewhere. This is architectural, not cosmetic — see
"What matters" #2 and #3.

**The common day (this is the path to optimise):**

1. **08:55 — one cold launch.** The window opens on Overview. Auto-sync runs once; only files
   changed since yesterday are read. Charts are populated in well under a second. This happens
   **once a day**, not once an hour.
2. **09:00–18:00 — the app is idle-but-live, for nine hours.** The user is working in Claude Code,
   not in Claude Lens. The file-watcher sees each transcript append, debounces ~500ms, seeks to the
   saved byte offset, ingests only the new lines, and pushes an update. The window must sit at
   effectively **zero idle CPU** and **flat memory** across the whole day. It is in peripheral
   vision, so nothing may flash, jump, or steal focus.
3. **Many times a day, 3–8 seconds each — the glance.** The user's eye moves to the second monitor
   mid-task, without clicking anything. They read the Overview hero tiles: output tokens, dollar
   cost, active hours, tool calls. The question is *"is this session costing what I think it's
   costing?"* Then their eye goes back to work. **No interaction at all.** This is the single most
   frequent interaction with the product, and it requires the numbers to be correct and current
   *without being asked*.
4. **A few times a week, 30–90 seconds — the drill.** A number on the glance looks wrong or
   surprising. The user clicks into Tokens & Cost: which project ate the output tokens (treemap),
   how much went to subagents rather than the main loop (the split), what that costs in dollars at
   the prices that were in effect at the time. Or into Sessions & Time for span-vs-active on today's
   marathon. They get an answer and go back to work.
5. **Weekly-ish, 5–10 minutes — harness hygiene.** A separate loop with a different trigger
   (housekeeping mood, or a disk-space nag). Harness Manager → Bloat Radar → "installed but never
   used" skills → reclaim disk, prune dead config, each behind a guarded action.
6. **Rarely, and this is the payoff visit — the graphs.** Answering something with no other source:
   which of the skills they built are actually invoked, and what a session's spawn tree really
   looks like.

**Abandonment budget:** the first-ever run — a cold parse of ~1 GB / 2,064 files / 236K records —
must not exceed ~30s (target < 10s), must run in a worker thread, and must show progress rather
than a frozen window. Every launch after that is incremental. The steady-state, always-open case
must never degrade over a nine-hour day.

## The moment of value

**Seeing where the compute actually went: the main-loop vs subagent split.** 175K subagent
messages and 36M output tokens — roughly 72% of the total — were spent by agents the user never
directly watched. No other tool shows this, and it is invisible from inside Claude Code itself.

*Recorded honestly:* the user's first answer was "all of them," and this ranking emerged only under
a forced choice. The other three — the Harness Map's designed-vs-actual, true active hours, and
Bloat Radar reclaim — were all rated as genuinely mattering and rank below this one only because a
choice was demanded. Do not treat them as low-value. The consequence for sequencing is that
**Tokens & Cost is first among equals** among the eight views.

## What "wrong" looks like

**A silently wrong number.** The dashboard shows a total that looks entirely plausible and is
incorrect — subagents double-counted against their parent, records silently dropped, `<synthetic>`
assistant records included in model stats, cache-read tokens leaked into a headline "total," bad
idle-gap math inflating active hours, a `$` figure that quietly omitted every record it had no price
for, or historical usage costed at today's prices. Nothing crashes. The app is simply lying,
beautifully, and the user trusts it. This is the worst outcome because it is undetectable from
inside the app, and because the entire point of the product is to be believed.

**This is the project's defining quality bar, and it is a gate, not a hope.** It must show up
downstream as a hard requirement, not an aspiration:

- **Golden-fixture tests over the parser and over every metric definition are mandatory.** Each
  metric in `docs/source/HANDOFF.md` §5 — session span, active time (idle-capped), output tokens as
  cost proxy, longest-session-by-active — gets a fixture with a hand-computed expected value
  committed under `test/fixtures/`.
- The subagent roll-up (see Domain language) must have an explicit test proving totals are neither
  double-counted nor dropped.
- The incremental append fast-path must have a test proving that appending a line to a fixture
  ingests **only** that line, and that the resulting totals equal a from-scratch parse of the same
  file. Incremental and cold parse must be provably identical.
- Malformed JSON lines, `<synthetic>` records, and ms-epoch vs ISO timestamp normalisation each get
  a fixture.
- Costing gets two: one fixture spanning a **price change**, proving usage is costed at the price in
  effect at the record's timestamp; and one containing **records with no applicable price row**,
  proving they are excluded from `$` totals *and* surfaced in the UI rather than zero-filled.

## What matters (ranked)

1. **Numeric honesty above everything.** Every headline metric is defined, labeled, reproducible,
   and covered by a golden fixture. Output tokens are the cost proxy and are never silently mixed
   with cache reads. Partial-data periods are marked partial, never shown as zero. Every `$` figure
   discloses what it could not cost.
2. **Correct while unattended.** The product's most common interaction is a 3-second glance at a
   number nobody asked to be refreshed. Live file-watching and incremental sync are **core
   architecture**, not a refinement, and their correctness matters as much as their speed.
3. **Well-behaved over a nine-hour day.** Near-zero idle CPU, flat memory, no focus stealing, no
   visual thrash. A watcher that leaks or spins is a product defect, not a performance nit.
4. **Never destroys data.** Read-only by default. The only writes to the Claude data directory are
   guarded actions: confirm + backup-before-delete + undo + audit log. The app never deletes
   anything on its own initiative — including its own backups.
5. **Looks like one designed system.** `docs/source/FRONTEND.md` is binding; the prototype is the
   visual target. Vibrant, dark-first, light-aware; legibility beats decoration.
6. **Path-agnostic and publicly shareable.** No personal paths, no personal data, exactly one
   permitted network egress point (below).

## In scope, and notably beyond the source docs

Two interview decisions **add scope** relative to `docs/source/DESIGN_INPUT.md`, which specified
tokens and a relative cost proxy only. They are recorded here rather than folded in silently.

### Real dollar costs, priced by effective date — NEW

The user asked for real cost estimates, verbatim: *"yes I want real estimates but only if we can
actually refresh the price, we should keep track of prices. meaning when they changed etc..."*

> **Load-bearing fact, stated to the user and accepted: there is no official, stable,
> machine-readable Anthropic pricing endpoint.** This is *why* the design below looks the way it
> does. Without this fact recorded, a later agent will "simplify" the design by assuming an official
> API exists and building against something that does not.

**Price source — bundled seed, user-editable, configurable fetch URL.**

- A **JSON price table ships in the repo**, correct as of build date. This is what a fresh clone
  runs on.
- **Every price row is editable in Settings.** Manual entry is a first-class path, not a fallback.
- A **user-triggered** refresh fetches from a **URL configured in Settings**, defaulting to a
  community-maintained pricing JSON. This is the single permitted network egress point (below) —
  the two rules are the same rule and must stay consistent.
- The app is **fully functional offline**, degrading to the bundled seed plus manual edits. **No
  fetch is ever automatic** — not on launch, not on a timer, not on a cache miss.

**Price history — auto-versioned on change, with hand-correctable effective dates.**

- Each price row carries a validity range. On a refresh **or a manual edit**, the incoming value is
  compared against the currently-valid row; **if any value differs, the old row's validity is closed
  at now and a new row is opened.** History accrues without the user doing anything.
- **Effective dates are hand-correctable**, for the common case where a price changed before the
  user noticed and the auto-generated boundary is therefore in the wrong place.
- **Usage joins to the price row valid at each record's own timestamp — never to today's price.**
  This is the core of what the user asked for and is stated here in exactly those terms.

**Price gaps — uncosted, and loudly visible.**

- A usage record with no price row covering its model **and** timestamp is **excluded from `$`
  totals**.
- The exclusion is shown **next to the figure**: *"N records uncosted (model X, date range Y)."*
- **Never silently zero-fill. Never silently substitute another model's or another period's rate.**
  A `$` total that is incomplete but *looks* complete is precisely the silent wrongness the user
  named as the failure they fear most.

**Cache pricing — four independently priced token classes, stored not derived.**

- Every model has **four** priced classes: **input, output, cache-write, cache-read** — each with
  its own rate and its own effective-dated history.
- Rates are **stored, never derived.** The user explicitly rejected computing cache rates from the
  base input rate via the usual multipliers, because that breaks silently the moment a model
  deviates from the usual ratio.
- Justification, recorded so nobody "simplifies" it away: the dataset carries **3.1B cache reads
  against 64.2M output tokens.** At that ratio, approximating or ignoring cache pricing makes the
  headline `$` figure wrong by a large multiple. This is not a rounding concern.

### Exactly one network egress point — NEW

"Zero network, ever" was **rejected**. The rule is now bounded and testable:

- **Exactly one** outbound call exists in the entire application: the user-triggered price-table
  refresh against the Settings-configured URL.
- Everything else remains fully offline: no telemetry, no analytics, no crash reporting, no update
  check, no remote asset or font fetch, no API calls of any other kind.
- **The app is fully functional with no network at all.** Every view, every metric, every guarded
  action works offline; only the price refresh is unavailable, and it fails with a clear,
  non-blocking error that leaves the existing price table intact.
- This should be enforceable as a test or lint over the source, not merely a policy in a document.

## Explicit non-goals (v1)

**Confirmed by the user:**

1. **Not a transcript reader or search tool.** No message viewer, no full-text search over
   conversations. Session drill-down shows metadata and structure, never a chat log.
2. **Deletes, but never authors.** The Harness Manager removes and cleans. It never writes or edits
   the *content* of `SKILL.md`, `CLAUDE.md`, agent definitions, `settings.json`, or memories.
3. **No diff rendering.** The 39 MB of `file-history/` before/after snapshots produce **metrics
   only** — files touched, churn, languages edited. No syntax-highlighted diff viewer. Rationale the
   user accepted: it is a substantial component on an already ~68-story plan, and "show me what
   changed in this conversation" drifts toward the transcript reader ruled out in #1.
4. **The app never auto-deletes anything, including its own backups.** No retention policy, no age
   cap, no size cap, no silent pruning. Pruning is itself an unconfirmed delete inside an app whose
   entire trust story is "confirm before touching anything."

**Carried from the source documents** (`docs/source/DESIGN_INPUT.md` §11, `docs/source/HANDOFF.md`
§2) — consistent with everything decided above, but not individually re-confirmed in this
interview; provenance noted so it stays honest:

5. **Not a team or multi-machine tool.** One directory, one machine, one person. No merging of
   several people's data, no comparison against anyone else, no accounts. *(HANDOFF §2.)*
6. **No packaged distribution.** No code signing, no notarization, no `.dmg`, no auto-update, no
   store. Source only: `pnpm install && pnpm run dev`. *(DESIGN_INPUT §11.)*
7. **Not a monitor.** No alerting, no threshold notifications, no menu-bar widget, and **no
   background process when the window is closed.** The app is live only while open. *(Implied by
   DESIGN_INPUT §3.3, which scopes watching to "while open.")*
8. **No export.** No CSV, no PDF, no report generation, no share or screenshot feature. Nothing
   leaves the machine. *(HANDOFF §2.2.)*
9. **macOS only in v1.** Windows and Linux are neither tested nor claimed — no CI matrix, no
   cross-platform branching, no support claim. **But no gratuitous lock-in either:** use Node path
   APIs and `os.homedir()` rather than literal `/Users/...` or hardcoded `/` separators, and do not
   reach for macOS-only native APIs without a specific reason. This costs approximately nothing per
   story and keeps a future Linux port a small job rather than an archaeology project. It pairs
   naturally with the path-agnostic requirement.

> Note on two former candidates: "no dollar costs" and "zero network, ever" were **rejected** by the
> user and are now requirements — see "In scope, and notably beyond the source docs." They must not
> reappear as non-goals anywhere downstream.

## Additional architectural constraints from round two

These are not views or features; they are constraints `design-author` must honour.

- **A query seam is mandatory.** All reads go through a repository / query interface. **No view or
  component touches SQL directly.** This keeps a future storage-engine change contained rather than
  a rewrite, and it is the precondition that makes the SQLite decision safe to make now.
- **A falsifiable performance trigger replaces a vague one.** `docs/source/DESIGN_INPUT.md` §3.2
  says to revisit DuckDB "only if aggregation perf demands it," which is unfalsifiable and would
  therefore never fire. The trigger is now numeric: **any dashboard query exceeding ~200ms on the
  full dataset reopens the DuckDB question.** This is a condition to measure against, not a promise
  to switch. `stack-decide` must lock SQLite and must not pre-emptively adopt DuckDB.
- **The backup directory is excluded from Bloat Radar and from all analytics.**
  `<claudeDir>/.claude-lens-backups/` lives *inside* the scanned directory. Without an explicit,
  tested exclusion, the app will flag **its own safety net** as bloat and offer to delete it, and
  will also fold its own backups into disk-size and project analytics. This is a requirement, not an
  implementation note.
- **Settings surfaces backup state:** total backup size and restore-point count, plus an explicit
  **"clear backups"** action which itself goes through the standard confirm-and-audit flow.

## Domain language (draft)

Sharpened during the interview. `design-author` owns the canonical glossary (DESIGN.md §2.1); this
is a head start plus a record of which words were chosen over which rejected synonyms. The four
marked ✅ were live schema forks and are now **decided** — do not reopen them.

- ✅ **Session** — exactly one transcript file, `projects/<encoded>/<session-id>.jsonl`, identified
  by its `sessionId`. Faithful to the data: one file, one row.
  (not: "conversation", "working period", "a day")
  **Session identity is fixed by the file and must never change when the idle-gap setting moves.**
  Sessions are *not* split on idle gaps. Idle-gap stripping applies only to the *active time*
  metric.
  - **Session span** = last timestamp − first timestamp.
  - **Session active time** = sum of inter-event gaps, each capped at the idle threshold (default
    15m, configurable). Both are reported; "longest session" means by active time, with
    longest-by-span shown separately and labeled.
- ✅ **Working day** — the day-level grouping of a project's sessions that the prototype's "Longest
  marathons" board actually shows (`2026-07-12 · Photo-Booth · 21h 37m active`). A distinct noun with
  its own aggregation, **not** a session. Two clean concepts, no collision.
  (not: "session"; "marathon" is UI copy for the leaderboard only, never a schema term)
- ✅ **Subagent run** — one execution of a subagent: an `Agent` tool_use in the parent plus its own
  transcript under `projects/<proj>/<session-id>/subagents/*.jsonl`. It belongs to exactly one
  Session and is not itself a Session.
  (not: "agent", "sidechain", "child session")
  **Roll-up rule (decided): a session's headline token and message totals INCLUDE its subagent
  runs.** One session is one unit of work, whatever it spawned. The parent↔child link
  (`parentUuid` / `isSidechain` / the `subagents/` folder) is **always stored**, so any view can
  split main-loop from subagent compute on demand — which is exactly what the moment-of-value view
  does. Double-counting here is the headline correctness risk and gets a dedicated test.
- **Agent definition** — an agent *kind*: a `.claude/agents/*.md` file or a `subagent_type` value.
  Distinct from a **Subagent run**, which is the instance. Never write bare "agent" for either.
- ✅ **Project** — exactly one `~/.claude/projects/<encoded-path>` directory. **Zero inference:** no
  on-disk probing, no symlink resolution, no worktree merging, no repo-root detection. Git worktrees
  and moved folders legitimately appear as sibling projects. No merge toggle in v1.
  (not: "repo", "codebase", "workspace")
- **Tool call** — one `tool_use` content item inside an assistant record. The headline count
  (65,438 across 33 distinct tools) **includes** `Agent` and `Skill` dispatches — those are tools.
  Wherever the UI says "tool calls," that is what it means.
  (not: "action", "invocation", "step")
- **Skill invocation** — a tool call whose tool name is `Skill`. A subset of tool calls, not a peer.
  Cross-referenced against the installed skill set to produce "installed but never used."
- ✅ **Harness** — **the user's Claude Code configuration surface that this app analyzes**: CLAUDE.md
  files, `skills/**/SKILL.md`, agent definitions, plugins, marketplaces, `settings.json`, memories.
  The sidebar item stays "Harness Manager"; Bloat Radar is unchanged; the source docs are unchanged.
  (not: "config", "setup")
  **Collision rule:** *this repository's own* kit-generated build system (`CLAUDE.md` + `.claude/**`,
  produced at step 5 of the Project Setup Kit) must **always** be written as **"the build harness"**
  or **"the kit harness"** — never bare "harness" — in DESIGN.md, PLAN.md, skills, agents, and
  commit messages. Bare "harness" always means the analyzed `~/.claude` surface.
- **Cost proxy** — output tokens. The always-honest, always-available cost signal and the primary
  headline metric, because it needs no price data to be correct. Cache-read tokens (billions) are
  cheap re-reads and are **never** summed into a headline "total tokens" without an explicit label.
  (not: "cost", "spend")
- **Cost** — a dollar figure, derived by joining usage to the **price row valid at the record's own
  timestamp**. Secondary to the cost proxy, and always accompanied by its uncosted-record
  disclosure.
  (not: bare "estimate", "spend")
- **Price row** — a price for one model, one **token class**, over one validity range. The unit of
  the price table and of its history.
- **Token class** — one of exactly four: **input, output, cache-write, cache-read**. Each is priced
  independently and stored, never derived from another.
- **Uncosted record** — a usage record with no price row covering its model and timestamp. Excluded
  from `$` totals and disclosed in the UI. Never zero-filled, never substituted.
- **Claude data directory** — the configured root the app reads. Defaults to `~/.claude` (via
  `os.homedir()`, never a literal), chosen in Settings via a native picker, validated (must contain
  `projects/` and/or `history.jsonl`), persisted.
  (not: "the claude folder")
- **Sync** — reconciling the SQLite cache to the current contents of the Claude data directory. The
  files are the source of truth and are read-only; SQLite is a derived cache that can be deleted and
  rebuilt at any time.
  (not: "import", "update", "refresh the data")
- **Bloat flag** — one detected issue carrying a rule id, a location, a disk size, a severity, a
  rationale, and a recommended action. The app's own backup directory can never produce one.
  (not: "warning", "problem", "issue")
- **Guarded action** — a mutating operation on the Claude data directory: confirm dialog → backup to
  `<claudeDir>/.claude-lens-backups/<timestamp>/` → execute → undoable → written to the audit trail.
  "Clear backups" is itself a guarded action.
  (not: "cleanup", "delete")

## Constraints

- **Team:** solo developer, building with agent assistance.
- **Timeline:** **open-ended.** Personal project, no deadline, explicitly multi-session. No
  scope/timeline contradiction to flag.
- **Platform:** macOS desktop. Electron + electron-vite. **No packaging toolchain at all** — no
  signing, no notarization, no `.dmg`. Source distribution only: `pnpm install && pnpm run dev`.
  *(`STACK.md` removed `electron-builder` outright rather than leaving it installed-but-unused: an
  installed packaging tool is a lockfile entry, an audit surface, and an invitation for a later
  agent to "finish" it.)*
- **Already fixed (locked in `docs/source/`, do not reopen):**
  - Electron + **React 19** + Vite + TypeScript + Tailwind. *(Corrected 2026-07-20. The source docs
    say "React 18"; that was carried from `docs/source/HANDOFF.md` §3, listed above as stale.
    `STACK.md` ADR-004 pins React 19.2.7 because `react-router@8` peer-requires `react >=19.2.7`
    and React 18.3.1 is maintenance-only. **User-confirmed at step 2.** `STACK.md` is the
    authority on versions.)*
  - Embedded SQLite via `better-sqlite3`, in the **main process**, behind the mandatory query seam.
    No server, no port, typed IPC. `better-sqlite3` is a native module and must be rebuilt for
    Electron's ABI.
  - Incremental sync: full parse on first run; then auto-sync on launch + manual Refresh + live
    `chokidar` file-watching, all incremental via a `file_manifest` byte-offset append fast-path.
  - Eight views, confirmed by the prototype: Overview · Tokens & Cost · Sessions & Time ·
    Tools & Agents · Graphs & Harness Flow · Projects & Code · Harness Manager · Settings.
  - Four graph tabs: Harness Map · Execution Trace · Tool Transition · Flow Sankey.
  - Guarded actions: confirm + backup + undo + audit trail.
  - The visual system in `docs/source/FRONTEND.md` and the prototype's layout are **binding**.
  - Metric definitions in `docs/source/HANDOFF.md` §5 are implemented **exactly**.
  - Ground-truth data facts in `docs/source/HANDOFF.md` §4 are **verified** — do not re-derive.
- **Corrections to the source docs** (they are stale; do not propagate):
  - The project is named **Claude Lens** (repo `ClaudeLens`), **not** `ClaudeAnalyzer`.
  - Nothing is scaffolded — no git repo, no `package.json`, no source. The tree is design docs plus
    the prototype folder.
  - `~/.claude` is a **setting**. No `/Users/<name>` literal may appear in any committed file.
  - `docs/source/HANDOFF.md` §6–§8 (build order, success criteria, definition-of-done) and its
    "build autonomously, do not stop" instruction are **superseded** by this kit. §7 is raw material
    for acceptance criteria only.
  - `docs/source/DESIGN_INPUT.md` specifies tokens and a relative cost proxy only; **dollar costing
    with four-class, effective-dated price history is a deliberate addition** made in this
    interview, as is the single permitted network egress point.

## Build tier

<!-- TIER: full -->

**Tier: full** — agreed by the user, not provisional. Estimated **~68 stories**.

Story estimate, out loud so it can be argued with:

| Area | Stories |
|---|---|
| Scaffold, IPC skeleton, query seam, theme tokens + component primitives | ~8 |
| Settings, onboarding, directory picker + validation, persistence | ~4 |
| Parser, SQLite schema, worker thread, `file_manifest` incremental sync, live watcher | ~10 |
| Golden-fixture test suite over parser + every metric definition + costing | ~5 |
| Pricing — bundled seed, four token classes, effective-dated auto-versioning, editable rows and dates, configurable-URL user-triggered fetch, uncosted disclosure | ~7 |
| Overview | ~3 |
| Tokens & Cost | ~4 |
| Sessions & Time | ~5 |
| Tools & Agents | ~3 |
| Projects & Code (metrics only, no diff rendering) | ~3 |
| Graphs — Harness Map (incl. SKILL.md/CLAUDE.md graph builder), Execution Trace, Tool Transition, Sankey, inspector, filters | ~10 |
| Harness Manager scan panels + Bloat Radar rules + backup-dir exclusion | ~6 |
| Guarded actions — confirm, backup, undo, audit trail, backup-state panel, clear-backups | ~5 |
| Cross-cutting: global date/project filter, empty/loading/error states, repo hygiene + README | ~4 |

Rationale: a solo build, but not a small one, and the user explicitly took the full harness rather
than the "full scope, standard harness" shortcut. It has a genuine data-engineering component
(streaming ~1 GB of JSONL into a schema, with an incremental sync engine and a nine-hour-a-day live
watcher), eight distinct views, four interactive graph visualisations, a bi-temporal pricing
subsystem, and a **file-mutating** subsystem operating on the user's real config directory. It is
open-ended and will span many sessions over weeks or months, so agents will lose context repeatedly
and need epic gates, a regression gate, and docs-sync to stay honest. Given that the defining
quality bar is "never show a silently wrong number," the regression gate is load-bearing rather than
ceremonial, and the guarded-delete subsystem must not be built under a harness with no review gate.

## Deliberately undecided

In round two the user chose to decide every previously-reserved item rather than leave it open. What
remains is one deferral, and it is honestly a deferral rather than an undecided requirement:

- **Diff rendering of `file-history/` snapshots, post-v1.** For v1 this is a firm non-goal (#3
  above) — metrics only. Whether a diff viewer is ever built is genuinely open, and no v1 agent may
  build toward it or leave a hook for it.

Everything else that was previously reserved is now resolved and recorded in `OPEN_QUESTIONS.md`
with its decision and rationale: DuckDB (OQ-102), backup retention (OQ-103), file-history depth
(OQ-104), dollar costing (OQ-105), Windows/Linux (OQ-106), and price source, history, gaps and cache
pricing (OQ-012).

Nothing was flagged as shaky. The user gave no provisional answers, so there is nothing for
`plan-lint` to revisit on their behalf.
