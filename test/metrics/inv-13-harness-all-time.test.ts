// INV-13 (§5.10) — "Harness Manager invocation counts, 'last used', 'never used' and the runtime
// overlay are computed over the **full dataset** and are unaffected by the global filter."
//
// ⚠️ §6.9's reason, in its own words: "A skill deleted because it looked unused this month is
// exactly the irreversible mistake this rule prevents." The primary enforcement is structural —
// the ⛔ channels are typed WITHOUT `GlobalFilter` (§4.5) and the repository methods take no
// scope argument, so an accidentally-filtered count would not compile. This test proves the
// behavioural half: the counts really are over everything, on a fixture where a filter would
// visibly change them.
//
// ⚠️ `harness_nodes` is populated by E10's scanner, which does not exist yet. The two rows below
// are inserted directly for this test only — the invariant under test is a property of the QUERY,
// not of the scan, and waiting for E10 would leave INV-13 unasserted through two more epics.

import { describe, expect, it } from 'vitest';
import { useSandbox } from '../support/sandbox';
import { at, loadFixture, type MetricsFixture } from './support/metrics-harness';
import { usePinnedTimezone } from './support/pinned-tz';

function seedSkillNodes(fixture: MetricsFixture): void {
  const insert = fixture.db.prepare(
    `INSERT INTO harness_nodes (kind, name, source, rel_path, size_bytes)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run('skill', 'demo-skill', 'user', 'skills/demo-skill/SKILL.md', 1_024);
  insert.run('skill', 'never-used-skill', 'user', 'skills/never-used-skill/SKILL.md', 512);
}

describe('INV-13 — Harness Manager counts ignore the global filter', () => {
  const sandbox = useSandbox();
  usePinnedTimezone();

  it('counts invocations over the whole dataset, not the filtered window', async () => {
    const fixture = await loadFixture(sandbox, 'inv13-skills');
    seedSkillNodes(fixture);

    // The fixture: `demo-skill` invoked once in project alpha (2024-05-01) and once in project
    // beta (2024-06-01). A filter restricted to alpha therefore sees ONE call…
    const alphaOnly = at(15, {
      projectIds: [fixture.projectId('-work-demo-alpha')],
      from: null,
      to: null,
    });
    expect(fixture.analytics.toolFingerprint(alphaOnly).total).toBe(1);

    // …but `q:skills` is all time and sees TWO. If this ever read 1, the "never used" badge would
    // be a function of the date picker.
    const skills = fixture.analytics.skills({ limit: 100 }, 'name');
    expect(skills.rows.map((row) => row.name)).toEqual(['demo-skill', 'never-used-skill']);
    expect(skills.rows[0]?.invocations).toBe(2);
    expect(skills.rows[0]?.lastUsedTs).toBe(Date.parse('2024-06-01T00:00:00.000Z'));
    expect(skills.rows[0]?.neverUsed).toBe(false);

    // The whole point of the view (§6.9, BR-03): an installed skill with zero invocations.
    expect(skills.rows[1]?.invocations).toBe(0);
    expect(skills.rows[1]?.lastUsedTs).toBeNull();
    expect(skills.rows[1]?.neverUsed).toBe(true);
  });

  it('sorts never-used first, which is what the view exists to show', async () => {
    const fixture = await loadFixture(sandbox, 'inv13-skills');
    seedSkillNodes(fixture);
    const skills = fixture.analytics.skills({ limit: 100 }, 'never_used');
    expect(skills.rows.map((row) => row.name)).toEqual(['never-used-skill', 'demo-skill']);
  });

  it('computes the runtime overlay over the full dataset too (M-14)', async () => {
    const fixture = await loadFixture(sandbox, 'inv13-skills');
    seedSkillNodes(fixture);
    const graph = fixture.analytics.harnessGraph();
    const demo = graph.nodes.find((node) => node.label === 'demo-skill');
    // 2 invocations, both projects, both months — the same all-time number as `q:skills`.
    expect(demo?.metrics['observed']).toBe(2);
  });
});
