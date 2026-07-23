// The app root (DESIGN §6.2, §7.3). The shell, the eight routes and one error boundary per
// view all hang off `AppRoutes`; the router itself is supplied by whoever mounts `App`
// (`HashRouter` in `main.tsx`, `MemoryRouter` in a component test), so the tree under test is
// the tree that ships.
//
// `data-testid="app-shell"` lives on the shell element in `shell/AppShell.tsx`, where §6.2 puts
// it — not here, so that a test selecting it is selecting the real chrome.

import type { JSX } from 'react';
import { AppRoutes } from './routes';

export function App(): JSX.Element {
  return <AppRoutes />;
}
