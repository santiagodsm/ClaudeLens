// §3.10's edge-derivation table — the `handoff` rule in particular.
//
// ⚠️ §3.10: "Edge derivation is exact and testable — **no natural-language inference**." That is
// what makes this file possible: every assertion below can be checked by reading the fixture,
// with no judgement about what a sentence "means".
//
// The rule, verbatim: "skill A → skill B iff B's frontmatter `name` occurs in A's body as a whole
// token (delimited by any character outside `[A-Za-z0-9_-]`), case-sensitive, self-excluded.
// **Verified case: `setup-project` yields 8 sibling edges** (HANDOFF §4)."

import { describe, expect, it } from 'vitest';
import { deriveHandoffEdges, occursAsWholeToken } from '../../../src/main/harness/edges';

/**
 * A synthetic nine-skill kit whose orchestrator names its eight siblings in prose, plus the
 * decoys that make the delimiter rule and the case rule bite.
 *
 * ⚠️ Synthetic — no real `.claude` content appears in this repository (CLAUDE.md §7).
 */
const SIBLINGS = [
  'project-brief',
  'stack-decide',
  'design-author',
  'scaffold',
  'harness-forge',
  'backlog-author',
  'plan-lint',
  'harness-doctor',
];

const ORCHESTRATOR_BODY = `
Run the chain in order.

1. project-brief writes the requirements.
2. Then stack-decide locks the technology.
3. design-author turns those two into the design contract.
4. scaffold builds the repo skeleton.
5. harness-forge generates the build harness (see harness-doctor below).
6. backlog-author turns the design into a plan, then plan-lint audits it.

Decoys that must NOT produce an edge:
  · setup-project itself — self-excluded.
  · stack-decided, plan-linted, xscaffold, scaffold-2 — token continues past the name.
  · Stack-Decide, SCAFFOLD — case-sensitive, so neither matches.
`;

function candidates(): { key: string; name: string; body: string }[] {
  return [
    {
      key: 'skill setup-project user skills/setup-project',
      name: 'setup-project',
      body: ORCHESTRATOR_BODY,
    },
    ...SIBLINGS.map((name) => ({
      key: `skill ${name} user skills/${name}`,
      name,
      // A sibling's own body mentions nothing, so every edge below is one the orchestrator drew.
      body: 'This skill does one thing and names no other skill.\n',
    })),
  ];
}

describe('§3.10 `handoff` — whole-token, case-sensitive, self-excluded', () => {
  it('yields exactly 8 sibling edges for `setup-project` (the verified case, HANDOFF §4)', () => {
    const edges = deriveHandoffEdges(candidates());
    const fromOrchestrator = edges.filter((edge) => edge.fromKey.includes('setup-project'));

    // ⚠️ THE verified case §3.10 names. Eight, not nine: `setup-project` is self-excluded even
    // though its own name appears in its own body.
    expect(fromOrchestrator).toHaveLength(8);
    expect(fromOrchestrator.map((edge) => edge.toKey).toSorted()).toEqual(
      SIBLINGS.map((name) => `skill ${name} user skills/${name}`).toSorted(),
    );
    // The siblings name nobody, so the orchestrator's eight are the whole graph.
    expect(edges).toHaveLength(8);
  });

  it('excludes a skill from itself even when its body names it', () => {
    const edges = deriveHandoffEdges(candidates());
    expect(edges.some((edge) => edge.fromKey === edge.toKey)).toBe(false);
    expect(ORCHESTRATOR_BODY).toContain('setup-project');
  });

  it('treats `_` and `-` as token characters, so a prefix does not match', () => {
    // The whole reason the delimiter class is spelled out in §3.10: `stack-decide` must not be
    // found inside `stack-decided`, or every skill whose name prefixes another collects edges
    // it never declared.
    expect(occursAsWholeToken('stack-decided', 'stack-decide')).toBe(false);
    expect(occursAsWholeToken('run stack-decide now', 'stack-decide')).toBe(true);
    expect(occursAsWholeToken('my_skill_name', 'skill')).toBe(false);
    expect(occursAsWholeToken('xscaffold', 'scaffold')).toBe(false);
    expect(occursAsWholeToken('scaffold-2', 'scaffold')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(occursAsWholeToken('Stack-Decide', 'stack-decide')).toBe(false);
    expect(occursAsWholeToken('SCAFFOLD', 'scaffold')).toBe(false);
    expect(occursAsWholeToken('scaffold', 'scaffold')).toBe(true);
  });

  it('accepts a name at either boundary of the body', () => {
    expect(occursAsWholeToken('scaffold', 'scaffold')).toBe(true);
    expect(occursAsWholeToken('scaffold builds it', 'scaffold')).toBe(true);
    expect(occursAsWholeToken('then scaffold', 'scaffold')).toBe(true);
    expect(occursAsWholeToken('(scaffold)', 'scaffold')).toBe(true);
  });

  it('matches a name containing regex metacharacters literally', () => {
    // Harness names are DATA (STACK ADR-017). Building a `RegExp` out of one would make a
    // configuration file able to change how the matcher behaves.
    expect(occursAsWholeToken('a b', 'a.b')).toBe(false);
    expect(occursAsWholeToken('a.b', 'a.b')).toBe(true);
  });
});
