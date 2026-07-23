// ADR-039 — project-level harness: path decoding, the read-only guarantee, and the exclusions.
//
// ⚠️ STACK ADR-013 — every fs-touching test opens with `useSandbox()`, no fixed path appears, and
// the real `~/.claude` is unreachable by construction (`test/support/tripwire.ts` plus
// `src/main/config/paths.ts`).
//
// ⚠️ One extra temporary root is created here, and it needs its reason stated. `useSandbox()`
// hands out `<tmp>/claude-lens-tests/w<id>/sbx-XXXX`, and **that path contains hyphens** — so
// `encodeProjectPath()` of it can never round-trip, because §3.3's encoding replaces `/` with `-`
// and is therefore lossy over any path whose own segments contain one. Testing the RESOLVED case
// at all requires a project directory whose absolute path has no hyphen in it. `mkdtemp` under
// `os.tmpdir()` with a hyphen-free prefix is the same mechanism `useSandbox()` uses — unique per
// test, under the OS temp root, removed afterwards — and nothing here ever names a fixed path.

import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyticsRepository } from '../../../src/main/db/repositories/analytics';
import { HarnessService } from '../../../src/main/harness/service';
import {
  decodeEncodedProjectPath,
  encodedProjectNameFor,
  resolveProjectHarnessDirs,
  scanProjectHarness,
} from '../../../src/main/harness/projects';
import { useSandbox } from '../../support/sandbox';
import { writeTree } from '../../support/action-harness';
import { createSyncHarness, FIXED_NOW } from '../../support/sync-harness';

const SKILL_ORCHESTRATE = `---
name: orchestrate
description: The project's own orchestrator skill.
allowed-tools: [Read, Bash]
---

Orchestrate hands work to polish when the build is green.
`;

const SKILL_POLISH = `---
name: polish
description: Tidies up afterwards.
allowed-tools: [Edit]
---

Polish names nobody.
`;

/**
 * Hands out project directories whose absolute path contains no hyphen, so §3.3's encoding
 * round-trips, and removes every one of them after the test that asked for it.
 */
function useHyphenFreeProjectRoots(): () => Promise<string> {
  const created: string[] = [];
  afterEach(async () => {
    const doomed = created.splice(0, created.length);
    for (const root of doomed) await rm(root, { recursive: true, force: true });
  });
  return async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'clprj'));
    created.push(root);
    // ⚠️ A loud failure rather than a silent skip. If a machine's temp root ever contains a
    // hyphen, the RESOLVED half of ADR-039 becomes untestable here and that must be visible,
    // not shrugged off — a test that quietly stops covering its case is how a scope gap returns.
    expect(root).not.toContain('-');
    return root;
  };
}

/** `/a/b/c` → `-a-b-c`, §3.3's encoding. Only valid for a hyphen-free path. */
function encode(absolutePath: string): string {
  return absolutePath.replaceAll('/', '-');
}

/** Every file under `root`, with its size, mtime and bytes — the read-only tripwire's evidence. */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(abs, relPath);
        continue;
      }
      const stats = await stat(abs);
      const bytes = await readFile(abs, 'utf8');
      snapshot.set(relPath, `${String(stats.size)}:${String(stats.mtimeMs)}:${bytes}`);
    }
  };
  await walk(root, '');
  return snapshot;
}

describe('decodeEncodedProjectPath() — exactly one candidate, never a search', () => {
  it('decodes the one path the encoding names', () => {
    expect(decodeEncodedProjectPath('-work-demo-alpha')).toBe('/work/demo/alpha');
  });

  it('⚠️ does NOT try to recover a hyphenated directory name', () => {
    // `/work/demo/my-app` encodes to `-work-demo-my-app`, which decodes to `/work/demo/my/app`.
    // The information is genuinely gone. §2.1's Project entry — "Zero inference: no on-disk
    // probing, no symlink resolution, no worktree merging, no repo-root detection" — forbids
    // enumerating the re-segmentations and stat-ing each until one exists. One candidate is
    // produced, it is wrong, it will not exist, and the project is skipped and disclosed.
    expect(decodeEncodedProjectPath('-work-demo-my-app')).toBe('/work/demo/my/app');
  });

  it('refuses an encoding with an empty segment as ambiguous', () => {
    // `-work-demo--claude` is the encoding of `/work/demo/.claude`, but it decodes to
    // `/work/demo//claude` — and `/work/demo/claude` may be a real, unrelated directory.
    // Two readings, no way to choose: `null`, which the caller counts as a skip.
    expect(decodeEncodedProjectPath('-work-demo--claude')).toBeNull();
  });

  it('refuses a name that does not begin with a separator', () => {
    expect(decodeEncodedProjectPath('work-demo-alpha')).toBeNull();
    expect(decodeEncodedProjectPath('')).toBeNull();
  });
});

describe('resolveProjectHarnessDirs() — resolved vs skipped, and every skip is a count', () => {
  const sandbox = useSandbox();
  const makeHyphenFreeRoot = useHyphenFreeProjectRoots();

  it('resolves a project whose encoded name round-trips to a directory with a harness', async () => {
    const projectDir = await makeHyphenFreeRoot();
    await writeTree(projectDir, {
      'CLAUDE.md': '# project rules\n',
      '.claude/skills/orchestrate/SKILL.md': SKILL_ORCHESTRATE,
    });
    const claudeDir = sandbox.resolve('claude');
    await writeTree(claudeDir, { 'settings.json': '{}' });

    const result = await resolveProjectHarnessDirs(claudeDir, [
      { id: 1, encodedName: encode(projectDir) },
    ]);

    expect(result.skipped).toEqual([]);
    expect(result.resolved).toEqual([
      { projectId: 1, encodedName: encode(projectDir), projectDir, via: 'decoded' },
    ]);
  });

  it('⚠️ skips — and counts — a project whose decoded path is not there', async () => {
    const claudeDir = sandbox.resolve('claude-absent');
    await writeTree(claudeDir, { 'settings.json': '{}' });

    const result = await resolveProjectHarnessDirs(claudeDir, [
      { id: 1, encodedName: '-work-demo-my-app' }, // decodes to /work/demo/my/app
      { id: 2, encodedName: '-work-demo--claude' }, // ambiguous on its face
      { id: 3, encodedName: 'not-absolute' },
    ]);

    expect(result.resolved).toEqual([]);
    // ⚠️ Each carries WHY. §4.6: incompleteness is data, never a log line — and "we could not
    // read that project" and "we did not try" are different facts about the same map.
    expect(result.skipped).toEqual([
      { encodedName: '-work-demo-my-app', reason: 'directory-absent' },
      { encodedName: '-work-demo--claude', reason: 'ambiguous-encoding' },
      { encodedName: 'not-absolute', reason: 'ambiguous-encoding' },
    ]);
  });

  it('skips a directory that exists but declares no harness', async () => {
    const projectDir = await makeHyphenFreeRoot();
    await writeTree(projectDir, { 'README.md': '# nothing to see\n' });
    const claudeDir = sandbox.resolve('claude-noharness');
    await writeTree(claudeDir, { 'settings.json': '{}' });

    const result = await resolveProjectHarnessDirs(claudeDir, [
      { id: 1, encodedName: encode(projectDir) },
    ]);
    expect(result.resolved).toEqual([]);
    expect(result.skipped).toEqual([{ encodedName: encode(projectDir), reason: 'no-harness' }]);
  });

  it('⚠️ skips a project that resolves onto the Claude data directory itself', async () => {
    // `~/.claude` is a project on any machine where Claude Code has been run from the home
    // directory. Reading it as "a project's harness" would scan the configured root a second time
    // under a project id — doubling every node and dragging the backup root in behind it (INV-14).
    const claudeDir = await makeHyphenFreeRoot();
    await writeTree(claudeDir, { 'CLAUDE.md': '# root\n' });

    const result = await resolveProjectHarnessDirs(claudeDir, [
      { id: 1, encodedName: encode(claudeDir) },
    ]);
    expect(result.resolved).toEqual([]);
    expect(result.skipped).toEqual([
      { encodedName: encode(claudeDir), reason: 'overlaps-claude-dir' },
    ]);
  });
});

describe('resolveProjectHarnessDirs() — the exact route through events.cwd', () => {
  const sandbox = useSandbox();

  it('⚠️ resolves a HYPHENATED project name the decode cannot recover', async () => {
    // ⚠️ This is the case that matters. `…/Projects/Photo-Booth` encodes to
    // `-…-Projects-Photo-Booth`, which decodes to `…/Projects/Photo/Booth` — a directory that does
    // not exist. Before the `cwd` route, such a project was correctly but uselessly skipped.
    // Note the sandbox path itself is full of hyphens and this still works, which is the point:
    // nothing is decoded, an equality between two recorded values is checked.
    const projectDir = sandbox.resolve('Photo-Booth');
    await writeTree(projectDir, { '.claude/skills/polish/SKILL.md': SKILL_POLISH });
    const claudeDir = sandbox.resolve('claude-cwd');
    await writeTree(claudeDir, { 'settings.json': '{}' });

    const result = await resolveProjectHarnessDirs(claudeDir, [
      { id: 1, encodedName: encodedProjectNameFor(projectDir), cwds: [projectDir] },
    ]);

    expect(result.skipped).toEqual([]);
    expect(result.resolved).toEqual([
      {
        projectId: 1,
        encodedName: encodedProjectNameFor(projectDir),
        projectDir,
        via: 'cwd',
      },
    ]);
    // The decode alone would have produced a different path entirely, which is why `via` is
    // recorded rather than assumed.
    expect(decodeEncodedProjectPath(encodedProjectNameFor(projectDir))).not.toBe(projectDir);
  });

  it('ignores a recorded cwd that does not re-encode to this project name', async () => {
    // A session's `cwd` can be a subdirectory of the project, or another project entirely after a
    // resumed session. Only an EXACT re-encoding match is accepted; anything else is not evidence
    // about this project's directory and is discarded rather than trimmed into shape.
    const projectDir = sandbox.resolve('Some-Project');
    await writeTree(projectDir, { 'CLAUDE.md': '# rules\n' });
    const claudeDir = sandbox.resolve('claude-mismatch');
    await writeTree(claudeDir, { 'settings.json': '{}' });

    const result = await resolveProjectHarnessDirs(claudeDir, [
      {
        id: 1,
        encodedName: encodedProjectNameFor(projectDir),
        cwds: [join(projectDir, 'src'), sandbox.resolve('Another-Project')],
      },
    ]);
    // Neither cwd matches, so it falls back to the lossy decode — which cannot recover
    // `Some-Project` — and the project is skipped and counted rather than mis-resolved.
    expect(result.resolved).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('directory-absent');
  });

  it('⚠️ skips when two different recorded directories encode to the same name', async () => {
    // `/x/a-b` and `/x/a/b` both encode to `-x-a-b`. When both are recorded there is no way to
    // choose, and choosing anyway would draw one repository's harness under another's name.
    const first = sandbox.resolve('a-b');
    const second = sandbox.resolve('a', 'b');
    await writeTree(first, { 'CLAUDE.md': '# one\n' });
    await writeTree(second, { 'CLAUDE.md': '# two\n' });
    expect(encodedProjectNameFor(first)).toBe(encodedProjectNameFor(second));

    const claudeDir = sandbox.resolve('claude-ambiguous');
    await writeTree(claudeDir, { 'settings.json': '{}' });

    const result = await resolveProjectHarnessDirs(claudeDir, [
      { id: 1, encodedName: encodedProjectNameFor(first), cwds: [first, second] },
    ]);
    expect(result.resolved).toEqual([]);
    expect(result.skipped).toEqual([
      { encodedName: encodedProjectNameFor(first), reason: 'ambiguous-encoding' },
    ]);
  });
});

describe('scanProjectHarness() — nodes, edges, and nothing written', () => {
  const makeHyphenFreeRoot = useHyphenFreeProjectRoots();

  it('derives project-scoped skills, agents and the root CLAUDE.md', async () => {
    const projectDir = await makeHyphenFreeRoot();
    await writeTree(projectDir, {
      'CLAUDE.md': '# the orchestrator instructions\n',
      '.claude/skills/orchestrate/SKILL.md': SKILL_ORCHESTRATE,
      '.claude/skills/polish/SKILL.md': SKILL_POLISH,
      '.claude/agents/builder.md': '---\nname: builder\n---\nBuilds.\n',
      '.claude/settings.json': '{}',
    });

    const scanned = await scanProjectHarness({
      projectId: 7,
      encodedName: encode(projectDir),
      projectDir,
      via: 'decoded',
    });
    const named = (kind: string): string[] =>
      scanned.nodes
        .filter((node) => node.kind === kind)
        .map((node) => node.name)
        .toSorted();

    expect(named('skill')).toEqual(['orchestrate', 'polish']);
    expect(named('agent')).toEqual(['builder']);
    // ⚠️ The project's ROOT `CLAUDE.md` keeps the bare name; §5.9 M-14's rule O-3 starts the
    // orchestrator edge from a node named exactly that. A `.claude/CLAUDE.md` would carry its
    // path in the name instead, so the two can never be confused.
    expect(named('claude_md')).toEqual(['CLAUDE.md']);

    // ⚠️ Every node from a project carries its `projectId`, which is the marker every consumer
    // filters on. A tool node does not: `Read` is the same `Read` in every project, and one tool
    // node per project would shatter the Map into disconnected islands.
    for (const node of scanned.nodes) {
      expect(node.projectId).toBe(node.kind === 'tool' ? null : 7);
    }

    // §3.10's edge table, over this project's own files: two `tool_grant`s from `orchestrate`,
    // one from `polish`, and the `body_mention` handoff `orchestrate` → `polish`.
    expect(scanned.edges.filter((edge) => edge.kind === 'tool_grant')).toHaveLength(3);
    const handoffs = scanned.edges.filter((edge) => edge.kind === 'handoff');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.evidence).toBe('body_mention');
  });

  it('⚠️⚠️ writes, moves and deletes NOTHING under the project directory', async () => {
    const projectDir = await makeHyphenFreeRoot();
    await writeTree(projectDir, {
      'CLAUDE.md': '# rules\n',
      '.claude/skills/orchestrate/SKILL.md': SKILL_ORCHESTRATE,
      '.claude/agents/builder.md': '---\nname: builder\n---\nBuilds.\n',
      'src/app.ts': 'export const x = 1;\n',
    });

    const before = await snapshotTree(projectDir);
    await scanProjectHarness({
      projectId: 1,
      encodedName: encode(projectDir),
      projectDir,
      via: 'decoded',
    });
    const after = await snapshotTree(projectDir);

    // Same files, same sizes, same modification times, same bytes. ACT-01…07 operate only within
    // the Claude data directory (§5.7, ADR-032) and ADR-039 does not widen their reach by one
    // path; this is the assertion that says so rather than the comment.
    expect([...after.keys()].toSorted()).toEqual([...before.keys()].toSorted());
    expect(after).toEqual(before);
  });
});

describe('ADR-039 exclusions — project harness is visible, never actionable', () => {
  const sandbox = useSandbox();
  const makeHyphenFreeRoot = useHyphenFreeProjectRoots();

  /** A synced Claude data directory plus one real project whose harness it can reach. */
  async function scenario(suffix: string): Promise<{
    db: ReturnType<typeof createSyncHarness>['db'];
    service: HarnessService;
    projectDir: string;
    claudeDir: string;
  }> {
    const projectDir = await makeHyphenFreeRoot();
    await writeTree(projectDir, {
      'CLAUDE.md': '# the orchestrator instructions\n',
      '.claude/skills/orchestrate/SKILL.md': SKILL_ORCHESTRATE,
      '.claude/agents/builder.md': '---\nname: builder\n---\nBuilds.\n',
    });

    const claudeDir = sandbox.resolve(`claude-${suffix}`);
    const encoded = encode(projectDir);
    // One session in that project, whose main loop spawns `builder` twice.
    const spawn = (uuid: string, ts: string, id: string): string =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        timestamp: ts,
        message: {
          role: 'assistant',
          model: 'claude-test-1',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'builder' } }],
        },
      });
    await writeTree(claudeDir, {
      [`projects/${encoded}/sess-p.jsonl`]:
        `${spawn('p-1', '2024-06-02T09:00:00.000Z', 'tu-p-1')}\n` +
        `${spawn('p-2', '2024-06-02T09:05:00.000Z', 'tu-p-2')}\n`,
    });

    const harness = createSyncHarness({ claudeDir, dbPath: sandbox.resolve(`${suffix}.db`) });
    await harness.runSync();
    const service = new HarnessService({
      db: harness.db,
      claudeDir: () => claudeDir,
      now: () => FIXED_NOW,
    });
    await service.scan();
    return { db: harness.db, service, projectDir, claudeDir };
  }

  it('puts the project harness on the Harness Map, with its project named', async () => {
    const { db } = await scenario('map');
    const graph = new AnalyticsRepository(db).harnessGraph();
    const byLabel = new Map(graph.nodes.map((node) => [`${node.kind}:${node.label}`, node]));

    expect(byLabel.get('skill:orchestrate')).toBeDefined();
    expect(byLabel.get('agent:builder')).toBeDefined();
    // §6.7's inspector must be able to say WHICH project a node came from: a Map that merges
    // several projects' orchestrators without saying so is worse than an empty one.
    expect(byLabel.get('skill:orchestrate')?.meta?.['scope']).toBe('project (read-only)');
    expect(byLabel.get('skill:orchestrate')?.meta?.['relPath']).toBe('.claude/skills/orchestrate');

    // ⚠️ Rule O-3 — the orchestrator hop. Two main-loop `Agent` calls naming `builder`, in this
    // project, from this project's own root CLAUDE.md.                                      = 2
    const orchestrator = byLabel.get('claude_md:CLAUDE.md');
    const builder = byLabel.get('agent:builder');
    const edge = graph.edges.find(
      (candidate) => candidate.source === orchestrator?.id && candidate.target === builder?.id,
    );
    expect(edge?.designed).toBe(false);
    expect(edge?.observed).toBe(2);
    // The agent node's own overlay is the same two spawns — §2.1's second definition of an
    // agent definition, now that it has an implementation.
    expect(builder?.metrics['observed']).toBe(2);
  });

  it('⚠️⚠️ keeps every project path out of the manifest, the flags and the skill list', async () => {
    const { db, service, projectDir } = await scenario('exclusions');

    // INV-14's shape, applied to a second root. Nothing under the project directory is a file
    // this app has recorded, sized, or offered to do anything with.
    const manifest = db
      .prepare<{ rel_path: string }>('SELECT rel_path FROM file_manifest')
      .all()
      .map((row) => row.rel_path);
    expect(manifest.some((relPath) => relPath.includes('.claude/skills'))).toBe(false);
    expect(manifest.some((relPath) => relPath.startsWith(projectDir))).toBe(false);

    const flags = service.bloatList().rows;
    expect(flags.some((flag) => flag.location.includes('.claude/skills'))).toBe(false);
    expect(flags.some((flag) => flag.location.startsWith(projectDir))).toBe(false);
    // ⚠️ BR-03 in particular: a project's skill must never be reported as "installed but never
    // invoked", because the card it produces is the app's opinion about a file in someone's
    // repository that it has no business having.
    expect(flags.some((flag) => flag.title.includes('orchestrate'))).toBe(false);

    // §4.5 `q:skills` is the list §6.9 wires to the guarded-action catalogue. A project skill in
    // it would put a Delete button beside a path ACT-01 must never resolve.
    expect(service.skills({ limit: 50, sort: 'name' }).rows).toEqual([]);
    expect(service.memories().rows).toEqual([]);
    expect(service.plugins()).toEqual({ marketplaces: [], plugins: [] });
  });

  it('⚠️⚠️ never draws one call as two edges when two projects share a name', async () => {
    // ⚠️ THE REGRESSION. Found by running the scanner against a real machine: joining nodes by
    // NAME alone drew `story-reviewer → Bash` three times, each reading 7,631 — once for the
    // plugin-level definition and once for each of two projects declaring the same agent. Anyone
    // reading that picture sums 22,893 calls that never happened. Two projects here declare the
    // same `builder` and the same `orchestrate`, and each spawns its own agent twice.
    const first = await makeHyphenFreeRoot();
    const second = await makeHyphenFreeRoot();
    for (const projectDir of [first, second]) {
      await writeTree(projectDir, {
        'CLAUDE.md': '# rules\n',
        '.claude/skills/orchestrate/SKILL.md': SKILL_ORCHESTRATE,
        '.claude/agents/builder.md': '---\nname: builder\n---\nBuilds.\n',
      });
    }

    const spawn = (uuid: string, ts: string, id: string): string =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        timestamp: ts,
        message: {
          role: 'assistant',
          model: 'claude-test-1',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'builder' } }],
        },
      });
    const claudeDir = sandbox.resolve('claude-shared-names');
    await writeTree(claudeDir, {
      [`projects/${encode(first)}/sess-1.jsonl`]:
        `${spawn('s1-1', '2024-06-03T09:00:00.000Z', 'tu-1-1')}\n` +
        `${spawn('s1-2', '2024-06-03T09:05:00.000Z', 'tu-1-2')}\n`,
      [`projects/${encode(second)}/sess-2.jsonl`]:
        `${spawn('s2-1', '2024-06-03T10:00:00.000Z', 'tu-2-1')}\n` +
        `${spawn('s2-2', '2024-06-03T10:05:00.000Z', 'tu-2-2')}\n`,
    });

    const harness = createSyncHarness({
      claudeDir,
      dbPath: sandbox.resolve('shared-names.db'),
    });
    await harness.runSync();
    const service = new HarnessService({
      db: harness.db,
      claudeDir: () => claudeDir,
      now: () => FIXED_NOW,
    });
    expect((await service.scan()).projectsResolved).toBe(2);

    const graph = new AnalyticsRepository(harness.db).harnessGraph();
    const builders = graph.nodes.filter(
      (node) => node.kind === 'agent' && node.label === 'builder',
    );
    // THREE nodes, and each one earns its place: one per project (two real definitions, which are
    // two different files) plus the unscoped `transcript` node. ⚠️ That third node is not
    // redundant — it is the fallback a project that SPAWNS `builder` without declaring it resolves
    // to, and dropping it would make such a project's calls resolve to another project's
    // definition, which is a worse error than a quiet node.
    expect(builders).toHaveLength(3);
    const scoped = builders.filter((node) => node.meta?.['project'] !== undefined);
    const unscoped = builders.filter((node) => node.meta?.['project'] === undefined);
    expect(scoped).toHaveLength(2);

    // ⚠️ Each project's node carries only ITS OWN two spawns…
    expect(scoped.map((node) => node.metrics['observed'])).toEqual([2, 2]);
    // …and the fallback carries none, because every call here belongs to a project that declares
    // its own. `0` is the honest reading: nothing in the data attributes a call to it.
    expect(unscoped.map((node) => node.metrics['observed'])).toEqual([0]);
    // ⚠️ The total drawn on the Map equals the total that happened: 2 + 2 + 0 = 4, never 4 + 4.
    expect(builders.reduce((sum, node) => sum + (node.metrics['observed'] ?? 0), 0)).toBe(4);

    // The same for edges: two O-3 orchestrator edges, one per project, two spawns each — not two
    // edges of four, and not four edges.
    const spawnEdges = graph.edges.filter((edge) =>
      builders.some((builder) => builder.id === edge.target),
    );
    expect(spawnEdges).toHaveLength(2);
    expect(spawnEdges.map((edge) => edge.observed)).toEqual([2, 2]);
  });

  it('reports how many projects resolved and how many were skipped', async () => {
    const { service } = await scenario('counts');
    const summary = await service.scan();
    expect(summary.projectsResolved).toBe(1);
    expect(summary.projectsSkipped).toBe(0);
  });
});
