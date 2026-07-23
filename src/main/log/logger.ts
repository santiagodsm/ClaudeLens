// The main-process log. DESIGN §7.3.
//
//   app.getPath('logs')/claude-lens.log, rotated at 5 MB × 3 files, containing timestamps,
//   error codes and stack traces.
//
// ⚠️ **Logs never contain prompt text, file contents, or the absolute Claude data directory
// path** — the last is written as `<claudeDir>`. The reason is not tidiness: the most likely
// way a log leaves this machine is a user pasting it into a public issue.
//
// ⚠️ **That rule is enforced in the writer, not by asking callers to remember it.** Two
// mechanisms, both structural:
//
//   1. **There is no channel for a record body.** The public API takes a one-sentence message,
//      an optional §4.1 `ErrorCode`, an optional developer `detail` (a stack), and scalar
//      fields. There is no `content`, no `line`, no `text` parameter for a caller to reach
//      for, so passing a transcript line is not a mistake that is available to make.
//   2. **Every string this file writes passes through `redact()`**, which replaces the
//      configured `claudeDir` with `<claudeDir>` and the real home directory with `<home>`,
//      and truncates. A stack trace that happens to embed a transcript path is redacted by
//      the same pass as an explicitly logged one — there is no way to write around it.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ErrorCode } from '../../shared/ipc-contract';
import { LOG_FILE_NAME } from '../config/paths';

/** §7.3 — "rotated at 5 MB × 3 files". */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** §7.3 — three files total: `claude-lens.log`, `claude-lens.log.1`, `claude-lens.log.2`. */
export const LOG_MAX_FILES = 3;

/** A single redacted field is capped so a leaked blob cannot land whole. */
export const LOG_MAX_FIELD_CHARS = 2_000;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The token an absolute Claude data directory is written as. Never the path itself (§7.3). */
export const CLAUDE_DIR_TOKEN = '<claudeDir>';

/** The token the real home directory is written as. */
export const HOME_TOKEN = '<home>';

/** Scalars only. There is deliberately no way to attach an object, a buffer or a line body. */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface LogEntry {
  readonly level: LogLevel;
  /** One sentence. The same sentence a user would see (§4.1), never a stack trace. */
  readonly message: string;
  /** §4.1's closed enum, when the entry describes a failure. */
  readonly code?: ErrorCode;
  /** Developer detail — a stack trace. Redacted and truncated like everything else. */
  readonly detail?: string;
  readonly fields?: LogFields;
}

export interface LoggerOptions {
  /** `app.getPath('logs')/claude-lens.log` (§9.3). Always injected; never resolved here. */
  readonly filePath: string;
  /** The real home directory, injected so this module never calls `os.homedir()` (INV-17). */
  readonly homeDir?: string | null;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  /** Injected clock — nothing in this build reads a clock it did not receive (ADR-021). */
  readonly now?: () => number;
  /**
   * Test seam. Production passes nothing and the entry is appended to `filePath`; a test can
   * capture lines without a directory. Redaction happens BEFORE this is called, so a sink
   * cannot see an unredacted string either.
   */
  readonly sink?: (line: string) => void;
}

/**
 * The §7.3 logger. One instance per process, created by `src/main/index.ts` and handed to
 * everything that needs it — nothing imports a module-level singleton, because a singleton
 * would have to resolve its own path and INV-17 forbids that.
 */
export class Logger {
  readonly #filePath: string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #now: () => number;
  readonly #sink: ((line: string) => void) | undefined;
  readonly #homeDir: string | null;
  #claudeDir: string | null = null;
  #bytesWritten = 0;
  #directoryReady = false;

  constructor(options: LoggerOptions) {
    this.#filePath = resolve(options.filePath);
    this.#maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
    this.#maxFiles = options.maxFiles ?? LOG_MAX_FILES;
    this.#now = options.now ?? Date.now;
    this.#sink = options.sink;
    this.#homeDir = options.homeDir === undefined ? null : options.homeDir;
    this.#bytesWritten = this.#existingSize();
  }

  /** The file this logger writes to. Exposed so Settings can tell the user where to look. */
  get filePath(): string {
    return this.#filePath;
  }

  /**
   * Tell the logger which absolute path to redact. Called by SM-1 on every `claudeDir`
   * transition (§5.1), so the redaction always tracks the directory actually in use.
   *
   * ⚠️ Setting it to `null` does not disable redaction of the *previous* directory's entries —
   * those were redacted when they were written. Redaction happens at write time, once, and is
   * therefore not recoverable from the file, which is the point.
   */
  setClaudeDir(claudeDir: string | null): void {
    this.#claudeDir = claudeDir === null ? null : resolve(claudeDir);
  }

  debug(message: string, fields?: LogFields): void {
    this.write({ level: 'debug', message, fields });
  }

  info(message: string, fields?: LogFields): void {
    this.write({ level: 'info', message, fields });
  }

  warn(message: string, fields?: LogFields): void {
    this.write({ level: 'warn', message, fields });
  }

  /** The §4.1 shape: a code, a user-facing sentence, and the stack behind `detail`. */
  error(
    message: string,
    options?: { code?: ErrorCode; detail?: string; fields?: LogFields },
  ): void {
    this.write({
      level: 'error',
      message,
      ...(options?.code === undefined ? {} : { code: options.code }),
      ...(options?.detail === undefined ? {} : { detail: options.detail }),
      ...(options?.fields === undefined ? {} : { fields: options.fields }),
    });
  }

  write(entry: LogEntry): void {
    const parts = [
      new Date(this.#now()).toISOString(),
      entry.level.toUpperCase(),
      entry.code ?? '-',
      this.redact(entry.message),
    ];
    if (entry.fields !== undefined) {
      for (const [key, value] of Object.entries(entry.fields)) {
        parts.push(`${this.redact(key)}=${this.redact(String(value))}`);
      }
    }
    if (entry.detail !== undefined) {
      // Newlines are collapsed so one entry is one line: a log a user greps is a log a user
      // will actually paste the relevant part of, rather than the whole file.
      parts.push(`detail=${this.redact(entry.detail).replaceAll('\n', ' \\n ')}`);
    }
    this.#append(`${parts.join(' ')}\n`);
  }

  /**
   * §7.3's rule, as a function. Applied to EVERY string this file writes — message, field
   * names, field values and stacks alike.
   *
   * Order matters: `claudeDir` is redacted before `homeDir`, because the Claude data directory
   * is normally inside the home directory and the more specific token is the more useful one.
   */
  redact(value: string): string {
    let text = value;
    if (this.#claudeDir !== null) text = text.replaceAll(this.#claudeDir, CLAUDE_DIR_TOKEN);
    if (this.#homeDir !== null && this.#homeDir !== '') {
      text = text.replaceAll(this.#homeDir, HOME_TOKEN);
    }
    if (text.length > LOG_MAX_FIELD_CHARS) {
      return `${text.slice(0, LOG_MAX_FIELD_CHARS)}…[truncated]`;
    }
    return text;
  }

  // -------------------------------------------------------------------------------------

  #append(line: string): void {
    if (this.#sink !== undefined) {
      this.#sink(line);
      return;
    }
    const bytes = Buffer.byteLength(line);
    if (this.#bytesWritten + bytes > this.#maxBytes) this.#rotate();
    try {
      if (!this.#directoryReady) {
        mkdirSync(dirname(this.#filePath), { recursive: true });
        this.#directoryReady = true;
      }
      appendFileSync(this.#filePath, line);
      this.#bytesWritten += bytes;
    } catch {
      // ⚠️ A log that cannot be written must never take the app down with it. §5.1 reserves
      // FATAL for migration failure and DB corruption; an unwritable logs directory is
      // neither, and an app whose value is being glanceable must not brick over one.
    }
  }

  /**
   * §7.3 — 3 files. `claude-lens.log.2` is dropped, `.1` becomes `.2`, the live file
   * becomes `.1`, and a new live file starts. Nothing is ever appended to a rotated file.
   */
  #rotate(): void {
    try {
      for (let index = this.#maxFiles - 1; index >= 1; index -= 1) {
        const source = index === 1 ? this.#filePath : `${this.#filePath}.${String(index - 1)}`;
        const target = `${this.#filePath}.${String(index)}`;
        if (index === this.#maxFiles - 1) rmSync(target, { force: true });
        try {
          renameSync(source, target);
        } catch {
          // The source does not exist yet: nothing to rotate at this level.
        }
      }
    } catch {
      // See #append: logging is never allowed to be the thing that fails.
    }
    this.#bytesWritten = 0;
  }

  #existingSize(): number {
    try {
      return statSync(this.#filePath).size;
    } catch {
      return 0;
    }
  }
}

/**
 * A logger that writes nowhere. Used by tests and by any code path that must be able to run
 * before the real one exists — never as a production fallback, because a silently discarded
 * log is indistinguishable from a log with nothing in it.
 */
export function silentLogger(): Logger {
  return new Logger({ filePath: LOG_FILE_NAME, sink: () => undefined });
}
