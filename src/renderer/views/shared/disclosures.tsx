/**
 * The disclosure vocabulary the six analytics views share (§4.6, §6.12, INV-10, INV-23).
 *
 * ⚠️ **Why this is one module and not six copies.** §6.12: "Disclosures render adjacent to the
 * number they qualify, never in a tooltip and never only in a footer." A rule stated once and
 * implemented six times is a rule that will be implemented five times. Every `$` figure and
 * every aggregate Active-hours figure in `src/renderer/views/**` goes through the two functions
 * below, so the disclosure travels with the number by construction.
 *
 * ⚠️ **The figure itself never changes.** Neither the uncosted disclosure nor the overlap
 * disclosure corrects the number it qualifies: the number stays as §5.9 defines it and the
 * caveat travels beside it (INV-10, INV-23, ADR-037).
 */

import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router';
import type { Disclosures, UncostedSummary } from '../../../shared/ipc-contract';
import { formatDuration, formatInteger } from '../../lib/format';

/**
 * §6.4 — "If **no** price row covers **any** record, the panel renders *'No pricing configured
 * — showing tokens only'* and **shows no `$` at all.** ⚠️ It never shows `$0.00`."
 *
 * `costNanoUsd === null` is exactly that condition on the wire: the repository returns `null`
 * when zero events were costed (§4.5 `costToWire`), never `0`.
 */
export const NO_PRICING_SENTENCE = 'No pricing configured — showing tokens only';

/** §6.3 — the Cost tile's sub-line when `UncostedSummary.records === 0`. */
export const ALL_COSTED_SENTENCE = 'all records costed';

/**
 * ⚠️ **The standing list-price caveat (approved 2026-07-22), rendered beside every `$` figure.**
 *
 * §5.9 M-05 costs usage against `price_rows`, which are **published API list rates** (§3.11, the
 * seed's own notes). A Claude subscription is not billed that way, so a lifetime total — the
 * reference dataset's reads **$17,726.65** — invites exactly one wrong conclusion if it is
 * presented bare: that the user spent it.
 *
 * ⚠️ **This is a STANDING caveat, not a data-dependent one, and that difference is the whole
 * rule.** M-20's overlap disclosure renders *nothing* at `overlapSeconds === 0` because §6.3
 * refuses "a reassurance nobody asked for" on the glance surface. This line does **not** follow
 * that precedent: it is true of every `$` this application will ever show, under every filter, in
 * every state, so it is always rendered. Being constant is also what makes it safe on the glance
 * surface (§6.2): a line that is present from first paint and never changes cannot shift layout,
 * whereas a conditional line appears and disappears as data arrives.
 *
 * It renders **adjacent to the number**, in normal flow, never in a tooltip and never only in a
 * footer (§6.12).
 */
export const LIST_PRICE_SENTENCE = 'API list-price equivalent — a subscription bill will differ.';

/** The standing caveat as a node, so both surfaces render one identical, testable element. */
export function ListPriceLine(): JSX.Element {
  return <span data-testid="list-price-disclosure">{LIST_PRICE_SENTENCE}</span>;
}

/** The route the uncosted disclosure links to (§6.4: "a link to Settings → Pricing"). */
export const PRICING_SETTINGS_PATH = '/settings#pricing';

/**
 * A-16 — the route the repeated-API-call coverage line links to. The card's own `id` on §6.10, so
 * the link lands on the control rather than on the top of a long screen.
 */
export const REREAD_SETTINGS_PATH = '/settings#reread';

/** §6.5/§6.12 — the caption on a hatched, pre-transcript chart region. */
export const PARTIAL_CAPTION = 'prompts only — no transcript detail';

/** A local calendar date, for the M-06 range and the M-16 boundary (ADR-021: local time). */
export function formatDay(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

export interface UncostedLineProps {
  uncosted: UncostedSummary;
  /** §6.4 pairs the disclosure with a link to Settings → Pricing; §6.3's tile does too. */
  withPricingLink?: boolean;
}

/**
 * §5.9 M-06 — *"N records uncosted (model X, date range Y)"*, rendered next to every `$`
 * figure (INV-10). Returns `null` when there is nothing to disclose; callers use
 * `costDisclosure` rather than this directly.
 */
export function UncostedLine({ uncosted, withPricingLink = true }: UncostedLineProps): JSX.Element {
  const models = uncosted.byModel
    .map((entry) => `${entry.model}, ${formatDay(entry.fromTs)} – ${formatDay(entry.toTs)}`)
    .join('; ');

  return (
    <span data-testid="uncosted-disclosure">
      {formatInteger(uncosted.records)} record{uncosted.records === 1 ? '' : 's'} uncosted
      {models === '' ? '' : ` (${models})`}
      {withPricingLink && (
        <>
          {' · '}
          <Link
            to={PRICING_SETTINGS_PATH}
            data-testid="pricing-settings-link"
            className="underline decoration-dotted underline-offset-2 hover:text-text-primary"
          >
            Settings → Pricing
          </Link>
        </>
      )}
    </span>
  );
}

/**
 * The one decision procedure for a `$` figure's disclosure (§6.3 tile, §6.4 Cost panel).
 *
 *   · `costNanoUsd === null`  → "No pricing configured — showing tokens only" + the link.
 *                               ⚠️ The caller must render **no `$` at all** in this case.
 *   · `records > 0`           → the M-06 line + the link. The figure still renders.
 *   · otherwise               → "all records costed".
 */
export function costDisclosure(costNanoUsd: number | null, uncosted: UncostedSummary): ReactNode {
  if (costNanoUsd === null) {
    return (
      <span data-testid="no-pricing-disclosure">
        {NO_PRICING_SENTENCE}
        {' · '}
        <Link
          to={PRICING_SETTINGS_PATH}
          data-testid="pricing-settings-link"
          className="underline decoration-dotted underline-offset-2 hover:text-text-primary"
        >
          Settings → Pricing
        </Link>
      </span>
    );
  }
  if (uncosted.records > 0) return <UncostedLine uncosted={uncosted} />;
  return <span data-testid="all-costed-disclosure">{ALL_COSTED_SENTENCE}</span>;
}

/**
 * §4.6 (A-05) — the two cache-write-split caveats, which qualify a `$` figure exactly as M-06's
 * uncosted line does, and which the Cost tile and the Cost panel both render.
 *
 * The subset of `Disclosures` these need, so a caller can pass the store's snapshot straight in.
 */
export type CacheSplitDisclosure = Pick<
  Disclosures,
  'cacheSplitUnknownEvents' | 'cacheSplitArchivedEvents' | 'cacheSplitMismatches'
> &
  // Migration 0011 — optional so the type stays satisfiable by a caller that predates it; the
  // store's own `Disclosures` snapshot supplies it, and `undefined` reads as "nothing to say"
  // rather than as a zero count.
  Partial<Pick<Disclosures, 'repeatedApiCalls'>>;

/** One line of a stacked disclosure block, carrying its own stable React key. */
export interface DisclosureLine {
  key: string;
  node: ReactNode;
}

/** The sentence for the RECOVERABLE half — the one a re-sync fixes. */
export const CACHE_SPLIT_UNKNOWN_SENTENCE =
  'still costed at the 5-minute cache-write rate — re-sync to price 1-hour writes correctly';

/** ⚠️⚠️ The sentence for the half that no re-sync can fix. Different wording, deliberately. */
export const CACHE_SPLIT_ARCHIVED_SENTENCE =
  'in archived sessions, whose transcripts are never re-read — their 1-hour cache writes can no' +
  ' longer be recovered and stay costed at the 5-minute rate';

/** §5.4 rule 8 — the source contradicted itself, so neither half of the split was trusted. */
export const CACHE_SPLIT_MISMATCH_SENTENCE =
  'with a cache-write split that did not match its own total — split not used, flat total kept';

/**
 * §4.6 / §6.12 (A-05) — the cache-split caveats, adjacent to the `$` they qualify.
 *
 * ⚠️ **Three separate counts and three separate sentences, because they are three different
 * facts with three different remedies.** The first is stale DERIVED data and says so — DERIVED is
 * rebuildable, and naming the remedy is the difference between a caveat and an apology. ⚠️⚠️ The
 * second is the one genuinely irreversible case in this change: an archived session's transcripts
 * have left the Claude data directory and §5.3 `ARCHIVED` never re-parses them (§9.4, ADR-034),
 * so its 1-hour share can never be filled in. If it were folded into the first sentence, the app
 * would be telling the user to re-sync something a re-sync cannot touch. The third is a source
 * record that contradicted itself (§5.4 rule 8).
 *
 * Each renders only when its count is non-zero: unlike `LIST_PRICE_SENTENCE`, these ARE
 * data-dependent, so they follow M-20's precedent (§6.3) rather than the standing-caveat rule.
 */
export function cacheSplitDisclosure(split: CacheSplitDisclosure | null): DisclosureLine[] {
  if (split === null) return [];
  const rows: readonly { id: string; records: number; sentence: string }[] = [
    {
      id: 'cache-split-unknown',
      records: split.cacheSplitUnknownEvents,
      sentence: CACHE_SPLIT_UNKNOWN_SENTENCE,
    },
    {
      id: 'cache-split-archived',
      records: split.cacheSplitArchivedEvents,
      sentence: CACHE_SPLIT_ARCHIVED_SENTENCE,
    },
    {
      id: 'cache-split-mismatch',
      records: split.cacheSplitMismatches,
      sentence: CACHE_SPLIT_MISMATCH_SENTENCE,
    },
  ];
  return rows
    .filter((row) => row.records > 0)
    .map((row) => ({
      key: row.id,
      node: (
        <span data-testid={`${row.id}-disclosure`}>
          {formatInteger(row.records)} record{row.records === 1 ? '' : 's'} {row.sentence}.
        </span>
      ),
    }));
}

/**
 * §4.6 (migration 0011) — the repeated-API-call caveat. The subset of `Disclosures` it needs.
 */
export type RepeatedApiCallDisclosure = Pick<Disclosures, 'repeatedApiCalls'>['repeatedApiCalls'];

/**
 * ⚠️ **The sentence for "we have not looked yet", which must never be confusable with "we
 * looked and found nothing".** §1a: no field name, no metric code, no `message.id` — it says what
 * happened and what would change it, in words.
 */
export const REPEATS_NOT_CHECKED_SENTENCE =
  'none of these records have been checked for repeated usage — the app only recently began' +
  ' recording which call a record came from, so this is not measured, which is not the same as' +
  ' none found';

/**
 * The reach of the check, for records that are merely old.
 *
 * ⚠️ **AMENDED 2026-07-24 (A-16) — this sentence used to promise nothing, and that was correct
 * at the time.** A normal sync resumes from where it stopped and never re-reads a committed line
 * (§5.2 rule 3, §5.3 `GREW`), and until A-16 the only thing that re-parsed everything was a change
 * of Claude data directory (§5.1, §3.18) — so the old wording said, deliberately, that these
 * records were checked "only if their file is rewritten". §3.18's explicit rebuild now has a
 * control (§6.10 card 4a), the remedy exists, and the sentence names it. ⚠️ A sentence that keeps
 * saying "there is no way to fix this" after the way exists is a lie of exactly the kind this
 * module is built to prevent — the reverse direction of the same failure.
 *
 * ⚠️ It stays distinct from `REPEATS_UNCHECKABLE_SENTENCE`, which must NOT name this remedy: the
 * rebuild reaches live transcripts and can never reach archived or vanished ones.
 */
export const REPEATS_UNCHECKED_SENTENCE =
  'not been checked — they were read before the app started recording which call each record came' +
  ' from, so any that repeat a call are still added up more than once in these totals. A normal' +
  ' sync only reads what is new; reading your transcripts again from the start will check them';

/** ⚠️⚠️ The half that can never be checked at all — archived or vanished transcripts. */
export const REPEATS_UNCHECKABLE_SENTENCE =
  'from archived or missing transcripts, which are never re-read — any that repeat a call can' +
  ' never be checked or corrected, so they stay added up more than once';

/**
 * The finding itself, once there is a checked population to have found it in.
 *
 * ⚠️ **AMENDED 2026-07-24 (ADR-042) — this used to end "counted more than once … nothing has been
 * changed to correct it yet", and after ADR-042 that is FALSE for the checked population: those
 * totals now count each such call ONCE, at its final usage.** A caption that keeps saying the
 * number is inflated after it has been corrected is the same lie as the reverse — it looks like an
 * explanation and explains the opposite of what is true (CLAUDE.md §1/§1a). The inflation caveat now
 * lives on the UNCHECKED / UNCHECKABLE sentences, which is where it is still true (those records
 * carry no call id, so they cannot be collapsed).
 */
export const REPEATS_FOUND_SENTENCE =
  'came from a call that produced more than one record. These totals now count each such call' +
  ' once, at its final usage, so it is not added up more than once';

/**
 * §4.6 / §6.12 (migration 0011) — records that share an API call, disclosed **with the coverage
 * that makes the number readable**.
 *
 * ⚠️⚠️ **THE RULE THIS FUNCTION EXISTS TO ENFORCE, and the one a later edit is most likely to
 * "simplify" away: "none found" and "not checked" are DIFFERENT STATES AND LOOK DIFFERENT.**
 * Every record ingested before the app started reading API-call ids has none, so `records === 0`
 * over a checked population of `0` means *nothing was examined* — and rendering that as "0
 * repeated records" would be a plausible number that means the opposite of what it says, which
 * is CLAUDE.md §1's worst outcome wearing a disclosure's clothes. So:
 *
 *   · nothing checked            → say so, loudly, and never show a repeat count.
 *   · something checked, some not→ show the count AND how much of the data it speaks for.
 *   · everything checked, none   → render nothing. This is the only silent state, and it is the
 *                                  genuine "nothing to say" one, so it follows §6.12's
 *                                  data-dependent rule rather than the standing-caveat one.
 *
 * ⚠️ The unchecked half is split the way A-05's is (§4.6): a rebuild reaches live transcripts and
 * can never reach archived or vanished ones, so the remedy is named only where it can work.
 */
export function repeatedApiCallDisclosure(
  repeats: RepeatedApiCallDisclosure | null,
): DisclosureLine[] {
  if (repeats === null) return [];
  const { records, checkedRecords, uncheckedRecords, uncheckableRecords } = repeats;
  const lines: DisclosureLine[] = [];

  if (checkedRecords === 0) {
    // ⚠️ NOT "0 repeated records". There is no count to give, and giving one would be a claim.
    lines.push({
      key: 'repeats-not-checked',
      node: (
        <span data-testid="repeats-unmeasured-disclosure">{REPEATS_NOT_CHECKED_SENTENCE}.</span>
      ),
    });
  } else if (records > 0) {
    lines.push({
      key: 'repeats-found',
      node: (
        <span data-testid="repeats-found-disclosure">
          {formatInteger(records)} of the {formatInteger(checkedRecords)} records checked{' '}
          {REPEATS_FOUND_SENTENCE}.
        </span>
      ),
    });
  }

  // The coverage line rides alongside whenever part of the data was out of reach, in both of the
  // states above AND in the "checked, none found" state — because "none found" over half the data
  // is a different fact from "none found" over all of it.
  if (checkedRecords > 0 && uncheckedRecords > 0) {
    lines.push({
      key: 'repeats-unchecked',
      node: (
        <span data-testid="repeats-unchecked-disclosure">
          {formatInteger(uncheckedRecords)} older record
          {uncheckedRecords === 1 ? ' has' : 's have'} {REPEATS_UNCHECKED_SENTENCE}.
          {/* A-16 — the same shape the uncosted line uses for Settings → Pricing: the remedy is
              named AND reachable from where the caveat is read. */}
          {' · '}
          <Link
            to={REREAD_SETTINGS_PATH}
            data-testid="reread-settings-link"
            className="underline decoration-dotted underline-offset-2 hover:text-text-primary"
          >
            Settings → Read your transcripts again
          </Link>
        </span>
      ),
    });
  }
  if (uncheckableRecords > 0) {
    lines.push({
      key: 'repeats-uncheckable',
      node: (
        <span data-testid="repeats-uncheckable-disclosure">
          {formatInteger(uncheckableRecords)} record
          {uncheckableRecords === 1 ? ' is' : 's are'} {REPEATS_UNCHECKABLE_SENTENCE}.
        </span>
      ),
    });
  }
  return lines;
}

/**
 * Everything that must sit beside a `$` figure, in one place, in one order (§6.12, INV-10).
 *
 * ⚠️ Line 1 is the **standing** list-price caveat and is always present. Lines 2+ are the
 * data-dependent ones and appear only when they have something to say. Stacked as block-level
 * `<span>`s rather than `<p>`s because both call sites already render this inside a `<p>`
 * (`StatTile`, `ChartCard`) and a nested `<p>` is invalid HTML.
 */
export function costDisclosureBlock(
  costNanoUsd: number | null,
  uncosted: UncostedSummary,
  split: CacheSplitDisclosure | null = null,
): ReactNode {
  const lines: DisclosureLine[] = [
    { key: 'list-price', node: <ListPriceLine /> },
    { key: 'cost', node: costDisclosure(costNanoUsd, uncosted) },
    ...cacheSplitDisclosure(split),
    // Migration 0011 — last, because it is the newest and least settled fact about the figure,
    // and because it qualifies the token sums behind the `$` rather than the pricing of them.
    ...repeatedApiCallDisclosure(split?.repeatedApiCalls ?? null),
  ];
  return (
    <>
      {lines.map((line) => (
        <span key={line.key} className="block">
          {line.node}
        </span>
      ))}
    </>
  );
}

/**
 * §6.3 / §5.9 M-20 / ADR-037 — the Active-hours companion disclosure, stated exactly:
 *
 *   · **`overlapSeconds === 0` → `undefined`, i.e. render nothing extra.** Deliberately *not* a
 *     positive confirmation like the Cost tile's "all records costed": the Overview is the
 *     3-second wordless glance surface (§1.3 moment 3) and "a reassurance nobody asked for is
 *     noise on the one screen whose rule is that nothing moves or accretes" (§6.3).
 *   · **`> 0` → *"N hours of this total overlap across projects"***, directly beneath the number
 *     and never in a tooltip, formatted to the tile's own precision.
 *
 * ⚠️ The Active-hours figure itself is unchanged either way (INV-23).
 */
export function overlapDisclosure(overlapSeconds: number): ReactNode {
  if (overlapSeconds <= 0) return undefined;
  return (
    <span data-testid="overlap-disclosure">
      {formatDuration(overlapSeconds)} of this total overlap across projects.
    </span>
  );
}

export interface PartialCaptionProps {
  /** §4.3 `DataCoverage.partialBefore` — prompts exist before this, transcripts do not. */
  partialBefore: number | null;
  className?: string;
}

/**
 * §6.12 — the muted caption that names the boundary date beside a hatched region. Renders
 * nothing when there is no boundary, because a caption about an absent condition is noise.
 */
export function PartialCaption({ partialBefore, className }: PartialCaptionProps): JSX.Element {
  if (partialBefore === null) return <></>;
  return (
    <span data-testid="partial-caption" className={className}>
      {PARTIAL_CAPTION} — before {formatDay(partialBefore)}
    </span>
  );
}

export interface HatchOverlayProps {
  /** The share of the plotting area to hatch, `0..1`, measured from the left edge. */
  fraction: number;
  label?: string;
}

/**
 * §6.12's partial-data treatment, half one: "diagonal hatching over the affected chart region".
 * The other half — "the value **suppressed rather than zeroed**" — is done by the caller, which
 * passes `null` for the affected buckets so no series draws a point there.
 */
export function HatchOverlay({
  fraction,
  label = PARTIAL_CAPTION,
}: HatchOverlayProps): JSX.Element {
  if (fraction <= 0) return <></>;
  const width = Math.min(1, fraction) * 100;
  return (
    <span
      data-testid="partial-hatch"
      aria-label={label}
      role="img"
      className="pointer-events-none absolute inset-y-0 left-0"
      style={{ width: `${String(width)}%`, backgroundImage: 'var(--hatch)' }}
    />
  );
}

/**
 * §6.12 — how many leading buckets fall before the transcript boundary and must therefore be
 * suppressed rather than zeroed. Buckets are local `YYYY-MM-DD` strings for both the `day` and
 * the `week` granularity (§4.5, the week is labelled by its Monday), so one comparison serves
 * both. A bucket is suppressed only when the whole bucket precedes the boundary day.
 */
export function suppressedBucketCount(buckets: string[], partialBefore: number | null): number {
  if (partialBefore === null) return 0;
  const boundary = localDayString(partialBefore);
  let count = 0;
  for (const bucket of buckets) {
    if (bucket >= boundary) break;
    count += 1;
  }
  return count;
}

/** ADR-021 — the local calendar date of an instant, as the `YYYY-MM-DD` the queries emit. */
export function localDayString(epochMs: number): string {
  const date = new Date(epochMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}
