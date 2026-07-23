/**
 * §6.7 Degraded — "Harness Map legend distinguishes designed-only, observed-only and both."
 *
 * ⚠️ This legend is the Harness Map's contract with the reader. `designed` and `observed` are
 * two fields on purpose (§4.5, M-14); if the legend showed one "edge" swatch, the view would be
 * drawing three different claims in one style and the reader would have no way to tell a
 * declared-but-dead path from a call that happens without being declared.
 *
 * ⚠️ **Meaning is never carried by colour alone** (FRONTEND §8). Every entry renders a stroke
 * *sample* — solid, dashed, or highlighted — beside the words, so the three classes are
 * distinguishable with no colour perception at all.
 */

import type { JSX } from 'react';
import { cx } from '../../lib/cx';
import {
  EDGE_EVIDENCE_LABEL,
  EDGE_EVIDENCE_NOTE,
  EDGE_EVIDENCE_STROKE,
  edgeDashArray,
  edgeIsHighlighted,
  type EdgeEvidenceClass,
} from './graph-model';

/** The order §6.7 names them in: designed-only, observed-only, both. */
const ORDER: readonly EdgeEvidenceClass[] = ['designed-only', 'observed-only', 'both', 'neither'];

const SAMPLE_WIDTH = 28;
const SAMPLE_HEIGHT = 10;

export interface EvidenceLegendProps {
  /** The classes actually present in the graph. Never fabricate an entry for an absent one. */
  present: ReadonlySet<EdgeEvidenceClass>;
  className?: string;
  'data-testid'?: string;
}

export function EvidenceLegend({
  present,
  className,
  'data-testid': testId = 'evidence-legend',
}: EvidenceLegendProps): JSX.Element {
  // ⚠️ The three specified classes are ALWAYS listed, even when a graph happens to contain none
  // of one of them: the legend is a key to what the drawing means, and a key that changes shape
  // with the data teaches the reader that an absent style is an impossible one. `neither` is the
  // exception — it is not one of §6.7's three, so it appears only when a real edge is in it.
  const classes = ORDER.filter((entry) => entry !== 'neither' || present.has(entry));

  return (
    <ul
      data-testid={testId}
      aria-label="Edge evidence"
      className={cx('flex flex-wrap items-center gap-3', className)}
    >
      {classes.map((entry) => (
        <li
          key={entry}
          data-testid={`${testId}-item`}
          data-evidence={entry}
          title={EDGE_EVIDENCE_NOTE[entry]}
          className={cx(
            'inline-flex items-center gap-2 text-micro',
            present.has(entry) ? 'text-text-primary' : 'text-text-faint',
          )}
        >
          <svg
            width={SAMPLE_WIDTH}
            height={SAMPLE_HEIGHT}
            viewBox={`0 0 ${String(SAMPLE_WIDTH)} ${String(SAMPLE_HEIGHT)}`}
            aria-hidden="true"
            className="shrink-0"
          >
            <line
              x1={0}
              y1={SAMPLE_HEIGHT / 2}
              x2={SAMPLE_WIDTH}
              y2={SAMPLE_HEIGHT / 2}
              stroke={EDGE_EVIDENCE_STROKE[entry]}
              strokeWidth={edgeIsHighlighted(entry) ? 3 : 2}
              strokeDasharray={edgeDashArray(entry) ?? undefined}
            />
          </svg>
          {EDGE_EVIDENCE_LABEL[entry]}
          {!present.has(entry) && <span className="text-text-faint"> · none</span>}
        </li>
      ))}
    </ul>
  );
}
