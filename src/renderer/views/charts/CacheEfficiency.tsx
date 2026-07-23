/**
 * §6.4's cache-efficiency card — reworked per the user directive of 2026-07-22:
 *
 *   "the cache efficiency, I do not know what it means, it is always 100 percent, and it has
 *    jargon 'share of input served from cache M-18' — I do not want jargon"
 *
 * ⚠️ **The ~100% is arithmetically correct, not a bug.** M-18 is
 * `cacheRead / (cacheRead + input)` (§5.9 M-18), and on this dataset cache reads (~19.4 billion)
 * dwarf fresh input (~11 million), so the ratio genuinely sits at ~99.9%. A gauge pinned at the
 * top of its arc carries almost no information, so the two **real token counts** lead and the
 * percentage is demoted to a small companion — the design already asked the caption to "name the
 * two real numbers" (§6.4).
 *
 * ⚠️ **No jargon on screen** (CLAUDE.md §1a): the metric id is gone and the meaning is stated in
 * words. The percentage shows **one** decimal, so the honest 99.9% appears instead of a flat,
 * misleading "100%".
 */

import type { JSX } from 'react';
import type { CacheEfficiency as CacheEfficiencyPayload } from '../../../shared/ipc-contract';
import { Gauge } from '../../components/Gauge';
import { formatInteger } from '../../lib/format';

export interface CacheEfficiencyProps {
  data: CacheEfficiencyPayload;
  'data-testid'?: string;
}

/** The plain sentence that replaces the old "share of input served from cache (M-18)" jargon. */
export const CACHE_MEANING =
  'How much of the input the model needed was reused from cache instead of re-sent — higher is cheaper.';

export function CacheEfficiency({
  data,
  'data-testid': testId = 'cache-efficiency',
}: CacheEfficiencyProps): JSX.Element {
  const { cacheReadTokens, inputTokens, hitRatio } = data;
  // M-18 is undefined when there are no input-or-cache tokens at all; that is "not available",
  // never a needle at 0% (§5.9 M-18, §6.12). The wire already reports `hitRatio: 0` there, so the
  // denominator is re-checked here rather than trusting a 0 that means "unknown".
  const ratio = cacheReadTokens + inputTokens === 0 ? null : hitRatio;

  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      <p className="text-small text-text-muted" data-testid="cache-caption">
        {CACHE_MEANING}
      </p>

      {/* The two real numbers, prominent — this is the signal, not the percentage. */}
      <div className="grid grid-cols-2 gap-3">
        <Count label="Reused from cache" value={cacheReadTokens} hint="cache reads" />
        <Count label="Fresh input sent" value={inputTokens} hint="input tokens" />
      </div>

      {/* The percentage, demoted to a small companion. One decimal so it is not a flat 100%. */}
      <div className="flex items-center gap-4">
        <Gauge
          value={ratio}
          label="Reused from cache"
          decimals={1}
          className="w-28 shrink-0"
          data-testid="gauge"
        />
        <p className="text-small text-text-muted">
          {ratio === null
            ? 'No input or cache tokens in this range yet.'
            : 'Almost all of the input was already in cache, so it cost far less than sending it fresh.'}
        </p>
      </div>
    </div>
  );
}

function Count({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-control border border-border bg-bg-surface-2 p-3">
      <span className="text-micro uppercase text-text-muted">{label}</span>
      <span
        className="text-h3 font-bold text-text-primary"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {formatInteger(value)}
      </span>
      <span className="text-micro text-text-faint">{hint}</span>
    </div>
  );
}
