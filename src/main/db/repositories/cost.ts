// The cost query seam — DESIGN §5.9 M-05 (Cost) and M-06 (Uncosted summary). Owned by E5.
//
// ⚠️ Here for the same reason as `price-rows.ts`: SQL text exists only under `src/main/db/**`
// (INV-16, lint-enforced). The arithmetic POLICY and the picoUSD → nanoUSD conversion live in
// `src/main/pricing/cost.ts`; this file is the SQL they are expressed in.
//
// ⚠️ EVERY SUM HERE IS IN picoUSD AND IS INTEGER (ADR-023). No `REAL`, no division, no `ROUND`.
// SQLite sums `tokens × rate_picousd_per_token` in 64-bit integers; §3.11 sizes the reference
// dataset's worst case at ~4.8e15 picoUSD, three orders inside 2^63. The conversion to the
// nanoUSD wire unit happens once, in `src/main/pricing/cost.ts`, via `picoToNanoUsd`.
//
// ⚠️ **AMENDED 2026-07-22 — a picoUSD sum leaves this file as a `bigint`, never as a `number`.**
// `2^63` is not the binding limit; `Number.MAX_SAFE_INTEGER` is, and in *this* unit that bound is
// only **$9,007** of lifetime spend (9.007e15 picoUSD). `totals()` and `totalsGroupedBy()` used
// to narrow the sum with `sumToSafeNumber` the moment it left SQL, which asserts INV-11 at the
// SQL boundary — precisely where §3.11 says not to assert it — and returned `E_INTERNAL` from
// `q:overviewTiles` for any real dataset past $9,007. Both now read in `safeIntegers` mode; the
// bound is asserted once, on the nanoUSD result, where the design puts it. The reference perf
// dataset totalled 4.7e15 picoUSD — about half the limit — which is why 890 tests were green.
//
// ⚠️ **AMENDED 2026-07-22 (A-05) — there are FIVE token classes, not four.** `cache_write` is the
// 5-minute class and `cache_write_1h` the 1-hour one; they bill at 1.25x and 2x input respectively,
// so costing every cache write at the 5-minute rate understated the total by $415.07 on the
// reference dataset. ⚠️ `events.tok_cache_write_1h` is NULLABLE: NULL means "this row was parsed
// before the split existed, so its 1-hour share is not known" (migration 0005). It is read as
// `COALESCE(..., 0)` here — which reproduces the pre-A-05 arithmetic for those rows exactly, so
// nothing moves under the user until a re-parse — and the count of such rows is DISCLOSED
// (§4.6 `cacheSplitUnknownEvents` / `cacheSplitArchivedEvents`) rather than left invisible.
// ⚠️ The 1.25x / 2x ratios are an OBSERVATION about today's published page, never a derivation:
// every rate is stored (§1.7, ADR-024).
//
// ⚠️ THE RULE THAT MATTERS MOST (M-05, INV-09): an event is costed only if EVERY token class
// with a non-zero count has a covering price row. Otherwise the ENTIRE event is uncosted and
// contributes nothing. That is the `costed` flag in the `classified` CTE, and it is computed
// once and used by both queries below, so the `$` figure and its disclosure can never disagree
// about which events they are talking about.

import { Repository, sumToBigInt, sumToSafeNumber } from './base';
import { rateAtPredicate } from './price-rows';
import { PROJECT_UNIT_CTE } from './project-groups';
import { localDate } from './scope';
import { assertSafeAggregate, picoToNanoUsd } from '../../../shared/money';
import type { SqlParam, SqliteDatabase } from '../sqlite';

/** §4.2 `GlobalFilter`, in the shape this repository binds. `to` is EXCLUSIVE. */
export interface CostScope {
  readonly projectIds: number[] | null;
  readonly from: number | null;
  readonly to: number | null;
  /**
   * ⚠️ AMENDED 2026-07-22 (E4). `q:sessionDetail` carries a `$` figure and therefore must carry
   * its `UncostedSummary` (INV-10), but §4.2's `GlobalFilter` has no session dimension. Rather
   * than compute a second, session-shaped costing — the A-10 failure repeating — the scope gains
   * an optional session restriction that BOTH `totals()` and `uncostedByModel()` bind, so the
   * drill-down's money and its disclosure come from the same `classified` rows as every other
   * `$` figure in the app. `undefined` (the default) means "no session restriction".
   */
  readonly sessionIds?: readonly string[];
}

/**
 * M-05's two halves, in STORAGE units.
 *
 * ⚠️ **`costPicoUsd` is a `bigint`, and that is load-bearing** (§3.11, ADR-023, AMENDED
 * 2026-07-22). picoUSD is 1e12 per dollar: `Number.MAX_SAFE_INTEGER` picoUSD is $9,007 of
 * lifetime spend, so a real dataset outgrows a JS `number` in this unit and *only* in this unit.
 * The value stays exact until `picoToNanoUsd` converts it, and INV-11 is asserted on the nanoUSD
 * result. `costedEvents`/`uncostedEvents` are counts and stay `number` (§3.5).
 */
export interface CostTotals {
  readonly costPicoUsd: bigint;
  readonly costedEvents: number;
  readonly uncostedEvents: number;
}

/** M-06, one row per model. */
export interface UncostedByModelRow {
  readonly model: string;
  readonly records: number;
  readonly fromTs: number;
  readonly toTs: number;
}

/**
 * §4.5 `q:costBreakdown` groupings, plus the two E4 needs for per-row `$` figures
 * (`q:tokensByProject`, `q:sessions`, `q:projectCards`).
 *
 * ⚠️ AMENDED 2026-07-22 (E4). This is **not** a second cost path (A-10's failure mode). It is
 * the *same* `classified` CTE and the *same* `COSTED_FLAG` as `totals()`, with a `GROUP BY`
 * added — so INV-09's all-or-nothing rule, the uncosted population, and the picoUSD arithmetic
 * are shared by construction. A grouped total and the ungrouped total over the same scope sum
 * to the same number because they are literally the same expression.
 */
export type CostGrouping = 'model' | 'project' | 'day' | 'session';

/**
 * One group's M-05 total and the four class sums it was computed from.
 *
 * ⚠️ `costPicoUsd` is a `bigint` for the reason given on `CostTotals` — a single group can
 * exceed `Number.MAX_SAFE_INTEGER` picoUSD just as the ungrouped total can. The token sums
 * beside it are counts and stay `number` (§3.5).
 */
export interface CostGroupRow {
  readonly key: string;
  readonly costPicoUsd: bigint;
  readonly costedEvents: number;
  readonly tokInput: number;
  readonly tokOutput: number;
  /** The **5-minute** cache-write class (A-05). */
  readonly tokCacheWrite: number;
  /** The **1-hour** cache-write class (A-05). Rows with an unknown split contribute `0`. */
  readonly tokCacheWrite1h: number;
  readonly tokCacheRead: number;
}

/** §4.7 `pricing:models`, in row form. */
export interface ObservedModelRecord {
  readonly model: string;
  readonly events: number;
  readonly firstTs: number;
  readonly lastTs: number;
  readonly priced: boolean;
}

// ---------------------------------------------------------------------------------------
// The priceable population — §5.9 M-01 plus the two facts that make an event priceable.
// ---------------------------------------------------------------------------------------
//
// This predicate is the `idx_events_priceable` partial index of §3.5, verbatim:
//
//   is_synthetic = 0 AND model IS NOT NULL AND (sum of the five token columns) > 0
//
// M-01: synthetic events are "excluded from every token, cost and model statistic". A row with
// no `model` cannot be priced under ADR-025 (exact match on the raw string — there is nothing to
// match), and a row with no tokens costs zero under any rate, so neither belongs in the costed
// OR the uncosted population: the uncosted disclosure names models and date ranges the user can
// act on, and "NULL model, 0 tokens" is not something a Settings edit can fix. Making the
// population identical to the index is deliberate — it is one fact, checkable in one place.
const PRICEABLE = `e.is_synthetic = 0
  AND e.model IS NOT NULL
  AND (e.tok_input + e.tok_output + e.tok_cache_write
       + COALESCE(e.tok_cache_write_1h, 0) + e.tok_cache_read) > 0`;

// ---------------------------------------------------------------------------------------
// The bi-temporal rate lookup, as a JOIN — §3.11, ADR-024. (P-09, 2026-07-22, E4)
// ---------------------------------------------------------------------------------------
//
// ⚠️ **This is an OPTIMISATION of the lookup, not a change to it.** The rule is unchanged: an
// event is priced at the row covering the event's own timestamp, half-open `[valid_from, valid_to)`,
// keyed on the EXACT raw model string (ADR-025), and an event with a non-zero class that has no
// covering row is entirely uncosted (INV-09). Fixtures F-08, F-09 and F-10 pin all three and were
// byte-identical before and after this change.
//
// It replaced four **correlated** subqueries — one per token class, re-seeking `price_rows` once
// per event per class, ~4 × 236 000 index seeks on the reference dataset — which measured at
// ~350 ms per pass and made P-09 the dominant cost in thirteen of twenty-five queries (§8.3).
// ADR-008's seam is what makes this containable: the change is entirely inside this file.
//
// ⚠️ **The naive pivot — `GROUP BY model, valid_from, valid_to` — would have been WRONG**, and is
// recorded here so nobody "simplifies" back to it. §3.11's auto-versioning is per
// `(model, token_class)`, and INV-08 only forbids overlap *within* one class, so the four classes
// of one model may have completely different validity ranges. Grouping on a row's own range
// produces buckets in which some classes are simply absent, which would silently change WHICH
// events are costed — a re-derivation wearing an optimisation's clothes.
//
// The correct construction is to split each model's timeline at **every** boundary any of its
// classes declares, so that within a segment every class's rate is constant by construction:
//
//   bounds   — every `valid_from` and every non-NULL `valid_to`, per model
//   segments — consecutive boundaries, `[seg_from, seg_to)`, `seg_to IS NULL` = still in effect
//   rates    — for each segment, the rate of each class whose row covers `seg_from`
//
// A class with no covering row in a segment yields NULL there, exactly as the correlated subquery
// yielded NULL, so `COSTED_FLAG` behaves identically. An event before a model's first boundary, or
// after its last closed range, matches no segment at all and is uncosted — also identical.
const RATE_SEGMENTS_CTE = `bounds AS (
  SELECT pr.model AS model, pr.valid_from AS t FROM price_rows pr
  UNION
  SELECT pr.model AS model, pr.valid_to   AS t FROM price_rows pr WHERE pr.valid_to IS NOT NULL
),
segments AS (
  SELECT b.model AS model, b.t AS seg_from,
         LEAD(b.t) OVER (PARTITION BY b.model ORDER BY b.t) AS seg_to
  FROM   bounds b
),
rates AS (
  SELECT sg.model AS model, sg.seg_from AS seg_from, sg.seg_to AS seg_to,
         MAX(CASE WHEN pr.token_class = 'input'       THEN pr.rate_picousd_per_token END) AS rate_input,
         MAX(CASE WHEN pr.token_class = 'output'      THEN pr.rate_picousd_per_token END) AS rate_output,
         MAX(CASE WHEN pr.token_class = 'cache_write' THEN pr.rate_picousd_per_token END) AS rate_cache_write,
         MAX(CASE WHEN pr.token_class = 'cache_write_1h' THEN pr.rate_picousd_per_token END) AS rate_cache_write_1h,
         MAX(CASE WHEN pr.token_class = 'cache_read'  THEN pr.rate_picousd_per_token END) AS rate_cache_read
  FROM   segments sg
  JOIN   price_rows pr ON pr.model = sg.model AND ${rateAtPredicate('sg.seg_from')}
  GROUP BY sg.model, sg.seg_from, sg.seg_to
)`;

/**
 * The event → segment predicate. The same half-open `[from, to)` shape as `rateAtPredicate`, one
 * level up: `seg_to IS NULL` is the open-ended segment, exactly as `valid_to IS NULL` is the
 * open-ended row (§3.11). Stated once so the two ends cannot drift into `<=` independently.
 */
const SEGMENT_AT_TS = 'r.seg_from <= s.ts AND (r.seg_to IS NULL OR r.seg_to > s.ts)';

/** `tokens × rate`, guarded so `0 × NULL` is 0 rather than SQL's NULL. */
function termFor(tokenColumn: string, rateAlias: string): string {
  return `(CASE WHEN ${tokenColumn} = 0 THEN 0 ELSE ${tokenColumn} * ${rateAlias} END)`;
}

/** INV-09, as SQL: every non-zero class must have a rate, or the whole event drops out. */
const COSTED_FLAG = `CASE
  WHEN (r.tok_input       = 0 OR r.rate_input       IS NOT NULL)
   AND (r.tok_output      = 0 OR r.rate_output      IS NOT NULL)
   AND (r.tok_cache_write = 0 OR r.rate_cache_write IS NOT NULL)
   AND (r.tok_cache_write_1h = 0 OR r.rate_cache_write_1h IS NOT NULL)
   AND (r.tok_cache_read  = 0 OR r.rate_cache_read  IS NOT NULL)
  THEN 1 ELSE 0 END AS costed`;

function classifiedCte(filterSql: string): string {
  // ⚠️ `project_id`, `session_id` and the ADR-021 local day are carried through so that
  // `totalsGroupedBy()` can group on them WITHOUT a second copy of the costing rules. They cost
  // nothing when unused: SQLite's query planner drops unreferenced CTE columns.
  return `WITH ${RATE_SEGMENTS_CTE},
${PROJECT_UNIT_CTE},
scoped AS (
  SELECT e.id, e.model, e.ts, e.project_id, e.session_id,
         -- ADR-040 — the project UNIT: the project itself, or the group the user put it in.
         -- Left-joined and coalesced, so an event can never be lost to a missing unit row.
         COALESCE(u.unit_id, e.project_id) AS unit_id,
         ${localDate('e.ts')} AS local_day,
         e.tok_input, e.tok_output, e.tok_cache_write,
         -- A-05: NULL = "split not known" (migration 0005). Read as 0 here, which is exactly the
         -- pre-A-05 arithmetic for those rows, and disclosed rather than silently absorbed.
         COALESCE(e.tok_cache_write_1h, 0) AS tok_cache_write_1h,
         e.tok_cache_read
  FROM   events e
  LEFT   JOIN project_unit u ON u.project_id = e.project_id
  WHERE  ${PRICEABLE}${filterSql}
),
rated AS (
  SELECT s.id, s.model, s.ts, s.project_id, s.unit_id, s.session_id, s.local_day,
         s.tok_input, s.tok_output, s.tok_cache_write, s.tok_cache_write_1h, s.tok_cache_read,
         r.rate_input, r.rate_output, r.rate_cache_write, r.rate_cache_write_1h, r.rate_cache_read
  FROM   scoped s
  -- LEFT, not INNER: an event whose model the price table has never heard of must reach
  -- the classified CTE with four NULL rates and be counted as UNCOSTED (INV-09, M-06).
  -- Dropping it here would make it vanish from the disclosure as well as from the total.
  LEFT JOIN rates r ON r.model = s.model AND ${SEGMENT_AT_TS}
),
classified AS (
  SELECT r.*, ${COSTED_FLAG}
  FROM   rated r
)`;
}

function totalsSql(filterSql: string): string {
  return `${classifiedCte(filterSql)}
SELECT
  COALESCE(SUM(CASE WHEN costed = 1 THEN
      ${termFor('tok_input', 'rate_input')}
    + ${termFor('tok_output', 'rate_output')}
    + ${termFor('tok_cache_write', 'rate_cache_write')}
    + ${termFor('tok_cache_write_1h', 'rate_cache_write_1h')}
    + ${termFor('tok_cache_read', 'rate_cache_read')}
  ELSE 0 END), 0)          AS cost_picousd,
  COALESCE(SUM(costed), 0) AS costed_events,
  COUNT(*) - COALESCE(SUM(costed), 0) AS uncosted_events
FROM classified`;
}

/** The `classified` column each §4.5 grouping keys on. Closed set — never an interpolated caller value. */
const GROUP_COLUMN: Readonly<Record<CostGrouping, string>> = {
  model: 'model',
  // ⚠️ ADR-040 — the UNIT, not the raw project. §6.4's cost breakdown by project reports one row
  // per thing the user calls a project, which is a group when they have made one.
  project: 'unit_id',
  day: 'local_day',
  session: 'session_id',
};

function groupedSql(filterSql: string, by: CostGrouping): string {
  const column = GROUP_COLUMN[by];
  return `${classifiedCte(filterSql)}
SELECT CAST(${column} AS TEXT) AS key,
  COALESCE(SUM(
      ${termFor('tok_input', 'rate_input')}
    + ${termFor('tok_output', 'rate_output')}
    + ${termFor('tok_cache_write', 'rate_cache_write')}
    + ${termFor('tok_cache_write_1h', 'rate_cache_write_1h')}
    + ${termFor('tok_cache_read', 'rate_cache_read')}
  ), 0)                              AS cost_picousd,
  COUNT(*)                           AS costed_events,
  COALESCE(SUM(tok_input), 0)        AS tok_input,
  COALESCE(SUM(tok_output), 0)       AS tok_output,
  COALESCE(SUM(tok_cache_write), 0)  AS tok_cache_write,
  COALESCE(SUM(tok_cache_write_1h), 0) AS tok_cache_write_1h,
  COALESCE(SUM(tok_cache_read), 0)   AS tok_cache_read
FROM classified
WHERE costed = 1
GROUP BY ${column}
ORDER BY cost_picousd DESC, key ASC`;
}

function uncostedSql(filterSql: string): string {
  return `${classifiedCte(filterSql)}
SELECT model, COUNT(*) AS records, MIN(ts) AS from_ts, MAX(ts) AS to_ts
FROM   classified
WHERE  costed = 0
GROUP BY model
ORDER BY records DESC, model ASC`;
}

/**
 * §4.7 `pricing:models` — "every distinct `model` string observed in `events`, with `priced`
 * telling the user whether any covering row exists. This is what makes an unpriced model visible
 * rather than silent."
 *
 * ⚠️ `priced` is `EXISTS(a row for this exact model string)` — byte-for-byte, case-sensitive, no
 * prefix or fuzzy match (ADR-025). It answers "does the price table know this model at all",
 * which is the question the Settings list exists to answer; whether a particular event falls in
 * a gap is M-06's job, and the two are shown side by side (§6.10 card 5).
 *
 * The population is M-01 (`is_synthetic = 0`), so the counts here agree with every other model
 * statistic in §5.9. `model IS NOT NULL` because a NULL is not a model string.
 */
const SELECT_OBSERVED_MODELS = `
SELECT e.model                            AS model,
       COUNT(*)                           AS events,
       MIN(e.ts)                          AS first_ts,
       MAX(e.ts)                          AS last_ts,
       CASE WHEN EXISTS (SELECT 1 FROM price_rows pr WHERE pr.model = e.model)
            THEN 1 ELSE 0 END             AS priced
FROM   events e
WHERE  e.is_synthetic = 0 AND e.model IS NOT NULL
GROUP BY e.model
ORDER BY e.model`;

interface TotalsRecord {
  readonly cost_picousd: number | bigint | null;
  readonly costed_events: number | bigint | null;
  readonly uncosted_events: number | bigint | null;
}

interface GroupedRecord {
  readonly key: string;
  readonly cost_picousd: number | bigint | null;
  readonly costed_events: number | bigint | null;
  readonly tok_input: number | bigint | null;
  readonly tok_output: number | bigint | null;
  readonly tok_cache_write: number | bigint | null;
  readonly tok_cache_write_1h: number | bigint | null;
  readonly tok_cache_read: number | bigint | null;
}

interface UncostedRecord {
  readonly model: string;
  readonly records: number;
  readonly from_ts: number;
  readonly to_ts: number;
}

interface ObservedModelSqlRecord {
  readonly model: string;
  readonly events: number;
  readonly first_ts: number;
  readonly last_ts: number;
  readonly priced: number;
}

/**
 * Builds the `GlobalFilter` clause and its bind parameters.
 *
 * The `projectIds` placeholder list makes the SQL text length-dependent, which is fine: the
 * statement cache in `Repository` is keyed on the SQL string, so each distinct arity gets its own
 * prepared statement instead of one statement being re-bound with the wrong shape.
 */
function buildFilter(scope: CostScope): { sql: string; params: SqlParam[] } {
  const clauses: string[] = [];
  const params: SqlParam[] = [];

  if (scope.projectIds !== null) {
    if (scope.projectIds.length === 0) {
      // An explicit empty selection selects nothing. It is NOT "all projects" — silently
      // widening an empty filter is how a scoped number becomes a global one.
      clauses.push('1 = 0');
    } else {
      clauses.push(`e.project_id IN (${scope.projectIds.map(() => '?').join(', ')})`);
      params.push(...scope.projectIds);
    }
  }
  if (scope.sessionIds !== undefined) {
    if (scope.sessionIds.length === 0) {
      clauses.push('1 = 0');
    } else {
      clauses.push(`e.session_id IN (${scope.sessionIds.map(() => '?').join(', ')})`);
      params.push(...scope.sessionIds);
    }
  }
  if (scope.from !== null) {
    clauses.push('e.ts >= ?');
    params.push(scope.from);
  }
  if (scope.to !== null) {
    // §4.2: the window is half-open [from, to).
    clauses.push('e.ts < ?');
    params.push(scope.to);
  }

  return { sql: clauses.length === 0 ? '' : `\n    AND ${clauses.join('\n    AND ')}`, params };
}

/**
 * A picoUSD total as the `costNanoUsd: number | null` §4.5 puts on the wire.
 *
 * ⚠️ `null` when **nothing in the group could be costed**, never `0`. §6.4 states the rule for
 * the surface — *"If no price row covers any record, the panel renders 'No pricing configured —
 * showing tokens only' and shows no `$` at all. ⚠️ It never shows `$0.00`"* — and §4.5 gives
 * every `$` field a nullable type for exactly this. `0` and "unknown" are different facts and a
 * `$0.00` that means "unpriced" is a silently wrong number with a currency symbol on it.
 *
 * The conversion picoUSD → nanoUSD happens here and nowhere else on this path (ADR-023); USD is
 * produced once more, at the presentation edge, by the renderer.
 */
export function nullWhenUnpriced(costNanoUsd: number, costedEvents: number): number | null {
  return costedEvents === 0 ? null : costNanoUsd;
}

/**
 * The same rule applied to a picoUSD sum, converting once (ADR-023).
 *
 * ⚠️ This function was always right and is the shape the two `CostRepository` methods below
 * now reduce to: **convert, then assert** — `picoToNanoUsd` first, `assertSafeAggregate` on the
 * nanoUSD result. Asserting on the picoUSD input instead is the bug of 2026-07-22 (§3.11's
 * amendment note); the `bigint` parameter type is what now makes that mistake impossible to
 * write, because a picoUSD sum can no longer be a `number` in the first place.
 */
export function costToWire(costPicoUsd: bigint, costedEvents: number): number | null {
  return nullWhenUnpriced(
    assertSafeAggregate(picoToNanoUsd(costPicoUsd), 'costNanoUsd'),
    costedEvents,
  );
}

export class CostRepository extends Repository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /**
   * M-05 — the picoUSD total, plus how many events were and were not costed.
   *
   * ⚠️ **AMENDED 2026-07-22 — read in `safeIntegers` mode, so `cost_picousd` arrives as a
   * `bigint`.** This method used to narrow the picoUSD sum with `sumToSafeNumber`, which asserts
   * INV-11 at the SQL boundary. §3.11 says the assertion belongs at the *wire* boundary, on the
   * nanoUSD value, and says why: 9.007e15 picoUSD is $9,007 of lifetime spend, while the same
   * money in nanoUSD has three orders of headroom. The narrowing turned `q:overviewTiles` into a
   * hard `E_INTERNAL` for any user past $9,007. The counts beside it are counts and stay
   * `number` (§3.5).
   */
  totals(scope: CostScope): CostTotals {
    const filter = buildFilter(scope);
    const row = this.oneExact<TotalsRecord>(totalsSql(filter.sql), ...filter.params);
    return {
      costPicoUsd: sumToBigInt(row?.cost_picousd ?? null, 'costPicoUsd'),
      costedEvents: sumToSafeNumber(row?.costed_events ?? null, 'costedEvents'),
      uncostedEvents: sumToSafeNumber(row?.uncosted_events ?? null, 'uncostedEvents'),
    };
  }

  /**
   * M-05, grouped — §4.5 `q:costBreakdown`, and the per-row `$` figures of `q:tokensByProject`,
   * `q:sessions` and `q:projectCards`.
   *
   * ⚠️ Only `costed = 1` rows appear, which is INV-09 doing its job: a group whose every event
   * is uncosted is ABSENT rather than present with `0`. §6.4 is explicit — "it never shows
   * `$0.00`" — and the events that vanished are named by `uncostedByModel()`, which is computed
   * from the same flag over the same rows. The four class sums are over the same costed rows as
   * the money, so a row's tokens and its `$` are always talking about the same events.
   *
   * ⚠️ **AMENDED 2026-07-22 — `safeIntegers`, for the same reason as `totals()`.** A single
   * group's picoUSD sum crosses `Number.MAX_SAFE_INTEGER` at $9,007 exactly as the ungrouped
   * total does, so `q:costBreakdown` and every per-row `$` had the same bug. The picoUSD sum
   * leaves SQL as a `bigint` and is converted once, by `costToWire`/`picoToNanoUsd`.
   */
  totalsGroupedBy(scope: CostScope, by: CostGrouping): CostGroupRow[] {
    const filter = buildFilter(scope);
    return this.allExact<GroupedRecord>(groupedSql(filter.sql, by), ...filter.params).map(
      (row) => ({
        key: row.key,
        costPicoUsd: sumToBigInt(row.cost_picousd, 'costPicoUsd'),
        costedEvents: sumToSafeNumber(row.costed_events, 'costedEvents'),
        tokInput: sumToSafeNumber(row.tok_input, 'tokInput'),
        tokOutput: sumToSafeNumber(row.tok_output, 'tokOutput'),
        tokCacheWrite: sumToSafeNumber(row.tok_cache_write, 'tokCacheWrite'),
        tokCacheWrite1h: sumToSafeNumber(row.tok_cache_write_1h, 'tokCacheWrite1h'),
        tokCacheRead: sumToSafeNumber(row.tok_cache_read, 'tokCacheRead'),
      }),
    );
  }

  /** M-06 — the excluded events, grouped by model with `MIN(ts)`/`MAX(ts)`. */
  uncostedByModel(scope: CostScope): UncostedByModelRow[] {
    const filter = buildFilter(scope);
    return this.all<UncostedRecord>(uncostedSql(filter.sql), ...filter.params).map((row) => ({
      model: row.model,
      records: row.records,
      fromTs: row.from_ts,
      toTs: row.to_ts,
    }));
  }

  /** §4.7 `pricing:models`. Unfiltered by design — Settings asks about the whole dataset. */
  observedModels(): ObservedModelRecord[] {
    return this.all<ObservedModelSqlRecord>(SELECT_OBSERVED_MODELS).map((row) => ({
      model: row.model,
      events: row.events,
      firstTs: row.first_ts,
      lastTs: row.last_ts,
      priced: row.priced === 1,
    }));
  }
}
