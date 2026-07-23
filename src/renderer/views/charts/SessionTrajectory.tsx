/**
 * §6.4 (PROGRESS.md amendment **A-12**, 2026-07-23) — "Session efficiency over time".
 *
 * Watch one session's context pile up while its output stays comparatively flat, so you can see
 * when it is worth a `/clear` or `/compact`. Left, in three tiers classified against the injected
 * clock (never the query, §1): **LIVE NOW** (active in the last ~5 min — a pulsing green dot),
 * **RECENTLY ACTIVE** (active in the last hour — a hollow green dot and an "active Nm ago" label),
 * then the rest grouped by project, each a small ratio sparkline plus a green/amber/red end-state
 * dot. The verdict word shows on every row, so live/recent rows keep their verdict too. Right: the
 * selected session as three tall aligned
 * curves over the same turn index — context fed per turn (climbs, sawtooths at a reset) with a
 * token-count y-axis, output per turn (flat) with a token-count y-axis, and the efficiency curve as
 * **"efficiency lost since it started"** on a FIXED 0–100% y-axis (0% = as fresh as its start at the
 * bottom, 100% = fully bloated at the top; it rises as the session bloats). The flag threshold is a
 * horizontal line with the danger band shaded ABOVE it; dragging the slider moves the line and
 * re-colours the curve instantly. ⚠️ The stored setting and the flag rule are unchanged — this is
 * only how the third curve is drawn and labelled; `bandOf` still decides the colours.
 *
 * ⚠️ **"Efficiency" here is output produced per token of context carried — a self-referential
 * proxy, NOT answer quality** (this app cannot see quality). No copy on this surface implies it.
 *
 * ⚠️ **Every colour, baseline, decay and verdict is computed HERE, from the raw per-turn pairs the
 * wire carries** (`analyseTrajectory` / `verdictOf` in `src/shared/trajectory.ts`). The slider only
 * changes the threshold, so the curve re-colours instantly with no re-query and nothing stored
 * (A-12, ADR-027). A turn whose context is `0` is a real point on the context/output curves but a
 * GAP on the ratio curve — it is never divided (§1).
 *
 * ⚠️ **A session with too few turns to judge renders grey "too short to judge", never a fabricated
 * red** (§1). A live session's last turn may be mid-write, so its endpoint is drawn in-progress.
 *
 * ⚠️ **No jargon** (§1a): the session id is React identity and a hover title only, never visible;
 * every row is labelled by its project NAME plus a start time, so two sessions never read as one.
 */

import { useState } from 'react';
import type { JSX } from 'react';
import type { ContextOverhead } from '../../../shared/ipc-contract';
import {
  analyseTrajectory,
  bandOf,
  efficiencyLostPercent,
  greyReasonOf,
  isLive,
  isRecent,
  lastN,
  verdictOf,
  type Trajectory,
  type TrajectoryBand,
  type TrajectoryPoint,
} from '../../../shared/trajectory';
import { formatCompact, formatInteger, formatRelative, formatTimestamp } from '../../lib/format';
import { SegmentedControl } from '../shared/SegmentedControl';

type Session = ContextOverhead['sessions'][number];

/**
 * A-12 — the detail view's x-axis window (view zoom). ⚠️ Ephemeral component state, NOT a persisted
 * setting: it changes what the curves DRAW, never what is measured. "Whole session" is the default.
 */
type WindowChoice = 'all' | '20' | '10' | '5';
const WINDOW_OPTIONS: readonly { value: WindowChoice; label: string }[] = [
  { value: 'all', label: 'Whole session' },
  { value: '20', label: 'Last 20' },
  { value: '10', label: 'Last 10' },
  { value: '5', label: 'Last 5' },
];

/** A-12 — the colour of each band, from the reserved semantic tokens (§6.1, never a raw hex). */
const BAND_VAR: Record<TrajectoryBand, string> = {
  green: 'var(--ok)',
  amber: 'var(--warn)',
  red: 'var(--danger)',
  grey: 'var(--text-faint)',
};

/** A-12 — the plain-words verdict. Speaks to context weight, never to answer quality (§1a). */
const BAND_WORD: Record<TrajectoryBand, string> = {
  green: 'Still efficient',
  amber: 'Getting heavier',
  red: 'Worth clearing or compacting',
  grey: 'Too short to judge',
};

const MIN_PERCENT = 5;
const MAX_PERCENT = 95;

export interface SessionTrajectoryProps {
  data: ContextOverhead;
  /** The flag threshold as a fraction in [0.05, 0.95] (the persisted `efficiencyDropThreshold`). */
  threshold: number;
  onThresholdChange: (value: number) => void;
  /** Injected so the "live" comparison is a property of a value in tests, not of the wall clock. */
  now?: number;
  'data-testid'?: string;
}

export function SessionTrajectory({
  data,
  threshold,
  onThresholdChange,
  now,
  'data-testid': testId = 'session-trajectory',
}: SessionTrajectoryProps): JSX.Element {
  const { sessions } = data;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = sessions.find((session) => session.key === selectedKey) ?? sessions[0] ?? null;

  // ⚠️ A-12 / §1 — reading the wall clock is impure, so it is read ONCE, in a lazy initializer
  // (the React-blessed "read an external value at mount" escape hatch), never repeatedly during
  // render. The comparison to it is purely presentational: it drives the "live" hint and is written
  // NOWHERE and fed to no metric. Tests pass `now` explicitly, so the signal is a property of a
  // value there rather than of the clock.
  const [mountedNow] = useState<number>(() => Date.now());
  const effectiveNow = now ?? mountedNow;

  // ⚠️ A-12 — the slider and graph share ONE "lost" framing. The STORED value is unchanged — a
  // retained-efficiency fraction (`efficiencyDropThreshold`, default 0.40). The slider just shows
  // and edits it as its complement, "% lost": display = 100 − round(threshold×100) (60 by default),
  // and a change of L% maps back to a stored threshold of (100 − L)/100. Slider range 5–95 (% lost)
  // ↔ stored 0.95–0.05, both inside the validated [0.05, 0.95]. No rule and no math changed.
  const lostPercent = 100 - Math.round(threshold * 100);

  // ⚠️ A-12 — three tiers, all classified HERE against the injected clock (`isLive`/`isRecent`),
  // never in the query, and written nowhere (§1's one sanctioned clock use). LIVE NOW and RECENTLY
  // ACTIVE float to the top independent of token weight, most-recent first; both are pulled OUT of
  // the project groups so no session is listed twice.
  const liveSessions = sessions
    .filter((session) => isLive(session.lastActivityTs, effectiveNow))
    .toSorted((left, right) => right.lastActivityTs - left.lastActivityTs);
  const recentSessions = sessions
    .filter((session) => isRecent(session.lastActivityTs, effectiveNow))
    .toSorted((left, right) => right.lastActivityTs - left.lastActivityTs);
  const surfacedKeys = new Set([...liveSessions, ...recentSessions].map((session) => session.key));

  // The rest, grouped by project display NAME, so a project's sessions sit together under one
  // heading and each row disambiguates by start time (A-11 review finding A). ⚠️ Keyed by the name,
  // not the unit id, so two DIFFERENT projects that happen to share a display name (migration 0006
  // allows it) collapse under one heading here — accepted for now; grouping by project id is a
  // separate question the coordinator is raising with the user. §1a keeps the id off screen either
  // way.
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    if (surfacedKeys.has(session.key)) continue; // already surfaced in a live/recent group
    const list = groups.get(session.label) ?? [];
    list.push(session);
    groups.set(session.label, list);
  }

  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      <p className="text-small text-text-muted" data-testid={`${testId}-caption`}>
        Each session&apos;s context grows as it re-reads the whole conversation, while the tokens it
        writes stay about the same. This flags a session once it is doing far less writing per token
        of context than it did when it started — a good moment to clear or compact it. It is not a
        judgement of the answers.
      </p>

      {/* The slider — the whole point of the feature. Recolours everything below instantly. */}
      <label className="flex flex-wrap items-center gap-3 text-small text-text-primary">
        <span className="shrink-0">Flag a session once it has lost more than</span>
        <input
          type="range"
          data-testid={`${testId}-threshold-slider`}
          aria-label="Flag a session once it has lost more than this share of its starting efficiency"
          min={MIN_PERCENT}
          max={MAX_PERCENT}
          step={5}
          value={lostPercent}
          onChange={(event) => {
            // Display is "% lost"; stored value is the retained fraction (100 − lost) / 100.
            onThresholdChange((100 - Number.parseInt(event.target.value, 10)) / 100);
          }}
          className="min-w-40 flex-1"
        />
        <span
          data-testid={`${testId}-threshold-value`}
          className="w-24 shrink-0 text-right"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {lostPercent}% lost
        </span>
      </label>

      {sessions.length === 0 ? (
        <p className="text-small text-text-muted">No sessions with turns in this range yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          {/* Left — LIVE NOW, then RECENTLY ACTIVE, then the project groups. */}
          <ul className="flex flex-col gap-3" data-testid={`${testId}-list`}>
            {liveSessions.length > 0 ? (
              <li className="flex flex-col gap-1" data-testid={`${testId}-live-group`}>
                <p className="flex items-center gap-2 text-micro font-semibold uppercase text-ok">
                  <span
                    className="dot-pulse h-2 w-2 rounded-full"
                    style={{ backgroundColor: 'var(--ok)' }}
                    aria-hidden
                  />
                  Live now ({liveSessions.length})
                </p>
                <ul className="flex flex-col gap-1">
                  {liveSessions.map((session) => (
                    <SessionRow
                      key={session.key}
                      session={session}
                      threshold={threshold}
                      now={effectiveNow}
                      tier="live"
                      selected={selected?.key === session.key}
                      onSelect={() => {
                        setSelectedKey(session.key);
                      }}
                      testId={`${testId}-row`}
                    />
                  ))}
                </ul>
              </li>
            ) : undefined}
            {recentSessions.length > 0 ? (
              <li className="flex flex-col gap-1" data-testid={`${testId}-recent-group`}>
                <p className="text-micro font-medium uppercase text-text-muted">
                  Recently active ({recentSessions.length})
                </p>
                <ul className="flex flex-col gap-1">
                  {recentSessions.map((session) => (
                    <SessionRow
                      key={session.key}
                      session={session}
                      threshold={threshold}
                      now={effectiveNow}
                      tier="recent"
                      selected={selected?.key === session.key}
                      onSelect={() => {
                        setSelectedKey(session.key);
                      }}
                      testId={`${testId}-row`}
                    />
                  ))}
                </ul>
              </li>
            ) : undefined}
            {[...groups.entries()].map(([label, rows]) => (
              <li key={label} className="flex flex-col gap-1">
                <p className="text-micro uppercase text-text-muted">{label}</p>
                <ul className="flex flex-col gap-1">
                  {rows.map((session) => (
                    <SessionRow
                      key={session.key}
                      session={session}
                      threshold={threshold}
                      now={effectiveNow}
                      tier={null}
                      selected={selected?.key === session.key}
                      onSelect={() => {
                        setSelectedKey(session.key);
                      }}
                      testId={`${testId}-row`}
                    />
                  ))}
                </ul>
              </li>
            ))}
          </ul>

          {/* Right — the selected session's three aligned curves. */}
          {selected !== null ? (
            <SessionDetail
              session={selected}
              threshold={threshold}
              now={effectiveNow}
              testId={`${testId}-detail`}
            />
          ) : undefined}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// The list row: a ratio sparkline, an end-state dot, a live indicator.
// ---------------------------------------------------------------------------------------

function SessionRow({
  session,
  threshold,
  now,
  tier,
  selected,
  onSelect,
  testId,
}: {
  session: Session;
  threshold: number;
  now: number | null;
  /** A-12 — which tier's group this row is in: 'live', 'recent', or null (a project group). */
  tier: 'live' | 'recent' | null;
  selected: boolean;
  onSelect: () => void;
  testId: string;
}): JSX.Element {
  const trajectory = analyseTrajectory(session.turns);
  const verdict = verdictOf(trajectory, threshold);
  // The relative label reads only for a recent row; `now` is always a real number in that tier.
  const recentLabel = now !== null ? `active ${formatRelative(session.lastActivityTs, now)}` : '';

  return (
    <li>
      <button
        type="button"
        data-testid={testId}
        // §1a/§7 — the session id disambiguates on hover only; it is never visible text.
        title={session.key}
        aria-pressed={selected}
        onClick={onSelect}
        className={
          'flex w-full items-center gap-3 rounded-control border px-3 py-2 text-left transition-colors duration-hover ' +
          (selected ? 'border-accent bg-bg-surface-2' : 'border-border hover:bg-bg-surface-2')
        }
      >
        {/* The lead indicator. For a live row it is a PULSING green dot; for a recent row a HOLLOW
            green outline dot; otherwise the verdict-coloured dot. ⚠️ The verdict itself stays
            legible either way — it is always printed as a WORD in the sub-text below (§1a). */}
        {tier === 'live' ? (
          <span
            data-testid={`${testId}-live`}
            className="dot-pulse h-3 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: 'var(--ok)' }}
            aria-label="Active now"
          />
        ) : tier === 'recent' ? (
          <span
            data-testid={`${testId}-recent`}
            className="h-3 w-3 shrink-0 rounded-full border-2 border-ok"
            aria-label="Recently active"
          />
        ) : (
          <span
            data-testid={`${testId}-verdict`}
            data-verdict={verdict}
            aria-label={BAND_WORD[verdict]}
            className="h-3 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: BAND_VAR[verdict] }}
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-small text-text-primary">
            {formatTimestamp(session.startedAt)}
          </span>
          {/* The discriminator that stops two rows reading as one (A-11 review finding A). The
              verdict WORD lives here, so a live/recent row still shows its verdict plainly. A recent
              row also carries its plain "active Nm ago" label here. */}
          <span className="text-micro text-text-muted">
            {formatCompact(session.cacheReadTokens)} re-read · {BAND_WORD[verdict]}
            {tier === 'recent' ? (
              <>
                {' · '}
                <span data-testid={`${testId}-recent-label`}>{recentLabel}</span>
              </>
            ) : undefined}
          </span>
        </span>
        <RatioSparkline trajectory={trajectory} threshold={threshold} />
      </button>
    </li>
  );
}

/** A tiny per-turn efficiency sparkline, each bar coloured by its own decay against the threshold. */
function RatioSparkline({
  trajectory,
  threshold,
}: {
  trajectory: Trajectory;
  threshold: number;
}): JSX.Element {
  const width = 72;
  const height = 20;
  const points = trajectory.points;
  const maxEfficiency = points.reduce(
    (highest, point) => (point.efficiency !== null ? Math.max(highest, point.efficiency) : highest),
    0,
  );
  const slot = points.length === 0 ? width : width / points.length;

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="none"
      className="h-5 w-18 shrink-0"
      role="img"
      aria-label="Efficiency per turn, most recent on the right"
    >
      {points.map((point, index) => {
        // A context-0 turn has no efficiency — it is a gap, never drawn as a zero-height "0".
        if (point.efficiency === null) return null;
        const barHeight = maxEfficiency === 0 ? 0 : (point.efficiency / maxEfficiency) * height;
        // Grey when the session is unjudgeable (no baseline); otherwise the decay's own band.
        const fill =
          point.decay === null ? BAND_VAR.grey : BAND_VAR[bandOf(point.decay, threshold)];
        return (
          <rect
            key={index}
            x={index * slot}
            y={height - barHeight}
            width={Math.max(0, slot - 1)}
            height={barHeight}
            fill={fill}
            fillOpacity={0.85}
          />
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------------------
// The detail: three aligned curves over one turn-index x-axis.
// ---------------------------------------------------------------------------------------

function SessionDetail({
  session,
  threshold,
  now,
  testId,
}: {
  session: Session;
  threshold: number;
  now: number | null;
  testId: string;
}): JSX.Element {
  // A-12 — ephemeral view zoom (component state only, never persisted). It crops which turns the
  // curves DRAW; it changes nothing that is measured.
  const [windowChoice, setWindowChoice] = useState<WindowChoice>('all');

  // ⚠️ **`analyseTrajectory` runs over the WHOLE session — the baseline, decay and colours are
  // anchored to the session's real start (§1).** The window is applied AFTER, by slicing the
  // already-anchored turns/points; it never re-measures, so a turn that is red at full scale stays
  // red when zoomed onto (that property is what `lastN`'s contract and the golden test guarantee).
  const trajectory = analyseTrajectory(session.turns);
  const verdict = verdictOf(trajectory, threshold);
  const greyReason = greyReasonOf(trajectory);
  const judgeable = trajectory.baseline !== null && trajectory.baseline > 0;
  const live = now !== null && isLive(session.lastActivityTs, now);

  const windowSize = windowChoice === 'all' ? null : Number(windowChoice);
  const windowedTurns = lastN(session.turns, windowSize);
  const windowedPoints = lastN(trajectory.points, windowSize);
  const shownCount = windowedTurns.length;

  return (
    <div
      className="flex flex-col gap-3 rounded-control border border-border bg-bg-surface-2 p-4"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-small text-text-primary">
          {session.label} · started {formatTimestamp(session.startedAt)}
        </p>
        <span
          data-testid={`${testId}-verdict`}
          data-verdict={verdict}
          className="text-small font-medium"
          style={{ color: BAND_VAR[verdict] }}
        >
          {BAND_WORD[verdict]}
        </span>
      </div>

      {/* A-12 — the x-axis window picker. Plain words, no jargon; "Whole session" is the default. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-micro uppercase text-text-muted">Show</span>
        <SegmentedControl
          label="How many recent turns to show"
          options={WINDOW_OPTIONS}
          value={windowChoice}
          onChange={setWindowChoice}
          data-testid={`${testId}-window`}
        />
      </div>

      {/* ⚠️ When zoomed, say so AND make the anchoring explicit, so nobody reads the crop as a
          re-measurement (§1). */}
      {windowSize !== null ? (
        <p className="text-small text-text-muted" data-testid={`${testId}-window-caption`}>
          Showing the last {formatInteger(shownCount)} turns — efficiency is still measured against
          how the whole session started.
        </p>
      ) : undefined}

      {/* A-12 — the grey verdict has two genuinely different reasons; say the true one (§1). */}
      {greyReason === 'too-short' ? (
        <p className="text-small text-text-muted" data-testid={`${testId}-too-short`}>
          This session has too few turns to tell how its efficiency is trending yet.
        </p>
      ) : greyReason === 'no-baseline' ? (
        <p className="text-small text-text-muted" data-testid={`${testId}-no-baseline`}>
          Its early turns produced no output, so there is no starting point to compare against.
        </p>
      ) : undefined}

      <TurnCurve
        title="Context fed to the model each turn"
        values={windowedTurns.map((turn) => turn.context)}
        stroke="var(--info)"
        live={live}
        testId={`${testId}-context`}
      />
      <TurnCurve
        title="Tokens the model wrote each turn"
        values={windowedTurns.map((turn) => turn.output)}
        stroke="var(--text-muted)"
        live={live}
        testId={`${testId}-output`}
      />
      <EfficiencyCurve
        points={windowedPoints}
        judgeable={judgeable}
        threshold={threshold}
        live={live}
        testId={testId}
      />

      <p className="text-micro text-text-faint" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatInteger(shownCount)} turns shown, evenly spaced — the axis is turn order, not the
        clock.
      </p>

      {session.subagentTurns > 0 ? (
        <p className="text-micro text-text-muted" data-testid={`${testId}-subagent-note`}>
          {formatInteger(session.subagentTurns)} subagent turns run a separate context and are not
          shown here.
        </p>
      ) : undefined}

      {/* A-12 (review follow-up) — a context-0 turn is a gap on the efficiency line; say so in
          plain words rather than leave the gap unexplained, mirroring the subagent line above. */}
      {trajectory.skippedZeroContext > 0 ? (
        <p className="text-micro text-text-muted" data-testid={`${testId}-skipped-note`}>
          {formatInteger(trajectory.skippedZeroContext)}{' '}
          {trajectory.skippedZeroContext === 1 ? 'turn had' : 'turns had'} no context to measure,
          shown as gaps.
        </p>
      ) : undefined}

      {live ? (
        <p className="text-micro text-text-muted" data-testid={`${testId}-inprogress`}>
          The last turn is still in progress — its final numbers may change.
        </p>
      ) : undefined}
    </div>
  );
}

// The stretched plot coordinate box. `preserveAspectRatio="none"` maps it onto whatever pixel box
// the CSS gives the <svg>, so these numbers are arbitrary units; the actual height is `h-32`
// (≈128px), ~3× the old strip, and the width is responsive (this card is full-width). Strokes use
// `vectorEffect="non-scaling-stroke"` so the stretch cannot make a line thick one way and thin the
// other.
const VIEW_W = 240;
const VIEW_H = 100;

/** A-12 — a two-tick y-axis (max at top, min at bottom) as HTML, so text is never SVG-stretched.
 *  Fixed width so all three curves' plot areas line up on the same turn-index x-axis. */
function AxisLabels({
  maxLabel,
  minLabel,
  testId,
}: {
  maxLabel: string;
  minLabel: string;
  testId: string;
}): JSX.Element {
  return (
    <div
      className="flex w-12 shrink-0 flex-col justify-between text-right text-micro text-text-faint"
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      <span data-testid={`${testId}-axis-max`}>{maxLabel}</span>
      <span data-testid={`${testId}-axis-min`}>{minLabel}</span>
    </div>
  );
}

/** One token-count quantity per turn as an area/line over the shared turn-index x-axis, with a
 *  token-count y-axis (max … 0, labelled in plain compact numbers). */
function TurnCurve({
  title,
  values,
  stroke,
  live,
  testId,
}: {
  title: string;
  values: readonly number[];
  stroke: string;
  live: boolean;
  testId: string;
}): JSX.Element {
  const max = values.reduce((highest, value) => Math.max(highest, value), 0);
  const point = (value: number, index: number): { x: number; y: number } => {
    const x = values.length <= 1 ? 0 : (index / (values.length - 1)) * VIEW_W;
    const y = max === 0 ? VIEW_H : VIEW_H - (value / max) * VIEW_H;
    return { x, y };
  };
  const path = values.map((value, index) => point(value, index));
  const line = path.map((p) => `${String(p.x)},${String(p.y)}`).join(' ');
  const area = `0,${String(VIEW_H)} ${line} ${String(VIEW_W)},${String(VIEW_H)}`;
  const last = path.at(-1);

  return (
    <figure className="flex flex-col gap-1" data-testid={testId}>
      <figcaption className="text-micro text-text-muted">{title}</figcaption>
      <div className="flex gap-2">
        <AxisLabels maxLabel={formatCompact(max)} minLabel="0" testId={testId} />
        <svg
          viewBox={`0 0 ${String(VIEW_W)} ${String(VIEW_H)}`}
          preserveAspectRatio="none"
          className="h-32 flex-1"
          role="img"
          aria-label={title}
        >
          {path.length > 1 ? <polygon points={area} fill={stroke} fillOpacity={0.12} /> : undefined}
          {path.length > 1 ? (
            <polyline
              points={line}
              fill="none"
              stroke={stroke}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          ) : undefined}
          {last !== undefined ? (
            <circle
              cx={last.x}
              cy={last.y}
              r={3}
              // A live session's last turn may be mid-write: draw it hollow (in-progress).
              fill={live ? 'var(--bg-surface-2)' : stroke}
              stroke={stroke}
              strokeWidth={1}
              data-testid={live ? `${testId}-inprogress-point` : undefined}
            />
          ) : undefined}
        </svg>
      </div>
    </figure>
  );
}

/**
 * A-12 — the efficiency curve, re-expressed on a y-axis of **"% of its start"** (the per-turn
 * `decay = efficiency / baseline`, where the session's start = 100%). Raw efficiency is a tiny
 * fraction (0.5 … 0.009) that means nothing to a reader; the share-of-start scale is the honest,
 * readable one, and it is what lets the flag threshold be drawn as a horizontal line.
 *
 * ⚠️ Only a JUDGEABLE session (baseline > 0) gets this axis — a grey session shows the plain
 * "too short / no baseline" note instead, never a fabricated axis (§1). Everything here is derived
 * in the renderer from the raw pairs and the live threshold; nothing is stored (ADR-027).
 *
 * ⚠️ **`points` are already the WINDOWED points and `judgeable` is the WHOLE-session verdict.** The
 * `decay` on each point was measured against the session's true start upstream (A-12), so cropping
 * the x-axis here never moves the baseline: a point's colour (`bandOf(decay, threshold)`) is a
 * property of the point, identical whether it is drawn at full scale or zoomed onto. The y-axis max
 * may rescale to the window, but it always keeps 0%, the flag line and the 100%-of-start reference.
 */
function EfficiencyCurve({
  points,
  judgeable,
  threshold,
  live,
  testId,
}: {
  points: readonly TrajectoryPoint[];
  judgeable: boolean;
  threshold: number;
  live: boolean;
  testId: string;
}): JSX.Element {
  const efficiencyTestId = `${testId}-efficiency`;

  if (!judgeable) {
    // No baseline → no "% of its start" to plot. The grey reason is already stated above the curves.
    return (
      <figure className="flex flex-col gap-1" data-testid={efficiencyTestId}>
        <figcaption className="text-micro text-text-muted">
          Efficiency as a share of how the session started
        </figcaption>
        <p className="text-micro text-text-faint">
          There is no starting point yet, so there is nothing to chart here.
        </p>
      </figure>
    );
  }

  // ⚠️ FIXED 0–100% scale of "efficiency lost since it started" (A-12). `lost` rises from ~0% (as
  // efficient as its start, at the BOTTOM) to 100% (fully bloated, at the TOP). Fixed so early turns
  // that beat the median baseline sit flat at 0% instead of auto-scaling the axis past 200% and
  // squashing the flag line. `yOf` maps a lost% to the plot: 0% → bottom (VIEW_H), 100% → top (0).
  const yOfLost = (lostPercent: number): number => VIEW_H - (lostPercent / 100) * VIEW_H;
  // The flag line sits at the lost% that corresponds to the retained-efficiency threshold: a
  // threshold of 0.40 (flag once ≤40% remains) is 60% LOST. The rule and stored value are unchanged.
  const flagLostPercent = Math.round((1 - threshold) * 100);
  const flagY = yOfLost(flagLostPercent);

  // Coloured segments between consecutive eligible turns; a context-0 turn breaks the line (a gap,
  // never a fabricated zero). ⚠️ Colour is STILL `bandOf(point.decay, threshold)` — unchanged — just
  // plotted at the `lost` y: green near the bottom (0% lost), amber below the line, red above it.
  const segments: JSX.Element[] = [];
  let previous: { x: number; y: number; decay: number } | null = null;
  points.forEach((point, index) => {
    if (point.decay === null) {
      previous = null;
      return;
    }
    const x = points.length <= 1 ? 0 : (index / (points.length - 1)) * VIEW_W;
    const here = { x, y: yOfLost(efficiencyLostPercent(point.decay)), decay: point.decay };
    if (previous !== null) {
      // `data-band` exposes the anchored colour so a test can prove a windowed turn keeps the exact
      // band it had at full scale (the baseline-did-not-move discriminator, §1). `here.decay` was
      // measured against the WHOLE session's start upstream.
      segments.push(
        <line
          key={index}
          data-testid={`${efficiencyTestId}-segment`}
          data-band={bandOf(here.decay, threshold)}
          x1={previous.x}
          y1={previous.y}
          x2={here.x}
          y2={here.y}
          stroke={BAND_VAR[bandOf(here.decay, threshold)]}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />,
      );
    }
    previous = here;
  });
  // ⚠️ Cast, because TS cannot see the assignment inside the `forEach` callback and narrows
  // `previous` back to its initial `null`. Same workaround the original curve used.
  const last = previous as { x: number; y: number; decay: number } | null;

  return (
    <figure className="flex flex-col gap-1" data-testid={efficiencyTestId}>
      <figcaption className="text-micro text-text-muted">
        How much of its starting efficiency this session has lost
      </figcaption>
      <div className="flex gap-2">
        {/* Fixed axis: 100% lost at the top, 0% (still fresh) at the bottom — never auto-scaled. */}
        <AxisLabels maxLabel="100%" minLabel="0%" testId={efficiencyTestId} />
        <div className="relative flex-1">
          <svg
            viewBox={`0 0 ${String(VIEW_W)} ${String(VIEW_H)}`}
            preserveAspectRatio="none"
            className="h-32 w-full"
            role="img"
            aria-label="How much of its starting efficiency the session has lost, per turn"
          >
            {/* The "worth clearing" zone: everything ABOVE the flag line (more lost than the flag). */}
            <rect
              x={0}
              y={0}
              width={VIEW_W}
              height={flagY}
              fill="var(--danger)"
              fillOpacity={0.1}
              data-testid={`${efficiencyTestId}-zone`}
            />
            {/* The flag line itself — moves the instant the slider changes the threshold. */}
            <line
              data-testid={`${efficiencyTestId}-flag-line`}
              data-lost-percent={flagLostPercent}
              x1={0}
              y1={flagY}
              x2={VIEW_W}
              y2={flagY}
              stroke="var(--danger)"
              strokeWidth={1.5}
              strokeDasharray="4 2"
              vectorEffect="non-scaling-stroke"
            />
            {segments}
            {last !== null ? (
              <circle
                cx={last.x}
                cy={last.y}
                r={3}
                fill={live ? 'var(--bg-surface-2)' : BAND_VAR[bandOf(last.decay, threshold)]}
                stroke={BAND_VAR[bandOf(last.decay, threshold)]}
                strokeWidth={1}
              />
            ) : undefined}
          </svg>
          {/* The flag line's label, pinned to the line's height in HTML (so it is never stretched)
              and moving with the threshold. */}
          <span
            data-testid={`${efficiencyTestId}-flag-label`}
            className="absolute left-1 -translate-y-1/2 rounded bg-bg-surface px-1 text-micro text-danger"
            style={{ top: `${String(flagY)}%` }}
          >
            Flag line — {flagLostPercent}% lost
          </span>
        </div>
      </div>
      <figcaption className="text-micro text-text-faint">
        0% = still as efficient as when it started; higher = doing far less writing per token of
        context. Flagged once it has lost more than {flagLostPercent}% of its start. A turn as
        efficient as its start (or better) counts as 0% lost.
      </figcaption>
    </figure>
  );
}
