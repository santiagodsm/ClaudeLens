/**
 * FRONTEND §5 — "sortable headers, sticky header, zebra via `--bg-surface-2` at low alpha, row
 * hover ring, click → drill-down. Tabular numerals in numeric columns."
 * P-30 — full keyboard navigation.
 *
 * ⚠️ **P-28 is enforced here, not hoped for.** "The renderer never holds more than 5,000 rows of
 * any single result set, and never the full dataset." Handed more, the table renders the first
 * `MAX_RENDERED_ROWS` and says so in a caption. It does not silently truncate: an invisible
 * truncation turns "the top of the list" into "the list", which is a wrong answer wearing a
 * right answer's clothes.
 *
 * Sorting is **controlled** — `sort` and `onSortChange` come from the caller, because every
 * §4.5 paged query sorts server-side (`q:sessions` takes `sort` and `dir`). A table that
 * re-sorted its own page would sort one page of a many-page result and present it as the whole
 * ordering.
 */

import type { JSX, KeyboardEvent, ReactNode } from 'react';
import type { SortDirection } from '../../shared/ipc-contract';
import { cx } from '../lib/cx';
import { MAX_RENDERED_ROWS } from '../lib/limits';
import { formatInteger } from '../lib/format';
import { SortIcon } from './icons';

export interface Column<Row> {
  /** Stable id; also the sort key handed back to `onSortChange`. */
  id: string;
  header: string;
  /** Numeric columns get `text-right` and tabular numerals (FRONTEND §5). */
  numeric?: boolean;
  /** `false` when the underlying query cannot sort by this column. Default `false`. */
  sortable?: boolean;
  /** Column width as a CSS length — pass a token, never a raw px string. */
  width?: string;
  render: (row: Row) => ReactNode;
}

export interface SortState {
  columnId: string;
  direction: SortDirection;
}

export interface DataTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  /** Stable identity per row — required, because React keys by index reorder wrongly on sort. */
  rowKey: (row: Row) => string;
  caption: string;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  /** Drill-down (§6.5 "click a row to inspect"). Rows become focusable when this is set. */
  onRowActivate?: (row: Row) => void;
  className?: string;
  'data-testid'?: string;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  sort,
  onSortChange,
  onRowActivate,
  className,
  'data-testid': testId = 'data-table',
}: DataTableProps<Row>): JSX.Element {
  const capped = rows.length > MAX_RENDERED_ROWS;
  const visible = capped ? rows.slice(0, MAX_RENDERED_ROWS) : rows;

  const nextDirection = (columnId: string): SortDirection =>
    sort?.columnId === columnId && sort.direction === 'desc' ? 'asc' : 'desc';

  // P-30 — roving focus down the rows with the arrow keys, activate with Enter or Space.
  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: Row): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onRowActivate?.(row);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const current = event.currentTarget;
    const sibling =
      event.key === 'ArrowDown' ? current.nextElementSibling : current.previousElementSibling;
    if (sibling instanceof HTMLElement) sibling.focus();
  };

  return (
    <div className={cx('w-full overflow-auto', className)} data-testid={`${testId}-scroll`}>
      <table
        data-testid={testId}
        className="w-full border-collapse text-body"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-bg-surface">
          <tr>
            {columns.map((column) => {
              const isSorted = sort?.columnId === column.id;
              const sortable = (column.sortable ?? false) && onSortChange !== undefined;
              return (
                <th
                  key={column.id}
                  scope="col"
                  style={column.width === undefined ? undefined : { width: column.width }}
                  aria-sort={
                    isSorted
                      ? sort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : sortable
                        ? 'none'
                        : undefined
                  }
                  className={cx(
                    'border-b border-border px-3 py-3 text-micro font-semibold uppercase text-text-muted',
                    column.numeric === true ? 'text-right' : 'text-left',
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => {
                        onSortChange({ columnId: column.id, direction: nextDirection(column.id) });
                      }}
                      className={cx(
                        'inline-flex items-center gap-1 transition-colors duration-hover hover:text-text-primary',
                        isSorted && 'text-text-primary',
                      )}
                    >
                      {column.header}
                      {/* Direction is spelled out for assistive tech via aria-sort above; the
                          glyph is a redundant cue, never the only one (FRONTEND §8). */}
                      <SortIcon aria-hidden="true" />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, rowIndex) => (
            <tr
              key={rowKey(row)}
              tabIndex={onRowActivate === undefined ? undefined : 0}
              onClick={
                onRowActivate === undefined
                  ? undefined
                  : () => {
                      onRowActivate(row);
                    }
              }
              onKeyDown={
                onRowActivate === undefined
                  ? undefined
                  : (event) => {
                      onRowKeyDown(event, row);
                    }
              }
              data-testid={`${testId}-row`}
              className={cx(
                'transition-colors duration-hover',
                rowIndex % 2 === 1 && 'bg-[var(--tint-zebra)]',
                onRowActivate !== undefined && 'cursor-pointer hover:bg-[var(--tint-hover)]',
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.id}
                  className={cx(
                    'border-b border-border px-3 py-3 text-text-primary',
                    column.numeric === true ? 'text-right' : 'text-left',
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {capped && (
        <p data-testid={`${testId}-cap`} className="px-3 py-3 text-small text-text-muted">
          Showing the first {formatInteger(MAX_RENDERED_ROWS)} of {formatInteger(rows.length)} rows
          (§8.6 P-28). Narrow the filter to see the rest.
        </p>
      )}
    </div>
  );
}
