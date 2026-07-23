/**
 * §6.7 — "One shell, **four tabs**, exactly as the prototype: **Harness Map · Execution Trace ·
 * Tool Transition · Flow Sankey**. No fifth graph (OQ-101 closed)."
 *
 * The tab list is a value rather than four hand-written buttons so that the row, the panel
 * switch and the four empty strings cannot drift apart, and so a fifth entry is a visible edit
 * to a closed list rather than an accident.
 *
 * ⚠️ `emptyReason` is §6.7's copy **verbatim**. §6.12: "a view that renders zero where it does
 * not know is a defect, not a style choice" — and an empty graph that says "No data" tells the
 * reader nothing about which of the four possible absences they are looking at.
 */

export type GraphTabId = 'harness' | 'trace' | 'transition' | 'sankey';

export interface GraphTab {
  readonly id: GraphTabId;
  /** The pill's text. */
  readonly label: string;
  /** The canvas heading, which also names the region for assistive technology. */
  readonly title: string;
  /** What this tab is showing, in the reader's terms. */
  readonly subtitle: string;
  /** §6.7's empty copy, verbatim. */
  readonly emptyReason: string;
}

export const GRAPH_TABS: readonly GraphTab[] = [
  {
    id: 'harness',
    label: 'Harness Map',
    title: 'Harness Map',
    // ⛔ INV-13 — `q:harnessGraph` takes no `GlobalFilter`, so the subtitle says so rather than
    // letting the date picker above imply a scope it does not have (§6.9's rule, same reason).
    subtitle: 'Declared structure with its runtime overlay — all time, never filtered',
    emptyReason: 'no skills or agents found under this directory',
  },
  {
    id: 'trace',
    label: 'Execution Trace',
    title: 'Execution Trace',
    subtitle: 'Main loop → subagent runs → tool calls, for one session',
    emptyReason: 'select a session',
  },
  {
    id: 'transition',
    label: 'Tool Transition',
    title: 'Tool Transition',
    subtitle: 'Consecutive tool calls within a session, as a Markov graph',
    emptyReason: 'fewer than two consecutive tool calls in range',
  },
  {
    id: 'sankey',
    label: 'Flow Sankey',
    title: 'Flow Sankey',
    subtitle: 'Project → model → skill/tool, banded by output tokens',
    emptyReason: 'no costed or counted flows in range',
  },
];

/** The tab record for an id. Total over `GraphTabId`, so a new id cannot go unhandled. */
export const GRAPH_TAB_BY_ID: Record<GraphTabId, GraphTab> = {
  harness: tabOrThrow('harness'),
  trace: tabOrThrow('trace'),
  transition: tabOrThrow('transition'),
  sankey: tabOrThrow('sankey'),
};

function tabOrThrow(id: GraphTabId): GraphTab {
  const tab = GRAPH_TABS.find((candidate) => candidate.id === id);
  // Never substitute (CLAUDE.md §1): a missing tab is a build defect, not a state to render.
  if (tab === undefined) throw new Error(`§6.7 declares no graph tab '${id}'`);
  return tab;
}
