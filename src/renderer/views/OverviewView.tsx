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
 *
 * ⚠️ **A-19 — the four tiles follow the control at the top of the app, which is now a BILLING
 * CYCLE picker (§6.2).** A-18 put a two-option scope toggle above this row, because a cycle was
 * then an Overview-only idea; the user asked for the cycle to be "the de facto filter on all the
 * pages … a control at the top, not only in Overview" (2026-08-18), so the toggle is GONE and the
 * tiles simply read the global filter, exactly as the calendar and the timeline always have. The
 * caption under the row survives and now describes whatever the top bar selected: a total whose
 * window the reader has to guess, or whose caption names a period it was not counted over, is the
 * same defect as a total that is wrong (CLAUDE.md §1/§1a). ⚠️ The caption still describes the
 * window the numbers ON SCREEN came from, which during a refresh in place is not the one being
 * fetched.
 *
 * ⚠️ **A-19 also adds the cycle-comparison strip beneath the tiles**, which deliberately does NOT
 * follow the cycle chosen at the top — comparing cycles is what it is for — and which draws only
 * its newest few. Both of those cuts are stated on the card itself, in words, together with what
 * the cycles it does not draw hold (§4.6): a card that shows less than its own caption promises
 * is the caption-shaped form of a wrong number.
 */

import { useState } from 'react';
import type { JSX } from 'react';
import type { BillingCycleRow, Disclosures, OverviewTiles } from '../../shared/ipc-contract';
import { ChartCard } from '../components/ChartCard';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { StatTile } from '../components/StatTile';
import { useQuery } from '../hooks/use-query';
import {
  DEFAULT_BILLING_CYCLE_DAY,
  asBillingCycleWindow,
  billingCycleCaption,
  filterWindowCaption,
  isCycleInProgress,
} from '../lib/billing-cycle';
import { useCycleClock } from '../hooks/use-cycle-clock';
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
import {
  CycleStrip,
  cycleCostScope,
  cycleStripScopeNote,
  cyclesEmptyReason,
  cyclesShownOnStrip,
  excludedCyclesNote,
} from './shared/billing-cycles';

/** §6.3 — "26-week activity calendar heatmap". */
const CALENDAR_WEEKS = 26;

/** A-19 — how many of the newest cycles the compact strip shows. Six, by the amendment. */
const STRIP_CYCLES = 6;

/** Stacked (composition + total) vs separate zero-based areas (head-to-head). User request 2026-07-23. */
type StackMode = 'stacked' | 'separate';
const STACK_OPTIONS: readonly { value: StackMode; label: string }[] = [
  { value: 'stacked', label: 'Stacked' },
  { value: 'separate', label: 'Separate' },
];

/** §6.3's empty copy, verbatim. */
export const OVERVIEW_EMPTY_REASON = 'No transcripts found in this directory yet';

/**
 * A-18 — the empty copy when the DATASET has records but the billing cycle on screen has none.
 *
 * ⚠️ It must not be §6.3's sentence. "No transcripts found in this directory yet" would be false
 * here — the transcripts exist, they simply all fall outside this cycle — and a false explanation
 * is the caption-shaped form of a silently wrong number (§1a).
 */
export const CYCLE_EMPTY_REASON = 'No activity yet in this billing cycle';

/**
 * A-19 — the same fact about a cycle that has CLOSED. ⚠️ "yet" is a promise that the number may
 * still rise, and it cannot: that month is over. One word, and it is the difference between a
 * true sentence and a false one (§1a).
 */
export const PAST_CYCLE_EMPTY_REASON = 'No activity in that billing cycle';

/**
 * A-19 — the empty copy when the chosen dates are not a billing cycle and hold nothing. A third
 * sentence, for the same reason A-18 needed a second: neither of the two above is TRUE here.
 */
export const RANGE_EMPTY_REASON = 'No activity in the dates chosen at the top';

export interface OverviewViewProps {
  /**
   * A-18/A-19 — the instant the caption reads the chosen window against, so it can say whether
   * that billing cycle has finished. Optional and injected only by tests; the shipped app reads
   * the wall clock through `useCycleClock`. ⚠️ It reaches no query and no stored value: after
   * A-19 the tiles' window comes from the control at the top of the app, already resolved to two
   * fixed local midnights (§1: never default a timestamp to "now").
   */
  now?: number;
}

export function OverviewView({ now }: OverviewViewProps = {}): JSX.Element {
  const filter = useAppStore((state) => state.filter);
  const settings = useAppStore((state) => state.settings);
  // M-16 — the transcript boundary is a property of the dataset, delivered by `app:bootstrap`
  // (§4.3 `DataCoverage`). It is read here rather than re-queried per view: a filter cannot move
  // the instant at which transcripts start existing. It is also what tells an empty window apart
  // from an empty directory (below), so the whole of it is taken once.
  const coverage = useAppStore((state) => state.coverage);
  const partialBefore = coverage?.partialBefore ?? null;
  const refresh = useAppStore((state) => state.refresh);
  // §4.6 (A-05) — the cache-write-split caveats travel with the `$` on this tile. They are
  // properties of the stored dataset, not of the filter, so they come from the bootstrap/
  // `q:disclosures` snapshot the shell already holds rather than from a fifth query.
  const disclosures = useAppStore((state) => state.disclosures);
  const selectCycle = useAppStore((state) => state.selectCycle);

  // A-18 — the anchor day of the user's Claude bill, read from the settings snapshot the shell
  // already holds, exactly as `idleGapMinutes` is. The fallback is the documented default for a
  // shell that has not booted yet, not a substitution for a value we have (§3.13).
  const billingCycleDay = useAppStore(
    (state) => state.settings?.billingCycleDay ?? DEFAULT_BILLING_CYCLE_DAY,
  );
  // ⚠️ Used for ONE thing: deciding whether the window on screen is a cycle that has finished, so
  // the caption can say "so far" only when that is true. It parameterises no query (A-19).
  const at = useCycleClock(billingCycleDay, now);

  // ⚠️ A-19 — the tiles read the global filter, like every other card in the app. The cycle-scope
  // toggle A-18 put here is gone: the control at the top owns the window now, for all eight views.
  const tiles = useQuery('q:overviewTiles', filter);
  const calendar = useQuery('q:activityCalendar', { ...filter, weeks: CALENDAR_WEEKS });
  const timeline = useQuery('q:modelMixTimeline', { ...filter, bucket: 'week' });
  // ⚠️ Deliberately NOT the global filter: this strip compares every cycle while the top bar is
  // parked on one of them, and the request type carries no date range at all so the range it
  // would have had to ignore cannot be passed. The project selection IS honoured, and the card
  // says both of those things in words (A-19, §4.5).
  const cycles = useQuery('q:billingCycleTotals', { projectIds: filter.projectIds });

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
  // What the payload proves: this WINDOW holds nothing. Deliberately not named `datasetEmpty` —
  // the tiles cannot see past their own range, and the reason a row is empty is a different fact
  // from the fact that it is empty (§1a).
  const windowEmpty =
    data !== null && data.sessions === 0 && data.outputTokens === 0 && data.toolCalls === 0;

  /**
   * ⚠️ **Which of the three empty sentences is true is a question only the dataset can answer.**
   *
   * "No activity yet in this billing cycle" over a directory that holds no transcripts at all is
   * a reassurance printed over a misconfiguration — and it suppresses the one hint (the path)
   * that would show the user what went wrong. Whether the dataset holds transcripts is a property
   * of the dataset, delivered once by `app:bootstrap` (§4.3 `DataCoverage`), so it is read from
   * the shell's snapshot rather than guessed from a payload that cannot know.
   *
   * `coverage === null` is not knowledge, so it claims nothing: the window sentences merely
   * restate what was measured, while §6.3's sentence asserts a cause we would not have (§1).
   */
  const datasetKnownEmpty = coverage !== null && coverage.transcriptsFrom === null;

  // ⚠️ The caption describes the window the numbers ON SCREEN were counted over. `useQuery` keeps
  // the previous payload visible while it re-queries, so for that one round trip the window the
  // user has just picked is not yet the window the totals came from; captioning the request in
  // flight would name a period those totals do not cover (§1a).
  const shownWindow = data === null ? filter : (tiles.dataRequest ?? filter);
  // A window is a billing cycle exactly when it is the cycle containing its own first instant —
  // a self-contained test, so it stays true of a cycle that has closed since it was queried.
  const shownCycle = asBillingCycleWindow(billingCycleDay, shownWindow.from, shownWindow.to);
  const shownIsAllTime = shownWindow.from === null && shownWindow.to === null;
  const claimsDirectoryEmpty = shownIsAllTime || datasetKnownEmpty;
  const emptyReason = claimsDirectoryEmpty
    ? OVERVIEW_EMPTY_REASON
    : shownCycle === null
      ? RANGE_EMPTY_REASON
      : isCycleInProgress(shownCycle, at)
        ? CYCLE_EMPTY_REASON
        : PAST_CYCLE_EMPTY_REASON;

  // A-19 — the rows the strip actually draws, computed here as well as inside the strip so the
  // `$` disclosure beneath them qualifies exactly those rows and no others (INV-10).
  const listedCycles = cycles.data?.cycles ?? [];
  const strip = cyclesShownOnStrip(listedCycles, STRIP_CYCLES);
  const stripCost = cycles.data === null ? null : cycleCostScope(strip, cycles.data);
  // §4.6 — what the cap left out, said as what those cycles HOLD rather than as a bare count:
  // the rows on screen exclude real records, and the figures beside them must not read as the
  // whole story with nothing to explain the difference.
  const cyclesExcluded =
    cycles.data === null ? null : excludedCyclesNote(cycles.data.truncated, cycles.data.excluded);

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
      {/* A-19 — the window caption sits under the tile row and renders in EVERY state, including
          loading and empty, so the row never resizes when data arrives (§6.3: "Layout never
          shifts") and the window is stated even when there is nothing in it. The scope toggle
          A-18 put above the row is gone: the control at the top of the app owns the window now. */}
      <div className="flex flex-col gap-4">
        {tiles.error !== null ? (
          <ErrorState
            error={tiles.error}
            onRetry={tiles.refetch}
            data-testid="overview-tiles-error"
          />
        ) : windowEmpty ? (
          <EmptyState
            reason={emptyReason}
            // The path answers "where did you look", which is exactly the question when the
            // claim is that the directory holds nothing — and is not the question when the
            // dataset is known to hold transcripts and only this window is empty.
            hint={claimsDirectoryEmpty ? (settings?.claudeDir ?? undefined) : undefined}
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

        {/* ⚠️ The promise this screen makes about its own numbers: the reader never has to guess
            which window the four totals cover. Same muted caption typography the disclosure
            lines use; it neither replaces nor displaces the cost and overlap disclosures, which
            stay on their own tiles exactly as before (§6.12, INV-10, INV-23). */}
        <p data-testid="tile-window-caption" className="text-small text-text-muted">
          {shownCycle === null
            ? filterWindowCaption(shownWindow.from, shownWindow.to)
            : billingCycleCaption(shownCycle, at)}
        </p>

        {/* A-19 — the comparison strip, directly under the four totals (§6.3). ⚠️ It shows every
            cycle whichever one is chosen at the top, and its own footer says so: a card that
            silently disobeys the control above it is a number the reader will misattribute. */}
        <ChartCard
          title="Recent billing cycles"
          subtitle={`Cost per cycle, the last ${String(STRIP_CYCLES)}. Click one to see it everywhere.`}
          index={0}
          loading={cycles.loading && cycles.data === null}
          error={cycles.error}
          empty={cycles.data !== null && cycles.data.cycles.length === 0}
          // ⚠️ Empty cycles ARE in the payload, deliberately — so an empty list means the scope
          // holds no records at all, and the scope includes the projects chosen at the top.
          emptyReason={cyclesEmptyReason(filter.projectIds)}
          onRetry={cycles.refetch}
          disclosure={
            stripCost === null
              ? undefined
              : costDisclosureBlock(stripCost.costNanoUsd, stripCost.uncosted, disclosures)
          }
          footer={
            <span data-testid="cycle-strip-scope-note">
              {cycleStripScopeNote(strip.length, listedCycles.length, cycles.data?.truncated ?? 0)}
              {cyclesExcluded === null ? '' : ` ${cyclesExcluded}`}
            </span>
          }
          data-testid="overview-cycles"
        >
          {cycles.data !== null && cycles.data.cycles.length > 0 ? (
            <CycleStrip
              cycles={cycles.data.cycles}
              limit={STRIP_CYCLES}
              // ⚠️ Which bar is in force, marked where the click was made — the top bar is not the
              // only place the selection may be legible (§6.12). Compared on BOTH ends of the
              // window, so a cycle is never marked because it merely starts where the filter does.
              selectedFrom={
                strip.some((row) => row.from === filter.from && row.to === filter.to)
                  ? filter.from
                  : null
              }
              onSelect={(row: BillingCycleRow) => {
                // ⚠️ The row's OWN window, applied verbatim — never re-resolved against the
                // bootstrap coverage snapshot, which the strip's rows can legitimately outrun
                // (see `selectCycle`). The in-progress row becomes "this billing cycle", so it
                // keeps rolling over instead of freezing on today's window (A-19, §1).
                selectCycle(row);
              }}
            />
          ) : undefined}
        </ChartCard>
      </div>
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
