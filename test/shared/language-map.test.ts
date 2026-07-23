// Unit tests for src/shared/language-map.ts — §5.9 M-15, §3.8.
//
// The map is a closed enumeration. These tests pin every pair M-15 lists AND pin that nothing
// else is mapped, because an extension quietly added here changes M-15's language breakdown.

import { describe, expect, it } from 'vitest';
import {
  LANGUAGE_BY_EXTENSION,
  languageForExtension,
  type Language,
} from '../../src/shared/language-map';

// The M-15 enumeration, retyped here by hand from DESIGN §5.9 so the test is an independent
// statement of the contract rather than a restatement of the implementation.
const M15_PAIRS: [string, Language][] = [
  ['ts', 'TypeScript'],
  ['tsx', 'TypeScript'],
  ['js', 'JavaScript'],
  ['jsx', 'JavaScript'],
  ['mjs', 'JavaScript'],
  ['cjs', 'JavaScript'],
  ['py', 'Python'],
  ['rs', 'Rust'],
  ['go', 'Go'],
  ['md', 'Markdown'],
  ['json', 'JSON'],
  ['sql', 'SQL'],
  ['css', 'CSS'],
  ['html', 'HTML'],
  ['sh', 'Shell'],
  ['zsh', 'Shell'],
  ['bash', 'Shell'],
  ['yml', 'YAML'],
  ['yaml', 'YAML'],
  ['toml', 'TOML'],
];

describe('§5.9 M-15 — the extension→language constant table', () => {
  it.each(M15_PAIRS)('maps .%s to %s', (extension, language) => {
    expect(languageForExtension(extension)).toBe(language);
  });

  it('maps exactly the 20 extensions M-15 enumerates and no others', () => {
    // Twenty entries: 2 TypeScript + 4 JavaScript + Python + Rust + Go + Markdown + JSON +
    // SQL + CSS + HTML + 3 Shell + 2 YAML + TOML = 20.
    expect(Object.keys(LANGUAGE_BY_EXTENSION).sort()).toEqual(
      M15_PAIRS.map(([extension]) => extension).sort(),
    );
    expect(Object.keys(LANGUAGE_BY_EXTENSION)).toHaveLength(20);
  });

  it('names exactly the 13 languages M-15 enumerates', () => {
    // TypeScript, JavaScript, Python, Rust, Go, Markdown, JSON, SQL, CSS, HTML, Shell,
    // YAML, TOML = 13 distinct labels.
    expect(new Set<string>(Object.values(LANGUAGE_BY_EXTENSION)).size).toBe(13);
  });
});

describe('languageForExtension — "anything else → NULL, surfaced as other"', () => {
  it.each([
    'txt',
    'jsonc', // deliberately NOT json: M-15 does not list it
    'mts', // deliberately NOT JavaScript/TypeScript: M-15 does not list it
    'cts',
    'c',
    'cpp',
    'java',
    'rb',
    'swift',
    'kt',
    'scss', // deliberately NOT css
    'vue',
    'ini',
    'lock',
    'jsx2',
  ])('returns null for an unmapped extension (.%s)', (extension) => {
    expect(languageForExtension(extension)).toBeNull();
  });

  it('returns null when the basename has no extension (§3.8 stores NULL)', () => {
    expect(languageForExtension(null)).toBeNull();
    expect(languageForExtension(undefined)).toBeNull();
    expect(languageForExtension('')).toBeNull();
  });

  it('never treats a dotted or leading-dot form as mapped — §3.8 stores "no dot"', () => {
    expect(languageForExtension('.ts')).toBeNull();
    expect(languageForExtension('file.ts')).toBeNull();
  });

  it('is case-insensitive, matching the lowercased §3.8 column', () => {
    expect(languageForExtension('TS')).toBe('TypeScript');
    expect(languageForExtension('Yaml')).toBe('YAML');
    expect(languageForExtension('HTML')).toBe('HTML');
  });

  it('does not inherit anything from Object.prototype', () => {
    // A naive `map[ext]` lookup returns a function for these; "other" is the only right answer.
    expect(languageForExtension('constructor')).toBeNull();
    expect(languageForExtension('toString')).toBeNull();
    expect(languageForExtension('__proto__')).toBeNull();
  });
});
