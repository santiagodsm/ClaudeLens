// Type-level tests for src/shared/ipc-contract.ts — DESIGN §4, ADR-031.
//
// ⚠️ This file is the E1 half of the IPC-drift gate. §4's preamble and ADR-031 say drift must
// be "a `typecheck` failure inside `npm run check`", which is why `api-contract-sync` is `no`
// in the gate manifest: there is no generated artifact to diff, because THE COMPILER IS THE
// GATE. So the assertions below are mostly compile-time. A `@ts-expect-error` here fails
// `tsc --build` if the error it expects stops happening — which is precisely the property
// "an unknown channel cannot key the map" needs.

import { describe, expectTypeOf, it } from 'vitest';
import type {
  ActionType,
  AppError,
  AuditStatus,
  DirStatus,
  GlobalFilter,
  IpcChannel,
  IpcChannels,
  IpcHandlerMap,
  IpcInvoke,
  IpcRequest,
  IpcResponse,
  OverviewTiles,
  Page,
  Paged,
  PushChannel,
  PushPayload,
  Result,
  SessionRow,
  SessionSort,
  SettingKey,
  SettingsSnapshot,
  SessionsPage,
  SkillRow,
  SkillSort,
  SyncState,
  UncostedSummary,
  WorkingDayRow,
} from '../../src/shared/ipc-contract';

// ---------------------------------------------------------------------------
// The negative half of the gate: each alias below MUST fail to compile.
//
// `@ts-expect-error` inverts the check — if a line ever stops erroring (because a channel name
// was widened to `string`, or the two maps were merged), `tsc --build` fails with "Unused
// '@ts-expect-error' directive". That is the assertion; it cannot be satisfied at runtime.
// They are exported so `noUnusedLocals` has nothing to say about them.
// ---------------------------------------------------------------------------

// @ts-expect-error 'q:notAChannel' is not a member of IpcChannels
export type UnknownChannelRequest = IpcRequest<'q:notAChannel'>;

// @ts-expect-error 'q:notAChannel' is not a member of IpcChannels
export type UnknownChannelResponse = IpcResponse<'q:notAChannel'>;

// @ts-expect-error a channel name is a member of a closed union, never an arbitrary string
export type LooseChannelRequest = IpcRequest<string>;

// @ts-expect-error push channels live in their own map (§4.9); they are not invocable
export type PushChannelIsNotInvocable = IpcRequest<'evt:sync'>;

// @ts-expect-error 'evt:nope' is not a member of PushChannels
export type UnknownPushPayload = PushPayload<'evt:nope'>;

// @ts-expect-error an invoke channel is not a push channel
export type InvokeChannelIsNotPushable = PushPayload<'q:overviewTiles'>;

// The two payloads that deliberately carry NO `overlapSeconds`. Both lines must stay errors.
//
// @ts-expect-error §6.8 / INV-22(d): a single-project scope has no overlap to disclose
export type ProjectCardsHasNoOverlap = IpcResponse<'q:projectCards'>['overlapSeconds'];
// @ts-expect-error M-07 binding (A) is one session; INV-23 binds only binding-(C) figures
export type SessionsPageHasNoOverlap = IpcResponse<'q:sessions'>['overlapSeconds'];

/**
 * The renderer-side call surface, asserted by compilation. **Never called** — every statement
 * inside is a type assertion, and calling it would only dereference a null `invoke`.
 */
export function invokeSurface(invoke: IpcInvoke, filter: GlobalFilter): void {
  // The channel picks the request type, and the answer is always the Result envelope —
  // never a bare payload, never a throw (ADR-031).
  expectTypeOf(invoke('q:overviewTiles', filter)).toEqualTypeOf<Promise<Result<OverviewTiles>>>();
  // A `void`-request channel takes one argument.
  expectTypeOf(invoke('settings:get')).toEqualTypeOf<Promise<Result<SettingsSnapshot>>>();

  // @ts-expect-error a GlobalFilter is not a { sessionId: string }
  void invoke('q:sessionDetail', filter);
  // @ts-expect-error an unknown channel cannot be invoked at all
  void invoke('q:notAChannel');
  // @ts-expect-error a channel with a request cannot be invoked without one
  void invoke('q:sessionDetail');
}

describe('§4 — the channel map is keyed by channel name and nothing else', () => {
  it('derives a request type from the channel name', () => {
    expectTypeOf<IpcRequest<'q:overviewTiles'>>().toEqualTypeOf<GlobalFilter>();
    expectTypeOf<IpcRequest<'q:sessionDetail'>>().toEqualTypeOf<{ sessionId: string }>();
    expectTypeOf<IpcRequest<'sync:cancel'>>().toEqualTypeOf<void>();
    expectTypeOf<IpcRequest<'audit:list'>>().toEqualTypeOf<Page>();
  });

  it('derives a response type from the channel name', () => {
    expectTypeOf<IpcResponse<'q:overviewTiles'>>().toEqualTypeOf<OverviewTiles>();
    expectTypeOf<IpcResponse<'sync:state'>>().toEqualTypeOf<SyncState>();
    expectTypeOf<IpcResponse<'settings:get'>>().toEqualTypeOf<SettingsSnapshot>();
    expectTypeOf<IpcResponse<'q:sessions'>>().toEqualTypeOf<SessionsPage>();
    expectTypeOf<IpcResponse<'q:sessions'>['page']>().toEqualTypeOf<Paged<SessionRow>>();
    expectTypeOf<IpcResponse<'q:skills'>>().toEqualTypeOf<Paged<SkillRow>>();
    expectTypeOf<IpcResponse<'q:uncosted'>>().toEqualTypeOf<UncostedSummary>();
  });

  it('admits only known channel names', () => {
    expectTypeOf<IpcChannel>().toExtend<string>();
    expectTypeOf<'q:overviewTiles'>().toExtend<IpcChannel>();
    expectTypeOf<'q:notAChannel'>().not.toExtend<IpcChannel>();
    expectTypeOf<'evt:sync'>().not.toExtend<IpcChannel>();
  });

  it('keeps the invoke surface honest on both sides (ADR-031)', () => {
    // The body of `invokeSurface` below is the assertion; it is checked by `tsc` and never run.
    expectTypeOf(invokeSurface).toBeFunction();
  });

  it('makes the main-side handler table exhaustive', () => {
    // IpcHandlerMap is a mapped type over IpcChannel, so a channel added to §4 and left
    // unhandled is a compile error in main — and a handler for a channel that does not exist
    // is one too. That is the "changing one side alone is a compile error" property.
    expectTypeOf<keyof IpcHandlerMap>().toEqualTypeOf<IpcChannel>();
    expectTypeOf<keyof IpcHandlerMap>().toEqualTypeOf<keyof IpcChannels>();

    type OverviewHandler = IpcHandlerMap['q:overviewTiles'];
    expectTypeOf<Parameters<OverviewHandler>[0]>().toEqualTypeOf<GlobalFilter>();
    expectTypeOf<ReturnType<OverviewHandler>>().toEqualTypeOf<
      Result<OverviewTiles> | Promise<Result<OverviewTiles>>
    >();
  });
});

describe('§4.9 — the push map is separate from the invoke map', () => {
  it('derives a push payload from the channel name', () => {
    expectTypeOf<PushPayload<'evt:sync'>>().toEqualTypeOf<SyncState>();
    expectTypeOf<PushPayload<'evt:dirStatus'>>().toEqualTypeOf<DirStatus>();
    expectTypeOf<PushPayload<'evt:fatal'>>().toEqualTypeOf<AppError>();
    expectTypeOf<PushPayload<'evt:actionCompleted'>>().toEqualTypeOf<{
      auditId: number;
      status: AuditStatus;
    }>();
  });

  it('admits only known push channel names', () => {
    expectTypeOf<'evt:fatal'>().toExtend<PushChannel>();
    expectTypeOf<'q:overviewTiles'>().not.toExtend<PushChannel>();
    expectTypeOf<'evt:nope'>().not.toExtend<PushChannel>();
  });
});

describe('§4 — the closed vocabularies stay closed', () => {
  it('binds SettingKey to SettingsSnapshot so §3.13 cannot drift', () => {
    expectTypeOf<SettingKey>().toEqualTypeOf<keyof SettingsSnapshot>();
    expectTypeOf<'claudeDir'>().toExtend<SettingKey>();
    expectTypeOf<'somethingInvented'>().not.toExtend<SettingKey>();
  });

  it('keeps ActionType to the §5.7 catalogue (ADR-032)', () => {
    expectTypeOf<'archive-sessions'>().toExtend<ActionType>();
    expectTypeOf<'delete-everything'>().not.toExtend<ActionType>();
  });

  it('keeps SessionSort to the §4.5 sort keys', () => {
    expectTypeOf<'activeSeconds'>().toExtend<SessionSort>();
    expectTypeOf<'costNanoUsd'>().not.toExtend<SessionSort>();
  });
});

describe('§4.5 — INV-13: the ⛔ channels cannot be handed a GlobalFilter', () => {
  it('types the Harness Manager channels without one, so "all time" is structural', () => {
    // INV-13: invocation counts, "last used", "never used" and the runtime overlay are computed
    // over the FULL dataset. Giving these channels no GlobalFilter in their request type makes
    // that a compile-time property rather than a convention someone can forget.
    expectTypeOf<IpcRequest<'q:harnessGraph'>>().toEqualTypeOf<{ tab: 'harness' }>();
    expectTypeOf<IpcRequest<'q:claudeMdFiles'>>().toEqualTypeOf<void>();
    expectTypeOf<IpcRequest<'q:plugins'>>().toEqualTypeOf<void>();
    expectTypeOf<IpcRequest<'q:memories'>>().toEqualTypeOf<void>();
    expectTypeOf<IpcRequest<'q:skills'>>().toEqualTypeOf<Page & { sort: SkillSort }>();

    expectTypeOf<IpcRequest<'q:harnessGraph'>>().not.toExtend<GlobalFilter>();
    expectTypeOf<IpcRequest<'q:skills'>>().not.toExtend<GlobalFilter>();
  });
});

describe('§4.1 / §4.6 — the envelope and the disclosure rule', () => {
  it('never lets a payload escape the Result envelope', () => {
    expectTypeOf<Result<number>>().toEqualTypeOf<
      { ok: true; data: number } | { ok: false; error: AppError }
    >();
  });

  it('carries UncostedSummary in EVERY payload carrying a $ figure (INV-10)', () => {
    // The six `$`-bearing responses in §4.5/§4.6. Three of them — tokensByProject, projectCards
    // and sessions — gained the field in the 2026-07-22 (E1) amendment; before it they could
    // render a cost with no way to know it was incomplete, which is the exact failure INV-10
    // and §1.5 forbid. `uncosted` is REQUIRED, never optional: an optional disclosure is a
    // swallowable one.
    expectTypeOf<IpcResponse<'q:overviewTiles'>['uncosted']>().toEqualTypeOf<UncostedSummary>();
    expectTypeOf<IpcResponse<'q:costBreakdown'>['uncosted']>().toEqualTypeOf<UncostedSummary>();
    expectTypeOf<IpcResponse<'q:sessionDetail'>['uncosted']>().toEqualTypeOf<UncostedSummary>();
    expectTypeOf<IpcResponse<'q:tokensByProject'>['uncosted']>().toEqualTypeOf<UncostedSummary>();
    expectTypeOf<IpcResponse<'q:projectCards'>['uncosted']>().toEqualTypeOf<UncostedSummary>();
    expectTypeOf<IpcResponse<'q:sessions'>['uncosted']>().toEqualTypeOf<UncostedSummary>();
  });

  it('leaves the shared Paged<T> envelope free of disclosures', () => {
    // Widening Paged<T> would have forced `uncosted` optional on the payloads that have no `$`
    // figure, and an optional disclosure is one a caller can swallow. q:sessions embeds a page
    // instead; q:workingDays and q:audit:list stay plain.
    expectTypeOf<Paged<SessionRow>>().toEqualTypeOf<{
      rows: SessionRow[];
      nextCursor: string | null;
      totalKnown: number | null;
    }>();
    expectTypeOf<IpcResponse<'q:workingDays'>>().toEqualTypeOf<Paged<WorkingDayRow>>();
  });

  it('carries overlapSeconds alongside the binding-(C) Active-hours tile (INV-23)', () => {
    expectTypeOf<IpcResponse<'q:overviewTiles'>['overlapSeconds']>().toEqualTypeOf<number>();
  });

  it('deliberately omits overlapSeconds where INV-23 does not bind', () => {
    // The two aliases at the top of this file assert it by failing to compile.
    expectTypeOf<IpcResponse<'q:projectCards'>>().toHaveProperty('uncosted');
    expectTypeOf<IpcResponse<'q:sessions'>>().toHaveProperty('uncosted');
  });
});
