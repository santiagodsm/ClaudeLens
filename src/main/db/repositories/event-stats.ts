// The plain event aggregates — DESIGN §5.9 M-01, M-02, M-03, M-04, M-11, M-16, M-17, M-18,
// and the two calendar surfaces of §6.3/§6.5.
//
// ⚠️ **M-01 is the population, and it is written out in one place.** "Synthetic events are
// excluded from every token, cost and model statistic." Every query in this file that touches
// `tok_*` or `model` carries `is_synthetic = 0`; the two that count *moments* rather than
// statistics say so and cite why (ADR-035's reasoning — a synthetic event is a real moment).
//
// ⚠️ **Origins roll up (§2.1, ADR-020, INV-02).** No query here filters `origin` unless it is
// explicitly partitioning by it (M-17). A subagent's tokens are the parent session's tokens.

import { Repository, sumToSafeNumber } from './base';
import {
  localDate,
  localHour,
  localWeekStart,
  localWeekday,
  scopeClause,
  type QueryContext,
} from './scope';
import type { SqliteDatabase } from '../sqlite';
import type { TimelineBucket } from '../../../shared/ipc-contract';

/**
 * M-04 — the class sums, always reported as separate numbers, never one.
 *
 * ⚠️ **AMENDED 2026-07-22 (A-05) — five, not four.** `cacheWrite` is the **5-minute** class and
 * `cacheWrite1h` the 1-hour one. ⚠️ `events.tok_cache_write_1h` is NULLABLE — NULL is "the split
 * is not known for this row" (migration 0005) — and every sum here reads `COALESCE(..., 0)`, so
 * a pre-A-05 row reports exactly what it reported before. How many such rows exist is DISCLOSED
 * (§4.6), which is what stops the zero being a claim rather than a placeholder.
 */
export interface TokenTotals {
  readonly input: number;
  readonly output: number;
  /** The **5-minute** cache-write class. Not "all cache writes". */
  readonly cacheWrite: number;
  /** The **1-hour** cache-write class. */
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
}

/**
 * §4.6 (A-05) — how many cache-writing events are still carrying the pre-split cache-write
 * total, partitioned by whether a re-sync can fix it.
 */
export interface CacheSplitCoverage {
  /** Live sessions: recoverable by a re-sync or a rebuild (DERIVED data is rebuildable). */
  readonly unknownEvents: number;
  /**
   * ⚠️⚠️ Archived sessions: **never** recoverable. Their transcripts have left the Claude data
   * directory and §5.3 `ARCHIVED` never re-parses them (§9.4, ADR-034).
   */
  readonly archivedEvents: number;
}

/**
 * §4.6 (ADR-041) — history kept from transcripts that are no longer in the Claude data directory
 * (`retained_orphan = 1`). Both counts feed the `q:disclosures` payload.
 */
export interface RetainedOrphanCoverage {
  /** Sessions with `retained_orphan = 1` — the number a human reads ("N sessions kept …"). */
  readonly sessions: number;
  /** Events whose source file is retained-orphan — the event-level companion. */
  readonly events: number;
}

/** The counts the Overview tiles and the Sessions header need. */
export interface EventCounts {
  /** M-11 — `role IN ('assistant','user')` over M-01, both origins. */
  readonly messages: number;
  /** Distinct `session_id` with at least one event in scope. */
  readonly sessions: number;
  /** §4.6 `Disclosures.syntheticEvents` — stored, counted, excluded from stats (M-01). */
  readonly syntheticEvents: number;
}

/** M-17 — one side of the origin split. */
export interface OriginTotalsRow extends TokenTotals {
  readonly messages: number;
  readonly toolCalls: number;
}

/** M-16 — what `DataCoverage` and `Disclosures.partialBefore` are computed from. */
export interface CoverageBounds {
  readonly transcriptsFrom: number | null;
  readonly transcriptsTo: number | null;
  readonly promptsFrom: number | null;
  readonly promptsTo: number | null;
  readonly statsCacheDays: number;
}

/** One `(bucket, series)` cell of a §4.5 `ModelTimeline`. */
export interface TimelineCell {
  readonly bucket: string;
  readonly model: string;
  readonly value: number;
}

// ---------------------------------------------------------------------------------------
// M-01 — the countable population, as a predicate, once.
// ---------------------------------------------------------------------------------------
const COUNTABLE = 'e.is_synthetic = 0';

/** M-11 — "`role IN ('assistant','user')`, **including** `origin='subagent'` (roll-up, §2.1)." */
const MESSAGE = `${COUNTABLE} AND e.role IN ('assistant', 'user')`;

const TOKEN_COLUMNS = `COALESCE(SUM(e.tok_input), 0)       AS input,
       COALESCE(SUM(e.tok_output), 0)      AS output,
       COALESCE(SUM(e.tok_cache_write), 0) AS cache_write,
       COALESCE(SUM(COALESCE(e.tok_cache_write_1h, 0)), 0) AS cache_write_1h,
       COALESCE(SUM(e.tok_cache_read), 0)  AS cache_read`;

interface TokenRecord {
  readonly input: number | bigint | null;
  readonly output: number | bigint | null;
  readonly cache_write: number | bigint | null;
  readonly cache_write_1h: number | bigint | null;
  readonly cache_read: number | bigint | null;
}

function readTokens(row: TokenRecord | undefined): TokenTotals {
  return {
    input: sumToSafeNumber(row?.input ?? null, 'tokens.input'),
    output: sumToSafeNumber(row?.output ?? null, 'tokens.output'),
    cacheWrite: sumToSafeNumber(row?.cache_write ?? null, 'tokens.cacheWrite'),
    cacheWrite1h: sumToSafeNumber(row?.cache_write_1h ?? null, 'tokens.cacheWrite1h'),
    cacheRead: sumToSafeNumber(row?.cache_read ?? null, 'tokens.cacheRead'),
  };
}

export class EventStatsRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** M-02 / M-03 / M-04 over M-01 in scope. */
  tokenTotals(context: QueryContext): TokenTotals {
    const scope = scopeClause(context.filter, 'e');
    return readTokens(
      this.one<TokenRecord>(
        `SELECT ${TOKEN_COLUMNS} FROM events e WHERE ${COUNTABLE}${scope.sql}`,
        ...scope.params,
      ),
    );
  }

  /** M-11 plus the two counts that are about rows rather than tokens. */
  counts(context: QueryContext): EventCounts {
    const scope = scopeClause(context.filter, 'e');
    // ⚠️ `sessions` and `syntheticEvents` deliberately do NOT carry the M-01 predicate: a
    // session containing only synthetic events still happened, and the synthetic disclosure is
    // a count OF the excluded rows. Only `messages` is a statistic.
    const row = this.one<{
      readonly messages: number | bigint | null;
      readonly sessions: number;
      readonly synthetic: number | bigint | null;
    }>(
      `SELECT COALESCE(SUM(CASE WHEN ${MESSAGE} THEN 1 ELSE 0 END), 0) AS messages,
              COUNT(DISTINCT e.session_id)                             AS sessions,
              COALESCE(SUM(e.is_synthetic), 0)                         AS synthetic
       FROM   events e
       WHERE  1 = 1${scope.sql}`,
      ...scope.params,
    );
    return {
      messages: sumToSafeNumber(row?.messages ?? null, 'messages'),
      sessions: row?.sessions ?? 0,
      syntheticEvents: sumToSafeNumber(row?.synthetic ?? null, 'syntheticEvents'),
    };
  }

  /**
   * M-17 — M-02/M-04/M-11/M-12 partitioned by `events.origin`.
   *
   * ⚠️ INV-02: `main + subagent` must equal the unpartitioned total **exactly**. The partition
   * is a `GROUP BY` over the same rows the unpartitioned query reads, with the same predicate,
   * so the equality is structural — there is no second population to drift. Tool calls are
   * counted from `tool_calls.origin` (§3.6 carries its own copy of the column) in the same
   * grouped query, which is what keeps M-12's split from being computed over a different scope
   * than M-02's. Fixture F-02 asserts the equality on real parsed data.
   */
  originSplit(context: QueryContext): { main: OriginTotalsRow; subagent: OriginTotalsRow } {
    const eventScope = scopeClause(context.filter, 'e');
    const rows = this.all<
      TokenRecord & { readonly origin: string; readonly messages: number | bigint | null }
    >(
      `SELECT e.origin AS origin,
              ${TOKEN_COLUMNS},
              COALESCE(SUM(CASE WHEN e.role IN ('assistant','user') THEN 1 ELSE 0 END), 0) AS messages
       FROM   events e
       WHERE  ${COUNTABLE}${eventScope.sql}
       GROUP BY e.origin`,
      ...eventScope.params,
    );
    const toolScope = scopeClause(context.filter, 't');
    const toolRows = this.all<{ readonly origin: string; readonly calls: number }>(
      `SELECT t.origin AS origin, COUNT(*) AS calls
       FROM   tool_calls t
       WHERE  1 = 1${toolScope.sql}
       GROUP BY t.origin`,
      ...toolScope.params,
    );

    const side = (origin: 'main' | 'subagent'): OriginTotalsRow => {
      const tokens = readTokens(rows.find((row) => row.origin === origin));
      return {
        ...tokens,
        messages: sumToSafeNumber(
          rows.find((row) => row.origin === origin)?.messages ?? null,
          'messages',
        ),
        toolCalls: toolRows.find((row) => row.origin === origin)?.calls ?? 0,
      };
    };
    return { main: side('main'), subagent: side('subagent') };
  }

  /**
   * §6.3 activity calendar — messages per **local** day (ADR-021), using M-11's definition of
   * "message" so the calendar and the origin split are counting the same thing.
   *
   * ⚠️ Only days with at least one message are returned. The grid is `weeks × 7` cells and the
   * renderer knows both numbers, so a missing day is unambiguous — whereas emitting
   * `{ day, messages: 0 }` for a day the dataset does not cover would be zero-filling, which
   * CLAUDE.md §1 forbids in absolute terms and which §6.12's partial-data treatment exists to
   * avoid. `weeks` bounds the range: the calendar ends on the local date of the **last event in
   * scope** and runs back `weeks × 7 − 1` days. §4.5 gives `weeks` no anchor, so it is anchored
   * to data rather than to `Date.now()` — nothing in this layer reads a clock (CLAUDE.md §1).
   */
  activityCalendar(context: QueryContext, weeks: number): { day: string; messages: number }[] {
    const scope = scopeClause(context.filter, 'e');
    const days = Math.max(1, Math.trunc(weeks)) * 7;
    return this.all<{ readonly day: string; readonly messages: number }>(
      `WITH scoped AS (
         SELECT ${localDate('e.ts')} AS day,
                CASE WHEN ${MESSAGE} THEN 1 ELSE 0 END AS is_message
         FROM   events e
         WHERE  1 = 1${scope.sql}
       ),
       last_day AS (SELECT MAX(day) AS day FROM scoped)
       SELECT day AS day, SUM(is_message) AS messages
       FROM   scoped
       WHERE  day > date((SELECT day FROM last_day), ?)
       GROUP BY day
       HAVING SUM(is_message) > 0
       ORDER BY day`,
      ...scope.params,
      `-${String(days)} days`,
    );
  }

  /**
   * §6.5 rhythm heatmap — local weekday × local hour (ADR-021).
   *
   * ⚠️ The population is **every** event, synthetic included, because this surface answers "when
   * was the person at the keyboard" rather than "how many tokens" — the same reading ADR-035
   * pins for M-07's stream ("they are real moments in the stream"). M-01's exclusion is scoped
   * by §5.9 to "every token, cost and model statistic", and a rhythm cell is none of those.
   * Empty cells are omitted rather than emitted as `0`, for the reason above.
   */
  rhythmHeatmap(context: QueryContext): { weekday: number; hour: number; events: number }[] {
    const scope = scopeClause(context.filter, 'e');
    return this.all<{ readonly weekday: string; readonly hour: string; readonly events: number }>(
      `SELECT ${localWeekday('e.ts')} AS weekday, ${localHour('e.ts')} AS hour, COUNT(*) AS events
       FROM   events e
       WHERE  1 = 1${scope.sql}
       GROUP BY weekday, hour
       ORDER BY weekday, hour`,
      ...scope.params,
    ).map((row) => ({
      weekday: Number.parseInt(row.weekday, 10),
      hour: Number.parseInt(row.hour, 10),
      events: row.events,
    }));
  }

  /**
   * §4.5 `q:modelMixTimeline` — **M-01 events per model per bucket**, i.e. which model was
   * being used and how often.
   *
   * ⚠️ §6.3 names the card "Model mix over time" and §4.5 gives it the same response shape as
   * `q:tokensByModel` without naming its measure. It is read as an event-count mix rather than a
   * token measure because `q:tokensByModel` already covers tokens under both of its modes, and
   * reading the two channels as the same quantity would make one of them redundant. Reported as
   * an under-specification rather than settled silently.
   */
  modelMixTimeline(context: QueryContext, bucket: TimelineBucket): TimelineCell[] {
    return this.#timeline(context, bucket, 'COUNT(*)');
  }

  /** §4.5 `q:tokensByModel` — M-02 (`output_only`) or all **five** classes summed (`all`). */
  tokensByModel(
    context: QueryContext,
    bucket: TimelineBucket,
    mode: 'all' | 'output_only',
  ): TimelineCell[] {
    const measure =
      mode === 'output_only'
        ? 'COALESCE(SUM(e.tok_output), 0)'
        : `COALESCE(SUM(e.tok_input + e.tok_output + e.tok_cache_write
             + COALESCE(e.tok_cache_write_1h, 0) + e.tok_cache_read), 0)`;
    return this.#timeline(context, bucket, measure);
  }

  #timeline(context: QueryContext, bucket: TimelineBucket, measure: string): TimelineCell[] {
    const scope = scopeClause(context.filter, 'e');
    const bucketExpression = bucket === 'week' ? localWeekStart('e.ts') : localDate('e.ts');
    return this.all<{
      readonly bucket: string;
      readonly model: string;
      readonly value: number | bigint;
    }>(
      // `model IS NOT NULL` because a series needs a name; ADR-025 forbids inventing one. Events
      // with no model are still counted everywhere a model is not the grouping key.
      `SELECT ${bucketExpression} AS bucket, e.model AS model, ${measure} AS value
       FROM   events e
       WHERE  ${COUNTABLE} AND e.model IS NOT NULL${scope.sql}
       GROUP BY bucket, model
       ORDER BY bucket, model`,
      ...scope.params,
    ).map((row) => ({
      bucket: row.bucket,
      model: row.model,
      value: sumToSafeNumber(row.value, 'timeline.value'),
    }));
  }

  /** M-16 — data coverage. `partialBefore` is derived from these four bounds by the caller. */
  coverage(): CoverageBounds {
    const row = this.one<{
      readonly transcripts_from: number | null;
      readonly transcripts_to: number | null;
      readonly prompts_from: number | null;
      readonly prompts_to: number | null;
      readonly stats_cache_days: number;
    }>(
      `SELECT (SELECT MIN(ts) FROM events)  AS transcripts_from,
              (SELECT MAX(ts) FROM events)  AS transcripts_to,
              (SELECT MIN(ts) FROM prompts) AS prompts_from,
              (SELECT MAX(ts) FROM prompts) AS prompts_to,
              (SELECT COUNT(*) FROM stats_cache_days) AS stats_cache_days`,
    );
    return {
      transcriptsFrom: row?.transcripts_from ?? null,
      transcriptsTo: row?.transcripts_to ?? null,
      promptsFrom: row?.prompts_from ?? null,
      promptsTo: row?.prompts_to ?? null,
      statsCacheDays: row?.stats_cache_days ?? 0,
    };
  }

  /** §4.6 `Disclosures.badLines` — malformed JSON lines skipped, across all files (§5.4 rule 1). */
  badLines(): number {
    const row = this.one<{ readonly bad_lines: number | bigint | null }>(
      'SELECT COALESCE(SUM(bad_lines), 0) AS bad_lines FROM file_manifest',
    );
    return sumToSafeNumber(row?.bad_lines ?? null, 'badLines');
  }

  /**
   * §4.6 `Disclosures.cacheSplitMismatches` (A-05) — §5.4 rule 8's sum-assertion failures across
   * all files. Same shape and same reason as `badLines()`: counted, never fatal, disclosed.
   */
  cacheSplitMismatches(): number {
    const row = this.one<{ readonly mismatches: number | bigint | null }>(
      'SELECT COALESCE(SUM(cache_split_mismatches), 0) AS mismatches FROM file_manifest',
    );
    return sumToSafeNumber(row?.mismatches ?? null, 'cacheSplitMismatches');
  }

  /**
   * §4.6 (A-05) — the events whose 1-hour cache-write share is **not known**, split by whether
   * anything can be done about it.
   *
   * ⚠️ `tok_cache_write_1h IS NULL` is precise, not a heuristic: migration 0005 adds the column
   * with no default, so NULL is exactly "this row was written before the split was captured", and
   * the parser writes a real number — `0` included — on every ingest since. `tok_cache_write > 0`
   * narrows it to the rows where it actually costs something: a row with no cache writes at all
   * has no split to be wrong about.
   *
   * ⚠️⚠️ The `archive_id` partition is the whole point. A live session's NULLs disappear on the
   * next full re-parse; an archived session's never can, because its transcripts have left the
   * Claude data directory and §5.3 `ARCHIVED` never re-reads them (§9.4). Two counts, two
   * sentences — one offers a fix and the other admits there is none.
   *
   * Deliberately UNFILTERED by the `GlobalFilter`: this is a property of the stored dataset, and
   * a date range that happens to exclude the stale rows would make the caveat disappear while the
   * cost figure it qualifies stays understated.
   */
  cacheSplitCoverage(): CacheSplitCoverage {
    const row = this.one<{
      readonly unknown_events: number | bigint | null;
      readonly archived_events: number | bigint | null;
    }>(
      `SELECT COALESCE(SUM(CASE WHEN s.archive_id IS NULL     THEN 1 ELSE 0 END), 0) AS unknown_events,
              COALESCE(SUM(CASE WHEN s.archive_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS archived_events
       FROM   events e
       JOIN   sessions s ON s.id = e.session_id
       WHERE  ${COUNTABLE} AND e.tok_cache_write_1h IS NULL AND e.tok_cache_write > 0`,
    );
    return {
      unknownEvents: sumToSafeNumber(row?.unknown_events ?? null, 'cacheSplitUnknownEvents'),
      archivedEvents: sumToSafeNumber(row?.archived_events ?? null, 'cacheSplitArchivedEvents'),
    };
  }

  /**
   * §4.6 (ADR-041) — sessions and events kept from transcripts that have vanished from the Claude
   * data directory (`retained_orphan = 1`). Feeds `Disclosures.retainedOrphanSessions` /
   * `retainedOrphanEvents`.
   *
   * ⚠️ Deliberately UNFILTERED by the `GlobalFilter`, exactly like `cacheSplitCoverage()`: it is a
   * property of the stored dataset, and a date range that happened to exclude the orphaned
   * sessions must not make the caveat disappear (INV-13-style). Synthetic events are NOT excluded
   * here — this counts what was KEPT, not what is priced, and a synthetic event kept from a
   * vanished file is still kept.
   */
  retainedOrphanCoverage(): RetainedOrphanCoverage {
    const row = this.one<{
      readonly sessions: number | bigint | null;
      readonly events: number | bigint | null;
    }>(
      `SELECT (SELECT COUNT(*) FROM sessions WHERE retained_orphan = 1) AS sessions,
              (SELECT COUNT(*) FROM events e
                 JOIN file_manifest f ON f.id = e.source_file_id
                WHERE f.retained_orphan = 1) AS events`,
    );
    return {
      sessions: sumToSafeNumber(row?.sessions ?? null, 'retainedOrphanSessions'),
      events: sumToSafeNumber(row?.events ?? null, 'retainedOrphanEvents'),
    };
  }
}
