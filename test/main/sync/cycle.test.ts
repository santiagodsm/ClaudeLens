// SM-2 (§5.2) — the sync cycle's state machine, driven against a scripted `SyncWork`.
//
// The five rules of §5.2, each with its own test, plus §8.5 P-22's 4 Hz progress ceiling.
// No filesystem and no database here on purpose: this is the state machine, and mixing it
// with real I/O is how a coalescing bug hides behind a timing flake.

import { describe, expect, it, vi } from 'vitest';
import type { SyncState } from '../../../src/shared/ipc-contract';
import { PROGRESS_INTERVAL_MS, SyncCycle } from '../../../src/main/sync/cycle';
import type {
  CycleSummary,
  FileParseResult,
  PlannedFile,
  ScanPhaseResult,
  SyncRunContext,
  SyncWork,
} from '../../../src/main/sync/engine';

function plannedFile(relPath: string): PlannedFile {
  return {
    relPath,
    kind: 'transcript',
    fileClass: 'NEW',
    manifestId: 1,
    startByteOffset: 0,
    startLineNo: 0,
    startBadLines: 0,
    startCacheSplitMismatches: 0,
    sizeBytes: 10,
    mtimeMs: 1,
  };
}

interface ScriptedWork extends SyncWork {
  readonly scans: number[];
  readonly parsed: string[];
  readonly finalized: CycleSummary[];
}

function scriptedWork(
  files: readonly string[],
  hooks: {
    onScan?: () => void;
    onParse?: (relPath: string, context: SyncRunContext) => void;
    failOn?: string;
  } = {},
): ScriptedWork {
  const scans: number[] = [];
  const parsed: string[] = [];
  const finalized: CycleSummary[] = [];
  return {
    scans,
    parsed,
    finalized,
    scan(): Promise<ScanPhaseResult> {
      scans.push(scans.length);
      hooks.onScan?.();
      return Promise.resolve({
        files: files.map(plannedFile),
        unchanged: 0,
        archived: 0,
        filesMissing: 0,
        retainedOrphans: 0,
        orphansReturned: 0,
        unreadable: [],
      });
    },
    parseFile(file: PlannedFile, context: SyncRunContext): Promise<FileParseResult> {
      hooks.onParse?.(file.relPath, context);
      if (hooks.failOn === file.relPath) throw new Error(`boom on ${file.relPath}`);
      parsed.push(file.relPath);
      return Promise.resolve({
        relPath: file.relPath,
        recordsIngested: 2,
        badLinesDelta: 1,
        cancelled: false,
      });
    },
    finalize(_context: SyncRunContext, summary: CycleSummary): Promise<void> {
      finalized.push(summary);
      return Promise.resolve();
    },
  };
}

const clock = (): (() => number) => {
  let value = 1_000;
  return () => (value += 1_000);
};

describe('SM-2 — the sync cycle', () => {
  it('runs IDLE → SCANNING → PARSING → FINALIZING → IDLE', async () => {
    const emitted: SyncState[] = [];
    const work = scriptedWork(['a.jsonl', 'b.jsonl']);
    const cycle = new SyncCycle({ work, now: clock(), emit: (state) => emitted.push(state) });

    cycle.start('full');
    await cycle.settled();

    expect(emitted.map((state) => state.phase)).toEqual([
      'scanning',
      'parsing',
      'parsing',
      'parsing',
      'finalizing',
      'idle',
    ]);
    const final = cycle.state();
    expect(final.phase).toBe('idle');
    expect(final.filesTotal).toBe(2);
    expect(final.filesDone).toBe(2);
    expect(final.recordsIngested).toBe(4); // 2 files × 2 records
    expect(final.badLines).toBe(2); // 2 files × 1 bad line
    expect(final.error).toBeNull();
    expect(final.lastDurationMs).toBeGreaterThan(0);
  });

  it('rule 1+2 — coalesces N mid-cycle requests into exactly ONE follow-up cycle', async () => {
    const ref = { cycle: null as SyncCycle | null };
    let injected = false;
    // Five watcher events arrive while the first file of the FIRST cycle is parsing. The
    // one-shot guard is the test's, not the machine's: re-injecting every cycle would loop
    // forever, which is itself the failure mode coalescing prevents in production.
    const work = scriptedWork(['a.jsonl', 'b.jsonl'], {
      onParse: (relPath) => {
        if (relPath !== 'a.jsonl' || injected) return;
        injected = true;
        for (let i = 0; i < 5; i += 1) ref.cycle?.start('incremental');
      },
    });
    const cycle = (ref.cycle = new SyncCycle({ work, now: clock(), emit: () => undefined }));

    cycle.start('incremental');
    await cycle.settled();

    // ⚠️ Exactly two scans: the original cycle and ONE follow-up. `queuedRescan` is a
    // boolean, not a queue — five events must not schedule five cycles (§5.2 rule 2).
    expect(work.scans.length).toBe(2);
    expect(cycle.state().queuedRescan).toBe(false);
    expect(cycle.state().phase).toBe('idle');
  });

  it('rule 1 — a mid-cycle request returns the current state, not an error', async () => {
    const ref = { cycle: null as SyncCycle | null };
    let midCycle: ReturnType<SyncCycle['start']> | null = null;
    const work = scriptedWork(['a.jsonl'], {
      onParse: () => {
        midCycle ??= ref.cycle?.start('incremental') ?? null;
      },
    });
    const cycle = (ref.cycle = new SyncCycle({ work, now: clock(), emit: () => undefined }));

    cycle.start('incremental');
    await cycle.settled();

    expect(midCycle).not.toBeNull();
    expect(midCycle!.coalesced).toBe(true);
    expect(midCycle!.busy).toBe(false);
    expect(midCycle!.state.queuedRescan).toBe(true);
  });

  it('§4.4 — a FULL sync requested mid-cycle is busy, because it cannot be coalesced', async () => {
    const ref = { cycle: null as SyncCycle | null };
    let midCycle: ReturnType<SyncCycle['start']> | null = null;
    const work = scriptedWork(['a.jsonl'], {
      onParse: () => {
        midCycle ??= ref.cycle?.start('full') ?? null;
      },
    });
    const cycle = (ref.cycle = new SyncCycle({ work, now: clock(), emit: () => undefined }));

    cycle.start('incremental');
    await cycle.settled();

    expect(midCycle!.busy).toBe(true);
    expect(midCycle!.coalesced).toBe(false);
    // …and it did NOT silently downgrade into a queued incremental.
    expect(work.scans.length).toBe(1);
  });

  it('cancel stops between files and keeps everything already committed (§5.2 rule 3)', async () => {
    const ref = { cycle: null as SyncCycle | null };
    const work = scriptedWork(['a.jsonl', 'b.jsonl', 'c.jsonl'], {
      onParse: (relPath) => {
        if (relPath === 'a.jsonl') ref.cycle?.cancel();
      },
    });
    const cycle = (ref.cycle = new SyncCycle({ work, now: clock(), emit: () => undefined }));

    cycle.start('incremental');
    await cycle.settled();

    // The file being parsed when the cancel arrived still finished and still committed;
    // the ones after it were not started.
    expect(work.parsed).toEqual(['a.jsonl']);
    // Nothing was finalized, nothing was rolled back, and the machine is idle again.
    expect(work.finalized).toEqual([]);
    expect(cycle.state().phase).toBe('idle');
  });

  it('rule 4 — an unrecoverable error goes to FAILED and truncates nothing', async () => {
    const emitted: SyncState[] = [];
    const work = scriptedWork(['a.jsonl', 'b.jsonl'], { failOn: 'b.jsonl' });
    const cycle = new SyncCycle({ work, now: clock(), emit: (state) => emitted.push(state) });

    cycle.start('incremental');
    await cycle.settled();

    const failed = cycle.state();
    expect(failed.phase).toBe('failed');
    expect(failed.error?.code).toBe('E_SYNC_FAILED');
    expect(failed.error?.retryable).toBe(true);
    // ⚠️ The file that succeeded before the failure stays committed. `FAILED` retains all
    // previously ingested data; there is deliberately no rollback on this path.
    expect(work.parsed).toEqual(['a.jsonl']);
    expect(failed.recordsIngested).toBe(2);

    // §5.2 — `FAILED ⇒ (manual retry) ⇒ SCANNING`. Explicit, never automatic.
    const retried = cycle.retry();
    expect(retried.started).toBe(true);
    await cycle.settled();
    expect(work.scans.length).toBe(2);
  });

  it('a queued rescan is not started after a FAILED cycle', async () => {
    const ref = { cycle: null as SyncCycle | null };
    let injected = false;
    const work = scriptedWork(['a.jsonl', 'b.jsonl'], {
      failOn: 'b.jsonl',
      onParse: (relPath) => {
        if (relPath !== 'a.jsonl' || injected) return;
        injected = true;
        ref.cycle?.start('incremental');
      },
    });
    const cycle = (ref.cycle = new SyncCycle({ work, now: clock(), emit: () => undefined }));

    cycle.start('incremental');
    await cycle.settled();

    // Auto-restarting into the same failure is a loop, not a recovery (ADR-032: failure
    // never triggers automatic recovery).
    expect(cycle.state().phase).toBe('failed');
    expect(work.scans.length).toBe(1);
  });

  it('P-22 — progress is emitted at most 4 Hz while parsing', async () => {
    const emitted: SyncState[] = [];
    // A clock that does not advance: every progress frame after the phase transition is
    // inside the same 250 ms window and must be dropped.
    const frozen = (): number => 5_000;
    const work = scriptedWork(['a', 'b', 'c', 'd', 'e', 'f']);
    const cycle = new SyncCycle({ work, now: frozen, emit: (state) => emitted.push(state) });

    cycle.start('incremental');
    await cycle.settled();

    // Phase transitions always emit — a phase change is not visual thrash. Six files
    // produce zero extra frames because no time passed.
    expect(emitted.map((state) => state.phase)).toEqual([
      'scanning',
      'parsing',
      'finalizing',
      'idle',
    ]);
    expect(PROGRESS_INTERVAL_MS).toBe(250); // 4 Hz, §8.5 P-22
  });

  it('emits dataChanged only when the cycle wrote something (§4.9, P-18)', async () => {
    const onDataChanged = vi.fn();
    const empty = new SyncCycle({
      work: scriptedWork([]),
      now: clock(),
      emit: () => undefined,
      onDataChanged,
    });
    empty.start('incremental');
    await empty.settled();
    expect(onDataChanged).not.toHaveBeenCalled();

    const wrote = new SyncCycle({
      work: scriptedWork(['a.jsonl']),
      now: clock(),
      emit: () => undefined,
      onDataChanged,
    });
    wrote.start('incremental');
    await wrote.settled();
    expect(onDataChanged).toHaveBeenCalledTimes(1);
  });

  it('skips FINALIZING work when nothing was parsed, without leaving the phase out', async () => {
    const emitted: SyncState[] = [];
    const work = scriptedWork([]);
    const cycle = new SyncCycle({ work, now: clock(), emit: (state) => emitted.push(state) });
    cycle.start('incremental');
    await cycle.settled();

    // The phase still happens (the machine has no shortcut edge); the WORK inside it is what
    // an empty cycle skips, which is what keeps P-02 at ≤ 500 ms.
    expect(emitted.map((state) => state.phase)).toContain('finalizing');
    expect(work.finalized[0]?.filesParsed).toBe(0);
  });
});
