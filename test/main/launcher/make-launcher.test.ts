// DESIGN.md ADR-038 — the macOS launcher.
//
// What can be tested without a GUI, and nothing that needs one. In particular:
//   - nothing here copies into the real /Applications (that is the one step of
//     `npm run launcher` that writes outside the repository, and it is opt-in);
//   - nothing here launches a window — that boundary is STACK ADR-018's, and
//     `npm run check` inherits no GUI precondition (CLAUDE.md §4).
//
// Every bundle is built inside a per-test sandbox (STACK ADR-013): no test names a fixed
// path, and the repository's own `Claude Lens.app` is never touched by the suite.
//
// The load-bearing assertion is `contains no absolute path`. The generated launcher lands in
// a gitignored bundle, but `npm run guard` also scans untracked-but-not-ignored files (P-33),
// and the launcher is one `--out` away from being written somewhere the gate can see it. The
// safe property is not "we remembered to gitignore it" but "the bytes cannot contain one" —
// which is why that check reads the executable as a buffer and works for either shape.
//
// ⚠️ TWO SHAPES, AND THE SUITE MUST ACCEPT BOTH (ADR-038 as amended 2026-07-22). The
// executable is a compiled, ad-hoc-signed Mach-O when a C compiler is present, and the old
// shell script when it is not. Asserting "Mach-O" unconditionally would make `npm run check`
// red on a cold clone with no Xcode Command Line Tools, which is exactly the failure mode
// ADR-016 exists to avoid and would make `check` a gate nobody believes (CLAUDE.md §4). So
// the tests detect the compiler the same way the generator does — by compiling — and assert
// the shape that machine is actually entitled to.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { useSandbox } from '../../support/sandbox';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts/make-launcher.mjs');
const APP_DIR_NAME = 'Claude Lens.app';
const EXEC_REL = `${APP_DIR_NAME}/Contents/MacOS/claude-lens`;
const PLIST_REL = `${APP_DIR_NAME}/Contents/Info.plist`;
const ICNS_REL = `${APP_DIR_NAME}/Contents/Resources/icon.icns`;

/** Split so this file does not itself contain the literal `npm run guard` fails on. */
const HOME_PREFIX = `/${'Users'}/`;

/**
 * The ten renditions `iconutil` requires for a complete iconset, built rather than written
 * out: `npm run guard`'s email-address rule reads a literal `icon_16x16` + `@` + `2x.png` as an
 * address, and it is right to — the pattern is indistinguishable. Composing the name keeps the
 * gate honest instead of adding an exception to it.
 */
const AT = '@';
const EXPECTED_RENDITIONS = [16, 32, 128, 256, 512].flatMap((size) => [
  `icon_${size}x${size}.png`,
  `icon_${size}x${size}${AT}2x.png`,
]);

function build(outDir: string): string {
  execFileSync(process.execPath, [SCRIPT, '--out', outDir], { encoding: 'utf8', stdio: 'pipe' });
  return join(outDir, APP_DIR_NAME);
}

/**
 * Can this machine compile the launcher at all? Decided by compiling, never by `which`:
 * `/usr/bin/clang` exists on every Mac as a Command Line Tools shim and exits non-zero
 * telling you to run `xcode-select --install` when the tools are absent. The generator
 * makes exactly the same call, so the two never disagree about which shape to expect.
 */
function compilerAvailable(): boolean {
  const dir = join(
    tmpdir(),
    `claude-lens-cc-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  try {
    const src = join(dir, 'probe.c');
    writeFileSync(src, 'int main(void) { return 0; }\n');
    const probe = spawnSync('/usr/bin/clang', ['-o', join(dir, 'probe'), src], {
      encoding: 'utf8',
    });
    return probe.error === undefined && probe.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Mach-O 64 little-endian (0xcffaedfe) or a fat/universal wrapper (0xcafebabe / 0xcafebabf). */
function isMachO(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const magic = bytes.readUInt32BE(0);
  return (
    magic === 0xcffaedfe || magic === 0xfeedfacf || magic === 0xcafebabe || magic === 0xcafebabf
  );
}

function plistValue(plistPath: string, key: string): string {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plistPath], {
    encoding: 'utf8',
  }).trim();
}

/** A repository the launcher will accept, with no build output and no Electron in it. */
function writeStubRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ "name": "claude-lens", "version": "0.0.0" }\n');
}

/**
 * A stub repository that HAS been built, with explicit mtimes so the staleness comparison
 * is decided by the test rather than by how fast the filesystem clock happens to tick.
 *
 * Electron is deliberately still absent: the launcher checks staleness before it looks for
 * the Electron binary, so these tests observe the staleness behaviour and then stop at a
 * failure dialog — never at a window (STACK ADR-018).
 */
function writeBuiltStubRepo(dir: string, { sourceIsNewer }: { sourceIsNewer: boolean }): void {
  writeStubRepo(dir);
  mkdirSync(join(dir, 'src/main'), { recursive: true });
  mkdirSync(join(dir, 'out/main'), { recursive: true });

  const source = join(dir, 'src/main/index.ts');
  const built = join(dir, 'out/main/index.cjs');
  writeFileSync(source, 'export {};\n');
  writeFileSync(built, '// built\n');

  const older = new Date(Date.now() - 60_000);
  const newer = new Date(Date.now() - 10_000);
  utimesSync(source, sourceIsNewer ? newer : older, sourceIsNewer ? newer : older);
  utimesSync(built, sourceIsNewer ? older : newer, sourceIsNewer ? older : newer);
  // package.json is source too; keep it old so it never decides these tests by accident.
  utimesSync(join(dir, 'package.json'), older, older);
}

/**
 * Repoint a generated bundle's recorded fallback at a directory that does not exist.
 *
 * ⚠️ Every generated bundle records the real repository, so a test that only breaks the
 * self-relative path would fall through to it, find a built `out/`, and launch a window.
 * Breaking the pointer is what keeps these tests off the GUI (STACK ADR-018's boundary).
 */
function orphanPointer(appPath: string, sandboxPath: string): void {
  writeFileSync(
    join(appPath, 'Contents/Resources/repo-root'),
    `${join(sandboxPath, 'no-such-repository')}\n`,
  );
}

describe('ADR-038 — make-launcher produces a well-formed .app bundle', () => {
  const sandbox = useSandbox();

  it('writes Info.plist, an executable and an icon, and nowhere else', () => {
    const appPath = build(sandbox.path);

    expect(existsSync(join(sandbox.path, PLIST_REL))).toBe(true);
    expect(existsSync(join(sandbox.path, EXEC_REL))).toBe(true);
    expect(existsSync(join(sandbox.path, ICNS_REL))).toBe(true);
    expect(existsSync(join(appPath, 'Contents/PkgInfo'))).toBe(true);

    // A universal two-slice Mach-O of this launcher is ~70 KB; the shell fallback is ~5 KB.
    // Either way nothing here is a packaged application: no Electron binary, no framework,
    // no app code (ADR-038 vs the ~250 MB electron-builder bundle). The bundle's ~1 MB is
    // almost entirely the .icns.
    expect(statSync(join(sandbox.path, EXEC_REL)).size).toBeLessThan(256 * 1024);
  });

  it('Info.plist parses, and carries the keys macOS actually reads', () => {
    build(sandbox.path);
    const plist = join(sandbox.path, PLIST_REL);

    // `plutil -lint` exits non-zero on a malformed plist, which is the failure that produces
    // an app that will not launch and says nothing about why.
    expect(() =>
      execFileSync('/usr/bin/plutil', ['-lint', plist], { encoding: 'utf8' }),
    ).not.toThrow();

    expect(plistValue(plist, 'CFBundleName')).toBe('Claude Lens');
    expect(plistValue(plist, 'CFBundleIdentifier')).toBe('app.claude-lens.launcher');
    expect(plistValue(plist, 'CFBundleIconFile')).toBe('icon');
    expect(plistValue(plist, 'CFBundleExecutable')).toBe('claude-lens');
    expect(plistValue(plist, 'NSHighResolutionCapable')).toBe('true');
    expect(plistValue(plist, 'LSMinimumSystemVersion')).toMatch(/^\d+(\.\d+)*$/);

    // The version is defined once, in package.json. A second copy is a second source of truth.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(plistValue(plist, 'CFBundleVersion')).toBe(pkg.version);
    expect(plistValue(plist, 'CFBundleShortVersionString')).toBe(pkg.version);
  });

  it('makes the launcher executable, in whichever shape this machine can produce', () => {
    build(sandbox.path);
    const execPath = join(sandbox.path, EXEC_REL);
    const bytes = readFileSync(execPath);

    expect(statSync(execPath).mode & 0o111).toBe(0o111);

    if (compilerAvailable()) {
      // ⚠️ The amendment's entire point: TCC attributes file-access permission to an
      // executable's code identity, and a script has none. A Mach-O here is not a
      // performance choice, it is the difference between an app that can be granted
      // access to an external volume and one that can never even be listed.
      expect(isMachO(bytes)).toBe(true);
    } else {
      expect(bytes.subarray(0, 12).toString('utf8')).toBe('#!/bin/bash\n');
      expect(() => execFileSync('/bin/bash', ['-n', execPath], { encoding: 'utf8' })).not.toThrow();
    }
  });

  it('ad-hoc signs the bundle, and signs it last so the seal covers the real contents', () => {
    const appPath = build(sandbox.path);

    // `codesign -dv` reports on stderr. An ad-hoc signature costs nothing — no certificate,
    // no Apple Developer account, no notarization — and is what gives TCC a stable cdhash
    // to record a Privacy & Security decision against (ADR-038 amended 2026-07-22).
    const shown = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', appPath], {
      encoding: 'utf8',
    });
    const report = `${shown.stderr ?? ''}${shown.stdout ?? ''}`;
    expect(report).toMatch(/Signature\s*=\s*adhoc/i);
    expect(report).toContain('app.claude-lens.launcher');

    // Signing must happen AFTER Info.plist, the icon and the repo pointer are written —
    // the seal covers Contents/Resources and Info.plist, so signing early seals a bundle
    // that no longer exists and `--verify` is the only thing that notices.
    const verified = spawnSync('/usr/bin/codesign', ['--verify', '--strict', appPath], {
      encoding: 'utf8',
    });
    expect(verified.status).toBe(0);
  });

  it('produces a real .icns holding the full iconset, 16 through 512 at 1x and 2x', () => {
    build(sandbox.path);
    const icns = join(sandbox.path, ICNS_REL);

    // Magic number, then a round-trip: iconutil only converts back what it can parse, so a
    // successful expansion is a stronger statement than any header check.
    expect(readFileSync(icns).subarray(0, 4).toString('ascii')).toBe('icns');

    const expanded = join(sandbox.path, 'expanded.iconset');
    execFileSync('/usr/bin/iconutil', ['--convert', 'iconset', '--output', expanded, icns], {
      encoding: 'utf8',
    });
    expect(readdirSync(expanded).sort()).toEqual([...EXPECTED_RENDITIONS].sort());

    // The 16 px rendition is the Dock one, and it must be a real 16 px image rather than a
    // scaled placeholder — the icon must never fall back to Electron's default.
    const dockIcon = readFileSync(join(expanded, 'icon_16x16.png'));
    expect(dockIcon.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(dockIcon.readUInt32BE(16)).toBe(16); // IHDR width
    expect(dockIcon.readUInt32BE(20)).toBe(16); // IHDR height
  });
});

describe('ADR-038 — the launcher embeds no absolute path (P-33)', () => {
  const sandbox = useSandbox();

  it('contains no home-directory literal and no path to the repository that built it', () => {
    build(sandbox.path);

    // Read as bytes, not text: a compiled Mach-O is not valid UTF-8, and a lossy decode
    // could in principle mangle the very substring being searched for.
    const bytes = readFileSync(join(sandbox.path, EXEC_REL));

    expect(bytes.includes(Buffer.from(HOME_PREFIX))).toBe(false);
    expect(bytes.includes(Buffer.from(REPO_ROOT.replace(/\/$/, '')))).toBe(false);
    expect(bytes.includes(Buffer.from(sandbox.path))).toBe(false);
  });

  it('resolves the repository at run time, in the committed source of either shape', () => {
    // The property has to hold of the *source*, since the compiled form is opaque. The C
    // launcher asks the kernel where it is (_NSGetExecutablePath); the shell fallback uses
    // `pwd -P`. Neither is ever handed a path by the generator (P-33).
    const c = readFileSync(join(REPO_ROOT, 'resources/launcher.c'), 'utf8');
    expect(c).toContain('_NSGetExecutablePath');
    expect(c).not.toContain(HOME_PREFIX);
    expect(c).not.toContain(REPO_ROOT.replace(/\/$/, ''));

    const generator = readFileSync(join(REPO_ROOT, 'scripts/make-launcher.mjs'), 'utf8');
    expect(generator).toContain('pwd -P');
  });
});

describe('ADR-038 — the launcher fails loudly, never silently', () => {
  const sandbox = useSandbox();

  /** Run a generated launcher with the dialog suppressed; `check` opens no windows. */
  function runLauncher(execPath: string): { status: number | null; stderr: string } {
    const result = spawnSync(execPath, [], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_LENS_LAUNCHER_NO_DIALOG: '1' },
    });
    return { status: result.status, stderr: result.stderr };
  }

  it('exits non-zero and explains itself when out/ has not been built', () => {
    const repo = sandbox.resolve('repo');
    writeStubRepo(repo);
    const appPath = build(repo);
    orphanPointer(appPath, sandbox.path);

    const { status, stderr } = runLauncher(join(repo, EXEC_REL));

    expect(status).not.toBe(0);
    expect(stderr).toContain('has not been built yet');
    expect(stderr).toContain('npm run build');
    // The message names the repository it looked in — an error the user cannot act on is
    // the desktop equivalent of a silently wrong number (CLAUDE.md §1).
    expect(stderr).toContain(repo);
  });

  it('exits non-zero and explains itself when the repository has moved away', () => {
    const repo = sandbox.resolve('repo');
    writeStubRepo(repo);
    build(repo);

    // Move the bundle somewhere with no repository above it and break its recorded pointer:
    // exactly the state the user reaches by moving or renaming the checkout.
    const orphan = sandbox.resolve('orphan');
    mkdirSync(orphan, { recursive: true });
    cpSync(join(repo, APP_DIR_NAME), join(orphan, APP_DIR_NAME), { recursive: true });
    orphanPointer(join(orphan, APP_DIR_NAME), sandbox.path);

    const { status, stderr } = runLauncher(join(orphan, EXEC_REL));

    expect(status).not.toBe(0);
    expect(stderr).toContain('cannot find its source repository');
    expect(stderr).toContain('npm run launcher');
  });

  it('warns when the build is older than the source it was built from', () => {
    // The silent-wrong-number case for a launcher: the app opens, everything looks normal,
    // and the numbers on screen were computed by the previous build. Detection only — the
    // launcher still refuses to build, because a build can fail and a dialog cannot show why.
    const repo = sandbox.resolve('repo');
    writeBuiltStubRepo(repo, { sourceIsNewer: true });
    const appPath = build(repo);
    orphanPointer(appPath, sandbox.path);

    const { status, stderr } = runLauncher(join(repo, EXEC_REL));

    expect(stderr).toContain('out-of-date build');
    expect(stderr).toContain('npm run build');
    expect(stderr).toContain(join(repo, 'src/main/index.ts'));

    // It warned and carried on: the run still reaches — and fails at — the Electron check.
    // A staleness warning must never be the thing that stops the app from opening.
    expect(stderr).toContain('cannot find the Electron binary');
    expect(status).not.toBe(0);
  });

  it('says nothing about staleness when the build is newer than the source', () => {
    const repo = sandbox.resolve('repo');
    writeBuiltStubRepo(repo, { sourceIsNewer: false });
    const appPath = build(repo);
    orphanPointer(appPath, sandbox.path);

    const { status, stderr } = runLauncher(join(repo, EXEC_REL));

    expect(stderr).not.toContain('out-of-date build');
    // Still went on to the next check, so the silence is "found nothing", not "skipped".
    expect(stderr).toContain('cannot find the Electron binary');
    expect(status).not.toBe(0);
  });

  it('tells the user it is a permission problem when the repository cannot be read', () => {
    // macOS refuses a double-clicked app read access to external and network volumes until
    // the user grants it, while letting it stat them — so "missing" and "unreadable" must not
    // collapse into one message. An unreadable package.json reproduces that shape locally.
    const repo = sandbox.resolve('repo');
    writeStubRepo(repo);
    const appPath = build(repo);
    orphanPointer(appPath, sandbox.path);
    chmodSync(join(repo, 'package.json'), 0o000);

    try {
      const { status, stderr } = runLauncher(join(repo, EXEC_REL));
      expect(status).not.toBe(0);
      expect(stderr).toContain('blocking Claude Lens from reading');
      expect(stderr).toContain('Privacy & Security');
    } finally {
      chmodSync(join(repo, 'package.json'), 0o644);
    }
  });
});
