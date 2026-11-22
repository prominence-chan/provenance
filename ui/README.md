# Provenance UI

A local, Codex-desktop-style web UI for Provenance. It talks to `provenance app-server`
(the same JSON-RPC protocol the official Codex IDE extension / desktop app use) through a
small Node bridge, because browsers can't speak stdio.

```
browser (React, Vite)  <── WebSocket /rpc ──>  server/main.ts + bridge.ts  <── stdio JSON-RPC ──>  provenance app-server  ──>  tierlm :4141
```

## Run

```sh
cd ui
npm install          # first time
npm run dev          # http://localhost:5173, opens your browser (NO_OPEN=1 to skip)
```

Or from anywhere: `provenance-ui` (symlink in `~/.local/bin` to `scripts/provenance-ui`).
New threads then default to the directory you ran it from.

Other scripts:

| command                       | what it does                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run dev`                 | Dev server with HMR + bridge, one process, one port                                           |
| `npm run build` / `npm start` | Type-check + build to `dist/`, then serve it with the bridge (`--prod`)                       |
| `npm run typecheck`           | `tsc -b` for both the app and the server/scripts                                              |
| `npm run gen:protocol`        | Regenerate protocol types from the installed binary                                           |
| `npm run smoke`               | Headless check through the bridge (no browser): new thread, "reply with just ok", resume      |
| `npm run e2e`                 | Headless Chromium (Playwright) drives the real UI; `APPROVAL=1` also tests a command approval |

Both checks expect the server to already be running. `MODEL=ember` picks a different tier.
The free upstream models sometimes return 503; both checks retry.

Requires Node >= 23.6: the server and scripts are `.ts` files run directly by Node
(type stripping), so stick to erasable TypeScript there (no `enum`, no constructor
parameter properties).

Env vars (server): `PORT` (5173), `HOST` (127.0.0.1), `PROVENANCE_BIN`
(`~/.local/bin/provenance`), `PROVENANCE_UI_CWD` (default cwd, `$HOME` otherwise),
`TIERLM_URL` (`http://127.0.0.1:4141`).

## Layout

```
ui/
├── server/
│   ├── main.ts        HTTP server: Vite middleware (dev) or dist/ (prod), /api/info, /api/tiers, WS /rpc
│   └── bridge.ts      AppServerBridge: spawns `provenance app-server`, relays JSON-RPC
├── scripts/
│   ├── gen-protocol.ts  runs `provenance app-server generate-ts --experimental`
│   ├── smoke.ts / e2e.ts
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
    ├── components/
    │   ├── Sidebar.tsx        threads grouped by project (cwd), search, new thread, archive, status
    │   ├── ThreadHeader.tsx   slim bar: sidebar toggle (when hidden), title, cwd, tier, context ring
    │   ├── Conversation.tsx   centered transcript; turns -> items; auto-scroll
    │   ├── items/             one renderer per ThreadItem type (ItemView.tsx dispatches); tool
    │   │                      items render as one-line rows, consecutive ones grouped
    │   ├── Approvals.tsx      command / file-change approval cards
    │   ├── Composer.tsx       prompt box, tier picker, permissions preset, cwd, send/stop
    │   ├── Markdown.tsx, DiffView.tsx, Notices.tsx, icons.tsx, format.ts
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
  blurbs shown in the picker. Any element with `data-tier="..."` gets `--tier-color` /
  `--tier-grad` for its subtree. `TierBadge` appears in the header, on the "Working…" line and
  in each turn's footer; `TierPicker` is the composer dropdown.
- **Effects** (always on for the selected tier), all in one WebGL2 canvas behind the main
  column, `src/components/effects/FlameFx.tsx`. Three states, eased into each other: a
  **flare** when the tier changes (and on first load), an almost-still **idle**, and an
  **active** state while a turn streams (above idle, well below the flare). Intensity climbs
  with the tier, spark subtlest, nova strongest. Each tier has its own style and ramp
  (`--fx-<tier>-deep/mid/hot/core`):
  - spark: electric (blue arc, ice-white, white-gold cores); tiny sparks fizzle in and out at
    random spots just outside the edge, drift and crackle; on switch a scatter of them with
    short arcs jumping between neighbours; idle is a lone spark every few seconds;
  - ember: craquelure; a Voronoi network of craggy cracks (big plates split by finer cracks,
    irregular cells, jagged edges) opens outward from the edge behind a ragged front, white-hot
    at the front, then each crack cools to a faint glow that stays in the network; while
    active, heat pulses run out along it;
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

- **Logo and hero:** `src/components/SolarMark.tsx` is the mark (a solid sun disc with a
  prominence arch and a horizon line cut out of it, on a 32 px grid so it stays crisp at
  16 px; a slow glow breathe in CSS, `.solar-mark` in `styles.css`; the favicon in
  `index.html` is a static copy). The new-thread page shows a live sun,
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
- A native folder picker for the cwd (it's a text box).
