/**
 * §6.2 — the **eight** nav items, in this order and with these labels:
 * Overview · Tokens & Cost · Sessions & Time · Tools & Agents · Graphs · Projects & Code ·
 * Harness Manager · Settings.
 *
 * ⚠️ There is no ninth item. **Onboarding is a state of the shell, not a view** (§6.2): with
 * `dirStatus = 'unset'` the sidebar and top bar render disabled and the content area shows the
 * directory picker. Adding "Onboarding" or "Getting started" here would be a design change.
 *
 * The `id` values are the §6.2 / ADR-018 test-hook ids: `overview`, `tokens`, `sessions`,
 * `tools`, `graphs`, `projects`, `harness`, `settings`. Every view root carries
 * `data-testid="view-<id>"` and its primary region `data-testid="view-<id>-primary"`, and the
 * smoke suite selects on those, never on copy or styling.
 */

import type { ComponentType, SVGProps } from 'react';
import {
  GraphsIcon,
  HarnessIcon,
  OverviewIcon,
  ProjectsIcon,
  SessionsIcon,
  SettingsIcon,
  TokensIcon,
  ToolsIcon,
} from '../components/icons';

/** The closed set of view ids (§6.2). A route or test hook outside it is a compile error. */
export type ViewId =
  'overview' | 'tokens' | 'sessions' | 'tools' | 'graphs' | 'projects' | 'harness' | 'settings';

export interface NavItem {
  id: ViewId;
  /** §6.2 verbatim. Changing one is a design change, not a copy edit. */
  label: string;
  /** The route path. `overview` is also the index route. */
  path: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/** Named, because it is also the index route and the fallback title. */
export const OVERVIEW_ITEM: NavItem = {
  id: 'overview',
  label: 'Overview',
  path: '/overview',
  Icon: OverviewIcon,
};

export const NAV_ITEMS: readonly NavItem[] = [
  OVERVIEW_ITEM,
  { id: 'tokens', label: 'Tokens & Cost', path: '/tokens', Icon: TokensIcon },
  { id: 'sessions', label: 'Sessions & Time', path: '/sessions', Icon: SessionsIcon },
  { id: 'tools', label: 'Tools & Agents', path: '/tools', Icon: ToolsIcon },
  { id: 'graphs', label: 'Graphs', path: '/graphs', Icon: GraphsIcon },
  { id: 'projects', label: 'Projects & Code', path: '/projects', Icon: ProjectsIcon },
  { id: 'harness', label: 'Harness Manager', path: '/harness', Icon: HarnessIcon },
  { id: 'settings', label: 'Settings', path: '/settings', Icon: SettingsIcon },
] as const;

/** The view title shown in the top bar. Identical to the nav label by design (§6.2). */
export function titleForPath(pathname: string): string {
  const match = NAV_ITEMS.find((item) => pathname.startsWith(item.path));
  return match?.label ?? OVERVIEW_ITEM.label;
}
