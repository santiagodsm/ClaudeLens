// Harness Manager — §6.9, INV-06, INV-13, §5.11 BR-03, §5.5 rules 1 and 3.
//
// ⚠️ The four properties this file exists to pin:
//   · every count is badged **"all time"** (INV-13)
//   · **BR-03 has no button** and carries the exact label §3.12 names
//   · the confirm dialog lists **every** target with its size, names the restore point BEFORE
//     the act, and focuses **Cancel** (§6.9)
//   · a typed-confirm action stays disabled until the phrase matches **exactly** (§5.5 rule 3)
//   · clicking an action button **previews**; it never executes (INV-06)

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  ActionPreview,
  BloatFlag,
  BloatList,
  ProjectHarnessGroup,
  Result,
  SkillRow,
} from '../../src/shared/ipc-contract';
import { HarnessView } from '../../src/renderer/views/HarnessView';
import { useAppStore } from '../../src/renderer/store/app-store';
import { installBridge, renderRouted, resetStore, uninstallBridge } from './harness';

afterEach(() => {
  // `globals` is off in `vitest.config.ts`, so Testing Library's auto-cleanup is not
  // registered. Every renderer suite unmounts explicitly (see `primitives.test.tsx`).
  cleanup();
  uninstallBridge();
  resetStore();
});

function flag(overrides: Partial<BloatFlag> = {}): BloatFlag {
  return {
    id: 1,
    ruleId: 'BR-02',
    severity: 'high',
    title: 'Orphaned skill folder',
    location: 'skills/orphan-a',
    sizeBytes: 0,
    itemCount: 1,
    rationale: 'No SKILL.md and 0 bytes of content.',
    actionType: 'delete-orphan-skill-folders',
    actionPayload: { relPaths: ['skills/orphan-a'] },
    detectedAt: 1_760_000_000_000,
    ...overrides,
  };
}

const NEVER_USED_SKILL: SkillRow = {
  name: 'unused',
  source: 'user',
  pluginName: null,
  relPath: 'skills/unused',
  sizeBytes: 1024,
  invocations: 0,
  lastUsedTs: null,
  neverUsed: true,
};

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function stubs(
  rows: BloatFlag[],
  extra: Partial<Record<string, (request: unknown) => Result<unknown>>> = {},
) {
  const list: BloatList = {
    rows,
    totalReclaimableBytes: rows.reduce((total, row) => total + row.sizeBytes, 0),
  };
  return {
    'bloat:list': () => ok(list),
    'q:skills': () => ok({ rows: [NEVER_USED_SKILL], nextCursor: null, totalKnown: 1 }),
    'q:claudeMdFiles': () =>
      ok({
        rows: [
          {
            relPath: 'CLAUDE.md',
            sizeBytes: 0,
            mtimeMs: 1,
            backups: [{ relPath: 'CLAUDE.md.bak', sizeBytes: 42 }],
          },
        ],
      }),
    'q:plugins': () => ok({ marketplaces: [], plugins: [] }),
    'q:memories': () =>
      ok({
        rows: [{ relPath: 'MEMORY.md', projectId: null, sizeBytes: 12, mtimeMs: 1, entryCount: 3 }],
      }),
    // ADR-039 — no project harness by default; the grouping tests below override this.
    'q:harnessProjects': () => ok({ rows: [] }),
    ...extra,
  } as Parameters<typeof installBridge>[0];
}

/** One project group's harness, for the grouping tests. */
function projectGroup(overrides: Partial<ProjectHarnessGroup> = {}): ProjectHarnessGroup {
  return {
    projectId: 7,
    displayName: 'my-side-project',
    encodedName: '-work-my-side-project',
    skills: [
      {
        name: 'orchestrate',
        source: 'user',
        pluginName: null,
        relPath: '.claude/skills/orchestrate',
        sizeBytes: 2048,
        invocations: 0,
        lastUsedTs: null,
        neverUsed: true,
      },
    ],
    agents: [{ name: 'builder', relPath: '.claude/agents/builder.md', sizeBytes: 128 }],
    claudeMd: [{ relPath: 'CLAUDE.md', sizeBytes: 512, mtimeMs: 1 }],
    memories: [],
    plugins: { marketplaces: [], plugins: [] },
    ...overrides,
  };
}

describe('§6.9 Harness Manager', () => {
  it('⛔ INV-13 — badges its counts "all time" and says the filter does not apply', async () => {
    installBridge(stubs([flag()]));
    renderRouted(<HarnessView />, '/harness');

    // The badge is the visible half of a property the IPC types already enforce: the five
    // channels this view reads carry no `GlobalFilter`.
    expect(await screen.findByTestId('all-time-badge')).toHaveTextContent('all time');
    expect(screen.getByText(/never filtered by the date range/i)).toBeInTheDocument();
    expect(await screen.findByText('Invocations (all time)')).toBeInTheDocument();
    expect(screen.getByText('Last used (all time)')).toBeInTheDocument();
  });

  it('renders the Bloat Radar badge, and severity as a WORD, never colour alone', async () => {
    installBridge(stubs([flag({ sizeBytes: 2048 })]));
    renderRouted(<HarnessView />, '/harness');

    expect(await screen.findByText(/1 issue · 2 KB reclaimable/)).toBeInTheDocument();
    expect(screen.getByTestId('severity-high')).toHaveTextContent('high');
    expect(screen.getByText('skills/orphan-a')).toBeInTheDocument();
    // §3.12 — the rationale is rendered verbatim.
    expect(screen.getByText('No SKILL.md and 0 bytes of content.')).toBeInTheDocument();
  });

  it('⚠️ BR-03 renders with NO button and the exact §3.12 label', async () => {
    installBridge(
      stubs([
        flag({
          id: 3,
          ruleId: 'BR-03',
          severity: 'medium',
          title: 'Skill never invoked: unused',
          actionType: null,
          actionPayload: null,
        }),
      ]),
    );
    renderRouted(<HarnessView />, '/harness');

    expect(await screen.findByTestId('no-action-label')).toHaveTextContent(
      'no automatic action in v1',
    );
    // ⚠️ THE assertion. §5.11: "deleting a skill because it shows zero invocations is exactly the
    // kind of irreversible act this app must not make easy."
    expect(screen.queryByTestId('bloat-action')).not.toBeInTheDocument();
  });

  it('a zero-invocation skill is chipped with the WORD "never used"', async () => {
    installBridge(stubs([]));
    renderRouted(<HarnessView />, '/harness');
    expect(await screen.findByTestId('never-used-chip')).toHaveTextContent('never used');
  });

  it('shows a genuine, celebratory empty state rather than an error (§6.9)', async () => {
    installBridge(stubs([]));
    renderRouted(<HarnessView />, '/harness');
    expect(await screen.findByText(/No issues found/)).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('⚠️ INV-06 — the action button PREVIEWS; it never executes', async () => {
    const preview: ActionPreview = {
      actionType: 'delete-orphan-skill-folders',
      targets: [
        { relPath: 'skills/orphan-a', sizeBytes: 0, kind: 'directory' },
        { relPath: 'skills/orphan-b', sizeBytes: 128, kind: 'directory' },
      ],
      totalBytes: 128,
      requiresTypedConfirm: false,
      typedConfirmPhrase: null,
      confirmToken: 'token-abc',
      warnings: ['1 target no longer exists and will be skipped.'],
    };
    const bridge = installBridge(stubs([flag()], { 'action:preview': () => ok(preview) }));
    renderRouted(<HarnessView />, '/harness');

    fireEvent.click(await screen.findByTestId('bloat-action'));
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog).toBeInTheDocument();

    // §6.9 — EVERY target, with its size. Not a count.
    const targets = screen.getAllByTestId('confirm-target');
    expect(targets).toHaveLength(2);
    expect(targets[0]).toHaveTextContent('skills/orphan-a');
    expect(targets[1]).toHaveTextContent('skills/orphan-b');
    expect(targets[1]).toHaveTextContent('128 B');
    expect(screen.getByTestId('confirm-warning')).toHaveTextContent('will be skipped');

    // §5.5 rule 1 — the restore point is named BEFORE the act.
    expect(screen.getByTestId('confirm-restore-note')).toHaveTextContent('.claude-lens-backups/');
    expect(screen.getByTestId('confirm-restore-note')).toHaveTextContent(
      'nothing is changed at all',
    );

    // §6.9 — "Cancel is the default focus."
    await waitFor(() => {
      expect(screen.getByTestId('confirm-cancel')).toHaveFocus();
    });

    // ⚠️ Nothing has been executed. Only the preview was asked for.
    expect(bridge.calls.map((call) => call.channel)).toContain('action:preview');
    expect(bridge.calls.map((call) => call.channel)).not.toContain('action:execute');
  });

  it('cancelling executes nothing and writes no audit row (ABORTED, §5.5 rule 6)', async () => {
    const preview: ActionPreview = {
      actionType: 'delete-orphan-skill-folders',
      targets: [{ relPath: 'skills/orphan-a', sizeBytes: 0, kind: 'directory' }],
      totalBytes: 0,
      requiresTypedConfirm: false,
      typedConfirmPhrase: null,
      confirmToken: 'token-abc',
      warnings: [],
    };
    const bridge = installBridge(stubs([flag()], { 'action:preview': () => ok(preview) }));
    renderRouted(<HarnessView />, '/harness');

    fireEvent.click(await screen.findByTestId('bloat-action'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
    expect(bridge.calls.map((call) => call.channel)).not.toContain('action:execute');
  });

  it('⚠️ §5.5 rule 3 — a typed-confirm action stays disabled until the phrase matches EXACTLY', async () => {
    const preview: ActionPreview = {
      actionType: 'archive-sessions',
      targets: [
        { relPath: 'projects/-a/s1.jsonl', sizeBytes: 1024, kind: 'file' },
        { relPath: 'projects/-a/s1/subagents', sizeBytes: 512, kind: 'directory' },
      ],
      totalBytes: 1536,
      requiresTypedConfirm: true,
      typedConfirmPhrase: 'archive 1 sessions',
      confirmToken: 'token-arch',
      warnings: [],
    };
    const bridge = installBridge(
      stubs(
        [
          flag({
            id: 5,
            ruleId: 'BR-05',
            severity: 'low',
            actionType: 'archive-sessions',
            actionPayload: null,
          }),
        ],
        {
          'action:preview': () => ok(preview),
          'action:execute': () =>
            ok({
              auditId: 1,
              status: 'completed' as const,
              result: {
                succeeded: ['projects/-a/s1.jsonl', 'projects/-a/s1/subagents'],
                skipped: [],
                failed: [],
                backupRelPath: '.claude-lens-backups/x-1',
                backupBytes: 200,
              },
            }),
        },
      ),
    );
    renderRouted(<HarnessView />, '/harness');

    fireEvent.click(await screen.findByTestId('bloat-action'));
    const accept = await screen.findByTestId('confirm-accept');
    expect(accept).toBeDisabled();

    // §6.9's archive copy, in the user's own terms.
    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent(
      /Every chart keeps counting them/,
    );
    // ADR-034 — a manifest, not copies, and undo verifies before it moves anything back.
    expect(screen.getByTestId('confirm-restore-note')).toHaveTextContent('move manifest');

    const input = screen.getByTestId('confirm-phrase');
    fireEvent.change(input, { target: { value: 'archive 1 session' } }); // one character short
    expect(screen.getByTestId('confirm-accept')).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Archive 1 Sessions' } }); // wrong case
    expect(screen.getByTestId('confirm-accept')).toBeDisabled();
    fireEvent.change(input, { target: { value: 'archive 1 sessions ' } }); // trailing space
    expect(screen.getByTestId('confirm-accept')).toBeDisabled();

    fireEvent.change(input, { target: { value: 'archive 1 sessions' } });
    expect(screen.getByTestId('confirm-accept')).toBeEnabled();
    fireEvent.click(screen.getByTestId('confirm-accept'));

    await waitFor(() => {
      expect(screen.getByTestId('action-notice')).toHaveTextContent(/restore point is available/);
    });
    const execute = bridge.calls.find((call) => call.channel === 'action:execute');
    // ⚠️ The token minted by the preview is the one sent back — that binding is INV-06.
    expect(execute?.request).toMatchObject({ confirmToken: 'token-arch' });
  });

  it('reports a FAILED_PARTIAL as "N of M" and offers a manual restore — never auto-restores', async () => {
    const preview: ActionPreview = {
      actionType: 'delete-duplicate-config-backups',
      targets: [
        { relPath: 'a/one.bak', sizeBytes: 1, kind: 'file' },
        { relPath: 'a/two.bak', sizeBytes: 2, kind: 'file' },
      ],
      totalBytes: 3,
      requiresTypedConfirm: false,
      typedConfirmPhrase: null,
      confirmToken: 'token-partial',
      warnings: [],
    };
    installBridge(
      stubs([flag({ id: 6, ruleId: 'BR-06', actionType: 'delete-duplicate-config-backups' })], {
        'action:preview': () => ok(preview),
        'action:execute': () =>
          ok({
            auditId: 2,
            status: 'failed_partial' as const,
            result: {
              succeeded: ['a/one.bak'],
              skipped: [],
              failed: [{ relPath: 'a/two.bak', reason: 'EACCES' }],
              backupRelPath: '.claude-lens-backups/x-2',
              backupBytes: 3,
            },
          }),
      }),
    );
    renderRouted(<HarnessView />, '/harness');

    fireEvent.click(await screen.findByTestId('bloat-action'));
    fireEvent.click(await screen.findByTestId('confirm-accept'));

    await waitFor(() => {
      // §5.5 rule 4 — "The UI reports 'N of M removed; restore point available' and offers a
      // manual restore. The app never auto-restores and never auto-deletes."
      expect(screen.getByTestId('action-notice')).toHaveTextContent('1 of 2 completed');
      expect(screen.getByTestId('action-notice')).toHaveTextContent('1 failed');
      expect(screen.getByTestId('action-notice')).toHaveTextContent('undo it from Settings');
    });
  });

  it('degrades to a message rather than executing when the preview refuses (INV-06, §6.9)', async () => {
    installBridge(
      stubs([flag()], {
        'action:preview': () => ({
          ok: false as const,
          error: {
            code: 'E_ACTION_TARGET_GONE' as const,
            message: 'Those targets are no longer where the scan found them.',
            retryable: false,
          },
        }),
      }),
    );
    renderRouted(<HarnessView />, '/harness');
    fireEvent.click(await screen.findByTestId('bloat-action'));
    expect(await screen.findByTestId('action-notice')).toHaveTextContent(
      /no longer where the scan found them/,
    );
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
  });

  it('renders the CLAUDE.md inspector, plugins and the memory browser with its definition', async () => {
    installBridge(stubs([]));
    renderRouted(<HarnessView />, '/harness');

    expect(await screen.findByTestId('claude-md-row')).toHaveTextContent('CLAUDE.md');
    expect(screen.getByTestId('claude-md-row')).toHaveTextContent('CLAUDE.md.bak');
    expect(await screen.findByTestId('memory-row')).toHaveTextContent('3 entries');
    // ⚠️ The definition travels with the number: DESIGN.md defines no "entry" for a MEMORY.md.
    expect(screen.getByText(/counted as markdown list items/i)).toBeInTheDocument();
  });

  it('renders an ErrorState rather than zeroes when a panel fails (§6.12)', async () => {
    installBridge(
      stubs([], {
        'q:plugins': () => ({
          ok: false as const,
          error: { code: 'E_INTERNAL' as const, message: 'nope', retryable: false },
        }),
      }),
    );
    renderRouted(<HarnessView />, '/harness');
    // A failed panel never blocks the others (§6.9): Bloat Radar still reached its empty state.
    expect(await screen.findByText(/No issues found/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('error-state')).toBeInTheDocument();
    });
  });

  // ---- ADR-039 — grouped by project ----------------------------------------------------------

  it('⚠️ ADR-039 — a project’s own skill shows under THAT project, never in the shared list', async () => {
    installBridge(stubs([], { 'q:harnessProjects': () => ok({ rows: [projectGroup()] }) }));
    renderRouted(<HarnessView />, '/harness');

    const projectSection = await screen.findByTestId('harness-section-project');
    // The header is the full folder name (§3.3), consumed as given.
    expect(within(projectSection).getByText('my-side-project')).toBeInTheDocument();
    // Its own skill, agent and CLAUDE.md are here…
    expect(within(projectSection).getByText('orchestrate')).toBeInTheDocument();
    expect(within(projectSection).getByTestId('agent-row')).toHaveTextContent('builder');
    expect(within(projectSection).getByTestId('project-claude-md-row')).toHaveTextContent(
      'CLAUDE.md',
    );

    // …and NOT in the shared section, whose only skill is the ~/.claude-level one.
    const sharedSection = screen.getByTestId('harness-section-shared');
    expect(within(sharedSection).queryByText('orchestrate')).not.toBeInTheDocument();
    expect(within(sharedSection).getByText('unused')).toBeInTheDocument();
  });

  it('⚠️ project sections are read-only — a project bloat flag has NO action button', async () => {
    // A flag whose location falls under this project's tree is grouped into its section, read-only.
    const projectFlag = flag({
      id: 9,
      location: 'projects/-work-my-side-project/sessions/big.jsonl',
      title: 'Oversized transcript storage',
      actionType: 'archive-sessions',
      actionPayload: null,
    });
    installBridge(
      stubs([projectFlag], { 'q:harnessProjects': () => ok({ rows: [projectGroup()] }) }),
    );
    renderRouted(<HarnessView />, '/harness');

    const projectSection = await screen.findByTestId('harness-section-project');
    // The flag is here…
    expect(within(projectSection).getByTestId('bloat-card')).toHaveTextContent(
      'Oversized transcript storage',
    );
    // …read-only, with NO action button (ADR-039 — the app never touches files inside a project).
    expect(within(projectSection).getByTestId('read-only-label')).toBeInTheDocument();
    expect(within(projectSection).queryByTestId('bloat-action')).not.toBeInTheDocument();

    // The shared section has no issues of its own — the flag was attributed to the project.
    const sharedSection = screen.getByTestId('harness-section-shared');
    expect(within(sharedSection).getByText(/No issues found/)).toBeInTheDocument();
  });

  it('⛔ INV-13 — the harness channels carry NO filter, so the date/project picker cannot move a count', async () => {
    // The store is put into a NON-default filter; the counts must be indifferent to it.
    useAppStore.setState({ filter: { projectIds: [1], from: 100, to: 200 } });
    const bridge = installBridge(
      stubs([], { 'q:harnessProjects': () => ok({ rows: [projectGroup()] }) }),
    );
    renderRouted(<HarnessView />, '/harness');
    await screen.findByTestId('harness-section-project');

    const harnessChannels = new Set([
      'bloat:list',
      'q:skills',
      'q:claudeMdFiles',
      'q:plugins',
      'q:memories',
      'q:harnessProjects',
    ]);
    const requests = bridge.calls
      .filter((call) => harnessChannels.has(call.channel))
      .map((call) => call.request);
    expect(requests.length).toBeGreaterThan(0);
    // No request to any of them mentions a project set or a date range — the type carries none.
    for (const request of requests) {
      if (request === undefined) continue;
      expect(Object.keys(request as object)).not.toContain('projectIds');
      expect(Object.keys(request as object)).not.toContain('from');
      expect(Object.keys(request as object)).not.toContain('to');
    }
    // And it says so on screen.
    expect(screen.getByTestId('all-time-badge')).toHaveTextContent('all time');
  });

  it('⚠️ §1a — no metric / rule / channel id reaches the screen, including the new sections', async () => {
    installBridge(stubs([flag()], { 'q:harnessProjects': () => ok({ rows: [projectGroup()] }) }));
    renderRouted(<HarnessView />, '/harness');
    await screen.findByTestId('harness-section-project');

    const text = document.body.textContent ?? '';
    for (const pattern of [
      /\bBR-\d/, // rule ids
      /\bINV-\d/, // invariant ids
      /\bADR-\d/, // decision ids
      /\bACT-\d/, // action ids
      /\bM-\d\d\b/, // metric ids
      /q:[a-zA-Z]/, // channel names
      /bloat:list/,
      /harness:scan/,
    ]) {
      expect(text).not.toMatch(pattern);
    }
  });
});
