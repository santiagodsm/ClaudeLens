/**
 * FRONTEND §6 — "Legends: interactive (click to isolate/toggle series) where the library
 * allows." §6.3 asks for exactly this on the model-mix area chart.
 *
 * ⚠️ **Meaning is never carried by colour alone** (FRONTEND §8, §6.12). Every entry is the
 * series *name* with the hue as a swatch beside it, and the toggle state is `aria-pressed`, not
 * an opacity difference. E7's `Pill` already renders that shape, so this is composition rather
 * than a new primitive.
 */

import type { JSX } from 'react';
import { Pill } from '../../components/Badge';

export interface SeriesLegendEntry {
  /** The series identity — a model, a project, a tool. Always rendered as text. */
  name: string;
  /** §3.3 stable hue index, so a series keeps its colour in every view. */
  colorIndex: number;
}

export interface SeriesLegendProps {
  entries: readonly SeriesLegendEntry[];
  /** Names currently toggled off. */
  hidden: ReadonlySet<string>;
  onToggle: (name: string) => void;
  'data-testid'?: string;
}

export function SeriesLegend({
  entries,
  hidden,
  onToggle,
  'data-testid': testId = 'series-legend',
}: SeriesLegendProps): JSX.Element {
  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-2">
      {entries.map((entry) => (
        <Pill
          key={entry.name}
          colorIndex={entry.colorIndex}
          pressed={!hidden.has(entry.name)}
          onClick={() => {
            onToggle(entry.name);
          }}
          data-testid={`${testId}-item`}
        >
          {entry.name}
        </Pill>
      ))}
    </div>
  );
}
