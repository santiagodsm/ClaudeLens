// §7.3 — the main-process log.
//
// The two properties worth a test are the two that matter if the file ever leaves the machine:
// the absolute Claude data directory is never in it, and neither is anything that could carry
// prompt text or file contents.

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  CLAUDE_DIR_TOKEN,
  HOME_TOKEN,
  LOG_MAX_FIELD_CHARS,
  Logger,
} from '../../../src/main/log/logger';
import { useSandbox } from '../../support/sandbox';

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe('§7.3 redaction — enforced in the writer, not by asking callers to remember', () => {
  const sandbox = useSandbox();

  it('writes the Claude data directory as <claudeDir>, everywhere it appears', () => {
    const { lines, sink } = capture();
    const claudeDir = sandbox.resolve('claude');
    const logger = new Logger({ filePath: sandbox.resolve('claude-lens.log'), sink, now: () => 0 });
    logger.setClaudeDir(claudeDir);

    logger.error(`could not read ${claudeDir}/projects/x/s1.jsonl`, {
      code: 'E_DIR_UNREADABLE',
      // A stack that happens to embed the path is redacted by the same pass — there is no way
      // to write around it, which is the point of doing this in the writer.
      detail: `Error: EACCES\n    at read (${claudeDir}/projects/x/s1.jsonl:1:1)`,
      fields: { path: `${claudeDir}/history.jsonl` },
    });

    const line = lines.join('');
    expect(line).not.toContain(claudeDir);
    expect(line).toContain(CLAUDE_DIR_TOKEN);
    // Three occurrences: message, field value, stack — all of them.
    expect(line.split(CLAUDE_DIR_TOKEN).length - 1).toBe(3);
    expect(line).toContain('E_DIR_UNREADABLE');
  });

  it('redacts the home directory too, and prefers the more specific token', () => {
    const { lines, sink } = capture();
    const home = sandbox.resolve('home');
    const claudeDir = `${home}/.claude`;
    const logger = new Logger({
      filePath: sandbox.resolve('claude-lens.log'),
      homeDir: home,
      sink,
      now: () => 0,
    });
    logger.setClaudeDir(claudeDir);

    logger.info('scanned', { root: claudeDir, other: `${home}/Documents` });
    const line = lines.join('');
    expect(line).not.toContain(home);
    expect(line).toContain(CLAUDE_DIR_TOKEN);
    expect(line).toContain(HOME_TOKEN);
  });

  it('truncates, so a leaked blob cannot land whole', () => {
    const { lines, sink } = capture();
    const logger = new Logger({ filePath: sandbox.resolve('claude-lens.log'), sink, now: () => 0 });
    // A transcript line pasted into `detail` by mistake is capped rather than persisted.
    logger.error('parse failed', { detail: 'x'.repeat(LOG_MAX_FIELD_CHARS * 3) });
    const line = lines.join('');
    expect(line).toContain('[truncated]');
    expect(line.length).toBeLessThan(LOG_MAX_FIELD_CHARS * 2);
  });

  it('offers no channel for a record body — the API is the enforcement', () => {
    // ⚠️ This is a structural assertion, not a string one. `Logger` accepts a message, a §4.1
    // code, a stack and SCALAR fields. There is no `content`, `line` or `text` parameter for a
    // caller to reach for, so logging a transcript line is not a mistake that is available to
    // make. If a later edit adds one, this test is where it is noticed.
    const surface = Object.getOwnPropertyNames(Logger.prototype).sort();
    expect(surface).toEqual([
      'constructor',
      'debug',
      'error',
      'filePath',
      'info',
      'redact',
      'setClaudeDir',
      'warn',
      'write',
    ]);
  });
});

describe('§7.3 rotation — 5 MB × 3 files', () => {
  const sandbox = useSandbox();

  it('rolls the live file to .1 and drops .2, keeping three files at most', () => {
    const filePath = sandbox.resolve('claude-lens.log');
    // A tiny cap so the behaviour is exercised without writing 5 MB three times.
    const logger = new Logger({ filePath, maxBytes: 120, maxFiles: 3, now: () => 0 });

    for (let index = 0; index < 12; index += 1) logger.info(`entry-${String(index)}`);

    expect(statSync(filePath).size).toBeGreaterThan(0);
    expect(statSync(`${filePath}.1`).size).toBeGreaterThan(0);
    expect(statSync(`${filePath}.2`).size).toBeGreaterThan(0);
    expect(() => statSync(`${filePath}.3`)).toThrow();
    // The oldest entries are gone rather than accumulating: rotation is a bound, not an archive.
    expect(readFileSync(filePath, 'utf8')).not.toContain('entry-0 ');
  });

  it('picks up an existing file’s size rather than restarting the budget', () => {
    const filePath = sandbox.resolve('claude-lens.log');
    writeFileSync(filePath, 'x'.repeat(200));
    const logger = new Logger({ filePath, maxBytes: 120, maxFiles: 3, now: () => 0 });
    logger.info('first entry after restart');
    // The pre-existing content was rotated away rather than appended past the cap.
    expect(readFileSync(filePath, 'utf8')).not.toContain('xxxx');
    expect(readFileSync(`${filePath}.1`, 'utf8')).toContain('xxxx');
  });

  it('never lets a failed write take the app down', () => {
    // §5.1 reserves FATAL for migration failure and DB corruption. An unwritable logs
    // directory is neither, and an app whose value is being glanceable must not brick over it.
    const logger = new Logger({ filePath: sandbox.resolve('a-file/nested/claude-lens.log') });
    writeFileSync(sandbox.resolve('a-file'), 'not a directory');
    expect(() => logger.info('this cannot be written anywhere')).not.toThrow();
  });
});
