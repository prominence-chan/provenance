<div align="center">

<img src="ui/design/icon/icon-256.png" alt="Provenance app icon" width="112" />

# Provenance

**A coding agent for your Mac and your terminal, running on pooled free-tier models.**

A fork of [OpenAI Codex CLI](https://github.com/openai/codex), powered by
[provenance-core](https://github.com/prominence-chan/provenance-core). Pick a strength, not a model.

[![Download for macOS](https://img.shields.io/badge/download-macOS%20arm64-111111?style=flat-square&logo=apple&logoColor=white)](https://github.com/prominence-chan/provenance/releases/tag/provenance-app-v0.1.0)
[![License](https://img.shields.io/badge/license-Apache--2.0-111111?style=flat-square)](LICENSE)
[![provenance-core](https://img.shields.io/badge/backend-provenance--core-111111?style=flat-square)](https://github.com/prominence-chan/provenance-core)
[![Upstream](https://img.shields.io/badge/upstream-openai%2Fcodex-111111?style=flat-square)](https://github.com/openai/codex)

<img src=".github/provenance-ui.png" alt="The Provenance desktop app" width="88%" />

</div>

## Why

Codex is a great agent harness, but it wants an OpenAI account. Provenance keeps the harness and swaps the brain.
Requests go to a local [provenance-core](https://github.com/prominence-chan/provenance-core), which pools the free
tiers of a dozen LLM providers and sorts them into four tiers:

| Tier       | Strength                    |
| ---------- | --------------------------- |
| `nova`     | hyperfrontier               |
| `solstice` | frontier (default)          |
| `ember`    | strong mid-size             |
| `spark`    | fast / small                |

No ChatGPT login and no `OPENAI_API_KEY`.

## Install the app

1. Download `Provenance-0.1.0-arm64.dmg` from the
   [latest release](https://github.com/prominence-chan/provenance/releases/tag/provenance-app-v0.1.0) (Apple Silicon)
   and drag **Provenance** into Applications.
2. The app is ad-hoc signed, not notarized, so the first launch needs a right-click on it, then **Open**. Or run
   `xattr -dr com.apple.quarantine /Applications/Provenance.app` once.
3. It needs the `provenance` binary in `~/.local/bin` (see [Build the CLI](#build-the-cli)) and provenance-core on
   `127.0.0.1:4141`. If provenance-core isn't running, the app starts it, and shows a banner if it can't. Paths and
   URLs can be changed under **Provenance → Preferences…**

Or build it yourself: `cd ui && npm install && npm run app:build && npm run app:install`. Details in
[`ui/README.md`](ui/README.md#app).

## Build the CLI

Needs a Rust toolchain (`codex-rs/rust-toolchain.toml` pins the version; rustup installs it on first use).

```shell
cd codex-rs
cargo build --release -p codex-cli --bin provenance -j 4
install -m 755 target/release/provenance ~/.local/bin/provenance
```

## Run

Start provenance-core (it serves `http://127.0.0.1:4141/v1`), then:

```shell
provenance                          # interactive TUI
provenance exec "<task>"            # non-interactive
provenance -m nova exec "<task>"    # choose a tier
provenance-ui                       # the desktop app (or the web UI with --web)
```

The desktop app and the web UI share one frontend in `ui/`, a Codex-desktop-style client for
`provenance app-server`. Without the app installed, `cd ui && npm install && npm run dev` serves it on
`http://localhost:5173`. See [`ui/README.md`](ui/README.md) for how it fits together.

## Configure

| Setting               | How to set it                                                   |
| --------------------- | --------------------------------------------------------------- |
| provenance-core URL   | `TIERLM_BASE_URL` (default `http://127.0.0.1:4141/v1`)          |
| provenance-core token | `TIERLM_TOKEN` (optional; sent as `Authorization: Bearer ...`)  |
| config home           | `PROVENANCE_HOME` (default `~/.provenance`)                     |
| default tier          | `model = "spark"` in `~/.provenance/config.toml`, or `-m spark` |

Any upstream Codex setting works in `~/.provenance/config.toml`. To use another provider, set
`model_provider = "openai"` or define your own under `[model_providers.<id>]` (Responses API only; upstream removed
`wire_api = "chat"`).

<details>
<summary><b>What differs from upstream Codex</b></summary>

- The binary is `provenance`. Its config home is `~/.provenance` (override with `PROVENANCE_HOME`), so it never
  reads or writes your real `~/.codex` config, auth or sessions.
- The built-in provider (id `tierlm`, pointing at provenance-core) is the default: Responses API
  (`wire_api = "responses"`) at `http://127.0.0.1:4141/v1`.
- Tier names, and any other non-OpenAI model, use conservative fallback metadata: a 128k context window, no
  reasoning-summary parameter, standard JSON-schema function tools.
- The startup update check is off by default, since it would point at upstream Codex releases.

Everything else is upstream Codex. The patch is kept small so it rebases cleanly onto new upstream tags.

</details>

## Credits and license

Provenance is built on [OpenAI Codex CLI](https://github.com/openai/codex) and keeps its license:
Apache-2.0 (see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)). All credit for the agent itself goes to the Codex
team. Not affiliated with or endorsed by OpenAI.

---

<p align="center"><sub><b>Upstream README</b>: everything below is the original OpenAI Codex CLI README, kept as is.<br/>Commands there say <code>codex</code>; in this fork the binary is <code>provenance</code>.</sub></p>

---

<p align="center"><strong>Codex CLI</strong> is a coding agent from OpenAI that runs locally on your computer.
<p align="center">
  <img src="https://github.com/openai/codex/blob/main/.github/codex-cli-splash.png" alt="Codex CLI splash" width="80%" />
</p>
</br>
If you want Codex in your code editor (VS Code, Cursor, Windsurf), <a href="https://developers.openai.com/codex/ide">install in your IDE.</a>
</br>If you want the desktop app experience, run <code>codex app</code> or visit <a href="https://chatgpt.com/codex?app-landing-page=true">the Codex App page</a>.
</br>If you are looking for the <em>cloud-based agent</em> from OpenAI, <strong>Codex Web</strong>, go to <a href="https://chatgpt.com/codex">chatgpt.com/codex</a>.</p>

---

## Quickstart

### Installing and running Codex CLI

Run the following on Mac or Linux to install Codex CLI:

```shell
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Run the following on Windows to install Codex CLI:

```shell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

The standalone installers download from `https://releases.openai.com/codex` by default and fall back to GitHub Releases if a metadata or asset download is unavailable. To force GitHub Releases, set `CODEX_INSTALLER_USE_RELEASES_OPENAI_COM` to `false` (`0` and `no` are also accepted):

```shell
curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false sh
```

```powershell
$env:CODEX_INSTALLER_USE_RELEASES_OPENAI_COM='false'; irm https://chatgpt.com/codex/install.ps1 | iex
```

Codex CLI can also be installed via the following package managers:

```shell
# Install using npm
npm install -g @openai/codex
```

```shell
# Install using Homebrew
brew install --cask codex
```

Then simply run `codex` to get started.

<details>
<summary>You can also go to the <a href="https://github.com/openai/codex/releases/latest">latest GitHub Release</a> and download the appropriate binary for your platform.</summary>

Each GitHub Release contains many executables, but in practice, you likely want one of these:

- macOS
  - Apple Silicon/arm64: `codex-aarch64-apple-darwin.tar.gz`
  - x86_64 (older Mac hardware): `codex-x86_64-apple-darwin.tar.gz`
- Linux
  - x86_64: `codex-x86_64-unknown-linux-musl.tar.gz`
  - arm64: `codex-aarch64-unknown-linux-musl.tar.gz`

Each archive contains a single entry with the platform baked into the name (e.g., `codex-x86_64-unknown-linux-musl`), so you likely want to rename it to `codex` after extracting it.

</details>

### Using Codex with your ChatGPT plan

Run `codex` and select **Sign in with ChatGPT**. We recommend signing into your ChatGPT account to use Codex as part of your Plus, Pro, Business, Edu, or Enterprise plan. [Learn more about what's included in your ChatGPT plan](https://help.openai.com/en/articles/11369540-codex-in-chatgpt).

You can also use Codex with an API key, but this requires [additional setup](https://developers.openai.com/codex/auth#sign-in-with-an-api-key).

## Docs

- [**Codex Documentation**](https://developers.openai.com/codex)
- [**Contributing**](./docs/contributing.md)
- [**Installing & building**](./docs/install.md)
- [**Open source fund**](./docs/open-source-fund.md)

This repository is licensed under the [Apache-2.0 License](LICENSE).
