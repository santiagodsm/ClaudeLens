import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import { App } from './App';
import './styles/tokens.css';

// `HashRouter`, not `BrowserRouter`: the packaged app loads the renderer from `file://`
// (STACK ADR-003 — there is no server, no port and no host), and a history-API route has no
// origin to resolve against there. The hash is inert, local, and needs nothing served.

const container = document.getElementById('root');
if (container === null) {
  // Never zero-fill, never substitute, never default (CLAUDE.md §1). A missing mount point
  // is a build defect, not a state to render around.
  throw new Error('Renderer mount point #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
