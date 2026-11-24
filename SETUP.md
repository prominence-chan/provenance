# Setup & Technical Guide

This covers installing, building from source, running the CLI or web UI, and configuring Provenance.

## Desktop app (macOS Apple Silicon)

### From a release

1. Download `Provenance-0.1.0-arm64.dmg` from the [latest release](https://github.com/prominence-chan/provenance/releases/tag/provenance-app-v0.1.0) and drag **Provenance** into `/Applications`.
2. The app is ad-hoc signed, not notarized, so the first launch needs a right-click → **Open**, or run:

   ```shell
   xattr -dr com.apple.quarantine /Applications/Provenance.app
   ```

3. On launch, the app connects to a local [provenance-core](https://github.com/prominence-chan/provenance-core) router on `127.0.0.1:4141` if one is already running, or starts its own bundled copy automatically. Paths and router URLs can be changed under **Provenance → Preferences…** (`⌘,`).

### Building the app from source

Needs Node `>= 23.6`, a Rust toolchain (to build the agent binary), and a sibling `../provenance-core` checkout (or `ROUTER_SRC=/path/to/provenance-core`):

```shell
# 1. Build the agent binary (and code-mode host if packaging)
cd codex-rs
cargo build --release -p codex-cli --bin provenance -j 4
cargo build --release -p codex-code-mode-host -j 4

# 2. Build and install Provenance.app
cd ../ui
npm install
npm run app:build
npm run app:install
```

See [`ui/README.md`](ui/README.md#app) for packaging details, bundled browser/router/agent checks, and Electron dev scripts.

## Building the CLI

Needs a Rust toolchain (`codex-rs/rust-toolchain.toml` pins the version; `rustup` installs it automatically on first build):

```shell
cd codex-rs
cargo build --release -p codex-cli --bin provenance -j 4
install -m 755 target/release/provenance ~/.local/bin/provenance
```

Verify the harness and hook guards any time with:

```shell
cd codex-rs && cargo test -p codex-provenance
```

## Running

Start `provenance-core` (serving `http://127.0.0.1:4141/v1`) when using the standalone CLI or web UI:

```shell
provenance                          # interactive terminal UI
provenance exec "<task>"            # non-interactive run
provenance -m nova exec "<task>"    # pick a tier (spark, ember, solstice, nova)
provenance-ui                       # launch the desktop app (or --web for the browser UI)
```

### Web UI (without packaging the desktop app)

The desktop app and web UI share one frontend in `ui/`. To run it directly in your browser on `http://localhost:5173`:

```shell
cd ui
npm install
npm run dev
```

## Configuration

| Setting | How to set it |
| --- | --- |
| Router URL | `TIERLM_BASE_URL` (default `http://127.0.0.1:4141/v1`) |
| Router bearer token | `TIERLM_TOKEN` (optional; sent as `Authorization: Bearer ...`) |
| Config home | `PROVENANCE_HOME` (default `~/.provenance`) |
| Default tier | `model = "spark"` in `~/.provenance/config.toml`, or `-m spark` |
| Agent binary (UI server) | `PROVENANCE_BIN` (default `~/.local/bin/provenance`) |
| UI router URL / token | `TIERLM_URL` (`http://127.0.0.1:4141`), `PCORE_TOKEN` |

### `~/.provenance/config.toml`

Provenance keeps its own config home (`~/.provenance`) so it stays isolated from any other CLI config on your machine.

- The built-in `tierlm` provider points at `http://127.0.0.1:4141/v1` (`wire_api = "responses"`) and defaults to the `solstice` tier.
- Pin a specific router source by naming `<source>/<tier>` (for example, `provenance -m pool/spark`).
- To use another Responses-API-compatible provider, set `model_provider` or define a custom `[model_providers.<id>]` section in `~/.provenance/config.toml`.

## Repository layout

- `ui/` — React/Vite UI, Node WebSocket bridge, experimental orchestrators, and Electron macOS app (`ui/README.md`)
- `codex-rs/` — Rust CLI, TUI, and `app-server` runtime; Provenance branding, tiers, and defaults live in [`codex-rs/provenance/harness.toml`](codex-rs/provenance/harness.toml)
- `scripts/` — Maintenance and smoke-test scripts (`provenance-smoke.py`, `sync-upstream.sh`)
- `docs/` — Architecture and upstream sync notes ([`docs/UPSTREAM.md`](docs/UPSTREAM.md))
