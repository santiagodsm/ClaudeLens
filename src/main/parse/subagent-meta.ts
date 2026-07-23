// The subagent run's own sidecar — `subagents/<run-id>.meta.json`.
// DESIGN §3.7 and §5.4 rule 12, both AMENDED 2026-07-22. ADR-020.
//
// ⚠️ WHY THIS FILE EXISTS. §3.7 specified spawn linkage as `parent_uuid` → `uuid`: take the
// run's earliest event, resolve its `parent_uuid` against `events.uuid`, and read the `Agent`
// call off the assistant event that comes back. On the reporting user's real data that
// resolves for **0 of 2,514** runs, and never intermittently — the run's earliest event has
// **no `parent_uuid` at all**. Of 237,606 subagent-origin events exactly 2,515 have a NULL
// `parent_uuid`, one per run: the head of the run's own chain. The chain is per-file. It does
// not cross the file boundary, so there is no edge for that rule to walk.
//
// ⚠️ THE SIDECAR IS MORE STRUCTURAL THAN THE UUID CHAIN, NOT LESS. It sits inside the run's
// own directory, beside the transcript it describes. That is the same kind of evidence
// ADR-020 already prefers over the record-level `isSidechain` flag: where the file is, not
// what a record says about itself. Reading it is not a fallback to a weaker signal.
//
// ⚠️ WHAT THIS IS NOT. It is not a heuristic, and none was added anywhere. There is no
// timestamp proximity, no nearest-preceding `Agent` call and no "the only candidate in that
// window" (§3.7 forbids all three, and that prohibition is why the totals are trustworthy).
// A run whose sidecar is absent, unreadable or names a `toolUseId` that matches no tool call
// keeps `spawn_event_id IS NULL`, is counted, and is disclosed (§4.6). Session attribution is
// untouched: it is still the path, always (ADR-020, §5.4 rules 4–5).
//
// The parse half of this module is pure — text in, facts out — so the shape rules are
// testable without a filesystem (STACK ADR-009/ADR-013). The read half is the only thing here
// that touches disk, and it takes its root as a parameter like everything else (INV-17).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The three fields §3.7 reads. Every one of them is independently optional. */
export interface SubagentMeta {
  /** `agentType` → `subagent_runs.subagent_type`. */
  readonly agentType: string | null;
  /** `toolUseId` → resolved against `tool_calls.tool_use_id` (§3.6). */
  readonly toolUseId: string | null;
  /** `description` → `subagent_runs.description` (§5.4 rule 9's field, same value). */
  readonly description: string | null;
}

/** Nothing was known. Distinct from "a sidecar existed and was empty" only in the log-free sense. */
export const EMPTY_SUBAGENT_META: SubagentMeta = {
  agentType: null,
  toolUseId: null,
  description: null,
};

const JSONL_SUFFIX = '.jsonl';
const META_SUFFIX = '.meta.json';

/**
 * `…/subagents/agent-x.jsonl` → `…/subagents/agent-x.meta.json`.
 *
 * Returns `null` for anything that is not a `.jsonl` path, so a caller can never build a
 * sidecar path for a file that has none.
 */
export function subagentMetaRelPath(transcriptRelPath: string): string | null {
  if (!transcriptRelPath.endsWith(JSONL_SUFFIX)) return null;
  return `${transcriptRelPath.slice(0, -JSONL_SUFFIX.length)}${META_SUFFIX}`;
}

/**
 * §5.4 rule 1's principle, applied to the sidecar: a malformed or surprising document yields
 * *less* knowledge, never a failure and never a guess.
 *
 * ⚠️ Each field is taken **independently**. The nested `subagents/workflows/<wf>/` sidecars on
 * the reference dataset carry an `agentType` and no `toolUseId` whatsoever (77 of them), and
 * dropping the whole document because one field is missing would throw away the only name
 * those runs will ever have. Partial knowledge is better than none.
 *
 * A non-string, empty or whitespace-only value is `null` — "not stated" — never the empty
 * string, which would render as a blank label that looks like an answer.
 */
export function parseSubagentMeta(text: string): SubagentMeta {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return EMPTY_SUBAGENT_META;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return EMPTY_SUBAGENT_META;
  }
  const record = document as Record<string, unknown>;
  return {
    agentType: readString(record['agentType']),
    toolUseId: readString(record['toolUseId']),
    description: readString(record['description']),
  };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Reads one run's sidecar. A missing file is the ordinary case, not an error: older Claude
 * versions wrote none, and a run that has none is simply a run whose agent is not recorded.
 *
 * ⚠️ `claudeDir` is a parameter (INV-17). `transcriptRelPath` comes from `file_manifest`
 * (§3.1.4: POSIX, relative, no `..` — `describeSourceFile` already rejected anything else).
 */
export async function readSubagentMeta(
  claudeDir: string,
  transcriptRelPath: string,
): Promise<SubagentMeta> {
  const metaRelPath = subagentMetaRelPath(transcriptRelPath);
  if (metaRelPath === null) return EMPTY_SUBAGENT_META;
  try {
    return parseSubagentMeta(await readFile(join(claudeDir, ...metaRelPath.split('/')), 'utf8'));
  } catch {
    // ENOENT, EACCES, a directory where a file was expected — all the same fact to §3.7:
    // nothing is known about this run's spawn point from this source. Counted and disclosed
    // downstream (§4.6), never logged as an error (CLAUDE.md §1).
    return EMPTY_SUBAGENT_META;
  }
}

/** True when the document carried nothing §3.7 can use. */
export function isEmptySubagentMeta(meta: SubagentMeta): boolean {
  return meta.agentType === null && meta.toolUseId === null && meta.description === null;
}
