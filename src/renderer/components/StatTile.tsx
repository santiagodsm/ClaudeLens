/**
 * FRONTEND §5 / §6.3 — "label (micro/uppercase/muted) · hero number (display/tabular) · delta or
 * sparkline · optional gradient top-border in the metric's hue."
 *
 * ⚠️ **The disclosure line is the reason this component is not a `<div>` with a number in it.**
 * INV-10 / §6.12: "Disclosures render adjacent to the number they qualify, never in a tooltip
 * and never only in a footer." `disclosure` therefore renders *directly beneath the value*, in
 * the normal flow, always visible, with no hover and no affordance to dismiss it. There is
 * deliberately no `tooltip` prop — adding one would make the rule optional.
 *
 * ⚠️ `value` is `string | null`. `null` renders "not available", **not** `0` and not `—` with a
 * zero hiding behind it. §6.12: "a view that renders zero where it does not know is a defect".
 */

import { motion } from 'framer-motion';
import type { JSX, ReactNode } from 'react';
import { categoricalVar, GRADIENT } from '../lib/colors';
import { cx } from '../lib/cx';
import { useEntrance } from '../lib/motion';

export interface StatTileProps {
  /** Micro, uppercase, `--text-muted`, letter-spacing 0.08em (FRONTEND §3). */
  label: string;
  /**
   * The formatted hero number. `null` means "we do not know", and renders as such.
   * Formatting happens in `lib/format.ts`; this component never touches a raw number.
   */
  value: string | null;
  /** The unit or qualifier that follows the number, e.g. "tokens" or "sessions". */
  unit?: string;
  /**
   * INV-10 — the caveat that qualifies the number, rendered directly beneath it. Examples:
   * §6.3's "N records uncosted", §6.5's overlap disclosure, §6.12's partial-data caption.
   */
  disclosure?: ReactNode;
  /** Delta text or a sparkline. Sits below the disclosure so it can never displace it. */
  footer?: ReactNode;
  /** Gradient top border in the metric's hue (§3.3 index). Falls back to violet→cyan. */
  colorIndex?: number;
  /** Entrance stagger position (FRONTEND §7, ~40 ms). First mount only (§6.12). */
  index?: number;
  /** §6.12 — diagonal hatching plus a muted caption when the range has partial data. */
  partial?: boolean;
  className?: string;
  'data-testid'?: string;
}

/** The sentence a tile shows instead of a number it does not have. Never `0`. */
export const UNKNOWN_VALUE_LABEL = 'not available';

export function StatTile({
  label,
  value,
  unit,
  disclosure,
  footer,
  colorIndex,
  index = 0,
  partial = false,
  className,
  'data-testid': testId = 'stat-tile',
}: StatTileProps): JSX.Element {
  const entrance = useEntrance(index);
  const topBorder = colorIndex === undefined ? GRADIENT.violetCyan : categoricalVar(colorIndex);

  return (
    <motion.section
      {...entrance}
      data-testid={testId}
      data-partial={partial ? 'true' : undefined}
      className={cx(
        'relative overflow-hidden rounded-card border border-border bg-bg-surface p-6',
        'shadow-card transition-colors duration-hover hover:bg-bg-surface-2',
        className,
      )}
    >
      {/* FRONTEND §5 — the hue-gradient top border. Decorative: the label carries the meaning. */}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-1"
        style={{ background: topBorder }}
      />
      {partial && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ backgroundImage: 'var(--hatch)' }}
        />
      )}

      <p
        className="text-micro uppercase text-text-muted"
        style={{ letterSpacing: 'var(--tracking-micro)' }}
      >
        {label}
      </p>

      <p
        className={cx(
          'mt-2 text-display font-bold text-text-primary',
          value === null && 'text-h3 font-normal text-text-muted',
        )}
      >
        {value ?? UNKNOWN_VALUE_LABEL}
        {value !== null && unit !== undefined && (
          <span className="ml-2 text-h3 font-normal text-text-muted">{unit}</span>
        )}
      </p>

      {/* INV-10 — adjacent to the number it qualifies. In flow. Never a tooltip. */}
      {disclosure !== undefined && (
        <p data-testid={`${testId}-disclosure`} className="mt-2 text-small text-text-muted">
          {disclosure}
        </p>
      )}

      {footer !== undefined && <div className="mt-3 text-small text-text-muted">{footer}</div>}
    </motion.section>
  );
}
