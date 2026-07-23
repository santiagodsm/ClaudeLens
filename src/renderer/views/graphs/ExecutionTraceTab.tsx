/**
 * §6.7 tab 2 — **Execution Trace**: `q:executionTrace` for one selected session, as a timeline
 * you drill into.
 *
 * ⚠️⚠️ **Why this is no longer a node-link diagram.** §6.7 asks this tab to show the spawn tree
 * "main-loop → subagent runs → tool calls, plus a timeline band per span", and it was built as a
 * `@xyflow/react` graph with the timeline underneath it. At real scale that picture is
 * unreadable — thousands of tool calls and dozens of subagent runs in one session, which is a
 * hairball at any layout quality — and the user said so directly: *"I love the information that
 * is there but it is not readable, it is just so much."* Nothing was removed. The same three
 * layers are now drawn along time, **one level at a time**:
 *
 *   · **the session** — the main loop, and the subagent runs it started;
 *   · **one run** — its tool calls, with consecutive repeats aggregated into `Read ×47`;
 *   · **one group** — the individual calls inside it.
 *
 * Opening a row **re-scopes** the view instead of expanding it in place, and the breadcrumb walks
 * back. An accordion reaches the same wall as the hairball, one row at a time; re-scoping cannot,
 * and it lets every level re-fit the time axis to what is on screen — which is what makes a
 * four-second run inside a nine-hour session legible at all. Reported as a deliberate departure
 * from §6.7's stated library composition for this tab (`@xyflow/react` + custom timeline): the
 * custom timeline is now the whole tab, and nothing in it lays out a graph.
 *
 * ⚠️ **Selecting and opening are two different actions** — one click selects and fills the
 * inspector rail, a double-click or the row's Open button drills in, and `Escape` steps back out.
 * Overloading one click to mean both would make the rail unreachable for anything with children.
 *
 * ⚠️⚠️ §6.7's Degraded row is the rule this tab exists to keep: "Execution Trace shows unlinked
 * runs as **detached** nodes in a clearly-labelled 'unlinked' lane rather than guessing a parent
 * (§3.7)." The payload makes the guess impossible to make by accident — the main process emits no
 * edge at all for an unlinked run — and here they get their own labelled lane, their own count and
 * the plain statement that their numbers still count.
 *
 * ⚠️ **Empty is "select a session", not "no data"** (§6.7). Before a session is chosen the query
 * is parked (`enabled: false`) rather than fired with a placeholder id.
 */

import { useMemo, useState, type JSX } from 'react';
import { Badge } from '../../components/Badge';
import { GraphCanvas } from '../../components/GraphCanvas';
import { useQuery } from '../../hooks/use-query';
import { cx } from '../../lib/cx';
import { formatClock, formatDurationShort, formatInteger, formatTimestamp } from '../../lib/format';
import { DEFAULT_PAGE_LIMIT } from '../../lib/limits';
import { useAppStore } from '../../store/app-store';
import { NodeInspector, type InspectorRow } from './NodeInspector';
import { GRAPH_TAB_BY_ID } from './tabs';
import { TimelineBand } from './TimelineBand';
import {
  ROW_ORDER_LABEL,
  SESSION_SCOPE_LABEL,
  buildTraceLevel,
  indexTrace,
  type TraceLevel,
  type TraceRow,
  type TraceRowOrder,
  type TraceScope,
} from './trace-timeline';
import { useTimeAxis } from './use-time-axis';
import { ZoomControls } from './ZoomControls';

const TAB = GRAPH_TAB_BY_ID.trace;

/**
 * §3.7 / §6.7 — the lane's own words, so the picture cannot be read as a complete tree.
 *
 * ⚠️ Plain language (CLAUDE.md §1a): no section number, no column name and no "spawn point" —
 * the sentence has to mean something to a reader who has never seen the design document.
 */
export const UNLINKED_LANE_LABEL = 'Runs we could not match to the moment they were started';

/** The same fact, said at length, in the inspector. */
const UNLINKED_NOTE =
  'Nothing in this session’s records says where this run was started from, so it is shown on its own rather than under a guessed parent. Everything it did is still counted — the totals elsewhere in the app are unaffected.';

/** ⚠️ The width rule, repeated where the numbers are. Once on the chart is not enough. */
const TOOL_GROUP_NOTE =
  'Each tool call is recorded as a single moment, with no end time. This bar runs from the first call in the group to the last, so its width tells you when those calls happened — not how long they took.';

const SINGLE_CALL_NOTE =
  'This call is recorded as a single moment, with no end time, so it has no duration to show.';

/**
 * The words for the numbers a `q:executionTrace` node carries.
 *
 * ⚠️ CLAUDE.md §1a — a payload key is an internal name and never reaches the screen. Anything not
 * listed is still shown (never silently dropped) but as spaced-out words rather than a key.
 */
const METRIC_LABEL: Record<string, string> = {
  messages: 'Messages',
  toolCalls: 'Tool calls',
  outputTokens: 'Tokens it produced',
};

/** Payload keys that are a flag or a timestamp, both of which are said better elsewhere. */
const METRIC_HIDDEN = new Set(['linked', 'ts']);

export function ExecutionTraceTab(): JSX.Element {
  const filter = useAppStore((state) => state.filter);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [path, setPath] = useState<readonly TraceScope[]>([]);
  const [order, setOrder] = useState<TraceRowOrder>('duration');
  const [revealAll, setRevealAll] = useState(false);

  // The session picker. `q:sessions` is the app's own list; this tab does not invent a second
  // way of naming a session.
  const sessions = useQuery('q:sessions', {
    ...filter,
    limit: DEFAULT_PAGE_LIMIT,
    sort: 'firstTs',
    dir: 'desc',
  });

  // ⚠️ Parked until a session is chosen. §6.7's empty copy for this tab is "select a session",
  // which is a *prompt*, not a failure — so no query is fired and no error is shown.
  const trace = useQuery(
    'q:executionTrace',
    { sessionId: sessionId ?? '' },
    { enabled: sessionId !== null },
  );

  const index = useMemo(
    () => indexTrace(trace.data ?? { nodes: [], edges: [], timeline: [], unlinkedRuns: 0 }),
    [trace.data],
  );

  // ⚠️ Only the session level's rows are subagent runs, and only a subagent run carries tokens.
  // Deeper levels are tool calls, which carry none — so they are always chosen by how long they
  // ran, and the control that offers the other rule is not shown there. A control that appears to
  // do something and quietly does nothing is its own small lie.
  const effectiveOrder: TraceRowOrder = path.length === 0 ? order : 'duration';

  const level = useMemo(
    () => buildTraceLevel(index, path, { order: effectiveOrder, revealAll }),
    [index, path, effectiveOrder, revealAll],
  );

  // ⚠️ The axis re-fits to the level: drilling into a four-second run inside a nine-hour session
  // makes that run the full width. `useTimeAxis` keys off the two timestamps, not the object.
  const axis = useTimeAxis(level);

  const nodesById = useMemo(
    () => new Map((trace.data?.nodes ?? []).map((node) => [node.id, node])),
    [trace.data],
  );

  const selectedRow =
    (level.header?.id === selectedId ? level.header : undefined) ??
    level.rows.find((row) => row.id === selectedId) ??
    null;

  const goTo = (next: readonly TraceScope[]): void => {
    setPath(next);
    setRevealAll(false);
    setSelectedId(null);
  };

  const open = (row: TraceRow): void => {
    if (!row.drillable) return;
    if (row.kind === 'main') {
      goTo([{ kind: 'mainLoop', id: row.id, label: 'Main loop’s own tool calls' }]);
      return;
    }
    if (row.kind === 'subagent') {
      goTo([{ kind: 'run', id: row.id, label: row.label }]);
      return;
    }
    if (row.kind === 'toolGroup') {
      goTo([...path, { kind: 'toolGroup', id: row.id, label: row.label }]);
    }
  };

  const back = (): void => {
    if (path.length === 0) return;
    goTo(path.slice(0, -1));
  };

  // "select a session" is the empty state before a choice; after one, an empty payload is a real
  // absence and says so in its own words rather than borrowing the prompt.
  const empty = sessionId === null || (trace.data !== null && trace.data.nodes.length === 0);
  const emptyReason = sessionId === null ? TAB.emptyReason : 'no events recorded for this session';

  return (
    <GraphCanvas
      title={TAB.title}
      data-testid="graphs-trace"
      nodeCount={level.total}
      renderedNodeCount={level.rows.length}
      loading={sessionId !== null && trace.loading && trace.data === null}
      error={trace.error}
      empty={empty}
      emptyReason={emptyReason}
      onRetry={trace.refetch}
      className="min-h-96"
      controls={
        <ZoomControls
          onZoomIn={axis.zoomIn}
          onZoomOut={axis.zoomOut}
          onFit={axis.fit}
          data-testid="zoom-controls"
        />
      }
      filters={
        <>
          <label className="flex items-center gap-2 text-small text-text-muted">
            Session
            <select
              data-testid="trace-session-picker"
              aria-label="Session to trace"
              value={sessionId ?? ''}
              onChange={(event) => {
                setSessionId(event.target.value === '' ? null : event.target.value);
                goTo([]);
              }}
              className="rounded-control border border-border bg-bg-surface px-3 py-1 text-small text-text-primary"
            >
              <option value="">— select a session —</option>
              {(sessions.data?.page.rows ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.displayName} · {formatTimestamp(row.firstTs)}
                </option>
              ))}
            </select>
          </label>

          {/*
            §11.7 leaves the ranking for this graph open, so the rule is a control rather than a
            silent choice: the reader is told which rows were picked and can change it. Shown only
            where both rules mean something — see `effectiveOrder`.
          */}
          {path.length === 0 && (
            <label className="flex items-center gap-2 text-small text-text-muted">
              Show the biggest by
              <select
                data-testid="trace-order"
                aria-label="Which rows to show first"
                value={order}
                onChange={(event) => {
                  setOrder(event.target.value === 'tokens' ? 'tokens' : 'duration');
                  setRevealAll(false);
                }}
                className="rounded-control border border-border bg-bg-surface px-3 py-1 text-small text-text-primary"
              >
                <option value="duration">{ROW_ORDER_LABEL.duration}</option>
                <option value="tokens">{ROW_ORDER_LABEL.tokens}</option>
              </select>
            </label>
          )}
        </>
      }
      legend={
        index.unlinkedRuns > 0 ? (
          <Badge tone="warn" data-testid="trace-unlinked-badge">
            {`${formatInteger(index.unlinkedRuns)} run${index.unlinkedRuns === 1 ? '' : 's'} could not be matched to the moment they started — totals are unaffected`}
          </Badge>
        ) : undefined
      }
      {...(selectedRow === null
        ? {}
        : {
            inspector: (
              <NodeInspector
                label={selectedRow.label}
                kind={kindWord(selectedRow)}
                colorIndex={selectedRow.colorIndex}
                rows={inspectorRows(selectedRow, nodesById.get(selectedRow.nodeId ?? ''))}
                note={noteFor(selectedRow)}
                /*
                 * ⚠️⚠️ §3.9 / §6.7 — the ONE prompt preview in the application, and this is the
                 * only `promptPreview` prop passed anywhere in the renderer (grep it).
                 *
                 * The text arrives already capped at 280 characters by the repository that read
                 * it; `NodeInspector` caps again on the way to the DOM. Two independent guards,
                 * because §1.6 non-goal 1 makes this a product boundary, not a display nicety.
                 *
                 * Read off `meta`, so a session with no prompt carries no key and renders no
                 * quote block — never an empty one, which would claim the prompt was empty.
                 */
                promptPreview={
                  selectedRow.kind === 'main'
                    ? nodesById.get(selectedRow.nodeId ?? '')?.meta?.['promptPreview']
                    : undefined
                }
              />
            ),
            onCloseInspector: () => {
              setSelectedId(null);
            },
          })}
    >
      <div
        className="flex h-full min-h-80 w-full flex-col gap-3 p-6"
        data-testid="trace-timeline"
        onKeyDown={(event) => {
          // Escape steps back one level, from anywhere inside the tab — a drill-down with no
          // way out by keyboard is a trapdoor (P-30).
          if (event.key !== 'Escape' || path.length === 0) return;
          event.preventDefault();
          back();
        }}
      >
        <Breadcrumb path={path} onGo={goTo} />

        <p className="text-small text-text-muted" data-testid="trace-level-caption">
          {levelCaption(level, effectiveOrder)}
        </p>

        <TimelineBand
          level={level}
          axis={axis}
          selectedId={selectedId}
          unlinkedLaneLabel={UNLINKED_LANE_LABEL}
          onSelect={(row) => {
            setSelectedId(row.id);
          }}
          onOpen={open}
          onRevealAll={() => {
            setRevealAll(true);
          }}
        />

        {index.unattachedToolCalls > 0 && (
          <p data-testid="trace-unattached" className="text-micro text-warn">
            {`${formatInteger(index.unattachedToolCalls)} tool call${index.unattachedToolCalls === 1 ? '' : 's'} could not be matched to the main loop or to a subagent run, so ${index.unattachedToolCalls === 1 ? 'it is' : 'they are'} not drawn here. They are still counted everywhere else.`}
          </p>
        )}
      </div>
    </GraphCanvas>
  );
}

/** The word for each kind of bar. Shape and hue are cues; this is the message (FRONTEND §8). */
const KIND_WORD: Record<TraceRow['kind'], string> = {
  main: 'Main loop',
  subagent: 'Subagent run',
  toolGroup: 'Repeated tool calls',
  toolCall: 'One tool call',
};

/**
 * The breadcrumb — what makes drilling safe rather than a trapdoor. Every step is a button back.
 */
function Breadcrumb({
  path,
  onGo,
}: {
  path: readonly TraceScope[];
  onGo: (next: readonly TraceScope[]) => void;
}): JSX.Element {
  const crumbs = [{ kind: 'session' as const, id: '', label: SESSION_SCOPE_LABEL }, ...path];
  return (
    <nav data-testid="trace-breadcrumb" aria-label="Where you are in this session">
      <ol className="flex flex-wrap items-center gap-1 text-small">
        {crumbs.map((crumb, position) => {
          const last = position === crumbs.length - 1;
          return (
            <li key={`${crumb.kind}:${crumb.id}`} className="flex items-center gap-1">
              {position > 0 && <span className="text-text-faint">›</span>}
              <button
                type="button"
                data-testid="trace-crumb"
                aria-current={last ? 'page' : undefined}
                disabled={last}
                onClick={() => {
                  onGo(path.slice(0, position));
                }}
                className={cx(
                  'rounded-control px-2 py-1 transition-colors duration-hover',
                  last
                    ? 'text-text-primary'
                    : 'text-text-muted underline hover:bg-bg-surface-2 hover:text-text-primary',
                )}
              >
                {crumb.label}
              </button>
            </li>
          );
        })}
        {path.length > 0 && (
          <li className="pl-2 text-micro text-text-faint">Press Escape to go back one step</li>
        )}
      </ol>
    </nav>
  );
}

/** What this level is showing, and — when some rows are held back — which ones and why. */
export function levelCaption(level: TraceLevel, order: TraceRowOrder): string {
  const { total, hidden, noun, nounOne } = level;
  if (total === 0) return `No ${noun} are recorded here.`;
  if (hidden === 0) {
    return total === 1
      ? `1 ${nounOne}.`
      : `${formatInteger(total)} ${noun}, in the order they happened.`;
  }
  return `Showing the ${formatInteger(level.rows.length)} of ${formatInteger(total)} ${noun} with the highest “${ROW_ORDER_LABEL[order].toLowerCase()}”, in the order they happened. ${formatInteger(hidden)} more ${hidden === 1 ? 'is' : 'are'} not drawn yet.`;
}

/** The inspector's key/value rows for one bar — the real numbers, in words. */
function inspectorRows(
  row: TraceRow,
  node: { metrics: Record<string, number> } | undefined,
): InspectorRow[] {
  const rows: InspectorRow[] = [];

  if (row.measured) {
    rows.push({ label: 'Started', value: formatClock(row.startTs) });
    rows.push({ label: 'Ended', value: formatClock(row.endTs) });
    rows.push({
      label: 'How long it ran',
      value: formatDurationShort((row.endTs - row.startTs) / 1000),
    });
  } else if (row.count > 1) {
    rows.push({ label: 'How many calls', value: formatInteger(row.count) });
    rows.push({ label: 'First call', value: formatClock(row.startTs) });
    rows.push({ label: 'Last call', value: formatClock(row.endTs) });
    rows.push({
      label: 'From the first call to the last',
      value: formatDurationShort((row.endTs - row.startTs) / 1000),
    });
  } else {
    rows.push({ label: 'Ran at', value: formatClock(row.startTs) });
  }

  if (row.toolCalls > 0 && row.kind !== 'toolGroup' && row.kind !== 'toolCall') {
    rows.push({ label: 'Tool calls inside it', value: formatInteger(row.toolCalls) });
  }

  for (const [key, value] of Object.entries(node?.metrics ?? {})) {
    if (METRIC_HIDDEN.has(key)) continue;
    // `toolCalls` is already said above, in the same words, from the rows we drew.
    if (key === 'toolCalls' && row.toolCalls > 0) continue;
    rows.push({ label: METRIC_LABEL[key] ?? humanise(key), value: formatInteger(value) });
  }

  return rows;
}

function noteFor(row: TraceRow): string | undefined {
  if (row.unlinked) return UNLINKED_NOTE;
  if (row.kind === 'toolCall' || row.count === 1) {
    return row.kind === 'toolGroup' || row.kind === 'toolCall' ? SINGLE_CALL_NOTE : undefined;
  }
  if (row.kind === 'toolGroup') return TOOL_GROUP_NOTE;
  return undefined;
}

/**
 * The word for a bar. ⚠️ A group of exactly one call is **one call**, not "repeated" — the label
 * has to describe what the reader is looking at, not the machinery that produced it.
 */
function kindWord(row: TraceRow): string {
  if (row.kind === 'toolGroup') return row.count > 1 ? KIND_WORD.toolGroup : KIND_WORD.toolCall;
  return KIND_WORD[row.kind];
}

/**
 * A payload key nobody has given words to yet, rendered as words rather than as a key.
 *
 * ⚠️ CLAUDE.md §1a — this is the fallback, not the plan: a new number in the payload should be
 * given a sentence in `METRIC_LABEL`. It exists so an unnamed key still reads as English instead
 * of leaking a field name, and so nothing is dropped in silence.
 */
export function humanise(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
