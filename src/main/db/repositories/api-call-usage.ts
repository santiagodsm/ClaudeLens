// The "one row per API call" seam — DESIGN §5.9 M-02/M-03/M-04/M-05, ADR-042. Defined ONCE here
// and spliced into every query that SUMS token usage or costs it (CLAUDE.md §1: every metric is
// defined once). SQL text lives only under `src/main/db/**`, behind a repository (INV-16), so
// this is the single place the rule is written.
//
// ⚠️ WHY THIS EXISTS. Claude Code writes one assistant API call as SEVERAL JSONL lines that share
// one `message.id`/`requestId` and repeat — or, while streaming, progressively accumulate — the
// same `usage`. §3.5's line identity (ADR-019) is correct: each line is a distinct `event_key`,
// a distinct row, legitimately stored. But every one of those rows carries the call's `usage`, so
// a naive `SUM(tok_*)` charges one call N times. On the reference dataset 187,870 costed rows are
// 85,234 distinct calls; the headline cost roughly halves. Migration 0011 MEASURED this; ADR-042
// FIXES it, at query time only.
//
// ⚠️ THE RULE, verbatim (ADR-042):
//   1. The grouping key is `message_id`. `message_id` and `request_id` are 1:1 in the data;
//      `message_id` is chosen because it is the call's own identity from `message.id`, and one
//      key, not two, is what keeps the seam a single fact.
//   2. Within a `message_id` group the lines can DISAGREE — early streaming lines carry partial
//      usage, the last carries the cumulative total (45,895 of 85,234 calls vary across their
//      lines on real data). So an arbitrary line is WRONG. The authoritative usage is the FINAL
//      line's — the greatest `line_no` in the group. Calls never span files, so `line_no` order
//      within the group is total and unambiguous; `source_file_id` is carried in the anti-join
//      key defensively so a `message_id` that somehow recurred in two files could not merge.
//   3. Rows with `message_id IS NULL` are EACH THEIR OWN CALL — never folded together. Two
//      different reasons ride on this: (a) a record that genuinely states no id is a real, single
//      call; (b) a pre-0011 row was ingested before the app read the field, and folding all NULLs
//      would collapse unrelated calls and silently shrink totals. So an unmeasured database is
//      counted exactly as-is, line for line, until a rebuild fills the ids in (§3.18, migration
//      0011's `api_ids_from_line` watermark).
//
// ⚠️ NOT AN IDENTITY CHANGE. `event_key` is unchanged and ingest is still
// `ON CONFLICT(event_key) DO NOTHING` (ADR-019). Every line is still its own `events` row. This
// is a QUERY-TIME projection of that storage, chosen exactly so a rebuild reproduces byte-identical
// rows and the dedup is recomputed, never baked in. See ADR-042 for why storage was NOT touched.
//
// ⚠️ WHAT ROUTES THROUGH HERE, AND WHAT DELIBERATELY DOES NOT. Only token-usage SUMS and cost.
// Counts of rows (messages M-11, tool calls M-12, subagent-turn counts), event MOMENTS (active
// time M-07 — it is about timestamps, not usage — the rhythm heatmap, the activity calendar) and
// per-model event mixes are genuinely per-line and are LEFT ALONE. Deduping them would be a second
// wrong number in the opposite direction.

/**
 * The seam, as a named CTE. A caller prepends it to its `WITH` (or opens one with it) and then
 * reads `FROM api_call_rows e` exactly where it used to read `FROM events e`. It carries every
 * `events` column, so it is a drop-in substitute for the base table in a usage-summing query.
 *
 * ⚠️ **No bind parameters.** The predicate is pure SQL over `events`, so splicing this in front of
 * an existing query does NOT shift that query's `?` binding order — the one property that makes it
 * safe to route a dozen hand-bound queries through it without re-threading their params. The one
 * query that needs a *second* filtered copy (`session-stats.ts`) re-filters `api_call_rows` and
 * accounts for its own extra params where it builds them.
 *
 * The predicate is an anti-join, not a window function, on purpose: a window `MAX(line_no) OVER
 * (PARTITION BY …)` would materialise and sort the WHOLE `events` table on every query regardless
 * of the caller's scope filter, whereas the anti-join lets the caller's `WHERE` cut the outer set
 * first and then probes `idx_events_call_dedup` (migration 0012) per surviving row. A call's lines
 * all share `project_id`/`session_id`/`ts`, so a scope filter keeps or drops a whole call together
 * and the final-line pick is unaffected by where the filter is applied.
 */
export const API_CALL_ROWS_CTE = `api_call_rows AS (
  SELECT e.*
  FROM   events e
  WHERE  e.message_id IS NULL
     -- Keep this line iff no LATER line of the same call exists (ADR-042 rule 2): it is the
     -- final, authoritative line. The \`line_no =\` … \`id >\` tie-break makes the survivor unique
     -- even in the unexpected case of two rows sharing one \`(source_file_id, line_no)\`.
     OR NOT EXISTS (
          SELECT 1 FROM events e2
          WHERE e2.message_id     = e.message_id
            AND e2.source_file_id = e.source_file_id
            AND (e2.line_no > e.line_no
                 OR (e2.line_no = e.line_no AND e2.id > e.id)))
)`;
