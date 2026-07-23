-- 0005 — the FIFTH token class: 1-hour cache writes (A-05)
--
-- ⚠️ A NEW numbered file, never an edit to 0001–0004: merged migration files are
-- IMMUTABLE (STACK ADR-007, §3.18). Editing a shipped file leaves already-migrated databases
-- silently divergent from new ones.
--
-- WHY THIS EXISTS (A-05, 2026-07-22 — user-approved; DESIGN §2.1, §3.5, §3.11, §4.7, §5.4 rule 8
-- and §5.9 M-04/M-05 all carry the matching ⚠️ AMENDED 2026-07-22 block):
--
--   `message.usage.cache_creation` carries `{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`
--   and the parser threw the split away, mapping only the flat `cache_creation_input_tokens` to
--   `tok_cache_write`. Cache writes bill at **1.25x input for 5-minute** and **2x input for
--   1-hour**, so costing every write at the 5-minute rate understates the total. On the reference
--   dataset the discriminator was present on all 133,701 cache-writing events and summed exactly
--   to the flat total in every one; the measured shortfall was $415.07.
--
--   ⚠️ §1.7's rule is UNCHANGED and is the reason this is a fifth stored class rather than a
--   multiplier: rates are **stored, never derived**. 1-hour happens to be 2x input for every model
--   in today's seed, but ADR-024 records the user's explicit rejection of computing one rate from
--   another — "it breaks silently the moment a model deviates from the ratio".
--
-- NAMING, stated once. `cache_write` KEEPS its meaning and is now explicitly the **5-minute**
-- class — which is what `resources/price-seed.json` has always seeded it with. The new value is
-- `cache_write_1h`. Renaming the existing class would have meant rewriting USER-class
-- `price_rows` data, including hand-corrected rates and effective dates; this way no existing
-- price row is touched at all.
--
-- ⚠️ `events.tok_cache_write_1h` is NULLABLE and has NO DEFAULT, which is deliberate and is the
-- whole disclosure mechanism. Every row that already exists gets **NULL**, meaning "this row was
-- parsed before the split was captured; its 1-hour share is NOT KNOWN". Exactly as
-- `harness_nodes.entry_count` (migration 0003) uses NULL for "not counted", it is **never read as
-- zero** by anything that reports it. The cost path reads `COALESCE(..., 0)`, which reproduces
-- today's behaviour bit for bit — those rows keep costing exactly what they cost before this
-- migration, so nothing moves under the user until a re-parse — and §4.6 gains
-- `cacheSplitUnknownEvents` / `cacheSplitArchivedEvents` so that "we are still using the old,
-- understated split for N events" is DATA IN THE PAYLOAD rather than an invisible fact
-- (CLAUDE.md §1). The parser never writes NULL for a live parse: it writes the real split, or
-- `0` when the record carries no `cache_creation` object at all (§5.4 rule 8).
--
-- ⚠️⚠️ ARCHIVED SESSIONS ARE THE ONE IRREVERSIBLE CASE (§5.3 `ARCHIVED`, §9.4, ADR-033/034).
-- Their transcripts have left the Claude data directory and are NEVER re-parsed, so their NULLs
-- can never be filled: they are costed at the 5-minute rate forever. That is why the disclosure
-- is split into two counts with two different sentences — one says "re-sync to fix", the other
-- says "this can no longer be recovered".
--
-- This migration is ADDITIVE to every DERIVED fact table: no row is deleted from `events`,
-- `sessions`, `tool_calls`, `subagent_runs`, `file_touches` or `file_manifest` (§3.18's
-- `db-migration-review` rule), and no RETAINED row is touched (INV-18, ADR-033).

-- §3.5 — the fifth class's token column. NULL = "the split is not known for this row".
ALTER TABLE events ADD COLUMN tok_cache_write_1h INTEGER;

-- §3.5 — the priceable partial index must cover the new class, or an event whose ONLY tokens are
-- 1-hour cache writes would be outside the index that `cost.ts`'s PRICEABLE predicate mirrors
-- verbatim. The two are one fact, checkable in one place; they are changed together.
DROP INDEX idx_events_priceable;
CREATE INDEX idx_events_priceable ON events(model, ts, id)
  WHERE is_synthetic = 0
    AND model IS NOT NULL
    AND (tok_input + tok_output + tok_cache_write
         + COALESCE(tok_cache_write_1h, 0) + tok_cache_read) > 0;

-- §3.2 / §4.6 — the counter for §5.4 rule 8's sum assertion. A record whose
-- `ephemeral_5m + ephemeral_1h` does not equal its own `cache_creation_input_tokens` is
-- internally inconsistent: the parser trusts NEITHER half, stores the flat total in the
-- 5-minute class with a NULL 1-hour share, and counts the record here. It mirrors `bad_lines`
-- exactly — counted, never fatal, disclosed (§4.6, §5.4 rule 1's principle).
ALTER TABLE file_manifest ADD COLUMN cache_split_mismatches INTEGER NOT NULL DEFAULT 0;

-- §3.11 — admit `cache_write_1h` in `price_rows.token_class`.
--
-- ⚠️⚠️ **THIS IS THE ONLY DELICATE STEP IN THIS FILE, AND ITS SHAPE IS FORCED.** SQLite cannot
-- `ALTER` a CHECK constraint, and ADR-026 says of `price_rows`, `settings` and `audit_log`:
-- "never emptied, **never dropped**, and **carried across every migration**". So the usual
-- SQLite table rebuild — copy the rows aside, destroy the original, rename the copy back — is not
-- available here: destroying the original would destroy the one table in this database that has no
-- other source. `migrate.test.ts` enforces that as a textual guard over every migration's SQL
-- (it greps for the destructive statement by name), and the guard is right.
--
-- The rebuild is therefore done by RENAME-ASIDE, which drops nothing:
--
--   1. drop the two INDEXES (an index is derived from the table and is recreated below);
--   2. `ALTER TABLE price_rows RENAME TO price_rows_pre_0005` — the original table object, with
--      every row exactly as it was, SURVIVES this migration and is never written again;
--   3. create the new `price_rows` with the widened CHECK;
--   4. copy every row across, column by column, INCLUDING `id` — no `SELECT *`, nothing
--      defaulted, nothing re-dated, nothing de-duplicated;
--   5. recreate the two indexes under their original names.
--
-- ⚠️ The surviving `price_rows_pre_0005` is deliberate, not debris. §9.4 is explicit that the
-- USER half of this database "has no other source", and this is the only migration in the project
-- that rewrites one of those tables rather than adding to it. Leaving the pre-image in place makes
-- the rewrite reversible by hand from inside the database itself, at the cost of a few hundred
-- rows. It is classified **USER** in `PERSISTENCE_CLASS_BY_TABLE`, so no purge and no rebuild will
-- ever touch it (ADR-026, INV-12), and nothing in the application reads it.
--
-- Nothing references `price_rows` by foreign key, so nothing dangles across the rename.
DROP INDEX idx_price_rows_cover;
DROP INDEX uq_price_rows_open;

ALTER TABLE price_rows RENAME TO price_rows_pre_0005;

CREATE TABLE price_rows (
  id                     INTEGER PRIMARY KEY,
  model                  TEXT    NOT NULL,     -- EXACT raw message.model string (ADR-025)
  token_class            TEXT    NOT NULL CHECK (token_class IN
                           ('input','output','cache_write','cache_write_1h','cache_read')),
  rate_picousd_per_token INTEGER NOT NULL CHECK (rate_picousd_per_token >= 0),  -- ADR-023 (amended)
  valid_from             INTEGER NOT NULL,     -- UTC epoch ms, INCLUSIVE
  valid_to               INTEGER,              -- UTC epoch ms, EXCLUSIVE; NULL = still in effect
  source                 TEXT    NOT NULL CHECK (source IN ('seed','fetch','manual')),
  source_url             TEXT,                 -- set when source='fetch'
  note                   TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

INSERT INTO price_rows
  (id, model, token_class, rate_picousd_per_token, valid_from, valid_to,
   source, source_url, note, created_at, updated_at)
SELECT
   id, model, token_class, rate_picousd_per_token, valid_from, valid_to,
   source, source_url, note, created_at, updated_at
FROM price_rows_pre_0005;

-- Recreated under their original names (§3.11); the rename took the old ones out of the way.
CREATE INDEX idx_price_rows_cover
  ON price_rows(model, token_class, valid_from, valid_to, rate_picousd_per_token);
CREATE UNIQUE INDEX uq_price_rows_open
  ON price_rows(model, token_class) WHERE valid_to IS NULL;
