// ⚠️⚠️ **The gate that stops "built but never triggered" recurring for the harness scan**
// (DESIGN §4.8, §5.1, §6.7, §6.9, INV-13).
//
// `harness:scan` was registered and fully implemented — scanner, project `.claude` reader
// (ADR-039), Bloat Radar, all fixture-tested — but **nothing ever called it**. Every harness test
// invoked the scanner directly, so on a real database `harness_nodes` stayed at 0 rows,
// `q:harnessGraph` returned an empty graph, and the Harness Map and the whole Harness Manager
// rendered empty. The scan logic and the thing that should trigger it were built by different
// agents and never met — the same shape as the seventeen unregistered channels
// (`all-channels.test.ts`), and invisible for the same reason: no test drove the *trigger*.
//
// So this file boots the SM-1 dataset lifecycle to READY against a fixture with a skill and an
// agent, wires `onReady` exactly as `src/main/index.ts` does, and asserts that **without any
// explicit `harness.scan()` call** the harness graph fills. The paired negative case boots the
// same lifecycle with the trigger absent and asserts it stays empty — which is what makes this a
// gate rather than a demonstration: it fails the moment the trigger is removed.

import { describe, expect, it } from 'vitest';
import type { HarnessScanSummary } from '../../src/shared/ipc-contract';
import { openDatabase } from '../../src/main/db/driver';
import type { SqliteDatabase } from '../../src/main/db/sqlite';
import { HarnessService } from '../../src/main/harness/service';
import { DatasetService } from '../../src/main/ipc/dataset';
import { silentLogger } from '../../src/main/log/logger';
import type { WatchHandle } from '../../src/main/watcher/watcher';
import { useSandbox } from '../support/sandbox';
import { writeTree } from '../support/action-harness';
import { FIXED_NOW } from '../support/sync-harness';

/** SM-5 is not under test here; a watch that never fires keeps the lifecycle deterministic. */
function inertWatch(): WatchHandle {
  return {
    on(): unknown {
      return this;
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** A real Claude data directory with one transcript (so the sync reaches READY) and a harness. */
async function makeClaudeDir(root: string): Promise<string> {
  await writeTree(root, {
    // One assistant event, so the first full sync completes with ≥1 event and SM-1 reaches READY.
    'projects/-work-demo-alpha/sess-a.jsonl': `${JSON.stringify({
      type: 'assistant',
      uuid: 'u-1',
      timestamp: new Date(FIXED_NOW).toISOString(),
      cwd: '/work/demo/alpha',
      message: {
        role: 'assistant',
        model: 'model-a',
        usage: { input_tokens: 5, output_tokens: 7 },
      },
    })}\n`,
    'history.jsonl': '',
    // The harness the scan must discover — a declared skill and a declared agent. Neither is read
    // by the sync cycle; only the harness scan walks these, which is exactly the point.
    'skills/demo/SKILL.md':
      '---\nname: demo\ndescription: A demo skill.\nallowed-tools: [Read]\n---\n\nDemo.\n',
    'agents/reviewer.md': '---\nname: reviewer\n---\nA reviewer.\n',
    'CLAUDE.md': '# fixture harness file\n',
  });
  return root;
}

/**
 * The production wiring, minus Electron: a real SQLite file, a real Claude data directory, the
 * real SM-1 lifecycle and the real harness scan. `wireTrigger` decides whether SM-1's `onReady`
 * runs the scan — the single line `src/main/index.ts` adds and this file exists to protect.
 */
async function bootToReady(
  db: SqliteDatabase,
  claudeDir: string,
  wireTrigger: boolean,
): Promise<{ dataset: DatasetService; scan: Promise<HarnessScanSummary> | null }> {
  // ⚠️ Declared const with deferred closure references, exactly as `src/main/index.ts` does:
  // `dataset.onReady` closes over `harness`, and `harness.claudeDir` closes over `dataset`; both
  // closures run only after `boot()`, long after each const is initialised.
  let scan: Promise<HarnessScanSummary> | null = null;
  const dataset = new DatasetService({
    db,
    logger: silentLogger(),
    now: () => FIXED_NOW,
    watchFactory: () => inertWatch(),
    // ⚠️ This is the exact hook `src/main/index.ts` wires; the negative case omits it to prove the
    // trigger is load-bearing rather than incidental.
    ...(wireTrigger
      ? {
          onReady: (): void => {
            scan = harness.scan();
          },
        }
      : {}),
  });
  const harness = new HarnessService({
    db,
    claudeDir: () => dataset.claudeDir(),
    now: () => FIXED_NOW,
  });

  await dataset.boot(); // NO_DIR — no directory configured yet.
  // §4.3 / §5.1 — the real transition: validate, purge DERIVED, full sync, then READY.
  await dataset.setSetting('claudeDir', claudeDir);
  await dataset.settled();
  return { dataset, scan };
}

function nodeCount(db: SqliteDatabase): number {
  return db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM harness_nodes').get()?.n ?? 0;
}

describe('the harness scan is triggered by the dataset lifecycle, not only by a direct call', () => {
  const sandbox = useSandbox();

  it('fills harness_nodes and q:harnessGraph on first-ready WITHOUT any explicit scan call', async () => {
    const db = openDatabase(sandbox.resolve('lens.db'));
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude'));

    const { dataset, scan } = await bootToReady(db, claudeDir, true);
    expect(dataset.state()).toBe('READY');

    // ⚠️ The trigger fired on its own: `onReady` created the scan. No test code called
    // `harness.scan()`. Awaiting it here only waits for the fs walk the trigger already started.
    expect(scan).not.toBeNull();
    const summary = await scan;

    expect(nodeCount(db)).toBeGreaterThan(0);
    expect(summary?.nodes).toBeGreaterThan(0);

    // `q:harnessGraph` is `dataset.analytics.harnessGraph()` (register.ts) — the exact call the
    // renderer's Harness Map makes. It must now return the nodes the trigger produced (INV-13:
    // all-time, unaffected by any filter).
    const graph = dataset.analytics.harnessGraph();
    expect(graph.nodes.length).toBeGreaterThan(0);
    // The declared skill and agent are both present — the two the sync cycle never reads.
    const names = new Set(graph.nodes.map((node) => node.label));
    expect(names.has('demo')).toBe(true);
    expect(names.has('reviewer')).toBe(true);

    db.close();
  });

  it('leaves harness_nodes empty when the first-ready trigger is absent — the exact gap this guards', async () => {
    const db = openDatabase(sandbox.resolve('lens-no-trigger.db'));
    const claudeDir = await makeClaudeDir(sandbox.resolve('claude-no-trigger'));

    const { dataset, scan } = await bootToReady(db, claudeDir, false);
    expect(dataset.state()).toBe('READY');

    // No trigger, no scan — which is precisely the shipped defect: a fully working scanner that
    // nothing calls, so the map is empty over a populated database.
    expect(scan).toBeNull();
    expect(nodeCount(db)).toBe(0);
    expect(dataset.analytics.harnessGraph().nodes).toHaveLength(0);

    db.close();
  });
});
