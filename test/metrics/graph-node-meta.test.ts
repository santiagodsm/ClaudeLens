// ⚠️⚠️ §3.9 / §6.7 / §4.5 — `GraphNode.meta`, and the 280-character prompt-preview cap.
//
// **The cap is a product boundary, not a display nicety.** §1.6 non-goal 1 says Claude Lens is
// not a transcript reader; §3.9 says `pastedContents` is never stored in any form and
// `display_preview` "is shown **only** in the graph inspector — never as a list, never
// searchable". `NodeInspector` enforces 280 at the render surface, which is necessary and not
// sufficient: text capped only there has already crossed IPC, entered the renderer's memory and
// become available to any future consumer of the payload.
//
// So the truncation lives in the **repository**, and this file proves it by writing an oversized
// `display_preview` straight into the table — the exact state a widened column, a changed parser
// or a hand backfill would produce — and asserting the payload is still 280.
//
// ⚠️ The direct `UPDATE` is deliberate and is the only hand-written row in this file. Everything
// else reaches the database through the real parser (ADR-013): a fixture that hand-wrote
// `prompts` would prove the `substr` and nothing about whether the query ever finds the right
// prompt for the right session.

import { describe, expect, it } from 'vitest';
import { AnalyticsRepository } from '../../src/main/db/repositories/analytics';
import { GraphStatsRepository } from '../../src/main/db/repositories/graph-stats';
import { PROMPT_PREVIEW_CHARS } from '../../src/main/parse/parse-line';
import { HarnessService } from '../../src/main/harness/service';
import { createSyncHarness, fixturePath, FIXED_NOW } from '../support/sync-harness';
import { writeTree } from '../support/action-harness';
import { useSandbox } from '../support/sandbox';

/** §3.9's own number, imported rather than restated (see `graph-stats.ts`). */
const CAP = PROMPT_PREVIEW_CHARS;

describe('§3.9 — the prompt preview reaches the inspector, capped in the repository', () => {
  const sandbox = useSandbox();

  async function seeded(): Promise<{
    analytics: AnalyticsRepository;
    graphs: GraphStatsRepository;
    setPreview: (sessionId: string, text: string) => void;
  }> {
    const root = await sandbox.copyFixture(fixturePath('f03-append/base'), 'claude');
    const harness = createSyncHarness({ claudeDir: root, dbPath: sandbox.resolve('lens.db') });
    await harness.runSync();
    return {
      analytics: new AnalyticsRepository(harness.db),
      graphs: new GraphStatsRepository(harness.db),
      setPreview: (sessionId, text) => {
        const changed = harness.db
          .prepare('UPDATE prompts SET display_preview = ? WHERE session_id = ?')
          .run(text, sessionId);
        // The test is worthless if the row it means to poison does not exist.
        expect(changed.changes).toBeGreaterThan(0);
      },
    };
  }

  it('carries `history.jsonl`’s display text on the Execution Trace session node', async () => {
    const { analytics } = await seeded();
    const trace = analytics.executionTrace('sess-a');
    const session = trace.nodes.find((node) => node.kind === 'session');
    // `f03-append/base/history.jsonl` line 1: `"display": "hello"`, `"sessionId": "sess-a"`.
    expect(session?.meta?.['promptPreview']).toBe('hello');
  });

  it('⚠️ never puts `pastedContents` on the wire, in any form (§3.9)', async () => {
    const { analytics } = await seeded();
    const trace = analytics.executionTrace('sess-a');
    // The fixture's prompt carries a `pastedContents` block whose body is this sentence. §3.9
    // says it is never stored, so it can appear in no payload — asserted over the WHOLE trace,
    // not just the field we happen to be looking at.
    expect(JSON.stringify(trace)).not.toContain('BULK PASTED MATERIAL');
  });

  it(`⚠️ truncates to ${String(CAP)} characters in the repository, not the component`, async () => {
    const { analytics, graphs, setPreview } = await seeded();
    // 400 characters — the state a widened column or a hand backfill would leave behind.
    const oversized = 'x'.repeat(400);
    setPreview('sess-a', oversized);

    // The repository seam.
    expect(graphs.sessionPromptPreview('sess-a')).toHaveLength(CAP);
    // The §4.5 payload — i.e. what actually crosses IPC.
    const session = analytics.executionTrace('sess-a').nodes.find((n) => n.kind === 'session');
    const preview = session?.meta?.['promptPreview'];
    expect(preview).toHaveLength(CAP);
    // ⚠️ The discriminator: the *untruncated* value must not be what came back. Asserting the
    // length alone would pass if some other 280-character string were substituted.
    expect(preview).not.toBe(oversized);
    expect(preview).toBe('x'.repeat(CAP));
    // ⚠️ And 281 is not "close enough": ≤280 is a stated limit, so one over must fail.
    expect((preview ?? '').length).toBeLessThanOrEqual(CAP);
  });

  it('omits the key entirely when the session has no prompt — never an empty preview', async () => {
    const { analytics, graphs, setPreview } = await seeded();
    // A prompt row whose display is empty is not a prompt with an empty body: §3.9's column is
    // nullable, and an empty quote block in the inspector would claim the user sent nothing.
    setPreview('sess-a', '');
    expect(graphs.sessionPromptPreview('sess-a')).toBeUndefined();
    const session = analytics.executionTrace('sess-a').nodes.find((n) => n.kind === 'session');
    expect(session?.meta?.['promptPreview']).toBeUndefined();
  });

  it('attaches the preview to the session node and to nothing else (§6.7)', async () => {
    const { analytics } = await seeded();
    const trace = analytics.executionTrace('sess-a');
    for (const node of trace.nodes) {
      if (node.kind === 'session') continue;
      // A tool or subagent node carrying prompt text would be attributing a prompt to something
      // that never received one — and would multiply the app's prompt surface by the node count.
      expect(node.meta?.['promptPreview']).toBeUndefined();
    }
  });
});

describe('§4.5 `GraphNode.meta` — the §3.10 columns the Harness Map inspector needs', () => {
  const sandbox = useSandbox();

  it('carries description, rel_path and source for every harness node', async () => {
    const claudeDir = sandbox.resolve('claude');
    await writeTree(claudeDir, {
      'skills/alpha/SKILL.md':
        '---\nname: alpha\ndescription: The first skill.\nallowed-tools: [Read]\n---\n\nBody.\n',
      'CLAUDE.md': '# rules\n',
    });
    const sync = createSyncHarness({ claudeDir, dbPath: sandbox.resolve('lens.db') });
    await sync.runSync();
    const service = new HarnessService({
      db: sync.db,
      claudeDir: () => claudeDir,
      now: () => FIXED_NOW,
    });
    await service.scan();

    const graph = new AnalyticsRepository(sync.db).harnessGraph();
    const alpha = graph.nodes.find((node) => node.label === 'alpha');
    expect(alpha).toBeDefined();
    // All three were columns of `harness_nodes` that `GraphNode` had no field to carry.
    expect(alpha?.meta?.['description']).toBe('The first skill.');
    expect(alpha?.meta?.['relPath']).toContain('skills/alpha');
    expect(alpha?.meta?.['source']).toBe('user');

    // ⚠️ A tool node has no `rel_path` (§3.10 — "NULL for tool nodes"). The key is OMITTED, not
    // emitted as an empty string: an empty "Path" row in the inspector is a different claim.
    const tool = graph.nodes.find((node) => node.kind === 'tool');
    if (tool !== undefined) expect(tool.meta?.['relPath']).toBeUndefined();
  });
});
