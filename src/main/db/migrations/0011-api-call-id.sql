-- =====================================================================================
-- Migration 0011 — the API call a record came from, so repeated usage becomes MEASURABLE.
--
-- ⚠️ A NEW numbered file, never an edit to 0001–0010: merged migration files are IMMUTABLE
-- (STACK ADR-007, §3.18). 0001–0010 are untouched.
--
-- ⚠️⚠️ THIS MIGRATION CHANGES NO NUMBER, AND THAT IS THE POINT.
--
--   WHAT WE KNOW. Claude Code commonly writes ONE assistant turn — text plus its tool calls —
--   as SEVERAL JSONL lines. Those lines share one `message.id` and repeat the identical
--   `message.usage` object, while each carries its own distinct `uuid`. §3.5's line-level
--   identity (ADR-019) is therefore working exactly as specified: `event_key` differs, the
--   `ON CONFLICT DO NOTHING` correctly does not fire, and the records really are distinct
--   records. But every one of them contributes its tokens to M-02/M-04/M-05, so one API call
--   is charged N times. This is the most plausible single explanation for a lifetime total
--   (the reference dataset's reads $17,726.65) being larger than it should be.
--
--   WHAT WE DO NOT KNOW: how big it is. Nothing in this application has ever read
--   `message.id` or `requestId`, so the size of the effect cannot be stated, and a metric
--   change sized by intuition is exactly the silently-wrong number CLAUDE.md §1 forbids.
--
--   SO: this migration adds two nullable columns and an index. It does NOT change §5.9's
--   arithmetic, the costed population, any token sum, or any displayed figure. The decision
--   about what to DO is deliberately deferred until it can be sized against real data.
--
-- Additive DDL and one partial index. No row is deleted, no table is dropped, no fact table is
-- rewritten, and `price_rows`, `settings`, `audit_log` and `archives` are not named (INV-12,
-- §3.18's `db-migration-review` rule). The single `UPDATE` below touches one bookkeeping column
-- of `file_manifest` and no DERIVED fact.
-- =====================================================================================

-- §3.5 — the identity of the API call the record came from, verbatim from `message.id`, and the
-- request that produced it, verbatim from the record's own `requestId`.
--
-- ⚠️ NULLABLE with NO DEFAULT, and NO placeholder is ever written (ADR-025's principle, and the
-- same shape migration 0005 chose for `tok_cache_write_1h`). NULL means "this record does not
-- state one, or was ingested before the app read the field" — those two are different facts and
-- `api_ids_from_line` below is what tells them apart. A sentinel like '' or 'unknown' would put
-- a word in the data that the transcript does not contain, and would make every pre-migration
-- row look like a checked one.
--
-- ⚠️ NEITHER COLUMN IS PART OF EVENT IDENTITY. `event_key` is unchanged (§3.5, ADR-019) and
-- ingest is still `ON CONFLICT(event_key) DO NOTHING`. Grouping by `message_id` is a QUERY-time
-- observation about rows that all legitimately exist; it is not a second dedup key, and nothing
-- in this migration causes a record to be dropped, merged or re-counted.
ALTER TABLE events ADD COLUMN message_id TEXT;
ALTER TABLE events ADD COLUMN request_id TEXT;

-- §3.2 — ⚠️⚠️ THE HONESTY COLUMN, and the reason this migration is more than two `ALTER`s.
--
-- Every row that already exists has `message_id IS NULL`, and so does a record that genuinely
-- states no id. A count that could not tell those apart would report "0 records repeat an API
-- call" for a database in which NOTHING WAS EVER CHECKED — a plausible number that means the
-- opposite of what it says, which is CLAUDE.md §1's worst outcome arriving as a disclosure.
--
-- So the boundary is recorded per file, in the one unit that is exact: `api_ids_from_line` is
-- the number of LEADING lines of this file whose records were ingested before the app read API
-- call ids. An event was examined if and only if `events.line_no > api_ids_from_line` for its
-- source file. This is exact under every §5.3 classification, which is why it is a watermark
-- and not a boolean:
--
--   · GREW (the append fast-path) — the file keeps its watermark and the appended lines sit
--     above it. A boolean flag on the file would have claimed the OLD lines were checked too.
--   · NEW / a purged-and-rebuilt row — inserted with the DEFAULT 0, so every line is above the
--     watermark. Correct: the whole file was read by this build.
--   · SHRANK / REWROTE — `resetForReparse` drops the file's rows and resets this to 0 with the
--     byte offset, so the re-read file is fully examined. Correct for the same reason.
--   · ARCHIVED / retained-orphan — never re-parsed (§5.3, ADR-034/041), so the watermark stays
--     at today's `lines_parsed` forever. Correct, and it is what lets the disclosure say that
--     those records can NEVER be checked rather than promising a remedy that cannot work.
--
-- The backfill below is the only correct value for an existing row: every line this file has
-- contributed so far was read by a build that did not look at `message.id`.
ALTER TABLE file_manifest ADD COLUMN api_ids_from_line INTEGER NOT NULL DEFAULT 0;
UPDATE file_manifest SET api_ids_from_line = lines_parsed;

-- The seek the §4.6 count makes: group the costed population by API call and keep the groups
-- with more than one member. Partial on `message_id IS NOT NULL`, so it costs nothing for the
-- rows that have none — the whole of an existing database on the day this migration runs, and
-- every user-role record forever after. The token predicate mirrors the one the count uses, so
-- records that carry no usage at all (which can repeat nothing) stay out of the index.
CREATE INDEX IF NOT EXISTS idx_events_message_id
  ON events(message_id, id)
  WHERE message_id IS NOT NULL
    AND is_synthetic = 0
    AND (tok_input + tok_output + tok_cache_write
         + COALESCE(tok_cache_write_1h, 0) + tok_cache_read) > 0;
