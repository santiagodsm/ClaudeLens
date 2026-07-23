-- 0006 — the project name is the folder's name, taken from `events.cwd`
--
-- ⚠️ A NEW numbered file, never an edit to 0001–0005: merged migration files are IMMUTABLE
-- (STACK ADR-007, §3.18). Editing a shipped file leaves already-migrated databases silently
-- divergent from new ones.
--
-- WHY THIS EXISTS (2026-07-22 — user-reported and verified against their own data; DESIGN §3.3
-- and §3.5 carry the matching ⚠️ AMENDED 2026-07-22 blocks):
--
--   §3.3 defined `display_name` as "the last path-like segment of the decoded `encoded_name`".
--   Claude encodes a project path by replacing every non-alphanumeric character with `-`, which
--   is LOSSY AND AMBIGUOUS: a folder whose own name contains a hyphen cannot be told apart from
--   two nested folders. For example:
--
--     encoded_name                         old name   folder it actually is
--     ...-demo-Home-Media-Server           Server     Home-Media-Server
--     ...-demo-Photo-Booth                 Booth      Photo-Booth
--     ...-demo-Portfolio-Site              Site       Portfolio-Site
--
--   The name should be the folder name, not only the last word. Nothing recovers the
--   lost characters from the encoded name alone — the information is not there.
--
-- ⚠️ `events.cwd` is the one unambiguous source, so §3.5's "never rendered" becomes **basename
-- only**. This statement selects no absolute path: `rtrim` strips everything up to and including
-- the final '/' inside the CTE, and only the last segment is ever written or returned. No
-- absolute path is logged, none crosses IPC, none reaches a committed file (P-33, §7.8). §3.8
-- already sets that precedent for `file_touches.path` — basename first, full path only in a
-- hover title.
--
-- ⚠️ `encoded_name` REMAINS THE IDENTITY (§3.3). `display_name` stays cosmetic and two projects
-- may still share one: after this migration two separate `Photo-Booth`
-- directories both read `Photo-Booth`, which is correct and which §3.3 explicitly allows
-- (worktrees are siblings, OQ-007). The UI disambiguates with the encoded name in a tooltip.
--
-- ⚠️ THIS DELETES NOTHING AND RE-PARSES NOTHING. `projects` is DERIVED, but the fix is a
-- re-derive over rows that are already stored, not a purge: no file_manifest row is reset, no
-- byte offset is rewound, no event is touched, and no RETAINED row is disturbed (INV-18,
-- ADR-033). An ARCHIVED session's events keep their `cwd` and take part exactly as live ones do,
-- so an archived-only project is named correctly too.
--
-- ⚠️ A project whose events carry no usable `cwd` is NOT updated: it keeps the insert-time
-- fallback, which is the old decoded-`encoded_name` behaviour (`displayNameForEncodedProject`,
-- src/main/parse/source-file.ts). No project is ever left unnamed.
--
-- The statement below is the VERBATIM text of `RECOMPUTE_PROJECT_DISPLAY_NAMES` in
-- src/main/db/repositories/ingest-repo.ts, which FINALIZING runs after every cycle that parses
-- anything (§5.2). One rule, in one place: this file exists only so that a database that already
-- holds the wrong names is corrected at upgrade instead of waiting for the next file to change.
-- `migrate.test.ts` asserts the two texts are identical. See that constant's doc comment for the
-- derivation rule — anchoring, subdirectory `cwd`s, and the most-frequent/lexical tie-break.

WITH anchored AS (
  SELECT p.id                                      AS project_id,
         substr(e.cwd, 1, length(p.encoded_name))  AS root,
         COUNT(*)                                  AS events
    FROM events e
    JOIN projects p ON p.id = e.project_id
   WHERE e.cwd IS NOT NULL
     AND (length(e.cwd) = length(p.encoded_name)
          OR substr(e.cwd, length(p.encoded_name) + 1, 1) = '/')
     AND substr(e.cwd, 1, length(p.encoded_name))
         GLOB replace(p.encoded_name, '-', '[^a-zA-Z0-9]')
   GROUP BY p.id, root
), folder AS (
  -- The last path segment, and ONLY it: `rtrim(root, <root without its slashes>)` strips
  -- everything after the final '/', so the absolute prefix never leaves this CTE.
  SELECT project_id,
         substr(root, length(rtrim(root, replace(root, '/', ''))) + 1) AS name,
         SUM(events) AS events
    FROM anchored
   GROUP BY project_id, name
  HAVING name <> ''
), chosen AS (
  SELECT project_id, name FROM (
    SELECT project_id, name,
           ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY events DESC, name ASC) AS pick
      FROM folder)
   WHERE pick = 1
)
UPDATE projects SET display_name = (SELECT c.name FROM chosen c WHERE c.project_id = projects.id)
 WHERE EXISTS (SELECT 1 FROM chosen c WHERE c.project_id = projects.id);
