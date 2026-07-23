// Electron main process entry point (STACK ADR-003 — there is no server; this is the backend).
//
// This file is deliberately thin. It owns the four things that genuinely need Electron —
// the window, `app.getPath`, `ipcMain` and the directory dialog — and nothing else. SM-1 lives
// in `src/main/ipc/dataset.ts`, SM-5 in `src/main/watcher/watcher.ts`, the §4.1 wrapper in
// `src/main/ipc/errors.ts`, all three importable and testable without an Electron window
// (STACK ADR-013: every fs/DB-touching test opens with `useSandbox()`).
//
// §7.2 — three processes and one worker thread, no more. `nodeIntegration: false`,
// `contextIsolation: true`, `sandbox: true`. No server, no port, no localhost listener.
//
// ⚠️ §1.6 non-goal 7 / §7.6 / P-18: **no background process survives the window.** The watcher
// is stopped and the database is closed when the last window closes, and nothing schedules
// work while nothing is open.

import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import type { IpcChannel } from '../shared/ipc-contract';
import { APP_NAME } from '../shared/version';
import {
  assertDatabaseOutsideClaudeDir,
  assertE2eStartupSafety,
  databasePath,
  logFilePath,
  pinUserDataDir,
  realHomeDir,
} from './config/paths';
import { aboutPanelOptions, buildAppMenuTemplate } from './menu';
import { ActionService } from './actions/service';
import { openDatabase } from './db/driver';
import type { SqliteDatabase } from './db/sqlite';
import { HarnessService } from './harness/service';
import { Logger } from './log/logger';
import { DatasetService } from './ipc/dataset';
import { createPushEmitters, type PushSender } from './ipc/push';
import { createHandlers, registerIpc, unregisterIpc } from './ipc/register';
import { PricingService } from './pricing';

// ⚠️⚠️ §9.3, §9.4 — app identity, established at module load so it is in force BEFORE
// `app.whenReady()` and, critically, BEFORE `app.setName`. Order is load-bearing:
//
//   1. Pin `userData` to its existing `<appData>/claude-lens` folder. Without this, step 2 would
//      re-derive `userData` to `<appData>/Claude Lens/` — a different, empty folder — silently
//      orphaning the 213 MB database and all USER-class data that has no other source (§9.4,
//      ADR-026). The pin is a no-op under E2E / `--user-data-dir` (ADR-018), so the sandbox wins.
//   2. Only now rename the display name. Menu items and the About panel read it; the database does
//      not, because step 1 nailed the path down independently of the name.
//   3. The native About panel's contents (§6.2), including one on-brand joke — see `./menu`.
pinUserDataDir(app);
app.setName(APP_NAME);
app.setAboutPanelOptions(aboutPanelOptions());

/** Everything the process owns, so shutdown is one function rather than five listeners. */
interface Runtime {
  readonly db: SqliteDatabase;
  readonly logger: Logger;
  readonly dataset: DatasetService;
  readonly channels: readonly IpcChannel[];
}

let runtime: Runtime | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    title: APP_NAME,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      // §7.2 / STACK ADR-003. The renderer reaches the main process only over contextBridge +
      // ipcRenderer.invoke on the typed channel map in src/shared/ipc-contract.ts (INV-16).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The ONE place the window is shown. ⚠️ No push event ever calls this, `focus()`, `moveTop()`
  // or `flashFrame()` — `src/main/ipc/push.ts` is handed a `send` capability and nothing else
  // (§4.9, §6.2, §1.3 moment 2). The app sits in peripheral vision nine hours a day.
  window.on('ready-to-show', () => {
    window.show();
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl !== undefined && devServerUrl !== '') {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

/** §4.9's transport. Deliberately not the window: a sender cannot raise or focus anything. */
function senderFor(window: BrowserWindow): PushSender {
  return {
    isAlive: () => !window.isDestroyed() && !window.webContents.isDestroyed(),
    send: (channel, payload) => {
      window.webContents.send(channel, payload);
    },
  };
}

async function start(): Promise<void> {
  // ⚠️ STACK ADR-018 extension 1, before anything opens a file. Fatal and non-zero: ADR-013's
  // Vitest tripwire cannot cover this process, and this app deletes files.
  try {
    assertE2eStartupSafety({
      claudeDataDir: process.env['CLAUDE_LENS_DATA_DIR'],
      userDataDir: app.getPath('userData'),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
    return;
  }

  // §7.3, §9.3 — one logger, at `app.getPath('logs')/claude-lens.log`. The real home directory
  // is handed to it so redaction can run without a second `os.homedir()` caller (INV-17).
  const logger = new Logger({ filePath: logFilePath(app.getPath('logs')), homeDir: realHomeDir() });

  // §9.3 — the database is `app.getPath('userData')/claude-lens.db` and is NEVER inside the
  // Claude data directory. `assertClaudeDirUsable` below re-checks that against whatever
  // directory the user configures.
  const dbFile = databasePath(app.getPath('userData'));
  const db = openDatabase(dbFile);

  const window = createWindow();

  const dataset = new DatasetService({
    db,
    logger,
    emit: createPushEmitters(senderFor(window)),
    assertClaudeDirUsable: (claudeDir) => {
      assertDatabaseOutsideClaudeDir(dbFile, claudeDir);
    },
    // §4.8 / §5.1 — the trigger the scanner was missing. `harness:scan` is registered and fully
    // implemented, but nothing ever called it, so on a real database `harness_nodes` stayed at 0
    // rows and the Harness Map and Manager rendered empty. This runs it once, AFTER the first
    // metrics sync completes and the dataset is READY / READY_EMPTY, so the map is populated the
    // first time the user opens Graphs without them hunting for a button (§1.3 moment 6) — and
    // never before Overview's first paint (§8.5 P-19). `harness` is initialised just below and is
    // always constructed before this async hook can fire (it fires after `boot()` settles a sync).
    onReady: () => {
      void runFirstReadyHarnessScan();
    },
  });

  const pricing = new PricingService({
    db,
    // §3.13 — read on every call rather than captured, so a settings change takes effect
    // without a relaunch (§5.8 rule 1: only the user starts a fetch).
    settings: () => dataset.settingsSnapshot().priceFetchUrl,
    onPricingChanged: (payload) => {
      createPushEmitters(senderFor(window))['evt:pricingChanged'](payload);
    },
  });
  // §3.11 — the bundled seed is loaded on first run. Local file read, not a fetch (§5.8 rule 1).
  try {
    pricing.seedIfEmpty();
  } catch (cause) {
    logger.error('the bundled price seed could not be applied', {
      detail: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
    });
  }

  const emit = createPushEmitters(senderFor(window));

  // E10 — §4.8. INV-17: both services take the Claude data directory as a parameter, read live
  // from SM-1, and neither resolves it implicitly.
  const harness = new HarnessService({
    db,
    claudeDir: () => dataset.claudeDir(),
    now: Date.now,
    onScanned: ({ at }) => {
      // §4.9 — the two scopes a sync cycle deliberately never claims (`src/main/ipc/dataset.ts`
      // PARSE_SCOPES), because they are written here and nowhere else. This is what makes the
      // Harness Map, Bloat Radar and the four ⛔ INV-13 tables re-query the instant a scan (either
      // the first-ready one below or a manual "Rescan") finishes — and it carries the scan time,
      // which the renderer shows as "last scanned".
      emit['evt:dataChanged']({ at, scopes: ['harness', 'bloat'] });
    },
  });

  /**
   * §4.8 / §5.1 — the first-ready harness scan, fired by SM-1's `onReady` once the first sync has
   * landed. A failed scan is caught and logged; it never blocks the analytics views (§6.9), and
   * the harness views simply keep whatever they had. INV-17: `harness.scan()` resolves `claudeDir`
   * live from SM-1 and reads it read-only (asserted by the harness suite); nothing here writes
   * under `~/.claude` or any project directory.
   */
  async function runFirstReadyHarnessScan(): Promise<void> {
    try {
      const summary = await harness.scan();
      logger.info('the harness map was populated after the first sync', {
        nodes: summary.nodes,
        edges: summary.edges,
        flags: summary.flags,
        projectsResolved: summary.projectsResolved,
        projectsSkipped: summary.projectsSkipped,
      });
    } catch (cause) {
      logger.warn(
        'the first-ready harness scan did not complete; the harness views keep prior data',
        {
          detail: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
        },
      );
    }
  }

  const actions = new ActionService({
    db,
    logger,
    claudeDir: () => dataset.claudeDir(),
    archiveRoot: () => dataset.settingsSnapshot().archiveRoot,
    // ⚠️ §5.6 — the seam SM-1 exposes. Every guarded action is bracketed with these two, so the
    // restore point the action writes into `<claudeDir>` cannot trigger a resync that races the
    // mutation it exists to protect.
    suspendWatcher: () => {
      dataset.suspendWatcher();
    },
    resumeWatcher: () => {
      dataset.resumeWatcher();
    },
    now: Date.now,
    onActionCompleted: (payload) => {
      emit['evt:actionCompleted'](payload);
    },
  });

  const handlers = createHandlers({
    dataset,
    pricing,
    harness,
    actions,
    logger,
    pickDirectory: async () => {
      // ⚠️ STACK ADR-018 — the ONE concession the app makes to automation, and it is narrow.
      // `_electron` cannot drive a native `NSOpenPanel`, so under `CLAUDE_LENS_E2E=1` the picker
      // answers with the injected sandbox directory instead of opening one. Everything after
      // this point is the real flow: real validation, real `settings:set`, real §5.1 transition,
      // real parser. ⚠️ Guarded by the SAME env var that arms `assertE2eStartupSafety()` above,
      // which has already refused to start if that directory is under the real `<home>/.claude`
      // — so this branch cannot hand the app a path the tripwire would have rejected.
      // ⚠️ It grants no capability the dialog does not: the result still goes through
      // `dataset.validate()`, and `settings:set` still refuses anything that does not validate.
      if (process.env['CLAUDE_LENS_E2E'] === '1') {
        return process.env['CLAUDE_LENS_DATA_DIR'] ?? null;
      }
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory', 'createDirectory'],
        message: 'Choose your Claude data directory',
      });
      // §4.3 — cancellation is data, not an error.
      return result.canceled || result.filePaths[0] === undefined ? null : result.filePaths[0];
    },
  });
  const channels = registerIpc(ipcMain, handlers, logger);

  runtime = { db, logger, dataset, channels };

  // §5.1 — migrations, then the `claudeDir` branch. A migration throw goes to FATAL and emits
  // `evt:fatal E_DB_MIGRATION_FAILED`; it purges nothing and rebuilds nothing (ADR-026).
  await dataset.boot();
}

/** §1.6 non-goal 7 — nothing survives the window. Idempotent; called from two listeners. */
async function shutdown(): Promise<void> {
  const current = runtime;
  runtime = null;
  if (current === null) return;
  await current.dataset.shutdown();
  unregisterIpc(ipcMain, current.channels);
  try {
    current.db.close();
  } catch {
    // Closing a database that is already closed is not a failure worth reporting on quit.
  }
}

void app.whenReady().then(async () => {
  // §6.2 — the standard macOS application menu, built from Electron roles so ⌘Q/⌘C/⌘W and
  // text-field editing are the real platform behaviours. Set before the first window shows so the
  // menu bar reads "Claude Lens" from the outset. The View menu exposes dev affordances only in a
  // dev run (same signal `createWindow` uses to pick the dev server).
  const dev =
    process.env['ELECTRON_RENDERER_URL'] !== undefined &&
    process.env['ELECTRON_RENDERER_URL'] !== '';
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate({ dev })));

  await start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void start();
  });
});

// macOS convention: the app stays alive with no windows. ⚠️ §1.6 non-goal 7 — nothing runs in
// the background when the window is closed, so the watcher is stopped and the database closed
// here rather than being left warm for a possible reopen.
app.on('window-all-closed', () => {
  void shutdown().then(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});

app.on('before-quit', () => {
  void shutdown();
});
