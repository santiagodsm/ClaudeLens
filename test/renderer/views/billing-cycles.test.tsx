/**
 * A-19 — **the two cycle-comparison surfaces**: the strip under the Overview tiles (§6.3) and the
 * full "Cost per billing cycle" card on Tokens & Cost (§6.4).
 *
 * ⚠️⚠️ **The suite exists for one assertion above all others: the cycle the clock is inside never
 * carries a change-vs-previous figure.** Today may be day 6 of 31. "−80% against the cycle before
 * it" is arithmetically correct and reads to a human as "I have cut my usage by four fifths" when
 * the truth is "the month has barely started" — a wrong number wearing a comparison's clothes
 * (CLAUDE.md §1). The other assertions here are the same family: no `$0.00` for an unknown cost,
 * an empty cycle told apart from an unpriced one by its records rather than by its money, and both
 * cards stating in words that they ignore the date chosen at the top.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { OverviewView } from '../../../src/renderer/views/OverviewView';
import { TokensView } from '../../../src/renderer/views/TokensView';
import { useAppStore } from '../../../src/renderer/store/app-store';
import { currentBillingCycle, cycleContaining } from '../../../src/renderer/lib/billing-cycle';
import { formatCost } from '../../../src/renderer/lib/format';
import {
  CYCLE_NOTHING_RECORDED,
  CYCLE_NOT_COMPARED_EARLIER_NOT_SHOWN,
  CYCLE_NOT_COMPARED_IN_PROGRESS,
  CYCLE_NOT_COMPARED_NO_EARLIER,
  CYCLE_NOT_COMPARED_UNPRICED,
  CYCLE_NOT_PRICED,
  CYCLE_SCOPE_NOTE,
  cycleChange,
  cyclesEmptyReason,
} from '../../../src/renderer/views/shared/billing-cycles';
import type { BillingCycleRow } from '../../../src/shared/ipc-contract';
import {
  ALL_COSTED_SENTENCE,
  NO_PRICING_SENTENCE,
} from '../../../src/renderer/views/shared/disclosures';
import { ok, renderView, resetAll, uninstallBridge } from './view-harness';
import type { ChannelStubs } from './view-harness';
import {
  activityCalendar,
  CYCLE_ANCHOR_DAY,
  CYCLE_FIRST,
  CYCLE_NOW,
  billingCycleRow,
  billingCycleTotals,
  cacheEfficiency,
  contextOverhead,
  costBreakdown,
  modelTimeline,
  originSplit,
  overviewTiles,
  tokensByProject,
  uncosted,
} from './payloads';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetAll();
});

/** Every channel the two hosting views touch, so the card under test is never the loading one. */
function stubs(cycles = billingCycleTotals()): ChannelStubs {
  return {
    'q:overviewTiles': () => ok(overviewTiles()),
    'q:activityCalendar': () => ok(activityCalendar()),
    'q:modelMixTimeline': () => ok(modelTimeline()),
    'q:tokensByModel': () => ok(modelTimeline()),
    'q:cacheEfficiency': () => ok(cacheEfficiency()),
    'q:contextOverhead': () => ok(contextOverhead()),
    'q:tokensByProject': () => ok(tokensByProject()),
    'q:costBreakdown': () => ok(costBreakdown()),
    'q:originSplit': () => ok(originSplit()),
    'q:billingCycleTotals': () => ok(cycles),
  };
}

/** The rows the default payload carries, newest first. */
function rows(): BillingCycleRow[] {
  return billingCycleTotals().cycles;
}

describe('A-19 — the change against the cycle before it, and when there is none', () => {
  it('⚠️ refuses a percentage for the cycle that has not finished', () => {
    const [running, complete] = rows();
    if (running === undefined || complete === undefined) throw new Error('payload has two cycles');
    expect(running.inProgress).toBe(true);

    // The arithmetic would happily produce one — that is exactly the danger.
    expect(running.costNanoUsd).not.toBeNull();
    expect(complete.costNanoUsd).not.toBeNull();
    expect(cycleChange(running, complete)).toEqual({
      ratio: null,
      reason: CYCLE_NOT_COMPARED_IN_PROGRESS,
    });
  });

  it('computes the change between two complete cycles, signed', () => {
    const previous = billingCycleRow({ from: 0, to: 1 }, { costNanoUsd: 10_000_000_000 }); // $10
    const rise = billingCycleRow({ from: 1, to: 2 }, { costNanoUsd: 15_000_000_000 }); // $15
    const fall = billingCycleRow({ from: 1, to: 2 }, { costNanoUsd: 4_000_000_000 }); // $4

    // Hand-computed: (15 − 10) / 10 = +0.5; (4 − 10) / 10 = −0.6.
    expect(cycleChange(rise, previous).ratio).toBeCloseTo(0.5, 10);
    expect(cycleChange(fall, previous).ratio).toBeCloseTo(-0.6, 10);
  });

  it('⚠️ says why rather than dividing by nothing', () => {
    const complete = billingCycleRow({ from: 1, to: 2 }, { costNanoUsd: 10_000_000_000 });
    const unpriced = billingCycleRow({ from: 0, to: 1 }, { costNanoUsd: null });
    const free = billingCycleRow({ from: 0, to: 1 }, { costNanoUsd: 0 });

    // No earlier cycle at all — the oldest row on every chart.
    expect(cycleChange(complete, undefined)).toEqual({
      ratio: null,
      reason: CYCLE_NOT_COMPARED_NO_EARLIER,
    });
    // One of the two totals does not exist; a change against an unknown is not a change.
    expect(cycleChange(complete, unpriced).ratio).toBeNull();
    expect(cycleChange(unpriced, complete)).toEqual({
      ratio: null,
      reason: CYCLE_NOT_COMPARED_UNPRICED,
    });
    // ⚠️ Division by zero: never `Infinity`, never a quiet "+100%".
    expect(cycleChange(complete, free)).toEqual({
      ratio: null,
      reason: CYCLE_NOT_COMPARED_UNPRICED,
    });
  });
});

describe('A-19 — the full card on Tokens & Cost (§6.4)', () => {
  it('renders every cycle with its dates, its cost and its comparison', async () => {
    renderView(<TokensView />, stubs());
    const card = await screen.findByTestId('tokens-billing-cycles');

    const cycleRows = within(card).getAllByTestId('cycle-table-row');
    expect(cycleRows).toHaveLength(rows().length);

    // Newest first, and the newest is the one still running.
    expect(cycleRows[0]).toHaveAttribute('data-in-progress', 'true');
    expect(cycleRows[1]).toHaveAttribute('data-in-progress', 'false');
    // $10.00 — the second cycle's own figure, rendered as money and not as a token count.
    expect(cycleRows[1]).toHaveTextContent(formatCost(20_000_000_000));
  });

  it('⚠️ marks the running cycle and says how far through it is, instead of comparing it', async () => {
    renderView(<TokensView />, stubs());
    const card = await screen.findByTestId('tokens-billing-cycles');

    const running = within(card).getAllByTestId('cycle-table-row')[0];
    if (running === undefined) throw new Error('the payload opens with a running cycle');
    expect(within(running).getByTestId('cycle-table-in-progress')).toHaveTextContent(
      'still counting — day 6 of 31',
    );
    expect(within(running).getByTestId('cycle-table-change')).toHaveTextContent(
      CYCLE_NOT_COMPARED_IN_PROGRESS,
    );
    // ⚠️ No percentage anywhere on that row: this is the assertion the whole card exists for.
    expect(running.textContent ?? '').not.toMatch(/[-+−]\d+(\.\d+)?%/);
    // And nothing is projected forward from it either — no run-rate, no forecast (§1).
    const text = card.textContent ?? '';
    expect(text).not.toMatch(/on track|projected|forecast|estimated total|per day/i);
  });

  it('⚠️ shows no `$` at all for a cycle nothing could be costed in, and says which case it is', async () => {
    const base = billingCycleTotals();
    const [running, unpriced, empty] = base.cycles;
    if (running === undefined || unpriced === undefined || empty === undefined) {
      throw new Error('the payload carries at least three cycles');
    }
    renderView(
      <TokensView />,
      stubs({
        ...base,
        cycles: [
          running,
          // Records exist; not one of them has a price (INV-09).
          { ...unpriced, costNanoUsd: null, uncostedRecords: 12 },
          // Nothing happened at all — present with measured zeros, never dropped (A-19).
          {
            ...empty,
            costNanoUsd: null,
            uncostedRecords: 0,
            sessions: 0,
            outputTokens: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
          },
          ...base.cycles.slice(3),
        ],
        uncosted: uncosted(12),
      }),
    );
    const card = await screen.findByTestId('tokens-billing-cycles');
    const cycleRows = within(card).getAllByTestId('cycle-table-row');

    const unpricedRow = cycleRows[1];
    const emptyRow = cycleRows[2];
    if (unpricedRow === undefined || emptyRow === undefined) throw new Error('three rows expected');

    // ⚠️ §6.4: never `$0.00` for a total that is unknown.
    expect(unpricedRow.textContent ?? '').not.toContain('$0.00');
    expect(emptyRow.textContent ?? '').not.toContain('$0.00');
    expect(unpricedRow).toHaveTextContent(CYCLE_NOT_PRICED);
    expect(emptyRow).toHaveTextContent(CYCLE_NOTHING_RECORDED);
    // ⚠️ The two are told apart by the records, not by the money — both show no money.
    expect(within(unpricedRow).getByTestId('cycle-table-uncosted')).toHaveTextContent(
      '12 records here had no price',
    );
    expect(within(emptyRow).queryByTestId('cycle-table-uncosted')).not.toBeInTheDocument();
  });

  it('⚠️ renders the "no pricing configured" line when NOT ONE cycle could be costed', async () => {
    const base = billingCycleTotals();
    renderView(
      <TokensView />,
      stubs({
        ...base,
        cycles: base.cycles.map((row) => ({ ...row, costNanoUsd: null, uncostedRecords: 5 })),
        uncosted: uncosted(20),
      }),
    );
    const card = await screen.findByTestId('tokens-billing-cycles');
    expect(within(card).getByTestId('tokens-billing-cycles-disclosure')).toHaveTextContent(
      NO_PRICING_SENTENCE,
    );
    // INV-10 — and the standing list-price caveat travels with every `$` surface, in every state.
    expect(within(card).getByTestId('list-price-disclosure')).toBeInTheDocument();
  });

  it('says in words that it ignores the date chosen at the top, but not the projects', async () => {
    renderView(<TokensView />, stubs());
    const card = await screen.findByTestId('tokens-billing-cycles');
    const note = within(card).getByTestId('cycle-table-scope-note');
    // ⚠️ Asserted as the words on screen. "whichever one is chosen at the top" meant "regardless
    // of" and read as though the card FOLLOWED the control — the opposite of what it states.
    expect(note).toHaveTextContent('Every billing cycle in your data is listed here.');
    expect(note).toHaveTextContent(
      'The billing cycle chosen at the top of the screen does not change these figures',
    );
    expect(note).toHaveTextContent('The projects chosen at the top do apply.');
    expect(note.textContent ?? '').not.toContain('whichever one is chosen');
  });
});

/**
 * ⚠️ The dataset's own first record, seeded exactly as `app:bootstrap` delivers it. The strip's
 * rows and the top bar's list are two readings of ONE dataset, and clicking a bar resolves the
 * cycle against that dataset — so a harness that claimed the dataset was empty would be testing a
 * state the app cannot be in (a cycle with records in a dataset with none).
 */
const BOOTED = { coverage: { transcriptsFrom: CYCLE_FIRST } };

describe('A-19 — the compact strip on Overview (§6.3)', () => {
  it('shows the newest cycles, oldest on the left, with the running one marked', async () => {
    renderView(<OverviewView />, stubs(), BOOTED);
    const strip = await screen.findByTestId('cycle-strip');

    const bars = within(strip).getAllByTestId('cycle-strip-bar');
    expect(bars).toHaveLength(rows().length);
    // Reading order is time order: the running cycle is LAST.
    expect(bars[bars.length - 1]).toHaveAttribute('data-in-progress', 'true');
    expect(bars[0]).toHaveAttribute('data-in-progress', 'false');
    expect(within(strip).getByTestId('cycle-strip-in-progress')).toHaveTextContent(
      'still counting — day 6 of 31',
    );
  });

  it('⚠️ puts the clicked cycle into the app-wide filter, so every screen follows', async () => {
    renderView(<OverviewView />, stubs(), BOOTED);
    const strip = await screen.findByTestId('cycle-strip');
    const bars = within(strip).getAllByTestId('cycle-strip-bar');

    // The leftmost bar is the OLDEST of the six shown.
    const oldest = rows()[rows().length - 1];
    if (oldest === undefined || bars[0] === undefined) throw new Error('a strip with bars');
    bars[0].click();

    await waitFor(() => {
      expect(useAppStore.getState().filter).toEqual({
        projectIds: null,
        from: oldest.from,
        to: oldest.to,
      });
    });
    // And the picker at the top now names that cycle rather than "this billing cycle".
    expect(useAppStore.getState().rangeChoice).toBe(`cycle:${String(oldest.from)}`);
  });
});

/**
 * A-19 review — a list long enough that the Overview strip's own six-bar cut actually bites, and
 * whose most expensive cycle is deliberately the OLDEST, so a bar scaled against only the drawn
 * rows and a bar scaled against the whole list are visibly different lengths.
 *
 * The windows come from the shared arithmetic, so no payload here describes a window the app
 * could not have produced.
 */
function manyCycles(count: number, overrides: Partial<BillingCycleRow>[] = []): BillingCycleRow[] {
  const built: BillingCycleRow[] = [];
  let window = currentBillingCycle(CYCLE_ANCHOR_DAY, CYCLE_NOW);
  for (let index = 0; index < count; index += 1) {
    const base: Partial<BillingCycleRow> =
      index === 0
        ? { costNanoUsd: 2_000_000_000, inProgress: true, elapsedDays: 6, totalDays: 31 }
        : // Older cycles cost more, so the tallest bar in the list is the oldest one.
          { costNanoUsd: (index + 1) * 10_000_000_000 };
    built.push(billingCycleRow(window, { ...base, ...(overrides[index] ?? {}) }));
    window = cycleContaining(CYCLE_ANCHOR_DAY, window.from - 1);
  }
  return built;
}

/** The nothing-was-left-out excluded block, as the payload carries it when nothing was. */
const NOTHING_EXCLUDED = {
  cycles: 0,
  records: 0,
  costNanoUsd: null,
  uncostedRecords: 0,
  outputTokens: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  activeSeconds: 0,
};

/** The inline height a strip bar was drawn at, as a number of percent. */
function barHeights(strip: HTMLElement): number[] {
  return within(strip)
    .getAllByTestId('cycle-strip-bar')
    .map((bar) => {
      const drawn = bar.querySelector<HTMLElement>('span[style*="height"]');
      const match = /height:\s*([\d.]+)%/.exec(drawn?.getAttribute('style') ?? '');
      return match === null ? Number.NaN : Number(match[1]);
    });
}

describe('A-19 review — the strip discloses its OWN cut, not only the payload cap (§4.6)', () => {
  it('⚠️ says how many cycles it draws and how many it does not, instead of promising all', async () => {
    // Fourteen cycles, six bars: eight rows are dropped by the strip itself.
    renderView(
      <OverviewView />,
      stubs({ ...billingCycleTotals(), cycles: manyCycles(14) }),
      BOOTED,
    );
    const card = await screen.findByTestId('overview-cycles');
    const note = within(card).getByTestId('cycle-strip-scope-note');

    expect(within(card).getAllByTestId('cycle-strip-bar')).toHaveLength(6);
    expect(note).toHaveTextContent('The 6 most recent billing cycles are shown here');
    expect(note).toHaveTextContent('8 earlier ones are in your data but not on this strip');
    // Where the ones it dropped can actually be read, named as the user sees it in the nav.
    expect(note).toHaveTextContent('Tokens & Cost');
    // ⚠️ The sentence that was false: it promised every cycle while dropping eight.
    expect(note.textContent ?? '').not.toContain('Every billing cycle in your data is shown here');
  });

  it('still says "every billing cycle" when it really is showing every one of them', async () => {
    renderView(<OverviewView />, stubs(), BOOTED);
    const card = await screen.findByTestId('overview-cycles');
    // The default payload holds four cycles, so all four are drawn.
    expect(within(card).getAllByTestId('cycle-strip-bar')).toHaveLength(4);
    expect(within(card).getByTestId('cycle-strip-scope-note')).toHaveTextContent(
      'Every billing cycle in your data is shown here.',
    );
  });

  it('⚠️ scales its bars against the whole list, so a cycle is the same length on both screens', async () => {
    // The most expensive cycle (the 14th) is off the strip. Scaled against the six drawn rows the
    // tallest of them would be a full-height bar; scaled against the list it is a fraction of one.
    const cycles = manyCycles(14);
    renderView(<OverviewView />, stubs({ ...billingCycleTotals(), cycles }), BOOTED);
    const strip = await screen.findByTestId('cycle-strip');

    const heights = barHeights(strip);
    // Hand-computed: the tallest DRAWN cycle is index 5 at 6 × $10 = $60; the tallest in the whole
    // list is index 13 at 14 × $10 = $140. 60 / 140 = 0.428… → 42.857…%.
    const tallest = Math.max(...heights);
    expect(tallest).toBeCloseTo((60 / 140) * 100, 6);
    expect(tallest).toBeLessThan(100);
  });
});

describe('A-19 review — the `$` disclosure covers the rows it sits under (INV-10)', () => {
  it('⚠️ never says "all records costed" over bars that could not be costed', async () => {
    // The six drawn cycles have no price at all; the two older ones do, and the payload's
    // scope-wide `uncosted` therefore has plenty to say about records nobody can see.
    const cycles = manyCycles(
      8,
      Array.from({ length: 6 }, () => ({ costNanoUsd: null, uncostedRecords: 5 })),
    );
    renderView(
      <OverviewView />,
      stubs({ ...billingCycleTotals(), cycles, uncosted: uncosted(30) }),
      BOOTED,
    );
    const card = await screen.findByTestId('overview-cycles');

    expect(within(card).getByTestId('overview-cycles-disclosure')).toHaveTextContent(
      NO_PRICING_SENTENCE,
    );
    // ⚠️ The reading that used to be produced: six unpriced bars under a reassurance.
    expect(card.textContent ?? '').not.toContain(ALL_COSTED_SENTENCE);
  });

  it('⚠️ counts the uncosted records of the DRAWN cycles, not of the whole dataset', async () => {
    // Six drawn cycles with 2 uncosted records each = 12; the two off-strip ones hold 88 more,
    // and the payload's scope-wide summary counts all 100.
    const cycles = manyCycles(8, [
      ...Array.from({ length: 6 }, () => ({ uncostedRecords: 2 })),
      { uncostedRecords: 44 },
      { uncostedRecords: 44 },
    ]);
    renderView(
      <OverviewView />,
      stubs({ ...billingCycleTotals(), cycles, uncosted: uncosted(100) }),
      BOOTED,
    );
    const card = await screen.findByTestId('overview-cycles');
    const disclosure = within(card).getByTestId('overview-cycles-disclosure');

    expect(disclosure).toHaveTextContent('12 records uncosted');
    expect(disclosure.textContent ?? '').not.toContain('100 records uncosted');
  });

  it('⚠️ puts a per-bar uncosted line on the bar whose `$` it qualifies', async () => {
    const cycles = manyCycles(4, [{}, { uncostedRecords: 12 }]);
    renderView(<OverviewView />, stubs({ ...billingCycleTotals(), cycles }), BOOTED);
    const strip = await screen.findByTestId('cycle-strip');

    // Reading order is time order, so the second-newest bar is the second from the right.
    const bars = within(strip).getAllByTestId('cycle-strip-bar');
    const qualified = bars[bars.length - 2];
    if (qualified === undefined) throw new Error('a strip with four bars');
    expect(within(qualified).getByTestId('cycle-strip-uncosted')).toHaveTextContent(
      '12 records here had no price for their model, so they are not in this figure.',
    );
    // And it travels with that bar only.
    expect(within(strip).getAllByTestId('cycle-strip-uncosted')).toHaveLength(1);
  });
});

describe('A-19 review — clicking a bar applies the cycle that was clicked (CLAUDE.md §1)', () => {
  /**
   * ⚠️ The first-launch state: `app:bootstrap` runs before the first parse, so the coverage
   * snapshot says the dataset has no transcripts while the strip's rows come from the live
   * database. Resolving a click against that snapshot found no matching cycle and silently
   * substituted the CURRENT one — eight views filtered to a period nobody chose.
   */
  it('⚠️ honours the clicked window even when the coverage snapshot knows nothing', async () => {
    renderView(<OverviewView />, stubs(), { coverage: { transcriptsFrom: null } });
    const strip = await screen.findByTestId('cycle-strip');
    const bars = within(strip).getAllByTestId('cycle-strip-bar');

    const oldest = rows()[rows().length - 1];
    if (oldest === undefined || bars[0] === undefined) throw new Error('a strip with bars');
    bars[0].click();

    await waitFor(() => {
      expect(useAppStore.getState().filter).toEqual({
        projectIds: null,
        from: oldest.from,
        to: oldest.to,
      });
    });
    expect(useAppStore.getState().rangeChoice).toBe(`cycle:${String(oldest.from)}`);
  });

  it('⚠️ stores "this billing cycle" when the bar clicked is the one still running', async () => {
    const bridge = renderView(<OverviewView />, stubs(), BOOTED).bridge;
    const strip = await screen.findByTestId('cycle-strip');
    const bars = within(strip).getAllByTestId('cycle-strip-bar');

    // Reading order is time order: the running cycle is the rightmost bar.
    const running = rows()[0];
    const bar = bars[bars.length - 1];
    if (running === undefined || bar === undefined) throw new Error('a strip with bars');
    bar.click();

    await waitFor(() => {
      expect(useAppStore.getState().filter.from).toBe(running.from);
    });
    // ⚠️ Frozen as `cycle:<date>` it would never roll over, and the picker — which has no such
    // row — would show its first option instead.
    expect(useAppStore.getState().rangeChoice).toBe('cycle:current');
    const written = bridge.calls
      .filter((call) => call.channel === 'settings:set')
      .map((call) => call.request as { key: string; value: unknown })
      .find((request) => request.key === 'lastRangeChoice');
    expect(written?.value).toBe('cycle:current');
  });

  it('⚠️ marks the cycle in force on the strip itself, not only in the control at the top', async () => {
    renderView(<OverviewView />, stubs(), BOOTED);
    const strip = await screen.findByTestId('cycle-strip');
    const bars = within(strip).getAllByTestId('cycle-strip-bar');
    if (bars[0] === undefined) throw new Error('a strip with bars');

    // Nothing is in force to begin with: the harness boots on an all-time window.
    expect(bars.every((bar) => bar.getAttribute('aria-pressed') === 'false')).toBe(true);

    bars[0].click();
    await waitFor(() => {
      expect(screen.getAllByTestId('cycle-strip-bar')[0]).toHaveAttribute('aria-pressed', 'true');
    });
    // Exactly one, and it says so in words as well as by the ring (FRONTEND §8).
    const pressed = screen
      .getAllByTestId('cycle-strip-bar')
      .filter((bar) => bar.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(within(strip).getAllByTestId('cycle-strip-selected')).toHaveLength(1);
  });
});

describe('A-19 review — what the cycles the cap left out actually hold (§4.6)', () => {
  const EXCLUDED = {
    cycles: 3,
    records: 1_204,
    costNanoUsd: 45_100_000_000, // $45.10
    uncostedRecords: 12,
    outputTokens: 2_100_000,
    inputTokens: 30_000,
    cacheReadTokens: 900_000,
    activeSeconds: 7_200,
  };

  it('⚠️ states their records, their tokens and their cost, not only how many there are', async () => {
    renderView(
      <TokensView />,
      stubs({ ...billingCycleTotals(), truncated: 3, excluded: EXCLUDED }),
    );
    const note = within(await screen.findByTestId('tokens-billing-cycles')).getByTestId(
      'cycle-table-scope-note',
    );

    expect(note).toHaveTextContent('3 older billing cycles are not shown.');
    expect(note).toHaveTextContent('They hold 1,204 records and 2.1M output tokens.');
    expect(note).toHaveTextContent('They cost $45.10.');
    expect(note).toHaveTextContent(
      '12 of those records had no price for their model, so they are not in that figure.',
    );
    // ⚠️ And the card no longer claims to be listing every cycle, because it is not.
    expect(note.textContent ?? '').not.toContain('Every billing cycle in your data is listed here');
  });

  it('⚠️ writes no `$` for excluded cycles nothing in them could be priced', async () => {
    renderView(
      <TokensView />,
      stubs({
        ...billingCycleTotals(),
        truncated: 1,
        excluded: { ...EXCLUDED, cycles: 1, costNanoUsd: null },
      }),
    );
    const note = within(await screen.findByTestId('tokens-billing-cycles')).getByTestId(
      'cycle-table-scope-note',
    );

    expect(note).toHaveTextContent('One older billing cycle is not shown.');
    expect(note).toHaveTextContent('No price covered any of its records');
    // ⚠️ `$0.00` would assert that those cycles cost nothing (INV-09).
    expect(note.textContent ?? '').not.toContain('$0.00');
  });

  it('⚠️ never adds a session count across cycles, in the note or anywhere else', async () => {
    // Four cycles of 1,111 sessions each: a naive total would be 4,444 — and a session that spans
    // a boundary is in both cycles, so that number is not a number of sessions at all.
    const cycles = manyCycles(4).map((row) => ({ ...row, sessions: 1_111 }));
    renderView(
      <TokensView />,
      stubs({ ...billingCycleTotals(), cycles, truncated: 3, excluded: EXCLUDED }),
    );
    const card = await screen.findByTestId('tokens-billing-cycles');
    const text = card.textContent ?? '';

    expect(text).not.toContain('4,444');
    expect(text).not.toContain('4444');
    expect(text).not.toMatch(/sessions/i);
  });

  it('⚠️ does not tell the oldest listed cycle it has no predecessor when the cap ate one', async () => {
    renderView(
      <TokensView />,
      stubs({ ...billingCycleTotals(), truncated: 3, excluded: EXCLUDED }),
    );
    const card = await screen.findByTestId('tokens-billing-cycles');
    const changes = within(card).getAllByTestId('cycle-table-change');
    const oldest = changes[changes.length - 1];
    if (oldest === undefined) throw new Error('a table with rows');

    expect(oldest).toHaveTextContent(CYCLE_NOT_COMPARED_EARLIER_NOT_SHOWN);
    expect(oldest.textContent ?? '').not.toContain(CYCLE_NOT_COMPARED_NO_EARLIER);
  });

  it('keeps "no earlier cycle" for the case where there genuinely is none', async () => {
    renderView(<TokensView />, stubs({ ...billingCycleTotals(), excluded: NOTHING_EXCLUDED }));
    const card = await screen.findByTestId('tokens-billing-cycles');
    const changes = within(card).getAllByTestId('cycle-table-change');
    expect(changes[changes.length - 1]).toHaveTextContent(CYCLE_NOT_COMPARED_NO_EARLIER);
  });
});

describe('A-19 review — why a cycle card is empty (§1a)', () => {
  it('⚠️ does not claim a filter the app does not apply', async () => {
    renderView(<OverviewView />, stubs({ ...billingCycleTotals(), cycles: [] }), BOOTED);
    const card = await screen.findByTestId('overview-cycles');

    // Cycles with nothing in them ARE listed, deliberately, so "with anything in them" described
    // a cut that never happens. The list is empty only when the scope holds nothing at all.
    expect(card.textContent ?? '').not.toContain('with anything in them');
    expect(card).toHaveTextContent('nothing has been recorded yet');
  });

  it('names the projects when they are what the scope was narrowed to', () => {
    expect(cyclesEmptyReason(null)).toContain('nothing has been recorded yet');
    expect(cyclesEmptyReason([7])).toContain('for the projects chosen at the top');
  });
});

describe('A-19 review — both cards say the same thing about the control above them', () => {
  it('states that the cycle chosen at the top does not change these figures', async () => {
    renderView(<OverviewView />, stubs(), BOOTED);
    const card = await screen.findByTestId('overview-cycles');
    expect(within(card).getByTestId('cycle-strip-scope-note')).toHaveTextContent(CYCLE_SCOPE_NOTE);
  });
});
