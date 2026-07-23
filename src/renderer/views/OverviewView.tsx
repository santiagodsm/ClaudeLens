/**
 * Overview — `view-overview` (DESIGN §6.3).
 *
 * The 3-second wordless glance (§1.3 moment 3). Four `StatTile`s, then the activity calendar and
 * the model-mix timeline.
 *
 * ⚠️ **The tile order is the PRD's, not the prototype's, and the override is deliberate.** §6.3:
 * "The prototype's first tile is `Sessions`; `PRD.md` 'The daily loop' step 3 names the glance
 * tiles as **output tokens, dollar cost, active hours, tool calls**. The PRD wins — dollar cost
 * is the newer requirement and the glance is what the tile row exists for. The session count
 * moves to the Sessions & Time header", which is where `SessionsView` renders it.
 *
 * ⚠️ **Two independent disclosures live on this row and they may appear together** (§6.3):
 *   · the Cost tile's M-06 line — or `all records costed`;
 *   · the Active-hours tile's M-20 overlap line — **and nothing at all when `overlapSeconds` is
 *     `0`**, deliberately not a positive confirmation, "because a reassurance nobody asked for
 *     is noise on the one screen whose rule is that nothing moves or accretes".
 * Neither disclosure changes the figure it qualifies (INV-10, INV-23).
 */

import { useState } from 'react';
import type { JSX } from 'react';
import type { Disclosures, OverviewTiles } from '../../shared/ipc-contract';
import { ChartCard } from '../components/ChartCard';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { StatTile } from '../components/StatTile';
import { useQuery } from '../hooks/use-query';
import { formatCompact, formatCost, formatDuration, formatInteger } from '../lib/format';
import { useAppStore } from '../store/app-store';
import { ViewShell } from '../shell/ViewShell';
import { CalendarHeatmap } from './charts/CalendarHeatmap';
import { ModelAreaChart } from './charts/ModelAreaChart';
import {
  PartialCaption,
  costDisclosureBlock,
  overlapDisclosure,
  suppressedBucketCount,
} from './shared/disclosures';
import { SeriesLegend } from './shared/SeriesLegend';
import { SegmentedControl } from './shared/SegmentedControl';

/** §6.3 — "26-week activity calendar heatmap". */
const CALENDAR_WEEKS = 26;

/** Stacked (composition + total) vs separate zero-based areas (head-to-head). User request 2026-07-23. */
type StackMode = 'stacked' | 'separate';
const STACK_OPTIONS: readonly { value: StackMode; label: string }[] = [
  { value: 'stacked', label: 'Stacked' },
  { value: 'separate', label: 'Separate' },
];

/** §6.3's empty copy, verbatim. */
export const OVERVIEW_EMPTY_REASON = 'No transcripts found in this directory yet';

export function OverviewView(): JSX.Element {
  const filter = useAppStore((state) => state.filter);
  const settings = useAppStore((state) => state.settings);
  // M-16 — the transcript boundary is a property of the dataset, delivered by `app:bootstrap`
  // (§4.3 `DataCoverage`). It is read here rather than re-queried per view: a filter cannot move
  // the instant at which transcripts start existing.
  const partialBefore = useAppStore((state) => state.coverage?.partialBefore ?? null);
  const refresh = useAppStore((state) => state.refresh);
  // §4.6 (A-05) — the cache-write-split caveats travel with the `$` on this tile. They are
  // properties of the stored dataset, not of the filter, so they come from the bootstrap/
  // `q:disclosures` snapshot the shell already holds rather than from a fifth query.
  const disclosures = useAppStore((state) => state.disclosures);

  const tiles = useQuery('q:overviewTiles', filter);
  const calendar = useQuery('q:activityCalendar', { ...filter, weeks: CALENDAR_WEEKS });
  const timeline = useQuery('q:modelMixTimeline', { ...filter, bucket: 'week' });

  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [stackMode, setStackMode] = useState<StackMode>('stacked');
  const toggle = (model: string): void => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  };

  const data = tiles.data;
  const datasetEmpty =
    data !== null && data.sessions === 0 && data.outputTokens === 0 && data.toolCalls === 0;

  return (
    <ViewShell
      id="overview"
      secondary={
        <>
          <ChartCard
            title="Activity"
            subtitle={`Messages per day, last ${String(CALENDAR_WEEKS)} weeks`}
            className="col-span-12"
            index={4}
            loading={calendar.loading && calendar.data === null}
            error={calendar.error}
            empty={calendar.data !== null && calendar.data.days.length === 0}
            emptyReason="no messages in this range"
            onRetry={calendar.refetch}
            disclosure={
              partialBefore === null ? undefined : <PartialCaption partialBefore={partialBefore} />
            }
            data-testid="overview-calendar"
          >
            {calendar.data !== null && calendar.data.days.length > 0 ? (
              <CalendarHeatmap
                calendar={calendar.data}
                weeks={CALENDAR_WEEKS}
                partialBefore={partialBefore}
              />
            ) : undefined}
          </ChartCard>

          <ChartCard
            title="Model mix over time"
            subtitle="Assistant events per model, by week"
            className="col-span-12"
            index={5}
            loading={timeline.loading && timeline.data === null}
            error={timeline.error}
            empty={timeline.data !== null && timeline.data.series.length === 0}
            emptyReason="no assistant events in this range"
            onRetry={timeline.refetch}
            control={
              <SegmentedControl
                label="Stack models"
                options={STACK_OPTIONS}
                value={stackMode}
                onChange={setStackMode}
                data-testid="model-mix-stack-toggle"
              />
            }
            legend={
              timeline.data === null ? undefined : (
                <SeriesLegend
                  entries={timeline.data.series.map((series) => ({
                    name: series.model,
                    colorIndex: series.colorIndex,
                  }))}
                  hidden={hidden}
                  onToggle={toggle}
                />
              )
            }
            disclosure={
              partialBefore === null ? undefined : <PartialCaption partialBefore={partialBefore} />
            }
            data-testid="overview-model-mix"
          >
            {timeline.data !== null && timeline.data.series.length > 0 ? (
              <ModelAreaChart
                timeline={timeline.data}
                hidden={hidden}
                stacked={stackMode === 'stacked'}
                suppressedBuckets={suppressedBucketCount(timeline.data.buckets, partialBefore)}
                unit="events"
              />
            ) : undefined}
          </ChartCard>
        </>
      }
    >
      {tiles.error !== null ? (
        <ErrorState
          error={tiles.error}
          onRetry={tiles.refetch}
          data-testid="overview-tiles-error"
        />
      ) : datasetEmpty ? (
        <EmptyState
          reason={OVERVIEW_EMPTY_REASON}
          hint={settings?.claudeDir ?? undefined}
          action={
            <button
              type="button"
              onClick={() => {
                void refresh();
              }}
              className="rounded-control border border-border px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
            >
              Refresh
            </button>
          }
          data-testid="overview-empty"
        />
      ) : data === null ? (
        <TileSkeletons />
      ) : (
        <HeroTiles
          tiles={data}
          idleGapMinutes={settings?.idleGapMinutes ?? null}
          disclosures={disclosures}
        />
      )}
    </ViewShell>
  );
}

function HeroTiles({
  tiles,
  idleGapMinutes,
  disclosures,
}: {
  tiles: OverviewTiles;
  idleGapMinutes: number | null;
  disclosures: Disclosures | null;
}): JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
      {/* M-02 — the primary headline number. */}
      <StatTile
        label="Output tokens"
        value={formatInteger(tiles.outputTokens)}
        index={0}
        footer={`cost proxy · ${formatCompact(tiles.cacheReadTokens)} cache reads`}
        data-testid="tile-output-tokens"
      />

      {/* M-05 with its M-06 disclosure. ⚠️ `costNanoUsd === null` renders NO `$` at all — never
          `$0.00`, which asserts a zero cost rather than an unknown one (§6.4).

          ⚠️ The first line of the block is the STANDING list-price caveat (approved 2026-07-22).
          It is not data-dependent and therefore does NOT follow M-20's render-nothing-at-zero
          precedent: it is true of this number in every state, so it is always there — which is
          also why it cannot shift the glance surface's layout (§6.2). Below it come the M-06 line
          and, when they have anything to say, the A-05 cache-split caveats. */}
      <StatTile
        label="Cost"
        value={tiles.costNanoUsd === null ? null : formatCost(tiles.costNanoUsd)}
        index={1}
        disclosure={costDisclosureBlock(tiles.costNanoUsd, tiles.uncosted, disclosures)}
        data-testid="tile-cost"
      />

      {/* M-07 binding (C) with its M-20 companion (INV-23). The figure never changes. */}
      <StatTile
        label="Active hours"
        value={formatDuration(tiles.activeSeconds)}
        index={2}
        disclosure={overlapDisclosure(tiles.overlapSeconds)}
        footer={`${idleGapMinutes === null ? 'idle gaps' : `idle gaps >${String(idleGapMinutes)}m`} removed · summed per project-day`}
        data-testid="tile-active-hours"
      />

      {/* M-12 — includes `Agent` and `Skill`, which are tools (§2.1). */}
      <StatTile
        label="Tool calls"
        value={formatInteger(tiles.toolCalls)}
        index={3}
        footer={`${formatInteger(tiles.distinctTools)} distinct tools`}
        data-testid="tile-tool-calls"
      />
    </div>
  );
}

/**
 * §6.3 loading row — "Tiles render skeleton bars … **Layout never shifts** when data arrives."
 * Four cards at the tiles' own height and in their own grid, so the row does not resize.
 */
function TileSkeletons(): JSX.Element {
  return (
    <div
      className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4"
      data-testid="tile-skeletons"
    >
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="rounded-card border border-border bg-bg-surface shadow-card">
          <LoadingState lines={3} label="Loading overview tiles" />
        </div>
      ))}
    </div>
  );
}
