-- 0007 — "these two projects are the same project", said by the user, never guessed by the app
--
-- ⚠️ A NEW numbered file, never an edit to 0001–0006: merged migration files are IMMUTABLE
-- (STACK ADR-007, §3.18).
--
-- WHY THIS EXISTS (2026-07-22 — user request, recorded as DESIGN §10 ADR-040 and §3.19):
--
--   Let the user group a project's metrics: when the same project has lived in two folders
--   (for example after moving a repository), let them declare the two folders are one project.
--
--   §2.1 "Project" forbids the app INFERRING that two `projects/<encoded-path>` directories are
--   one project — no on-disk probing, no symlink resolution, no worktree merging, no repo-root
--   detection. ⚠️ **That rule is untouched.** Nothing in this schema, and nothing that reads it,
--   guesses, suggests or auto-detects a grouping: there is no name-similarity column, no path
--   distance, no "these look alike" flag, and no writer other than the user's own explicit
--   action. A group exists only because a person selected the folders and typed a name.
--
-- ⚠️⚠️ MEMBERSHIP KEYS ON `encoded_name`, NEVER ON `projects.id`. THIS IS THE WHOLE POINT OF THE
-- TABLE'S SHAPE.
--
--   `projects.id` is a surrogate `INTEGER PRIMARY KEY` (§3.1.3) on a **DERIVED** table (§2.2).
--   §3.18's purge deletes every un-archived `projects` row and ingest re-inserts them, so the
--   ids after a `claudeDir` change or an explicit rebuild are DIFFERENT INTEGERS for the same
--   folders. A membership row storing `project_id` would, after any rebuild, silently re-point
--   every group at whichever projects happened to land on those ids — a merge nobody asked for,
--   with no error, no marker and no way for the user to see it. That is exactly CLAUDE.md §1's
--   worst outcome.
--
--   `encoded_name` is the identity (§3.3, `UNIQUE`) and it is a property of the directory on
--   disk, so it survives every purge and rebuild unchanged. Membership therefore stores it, and
--   resolves it to an id at QUERY TIME.
--
-- ⚠️ THERE IS DELIBERATELY NO FOREIGN KEY TO `projects`. Two reasons, both structural:
--   1. `projects` is DERIVED and the purge empties it. An `ON DELETE CASCADE` would delete the
--      user's groups during a rebuild; an `ON DELETE RESTRICT` would make the purge fail. Either
--      way a USER-class fact would be governed by a DERIVED table's lifetime, which ADR-026
--      exists to prevent.
--   2. A membership row naming a folder that is not currently present is legal and meaningful:
--      it is the state between a purge and the sync that follows it, and it is also what a user
--      sees when a drive is unmounted. It resolves to nothing and is shown as "not currently
--      present" — never deleted on the app's own initiative.
--
-- ⚠️ BOTH TABLES ARE **USER** CLASS (§2.2 row 3, ADR-026, INV-12): hand-entered, with no other
-- source, exactly like `price_rows`. Never purged, never dropped, always migrated.
-- `PERSISTENCE_CLASS_BY_TABLE` in `src/main/db/repositories/base.ts` carries the classification
-- as a VALUE, and `purge()` refuses to remove rows from any table not classified DERIVED
-- there.
--
-- ⚠️ GROUPING IS A LABEL OVER REAL DATA. Nothing underneath is merged, rewritten or deleted:
-- no `events` row moves, no `projects` row is removed, no `project_id` is rewritten. Ungrouping
-- removes the one `project_groups` row (members cascade), and every figure returns to exactly
-- the value it had before the group existed (ADR-040,
-- test/metrics/f16-grouped-active-time.test.ts).

CREATE TABLE project_groups (
  id          INTEGER PRIMARY KEY,
  -- The user's own words. Rendered as-is; the app never generates, completes or suggests one.
  name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  -- §3.3's rule, applied to the group's name: a pure function of the name, so the hue follows
  -- what the user called it. Computed by `colorIndexFor` (src/shared/color-index.ts) at write
  -- time and rewritten on rename, which is what keeps SQL and TypeScript from owning two
  -- different hue rules for the same string.
  color_index INTEGER NOT NULL CHECK (color_index BETWEEN 0 AND 7),
  -- §3.1.6 — every USER table carries both.
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Two groups called "Family App" would be indistinguishable in the filter, in Settings and in
-- every chart legend. NOCASE because "family app" and "Family App" are the same answer to
-- "what did you call it".
CREATE UNIQUE INDEX idx_project_groups_name ON project_groups(name COLLATE NOCASE);

CREATE TABLE project_group_members (
  -- ⚠️ THE IDENTITY (§3.3), and the PRIMARY KEY. This is a deliberate deviation from §3.1.3
  -- ("surrogate keys are INTEGER PRIMARY KEY"), for the same reason `sessions` deviates: the
  -- natural key is the right key. Making it the primary key is also what makes "a project
  -- belongs to at most one group" a property of the schema rather than of a check somewhere.
  encoded_name TEXT    PRIMARY KEY,
  group_id     INTEGER NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_project_group_members_group ON project_group_members(group_id);
