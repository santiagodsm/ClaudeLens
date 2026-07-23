# Claude Lens

*Where did your Claude Code tokens, time, and money actually go? Look and see.*

## What it is

Claude Lens is a local, offline macOS app that reads your Claude Code history from
`~/.claude` and shows you where your usage really went. It separates what the main loop
cost from what your subagents cost, breaks down spending by project at the prices that were
in effect when you spent it, and draws a map of your harness — skills, agents, plugins, and
memory files. Nothing leaves your machine to do any of it.

It reads your history; it does not change it.

## Requirements

- **macOS** — Apple silicon or Intel. macOS only for now.
- **Node.js 24.** The version is pinned in `.nvmrc`, so if you use `nvm`, a plain `nvm use`
  in the project folder picks the right one up.
- **No Xcode, no compiler, nothing else.** The app uses a native database module, and on the
  pinned versions above that module installs as a **prebuilt binary** — it is downloaded, not
  compiled. This is exactly why the versions are pinned. You do not need Xcode, the Command
  Line Tools, Python, or a C compiler to run Claude Lens.

## Install and run

```
git clone https://github.com/buenos-diaz-inc/ClaudeLens.git
cd ClaudeLens
npm install
npm run dev
```

`npm install` fetches everything and downloads the prebuilt database binaries. `npm run dev`
opens the app.

## First run

On first launch, Claude Lens asks where your Claude data lives. The default is `~/.claude`,
which is almost certainly what you want — press go. It then parses your history; on a large
history the first pass can take a few seconds. After that it watches for changes and updates
live as you keep using Claude Code, so you never have to re-run anything.

## Optional: a Dock icon

If you would rather double-click an icon than open a terminal, build a small
`Claude Lens.app` and drop it in your Dock:

```
npm run build
npm run launcher -- --install
```

Two honest things to know, because both have tripped people up:

- **The app launches Claude Lens from this repo folder.** It is a thin shortcut, not a
  self-contained copy — so keep the project folder where it is. If you move or rename it, run
  the command above again.
- **If the repo lives on an external drive,** macOS may block the app from reading it the
  first time. Grant it once: **System Settings → Privacy & Security → Full Disk Access**, then
  add `Claude Lens` and turn its switch on. (Full Disk Access is the list to use — it has a
  `+` button; the Files and Folders list does not.) Quit the app fully and reopen it afterward.

## Privacy and offline use

Claude Lens is built to run with no network at all, and it does.

- **Nothing phones home.** No telemetry, no analytics, no crash reporting, no update check.
- **Exactly one outbound request exists in the whole app,** and you have to ask for it: an
  optional refresh of the model price table. Everything else — parsing, every chart, every
  number — works fully offline. If you never refresh prices, the app never touches the network.
- **Your data stays on your machine.** The database and logs live in the app's own storage,
  never inside your Claude folder and never in this repo.
- **It reads your Claude files; it does not edit them** — except through a few explicit
  actions you confirm yourself, each of which takes a restore point *before* it changes
  anything, and nothing is ever deleted automatically.

## What it is not

- **No installer and no `.dmg`.** Claude Lens ships as source you clone and run — that is a
  deliberate choice, not a missing feature.
- **macOS only,** for now.
- **Not a transcript reader.** It answers *where the tokens, time, and money went*; it is not
  a viewer for reading your conversations back.

## Contributing / development

```
npm run check      # the full gate: format, lint, types, build, and tests
npm run e2e        # smoke suite that launches the real window (needs a GUI session)
```

`npm run check` is self-contained — it needs `npm install` and nothing else: no service, no
network, no environment setup. It is the one command that says whether a change is good.
`npm run e2e` is separate on purpose, because it needs a built app and a real macOS desktop
session to open a window in.

The product thinking lives in `PRD.md`, the technology choices in `STACK.md`, the build
contract in `DESIGN.md`, and the visual system in `FRONTEND.md`.
