/**
 * FRONTEND §5 — "Badge/Pill — status (ok/warn/danger), model tag (in the model's hue), count
 * chips."
 *
 * ⚠️ **Meaning is never carried by colour alone** (FRONTEND §8, §6.12, and §6.9 for Bloat Radar
 * severity). Every severity badge renders the severity **word** next to the swatch, and the
 * swatch is decorative. A screen reader, a monochrome display and a red-green colourblind user
 * all read the same badge.
 *
 * Colour is applied as a 1 px hue border plus a hue dot, never as the text colour. That is not
 * a style preference: at light-theme surfaces the §6.1 categorical ramp measures between 1.5:1
 * and 4.4:1, so hue-coloured text would fail P-29 for every hue but violet. The border-and-dot
 * treatment keeps the label at `--text-primary` (17:1 / 19:1) in both themes.
 */

import type { JSX, ReactNode } from 'react';
import type { BloatSeverity } from '../../shared/ipc-contract';
import { categoricalVar } from '../lib/colors';
import { cx } from '../lib/cx';

/** The semantic tier. `neutral` uses `--border`, keeping semantic hues for real severity. */
export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info';

const TONE_VAR: Record<BadgeTone, string> = {
  neutral: 'var(--border)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  info: 'var(--info)',
};

/** §3.12 severity → tone. `high` is danger, `medium` warn, `low` info — always with the word. */
const SEVERITY_TONE: Record<BloatSeverity, BadgeTone> = {
  high: 'danger',
  medium: 'warn',
  low: 'info',
};

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  /**
   * A categorical index (§3.3) — for a model tag, a project chip or a series legend. Wins over
   * `tone` when both are given, because a model's hue is its identity across every view.
   */
  colorIndex?: number;
  /** Renders the hue dot. On by default whenever a hue or a non-neutral tone is in play. */
  swatch?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function Badge({
  children,
  tone = 'neutral',
  colorIndex,
  swatch,
  className,
  'data-testid': testId = 'badge',
}: BadgeProps): JSX.Element {
  const hue = colorIndex === undefined ? TONE_VAR[tone] : categoricalVar(colorIndex);
  const showSwatch = swatch ?? (colorIndex !== undefined || tone !== 'neutral');

  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className={cx(
        'inline-flex items-center gap-2 rounded-pill border px-3 py-1 text-micro text-text-primary',
        className,
      )}
      style={{ borderColor: hue }}
    >
      {showSwatch && (
        <span
          aria-hidden="true"
          className="inline-block size-2 rounded-pill"
          style={{ background: hue }}
        />
      )}
      {children}
    </span>
  );
}

export interface SeverityBadgeProps {
  severity: BloatSeverity;
  className?: string;
}

/**
 * §6.9 / §3.12 — the Bloat Radar severity badge. The word IS the content; the hue is an
 * additional cue, not the message.
 */
export function SeverityBadge({ severity, className }: SeverityBadgeProps): JSX.Element {
  return (
    <Badge
      tone={SEVERITY_TONE[severity]}
      className={className}
      data-testid={`severity-${severity}`}
    >
      {severity}
    </Badge>
  );
}

export interface PillProps {
  children: ReactNode;
  /** Interactive pills are the legend/filter chips of FRONTEND §5 and §6. */
  onClick?: () => void;
  pressed?: boolean;
  colorIndex?: number;
  className?: string;
  'data-testid'?: string;
}

/** A toggleable chip: legend isolation, graph filters, segmented controls. */
export function Pill({
  children,
  onClick,
  pressed = false,
  colorIndex,
  className,
  'data-testid': testId = 'pill',
}: PillProps): JSX.Element {
  const hue = colorIndex === undefined ? undefined : categoricalVar(colorIndex);
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={onClick === undefined ? undefined : pressed}
      onClick={onClick}
      className={cx(
        'inline-flex items-center gap-2 rounded-pill border border-border px-3 py-1 text-micro',
        'transition-colors duration-hover hover:bg-bg-surface-2',
        pressed ? 'bg-bg-surface-2 text-text-primary' : 'text-text-muted',
        className,
      )}
    >
      {hue !== undefined && (
        <span
          aria-hidden="true"
          className="inline-block size-2 rounded-pill"
          style={{ background: hue }}
        />
      )}
      {children}
    </button>
  );
}
