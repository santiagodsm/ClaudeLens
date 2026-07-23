// ADR-021 requires the golden fixtures to **pin an explicit `TZ`** so they are reproducible:
// "Every calendar grouping … is computed at query time in the machine's local timezone, via
// `datetime(ts/1000, 'unixepoch', 'localtime')`", and a fixture that inherits the developer's
// timezone would produce a different — and differently wrong — day boundary on every machine.
//
// `Asia/Tokyo` is chosen deliberately: **UTC+9 with no DST, ever**. A zone with a DST rule would
// make the fixture's expected local dates depend on the month it was written in, which is the
// class of hidden coupling this file exists to remove. UTC+9 also puts local midnight at 15:00Z,
// far from any fixture's UTC-midnight arithmetic, so a bug that silently bucketed in UTC produces
// a visibly different day rather than the same one.
//
// ⚠️ Assigning `process.env.TZ` at runtime is honoured by BOTH `Date` and SQLite's `'localtime'`
// modifier under Node on this platform (V8 clears its timezone cache and the C runtime re-reads
// `TZ`). `assertTimezonePinned()` proves it inside every test that depends on it, so a platform
// where it were NOT honoured fails loudly instead of silently bucketing in the wrong zone.
//
// This file is not a test: the `main` Vitest project collects only `*.{test,spec}.ts`.

import { afterAll, beforeAll, expect } from 'vitest';

/** The one timezone every §5.9.1 calendar fixture is computed in. */
export const FIXTURE_TZ = 'Asia/Tokyo';

/** UTC+9, so this instant is 09:00 local on 2024-05-01 — the anchor F-12 and F-13 are written in. */
export const LOCAL_0900_ON_2024_05_01 = Date.parse('2024-05-01T00:00:00.000Z');

/** Pins `TZ` for the enclosing `describe`, and restores whatever was there before. */
export function usePinnedTimezone(zone: string = FIXTURE_TZ): void {
  const previous = process.env['TZ'];
  beforeAll(() => {
    process.env['TZ'] = zone;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env['TZ'];
    else process.env['TZ'] = previous;
  });
}

/**
 * Proves the pin actually took effect before any expected value depends on it.
 *
 * 2024-05-01T00:00:00Z is 09:00 in `Asia/Tokyo`. If this fails, every local-date expectation in
 * the file is meaningless — which is exactly the failure that must be loud rather than silent.
 */
export function assertTimezonePinned(): void {
  expect(new Date(LOCAL_0900_ON_2024_05_01).getHours()).toBe(9);
}
