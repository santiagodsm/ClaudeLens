-- =====================================================================================
-- Migration 0012 — the covering index the "one row per API call" seam seeks on.
--
-- ⚠️ A NEW numbered file, never an edit to 0001–0011: merged migration files are IMMUTABLE
-- (STACK ADR-007, §3.18). 0001–0011 are untouched.
--
-- ⚠️⚠️ THIS MIGRATION CHANGES NO NUMBER BY ITSELF. It adds one index. The metric change that
-- USES it — deduplicating repeated API-call usage before summing tokens and cost — is ADR-042
-- and lives entirely at QUERY time in `src/main/db/repositories/api-call-usage.ts`. Storage is
-- unchanged: every line remains its own `events` row (ADR-019), and `event_key` is untouched.
--
--   WHAT THE SEAM DOES. Claude Code writes one assistant API call as several JSONL lines that
--   share one `message.id` and repeat (or, while streaming, progressively accumulate) the same
--   `usage`. Migration 0011 stored `message_id`/`request_id` so this could be MEASURED; on the
--   reference dataset 187,870 costed rows collapse to 85,234 distinct calls. ADR-042 now sums
--   each call ONCE, using its final line's authoritative usage. The seam selects, per file and
--   per `message_id`, the row with the greatest `line_no` (an anti-join: "no later line of my
--   own call exists"), plus every `message_id IS NULL` row as its own call.
--
--   WHAT THIS INDEX IS FOR. That anti-join probes, for a candidate event, whether another event
--   with the same `(message_id, source_file_id)` has a greater `line_no`. This index answers
--   that probe from the index alone. Partial on `message_id IS NOT NULL`, so it costs nothing
--   for the rows that carry no id — the whole of a pre-0011 database, and every user-role record
--   forever after — exactly like migration 0011's own index.
--
-- Additive DDL only. No row is deleted, no table is dropped, no fact is rewritten, and
-- `price_rows`, `settings`, `audit_log` and `archives` are not named (INV-12, §3.18's
-- `db-migration-review` rule).
-- =====================================================================================

-- §3.5 — the anti-join key. `(message_id, source_file_id, line_no)` is the exact triple the seam
-- compares: equality on the first two, a `> line_no` range on the third. `id` rides last so the
-- deterministic tie-break (`line_no` equal ⇒ greater `id` wins) is also index-covered, though a
-- second row on one `(source_file_id, line_no)` is not expected — one JSONL line is one record.
CREATE INDEX IF NOT EXISTS idx_events_call_dedup
  ON events(message_id, source_file_id, line_no, id)
  WHERE message_id IS NOT NULL;
