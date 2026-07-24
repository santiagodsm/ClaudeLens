// The main-side registration table — DESIGN §4, ADR-031.
//
// ⚠️ `IpcHandlerMap` is a mapped type over EVERY channel in `src/shared/ipc-contract.ts`, so
// **an unhandled channel and an invented channel are both compile errors.** That is the check;
// there is deliberately no runtime registry assertion duplicating it, because a runtime copy of
// the channel list is exactly the drift the one-map design exists to prevent (§4 preamble).
//
// ⚠️ **One `withResult()` wrapper around every handler** (§4.1 rule 1). It is applied here, in
// one loop, rather than per handler — a handler that forgot its wrapper would otherwise reject
// the `invoke` promise, and the renderer would see a lossy string instead of an error `code`.
//
// ⚠️ **There is no "warning" channel** (§4.1 rule 4). Nothing below returns a partial result as
// an error, and nothing returns a fabricated success. A channel whose repository does not exist
// yet returns `notImplemented()` — never zeroes, never empty rows (CLAUDE.md §1).
//
// ⚠️ **AMENDED 2026-07-22 (E12) — there are no `notImplemented` channels left.** Every channel in
// the contract is composed from a repository that already existed. `test/integration/
// all-channels.test.ts` walks `IpcChannels` itself and calls every one against a real sandboxed
// database seeded through the real parser, so a channel added to §4 and forgotten here fails a
// test rather than reaching a user as an `ErrorState` over a finished data layer.

import type {
  DirPickResult,
  IpcChannel,
  IpcHandlerMap,
  IpcRequest,
  Result,
} from '../../shared/ipc-contract';
import type { ActionService } from '../actions/service';
import type { HarnessService } from '../harness/service';
import type { Logger } from '../log/logger';
import type { PricingService } from '../pricing';
import type { DatasetService } from './dataset';
import { HandlerError, withResult } from './errors';

/** The `ipcMain.handle` surface this module needs. Narrow, so a fake is honest. */
export interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>): void;
  removeHandler?(channel: string): void;
}

export interface HandlerDeps {
  readonly dataset: DatasetService;
  readonly pricing: PricingService;
  /** E10 — §4.8's harness scan and Bloat Radar, plus §4.5's four ⛔ INV-13 channels. */
  readonly harness: HarnessService;
  /** E10 — §5.5's guarded-action lifecycle and §4.8's audit/backup/archive channels. */
  readonly actions: ActionService;
  readonly logger: Logger;
  /**
   * §4.3 `dir:pick`. Injected because the picker is `electron.dialog`, and this module must
   * stay compilable and testable without an Electron window (§7.2).
   * Resolves `null` when the user cancelled — ⚠️ cancellation is DATA, not an error (§4.3).
   */
  readonly pickDirectory: () => Promise<string | null>;
}

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

/** Every channel in §4, in the order §4 declares them. */
export function createHandlers(deps: HandlerDeps): IpcHandlerMap {
  const { actions, dataset, harness, pricing } = deps;

  return {
    // ---- §4.3 Bootstrap and settings ----
    'app:bootstrap': () => ok(dataset.bootstrap()),
    'settings:get': () => ok(dataset.settingsSnapshot()),
    /**
     * ⚠️ `key = 'claudeDir'` validates FIRST and, on success, triggers the purge-and-full-sync
     * transition of §5.1. **It never partially applies**: `DatasetService.setSetting` refuses
     * before writing, and the write itself is one transaction (§4.3).
     */
    'settings:set': async (req) => ok(await dataset.setSetting(req.key, req.value)),
    'dir:pick': async (): Promise<Result<DirPickResult>> => {
      const path = await deps.pickDirectory();
      // §4.3 — "Cancellation is data, not an error."
      if (path === null) return ok({ cancelled: true });
      return ok({ cancelled: false, path, validation: await dataset.validate(path) });
    },
    'dir:validate': async (req) => ok(await dataset.validate(req.path)),

    // ---- §4.4 Sync ----
    'sync:start': (req) => ok(dataset.startSync(req.kind)),
    'sync:cancel': () => ok(dataset.cancelSync()),
    'sync:state': () => ok(dataset.syncState()),
    /**
     * A-16 — the explicit rebuild of §3.18, the only path that re-reads a transcript the app has
     * already committed. ⚠️ **Not a guarded action**: it mutates no file, so it is not ACT-08 and
     * the closed catalogue of §5.7 is unchanged (ADR-032). Purge (DERIVED only, both RETAINED
     * markers guarded) then one full cycle — the pair §5.1 already runs on a directory change.
     */
    'sync:rebuild': () => ok(dataset.rebuildDerived()),

    // ---- §4.5 Analytics queries — E4's repositories (§5.9 M-01…M-20), wired by E12 ----
    //
    // ⚠️ **AMENDED 2026-07-22 (E12).** Every line below used to be `notImplementedHandler(…, E4)`
    // while E4's repository behind it was complete and fixture-tested. The whole of Overview,
    // Tokens & Cost, Sessions & Time, Tools & Agents and Projects & Code rendered an `ErrorState`
    // in the running app over a finished data layer. Nothing here computes anything: each line
    // composes `dataset.analytics`, the SAME façade E11 used for the four graph channels, so a
    // §5.9 metric is still defined exactly once (CLAUDE.md §1, the A-10 lesson).
    //
    // ⚠️ `dataset.queryContext(req)` is the ONE way a `GlobalFilter` becomes a `QueryContext`:
    // it reads `idleGapMinutes` from `settings` per request (ADR-022, INV-05). No handler builds
    // one by hand, so a stale threshold cannot reach one channel and not another.
    'q:overviewTiles': (req) => ok(dataset.analytics.overviewTiles(dataset.queryContext(req))),
    'q:activityCalendar': (req) =>
      ok(dataset.analytics.activityCalendar(dataset.queryContext(req), req.weeks)),
    'q:modelMixTimeline': (req) =>
      ok(dataset.analytics.modelMixTimeline(dataset.queryContext(req), req.bucket)),
    'q:tokensByModel': (req) =>
      ok(dataset.analytics.tokensByModel(dataset.queryContext(req), req.bucket, req.mode)),
    'q:tokensByProject': (req) => ok(dataset.analytics.tokensByProject(dataset.queryContext(req))),
    'q:cacheEfficiency': (req) => ok(dataset.analytics.cacheEfficiency(dataset.queryContext(req))),
    // A-11 — where cache-read volume concentrates, by session (§6.4, replaced the gauge).
    'q:contextOverhead': (req) => ok(dataset.analytics.contextOverhead(dataset.queryContext(req))),
    'q:costBreakdown': (req) =>
      ok(dataset.analytics.costBreakdown(dataset.queryContext(req), req.by)),
    'q:sessionHistogram': (req) =>
      ok(dataset.analytics.sessionHistogram(dataset.queryContext(req))),
    'q:rhythmHeatmap': (req) => ok(dataset.analytics.rhythmHeatmap(dataset.queryContext(req))),
    'q:workingDays': (req) => ok(dataset.analytics.workingDays(dataset.queryContext(req), req)),
    /**
     * ⚠️ Wired by **E11**, not E4, and only because §6.7's Execution Trace has no other way to
     * name a session: its tab is a session picker plus a spawn tree, and `q:sessions` is the
     * app's own list. Inventing a second session-listing channel for one tab would have been a
     * second source of truth for the same rows. The repository is E4's and is fixture-tested;
     * this line composes it.
     */
    'q:sessions': (req) =>
      ok(dataset.analytics.sessions(dataset.queryContext(req), req, req.sort, req.dir)),
    /**
     * ⚠️ §4.5 types the response as `SessionDetail`, not `SessionDetail | null`, so an unknown
     * `sessionId` has to be an error rather than a payload. §4.1's enum is CLOSED and carries no
     * not-found member, so this raises `E_INTERNAL` with the reason in `detail` rather than
     * inventing a code (CLAUDE.md §2 — cite, do not re-argue). ⚠️ Reported as a §4.1 gap: the
     * case is reachable in the running app, because a re-sync can purge a session between the
     * `q:sessions` page that offered the row and the click on it.
     * ⚠️ Never a fabricated empty `SessionDetail` — a session with zero of everything is
     * indistinguishable from a real one (CLAUDE.md §1).
     */
    'q:sessionDetail': (req) => {
      const detail = dataset.analytics.sessionDetail(
        req.sessionId,
        dataset.settingsSnapshot().idleGapMinutes,
      );
      if (detail === undefined) {
        throw new HandlerError('E_INTERNAL', 'That session is no longer in this dataset.', {
          detail:
            `q:sessionDetail found no session "${req.sessionId}". §4.1's error enum is closed ` +
            'and has no not-found member, so this is reported as E_INTERNAL rather than as an ' +
            'empty payload. See DESIGN §4.1 / §4.5.',
        });
      }
      return ok(detail);
    },
    'q:toolFingerprint': (req) => ok(dataset.analytics.toolFingerprint(dataset.queryContext(req))),
    'q:originSplit': (req) => ok(dataset.analytics.originSplit(dataset.queryContext(req))),
    'q:toolMixByProject': (req) =>
      ok(dataset.analytics.toolMixByProject(dataset.queryContext(req), req.topN)),
    'q:projectCards': (req) => ok(dataset.analytics.projectCards(dataset.queryContext(req))),
    /**
     * ADR-040 — the user's project groups. ⚠️ Four channels, and **none of them suggests one**:
     * §2.1's zero-inference rule forbids the app deciding that two folders are one project, so
     * there is no candidates/similar/suggested channel here and there must never be one. The user
     * names the group and picks its members.
     */
    'groups:list': () => ok(dataset.projectGroups()),
    'groups:create': (req) => ok(dataset.createProjectGroup(req.name, req.encodedNames)),
    'groups:rename': (req) => ok(dataset.renameProjectGroup(req.groupId, req.name)),
    /** Splits the group back apart. Every figure returns to its pre-group value exactly. */
    'groups:ungroup': (req) => ok(dataset.ungroupProjectGroup(req.groupId)),
    'q:fileMetrics': (req) =>
      ok(
        dataset.analytics.fileMetrics(
          dataset.queryContext(req),
          req,
          // ⚠️ Passed through as `undefined` rather than `null`: `fileMetrics` treats absence as
          // "every project", and a `null` project id would be a filter on nothing.
          req.projectId,
        ),
      ),
    // ---- §6.7's four graph channels — E11. ----
    /**
     * ⛔ INV-13 — all time, and it is a **compile-time** property: the request type carries no
     * `GlobalFilter` (E1), so there is nothing here to scope by even by mistake. M-14's runtime
     * overlay is computed by the query, never stored (ADR-027).
     */
    'q:harnessGraph': () => ok(dataset.analytics.harnessGraph()),
    'q:executionTrace': (req) => ok(dataset.analytics.executionTrace(req.sessionId)),
    'q:toolTransition': (req) => ok(dataset.analytics.toolTransition(dataset.queryContext(req))),
    'q:flowSankey': (req) => ok(dataset.analytics.flowSankey(dataset.queryContext(req))),
    // ⛔ INV-13 — the four Harness Manager channels. Their request types carry no
    // `GlobalFilter`, so "all time" is a compile-time property, not a convention (§4.5, §6.9).
    'q:skills': (req) => ok(harness.skills(req)),
    'q:claudeMdFiles': () => ok(harness.claudeMdFiles()),
    'q:plugins': () => ok(harness.plugins()),
    'q:memories': () => ok(harness.memories()),
    // ADR-039 — each project's own harness, grouped for §6.9's per-project sections. Read-only;
    // the request carries no `GlobalFilter`, so its counts are all time by construction (INV-13).
    'q:harnessProjects': () => ok(harness.projectHarness()),

    // ---- §4.6 Disclosures ----
    /**
     * ⚠️ **AMENDED 2026-07-22 (E12).** E6 left this not-implemented for two fields it could not
     * compute — `partialBefore` (M-16) and `activeOverlapSeconds` (M-20) — rather than ship a
     * `Disclosures` with two invented members, "because a caveat that is silently zero is not a
     * caveat". E4's repository computes both. `DatasetService.disclosures()` supplies the one
     * fact the database does not hold (D-2 `filesMissingSinceLastSync`, process-scoped).
     */
    'q:disclosures': (req) => ok(dataset.disclosures(dataset.queryContext(req))),
    /**
     * ✅ Implemented — M-05/M-06 exist and are fixture-tested by E5 (F-09). Delegated to
     * `CostRepository`, never reimplemented: a §5.9 metric is defined once (CLAUDE.md §1).
     */
    'q:uncosted': (req) =>
      ok(dataset.uncosted({ projectIds: req.projectIds, from: req.from, to: req.to })),

    // ---- §4.7 Pricing — E5. The seven handlers already exist; they are registered, not rewritten.
    ...pricing.handlers(),

    // ---- §4.8 Harness scan, guarded actions, audit, backups, archives — E10 ----
    'harness:scan': async () => ok(await harness.scan()),
    'bloat:list': () => ok(harness.bloatList()),
    /**
     * ⚠️ INV-06 — `action:preview` is what mints the `confirmToken`, bound to the exact resolved
     * target list and to a hash of it. It mutates nothing. `archives:candidates` below is the
     * read-only helper that turns "sessions older than X" into ACT-07's explicit session list;
     * it never mints a token (§4.8).
     */
    'action:preview': async (req) => ok(await actions.preview(req)),
    /**
     * ⚠️ Backup strictly precedes mutation (INV-07); the targets are RE-RESOLVED and the token
     * is redeemed against the new list (INV-06); the whole execution is bracketed with
     * `suspendWatcher()`/`resumeWatcher()` (§5.6); every terminal state writes exactly one
     * `audit_log` row (§5.5 rule 6). All four live in `src/main/actions/service.ts`.
     */
    'action:execute': async (req) => ok(await actions.execute(req)),
    'action:undoLast': async (req) => ok(await actions.undoLast(req)),
    'audit:list': (req) => ok(actions.auditList(req)),
    'backups:summary': () => ok(actions.backupsSummary()),
    'archives:list': () => ok(actions.archivesList()),
    'archives:candidates': (req) => ok(actions.archiveCandidates(req)),
  };
}

/**
 * Registers every handler behind exactly one `withResult()` (§4.1 rule 1).
 *
 * Returns the channel names it registered, so `src/main/index.ts` can tear them down on quit
 * and so a test can assert the set matches the contract's without a hand-maintained list.
 */
export function registerIpc(
  registrar: IpcRegistrar,
  handlers: IpcHandlerMap,
  logger: Logger,
): readonly IpcChannel[] {
  const channels = Object.keys(handlers) as IpcChannel[];
  for (const channel of channels) registerOne(registrar, channel, handlers, logger);
  return channels;
}

/**
 * One channel, generically — which is what keeps `IpcHandlerMap[C]` correlated with
 * `IpcRequest<C>`. Written as a separate function rather than inlined into the loop because
 * indexing the mapped type with the union `IpcChannel` collapses the correlation and would
 * force a cast that hides a real mismatch.
 */
function registerOne<C extends IpcChannel>(
  registrar: IpcRegistrar,
  channel: C,
  handlers: IpcHandlerMap,
  logger: Logger,
): void {
  const wrapped = withResult(channel, handlers[channel], logger);
  registrar.handle(channel, async (_event: unknown, ...args: unknown[]) =>
    // `void`-request channels arrive with no argument; the contract's `IpcRequestArgs`
    // guarantees the renderer sent either nothing or exactly one request object.
    wrapped(args[0] as IpcRequest<C>),
  );
}

/** Removes every handler. Called on quit so a relaunch in the same process cannot double-register. */
export function unregisterIpc(registrar: IpcRegistrar, channels: readonly IpcChannel[]): void {
  for (const channel of channels) registrar.removeHandler?.(channel);
}

export { HandlerError };
