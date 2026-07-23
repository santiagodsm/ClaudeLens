/**
 * §6.2 — the global project filter, one half of the `GlobalFilter` of §4.2.
 *
 * ⚠️ **Three states, and no two of them may look alike.** §4.2 defines `projectIds: number[] |
 * null` with `null` = every project, so "all" is a state in its own right — it is **not** the
 * list of every id. This file previously rendered "all" as *every row ticked* and started a
 * toggle from `rows.map(r => r.projectId)`, so the first click on the project the user actually
 * wanted **removed** it and kept the other eleven. That is the reported defect. Here:
 *
 *   · "All projects" is its own row, and it is the checked one; every project row is unchecked.
 *   · A project row is a **real checkbox** — selection is a tick, never a background tint
 *     (§6.12 / FRONTEND §8: meaning is never carried by colour alone).
 *   · From "all", ticking one project therefore yields exactly that project. `Only` on any row
 *     collapses a wider selection to one project in a single click.
 *   · Untick the last one (or tick every one) and the filter returns to `null`. `[]` is never
 *     emitted: §4.2 does not define it, and "show nothing" is not a state anyone asks for.
 *
 * ⚠️ Selection is by `projectId`, always. §3.3 — `display_name` is cosmetic and **two projects
 * may share one** (worktrees are siblings); the encoded name disambiguates, in the row and in
 * its tooltip.
 *
 * ⚠️ The project list is fetched **only when the menu is open** — or, for exactly one query,
 * when a single-project filter was restored from `lastGlobalFilter` (§3.13) and the trigger
 * does not yet know that project's name to print it. Two reasons, both structural:
 *   · §7.4 — the store holds the filter, not the project list. The list is a query result and
 *     lives for exactly as long as the menu that shows it.
 *   · §6.2 — the shell must be quiet. A permanently-mounted query in the top bar would re-fire
 *     on every `evt:dataChanged` and put a spinner in the chrome, which is precisely the
 *     peripheral-vision failure the design forbids. Names already learned are kept in this
 *     component, so the label never re-queries for a project it has already seen.
 *
 * With no `q:projectCards` handler registered yet, opening the menu shows an `ErrorState`. That
 * is the honest degradation: the filter does not silently offer an empty project list, because
 * "no projects" and "could not ask" are different answers (CLAUDE.md §1).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent as ReactKeyboardEvent, SVGProps } from 'react';
import type { AppError, ProjectCard } from '../../shared/ipc-contract';
import { useQuery } from '../hooks/use-query';
import { ALL_TIME_ALL_PROJECTS } from '../store/app-store';
import { cx } from '../lib/cx';
import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';

export interface ProjectFilterProps {
  disabled: boolean;
  /** `null` = all projects (§4.2). */
  selected: number[] | null;
  onChange: (projectIds: number[] | null) => void;
}

/** Just enough of a project to label the trigger; the identity is the id, never the name. */
interface ProjectName {
  displayName: string;
  /** ⚠️ `null` for a group (ADR-040) — a group is not a directory and has no folder name. */
  encodedName: string | null;
}

export const ALL_PROJECTS_LABEL = 'All projects';

/**
 * §6.2 — the top bar is glanceable, so the trigger states the filter precisely: the project's
 * own name for one (more useful than "1 project", and the same width), "N projects" for several,
 * "All projects" for all.
 */
export function projectFilterLabel(
  selected: number[] | null,
  names: ReadonlyMap<number, ProjectName>,
): string {
  const ids = selected ?? [];
  if (ids.length === 0) return ALL_PROJECTS_LABEL;
  if (ids.length === 1) {
    const id = ids[0];
    const known = id === undefined ? undefined : names.get(id);
    // Before the menu has ever opened we may not know the name yet; the count is the honest
    // fallback, never a guessed or remembered name.
    return known?.displayName ?? '1 project';
  }
  return `${String(ids.length)} projects`;
}

export function ProjectFilter({ disabled, selected, onChange }: ProjectFilterProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const namesRef = useRef<Map<number, ProjectName> | null>(null);
  const names = (namesRef.current ??= new Map<number, ProjectName>());

  const selectedIds = selected ?? [];
  const single = selectedIds.length === 1 ? (selectedIds[0] ?? null) : null;
  const needsName = single !== null && !names.has(single);

  const projects = useQuery('q:projectCards', ALL_TIME_ALL_PROJECTS, {
    enabled: open || needsName,
  });
  const rows = projects.data?.rows ?? null;

  // The trigger must be able to print a name after the menu is closed and the query result is
  // gone, so names are remembered here. A ref rather than state, and filled in render rather
  // than in an effect, because the label has to be right in the SAME frame the rows arrive —
  // a second render pass to catch up is the one thing §6.2 forbids in the top bar. The write is
  // idempotent (same rows in, same map out), so a double render cannot change the outcome.
  // ⚠️ This is a display cache, never a second source of truth: the selection itself lives only
  // in the store (§7.4), and it is a set of ids — §3.3 names are never an identity.
  if (rows !== null) {
    for (const row of rows) {
      names.set(row.projectId, { displayName: row.displayName, encodedName: row.encodedName });
    }
  }

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    // §6.12 / FRONTEND §8 — closing with the keyboard puts focus back where it started.
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Clicking away closes the menu. It never moves focus: §6.2's peripheral-vision rule is about
  // nothing *unbidden* taking focus, and a click elsewhere is the user choosing where to be.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof Node && wrapperRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const menuItems = useCallback(
    (): HTMLElement[] =>
      Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? []),
    [],
  );

  const rowCount = rows?.length ?? 0;

  // Opening moves focus into the menu so it can be driven entirely from the keyboard. It runs
  // only on the user's own click or keypress, and never steals focus back once the user is
  // already inside the menu.
  useEffect(() => {
    if (!open) return;
    const node = menuRef.current;
    if (node === null) return;
    if (node.contains(document.activeElement)) return;
    menuItems()[0]?.focus();
  }, [open, rowCount, menuItems]);

  const moveFocus = (delta: number): void => {
    const items = menuItems();
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(index + delta + items.length) % items.length];
    next?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      if (!open) return;
      event.stopPropagation();
      close(true);
      return;
    }
    if (!open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const items = menuItems();
      (event.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
    }
  };

  const label = projectFilterLabel(selected, names);
  const singleEncoded = single === null ? undefined : (names.get(single)?.encodedName ?? undefined);

  /** The one place a selection is turned into a `GlobalFilter` value (§4.2). */
  const commit = (ids: number[]): void => {
    // `[]` would mean "show nothing", which §4.2 does not define and no user intends; a full
    // house is spelled `null`, so "all" has exactly one representation.
    onChange(ids.length === 0 || (rowCount > 0 && ids.length === rowCount) ? null : ids);
  };

  const toggle = (projectId: number): void => {
    commit(
      selectedIds.includes(projectId)
        ? selectedIds.filter((id) => id !== projectId)
        : [...selectedIds, projectId],
    );
  };

  return (
    <div className="relative" ref={wrapperRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={triggerRef}
        data-testid="project-filter"
        data-state={selectedIds.length === 0 ? 'all' : selectedIds.length === 1 ? 'one' : 'many'}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="project-filter-menu"
        aria-label={`Project filter: ${label}`}
        // §3.3 — the encoded name disambiguates two projects that share a display name.
        title={singleEncoded}
        disabled={disabled}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="flex min-w-40 max-w-64 items-center gap-2 rounded-control border border-border bg-bg-surface px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
      >
        <span className="truncate">{label}</span>
        <CaretIcon className="ml-auto shrink-0 text-text-muted" />
      </button>

      {open && (
        <div
          id="project-filter-menu"
          ref={menuRef}
          data-testid="project-filter-menu"
          role="group"
          aria-label="Projects"
          // Absolutely positioned, so opening and closing never reflows the bar behind it (§6.2).
          className="absolute right-0 z-30 mt-2 flex max-h-96 w-80 flex-col gap-2 overflow-y-auto rounded-card border border-border bg-bg-surface p-3 shadow-card"
        >
          <ProjectFilterMenu
            rows={rows}
            loading={projects.loading}
            error={projects.error}
            refetch={projects.refetch}
            selectedIds={selectedIds}
            onAll={() => {
              onChange(null);
            }}
            onToggle={toggle}
            onOnly={(projectId) => {
              commit([projectId]);
            }}
          />
        </div>
      )}
    </div>
  );
}

interface ProjectFilterMenuProps {
  rows: ProjectCard[] | null;
  loading: boolean;
  error: AppError | null;
  refetch: () => void;
  selectedIds: number[];
  onAll: () => void;
  onToggle: (projectId: number) => void;
  onOnly: (projectId: number) => void;
}

function ProjectFilterMenu({
  rows,
  loading,
  error,
  refetch,
  selectedIds,
  onAll,
  onToggle,
  onOnly,
}: ProjectFilterMenuProps): JSX.Element {
  if (error !== null) {
    return <ErrorState error={error} onRetry={refetch} className="border-0" />;
  }
  if (loading && rows === null) {
    return <LoadingState label="Loading projects" lines={4} />;
  }
  if (rows === null || rows.length === 0) {
    return <EmptyState reason="No projects have been parsed yet" />;
  }

  const isAll = selectedIds.length === 0;

  return (
    <>
      {/* ⚠️ "All projects" is the state, checked, with every project row unchecked below it. */}
      <button
        type="button"
        data-menu-item=""
        data-testid="project-filter-all"
        data-selected={isAll ? 'true' : 'false'}
        aria-pressed={isAll}
        onClick={onAll}
        className={cx(
          'flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-small text-text-primary',
          'transition-colors duration-hover hover:bg-bg-surface-2',
          isAll && 'bg-bg-surface-2',
        )}
      >
        <CheckIcon className={cx('shrink-0', isAll ? 'text-accent' : 'text-transparent')} />
        <span>{ALL_PROJECTS_LABEL}</span>
      </button>

      <ul className="flex flex-col gap-1">
        {rows.map((row) => {
          const checked = selectedIds.includes(row.projectId);
          return (
            <li key={row.projectId} className="flex items-center gap-1">
              <label
                data-testid={`project-filter-option-${String(row.projectId)}`}
                data-selected={checked ? 'true' : 'false'}
                // §3.3 — the tooltip carries the encoded name, which is the identity. ⚠️ For a
                // group (ADR-040) there is no folder of its own, so it carries the folders it
                // stands for instead — the same question, answered honestly for a group.
                title={optionTitle(row)}
                className={cx(
                  'flex min-w-0 flex-1 items-center gap-2 rounded-control px-3 py-2 text-small text-text-primary',
                  'transition-colors duration-hover hover:bg-bg-surface-2',
                  checked && 'bg-bg-surface-2',
                )}
              >
                <input
                  type="checkbox"
                  data-menu-item=""
                  data-testid={`project-filter-checkbox-${String(row.projectId)}`}
                  checked={checked}
                  onChange={() => {
                    onToggle(row.projectId);
                  }}
                  onKeyDown={(event) => {
                    // Space is native; Enter is not, and a menu that ignores Enter feels broken.
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onToggle(row.projectId);
                    }
                  }}
                  className="size-4 shrink-0"
                  style={{ accentColor: 'var(--accent)' }}
                />
                <Badge colorIndex={row.colorIndex}>{row.displayName}</Badge>
                {/* §3.3 / P-33 — the encoded name is the identity, but it embeds the absolute
                    home path and username, so it lives ONLY in the label's `title` (hover) for
                    disambiguation — never as visible text. A group shows its folder count, which
                    carries no path. */}
                {row.encodedName === null && (
                  <span className="ml-auto truncate text-micro text-text-faint">
                    {`${String(row.members.length)} folders`}
                  </span>
                )}
              </label>
              {/* "Show me just this one", from any selection, in one click. */}
              <button
                type="button"
                data-testid={`project-filter-only-${String(row.projectId)}`}
                aria-label={`Show only ${row.displayName} (${optionTitle(row)})`}
                onClick={() => {
                  onOnly(row.projectId);
                }}
                className="shrink-0 rounded-control px-2 py-1 text-micro text-text-muted transition-colors duration-hover hover:bg-bg-surface-2 hover:text-text-primary"
              >
                Only
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-2 border-t border-border pt-2">
        <p data-testid="project-filter-summary" className="text-micro text-text-muted">
          {isAll
            ? 'Showing every project'
            : `Showing ${String(selectedIds.length)} of ${String(rows.length)} projects`}
        </p>
        <button
          type="button"
          data-testid="project-filter-clear"
          aria-label="Clear the project filter and show all projects"
          disabled={isAll}
          onClick={onAll}
          className={cx(
            'ml-auto shrink-0 rounded-control border border-border px-2 py-1 text-micro',
            'transition-colors duration-hover hover:bg-bg-surface-2',
            isAll ? 'text-text-faint opacity-60' : 'text-text-primary',
          )}
        >
          Clear
        </button>
      </div>
    </>
  );
}

/**
 * What goes in the row's secondary slot and its tooltip.
 *
 * A plain project answers with its folder name — the identity (§3.3). A group has no folder of
 * its own, so it answers with the folders it stands for, which is the same question honestly
 * answered. ⚠️ Never an empty string: "no folder" and "a folder with no name" are different
 * claims (CLAUDE.md §1).
 */
function optionTitle(row: ProjectCard): string {
  if (row.encodedName !== null) return row.encodedName;
  return row.members.map((member) => member.encodedName).join(' · ');
}

type GlyphProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

/** Local glyphs — the icon set (FRONTEND §5) has no tick or caret, and both are one path. */
function CheckIcon(props: GlyphProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function CaretIcon(props: GlyphProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
