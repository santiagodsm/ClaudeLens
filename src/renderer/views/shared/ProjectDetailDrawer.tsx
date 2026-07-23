/**
 * The one project-detail surface (user directive 2026-07-22, asked for in three places):
 *
 *   "output tokens by project — the project should be clickable, I go into the project and see
 *    all the project stats"
 *   "in Projects & Code the projects should be clickable and provide the statistics"
 *
 * ⚠️ **One destination, two doors.** A right-hand drawer — the same pattern as the session
 * drill-down (§6.5), deliberately not a route, so opening it changes nothing about the view
 * behind it — opened both by clicking a **Projects & Code card** (§6.8) and by clicking a
 * **treemap tile** in Tokens & Cost (§6.4). Both doors pass one thing: the project **unit id**.
 *
 * ⚠️ **It composes existing scoped `q:*` channels rather than adding a new one.** The global
 * filter already carries `projectIds` (§4.2, ADR-040), and a single-project scope is exactly
 * `projectIds: [unitId]`; the shell expands a unit id to its real project ids in one place
 * (`queryContext`), so a **group** scopes to all its folders and its detail shows the group —
 * §6.8's grouped card, opened. No `q:projectDetail` handler is added, so there is no handler
 * that nothing calls.
 *
 * ⚠️ **Plain language throughout** (§1a): no metric ids, no channel names, no section numbers.
 * Every `$` keeps its list-price caveat and its uncosted disclosure (§6.12, INV-10).
 */

import { useMemo } from 'react';
import type { JSX } from 'react';
import type { ProjectCard } from '../../../shared/ipc-contract';
import { DataTable } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useQuery } from '../../hooks/use-query';
import { categoricalVar } from '../../lib/colors';
import { formatCost, formatDuration, formatInteger, formatTimestamp } from '../../lib/format';
import { DEFAULT_PAGE_LIMIT } from '../../lib/limits';
import { useAppStore } from '../../store/app-store';
import { Drawer } from './Drawer';
import { costDisclosureBlock } from './disclosures';

/** How many tools the "most-used tools" list shows before it stops; the rest are summarised. */
const TOP_TOOLS = 8;

export interface ProjectDetailDrawerProps {
  /** The project **unit id** to show, or `null` when the drawer is closed. */
  projectId: number | null;
  onClose: () => void;
}

export function ProjectDetailDrawer({ projectId, onClose }: ProjectDetailDrawerProps): JSX.Element {
  const open = projectId !== null;
  const filter = useAppStore((state) => state.filter);
  const idleGapMinutes = useAppStore((state) => state.settings?.idleGapMinutes ?? null);
  const disclosures = useAppStore((state) => state.disclosures);

  // A single-project scope IS `projectIds: [unitId]` (§4.2). Everything below reads this project
  // only, so the uncosted disclosure and every count belong to it and not to the whole dataset.
  const scoped = useMemo(
    () => ({ ...filter, projectIds: projectId === null ? null : [projectId] }),
    [filter, projectId],
  );

  const cards = useQuery('q:projectCards', scoped, { enabled: open });
  const tools = useQuery('q:toolFingerprint', scoped, { enabled: open });
  const models = useQuery(
    'q:tokensByModel',
    { ...scoped, mode: 'output_only', bucket: 'day' },
    { enabled: open },
  );
  const files = useQuery(
    'q:fileMetrics',
    { ...scoped, ...(projectId === null ? {} : { projectId }), limit: DEFAULT_PAGE_LIMIT },
    { enabled: open },
  );

  const card =
    cards.data?.rows.find((row) => row.projectId === projectId) ?? cards.data?.rows[0] ?? null;

  return (
    <Drawer
      open={open}
      title={card?.displayName ?? 'Project'}
      subtitle={<DateRange buckets={models.data?.buckets ?? null} />}
      onClose={onClose}
      data-testid="project-detail-drawer"
    >
      {cards.error !== null ? (
        <ErrorState
          error={cards.error}
          onRetry={cards.refetch}
          data-testid="project-detail-error"
        />
      ) : card === null ? (
        cards.loading ? (
          <LoadingState lines={6} label="Loading project detail" />
        ) : (
          <EmptyState reason="That project is no longer in this range" />
        )
      ) : (
        <ProjectDetailBody
          card={card}
          uncosted={cards.data?.uncosted ?? null}
          idleGapMinutes={idleGapMinutes}
          disclosures={disclosures}
          tools={tools.data}
          models={models.data}
          files={files.data}
          filesLoading={files.loading && files.data === null}
        />
      )}
    </Drawer>
  );
}

function ProjectDetailBody({
  card,
  uncosted,
  idleGapMinutes,
  disclosures,
  tools,
  models,
  files,
  filesLoading,
}: {
  card: ProjectCard;
  uncosted: {
    records: number;
    byModel: { model: string; records: number; fromTs: number; toTs: number }[];
  } | null;
  idleGapMinutes: number | null;
  disclosures: ReturnType<typeof useAppStore.getState>['disclosures'];
  tools: { total: number; distinct: number; rows: { toolName: string; count: number }[] } | null;
  models: { series: { model: string; colorIndex: number; data: number[] }[] } | null;
  files: {
    rows: { path: string; language: string | null; edits: number; lastTs: number }[];
    totalKnown: number | null;
  } | null;
  filesLoading: boolean;
}): JSX.Element {
  const grouped = card.groupId !== null;
  const activeNote =
    idleGapMinutes === null ? 'summed per day' : `idle gaps >${String(idleGapMinutes)}m removed`;

  return (
    <>
      {/* The headline stats, in plain words. */}
      <dl className="grid grid-cols-2 gap-3 text-small">
        <Stat
          label="Output tokens"
          value={formatInteger(card.outputTokens)}
          testId="project-detail-output"
        />
        <Stat
          label="Sessions"
          value={formatInteger(card.sessions)}
          testId="project-detail-sessions"
        />
        <Stat
          label="Tool calls"
          value={formatInteger(card.toolCalls)}
          testId="project-detail-toolcalls"
        />
        <Stat
          label="Active time"
          value={formatDuration(card.activeSeconds)}
          note={activeNote}
          testId="project-detail-active"
        />
      </dl>

      {/* Cost — never `$0.00`, always with its list-price caveat and any uncosted disclosure. */}
      <section aria-label="Cost" className="flex flex-col gap-1">
        <h3 className="text-micro uppercase text-text-muted">Cost</h3>
        <p className="text-h3 font-bold text-text-primary" data-testid="project-detail-cost">
          {card.costNanoUsd === null ? '—' : formatCost(card.costNanoUsd)}
        </p>
        <p className="text-small text-text-muted" data-testid="project-detail-cost-disclosure">
          {costDisclosureBlock(
            card.costNanoUsd,
            uncosted ?? { records: 0, byModel: [] },
            disclosures,
          )}
        </p>
      </section>

      {grouped && <GroupFolders card={card} />}

      {/* Model mix — which models did the work here, by output tokens. */}
      <ModelMix models={models} />

      {/* Most-used tools. */}
      <ToolList tools={tools} />

      {/* Files touched and how many times each was edited (never lines changed). */}
      <FilesSection files={files} loading={filesLoading} />
    </>
  );
}

function DateRange({ buckets }: { buckets: string[] | null }): JSX.Element {
  if (buckets === null || buckets.length === 0) {
    return <span data-testid="project-detail-range">No activity in this range</span>;
  }
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  return (
    <span data-testid="project-detail-range">
      Active {first === last ? first : `${String(first)} to ${String(last)}`}
    </span>
  );
}

function ModelMix({
  models,
}: {
  models: { series: { model: string; colorIndex: number; data: number[] }[] } | null;
}): JSX.Element {
  const rows = useMemo(() => {
    if (models === null) return [];
    return models.series
      .map((series) => ({
        model: series.model,
        colorIndex: series.colorIndex,
        total: series.data.reduce((sum, value) => sum + value, 0),
      }))
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [models]);

  const max = rows[0]?.total ?? 0;

  return (
    <section
      aria-label="Models"
      className="flex flex-col gap-2"
      data-testid="project-detail-models"
    >
      <h3 className="text-micro uppercase text-text-muted">Models used (by output tokens)</h3>
      {models === null ? (
        <LoadingState variant="inline" label="Loading models" />
      ) : rows.length === 0 ? (
        <p className="text-small text-text-muted">No assistant output in this range</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.model} className="flex items-center gap-3 text-small">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ background: categoricalVar(row.colorIndex) }}
              />
              <span className="min-w-0 flex-1 truncate text-text-primary">{row.model}</span>
              <span
                aria-hidden="true"
                className="h-2 rounded-pill"
                style={{
                  width: `${String(max === 0 ? 0 : Math.max(6, (row.total / max) * 96))}px`,
                  background: categoricalVar(row.colorIndex),
                  opacity: 0.55,
                }}
              />
              <span className="w-16 text-right tabular-nums text-text-muted">
                {formatInteger(row.total)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ToolList({
  tools,
}: {
  tools: { total: number; distinct: number; rows: { toolName: string; count: number }[] } | null;
}): JSX.Element {
  return (
    <section aria-label="Tools" className="flex flex-col gap-2" data-testid="project-detail-tools">
      <h3 className="text-micro uppercase text-text-muted">Most-used tools</h3>
      {tools === null ? (
        <LoadingState variant="inline" label="Loading tools" />
      ) : tools.rows.length === 0 ? (
        <p className="text-small text-text-muted">No tool calls in this range</p>
      ) : (
        <>
          <ul className="flex flex-col gap-1 text-small">
            {tools.rows.slice(0, TOP_TOOLS).map((tool) => (
              <li key={tool.toolName} className="flex justify-between gap-3">
                <span className="text-text-primary">{tool.toolName}</span>
                <span className="tabular-nums text-text-muted">{formatInteger(tool.count)}</span>
              </li>
            ))}
          </ul>
          <p className="text-micro text-text-faint">
            {formatInteger(tools.total)} tool calls across {formatInteger(tools.distinct)} different
            tools.
          </p>
        </>
      )}
    </section>
  );
}

function FilesSection({
  files,
  loading,
}: {
  files: {
    rows: { path: string; language: string | null; edits: number; lastTs: number }[];
    totalKnown: number | null;
  } | null;
  loading: boolean;
}): JSX.Element {
  return (
    <section aria-label="Files" className="flex flex-col gap-2" data-testid="project-detail-files">
      <h3 className="text-micro uppercase text-text-muted">Files touched</h3>
      {/* ⚠️ "Edits", never "lines changed"; no diff is rendered anywhere (§1.6 non-goal 3, M-15). */}
      <p className="text-micro text-text-faint">
        How many times a file was edited in this range — never lines changed, and no diff is shown.
      </p>
      {loading ? (
        <LoadingState variant="inline" label="Loading files" />
      ) : files === null || files.rows.length === 0 ? (
        <p className="text-small text-text-muted">No file edits recorded in this range</p>
      ) : (
        <DataTable
          rows={files.rows}
          rowKey={(row) => row.path}
          caption="Files touched, by edit count"
          data-testid="file-metrics-table"
          columns={[
            {
              id: 'path',
              header: 'File',
              render: (row) => (
                <span className="font-mono text-micro text-text-primary">{row.path}</span>
              ),
            },
            {
              id: 'language',
              header: 'Language',
              // Anything unmapped is surfaced as "other", never guessed (M-15).
              render: (row) => row.language ?? 'other',
            },
            {
              id: 'edits',
              header: 'Edits',
              numeric: true,
              render: (row) => formatInteger(row.edits),
            },
            {
              id: 'lastTs',
              header: 'Last touched',
              numeric: true,
              render: (row) => formatTimestamp(row.lastTs),
            },
          ]}
        />
      )}
    </section>
  );
}

/**
 * §6.8 — the folders inside a group, each with its own numbers, and the plain-words explanation
 * of why those numbers do not add up to the card's active time. This sentence is **not optional**
 * (§1a): two columns that look like they should add up and do not are a defect in the same family
 * as a wrong number.
 */
function GroupFolders({ card }: { card: ProjectCard }): JSX.Element {
  return (
    <section
      aria-label="Folders"
      className="flex flex-col gap-2"
      data-testid="project-group-members"
    >
      <h3 className="text-micro uppercase text-text-muted">Folders in this project</h3>
      <p className="text-small text-text-muted">
        You said these {String(card.members.length)} folders are the same project. Each
        folder&apos;s own numbers, as if you had never said so:
      </p>
      <DataTable
        rows={card.members}
        rowKey={(row) => row.encodedName}
        caption="Folders in this project"
        data-testid="group-members-table"
        columns={[
          {
            id: 'folder',
            header: 'Folder',
            // §3.3, §7.8/P-33 — the display name (folder basename) is the only project string
            // that may be visible; the encoded name is an absolute personal path and appears on
            // hover only, to disambiguate two folders that share a basename.
            render: (row) => (
              <span className="font-mono text-micro text-text-primary" title={row.encodedName}>
                {row.displayName}
              </span>
            ),
          },
          {
            id: 'sessions',
            header: 'Sessions',
            numeric: true,
            render: (row) => formatInteger(row.sessions),
          },
          {
            id: 'outputTokens',
            header: 'Output',
            numeric: true,
            render: (row) => formatInteger(row.outputTokens),
          },
          {
            id: 'toolCalls',
            header: 'Tool calls',
            numeric: true,
            render: (row) => formatInteger(row.toolCalls),
          },
          {
            id: 'activeSeconds',
            header: 'Active on its own',
            numeric: true,
            render: (row) => formatDuration(row.activeSeconds),
          },
        ]}
      />
      <p className="text-small text-text-muted">
        These folder times do not add up to the {formatDuration(card.activeSeconds)} above, and that
        is correct. Now that the folders are one project, time spent moving between them on the same
        day counts as time on that project instead of being dropped at each folder&apos;s edge.
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string;
  note?: string;
  testId: string;
}): JSX.Element {
  return (
    <div data-testid={testId}>
      <dt className="text-micro uppercase text-text-muted">{label}</dt>
      <dd
        className="text-h3 font-bold text-text-primary"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </dd>
      {note !== undefined && <dd className="text-micro text-text-faint">{note}</dd>}
    </div>
  );
}
