/**
 * §6.4 — "**Full width:** treemap, **output tokens by project**, tiles in project hues with
 * labels inside."
 *
 * visx (STACK ADR-011 — visx serves "the bespoke visuals FRONTEND §5 specifies … treemap"),
 * sized by `ParentSize` so the tiles and their labels scale in real pixels rather than being
 * stretched by a viewBox.
 *
 * ⚠️ **A hue is never the only carrier of identity** (FRONTEND §8): every tile large enough
 * carries its project name and figure inside it, and the accessible list beneath carries all of
 * them regardless of tile size.
 *
 * ⚠️ A project with **zero** output tokens is dropped from the layout rather than drawn as a
 * zero-area tile: `d3-hierarchy` gives it no area anyway, and a legend entry pointing at
 * nothing is worse than its absence. It still appears in the list beneath.
 */

import type { JSX } from 'react';
import { Treemap, hierarchy } from '@visx/hierarchy';
import { ParentSize } from '@visx/responsive';
import type { TokensByProject } from '../../../shared/ipc-contract';
import { categoricalVar } from '../../lib/colors';
import { formatCompact, formatInteger } from '../../lib/format';

const CHART_HEIGHT = 320;
/** Below this many pixels of tile edge, a label would overflow its tile; the list carries it. */
const LABEL_MIN_EDGE = 64;

type Row = TokensByProject['rows'][number];

interface Node {
  name: string;
  projectId: number;
  colorIndex: number;
  value: number;
  children?: Node[];
}

export interface ProjectTreemapProps {
  tokens: TokensByProject;
  /**
   * ⚠️ Opens the shared project-detail surface for a tile's project (§6.4 / §6.8 — "the project
   * should be clickable, I go into the project and see all the project stats"). The id is the
   * project UNIT id (ADR-040), the same the card and the global filter speak, so a group tile
   * opens the group. Absent ⇒ tiles are inert (the accessible list still names every project).
   */
  onSelect?: (projectId: number, displayName: string) => void;
  'data-testid'?: string;
}

export function ProjectTreemap({
  tokens,
  onSelect,
  'data-testid': testId = 'project-treemap',
}: ProjectTreemapProps): JSX.Element {
  const rows = tokens.rows.filter((row) => row.outputTokens > 0);

  return (
    <div data-testid={testId}>
      <div style={{ height: CHART_HEIGHT }}>
        <ParentSize>
          {({ width, height }) => (
            // ⚠️ Fall back to an estimate before the observer has measured (and under jsdom, where
            // there is no live layout at all), so the tiles paint on the first frame instead of
            // flashing an empty box. The real size replaces it as soon as it is known.
            <TreemapSvg
              rows={rows}
              width={width || 640}
              height={height || CHART_HEIGHT}
              onSelect={onSelect}
            />
          )}
        </ParentSize>
      </div>

      {/* FRONTEND §8 — the figures exist outside the picture. */}
      <ul className="sr-only" data-testid={`${testId}-list`}>
        {tokens.rows.map((row) => (
          <li key={row.projectId}>
            {row.displayName}: {formatInteger(row.outputTokens)} output tokens
          </li>
        ))}
      </ul>
    </div>
  );
}

function TreemapSvg({
  rows,
  width,
  height,
  onSelect,
}: {
  rows: Row[];
  width: number;
  height: number;
  onSelect?: (projectId: number, displayName: string) => void;
}): JSX.Element {
  const root = hierarchy<Node>({
    name: 'root',
    projectId: 0,
    colorIndex: 0,
    value: 0,
    children: rows.map((row) => ({
      name: row.displayName,
      projectId: row.projectId,
      colorIndex: row.colorIndex,
      value: row.outputTokens,
    })),
  })
    .sum((node) => node.value)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  return (
    <svg width={width} height={height} role="img" aria-label="Output tokens by project">
      <Treemap<Node> root={root} size={[width, height]} round paddingInner={2}>
        {(treemap) => (
          <g>
            {treemap.leaves().map((node) => {
              const tileWidth = node.x1 - node.x0;
              const tileHeight = node.y1 - node.y0;
              const hue = categoricalVar(node.data.colorIndex);
              const clickable = onSelect !== undefined;
              const open = clickable
                ? () => onSelect(node.data.projectId, node.data.name)
                : undefined;
              return (
                <g
                  key={node.data.name}
                  transform={`translate(${String(node.x0)},${String(node.y0)})`}
                  // ⚠️ A11y (§6.12 / P-30) — a clickable tile is a real button: reachable by
                  // keyboard, activated by Enter/Space, and named for a screen reader.
                  data-testid={
                    clickable ? `treemap-tile-${String(node.data.projectId)}` : undefined
                  }
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-label={
                    clickable
                      ? `${node.data.name}: ${formatInteger(node.value ?? 0)} output tokens — open project`
                      : undefined
                  }
                  className={clickable ? 'cursor-pointer focus-visible:outline-2' : undefined}
                  onClick={open}
                  onKeyDown={(event) => {
                    if (open === undefined) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      open();
                    }
                  }}
                >
                  <rect
                    width={tileWidth}
                    height={tileHeight}
                    rx={4}
                    fill={hue}
                    fillOpacity={0.55}
                    stroke={hue}
                  />
                  {tileWidth >= LABEL_MIN_EDGE && tileHeight >= LABEL_MIN_EDGE && (
                    <text x={8} y={20} className="fill-text-primary text-small">
                      {node.data.name}
                      <tspan x={8} dy={16} className="fill-text-muted text-micro">
                        {formatCompact(node.value ?? 0)}
                      </tspan>
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        )}
      </Treemap>
    </svg>
  );
}
