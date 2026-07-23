/**
 * §6.6 — "**Full width:** **Tool mix per project** — small multiples, one stacked pill per
 * project."
 *
 * One pill per project, segmented by tool, each segment's width proportional to its share.
 * ⚠️ Every segment carries its tool name in `title` and in the accessible list beneath, because
 * a stack of eight hues with no labels is exactly the "meaning carried by colour alone" that
 * FRONTEND §8 forbids — and with a shared 8-hue ramp (§3.3) two tools in the same pill can
 * legitimately collide.
 */

import type { JSX } from 'react';
import { categoricalVar } from '../../lib/colors';
import { formatInteger, formatPercent } from '../../lib/format';

export interface StackedPillPart {
  toolName: string;
  count: number;
  colorIndex: number;
}

export interface StackedPillProps {
  label: string;
  parts: readonly StackedPillPart[];
  'data-testid'?: string;
}

export function StackedPill({
  label,
  parts,
  'data-testid': testId = 'stacked-pill',
}: StackedPillProps): JSX.Element {
  const total = parts.reduce((sum, part) => sum + part.count, 0);

  return (
    <div data-testid={testId} className="flex flex-col gap-2">
      <p className="truncate text-small text-text-primary">{label}</p>
      {total === 0 ? (
        <p className="text-small text-text-muted">no tool calls in this range</p>
      ) : (
        <>
          <div className="flex h-3 w-full overflow-hidden rounded-pill bg-bg-surface-2">
            {parts.map((part) => (
              <span
                key={part.toolName}
                data-testid={`${testId}-part`}
                title={`${part.toolName}: ${formatInteger(part.count)}`}
                style={{
                  width: `${String((part.count / total) * 100)}%`,
                  background: categoricalVar(part.colorIndex),
                }}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-micro text-text-muted">
            {parts.map((part) => (
              <li key={part.toolName}>
                <span
                  aria-hidden="true"
                  className="mr-1 inline-block size-2 rounded-pill align-middle"
                  style={{ background: categoricalVar(part.colorIndex) }}
                />
                {part.toolName} {formatPercent(part.count / total)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
