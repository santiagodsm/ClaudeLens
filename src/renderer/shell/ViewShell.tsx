/**
 * The wrapper every view renders through, so the §6.2 / ADR-018 test hooks cannot be forgotten:
 * the root carries `data-testid="view-<id>"` and the primary content region carries
 * `data-testid="view-<id>-primary"`. **The smoke suite selects on these, never on copy or
 * styling** — which only holds if every view actually has them, and this is how.
 *
 * It also owns the FRONTEND §7 view transition (200 ms fade + 8 px slide) and the 12-column
 * grid each view lays its cards out on.
 *
 * ⚠️ The transition is keyed to the view, not to the data: navigating animates, a number
 * arriving does not (§6.12, §1.3 moment 2).
 */

import { motion } from 'framer-motion';
import type { JSX, ReactNode } from 'react';
import { cx } from '../lib/cx';
import { useViewTransition } from '../lib/motion';
import type { ViewId } from './nav';

export interface ViewShellProps {
  id: ViewId;
  /** The view's own heading, when it needs one beyond the top-bar title (§6.5 header line). */
  heading?: ReactNode;
  /** The primary region — the one the smoke suite asserts on. */
  children: ReactNode;
  /** Anything below the primary region: secondary rows, right rails, tables. */
  secondary?: ReactNode;
  className?: string;
}

export function ViewShell({
  id,
  heading,
  children,
  secondary,
  className,
}: ViewShellProps): JSX.Element {
  const transition = useViewTransition();

  return (
    <motion.div
      {...transition}
      data-testid={`view-${id}`}
      className={cx('col-span-12 grid grid-cols-12', className)}
      style={{ gap: 'var(--grid-gutter)' }}
    >
      {heading !== undefined && <div className="col-span-12">{heading}</div>}
      <section data-testid={`view-${id}-primary`} className="col-span-12">
        {children}
      </section>
      {secondary}
    </motion.div>
  );
}
