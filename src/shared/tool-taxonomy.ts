// src/shared/tool-taxonomy.ts — the write-class tool set, stated ONCE.
//
// §3.6: `tool_calls.is_write_class = 1` iff `tool_name IN ('Edit','MultiEdit','Write',
// 'NotebookEdit')`. "That set is a single exported constant in `src/shared/tool-taxonomy.ts`,
// so §3.8 and §5.9 M-15 cannot drift apart." This file IS that constant — the ingest
// classifier (§3.6), the `file_touches` derivation (§3.8) and the file metrics (§5.9 M-15)
// all read it, so there is exactly one place the set can be wrong.
//
// §2.1 "Write-class tool call" — a Tool call whose tool writes a file path. The sole source of
// file metrics in v1 (ADR-028: `file-history/` is not parsed).

/**
 * §3.6 / §2.1 — the CLOSED write-class tool set, in the order §3.6 writes it.
 *
 * ⚠️ Adding a member changes what `file_touches` contains and therefore changes M-15's
 * "files touched" and "edit count". It is a design change (§3.6, ADR-028), not a constant edit.
 */
export const WRITE_CLASS_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'] as const;

/** §3.6 — the tool names that set `is_write_class = 1`. */
export type WriteClassTool = (typeof WRITE_CLASS_TOOLS)[number];

// Built from the constant above, never listed a second time: a `Set` literal here would be the
// exact drift §3.6 forbids.
const WRITE_CLASS_TOOL_SET: ReadonlySet<string> = new Set<string>(WRITE_CLASS_TOOLS);

/**
 * §3.6 — whether a raw `tool_name` is write-class. Matching is exact and case-sensitive: the
 * value is the verbatim `tool_use.name` from the transcript, and normalising it here would be
 * an inference the design does not make (§2.1 "Project" — zero inference).
 */
export function isWriteClass(toolName: string): toolName is WriteClassTool {
  return WRITE_CLASS_TOOL_SET.has(toolName);
}
