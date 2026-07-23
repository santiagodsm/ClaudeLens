// §4.9 — push events, main → renderer. One `evt:` channel each, delivered over
// `webContents.send`. §7.4: push only, no polling, no reconnection logic, no subscription
// protocol — main and renderer share a process tree and IPC does not drop.
//
// ⚠️ **No push event ever focuses, raises or animates the window** (§1.3 moment 2, §6.2).
// `evt:dataChanged` causes a silent re-query and an in-place number update, nothing more.
// That is enforced structurally here: the only capability this module is given is `send`.
// A `BrowserWindow` is never handed to an emitter, so `focus()`, `show()`, `moveTop()` and
// `flashFrame()` are not reachable from any code that emits an event. The app sits in
// peripheral vision nine hours a day; anything that steals focus is a product defect.

import type { PushChannel, PushEmitterMap, PushPayload } from '../../shared/ipc-contract';

/**
 * The one capability an emitter gets. Deliberately NOT `BrowserWindow` and deliberately not
 * `WebContents` either — both carry focus/raise methods.
 */
export interface PushSender {
  /** True while a renderer is attached. A closed window drops events silently (§7.6). */
  isAlive(): boolean;
  send(channel: PushChannel, payload: unknown): void;
}

/** Every push channel name, as a runtime value. Mapped over `PushEmitterMap` below, so a
 *  channel added to §4.9 that is missing here is a `typecheck` failure. */
export const PUSH_CHANNELS = [
  'evt:sync',
  'evt:dataChanged',
  'evt:pricingChanged',
  'evt:actionCompleted',
  'evt:dirStatus',
  'evt:fatal',
] as const satisfies readonly PushChannel[];

/**
 * §4.9's emitter table. Mapped over `PushChannel`, so a missing emitter is a compile error.
 *
 * ⚠️ The `evt:sync` 4 Hz cap (P-22) is NOT applied here. `SyncCycle` already throttles its own
 * emissions to one per 250 ms (`PROGRESS_INTERVAL_MS`), and a second throttle in this file
 * would drop phase transitions — which §4.9 requires to be emitted immediately. One throttle,
 * at the source, where the state is cumulative and dropping an intermediate frame loses
 * nothing.
 */
export function createPushEmitters(sender: PushSender | null): PushEmitterMap {
  const emit = <C extends PushChannel>(channel: C) => {
    return (payload: PushPayload<C>): void => {
      if (sender === null || !sender.isAlive()) return;
      sender.send(channel, payload);
    };
  };

  return {
    'evt:sync': emit('evt:sync'),
    'evt:dataChanged': emit('evt:dataChanged'),
    'evt:pricingChanged': emit('evt:pricingChanged'),
    'evt:actionCompleted': emit('evt:actionCompleted'),
    'evt:dirStatus': emit('evt:dirStatus'),
    'evt:fatal': emit('evt:fatal'),
  };
}

/** Emitters that go nowhere — used before a window exists and in tests. */
export function noPushEmitters(): PushEmitterMap {
  return createPushEmitters(null);
}
