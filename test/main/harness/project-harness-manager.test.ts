// §6.9 / ADR-039 — the Harness Manager, grouped by project. `HarnessService.projectHarness()` is
// the per-project half; the four ⛔ channels stay the `~/.claude`-level (shared) half.
//
// ⚠️ These are the properties the grouping must hold:
//   · a project's OWN skill/agent/CLAUDE.md appears under THAT project, never in the shared list
//   · a shared node (`project_id IS NULL`) never leaks into a project group
//   · "installed but never used" sorts first WITHIN a project section (§6.9)
//   · ⛔ INV-13 — invocations are ALL TIME, by skill name, over the whole dataset. Grouping by
//     which project OWNS a skill is not the same as filtering its count by project.
//
// ⚠️ STACK ADR-013 — one sandbox, one SQLite file, the real parser. The three project-scoped
// `harness_nodes` rows are seeded directly for the same reason `inv-13-harness-all-time.test.ts`
// does it: E10's scanner populates that table, and the property under test is a property of the
// QUERY, not of the scan.

import { describe, expect, it } from 'vitest';
import { HarnessManagerRepository } from '../../../src/main/db/repositories/harness-manager';
import { HarnessService } from '../../../src/main/harness/service';
import { useSandbox } from '../../support/sandbox';
import { loadFixture, type MetricsFixture } from '../../metrics/support/metrics-harness';
import { usePinnedTimezone } from '../../metrics/support/pinned-tz';

const ALPHA = '-work-demo-alpha';

/**
 * Seeds alpha's own harness: two skills (one invoked in the fixture, one never), an agent and the
 * project's root CLAUDE.md — plus one SHARED skill (`project_id IS NULL`) that must stay out of
 * every project group.
 */
function seedProjectHarness(fixture: MetricsFixture, projectId: number): void {
  const node = fixture.db.prepare(
    `INSERT INTO harness_nodes (kind, name, source, project_id, rel_path, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  node.run('skill', 'demo-skill', 'user', projectId, '.claude/skills/demo-skill', 100);
  node.run('skill', 'zzz-unused', 'user', projectId, '.claude/skills/zzz-unused', 50);
  node.run('agent', 'builder', 'user', projectId, '.claude/agents/builder.md', 30);
  node.run('claude_md', 'CLAUDE.md', 'user', projectId, 'CLAUDE.md', 200);
  // The shared harness — the ~/.claude-level list every project inherits.
  node.run('skill', 'shared-skill', 'user', null, 'skills/shared-skill', 70);
}

function service(fixture: MetricsFixture): HarnessService {
  return new HarnessService({
    db: fixture.db,
    claudeDir: () => '/unused-in-these-reads',
    now: () => 0,
  });
}

describe('§6.9 / ADR-039 — Harness Manager grouped by project', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('puts a project’s own skills, agent and CLAUDE.md under that project — not in the shared list', async () => {
    const fixture = await loadFixture(sandbox, 'inv13-skills');
    const alpha = fixture.projectId(ALPHA);
    seedProjectHarness(fixture, alpha);

    const groups = service(fixture).projectHarness().rows;
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.projectId).toBe(alpha);
    expect(group?.encodedName).toBe(ALPHA);
    expect(typeof group?.displayName).toBe('string');
    expect((group?.displayName ?? '').length).toBeGreaterThan(0);

    expect(group?.agents.map((a) => a.name)).toEqual(['builder']);
    expect(group?.claudeMd.map((c) => c.relPath)).toEqual(['CLAUDE.md']);

    // The shared skill is NOT in the project group…
    expect(group?.skills.map((s) => s.name)).not.toContain('shared-skill');
    // …it is in the shared list, and the project skills are NOT (ADR-039 exclusion, re-asserted).
    const shared = service(fixture).skills({ limit: 100, sort: 'name' }).rows;
    expect(shared.map((s) => s.name)).toContain('shared-skill');
    expect(shared.map((s) => s.name)).not.toContain('demo-skill');
    expect(shared.map((s) => s.name)).not.toContain('zzz-unused');
  });

  it('sorts "installed but never used" first WITHIN the project section, counting all time', async () => {
    const fixture = await loadFixture(sandbox, 'inv13-skills');
    const alpha = fixture.projectId(ALPHA);
    seedProjectHarness(fixture, alpha);

    const group = service(fixture).projectHarness().rows[0];
    // never-used first, then the used one — the ranking §6.9 asks for, now per section.
    expect(group?.skills.map((s) => s.name)).toEqual(['zzz-unused', 'demo-skill']);
    expect(group?.skills[0]?.neverUsed).toBe(true);
    expect(group?.skills[0]?.invocations).toBe(0);

    // ⛔ INV-13 — `demo-skill` ran once in alpha (2024-05) and once in beta (2024-06). The count
    // is ALL TIME, by name: 2, not "1 in this project". `projectHarness()` takes no filter to make
    // it otherwise.
    expect(group?.skills[1]?.name).toBe('demo-skill');
    expect(group?.skills[1]?.invocations).toBe(2);
    expect(group?.skills[1]?.neverUsed).toBe(false);
  });

  it('returns no groups when nothing declares a project-scoped harness', async () => {
    const fixture = await loadFixture(sandbox, 'inv13-skills');
    // Only a shared node exists.
    fixture.db
      .prepare(
        `INSERT INTO harness_nodes (kind, name, source, project_id, rel_path, size_bytes)
         VALUES ('skill', 'shared-only', 'user', NULL, 'skills/shared-only', 10)`,
      )
      .run();
    expect(new HarnessManagerRepository(fixture.db).projectHarness()).toEqual([]);
  });
});
