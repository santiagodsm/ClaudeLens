// The `meta` repository. DESIGN §3.17. STACK ADR-008 (the seam).
//
// ⚠️ `meta` is DERIVED class and `settings` is USER class (§3.17, ADR-026). That one
// distinction decides what a purge may touch: `purge.ts` truncates this table on every
// `claudeDir` change and every explicit rebuild, and never touches `settings`. The
// classification is encoded in `PERSISTENCE_CLASS_BY_TABLE` (repositories/base.ts) and
// restated as a value below — it is not a comment, because a comment has a half-life.
//
// "Anything a rebuild can recompute belongs here, and nothing else does." If a value would
// be lost forever by a purge, it does not go in `meta`.
//
// ⚠️ Nothing in this table is a metric. `recordCounts` and `badLineTotal` are sync
// bookkeeping and progress reporting; every displayed number in §5.9 is computed at query
// time from `events`, `tool_calls`, `file_touches` and `price_rows` (ADR-027). A count read
// from here and rendered as a total would be exactly the stored-aggregate drift ADR-027
// exists to prevent.

import { DbError } from './errors';
import { Repository, type PersistenceClass } from './repositories/base';
import type { SqliteDatabase } from './sqlite';

/** §2.2 — encoded, not commented. `purge.ts` reads this classification before it deletes. */
export const META_PERSISTENCE_CLASS: PersistenceClass = 'DERIVED';

/** §5.2's two sync kinds. */
export type SyncKind = 'full' | 'incremental';

/** Sync-progress bookkeeping, never a displayed metric (ADR-027). */
export interface MetaRecordCounts {
  readonly events: number;
  readonly sessions: number;
  readonly projects: number;
  readonly toolCalls: number;
  readonly prompts: number;
}

/**
 * The closed key set of §3.17. A key not listed here does not exist; `meta` is bookkeeping
 * this build writes and reads, not an open key/value store.
 */
export interface MetaValues {
  readonly lastSyncCompletedAt: number;
  readonly lastSyncDurationMs: number;
  readonly lastSyncKind: SyncKind;
  readonly lastFullParseAt: number;
  /** sha256 of the absolute `claudeDir`, used to detect a directory change (§5.1). */
  readonly claudeDirFingerprint: string;
  readonly recordCounts: MetaRecordCounts;
  /** Total malformed JSON lines skipped; surfaced as a disclosure, never as an error (§4.6). */
  readonly badLineTotal: number;
  /** Runs with no resolvable spawn point; disclosed, never guessed (§3.7, §4.6). */
  readonly unlinkedSubagentRuns: number;
}

export type MetaKey = keyof MetaValues;

const META_KEY_VALIDATORS: { readonly [K in MetaKey]: (value: unknown) => value is MetaValues[K] } =
  {
    lastSyncCompletedAt: isEpochMs,
    lastSyncDurationMs: isNonNegativeInteger,
    lastSyncKind: (value): value is SyncKind => value === 'full' || value === 'incremental',
    lastFullParseAt: isEpochMs,
    claudeDirFingerprint: (value): value is string => typeof value === 'string',
    recordCounts: isRecordCounts,
    badLineTotal: isNonNegativeInteger,
    unlinkedSubagentRuns: isNonNegativeInteger,
  };

export const META_KEYS: readonly MetaKey[] = Object.keys(META_KEY_VALIDATORS) as MetaKey[];

export function isMetaKey(key: string): key is MetaKey {
  return Object.hasOwn(META_KEY_VALIDATORS, key);
}

// ---------------------------------------------------------------------------------------
// SQL — §3.17. `meta` is `WITHOUT ROWID`, keyed on `key`.
// ---------------------------------------------------------------------------------------

const SELECT_ONE = 'SELECT value_json FROM meta WHERE key = ?';
const SELECT_ALL = 'SELECT key, value_json FROM meta';
const UPSERT = `INSERT INTO meta (key, value_json, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`;
const DELETE_ONE = 'DELETE FROM meta WHERE key = ?';

interface MetaRow {
  readonly key: string;
  readonly value_json: string;
}

export class MetaRepository extends Repository {
  /** §2.2 — DERIVED class. Purged and rebuilt; nothing here is irreplaceable. */
  static readonly persistenceClass: PersistenceClass = META_PERSISTENCE_CLASS;

  constructor(db: SqliteDatabase) {
    super(db);
  }

  /**
   * The stored value, or `undefined` when the key has never been written.
   *
   * ⚠️ There are no defaults here, unlike `settings` (§3.13). "Never synced" and "synced,
   * result was zero" are different facts, and a default would erase the difference —
   * `undefined` is the honest answer and the caller discloses it (§4.6).
   */
  get<K extends MetaKey>(key: K): MetaValues[K] | undefined {
    assertKnownKey(key);
    const row = this.one<{ value_json: string }>(SELECT_ONE, key);
    if (row === undefined) return undefined;
    const decoded = decodeJson(row.value_json, key);
    return META_KEY_VALIDATORS[key](decoded) ? decoded : undefined;
  }

  /** Every known key present in the table. Unknown keys are ignored, as in §3.13. */
  snapshot(): Partial<MetaValues> {
    const result: Record<string, unknown> = {};
    for (const row of this.all<MetaRow>(SELECT_ALL)) {
      if (!isMetaKey(row.key)) continue;
      const decoded = decodeJson(row.value_json, row.key);
      if (META_KEY_VALIDATORS[row.key](decoded)) result[row.key] = decoded;
    }
    return result;
  }

  /** Writes one key. `now` is passed in, never read from a clock inside the seam. */
  set<K extends MetaKey>(key: K, value: MetaValues[K], now: number): void {
    assertKnownKey(key);
    if (!META_KEY_VALIDATORS[key](value)) {
      throw new DbError('E_INTERNAL', `The value for the meta key "${key}" has the wrong type.`, {
        retryable: false,
      });
    }
    this.run(UPSERT, key, JSON.stringify(value), now);
  }

  /** Writes several keys in one transaction, so a sync's bookkeeping lands atomically. */
  setMany(values: Partial<MetaValues>, now: number): void {
    this.transaction(() => {
      for (const key of META_KEYS) {
        const value = values[key];
        if (value === undefined) continue;
        this.set(key, value, now);
      }
    });
  }

  /** Removes one key. Used when a fact stops being true rather than becoming a new value. */
  clear(key: MetaKey): void {
    assertKnownKey(key);
    this.run(DELETE_ONE, key);
  }
}

function assertKnownKey(key: string): asserts key is MetaKey {
  if (!isMetaKey(key)) {
    throw new DbError('E_INTERNAL', `"${key}" is not a meta key defined by §3.17.`, {
      retryable: false,
    });
  }
}

function decodeJson(raw: string, key: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new DbError('E_INTERNAL', `The stored value for the meta key "${key}" is not JSON.`, {
      cause,
      retryable: false,
    });
  }
}

function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecordCounts(value: unknown): value is MetaRecordCounts {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (['events', 'sessions', 'projects', 'toolCalls', 'prompts'] as const).every((field) =>
    isNonNegativeInteger(candidate[field]),
  );
}
