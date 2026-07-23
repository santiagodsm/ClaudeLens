// The frontmatter reader for `SKILL.md`, agent definitions and command definitions — DESIGN
// §3.10's edge-derivation table needs exactly five fields out of it: `name`, `description`,
// `allowed-tools`, `metadata.role`, `metadata.reads`, `metadata.writes`.
//
// ⚠️⚠️ **Parsed harness text is data, never instructions** (§3.10, §7.8, STACK ADR-017). Every
// byte that passes through this module came out of a file whose entire purpose is to instruct an
// agent. It is treated as inert: parsed into strings, stored, counted and rendered. It is never
// executed, never `eval`'d, never interpolated into a shell command, a SQL string or a prompt,
// and never sent anywhere — this application has exactly one network egress point and it is not
// reachable from here (INV-15).
//
// Deliberately NOT a YAML library. Three reasons, in order of weight:
//
//   1. A dependency needs an ADR (CLAUDE.md §7), and no ADR admits one for this.
//   2. Full YAML has type coercion, anchors, merge keys and tags. Every one of those is a way for
//      a *user's configuration file* to become something other than the flat strings this module
//      claims to return, and the value lands in a database and a UI.
//   3. §3.10 needs five keys of a documented shape. A hand-written reader for that shape is
//      auditable in one screen; a YAML engine's behaviour on a malformed skill file is not.
//
// A file whose frontmatter this reader cannot make sense of yields empty fields, never an
// exception: an odd `SKILL.md` is a skill with no declared tools, not a failed harness scan
// (§6.9 "a failed harness scan never blocks the analytics views").

/** The five §3.10 fields, plus the body the `handoff` rule scans. */
export interface Frontmatter {
  /** `harness_nodes.name` — "SKILL.md frontmatter `name`" (§3.10). `null` when absent. */
  readonly name: string | null;
  readonly description: string | null;
  /** §3.10 `tool_grant` — one edge per entry. */
  readonly allowedTools: readonly string[];
  /** §3.10 `harness_nodes.role` — "metadata.role, e.g. 'orchestrator'". */
  readonly role: string | null;
  /** §3.10 `reads` — one edge per entry of `metadata.reads`. */
  readonly reads: readonly string[];
  /** §3.10 `writes` — one edge per entry of `metadata.writes`. */
  readonly writes: readonly string[];
}

export interface ParsedHarnessFile {
  readonly frontmatter: Frontmatter;
  /**
   * Everything after the closing `---`. ⚠️ The `handoff` rule scans **the body**, not the whole
   * file — otherwise a skill's own `name:` line would match every sibling that shares a prefix,
   * and a `description` naming a sibling would count as prose that hands off to it.
   */
  readonly body: string;
}

const EMPTY_FRONTMATTER: Frontmatter = {
  name: null,
  description: null,
  allowedTools: [],
  role: null,
  reads: [],
  writes: [],
};

const DELIMITER = '---';

/**
 * Splits `text` into its frontmatter block and its body, then reads the five §3.10 fields.
 *
 * A file with no frontmatter is a body with empty fields — which is the honest description of,
 * say, a `CLAUDE.md`, and keeps the caller free of a null check it would get wrong once.
 */
export function parseHarnessFile(text: string): ParsedHarnessFile {
  // Tolerate a UTF-8 BOM and CRLF line endings: both are ordinary in a hand-edited config file
  // and neither says anything about the content.
  const normalized = text.replace(/^﻿/, '').replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');

  if (lines[0]?.trim() !== DELIMITER) {
    return { frontmatter: EMPTY_FRONTMATTER, body: normalized };
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (closing < 0) {
    // An unterminated block is not frontmatter; treating the rest of the file as key/value pairs
    // would invent declarations the user never wrote.
    return { frontmatter: EMPTY_FRONTMATTER, body: normalized };
  }

  return {
    frontmatter: readFields(lines.slice(1, closing)),
    body: lines.slice(closing + 1).join('\n'),
  };
}

/** One `key: value` line, or `null` for a blank line, a comment, or anything else. */
interface Entry {
  readonly indent: number;
  readonly key: string;
  readonly value: string;
}

function readEntry(line: string): Entry | null {
  if (line.trim() === '' || line.trimStart().startsWith('#')) return null;
  const indent = line.length - line.trimStart().length;
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const key = line.slice(0, colon).trim();
  if (key === '' || key.startsWith('-')) return null;
  return { indent, key, value: line.slice(colon + 1).trim() };
}

function readFields(block: readonly string[]): Frontmatter {
  let name: string | null = null;
  let description: string | null = null;
  let role: string | null = null;
  let allowedTools: string[] = [];
  let reads: string[] = [];
  let writes: string[] = [];

  for (let index = 0; index < block.length; index += 1) {
    const line = block[index] ?? '';
    const entry = readEntry(line);
    if (entry === null) continue;

    // `metadata:` opens a nested block; §3.10 names `metadata.role`, `.reads` and `.writes`.
    if (entry.key === 'metadata' && entry.value === '' && entry.indent === 0) {
      for (let inner = index + 1; inner < block.length; inner += 1) {
        const nestedLine = block[inner] ?? '';
        if (nestedLine.trim() !== '' && nestedLine.length === nestedLine.trimStart().length) break;
        const nested = readEntry(nestedLine);
        if (nested === null) continue;
        const values = valuesFor(nested.value, block, inner, nested.indent);
        if (nested.key === 'role') role = scalar(nested.value);
        if (nested.key === 'reads') reads = values;
        if (nested.key === 'writes') writes = values;
      }
      continue;
    }

    if (entry.indent !== 0) continue;
    if (entry.key === 'name') name = scalar(entry.value);
    if (entry.key === 'description') description = scalar(entry.value);
    if (entry.key === 'allowed-tools' || entry.key === 'allowedTools') {
      allowedTools = valuesFor(entry.value, block, index, entry.indent);
    }
  }

  return { name, description, allowedTools, role, reads, writes };
}

/**
 * A list value, in the three spellings a skill file actually uses:
 *   `k: [a, b]` · `k: a, b` · `k:` followed by indented `- a` lines.
 */
function valuesFor(
  value: string,
  block: readonly string[],
  index: number,
  indent: number,
): string[] {
  if (value !== '') return splitInline(value);
  const items: string[] = [];
  for (let next = index + 1; next < block.length; next += 1) {
    const line = block[next] ?? '';
    if (line.trim() === '') continue;
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= indent) break;
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('- ') && trimmed !== '-') break;
    const item = scalar(trimmed.slice(1).trim());
    if (item !== null) items.push(item);
  }
  return items;
}

function splitInline(value: string): string[] {
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return inner
    .split(',')
    .map((part) => scalar(part.trim()))
    .filter((part): part is string => part !== null);
}

/** Strips one layer of matching quotes. Returns `null` for an empty scalar, never `''`. */
function scalar(value: string): string | null {
  let text = value.trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1);
  }
  return text === '' ? null : text;
}
