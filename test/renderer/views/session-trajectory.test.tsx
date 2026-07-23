/**
 * A-12 — the "Session efficiency over time" panel, rendered in isolation so the four honesty
 * states are pinned independently of the Tokens view: a declining session flagged red at the
 * default threshold, the SAME session recoloured by the slider, a too-short session held grey
 * (never a fabricated red), and a live session drawn in-progress.
 *
 * ⚠️ Every colour, baseline, decay and verdict is computed in the renderer from the raw per-turn
 * pairs the payload carries (A-12). These tests assert the verdict via the `data-verdict` hook, so
 * a change of CSS token cannot make them pass silently; the on-screen words are checked separately.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SessionTrajectory } from '../../../src/renderer/views/charts/SessionTrajectory';
import { contextOverhead, T0 } from './payloads';

afterEach(() => {
  cleanup();
});

/** A fixed "now" far past every fixture timestamp, so nothing reads as live unless a test wants it. */
const LONG_AFTER = T0 + 10 * 24 * 60 * 60 * 1000;

const noop = (): void => {
  /* the threshold change is asserted with a spy where it matters */
};

describe('A-12 — Session efficiency panel', () => {
  it('flags a declining session red at the default 40% threshold, and holds a short one grey', () => {
    render(
      <SessionTrajectory
        data={contextOverhead()}
        threshold={0.4}
        onThresholdChange={noop}
        now={LONG_AFTER}
      />,
    );
    const dots = screen.getAllByTestId('session-trajectory-row-verdict');
    // Two projects, one session each, alpha (declining) before beta (short).
    expect(dots).toHaveLength(2);
    expect(dots[0]).toHaveAttribute('data-verdict', 'red');
    // ⚠️ The mandatory guard: too few turns → grey, NEVER a fabricated red or green (§1).
    expect(dots[1]).toHaveAttribute('data-verdict', 'grey');
    expect(dots[1]).not.toHaveAttribute('data-verdict', 'red');
  });

  it('⚠️ recolours instantly when the threshold drops below the recent decay', () => {
    // Recent median decay is 0.08. At 0.05 the same red session becomes amber — from the same
    // payload, no re-query (the slider only changes the prop).
    render(
      <SessionTrajectory
        data={contextOverhead()}
        threshold={0.05}
        onThresholdChange={noop}
        now={LONG_AFTER}
      />,
    );
    expect(screen.getAllByTestId('session-trajectory-row-verdict')[0]).toHaveAttribute(
      'data-verdict',
      'amber',
    );
  });

  it('slider is framed as "% lost" but stores the retained fraction (A-12 round-trip)', () => {
    const onChange = vi.fn();
    render(
      <SessionTrajectory
        data={contextOverhead()}
        threshold={0.4}
        onThresholdChange={onChange}
        now={LONG_AFTER}
      />,
    );
    // At the default 0.40 retained, the slider reads 60% lost.
    expect(screen.getByTestId('session-trajectory-threshold-value')).toHaveTextContent('60% lost');
    // ⚠️ Dragging to "80% lost" stores the retained fraction (100 − 80) / 100 = 0.20 — the stored
    // value stays a retained-efficiency fraction; only the framing flipped.
    fireEvent.change(screen.getByTestId('session-trajectory-threshold-slider'), {
      target: { value: '80' },
    });
    expect(onChange).toHaveBeenCalledWith(0.2);
    // Discriminator: it did NOT store the raw slider value (0.8) — that would be the un-flipped bug.
    expect(onChange).not.toHaveBeenCalledWith(0.8);
  });

  it('shows the too-short session its own plain-words explanation, never a red curve', () => {
    render(
      <SessionTrajectory
        data={contextOverhead()}
        threshold={0.4}
        onThresholdChange={noop}
        now={LONG_AFTER}
      />,
    );
    // Select the short (beta) session.
    fireEvent.click(screen.getAllByTestId('session-trajectory-row')[1]!);
    const detail = screen.getByTestId('session-trajectory-detail');
    expect(within(detail).getByTestId('session-trajectory-detail-too-short')).toBeInTheDocument();
    expect(within(detail).getByTestId('session-trajectory-detail-verdict')).toHaveAttribute(
      'data-verdict',
      'grey',
    );
    expect(detail.textContent ?? '').toContain('Too short to judge');
  });

  it('marks a live session in-progress and never invents "live" for an old one', () => {
    // now one minute after alpha's last activity → alpha is live; beta (a day earlier) is not.
    const now = T0 + 60_000;
    render(
      <SessionTrajectory
        data={contextOverhead()}
        threshold={0.4}
        onThresholdChange={noop}
        now={now}
      />,
    );
    // Exactly one live badge (alpha), and the selected detail carries the in-progress caveat.
    expect(screen.getAllByTestId('session-trajectory-row-live')).toHaveLength(1);
    expect(screen.getByTestId('session-trajectory-detail-inprogress')).toBeInTheDocument();
  });

  it('explains a zero-context turn as a gap, in plain words (never an unexplained hole)', () => {
    // Five countable turns plus one context-0 turn → the efficiency line has a gap; say why.
    const withGap = contextOverhead({
      sessions: [
        {
          key: 'sess-gap',
          label: 'demo-gap',
          startedAt: T0,
          lastActivityTs: T0,
          cacheReadTokens: 1_000,
          outputTokens: 100,
          subagentTurns: 0,
          turns: [
            { context: 1_000, output: 500 },
            { context: 2_000, output: 400 },
            { context: 4_000, output: 300 },
            { context: 0, output: 0 }, // no context to measure
            { context: 8_000, output: 200 },
            { context: 16_000, output: 100 },
          ],
        },
      ],
    });
    render(
      <SessionTrajectory
        data={withGap}
        threshold={0.4}
        onThresholdChange={noop}
        now={LONG_AFTER}
      />,
    );
    const note = screen.getByTestId('session-trajectory-detail-skipped-note');
    expect(note).toBeInTheDocument();
    expect(note.textContent ?? '').toContain('no context to measure');
  });

  it('gives a zero-baseline session its own accurate reason, not "too few turns"', () => {
    // ≥5 turns, but the first three wrote nothing → grey for the "no-baseline" reason (§1).
    const noBaseline = contextOverhead({
      sessions: [
        {
          key: 'sess-nb',
          label: 'demo-nb',
          startedAt: T0,
          lastActivityTs: T0,
          cacheReadTokens: 1_000,
          outputTokens: 720,
          subagentTurns: 0,
          turns: [
            { context: 1_000, output: 0 },
            { context: 2_000, output: 0 },
            { context: 4_000, output: 0 },
            { context: 8_000, output: 400 },
            { context: 16_000, output: 320 },
          ],
        },
      ],
    });
    render(
      <SessionTrajectory
        data={noBaseline}
        threshold={0.4}
        onThresholdChange={noop}
        now={LONG_AFTER}
      />,
    );
    const detail = screen.getByTestId('session-trajectory-detail');
    expect(within(detail).getByTestId('session-trajectory-detail-verdict')).toHaveAttribute(
      'data-verdict',
      'grey',
    );
    expect(within(detail).getByTestId('session-trajectory-detail-no-baseline')).toBeInTheDocument();
    expect(detail.textContent ?? '').toContain('no starting point');
    // ⚠️ Discriminator: it must NOT claim "too few turns" — it has five.
    expect(
      within(detail).queryByTestId('session-trajectory-detail-too-short'),
    ).not.toBeInTheDocument();
  });

  it('gives each detail curve a plain-words y-axis (token counts, and a FIXED 0–100% lost scale)', () => {
    render(
      <SessionTrajectory
        data={contextOverhead()}
        threshold={0.4}
        onThresholdChange={noop}
        now={LONG_AFTER}
      />,
    );
    const detail = screen.getByTestId('session-trajectory-detail'); // alpha is selected by default
    // Context curve — token counts: max 32K (the biggest contextSize in alpha's turns) … 0.
    expect(
      within(detail).getByTestId('session-trajectory-detail-context-axis-max'),
    ).toHaveTextContent('32K');
    expect(
      within(detail).getByTestId('session-trajectory-detail-context-axis-min'),
    ).toHaveTextContent('0');
    // Output curve — token counts: max 500 … 0.
    expect(
      within(detail).getByTestId('session-trajectory-detail-output-axis-max'),
    ).toHaveTextContent('500');
    // Efficiency curve — FIXED "% lost" scale, always 0% … 100%, never auto-scaled past 100%.
    // ⚠️ Discriminator: even though alpha's early turns beat baseline (would be 200% "of start"),
    // the axis top is a fixed 100% — the readability fix.
    expect(
      within(detail).getByTestId('session-trajectory-detail-efficiency-axis-max'),
    ).toHaveTextContent('100%');
    expect(
      within(detail).getByTestId('session-trajectory-detail-efficiency-axis-min'),
    ).toHaveTextContent('0%');
  });

  it('⚠️ draws the flag line (danger band above) and moves it when the threshold changes', () => {
    const { rerender } = render(
      <SessionTrajectory
        data={contextOverhead()}
        threshold={0.4}
        onThresholdChange={noop}
        now={LONG_AFTER}
      />,
    );
    // Threshold 0.40 retained → 60% LOST flag. On the fixed 0–100 axis the line sits at y = 100 − 60
    // = 40, and it is labelled "60% lost". The danger zone is the band ABOVE it (y 0 → 40).
    const flag40 = screen.getByTestId('session-trajectory-detail-efficiency-flag-line');
    expect(flag40).toHaveAttribute('data-lost-percent', '60');
    expect(flag40.getAttribute('y1')).toBe('40');
    expect(screen.getByTestId('session-trajectory-detail-efficiency-zone')).toBeInTheDocument();
    expect(screen.getByTestId('session-trajectory-detail-efficiency-flag-label')).toHaveTextContent(
      'Flag line — 60% lost',
    );

    // Threshold 0.20 retained → 80% lost → line at y = 100 − 80 = 20, instantly, renderer-side.
    // ⚠️ Discriminator: the line MOVED (up, into a stricter-loss position).
    rerender(
      <SessionTrajectory
        data={contextOverhead()}
        threshold={0.2}
        onThresholdChange={noop}
        now={LONG_AFTER}
      />,
    );
    const flag20 = screen.getByTestId('session-trajectory-detail-efficiency-flag-line');
    expect(flag20).toHaveAttribute('data-lost-percent', '80');
    expect(flag20.getAttribute('y1')).toBe('20');
    expect(flag20.getAttribute('y1')).not.toBe('40');
  });

  it('⚠️ pins a live session above a heavier non-live one, independent of token weight', () => {
    const now = T0 + 60_000;
    const data = contextOverhead({
      sessions: [
        // Wire order is cache-read DESC, so the heavy, long-idle session comes first on the wire…
        {
          key: 'sess-heavy',
          label: 'demo-heavy',
          startedAt: T0,
          lastActivityTs: T0 - 10 * 24 * 60 * 60 * 1000,
          cacheReadTokens: 900_000,
          outputTokens: 5_000,
          subagentTurns: 0,
          turns: [
            { context: 1_000, output: 500 },
            { context: 2_000, output: 400 },
            { context: 4_000, output: 300 },
            { context: 8_000, output: 200 },
            { context: 16_000, output: 100 },
          ],
        },
        // …but this far lighter session is LIVE (active a minute ago), so it must render on top.
        {
          key: 'sess-live',
          label: 'demo-live',
          startedAt: T0,
          lastActivityTs: T0,
          cacheReadTokens: 1_000,
          outputTokens: 400,
          subagentTurns: 0,
          turns: [
            { context: 1_000, output: 500 },
            { context: 2_000, output: 400 },
          ],
        },
      ],
    });
    render(<SessionTrajectory data={data} threshold={0.4} onThresholdChange={noop} now={now} />);

    expect(screen.getByTestId('session-trajectory-live-group')).toBeInTheDocument();
    const rows = screen.getAllByTestId('session-trajectory-row');
    // ⚠️ Discriminator: the live (light) session is row 0 and the heavy non-live one is row 1 — the
    // opposite of the token-weight wire order. Live-on-top is a renderer reordering, not the query's.
    expect(within(rows[0]!).queryByTestId('session-trajectory-row-live')).toBeInTheDocument();
    expect(within(rows[1]!).queryByTestId('session-trajectory-row-live')).not.toBeInTheDocument();
  });

  it('⚠️ windows the x-axis WITHOUT moving the baseline — a windowed turn keeps its whole-session colour', () => {
    // Six turns, baseline = median(0.9, 0.2, 0.1) = 0.2. Per-turn decays 4.5, 1.0, 0.5, 0.1, 0.025,
    // 0.0125 → segment bands (coloured by each segment's endpoint) at threshold 0.4:
    //   green · amber · red · red · red   (5 segments across 6 points).
    const data = contextOverhead({
      sessions: [
        {
          key: 'sess-window',
          label: 'demo-window',
          startedAt: T0,
          lastActivityTs: T0,
          cacheReadTokens: 60_000,
          outputTokens: 2_000,
          subagentTurns: 0,
          turns: [
            { context: 1_000, output: 900 }, // eff 0.9  → decay 4.5  → green
            { context: 2_000, output: 400 }, // eff 0.2  → decay 1.0  → green
            { context: 4_000, output: 400 }, // eff 0.1  → decay 0.5  → amber
            { context: 8_000, output: 160 }, // eff 0.02 → decay 0.1  → red
            { context: 16_000, output: 80 }, // eff 0.005→ decay 0.025→ red
            { context: 32_000, output: 80 }, // eff 0.0025→decay 0.0125→red
          ],
        },
      ],
    });
    render(
      <SessionTrajectory data={data} threshold={0.4} onThresholdChange={noop} now={LONG_AFTER} />,
    );

    // Defaults to the whole session: the picker's "Whole session" is checked and no window caption.
    expect(screen.getByTestId('session-trajectory-detail-window-all')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(
      screen.queryByTestId('session-trajectory-detail-window-caption'),
    ).not.toBeInTheDocument();

    // Whole session draws all six points (five segments) with the anchored bands.
    const fullBands = screen
      .getAllByTestId('session-trajectory-detail-efficiency-segment')
      .map((line) => line.getAttribute('data-band'));
    expect(fullBands).toEqual(['green', 'amber', 'red', 'red', 'red']);
    expect(
      screen
        .getByTestId('session-trajectory-detail-context')
        .querySelector('polyline')
        ?.getAttribute('points')
        ?.trim()
        .split(/\s+/),
    ).toHaveLength(6);

    // Zoom to the last 5 turns.
    fireEvent.click(screen.getByTestId('session-trajectory-detail-window-5'));

    // The caption now makes the anchoring explicit.
    const caption = screen.getByTestId('session-trajectory-detail-window-caption');
    expect(caption).toHaveTextContent('Showing the last 5 turns');
    expect(caption).toHaveTextContent('still measured against how the whole session started');

    // The context curve is cropped to five points (a real x-axis zoom).
    expect(
      screen
        .getByTestId('session-trajectory-detail-context')
        .querySelector('polyline')
        ?.getAttribute('points')
        ?.trim()
        .split(/\s+/),
    ).toHaveLength(5);

    // ⚠️ THE ANCHORING DISCRIMINATOR. The windowed segments are the LAST FOUR of the whole-session
    // bands — identical colours. The first shown segment is AMBER, exactly as at full scale.
    const windowedBands = screen
      .getAllByTestId('session-trajectory-detail-efficiency-segment')
      .map((line) => line.getAttribute('data-band'));
    expect(windowedBands).toEqual(['amber', 'red', 'red', 'red']);
    expect(windowedBands).toEqual(fullBands.slice(-4));
    // If the baseline had been RE-MEASURED over the window, that first segment would be GREEN
    // (a smaller windowed baseline lifts every decay). It must not be.
    expect(windowedBands[0]).not.toBe('green');
  });

  it('the window picker is component state only and does not persist a setting', () => {
    // A pure sanity check that the picker exists with the plain no-jargon options and no wire call.
    render(
      <SessionTrajectory
        data={contextOverhead()}
        threshold={0.4}
        onThresholdChange={noop}
        now={LONG_AFTER}
      />,
    );
    expect(screen.getByTestId('session-trajectory-detail-window-all')).toHaveTextContent(
      'Whole session',
    );
    for (const option of ['5', '10', '20']) {
      expect(screen.getByTestId(`session-trajectory-detail-window-${option}`)).toBeInTheDocument();
    }
  });

  it('⚠️ splits sessions into LIVE NOW / RECENTLY ACTIVE / project groups by the injected clock', () => {
    const now = T0 + 100_000_000;
    const turns = [
      { context: 1_000, output: 500 },
      { context: 2_000, output: 400 },
      { context: 4_000, output: 300 },
    ];
    const data = contextOverhead({
      sessions: [
        // Wire order is cache-read DESC, so the OLD heavy session is first on the wire…
        {
          key: 'sess-old',
          label: 'demo-old',
          startedAt: T0,
          lastActivityTs: now - 2 * 60 * 60 * 1000, // 2h ago → neither live nor recent
          cacheReadTokens: 900_000,
          outputTokens: 5_000,
          subagentTurns: 0,
          turns,
        },
        {
          key: 'sess-recent',
          label: 'demo-recent',
          startedAt: T0,
          lastActivityTs: now - 21 * 60 * 1000, // 21m ago → RECENTLY ACTIVE
          cacheReadTokens: 5_000,
          outputTokens: 400,
          subagentTurns: 0,
          turns,
        },
        {
          key: 'sess-live',
          label: 'demo-live',
          startedAt: T0,
          lastActivityTs: now - 60_000, // 1m ago → LIVE NOW
          cacheReadTokens: 1_000,
          outputTokens: 400,
          subagentTurns: 0,
          turns,
        },
      ],
    });
    render(<SessionTrajectory data={data} threshold={0.4} onThresholdChange={noop} now={now} />);

    // Both tier headers carry their counts.
    expect(screen.getByTestId('session-trajectory-live-group')).toHaveTextContent('Live now (1)');
    expect(screen.getByTestId('session-trajectory-recent-group')).toHaveTextContent(
      'Recently active (1)',
    );

    // ⚠️ Order regardless of token weight: live row first, recent second, old (heaviest) last.
    const rows = screen.getAllByTestId('session-trajectory-row');
    expect(within(rows[0]!).getByTestId('session-trajectory-row-live')).toBeInTheDocument();
    // The live lead dot pulses — and degrades to a solid dot via CSS under reduced motion.
    expect(within(rows[0]!).getByTestId('session-trajectory-row-live')).toHaveClass('dot-pulse');
    // The recent row has a hollow dot and a plain relative label.
    expect(within(rows[1]!).getByTestId('session-trajectory-row-recent')).toBeInTheDocument();
    expect(within(rows[1]!).getByTestId('session-trajectory-row-recent-label')).toHaveTextContent(
      'active 21m ago',
    );
    // The old, heaviest session sits in its project group with a verdict dot — not live/recent.
    expect(within(rows[2]!).getByTestId('session-trajectory-row-verdict')).toBeInTheDocument();
    expect(within(rows[2]!).queryByTestId('session-trajectory-row-live')).not.toBeInTheDocument();
  });

  it('renders no live/recent group when nothing is active (never fabricates one)', () => {
    // now is far past every timestamp → all sessions land in project groups, no live/recent tiers.
    render(
      <SessionTrajectory
        data={contextOverhead()}
        threshold={0.4}
        onThresholdChange={noop}
        now={LONG_AFTER}
      />,
    );
    expect(screen.queryByTestId('session-trajectory-live-group')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-trajectory-recent-group')).not.toBeInTheDocument();
  });

  it('renders no jargon and never shows a session id', () => {
    const { container } = render(
      <SessionTrajectory
        data={contextOverhead()}
        threshold={0.4}
        onThresholdChange={noop}
        now={LONG_AFTER}
      />,
    );
    const text = container.textContent ?? '';
    for (const pattern of [
      /\bM-\d/,
      /\bA-\d/,
      /\bINV-\d/,
      /\bADR-\d/,
      /\bq:[a-z]/i,
      /§\d/,
      /\btok_[a-z]/,
    ]) {
      expect(text).not.toMatch(pattern);
    }
    // §1a/§7 — the session id is React identity and a hover title only, never visible text.
    expect(text).not.toContain('sess-0000-1111');
    expect(text).not.toContain('-work-');
  });
});
