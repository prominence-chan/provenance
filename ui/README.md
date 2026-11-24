# Provenance UI

A local, Codex-desktop-style UI for Provenance, as a macOS app or in the browser. It talks to `provenance app-server`
(the same JSON-RPC protocol the official Codex IDE extension / desktop app use) through a
small Node bridge, because browsers can't speak stdio.

```
browser (React, Vite)  <── WebSocket /rpc ──>  server/main.ts + bridge.ts  <── stdio JSON-RPC ──>  provenance app-server  ──>  provenance-core
                       <── /api/* ─────────>  server/app.ts  ──────────────────────────────────────────────────────────────>  (:4141, or the app's own)
```

## Run

```sh
cd ui
npm install          # first time
npm run dev          # http://localhost:5173, opens your browser (NO_OPEN=1 to skip)
```

Or from anywhere: `provenance-ui --web` (symlink in `~/.local/bin` to `scripts/provenance-ui`).
New threads then default to the directory you ran it from. Without `--web` it opens the
desktop app if it's installed (see [App](#app)).

Other scripts:

| command                       | what it does                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run dev`                 | Dev server with HMR + bridge, one process, one port                                           |
| `npm run build` / `npm start` | Type-check + build to `dist/`, then serve it with the bridge (`--prod`)                       |
| `npm run typecheck`           | `tsc -b` for both the app and the server/scripts                                              |
| `npm run gen:protocol`        | Regenerate protocol types from the installed binary                                           |
| `npm run smoke`               | Headless check through the bridge (no browser): new thread, "reply with just ok", resume      |
| `npm run e2e`                 | Headless Chromium (Playwright) drives the real UI; `APPROVAL=1` also tests a command approval |
| `npm run e2e:setup`           | Headless walk through Models & accounts against the mock router (needs `npm run build`)       |
| `npm run e2e:router`          | The same against a **real** provenance-core on its mock chat page, plus a real turn (below)   |
| `npm run mock:router`         | `scripts/mock-router.ts` on :4199, a stand-in for provenance-core's setup API                 |
| `npm run check:fallback`      | Claude Code / Codex fallbacks, server side, against stand-in CLIs (no browser)                |
| `npm run e2e:welcome`         | Welcome, fallbacks, picker, "too large" suggestion, headless (needs `npm run build`)          |
| `npm run e2e:carry`           | One conversation moving between tiers, Claude Code and Codex, headless (needs `npm run build`) |
| `npm run check:orchestrator`  | The two experimental orchestrators, server side, against a stand-in router and app-server     |
| `npm run check:presence`      | Discord Rich Presence against a stand-in Discord socket, plus the page's reports (below)      |

`smoke` and `e2e` expect the server to already be running; `e2e:setup` starts its own UI
server and mock router and needs neither app-server nor model quota. `MODEL=ember` picks a different tier.
`e2e:router` runs provenance-core's `tests/serve_mock.py` (its real server; the web chats pointed
at its mock page; a scratch home; every browser headless, the sign-in window included) from
`ROUTER_SRC` (default `../../provenance-core`) on the Python bundled in `vendor/router` (else
`ROUTER_SRC/.venv`), and walks first run, the browser set-up, a sign-in placed beside the app,
shown, cancelled and then done for real, a pinned web source serving a real turn through
app-server (`PROVENANCE_HOME` in a scratch folder; `TURN=0` skips it), site switches, accounts,
an API key, and the router going away. Nothing shows on screen or reaches a real site.
The free upstream models sometimes return 503; both checks retry.

Requires Node >= 23.6: the server and scripts are `.ts` files run directly by Node
(type stripping), so stick to erasable TypeScript there (no `enum`, no constructor
parameter properties).

Env vars (server): `PORT` (5173), `HOST` (127.0.0.1), `PROVENANCE_BIN`
(`~/.local/bin/provenance`; the desktop app also falls back to its own copy, see
[Which provenance binary](#which-provenance-binary)), `PROVENANCE_UI_CWD` (default cwd, `$HOME` otherwise),
`TIERLM_URL` (`http://127.0.0.1:4141`), `PCORE_TOKEN` (the router's bearer token, if it has one).
The server starts app-server with `TIERLM_BASE_URL=<router>/v1` and `TIERLM_TOKEN`, which its
built-in `tierlm` provider reads (`codex-rs/model-provider-info`), so the agent and the page always
use the same router. (A `model_provider` of your own in `~/.provenance/config.toml` takes its own
`base_url` instead.)

## App

`Provenance.app` is an Electron shell around the same UI. The UI server (`server/app.ts`:
static `dist/`, `/api/*`, the `/rpc` bridge to `provenance app-server`) runs inside the app's
main process on Electron's own Node, so it needs no Node install and doesn't depend on your
shell's PATH. The window loads it from `http://localhost:41730` (a fixed port, so the page's
localStorage, i.e. tier, theme and collapsed projects, survives relaunches; if the port is taken
it falls back to a random one).

```sh
npm run app:build     # dist/ + build-electron/ + vendor/browser/ + vendor/router/ + vendor/agent/ -> release/mac-arm64/Provenance.app + release/Provenance-<v>-arm64.dmg
npm run app:check:router  # the packaged app's own router, with no window (below)
npm run app:check:fresh   # a brand-new user's first run of the packaged app, with no window (below)
npm run app:install   # copy it to /Applications/Provenance.app (quits a running copy first)
npm run app:e2e       # Playwright drives the installed app: window, health, a real "reply with just ok" turn
npm run app:dev       # run Electron from the checkout with Vite + HMR (DevTools in the View menu)
npm run app:start     # run Electron from the checkout on the built dist/
```

`provenance-ui` opens the installed app (`/Applications` or `~/Applications`) with `--cwd
$PWD`; if it's already running, the new instance hands the directory to it and exits (single
instance), and the app starts a new thread there. `provenance-ui --web` keeps the old
browser mode.

What the shell adds:

- **Window:** `hiddenInset` title bar, the traffic lights over the sidebar head (or the main
  header when the sidebar is hidden), both header strips drag the window; min 720 x 480;
  bounds remembered (`window-state.json`). Closing the window keeps the app (and running turns)
  alive; the Dock icon reopens it.
- **Menu:** About, Preferences… (`⌘,`), Models & Accounts…, File → New Thread (`⌘N`) / Open Folder… (`⌘O`), the
  standard Edit menu (copy/paste), View (reload, zoom, full screen; DevTools only when not
  packaged), Window, Help (GitHub, logs, settings file).
- **Folder picker:** the folder icon in the composer's working-directory field opens the
  native folder dialog.
- **Links** open in the default browser.
- **provenance-core, its own** (`electron/router.ts`): on launch the app uses a router that
  already answers at `routerUrl` (yours, e.g. a launchd agent: used as it is, never started,
  restarted or stopped; with `routerLaunchdLabel` set, a loaded agent is waited for up to 20 s).
  Otherwise it runs the copy inside the app (`Contents/Resources/router`, below) on a free
  127.0.0.1 port, home `~/Library/Application Support/Provenance/router`, a random bearer token
  per launch, the web chats on and pointed at the app's own browser, and hands that URL and token
  to the UI server and to `provenance app-server`. It watches it (`/health` every 5 s), restarts
  it with backoff when it exits or stops answering, and stops it on quit; if the app dies, the
  router stops by itself (`serve --watch-stdin`: its stdin is a pipe the app holds) and so do its
  browsers (their own watchdogs). The banner under the header says "Starting Provenance's model
  router…" while it comes up, and which router is down otherwise, with Restart it / Retry; it
  also says when the `provenance` binary is missing. In the browser, the same banner shows
  without the buttons (`GET /api/health`).
- **PATH:** the login shell's PATH (`$SHELL -ilc`) plus `~/.local/bin` and Homebrew, so
  commands the agent runs find your tools.
- **Discord:** Rich Presence, once a Discord application id is set ([below](#discord-rich-presence)).

Files, all in `~/Library/Application Support/Provenance/`:

| file                       | what                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.json`            | overrides (Preferences… opens it; the app offers to relaunch on save)                                                                          |
| `window-state.json`        | window bounds                                                                                                                                  |
| `logs/main.log`            | app + bridge log                                                                                                                               |
| `logs/provenance-core.log` | the app's own router (one older copy kept as `.1` past 5 MB)                                                                                   |
| `router/`                  | the app's own router's home (`PCORE_HOME`): accounts and sign-ins, `settings.json`, `keys.json` (0600), browser profiles, the prepared browser |

`settings.json` keys (defaults): `provenanceBin` (empty: see [Which provenance binary](#which-provenance-binary)), `routerUrl`
(`http://127.0.0.1:4141`: where your own router answers, if you run one), `router` (`auto`: the
router at `routerUrl` if it answers at launch, else the app's own; `external`: only `routerUrl`;
`bundled`: always the app's own), `routerLaunchdLabel` (empty; a launchd agent running your own
router, waited for at launch), `defaultCwd` (empty: last used, else home), `port` (`41730`),
`discordPresence` (`true`: the menu's "Show activity in Discord"), `discordClientId` (empty: the id
in `electron/discord-presence.ts`; both Discord keys apply without a relaunch). The
env vars `PROVENANCE_BIN`, `TIERLM_URL`, `PROVENANCE_ROUTER=auto|external|bundled` and
`PROVENANCE_ROUTER_AUTOSTART=0` (= external) still win; an old `autoStartRouter: false` means
external.

Packaging: `scripts/build-electron.mjs` bundles `electron/main.ts` (with `server/app.ts`,
`bridge.ts` and `ws`) and `electron/preload.ts` with esbuild into `build-electron/*.cjs`, so the
app ships no `node_modules`. electron-builder (`build` in `package.json`) makes an arm64 `.app`
and `.dmg`; `scripts/adhoc-sign.cjs` ad-hoc signs the app before the DMG is made (Apple Silicon
won't run unsigned arm64 code). No Developer ID, no notarization: a downloaded DMG needs
right-click → Open the first time. The icon is `design/icon/Provenance.icns`.

**Bundled router:** `Contents/Resources/router/` is provenance-core with no Python install, venv
or launchd job needed: `python/` is CPython 3.13 from python-build-standalone (a relocatable
CPython, pinned with its sha256 in `scripts/fetch-router.ts`) whose own site-packages hold the
wheels in `scripts/router-requirements.txt` (the versions provenance-core's tests pass with,
wheels only) and `provenance_core` itself as plain files; `catalog.yaml` and `catalog.app.yaml`
(the router's overlay for a new user: one account per site, nothing signed in skipped, OVH needing
a key); `node`, a wrapper that runs patchright's driver on the app's own Electron in Node mode
(`ELECTRON_RUN_AS_NODE`), so the driver's own 117 MB Node isn't shipped; `VERSION.json`. Chosen
over a frozen binary (PyInstaller, Nuitka) because it is CPython as-is: the router stays readable
and patchable `.py` files, its dependencies are the ordinary wheels its tests run with, and
nothing has to be taught about patchright's driver files or lazy imports; a freezer would carry
the same interpreter and libraries, so it would not be smaller. tkinter, idle, the test suite,
pip and headers are removed; everything is compiled ahead (unchecked-hash `.pyc`) and run with
`-I -B`, so nothing is ever written inside the signed bundle. `scripts/fetch-router.ts` (run by
`app:build`, or `npm run router:fetch`) builds `vendor/router/` from `ROUTER_SRC` (default
`../../provenance-core`; it must have `catalog.app.yaml`), downloading the pinned Python once
into `vendor/.cache/` and rebuilding the wheels only when the pins change. It adds ~96 MB to the
app (~33 MB to the DMG).

**Bundled agent:** `Contents/Resources/agent/provenance` is the `provenance` binary itself, so
someone with only the app can run threads. `scripts/fetch-agent.ts` (run by `app:build`, or
`npm run agent:fetch`) copies this checkout's release build (`../codex-rs/target/release/provenance`;
`AGENT_BIN=` another) into `vendor/agent/`, strips it (symbols and line tables: 432 MB -> 285 MB),
ad-hoc signs it again, checks it runs, writes `VERSION.json`, and warns when
`src/protocol/generated` doesn't match the types it generates. Build it first:
`cd codex-rs && cargo build --release -p codex-cli --bin provenance -j 4`.

#### Discord Rich Presence

`electron/discord-presence.ts` speaks Discord's local RPC socket itself (`$TMPDIR/discord-ipc-<n>`,
no dependency). The page sends the main process only `{kind, working, since}` (`src/presence.ts`,
preload `setPresence`): the selected tier or fallback, whether a turn runs, and since when. No
thread title, prompt, path, project, output or account ever reaches Discord. It shows:

| line                | idle                                                                                                     | a turn running                       |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| title               | Provenance (the Discord application's name)                                                              | same                                 |
| details             | `Idle · Solstice`                                                                                        | `Working · Solstice` + elapsed timer |
| state               | `by SkyeNXT · coming soon`                                                                               | same                                 |
| large image (hover) | the app icon (`Provenance · harness by SkyeNXT`; a click opens the repo)                                 | same                                 |
| small image (hover) | the tier's glyph (`Solstice tier · frontier`); Claude Code / Codex: their glyph (`Claude Code fallback`) | same                                 |
| button              | `Provenance on GitHub` (Discord shows buttons to others, not to you)                                     | same                                 |

The tier names are Spark, Ember, Solstice, Nova, Claude Code and Codex; a model that is none of
these shows just `Idle` / `Working` and no small image. The words, the credit, the button and the
image source are one `PRESENCE` block at the top of that file. It connects only when there is
something to show, retries quietly (5 s doubling to 60 s) while Discord isn't running, sends at
most one update per 15 s (the latest wins), clears at once when switched off and on quit, and
does nothing at all without an application id, in headless runs, or in the browser.

Setting it up (the Discord developer portal, once):

1. <https://discord.com/developers/applications> → **New Application** → name it **Provenance**
   (that name is the activity's title) → Create.
2. **General Information** → copy the **Application ID**.
3. Put it in `PRESENCE.clientId` in `electron/discord-presence.ts` (ships with the app), or, for
   this Mac only, in `settings.json` as `"discordClientId": "<id>"` (applies at once).
   Provenance → **Show activity in Discord** appears in the app menu once an id is set.

Nothing needs uploading: the images are https URLs into the public repo
(`ui/design/presence/*.png` on the `provenance` branch, made by `node design/presence/render.ts`),
which Discord fetches itself, so they show once this folder is pushed there. To use uploaded
art instead, upload under **Rich Presence → Art Assets** `provenance.png` as `provenance`,
`tier-spark.png` / `tier-ember.png` / `tier-solstice.png` / `tier-nova.png` as `tier-spark` /
`tier-ember` / `tier-solstice` / `tier-nova`, and `fallback-claude.png` / `fallback-codex.png` as
`fallback-claude` / `fallback-codex`, then set `PRESENCE.imageBase` to `""`.

`npm run check:presence` runs it against a stand-in Discord (a scratch `TMPDIR` with its own
`discord-ipc-0`; the real socket is never touched): handshake, the activity's fields, coalescing,
clearing on switch-off and quit, reconnecting, quiet without a socket or an id; then, with a
build in `dist/`, the page's reports through a stand-in preload during a scripted turn.

#### Which provenance binary

The app runs `provenance app-server` from the first of:

1. `PROVENANCE_BIN` (env), then `provenanceBin` in `settings.json` when set: used as given,
   even if missing (the banner says so);
2. `~/.local/bin/provenance`, when it exists;
3. the binary inside the app, `Contents/Resources/agent/provenance`.

`~/.local/bin` wins over the app's copy because that is where a build of the fork is installed
(`docs/UPSTREAM.md`, "Install the new binary"): someone who builds Provenance gets their own,
newer binary without rebuilding the app, and the app's copy is for everyone else. The choice is
made at launch (main.log: `launch … bin=<path> (<which>)`). Its config home is the binary's own
default, `~/.provenance` (`PROVENANCE_HOME` overrides it), which it creates on first start; the
app hands it the router's URL and token (`TIERLM_BASE_URL`, `TIERLM_TOKEN`), so a new user needs
no `config.toml`. An empty or old-default (`~/.local/bin/provenance`) `provenanceBin` means
"automatic". The app's protocol types (`src/protocol/generated`) are generated from the
bundled binary; a different `~/.local/bin/provenance` may speak a slightly newer or older
protocol.

**Bundled browser:** the app carries the Chrome for Testing build provenance-core drives for the
chat sites, unmodified, at `Contents/Resources/browser/Google Chrome for Testing.app`
(`extraResources` from `vendor/browser/`, git-ignored). provenance-core looks there first and
makes its own background-only copy on first use, so nothing is downloaded before the first
sign-in. `scripts/fetch-browser.ts` (run by `app:build`, or `npm run browser:fetch`) fills
`vendor/browser/` with the pinned version (`VERSION` in the script, 157.0.8103.78): copied
from `~/.tierlm/browser/<v>/plain/` when provenance-core already has it, else downloaded from
Google's bucket (~197 MB, md5-checked; `BROWSER_SOURCE=download` forces that). It adds ~400 MB
to the app (~175 MB to the DMG). The browser keeps its own (linker) signature and the app's
ad-hoc pass still passes `codesign --verify --deep --strict`. Bump `VERSION` when the installed
Chrome's major version passes it: provenance-core only uses a build at least that new.

The web UI only knows it's in the app through `window.provenanceApp` (`src/app-shell.ts`,
from the preload), which sets `html[data-shell="darwin"]` for the window-chrome styles.

**Checking the packaged app without a window:** `PROVENANCE_HEADLESS=1` opens no window and no
Dock icon and prints one `PROVENANCE_READY {ui, router, mode, routerPid}` line once serving;
`PROVENANCE_USER_DATA=<dir>` keeps settings, logs and the router's home there (and with them the
single-instance lock), so a check never meets the installed app. `npm run app:check:fresh` runs the
packaged app as a brand-new user: `HOME` an empty scratch folder (no `~/.provenance`, no
`~/.local/bin/provenance`), no `PROVENANCE_*` / `TIERLM_*` / `PCORE_*` env, and a `routerUrl` where
nothing answers; it checks the app picked its own binary, its own router (port, pid, not the
launchd one), app-server's binary, environment and new config home, the Models & accounts
dialog in headless Chromium, one turn (`TURN_MODEL`, default `spark`, served by whatever the fresh
router can reach without a key or sign-in; `TURN=0` skips it), and that quitting ends both. `npm run app:check:router`
(`APP=` another .app) uses both, with app-server's state in a scratch `PROVENANCE_HOME`: an
answering router at `routerUrl` is used and nothing starts; otherwise the bundled router answers
on its own port and pid (checked with `lsof` against the launchd router's), wants its token,
lists the sites and tiers, prepares the browser from `Contents/Resources/browser`, is restarted
when killed, and is gone after quit; a second launch is killed outright and its router stops by
itself. `node scripts/first-run-tour.ts` screenshots a new user's first launch (the app's
supervisor on `vendor/router` with a fresh home, headless Chromium).

## Layout

```
ui/
├── server/
│   ├── app.ts         startUiServer(): Vite middleware (dev) or dist/ (prod), /api/info, /api/tiers,
│   │                  /api/sources, /api/health, /api/usage, /api/web/*, /api/pool/*, WS /rpc
│   ├── main.ts        CLI for `npm run dev` / `npm start`
│   └── bridge.ts      AppServerBridge: spawns `provenance app-server` (router URL in its env), relays JSON-RPC
├── shared/
│   └── router-api.ts  provenance-core's wire shapes + the proxy's route table, shared by all of the above
├── electron/
│   ├── main.ts        desktop app: window, menu, settings, runs startUiServer(), test switches
│   ├── router.ts      RouterSupervisor: an answering router, else the bundled one (start, watch, stop)
│   ├── discord-presence.ts  Discord Rich Presence over Discord's local socket (coarse state only)
│   └── preload.ts     window.provenanceApp (folder picker, start router, preferences, menu events)
├── scripts/
│   ├── gen-protocol.ts  runs `provenance app-server generate-ts --experimental`
│   ├── smoke.ts / e2e.ts / app-e2e.ts, chromium.ts (which Chromium they run)
│   ├── setup-e2e.ts / router-e2e.ts, e2e-kit.ts   Models & accounts on the mock / a real router
│   ├── mock-router.ts   stand-in for provenance-core's setup API (dev + setup-e2e)
│   ├── app-router-check.ts, first-run-tour.ts   the packaged app's router, headless; first-run screenshots
│   ├── app-fresh-check.ts   a brand-new user's packaged app, headless (bundled binary + router, a turn)
│   ├── build-electron.mjs, fetch-browser.ts, fetch-router.ts (+ router-requirements.txt), fetch-agent.ts,
│   │   adhoc-sign.cjs, install-app.mjs   app packaging
│   └── provenance-ui    launcher (symlinked into ~/.local/bin)
└── src/
    ├── protocol/
    │   ├── generated/   GENERATED: TypeScript bindings for the whole app-server protocol
    │   └── index.ts     re-exports + ParamsOf<method> / ResultOf<method> helpers
    ├── rpc/client.ts    typed JSON-RPC client over the WebSocket
    ├── store/
    │   ├── store.ts     tiny external store + useAppState(selector) hook
    │   ├── state.ts     AppState / ThreadView / TurnView shapes, settings persistence
    │   ├── reducer.ts   applyNotification(): app-server notifications -> state (pure)
    │   └── actions.ts   everything that sends requests (threads, turns, approvals, interrupt)
    ├── setup/           Models & accounts: SetupDialog.tsx, SiteSteps / SignInSteps / KeysStep.tsx,
    │                    parts.tsx, SetupArt.tsx (step pictures), web.ts (the API client), open.ts
    ├── components/
    │   ├── Sidebar.tsx        threads grouped by project (cwd), search, new thread, archive, status
    │   ├── ThreadHeader.tsx   slim bar: sidebar toggle (when hidden), title, cwd, tier, context ring
    │   ├── Conversation.tsx   centered transcript; turns -> items; auto-scroll
    │   ├── items/             one renderer per ThreadItem type (ItemView.tsx dispatches); tool
    │   │                      items render as one-line rows, consecutive ones grouped (ToolGroup.tsx
    │   │                      folds a finished turn's run into one summary line)
    │   ├── TurnModels.tsx     the turn footer's served-model line and its breakdown dialog
    │   ├── Approvals.tsx      command / file-change approval cards
    │   ├── Composer.tsx       prompt box, tier picker, permissions preset, cwd, send/stop
    │   ├── Markdown.tsx, DiffView.tsx, Notices.tsx, HealthBanner.tsx, icons.tsx, format.ts
    ├── components/effects/  FlameFx.tsx (WebGL2 tier effects), useFx.ts
    ├── components/TierPicker.tsx, TierBadge.tsx, SolarMark.tsx
    ├── theme/           tokens.css, effects.css, tiers.ts, theme.ts, ui.ts (see "Theme" below)
    ├── App.tsx, main.tsx
    └── styles.css       layout + components; only references theme tokens
```

## Where the protocol types come from

`src/protocol/generated/` is produced by the binary itself:

```sh
npm run gen:protocol    # = provenance app-server generate-ts --experimental --out src/protocol/generated
```

The binary generates the files with ts-rs from the Rust structs in
`codex-rs/app-server-protocol` (`src/protocol/v2.rs` and friends). Re-run it after
rebuilding Provenance with protocol changes, then `npm run typecheck`: anything that
drifted shows up as a type error. The files are committed so the UI builds even when
the binary is missing. Don't edit them by hand.

ts-rs doesn't emit a method-to-response mapping, so `src/protocol/index.ts` keeps a small
hand-written `ResponseMap` for the requests the UI sends. Add an entry when you call a new
method, and `rpc.request("that/method", params)` becomes fully typed.

The human docs for the protocol are in `codex-rs/app-server/README.md`.

## How a conversation flows

1. **Connect.** The bridge starts one `provenance app-server`, does the `initialize`
   handshake, and announces `bridge/status {state: "ready"}`. The browser then sends its
   own `initialize` (the bridge answers it from cache) and calls `thread/list`.
2. **New thread.** The "New thread" screen is just `selectedThreadId = null`. The first
   send calls `thread/start {model, cwd, approvalPolicy, sandbox}`, then
   `turn/start {threadId, input, model, ...}`.
3. **Streaming.** app-server sends `turn/started`, `item/started`, deltas
   (`item/agentMessage/delta`, `item/reasoning/*Delta`, `item/commandExecution/outputDelta`,
   ...), `item/completed`, `thread/tokenUsage/updated`, `turn/completed`.
   `store/reducer.ts` folds each one into `views[threadId].turns[].items[]`.
4. **Approvals.** app-server sends a _request_ (`item/commandExecution/requestApproval`,
   `item/fileChange/requestApproval`) and blocks the turn until the client replies
   `{decision: "accept" | "acceptForSession" | "decline" | "cancel"}`. These land in
   `state.serverRequests` and show up as cards under the transcript.
5. **Resume.** Clicking a past thread calls `thread/resume {excludeTurns: true}`, which
   subscribes this connection to the thread's events, then
   `thread/turns/list {sortDirection: "desc", itemsView: "full"}` for the history.
6. **Interrupt.** `turn/interrupt {threadId, turnId}` for the in-progress turn.

The bridge shares one app-server across all tabs: request ids are rewritten per client,
notifications go to everyone, and unanswered approvals are replayed to newly opened tabs.
A page reload therefore doesn't kill a running turn. If the binary disappears (e.g. while
a rebuild replaces it) or app-server exits, the bridge retries with backoff. The UI shows
the state bottom-left and re-attaches to the open thread once app-server is back.

## Models & accounts

Signing in to the chat sites provenance-core drives (ChatGPT, Qwen, Gemini) happens in the app,
in one dialog (`src/setup/`): **Site → Account → Sign in → Ready**, on a step rail that never
moves. Ways in: the people icon in the sidebar foot, the tier picker's last row, the app menu,
and the welcome (below), whose rows open it on a site and return to the welcome when it closes.

- **Site:** each site with the models it gives and the tier they land in, and one status
  line (Ready, Ready on N accounts, Signing in…, Paused, Off, Not signed in); sites without
  models are left out. Below them, the **Token pool** row, and a note saying which router the
  app uses (Provenance's own, or yours at host:port, with its pid).
- **Account:** the site's own switches first: **Use <site>** (on / off) and its **daily limit**
  (chats per account per day), kept by the router (`PATCH /web/providers/{id}`; PCORE_CHATGPT_WEB=0
  on the router locks the switch). Then per account (one browser profile, shared by every site):
  signed in or not, as whom (the e-mail the site showed), when last checked, chats today against
  the limit, why it is paused; one primary Sign in; add another account (next free letter id),
  remove one (from all sites). A model limited to some accounts says which ("only on Account B").
- **Sign in:** provenance-core opens one visible browser window beside the app (the page sends
  `bounds` worked out from its own window and screen) on the site's sign-in page; the dialog says
  so, offers **Show the window** (`POST /web/login/show`) and polls `GET /web/login` once a second
  through preparing (the browser being set up: its stage and download progress) → open →
  verifying → signed_in, or failed with the router's reason and Try again. The router closes the
  window itself. Cancel, Back or closing the dialog mid sign-in cancels it. A 409 (another
  sign-in open) shows its detail under the account.
- **Ready:** signed in as whom, the models now in the tier picker (sources are re-read), Done.
- **Token pool:** each API provider: works (with a key set here or by the router's own setup,
  or without one), needs a key, its models and tiers; Add key / Change opens password fields for
  its variables, Save sends them to the router (`PUT /pool/keys/{id}`), which keeps them in its
  home readable by you only and never sends them back; Remove key (`DELETE`).
- Browser not ready: a strip with Set it up and its stage and progress (`POST /web/browser/prepare`).
  Router down: a page state with Start it (app) / Try again. A router without `/web/*`: a page
  state asking to update it.

Code: `SetupDialog.tsx` (the dialog, its steps and polling), `SiteSteps.tsx` (Site, Account,
the site switches), `SignInSteps.tsx` (Sign in, Ready), `KeysStep.tsx` (Token pool), `parts.tsx`
(status lines, the browser strip, page states, icons), `web.ts` (the API client), `open.ts` (open
state, first run). The router's wire shapes live once, in `shared/router-api.ts`, for the page,
the UI server, the desktop shell and the mock router.

The UI server proxies `/api/web/<route>` and `/api/pool/<route>` to provenance-core (only the
routes in `ROUTER_ROUTES`; writes need our own Origin and a JSON body; bodies are never logged)
with the router's status and body as-is. `scripts/mock-router.ts` implements the same API with
its state transitions (`MOCK_SCENARIO=fresh|signed|nobrowser`, `MOCK_AUTO=1` finishes a sign-in
by itself after 4 s): `npm run mock:router`, then `TIERLM_URL=http://127.0.0.1:4199 npm run dev`.

## Welcome and fallbacks

**Welcome** (`src/fallback/WelcomeDialog.tsx`): Welcome → Models → Fallbacks → Done, on the same
rail and panel as Models & accounts. It opens by itself once, when nothing is set up: no site
signed in, no API key in the token pool, no fallback on (`setup/open.ts` `maybeOpenWelcome`;
closing or finishing it is remembered, localStorage `provenance-ui.welcome-done`). Provenance >
Welcome… opens it again. Models lists the sites and the token pool with their status; each row
opens Models & accounts there. Fallbacks is the page below. Done sums up what is ready.

**Fallbacks** (Models & accounts > Fallbacks, the welcome, `src/fallback/FallbacksStep.tsx`):
Claude Code and Codex for threads the free models can't carry. Each row checks the CLI (found on
PATH or in the usual install folders, `--version`, `claude auth status --json` / `codex login
status`; nothing spends usage, no e-mail is passed on) and shows Ready, Not installed (with the
one-line install command) or Not signed in (with the command to run), and a switch. Codex has
two modes:

- **Run Codex through Provenance:** the provenance binary runs the turn, as any thread here
  (approvals, live edits, interrupt), on your Codex ChatGPT sign-in, with its model requests going
  through provenance-core's pass-through to OpenAI, so the router's history pruning applies. A
  second `provenance app-server` on its own home (`<data>/codex-home`) whose `auth.json` and
  `auth.lock` are symlinks to Codex's (`$CODEX_HOME` or `~/.codex`): the fork's credential store
  reads through the link and writes a refresh to its target, and both lock the same file, so the
  two share one login and no token is copied or read by the app (`server/fallback/codex-home.ts`).
  It starts with (`server/fallback/codex-route.ts`)

  ```
  -c model_provider="openai"
  -c openai_base_url="<router>/codex-sub/<key>/backend-api/codex"
  -c features.enable_request_compression=false
  ```

  The binary keeps doing its own auth (its Authorization and account headers go through the
  router untouched, never stored or logged); `<key>` is derived from the router's token (a hash:
  it opens only the pass-through and never gives the token away; `open` for a router without
  one), and masked in what app-server prints. The router forwards to
  `https://chatgpt.com/backend-api/codex/…` and prunes old tool output in the request in its
  stable mode, so OpenAI's prompt cache keeps hitting (provenance-core `docs/TECHNICAL.md`,
  "Codex on your own sign-in"); Codex's own compaction handles overflow. A finished turn's footer
  says how much smaller its history went out ("history 31% smaller", from the router's usage
  ledger). If the router or its pass-through isn't there, the mode is not ready and says why
  ("Provenance's router isn't running"); it never goes to OpenAI directly. No Rust change. Its
  models are the binary's own catalog for that provider.

- **Codex in the background:** the stock `codex` CLI runs each turn (`codex exec --json`, then
  `codex exec resume <id>`), like Claude Code below.

Claude Code and Codex-in-the-background threads are run by `server/fallback/backend.ts`: one CLI
process per turn in the thread's folder, prompt on stdin (`claude -p --output-format stream-json
--verbose --include-partial-messages [--model m] [--resume <session>]`), its output turned into
app-server's own items (messages streaming, commands, edits with a diff, tool calls, thinking:
`claude-stream.ts`, `codex-stream.ts`) and served on WebSocket `/rpc/fallback` with app-server's
methods and notifications, so the thread view renders them unchanged. Permissions follow the
composer: Read only → `--permission-mode dontAsk` / `-s read-only`; Auto → `acceptEdits` /
`workspace-write`; Full access → `--dangerously-skip-permissions` / `danger-full-access`;
"Ask every time" runs like Auto, without asking: the CLIs can't ask the page, so the composer
(under the bar) and the Fallbacks page say so; what the CLI itself still declines shows as a
failed row. Threads are JSON files in `<data>/fallback/threads`
(`<data>` = the app's Application Support folder, or `~/.provenance-ui` / `PROVENANCE_UI_DATA`
for `npm run dev`).

**Model picker:** a Fallbacks section below the tiers. A ready fallback opens a side list of
the models its CLI offers on hover (Claude Code: Default plus the aliases its `--help` names and
`server/fallback/known-models.ts`, the one hand-kept list; Codex: `codex debug models`, or the
provenance binary's catalog through Provenance), and for Codex the two modes. Off or not ready:
a muted row that opens the Fallbacks page. The model key says where a thread runs:
`solstice` / `luna/solstice` (tiers, `/rpc`), `claude:<m>` and `codex:<m>` (`/rpc/fallback`),
`codex-pv:<m>` (`/rpc/codex`); the store keeps all three backends' threads in one list. A thread
stays on its backend: opening one points the picker at its model.

**Moving a conversation** (`shared/thread-links.ts`, `store/segments.ts`, `actions.ts`
`handOver`): sending with another backend picked moves the conversation there and it stays one
thread: same sidebar entry and title, the earlier turns where they were. Behind it each backend
that served it has its own session ("segment"): a new thread on the target, linked to the
conversation in `<data>/thread-links.json` (`GET /api/links`, `PUT`/`DELETE /api/links/<id>`), its
model handed a brief of everything so far (`fallback/brief.ts`: the goal, requests since, what the
agent reported, files, commands, the plan, where it stands, the latest request verbatim; 16,000
characters at most). The brief never shows and is never stored as an item: Claude Code, Codex in
the background and the orchestrators get it in turn/start's `additionalContext` (the CLI reads it
on stdin before the message, once, until it has a session), an app-server (Codex through
Provenance, or back on the tiers) in thread/start's `developerInstructions`. The page lists one
entry per conversation, shows a later session's events in it, sends each message to the latest
session, and stitches all sessions' turns into one view; one faint line marks where it moved
("Continued in Claude Code from the conversation above"). Back on a tier is a new tier session
(the old one is the history that outgrew the free models, and it would need the brief as a visible
message). A turn still running is stopped first. Archive archives every session; a rename names
the conversation's own thread. Threads carried over before this (two threads, the brief as the new
one's first message) show only what the person wrote, under "This was continued from another
conversation", titled "… (continued)".

**"Too large" suggestion** (`fallback/strain.ts`, `StrainNote.tsx`): under a tier thread, when
its history has outgrown the free models. Per finished turn: provenance-core's context flags
(`/api/usage` → `context`: `over` 3, `trimmed` 2, `restarted` 2; `compacted` alone is normal and
counts 0), a context-window error 3, app-server compacting twice in the turn 2 (once 1), the same
command with the same result 3+ times 2. Shown when the last three turns add to 4+ with the latest
at 2+, or one of the last two at 3. One line, a button per ready fallback (the conversation moves there
and the model carries on with the work, no message of the person's), or "Set up Codex or Claude
Code…"; dismissed, it comes back for that thread only
when the score rises by 4.

Checks: `npm run check:fallback` (server side against stand-in CLIs), `npm run e2e:welcome` (the
page end to end, stand-in claude / codex / provenance; needs `npm run build`), `npm run e2e:carry`
(a conversation moved tier → Claude Code → restart → tier → Codex mid-turn → archive, and the brief
nowhere in the page, the store or the thread files),
`node scripts/fallback-real-check.ts` (one tiny real turn each through the real CLIs and your
Codex sign-in; spends a little usage).

## Orchestrators

Who drives a thread on the tiers (`shared/orchestrator-api.ts`; the composer's choice,
`settings.orchestrator`). **Provenance** is the stock harness on `/rpc`. The other two live in
`server/orchestrator/` and are served on WebSocket `/rpc/orchestrator` with app-server's methods
and notifications, like `/rpc/fallback`; their thread ids start with `orc-`, `thread/start` takes
the choice in `config.orchestrator`, and a thread keeps the one it was started with. Threads are
JSON files in `<data>/orchestrator/threads`. Both use a third `provenance app-server`
(`appserver.ts`: same binary, home and router as the main one, started on first use, run in an
empty folder) that only the backend talks to, and call the router directly for plain model calls
(`router.ts`: `POST /v1/responses`, one user message, streamed, not stored, a session key per
call, so each lands in a new chat). Every prompt is in `prompts.ts`; a plain call is held to 8,000
characters, Hyperexperimental's think call to 12,000 (it carries the working memory), a worker's
brief to 4,800, and every role's instructions to under 3,000.

- **Experimental** (`experimental.ts`): a planner call decides between one worker for the whole
  job (`ONE`, the normal case, and the outcome for any request that fits a brief unless the
  planner says why the job is `LARGE`) and a short list of tasks in plain text (`parse.ts` reads
  it leniently). A worker is a fresh ephemeral thread of the stock harness with the thread's
  sandbox and approval preset, given a brief; its commands, edits and approval requests show in
  the visible thread; its last message is its report. The notes (`notes.ts`, at most 2,400
  characters, oldest folded first) are the only thing carried between tasks and turns: files and
  commands as recorded, one line per task as reported, and the tasks still to do (so "continue"
  after a turn that ended early runs what was left, without planning again). A blocked task, or
  a worker that used up its own budget (24 requests and 10 minutes for a task, half as much
  again for an unsplit job, and never more than the turn has left), sends the remaining list
  back to the planner. Three things do not: an approval that is declined (recorded once, the
  task run once more without that command, then the job goes on and the reply names the
  command); a last task that made the work and reports only that something cannot be run or
  installed here (a missing tool, no network: the reply says "not verified"); and a plan that
  was already revised and whose tasks since changed nothing. A planner reply that declines ("I
  can't run commands…") is asked for once more.
  **A worker's context has a budget** (`Caps.workerContextTokens`, 11,000 input tokens in one
  request as the router reports them, `PROVENANCE_ORC_WORKER_TOKENS`; the web chat behind the
  bridge takes about 15,000): a worker whose requests reach it is stopped and asked, on the same
  thread, for a hand-over (what is done, what is left, what it learned), and a fresh worker goes
  on with the same task from that and the notes. No planner call is spent on it; only a context
  that fills up twice with nothing changed, or more than four times in a turn, sends what is
  left to the planner to split. So a job that starts as one worker and grows is carried by
  hand-overs, not by the harness's own compaction.
- **Hyperexperimental** (`hyper.ts`, `memory.ts`, `exec.ts`): no tool calls. Per step one new
  chat (think) that says what to do next in plain text: commands in ` ```bash ` blocks, a file
  once and whole in a ` ```file:<path> ` block, looks and small changes as `READ:` / `LIST:` /
  `SEARCH:` / `REPLACE:` lines, several actions a step when they do not depend on each other.
  The blocks are lifted out verbatim; when the reply holds nothing else that could be an
  instruction the actions are read straight from it, and only a reply that says what to do in
  prose goes to a second chat (translate; nine in ten did not need it in the benchmark). Actions
  run through app-server's `command/exec` under the thread's sandbox as an explicit policy (reads
  always read-only; "Ask every time" shows each command and file change for approval first), in
  order, stopped at the first that fails. Before one runs, code checks it: paths are relative to
  the thread's folder, a file the request names in a subfolder is written there even when the
  step gave its bare name, a write (or a listing, a search) outside the folder that the request
  does not name is refused with the reason, a leading `cd <the folder>` is dropped (every
  command starts there), and an action that repeats an earlier one with nothing changed since
  is answered from memory instead of being run. **The memory is kept by code**, not by a model
  summarizing each step: a log (one line per step: what was meant, each action and how it
  ended), facts the think step asks to keep (`KEEP:` lines, as written), the one or two files
  being worked on pinned and re-read from disk before every think (with line numbers; a third
  file replaces the oldest), and long outputs shown once as their first and last lines with the
  whole saved to a temp file whose path and line range the result names. All of it is bounded
  (3,000 characters of memory, the pins and results in what the think budget leaves); when the
  log outgrows its share its oldest half is folded into a digest by one model call (the only
  "summarize" left). **There is no fixed number of steps**: a turn goes on while it advances,
  until its model calls or minutes are spent (40 steps is a backstop); after three steps that
  only look the next must change or run something or say `BLOCKED:`, and five steps in a row
  that change no file and run nothing new end the turn with what it has. A `RUN` sees the
  environment the harness's shell tool gives a command (the login shell plus the rc file,
  captured once, then a non-login shell), not a bare `zsh -lc`.
  *What it is for:* every request stays small however long the job runs, and nothing depends on
  the model calling tools, so it can drive a chat model that only answers in prose. That is
  all it has over Experimental so far: in the second benchmark round (Luna, ten tasks) it
  finished 4 against Experimental's 8, at 2.7 times the calls, and nothing measured yet shows it
  ahead on any task. The redesign above cuts its calls to about a third (offline: 8 → 5 for a
  three-step job, 38 → 15 for a twelve-step one; a small real job: 12 → 4); whether that turns
  into finished tasks is for the next round to show.

Both carry **the request word for word** (`request.ts`): every worker brief and every think
prompt quotes the person's own text (whole when it fits; otherwise the pieces a task needs, which
the planner names by number, with the gaps marked and the path of a temp file that holds all of
it), together with a "must match exactly" list that code copies out of the request: paths, file
names, quoted strings, flags, calls, numbers with their units. No model restates them on the way.

Both end a turn that changed something with **a finish check** (`finish.ts`). By code, always:
every file the request names as output exists under exactly that name and place (a file of
nearly that name is reported as a near miss), nothing was written outside the folder to a path
the request does not name, and the last recorded check (a command that was more than a look)
did not fail. A reviewer (one plain call) is asked only when it can add something: the job was
split among workers, the work itself names something as not checked, or no recorded command ran
the result. A job one worker did whole, ran, and reports nothing unchecked about gets none. The
reviewer is given the evidence (the files with excerpts, every command with its exit code and
the end of its output, what code settled) and names at most three things the evidence does not
show, each with one command that settles it; a placeholder in an example is not a requirement.
Those commands are run by code under the thread's sandbox and approval preset (one that would
delete, install or write outside the folder is not run), so a check that passes costs no model
call. Only a check that fails, or what code found, buys a fix: one bounded task (Experimental;
written by code from the failing command and its output, not replanned) or up to four more
steps (Hyperexperimental), after which the failing commands are run again by code. With too
little budget left no fix is started. The reply states first what code found, then which checks
passed, which failed and which could not be run ("not verified"). The briefs and the think
prompt carry three rules of checking: run the result the way the request says it will be used,
each failure case it names for real (an interrupt as a real SIGINT while work is queued), with
test inputs that vary what the request leaves open; copy an input before a tool that may change
it opens it; hold the result to every size, count or shape the request states. A worker is also
told to stay in its folder: not to search the machine for tools, to try what is there, and to
report `cannot execute: <tool> missing` rather than hunt.

Loop guards are `Caps` in `backend.ts` (tasks, tries per task, plan revisions, hand-overs, model
calls and minutes per turn, requests, minutes and context per worker; steps without progress and
look-only steps for Hyperexperimental); one that stops the work ends the turn with a plain
message and where things stand. Experimental spends by what the turn has left (a reserve is kept
for the finish check): a worker gets no more than is left, a revision is made only when it and
one more task still fit, and otherwise the turn stops with what it has and says what is not
done. A model call the router can't serve (429, 5xx, no answer, a timeout, an empty reply) is
retried inside the turn after 5, 20, 60 and 120 s (`PROVENANCE_ORC_RETRY_S`), with a status line
in the thread; a worker whose own request failed is run again on the same schedule; interrupt ends
a wait at once. Only then does the turn fail with the router's message, and what was done stays
in the notes / memory for "continue". Guards read the monotonic clock (`clock.ts`).
`npm run check:orchestrator` checks all of it against a stand-in router and app-server, long
jobs included (a twelve-step Hyperexperimental job with long outputs and a worker whose context
fills up three times: the largest prompt of every role and the largest request of every worker
stay within budget for the whole run); `node scripts/orchestrator-real-check.ts sandbox` runs the
execute step against the real binary's sandbox (no model), and `… experimental | hyperexperimental
| stock [model]` one small real job each (they spend the free allowance).

## Tool runs and model attribution

- **Folded tool runs:** while a turn runs, every tool row shows live. Once it finishes (and for
  history), each run of consecutive tool items folds into one line, "Ran 6 commands, edited 3
  files, read 2 files" (+ failures and the run's diffstat on the right); it opens back to the
  rows, which open to output / diffs. Thinking stays in the rows but isn't counted; a run of one
  row, or of thinking only, isn't folded (`items/ToolGroup.tsx`).
- **Which models served a turn:** the footer shows, after the tier badge, the concrete models
  provenance-core routed the turn's requests to, short names (`kilo/nvidia/nemotron-3-ultra-550b-a55b:free`
  -> `nemotron-3-ultra`, `components/modelName.ts`), most requests first, on one line. Names that
  don't fit become "…"; with more than one model the line opens a dialog with each model's
  requests and tokens and their share. Data: provenance-core's usage ledger
  (`GET /v1/pcore/usage`, `provenance_core/ledger.py`) records every Responses request under
  Codex's `client_metadata.thread_id` + `turn_id`; the UI asks `/api/usage?key=<thread id>&turn=<turn
id>&since&until` once a turn completes (and for history turns as they render). A turn the ledger
  doesn't know (from before it existed) shows no models.

## Extending

- **New item type:** add `components/items/Foo.tsx` and a `case` in `items/ItemView.tsx`.
  Unknown types fall back to `GenericItem` (title + JSON).
- **New notification:** add a `case` in `store/reducer.ts`. The switch is typed off the
  generated `ServerNotification` union, so `n.params` is typed for you.
- **New server request** (e.g. `item/tool/requestUserInput`): handle it in
  `components/Approvals.tsx` and reply with `rpc.respond(req.id, result)`. Unsupported ones
  currently render a card that replies with a JSON-RPC error.
- **Tiers:** the picker lists tierlm's own models (`/v1/models` where `owned_by ==
"tierlm"`), falling back to `nova / solstice / ember / spark` (`server/main.ts`). Default
  is `solstice`.
- **Sources:** hovering or arrowing onto a tier opens its source submenu, from
  provenance-core's `GET /v1/sources` (via `/api/sources`, re-read each time the picker opens,
  never polled): **Auto** sends the plain tier (`solstice`, the router picks), a source sends
  its `model` (`luna/solstice`, that source pinned), with the share of today's usage it has
  left and, when non-zero, how many requests it is serving. Sources that need something first
  (`needs`: API keys, a sign-in) are listed after them with "Add API keys…" / "Sign in…" and open
  Models & accounts there; other sources with `pinnable: false` are left out (Auto can still use
  them); unavailable ones show greyed out. A pinned source's
  label follows the tier name in the picker button and the tier badges ("solstice · GPT-6
  Luna"). Router down or without `/v1/sources`: no submenu, plain tiers as before. Keys:
  ↑/↓ tiers, → into the submenu, ← back, Enter picks (Enter on a tier row = Auto).

## Theme

The look is "solar prominence": near-black warm backgrounds, soft off-white text, plasma
accents (ember orange, crimson, a pink-magenta highlight) used sparingly. The layout is
compact in the spirit of the Claude Code and Codex desktop apps: 28 px sidebar rows,
a 40 px header, 13.5 px body text, tool calls as one-line rows that open on click.

- **Tokens:** `src/theme/tokens.css` is the single place to tweak it: surfaces, text, accents
  (`--ember`, `--crimson`, `--magenta`, `--corona`), status and diff colors, fonts
  (`--font-ui`, `--font-mono`), the type scale (`--fs-*`), radii, motion, layout sizes
  (`--sidebar-width`, `--header-height`, `--content-width`), per-tier colors
  (`--tier-<id>`, `--tier-<id>-grad`) and the flame ramps (`--fx-<tier>-deep/mid/hot/core`).
  `[data-theme="light"]` in the same file overrides them for light mode (sun/moon toggle
  bottom-left, stored in localStorage `provenance-ui.theme`). `styles.css` uses only these
  variables.
- **Sidebar:** threads are grouped by working directory, most recent project first; a
  project's header collapses it (remembered). `⌘B` / `Ctrl+B` or the panel button hides the
  sidebar (remembered). Below 860 px it becomes a drawer that starts closed and closes after
  you pick a thread. The state lives in `src/theme/ui.ts`.
- **Tiers:** `src/theme/tiers.ts` holds the order (spark < ember < solstice < nova) and the
  blurbs and effort words (Low / Medium / High / Max) shown in the picker. Any element with
  `data-tier="..."` gets `--tier-color` / `--tier-grad` for its subtree. `TierBadge` appears
  on the "Working…" line and in each turn's footer; `TierPicker` is the composer dropdown.
- **Small secondary text** (tier blurbs, effort, source usage, the header's context use) uses
  the one `.meta` class in `styles.css`: `--fs-xs`, weight 400, `--muted`, sentence case, no
  letter-spacing. Reuse it rather than styling such text per component.
- **Effects** (always on for the selected tier), all in one WebGL2 canvas behind the main
  column, `src/components/effects/FlameFx.tsx`. Three states, eased into each other: a
  **flare** when the tier changes (and on first load), an almost-still **idle**, and an
  **active** state while a turn streams (above idle, well below the flare). Intensity climbs
  with the tier, spark subtlest, nova strongest. Each tier has its own style and ramp
  (`--fx-<tier>-deep/mid/hot/core`):
  - spark: electric (blue arc, ice-white, white-gold cores); tiny sparks fizzle in and out at
    random spots just outside the edge, drift and crackle; on switch a scatter of them with
    short arcs jumping between neighbours; idle is a lone spark every few seconds;
  - ember: a small craquelure; a sparse network of hairline cracks creeps along the edge and
    only a few px out from it (most on top), meandering, branching sideways and stopping at
    random (one Voronoi network with single edges dropped, cells stretched along the edge,
    growing from a few random seed points on the edge); white-hot only at the growing tips,
    then a faint glow that stays in the cracks; while active, slow heat pulses wander along
    it. No particles, no second layer;
  - solstice: sunset; on switch the sun's glare appears on the top edge, flames and dusk
    clouds (`--fx-solstice-dusk`) rise and run out sideways under slowly turning rays, then
    it settles; idle is a low, faint flame with sparse cinders drifting up; every solstice
    layer (flames, glare, rays, clouds, the header filament) fades out inside the composer's
    width;
  - nova: plasma; on switch a ~1.3 s charge: the composer heats like metal, its edge (and its
    own border, via `--fx-heat` on `.composer`, `effects.css`) going dull orange, yellow, then
    white-hot with a bloom and heat shimmer; then an eruption from the whole composer: core
    flash, lopsided noise-warped shock fronts torn into arcs of uneven thickness with radial
    filaments, debris with physics, plasma smoke, and a supernova remnant (wispy pink
    filaments over violet / teal gas, `--fx-nova-off1/2`, two layers drifting at different
    rates) that fades over ~10 s; idle is a calm shimmering plasma rim, active adds a corona,
    flames, embers and the header filament.
  - Flames (solstice, nova) have depth: a slower, taller, dimmer back layer behind the front
    tongues, and hot filaments streaming up inside each tongue.

  Motion is organic by construction: smooth attacks into two-rate decays (no kink at the
  peak), per-flare timing jitter, idle brightness wandering on slow noise, layers fading at
  different rates. The shader runs only in a band around the composer (plus a strip under
  the header and, during nova's eruption, the shockwave's box), and every band fades out
  before its edge; DPR is capped at 1.5, idle draws at 20 fps, a background window at 30
  fps (idle stops after ~8 s unfocused and resumes on focus), and nothing runs while the tab
  is hidden. The canvas is `pointer-events: none` and sits under the text. Under
  `prefers-reduced-motion`, or without WebGL2, nothing animates: `src/theme/effects.css`
  draws a static tier tint on the composer border instead.

- **Logo and hero:** `src/components/SolarMark.tsx` is the in-app mark: the app icon's sun
  disc with a black ">_" prompt on it, no tile (32-unit grid; the glyph thickens at 16 px; a
  slow glow breathe in CSS, `.solar-mark` in `styles.css`). The favicon is
  `public/favicon.svg`, with `apple-touch-icon.png`, `icon-192/512.png` and
  `manifest.webmanifest` beside it. The macOS app icon (continuous-corner tile, rim glint,
  inner shading, drop shadow on Apple's 1024 grid) lives in `design/icon/`: SVG masters, PNGs
  16 to 1024 and `Provenance.icns`, all regenerated by `python3 gen.py && node render.mjs`
  there, from the owner's `design/icon-reference.jpg`. The new-thread page shows a live sun,
  `src/components/effects/HeroSun.tsx`: a small WebGL2 canvas with a turning, limb-darkened
  sphere (granulation at three scales and speeds, faculae, a dark filament), a red
  chromosphere with spicules, a two-layer corona with bloom, prominence loops of braided
  threads lit from below on their own random life cycles, and the odd flare jet; 30 fps,
  paused when hidden or unfocused, one still frame under reduced motion, the static mark
  without WebGL2.
- **Preview without a turn (dev only):** `http://localhost:5173/?fx=nova` (active),
  `?fx=nova:idle` (load flare, then idle); in the console `__provenanceFx("spark", "flare")`
  replays a tier's switch flare, `__provenanceFx("spark", "idle" | "active")` sets the state,
  `__provenanceFx(null)` goes back to the real state. Production builds strip this.

## Not done yet (v1)

- Steering or queueing a message while a turn runs (`turn/steer`, `thread/queue/*`):
  send is disabled during a turn.
- Image attachments, `@file` mentions, and skills in the composer (only text input).
- Thread rename (`thread/name/set`), fork, rollback, and loading more than the last 50 turns.
- `item/tool/requestUserInput`, MCP elicitation, and permission-request prompts (generic
  fallback card only).
- Reasoning-effort picker (tierlm tiers currently report no effort options), plan/goal UI,
  review mode, MCP/plugin management.
- A native folder picker in the browser (the app has one; the browser keeps the text box).
- Notarized / universal (x64) app builds, auto-update.
