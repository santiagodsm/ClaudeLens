/*
 * Claude Lens launcher — the executable inside `Claude Lens.app/Contents/MacOS/`.
 * DESIGN.md ADR-038 (AMENDED 2026-07-22). Compiled by `scripts/make-launcher.mjs`.
 *
 * This file contains NO application code and NO absolute path to any repository. It
 * resolves the Claude Lens repository at RUN TIME — from its own location in the
 * filesystem, or from the one-line pointer the generator wrote into the bundle — and
 * execs that repository's own Electron binary against its build output. The app lives
 * in the repository, not in here (P-33: no absolute path may be baked into a committed
 * file, and this file is committed).
 *
 * ⚠️ WHY THIS IS C AND NOT A SHELL SCRIPT — the whole reason this file exists.
 *
 * Until 2026-07-22 this was a `#!/bin/bash` script. It worked, and it failed in exactly
 * one way that could not be fixed from inside a script: macOS TCC (the Privacy & Security
 * permission system) attributes file access to an *executable's code identity* — its code
 * signature. A bundle whose CFBundleExecutable is a script has none: the kernel execs
 * /bin/bash, and the access request is either attributed to bash or never well formed.
 * An unsigned, script-backed bundle therefore has nothing for TCC to remember, which is
 * why it never prompted, never appeared under Privacy & Security → Files and Folders
 * (that list has no "+" button — it is populated only by apps that have already made a
 * successful, attributable request), and could not be granted access to an external
 * volume at all. A compiled Mach-O, ad-hoc signed with `codesign -s -`, has a stable
 * code identity (its cdhash) that TCC can attribute a decision to and remember.
 *
 * ⚠️ EVERY BEHAVIOUR OF THE SHELL VERSION IS PRESERVED HERE, DELIBERATELY:
 *   - the ok / missing / denied / mismatch classification of a candidate directory,
 *     including the read-not-stat probe that is the only way to tell "no repository
 *     here" apart from "the repository is here and macOS will not let me read it";
 *   - all five failure dialogs, with the same wording the tests assert on;
 *   - CLAUDE_LENS_LAUNCHER_NO_DIALOG suppression;
 *   - TTY suppression (no dialog when stderr is a terminal — someone is watching).
 *
 * Failing loudly is the load-bearing behaviour. A launcher that bounces once in the Dock
 * and dies is the desktop equivalent of a silently wrong number (CLAUDE.md §1): no
 * information, no way to act, and — unlike a terminal — nowhere for a log line to go.
 * Every failure path below ends in a native dialog naming what happened and the exact
 * command that fixes it, and exits non-zero.
 *
 * Built with: clang -O2 -Wall -Wextra (no libraries beyond libSystem, no dependency).
 */

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define TITLE "Claude Lens"

/* Long enough for the longest dialog below plus two PATH_MAX paths. */
#define MSG_MAX 8192

/* Bounds on the staleness scan. It walks src/ and nothing else; these stop a symlink
 * loop or a surprise directory from turning a launch into a filesystem crawl. */
#define SCAN_MAX_DEPTH 8
#define SCAN_MAX_ENTRIES 20000

/* ------------------------------------------------------------------------- */
/* Failing loudly                                                            */
/* ------------------------------------------------------------------------- */

/*
 * A native dialog via osascript. Deliberately a separate process: this launcher links
 * nothing but libSystem, and putting AppKit in a 40 KB shim to draw one alert would be
 * a dependency in all but name.
 */
static void show_dialog(const char *message) {
  pid_t pid = fork();
  if (pid < 0) {
    return; /* No dialog is still better than hanging. stderr already has the text. */
  }
  if (pid == 0) {
    int devnull = open("/dev/null", O_RDWR);
    if (devnull >= 0) {
      (void)dup2(devnull, STDOUT_FILENO);
      (void)dup2(devnull, STDERR_FILENO);
      if (devnull > STDERR_FILENO) {
        (void)close(devnull);
      }
    }
    char *const argv[] = {
        (char *)"osascript",
        (char *)"-e",
        (char *)"on run argv",
        (char *)"-e",
        (char *)"display dialog (item 1 of argv) with title (item 2 of argv) "
                "buttons {\"OK\"} default button \"OK\" with icon stop",
        (char *)"-e",
        (char *)"end run",
        (char *)"--",
        (char *)message,
        (char *)TITLE,
        NULL,
    };
    (void)execv("/usr/bin/osascript", argv);
    _exit(127);
  }
  int status = 0;
  (void)waitpid(pid, &status, 0);
}

/*
 * Suppressed when CLAUDE_LENS_LAUNCHER_NO_DIALOG is set (how the test suite exercises
 * every failure path without a window server — STACK ADR-018's boundary: nothing in
 * `npm run check` opens a GUI) and when stderr is a terminal (someone is debugging from
 * a shell and can read the text there).
 */
__attribute__((noreturn)) static void fail(const char *message) {
  (void)fprintf(stderr, "%s\n", message);
  (void)fflush(stderr);
  const char *quiet = getenv("CLAUDE_LENS_LAUNCHER_NO_DIALOG");
  if ((quiet == NULL || quiet[0] == '\0') && !isatty(STDERR_FILENO)) {
    show_dialog(message);
  }
  exit(1);
}

/*
 * A two-button question, and the one place this launcher does NOT simply exit. Returns 1
 * to proceed, 0 to cancel.
 *
 * The answer is read back over a pipe rather than inferred from osascript's exit status,
 * because "the user clicked Cancel" and "osascript could not run" both surface as exit 1
 * and they mean opposite things. If osascript could not be started at all (exit 127) this
 * returns 1: a check that cannot ask its question must not silently refuse to open the app.
 */
static int ask_open_anyway(const char *message) {
  int fds[2];
  if (pipe(fds) != 0) {
    return 1;
  }
  pid_t pid = fork();
  if (pid < 0) {
    (void)close(fds[0]);
    (void)close(fds[1]);
    return 1;
  }
  if (pid == 0) {
    (void)close(fds[0]);
    (void)dup2(fds[1], STDOUT_FILENO);
    if (fds[1] > STDERR_FILENO) {
      (void)close(fds[1]);
    }
    int devnull = open("/dev/null", O_RDWR);
    if (devnull >= 0) {
      (void)dup2(devnull, STDERR_FILENO);
      if (devnull > STDERR_FILENO) {
        (void)close(devnull);
      }
    }
    char *const argv[] = {
        (char *)"osascript",
        (char *)"-e",
        (char *)"on run argv",
        (char *)"-e",
        (char *)"display dialog (item 1 of argv) with title (item 2 of argv) "
                "buttons {\"Cancel\", \"Open anyway\"} default button \"Open anyway\" "
                "with icon caution",
        (char *)"-e",
        (char *)"return button returned of result",
        (char *)"-e",
        (char *)"end run",
        (char *)"--",
        (char *)message,
        (char *)TITLE,
        NULL,
    };
    (void)execv("/usr/bin/osascript", argv);
    _exit(127);
  }

  (void)close(fds[1]);
  char answer[256];
  size_t used = 0;
  ssize_t got;
  while (used < sizeof answer - 1 &&
         (got = read(fds[0], answer + used, sizeof answer - 1 - used)) > 0) {
    used += (size_t)got;
  }
  answer[used] = '\0';
  (void)close(fds[0]);

  int status = 0;
  (void)waitpid(pid, &status, 0);
  if (WIFEXITED(status) && WEXITSTATUS(status) == 127) {
    return 1; /* Could not ask. Do not block. */
  }
  return strstr(answer, "Open anyway") != NULL ? 1 : 0;
}

/* ------------------------------------------------------------------------- */
/* Paths                                                                      */
/* ------------------------------------------------------------------------- */

/** The directory containing `path`. Pure string work, like dirname(1). */
static int parent_of(const char *path, char *out, size_t cap) {
  const char *slash = strrchr(path, '/');
  if (slash == NULL) {
    if (cap < 2) {
      return 0;
    }
    out[0] = '.';
    out[1] = '\0';
    return 1;
  }
  size_t len = (size_t)(slash - path);
  if (len == 0) {
    len = 1; /* "/foo" -> "/" */
  }
  if (len >= cap) {
    return 0;
  }
  memcpy(out, path, len);
  out[len] = '\0';
  return 1;
}

/**
 * This executable's own fully resolved location — the C equivalent of the shell
 * version's `cd "$(dirname "$0")" && pwd -P`. realpath() resolves symlinks, so a
 * symlinked bundle still finds the repository beside the real one.
 */
static int self_path(char *out, size_t cap) {
  char raw[PATH_MAX];
  uint32_t size = (uint32_t)sizeof raw;
  if (_NSGetExecutablePath(raw, &size) != 0) {
    return 0;
  }
  char resolved[PATH_MAX];
  if (realpath(raw, resolved) == NULL) {
    return 0;
  }
  size_t len = strlen(resolved);
  if (len == 0 || len >= cap) {
    return 0;
  }
  memcpy(out, resolved, len + 1);
  return 1;
}

/** First line of a file, trailing whitespace stripped. 0 if unreadable or empty. */
static int read_first_line(const char *path, char *out, size_t cap) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    return 0;
  }
  char buf[PATH_MAX + 2];
  ssize_t got = read(fd, buf, sizeof buf - 1);
  (void)close(fd);
  if (got <= 0) {
    return 0;
  }
  buf[got] = '\0';
  char *newline = strchr(buf, '\n');
  if (newline != NULL) {
    *newline = '\0';
  }
  size_t len = strlen(buf);
  while (len > 0 && (unsigned char)buf[len - 1] <= ' ') {
    buf[--len] = '\0';
  }
  if (len == 0 || len >= cap) {
    return 0;
  }
  memcpy(out, buf, len + 1);
  return 1;
}

/* ------------------------------------------------------------------------- */
/* Is this directory the Claude Lens repository?                              */
/* ------------------------------------------------------------------------- */

typedef enum { REPO_OK, REPO_MISSING, REPO_DENIED, REPO_MISMATCH } repo_status_t;

/** The shell version's `grep -q '"name"[[:space:]]*:[[:space:]]*"claude-lens"'`. */
static int declares_claude_lens(const char *text) {
  const char *cursor = text;
  const char *key = "\"name\"";
  const size_t key_len = 6;
  while ((cursor = strstr(cursor, key)) != NULL) {
    const char *probe = cursor + key_len;
    while (*probe != '\0' && isspace((unsigned char)*probe)) {
      probe++;
    }
    if (*probe == ':') {
      probe++;
      while (*probe != '\0' && isspace((unsigned char)*probe)) {
        probe++;
      }
      if (strncmp(probe, "\"claude-lens\"", 13) == 0) {
        return 1;
      }
    }
    cursor += key_len;
  }
  return 0;
}

/*
 * ⚠️ 'denied' is a separate answer on purpose, and it was found the hard way — twice.
 *
 * A double-clicked app is allowed to *stat* files on an external, network or
 * other-user volume but is refused permission to *read* them until the user grants
 * access. So "there is no repository here" and "the repository is here and macOS will
 * not let me read it" are indistinguishable to any check built on stat() alone — and
 * they need opposite fixes. Telling the user to regenerate their launcher when the real
 * problem is a privacy setting is the same class of failure as a plausible wrong number:
 * confident, actionable, and wrong. Only an actual read() can tell them apart.
 */
static repo_status_t repo_status(const char *dir) {
  if (dir == NULL || dir[0] == '\0') {
    return REPO_MISSING;
  }
  char path[PATH_MAX];
  int written = snprintf(path, sizeof path, "%s/package.json", dir);
  if (written < 0 || (size_t)written >= sizeof path) {
    return REPO_MISSING;
  }

  struct stat info;
  if (stat(path, &info) != 0) {
    /* A refusal at stat() is still a refusal, not an absence. */
    return (errno == EACCES || errno == EPERM) ? REPO_DENIED : REPO_MISSING;
  }

  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    return REPO_DENIED;
  }
  char buf[65536];
  ssize_t got = read(fd, buf, sizeof buf - 1);
  (void)close(fd);
  if (got < 0) {
    return REPO_DENIED;
  }
  buf[got] = '\0';
  return declares_claude_lens(buf) ? REPO_OK : REPO_MISMATCH;
}

/* ------------------------------------------------------------------------- */
/* Is the build older than the source it was built from?                      */
/*                                                                            */
/* ⚠️ This launcher starts `out/main/index.cjs` — the BUILT output. Change a  */
/* source file without rebuilding and the app opens perfectly and silently    */
/* runs the previous build. Nothing crashes, nothing looks wrong, and the     */
/* numbers on screen are computed by yesterday's code. That is precisely the  */
/* failure this project exists to refuse (CLAUDE.md §1), and the person most  */
/* exposed to it is whoever is actively developing the repository.            */
/*                                                                            */
/* ⚠️ It DETECTS; it never builds. The reasoning that kept `npm run build`    */
/* out of the launcher is unchanged and still right: a build can fail, and    */
/* this window cannot show you why. So the user is told, and chooses.         */
/*                                                                            */
/* And it never blocks on its own uncertainty: any failure to scan — an       */
/* unreadable directory, a missing src/, a budget or depth cap — launches     */
/* normally. An over-eager staleness check that refuses to open the app is    */
/* worse than the staleness it was added to catch.                            */
/* ------------------------------------------------------------------------- */

typedef struct {
  time_t sec;
  long nsec;
} file_time_t;

static int is_newer(file_time_t a, file_time_t b) {
  return a.sec > b.sec || (a.sec == b.sec && a.nsec > b.nsec);
}

static file_time_t modified_at(const struct stat *info) {
  file_time_t when;
  when.sec = info->st_mtimespec.tv_sec;
  when.nsec = info->st_mtimespec.tv_nsec;
  return when;
}

static void format_time(file_time_t when, char *out, size_t cap) {
  struct tm parts;
  if (localtime_r(&when.sec, &parts) == NULL ||
      strftime(out, cap, "%Y-%m-%d %H:%M:%S", &parts) == 0) {
    (void)snprintf(out, cap, "an unknown time");
  }
}

/**
 * Newest mtime under `dir`, and the path that carries it. Returns 0 if the scan could
 * not be completed, in which case the caller must not draw any conclusion.
 *
 * Deliberately narrow: it is pointed at `src/` only. `node_modules` and dot-directories
 * are skipped, symlinks are not followed (lstat, and only real directories recursed),
 * and both depth and total entries are capped. A launcher is not a build system.
 */
static int scan_newest(const char *dir, int depth, file_time_t *newest, char *witness,
                       size_t witness_cap, int *budget) {
  if (depth > SCAN_MAX_DEPTH) {
    return 0;
  }
  DIR *handle = opendir(dir);
  if (handle == NULL) {
    return 0;
  }

  int complete = 1;
  struct dirent *entry;
  while ((entry = readdir(handle)) != NULL) {
    if (entry->d_name[0] == '.' || strcmp(entry->d_name, "node_modules") == 0) {
      continue;
    }
    if (--(*budget) <= 0) {
      complete = 0;
      break;
    }

    char child[PATH_MAX];
    int written = snprintf(child, sizeof child, "%s/%s", dir, entry->d_name);
    if (written < 0 || (size_t)written >= sizeof child) {
      complete = 0;
      break;
    }

    struct stat info;
    if (lstat(child, &info) != 0) {
      complete = 0;
      break;
    }

    if (S_ISDIR(info.st_mode)) {
      if (!scan_newest(child, depth + 1, newest, witness, witness_cap, budget)) {
        complete = 0;
        break;
      }
    } else if (S_ISREG(info.st_mode)) {
      file_time_t when = modified_at(&info);
      if (is_newer(when, *newest)) {
        *newest = when;
        (void)snprintf(witness, witness_cap, "%s", child);
      }
    }
  }

  (void)closedir(handle);
  return complete;
}

/* ------------------------------------------------------------------------- */
/* main                                                                       */
/* ------------------------------------------------------------------------- */

int main(void) {
  static char message[MSG_MAX];

  char self[PATH_MAX];
  if (!self_path(self, sizeof self)) {
    fail("Claude Lens could not work out where it was launched from.\n"
         "\n"
         "Rebuild the launcher: open Terminal, cd into the Claude Lens repository and run\n"
         "\n"
         "    npm run launcher");
  }

  /* self = <app>/Contents/MacOS/claude-lens  ->  bundle = <app> */
  char macos_dir[PATH_MAX];
  char contents_dir[PATH_MAX];
  char bundle[PATH_MAX];
  if (!parent_of(self, macos_dir, sizeof macos_dir) ||
      !parent_of(macos_dir, contents_dir, sizeof contents_dir) ||
      !parent_of(contents_dir, bundle, sizeof bundle)) {
    fail("Claude Lens could not work out where it was launched from.\n"
         "\n"
         "Rebuild the launcher: open Terminal, cd into the Claude Lens repository and run\n"
         "\n"
         "    npm run launcher");
  }

  char repo[PATH_MAX];
  char denied[PATH_MAX];
  char recorded[PATH_MAX];
  repo[0] = '\0';
  denied[0] = '\0';
  recorded[0] = '\0';

  /*
   * 1. Run time, from this file's own location: the bundle built in place sits beside
   *    the repository it launches, so moving or renaming the whole checkout keeps
   *    working. No path is baked in anywhere (P-33).
   */
  char candidate[PATH_MAX];
  if (parent_of(bundle, candidate, sizeof candidate)) {
    switch (repo_status(candidate)) {
      case REPO_OK:
        (void)snprintf(repo, sizeof repo, "%s", candidate);
        break;
      case REPO_DENIED:
        (void)snprintf(denied, sizeof denied, "%s", candidate);
        break;
      default:
        break;
    }
  }

  /*
   * 2. Otherwise the location recorded when the bundle was generated. This is the path
   *    the copy in /Applications uses, because it has no repository above it. It lives
   *    in the bundle (a build output), never in a committed file.
   */
  if (repo[0] == '\0') {
    char pointer[PATH_MAX];
    int written = snprintf(pointer, sizeof pointer, "%s/Contents/Resources/repo-root", bundle);
    if (written > 0 && (size_t)written < sizeof pointer &&
        read_first_line(pointer, recorded, sizeof recorded)) {
      switch (repo_status(recorded)) {
        case REPO_OK:
          (void)snprintf(repo, sizeof repo, "%s", recorded);
          break;
        case REPO_DENIED:
          if (denied[0] == '\0') {
            (void)snprintf(denied, sizeof denied, "%s", recorded);
          }
          break;
        default:
          break;
      }
    }
  }

  if (repo[0] == '\0' && denied[0] != '\0') {
    (void)snprintf(
        message, sizeof message,
        "macOS is blocking Claude Lens from reading its own files.\n"
        "\n"
        "The launcher found the repository at:\n"
        "%s\n"
        "\n"
        "but the system refused to read it. This is a privacy permission, not a missing file, "
        "and it\n"
        "is normal when the repository lives on an external disk, a network share or another "
        "user's\n"
        "folder: an app you double-click has to be granted access to those explicitly, while the "
        "same\n"
        "files opened from Terminal are already allowed.\n"
        "\n"
        "To fix it, open System Settings, then Privacy & Security, and grant Claude Lens access "
        "under\n"
        "'Files and Folders' — including 'Removable Volumes' if the repository is on an external "
        "disk.\n"
        "\n"
        "If Claude Lens is not listed under 'Files and Folders', do not go looking for a '+' "
        "button:\n"
        "that list has none. It only ever shows apps macOS has already been asked by. Use 'Full "
        "Disk\n"
        "Access' instead — that list does have a '+'. Click it, choose Claude Lens (in "
        "Applications),\n"
        "make sure its switch is on, then quit Claude Lens completely and open it again; the "
        "grant\n"
        "is only picked up on a fresh launch.\n"
        "\n"
        "Alternatively, move the repository onto the internal disk and run\n"
        "\n"
        "    npm run launcher\n"
        "\n"
        "again. Nothing is wrong with the installation.",
        denied);
    fail(message);
  }

  if (repo[0] == '\0') {
    char detail[PATH_MAX + 32];
    detail[0] = '\0';
    if (recorded[0] != '\0') {
      (void)snprintf(detail, sizeof detail, "It last pointed at:\n%s\n", recorded);
    }
    (void)snprintf(
        message, sizeof message,
        "Claude Lens cannot find its source repository.\n"
        "\n"
        "This launcher does not contain the application. It starts the copy of Claude Lens that "
        "lives\n"
        "in the folder it was generated from, and that folder has been moved, renamed or "
        "deleted.\n"
        "%s"
        "\n"
        "To fix it: open Terminal, cd into the Claude Lens repository and run\n"
        "\n"
        "    npm run launcher -- --install\n"
        "\n"
        "which regenerates this launcher against the repository's current location.",
        detail);
    fail(message);
  }

  char main_bundle[PATH_MAX];
  int written = snprintf(main_bundle, sizeof main_bundle, "%s/out/main/index.cjs", repo);
  struct stat info;
  if (written < 0 || (size_t)written >= sizeof main_bundle || stat(main_bundle, &info) != 0 ||
      !S_ISREG(info.st_mode)) {
    (void)snprintf(
        message, sizeof message,
        "Claude Lens has not been built yet.\n"
        "\n"
        "The launcher found the repository at:\n"
        "%s\n"
        "\n"
        "but there is no build output at out/main/index.cjs. The launcher starts a built app; it "
        "does\n"
        "not build one, because a build can fail and this window cannot show you why.\n"
        "\n"
        "To fix it: open Terminal, cd into that folder and run\n"
        "\n"
        "    npm install\n"
        "    npm run build",
        repo);
    fail(message);
  }

  /*
   * Staleness. Not an error and never fatal on its own — see the block comment above.
   */
  file_time_t built = modified_at(&info);
  file_time_t newest = {0, 0};
  char witness[PATH_MAX];
  witness[0] = '\0';
  int budget = SCAN_MAX_ENTRIES;
  int scanned = 1;

  char src_dir[PATH_MAX];
  written = snprintf(src_dir, sizeof src_dir, "%s/src", repo);
  if (written < 0 || (size_t)written >= sizeof src_dir ||
      !scan_newest(src_dir, 0, &newest, witness, sizeof witness, &budget)) {
    scanned = 0;
  }

  /* package.json too: a dependency or version change is a source change. */
  if (scanned) {
    char manifest[PATH_MAX];
    struct stat manifest_info;
    written = snprintf(manifest, sizeof manifest, "%s/package.json", repo);
    if (written > 0 && (size_t)written < sizeof manifest && stat(manifest, &manifest_info) == 0) {
      file_time_t when = modified_at(&manifest_info);
      if (is_newer(when, newest)) {
        newest = when;
        (void)snprintf(witness, sizeof witness, "%s", manifest);
      }
    }
  }

  if (scanned && witness[0] != '\0' && is_newer(newest, built)) {
    char built_at[64];
    char changed_at[64];
    format_time(built, built_at, sizeof built_at);
    format_time(newest, changed_at, sizeof changed_at);

    (void)snprintf(
        message, sizeof message,
        "Claude Lens is about to start an out-of-date build.\n"
        "\n"
        "The source has changed since the app was last built:\n"
        "\n"
        "    built    %s   out/main/index.cjs\n"
        "    changed  %s   %s\n"
        "\n"
        "The window will open and everything in it will look completely normal — but it will "
        "be\n"
        "running the PREVIOUS build, not the code currently in the repository. That is exactly "
        "why\n"
        "this is a dialog and not a log line.\n"
        "\n"
        "To see your current code, open Terminal, cd into\n"
        "\n"
        "%s\n"
        "\n"
        "and run\n"
        "\n"
        "    npm run build          (or 'npm run check' to build and verify)\n"
        "\n"
        "then open Claude Lens again.\n"
        "\n"
        "'Open anyway' starts the older build. Wanting that is perfectly reasonable; getting it "
        "by\n"
        "accident is not.",
        built_at, changed_at, witness, repo);

    const char *quiet = getenv("CLAUDE_LENS_LAUNCHER_NO_DIALOG");
    if ((quiet != NULL && quiet[0] != '\0') || isatty(STDERR_FILENO)) {
      /* Same suppression as every other path: say it on stderr and carry on. */
      (void)fprintf(stderr, "%s\n", message);
      (void)fflush(stderr);
    } else if (!ask_open_anyway(message)) {
      exit(0); /* The user chose to go and build. That is not a failure. */
    }
  }

  /*
   * Electron records its own binary's location inside its npm package, so an Electron
   * version that moves it does not silently become "cannot find Electron".
   */
  char electron_rel[PATH_MAX];
  (void)snprintf(electron_rel, sizeof electron_rel, "Electron.app/Contents/MacOS/Electron");
  char path_txt[PATH_MAX];
  written = snprintf(path_txt, sizeof path_txt, "%s/node_modules/electron/path.txt", repo);
  if (written > 0 && (size_t)written < sizeof path_txt) {
    char from_file[PATH_MAX];
    if (read_first_line(path_txt, from_file, sizeof from_file)) {
      (void)snprintf(electron_rel, sizeof electron_rel, "%s", from_file);
    }
  }

  char electron[PATH_MAX];
  written =
      snprintf(electron, sizeof electron, "%s/node_modules/electron/dist/%s", repo, electron_rel);
  if (written < 0 || (size_t)written >= sizeof electron || access(electron, X_OK) != 0) {
    (void)snprintf(message, sizeof message,
                   "Claude Lens cannot find the Electron binary it runs on.\n"
                   "\n"
                   "Expected it at:\n"
                   "%s\n"
                   "\n"
                   "Dependencies are missing or were installed for a different Electron version.\n"
                   "\n"
                   "To fix it: open Terminal, cd into\n"
                   "\n"
                   "%s\n"
                   "\n"
                   "and run\n"
                   "\n"
                   "    npm install\n"
                   "\n"
                   "then run 'npm run launcher' again if the Electron version changed.",
                   electron, repo);
    fail(message);
  }

  if (chdir(repo) != 0) {
    (void)snprintf(message, sizeof message,
                   "Claude Lens could not enter its repository directory:\n"
                   "\n"
                   "%s",
                   repo);
    fail(message);
  }

  char *const argv[] = {electron, repo, NULL};
  (void)execv(electron, argv);

  /* Only reached if exec itself failed. */
  (void)snprintf(message, sizeof message,
                 "Claude Lens could not start Electron.\n"
                 "\n"
                 "The binary exists at\n"
                 "\n"
                 "%s\n"
                 "\n"
                 "but the system refused to execute it. This usually means the download was "
                 "interrupted or the\n"
                 "architecture does not match. Open Terminal, cd into\n"
                 "\n"
                 "%s\n"
                 "\n"
                 "and run\n"
                 "\n"
                 "    rm -rf node_modules && npm install",
                 electron, repo);
  fail(message);
}
