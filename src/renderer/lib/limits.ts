/**
 * §8.6 payload limits, as constants the components actually consult.
 *
 * P-28: "The renderer never holds more than 5,000 rows of any single result set, and never the
 * full dataset." This is a hard cap, not a hint — a table handed more than this renders the cap
 * and says so, because the alternative (rendering everything and getting slow, or silently
 * truncating) is either a broken window or a silently wrong picture.
 */

/** §8.6 P-28. */
export const MAX_RENDERED_ROWS = 5_000;

/** §4.2 — `limit: 1..500`, default 100. `limit > 500` is rejected with `E_INVALID_SETTING`. */
export const MAX_PAGE_LIMIT = 500;

/** §4.2 default page size. */
export const DEFAULT_PAGE_LIMIT = 100;

/** §8.5 P-23 — graph canvases render at most this many nodes, with an explicit label. */
export const MAX_RENDERED_GRAPH_NODES = 500;
