/**
 * Harness Manager — `view-harness` (DESIGN §6.9), grouped by project (ADR-039).
 *
 * ⚠️⚠️ **This view ignores the global filter entirely** (INV-13) **and says so**: every count is
 * badged "all time". §6.9's reason, in its own words: "A skill deleted because it looked unused
 * this month is exactly the irreversible mistake this rule prevents." Grouping the screen BY
 * project is not the same as FILTERING the counts by project — the counts stay all-time, and the
 * five read channels this view uses (`bloat:list`, `q:skills`, `q:claudeMdFiles`, `q:plugins`,
 * `q:memories`) plus the sixth (`q:harnessProjects`) are typed in `src/shared/ipc-contract.ts`
 * **without** a `GlobalFilter`, so there is no filter to pass even if someone tried.
 *
 * ⚠️ **ADR-039 — project sections are READ-ONLY.** A project's own skills, agents and CLAUDE.md
 * live outside the Claude data directory, and ACT-01…07 operate only inside it. So a project row
 * never carries an action button: it is shown, so the user can see what a project declares, and
 * never actioned. The "Shared across all projects" section (`~/.claude`-level, `project_id IS
 * NULL`) keeps its guarded actions, because those files are inside the directory the app owns.
 *
 * ⚠️ **BR-03 has no button, by design.** §5.11: deleting a skill because it shows zero invocations
 * is exactly the irreversible act this app must not make easy. `actionType: null` renders as the
 * muted label "no automatic action in v1". Do not wire one.
 *
 * ⚠️ **Parsed harness text is data, never instructions** (§3.10, §7.8, STACK ADR-017). Skill
 * names, descriptions, project display names and rationales are rendered as text by React, which
 * escapes them. Nothing on this screen uses `dangerouslySetInnerHTML`, and nothing may.
 *
 * ⚠️ **No jargon on screen** (CLAUDE.md §1a). Every metric/rule/channel/column id is confined to
 * comments; the screen says "installed but never used", "no issues found", "read-only", never
 * `BR-03`, `INV-13` or a channel name.
 */

import { useCallback, useMemo, useState, type JSX, type ReactNode } from 'react';
import type {
  ActionPreview,
  ActionType,
  AppError,
  BloatFlag,
  MarketplaceRow,
  PluginRow,
  ProjectHarnessAgent,
  ProjectHarnessClaudeMd,
  ProjectHarnessGroup,
  SkillRow,
} from '../../shared/ipc-contract';
import { Badge, SeverityBadge } from '../components/Badge';
import { ChartCard } from '../components/ChartCard';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { RescanButton } from '../components/RescanButton';
import { useQuery } from '../hooks/use-query';
import { invokeWith } from '../lib/ipc';
import { DEFAULT_PAGE_LIMIT } from '../lib/limits';
import { formatBytes, formatInteger, formatTimestamp } from '../lib/format';
import { useAppStore } from '../store/app-store';
import { ViewShell } from '../shell/ViewShell';

/** §6.9 — every count on this screen carries this word. INV-13, made visible. */
function AllTime(): JSX.Element {
  return (
    <Badge tone="neutral" data-testid="all-time-badge">
      all time
    </Badge>
  );
}

interface PendingAction {
  readonly actionType: ActionType;
  readonly payload: unknown;
  readonly preview: ActionPreview;
  readonly headline: string;
  readonly confirmLabel: string;
}

/**
 * A bloat flag whose `location` falls under `projects/<encodedName>/…` belongs to that project's
 * section; everything else is `~/.claude`-level and belongs to the shared section. In practice
 * project nodes never produce flags (ADR-039 excludes them from Bloat Radar), and the one rule
 * that walks `projects/**` (oversized transcript storage) carries a glob, not one project's path —
 * so this attributes correctly and leaves those where they belong: shared.
 */
function flagBelongsToProject(flag: BloatFlag, group: ProjectHarnessGroup): boolean {
  const prefix = `projects/${group.encodedName}/`;
  return flag.location === `projects/${group.encodedName}` || flag.location.startsWith(prefix);
}

/**
 * §3.12 — "reclaimable" counts only flags that HAVE an action. The actionless ones (installed but
 * never used) and the archive-only one promise no disk back, so they are excluded — the same
 * exclusion the main process applies to the header total (§5.11).
 */
function reclaimableBytes(flags: readonly BloatFlag[]): number {
  return flags
    .filter((flag) => flag.actionType !== null && flag.ruleId !== 'BR-05')
    .reduce((total, flag) => total + flag.sizeBytes, 0);
}

function issuesSummary(flags: readonly BloatFlag[]): string {
  return `${String(flags.length)} issue${flags.length === 1 ? '' : 's'} · ${formatBytes(
    reclaimableBytes(flags),
  )} reclaimable`;
}

export function HarnessView(): JSX.Element {
  const bloat = useQuery('bloat:list', undefined);
  const skills = useQuery('q:skills', { limit: DEFAULT_PAGE_LIMIT, sort: 'never_used' });
  const claudeMd = useQuery('q:claudeMdFiles', undefined);
  const plugins = useQuery('q:plugins', undefined);
  const memories = useQuery('q:memories', undefined);
  const projects = useQuery('q:harnessProjects', undefined);
  const bumpHarness = useAppStore((state) => state.applyDataChanged);

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshAll = useCallback(() => {
    // §7.4 — the same invalidation path a push event takes. Nothing is cached client-side.
    bumpHarness(['harness', 'bloat', 'events', 'sessions']);
  }, [bumpHarness]);

  /**
   * ⚠️ INV-06 — the button does NOT execute. It asks the main process to resolve the targets and
   * mint a token bound to that exact list, then shows the list. Execution happens only after the
   * user has confirmed the list they were shown.
   */
  const beginAction = useCallback(async (flag: BloatFlag): Promise<void> => {
    if (flag.actionType === null) return;
    setNotice(null);
    const result = await invokeWith('action:preview', {
      actionType: flag.actionType,
      payload: flag.actionPayload,
    });
    if (!result.ok) {
      // §6.9's degraded state: the action is disabled with "targets changed — rescan" rather than
      // executing against a stale list (INV-06).
      setNotice(`${flag.title}: ${result.error.message}`);
      return;
    }
    setPending({
      actionType: flag.actionType,
      payload: flag.actionPayload,
      preview: result.data,
      headline: headlineFor(flag.actionType, result.data),
      confirmLabel: confirmLabelFor(flag.actionType, result.data),
    });
  }, []);

  const runPending = useCallback(async (): Promise<void> => {
    if (pending === null) return;
    setBusy(true);
    const result = await invokeWith('action:execute', {
      actionType: pending.actionType,
      payload: pending.payload,
      confirmToken: pending.preview.confirmToken,
    });
    setBusy(false);
    setPending(null);
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    const { status, result: outcome } = result.data;
    setNotice(
      status === 'completed'
        ? `Done — ${String(outcome.succeeded.length)} of ${String(pending.preview.targets.length)}. A restore point is available.`
        : // ⚠️ §5.5 rule 4 — FAILED_PARTIAL reports "N of M" and offers a manual restore. The
          // app never auto-restores and never auto-deletes.
          `${String(outcome.succeeded.length)} of ${String(pending.preview.targets.length)} completed; ${String(outcome.failed.length)} failed. A restore point is available — undo it from Settings.`,
    );
    refreshAll();
  }, [pending, refreshAll]);

  // ⚠️ Referentially stable: a new `[]` every render would re-fire the flag-bucketing memo below
  // and, worse, re-run the section entrances on every push event (§6.2 forbids re-animation).
  const flags = useMemo(() => bloat.data?.rows ?? [], [bloat.data]);
  const groups = useMemo(() => projects.data?.rows ?? [], [projects.data]);

  // Every flag is placed in exactly one section: a project's, or (the default) shared.
  const { sharedFlags, flagsByProject } = useMemo(() => {
    const byProject = new Map<number, BloatFlag[]>();
    const shared: BloatFlag[] = [];
    for (const flag of flags) {
      const owner = groups.find((group) => flagBelongsToProject(flag, group));
      if (owner === undefined) {
        shared.push(flag);
        continue;
      }
      const bucket = byProject.get(owner.projectId) ?? [];
      bucket.push(flag);
      byProject.set(owner.projectId, bucket);
    }
    return { sharedFlags: shared, flagsByProject: byProject };
  }, [flags, groups]);

  // The project query drives every project sub-panel; each shares this one loading/error state.
  const projectsState: PanelState = {
    loading: projects.loading,
    error: projects.error,
    refetch: projects.refetch,
  };

  return (
    <ViewShell
      id="harness"
      heading={
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-h2 text-text-primary">Harness Manager</h1>
            <AllTime />
            <span className="text-small text-text-muted">
              Counts here are never filtered by the date range or project selection.
            </span>
            {/* §6.9 — harness files change while the app is open; re-walk on demand. */}
            <RescanButton />
          </div>
          {/* §6.9's rationale, in plain words: per-project is where "never used" is a real signal. */}
          <p className="max-w-3xl text-small text-text-muted">
            A skill that is never used <em>in one project</em> is a real signal. The same skill
            sitting unused across a dozen projects that each keep their own copy is just noise — so
            each project is its own section, with the shared configuration everything inherits at
            the top.
          </p>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        {notice !== null && (
          <p data-testid="action-notice" role="status" className="text-small text-text-primary">
            {notice}
          </p>
        )}

        {/* ---- Shared: the ~/.claude-level harness every project inherits (project_id IS NULL) ---- */}
        <HarnessSection
          title="Shared across all projects"
          subtitle="Skills, memory, plugins and settings in your home Claude folder — inherited by every project."
          defaultOpen
          testId="harness-section-shared"
        >
          <BloatRadar
            flags={sharedFlags}
            loading={bloat.loading}
            error={bloat.error}
            onRetry={bloat.refetch}
            onAction={beginAction}
            // §6.9 — "a genuine, celebratory empty state, not an error".
            emptyReason="No issues found — your harness is tidy."
          />
          <SkillsPanel rows={skills.data?.rows ?? []} state={skills} />
          <ClaudeMdPanel state={claudeMd} onAction={beginAction} flags={sharedFlags} />
          <PluginsPanel state={plugins} />
          <MemoriesPanel rows={memories.data?.rows ?? []} state={memories} />
        </HarnessSection>

        {/* ---- One section per project that declares its own harness (ADR-039). READ-ONLY. ---- */}
        {groups.map((group) => (
          <ProjectSection
            key={group.projectId}
            group={group}
            flags={flagsByProject.get(group.projectId) ?? []}
            state={projectsState}
          />
        ))}
      </div>

      {pending !== null && (
        <ConfirmDialog
          preview={pending.preview}
          headline={pending.headline}
          restorePointNote={restoreNoteFor(pending.actionType)}
          confirmLabel={pending.confirmLabel}
          busy={busy}
          onCancel={() => {
            // §5.5 — ABORTED. Nothing happened, nothing was promised, and no audit row is written.
            setPending(null);
          }}
          onConfirm={() => {
            void runPending();
          }}
        />
      )}
    </ViewShell>
  );
}

// ---------------------------------------------------------------------------
// Collapsible section — native <details>/<summary>: keyboard-navigable, focus-ringed, and it
// neither animates nor reflows anything but itself when toggled (FRONTEND §7, §6.12).
// ---------------------------------------------------------------------------

function HarnessSection({
  title,
  subtitle,
  defaultOpen = false,
  testId,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  testId?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <details
      open={defaultOpen}
      data-testid={testId}
      className="rounded-card border border-border bg-bg-surface"
    >
      {/* Focus ring comes from the global `summary:focus-visible` rule in tokens.css (§6.12). */}
      <summary className="flex cursor-pointer list-none flex-col gap-1 rounded-card px-5 py-4 [&::-webkit-details-marker]:hidden">
        <span className="text-h3 text-text-primary">{title}</span>
        {subtitle !== undefined && <span className="text-small text-text-muted">{subtitle}</span>}
      </summary>
      <div className="flex flex-col gap-4 border-t border-border p-5">{children}</div>
    </details>
  );
}

/** One project's read-only harness (ADR-039). Sub-panels render only when they have content. */
function ProjectSection({
  group,
  flags,
  state,
}: {
  group: ProjectHarnessGroup;
  flags: BloatFlag[];
  state: PanelState;
}): JSX.Element {
  const hasPlugins = group.plugins.marketplaces.length + group.plugins.plugins.length > 0;
  return (
    <HarnessSection
      // §3.3 — the full folder name, consumed as given; never re-derived.
      title={group.displayName}
      subtitle="This project’s own skills and agents. Read-only — Claude Lens never changes files inside your projects."
      defaultOpen
      testId="harness-section-project"
    >
      <BloatRadar
        flags={flags}
        loading={state.loading}
        error={state.error}
        onRetry={state.refetch}
        // Read-only: a project file is never a guarded-action target (ADR-039).
        readOnly
        // §6.9's celebratory empty state, per project.
        emptyReason="Nothing to clean here — this project looks tidy."
      />
      {group.skills.length > 0 && <SkillsPanel rows={group.skills} state={state} />}
      {group.agents.length > 0 && <AgentsPanel agents={group.agents} state={state} />}
      {group.claudeMd.length > 0 && <ProjectClaudeMdPanel rows={group.claudeMd} state={state} />}
      {group.memories.length > 0 && <MemoriesPanel rows={group.memories} state={state} />}
      {hasPlugins && (
        <PluginsPanel
          state={{
            ...state,
            data: { marketplaces: group.plugins.marketplaces, plugins: group.plugins.plugins },
          }}
        />
      )}
    </HarnessSection>
  );
}

// ---------------------------------------------------------------------------
// Bloat Radar — §6.9's 2-column grid, now scoped to one section
// ---------------------------------------------------------------------------

function BloatRadar({
  flags,
  loading,
  error,
  onRetry,
  onAction,
  emptyReason,
  readOnly = false,
}: {
  flags: BloatFlag[];
  loading: boolean;
  error: AppError | null;
  onRetry: () => void;
  onAction?: (flag: BloatFlag) => Promise<void>;
  emptyReason: string;
  readOnly?: boolean;
}): JSX.Element {
  return (
    <div className="col-span-12">
      <ChartCard
        title="Bloat Radar"
        subtitle={loading || error !== null ? undefined : issuesSummary(flags)}
        loading={loading}
        error={error}
        empty={!loading && error === null && flags.length === 0}
        emptyReason={emptyReason}
        onRetry={onRetry}
        bodyClassName="p-6"
      >
        <div className="grid gap-4 md:grid-cols-2">
          {flags.map((flag) => (
            <BloatCard
              key={flag.id}
              flag={flag}
              readOnly={readOnly}
              onAction={
                onAction === undefined
                  ? undefined
                  : () => {
                      void onAction(flag);
                    }
              }
            />
          ))}
        </div>
      </ChartCard>
    </div>
  );
}

function BloatCard({
  flag,
  onAction,
  readOnly,
}: {
  flag: BloatFlag;
  onAction?: () => void;
  readOnly: boolean;
}): JSX.Element {
  // A project flag (read-only) never gets a button; neither does an actionless rule (BR-03/BR-05).
  const actionable = !readOnly && flag.actionType !== null && onAction !== undefined;
  return (
    <article
      data-testid="bloat-card"
      data-rule={flag.ruleId}
      className="flex flex-col gap-3 rounded-card border border-border bg-bg-surface-2 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* FRONTEND §8 — severity is paired with the WORD, never colour alone. */}
        <SeverityBadge severity={flag.severity} />
        <span className="text-body text-text-primary">{flag.title}</span>
      </div>
      <p className="font-mono text-micro break-all text-text-muted">{flag.location}</p>
      <p className="text-small text-text-muted">
        {formatBytes(flag.sizeBytes)} · {formatInteger(flag.itemCount)} item
        {flag.itemCount === 1 ? '' : 's'}
      </p>
      {/* §3.12 — "why flagged", rendered verbatim. */}
      <p className="text-small text-text-primary">{flag.rationale}</p>
      {actionable ? (
        <button
          data-testid="bloat-action"
          type="button"
          onClick={onAction}
          className="self-start rounded-control border border-border px-3 py-1 text-small text-text-primary"
        >
          {buttonLabelFor(flag.actionType as ActionType)}
        </button>
      ) : readOnly ? (
        // ADR-039 — a project's own file; the app never changes files inside a project.
        <p data-testid="read-only-label" className="text-small text-text-faint">
          read-only — inside a project folder
        </p>
      ) : (
        // ⚠️ §3.12 / §5.11 BR-03 — a flag with NO button and this exact label. Deliberate.
        <p data-testid="no-action-label" className="text-small text-text-faint">
          no automatic action in v1
        </p>
      )}
    </article>
  );
}

/** §5.7's catalogue, in the user's words. Never a raw action id on screen. */
function buttonLabelFor(actionType: ActionType): string {
  switch (actionType) {
    case 'delete-orphan-skill-folders':
      return 'Delete folder…';
    case 'clear-plugin-cache':
      return 'Clear cache…';
    case 'delete-duplicate-config-backups':
      return 'Delete copies…';
    case 'restore-claude-md':
      return 'Restore from backup…';
    case 'delete-empty-claude-md':
      return 'Delete empty file…';
    case 'clear-backups':
      return 'Clear restore points…';
    case 'archive-sessions':
      return 'Archive…';
  }
}

function headlineFor(actionType: ActionType, preview: ActionPreview): string {
  if (actionType === 'archive-sessions') {
    // §6.9, in the user's own terms, verbatim.
    return 'These transcripts move to your archive folder. Every chart keeps counting them. Nothing is deleted, and this is undoable.';
  }
  if (actionType === 'restore-claude-md') {
    return 'Overwrite this CLAUDE.md with the backup beside it. The current file is copied to a restore point first.';
  }
  if (actionType === 'clear-backups') {
    return "Remove Claude Lens's own restore points. The actions they belonged to stay in the audit log, but they can no longer be undone.";
  }
  return `Delete ${String(preview.targets.length)} item${preview.targets.length === 1 ? '' : 's'} from your Claude data directory.`;
}

function confirmLabelFor(actionType: ActionType, preview: ActionPreview): string {
  const count = preview.targets.length;
  if (actionType === 'archive-sessions') return 'Archive';
  if (actionType === 'restore-claude-md') return 'Restore';
  return `Delete ${String(count)} item${count === 1 ? '' : 's'}`;
}

/** §5.5 rule 1 / INV-07 — what the restore point will be, promised before the act. */
function restoreNoteFor(actionType: ActionType): string {
  if (actionType === 'archive-sessions') {
    // ADR-034 — a manifest, not copies, and why that is still a sufficient restore point.
    return 'A move manifest is written to .claude-lens-backups/ first. Undo checks every file’s size and date before moving it back, and refuses if anything changed. Nothing is copied, so archiving does not consume the disk you are freeing.';
  }
  if (actionType === 'clear-backups') {
    return 'This is the one action with no restore point of its own — it is the restore points. Nothing else is touched, and no audit entry is deleted.';
  }
  return 'A copy of everything listed above is written to .claude-lens-backups/ before anything is changed. If that copy cannot be made, nothing is changed at all. Restore points are never deleted automatically.';
}

// ---------------------------------------------------------------------------
// §6.9's tables — reused for both the shared section and the project sections
// ---------------------------------------------------------------------------

interface PanelState {
  loading: boolean;
  error: AppError | null;
  refetch: () => void;
}

const SKILL_COLUMNS: Column<SkillRow>[] = [
  { id: 'name', header: 'Skill', render: (row) => row.name },
  {
    id: 'source',
    header: 'Source',
    render: (row) => (row.pluginName === null ? row.source : `${row.source} · ${row.pluginName}`),
  },
  {
    id: 'invocations',
    header: 'Invocations (all time)',
    numeric: true,
    render: (row) =>
      row.neverUsed ? (
        // §6.9 — "a `--danger`-tinted count chip for zero", paired with the word (FRONTEND §8).
        <Badge tone="danger" data-testid="never-used-chip">
          never used
        </Badge>
      ) : (
        formatInteger(row.invocations)
      ),
  },
  {
    id: 'lastUsed',
    header: 'Last used (all time)',
    render: (row) => (row.lastUsedTs === null ? '—' : formatTimestamp(row.lastUsedTs)),
  },
  { id: 'size', header: 'Size', numeric: true, render: (row) => formatBytes(row.sizeBytes) },
];

function SkillsPanel({ rows, state }: { rows: SkillRow[]; state: PanelState }): JSX.Element {
  return (
    <div className="col-span-12">
      <ChartCard
        title="Skills"
        subtitle="Invocations and “last used” are over the whole dataset — never the current filter."
        loading={state.loading}
        error={state.error}
        empty={!state.loading && state.error === null && rows.length === 0}
        emptyReason="No skills found — run a harness scan, or you have none installed."
        onRetry={state.refetch}
        bodyClassName="p-0"
      >
        <DataTable
          columns={SKILL_COLUMNS}
          rows={rows}
          rowKey={(row) => `${row.relPath}|${row.name}`}
          caption="Installed skills, sorted by installed-but-never-used. Counts are all time."
          data-testid="skills-table"
        />
      </ChartCard>
    </div>
  );
}

/** §6.9 — a project's own agent definitions (ADR-039). Read-only, so never an action button. */
function AgentsPanel({
  agents,
  state,
}: {
  agents: ProjectHarnessAgent[];
  state: PanelState;
}): JSX.Element {
  return (
    <div className="col-span-12">
      <ChartCard
        title="Agents"
        subtitle="Agent definitions this project declares in its own .claude/agents folder."
        loading={state.loading}
        error={state.error}
        empty={!state.loading && state.error === null && agents.length === 0}
        emptyReason="No agents found in this project."
        onRetry={state.refetch}
        bodyClassName="p-6"
      >
        <ul className="flex flex-col gap-2">
          {agents.map((agent) => (
            <li
              key={`${agent.relPath}|${agent.name}`}
              data-testid="agent-row"
              className="flex flex-wrap items-center gap-3"
            >
              <span className="text-body text-text-primary">{agent.name}</span>
              <span className="font-mono text-micro break-all text-text-muted">
                {agent.relPath}
              </span>
              <span className="text-small text-text-muted">{formatBytes(agent.sizeBytes)}</span>
            </li>
          ))}
        </ul>
      </ChartCard>
    </div>
  );
}

function ClaudeMdPanel({
  state,
  flags,
  onAction,
}: {
  state: PanelState & {
    data: {
      rows: {
        relPath: string;
        sizeBytes: number;
        mtimeMs: number;
        backups: { relPath: string; sizeBytes: number }[];
      }[];
    } | null;
  };
  flags: BloatFlag[];
  onAction: (flag: BloatFlag) => Promise<void>;
}): JSX.Element {
  const rows = state.data?.rows ?? [];
  return (
    <div className="col-span-12">
      <ChartCard
        title="CLAUDE.md inspector"
        subtitle="Every CLAUDE.md with its sibling backups. The empty-file-with-a-non-empty-backup case is the headline row."
        loading={state.loading}
        error={state.error}
        empty={!state.loading && state.error === null && rows.length === 0}
        emptyReason="No CLAUDE.md files found."
        onRetry={state.refetch}
        bodyClassName="p-6"
      >
        <ul className="flex flex-col gap-3">
          {rows.map((row) => {
            const flag = flags.find(
              (candidate) => candidate.ruleId === 'BR-01' && candidate.location === row.relPath,
            );
            return (
              <li
                key={row.relPath}
                data-testid="claude-md-row"
                className="flex flex-wrap items-center gap-3 border-b border-border pb-3 last:border-b-0"
              >
                <span className="font-mono text-micro break-all text-text-primary">
                  {row.relPath}
                </span>
                <span className="text-small text-text-muted">
                  {formatBytes(row.sizeBytes)} · {formatTimestamp(row.mtimeMs)}
                </span>
                {row.sizeBytes === 0 && <Badge tone="danger">empty</Badge>}
                {row.backups.map((backup) => (
                  <Badge key={backup.relPath} tone="info">
                    {backup.relPath.split('/').pop() ?? backup.relPath} ·{' '}
                    {formatBytes(backup.sizeBytes)}
                  </Badge>
                ))}
                {flag !== undefined && (
                  <button
                    data-testid="claude-md-action"
                    type="button"
                    onClick={() => {
                      void onAction(flag);
                    }}
                    className="rounded-control border border-border px-3 py-1 text-small text-text-primary"
                  >
                    Restore from backup…
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </ChartCard>
    </div>
  );
}

/**
 * §6.9 — a project's own CLAUDE.md files (ADR-039). Read-only: a project file is outside the
 * Claude data directory, so it has no sibling-backup set here and never a restore button.
 */
function ProjectClaudeMdPanel({
  rows,
  state,
}: {
  rows: ProjectHarnessClaudeMd[];
  state: PanelState;
}): JSX.Element {
  return (
    <div className="col-span-12">
      <ChartCard
        title="CLAUDE.md"
        subtitle="The instructions this project gives its main loop. Shown for reference — never changed."
        loading={state.loading}
        error={state.error}
        empty={!state.loading && state.error === null && rows.length === 0}
        emptyReason="No CLAUDE.md in this project."
        onRetry={state.refetch}
        bodyClassName="p-6"
      >
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li
              key={row.relPath}
              data-testid="project-claude-md-row"
              className="flex flex-wrap items-center gap-3"
            >
              <span className="font-mono text-micro break-all text-text-primary">
                {row.relPath}
              </span>
              <span className="text-small text-text-muted">
                {formatBytes(row.sizeBytes)} · {formatTimestamp(row.mtimeMs)}
              </span>
              {row.sizeBytes === 0 && <Badge tone="danger">empty</Badge>}
            </li>
          ))}
        </ul>
      </ChartCard>
    </div>
  );
}

function PluginsPanel({
  state,
}: {
  state: PanelState & {
    data: {
      marketplaces: MarketplaceRow[];
      plugins: PluginRow[];
    } | null;
  };
}): JSX.Element {
  const marketplaces = state.data?.marketplaces ?? [];
  const plugins = state.data?.plugins ?? [];
  return (
    <div className="col-span-12">
      <ChartCard
        title="Plugins & marketplaces"
        subtitle="Enabled versus merely cached, with disk cost each."
        loading={state.loading}
        error={state.error}
        empty={!state.loading && state.error === null && marketplaces.length + plugins.length === 0}
        emptyReason="No plugins or marketplaces installed."
        onRetry={state.refetch}
        bodyClassName="p-6"
      >
        <ul className="flex flex-col gap-2">
          {marketplaces.map((marketplace) => (
            <li
              key={`m${String(marketplace.id)}`}
              data-testid="marketplace-row"
              className="flex flex-wrap items-center gap-3"
            >
              <Badge tone="neutral">marketplace</Badge>
              <span className="text-body text-text-primary">{marketplace.name}</span>
              <span className="text-small text-text-muted">
                {formatInteger(marketplace.pluginCount)} plugins ·{' '}
                {formatBytes(marketplace.sizeBytes)}
              </span>
            </li>
          ))}
          {plugins.map((plugin) => (
            <li
              key={`p${String(plugin.id)}`}
              data-testid="plugin-row"
              className="flex flex-wrap items-center gap-3"
            >
              {/* Never colour alone: the word is the message (FRONTEND §8). */}
              <Badge tone={plugin.enabled === true ? 'ok' : 'warn'}>
                {plugin.enabled === true ? 'enabled' : 'cached, not enabled'}
              </Badge>
              <span className="text-body text-text-primary">{plugin.name}</span>
              <span className="text-small text-text-muted">
                {plugin.marketplaceName ?? 'no marketplace'} · {formatBytes(plugin.sizeBytes)}
              </span>
            </li>
          ))}
        </ul>
      </ChartCard>
    </div>
  );
}

function MemoriesPanel({
  rows,
  state,
}: {
  rows: { relPath: string; sizeBytes: number; mtimeMs: number; entryCount: number }[];
  state: PanelState;
}): JSX.Element {
  return (
    <div className="col-span-12">
      <ChartCard
        title="Memory browser"
        // ⚠️ The definition travels with the number. DESIGN.md defines no "entry" for a MEMORY.md,
        // so the counted rule is stated rather than showing a figure nothing stands behind.
        subtitle="Entries are counted as markdown list items."
        loading={state.loading}
        error={state.error}
        empty={!state.loading && state.error === null && rows.length === 0}
        emptyReason="No MEMORY.md files found."
        onRetry={state.refetch}
        bodyClassName="p-6"
      >
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.relPath}
              data-testid="memory-row"
              className="flex flex-wrap items-center gap-3"
            >
              <span className="font-mono text-micro break-all text-text-primary">
                {row.relPath}
              </span>
              <span className="text-small text-text-muted">
                {formatInteger(row.entryCount)} entries · {formatBytes(row.sizeBytes)} · last
                changed {formatTimestamp(row.mtimeMs)}
              </span>
            </li>
          ))}
        </ul>
      </ChartCard>
    </div>
  );
}

/** Kept so an unused-import lint cannot quietly drop the shared empty state. */
export const HARNESS_EMPTY_STATE = EmptyState;

/** Re-exported for the view test, which asserts the label §5.11 BR-03 requires. */
export const NO_ACTION_LABEL: ReactNode = 'no automatic action in v1';
