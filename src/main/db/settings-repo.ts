// The `settings` repository. DESIGN §3.13, §4.3. STACK ADR-008 (the seam).
//
// ⚠️ `settings` is USER class (§2.2, ADR-026): hand-entered, with no other source. A purge
// never touches it — see `PERSISTENCE_CLASS_BY_TABLE` in `repositories/base.ts`, which
// `purge.ts` reads before it deletes anything. That is the classification encoded as a
// value; this constant is the same fact stated where a reader of this file will meet it.
//
// ⚠️ `electron-store` is NOT used (ADR-030), deliberately contradicting HANDOFF §3: one
// persistence store, one migration chain, one backup story. If you find yourself reaching
// for a second store, you have misread the design (CLAUDE.md §2).

import type {
  GlobalFilter,
  ReduceMotionPreference,
  SettingKey,
  SettingsSnapshot,
  ThemePreference,
} from '../../shared/ipc-contract';
import { DbError } from './errors';
import { Repository, type PersistenceClass } from './repositories/base';
import type { SqliteDatabase } from './sqlite';

/** §2.2 — encoded, not commented. `purge.ts` and `db-migration-review` both key on this. */
export const SETTINGS_PERSISTENCE_CLASS: PersistenceClass = 'USER';

// ---------------------------------------------------------------------------------------
// The typed key/default table — DESIGN §3.13.
//
// ⚠️ `SettingsSnapshot`, `SettingKey`, `GlobalFilter`, `ThemePreference` and
// `ReduceMotionPreference` are IMPORTED from `src/shared/ipc-contract.ts` (§4.2/§4.3), never
// restated here. `settings:set` returns a `SettingsSnapshot` across IPC, so main and renderer
// must compile against ONE definition (§12.1 item 6, ADR-031) — a ninth key, a renamed key or
// a changed value type is then a type error in this file rather than a runtime disagreement
// between the two processes. What this file owns is the half the contract cannot express:
// each key's DEFAULT and its runtime VALIDATOR.
// ---------------------------------------------------------------------------------------

export type { GlobalFilter, ReduceMotionPreference, SettingKey, SettingsSnapshot, ThemePreference };

/**
 * Reported when a PERSISTED value could not be used and its documented default was
 * substituted (the E6 ruling — see `snapshot()`). ⚠️ The offending VALUE is deliberately not
 * carried: a `claudeDir` is an absolute path and §7.3 forbids one reaching the log.
 */
export interface SettingsFallback {
  readonly key: SettingKey;
  readonly reason: 'invalid-json' | 'invalid-value';
}

export type SettingsFallbackListener = (fallback: SettingsFallback) => void;

/** A key's declared type and default, plus the validator every write passes through. */
interface SettingDefinition<Value> {
  readonly defaultValue: Value;
  /** Returns the accepted value, or `undefined` when the input is not of the declared type. */
  readonly parse: (value: unknown) => Value | undefined;
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const asNullableAbsolutePath = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  // Type-shape only. Existence, writability and INV-19's containment rules are checked by
  // the §4.3 handler BEFORE it calls `set` — `src/main/db/**` never touches the filesystem.
  return value.startsWith('/') ? value : undefined;
};

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const asEnum = <Value extends string>(
  allowed: readonly Value[],
): ((value: unknown) => Value | undefined) => {
  return (value: unknown): Value | undefined =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value)
      ? (value as Value)
      : undefined;
};

/** §3.13: 5–60, step 5. Not clamped and not rounded — an out-of-range value is rejected. */
const asIdleGapMinutes = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < 5 || value > 60 || value % 5 !== 0) return undefined;
  return value;
};

/**
 * A-12 — the session-efficiency flag threshold, a fraction in [0.05, 0.95]. Like `idleGapMinutes`
 * it is REJECTED, never clamped and never rounded, when out of range (CLAUDE.md §1: never
 * substitute). No step is enforced: unlike the minute slider a percentage has no natural integer
 * grid, and the panel's slider only ever emits in-range values.
 */
const asEfficiencyDropThreshold = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0.05 || value > 0.95) return undefined;
  return value;
};

const asNullableEpochMs = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
};

const asGlobalFilter = (value: unknown): GlobalFilter | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;

  let projectIds: number[] | null;
  if (candidate['projectIds'] === null || candidate['projectIds'] === undefined) {
    projectIds = null;
  } else if (
    Array.isArray(candidate['projectIds']) &&
    candidate['projectIds'].every((id) => typeof id === 'number' && Number.isSafeInteger(id))
  ) {
    // Copied, not aliased: the caller's array must not become the persisted one.
    projectIds = [...(candidate['projectIds'] as number[])];
  } else {
    return undefined;
  }

  const from = asNullableEpochMs(candidate['from'] ?? null);
  const to = asNullableEpochMs(candidate['to'] ?? null);
  if (from === undefined || to === undefined) return undefined;
  // §4.2's range is half-open [from, to); an inverted range is not a filter.
  if (from !== null && to !== null && to <= from) return undefined;
  return { projectIds, from, to };
};

/**
 * The declared type and default of every key, in one place, exactly as §3.13's table.
 * ⚠️ A key that is not in this object does not exist: unknown keys are ignored on read and
 * rejected on write with `E_UNKNOWN_SETTING` (§3.13, §4.1).
 */
export const SETTING_DEFINITIONS: {
  readonly [K in SettingKey]: SettingDefinition<SettingsSnapshot[K]>;
} = {
  claudeDir: { defaultValue: null, parse: asNullableAbsolutePath },
  idleGapMinutes: { defaultValue: 15, parse: asIdleGapMinutes },
  theme: { defaultValue: 'system', parse: asEnum<ThemePreference>(['system', 'dark', 'light']) },
  priceFetchUrl: { defaultValue: '', parse: asString },
  archiveRoot: { defaultValue: null, parse: asNullableAbsolutePath },
  lastGlobalFilter: {
    defaultValue: { projectIds: null, from: null, to: null },
    parse: asGlobalFilter,
  },
  sidebarCollapsed: { defaultValue: false, parse: asBoolean },
  reduceMotionOverride: {
    defaultValue: 'system',
    parse: asEnum<ReduceMotionPreference>(['system', 'reduce', 'full']),
  },
  // ⚠️ ADR-041 — default TRUE, and the default is the whole point. The app's stated bar is
  // "never destroys data" (PRD "What matters" #4) and non-goal #4 is "never auto-deletes
  // anything." Deleting a session's derived history because its file vanished is the same
  // violation the app already refuses for the user's own files, so retain-by-default is the
  // value-consistent choice, not a surprise. It is a setting so a user who wants a pure mirror
  // of `<claudeDir>` can turn it OFF (§3.13, §5.3).
  retainOrphanedHistory: { defaultValue: true, parse: asBoolean },
  // A-12 — the session-efficiency flag threshold. Default 0.40 ("flag when efficiency drops below
  // 40% of how the session started"). Purely presentational; no metric reads it. Added here, with
  // no DB migration, exactly as ADR-041's `retainOrphanedHistory` was: `settings` is a key/value
  // table (§3.13), so a new key needs a definition, not a schema change.
  efficiencyDropThreshold: { defaultValue: 0.4, parse: asEfficiencyDropThreshold },
};

export const SETTING_KEYS: readonly SettingKey[] = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

/**
 * ⚠️ The half of the E6 ruling that a test can hold: **no default may be a filesystem path.**
 *
 * Falling back to a documented default is safe for a theme and unsafe for the root directory of
 * a delete subsystem. `claudeDir` and `archiveRoot` therefore default to `null` — onboarding,
 * and "ACT-07 unavailable" — and this predicate is what makes a later edit that "helpfully"
 * defaults `claudeDir` to a resolved `~/.claude` fail rather than ship.
 */
export function defaultsAreSafe(): boolean {
  return SETTING_KEYS.every((key) => {
    const value = SETTING_DEFINITIONS[key].defaultValue;
    return typeof value !== 'string' || !value.startsWith('/');
  });
}

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTING_DEFINITIONS, key);
}

// ---------------------------------------------------------------------------------------
// SQL — §3.13. `settings` is `WITHOUT ROWID`, keyed on `key`.
// ---------------------------------------------------------------------------------------

const SELECT_ALL = 'SELECT key, value_json FROM settings';
const SELECT_ONE = 'SELECT value_json FROM settings WHERE key = ?';
const UPSERT = `INSERT INTO settings (key, value_json, created_at, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`;

interface SettingRow {
  readonly key: string;
  readonly value_json: string;
}

export class SettingsRepository extends Repository {
  /** §2.2 — USER class. Never purged, never dropped, carried across every migration. */
  static readonly persistenceClass: PersistenceClass = SETTINGS_PERSISTENCE_CLASS;

  constructor(db: SqliteDatabase) {
    super(db);
  }

  /**
   * The full §4.3 `SettingsSnapshot`. Absent keys take their §3.13 default; **unknown keys
   * present in the table are ignored** (§3.13), because a key this build does not know about
   * is either from a newer build or from hand-editing, and neither is ours to interpret.
   *
   * ⚠️ **A known key whose PERSISTED value is corrupt falls back to its documented default and
   * is reported through `onFallback` so the caller logs it** (E6 ruling, 2026-07-22 — §3.13
   * does not cover the case and it was carried as an open question).
   *
   * The reasoning, so it is not re-argued: §5.1 reserves `FATAL` for migration failure and DB
   * corruption. One bad settings row is neither, and an app whose entire value is *being
   * glanceable* must not brick over a hand-edited `theme`. The fallback is not silent — it is
   * a `warn` line naming the key — so "never substitute" is honoured in the sense that
   * matters: the substitution is disclosed rather than hidden.
   *
   * ⚠️ **`claudeDir` is the one exception, and it is not an exception to the mechanism but to
   * what "default" is allowed to mean.** Its documented default is `null` (→ onboarding,
   * §6.2), and it must fall back to exactly that, never to a guessed `~/.claude`. `claudeDir`
   * is the input to a **delete** subsystem (§5.7, ADR-032): guessing a path there is
   * categorically different from guessing a theme. `SETTING_DEFINITIONS.claudeDir.defaultValue`
   * is `null` for this reason, and `defaultsAreSafe` below pins it so no later edit can turn
   * it into a resolved path without failing a test.
   */
  snapshot(onFallback?: SettingsFallbackListener): SettingsSnapshot {
    const stored = new Map<string, string>();
    for (const row of this.all<SettingRow>(SELECT_ALL)) {
      stored.set(row.key, row.value_json);
    }

    const result: Record<string, unknown> = {};
    for (const key of SETTING_KEYS) {
      const raw = stored.get(key);
      result[key] =
        raw === undefined
          ? SETTING_DEFINITIONS[key].defaultValue
          : parseOrDefault(key, raw, onFallback);
    }
    return result as unknown as SettingsSnapshot;
  }

  /**
   * One key's effective value: the persisted one if present and valid, else its documented
   * default. Same ruling, same reasoning as `snapshot()` above.
   */
  get<K extends SettingKey>(key: K, onFallback?: SettingsFallbackListener): SettingsSnapshot[K] {
    assertKnownKey(key);
    const row = this.one<{ value_json: string }>(SELECT_ONE, key);
    if (row === undefined) return SETTING_DEFINITIONS[key].defaultValue;
    return parseOrDefault(key, row.value_json, onFallback) as SettingsSnapshot[K];
  }

  /**
   * Validates against the declared type, then persists. §3.13: "Every value is validated
   * against its declared type before persisting; an invalid value never reaches the table."
   *
   *   unknown key   → `E_UNKNOWN_SETTING`
   *   invalid value → `E_INVALID_SETTING`
   *
   * Returns the full new snapshot, which is what `settings:set` responds with (§4.3).
   */
  set(key: string, value: unknown, now: number): SettingsSnapshot {
    assertKnownKey(key);
    const definition = SETTING_DEFINITIONS[key];
    const parsed = definition.parse(value);
    if (parsed === undefined) {
      throw new DbError(
        'E_INVALID_SETTING',
        `The value provided for the setting "${key}" is not valid for its type.`,
        { retryable: false },
      );
    }
    // One transaction, so a rejected value cannot leave a half-written row and the returned
    // snapshot is the state that was actually committed (§4.3: "It never partially applies").
    return this.transaction(() => {
      this.run(UPSERT, key, JSON.stringify(parsed), now, now);
      return this.snapshot();
    });
  }
}

function assertKnownKey(key: string): asserts key is SettingKey {
  if (!isSettingKey(key)) {
    throw new DbError('E_UNKNOWN_SETTING', `"${key}" is not a setting this app recognises.`, {
      retryable: false,
    });
  }
}

/**
 * The E6 ruling, in one place so `snapshot()` and `get()` cannot diverge: an unusable stored
 * value yields the documented default and a report. It never throws — a read of `settings` is
 * on the boot path (§5.1), and a throw there would turn one bad row into an unstartable app.
 */
function parseOrDefault(
  key: SettingKey,
  raw: string,
  onFallback: SettingsFallbackListener | undefined,
): SettingsSnapshot[SettingKey] {
  const definition = SETTING_DEFINITIONS[key];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    onFallback?.({ key, reason: 'invalid-json' });
    return definition.defaultValue;
  }
  const parsed = definition.parse(decoded);
  if (parsed === undefined) {
    onFallback?.({ key, reason: 'invalid-value' });
    return definition.defaultValue;
  }
  return parsed;
}
