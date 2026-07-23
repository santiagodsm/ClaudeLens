// SM-5 — DESIGN §5.6, STACK ADR-010.
//
// The watch itself is chokidar's; what this file tests is the state machine around it, driven
// through the injected `watchFactory` and injected timers so a 500 ms debounce does not cost
// 500 ms of suite time and cannot flake on a loaded machine.

import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { BACKUP_ROOT_NAME } from '../../../src/main/config/paths';
import {
  WATCH_DEBOUNCE_MS,
  Watcher,
  isIgnoredWatchPath,
  isWatchTrigger,
  type WatchHandle,
} from '../../../src/main/watcher/watcher';
import { useSandbox } from '../../support/sandbox';

interface FakeWatch extends WatchHandle {
  /** Deliver an fs event, as chokidar's `all` listener would. */
  fire(path: string): void;
  /** Deliver a watch error — the directory disappeared or became unreadable. */
  fail(cause: unknown): void;
  closes(): number;
  /** Every path chokidar asked the ignore predicate about. */
  ignored(path: string): boolean;
}

function fakeWatch(): {
  factory: (root: string, ignored: (p: string) => boolean) => WatchHandle;
  watch: () => FakeWatch;
} {
  let current: FakeWatch | null = null;
  const factory = (_root: string, ignoredFn: (path: string) => boolean): WatchHandle => {
    const all: ((event: string, path: string) => void)[] = [];
    const errors: ((cause: unknown) => void)[] = [];
    let closed = 0;
    const handle: FakeWatch = {
      on(event: 'all' | 'error', listener: unknown): unknown {
        if (event === 'all') all.push(listener as (event: string, path: string) => void);
        else errors.push(listener as (cause: unknown) => void);
        return handle;
      },
      close(): Promise<void> {
        closed += 1;
        return Promise.resolve();
      },
      fire(path: string): void {
        // chokidar never delivers an ignored path; the fake honours the same contract, which
        // is what makes INV-14 a property of the predicate rather than of the consumer.
        if (ignoredFn(path)) return;
        for (const listener of all) listener('change', path);
      },
      fail(cause: unknown): void {
        for (const listener of errors) listener(cause);
      },
      closes: () => closed,
      ignored: ignoredFn,
    };
    current = handle;
    return handle;
  };
  return {
    factory,
    watch: () => {
      if (current === null) throw new Error('the watch has not been created yet');
      return current;
    },
  };
}

/** A manual timer queue, so "500 ms of quiet" is an assertion rather than a wait. */
function fakeTimers(): {
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  pending: () => number;
  fire: () => void;
} {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimer: (callback) => {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    pending: () => timers.size,
    fire: () => {
      const entries = [...timers.entries()];
      timers.clear();
      for (const [, callback] of entries) callback();
    },
  };
}

describe('the ignore rules (INV-14, ADR-028)', () => {
  const sandbox = useSandbox();

  it('excludes the backup root and everything beneath it', () => {
    const root = sandbox.resolve('claude');
    // ⚠️ INV-14 — the app must never see its own safety net. Without this, every guarded
    // action's restore point triggers a resync of the tree the action just wrote into.
    expect(isIgnoredWatchPath(root, join(root, BACKUP_ROOT_NAME))).toBe(true);
    expect(isIgnoredWatchPath(root, join(root, BACKUP_ROOT_NAME, 'iso-1', 'CLAUDE.md'))).toBe(true);
    expect(isIgnoredWatchPath(root, join(root, 'projects', 'a', 's.jsonl'))).toBe(false);
    expect(isIgnoredWatchPath(root, root)).toBe(false);
  });

  it('triggers only on the parsed file kinds', () => {
    const root = sandbox.resolve('claude');
    expect(isWatchTrigger(root, join(root, 'projects', '-a', 's1.jsonl'))).toBe(true);
    expect(isWatchTrigger(root, join(root, 'projects', '-a', 's1', 'subagents', 'r.jsonl'))).toBe(
      true,
    );
    expect(isWatchTrigger(root, join(root, 'history.jsonl'))).toBe(true);
    expect(isWatchTrigger(root, join(root, 'stats-cache.json'))).toBe(true);
    // ADR-028 — `file-history/` is not parsed in v1, so a write there is not a resync reason.
    expect(isWatchTrigger(root, join(root, 'file-history', 'abc.json'))).toBe(false);
    expect(isWatchTrigger(root, join(root, 'projects', '-a', '.DS_Store'))).toBe(false);
    expect(isWatchTrigger(root, join(root, BACKUP_ROOT_NAME, 'iso-1', 'history.jsonl'))).toBe(
      false,
    );
  });
});

describe('SM-5 (§5.6)', () => {
  const sandbox = useSandbox();

  function build(onChange = vi.fn()) {
    const root = sandbox.resolve('claude');
    const watch = fakeWatch();
    const timers = fakeTimers();
    const watcher = new Watcher({
      claudeDir: root,
      onChange,
      watchFactory: watch.factory,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    return { root, watcher, watch, timers, onChange };
  }

  it('debounces a burst into ONE sync (§5.6, 500 ms)', () => {
    expect(WATCH_DEBOUNCE_MS).toBe(500);
    const { root, watcher, watch, timers, onChange } = build();
    watcher.start();
    expect(watcher.state()).toBe('WATCHING');

    for (let index = 0; index < 25; index += 1) {
      watch.watch().fire(join(root, 'projects', '-a', `s${String(index)}.jsonl`));
    }
    // Every event extended the same timer rather than adding one — a per-event timer is how a
    // busy directory schedules a cycle per file and never reaches idle.
    expect(watcher.state()).toBe('DEBOUNCING');
    expect(timers.pending()).toBe(1);
    expect(onChange).not.toHaveBeenCalled();

    timers.fire();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(watcher.state()).toBe('WATCHING');
  });

  it('never sees a backup-root event at all (INV-14)', () => {
    const { root, watcher, watch, timers, onChange } = build();
    watcher.start();
    watch.watch().fire(join(root, BACKUP_ROOT_NAME, 'iso-1', 'projects', 'old.jsonl'));
    expect(watcher.state()).toBe('WATCHING');
    expect(timers.pending()).toBe(0);
    timers.fire();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores a non-parsed kind without starting a timer (ADR-028)', () => {
    const { root, watcher, watch, timers } = build();
    watcher.start();
    watch.watch().fire(join(root, 'file-history', 'abc.json'));
    expect(watcher.state()).toBe('WATCHING');
    expect(timers.pending()).toBe(0);
  });

  it('SUSPENDED drops our own writes, and resume runs exactly one sync (§5.6)', () => {
    const { root, watcher, watch, timers, onChange } = build();
    watcher.start();

    watcher.suspend();
    expect(watcher.state()).toBe('SUSPENDED');
    // ⚠️ A guarded action writes a restore point INSIDE `<claudeDir>`. Those writes must not
    // trigger a resync — the resync would race the mutation it is protecting (§5.5, ADR-032).
    for (let index = 0; index < 5; index += 1) {
      watch.watch().fire(join(root, 'projects', '-a', `s${String(index)}.jsonl`));
    }
    expect(timers.pending()).toBe(0);
    expect(onChange).not.toHaveBeenCalled();

    watcher.resume();
    expect(watcher.state()).toBe('WATCHING');
    expect(onChange).toHaveBeenCalledTimes(1); // "One explicit incremental sync"
  });

  it('a pending debounce is cancelled by suspend rather than firing mid-action', () => {
    const { root, watcher, watch, timers, onChange } = build();
    watcher.start();
    watch.watch().fire(join(root, 'history.jsonl'));
    expect(watcher.state()).toBe('DEBOUNCING');

    watcher.suspend();
    expect(timers.pending()).toBe(0);
    timers.fire();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stops on window close, closes the watch, and fires nothing afterwards', async () => {
    // ⚠️ §1.6 non-goal 7 / §7.6 / P-18: no background process survives the window.
    const { root, watcher, watch, timers, onChange } = build();
    watcher.start();
    watch.watch().fire(join(root, 'history.jsonl'));
    expect(watcher.state()).toBe('DEBOUNCING');

    await watcher.stop();

    expect(watcher.state()).toBe('STOPPED');
    expect(watch.watch().closes()).toBe(1);
    expect(timers.pending()).toBe(0);
    // A late event after the window closed reaches nothing.
    watch.watch().fire(join(root, 'history.jsonl'));
    timers.fire();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a lost directory and stops, rather than throwing (§5.1)', async () => {
    const onDirectoryLost = vi.fn();
    const root = sandbox.resolve('claude');
    const watch = fakeWatch();
    const watcher = new Watcher({
      claudeDir: root,
      onChange: vi.fn(),
      onDirectoryLost,
      watchFactory: watch.factory,
    });
    watcher.start();
    watch.watch().fail(new Error('ENOENT'));
    await Promise.resolve();

    expect(onDirectoryLost).toHaveBeenCalledTimes(1);
    expect(watcher.state()).toBe('STOPPED');
  });

  it('start() is idempotent — one recursive watch, never a second (P-16)', () => {
    const { watcher, watch } = build();
    watcher.start();
    const first = watch.watch();
    watcher.start();
    expect(watch.watch()).toBe(first);
  });
});
