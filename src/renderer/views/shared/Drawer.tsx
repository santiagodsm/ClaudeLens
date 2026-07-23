/**
 * §6.5 — "row click → drill-down. **Session drill-down** is a right-hand drawer (not a route)."
 *
 * Not a route, deliberately: a drill-down that changes the URL changes the view title, the
 * back-button semantics and the global filter's meaning, none of which §6.5 asks for. It is a
 * panel over the same view, and closing it restores exactly what was there.
 *
 * ⚠️ **It is not a modal and it never appears unbidden** (§6.2). It opens only from a user
 * gesture, it does not trap focus, and it does not dim the app. What it does do is take focus
 * on open — a user-initiated drill-down that leaves the keyboard behind is unusable (P-30) —
 * and return it on Escape.
 *
 * FRONTEND §7 — "Drawer: 240ms slide", via the `duration-drawer` token.
 */

import { useEffect, useRef } from 'react';
import type { JSX, ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface DrawerProps {
  open: boolean;
  title: string;
  /** The line beneath the title — an id, a project, a date range. */
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  'data-testid'?: string;
}

export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  'data-testid': testId = 'drawer',
}: DrawerProps): JSX.Element {
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return <></>;

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-label={title}
      data-testid={testId}
      className={cx(
        'fixed inset-y-0 right-0 z-40 flex w-full max-w-xl flex-col overflow-y-auto',
        'border-l border-border bg-bg-surface p-6 shadow-card transition-transform duration-drawer',
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-h3 font-semibold text-text-primary">{title}</h2>
          {subtitle !== undefined && <p className="mt-1 text-small text-text-muted">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close drill-down"
          data-testid={`${testId}-close`}
          className="rounded-control border border-border px-3 py-1 text-small text-text-muted transition-colors duration-hover hover:bg-bg-surface-2"
        >
          Close
        </button>
      </header>

      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </aside>
  );
}
