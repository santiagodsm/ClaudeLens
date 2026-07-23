/**
 * §6.4's "Context overhead" panel — replaced the cache-efficiency gauge per the user directive of
 * 2026-07-22 ("the cache efficiency … is always 100 percent" and is not actionable) and
 * PROGRESS.md amendment **A-11**.
 *
 * ⚠️ **Why this replaced the gauge.** Cache reads dominate token volume because every turn
 * re-sends the accumulated context, served cheaply from cache — so the old ratio sat at ~99.9%
 * for every real user and told them nothing they could act on. This panel instead shows WHERE the
 * re-read volume concentrates (the heaviest sessions), which is a thing the user can change: a
 * `/compact`, a `/clear`, or a shorter session.
 *
 * ⚠️ **The display ratio is computed HERE, at the presentation edge, and only here** (A-11,
 * §3.11's "USD only at the edge" reasoning applied to a token ratio). The wire carries the two raw
 * totals; this component divides them. When there is no output at all it does **not** divide —
 * it says so in words, never a `0` and never a `NaN` (CLAUDE.md §1).
 *
 * ⚠️ **No jargon on screen** (CLAUDE.md §1a): every number is explained in plain words, and the
 * leaderboard shows the project NAME, never a session id or an encoded path.
 */

import type { JSX } from 'react';
import type { ContextOverhead as ContextOverheadPayload } from '../../../shared/ipc-contract';
import { formatCompact, formatInteger, formatTimestamp } from '../../lib/format';

export interface ContextOverheadProps {
  data: ContextOverheadPayload;
  'data-testid'?: string;
}

/** The plain sentence that replaces the old "share of input served from cache (M-18)" jargon. */
export const CONTEXT_OVERHEAD_MEANING =
  'Every turn re-reads the whole conversation from cache. This is how much context you re-read ' +
  'for each token the model actually wrote — and which sessions carry the most of it.';

/**
 * `cacheReadTokens / outputTokens`, rounded for reading only — never stored, never on the wire
 * (A-11). One decimal below ten, a whole number above it, so a big ratio reads cleanly and a small
 * one keeps its precision. This is a DISPLAY string; the authoritative numbers are the two totals.
 */
function formatOverheadRatio(ratio: number): string {
  if (ratio >= 10) return formatInteger(Math.round(ratio));
  const fixed = ratio.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

export function ContextOverhead({
  data,
  'data-testid': testId = 'context-overhead',
}: ContextOverheadProps): JSX.Element {
  const { cacheReadTokens, outputTokens, sessions } = data;
  // ⚠️ Divide only when there is an output to divide by. `outputTokens === 0` is a real measured
  // total, not "unknown" — but a ratio over it is undefined, so it is shown in words (A-11).
  const ratio = outputTokens === 0 ? null : cacheReadTokens / outputTokens;

  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      <p className="text-small text-text-muted" data-testid="context-overhead-caption">
        {CONTEXT_OVERHEAD_MEANING}
      </p>

      {/* The headline: the re-read-per-output ratio, in a plain sentence. */}
      <p className="text-body text-text-primary" data-testid="context-overhead-headline">
        {ratio === null ? (
          'No output tokens in this range yet.'
        ) : (
          <>
            You re-read about{' '}
            <span className="text-h3 font-bold" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatOverheadRatio(ratio)}
            </span>{' '}
            tokens of context for every 1 token of output.
          </>
        )}
      </p>

      {/* The two grounding totals as real numbers — the signal the ratio is built from. */}
      <div className="grid grid-cols-2 gap-3">
        <Count label="Re-read from cache" value={cacheReadTokens} hint="cache-read tokens" />
        <Count label="Output written" value={outputTokens} hint="output tokens" />
      </div>

      {/* The leaderboard: the sessions worth compacting or clearing. */}
      {sessions.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="context-overhead-leaderboard">
          <p className="text-micro uppercase text-text-muted">
            Sessions re-reading the most context — worth compacting or clearing
          </p>
          <table className="w-full text-small" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr className="text-micro uppercase text-text-faint">
                <th className="py-1 text-left font-normal">Project</th>
                <th className="py-1 text-left font-normal">Started</th>
                <th className="py-1 text-right font-normal">Re-read from cache</th>
                <th className="py-1 text-right font-normal">Output</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                // ⚠️ §1a — keyed on the session id for React identity, but the id is NEVER rendered;
                // the visible cell is the project display name (`label`).
                <tr
                  key={session.key}
                  data-testid="context-overhead-row"
                  className="border-t border-border"
                >
                  <td className="py-1 text-left text-text-primary">{session.label}</td>
                  <td className="py-1 text-left text-text-muted">
                    {formatTimestamp(session.startedAt)}
                  </td>
                  <td className="py-1 text-right text-text-primary">
                    {formatCompact(session.cacheReadTokens)}
                  </td>
                  <td className="py-1 text-right text-text-muted">
                    {formatCompact(session.outputTokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : undefined}
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
