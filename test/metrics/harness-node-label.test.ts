// §6.7 / §1a — the Harness Map label, and its disambiguation on collision.
//
// Node identity is `(kind, name, source, rel_path, project_id)` (§3.10), so two on-disk entities
// that legitimately share a `name:` are two DISTINCT nodes — the concrete case is a plugin cache
// holding two VERSIONS of one plugin, each shipping a skill named the same. Both must survive
// (dropping one would be a wrong dedup); the collision is resolved on the LABEL, with the plugin's
// version as the plain distinguisher. This file proves both halves: the pure rule in
// `harness-labels.ts`, and the whole path scan → `harness_nodes.version` → `harnessGraph()` label.
//
// ⚠️ STACK ADR-013 — every fs/DB-touching test opens with `useSandbox()`; no fixed path appears.
// ⚠️ `toMatchSnapshot()` is banned under `test/metrics/**` (CLAUDE.md §1); every expected label
// below is written out in full.

import { describe, expect, it } from 'vitest';
import { AnalyticsRepository } from '../../src/main/db/repositories/analytics';
import {
  disambiguatedLabels,
  plainSourcePhrase,
  type LabelableNode,
} from '../../src/main/db/repositories/harness-labels';
import { HarnessService } from '../../src/main/harness/service';
import { createSyncHarness, FIXED_NOW } from '../support/sync-harness';
import { writeTree } from '../support/action-harness';
import { useSandbox } from '../support/sandbox';

/** A `LabelableNode` with the plain fields defaulted; each test overrides what it exercises. */
function node(over: Partial<LabelableNode> & { id: number; name: string }): LabelableNode {
  return {
    pluginVersion: null,
    pluginName: null,
    projectName: null,
    sourcePhrase: 'your configuration',
    ...over,
  };
}

describe('§6.7 / §1a — disambiguatedLabels()', () => {
  it('keeps a bare name when it is unique in scope — does NOT suffix everything', () => {
    const labels = disambiguatedLabels([
      node({ id: 1, name: 'setup-project', pluginVersion: '0.5.0' }),
      node({ id: 2, name: 'solo-skill', pluginVersion: '0.5.0' }),
    ]);
    // `solo-skill` collides with nobody, so it keeps its bare label even though it HAS a version.
    expect(labels.get(2)).toBe('solo-skill');
    // `setup-project` also collides with nobody here.
    expect(labels.get(1)).toBe('setup-project');
  });

  it('qualifies two versions of one plugin by version — the concrete case', () => {
    const labels = disambiguatedLabels([
      node({
        id: 1,
        name: 'setup-project',
        pluginVersion: '0.4.0',
        pluginName: 'project-setup-kit',
      }),
      node({
        id: 2,
        name: 'setup-project',
        pluginVersion: '0.5.0',
        pluginName: 'project-setup-kit',
      }),
    ]);
    expect(labels.get(1)).toBe('setup-project (0.4.0)');
    expect(labels.get(2)).toBe('setup-project (0.5.0)');
  });

  it('falls back to the plugin name when two DIFFERENT plugins share a skill name and a version', () => {
    // Same name, same version, different plugins — version cannot separate them, the plugin can.
    const labels = disambiguatedLabels([
      node({ id: 1, name: 'review', pluginVersion: '1.0.0', pluginName: 'kit-a' }),
      node({ id: 2, name: 'review', pluginVersion: '1.0.0', pluginName: 'kit-b' }),
    ]);
    expect(labels.get(1)).toBe('review (1.0.0, kit-a)');
    expect(labels.get(2)).toBe('review (1.0.0, kit-b)');
  });

  it('falls back to the project name when two projects declare the same skill', () => {
    const labels = disambiguatedLabels([
      node({ id: 1, name: 'orchestrator', projectName: 'Alpha' }),
      node({ id: 2, name: 'orchestrator', projectName: 'Beta' }),
    ]);
    // No version, no plugin — the project is the first non-null distinguisher.
    expect(labels.get(1)).toBe('orchestrator (Alpha)');
    expect(labels.get(2)).toBe('orchestrator (Beta)');
  });

  it('falls back to a PLAIN source phrase, never a raw enum value (§1a)', () => {
    const labels = disambiguatedLabels([
      node({ id: 1, name: 'Read', sourcePhrase: plainSourcePhrase('builtin') }),
      node({ id: 2, name: 'Read', sourcePhrase: plainSourcePhrase('transcript') }),
    ]);
    expect(labels.get(1)).toBe('Read (built in)');
    expect(labels.get(2)).toBe('Read (seen in your history)');
    // ⚠️ The raw enum tokens must never appear in a label.
    for (const label of labels.values()) {
      expect(label).not.toContain('builtin');
      expect(label).not.toContain('transcript');
    }
  });

  it('maps every §3.10 source to plain words', () => {
    expect(plainSourcePhrase('user')).toBe('your configuration');
    expect(plainSourcePhrase('plugin')).toBe('from a plugin');
    expect(plainSourcePhrase('builtin')).toBe('built in');
    expect(plainSourcePhrase('transcript')).toBe('seen in your history');
  });
});

describe('§6.7 — the label reaches the Harness Map through harness_nodes.version', () => {
  const sandbox = useSandbox();

  it('renders two plugin versions of setup-project distinctly, and a unique skill bare', async () => {
    const claudeDir = sandbox.resolve('claude');
    // ⚠️ Synthetic, tiny, no personal content (CLAUDE.md §3.4). Two versions of one plugin sit
    // side by side in the cache, each shipping a skill whose frontmatter `name` is `setup-project`
    // — the exact on-disk shape that produced two identical labels.
    await writeTree(claudeDir, {
      'settings.json': '{"enabledPlugins":["project-setup-kit"]}',
      'plugins/market/marketplace.json': '{"name":"market"}',
      'plugins/market/project-setup-kit/0.4.0/plugin.json':
        '{"name":"project-setup-kit","version":"0.4.0"}',
      'plugins/market/project-setup-kit/0.4.0/skills/setup/SKILL.md':
        '---\nname: setup-project\n---\nBody.\n',
      'plugins/market/project-setup-kit/0.5.0/plugin.json':
        '{"name":"project-setup-kit","version":"0.5.0"}',
      'plugins/market/project-setup-kit/0.5.0/skills/setup/SKILL.md':
        '---\nname: setup-project\n---\nBody.\n',
      // A skill whose name is unique in the scope — it must keep its bare label.
      'skills/solo/SKILL.md': '---\nname: solo-skill\n---\nBody.\n',
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
    const skillLabels = graph.nodes
      .filter((n) => n.kind === 'skill')
      .map((n) => n.label)
      .toSorted();

    // (a) the two colliding skills are qualified by their plugin's version; (b) the unique one is
    // bare. No two labels are identical.
    expect(skillLabels).toEqual(['setup-project (0.4.0)', 'setup-project (0.5.0)', 'solo-skill']);

    // The plugin nodes themselves share a name too, and are disambiguated the same way.
    const pluginLabels = graph.nodes
      .filter((n) => n.kind === 'plugin')
      .map((n) => n.label)
      .toSorted();
    expect(pluginLabels).toEqual(['project-setup-kit (0.4.0)', 'project-setup-kit (0.5.0)']);
  });
});
