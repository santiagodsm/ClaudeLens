#!/usr/bin/env node
// npm run launcher — generates `Claude Lens.app`, a thin macOS launcher (DESIGN.md ADR-038).
//
// ADR-016 said "source only, no packaging tool" and named its own revisit trigger: *the user
// asks for a double-clickable app*. The user asked. ADR-038 records the change. What ADR-016
// still forbids is untouched and this script depends on none of it: **no packaging toolchain,
// no new npm dependency, no notarization, no `.dmg`, no store, no auto-update, no release
// binary, and no Apple Developer account.** A `.app` is a directory with a plist in it, and
// macOS ships `sips`, `iconutil`, `codesign` and (with the free Command Line Tools) `clang`.
// That is the whole build.
//
// ⚠️ AMENDED 2026-07-22 — the executable is a COMPILED, AD-HOC SIGNED Mach-O, not a script.
// macOS TCC attributes file-access permissions to an executable's *code identity*. A bundle
// whose CFBundleExecutable is `#!/bin/bash` has none — the kernel execs /bin/bash — so an
// unsigned, script-backed bundle has nothing for TCC to remember: it never prompts, never
// appears under Privacy & Security → Files and Folders, and cannot be granted access to a
// repository on an external volume. `codesign -s - --force` costs nothing and no account, and
// it is what gives the bundle a stable cdhash for TCC to attribute a decision to. See
// `resources/launcher.c`. If no compiler is present this falls back to the shell script with a
// loud warning: a cold clone without Xcode Command Line Tools must still get a *working*
// launcher (ADR-016's whole concern), and `npm run launcher` is opt-in and outside `check`.
//
// The bundle is a **build output**: gitignored, never committed, ~1 MB — almost all of which
// is the `.icns`; the executable itself is ~70 KB of universal Mach-O (~5 KB of shell in the
// fallback). It contains no application code — it resolves this repository at run time and
// execs the repository's own Electron binary against `out/`.
//
// ⚠️ P-33 / INV-15's sibling: `npm run guard` fails on any `/Users/...` in a tracked *or*
// untracked-but-not-ignored file. Two rules follow, and both are tested:
//   1. the generated launcher — compiled or script — contains **no absolute path at all**; it
//      resolves the repository from its own location at run time, and so does its C source;
//   2. everything this script writes lands inside the gitignored bundle or the gitignored
//      icon work directory.
//
// Usage:
//   npm run launcher                 build `Claude Lens.app` beside package.json
//   npm run launcher -- --install    ...and then copy it into /Applications (opt-in, never
//                                    the default — it writes outside the repository)
//   npm run launcher -- --out DIR    build into DIR instead (used by the tests, sandboxed)
//   npm run launcher -- --help

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const APP_NAME = 'Claude Lens';
const APP_DIR_NAME = `${APP_NAME}.app`;
/** CFBundleExecutable, and the file name under Contents/MacOS. */
const EXEC_NAME = 'claude-lens';
/** CFBundleIdentifier. Not a registered domain; it identifies the bundle, nothing more. */
const BUNDLE_ID = 'app.claude-lens.launcher';
/** CFBundleIconFile — the `.icns` basename inside Contents/Resources. */
const ICON_BASENAME = 'icon';
/** Read by the launcher only when self-relative resolution fails (the /Applications copy). */
const REPO_POINTER_NAME = 'repo-root';
const APPLICATIONS_DIR = '/Applications';

/** The .icns sizes Apple's iconset format defines. `iconutil` rejects anything else. */
const ICONSET_SIZES = [16, 32, 128, 256, 512];

/** The committed C source. Compiled to Contents/MacOS/claude-lens; see its header. */
const LAUNCHER_SOURCE_REL = 'resources/launcher.c';

/**
 * Both slices, so the bundle keeps working under Rosetta and on an Intel Mac. Tried
 * together first; if the pair does not link cleanly we fall back to the native slice
 * and say so, rather than failing on a machine that only has one SDK.
 */
const UNIVERSAL_ARCHES = ['arm64', 'x86_64'];

/**
 * Compilers to try, in order. `/usr/bin/clang` is the Command Line Tools shim and is
 * present even when the tools are not installed — it then exits non-zero telling you to
 * run `xcode-select --install`. That is why availability is decided by *actually
 * compiling*, never by `which`.
 */
const COMPILER_CANDIDATES = ['/usr/bin/clang', 'clang', 'cc'];

// ---------------------------------------------------------------------------
// The fallback launcher executable.
//
// ⚠️ This is the DEGRADED path, used only when no C compiler is available. It works —
// double-clicking the bundle starts Claude Lens exactly as the compiled one does — but it
// has no code identity, so macOS TCC cannot attribute a file-access decision to it and
// the app can never be granted access to an external or network volume. See the amended
// header and `resources/launcher.c`. Kept because ADR-016's concern is not creating a
// cold-clone failure mode: a checkout without Xcode Command Line Tools still gets a
// working launcher, with a warning, rather than an error.
//
// Held here as one constant string. The only interpolation is a file *name*
// (REPO_POINTER_NAME); no path, no repository location, nothing machine-derived
// is ever substituted in. That is what makes "the generated launcher contains no
// absolute path" a property of this source file rather than of the machine that
// happened to run it — and `test/main/launcher/make-launcher.test.ts` asserts it of
// whichever executable was produced.
// ---------------------------------------------------------------------------

const LAUNCHER_SCRIPT = `#!/bin/bash
# Claude Lens launcher — GENERATED by scripts/make-launcher.mjs (DESIGN.md ADR-038).
# Do not edit; 'npm run launcher' overwrites it.
#
# This file contains no application code and no absolute path. It resolves the Claude Lens
# repository at RUN TIME and execs that repository's own Electron binary against its build
# output. It is deliberately thin: the app lives in the repository, not in here.
#
# Every failure below ends in a native dialog that says what happened and what to do, and a
# non-zero exit. A launcher that bounces once in the Dock and dies is the desktop equivalent
# of a silently wrong number (CLAUDE.md section 1) — the user gets no information and no way
# to act. That is the single most important behaviour in this file.

set -u

TITLE='Claude Lens'

# Dialog unless stderr is a terminal (i.e. someone is debugging from a shell and can read it)
# or CLAUDE_LENS_LAUNCHER_NO_DIALOG is set, which is how the test suite exercises these paths
# without a window server (STACK ADR-018's boundary: nothing in 'npm run check' opens a GUI).
fail() {
  printf '%s\\n' "$1" >&2
  if [ -z "\${CLAUDE_LENS_LAUNCHER_NO_DIALOG:-}" ] && [ ! -t 2 ]; then
    /usr/bin/osascript \\
      -e 'on run argv' \\
      -e 'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"OK"} default button "OK" with icon stop' \\
      -e 'end run' \\
      -- "$1" "$TITLE" >/dev/null 2>&1
  fi
  exit 1
}

# A two-button question — the one place this launcher asks instead of exiting. Returns 0 to
# proceed, 1 to cancel. Suppressed the same way 'fail' is, and for the same reason. The answer
# is read from osascript's OUTPUT, not its exit status: "the user clicked Cancel" and
# "osascript could not run" both exit non-zero and they mean opposite things.
confirm() {
  if [ -n "\${CLAUDE_LENS_LAUNCHER_NO_DIALOG:-}" ] || [ -t 2 ]; then
    printf '%s\\n' "$1" >&2
    return 0
  fi
  [ -x /usr/bin/osascript ] || return 0
  answer="$(/usr/bin/osascript \\
    -e 'on run argv' \\
    -e 'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Cancel", "Open anyway"} default button "Open anyway" with icon caution' \\
    -e 'return button returned of result' \\
    -e 'end run' \\
    -- "$1" "$TITLE" 2>/dev/null)" || answer=''
  case "$answer" in
    *'Open anyway'*) return 0 ;;
  esac
  return 1
}

self="$0"
case "$self" in
  /*) ;;
  *) self="$PWD/$self" ;;
esac
selfdir="$(cd "$(dirname "$self")" 2>/dev/null && pwd -P)" || selfdir=''
[ -n "$selfdir" ] || fail "Claude Lens could not work out where it was launched from.

Rebuild the launcher: open Terminal, cd into the Claude Lens repository and run

    npm run launcher"
bundle="$(cd "$selfdir/../.." 2>/dev/null && pwd -P)" || bundle=''

# Classify a candidate directory. Prints exactly one of: ok | missing | denied | mismatch.
#
# 'denied' is a separate answer on purpose, and it was found the hard way. A double-clicked,
# unsigned app is allowed to *stat* files on an external or network volume but is refused
# permission to *read* them until the user grants access in System Settings. So "there is no
# repository here" and "the repository is here and macOS will not let me read it" are
# indistinguishable to any check built on '[ -f ]' alone — and they need opposite fixes.
# Telling the user to regenerate the launcher when the real problem is a privacy setting is
# the same class of failure as a plausible wrong number: confident, actionable, and wrong.
repo_status() {
  d="\${1:-}"
  [ -n "$d" ] && [ -e "$d/package.json" ] || { printf 'missing'; return; }
  /bin/cat "$d/package.json" >/dev/null 2>&1 || { printf 'denied'; return; }
  if /usr/bin/grep -q '"name"[[:space:]]*:[[:space:]]*"claude-lens"' "$d/package.json"; then
    printf 'ok'
  else
    printf 'mismatch'
  fi
}

repo=''
denied=''

# 1. Run time, from this file's own location: the bundle built in place sits beside the
#    repository it launches, so moving or renaming the whole checkout keeps working.
candidate="$(dirname "$bundle")"
status="$(repo_status "$candidate")"
if [ "$status" = 'ok' ]; then repo="$candidate"; fi
if [ "$status" = 'denied' ]; then denied="$candidate"; fi

# 2. Otherwise the location recorded when the bundle was generated. This is the path the
#    copy in /Applications uses, because it has no repository above it.
pointer="$bundle/Contents/Resources/${REPO_POINTER_NAME}"
recorded=''
if [ -z "$repo" ] && [ -f "$pointer" ]; then
  recorded="$(cat "$pointer" 2>/dev/null)"
  status="$(repo_status "$recorded")"
  if [ "$status" = 'ok' ]; then repo="$recorded"; fi
  if [ "$status" = 'denied' ] && [ -z "$denied" ]; then denied="$recorded"; fi
fi

if [ -z "$repo" ] && [ -n "$denied" ]; then
  fail "macOS is blocking Claude Lens from reading its own files.

The launcher found the repository at:
$denied

but the system refused to read it. This is a privacy permission, not a missing file, and it
is normal when the repository lives on an external disk, a network share or another user's
folder: an app you double-click has to be granted access to those explicitly, while the same
files opened from Terminal are already allowed.

To fix it, open System Settings, then Privacy & Security, and grant Claude Lens access under
'Files and Folders' — including 'Removable Volumes' if the repository is on an external disk.

If Claude Lens is not listed under 'Files and Folders', do not go looking for a '+' button:
that list has none. It only ever shows apps macOS has already been asked by. Use 'Full Disk
Access' instead — that list does have a '+'. Click it, choose Claude Lens (in Applications),
make sure its switch is on, then quit Claude Lens completely and open it again.

⚠️ This launcher was built WITHOUT a C compiler, so it is a shell script and has no code
identity for macOS to attach a permission to — the grant above may not stick. Install the
free Command Line Tools ('xcode-select --install') and run 'npm run launcher -- --install'
again to get the compiled launcher, which does.

Alternatively, move the repository onto the internal disk and run

    npm run launcher

again. Nothing is wrong with the installation."
fi

if [ -z "$repo" ]; then
  detail=''
  if [ -n "$recorded" ]; then
    detail="It last pointed at:
$recorded
"
  fi
  fail "Claude Lens cannot find its source repository.

This launcher does not contain the application. It starts the copy of Claude Lens that lives
in the folder it was generated from, and that folder has been moved, renamed or deleted.
$detail
To fix it: open Terminal, cd into the Claude Lens repository and run

    npm run launcher -- --install

which regenerates this launcher against the repository's current location."
fi

main="$repo/out/main/index.cjs"
if [ ! -f "$main" ]; then
  fail "Claude Lens has not been built yet.

The launcher found the repository at:
$repo

but there is no build output at out/main/index.cjs. The launcher starts a built app; it does
not build one, because a build can fail and this window cannot show you why.

To fix it: open Terminal, cd into that folder and run

    npm install
    npm run build"
fi

# ⚠️ Staleness. This launcher starts out/main/index.cjs — the BUILT output. Change a source
# file without rebuilding and the app opens perfectly and silently runs the previous build:
# nothing crashes, nothing looks wrong, and the numbers on screen came from yesterday's code.
# That is the failure this project exists to refuse (CLAUDE.md section 1).
#
# It DETECTS; it never builds. The reason the launcher does not build is unchanged and still
# right: a build can fail and this window cannot show you why. So the user is told, and chooses.
# Any failure to scan launches normally — an over-eager check that refuses to open the app is
# worse than the staleness it was added to catch.
stale=''
if [ -d "$repo/src" ]; then
  stale="$(/usr/bin/find "$repo/src" -type f -newer "$main" -print -quit 2>/dev/null)" || stale=''
fi
if [ -z "$stale" ] && [ "$repo/package.json" -nt "$main" ]; then
  stale="$repo/package.json"
fi

if [ -n "$stale" ]; then
  built_at="$(/usr/bin/stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$main" 2>/dev/null)" || built_at='an unknown time'
  changed_at="$(/usr/bin/stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$stale" 2>/dev/null)" || changed_at='an unknown time'
  confirm "Claude Lens is about to start an out-of-date build.

The source has changed since the app was last built:

    built    $built_at   out/main/index.cjs
    changed  $changed_at   $stale

The window will open and everything in it will look completely normal — but it will be
running the PREVIOUS build, not the code currently in the repository. That is exactly why
this is a dialog and not a log line.

To see your current code, open Terminal, cd into

$repo

and run

    npm run build          (or 'npm run check' to build and verify)

then open Claude Lens again.

'Open anyway' starts the older build. Wanting that is perfectly reasonable; getting it by
accident is not." || exit 0
fi

electron_rel='Electron.app/Contents/MacOS/Electron'
if [ -f "$repo/node_modules/electron/path.txt" ]; then
  read -r recorded < "$repo/node_modules/electron/path.txt" || true
  if [ -n "\${recorded:-}" ]; then electron_rel="$recorded"; fi
fi
electron="$repo/node_modules/electron/dist/$electron_rel"

if [ ! -x "$electron" ]; then
  fail "Claude Lens cannot find the Electron binary it runs on.

Expected it at:
$electron

Dependencies are missing or were installed for a different Electron version.

To fix it: open Terminal, cd into

$repo

and run

    npm install

then run 'npm run launcher' again if the Electron version changed."
fi

cd "$repo" || fail "Claude Lens could not enter its repository directory:

$repo"

exec "$electron" "$repo"

# Only reached if exec itself failed.
fail "Claude Lens could not start Electron.

The binary exists at

$electron

but the system refused to execute it. This usually means the download was interrupted or the
architecture does not match. Open Terminal, cd into

$repo

and run

    rm -rf node_modules && npm install"
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(message) {
  console.error(`\nmake-launcher: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
}

/** Like `run`, but never throws and hands back both streams — `codesign` reports on stderr. */
function tryRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.error === undefined && result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function requireTool(command) {
  try {
    run('/usr/bin/which', [command]);
  } catch {
    die(
      `'${command}' is not on PATH. The launcher is macOS-only and is built entirely from ` +
        'tools macOS ships (ADR-038: no packaging dependency is installed). There is no ' +
        'fallback, and inventing one would mean adding the dependency ADR-016 exists to refuse.',
    );
  }
}

/** XML text escaping for the four characters that matter inside a plist <string>. */
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * CFBundleVersion comes from package.json — the version is defined once (CLAUDE.md section 2:
 * cite, do not duplicate). A second copy in a plist is a second source of truth that drifts.
 */
function packageVersion() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    die('package.json has no "version"; CFBundleVersion has nowhere to come from.');
  }
  return pkg.version;
}

/**
 * LSMinimumSystemVersion is read from the Electron build this launcher actually starts,
 * rather than guessed, because that binary is what imposes the floor. Falls back only if
 * Electron is not installed yet.
 */
function minimumSystemVersion() {
  const plist = join(REPO_ROOT, 'node_modules/electron/dist/Electron.app/Contents/Info.plist');
  const fallback = '12.0';
  try {
    const text = readFileSync(plist, 'utf8');
    const match = /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
    return match ? match[1].trim() : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// The executable: compile resources/launcher.c, or fall back to the shell script.
//
// ⚠️ This is the whole point of the 2026-07-22 amendment to ADR-038. TCC attributes
// file-access permission to an executable's *code identity*; a script-backed bundle has
// none, so it can never be granted access to an external volume — it does not even get
// far enough to be listed in System Settings. A compiled Mach-O with an ad-hoc signature
// has a stable cdhash, which is exactly what TCC records a decision against.
// ---------------------------------------------------------------------------

/**
 * Compile `resources/launcher.c` straight into the bundle.
 *
 * Returns `{ compiler, arches }` on success, or `null` when no compiler on this machine
 * can build it — which is NOT an error. ADR-016's standing concern is that nothing here
 * creates a cold-clone failure mode; `npm run launcher` is opt-in and outside `npm run
 * check`, so a missing toolchain must degrade to the shell launcher, never fail.
 */
function compileLauncher({ srcPath, destPath, minimumSystem }) {
  if (!existsSync(srcPath)) {
    die(`the launcher source is missing: ${srcPath}. It is committed; restore it from git.`);
  }

  // Match the bundle's declared floor, so the x86_64 slice does not silently require the
  // SDK's current macOS. Skipped rather than guessed if the plist value is not a version.
  const minFlag = /^\d+(\.\d+)*$/.test(minimumSystem)
    ? [`-mmacosx-version-min=${minimumSystem}`]
    : [];
  const base = ['-O2', '-Wall', '-Wextra', '-g0', '-fno-common', ...minFlag];

  const attempts = [
    { arches: UNIVERSAL_ARCHES, flags: UNIVERSAL_ARCHES.flatMap((arch) => ['-arch', arch]) },
    { arches: [process.arch === 'x64' ? 'x86_64' : 'arm64'], flags: [] },
  ];

  const failures = [];
  for (const compiler of COMPILER_CANDIDATES) {
    for (const attempt of attempts) {
      rmSync(destPath, { force: true });
      const result = tryRun(compiler, [...base, ...attempt.flags, '-o', destPath, srcPath]);
      if (result.ok && existsSync(destPath)) {
        chmodSync(destPath, 0o755);
        return { compiler, arches: attempt.arches };
      }
      failures.push(
        `${compiler} ${attempt.arches.join('+')}: ${(result.stderr || 'no output').trim().split('\n')[0]}`,
      );
    }
  }

  rmSync(destPath, { force: true });
  return { failures };
}

const NO_COMPILER_WARNING = `
  ⚠️  NO C COMPILER — falling back to the shell-script launcher.

      The bundle still works. Double-clicking it starts Claude Lens exactly as the
      compiled launcher does, and every failure dialog is identical.

      What you lose is macOS code identity, and it is not cosmetic. TCC — the Privacy &
      Security permission system — attributes file access to an executable's code
      signature. A '#!/bin/bash' executable has none: the kernel execs /bin/bash, so the
      request is attributed to bash or is never well formed, and there is nothing for the
      system to remember. In practice: if this repository lives on an external disk, a
      network share or another user's folder, the double-clicked app will be refused read
      access AND WILL NEVER APPEAR in System Settings > Privacy & Security > Files and
      Folders. That list has no '+' button — it is populated only by apps that have
      already made a successful, attributable request. There is no way out of that from
      inside a script.

      To get the compiled, ad-hoc-signed launcher (free, no Apple Developer account):

          xcode-select --install
          npm run launcher

      This is a warning and not an error on purpose: a cold clone with no Xcode Command
      Line Tools must still get a working launcher (STACK ADR-016, DESIGN ADR-038).
`;

// ---------------------------------------------------------------------------
// Signing
//
// ⚠️ ORDER MATTERS: sign LAST, after Info.plist, the icon and the repo pointer are all in
// place. A bundle signature seals Contents/Resources and Info.plist into
// _CodeSignature/CodeResources; signing first would seal a bundle that no longer exists.
// ---------------------------------------------------------------------------

/**
 * Ad-hoc signature: `codesign -s -`. No certificate, no Apple Developer account, no
 * notarization, no network — ADR-016's "$99/yr" applies to shipping to *other people* and
 * none of it applies here. What this buys is a cdhash: a stable code identity TCC can
 * attribute a permission decision to and remember across launches.
 *
 * Never fatal. An unsigned bundle is worse, not broken — and on Apple silicon clang has
 * already linker-signed the Mach-O ad hoc, so it executes either way.
 */
function signBundle(appPath) {
  const signed = tryRun('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--identifier',
    BUNDLE_ID,
    '--timestamp=none',
    appPath,
  ]);
  if (!signed.ok) {
    return { ok: false, detail: (signed.stderr || signed.stdout).trim() };
  }

  // Verify rather than assume. `codesign -dv` writes its report to stderr.
  const shown = tryRun('/usr/bin/codesign', ['-dv', '--verbose=2', appPath]);
  const report = `${shown.stderr}${shown.stdout}`;
  const verified = tryRun('/usr/bin/codesign', ['--verify', '--strict', appPath]);
  const adhoc = /Signature\s*=\s*adhoc/i.test(report);

  return {
    ok: adhoc && verified.ok,
    adhoc,
    verified: verified.ok,
    detail: adhoc && verified.ok ? '' : `${report}\n${verified.stderr}`.trim(),
  };
}

// ---------------------------------------------------------------------------
// Icon: resources/icon.svg -> .iconset -> .icns
// ---------------------------------------------------------------------------

/**
 * `sips` reads SVG directly on macOS 13+ (verified on 26.5), rasterising from the vector at
 * each requested size rather than resampling one big PNG — so the 16 px Dock render is a real
 * 16 px render. If a future macOS drops that, this fails loudly rather than shipping the
 * Electron atom; the documented fallback is `qlmanage -t`, which is not wired in because it
 * is not needed and an untested fallback is worse than none.
 */
function buildIcns(svgPath, workDir) {
  if (!existsSync(svgPath)) {
    die(`the source artwork is missing: ${svgPath}. It is committed; restore it from git.`);
  }
  requireTool('sips');
  requireTool('iconutil');

  const iconsetDir = join(workDir, `${ICON_BASENAME}.iconset`);
  const icnsPath = join(workDir, `${ICON_BASENAME}.icns`);
  rmSync(iconsetDir, { recursive: true, force: true });
  rmSync(icnsPath, { force: true });
  mkdirSync(iconsetDir, { recursive: true });

  const rendered = [];
  for (const size of ICONSET_SIZES) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const name = `${ICON_BASENAME}_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      const out = join(iconsetDir, name);
      try {
        run('sips', [
          '-s',
          'format',
          'png',
          '--resampleHeightWidth',
          String(pixels),
          String(pixels),
          svgPath,
          '--out',
          out,
        ]);
      } catch (error) {
        die(
          `sips could not rasterise ${svgPath} at ${pixels}px.\n` +
            "    A common cause is an XML comment containing '--', which the SVG parser " +
            'rejects outright.\n' +
            `    sips said: ${String(error.stderr ?? error.message).trim()}`,
        );
      }
      if (!existsSync(out)) die(`sips reported success but wrote nothing at ${out}.`);
      rendered.push(`${pixels}px`);
    }
  }

  try {
    run('iconutil', ['--convert', 'icns', '--output', icnsPath, iconsetDir]);
  } catch (error) {
    die(`iconutil could not build the .icns: ${String(error.stderr ?? error.message).trim()}`);
  }
  if (!existsSync(icnsPath)) die('iconutil reported success but wrote no .icns.');

  return { icnsPath, iconsetDir, rendered };
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

function infoPlist({ version, minimumSystem }) {
  // The DOCTYPE identifier below is Apple's standard plist DTD id. It is an identifier, not
  // a fetch: nothing in this repository resolves it (INV-15 is about egress, and there is
  // none here).
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>${xmlEscape(APP_NAME)}</string>
	<key>CFBundleExecutable</key>
	<string>${xmlEscape(EXEC_NAME)}</string>
	<key>CFBundleIconFile</key>
	<string>${xmlEscape(ICON_BASENAME)}</string>
	<key>CFBundleIdentifier</key>
	<string>${xmlEscape(BUNDLE_ID)}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>${xmlEscape(APP_NAME)}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${xmlEscape(version)}</string>
	<key>CFBundleSignature</key>
	<string>????</string>
	<key>CFBundleVersion</key>
	<string>${xmlEscape(version)}</string>
	<key>LSMinimumSystemVersion</key>
	<string>${xmlEscape(minimumSystem)}</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
`;
}

function buildBundle({ outDir, icnsPath, version, minimumSystem }) {
  const appPath = join(outDir, APP_DIR_NAME);
  const contents = join(appPath, 'Contents');
  const macos = join(contents, 'MacOS');
  const resources = join(contents, 'Resources');

  rmSync(appPath, { recursive: true, force: true });
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });

  writeFileSync(join(contents, 'Info.plist'), infoPlist({ version, minimumSystem }), 'utf8');
  writeFileSync(join(contents, 'PkgInfo'), 'APPL????', 'utf8');

  // The executable: compiled Mach-O when a compiler exists, shell script when not.
  const execPath = join(macos, EXEC_NAME);
  const compiled = compileLauncher({
    srcPath: join(REPO_ROOT, LAUNCHER_SOURCE_REL),
    destPath: execPath,
    minimumSystem,
  });
  if (compiled.failures !== undefined) {
    writeFileSync(execPath, LAUNCHER_SCRIPT, 'utf8');
    chmodSync(execPath, 0o755);
  }

  cpSync(icnsPath, join(resources, `${ICON_BASENAME}.icns`));

  // The one absolute path in the bundle, and it is deliberately NOT in the executable:
  // the launcher prefers self-relative resolution and reads this only when the bundle has
  // been copied away from the repository (the /Applications case). The bundle is gitignored,
  // so `npm run guard` never sees it — see the header.
  writeFileSync(join(resources, REPO_POINTER_NAME), `${REPO_ROOT}\n`, 'utf8');

  // Self-check, loudly: a malformed Info.plist produces an app that fails to launch with no
  // explanation at all, which is the exact failure mode this whole task exists to prevent.
  try {
    run('plutil', ['-lint', join(contents, 'Info.plist')]);
  } catch (error) {
    die(`the generated Info.plist is not valid: ${String(error.stdout ?? error.message).trim()}`);
  }

  // ⚠️ LAST, and only now: the signature seals Info.plist and everything under Resources.
  const signature = signBundle(appPath);

  return { appPath, compiled, signature };
}

function bundleSizeBytes(appPath) {
  const out = run('/usr/bin/du', ['-sk', appPath]);
  return Number.parseInt(out.trim().split(/\s+/)[0], 10) * 1024;
}

// ---------------------------------------------------------------------------
// --install: the only step that writes outside the repository.
// ---------------------------------------------------------------------------

function install(appPath) {
  const target = join(APPLICATIONS_DIR, APP_DIR_NAME);

  if (existsSync(target)) {
    // Refuse to delete something that is not ours. /Applications is the user's system.
    let identifier = '';
    try {
      identifier = run('/usr/bin/plutil', [
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        join(target, 'Contents/Info.plist'),
      ]).trim();
    } catch {
      identifier = '';
    }
    if (identifier !== BUNDLE_ID) {
      die(
        `${target} already exists and is not a Claude Lens launcher ` +
          `(CFBundleIdentifier ${identifier === '' ? 'unreadable' : identifier}, expected ` +
          `${BUNDLE_ID}). Refusing to replace it. Move it aside yourself if that is what you want.`,
      );
    }
    console.log(`  replacing the existing ${target} (same bundle identifier)`);
    try {
      rmSync(target, { recursive: true, force: true });
    } catch (error) {
      die(`could not remove ${target}: ${error.message}`);
    }
  }

  try {
    cpSync(appPath, target, { recursive: true });
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      die(
        `no permission to write ${APPLICATIONS_DIR}. Copy it in Finder instead — drag\n` +
          `    ${appPath}\n    into ${APPLICATIONS_DIR}.`,
      );
    }
    die(`could not copy the bundle into ${APPLICATIONS_DIR}: ${error.message}`);
  }

  return target;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const HELP = `
npm run launcher — build the macOS launcher for Claude Lens (DESIGN.md ADR-038)

  npm run launcher                 build "${APP_DIR_NAME}" beside package.json
  npm run launcher -- --install    ...and copy it into ${APPLICATIONS_DIR}
  npm run launcher -- --out DIR    build into DIR instead of the repository root
  npm run launcher -- --help       this text

The bundle is a build output: gitignored, ~200 KB, containing no application code. It starts
this repository's Electron binary against this repository's out/ directory. Its executable is
compiled from ${LAUNCHER_SOURCE_REL} and AD-HOC signed (codesign -s -) so that macOS TCC has a
code identity to attach a Files-and-Folders permission to; with no compiler present it falls
back to a shell script, which works but can never hold that permission.

It is still not a distributable artifact: no certificate, no Apple Developer account, no
notarization, no .dmg, no store (STACK ADR-016, as amended by DESIGN.md ADR-038).

--install is opt-in on purpose: it writes into ${APPLICATIONS_DIR}, which is outside the
repository and part of the user's system. A bare invocation never touches it.
`;

function parseArgs(argv) {
  const options = { install: false, outDir: REPO_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--install') options.install = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) die('--out needs a directory.');
      options.outDir = resolve(value);
      i += 1;
    } else die(`unknown argument '${arg}'. Try --help.`);
  }
  return options;
}

function main() {
  if (process.platform !== 'darwin') {
    die(
      'the launcher is macOS-only, like the application (STACK ADR-016, PRD OQ-106). ' +
        'There is no Windows or Linux bundle and none is claimed.',
    );
  }

  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  mkdirSync(options.outDir, { recursive: true });
  const workDir = join(options.outDir, '.claude-lens-icon');
  mkdirSync(workDir, { recursive: true });

  const version = packageVersion();
  const minimumSystem = minimumSystemVersion();

  const { icnsPath, iconsetDir, rendered } = buildIcns(
    join(REPO_ROOT, 'resources/icon.svg'),
    workDir,
  );
  const { appPath, compiled, signature } = buildBundle({
    outDir: options.outDir,
    icnsPath,
    version,
    minimumSystem,
  });

  console.log(`\nmake-launcher: built ${appPath}`);
  console.log(`  version ${version} · LSMinimumSystemVersion ${minimumSystem}`);
  console.log(`  icon    ${rendered.join(' ')} -> ${iconsetDir} -> ${statSync(icnsPath).size} B`);

  if (compiled.failures === undefined) {
    const universal = compiled.arches.length > 1;
    console.log(
      `  exec    Mach-O ${compiled.arches.join(' + ')}${universal ? ' (universal)' : ''} ` +
        `from ${LAUNCHER_SOURCE_REL} via ${compiled.compiler}`,
    );
    if (!universal) {
      console.log(
        '          note: only the native slice built cleanly, so this bundle is not universal.',
      );
    }
  } else {
    console.log('  exec    /bin/bash script (fallback — no compiler)');
  }

  if (signature.ok && compiled.failures === undefined) {
    console.log('  signed  ad-hoc (codesign -s -) · verified · TCC has a code identity to bind to');
  } else if (signature.ok) {
    // Honest about a half-measure: codesign will happily seal a script-backed bundle, but
    // the kernel execs /bin/bash, so there is still no executable code identity for TCC to
    // attribute a file-access decision to. Saying "signed" and stopping there would be the
    // reassuring-but-wrong answer this project exists to avoid.
    console.log(
      '  signed  ad-hoc, but the executable is a script — the bundle is sealed and the\n' +
        '          executable still has no code identity. See the warning below.',
    );
  } else {
    console.log(
      `  signed  ⚠️  NOT ad-hoc signed. macOS cannot attribute a Privacy & Security\n` +
        `          permission to this bundle, so it may be unable to read a repository on an\n` +
        `          external or network volume. codesign said: ${signature.detail || '(nothing)'}`,
    );
  }

  console.log(`  size    ${(bundleSizeBytes(appPath) / 1024).toFixed(0)} KB`);

  if (compiled.failures !== undefined) {
    console.log(NO_COMPILER_WARNING);
    console.log('      What was tried:');
    for (const failure of compiled.failures) console.log(`        ${failure}`);
    console.log('');
  }

  if (!existsSync(join(REPO_ROOT, 'out/main/index.cjs'))) {
    console.log(
      "\n  note: out/main/index.cjs does not exist yet, so the launcher will open a dialog\n        saying so. Run 'npm run build' first.",
    );
  }

  if (options.install) {
    console.log(`\n  --install: copying into ${APPLICATIONS_DIR} (this writes outside the repo)`);
    const target = install(appPath);
    console.log(`  installed ${target}`);
    console.log(
      '  it starts this repository, so it stops working if the repository moves;\n' +
        "  rerun 'npm run launcher -- --install' if it does.",
    );
  } else {
    console.log(
      `\n  double-click it, or run 'npm run launcher -- --install' to copy it into ${APPLICATIONS_DIR}.`,
    );
  }
  console.log('');
}

main();
