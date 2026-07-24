/**
 * §4.6 / migration 0011 — the repeated-API-call caveat, and ⚠️⚠️ **the one property it exists for:
 * "none found" and "not checked" are DIFFERENT STATES AND LOOK DIFFERENT ON SCREEN.**
 *
 * Claude Code writes one assistant turn as several JSONL lines sharing one API call. Since ADR-042
 * the CHECKED population is deduplicated — each such call is summed once — but records ingested
 * before the app read the call id carry none, so they cannot be collapsed and any repeats among
 * them are still counted more than once (the caveat now lives on the unchecked/uncheckable lines).
 * And a count of `0` over a checked population of `0` means *nothing was examined*. Rendering that
 * as "0 repeated records" would be a plausible number that means the opposite of what it says:
 * CLAUDE.md §1's worst outcome wearing a disclosure's clothes. This suite is what fails if a later
 * edit "simplifies" the two states into one.
 *
 * ⚠️ §1a is binding on every sentence here: no field name, no metric code, no `message.id`. The
 * `no-jargon` sweep is the backstop; these assertions are about the *meaning* being present.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import { OverviewView } from '../../../src/renderer/views/OverviewView';
import { useAppStore } from '../../../src/renderer/store/app-store';
import {
  REPEATS_NOT_CHECKED_SENTENCE,
  REPEATS_UNCHECKABLE_SENTENCE,
  REPEATS_UNCHECKED_SENTENCE,
  repeatedApiCallDisclosure,
} from '../../../src/renderer/views/shared/disclosures';
import { DEFAULT_DISCLOSURES } from '../harness';
import { ok, renderView, resetAll, uninstallBridge } from './view-harness';
import type { Disclosures, RepeatedApiCalls } from '../../../src/shared/ipc-contract';
import { activityCalendar, modelTimeline, overviewTiles } from './payloads';

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetAll();
});

function seed(repeats: Partial<RepeatedApiCalls>): void {
  const next: Disclosures = {
    ...DEFAULT_DISCLOSURES,
    repeatedApiCalls: {
      records: 0,
      checkedRecords: 0,
      uncheckedRecords: 0,
      uncheckableRecords: 0,
      ...repeats,
    },
  };
  act(() => {
    useAppStore.setState({ disclosures: next });
  });
}

async function renderOverview(): Promise<HTMLElement> {
  renderView(<OverviewView />, {
    'q:overviewTiles': () => ok(overviewTiles()),
    'q:activityCalendar': () => ok(activityCalendar()),
    'q:modelMixTimeline': () => ok(modelTimeline()),
  });
  await screen.findByTestId('tile-cost');
  return screen.getByTestId('tile-cost-disclosure');
}

describe('⚠️⚠️ "not checked" is never rendered as "none found"', () => {
  it('says it has not measured this, and shows NO repeat count, when nothing was checked', async () => {
    const disclosure = await renderOverview();
    seed({ records: 0, checkedRecords: 0, uncheckedRecords: 5_000 });

    const line = within(disclosure).getByTestId('repeats-unmeasured-disclosure');
    expect(line).toHaveTextContent(REPEATS_NOT_CHECKED_SENTENCE);
    // ⚠️ The sentence must contain the distinction in words, not only in the developer's head.
    expect(line.textContent ?? '').toMatch(/not measured/i);
    expect(line.textContent ?? '').toMatch(/not the same as none found/i);
    // ⚠️ And there must be no finding, because none was made.
    expect(within(disclosure).queryByTestId('repeats-found-disclosure')).not.toBeInTheDocument();
    expect(disclosure.textContent ?? '').not.toMatch(/\b0 (of|records)/);
  });

  it('⚠️ renders NOTHING at all when everything was checked and nothing repeats', async () => {
    const disclosure = await renderOverview();
    seed({ records: 0, checkedRecords: 9_000 });

    // The only silent state, and the genuine "nothing to say" one, so it follows the
    // data-dependent render-nothing-at-zero rule rather than the standing-caveat rule.
    expect(
      within(disclosure).queryByTestId('repeats-unmeasured-disclosure'),
    ).not.toBeInTheDocument();
    expect(within(disclosure).queryByTestId('repeats-found-disclosure')).not.toBeInTheDocument();
    expect(
      within(disclosure).queryByTestId('repeats-unchecked-disclosure'),
    ).not.toBeInTheDocument();
  });

  it('⚠️ the two states are DIFFERENT rendered output, which is the whole claim', () => {
    // Both have `records: 0`. Only one of them has anything to say, and it is not the same thing.
    const notChecked = repeatedApiCallDisclosure({
      records: 0,
      checkedRecords: 0,
      uncheckedRecords: 10,
      uncheckableRecords: 0,
    });
    const noneFound = repeatedApiCallDisclosure({
      records: 0,
      checkedRecords: 10,
      uncheckedRecords: 0,
      uncheckableRecords: 0,
    });
    expect(notChecked.map((line) => line.key)).toEqual(['repeats-not-checked']);
    expect(noneFound).toEqual([]);
  });
});

describe('the finding, once there is a population to have found it in', () => {
  it('states the count AGAINST the number of records it could examine', async () => {
    const disclosure = await renderOverview();
    seed({ records: 1_234, checkedRecords: 9_000 });

    const line = within(disclosure).getByTestId('repeats-found-disclosure');
    // ⚠️ Both numbers, always. "1,234 records repeat a call" alone would not say what share of
    // the data that is, and a count with no denominator is not an answer to "why believe it".
    expect(line).toHaveTextContent('1,234 of the 9,000 records checked');
    // ⚠️ AMENDED 2026-07-24 (ADR-042). The checked population is now DEDUPLICATED, so this sentence
    // must say the call is counted ONCE — not that the total is inflated and unfixed. A test that
    // kept pinning "counted more than once / nothing changed" would be the mechanism by which a
    // now-false caption survived on screen (§1/§1a), the same failure the A-16 amendment fixed for
    // the unchecked line.
    expect(line.textContent ?? '').toMatch(/count each such call once/i);
    expect(line.textContent ?? '').not.toMatch(/nothing has been changed/i);
  });

  it('adds the coverage line when part of the data was out of reach', async () => {
    const disclosure = await renderOverview();
    seed({ records: 12, checkedRecords: 100, uncheckedRecords: 40 });

    expect(within(disclosure).getByTestId('repeats-found-disclosure')).toBeInTheDocument();
    const unchecked = within(disclosure).getByTestId('repeats-unchecked-disclosure');
    expect(unchecked).toHaveTextContent('40 older records');
    expect(unchecked).toHaveTextContent(REPEATS_UNCHECKED_SENTENCE);
    // ⚠️⚠️ **AMENDED 2026-07-24 (A-16), and the amendment is the point.** This assertion used to
    // be `not.toMatch(/re-?sync|rebuild/i)` — "it promises no remedy, because the app offers
    // none". That was true and correct on the day it was written: nothing could re-read a
    // committed line. §3.18's explicit rebuild now has a control, so the SAME rule ("never name a
    // remedy that cannot work") produces the opposite assertion, and a test that kept pinning the
    // old sentence would be the mechanism by which the caveat stayed false forever.
    expect(unchecked.textContent ?? '').toMatch(/read your transcripts again|read them again/i);
    // ⚠️ And it must still not say "re-sync": an incremental re-sync genuinely cannot reach these
    // records, and that is the piece of advice this line has always refused to give.
    expect(unchecked.textContent ?? '').not.toMatch(/re-?sync/i);
    // The remedy is reachable from where the caveat is read, exactly like Settings → Pricing.
    expect(within(unchecked).getByTestId('reread-settings-link')).toHaveAttribute(
      'href',
      '/settings#reread',
    );
  });

  it('⚠️ names the records that can NEVER be checked in their own sentence', async () => {
    const disclosure = await renderOverview();
    seed({ records: 3, checkedRecords: 50, uncheckedRecords: 20, uncheckableRecords: 8 });

    const uncheckable = within(disclosure).getByTestId('repeats-uncheckable-disclosure');
    expect(uncheckable).toHaveTextContent('8 records are');
    expect(uncheckable).toHaveTextContent(REPEATS_UNCHECKABLE_SENTENCE);
    // ⚠️⚠️ A different sentence from the merely-old one, for exactly the reason the cache-split
    // disclosure splits: one describes records a rewritten file would reach, the other describes
    // records nothing will ever reach. Folding them together would blur "later" into "never".
    expect(REPEATS_UNCHECKABLE_SENTENCE).not.toBe(REPEATS_UNCHECKED_SENTENCE);
    expect(uncheckable.textContent ?? '').toMatch(/never/i);
  });

  it('reads correctly for a single record, in both directions', () => {
    const [unchecked] = repeatedApiCallDisclosure({
      records: 0,
      checkedRecords: 5,
      uncheckedRecords: 1,
      uncheckableRecords: 1,
    });
    expect(unchecked?.key).toBe('repeats-unchecked');
  });
});

describe('it rides the same slot as every other caveat on a $ figure (§6.12)', () => {
  it('sits beneath the standing list-price line, never replacing it', async () => {
    const disclosure = await renderOverview();
    seed({ records: 5, checkedRecords: 50 });

    expect(within(disclosure).getByTestId('list-price-disclosure')).toBeInTheDocument();
    const text = disclosure.textContent ?? '';
    expect(text.indexOf('API list-price equivalent')).toBeLessThan(
      text.indexOf('of the 50 records checked'),
    );
  });
});
