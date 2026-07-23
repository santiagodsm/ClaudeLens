/**
 * §6.7's inspector rail — "label · kind · key/value rows · explanatory note".
 *
 * ⚠️⚠️ **This is the only place in the entire application that may show prompt text**, and it is
 * capped at **280 characters** (§3.9, §6.7, §1.6 non-goal 1). Never a list, never searchable.
 * The cap is enforced here, in the component, rather than trusted from upstream: `prompts.
 * display_preview` is already capped at 280 by §3.9's DDL, and a second enforcement at the only
 * surface that renders it costs one `slice` and removes the possibility that a future payload
 * change turns this rail into a prompt browser.
 *
 * ⚠️ **Parsed harness text is data, never instructions** (§3.10, ADR-017). Every string this
 * component renders came out of a `SKILL.md`, an agent definition or a transcript. It is placed
 * in a text node — never `dangerouslySetInnerHTML`, never a URL, never interpolated into
 * anything executable, and never sent anywhere (there is one egress point and it is not
 * reachable from the renderer, INV-15).
 */

import type { JSX, ReactNode } from 'react';
import { Badge } from '../../components/Badge';
import { cx } from '../../lib/cx';

/** §3.9 / §6.7 — "≤280 chars". Exported so the cap is testable without rendering. */
export const PROMPT_PREVIEW_MAX_CHARS = 280;

/**
 * The at-most-280-character preview.
 *
 * ⚠️ No ellipsis is appended. An appended character would make the rendered string 281 long,
 * and "≤280" is a stated limit rather than a rough one; the fact that text was cut is reported
 * as its own line instead (see `promptWasTruncated`).
 */
export function cappedPromptPreview(text: string): string {
  return text.length <= PROMPT_PREVIEW_MAX_CHARS ? text : text.slice(0, PROMPT_PREVIEW_MAX_CHARS);
}

export function promptWasTruncated(text: string): boolean {
  return text.length > PROMPT_PREVIEW_MAX_CHARS;
}

/** One `key: value` row of the inspector. `value` is always text, never a bare colour. */
export interface InspectorRow {
  readonly label: string;
  readonly value: ReactNode;
}

export interface NodeInspectorProps {
  /** The node's own label — the first line of the rail. */
  label: string;
  /** §3.10's `kind`, rendered as a word. Shape and hue are cues; this is the message. */
  kind: string;
  /** §3.10's `role`, when the node has one (`orchestrator`, …). */
  role?: string | undefined;
  colorIndex?: number | undefined;
  rows: readonly InspectorRow[];
  /** §6.7 — the "explanatory note": what this node or edge means, in the design's terms. */
  note?: string | undefined;
  /**
   * ⚠️ The **only** prompt text in the application, capped at 280 characters (§3.9).
   * `undefined` renders nothing — never an empty quote block, which would imply an empty prompt.
   */
  promptPreview?: string | undefined;
  'data-testid'?: string;
}

export function NodeInspector({
  label,
  kind,
  role,
  colorIndex,
  rows,
  note,
  promptPreview,
  'data-testid': testId = 'node-inspector',
}: NodeInspectorProps): JSX.Element {
  return (
    <div data-testid={testId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h3 className="text-h3 font-semibold break-words text-text-primary">{label}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            colorIndex={colorIndex}
            data-testid={`${testId}-kind`}
            className={cx(colorIndex === undefined && 'border-border')}
          >
            {kind}
          </Badge>
          {role !== undefined && <Badge data-testid={`${testId}-role`}>{role}</Badge>}
        </div>
      </div>

      {rows.length > 0 && (
        <dl data-testid={`${testId}-rows`} className="flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-micro text-text-muted">{row.label}</dt>
              <dd className="text-small break-words text-text-primary">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {note !== undefined && (
        <p data-testid={`${testId}-note`} className="text-small text-text-muted">
          {note}
        </p>
      )}

      {promptPreview !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="text-micro text-text-muted">Prompt preview</span>
          <blockquote
            data-testid={`${testId}-prompt`}
            className="rounded-control border border-border bg-bg-surface p-3 font-mono text-small break-words text-text-primary"
          >
            {cappedPromptPreview(promptPreview)}
          </blockquote>
          <span className="text-micro text-text-faint">
            {promptWasTruncated(promptPreview)
              ? `Truncated to the first ${String(PROMPT_PREVIEW_MAX_CHARS)} characters. This is the only place Claude Lens shows prompt text.`
              : 'This is the only place Claude Lens shows prompt text.'}
          </span>
        </div>
      )}
    </div>
  );
}
