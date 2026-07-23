/**
 * §6.7's Execution Trace, drawn: one level of the drill-down as a timeline.
 *
 * ⚠️⚠️ **Time runs left to right and width is time.** A bar's position is when the thing ran and
 * its width is how long it occupied. That is the whole reason this is a timeline rather than a
 * tree: the expensive thing is the widest bar, and the eye finds it without reading anything.
 *
 * ⚠️⚠️ **Except for tool calls, which are recorded as single moments.** `tool_calls` stores one
 * timestamp and no end (§3.6), so an aggregated bar runs from the group's **first call to its
 * last** — two recorded instants — and a group of one call has no width at all and is drawn as a
 * marker. The rule is printed under the chart and repeated in the inspector, because a width read
 * as a duration it is not is a silently wrong number wearing a picture (CLAUDE.md §1).
 *
 * ⚠️ **Nothing is drawn twice.** Consecutive calls of the same tool arrive here already collapsed
 * into `Read ×47` by `aggregateToolCalls`; forty-seven boxes carry no more information than one
 * labelled bar and cost forty-seven times the DOM.
 *
 * ⚠️ **Colour is never the message** (FRONTEND §8). Every bar's name is a text label in its own
 * column, and the hue is the §3.3 stable index the payload carries — the same hue that name has
 * in every other view.
 *
 * ⚠️ **Rows are HTML, not SVG shapes.** Labels stay upright and legible at every zoom level, the
 * bars are real focusable buttons, and a screen reader reads a list of named rows instead of a
 * picture. Only the geometry is computed — as fractions, by `barGeometry` — and the browser does
 * the layout.
 */

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { categoricalVar } from '../../lib/colors';
import { cx } from '../../lib/cx';
import { formatClock, formatDurationShort, formatInteger, formatTimestamp } from '../../lib/format';
import { axisTicks, barGeometry, type TraceLevel, type TraceRow } from './trace-timeline';
import { KEY_PAN_RATIO, ZOOM_STEP, type TimeAxis } from './use-time-axis';

/**
 * The width rule, in the reader's own words. Exported so the test that guards it asserts the
 * shipped sentence rather than a paraphrase of it.
 */
export const WIDTH_RULE =
  'The main loop and each subagent run are drawn from the moment they started to the moment they ended, so a wider bar really did run for longer. Tool calls are recorded as single moments with no end time, so a group like “Read ×47” is drawn from its first call to its last: that shows when those calls happened, not how long they took. One call on its own has no width and is drawn as a marker.';

/** Said once, in the accessible name, because a chart cannot show its own instructions. */
export const TIMELINE_HELP =
  'Drag to move through time, scroll to zoom, arrow keys to move, plus and minus to zoom, 0 to show the whole of this level. Click a bar to see its numbers; double-click a bar, or use its Open button, to look inside it.';

/** A drag shorter than this many client pixels is a click on whatever is underneath, not a pan. */
const DRAG_SLOP = 3;

export interface TimelineBandProps {
  level: TraceLevel;
  axis: TimeAxis;
  selectedId: string | null;
  onSelect: (row: TraceRow) => void;
  /** Drilling — a **separate** action from selecting, on purpose (double-click, or the button). */
  onOpen: (row: TraceRow) => void;
  /** §8.5 P-23 — the hidden remainder is a count the reader can click, never a silent drop. */
  onRevealAll: () => void;
  /** §3.7's lane heading, shown above the first run whose starting point is unknown. */
  unlinkedLaneLabel: string;
  'data-testid'?: string;
}

export function TimelineBand({
  level,
  axis,
  selectedId,
  onSelect,
  onOpen,
  onRevealAll,
  unlinkedLaneLabel,
  'data-testid': testId = 'timeline-band',
}: TimelineBandProps): JSX.Element {
  const view = axis.window;
  const ticks = axisTicks(view);
  const flat = level.endTs === level.startTs;
  const surface = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; clientX: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);

  // The wheel listener is registered on the element with `{ passive: false }`: React attaches
  // `wheel` at the root as passive, so a `preventDefault()` in an `onWheel` prop is ignored and
  // the whole view scrolls away under the pointer instead of the axis zooming.
  // Written in a layout effect — before any event can fire — rather than during render, so the
  // listener always reads the current camera without being torn down on every render.
  const axisRef = useRef(axis);
  useLayoutEffect(() => {
    axisRef.current = axis;
  });
  useEffect(() => {
    const element = surface.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const current = axisRef.current;
      const rect = element.getBoundingClientRect();
      const fraction = rect.width <= 0 ? 0.5 : (event.clientX - rect.left) / rect.width;
      const focusTs =
        current.window.startTs + (current.window.endTs - current.window.startTs) * fraction;
      current.zoomAt(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, focusTs);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
    };
  }, []);

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.clientX;
    const rect = surface.current?.getBoundingClientRect();
    const width = rect === undefined || rect.width <= 0 ? 0 : rect.width;
    if (width > 0) {
      // Drag-to-pan means the content follows the pointer, so the window moves the other way.
      axis.panByMs((-dx / width) * (view.endTs - view.startTs));
    }
    drag.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      moved: active.moved || Math.abs(dx) > DRAG_SLOP,
    };
  };

  const rows = level.rows;
  const firstUnlinked = rows.findIndex((row) => row.unlinked);

  return (
    <figure data-testid={testId} className="flex min-w-0 flex-col gap-3">
      <figcaption
        data-testid={`${testId}-window`}
        className="flex flex-wrap items-baseline justify-between gap-2 text-micro text-text-muted"
      >
        <span>
          {flat
            ? /* One instant. Stated, never stretched across the width. */
              'Everything here is recorded at a single moment, so there is no span to lay out.'
            : `${formatTimestamp(view.startTs)} → ${formatTimestamp(view.endTs)}`}
        </span>
        <span>
          {axis.isZoomed
            ? `Zoomed in on part of this view — ${formatDurationShort((view.endTs - view.startTs) / 1000)} of ${formatDurationShort((level.endTs - level.startTs) / 1000)}`
            : flat
              ? ''
              : `${formatDurationShort((level.endTs - level.startTs) / 1000)} from end to end`}
        </span>
      </figcaption>

      <div
        ref={surface}
        data-testid={`${testId}-surface`}
        tabIndex={0}
        // `application` is the honest role: this element answers its own keys, and telling
        // assistive technology otherwise would have it swallow the arrows before they arrive.
        role="application"
        aria-label={`Timeline. ${TIMELINE_HELP}`}
        className="flex touch-none flex-col rounded-control border border-border select-none"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { pointerId: event.pointerId, clientX: event.clientX, moved: false };
        }}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          swallowClick.current = drag.current.moved;
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onClickCapture={(event) => {
          // A pan that ended over a bar must not also select it.
          if (!swallowClick.current) return;
          swallowClick.current = false;
          event.stopPropagation();
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          switch (event.key) {
            case 'ArrowLeft':
              axis.panByFraction(-KEY_PAN_RATIO);
              break;
            case 'ArrowRight':
              axis.panByFraction(KEY_PAN_RATIO);
              break;
            case '+':
            case '=':
              axis.zoomIn();
              break;
            case '-':
            case '_':
              axis.zoomOut();
              break;
            case '0':
              axis.fit();
              break;
            default:
              return;
          }
          event.preventDefault();
        }}
      >
        {/* ⚠️ Real clock labels. An axis of unlabelled ticks answers nothing (§6.12). */}
        <div className="flex items-end border-b border-border">
          <div className="w-52 shrink-0 px-3 py-1 text-micro text-text-faint">Time of day</div>
          <div data-testid={`${testId}-axis`} className="relative h-6 flex-1 overflow-hidden">
            {ticks.map((tick) => {
              // A label runs rightward from its own mark, so the one at the far edge would be
              // clipped away by the overflow — the last tick is the end of the window, which is
              // exactly the label a reader wants. It is anchored to the right instead.
              const atEnd = tick.fraction > 0.92;
              return (
                <span
                  key={tick.ts}
                  data-testid={`${testId}-tick`}
                  className={cx(
                    'absolute bottom-0 text-micro whitespace-nowrap text-text-muted',
                    atEnd ? 'border-r border-border pr-1' : 'border-l border-border pl-1',
                  )}
                  style={
                    atEnd ? { right: percent(1 - tick.fraction) } : { left: percent(tick.fraction) }
                  }
                >
                  {tick.dayLabel === null ? tick.label : `${tick.dayLabel} ${tick.label}`}
                </span>
              );
            })}
          </div>
        </div>

        {/*
          Vertical is a list and is **scrolled**, never zoomed — zooming it would only make the
          bars fatter. The height is capped so that asking for every remaining row grows a scroll
          area inside the chart rather than an unbounded page.
        */}
        {level.header !== null && (
          // Its own list, above the scroll area: the bar for the thing you are looking at stays
          // in view while its children scroll, which is what keeps the level's context readable.
          <ul className="flex flex-col">
            <Row
              row={level.header}
              view={view}
              scope
              selected={selectedId === level.header.id}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          </ul>
        )}

        <ul className="flex max-h-96 flex-col overflow-y-auto">
          {rows.map((row, index) => (
            <Fragment key={row.id}>
              {index === firstUnlinked && (
                // ⚠️ §3.7 / §6.7 — the lane is labelled in the DOM, not merely positioned. A
                // y-offset is not a label, and these runs must never read as parented.
                <li
                  data-testid="trace-unlinked-lane"
                  className="border-t border-border px-3 pt-2 pb-1 text-micro text-warn"
                >
                  {unlinkedLaneLabel} · {formatInteger(rows.length - firstUnlinked)} shown on their
                  own
                </li>
              )}
              <Row
                row={row}
                view={view}
                selected={selectedId === row.id}
                onSelect={onSelect}
                onOpen={onOpen}
              />
            </Fragment>
          ))}

          {rows.length === 0 && (
            <li className="px-3 py-3 text-small text-text-muted" data-testid={`${testId}-none`}>
              Nothing to show here — there are no {level.noun} recorded under this one.
            </li>
          )}
        </ul>
      </div>

      {level.hidden > 0 && (
        <button
          type="button"
          data-testid={`${testId}-more`}
          onClick={onRevealAll}
          className="self-start rounded-control border border-border px-3 py-1 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
        >
          {`and ${formatInteger(level.hidden)} more — show ${level.hidden === 1 ? 'it' : 'them'}`}
        </button>
      )}

      <p data-testid={`${testId}-width-rule`} className="text-micro text-text-muted">
        <span className="text-text-primary">How to read the widths. </span>
        {WIDTH_RULE}
      </p>
    </figure>
  );
}

interface RowProps {
  row: TraceRow;
  /** The visible time window. Every bar's geometry is a fraction of it. */
  view: { startTs: number; endTs: number };
  /** The row for the thing being looked at, drawn above its children. */
  scope?: boolean;
  selected: boolean;
  onSelect: (row: TraceRow) => void;
  onOpen: (row: TraceRow) => void;
}

function Row({ row, view, scope = false, selected, onSelect, onOpen }: RowProps): JSX.Element {
  const geometry = barGeometry(row, view);
  const instant = geometry.width === 0;

  return (
    <li
      data-testid="trace-row"
      data-row-id={row.id}
      data-row-kind={row.kind}
      data-scope={scope ? 'true' : undefined}
      data-unlinked={row.unlinked ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      className={cx(
        'flex items-center transition-colors duration-hover',
        selected ? 'bg-bg-surface-2' : 'hover:bg-bg-surface-2',
        scope && 'border-b border-border',
      )}
    >
      <div
        className={cx(
          'flex w-52 shrink-0 items-center gap-1 px-3 py-1',
          scope ? 'text-small text-text-primary' : 'text-micro text-text-primary',
        )}
      >
        <span className="min-w-0 flex-1 truncate" title={row.label}>
          {row.label}
        </span>
        {row.drillable && (
          <button
            type="button"
            data-testid="trace-open"
            data-row-id={row.id}
            aria-label={`Open ${row.label}`}
            title={`Open ${row.label} — ${formatInteger(row.toolCalls)} tool calls inside`}
            onClick={(event) => {
              event.stopPropagation();
              onOpen(row);
            }}
            className="rounded-control border border-border px-2 text-micro text-text-muted transition-colors duration-hover hover:bg-bg-surface"
          >
            ›
          </button>
        )}
      </div>

      <div className="relative h-6 flex-1 overflow-hidden">
        {geometry.visible && (
          <div
            data-testid="trace-bar"
            data-row-id={row.id}
            data-measured={row.measured ? 'true' : 'false'}
            data-instant={instant ? 'true' : undefined}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={barLabel(row)}
            title={barLabel(row)}
            onClick={() => {
              onSelect(row);
            }}
            onDoubleClick={() => {
              if (row.drillable) onOpen(row);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                onSelect(row);
                return;
              }
              if (event.key !== 'ArrowRight' || !row.drillable) return;
              event.preventDefault();
              event.stopPropagation();
              onOpen(row);
            }}
            className={cx(
              'absolute top-1/2 min-w-0.5 -translate-y-1/2 cursor-pointer rounded-pill',
              scope ? 'h-4' : row.kind === 'subagent' ? 'h-3' : 'h-2',
              // ⚠️ A bar built from point events is drawn hollow, with its two recorded instants
              // as solid ends. The treatment carries the same message as the sentence under the
              // chart: the ends are real, the middle is not a measurement.
              row.measured ? 'opacity-90' : 'border-x-2 opacity-50',
              selected && 'ring-2 ring-accent',
            )}
            style={{
              left: percent(geometry.left),
              width: percent(geometry.width),
              backgroundColor: categoricalVar(row.colorIndex),
              borderColor: categoricalVar(row.colorIndex),
            }}
          />
        )}
      </div>
    </li>
  );
}

/**
 * What a bar is called for a screen reader, a hover and a test: the name, what it stands for, and
 * the honest description of its two ends.
 */
export function barLabel(row: TraceRow): string {
  if (row.measured) {
    return `${row.label}, ran ${formatDurationShort((row.endTs - row.startTs) / 1000)} from ${formatClock(row.startTs)} to ${formatClock(row.endTs)}`;
  }
  if (row.count > 1) {
    return `${row.label}, first call ${formatClock(row.startTs)}, last call ${formatClock(row.endTs)} — the width is when the calls happened, not how long they took`;
  }
  return `${row.label}, one call at ${formatClock(row.startTs)} — a single moment, with no recorded duration`;
}

/**
 * A fraction as a CSS percentage, rounded to two decimals.
 *
 * Two decimals is ~0.01% of the width — well under a pixel on any real canvas — and it keeps the
 * rendered attribute exactly predictable, so a test asserts a hand-computed `'50%'` rather than a
 * blessed snapshot of whatever floating-point noise came out.
 */
export function percent(fraction: number): string {
  return `${String(Math.round(fraction * 10_000) / 100)}%`;
}
