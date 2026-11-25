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
| `codex-rs/core/src/provenance.rs` | Names the agent in what a model is sent ([The agent's name](#the-agents-name)) |
| `scripts/sync-upstream.sh` | The upstream sync ([Syncing](#syncing)) |
| `scripts/provenance-smoke.py` | Drives `provenance app-server`: model/list, optionally one real turn |
| `scripts/provenance-name-check.py` | Reads the request a built binary sends for each tier and fails if it still calls the agent Codex |
| `README.md`, `SETUP.md` | Fork-owned README and technical setup guide |
| `docs/UPSTREAM.md` | This file |
| `ui/` | The desktop / web UI (talks to `provenance app-server`; upstream has no such directory) |
| `.github/provenance-ui.png`, `.github/ui-*.png` | README screenshots |

`codex-provenance` is a workspace member because it is a path dependency inside `codex-rs/` (Cargo adds those
automatically), so the workspace `Cargo.toml` members list is not edited.

## Every hook in upstream code

`codex-rs/provenance/hooks.toml` is the machine-readable version of this table; the tests fail if the two
disagree with the tree.

| Upstream file | Hooks | What the hook does | Why it cannot be a fork file |
| --- | --- | --- | --- |
| `codex-rs/cli/Cargo.toml` | 3 | `[[bin]] name` and `default-run` = `provenance`; the codex-provenance dependency | Cargo names the binary here |
| `codex-rs/cli/src/main.rs` | 2 | clap `name`/`bin_name`/`override_usage`/`about`/`long_about` from `[branding]`; completion command name | clap reads them from the derive attributes |
| `codex-rs/cli/src/config_override_args.rs` | 1 | `codex_provenance::cli_command(..)`: every command's `--help` text names the fork (and `~/.provenance`) | the help strings are doc comments on upstream's clap structs, across many files |
| `codex-rs/core/src/client.rs` | 1 | `crate::provenance::name_agent(..)` at the end of `build_responses_request`: the agent's name in the base instructions, tool descriptions and skills list, on every provider but `openai` | the request is assembled inside upstream's client |
| `codex-rs/core/src/lib.rs` | 1 | `pub mod provenance` | |
| `codex-rs/tui/src/history_cell/session.rs` | 2 | TUI session header shows `product_name` | literal in upstream code |
| `codex-rs/exec/src/event_processor_with_human_output.rs` | 1 | `exec` banner shows `product_name` | literal in upstream code |
| `codex-rs/arg0/src/lib.rs` | 1 | `codex_provenance::init_home_env()`: `PROVENANCE_HOME` (default `~/.provenance`) exported as `CODEX_HOME` before anything reads it | every binary starts in `arg0_dispatch` |
| `codex-rs/utils/home-dir/src/lib.rs` | 2 | default config home `~/.provenance` when `CODEX_HOME` is unset (and its upstream unit test) | defence in depth for code paths that skip arg0 |
| `codex-rs/core/src/config/mod.rs` | 4 | default provider `tierlm`; default model = default tier for that provider; update check off unless config sets it; tier catalog unless `model_catalog_json` is set | config resolution is one big upstream function |
| `codex-rs/model-provider-info/src/lib.rs` | 2 | the `tierlm` entry in `built_in_model_providers`; `pub mod provenance` | the built-in list is a literal array |
| `codex-rs/models-manager/src/lib.rs` | 1 | `pub mod provenance` | |
| `codex-rs/models-manager/src/manager.rs` | 2 | models with no catalog entry get `[model_defaults]` layered over upstream's fallback; the model list's default (`model/list` `isDefault`) is `[provider] default_model`, not the first tier | the fallback is built inside `construct_model_info`; the default is marked inside `build_available_models` |
| `codex-rs/app-server/src/config_manager.rs` | 1 | default provider when validating a saved route | upstream falls back to `"openai"` here |
| `codex-rs/app-server/src/config_manager_service_model_providers.rs` | 1 | default provider reported to clients | same |
| `codex-rs/tui/src/app/agents_overview.rs` | 1 | default provider for embedded `thread/start` | same |
| `codex-rs/tui/src/app_server_session/account.rs` | 1 | default provider when checking auth capabilities | same |
| `codex-rs/tui/src/app_server_session/provider_selection.rs` | 1 | default provider in provider selection | same |
| `codex-rs/{app-server,arg0,core,exec,model-provider-info,models-manager,tui,utils/home-dir}/Cargo.toml` | 1 each | `[dependencies.codex-provenance]`, placed just before `[dependencies]` so upstream's alphabetical dependency edits never touch it | Cargo needs the dependency per crate |
| `codex-rs/Cargo.toml` | 1 | workspace `version = "0.171.0"` (upstream main: `0.0.0`) | Cargo reads the version here |

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

The workspace version is a hook too: `codex-rs/Cargo.toml` keeps `version = "0.171.0"`, the release the fork
started from (`rust-v0.171.0`), while upstream `main` says `0.0.0` there and never edits the line. It sets
`provenance --version` and the user agent; change it there if you want a different version string.

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
| What the agent is called in prompts and `--help` | `[branding.agent_text]`: `from` (upstream's word), `keep` (phrases where it names OpenAI's product), `[[branding.agent_text.rewrite]]` (whole sentences) |
| Startup update check | `[defaults] check_for_update_on_startup` |

**Pinned sources.** A model named `<source>/<tier>` (`luna/solstice`, `pool/spark`) reaches the router
unchanged: the fork never rewrites model names. Metadata comes from upstream's namespaced-slug lookup
(`find_model_by_namespaced_suffix` in `models-manager/src/manager.rs`), which matches the tier after the `/`; a
`[sources.<source>]` table adds hidden catalog entries named `<source>/<tier>` so that source gets its own
metadata. The test `unknown_and_pinned_models_resolve` checks both.

Runtime overrides that need no rebuild stay upstream's: `model`, `model_provider`, `[model_providers.<id>]`,
`model_catalog_json`, `model_instructions_file`, `compact_prompt` in `~/.provenance/config.toml`, and the
`TIERLM_BASE_URL` / `TIERLM_TOKEN` env vars.

## The agent's name

Upstream's prompts call the agent "Codex" ("You are a coding agent running in the Codex CLI…"), and so do a
few tool descriptions and the descriptions of the bundled skills. The fork does not edit those files (there
are dozens, and upstream rewrites them often). Instead the name is substituted where the text is used:

- **What a model is sent**: `crate::provenance::name_agent` (`codex-rs/core/src/provenance.rs`), called at the
  end of `build_responses_request`, rewrites the text the harness itself wrote: the base instructions, every
  tool `description`, and the `<skills_instructions>` list. The conversation is never touched (the person's
  messages, AGENTS.md, developer instructions a client passes to `thread/start`, tool output): "Codex" there
  is somebody else's word, e.g. the app's carried-over brief saying which turns Codex served.
- **Not on the `openai` provider**: a provider named `OpenAI` (`ModelProviderInfo::is_openai`, what
  `model_provider = "openai"` selects) gets the request exactly as upstream builds it. That is the app's
  "Run Codex through Provenance": the harness there stays stock.
- **`--help`**: `codex_provenance::cli_command` passes every help string of the clap command tree through the
  same rules, and says `~/.provenance` where upstream says `~/.codex`.

The rules are `[branding.agent_text]` in harness.toml: the word (`from = "Codex"`, whole word, case-sensitive,
so `codex`, `CODEX_HOME`, `gpt-5.3-codex` never match), the phrases in which it means OpenAI's product and
stays (`keep`: "OpenAI's Codex", "Codex Cloud", …), and whole sentences that would be false with only the
name swapped (`rewrite`: "Codex CLI is an open source project led by OpenAI." becomes "Provenance is an
open source fork of OpenAI's Codex CLI.").

Not renamed: text the binary prints for people outside `--help` (TUI strings, error messages such as "Codex
ran out of room in the model's context window", `doctor` output) and tool *results* a model reads ("Network
access was denied by the Codex sandbox network proxy"). Those are several hundred literals in upstream files;
the desktop app renames the agent in the error text it shows for tier turns (`harnessMessage` in
`ui/src/components/format.ts`). The bodies of the bundled skills (`skills/src/assets/samples/*/SKILL.md`) also
still say Codex once a model opens one.

Checks: `cargo test -p codex-provenance` (`models_are_told_the_forks_name`: every tier's, a pinned source's
and an unknown model's base instructions; each `rewrite` sentence is still in upstream's prompt; the `openai`
provider is skipped) and, on a built binary, `scripts/provenance-name-check.py <binary>`: one turn per tier
against a stand-in endpoint, the whole request read back, plus one turn on a provider named OpenAI that must
still say Codex. The sync script runs both.

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
4. builds `provenance`, runs `cargo test -p codex-provenance`, smoke-tests `provenance app-server`
   (model/list must list the tiers; no router quota is spent) and runs the name check
   (`scripts/provenance-name-check.py`, against a stand-in endpoint), then commits the merge.

### Resolving a hook conflict

Take upstream's side of the conflict block, then re-apply the hook line as it was
(`git show ORIG_HEAD:<file> | grep -n -B3 -A3 PROVENANCE-HOOK` shows it). If upstream renamed or moved the code
the hook sat in, put the hook at the new place; if upstream removed the behaviour, the hook may no longer be
needed: drop it and its hooks.toml entry. Then `git add <file>` and `scripts/sync-upstream.sh --continue`.

Failures after a clean merge mean upstream changed something a hook relies on:

| Failure | Meaning |
| --- | --- |
| `hook_manifest_matches_tree` | a hook line was lost or duplicated in the merge |
| `models_are_told_the_forks_name` | upstream reworded a sentence `[branding.agent_text]` rewrites whole (update the `from`), or a new base prompt names the agent in a way the rules miss |
| `provenance-name-check.py` fails | text that calls the agent Codex reaches a model from a place `name_agent` does not cover (a new harness-written message): extend `core/src/provenance.rs` or add a `keep` phrase if it names OpenAI's product |
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

Upstream's own tests that assert the defaults the fork changes are expected to fail on the fork, e.g.
`codex-models-manager` `authoritative_catalog_preserves_hidden_models_and_matches_exact_ids` (expects
upstream's 272k fallback context, the fork's is 128k). Expect the same in the core / tui / app-server suites
wherever a test asserts provider `openai` by default or a snapshot shows the `OpenAI Codex` header (those suites
were not run for the first sync). `codex-utils-home-dir`'s home test is hooked and passes.

## Sync log

| Date | Upstream | Commits | Conflicted files | Needed a person | Time |
| --- | --- | --- | --- | --- | --- |
| 2026-11-22 | `cf3ff153` (main) | 211 since `1b841662` | 5 | 1 (`exec` banner, upstream reshaped the next line) | merge + resolution 19 s; Cargo.lock refresh, build, tests, smoke 17 min |
| 2026-11-24 | `f64f003d` (main) | 123 since `cf3ff153` | 0 | 0 | merge 1 s (run with `--no-build`: 10 GB free on the disk); checks run by hand afterwards |

The first sync also cleared the release-branch residue: the fork started from the `rust-v0.171.0` tag, which is
off `main` (a cherry-pick of #62387 plus the version bump). Four TUI files conflicted between that cherry-pick
and `main`'s later edits and were taken from upstream; from now on the merge base is a `main` commit.
