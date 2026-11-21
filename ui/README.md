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

Both checks expect the server to already be running. `MODEL=spark` picks a different tier.
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
    │   ├── Sidebar.tsx        thread list, search, new thread, archive, connection status
    │   ├── ThreadHeader.tsx   title, cwd, model, token usage
    │   ├── Conversation.tsx   centered transcript; turns -> items; auto-scroll
    │   ├── items/             one renderer per ThreadItem type (ItemView.tsx dispatches)
    │   ├── Approvals.tsx      command / file-change approval cards
    │   ├── Composer.tsx       prompt box, tier picker, permissions preset, cwd, send/stop
    │   ├── Markdown.tsx, DiffView.tsx, Notices.tsx, icons.tsx, format.ts
    ├── App.tsx, main.tsx
    └── styles.css       all styling; palette is CSS variables at the top
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
"tierlm"`), falling back to `nova / solstice / spark / ember` (`server/main.ts`). Default
  is `solstice`.

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
