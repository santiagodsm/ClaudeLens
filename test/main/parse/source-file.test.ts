// §5.4 rules 4–6 and §3.2's `kind` enum — path → identity.
//
// ⚠️ ADR-020: "Session attribution comes from the **directory path**, never from
// `isSidechain` and never from a heuristic." Everything below is that sentence made
// executable.

import { describe, expect, it } from 'vitest';
import {
  classifyFileKind,
  describeSourceFile,
  displayNameForEncodedProject,
  encodeProjectPath,
} from '../../../src/main/parse/source-file';

describe('describeSourceFile — §5.4 rules 4, 5, 6', () => {
  it('reads a main transcript: session id is the basename, origin is main', () => {
    expect(describeSourceFile('projects/-work-demo-alpha/sess-a.jsonl')).toEqual({
      kind: 'transcript',
      relPath: 'projects/-work-demo-alpha/sess-a.jsonl',
      sessionId: 'sess-a',
      encodedProject: '-work-demo-alpha',
      origin: 'main',
    });
  });

  it('reads a subagent transcript: session id is the SESSION directory, origin is subagent', () => {
    // ⚠️ §5.4 rule 5 says "the name of the parent directory", which read literally is
    // `subagents`. §3.7 and ADR-020 both spell out `projects/<proj>/<session-id>/subagents/
    // *.jsonl`, so the session id is the segment BEFORE `subagents`.
    expect(describeSourceFile('projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl')).toEqual({
      kind: 'subagent_transcript',
      relPath: 'projects/-work-demo-alpha/sess-a/subagents/run-1.jsonl',
      sessionId: 'sess-a',
      encodedProject: '-work-demo-alpha',
      origin: 'subagent',
    });
  });

  it('decides origin by PATH POSITION, not by a `subagents` segment anywhere', () => {
    // A project literally called `subagents` is a project, not a subagent run.
    expect(describeSourceFile('projects/-work-subagents/sess-a.jsonl')).toEqual({
      kind: 'transcript',
      relPath: 'projects/-work-subagents/sess-a.jsonl',
      sessionId: 'sess-a',
      encodedProject: '-work-subagents',
      origin: 'main',
    });
    // A `.jsonl` under the session directory but NOT under `subagents/` is not a transcript
    // this parser reads — it is not guessed at either way.
    expect(describeSourceFile('projects/-work-demo-alpha/sess-a/notes.jsonl')).toBeNull();
  });

  it('recognises history.jsonl and stats-cache.json only at the top level', () => {
    expect(describeSourceFile('history.jsonl')).toEqual({
      kind: 'history',
      relPath: 'history.jsonl',
    });
    expect(describeSourceFile('stats-cache.json')).toEqual({
      kind: 'stats_cache',
      relPath: 'stats-cache.json',
    });
    // Nested `history.jsonl` is not the prompt log — §3.9 is explicit that prompts are
    // "one line of TOP-LEVEL `history.jsonl`". Under `projects/<encoded>/` the same name is
    // structurally a session transcript, and it is read as one rather than misfiled.
    expect(describeSourceFile('projects/-work-demo-alpha/history.jsonl')).toMatchObject({
      kind: 'transcript',
      sessionId: 'history',
    });
    expect(describeSourceFile('nested/stats-cache.json')).toBeNull();
  });

  it('refuses absolute and traversing paths rather than interpreting them', () => {
    expect(describeSourceFile('/projects/-work-demo-alpha/sess-a.jsonl')).toBeNull();
    expect(describeSourceFile('projects/../../etc/sess-a.jsonl')).toBeNull();
    expect(describeSourceFile('')).toBeNull();
  });
});

describe('classifyFileKind — §3.2', () => {
  it('maps each config file to its kind, and anything else to `other`', () => {
    expect(classifyFileKind('skills/alpha/SKILL.md')).toBe('skill_md');
    expect(classifyFileKind('plugins/repos/x/skills/beta/SKILL.md')).toBe('skill_md');
    expect(classifyFileKind('agents/reviewer.md')).toBe('agent_md');
    expect(classifyFileKind('CLAUDE.md')).toBe('claude_md');
    expect(classifyFileKind('projects/-work-demo-alpha/CLAUDE.md')).toBe('claude_md');
    expect(classifyFileKind('settings.json')).toBe('settings_json');
    expect(classifyFileKind('settings.local.json')).toBe('settings_json');
    expect(classifyFileKind('plugins/repos/x/.claude-plugin/plugin.json')).toBe('plugin_manifest');
    expect(classifyFileKind('plugins/marketplaces/y/marketplace.json')).toBe('plugin_manifest');
    expect(classifyFileKind('projects/-work-demo-alpha/memory/MEMORY.md')).toBe('memory_md');
    // ADR-028 — `file-history/` is not parsed in v1, but it is still classified and sized.
    expect(classifyFileKind('file-history/session/before.txt')).toBe('other');
    expect(classifyFileKind('telemetry/failed.log')).toBe('other');
  });
});

describe('§3.3 (amended 2026-07-22) — the FALLBACK display name, and project encoding', () => {
  it('takes the last path-like segment of the decoded encoded name', () => {
    expect(displayNameForEncodedProject('-work-demo-alpha')).toBe('alpha');
    expect(displayNameForEncodedProject('-work-demo-beta')).toBe('beta');
    // ⚠️ Lossy by construction, and this is the WRONG ANSWER for a folder really called
    // `my-app` — which is exactly why it is no longer the primary rule. The name is re-derived
    // from `events.cwd` at finalize (project-display-name.test.ts); this function is only what
    // a project with no usable `cwd` falls back to.
    expect(displayNameForEncodedProject('-work-demo-my-app')).toBe('app');
    // Never empty: an all-separator name falls back to its own identity rather than ''.
    expect(displayNameForEncodedProject('---')).toBe('---');
  });

  it('encodes a path the way `projects/<encoded>` names one', () => {
    expect(encodeProjectPath('/work/demo/alpha')).toBe('-work-demo-alpha');
  });
});
