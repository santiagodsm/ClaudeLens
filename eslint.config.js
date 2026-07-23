// ESLint 10 flat config — STACK ADR-014 (tooling) and ADR-015 (the four architectural
// invariants). `eslint . --max-warnings 0`: there is no warning tier, a rule is either on
// and blocking or off.
//
// Everything below that reads as "unusually strict" is one of the four invariants in
// STACK ADR-015 / CLAUDE.md §3. If you want to disable one, you have misread the design —
// stop and report it (CLAUDE.md §2).

import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';

// ---------------------------------------------------------------------------
// INVARIANT 1 — exactly one network egress point (INV-15, DESIGN §7.5)
// The single allowlisted file is src/main/pricing/fetch-price-table.ts.
// ---------------------------------------------------------------------------

const EGRESS_ONLY_FILE = 'src/main/pricing/fetch-price-table.ts';

const EGRESS_MESSAGE =
  `INV-15: exactly one network egress point exists, and it is ${EGRESS_ONLY_FILE}. ` +
  'No telemetry, no analytics, no update check, no remote font, no remote asset. ' +
  'A second egress point is a PRD change, not a config change (STACK ADR-015).';

const RESTRICTED_GLOBALS = [
  { name: 'fetch', message: EGRESS_MESSAGE },
  { name: 'XMLHttpRequest', message: EGRESS_MESSAGE },
  { name: 'WebSocket', message: EGRESS_MESSAGE },
  { name: 'EventSource', message: EGRESS_MESSAGE },
];

const EGRESS_IMPORT_PATHS = [
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'node:dgram',
  'http',
  'https',
  'net',
  'tls',
  'dgram',
  'axios',
  'undici',
  'node-fetch',
].map((name) => ({ name, message: EGRESS_MESSAGE }));

// ---------------------------------------------------------------------------
// INVARIANT 3 — os.homedir() appears in exactly one file (INV-17)
// ---------------------------------------------------------------------------

const HOMEDIR_ONLY_FILE = 'src/main/config/paths.ts';

const HOMEDIR_MESSAGE =
  `INV-17: os.homedir() appears in exactly one file — ${HOMEDIR_ONLY_FILE}. ` +
  'Every scanner, parser and action entry point takes its root directory as a parameter; ' +
  'no module resolves claudeDir implicitly (STACK ADR-013/ADR-015). This app deletes files.';

const HOMEDIR_IMPORT_PATHS = [
  { name: 'node:os', importNames: ['homedir'], message: HOMEDIR_MESSAGE },
  { name: 'os', importNames: ['homedir'], message: HOMEDIR_MESSAGE },
];

const RESTRICTED_PROPERTIES = [
  { object: 'os', property: 'homedir', message: HOMEDIR_MESSAGE },
  { object: 'nodeOs', property: 'homedir', message: HOMEDIR_MESSAGE },
];

// ---------------------------------------------------------------------------
// INVARIANT 2 — the query seam (INV-16, STACK ADR-008)
// ---------------------------------------------------------------------------

const SEAM_MESSAGE =
  "INV-16: the renderer's only vocabulary is the typed IPC contract in src/shared/ipc-contract.ts. " +
  'It may not import src/main/**, better-sqlite3*, node:fs, node:path or electron ' +
  '(STACK ADR-003/ADR-008). Anything the renderer needs must exist as a typed IPC method.';

const RENDERER_FORBIDDEN_PATHS = [
  { name: 'electron', message: SEAM_MESSAGE },
  { name: 'node:fs', message: SEAM_MESSAGE },
  { name: 'fs', message: SEAM_MESSAGE },
  { name: 'node:path', message: SEAM_MESSAGE },
  { name: 'path', message: SEAM_MESSAGE },
];

const RENDERER_FORBIDDEN_PATTERNS = [
  { group: ['**/main/**', '**/src/main/**'], message: SEAM_MESSAGE },
  {
    group: [
      'better-sqlite3',
      'better-sqlite3/**',
      'better-sqlite3-*',
      'better-sqlite3-*/**',
      'electron/**',
      'node:fs/**',
      'node:path/**',
    ],
    message: SEAM_MESSAGE,
  },
];

// ---------------------------------------------------------------------------
// INVARIANT 4 — no personal path in any source file (P-33)
// The non-TypeScript half of this invariant is scripts/guard-repo.mjs.
// ---------------------------------------------------------------------------

const PERSONAL_PATH_MESSAGE =
  'P-33: this repository is published. No /Users/... literal, no author name, no real ' +
  '.claude content — anywhere, including tests, README examples and commit messages. ' +
  '`~/.claude` is a setting; resolve it through src/main/config/paths.ts (STACK ADR-015).';

const NO_PERSONAL_PATH = [
  { selector: 'Literal[value=/^\\/Users\\//]', message: PERSONAL_PATH_MESSAGE },
  { selector: 'TemplateElement[value.raw=/^\\/Users\\//]', message: PERSONAL_PATH_MESSAGE },
  { selector: 'Literal[value=/^\\/home\\/[a-zA-Z0-9]/]', message: PERSONAL_PATH_MESSAGE },
];

// ---------------------------------------------------------------------------
// DESIGN §12.1 item 4 (second half) — SQL text exists only under src/main/db/**
// Deliberately shaped to need two SQL keywords in sequence so that ordinary UI copy
// ("Select a directory", "Update available") cannot trip it.
// ---------------------------------------------------------------------------

const SQL_MESSAGE =
  'INV-16: SQL text exists only under src/main/db/**, behind a repository function ' +
  '(STACK ADR-007/ADR-008). No view, component, hook, store or service composes SQL.';

const SQL_PATTERN =
  '/\\bSELECT\\b[^;]{0,300}\\bFROM\\b|\\bINSERT\\s+INTO\\b|\\bDELETE\\s+FROM\\b|' +
  '\\bUPDATE\\b[^;]{0,80}\\bSET\\b|\\bCREATE\\s+(TABLE|INDEX|VIEW|TRIGGER)\\b|' +
  '\\bALTER\\s+TABLE\\b|\\bPRAGMA\\s+[a-z_]/i';

const NO_SQL_OUTSIDE_DB = [
  { selector: `Literal[value=${SQL_PATTERN}]`, message: SQL_MESSAGE },
  { selector: `TemplateElement[value.raw=${SQL_PATTERN}]`, message: SQL_MESSAGE },
];

// ---------------------------------------------------------------------------
// `design-token-lint` (STACK gate manifest, DESIGN §6.1)
// src/renderer/styles/tokens.css is the ONLY file allowed a raw hex/rgb/hsl literal or a
// raw px value. ESLint does not lint CSS, so scoping to src/renderer/**/*.{ts,tsx} already
// excludes tokens.css; the patterns are still written tightly enough that ordinary strings
// (`data-testid`, ids, class names) cannot match.
// ---------------------------------------------------------------------------

const TOKEN_MESSAGE =
  'design-token-lint (DESIGN §6.1): colours and spacing come from the token layer in ' +
  'src/renderer/styles/tokens.css — the only file allowed a raw hex/rgb/hsl literal or a ' +
  'raw px value. Use a CSS custom property or a Tailwind token, never a literal.';

// `#` + exactly 3/4/6/8 hex digits, not followed by another word character.
const HEX_COLOUR =
  '/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_])/';
const FUNCTIONAL_COLOUR = '/\\b(rgba?|hsla?|oklch|color-mix)\\s*\\(/i';
const RAW_PX = '/(^|[^a-zA-Z0-9_-])[0-9]+(\\.[0-9]+)?px([^a-zA-Z0-9_-]|$)/';

const NO_RAW_DESIGN_VALUES = [HEX_COLOUR, FUNCTIONAL_COLOUR, RAW_PX].flatMap((pattern) => [
  { selector: `Literal[value=${pattern}]`, message: TOKEN_MESSAGE },
  { selector: `TemplateElement[value.raw=${pattern}]`, message: TOKEN_MESSAGE },
]);

// ---------------------------------------------------------------------------
// STACK ADR-012 / DESIGN §12.1 item 9 — no auto-written snapshot under test/metrics/**
// ---------------------------------------------------------------------------

const SNAPSHOT_MESSAGE =
  'STACK ADR-012: an auto-written snapshot records whatever the code currently produces, ' +
  'which for this project is a machine for blessing the bug. Metric fixtures use an inline ' +
  'hand-computed expected value with the arithmetic in a comment: ' +
  'expect(activeSeconds).toBe(5_400). Snapshots are reserved for structural output.';

const NO_METRIC_SNAPSHOTS = [
  {
    selector: 'CallExpression[callee.property.name=/^toMatch(File|Inline)?Snapshot$/]',
    message: SNAPSHOT_MESSAGE,
  },
];

// ---------------------------------------------------------------------------

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      '*.html',
      'test/fixtures/**',
    ],
  },

  // Type-aware everywhere (STACK ADR-014). `projectService` resolves each file through the
  // tsconfig that owns it — tsconfig.{shared,main,preload,renderer,test}.json and
  // e2e/tsconfig.json — so ADR-015's rules can assume type information.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.ts', '*.js', '*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Plain-JS tooling (this file, scripts/*.mjs) is not part of any TypeScript program.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },

  // ---- The four invariants, applied to every file in the repository ----
  {
    rules: {
      'no-restricted-globals': ['error', ...RESTRICTED_GLOBALS],
      'no-restricted-imports': [
        'error',
        { paths: [...EGRESS_IMPORT_PATHS, ...HOMEDIR_IMPORT_PATHS] },
      ],
      'no-restricted-properties': ['error', ...RESTRICTED_PROPERTIES],
    },
  },

  // INVARIANT 4 + the SQL half of INVARIANT 2, over the whole source tree.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_PERSONAL_PATH, ...NO_SQL_OUTSIDE_DB],
    },
  },
  {
    files: ['src/main/db/**/*.ts'],
    rules: {
      // SQL belongs here and only here. The personal-path ban still applies.
      'no-restricted-syntax': ['error', ...NO_PERSONAL_PATH],
    },
  },

  // INVARIANT 2 — the renderer half of the query seam.
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...EGRESS_IMPORT_PATHS, ...HOMEDIR_IMPORT_PATHS, ...RENDERER_FORBIDDEN_PATHS],
          patterns: RENDERER_FORBIDDEN_PATTERNS,
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...NO_PERSONAL_PATH,
        ...NO_SQL_OUTSIDE_DB,
        ...NO_RAW_DESIGN_VALUES,
      ],
    },
  },
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    ...reactHooks.configs.flat.recommended,
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      // ADR-014: there is no warning tier. A rule is either on and blocking, or off.
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/incompatible-library': 'error',
      'react-hooks/unsupported-syntax': 'error',
    },
  },

  // ---- The two single-file allowlists. Both are deliberate, both are visible in review. ----

  // INVARIANT 1's one permitted egress point.
  {
    files: [EGRESS_ONLY_FILE],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-imports': ['error', { paths: HOMEDIR_IMPORT_PATHS }],
    },
  },

  // INVARIANT 3's one permitted os.homedir() caller. It also carries the ADR-018
  // CLAUDE_LENS_E2E startup assertion, which needs the real home directory to assert against.
  {
    files: [HOMEDIR_ONLY_FILE],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-imports': ['error', { paths: EGRESS_IMPORT_PATHS }],
    },
  },

  // ---- Tests ----
  {
    files: ['test/**/*.ts', 'test/**/*.tsx', 'e2e/**/*.ts'],
    rules: {
      // Fixture roots are sandbox paths built at runtime (STACK ADR-013); a test that
      // names a fixed path is the bug this rule exists to catch.
      'no-restricted-syntax': ['error', ...NO_PERSONAL_PATH],
    },
  },
  {
    files: ['test/metrics/**/*.ts', 'test/metrics/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_PERSONAL_PATH, ...NO_METRIC_SNAPSHOTS],
    },
  },

  // Prettier owns formatting; ESLint owns correctness (STACK ADR-014). Last, so it wins.
  prettierConfig,
);
