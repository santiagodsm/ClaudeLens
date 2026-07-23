/**
 * §5.9 M-17, rendered by §6.6 ("**Main-loop vs subagents** — the M-17 donut with both
 * percentages, the absolute subagent output-token figure in the centre, and the message/tool-call
 * counts beneath") and again by §6.4's right rail ("the **origin split** donut … This is the
 * moment of value and it appears here as well as on Tools & Agents").
 *
 * One component for both, so the two surfaces cannot show different numbers for the same query.
 *
 * ⚠️ **Both percentages are text, not arcs** (FRONTEND §8, §6.12): the split is legible with no
 * colour perception at all, and the absolute figure sits beside the share so a reader never has
 * to multiply a percentage by a total that is somewhere else on the page.
 *
 * ⚠️ **A zero denominator is not a zero split.** With no output tokens in scope there is no
 * share to state, and the component says so rather than drawing two 0% halves (§6.12).
 *
 * visx `Pie` in a unitless viewBox (STACK ADR-011 — visx serves the bespoke radial visuals);
 * the ring is decorative and the numbers are DOM text.
 */

import type { JSX } from 'react';
import { Pie } from '@visx/shape';
import type { OriginSplit } from '../../../shared/ipc-contract';
import { categoricalVarFor } from '../../lib/colors';
import { formatCompact, formatInteger, formatPercent } from '../../lib/format';

const VIEW_SIZE = 120;
const OUTER_RADIUS = 52;
const INNER_RADIUS = 36;

/** §2.1's own words for the two origins; the hue follows the name through the §3.3 index. */
const MAIN_LABEL = 'Main loop';
const SUBAGENT_LABEL = 'Subagents';

export interface OriginDonutProps {
  split: OriginSplit;
  'data-testid'?: string;
}

interface Slice {
  label: string;
  value: number;
  hue: string;
}

export function OriginDonut({
  split,
  'data-testid': testId = 'origin-donut',
}: OriginDonutProps): JSX.Element {
  const total = split.main.output + split.subagent.output;
  const slices: Slice[] = [
    { label: MAIN_LABEL, value: split.main.output, hue: categoricalVarFor(MAIN_LABEL) },
    { label: SUBAGENT_LABEL, value: split.subagent.output, hue: categoricalVarFor(SUBAGENT_LABEL) },
  ];

  return (
    <figure data-testid={testId} className="flex flex-col items-center gap-3">
      <div className="relative">
        <svg
          viewBox={`0 0 ${String(VIEW_SIZE)} ${String(VIEW_SIZE)}`}
          className="w-40 max-w-full"
          role="img"
          aria-label="Output tokens by origin"
        >
          <g transform={`translate(${String(VIEW_SIZE / 2)},${String(VIEW_SIZE / 2)})`}>
            {total > 0 && (
              <Pie<Slice>
                data={slices}
                pieValue={(slice) => slice.value}
                outerRadius={OUTER_RADIUS}
                innerRadius={INNER_RADIUS}
                pieSort={null}
              >
                {(pie) =>
                  pie.arcs.map((arc) => (
                    <path
                      key={arc.data.label}
                      d={pie.path(arc) ?? undefined}
                      fill={arc.data.hue}
                      stroke="var(--bg-surface)"
                    />
                  ))
                }
              </Pie>
            )}
            {total === 0 && (
              <circle r={(OUTER_RADIUS + INNER_RADIUS) / 2} fill="none" stroke="var(--border)" />
            )}
          </g>
        </svg>

        {/* §6.6 — "the absolute subagent output-token figure in the centre". */}
        <span
          data-testid={`${testId}-centre`}
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center"
        >
          <span className="text-h3 font-bold text-text-primary">
            {formatCompact(split.subagent.output)}
          </span>
          <span className="text-micro text-text-muted">subagent output</span>
        </span>
      </div>

      <figcaption className="flex flex-col items-center gap-1 text-small text-text-muted">
        {total === 0 ? (
          <span data-testid={`${testId}-undefined`}>
            no output tokens in this range — no split to state
          </span>
        ) : (
          slices.map((slice) => (
            <span key={slice.label} data-testid={`${testId}-share`}>
              <span
                aria-hidden="true"
                className="mr-2 inline-block size-2 rounded-pill align-middle"
                style={{ background: slice.hue }}
              />
              {slice.label} {formatPercent(slice.value / total, 1)} · {formatInteger(slice.value)}{' '}
              output tokens
            </span>
          ))
        )}

        {/* §6.6 — "the message/tool-call counts beneath". */}
        <span className="text-text-faint">
          {formatInteger(split.main.messages)} / {formatInteger(split.subagent.messages)} messages ·{' '}
          {formatInteger(split.main.toolCalls)} / {formatInteger(split.subagent.toolCalls)} tool
          calls (main / subagent)
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * §6.6's degraded row, stated in full because "**Totals genuinely are unaffected** (§3.7), and
 * saying so is part of the disclosure". Returns `null` when there is nothing to disclose.
 */
export function unlinkedRunsFootnote(unlinkedRuns: number): string | null {
  if (unlinkedRuns <= 0) return null;
  return `${formatInteger(unlinkedRuns)} subagent run${unlinkedRuns === 1 ? '' : 's'} could not be linked to a spawn point — totals are unaffected.`;
}
