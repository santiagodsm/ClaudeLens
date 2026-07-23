/**
 * Sessions & Time — `view-sessions` (DESIGN §6.5).
 *
 * ⚠️ **Three different active-time bindings are visible on this one screen and they are not
 * interchangeable** (§5.9 M-07, ADR-036). The design calls the asymmetry out with M-10
 * explicitly, so the surface must too:
 *   · the **histogram** and every `Active` cell in the table are binding **(A)** — one session;
 *   · **Longest marathons** ranks **working days**, binding **(B)** — `(local date, project)`.
 *     They are different nouns and may name different winners, which is why the card's subtitle
 *     says "working days" in its own words rather than leaving the reader to infer it.
 *
 * ⚠️ **No message content anywhere** (§1.6 non-goal 1). The drill-down shows identity, timing,
 * tokens, cost, the origin split, tool counts and subagent runs — metadata and structure only.
 * There is no channel that returns message text and this view asks for none.
 */

import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import type {
  AppError,
  SessionDetail,
  SessionRow,
  SessionSort,
  SessionsPage,
  WorkingDayRow,
} from '../../shared/ipc-contract';
import { Badge } from '../components/Badge';
import { ChartCard } from '../components/ChartCard';
import { DataTable } from '../components/DataTable';
import type { SortState } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { useQuery } from '../hooks/use-query';
import {
  formatCost,
  formatDuration,
  formatDurationShort,
  formatInteger,
  formatTimestamp,
} from '../lib/format';
import { DEFAULT_PAGE_LIMIT } from '../lib/limits';
import { ALL_TIME_ALL_PROJECTS, useAppStore } from '../store/app-store';
import { ViewShell } from '../shell/ViewShell';
import { GradientBars } from './charts/GradientBars';
import type { GradientBarRow } from './charts/GradientBars';
import { RhythmHeatmap } from './charts/RhythmHeatmap';
import { SessionLengthHistogram, bucketRangePhrase } from './charts/SessionLengthHistogram';
import type { SessionHistogramBucket } from './charts/SessionLengthHistogram';
import { Drawer } from './shared/Drawer';
import { SegmentedControl } from './shared/SegmentedControl';
import { UncostedLine, costDisclosure, localDayString } from './shared/disclosures';

/** §6.5 — "Longest marathons", a leaderboard rather than a table. */
const MARATHON_LIMIT = 10;

/**
 * How the marathon board is ordered. The rows `q:workingDays` returns are already **the marathon
 * set** — the working days with the most active time (M-07 binding (B)) — so ordering happens
 * client-side over those returned rows rather than through a new channel: the user is reordering
 * the leaderboard, not re-selecting it. Active time is the default and also how the set was
 * chosen, which is why the card subtitle keeps saying so.
 */
type MarathonSort = 'active' | 'span' | 'sessions' | 'date';
const MARATHON_SORTS: readonly { value: MarathonSort; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'span', label: 'Span' },
  { value: 'sessions', label: 'Sessions' },
  { value: 'date', label: 'Date' },
];

/**
 * How the marathon board is grouped. Ungrouped is the default flat leaderboard. "Project" gathers
 * a project's working days together — the answer to "which project ate the most marathon days".
 * ⚠️ These are still **working days**, never sessions (§6.5, M-10's asymmetry): grouping changes
 * only how the days are stacked on screen, never what a row counts.
 */
type MarathonGroup = 'none' | 'project' | 'week' | 'month';
const MARATHON_GROUPS: readonly { value: MarathonGroup; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'project', label: 'Project' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

/** §6.5's empty copy, verbatim. */
export const SESSIONS_EMPTY_REASON = 'No sessions in this range';

/** The sortable columns, keyed by the §4.5 `SessionSort` value the server sorts on. */
const SORTABLE: Record<string, SessionSort> = {
  firstTs: 'firstTs',
  messages: 'messages',
  outputTokens: 'outputTokens',
  activeSeconds: 'activeSeconds',
  spanSeconds: 'spanSeconds',
};

export function SessionsView(): JSX.Element {
  const filter = useAppStore((state) => state.filter);
  const setFilter = useAppStore((state) => state.setFilter);
  const idleGapMinutes = useAppStore((state) => state.settings?.idleGapMinutes ?? null);
  const partialBefore = useAppStore((state) => state.coverage?.partialBefore ?? null);

  const [sort, setSort] = useState<SortState>({ columnId: 'firstTs', direction: 'desc' });
  const [selected, setSelected] = useState<string | null>(null);

  // The histogram bucket the user clicked, if any — it narrows the sessions table below to the
  // sessions of that active-time range. `null` = the whole page (§6.5).
  const [bucket, setBucket] = useState<SessionHistogramBucket | null>(null);

  // Marathon-board display controls (client-side over the returned marathon set — see the types).
  const [marathonSort, setMarathonSort] = useState<MarathonSort>('active');
  const [marathonGroup, setMarathonGroup] = useState<MarathonGroup>('none');

  const histogram = useQuery('q:sessionHistogram', filter);
  const rhythm = useQuery('q:rhythmHeatmap', filter);
  const marathons = useQuery('q:workingDays', { ...filter, limit: MARATHON_LIMIT });
  const sessions = useQuery('q:sessions', {
    ...filter,
    limit: DEFAULT_PAGE_LIMIT,
    sort: SORTABLE[sort.columnId] ?? 'firstTs',
    dir: sort.direction,
  });
  const detail = useQuery(
    'q:sessionDetail',
    { sessionId: selected ?? '' },
    { enabled: selected !== null },
  );

  // §6.5 error row — "the table keeps the last good page and shows a retry strip". `useQuery`
  // drops `data` on error by design ("a number kept on screen after the query that produced it
  // failed is a number nothing is standing behind"), so the last good page is retained here and
  // is rendered **with** a visible staleness strip naming the failure. Retained-and-labelled is
  // what §6.5 asks for; retained and silent would be the failure CLAUDE.md §1 is about.
  //
  // Adjusted during render rather than in an effect — React's documented pattern for state
  // derived from a changing input, and the one that does not paint a frame of the wrong thing.
  const [retained, setRetained] = useState<SessionsPage | null>(null);
  if (sessions.data !== null && sessions.data !== retained) setRetained(sessions.data);

  const page = sessions.data ?? retained;
  const sessionCount = page?.page.totalKnown ?? null;
  const boundaryDay = partialBefore === null ? null : localDayString(partialBefore);

  // §6.5 — a clicked histogram bar filters the loaded sessions to that active-time range, in
  // plain words on the chip. This is a client-side filter of the page already on screen (the
  // table shows one page; there is no active-time argument on `q:sessions`), which is the
  // sanctioned choice over adding a channel.
  const allRows = page?.page.rows ?? [];
  const visibleRows =
    bucket === null
      ? allRows
      : allRows.filter(
          (row) =>
            row.activeSeconds >= bucket.lowerSeconds &&
            (bucket.upperSeconds === null || row.activeSeconds < bucket.upperSeconds),
        );

  return (
    <ViewShell
      id="sessions"
      heading={
        // §6.3 moved the session count here: "The session count moves to the Sessions & Time
        // header, where the prototype already shows it."
        <p className="text-body text-text-muted" data-testid="sessions-header">
          {sessionCount === null
            ? 'Sessions · click a row to inspect'
            : `${formatInteger(sessionCount)} session${sessionCount === 1 ? '' : 's'} · click a row to inspect`}
        </p>
      }
      secondary={
        <>
          <ChartCard
            title="Longest marathons"
            // ⚠️ The binding, in the card's own subtitle (§6.5). These rows are working days.
            // "Ranked by active time" describes how the set is CHOSEN (the marathon definition);
            // the Sort control below only reorders how those same days are shown.
            subtitle={`Working days — ranked by active time (idle gaps ${idleGapMinutes === null ? '' : `>${String(idleGapMinutes)}m `}removed)`}
            className="col-span-12"
            index={2}
            control={
              <div
                className="flex flex-wrap items-center gap-x-4 gap-y-2"
                data-testid="marathon-controls"
              >
                <div className="flex items-center gap-2 text-small text-text-muted">
                  <span aria-hidden="true">Sort</span>
                  <SegmentedControl
                    label="Sort working days by"
                    options={MARATHON_SORTS}
                    value={marathonSort}
                    onChange={setMarathonSort}
                    data-testid="marathon-sort"
                  />
                </div>
                <div className="flex items-center gap-2 text-small text-text-muted">
                  <span aria-hidden="true">Group</span>
                  <SegmentedControl
                    label="Group working days by"
                    options={MARATHON_GROUPS}
                    value={marathonGroup}
                    onChange={setMarathonGroup}
                    data-testid="marathon-group"
                  />
                </div>
              </div>
            }
            loading={marathons.loading && marathons.data === null}
            error={marathons.error}
            empty={marathons.data !== null && marathons.data.rows.length === 0}
            emptyReason="no working days in this range"
            onRetry={marathons.refetch}
            footer="A working day is one calendar day of work on a single project — not the same as a session."
            data-testid="sessions-marathons"
          >
            {marathons.data !== null && marathons.data.rows.length > 0 ? (
              <MarathonBoard
                rows={marathons.data.rows}
                sort={marathonSort}
                group={marathonGroup}
                boundaryDay={boundaryDay}
              />
            ) : undefined}
          </ChartCard>

          <ChartCard
            title="Sessions"
            subtitle="Active time here is measured per session, with idle gaps removed"
            className="col-span-12"
            index={3}
            loading={sessions.loading && page === null}
            error={page === null ? sessions.error : null}
            // The empty state is rendered as a child rather than through `empty`, because §6.5
            // asks for "a control to clear the global filter" beside the sentence and a bare
            // `EmptyState` reason cannot carry one.
            onRetry={sessions.refetch}
            disclosure={
              page !== null && page.uncosted.records > 0 ? (
                <UncostedLine uncosted={page.uncosted} />
              ) : undefined
            }
            data-testid="sessions-table-card"
          >
            {page !== null && page.page.rows.length > 0 ? (
              <div className="flex flex-col gap-3">
                {sessions.error !== null && (
                  <div
                    role="status"
                    data-testid="sessions-retry-strip"
                    className="flex items-center justify-between gap-3 rounded-control border border-border px-3 py-2 text-small text-text-muted"
                  >
                    <span>
                      Showing the last loaded page — this query failed ({sessions.error.code}).
                    </span>
                    <button
                      type="button"
                      onClick={sessions.refetch}
                      className="rounded-control border border-border px-3 py-1 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
                    >
                      Try again
                    </button>
                  </div>
                )}
                {bucket !== null && (
                  <div
                    role="status"
                    data-testid="sessions-bucket-chip"
                    className="flex items-center justify-between gap-3 rounded-control border border-border bg-bg-surface-2 px-3 py-2 text-small text-text-primary"
                  >
                    <span>
                      Showing sessions {bucketRangePhrase(bucket.lowerSeconds, bucket.upperSeconds)}
                    </span>
                    <button
                      type="button"
                      data-testid="sessions-bucket-clear"
                      onClick={() => {
                        setBucket(null);
                      }}
                      className="rounded-control border border-border px-3 py-1 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface"
                    >
                      Clear
                    </button>
                  </div>
                )}
                {visibleRows.length > 0 ? (
                  <SessionsTable
                    rows={visibleRows}
                    sort={sort}
                    onSortChange={setSort}
                    onRowActivate={(row) => {
                      setSelected(row.id);
                    }}
                  />
                ) : (
                  // The page has sessions, but none in the chosen length range. This is a
                  // property of the selection, not of the global filter, so the way out is to
                  // clear the bucket — not to clear the filter (§6.5).
                  <EmptyState
                    reason={`No sessions ${bucketRangePhrase(bucket?.lowerSeconds ?? 0, bucket?.upperSeconds ?? null)} on this page`}
                    action={
                      <button
                        type="button"
                        data-testid="sessions-bucket-clear-empty"
                        onClick={() => {
                          setBucket(null);
                        }}
                        className="rounded-control border border-border px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
                      >
                        Show all lengths
                      </button>
                    }
                    data-testid="sessions-bucket-empty"
                  />
                )}
              </div>
            ) : page !== null && page.page.rows.length === 0 ? (
              <EmptyState
                reason={SESSIONS_EMPTY_REASON}
                hint="The global filter is narrowing this list."
                action={
                  <button
                    type="button"
                    data-testid="clear-global-filter"
                    onClick={() => {
                      setFilter(ALL_TIME_ALL_PROJECTS);
                    }}
                    className="rounded-control border border-border px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
                  >
                    Clear the filter
                  </button>
                }
                data-testid="sessions-empty"
              />
            ) : sessions.loading ? (
              <LoadingState lines={8} label="Loading sessions" />
            ) : undefined}
          </ChartCard>

          <SessionDrawer
            open={selected !== null}
            loading={detail.loading}
            error={detail.error}
            detail={detail.data}
            onClose={() => {
              setSelected(null);
            }}
          />
        </>
      }
    >
      <div className="grid grid-cols-12" style={{ gap: 'var(--grid-gutter)' }}>
        <ChartCard
          title="Session length distribution"
          subtitle="One bar per session, grouped by how much active time it held"
          className="col-span-12 xl:col-span-6"
          index={0}
          loading={histogram.loading && histogram.data === null}
          error={histogram.error}
          empty={
            histogram.data !== null && histogram.data.buckets.every((bucket) => bucket.count === 0)
          }
          emptyReason={SESSIONS_EMPTY_REASON}
          onRetry={histogram.refetch}
          footer="Select a bar to list the sessions of that length below."
          data-testid="sessions-histogram"
        >
          {histogram.data !== null ? (
            <SessionLengthHistogram
              histogram={histogram.data}
              selectedLowerSeconds={bucket?.lowerSeconds ?? null}
              onSelectBucket={setBucket}
            />
          ) : undefined}
        </ChartCard>

        <ChartCard
          title="Rhythm"
          subtitle="Events by local hour and weekday"
          className="col-span-12 xl:col-span-6"
          index={1}
          loading={rhythm.loading && rhythm.data === null}
          error={rhythm.error}
          empty={rhythm.data !== null && rhythm.data.cells.length === 0}
          emptyReason="no events in this range"
          onRetry={rhythm.refetch}
          data-testid="sessions-rhythm"
        >
          {rhythm.data !== null && rhythm.data.cells.length > 0 ? (
            <RhythmHeatmap rhythm={rhythm.data} />
          ) : undefined}
        </ChartCard>
      </div>
    </ViewShell>
  );
}

/**
 * §6.5 "Longest marathons" — the working-day leaderboard, reorderable and groupable.
 *
 * ⚠️ Every row is a **working day** (M-07 binding (B)), never a session (M-10's asymmetry). Sort
 * and group only rearrange how the returned marathon set is shown; the bar always encodes the
 * day's active time, scaled against the same maximum across every group so lengths stay
 * comparable, and the trailing figures carry active, span and session count as text (FRONTEND §8
 * — the hue never carries meaning).
 */
function MarathonBoard({
  rows,
  sort,
  group,
  boundaryDay,
}: {
  rows: readonly WorkingDayRow[];
  sort: MarathonSort;
  group: MarathonGroup;
  boundaryDay: string | null;
}): JSX.Element {
  const sorted = useMemo(() => sortWorkingDays(rows, sort), [rows, sort]);
  const maxActive = sorted.reduce((highest, row) => Math.max(highest, row.activeSeconds), 0);

  const toBarRow = (row: WorkingDayRow, indexInGroup: number): GradientBarRow => ({
    id: `${row.day}-${String(row.projectId)}`,
    leading: `#${String(indexInGroup + 1)} ${row.day}`,
    label: row.displayName,
    trailing: `${formatDuration(row.activeSeconds)} active · ${formatDuration(row.spanSeconds)} span · ${formatInteger(row.sessions)} ${row.sessions === 1 ? 'session' : 'sessions'}`,
    value: row.activeSeconds,
    colorIndex: row.colorIndex,
    // §6.12 — "Marathon rows whose day precedes `partialBefore` are hatched."
    partial: boundaryDay !== null && row.day < boundaryDay,
  });

  if (group === 'none') {
    return (
      <GradientBars
        label="Longest working days by active time"
        max={maxActive}
        rows={sorted.map((row, index) => toBarRow(row, index))}
      />
    );
  }

  const groups = groupWorkingDays(sorted, group);
  return (
    <div className="flex flex-col gap-4">
      {groups.map((entry) => (
        <section
          key={entry.key}
          data-testid="marathon-group-section"
          aria-label={entry.label}
          className="flex flex-col gap-2"
        >
          <h3
            className="text-small font-semibold text-text-primary"
            data-testid="marathon-group-heading"
          >
            {entry.label}{' '}
            <span className="font-normal text-text-muted">
              · {formatInteger(entry.rows.length)} working{' '}
              {entry.rows.length === 1 ? 'day' : 'days'}
            </span>
          </h3>
          <GradientBars
            label={`Working days grouped under ${entry.label}`}
            max={maxActive}
            rows={entry.rows.map((row, index) => toBarRow(row, index))}
          />
        </section>
      ))}
    </div>
  );
}

/** Reorder the marathon set client-side; ties break to newest day then project for determinism. */
function sortWorkingDays(rows: readonly WorkingDayRow[], sort: MarathonSort): WorkingDayRow[] {
  const dayDesc = (a: WorkingDayRow, b: WorkingDayRow): number =>
    a.day < b.day ? 1 : a.day > b.day ? -1 : a.projectId - b.projectId;
  return [...rows].sort((a, b) => {
    switch (sort) {
      case 'span':
        return b.spanSeconds - a.spanSeconds || dayDesc(a, b);
      case 'sessions':
        return b.sessions - a.sessions || dayDesc(a, b);
      case 'date':
        return dayDesc(a, b);
      case 'active':
      default:
        return b.activeSeconds - a.activeSeconds || dayDesc(a, b);
    }
  });
}

interface MarathonGrouping {
  key: string;
  label: string;
  rows: WorkingDayRow[];
}

/**
 * Bucket the sorted days into groups, preserving the sort order so the strongest group (its top
 * row appears first) leads. "Project" answers "which project ate the most marathon days"; week and
 * month gather the days of one local calendar period (`day` is already a local date, ADR-021).
 */
function groupWorkingDays(rows: WorkingDayRow[], group: MarathonGroup): MarathonGrouping[] {
  const byKey = new Map<string, MarathonGrouping>();
  for (const row of rows) {
    const { key, label } = groupKeyOf(row, group);
    const existing = byKey.get(key);
    if (existing !== undefined) existing.rows.push(row);
    else byKey.set(key, { key, label, rows: [row] });
  }
  return [...byKey.values()];
}

function groupKeyOf(row: WorkingDayRow, group: MarathonGroup): { key: string; label: string } {
  if (group === 'project') return { key: `p${String(row.projectId)}`, label: row.displayName };
  if (group === 'month') {
    const key = row.day.slice(0, 7); // YYYY-MM
    const [year, month] = key.split('-').map(Number);
    const label = new Date(year ?? 1970, (month ?? 1) - 1, 1).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
    return { key, label };
  }
  // Week: the Monday of the day's local week, both as the key and, formatted, as the label.
  const monday = mondayOf(row.day);
  const key = `w${String(monday.getFullYear())}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  const label = `Week of ${monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return { key, label };
}

/** The Monday that starts the local week containing `day` (a `YYYY-MM-DD` local date). */
function mondayOf(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  const local = new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
  const sinceMonday = (local.getDay() + 6) % 7; // getDay: 0 = Sun … 6 = Sat
  local.setDate(local.getDate() - sinceMonday);
  return local;
}

function SessionsTable({
  rows,
  sort,
  onSortChange,
  onRowActivate,
}: {
  rows: SessionRow[];
  sort: SortState;
  onSortChange: (sort: SortState) => void;
  onRowActivate: (row: SessionRow) => void;
}): JSX.Element {
  return (
    <DataTable<SessionRow>
      rows={rows}
      rowKey={(row) => row.id}
      caption="Sessions in the current filter"
      sort={sort}
      onSortChange={onSortChange}
      onRowActivate={onRowActivate}
      data-testid="sessions-table"
      columns={[
        {
          id: 'firstTs',
          header: 'Session',
          sortable: true,
          render: (row) => (
            <span className="flex items-center gap-2">
              <span className="font-mono text-micro text-text-muted">{row.id.slice(0, 8)}</span>
              <span className="text-small text-text-muted">{formatTimestamp(row.firstTs)}</span>
              {/* §6.5 degraded — prompts exist, the transcript does not. */}
              {row.isPartial && (
                <Badge
                  tone="warn"
                  data-testid="session-partial-badge"
                  className="cursor-help"
                  // The explanation is text, not only a colour (FRONTEND §8).
                >
                  partial
                </Badge>
              )}
              <ArchivedBadge archiveRoot={row.archiveRoot} />
            </span>
          ),
        },
        {
          id: 'project',
          header: 'Project',
          render: (row) => <Badge colorIndex={row.colorIndex}>{row.displayName}</Badge>,
        },
        {
          id: 'model',
          header: 'Model',
          render: (row) => (
            <span className="font-mono text-micro text-text-muted">
              {row.primaryModel ?? 'no model recorded'}
            </span>
          ),
        },
        {
          id: 'messages',
          header: 'Msgs',
          numeric: true,
          sortable: true,
          render: (row) => formatInteger(row.messages),
        },
        {
          id: 'outputTokens',
          header: 'Output',
          numeric: true,
          sortable: true,
          render: (row) => formatInteger(row.tokens.output),
        },
        {
          id: 'activeSeconds',
          header: 'Active',
          numeric: true,
          sortable: true,
          render: (row) => formatDurationShort(row.activeSeconds),
        },
        {
          id: 'spanSeconds',
          header: 'Span',
          numeric: true,
          sortable: true,
          render: (row) => formatDurationShort(row.spanSeconds),
        },
      ]}
    />
  );
}

/**
 * §6.5 Degraded — "**Archived sessions carry a neutral 'archived' `Badge`** naming the archive
 * root — neutral, not a warning, because their numbers are complete and unchanged (INV-18)."
 *
 * ⚠️ **`tone="neutral"` is load-bearing and must stay neutral.** An archived session's totals,
 * active time and cost are byte-identical to what they were before the archive — that is INV-18,
 * and F-04 is the fixture that proves it. Styling this `--warn` or `--danger` would tell the user
 * their data is at risk when nothing about it changed but its location, which is a false statement
 * dressed as a colour (CLAUDE.md §1, FRONTEND §8).
 *
 * ⚠️ The root is named, not merely implied: §3.15 calls an archive you cannot find "a delete with
 * extra steps", and `archiveRoot` is the DESTINATION directory (§3.2 as amended by E10), so this
 * is the exact folder the transcripts are in. It comes from `sessions.archive_id → archives`
 * (ADR-033), never from overlapping an `archives:list` date range.
 *
 * Renders nothing at all for a live session — `archiveRoot === null` is not a degraded state.
 */
function ArchivedBadge({ archiveRoot }: { archiveRoot: string | null }): JSX.Element | null {
  if (archiveRoot === null) return null;
  return (
    <Badge tone="neutral" data-testid="session-archived-badge" className="max-w-full">
      <span>archived</span>
      <span className="truncate font-mono text-micro text-text-muted" title={archiveRoot}>
        {archiveRoot}
      </span>
    </Badge>
  );
}

/**
 * §6.5 — the drill-down drawer. "Identity, project, model, branch, CLI version, span vs active,
 * the five token classes (A-05), cost with disclosure, the origin split, the tool histogram, and the
 * list of subagent runs with `linked` shown honestly."
 */
function SessionDrawer({
  open,
  loading,
  error,
  detail,
  onClose,
}: {
  open: boolean;
  loading: boolean;
  error: AppError | null;
  detail: SessionDetail | null;
  onClose: () => void;
}): JSX.Element {
  return (
    <Drawer
      open={open}
      title="Session detail"
      subtitle={detail === null ? undefined : detail.id}
      onClose={onClose}
      data-testid="session-drawer"
    >
      {error !== null ? (
        <ErrorState error={error} data-testid="session-drawer-error" />
      ) : detail === null ? (
        loading ? (
          <LoadingState lines={6} label="Loading session detail" />
        ) : (
          <EmptyState reason="That session is no longer in the dataset" />
        )
      ) : (
        <>
          {/* §6.5 Degraded — the same neutral badge the table row carries, so opening the
              drawer never loses the fact that these transcripts live somewhere else now. */}
          <ArchivedBadge archiveRoot={detail.archiveRoot} />

          <dl className="grid grid-cols-2 gap-3 text-small">
            <Field label="Project" value={detail.displayName} />
            <Field label="Model" value={detail.primaryModel ?? 'no model recorded'} />
            <Field label="Branch" value={detail.gitBranch ?? 'none recorded'} />
            <Field label="CLI version" value={detail.cliVersion ?? 'none recorded'} />
            <Field label="Span" value={formatDuration(detail.spanSeconds)} />
            <Field
              label="Active"
              value={`${formatDuration(detail.activeSeconds)} (this session)`}
            />
            <Field label="Messages" value={formatInteger(detail.messages)} />
            <Field label="Tool calls" value={formatInteger(detail.toolCalls)} />
          </dl>

          <section aria-label="Tokens" className="flex flex-col gap-1">
            <h3 className="text-micro uppercase text-text-muted">Tokens</h3>
            <p className="text-small text-text-primary">
              {formatInteger(detail.tokens.input)} input · {formatInteger(detail.tokens.output)}{' '}
              output · {formatInteger(detail.tokens.cacheWrite)} cache write 5m ·{' '}
              {formatInteger(detail.tokens.cacheWrite1h)} cache write 1h ·{' '}
              {formatInteger(detail.tokens.cacheRead)} cache read
            </p>
          </section>

          <section aria-label="Cost" className="flex flex-col gap-1">
            <h3 className="text-micro uppercase text-text-muted">Cost</h3>
            {/* ⚠️ Never `$0.00` for an unknown cost; the disclosure sits with the figure. */}
            <p className="text-h3 font-bold text-text-primary" data-testid="drawer-cost">
              {detail.costNanoUsd === null ? '—' : formatCost(detail.costNanoUsd)}
            </p>
            <p className="text-small text-text-muted">
              {costDisclosure(detail.costNanoUsd, detail.uncosted)}
            </p>
          </section>

          <section aria-label="Origin split" className="flex flex-col gap-1">
            <h3 className="text-micro uppercase text-text-muted">Origin split</h3>
            <p className="text-small text-text-primary">
              main {formatInteger(detail.originSplit.main.output)} output · subagent{' '}
              {formatInteger(detail.originSplit.subagent.output)} output
            </p>
          </section>

          <section aria-label="Tool histogram" className="flex flex-col gap-2">
            <h3 className="text-micro uppercase text-text-muted">Tools</h3>
            {detail.toolCounts.length === 0 ? (
              <p className="text-small text-text-muted">no tool calls in this session</p>
            ) : (
              <ul className="flex flex-col gap-1 text-small text-text-primary">
                {detail.toolCounts.map((tool) => (
                  <li key={tool.toolName} className="flex justify-between gap-3">
                    <span>{tool.toolName}</span>
                    <span className="text-text-muted">{formatInteger(tool.count)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Subagent runs" className="flex flex-col gap-2">
            <h3 className="text-micro uppercase text-text-muted">Subagent runs</h3>
            {detail.subagentRuns.length === 0 ? (
              <p className="text-small text-text-muted">no subagent runs in this session</p>
            ) : (
              <ul className="flex flex-col gap-2 text-small">
                {detail.subagentRuns.map((run) => (
                  <li key={run.id} className="flex items-center justify-between gap-3">
                    <span className="text-text-primary">
                      {run.subagentType ?? 'unnamed subagent'}
                    </span>
                    {/* §3.7 — `linked` is shown honestly, never inferred. */}
                    <Badge tone={run.linked ? 'ok' : 'neutral'} data-testid="subagent-linked-badge">
                      {run.linked ? 'linked' : 'not linked to a spawn point'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </Drawer>
  );
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt className="text-micro uppercase text-text-muted">{label}</dt>
      <dd className="text-small text-text-primary">{value}</dd>
    </div>
  );
}
