# Provenance

Provenance is a lightly rebranded fork of [OpenAI's Codex CLI](https://github.com/openai/codex)
(Apache-2.0) that runs on [tierlm](https://github.com/prominence-chan/tierlm)'s pooled free-tier
models instead of OpenAI's. You pick a strength tier, not a model:

| Model    | Tier                                   |
|----------|----------------------------------------|
| `corona` | hyperfrontier                          |
| `flare`  | frontier (default)                     |
| `ember`  | strong mid                             |
| `cinder` | fast / small                           |

What differs from upstream Codex:

- The binary is `provenance`. Its config home is `~/.provenance` (override with `PROVENANCE_HOME`), so it
  never reads or writes your real `~/.codex` config, auth or sessions.
- The built-in `tierlm` provider is the default: Responses API (`wire_api = "responses"`) at
  `http://127.0.0.1:4141/v1`. No ChatGPT login or `OPENAI_API_KEY` is needed.
- Tier names, and any other non-OpenAI model, use conservative fallback metadata: a 128k context window,
  no reasoning-summary parameter, standard JSON-schema function tools.
- The startup update check is off by default, since it would point at upstream Codex releases.

Everything else is upstream Codex. The patch is kept small so it rebases cleanly onto new upstream tags.

## Build

You need a Rust toolchain. `codex-rs/rust-toolchain.toml` pins the version, and rustup installs it on first use.

```shell
curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
cd codex-rs
cargo build --release -p codex-cli --bin provenance -j 4
install -m 755 target/release/provenance ~/.local/bin/provenance
```

## Run

Start tierlm (it listens on `127.0.0.1:4141` and serves `/v1/responses`), then:

```shell
provenance                          # interactive TUI
provenance exec "<task>"            # non-interactive
provenance -m corona exec "<task>"  # choose a tier
```

## Configure

| Setting                 | How to set it                                                   |
|-------------------------|-----------------------------------------------------------------|
| tierlm base URL         | `TIERLM_BASE_URL` (default `http://127.0.0.1:4141/v1`)          |
| tierlm bearer token     | `TIERLM_TOKEN` (optional; sent as `Authorization: Bearer ...`)   |
| config home             | `PROVENANCE_HOME` (default `~/.provenance`)                     |
| default tier            | `model = "ember"` in `~/.provenance/config.toml`, or `-m ember` |

Any upstream Codex setting works in `~/.provenance/config.toml`. To use another provider, set
`model_provider = "openai"` or define your own under `[model_providers.<id>]`.
Upstream has removed `wire_api = "chat"`, so providers must speak the Responses API.

License: Apache-2.0, the same as upstream (see `LICENSE` and `NOTICE`). Not affiliated with OpenAI.

---

*The upstream Codex README follows.*

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
