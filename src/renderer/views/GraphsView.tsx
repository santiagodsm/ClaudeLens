/**
 * Graphs & Harness Flow — `view-graphs` (DESIGN §6.7).
 *
 * "One shell, **four tabs**, exactly as the prototype: **Harness Map · Execution Trace · Tool
 * Transition · Flow Sankey**. No fifth graph (OQ-101 closed)." The shell is the tab pill row;
 * each tab owns its own query, its own four states and its own canvas, and E7's `GraphCanvas`
 * supplies the chrome every one of them shares — zoom controls, legend, inspector rail, and the
 * P-23 node cap with its explicit label.
 *
 * ⚠️ **Only the active tab is mounted.** Four graph canvases querying at once would fire four
 * `q:*` channels on every filter change for three pictures nobody is looking at, against §8.3's
 * 200 ms budget and P-21's 50 ms main-thread rule. The unmounted tabs are not hidden with CSS.
 *
 * ⚠️ **The tab row does not remount the canvas on a data update** (§6.12, §1.3 moment 2):
 * entrance animation runs on first mount only, and nothing here is keyed on a payload. Switching
 * tabs *is* a new mount, and that is the one case where an entrance is correct — the reader
 * asked for a new picture.
 */

import { useState, type JSX } from 'react';
import { ViewShell } from '../shell/ViewShell';
import { ExecutionTraceTab } from './graphs/ExecutionTraceTab';
import { FlowSankeyTab } from './graphs/FlowSankeyTab';
import { HarnessMapTab } from './graphs/HarnessMapTab';
import { ToolTransitionTab } from './graphs/ToolTransitionTab';
import { GRAPH_TABS, type GraphTabId } from './graphs/tabs';
import { cx } from '../lib/cx';

/** Total over `GraphTabId`, so a fifth tab is a compile error rather than a blank canvas. */
const TAB_PANELS: Record<GraphTabId, () => JSX.Element> = {
  harness: HarnessMapTab,
  trace: ExecutionTraceTab,
  transition: ToolTransitionTab,
  sankey: FlowSankeyTab,
};

export function GraphsView(): JSX.Element {
  const [active, setActive] = useState<GraphTabId>('harness');
  const Panel = TAB_PANELS[active];

  return (
    <ViewShell id="graphs">
      <div className="flex flex-col gap-4">
        {/*
          A tab list, not a row of buttons: `role="tablist"` plus roving `tabIndex` is what gives
          P-30's "full keyboard navigation" for free, and what tells assistive technology that the
          four are one exclusive choice.
        */}
        <div
          role="tablist"
          aria-label="Graph"
          data-testid="graphs-tabs"
          className="flex flex-wrap items-center gap-2"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            event.preventDefault();
            const index = GRAPH_TABS.findIndex((tab) => tab.id === active);
            const delta = event.key === 'ArrowRight' ? 1 : -1;
            const next = GRAPH_TABS[(index + delta + GRAPH_TABS.length) % GRAPH_TABS.length];
            if (next !== undefined) setActive(next.id);
          }}
        >
          {GRAPH_TABS.map((tab) => {
            const selected = tab.id === active;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`graphs-panel-${tab.id}`}
                id={`graphs-tab-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                data-testid={`graphs-tab-${tab.id}`}
                onClick={() => {
                  setActive(tab.id);
                }}
                className={cx(
                  'rounded-pill border px-4 py-1 text-small transition-colors duration-hover',
                  selected
                    ? 'border-accent bg-bg-surface-2 text-text-primary'
                    : 'border-border text-text-muted hover:bg-bg-surface-2',
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {GRAPH_TABS.map((tab) =>
          tab.id === active ? (
            <p key={tab.id} className="text-small text-text-muted">
              {tab.subtitle}
            </p>
          ) : null,
        )}

        <div
          role="tabpanel"
          id={`graphs-panel-${active}`}
          aria-labelledby={`graphs-tab-${active}`}
          data-testid={`graphs-panel-${active}`}
        >
          <Panel />
        </div>
      </div>
    </ViewShell>
  );
}
