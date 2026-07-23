# Stack — Claude Lens

> Step 2 of the Project Setup Kit. Inputs: `PRD.md` (authoritative), `OPEN_QUESTIONS.md`,
> `docs/source/DESIGN_INPUT.md` §3/§8, `docs/source/HANDOFF.md` §3/§4, `docs/source/FRONTEND.md`.
>
> **Every version below was resolved against the live npm registry and the upstream release
> artifact lists on 2026-07-20, not recalled.** Three of the pins are deliberately *not* the
> newest published version. Those three are the most load-bearing decisions in this file
> (ADR-001, ADR-002, ADR-005/006) and each carries the fact that forced it.
>
> Terminology, per OQ-008: bare **"harness"** always means the user's `~/.claude` configuration
> surface that the product analyzes. This repository's own kit-generated build system is always
> written as **"the build harness"**.

---

## Locked (ADRs) — this project's ADR numbering STARTS here; `design-author` continues it

### ADR-001 — Language and runtime: TypeScript 6.0.3 on Node.js 24 LTS  [LOCKED 2026-07-20]

- **Decision:** TypeScript pinned to **6.0.3**. Node.js pinned to **24 LTS** (`.nvmrc`, `engines.node: ">=24.0.0 <25"`), `@types/node` pinned to **^24** (not the `26.x` that npm resolves by default).
- **Because:** TypeScript **7.0.2** shipped 2026-07-08 as the Go-native compiler and is the npm `latest` tag — but **`typescript-eslint@8.65.0` declares `peerDependencies.typescript: ">=4.8.4 <6.1.0"`**. TS 7 does not yet expose a stable programmatic compiler API; the TypeScript team has said that lands in 7.1, and published `@typescript/typescript6` explicitly so tools like typescript-eslint can keep working. Adopting TS 7 today means **losing typed linting**, and typed linting is where the seam rules and the egress rules in ADR-015 live. A silently-wrong-number project does not trade away its type-aware lint for compile speed on a ~40-file codebase. Node 24 is the active LTS line (LTS 2025-10-28, maintenance from 2026-10-20, EOL 2028-04-30) and — see ADR-006 — its ABI (137) has a published `better-sqlite3` prebuilt binary.
- **Rejected:** *TypeScript 7.0.2.* Real cost of rejecting it: ~10x slower `tsc`, which on this codebase is a few seconds, not minutes. Real cost of adopting it: no `typescript-eslint`, therefore no typed rules, therefore ADR-015's architectural invariants become grep scripts instead of lint rules. *Node 26* (LTS from 2026-10-28) was rejected as premature — it is not LTS yet on 2026-07-20.
- **Constrains:** All ADR-015 lint rules may assume type information. `tsconfig` targets ES2023 / `moduleResolution: "bundler"`.
- **Revisit if:** `typescript-eslint` publishes a release whose peer range admits TypeScript 7 (expected against TS 7.1). At that point this is a two-line bump with no code impact.

### ADR-002 — App shell: Electron 42.7.0 + electron-vite 5.0.0 + Vite 7.3.6  [LOCKED 2026-07-20]

- **Decision:** **Electron 42.7.0**, built by **electron-vite 5.0.0** over **Vite 7.3.6**. macOS only (arm64 primary, x64 works). No packaging tool of any kind is installed — see ADR-016.
- **Because:** two separate ceilings, both verified:
  1. **`electron-vite@5.0.0` declares `peerDependencies.vite: "^5.0.0 || ^6.0.0 || ^7.0.0"`.** Vite **8.1.5** is npm `latest`; electron-vite support for it exists only in `6.0.0-beta.1`. Pinning Vite 7.3.6 keeps the whole toolchain on published stable releases. `vitest@4` peers `vite ^6 || ^7 || ^8`, so Vite 7 satisfies both.
  2. **Electron 43 has no `better-sqlite3` prebuilt binary.** Electron 43 = ABI 148; `better-sqlite3@12.11.1` publishes prebuilds for Electron ABIs `121,123,125,128,130,132,133,135,136,139,140,143,145,146` — topping out at **ABI 146 = Electron 42**. Electron 42.7.0 (2026-07-15) is inside Electron's supported window (41/42/43) and gets a downloaded binary; Electron 43 would fall back to `node-gyp rebuild`, requiring Xcode Command Line Tools and Python on every machine that clones this **publicly shared** repo. That is a cold-clone failure mode we are choosing not to have.
- **Rejected:** *Electron 43.1.1 + Vite 8.1.5 + electron-vite 6 beta.* Real cost of rejecting: one Chromium major behind, and Vite 8's build-perf work. Real cost of adopting: a beta build tool, plus a from-source native compile on first install for every user of a repo whose whole distribution story is "`pnpm install && pnpm run dev`."
- **Constrains:** ADR-006's Electron rebuild target is `42.7.0` and must be updated in lockstep with any Electron bump. Renderer targets Chromium as shipped by Electron 42 — no browser-compat polyfills, no `browserslist`.
- **Revisit if:** `better-sqlite3` publishes ABI-148+ prebuilds **and** `electron-vite@6` reaches stable. Bump both together, verify `pnpm install` on a machine with no compiler, then re-pin.

### ADR-003 — No server. The Electron main process is the backend.  [LOCKED 2026-07-20]

- **Decision:** There is **no server, no port, no HTTP layer, no localhost listener**. Filesystem access, JSONL parsing, SQLite, the file-watcher and every guarded action live in the **Electron main process**. The renderer reaches them only over `contextBridge` + `ipcRenderer.invoke` on a single typed channel map in `src/shared/ipc-contract.ts`, exposed by a preload script with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- **Because:** carried from PRD "Already fixed" and `DESIGN_INPUT.md` §3.1. Single user, single machine, one dataset. A port is attack surface and a process to supervise, for zero benefit. It also makes the "exactly one network egress point" rule in ADR-015 mechanically checkable: with no server, *every* socket in the app is an outbound one.
- **Rejected:** *A local HTTP/tRPC server in a child process.* Real cost of rejecting: no off-the-shelf request/response tooling, no browser devtools network tab for the data layer, and IPC has no streaming ergonomics — large results must be paged by hand. Accepted.
- **Constrains:** The renderer **cannot** import `node:fs`, `node:path`, `better-sqlite3` or `electron` outside the preload boundary. Enforced as a lint rule, not a convention (ADR-015). Anything the renderer needs must exist as a typed IPC method.
- **Revisit if:** never, for v1. A second consumer of the data (a CLI, a second window process needing direct DB access) would reopen it.

### ADR-004 — Frontend: React 19.2.7 + Tailwind CSS 4.3.3 + Zustand 5.0.14 + React Router 8.2.0  [LOCKED 2026-07-20]

- **Decision:** **React 19.2.7** / **react-dom 19.2.7**, **Tailwind CSS 4.3.3**, **Zustand 5.0.14** for renderer state, **React Router 8.2.0** for the eight-view sidebar navigation, **Framer Motion 12.42.2** for the motion spec in `FRONTEND.md` §7.
- **Because:** ✅ **Confirmed by the user, 2026-07-20.** `PRD.md` originally said "React 18", carried verbatim from `docs/source/HANDOFF.md` §3 — a document the PRD *itself* flags as stale in "Corrections to the source docs" (it still names the repo `ClaudeAnalyzer`). The locked decision is the *framework* — Electron + React + Vite + TypeScript — not a major version resolved before this step existed. React 18.3.1 is in maintenance and receives no feature work. The independent confirmation: **`react-router@8.2.0` declares `peerDependencies.react: ">=19.2.7"`** — the current router line will not install on React 18 at all. Every other pinned library (`@xyflow/react` `>=17`, `@visx/visx` `^18||^19`, `@testing-library/react@16.3.2` `^18||^19`, Recharts 3, Framer Motion 12) supports both, so 19 costs nothing and 18 costs the router. **`PRD.md` has since been corrected to React 19 and now points here as the authority on versions — the two documents agree; do not "fix" either back toward 18.**
  Tailwind **4.3.3** is CSS-first: `FRONTEND.md` §2's note that "Tailwind reads them via `theme.extend.colors`" is a v3 idiom. The token **values** in `FRONTEND.md` §2–§4 remain binding verbatim; only the mechanism changes — they are declared once in `src/renderer/styles/tokens.css` under `:root` / `:root[data-theme="light"]` and surfaced to Tailwind via `@theme`. This *helps* ADR-015: one file owns every literal color.
- **Rejected:** *React 18.3.1* (forces `react-router-dom@7`, an older line, and starts the project on a maintenance-only runtime). *Redux Toolkit / Jotai* — Zustand is already specified in `DESIGN_INPUT.md` §8 and the renderer holds almost no state; the data lives in SQLite behind IPC. *A component library (shadcn/MUI/Mantine)* — `FRONTEND.md` §5 specifies seven bespoke primitives with a specific glow/gradient system; a library would be fought, not used.
- **Constrains:** `design-author` writes §5 component primitives against React 19 idioms. Tailwind v4 means **there is no `tailwind.config.js`** — a scaffold detail that trips the muscle memory of every agent that has seen v3.
- **Revisit if:** nothing foreseeable. This was the one open item at step 2 and the user closed it in favour of 19.

### ADR-005 — Database: embedded SQLite via `better-sqlite3` 12.11.1, in the main process  [LOCKED 2026-07-20]

- **Decision:** **SQLite**, embedded, through **`better-sqlite3@12.11.1`**, opened **only** in the Electron main process (and in the parse worker thread), at `app.getPath('userData')/claude-lens.db`. Never inside the Claude data directory, never in the repo, gitignored. WAL mode. **DuckDB is neither adopted nor foreclosed** — see the trigger below.
- **Because:** locked by OQ-102 and PRD Constraints. `better-sqlite3` is synchronous, which is exactly right for a main-process/worker-thread caller with no event loop to protect, and it is the fastest option for the point-lookup + `GROUP BY` workload the eight views produce. It also publishes prebuilt binaries for both Node and Electron ABIs, which ADR-006 depends on.
- **Rejected:** *DuckDB.* Real, non-strawman cost of rejecting it: DuckDB is columnar and would very likely beat SQLite on the wide `GROUP BY model, date` roll-ups over ~236,030 records, and it can query JSONL directly, which would shorten the ingest path. It was rejected for v1 on packaging risk under Electron and because the workload is not yet proven to need it. **This is a live question, not a closed one.** *`node:sqlite`* (built into Node 22+ / Electron's embedded Node) would have made ADR-006 disappear entirely — one runtime, no native module, no ABI — but it remains **experimental** across the v22/v24 lines with an API that can change in minor releases, and the PRD locks `better-sqlite3`. Recorded because it is the obvious "why didn't you just…" and the answer must not be re-derived. *Prisma / Drizzle / Kysely* — see ADR-007.
- **Constrains:** All SQL lives in `src/main/db/`. The renderer never sees a connection (ADR-003, ADR-008).
- **Revisit if:** **any dashboard query exceeds ~200 ms on the full dataset** (~1 GB, 2,064 files, 236,030 records). That is the numeric trigger from OQ-102, restated here verbatim as the condition to measure against — **not** a promise to switch. ADR-008's seam is what makes measuring-then-deciding cheap. `perf-profiling` (see the manifest) is the gate that would surface this.

### ADR-006 — Dual-ABI native module strategy: two `better-sqlite3` installs, selected at load  [LOCKED 2026-07-20 · **AMENDED 2026-07-23**]

- **Decision:** `better-sqlite3` is installed **twice**, under two names, and the correct one is chosen at runtime:

  ```jsonc
  "dependencies": {
    "better-sqlite3":          "12.11.1",                        // built for Node's ABI  (137)
    "better-sqlite3-electron": "npm:better-sqlite3@12.11.1"      // rebuilt for Electron's ABI (146)
  },
  "scripts": {
    "postinstall": "electron-rebuild --force --only better-sqlite3-electron"
  }
  ```

  A single ~10-line loader inside the query seam (`src/main/db/driver.ts`) resolves
  `process.versions.electron ? 'better-sqlite3-electron' : 'better-sqlite3'`. `better-sqlite3`'s
  documented `nativeBinding` constructor option is the escape hatch if a bundler ever relocates
  the `.node` file. **`@electron/rebuild@4.2.0`**, rebuild target `42.7.0`.
- **Because:** this is **the single decision that determines whether the check command can be green**, and it is not obvious. `better-sqlite3` is a NAN/V8 addon, not N-API, so one compiled `.node` cannot serve both runtimes. The app runs under Electron (ABI 146); Vitest runs under Node (ABI 137). The naive setup — install, then `electron-rebuild` in postinstall — **overwrites the Node binary in place**, and from that moment every SQLite test fails with `NODE_MODULE_VERSION` mismatch. An agent reading that failure will correctly conclude it is environmental, and then incorrectly conclude the same about the next real failure. Two install paths means two `build/Release/better_sqlite3.node` files that never contend, `@electron/rebuild` handles prebuild download and compile fallback, and **both binaries are downloaded, not compiled**, on macOS arm64/x64 for these exact pins.
- **Rejected:** *Running Vitest inside Electron's Node via `ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run`.* This genuinely works and needs only one ABI. Real cost: Vitest's fork pool spawns children from `process.execPath`, so the whole pool must inherit the Electron binary and the env var; coverage, the VS Code extension, watch mode and `--ui` all become special cases; and it makes the most-run command in the project depend on Electron booting correctly. That is a flaky check command, which the PRD's quality bar cannot tolerate. *A postinstall script that stashes and swaps one `.node` file between `dev` and `test`* — rejected outright: the failure mode is a stale binary and a check command whose result depends on which script ran last.
- **Constrains:** Scaffold must verify **both** paths in one run: `node -e "require('better-sqlite3')"` and an Electron smoke load. Any Electron version bump requires re-running `postinstall`. `better-sqlite3` (and only `better-sqlite3`) is `external` in the electron-vite main-process build; everything else is bundled (see ADR-010).
- **Revisit if:** `node:sqlite` graduates from experimental (targeted around Node 26 LTS), which would delete this ADR and ADR-005's native dependency together — or `better-sqlite3` ships an N-API build.
- **AMENDED 2026-07-23 — package manager is now pnpm.** The two-copies dual-ABI strategy REQUIRES `.npmrc` `node-linker=hoisted`. pnpm's default content-addressed store deduplicates the two `better-sqlite3` / `better-sqlite3-electron` aliases (identical name@version) into ONE physical binary — which makes two ABIs impossible and breaks either the app or the Node-ABI test suite (verified: both names symlinked to one store dir, one shared `.node` inode). `node-linker=hoisted` restores the flat, two-independent-copies layout, so `postinstall`'s `electron-rebuild --force --only better-sqlite3-electron` produces a distinct Electron-ABI binary. `pnpm.onlyBuiltDependencies` allowlists better-sqlite3 / better-sqlite3-electron / electron so a cold clone runs their install/build scripts deterministically. Verified 2026-07-23: `pnpm run check` (1255 tests) and `pnpm run e2e` (8, real window) green; `check-bundle-externals` confirms both copies reachable and not inlined.

### ADR-007 — Schema migrations: hand-written numbered SQL + `PRAGMA user_version`. No ORM.  [LOCKED 2026-07-20]

- **Decision:** No ORM and no query builder. Schema lives in `src/main/db/migrations/NNNN-name.sql`, applied in order inside a transaction by a ~40-line runner keyed on `PRAGMA user_version`. Queries are hand-written SQL in `src/main/db/queries/`, each behind a typed repository function (ADR-008).
- **Because:** the schema is small, fixed and deeply shaped by SQLite specifics this project actually needs — partial indexes for the `<synthetic>` exclusion, a covering index for the bi-temporal price join, `WITHOUT ROWID` where it pays. An ORM abstracts exactly the thing that must stay legible. **And the critical non-obvious fact this ADR exists to record: the SQLite file is only *partly* a derived cache.** `DESIGN_INPUT.md` §3.3 says "SQLite is a derived cache that can be deleted and rebuilt at any time" — that is true of `events`, `sessions`, `tool_calls`, `file_manifest`, but it is **false** of `price_rows` (hand-edited rates and hand-corrected effective dates), `audit_log` (the guarded-action trail) and `settings`. Those are user data with no other source. "Just drop and re-sync on schema change" would silently destroy a user's hand-corrected price history — which is textbook silently-wrong-number territory. Migrations are therefore mandatory, and they are why `db-migration-review` is a real gate for this stack.
- **Rejected:** *Drizzle / Kysely.* Real cost of rejecting: no compile-time checking that a SQL string matches the schema, so a renamed column becomes a runtime error rather than a type error. Mitigated by golden-fixture coverage over every metric and by ADR-012's integration tests running against a real migrated database. *Prisma* — its engine is a second native binary, which after ADR-006 is a cost this project has already paid once and will not pay twice.
- **Constrains:** Every schema change is a new numbered file; existing migration files are **immutable** once merged. `design-author` writes the DDL in DESIGN.md and it must match migration `0001`.
- **Revisit if:** the schema exceeds ~20 tables, or the "renamed column found at runtime" failure actually happens twice.

### ADR-008 — Mandatory query seam, enforced as an import boundary  [LOCKED 2026-07-20]

- **Decision:** Every read goes through a repository interface in `src/main/db/repositories/`. **No view, component, hook or store touches SQL.** The boundary is enforced mechanically, not by review: SQL text may exist only under `src/main/db/**`, and `src/renderer/**` may not import from `src/main/**` at all (ESLint `no-restricted-imports` zones, ADR-015). The renderer's only vocabulary is the typed IPC contract.
- **Because:** required by OQ-102 and PRD "Additional architectural constraints." It is the precondition that makes ADR-005's SQLite lock safe: with the seam, the ~200 ms trigger firing means rewriting a package; without it, it means rewriting the app.
- **Rejected:** *"Convention, enforced in code review."* Real cost of rejecting the convention approach: a lint rule occasionally blocks a legitimately convenient shortcut and someone has to add an eslint-disable with a reason. Real cost of accepting it: on a multi-month, many-session build where agents repeatedly lose context, an unenforced architectural rule has a half-life measured in weeks. The whole point of a `full`-tier build harness is to not rely on memory.
- **Constrains:** Every new metric needs a repository method *and* an IPC method. This is deliberate friction — it is the same list a metric's golden fixture has to cover.
- **Revisit if:** never in v1.

### ADR-009 — Ingestion: streaming `node:readline` in a `worker_threads` worker, byte-offset manifest  [LOCKED 2026-07-20]

- **Decision:** JSONL is read with `node:readline` over `fs.createReadStream`, **one line at a time, never `JSON.parse` of a whole file**, inside a `worker_threads` worker owned by the main process. Incremental sync uses the `file_manifest` byte-offset append fast-path from `DESIGN_INPUT.md` §3.3. Timestamps normalize on ingest (transcripts ISO 8601 Z, `history.jsonl` ms-epoch — `HANDOFF.md` §4). `<synthetic>` assistant records are excluded from token/model stats. Malformed lines are counted and skipped, never fatal. Node core only — no `stream-json`, no `ndjson`, no `JSONStream`.
- **Because:** ~1 GB across 2,064 files, 236,030 records, with a target cold parse under 10 s and a hard ceiling of 30 s. Line-delimited JSON needs a line splitter and `JSON.parse` per line; `readline` is that, it is zero-dependency, and it back-pressures correctly. Cache-read counts reach the billions (3.1e9), so accumulators must be `BigInt` or carefully-bounded `number` — `Number.MAX_SAFE_INTEGER` is 9.0e15, so `number` is safe for sums but the choice must be *made*, not defaulted into. A worker thread is required because the main process also serves IPC and must stay responsive with a live progress indicator.
- **Rejected:** *`stream-json`.* Real cost of rejecting: it handles pathological cases (a single JSON value spanning many lines) that `readline` cannot. Accepted, because the format here is strictly one object per line — verified in `HANDOFF.md` §4 — and a dependency that parses untrusted-ish input is surface this app does not need. *Parsing in the main process without a worker* — rejected; it freezes the window during the one operation the PRD explicitly budgets for.
- **Constrains:** The parser must be a pure, injectable function over a line iterator so golden fixtures can drive it without touching a real directory (ADR-013). Worker↔main messages are structured-clone only.
- **Revisit if:** cold parse exceeds 30 s on the reference dataset after indexing is tuned.

### ADR-010 — File watching: `chokidar@5.0.0`, bundled rather than externalized  [LOCKED 2026-07-20]

- **Decision:** **`chokidar@5.0.0`**, debounced ~500 ms, watching the configured Claude data directory while the window is open and **not** while it is closed (PRD non-goal #7). `<claudeDir>/.claude-lens-backups/` is excluded from the watch as well as from Bloat Radar and analytics. **chokidar is bundled into the main-process output, not listed as an electron-vite external** — `better-sqlite3` is the *only* external.
- **Because:** the app is open nine hours a day and the watcher is core architecture, so idle behaviour is a product property. chokidar 4 dropped the bundled `fsevents` native dependency and glob support; chokidar 5 (2025-11-25) is the same engine, **ESM-only**, Node ≥20.19. Being ESM-only is the trap: electron-vite's `externalizeDepsPlugin` is on by default, and an externalized ESM-only package `require()`d from a CJS main bundle fails at runtime — after the build passes. Bundling it (it is pure JS with one dependency, `readdirp`) removes the failure mode entirely and keeps the externals list down to the one module that genuinely cannot be bundled. On macOS, `fs.watch` with `recursive: true` is natively supported and is what a ~2,000-file tree under one root should use — a per-file watcher fleet is what burns idle CPU and hits descriptor limits.
- **Rejected:** *`chokidar@4.x` (CJS-compatible)* — avoids the ESM question by staying a version behind; rejected because bundling solves it properly and v5 is the maintained line. *Raw `fs.watch`* — real cost of rejecting: one fewer dependency. Accepted, because chokidar's event coalescing, atomic-write handling (editors write-then-rename) and `awaitWriteFinish` are precisely the correctness this watcher needs, and reimplementing them is how a watcher starts missing appends.
- **Constrains:** Idle CPU and RSS over a long session are measurable properties and belong in DESIGN.md §8's perf targets — which is what resolves `perf-profiling` in the manifest.
- **Revisit if:** measured idle CPU is non-trivial with the window idle, or appends are ever missed.

### ADR-011 — Charts and graphs: Recharts 3.10.0 · visx 4.0.0 · @xyflow/react 12.11.2 · cytoscape 3.34.0 · d3-sankey 0.12.3  [LOCKED 2026-07-20]

- **Decision:** **Recharts 3.10.0** for standard chart types (stacked areas, bars, histogram); **`@visx/visx` 4.0.0** + `d3-scale@4.0.2` / `d3-array@3.2.4` for the bespoke visuals `FRONTEND.md` §5 specifies — calendar heatmap, hour×weekday heatmap, treemap, radial cache gauge; **`@xyflow/react` 12.11.2** for the Harness Map and Execution Trace; **`cytoscape` 3.34.0** for the force-directed Tool Transition graph; **`d3-sankey` 0.12.3** (layout only) for the Flow Sankey, rendered as SVG by our own code.
- **Because:** ⚠️ **`reactflow` — the package name in `DESIGN_INPUT.md` §8 — is the deprecated v11 line, last published 2024-06-20.** The maintained package is `@xyflow/react` (v12). Propagating §8 verbatim would have installed an abandoned dependency; this is exactly the "locked against a library abandoned eighteen months ago" case. `cytoscape` is chosen over `react-force-graph-2d` because the Tool Transition view needs deterministic, re-runnable layout over a fixed 33-node Markov graph, not a WebGL particle simulation. `d3-sankey` has not been published since 2019 and that is fine and stated plainly: it is ~600 lines of finished layout arithmetic with no dependencies and no attack surface; we render its output ourselves.
- **Rejected:** *A single library for everything* — nothing covers Recharts' ergonomics, node-graph interaction and Sankey layout at once. *ECharts* — one bundle for all of it, but a canvas-first imperative API that fights `FRONTEND.md`'s per-series CSS-variable theming and its stable-hue-per-model rule.
- **Constrains:** Every one of these renders in the renderer only. All five must read their colors from the ADR-004 token layer, never from literals — which is what makes `design-token-lint` a runnable gate.
- **Revisit if:** the Sankey needs a feature `d3-sankey` never gained, or bundle size becomes a startup cost.

### ADR-012 — Test tooling: Vitest 4.1.10, three projects, split by process  [LOCKED 2026-07-20]

- **Decision:** **Vitest 4.1.10**, configured with the `projects` field (`workspace` is deprecated since 3.2). **Three projects, because main and renderer are genuinely different runtimes and a single config cannot serve both:**

  | project | environment | pool | scope |
  |---|---|---|---|
  | `main` | `node` | **`forks`** | `src/main/**`, parser, worker, SQLite, migrations, pricing, guarded actions, integration tests |
  | `renderer` | `jsdom@29.1.1` | `threads` | `src/renderer/**` components and hooks, via `@testing-library/react@16.3.2` + `@testing-library/jest-dom@7.0.0` |
  | `shared` | `node` | `threads` | `src/shared/**` — IPC contract types, metric pure functions, formatters |

  Golden fixtures live in `test/fixtures/` and are **read-only inputs**, committed, tiny, synthetic. Coverage via `@vitest/coverage-v8@4.1.10`, reported but **not** thresholded in the check command (see ADR-014). **End-to-end tests are not one of these projects** — they live in `e2e/`, run under Playwright via a separate command, and are excluded from every Vitest glob (ADR-018).
- **Because:** Vitest reuses the Vite 7 transform pipeline that electron-vite already requires, so there is one TS/JSX config, not two. `pool: 'forks'` for `main` is a deliberate, non-default choice: the `main` project loads a **NAN-based native addon** (ADR-006) and drives real files, and child-process isolation avoids the addon-in-worker-isolate class of problem entirely while giving each test file its own process, its own CWD and its own file descriptors. The renderer has no native code, so it keeps the faster `threads` pool. Vitest's golden/snapshot ergonomics matter here specifically because the PRD makes hand-computed expected values a gate — but note the deliberate constraint below.
- **Rejected:** *Jest* — a second transform pipeline to configure and keep in sync with Vite, for no gain. *`node:test`* — no `projects` concept, no jsdom story, and would need a separate TS transform. *One Vitest config with `environmentMatchGlobs`* — real cost of rejecting: one less file. Accepted, because it cannot express *per-project pools*, and the pool split is the whole point.
- **Constrains:** ⚠️ **Metric golden fixtures use explicit inline expected values, never `toMatchSnapshot()`.** An auto-written snapshot records whatever the code currently produces — which, for a project whose worst failure is a silently wrong number, is a machine for blessing the bug. `expect(activeSeconds).toBe(5_400)` with the arithmetic in a comment is the required form; `.toMatchSnapshot()` is reserved for structural output (a graph's node/edge shape) and is banned in `test/metrics/**` by lint.
- **Revisit if:** the `main` suite's fork overhead becomes the dominant cost of `pnpm run check`.

### ADR-013 — Test isolation: per-worker sandbox roots, one SQLite file per test, and a home-directory tripwire  [LOCKED 2026-07-20]

- **Decision:** Three mechanisms, all mandatory, all in `test/support/`:

  1. **Per-worker sandbox roots.** `useSandbox()` (`test/support/sandbox.ts`) creates, in `beforeEach`, a directory at
     `os.tmpdir()/claude-lens-tests/w${process.env.VITEST_POOL_ID}/${mkdtemp(...)}` and registers `afterEach` removal. `VITEST_POOL_ID` partitions by worker; `fs.mkdtemp` guarantees uniqueness *within* a worker. **No test may name a fixed path.** Fixtures are copied into the sandbox before any mutation, so `test/fixtures/**` is never written to and stays diff-clean.
  2. **One SQLite file per test.** Databases open at `join(sandbox, 'lens.db')` — never a shared path, never a repo-relative path. `:memory:` is permitted **only** for pure SQL-shape unit tests; anything exercising the file manifest, byte offsets, WAL, migrations or the incremental fast-path must use a real file, because those are precisely the behaviours an in-memory DB does not have.
  3. **A home-directory tripwire.** A `setupFiles` entry loaded by *every* project resolves the real `os.homedir()` once and installs an assertion that throws immediately if any path handed to the scanner, the parser or a guarded action resolves under `<home>/.claude`. Reinforced by two independent belts: ESLint forbids `os.homedir()` anywhere outside `src/main/config/paths.ts` (ADR-015), and `CLAUDE_LENS_DATA_DIR` is **injected** in tests, never defaulted.
     ⚠️ **This mechanism is Vitest-only and does NOT cover the E2E suite**, which launches the real app in a separate process where `setupFiles` never loads. **ADR-018 extends it** — the assertion also lives in `src/main/config/paths.ts` as production code under `CLAUDE_LENS_E2E=1`, the launcher asserts its sandbox is under `os.tmpdir()` before spawning, `--user-data-dir` is redirected so the real `claude-lens.db` is untouched, and the smoke suite never invokes a guarded action at all. Read ADR-013 and ADR-018 together; neither is complete alone.
- **Because:** the `main` suite touches SQLite files and a filesystem tree in parallel. Workers sharing one DB file or one temp directory produce `SQLITE_BUSY` and phantom-file failures that look exactly like flakes — and a flaky check command is worse than none, because an agent will read "environmental, unrelated to my change" and pass a broken story. Separately, **this app has a delete subsystem.** A test that resolves the real `~/.claude` is not a flaky test, it is data loss on the author's own machine. Three independent mechanisms because one of them will eventually be forgotten in a new test file.
- **Rejected:** *`fileParallelism: false`* (serialize everything) — real cost of rejecting: sandboxing is ~30 lines of helper. Real cost of accepting: a `full`-tier suite that can never parallelize, which gets slow, which gets skipped. *A single shared temp root with per-test subdirectories* — works until a test cleans up its parent, and the failure appears in an unrelated file.
- **Constrains:** Every fs/DB-touching test opens with `const sandbox = useSandbox()`. `design-author` should treat "takes its root directory as a parameter" as a design requirement of the scanner, parser and action layers — not an afterthought.
- **Revisit if:** never. This is a safety property.

### ADR-014 — Lint and format: ESLint 10.7.0 flat config + typescript-eslint 8.65.0 + Prettier 3.9.5  [LOCKED 2026-07-20]

- **Decision:** **ESLint 10.7.0** with flat config (`eslint.config.js`), **typescript-eslint 8.65.0** with **type-aware** rules enabled across all three tsconfig projects, **eslint-plugin-react-hooks 7.1.1**, and **Prettier 3.9.5** for formatting only, with **eslint-config-prettier 10.1.8** disabling the overlap. `eslint --max-warnings 0` — there is no warning tier; a rule is either on and blocking, or off.
- **Because:** typed linting is the mechanism ADR-015's architectural rules are built from, which is also why ADR-001 pins TypeScript at 6.0.3. `--max-warnings 0` because a warning an agent can ignore is a rule that does not exist.
- **Rejected:** *Biome 2.5.4 / oxlint 1.74.0.* Real cost of rejecting: both are 10–50x faster and replace two tools with one. Real cost of adopting: neither offers type-aware linting of the depth needed, and ADR-015's rules — import zones, restricted globals scoped to a single allowlisted file, restricted syntax on string literals — are natural in ESLint and awkward or impossible elsewhere. On a ~40-file codebase, lint speed is not a problem worth trading correctness enforcement for.
- **Constrains:** Coverage is collected but **not** thresholded in `pnpm run check`. A coverage percentage is a proxy the PRD explicitly distrusts — the real bar is "every metric has a golden fixture with a hand-computed expected value," which is what `golden-fixture-review` gates. A 90% line-coverage gate would pass on a suite with zero correct expected values.
- **Revisit if:** lint wall-time exceeds ~20 s.

### ADR-015 — Four architectural invariants enforced by the check command, not by prose  [LOCKED 2026-07-20]

- **Decision:** Four PRD-level rules become blocking, executable checks:

  | Invariant | Mechanism | Where |
  |---|---|---|
  | **Exactly one network egress point** | `no-restricted-globals` on `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` + `no-restricted-imports` on `node:http(s)`, `node:net`, `node:tls`, `node:dgram`, `axios`, `undici`, `node-fetch` — **globally**, with a single-file allowlist override for `src/main/pricing/fetch-price-table.ts` | `eslint.config.js` |
  | **Query seam** (ADR-008) | `no-restricted-imports` zones: `src/renderer/**` may not import `src/main/**`, `better-sqlite3*`, `node:fs`, `node:path`, `electron`; SQL text permitted only under `src/main/db/**` | `eslint.config.js` |
  | **No personal paths / no personal data** | `no-restricted-syntax` on string literals matching `^/Users/` in `src/**`, **plus** `scripts/guard-repo.mjs` grepping every git-tracked file (README, JSON, fixtures, docs) for `/Users/`, the author's name, and `.claude` real-data copies; also fails on any fixture > 256 KB | lint + `pnpm run guard` |
  | **No `os.homedir()` outside one file** | `no-restricted-properties` scoped to everything except `src/main/config/paths.ts` | `eslint.config.js` |
- **Because:** the PRD asks directly whether the single-egress rule is worth an enforceable gate. **It is, and it is cheap** — a `no-restricted-globals` entry plus one `files:` override, roughly fifteen lines total, and it makes "exactly one outbound call exists in the entire application" a fact the build proves rather than a claim a document makes. The same fifteen-line move buys the seam rule and the personal-path rule. All three are properties an agent working alone six weeks from now cannot violate by accident. The personal-path check needs a script rather than lint because it must cover non-TypeScript files, which is where a personal path actually leaks (a README example, a fixture, a committed settings snapshot).
- **Rejected:** *`dependency-cruiser@18.1.0`* for the seam. Real cost of rejecting: a much richer boundary language and a dependency graph visualization. Accepted, because `no-restricted-imports` zones cover the two boundaries this app has, inside a tool the check command already runs. *A runtime egress interceptor* (monkey-patching `fetch` in main) — rejected as a *replacement*; it can only catch what executes, whereas lint catches what exists. Worth adding later as defence in depth, not as the gate.
- **Constrains:** Any legitimate future exception needs an explicit config change with a reason — visible in review, which is the point.
- **Revisit if:** a second egress point is ever authorized. That is a PRD change, not a config change.

### ADR-016 — Distribution: there is no deploy target. Source only.  [LOCKED 2026-07-20 · **AMENDED 2026-07-22** · **AMENDED 2026-07-23**]

> ⚠️ **AMENDED 2026-07-22 — the *Revisit if* below fired: the user asked for a double-clickable app, and `DESIGN.md` **ADR-038** grants it as a thin, gitignored, dependency-free `.app` launcher. Everything this ADR forbids still holds — no packaging toolchain, no signing, no `.dmg`, no store, no release binary — and the **$99/yr prerequisite claimed in the last line is wrong for the local case**: it is the price of distributing to other people. Read ADR-038 before citing this ADR.

- **Decision:** **There is no deploy target, and this file will not invent one.** No `electron-builder`, no `electron-forge`, no packaging config, **no packaging dependency installed at all**. No code signing, no notarization, no `.dmg`, no auto-update, no store, no release binary, no CI release job. Distribution is: clone the repo, `pnpm install`, `pnpm run dev`. No CI platform matrix — macOS only (OQ-106), and a matrix for platforms nobody supports is a gate that lies.
- **Because:** PRD non-goal #6 and `DESIGN_INPUT.md` §11. Note this **removes `electron-builder` from `DESIGN_INPUT.md` §8 and `HANDOFF.md` §3**, which both list it as present-but-unused. An installed-but-unconfigured packaging tool is a dependency, a lockfile entry, a security-audit surface and a standing invitation for a later agent to "finish" it. **`PRD.md`'s Constraints section carried the same present-but-unused wording and has since been corrected to match this ADR — all three current documents now agree; the two `docs/source/` files are historical and stay as they are.**
- **Rejected:** *Keeping `electron-builder` installed but unconfigured* — the source docs' position; rejected for the reasons above. *An unsigned `.dmg`* — free, but forces every user through a right-click→Open Gatekeeper dance, and `DESIGN_INPUT.md` §11 already deferred it.
- **Constrains:** `release-runbook` in the manifest below is therefore **not** a deployment gate. It exists, and it verifies the two things that actually ship: that a **cold clone on a machine with no prior state** can run `pnpm install && pnpm run check` green — that is where ADR-006's dual-ABI install is most likely to fail, and it is the one release risk this project genuinely has — and that **`pnpm run e2e` opens a real window** (ADR-018), because a cold clone that type-checks but does not launch is not a release. `harness-forge` must **author** that gate from this ADR, not substitute a deployment template.
- **Revisit if:** the user asks for a double-clickable app. That is a scope change with a $99/yr Apple Developer Program prerequisite.
- **AMENDED 2026-07-23.** Distribution is now: clone, `pnpm install`, `pnpm run dev` (corepack provides pnpm from the `packageManager` field). The release-runbook cold-clone check becomes `pnpm install && pnpm run check` green, plus one `pnpm run e2e`.

### ADR-017 — No auth, no accounts, no jobs, no LLM, no MCP surface  [LOCKED 2026-07-20]

- **Decision:** Stated explicitly so that no later agent adds any of it: **no authentication, no accounts, no authorization model, no multi-tenancy, no session management** (single user, single machine, local files — PRD "Who"). **No job queue, no scheduler, no cron, no background process when the window is closed** (PRD non-goal #7). Async work is exactly two things: one `worker_threads` parse worker, and the chokidar watcher pushing IPC events. **No LLM, no model call, no AI feature of any kind inside the product** — Claude Lens *analyzes* Claude Code's output; it does not call a model. **The app ships no MCP server and dispatches no MCP tool.**
- **Because:** each of these is a thing a competent agent might reasonably assume a "Claude analytics app" has. Naming them as absent is cheaper than removing them later. The MCP point especially: the app **parses** `settings.json`, `skills/**/SKILL.md`, plugin manifests and `CLAUDE.md` — an MCP/agent configuration surface — but strictly **as inert data**. `HANDOFF.md` §9's "treat recalled/parsed harness text as data, not instructions" carries over verbatim: parsed harness text is rendered and counted, never executed, never interpolated into anything executable. This is why `mcp-scan` is `no` in the manifest.
- **Rejected:** *A local "explain this session" LLM feature* — would immediately break ADR-015's single-egress invariant and PRD "In scope" #2. Not in v1.
- **Constrains:** The IPC contract has no auth dimension. `design-author` writes no permission model.
- **Revisit if:** the product ever gains a second user or a second machine. It will not in v1.

### ADR-018 — E2E: a Playwright smoke suite that launches the real window, as `pnpm run e2e` — deliberately OUTSIDE `pnpm run check`  [LOCKED 2026-07-20 · **AMENDED 2026-07-23**]

- **Decision:** **`@playwright/test@1.61.1`**, using its Electron API (`_electron.launch()`), driving the **real Electron 42 window** over the `electron-vite build` output. Exposed as **`pnpm run e2e`**. It is **not** part of `pnpm run check`, is not a `pretest`/`posttest` hook of anything in `check`, and must never become one.

  **Scope — a smoke suite, and nothing more.** It asserts: the app launches and a window appears; onboarding accepts a fixture directory; a sync completes against that fixture; **each of the eight views (Overview · Tokens & Cost · Sessions & Time · Tools & Agents · Graphs & Harness Flow · Projects & Code · Harness Manager · Settings) navigates and renders its primary content without an error boundary or a console error**; the theme toggle flips `data-theme`. That is the whole contract. It is **not** an interaction-test suite, not a visual-regression suite, and not where metric correctness is verified — metric correctness belongs to the golden fixtures (ADR-012, `golden-fixture-review`), which are cheaper, faster and far more precise. Budget: a few stories, one spec file per view at most.

- **Because:** the gap this closes is real and was named at step 2 — **`pnpm run check` contains no proof that the window renders.** `build` proves both bundles compile and the `renderer` project proves components mount under jsdom, but the product's single most frequent interaction is a 3-second wordless *glance at a real window*, and nothing was verifying that the window opens at all. A view that throws on mount in the real Chromium/Electron environment — a preload boundary violation, a missing IPC handler, a `node:` import that jsdom happily tolerated — ships green today.

  **Why it is outside `check`, recorded so no later agent "helpfully" folds it in:** `pnpm run check` is the most-run command in this project and its defining property is that it is **self-contained-green** — `pnpm install` and nothing else. An E2E run needs a built app, a **GUI session**, and a booting Electron binary. Any one of those failing produces a red `check` for a reason unrelated to the change under test, and an agent reading that will correctly reason *"this failure is environmental"* — and then apply the same reasoning to the next failure, which is real. **A flaky check command is worse than no check command, because it teaches agents to disbelieve it.** That is the entire argument, and it is why the boundary is drawn here rather than at convenience. `e2e` is permitted to have hidden preconditions **only because** it is not `check`; the moment it is folded in, `check` inherits every one of them.

- **Preconditions — stated in full, because this is exactly the class `check` is forbidden to have:**
  1. **A built app.** `e2e` runs `electron-vite build` first; it does not test source.
  2. **The Electron binary**, at `node_modules/.bin/electron` — installed by `pnpm install` via the existing `electron` devDependency. `_electron.launch()` uses it by default.
  3. **An interactive macOS login session with a window server.** Electron cannot open a window over a plain SSH connection with no logged-in GUI session. There is **no Xvfb equivalent on macOS** — this cannot be made headless. Consequence, stated so nobody wires it into a job that then silently skips: this gate runs on the developer's machine, not in a headless context. (Moot in practice — ADR-016: there is no CI.)
  4. **Network: none.** Verified, and better than expected: **`playwright@1.61.1` ships no install/postinstall script** (confirmed against the published tarball's `package.json`, not the registry metadata), so `pnpm install` downloads **no browser binaries**. Playwright's Chromium/Firefox/WebKit builds are fetched only by an explicit `npx playwright install`, which this project never runs — Electron automation drives Electron's own binary. So `pnpm run e2e` adds **no network requirement beyond the `pnpm install` that already needed the registry and github.com**, and needs none at run time.
  5. **Fixture data and a scratch userData dir** — see the safety rule below. Injected by the launcher; never defaulted.

- **Safety — the same rule as everywhere else, with no exceptions, and it needed extending:** ⚠️ **ADR-013's home-directory tripwire does NOT cover this path as written.** That tripwire is a Vitest `setupFiles` assertion, and E2E launches the **real application in a separate process** where Vitest setup files never load. This is the one context in the project where a mistake reaches the delete subsystem. Three extensions, all required:
  1. **The tripwire moves into production code.** `src/main/config/paths.ts` — already the only file permitted to call `os.homedir()` (ADR-015) — gains a startup assertion: when `CLAUDE_LENS_E2E=1` is set, resolving either the Claude data directory or `userData` to a path under the real `<home>/.claude` is a fatal error that exits non-zero. It cannot be reached by accident because it is the same file every path resolution already goes through.
  2. **The launcher asserts before spawning.** `e2e/support/launch.ts` builds a fresh sandbox per spec, asserts it is under `os.tmpdir()`, and refuses to launch otherwise. It passes `CLAUDE_LENS_DATA_DIR=<sandbox>/claude-fixture`, `CLAUDE_LENS_E2E=1`, and `--user-data-dir=<sandbox>/userdata` — the last so the run cannot touch the developer's real `claude-lens.db`, which lives in `app.getPath('userData')` and is **not** inside `~/.claude` and so is not covered by rule 1.
  3. **The smoke suite is read-only by construction.** It **never invokes a guarded action** — no delete, no backup, no undo, no "clear backups". The Harness Manager view is asserted to *render*, not to *act*. The delete subsystem is covered by Vitest integration tests against sandboxes, where ADR-013's isolation fully applies and `guarded-action-review` gates it. This is the strongest of the three protections because it removes the capability rather than guarding it.

- **Rejected:** *No E2E at all* — my step-2 position, and the user overrode it. The override is correct on the merits: the reasoning that kept it out of `check` does not justify keeping it out of the repo. *Folding `e2e` into `pnpm run check`* — rejected for the reason above; this is the failure mode the ADR exists to prevent. *WebdriverIO with `wdio-electron-service`* — arguably the more purpose-built Electron harness, with better packaged-app support; rejected because Playwright is one dependency with no install-time download, the project needs no packaged-app testing (ADR-016), and a second full test framework alongside Vitest is real ongoing cost. *Reusing Vitest's browser mode* — cannot launch Electron's main process at all.
- **Honest cost:** **Playwright's Electron support is officially marked experimental** and has been for years. It works and is widely used, but it is not covered by Playwright's stability guarantees, and an upstream change can break it in a minor. Acceptable for a smoke suite that is not in the critical path of `check`; it would not be acceptable if `check` depended on it — which is a second, independent reason for the boundary.
- **Constrains:** `design-author` should give each of the eight views a stable test hook (`data-testid` on the view root and its primary content region) so the smoke suite selects on structure rather than on copy or on `FRONTEND.md` styling, both of which will churn. E2E specs live in `e2e/`, are excluded from the Vitest `projects` globs (ADR-012), and are excluded from `tsconfig.test.json`'s Vitest project into their own tsconfig — otherwise Playwright's and Vitest's global `expect` types collide.
- **Revisit if:** the suite becomes flaky enough that anyone proposes retries. Retries on a smoke suite mean the smoke suite is lying; fix or delete it rather than retry it.
- **AMENDED 2026-07-23.** The suite is exposed as `pnpm run e2e`. The check contract "needs `npm ci` and nothing else" is now "`pnpm install` and nothing else" (cold clone / CI: `pnpm install --frozen-lockfile`). Everything else in this ADR stands — e2e is still outside `check`.

---

## The check command

```
pnpm run check
```

**Composition** — one command, six steps, fail-fast, cheapest-and-most-localized first:

```jsonc
{
  "scripts": {
    "guard":        "node scripts/guard-repo.mjs",
    "format:check": "prettier --check .",
    "lint":         "eslint . --max-warnings 0",
    "typecheck":    "tsc --build --force",
    "build":        "electron-vite build && node scripts/check-bundle-externals.mjs",
    "test":         "vitest run",

    "check": "pnpm run guard && pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test",

    "e2e": "pnpm run build && playwright test -c e2e/playwright.config.ts"
  }
}
```

⚠️ **`e2e` is deliberately NOT in `check`, and must never be added to it** — not as a step, not as a `posttest` hook, not "just in CI". See ADR-018: it needs a built app, a booting Electron binary and a **GUI session**, and `check`'s defining property is that it needs `pnpm install` and nothing else. Folding `e2e` in makes `check` inherit every one of those preconditions, and a `check` that fails for environmental reasons teaches agents to disbelieve it.

| Step | What it proves |
|---|---|
| `guard` | No personal path, no personal data, no oversized fixture in any git-tracked file (ADR-015). ~200 ms; runs first so the publicly-shared-repo invariant fails before anything expensive. |
| `format:check` | Prettier 3.9.5, whole repo. Never `--write` inside `check` — a check command that mutates the tree is not a check. |
| `lint` | ESLint 10.7.0, type-aware, `--max-warnings 0`. Carries the four ADR-015 invariants: single egress, query seam, no personal paths, `os.homedir()` confinement. |
| `typecheck` | `tsc --build` over the solution tsconfig → `tsconfig.main.json`, `tsconfig.preload.json`, `tsconfig.renderer.json`, `tsconfig.shared.json`, `tsconfig.test.json`. **This is also the IPC contract gate**: main and renderer are typed against one shared channel map, so drift is a compile error (which is why `api-contract-sync` is `no` below). |
| `build` | `electron-vite build`, **followed by `node scripts/check-bundle-externals.mjs`** (added at step 4 — see the ADR-010 note below). esbuild does **not** typecheck, so this is not redundant with the step above — it catches externalization mistakes (ADR-010's ESM-only chokidar), bad import paths, and preload/renderer boundary violations that only appear at bundle time. Does **not** require the Electron binary. |
| `test` | `vitest run` across all three projects (ADR-012). Last because it is the slowest and its failures are the most informative once everything else is clean. |

**Preconditions, and how each is satisfied automatically:**

- **`pnpm install`.** That is the entire list. There is no service to start, no container, no database server, no environment variable to export, no file that must exist outside the repo, and no step that requires being run from a particular subdirectory.
- The one non-obvious precondition is **ADR-006's two native binaries**, and it is satisfied by the `postinstall` hook inside `pnpm install` — not by a human remembering. `postinstall` fetches the Electron-ABI prebuild for `better-sqlite3-electron`; the Node-ABI prebuild for `better-sqlite3` arrives with the normal install. For the pins in ADR-002/005 on macOS arm64 and x64, **both are downloaded, not compiled** — no Xcode Command Line Tools required. If a prebuild is ever missing, `@electron/rebuild` falls back to `node-gyp`, which is slower and needs a compiler; that fallback is exactly what the Electron 42 pin exists to avoid, and what `release-runbook` verifies.
- **Network:** `pnpm install` needs the npm registry **and** `github.com` (prebuilt binaries are GitHub release assets). `pnpm run check` itself needs **no network at all** — no dependency audit, no remote schema, no fixture download. It runs on a plane. Adding `@playwright/test` (ADR-018) changes none of this: verified against the published tarball, `playwright@1.61.1` ships **no install/postinstall script**, so `pnpm install` downloads no browser binaries and `pnpm run e2e` needs no network either.

**Deliberately not in `check`, each with its reason:** `pnpm run e2e` (ADR-018 — GUI session, booting binary); `pnpm audit` (needs network); a coverage threshold (ADR-014 — coverage is reported, never gated).

**Test isolation (ADR-013), named explicitly:**

- **Per-worker sandbox roots.** `useSandbox()` → `os.tmpdir()/claude-lens-tests/w${VITEST_POOL_ID}/${mkdtemp}`. `VITEST_POOL_ID` partitions across workers; `mkdtemp` guarantees uniqueness within one. Torn down in `afterEach`. No test names a fixed path; fixtures are copied in before mutation.
- **One SQLite file per test**, inside that sandbox. Never shared, never repo-relative. `:memory:` only for pure SQL-shape unit tests — anything touching the manifest, byte offsets, WAL or migrations uses a real file.
- **Home-directory tripwire.** A global `setupFiles` assertion throws if any path resolves under the real `<home>/.claude`; ESLint confines `os.homedir()` to one file; `CLAUDE_LENS_DATA_DIR` is injected in tests, never defaulted. **This app deletes files — every test runs against fixtures, and the real `~/.claude` is unreachable by construction, not by convention.**
- **Pools:** `main` uses `forks` (native addon + real file I/O + per-file process isolation); `renderer` and `shared` use `threads`.

**Red when broken — verifiable at step 4 (`scaffold`) by actually running it:** break a metric's arithmetic → `test` fails; add a `fetch(` outside the pricing file → `lint` fails; add a real `/Users/<name>` home path to the README → `guard` fails; import `better-sqlite3` from a component → `lint` fails; rename a DB column → `test` fails; change an IPC payload on one side only → `typecheck` fails; externalize an ESM-only dependency → `build` fails.

---

## Gate manifest  (`harness-forge` reads this; ONLY these gates are emitted)

**Tier: `full`** — from `<!-- TIER: full -->` in `PRD.md`, ~68 stories, user-agreed and not provisional (OQ-010).

| Gate | small | standard | full | Stack condition |
|---|---|---|---|---|
| regression-run | **no** | yes | **yes** | ✅ Vitest 4 suite with three projects; `pnpm run check` is a single self-contained entry point. |
| code-review | **no** | **no** | **yes** | ✅ Multi-month, many-session build; ADRs exist to cite. The guarded-delete subsystem must not be built without one. |
| docs-sync | **no** | **no** | **yes** | ✅ `DESIGN.md`, `PLAN.md`, `STACK.md` and a public `README.md` are all load-bearing and will drift. |
| db-migration-review | **no** | **inline** | **yes** | ✅ ADR-007: numbered SQL migrations + `PRAGMA user_version`. Non-obvious and decisive: `price_rows`, `audit_log` and `settings` are **user data with no other source**, not rebuildable cache — a careless "drop and re-sync" destroys hand-corrected price history. |
| api-contract-sync | **no** | **inline** | **no** | ❌ **Nothing is generated from a spec.** The IPC contract is one shared TypeScript channel map (ADR-003) that both sides compile against, so drift is a `typecheck` failure inside `pnpm run check`. A gate would have no artifact to diff and would report success for doing nothing. |
| design-token-lint | **no** | **inline** | **yes** | ✅ `FRONTEND.md` §2–§4 is a real token system (surfaces, accents, an 8-hue categorical ramp, semantic colors, a 7-step spacing scale, radii) and it is **binding**. ADR-004 materializes it in one `tokens.css`, so the rule is runnable: no raw hex/rgb/hsl literal and no raw px spacing outside that file. |
| dependency-security-audit | **no** | **no** | **yes** | ✅ ~30 third-party runtime deps including a native addon that executes at load. `pnpm audit --omit=dev` runs. (Deliberately **not** in `pnpm run check` — it needs network, and the check command must not.) |
| mcp-scan | **no** | **no** | **no** | ❌ **The product ships no MCP server and dispatches no MCP tool** (ADR-017). It *parses* `settings.json`, `SKILL.md`, plugin manifests and `CLAUDE.md` strictly as inert data — rendered and counted, never executed. There is no LLM and no model call anywhere in the app. Nothing to scan. |
| perf-profiling | **no** | **no** | **yes** | ✅ **RESOLVED from `DESIGN.md` §8 by `harness-forge` (2026-07-21); was `DEFERRED`.** §8 commits to **37 numeric, measurable, failable targets — P-01…P-37** across ingest (§8.2), query (§8.3), the nine-hour steady state (§8.4), interaction (§8.5), payload limits (§8.6) and a11y/security/privacy (§8.7), each with a stated measurement method (§8.1: p95 of 20 runs after 3 warm-ups; a target with no percentile is a hard ceiling on every run) and a fixed reference dataset (~1 GB / 2,064 files / 236,030 records, measured against a **generated synthetic** dataset of the same shape, never personal data). The three that carry the most weight: **P-08** — every repository method backing a view ≤ 200 ms p95, which is the numeric DuckDB trigger from OQ-102/ADR-005; **P-13/P-14/P-15** — the idle-CPU and RSS/heap-growth ceilings that the "kept open all day" trigger makes load-bearing rather than cosmetic; and **P-01** — cold parse ≤ 30 s hard / ≤ 10 s target. The gate is emitted as `.claude/skills/perf-profiling/`, dispatched at epic boundaries from the first epic that lands a parser path, a repository query or a view, and folded into the epic gate alongside `code-review`. |
| release-runbook | **no** | **no** | **yes (author, do not substitute)** | ⚠️ **No deploy target exists** (ADR-016: source only, no signing, no `.dmg`, no store, no CI release). The template must **not** be substituted — a deployment runbook here would be a gate that lies. Author it from ADR-016 + ADR-006: the release act is publishing source that strangers `pnpm install`, and the gate verifies a **cold clone on a machine with no prior state** runs `pnpm install && pnpm run check` green. That is precisely where the dual-ABI native install fails, and it is this project's only real release risk. **Its checklist must also include one `pnpm run e2e` run** — a cold clone that type-checks but whose window does not open is not a release. |
| **e2e-smoke** | **no** | **no** | **yes (author, new gate)** | ✅ **Project-specific; no template covers it.** Dispatches `pnpm run e2e` (ADR-018) at **epic boundaries**, alongside `regression-run`, and is referenced again by `release-runbook`. One gate file, two dispatch points. **It gets a row precisely because it is not in `check`:** nothing else would ever run it, and an E2E suite nobody runs is worse than none because it reads as coverage. The gate must state its own preconditions verbatim from ADR-018 — built app, Electron binary, **interactive macOS GUI session, not headless-capable** — and must **fail loudly rather than skip** when they are absent, since a silently-skipped gate is the exact failure this manifest exists to prevent. It must also record that the suite is read-only by construction and never invokes a guarded action. |
| **golden-fixture-review** | **no** | **no** | **yes (author, new gate)** | ✅ **Project-specific; no template covers it.** The PRD's defining quality bar is "a silently wrong number," recorded as a hard gate. Any story adding or changing a parser path, a metric definition, or a costing rule must land a fixture under `test/fixtures/` with a **hand-computed expected value** — not `toMatchSnapshot()`, which blesses whatever the code currently emits (ADR-012). Mandatory coverage named by the PRD: subagent roll-up (neither double-counted nor dropped — 72% of output tokens ride on it); incremental append == cold parse; malformed JSON lines; `<synthetic>` exclusion; ms-epoch vs ISO normalization; a costing fixture spanning a **price change**; a costing fixture with **no applicable price row** (excluded from `$` *and* surfaced, never zero-filled). |
| **guarded-action-review** | **no** | **no** | **yes (author, new gate)** | ✅ **Project-specific; no template covers it.** This app deletes files in the user's real config directory. Any story touching `src/main/actions/**` must demonstrate, with a test: confirm → **backup before mutate** → undo → audit-trail entry; the `<claudeDir>/.claude-lens-backups/` exclusion from Bloat Radar, analytics and the watcher (OQ-103 — without it the app flags its own safety net as bloat and offers to delete it); and that **nothing is ever auto-deleted, including backups** (PRD non-goal #4). |
| egress-audit | **no** | **no** | **no** | ❌ Already enforced inside `pnpm run check` by ADR-015's lint rules, on every run. A separate gate would duplicate a check that cannot be skipped, and dispatch effort at something already proven. |
| query-seam-review | **no** | **no** | **no** | ❌ Same reason: ADR-008's boundary is an ESLint import zone, enforced on every `pnpm run check`. A review gate for a rule the compiler already blocks is ceremony. |

**Three values, and `inline` is not the same as `yes`:** `yes` → `harness-forge` emits the gate as its own skill file. `no` → not emitted; **emitting it anyway is a BLOCKER**, because nothing dispatches it and an orphan skill file is a gate you believe you have and don't. `inline` → the check exists but folded into `story-reviewer` step 5 rather than as a separate file (only relevant at `standard`; this project is `full`).

**Rows marked "author, do not substitute" / "author, new gate"** require `harness-forge` to write the gate from the contract in the Stack-condition column rather than substituting a template. Substituting a generic template into `release-runbook` in particular would produce a signing/notarization checklist for a project that has neither.

---

## ADR numbering handoff

Last ADR issued here: **ADR-018**. `design-author` continues at **ADR-019**. There is one ADR namespace for this project; do not restart at ADR-001.

*(ADR-018 was added after the first draft of this file, when the user overrode the "no E2E in v1" decision. An earlier revision — and any note derived from it — said "continues at ADR-018"; that is stale. **ADR-019.**)*

---

## Not chosen, deliberately

Recorded so a later agent does not add them back, and so the reasoning is not re-derived wrongly.

- **DuckDB** — *not adopted, and explicitly not foreclosed* (OQ-102). SQLite is locked for v1. The re-open condition is numeric and measurable: **any dashboard query exceeding ~200 ms on the full dataset**. ADR-008's seam is what makes that a contained change. Do not pre-emptively adopt it; do not pre-emptively rule it out.
- **`node:sqlite`** (built into Node 22+/Electron's Node) — would have eliminated ADR-006's entire dual-ABI apparatus. Rejected: still experimental across the v22/v24 lines with an API that can change in minors, and `better-sqlite3` is locked by the PRD. Revisit around Node 26 LTS.
- **An ORM or query builder** (Prisma, Drizzle, Kysely) — ADR-007. Prisma additionally means a second native binary.
- **`electron-builder` / `electron-forge`** — removed entirely, including as an unused dependency. Contradicts `DESIGN_INPUT.md` §8 and `HANDOFF.md` §3 deliberately (ADR-016).
- **`reactflow` (v11)** — the package named in `DESIGN_INPUT.md` §8 is the deprecated line, last published 2024-06-20. Superseded by `@xyflow/react` v12 (ADR-011). Do not reinstate the old name.
- **`react-force-graph`** — listed as an option in §8; `cytoscape` chosen instead for deterministic layout over a fixed 33-node graph (ADR-011).
- **Biome / oxlint** — ADR-014. Faster, but no type-aware linting, which is what ADR-015's invariants are built from.
- **Jest** — ADR-012. A second transform pipeline for no gain.
- **`stream-json` / `ndjson` / `JSONStream`** — ADR-009. `node:readline` is sufficient for strictly line-delimited JSON and adds no dependency.
- **~~An E2E suite driving the real Electron window~~ — REVERSED by the user, 2026-07-20. Now adopted: see ADR-018.** Recorded rather than deleted, because the shape of the reversal is the useful part. Step 2 rejected E2E entirely, flagging it as its least-confident call; the user took the middle option — **a Playwright smoke suite behind a separate `pnpm run e2e`, explicitly NOT in `check`.** The architectural half of the original reasoning survived intact (`check` stays self-contained and free of any GUI-session dependency); what was rejected was treating "no automated proof the window renders" as an acceptable v1 risk. **What remains genuinely not chosen: an interaction/visual-regression E2E suite.** ADR-018 is a smoke suite — eight views render, and nothing more. Metric correctness is golden-fixture territory (ADR-012), which is cheaper, faster and more precise; do not migrate assertions from there into `e2e`.
- **WebdriverIO + `wdio-electron-service`** — the more purpose-built Electron harness, with better packaged-app support. Rejected in ADR-018: this project never packages (ADR-016), and a second full test framework alongside Vitest is real ongoing cost.
- **Playwright browser binaries** — never installed. `npx playwright install` is not run and is not needed; Electron automation drives `node_modules/.bin/electron`. This is why adding Playwright cost the install story nothing.
- **A coverage threshold** — ADR-014. Coverage is reported, never gated; `golden-fixture-review` is the real bar.
- **Cross-platform CI matrix** — macOS only (OQ-106). A Windows/Linux job for platforms nobody tests or claims is a gate that reports success for nothing. Code stays platform-clean anyway (`os.homedir()`, `node:path`, no literal separators) so a future port is small.
- **Any second network call, any telemetry, analytics, crash reporting, update check, remote font or remote asset** — exactly one egress point exists (ADR-015), and it is enforced by the check command.
- **Any LLM or model call inside the product** — ADR-017.
