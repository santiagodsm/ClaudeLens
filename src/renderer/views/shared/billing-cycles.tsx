/**
 * A-19 — **comparing one billing cycle against the next**, on the two surfaces that show it:
 * the compact strip under the Overview tiles (§6.3) and the full card on Tokens & Cost (§6.4).
 *
 * User's words, 2026-08-18: "I don't want just this billing cycle vs previous — now I should be
 * able to compare across billing cycles, all of them, when I used more vs less."
 *
 * ⚠️⚠️ **THE RULE THIS MODULE EXISTS TO ENFORCE, and the one a later edit is most likely to
 * "complete": the cycle the clock is inside is INCOMPLETE, and it never carries a plain
 * change-vs-previous figure.** Today may be day 4 of 31. "−65% vs last cycle" against a whole
 * cycle is a wrong number wearing a comparison's clothes — arithmetically correct, and read by a
 * human as "I have cut my usage by two thirds" when the truth is "the month has barely started"
 * (CLAUDE.md §1). So the in-progress cycle is drawn differently (hatched, the way every other
 * partial region in this app is — §6.12), says how far through it is in words, and its comparison
 * cell says why there is no percentage instead of showing one. ⚠️ Nothing here extrapolates,
 * projects, annualises or runs a rate: the app reports what happened.
 *
 * ⚠️ **`costNanoUsd === null` renders no `$` at all, never `$0.00`** (§6.4) — and the reason is
 * said in words, because two different facts produce that `null`: a cycle in which nothing was
 * recorded, and a cycle whose every record is missing a price. They are told apart by the tokens
 * and the record counts, never by the money (INV-09, INV-10).
 *
 * ⚠️⚠️ **What is on screen and what the figures beside it cover are never allowed to differ in
 * silence.** Two cuts happen here — the strip draws only its newest few, and the payload itself
 * stops at a cap — so every note this module produces states the cut that actually happened
 * (§4.6), every `$` disclosure is computed over the rows it sits beneath (INV-10), and the
 * excluded cycles' own totals are said out loud rather than left as a bare count.
 *
 * ⚠️ **Nothing here ever adds a session count across cycles.** A session that spans a cycle
 * boundary is counted in BOTH cycles by design (`BillingCycleRow.sessions`), so the sum is not a
 * number of sessions; the wire type for the excluded cycles carries no session field at all, and
 * neither surface prints one.
 */

import type { JSX } from 'react';
import type {
  BillingCycleRow,
  BillingCycleTotals,
  ExcludedCycleTotals,
  UncostedSummary,
} from '../../../shared/ipc-contract';
import { cycleLabel, cycleProgressLabel } from '../../lib/billing-cycle';
import { cx } from '../../lib/cx';
import { formatCompact, formatCost, formatDelta, formatInteger } from '../../lib/format';

/**
 * §1a — the one surprising thing about both cards, said plainly on both of them: the control at
 * the top picks ONE cycle, and these cards deliberately ignore it, because comparing cycles is
 * what they are for. The project selection is not ignored, and saying only half of that would be
 * worse than saying nothing.
 *
 * ⚠️ It says "does not change these figures", not "whichever one is chosen": the earlier wording
 * meant "regardless of" and read as if the card FOLLOWED the control — the exact opposite of the
 * fact it was there to state (A-19 review).
 */
export const CYCLE_SCOPE_NOTE =
  'The billing cycle chosen at the top of the screen does not change these figures — comparing' +
  ' one cycle with another is what this card is for. The projects chosen at the top do apply.';

/** Where the whole list lives, for the strip to point at. Named as the user sees it in the nav. */
const FULL_LIST_SCREEN = 'Tokens & Cost';

/**
 * §4.6 — the full card's own scope sentence. ⚠️ It claims "every billing cycle" only when that is
 * true: once the cap has bitten, this card is a list of the most recent ones and says so, and
 * `excludedCyclesNote` beside it says what the missing ones hold.
 */
export function cycleTableScopeNote(listed: number, truncated: number): string {
  if (truncated <= 0) return `Every billing cycle in your data is listed here. ${CYCLE_SCOPE_NOTE}`;
  return `${mostRecentClause(listed)} listed here. ${CYCLE_SCOPE_NOTE}`;
}

/**
 * §4.6 — the strip's own scope sentence.
 *
 * ⚠️ **The strip slices to its newest few, and this is where that cut is disclosed.** It used to
 * borrow the full card's sentence verbatim, so a fourteen-cycle dataset dropped eight bars under
 * a sentence promising that none were dropped — the cut that actually happens must be the cut
 * that is stated (A-19 review, §4.6).
 */
export function cycleStripScopeNote(shown: number, listed: number, truncated: number): string {
  const hidden = listed - shown;
  if (hidden <= 0) {
    if (truncated <= 0)
      return `Every billing cycle in your data is shown here. ${CYCLE_SCOPE_NOTE}`;
    return `${mostRecentClause(shown)} shown here. ${CYCLE_SCOPE_NOTE}`;
  }
  return (
    `${mostRecentClause(shown)} shown here; ${formatInteger(hidden)} earlier ` +
    `${hidden === 1 ? 'one is' : 'ones are'} in your data but not on this strip, and the whole` +
    ` list is on the ${FULL_LIST_SCREEN} screen. ${CYCLE_SCOPE_NOTE}`
  );
}

/** "Only the most recent billing cycle is" / "The 6 most recent billing cycles are". */
function mostRecentClause(count: number): string {
  return count === 1
    ? 'Only the most recent billing cycle is'
    : `The ${formatInteger(count)} most recent billing cycles are`;
}

/**
 * §1a / §4.6 — why a cycle card has no rows at all.
 *
 * ⚠️ The old copy — "no billing cycles with anything in them yet" — implied a filter this app
 * does not apply: a cycle in which nothing happened IS in the payload, deliberately, so that two
 * non-adjacent cycles never look consecutive. The list is empty only when the scope holds no
 * records whatsoever, and the scope includes the projects chosen at the top, so which of those
 * two facts is true is said rather than blurred (A-19 review).
 */
export function cyclesEmptyReason(projectIds: readonly number[] | null): string {
  return projectIds === null
    ? 'nothing has been recorded yet, so there are no billing cycles to compare'
    : 'nothing has been recorded for the projects chosen at the top, so there are no billing' +
        ' cycles to compare';
}

/**
 * §4.6 — **what the cycles the cap left out actually hold**, in plain words.
 *
 * ⚠️ A bare "N older billing cycles are not shown" is not enough, and that is the whole reason
 * the payload carries their totals: the rows on screen exclude real records while the `$` and the
 * record counts beside them are read as the whole story. Stating the shortfall is what keeps
 * listed + not-listed adding up in the reader's head (CLAUDE.md §1, §4.6).
 *
 * ⚠️ No session count appears here, and the wire type deliberately has no field for one: a
 * session spanning a boundary is counted in both cycles, so cycle counts do not add.
 *
 * Returns `null` when nothing was left out.
 */
export function excludedCyclesNote(
  truncated: number,
  excluded: ExcludedCycleTotals,
): string | null {
  if (truncated <= 0) return null;
  const one = truncated === 1;
  const opening = one
    ? 'One older billing cycle is not shown.'
    : `${formatInteger(truncated)} older billing cycles are not shown.`;
  const holds = one ? 'It holds' : 'They hold';

  if (excluded.records <= 0) {
    return `${opening} Nothing was recorded in ${one ? 'it' : 'them'}.`;
  }

  const records = `${formatInteger(excluded.records)} record${excluded.records === 1 ? '' : 's'}`;
  const tokens = `${formatCompact(excluded.outputTokens)} output tokens`;
  // ⚠️ `costNanoUsd === null` writes no `$` at all, exactly as a listed row does: the cost of
  // those cycles is unknown, and `$0.00` would assert that they cost nothing (INV-09, §6.4).
  const money =
    excluded.costNanoUsd === null
      ? ` No price covered any of ${one ? 'its' : 'their'} records, so no cost can be given for` +
        ` ${one ? 'it' : 'them'}.`
      : ` ${one ? 'It' : 'They'} cost ${formatCost(excluded.costNanoUsd)}.`;
  const uncosted =
    excluded.uncostedRecords > 0 && excluded.costNanoUsd !== null
      ? ` ${formatInteger(excluded.uncostedRecords)} of those records had no price for their` +
        ' model, so they are not in that figure.'
      : '';

  return `${opening} ${holds} ${records} and ${tokens}.${money}${uncosted}`;
}

/** The words for a cycle in which nothing at all was recorded. */
export const CYCLE_NOTHING_RECORDED = 'nothing recorded';

/** The words for a cycle that holds records, none of which has a price. */
export const CYCLE_NOT_PRICED = 'no price for these records';

/** The comparison cell when the cycle is still running. */
export const CYCLE_NOT_COMPARED_IN_PROGRESS = 'not compared — this cycle is not over yet';

/** …when there is nothing before it to compare against. */
export const CYCLE_NOT_COMPARED_NO_EARLIER = 'no earlier cycle to compare with';

/**
 * …when there IS an earlier cycle and it was left out of this list by the cap.
 *
 * ⚠️ Distinct from `CYCLE_NOT_COMPARED_NO_EARLIER`, which would be false here: the oldest listed
 * row does have a predecessor, it is simply not on screen, and telling the user no such cycle
 * exists is a plausible sentence that is not true (A-19 review, §4.6).
 */
export const CYCLE_NOT_COMPARED_EARLIER_NOT_SHOWN =
  'not compared — the cycle before it is not shown here';

/** …when one of the two totals does not exist. */
export const CYCLE_NOT_COMPARED_UNPRICED = 'not compared — one of these two cycles has no cost';

/**
 * Whether a cycle's `null` cost means "nothing happened" rather than "nothing was priced".
 * ⚠️ Decided on the DATA, never on the money: an empty cycle and an all-unpriced one both show no
 * `$`, and using the absent `$` to tell them apart would be reasoning from the very thing that is
 * missing (A-19, INV-09).
 */
export function cycleIsEmpty(row: BillingCycleRow): boolean {
  return (
    row.sessions === 0 &&
    row.outputTokens === 0 &&
    row.inputTokens === 0 &&
    row.cacheReadTokens === 0 &&
    row.uncostedRecords === 0
  );
}

/** What to write where the `$` would have gone when there is no `$` to write. */
export function cycleNoCostReason(row: BillingCycleRow): string {
  return cycleIsEmpty(row) ? CYCLE_NOTHING_RECORDED : CYCLE_NOT_PRICED;
}

/** The change against the cycle before it — or, in words, why there is none. */
export interface CycleChange {
  /** The signed fraction, or `null` when no honest comparison exists. NEVER 0 for "unknown". */
  ratio: number | null;
  /** Present exactly when `ratio` is `null`: the reason, in plain words. */
  reason: string | null;
}

/**
 * ⚠️ The refusals below are the whole of the partial-cycle defence, and each is a separate
 * fact so it can be said separately:
 *   · the cycle has not finished — comparing it to a finished one is comparing four days to a month;
 *   · there is no earlier cycle at all;
 *   · there is one, but the cap left it out of this list — a different fact, said differently;
 *   · one of the two has no cost, so there is nothing to divide;
 *   · the earlier one cost nothing, so the change is a division by zero — reported, never rendered
 *     as an infinity or quietly as "+100%".
 *
 * @param earlierWasExcluded true when this is the oldest listed row AND older cycles exist that
 *                           the cap dropped, so "no earlier cycle" would be a false statement.
 */
export function cycleChange(
  row: BillingCycleRow,
  previous: BillingCycleRow | undefined,
  earlierWasExcluded = false,
): CycleChange {
  if (row.inProgress) return { ratio: null, reason: CYCLE_NOT_COMPARED_IN_PROGRESS };
  if (previous === undefined) {
    return {
      ratio: null,
      reason: earlierWasExcluded
        ? CYCLE_NOT_COMPARED_EARLIER_NOT_SHOWN
        : CYCLE_NOT_COMPARED_NO_EARLIER,
    };
  }
  if (row.costNanoUsd === null || previous.costNanoUsd === null || previous.costNanoUsd === 0) {
    return { ratio: null, reason: CYCLE_NOT_COMPARED_UNPRICED };
  }
  return {
    ratio: (row.costNanoUsd - previous.costNanoUsd) / previous.costNanoUsd,
    reason: null,
  };
}

/**
 * The rows' `$` added up — `null`, never `0`, when not one of them could be costed. It selects
 * which disclosure the card renders beneath the bars (§6.4's "no pricing configured" branch), so
 * a `0` here would put an "all records costed" line under a card showing no money at all.
 */
export function cyclesTotalCost(rows: readonly BillingCycleRow[]): number | null {
  const costed = rows.filter((row) => row.costNanoUsd !== null);
  if (costed.length === 0) return null;
  return costed.reduce((sum, row) => sum + (row.costNanoUsd ?? 0), 0);
}

/**
 * INV-10 — **the `$` disclosure for exactly the rows a card is drawing**, and not for a wider
 * scope the reader cannot see.
 *
 * ⚠️ The payload's `uncosted` covers the whole scope, including cycles the cap dropped and, on
 * the Overview strip, cycles the strip does not draw. Rendered under a six-bar strip it produced
 * two defects at once: six all-unpriced bars could sit under "all records costed" because other
 * cycles were costed, and the record count beneath six bars was an all-cycles figure. The
 * disclosure has to qualify the number it is adjacent to, so it is computed over the drawn rows
 * — and the payload's own summary is used verbatim only when those rows ARE the whole scope, so
 * the models it names are never a wider set than the count beside them (A-19 review, INV-10).
 */
export function cycleCostScope(
  rows: readonly BillingCycleRow[],
  totals: BillingCycleTotals,
): { costNanoUsd: number | null; uncosted: UncostedSummary } {
  const costNanoUsd = cyclesTotalCost(rows);
  const wholeScope = totals.truncated === 0 && rows.length === totals.cycles.length;
  if (wholeScope) return { costNanoUsd, uncosted: totals.uncosted };
  return {
    costNanoUsd,
    // ⚠️ No `byModel`: a per-cycle row carries a COUNT of uncosted records and not the models
    // behind it, and pairing the whole scope's model list with a subset's count would name
    // models that may have nothing to do with these rows (§1).
    uncosted: {
      records: rows.reduce((sum, row) => sum + row.uncostedRecords, 0),
      byModel: [],
    },
  };
}

/** The newest `limit` cycles — the rows the strip draws. One definition, so a caller's
 * disclosure and the strip's bars are computed over the same rows. */
export function cyclesShownOnStrip(
  cycles: readonly BillingCycleRow[],
  limit: number,
): readonly BillingCycleRow[] {
  return cycles.slice(0, limit);
}

/** The largest cost among the rows, as the bars' denominator. `0` when nothing is costed. */
function costCeiling(rows: readonly BillingCycleRow[]): number {
  return rows.reduce((highest, row) => Math.max(highest, row.costNanoUsd ?? 0), 0);
}

/** `0..1` of the ceiling. A `null` cost has no bar at all — an absent bar, not a zero-length one. */
function costShare(row: BillingCycleRow, ceiling: number): number | null {
  if (row.costNanoUsd === null || ceiling <= 0) return null;
  return Math.max(0, row.costNanoUsd) / ceiling;
}

/** The per-row disclosure that travels with a `$` (INV-10). `null` when there is nothing to say. */
export function cycleUncostedNote(row: BillingCycleRow): string | null {
  if (row.uncostedRecords <= 0) return null;
  return `${formatInteger(row.uncostedRecords)} record${
    row.uncostedRecords === 1 ? '' : 's'
  } here had no price for their model, so they are not in this figure.`;
}

export interface CycleStripProps {
  /** Newest first, as the payload delivers them — ALL of them, not just the drawn ones. */
  cycles: readonly BillingCycleRow[];
  /** How many of the newest to draw. */
  limit: number;
  /**
   * The opening instant of the cycle the whole app is currently filtered to, or `null` when the
   * app's window is not one of these cycles. ⚠️ The selection has to be legible HERE and not only
   * in the control at the top: a click that changes eight screens must leave a mark where it was
   * made (§6.12, FRONTEND §8 — never by colour alone, so it also carries `aria-pressed`).
   */
  selectedFrom: number | null;
  /** Selecting a cycle at the top of the app. */
  onSelect: (row: BillingCycleRow) => void;
}

/**
 * §6.3 — the compact strip under the four totals. Oldest on the left, newest on the right, so it
 * reads the way time does. Clicking a bar puts that cycle in the control at the top.
 *
 * ⚠️ Every bar carries its own figure as TEXT beneath it, its own uncosted disclosure when it has
 * one, and — for the in-progress one — its progress in words: FRONTEND §8 forbids encoding
 * meaning by colour alone, and here the shorter bar means two different things depending on facts
 * the colour cannot carry.
 *
 * ⚠️ **The bars are scaled against the largest cost in the WHOLE list, not against the largest of
 * the few drawn**, so one cycle's bar is the same length here as it is in the full table on
 * Tokens & Cost. Two honest relative encodings of one quantity that disagree in length are still
 * a thing the reader has to reconcile, and the reconciliation is not on screen (A-19 review).
 */
export function CycleStrip({
  cycles,
  limit,
  selectedFrom,
  onSelect,
}: CycleStripProps): JSX.Element {
  // Reversed for reading order; sliced from the newest end, so "the last 6" really are the last 6.
  const shown = cyclesShownOnStrip(cycles, limit).toReversed();
  const ceiling = costCeiling(cycles);

  return (
    <ol data-testid="cycle-strip" className="flex items-end gap-3">
      {shown.map((row) => {
        const share = costShare(row, ceiling);
        const uncostedNote = cycleUncostedNote(row);
        const selected = selectedFrom !== null && row.from === selectedFrom;
        return (
          <li key={row.from} className="min-w-0 flex-1">
            <button
              type="button"
              data-testid="cycle-strip-bar"
              data-in-progress={row.inProgress ? 'true' : 'false'}
              data-selected={selected ? 'true' : 'false'}
              aria-pressed={selected}
              onClick={() => {
                onSelect(row);
              }}
              className={cx(
                'flex w-full flex-col items-stretch gap-2 rounded-control p-2 text-left',
                'transition-colors duration-hover hover:bg-bg-surface-2',
                selected && 'bg-bg-surface-2 shadow-ring',
              )}
            >
              <span className="flex h-24 items-end">
                {share === null ? (
                  // No bar at all: there is no figure to draw. The words below say which.
                  <span className="w-full rounded-pill border border-dashed border-border" />
                ) : (
                  <span
                    aria-hidden="true"
                    className={cx(
                      'w-full rounded-pill bg-accent',
                      // §6.12's partial treatment, reused: this window has not finished, so its
                      // height is not comparable with the complete ones beside it.
                      row.inProgress && 'opacity-70',
                    )}
                    style={{
                      // A visible floor, so a very small cost is a thin bar rather than nothing
                      // at all. ⚠️ It is a floor on the DRAWING only: the figure beside it is the
                      // real one, and no bar is drawn at all when there is no figure (§1).
                      height: `${String(Math.max(share * 100, 2))}%`,
                      backgroundImage: row.inProgress ? 'var(--hatch)' : undefined,
                    }}
                  />
                )}
              </span>
              <span className="truncate text-small text-text-primary">
                {row.costNanoUsd === null ? cycleNoCostReason(row) : formatCost(row.costNanoUsd)}
              </span>
              <span className="truncate text-micro text-text-muted">{cycleLabel(row)}</span>
              {row.inProgress && (
                <span data-testid="cycle-strip-in-progress" className="text-micro text-text-faint">
                  {cycleProgressLabel(row.elapsedDays, row.totalDays)}
                </span>
              )}
              {/* INV-10 — adjacent to the `$` above it, in flow, never a tooltip and never only
                  in the card's footer (§6.12). A bar reading "$12.00" that leaves 500 records out
                  says so on itself, exactly as the full table's row does. */}
              {uncostedNote !== null && (
                <span data-testid="cycle-strip-uncosted" className="text-micro text-text-faint">
                  {uncostedNote}
                </span>
              )}
              {selected && (
                <span data-testid="cycle-strip-selected" className="text-micro text-text-muted">
                  showing on every screen
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export interface CycleTableProps {
  /** Newest first, as the payload delivers them. Every one of them is rendered. */
  cycles: readonly BillingCycleRow[];
  /**
   * How many older cycles the cap left out of `cycles` (§4.6). ⚠️ It reaches the oldest row's
   * comparison cell: with cycles dropped, "no earlier cycle to compare with" is false.
   */
  truncated: number;
}

/**
 * §6.4 — the full list: every cycle, newest first, each with its dates, its `$`, its output
 * tokens and the change against the cycle before it.
 *
 * Newest first is chosen and kept: the question the card answers is "am I spending more than I
 * was", which is asked from the present backwards.
 */
export function CycleTable({ cycles, truncated }: CycleTableProps): JSX.Element {
  const ceiling = costCeiling(cycles);

  return (
    <ol data-testid="cycle-table" className="flex flex-col gap-3">
      {cycles.map((row, index) => {
        // Newest first, so the cycle BEFORE this one is the next element.
        const previous = cycles[index + 1];
        const change = cycleChange(
          row,
          previous,
          // The oldest row on a truncated list DOES have a predecessor; it was cut by the cap.
          previous === undefined && truncated > 0,
        );
        const share = costShare(row, ceiling);
        const uncostedNote = cycleUncostedNote(row);

        return (
          <li
            key={row.from}
            data-testid="cycle-table-row"
            data-in-progress={row.inProgress ? 'true' : 'false'}
            className={cx(
              'flex flex-col gap-1 rounded-control px-2 py-2',
              row.inProgress && 'bg-bg-surface-2',
            )}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="w-48 shrink-0 text-small text-text-primary">{cycleLabel(row)}</span>

              <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-pill bg-bg-surface-2">
                {share !== null && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 rounded-pill bg-accent"
                    style={{
                      width: `${String(share * 100)}%`,
                      backgroundImage: row.inProgress ? 'var(--hatch)' : undefined,
                    }}
                  />
                )}
              </span>

              <span className="w-28 shrink-0 text-right text-small text-text-primary tabular-nums">
                {row.costNanoUsd === null ? cycleNoCostReason(row) : formatCost(row.costNanoUsd)}
              </span>

              <span className="w-32 shrink-0 text-right text-small text-text-muted tabular-nums">
                {formatCompact(row.outputTokens)} output
              </span>

              <span
                data-testid="cycle-table-change"
                className="w-64 shrink-0 text-right text-small text-text-muted"
              >
                {change.ratio === null
                  ? change.reason
                  : `${formatDelta(change.ratio)} against the cycle before it`}
              </span>
            </div>

            {/* Adjacent to the number it qualifies, in flow, never a tooltip (§6.12, INV-10). */}
            {(row.inProgress || uncostedNote !== null) && (
              <div className="flex flex-wrap gap-x-3 text-micro text-text-faint">
                {row.inProgress && (
                  <span data-testid="cycle-table-in-progress">
                    {cycleProgressLabel(row.elapsedDays, row.totalDays)}
                  </span>
                )}
                {uncostedNote !== null && (
                  <span data-testid="cycle-table-uncosted">{uncostedNote}</span>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
