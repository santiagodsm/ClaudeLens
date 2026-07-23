// src/shared/language-map.ts — the extension→language constant table.
//
// §5.9 M-15: "Extension→language map is a constant table in `src/shared/language-map.ts`
// (`ts/tsx→TypeScript`, `js/jsx/mjs/cjs→JavaScript`, `py→Python`, `rs→Rust`, `go→Go`,
// `md→Markdown`, `json→JSON`, `sql→SQL`, `css→CSS`, `html→HTML`, `sh/zsh/bash→Shell`,
// `yml/yaml→YAML`, `toml→TOML`; anything else → `NULL`, surfaced as 'other')."
//
// ⚠️ The enumeration above is the whole map. An extension the design does not list is `null`,
// not a guess — a file counted under the wrong language is a silently wrong number
// (CLAUDE.md §1). Adding an entry changes M-15's language breakdown and is a design change.
//
// §3.8 stores the result: `file_touches.language TEXT -- from the §5.9 M-15 extension map;
// NULL when unmapped`, keyed by `file_touches.extension TEXT -- lowercased, no dot`.

/**
 * §5.9 M-15 — the constant table, transcribed in the order M-15 enumerates it.
 * Keys are lowercased and dot-free, matching `file_touches.extension` (§3.8).
 */
export const LANGUAGE_BY_EXTENSION = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  md: 'Markdown',
  json: 'JSON',
  sql: 'SQL',
  css: 'CSS',
  html: 'HTML',
  sh: 'Shell',
  zsh: 'Shell',
  bash: 'Shell',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
} as const;

/** §5.9 M-15 — every extension the design maps. Anything else is `null`. */
export type MappedExtension = keyof typeof LANGUAGE_BY_EXTENSION;

/** §5.9 M-15 — the closed set of language labels the app can display. */
export type Language = (typeof LANGUAGE_BY_EXTENSION)[MappedExtension];

// A Map, not a plain-object index: `TABLE['constructor']` on an object literal would return
// `Object.prototype.constructor` and report a file as a language. An extension is untrusted
// input — it comes from a tool argument in someone's transcript (§3.8).
const TABLE: ReadonlyMap<string, Language> = new Map(Object.entries(LANGUAGE_BY_EXTENSION));

/**
 * §5.9 M-15 — the language for one file extension, or `null` when the design does not map it.
 *
 * `null` is the honest answer and the UI surfaces it as **"other"** — it is never bucketed into
 * a neighbouring language and never dropped.
 *
 * Input is the §3.8 `file_touches.extension`: no leading dot, and `null` when the basename has
 * no extension. Lowercasing is applied here too so the table can never be missed by a caller
 * that skipped §3.8's normalisation; §3.8 already lowercases, so this is idempotent.
 */
export function languageForExtension(extension: string | null | undefined): Language | null {
  if (extension === null || extension === undefined || extension === '') return null;
  return TABLE.get(extension.toLowerCase()) ?? null;
}
