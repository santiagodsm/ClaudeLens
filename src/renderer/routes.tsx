/**
 * Routing (React Router 8, STACK ADR-004).
 *
 * Eight routes, one per §6.2 nav item, derived from `NAV_ITEMS` so the router and the sidebar
 * cannot disagree about how many views exist or what they are called.
 *
 * ⚠️ **One error boundary per view** (§7.3): "Renderer errors are caught by one error boundary
 * per view, so a broken chart never blanks the shell." Each element is wrapped individually —
 * not the layout, not the whole tree.
 *
 * ⚠️ There is no onboarding route. Onboarding is a state of `AppShell` (§6.2).
 */

import type { JSX } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AppShell } from './shell/AppShell';
import { NAV_ITEMS, OVERVIEW_ITEM } from './shell/nav';
import type { ViewId } from './shell/nav';
import { ViewErrorBoundary } from './components/ViewErrorBoundary';
import { GraphsView } from './views/GraphsView';
import { HarnessView } from './views/HarnessView';
import { OverviewView } from './views/OverviewView';
import { ProjectsView } from './views/ProjectsView';
import { SessionsView } from './views/SessionsView';
import { SettingsView } from './views/SettingsView';
import { TokensView } from './views/TokensView';
import { ToolsView } from './views/ToolsView';

/**
 * The view element for each id. Typed as a total map over `ViewId`, so adding a ninth nav item
 * without a view — or a view without a nav item — is a compile error rather than a blank page.
 */
const VIEW_ELEMENTS: Record<ViewId, JSX.Element> = {
  overview: <OverviewView />,
  tokens: <TokensView />,
  sessions: <SessionsView />,
  tools: <ToolsView />,
  graphs: <GraphsView />,
  projects: <ProjectsView />,
  harness: <HarnessView />,
  settings: <SettingsView />,
};

export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to={OVERVIEW_ITEM.path} replace />} />
        {NAV_ITEMS.map((item) => (
          <Route
            key={item.id}
            path={item.path}
            element={
              <ViewErrorBoundary viewId={item.id}>{VIEW_ELEMENTS[item.id]}</ViewErrorBoundary>
            }
          />
        ))}
        {/* An unknown path is a navigation bug, not a user-facing 404 surface: this app has
            eight views and no addressable content beyond them. */}
        <Route path="*" element={<Navigate to={OVERVIEW_ITEM.path} replace />} />
      </Route>
    </Routes>
  );
}
