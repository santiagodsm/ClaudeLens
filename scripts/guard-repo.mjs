#!/usr/bin/env node
// pnpm run guard — the non-TypeScript half of INVARIANT 4 (P-33, STACK ADR-015).
//
// This repository is published. ESLint covers `src/**/*.ts`; a personal path actually leaks
// through the files ESLint never sees — a README example, a JSON snapshot, a committed
// fixture, a doc. So this greps every file that is committed OR on its way to being
// committed, and it runs FIRST in `pnpm run check` so the publicly-shared-repo invariant
// fails before anything expensive.
//
// ⚠️ Scope (A-10 gate log): the index is NOT the scope. Scanning `git ls-files` alone made
// this gate near-vacuous during a build — a file is only in the index after it is staged, so
// during the one activity that creates leaks (writing new files) the new files were exactly
// the ones not scanned; the count moved 61 → 42 → 61 as the index churned while 114 files sat
// on disk unread. The scope is therefore `git ls-files` PLUS
// `git ls-files --others --exclude-standard`: everything tracked, plus everything untracked
// that is not gitignored. Deliberately ignored files stay out — `DESIGN_INPUT.md` is
// gitignored *because* it carries a real home path, and scanning it would make `check` red
// for a documented reason. Ignoring a file is a decision; not having staged it yet is not.
//
// It fails on:
//   1. a real `/Users/<name>` or `/home/<name>` home path (documented placeholders like
//      `/Users/<name>` and `/Users/...` are permitted — the rule has to survive being
//      written down in the very documents that define it);
//   2. the current OS username, which is how an author's name leaks without anyone noticing;
//   3. obvious personal-data markers — API keys, tokens, private keys, email addresses;
//   4. any fixture over 256 KB.
//
// Exits non-zero naming the offending file and line. Budget: ~200 ms.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { extname } from 'node:path';

const FIXTURE_DIR = 'test/fixtures/';
const FIXTURE_MAX_BYTES = 256 * 1024;

/** Files whose bytes are not text; scanned for size only. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.icns',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.node',
  '.zip',
  '.gz',
  '.pdf',
  '.db',
]);

/**
 * Usernames too generic to search for without drowning the output in false positives.
 * If the machine's username is one of these, check 2 is skipped and says so.
 */
const GENERIC_USERNAMES = new Set([
  'user',
  'users',
  'admin',
  'root',
  'test',
  'tests',
  'dev',
  'developer',
  'build',
  'runner',
  'node',
  'home',
  'me',
  'ci',
]);

/** Addresses that are project infrastructure rather than a person. */
const ALLOWED_EMAILS = new Set(['noreply@anthropic.com']);

const rules = [
  {
    id: 'personal-home-path',
    // `/Users/` or `/home/` followed by a real-looking name. `/Users/<name>`, `/Users/...`
    // and a bare `` `/Users/` `` are placeholders and do not match, which is what lets
    // PRD.md, STACK.md, DESIGN.md and CLAUDE.md state this rule in prose.
    pattern: /(?:\/Users|\/home)\/[A-Za-z0-9][A-Za-z0-9._-]*/g,
    explain: (hit) =>
      `a real home path (${hit}). \`~/.claude\` is a setting — resolve it through ` +
      'src/main/config/paths.ts. Placeholders like /Users/<name> are fine; this is not one.',
  },
  {
    id: 'private-key',
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    explain: () => 'a private key block',
  },
  {
    id: 'anthropic-api-key',
    pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g,
    explain: () => 'something shaped like an Anthropic API key',
  },
  {
    id: 'github-token',
    pattern: /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    explain: () => 'something shaped like a GitHub token',
  },
  {
    id: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    explain: () => 'something shaped like an AWS access key id',
  },
  {
    id: 'email-address',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,
    explain: (hit) => `an email address (${hit})`,
    ignore: (hit) => ALLOWED_EMAILS.has(hit.toLowerCase()),
  },
];

const username = userInfo().username;
const usernameIsSearchable = username.length >= 4 && !GENERIC_USERNAMES.has(username.toLowerCase());
if (usernameIsSearchable) {
  rules.push({
    id: 'os-username',
    pattern: new RegExp(`\\b${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
    explain: () =>
      "this machine's OS username. An author name is personal data and this repo is published",
  });
}

function gitList(...args) {
  const out = execFileSync('git', ['ls-files', '-z', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((name) => name !== '');
}

/**
 * Everything committed or on its way to being committed: tracked files, plus untracked files
 * that are not gitignored. Two cheap `git ls-files` calls — the budget is unchanged.
 * A path can appear in both listings, so the result is deduplicated and stably ordered.
 */
function filesInScope() {
  const tracked = new Set(gitList());
  const untracked = gitList('--others', '--exclude-standard');
  return { files: [...new Set([...tracked, ...untracked])], tracked };
}

const failures = [];
let scanned = 0;
let scannedUntracked = 0;
let bytes = 0;

let files;
let tracked;
try {
  ({ files, tracked } = filesInScope());
} catch {
  console.error('guard: `git ls-files` failed. scripts/guard-repo.mjs needs a git repository.');
  process.exit(2);
}

for (const file of files) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    continue; // tracked but deleted in the working tree; nothing to inspect
  }
  scanned += 1;
  bytes += size;
  // Noted on every finding: an untracked hit is the one this gate used to miss entirely.
  const note = tracked.has(file) ? '' : '  (untracked, not gitignored)';
  if (note !== '') scannedUntracked += 1;

  if (file.startsWith(FIXTURE_DIR) && size > FIXTURE_MAX_BYTES) {
    failures.push(
      `${file}${note}\n    fixture is ${(size / 1024).toFixed(1)} KB, over the ${FIXTURE_MAX_BYTES / 1024} KB ceiling.\n` +
        '    Fixtures are tiny, synthetic and hand-computed (STACK ADR-012/ADR-013, P-33).',
    );
  }

  if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) continue;

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue; // binary without a known extension

  // Note: guard-repo.mjs is NOT exempted from its own rules. Every pattern above is written
  // so that its own source text does not match it — an exemption here would be a blind spot
  // in the one file whose whole job is to have none.
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      const hit = match[0];
      if (rule.ignore?.(hit)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      failures.push(`${file}:${line}${note}\n    contains ${rule.explain(hit)}  [${rule.id}]`);
      break; // one finding per rule per file is enough to act on
    }
  }
}

if (failures.length > 0) {
  console.error(
    `\nguard: ${failures.length} finding${failures.length === 1 ? '' : 's'} in ${scanned} files ` +
      '(tracked, plus untracked and not gitignored).\n' +
      'This repository is published (P-33, STACK ADR-015). Nothing personal ships.\n',
  );
  for (const failure of failures) console.error(`  ✖ ${failure}\n`);
  process.exit(1);
}

console.log(
  `guard: ${scanned} files clean — ${scanned - scannedUntracked} tracked, ${scannedUntracked} ` +
    `untracked and not gitignored (${(bytes / 1024).toFixed(0)} KB)` +
    (usernameIsSearchable ? '' : ` — os-username check skipped, "${username}" is too generic`),
);
