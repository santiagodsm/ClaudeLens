/**
 * A-11 — the Context-overhead panel that replaced the cache-efficiency gauge (user directive
 * 2026-07-22). Rendered as a component in isolation, so the display-ratio arithmetic and the
 * three states (normal, zero-output, empty leaderboard) are pinned independently of the view.
 *
 * ⚠️ The display ratio `cacheReadTokens / outputTokens` is computed HERE, in the renderer, from
 * the two raw totals — never on the wire (A-11). These tests assert that division and, above all,
 * that a zero denominator yields the "no output" sentence rather than a `NaN`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ContextOverhead } from '../../../src/renderer/views/charts/ContextOverhead';
import { contextOverhead } from './payloads';

afterEach(() => {
  cleanup();
});

describe('A-11 — Context overhead panel', () => {
  it('leads with the re-read-per-output ratio and the two grounding totals', () => {
    // 900,000 cache reads / 30,000 output = 30 tokens re-read per output token.
    render(<ContextOverhead data={contextOverhead()} />);
    expect(screen.getByTestId('context-overhead-headline')).toHaveTextContent(
      'You re-read about 30 tokens of context for every 1 token of output.',
    );
    expect(screen.getByText('900,000')).toBeInTheDocument();
    expect(screen.getByText('30,000')).toBeInTheDocument();
  });

  it('rounds a non-integer ratio for display without rounding in the payload', () => {
    // 900,000 / 240,000 = 3.75 → one decimal below ten: "3.8".
    render(
      <ContextOverhead
        data={contextOverhead({ cacheReadTokens: 900_000, outputTokens: 240_000 })}
      />,
    );
    expect(screen.getByTestId('context-overhead-headline')).toHaveTextContent('about 3.8 tokens');
  });

  it('lists the heaviest sessions by PROJECT NAME, cache-read first — never an id or a path', () => {
    render(<ContextOverhead data={contextOverhead()} />);
    const rows = screen.getAllByTestId('context-overhead-row');
    expect(rows).toHaveLength(2);
    // Heaviest cache-read first: demo-alpha (600K) before demo-beta (300K).
    expect(rows[0]).toHaveTextContent('demo-alpha');
    expect(rows[0]).toHaveTextContent('600K');
    expect(rows[1]).toHaveTextContent('demo-beta');
    // §1a — the stable session id (`key`) is React identity only and never appears on screen.
    const panel = screen.getByTestId('context-overhead');
    expect(panel.textContent ?? '').not.toContain('sess-0000-1111');
    expect(panel.textContent ?? '').not.toContain('-work-');
  });

  it('⚠️ shows "no output tokens", not a fabricated ratio, when output is zero', () => {
    render(
      <ContextOverhead
        data={contextOverhead({ cacheReadTokens: 5_000, outputTokens: 0, sessions: [] })}
      />,
    );
    const headline = screen.getByTestId('context-overhead-headline');
    expect(headline).toHaveTextContent('No output tokens in this range yet.');
    const panel = screen.getByTestId('context-overhead');
    expect(panel.textContent ?? '').not.toContain('NaN');
    expect(panel.textContent ?? '').not.toContain('Infinity');
  });

  it('renders no leaderboard when there are no sessions', () => {
    render(<ContextOverhead data={contextOverhead({ sessions: [] })} />);
    expect(screen.queryByTestId('context-overhead-leaderboard')).not.toBeInTheDocument();
    // The two totals still render — an empty leaderboard is not an empty panel.
    expect(screen.getByTestId('context-overhead-headline')).toBeInTheDocument();
  });

  it('renders no jargon: no metric id, channel name or section sign', () => {
    const { container } = render(<ContextOverhead data={contextOverhead()} />);
    const text = container.textContent ?? '';
    for (const pattern of [/\bM-\d/, /\bA-\d/, /\bINV-\d/, /\bq:[a-z]/i, /§\d/, /\btok_[a-z]/]) {
      expect(text).not.toMatch(pattern);
    }
  });
});
