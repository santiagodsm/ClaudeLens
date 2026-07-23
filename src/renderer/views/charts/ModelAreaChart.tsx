/**
 * The stacked gradient area over time, shared by §6.3 ("Model mix over time") and §6.4
 * ("<All|Output> tokens by model"). One component, because §4.5 gives `q:modelMixTimeline` and
 * `q:tokensByModel` the same `ModelTimeline` shape and two implementations of one chart is two
 * places for a hue or a suppression rule to drift.
 *
 * Recharts (STACK ADR-011 — "standard chart types (stacked areas, bars, histogram)").
 * FRONTEND §2/§6: fill = series hue at 0.35 alpha → transparent, stroke = full hue at 1.5 px,
 * horizontal grid lines only, axis text muted and abbreviated.
 *
 * ⚠️ **Partial data is suppressed, not zeroed** (§6.12). Buckets before `partialBefore` are
 * passed as `null`, so no series draws a point there and the region is hatched and captioned
 * instead. Passing `0` would assert "no tokens that week", which is a different and false claim
 * from "we have prompts but no transcript".
 *
 * ⚠️ **The entrance runs on first mount only, and the series animation is off entirely** (§6.12,
 * §1.3 moment 2). Recharts replays its per-series animation on every data change, which is
 * precisely "a live data update re-animating a chart"; there is no flag that switches it off
 * afterwards without re-rendering mid-animation. So the entrance is the **card's** — Framer's
 * `initial → animate`, which runs at mount and never again (`lib/motion.ts`) — and the areas
 * themselves update in place. That is also what §6.2 asks for on a window that sits in
 * peripheral vision for nine hours: numbers move, nothing replays.
 */

import { useId } from 'react';
import type { JSX } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ModelTimeline } from '../../../shared/ipc-contract';
import { categoricalVar } from '../../lib/colors';
import { formatCompact, formatInteger } from '../../lib/format';
import { HatchOverlay } from '../shared/disclosures';

/** Unitless; the container is responsive in width and fixed in height (FRONTEND §4 grid). */
const CHART_HEIGHT = 260;
/** FRONTEND §2 — "fill = series hue at 0.35 alpha → transparent (top→bottom)". */
const FILL_OPACITY = 0.35;
/** FRONTEND §2 — "Stroke = full hue", 1.5 px. Unitless SVG stroke width, not a CSS length. */
const STROKE_WIDTH = 1.5;

export interface ModelAreaChartProps {
  timeline: ModelTimeline;
  /** Models the interactive legend has toggled off (FRONTEND §6). */
  hidden?: ReadonlySet<string>;
  /** Leading buckets that fall before `partialBefore` and must be suppressed (§6.12). */
  suppressedBuckets?: number;
  /** What the values count — "events", "tokens". Used in the accessible summary. */
  unit: string;
  /**
   * ⚠️ The plain-language explanation of the hatched region, rendered VISIBLY on the chart so the
   * grey band at the start explains itself (user directive 2026-07-22 §1a — "I don't know what
   * the grey area at the start means"). Optional so a caller that has no boundary date still gets
   * a sensible default; §6.12 keeps its own caption below the chart as well.
   */
  partialLabel?: string;
  'data-testid'?: string;
}

/** The word the vertical axis is measured in, capitalised for an axis title. */
function axisUnitLabel(unit: string): string {
  return unit.charAt(0).toUpperCase() + unit.slice(1);
}

interface Row {
  bucket: string;
  [model: string]: string | number | null;
}

export function ModelAreaChart({
  timeline,
  hidden,
  suppressedBuckets = 0,
  unit,
  partialLabel,
  'data-testid': testId = 'model-area-chart',
}: ModelAreaChartProps): JSX.Element {
  const gradientId = useId();
  const visible = timeline.series.filter((series) => hidden?.has(series.model) !== true);

  const rows: Row[] = timeline.buckets.map((bucket, index) => {
    const row: Row = { bucket };
    for (const series of visible) {
      // §6.12 — suppressed, never zeroed.
      row[series.model] = index < suppressedBuckets ? null : (series.data[index] ?? null);
    }
    return row;
  });

  const fraction = timeline.buckets.length === 0 ? 0 : suppressedBuckets / timeline.buckets.length;

  return (
    <div className="relative" data-testid={testId} style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer width="100%" height="100%">
        {/* Margins leave room for the two axis titles (§1a — both axes labelled in words). */}
        <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 20, left: 8 }}>
          <defs>
            {visible.map((series) => (
              <linearGradient
                key={series.model}
                id={`${gradientId}-${String(series.colorIndex)}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor={categoricalVar(series.colorIndex)}
                  stopOpacity={FILL_OPACITY}
                />
                <stop offset="100%" stopColor={categoricalVar(series.colorIndex)} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          {/* FRONTEND §6 — "Grid lines: --border at low alpha, horizontal only". */}
          <CartesianGrid stroke="var(--border)" vertical={false} />
          {/* ⚠️ §1a — both axes carry a plain word for what they show: time along the bottom,
              the counted quantity up the side. */}
          <XAxis
            dataKey="bucket"
            stroke="var(--text-muted)"
            tickLine={false}
            axisLine={false}
            label={{
              value: 'Date',
              position: 'insideBottom',
              offset: -12,
              fill: 'var(--text-muted)',
              fontSize: 11,
            }}
          />
          <YAxis
            stroke="var(--text-muted)"
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) => formatCompact(value)}
            label={{
              value: axisUnitLabel(unit),
              angle: -90,
              position: 'insideLeft',
              style: { textAnchor: 'middle' },
              fill: 'var(--text-muted)',
              fontSize: 11,
            }}
          />
          <Tooltip
            // FRONTEND §6 — "Tooltips: --bg-surface-2, 10px radius, soft shadow". Radius and
            // shadow come from the token layer; no raw length appears here (§6.1).
            contentStyle={{
              background: 'var(--bg-surface-2)',
              borderRadius: 'var(--radius-control)',
              boxShadow: 'var(--shadow)',
              color: 'var(--text-primary)',
            }}
            formatter={(value, name) => [
              typeof value === 'number' ? formatInteger(value) : String(value ?? '—'),
              String(name ?? ''),
            ]}
          />
          {visible.map((series) => (
            <Area
              key={series.model}
              type="monotone"
              dataKey={series.model}
              name={series.model}
              stackId="tokens"
              stroke={categoricalVar(series.colorIndex)}
              strokeWidth={STROKE_WIDTH}
              fill={`url(#${gradientId}-${String(series.colorIndex)})`}
              // §6.12 — a suppressed bucket is a hole in the series, not a zero.
              connectNulls={false}
              // ⚠️ Never — see the note at the top of this file. A live update must not replay.
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>

      <HatchOverlay fraction={fraction} />

      {/* ⚠️ The visible words on the grey band, so it explains itself rather than needing the
          caption below to be read (user directive 2026-07-22). Only when there IS a hatched
          region; positioned over it, wrapped, never overlapping the plotted series. */}
      {suppressedBuckets > 0 && (
        <span
          data-testid="partial-region-label"
          className="pointer-events-none absolute bottom-8 left-2 max-w-[45%] text-micro leading-tight text-text-muted"
        >
          {partialLabel ?? 'Earlier here we only have prompts, not full token detail.'}
        </span>
      )}

      {/* FRONTEND §8 — the series and their totals are reachable without seeing the chart. */}
      <ul className="sr-only">
        {visible.map((series) => (
          <li key={series.model}>
            {series.model}: {formatInteger(series.data.reduce((sum, value) => sum + value, 0))}{' '}
            {unit}
          </li>
        ))}
      </ul>
    </div>
  );
}
