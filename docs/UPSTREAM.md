# Provenance and upstream Codex

Provenance is a fork of [openai/codex](https://github.com/openai/codex). This file is the fork's map: what the
fork owns, every place it touches upstream code and why, how to change the things that change most, and how to
merge new upstream Codex.

The rule: **the fork's logic and data live in fork-owned files; upstream files carry only one-line hooks**,
each tagged `PROVENANCE-HOOK` so `git grep PROVENANCE-HOOK` finds them all. A merge then conflicts only where
upstream edits one of those lines or the line next to it, and the resolution is always "take upstream's
side, re-apply the hook line".

## What the fork owns

These paths never exist upstream, so they never conflict.

| Path | What it is |
| --- | --- |
| `codex-rs/provenance/harness.toml` | **The fork's settings**: names, provider, default tier, tiers, model metadata, prompt overrides |
| `codex-rs/provenance/src/lib.rs` | Reads harness.toml; branding, config home, provider id, default model helpers (crate `codex-provenance`, no Codex deps) |
| `codex-rs/provenance/prompts/` | Prompt files harness.toml can name with `instructions_file` (embedded at build time) |
| `codex-rs/provenance/hooks.toml` | The hook manifest: every upstream file the fork edits and its hook count |
| `codex-rs/provenance/tests/hooks.rs` | Merge guards (see [Checks](#checks)) |
| `codex-rs/model-provider-info/src/provenance.rs` | Builds the built-in `tierlm` provider from `[provider]` |
| `codex-rs/models-manager/src/provenance.rs` | Builds the tier catalog and the fallback metadata from `[model_defaults]`, `[[tiers]]`, `[sources]` |
| `scripts/sync-upstream.sh` | The upstream sync ([Syncing](#syncing)) |
| `scripts/provenance-smoke.py` | Drives `provenance app-server`: model/list, optionally one real turn |
| `docs/UPSTREAM.md` | This file |
| `ui/` | The desktop / web UI (talks to `provenance app-server`; upstream has no such directory) |
| `.github/provenance-ui.png` | README screenshot |

`codex-provenance` is a workspace member because it is a path dependency inside `codex-rs/` (Cargo adds those
automatically), so the workspace `Cargo.toml` members list is not edited.

## Every hook in upstream code

`codex-rs/provenance/hooks.toml` is the machine-readable version of this table; the tests fail if the two
disagree with the tree.

| Upstream file | Hooks | What the hook does | Why it cannot be a fork file |
| --- | --- | --- | --- |
| `codex-rs/cli/Cargo.toml` | 3 | `[[bin]] name` and `default-run` = `provenance`; the codex-provenance dependency | Cargo names the binary here |
| `codex-rs/cli/src/main.rs` | 2 | clap `name`/`bin_name`/`override_usage`/`about`/`long_about` from `[branding]`; completion command name | clap reads them from the derive attributes |
| `codex-rs/tui/src/history_cell/session.rs` | 2 | TUI session header shows `product_name` | literal in upstream code |
| `codex-rs/exec/src/event_processor_with_human_output.rs` | 1 | `exec` banner shows `product_name` | literal in upstream code |
| `codex-rs/arg0/src/lib.rs` | 1 | `codex_provenance::init_home_env()`: `PROVENANCE_HOME` (default `~/.provenance`) exported as `CODEX_HOME` before anything reads it | every binary starts in `arg0_dispatch` |
| `codex-rs/utils/home-dir/src/lib.rs` | 2 | default config home `~/.provenance` when `CODEX_HOME` is unset (and its upstream unit test) | defence in depth for code paths that skip arg0 |
| `codex-rs/core/src/config/mod.rs` | 4 | default provider `tierlm`; default model = default tier for that provider; update check off unless config sets it; tier catalog unless `model_catalog_json` is set | config resolution is one big upstream function |
| `codex-rs/model-provider-info/src/lib.rs` | 2 | the `tierlm` entry in `built_in_model_providers`; `pub mod provenance` | the built-in list is a literal array |
| `codex-rs/models-manager/src/lib.rs` | 1 | `pub mod provenance` | |
| `codex-rs/models-manager/src/manager.rs` | 1 | models with no catalog entry get `[model_defaults]` layered over upstream's fallback | the fallback is built inside `construct_model_info` |
| `codex-rs/app-server/src/config_manager.rs` | 1 | default provider when validating a saved route | upstream falls back to `"openai"` here |
| `codex-rs/app-server/src/config_manager_service_model_providers.rs` | 1 | default provider reported to clients | same |
| `codex-rs/tui/src/app/agents_overview.rs` | 1 | default provider for embedded `thread/start` | same |
| `codex-rs/tui/src/app_server_session/account.rs` | 1 | default provider when checking auth capabilities | same |
| `codex-rs/tui/src/app_server_session/provider_selection.rs` | 1 | default provider in provider selection | same |
| `codex-rs/{app-server,arg0,core,exec,model-provider-info,models-manager,tui,utils/home-dir}/Cargo.toml` | 1 each | `[dependencies.codex-provenance]`, placed just before `[dependencies]` so upstream's alphabetical dependency edits never touch it | Cargo needs the dependency per crate |
| `README.md` | 1 | marks where the fork's section ends and upstream's README begins | GitHub shows README.md |

Hook shapes, so a hook re-applied after a conflict looks like the others:

- **Wrap upstream's default, keep it visible**: `.unwrap_or(codex_provenance::default_provider(OPENAI_PROVIDER_ID))`,
  `.unwrap_or(codex_provenance::check_for_update_on_startup(upstream_value))`. The upstream value stays in the line
  (and upstream imports stay used), and the fork decides.
- **Additive line after upstream's**: core's default model and tier catalog are new `let` lines after upstream's
  unchanged lines.
- **Tag**: a trailing `// PROVENANCE-HOOK` when the line stays under 100 columns, otherwise a
  `// PROVENANCE-HOOK: <why>` line just above. In TOML / Markdown, `#` / `<!-- -->` comments.
- **Fully qualified paths** (`codex_provenance::...`), never new `use` lines: import blocks are where upstream
  edits most.

Not hooked on purpose: the workspace version. `codex-rs/Cargo.toml` says `version = "0.171.0"` because the fork
started from the `rust-v0.171.0` release commit; upstream `main` keeps `0.0.0` there and never edits the line, so
it does not conflict and `provenance --version` keeps saying 0.171.0. Change it there if you want a different
version string.

## Changing the harness

All of these are edits to `codex-rs/provenance/harness.toml`, then a rebuild. `cargo test -p codex-provenance`
checks the file (unknown keys, a default tier that is not a tier, a missing prompt file, metadata that does not
fit `ModelInfo` all fail).

| To change | Edit |
| --- | --- |
| Tier list, names, descriptions, order | `[[tiers]]`: `slug`, `display_name`, `description`; order = picker order (`priority`) |
| Default tier | `[provider] default_model` (must be one of the tiers) |
| Router URL / provider | `[provider] base_url`, `base_url_env`, `token_env`, `name`; the provider id `id` is what config.toml's `model_provider` names |
| Metadata for every tier and unknown model | `[model_defaults]`: any `ModelInfo` field (`codex-rs/protocol/src/openai_models.rs`) in JSON spelling, e.g. `context_window`, `supports_reasoning_summary_parameter`, `default_reasoning_summary`, `truncation_policy = { mode = "tokens", limit = 10000 }` |
| Metadata for one tier | the same keys inside that `[[tiers]]` entry |
| Metadata for a pinned source | `[sources.<source>]`: layered over the tier's metadata for every `<source>/<tier>` |
| Base instructions (prompt) | put a file in `codex-rs/provenance/prompts/`, then `instructions_file = "<file>"` in `[model_defaults]` or a tier |
| Product name, command name, config home | `[branding]` (`bin_name` must match `[[bin]] name` in `codex-rs/cli/Cargo.toml`; a test checks) |
| Startup update check | `[defaults] check_for_update_on_startup` |

**Pinned sources.** A model named `<source>/<tier>` (`luna/solstice`, `pool/spark`) reaches the router
unchanged: the fork never rewrites model names. Metadata comes from upstream's namespaced-slug lookup
(`find_model_by_namespaced_suffix` in `models-manager/src/manager.rs`), which matches the tier after the `/`; a
`[sources.<source>]` table adds hidden catalog entries named `<source>/<tier>` so that source gets its own
metadata. The test `unknown_and_pinned_models_resolve` checks both.

Runtime overrides that need no rebuild stay upstream's: `model`, `model_provider`, `[model_providers.<id>]`,
`model_catalog_json`, `model_instructions_file`, `compact_prompt` in `~/.provenance/config.toml`, and the
`TIERLM_BASE_URL` / `TIERLM_TOKEN` env vars.

## Adding a new customisation

1. Put the data in `harness.toml` (add the field to the matching struct in `codex-rs/provenance/src/lib.rs`;
   structs use `deny_unknown_fields`, so a typo fails the tests) and the logic in a fork-owned file:
   `codex-rs/provenance/src/lib.rs` if it needs no Codex types, else `src/provenance.rs` in the crate that owns
   the types (create one with a `pub mod provenance;` hook at the end of that crate's `lib.rs`).
2. Hook upstream with the smallest change: one call, ideally wrapping upstream's value or adding a line after
   upstream's. Use a fully qualified path and tag it `PROVENANCE-HOOK`. If the crate does not depend on
   `codex-provenance` yet, add the `[dependencies.codex-provenance]` block before its `[dependencies]` header.
3. Add or bump the file's entry in `codex-rs/provenance/hooks.toml`, add a row to the table above, and add a
   behaviour test to `codex-rs/provenance/tests/hooks.rs` that would fail if the hook were dropped.
4. Never reformat upstream code: run `rustfmt --edition 2024 --check <file>` on the files you touched, not
   `cargo fmt` on whole crates.

## Syncing

Provenance **merges** upstream `main` (it does not rebase): fork history stays intact for the pushed `pc` remote,
each sync resolves conflicts once, and the next sync starts from the last merged upstream commit.

```shell
scripts/sync-upstream.sh            # fetch openai/codex main, merge, check, build, test, smoke, commit
scripts/sync-upstream.sh --continue # after resolving what it left for you
scripts/sync-upstream.sh --check    # just the checks, any time
```

Run it on a clean tree (a worktree is easiest: `git worktree add ../provenance-sync -b sync-$(date +%F) main`).
It:

1. fetches upstream `main` (the clone is shallow; it deepens until the merge base is found);
2. runs `git merge --no-commit` with rerere on, then resolves what has a fixed answer:
   - `codex-rs/Cargo.lock`: upstream's, then cargo regenerates it with the fork's crate;
   - fork-owned paths: ours;
   - files without a `PROVENANCE-HOOK` tag: upstream's (the fork does not change them; such conflicts come
     from upstream history, e.g. the release-branch cherry-picks the fork started from);
   - files with hooks: left for you, with the reason for each hook (exit status 2);
3. checks every hook against `hooks.toml`, looks for leftover conflict markers, and lists files that differ from
   upstream without being in the map;
4. builds `provenance`, runs `cargo test -p codex-provenance`, and smoke-tests `provenance app-server`
   (model/list must list the tiers; no router quota is spent), then commits the merge.

### Resolving a hook conflict

Take upstream's side of the conflict block, then re-apply the hook line as it was
(`git show ORIG_HEAD:<file> | grep -n -B3 -A3 PROVENANCE-HOOK` shows it). If upstream renamed or moved the code
the hook sat in, put the hook at the new place; if upstream removed the behaviour, the hook may no longer be
needed: drop it and its hooks.toml entry. Then `git add <file>` and `scripts/sync-upstream.sh --continue`.

Failures after a clean merge mean upstream changed something a hook relies on:

| Failure | Meaning |
| --- | --- |
| `hook_manifest_matches_tree` | a hook line was lost or duplicated in the merge |
| `no_new_openai_default_sites` | upstream added a new place that falls back to the `openai` provider: hook it with `codex_provenance::default_provider(..)` |
| `config_defaults_to_the_fork` / `other_providers_keep_upstream_defaults` | config resolution changed shape around the core hooks |
| `unknown_and_pinned_models_resolve` | upstream changed model lookup; check pinned `<source>/<tier>` names still keep their slug |
| `model_info_round_trips_through_json` | `ModelInfo` gained a field that does not survive JSON; `with_metadata` needs a look |
| build error in a `provenance.rs` | an upstream type or function the fork uses changed |

### Install the new binary

```shell
cd codex-rs
cargo build --release -p codex-cli --bin provenance -j 4
install -m 755 target/release/provenance ~/.local/bin/provenance
```

If the app-server protocol changed, regenerate the UI's types: `cd ui && npm run gen:protocol`.

## Checks

`cargo test -p codex-provenance` (also run by the sync script):

- unit tests on harness.toml itself;
- `tests/hooks.rs`: the hook manifest against the tree, a scan for new `openai` provider fallbacks, the CLI
  binary name, and behaviour through the real crates: the built-in provider, the tier catalog, pinned and
  unknown model metadata, config defaults with and without `model_provider = "openai"`, the config home.

`scripts/provenance-smoke.py <binary> [--turn spark]` drives a built binary's `app-server` with a throwaway
`PROVENANCE_HOME`; `--turn` runs one real turn against the router (spends quota).

Upstream's own tests that assert upstream defaults (provider `openai`, 272k fallback context, the `OpenAI Codex`
header in TUI snapshots, `.codex` home) fail on the fork by design.
