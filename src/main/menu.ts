// The macOS application menu and the native About panel (DESIGN §6.2 — the shell is Claude Lens,
// not "Electron").
//
// ⚠️ This module is deliberately electron-free at runtime. It imports only *types* from electron
// (`import type`, erased under `verbatimModuleSyntax`) and returns plain data: a menu template and
// an about-panel options object. `src/main/index.ts` is the one place that hands these to
// `Menu.buildFromTemplate` / `Menu.setApplicationMenu` / `app.setAboutPanelOptions`. Keeping the
// electron calls out of here is what lets the `main` Vitest project (node env, no electron binary)
// unit-test the menu shape and the About copy without launching a window.
//
// ⚠️ §1a — no jargon reaches the screen. The About copy below is plain language: it never names a
// metric id, a channel, a column or a state machine. It says what the app is, in words.

import type { AboutPanelOptionsOptions, MenuItemConstructorOptions } from 'electron';
import { APP_NAME, APP_VERSION } from '../shared/version';

/**
 * The native About panel's contents (`app.setAboutPanelOptions`).
 *
 * §6.2 — names the app, shows the version, says in plain language what it is, and lands one
 * on-brand joke in `credits` (the conventional home for it). Nothing here impersonates Anthropic
 * or claims to be an official product: it describes what the app reads and does, and nothing more.
 */
export function aboutPanelOptions(): AboutPanelOptionsOptions {
  return {
    applicationName: APP_NAME,
    applicationVersion: APP_VERSION,
    // Shown under the name on macOS. Plain, and honest about the one thing that matters most here.
    copyright: 'Runs entirely on your machine. Nothing leaves it.',
    // Two plain sentences on what it is, then the joke — clean, self-aware, on-brand (§1a).
    credits:
      'Claude Lens is a local dashboard that reads your Claude Code history and shows where the ' +
      'tokens, time and money actually went — the main loop versus your subagents, cost by ' +
      'project, and the shape of your setup. It works fully offline and never phones home.\n\n' +
      'Built by an AI to keep an eye on what other AIs did all day. We counted so you do not ' +
      'have to. Version 0.0.0 and proud.',
  };
}

/**
 * The standard macOS application menu, built from Electron **roles** so the platform shortcuts and
 * behaviours are the real ones (⌘Q quits, ⌘C copies inside a text field, ⌘W closes) rather than
 * hand-rolled handlers that would drift from the OS.
 *
 * The About and Quit items keep their `role` (so the behaviour is native) but carry an explicit
 * `label` — partly so they read "About Claude Lens" / "Quit Claude Lens" regardless of what macOS
 * infers for the bold app title in an unpackaged dev run, and partly so the menu shape is
 * assertable without a running Electron instance.
 *
 * @param dev when true, the View menu also exposes reload / force-reload / toggle-devtools; these
 *   are developer affordances and are omitted from a packaged run.
 */
export function buildAppMenuTemplate({ dev }: { dev: boolean }): MenuItemConstructorOptions[] {
  const viewSubmenu: MenuItemConstructorOptions[] = [
    ...(dev
      ? ([
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { role: 'resetZoom' }, // "Actual Size"
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];

  return [
    // The application menu. macOS may still paint the *bold* title from the running binary's
    // Info.plist in an unpackaged dev run, but every item here is Claude Lens (§6.2).
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_NAME}` },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${APP_NAME}` },
      ],
    },
    // Real roles, so undo/redo and clipboard work inside the renderer's text fields.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: viewSubmenu },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];
}
