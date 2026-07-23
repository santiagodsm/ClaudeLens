/**
 * Tokens & Cost — `view-tokens` (DESIGN §6.4) — **first among equals**.
 *
 * §1.4's moment of value lives here: the origin split, and the honest cost signal.
 *
 * ⚠️ **The rule this view exists to obey** (§6.4 degraded row): "If `UncostedSummary.records > 0`,
 * the Cost panel renders the figure **with** the disclosure line and a link to Settings →
 * Pricing. If **no** price row covers **any** record, the panel renders *'No pricing configured —
 * showing tokens only'* and **shows no `$` at all.** ⚠️ It never shows `$0.00`."
 *
 * On the wire that condition is exact rather than inferred: `costNanoUsd` is `null` when zero
 * events were costed and a number otherwise (§4.5), so this view never has to decide what a zero
 * means. `formatCost(null)` returns a sentence, not `$0.00`, and `costDisclosure` chooses the
 * line — both in one place, `views/shared/disclosures.tsx`.
 */

import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { CostBreakdownBy, TimelineBucket, TokensByModelMode } from '../../shared/ipc-contract';
import { ChartCard } from '../components/ChartCard';
import { DataTable } from '../components/DataTable';
import { useQuery } from '../hooks/use-query';
import { formatCompact, formatCost } from '../lib/format';
import { useAppStore } from '../store/app-store';
import { ViewShell } from '../shell/ViewShell';
import { CacheEfficiency } from './charts/CacheEfficiency';
import { ModelAreaChart } from './charts/ModelAreaChart';
import { OriginDonut, unlinkedRunsFootnote } from './charts/OriginDonut';
import { ProjectTreemap } from './charts/ProjectTreemap';
import { ProjectDetailDrawer } from './shared/ProjectDetailDrawer';
import { SegmentedControl } from './shared/SegmentedControl';
import { SeriesLegend } from './shared/SeriesLegend';
import { costDisclosureBlock, formatDay, suppressedBucketCount } from './shared/disclosures';

/**
 * §6.4's standing note, verbatim. It stands whichever way the toggle is set, which is why it is
 * a constant and not a branch: cache reads are cheap re-reads, and M-03 warns that they are
 * "**never** added into a 'total tokens' figure without an explicit adjacent label".
 */
export const CACHE_READ_NOTE =
  'Cache reads are cheap re-reads — output tokens are the honest cost signal.';

const MODE_OPTIONS: readonly { value: TokensByModelMode; label: string }[] = [
  { value: 'all', label: 'All tokens' },
  { value: 'output_only', label: 'Cost proxy (output only)' },
];

const BY_OPTIONS: readonly { value: CostBreakdownBy; label: string }[] = [
  { value: 'model', label: 'By model' },
  { value: 'project', label: 'By project' },
];

/** §6.4 (user directive) — the configurable time bucket for the stacked-area chart. */
const BUCKET_OPTIONS: readonly { value: TimelineBucket; label: string }[] = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
];

/**
 * The zoom presets. They set the **global** date filter (§4.2) rather than a second range state,
 * so zooming here scopes every view consistently, exactly as the user asked ("zoom into a day, or
 * zoom out"). `'all'` clears the range; the others scope to a recent window.
 */
type RangePreset = 'week' | 'month' | 'all';
const RANGE_OPTIONS: readonly { value: RangePreset; label: string }[] = [
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' },
  { value: 'all', label: 'All dates' },
];
const DAY_MS = 86_400_000;

/** Stacked (composition + total) vs separate zero-based areas (head-to-head). User request 2026-07-23. */
type StackMode = 'stacked' | 'separate';
const STACK_OPTIONS: readonly { value: StackMode; label: string }[] = [
  { value: 'stacked', label: 'Stacked' },
  { value: 'separate', label: 'Separate' },
];

export function TokensView(): JSX.Element {
  const filter = useAppStore((state) => state.filter);
  const setFilter = useAppStore((state) => state.setFilter);
  const partialBefore = useAppStore((state) => state.coverage?.partialBefore ?? null);
  const transcriptsTo = useAppStore((state) => state.coverage?.transcriptsTo ?? null);
  // §4.6 (A-05) — the cache-write-split caveats belong beside this panel's `$`, exactly as the
  // M-06 line does. Read from the shell's snapshot; they describe the dataset, not the filter.
  const disclosures = useAppStore((state) => state.disclosures);

  const [mode, setMode] = useState<TokensByModelMode>('output_only');
  const [by, setBy] = useState<CostBreakdownBy>('model');
  const [bucket, setBucket] = useState<TimelineBucket>('day');
  const [range, setRange] = useState<RangePreset>('all');
  const [stackMode, setStackMode] = useState<StackMode>('stacked');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  // The unit id of the project whose detail drawer is open; `null` = closed. Opened by a treemap
  // tile (below) — the same drawer a Projects & Code card opens (§6.4/§6.8, one destination).
  const [openProject, setOpenProject] = useState<number | null>(null);

  const timeline = useQuery('q:tokensByModel', { ...filter, mode, bucket });
  const cache = useQuery('q:cacheEfficiency', filter);
  const byProject = useQuery('q:tokensByProject', filter);
  const cost = useQuery('q:costBreakdown', { ...filter, by });
  const origin = useQuery('q:originSplit', filter);

  // ⚠️ The zoom presets set the GLOBAL date filter (reused, not duplicated). The window is
  // anchored to the newest data point rather than to the wall clock, so it never invents a
  // "now" the dataset does not reach (CLAUDE.md §1); the clock is only a last resort when there
  // is no coverage at all, and only to compute a UI window — never to stamp a data value.
  const applyRange = (preset: RangePreset): void => {
    setRange(preset);
    if (preset === 'all') {
      setFilter({ ...filter, from: null, to: null });
      setBucket('week');
      return;
    }
    const anchor = transcriptsTo ?? filter.to ?? Date.now();
    const days = preset === 'week' ? 7 : 30;
    setFilter({ ...filter, from: anchor - days * DAY_MS, to: null });
    // Zooming into a narrow window switches to day buckets, so a day is actually visible.
    setBucket('day');
  };

  const toggleSeries = (model: string): void => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  };

  // The panel's total is the sum of its costed rows. ⚠️ `null` — not `0` — when there are no
  // costed rows at all, so the "no pricing configured" branch is reached rather than `$0.00`
  // (§6.4). `q:costBreakdown` returns only costed groups (INV-09).
  const costRows = cost.data?.rows;
  const costTotal = useMemo(() => {
    if (costRows === undefined || costRows.length === 0) return null;
    return costRows.reduce((sum, row) => sum + row.costNanoUsd, 0);
  }, [costRows]);

  const timelineTitle = mode === 'all' ? 'All tokens by model' : 'Output tokens by model';

  // ⚠️ The plain-words explanation of the hatched region at the start of the chart (§6.12, user
  // directive 2026-07-22 — "I don't know what the grey area at the start means"). Rendered both
  // ON the chart and as the caption below it, so the grey band is never unexplained.
  const partialLabel =
    partialBefore === null
      ? undefined
      : `Before ${formatDay(partialBefore)} we only have prompts, not full token detail.`;

  return (
    <ViewShell
      id="tokens"
      heading={
        <div
          className="flex flex-wrap items-center gap-4 rounded-card border border-border bg-bg-surface p-6 shadow-card"
          data-testid="tokens-control-row"
        >
          <SegmentedControl
            label="Token measure"
            options={MODE_OPTIONS}
            value={mode}
            onChange={setMode}
            data-testid="token-mode-toggle"
          />
          <p className="text-small text-text-muted">{CACHE_READ_NOTE}</p>
        </div>
      }
      secondary={
        <>
          <ChartCard
            title="Output tokens by project"
            subtitle="Each tile's size is its output tokens. Click a project to see all its stats."
            className="col-span-12"
            index={2}
            loading={byProject.loading && byProject.data === null}
            error={byProject.error}
            empty={byProject.data !== null && byProject.data.rows.length === 0}
            emptyReason="no assistant events in this range"
            onRetry={byProject.refetch}
            data-testid="tokens-treemap"
          >
            {byProject.data !== null && byProject.data.rows.length > 0 ? (
              <ProjectTreemap
                tokens={byProject.data}
                onSelect={(projectId) => {
                  setOpenProject(projectId);
                }}
              />
            ) : undefined}
          </ChartCard>

          <ChartCard
            title="Cost"
            subtitle="Each dollar figure is what those tokens would cost at list price. The columns count the tokens behind it."
            className="col-span-12 xl:col-span-8"
            index={3}
            footer={
              // ⚠️ Plain-words gloss so no column is a number without a meaning (§1a, user
              // directive — "cost by project has numbers I don't know the meaning of").
              <span data-testid="cost-columns-explainer">
                Input: tokens sent to the model. Output: tokens it wrote back. Cache write 5m / 1h:
                tokens stored so they can be reused (for 5 minutes or 1 hour). Cache read: tokens
                reused from cache instead of re-sent.
              </span>
            }
            control={
              <SegmentedControl
                label="Cost grouping"
                options={BY_OPTIONS}
                value={by}
                onChange={setBy}
                data-testid="cost-by-toggle"
              />
            }
            loading={cost.loading && cost.data === null}
            error={cost.error}
            empty={
              cost.data !== null && cost.data.rows.length === 0 && cost.data.uncosted.records === 0
            }
            emptyReason="no assistant events in this range"
            onRetry={cost.refetch}
            // INV-10 / §6.12 — pinned directly beneath the total, never in a tooltip.
            //
            // ⚠️ Line 1 is the STANDING list-price caveat (approved 2026-07-22): this panel's
            // figures are API list-price equivalents, which is always true and therefore always
            // shown, unlike the data-dependent lines beneath it.
            disclosure={
              cost.data === null
                ? undefined
                : costDisclosureBlock(costTotal, cost.data.uncosted, disclosures)
            }
            data-testid="tokens-cost-panel"
          >
            {cost.data !== null && (cost.data.rows.length > 0 || cost.data.uncosted.records > 0) ? (
              <div className="flex flex-col gap-3">
                <DataTable
                  columns={[
                    {
                      id: 'key',
                      header: by === 'model' ? 'Model' : 'Project',
                      // §1a — show the display name (row.label), never the numeric unit id (row.key).
                      render: (row) => row.label,
                    },
                    {
                      id: 'input',
                      header: 'Input',
                      numeric: true,
                      render: (row) => formatCompact(row.tokensByClass.input),
                    },
                    {
                      id: 'output',
                      header: 'Output',
                      numeric: true,
                      render: (row) => formatCompact(row.tokensByClass.output),
                    },
                    {
                      // A-05 — `cacheWrite` is the 5-MINUTE class; the header says so, because
                      // "Cache write" beside a second cache-write column would be ambiguous.
                      id: 'cacheWrite',
                      header: 'Cache write 5m',
                      numeric: true,
                      render: (row) => formatCompact(row.tokensByClass.cacheWrite),
                    },
                    {
                      id: 'cacheWrite1h',
                      header: 'Cache write 1h',
                      numeric: true,
                      render: (row) => formatCompact(row.tokensByClass.cacheWrite1h),
                    },
                    {
                      id: 'cacheRead',
                      header: 'Cache read',
                      numeric: true,
                      render: (row) => formatCompact(row.tokensByClass.cacheRead),
                    },
                    {
                      id: 'cost',
                      header: 'Cost',
                      numeric: true,
                      render: (row) => formatCost(row.costNanoUsd),
                    },
                  ]}
                  rows={cost.data.rows}
                  rowKey={(row) => row.key}
                  caption={`Cost by ${by}`}
                  data-testid="cost-table"
                />
                <p className="flex items-baseline justify-end gap-3 text-body text-text-primary">
                  <span className="text-micro uppercase text-text-muted">Total</span>
                  {/* ⚠️ No `$` at all when nothing is costed (§6.4). */}
                  <span data-testid="cost-total" className="text-h3 font-bold">
                    {costTotal === null ? '—' : formatCost(costTotal)}
                  </span>
                </p>
              </div>
            ) : undefined}
          </ChartCard>

          {/* §6.4 right rail — the origin split, "the thing visible nowhere else". */}
          <ChartCard
            title="Main loop vs subagents"
            subtitle="Share of output tokens written by the main loop versus its subagents"
            className="col-span-12 xl:col-span-4"
            index={4}
            loading={origin.loading && origin.data === null}
            error={origin.error}
            onRetry={origin.refetch}
            disclosure={
              origin.data === null
                ? undefined
                : (unlinkedRunsFootnote(origin.data.unlinkedRuns) ?? undefined)
            }
            data-testid="tokens-origin-split"
          >
            {origin.data !== null ? <OriginDonut split={origin.data} /> : undefined}
          </ChartCard>
        </>
      }
    >
      <div className="grid grid-cols-12" style={{ gap: 'var(--grid-gutter)' }}>
        <ChartCard
          title={timelineTitle}
          subtitle={`Stacked per model, by ${bucket === 'day' ? 'day' : 'week'}`}
          className="col-span-12 xl:col-span-8"
          index={0}
          loading={timeline.loading && timeline.data === null}
          error={timeline.error}
          empty={timeline.data !== null && timeline.data.series.length === 0}
          emptyReason="no assistant events in this range"
          onRetry={timeline.refetch}
          control={
            <div
              className="flex flex-wrap items-center gap-2"
              data-testid="timeline-scale-controls"
            >
              <SegmentedControl
                label="Time bucket"
                options={BUCKET_OPTIONS}
                value={bucket}
                onChange={setBucket}
                data-testid="timeline-bucket-toggle"
              />
              <SegmentedControl
                label="Date range"
                options={RANGE_OPTIONS}
                value={range}
                onChange={applyRange}
                data-testid="timeline-range-toggle"
              />
              <SegmentedControl
                label="Stack models"
                options={STACK_OPTIONS}
                value={stackMode}
                onChange={setStackMode}
                data-testid="timeline-stack-toggle"
              />
            </div>
          }
          legend={
            timeline.data === null ? undefined : (
              <SeriesLegend
                entries={timeline.data.series.map((series) => ({
                  name: series.model,
                  colorIndex: series.colorIndex,
                }))}
                hidden={hidden}
                onToggle={toggleSeries}
              />
            )
          }
          disclosure={
            partialLabel === undefined ? undefined : (
              <span data-testid="partial-caption">{partialLabel}</span>
            )
          }
          data-testid="tokens-timeline"
        >
          {timeline.data !== null && timeline.data.series.length > 0 ? (
            <ModelAreaChart
              timeline={timeline.data}
              hidden={hidden}
              stacked={stackMode === 'stacked'}
              suppressedBuckets={suppressedBucketCount(timeline.data.buckets, partialBefore)}
              unit="tokens"
              partialLabel={partialLabel}
            />
          ) : undefined}
        </ChartCard>

        <ChartCard
          title="Cache efficiency"
          subtitle="How much of the input was reused from cache instead of re-sent — higher is cheaper"
          className="col-span-12 xl:col-span-4"
          index={1}
          loading={cache.loading && cache.data === null}
          error={cache.error}
          onRetry={cache.refetch}
          data-testid="tokens-cache-gauge"
        >
          {cache.data !== null ? <CacheEfficiency data={cache.data} /> : undefined}
        </ChartCard>
      </div>

      {/* One destination, second door: the treemap opens the same project drawer a card does. */}
      <ProjectDetailDrawer
        projectId={openProject}
        onClose={() => {
          setOpenProject(null);
        }}
      />
    </ViewShell>
  );
}
