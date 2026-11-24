//! Provenance: the fork's own crate.
//!
//! The fork's settings live in `../harness.toml` (names, provider, default tier, tiers,
//! model metadata, prompt overrides). Upstream crates reach them only through one-line
//! hooks tagged `PROVENANCE-HOOK` (listed in `../hooks.toml`), and through the fork-owned
//! `src/provenance.rs` modules in `model-provider-info` and `models-manager`, which turn
//! this data into upstream types. This crate depends on no other Codex crate, so any
//! crate can use it.
//!
//! docs/UPSTREAM.md (repository root) is the map of the fork.

use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

include!(concat!(env!("OUT_DIR"), "/prompts.rs"));

/// The comment tag on every hook in upstream code: `git grep PROVENANCE-HOOK`.
pub const HOOK_TAG: &str = "PROVENANCE-HOOK";

/// The harness settings source, as compiled in.
pub const HARNESS_TOML: &str = include_str!("../harness.toml");

/// harness.toml, parsed.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Harness {
    pub branding: Branding,
    pub provider: Provider,
    pub defaults: Defaults,
    /// ModelInfo fields layered over upstream's fallback metadata.
    #[serde(default)]
    pub model_defaults: toml::Table,
    /// Strongest first.
    pub tiers: Vec<Tier>,
    /// `<source>` -> ModelInfo fields for every `<source>/<tier>`.
    #[serde(default)]
    pub sources: BTreeMap<String, toml::Table>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Branding {
    pub product_name: String,
    pub bin_name: String,
    pub cli_about: String,
    pub home_dir_name: String,
    pub home_env: String,
    pub agent_text: AgentText,
}

/// `[branding.agent_text]`: how upstream's name for the agent becomes `product_name`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentText {
    /// Upstream's name for the agent (`Codex`), matched as a whole word.
    pub from: String,
    /// Phrases in which that word names OpenAI's product and is kept.
    #[serde(default)]
    pub keep: Vec<String>,
    /// Whole sentences replaced before the name is swapped.
    #[serde(default)]
    pub rewrite: Vec<Rewrite>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rewrite {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub base_url_env: String,
    pub token_env: String,
    pub default_model: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Defaults {
    pub check_for_update_on_startup: bool,
}

#[derive(Debug, Deserialize)]
pub struct Tier {
    pub slug: String,
    /// Every other key: ModelInfo fields (or `instructions_file`).
    #[serde(flatten)]
    pub metadata: toml::Table,
}

/// One model the fork adds to the catalog: its slug and the ModelInfo fields to layer
/// over upstream's fallback metadata for it.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogEntry {
    pub slug: String,
    pub metadata: Map<String, Value>,
}

/// Parse a harness file. `harness()` is this applied to the compiled-in harness.toml.
pub fn parse_harness(source: &str) -> Result<Harness, String> {
    let harness: Harness = toml::from_str(source).map_err(|err| format!("harness.toml: {err}"))?;
    if harness.tiers.is_empty() {
        return Err("harness.toml: [[tiers]] is empty".to_string());
    }
    let mut seen = std::collections::BTreeSet::new();
    for tier in &harness.tiers {
        if tier.slug.is_empty() || tier.slug.contains('/') {
            return Err(format!("harness.toml: bad tier slug {:?}", tier.slug));
        }
        if !seen.insert(tier.slug.as_str()) {
            return Err(format!("harness.toml: tier {:?} listed twice", tier.slug));
        }
    }
    if !seen.contains(harness.provider.default_model.as_str()) {
        return Err(format!(
            "harness.toml: provider.default_model {:?} is not one of the tiers",
            harness.provider.default_model
        ));
    }
    let agent_text = &harness.branding.agent_text;
    if agent_text.from.is_empty() || harness.branding.product_name.contains(&agent_text.from) {
        return Err(
            "harness.toml: branding.agent_text.from is empty or part of product_name".into(),
        );
    }
    for rule in &agent_text.rewrite {
        if rule.from.is_empty() || !agent_names(&harness.branding, &rule.to).is_empty() {
            return Err(format!(
                "harness.toml: agent_text rewrite {:?} is empty or still names the agent {:?}",
                rule.from, agent_text.from
            ));
        }
    }
    // Resolve every instructions_file now so a missing prompt fails at the first use.
    for table in std::iter::once(&harness.model_defaults)
        .chain(harness.tiers.iter().map(|tier| &tier.metadata))
        .chain(harness.sources.values())
    {
        metadata_json(table)?;
    }
    Ok(harness)
}

/// The compiled-in harness.toml. Panics on an invalid file; the crate's tests parse it,
/// so an invalid file never gets past `cargo test -p codex-provenance`.
pub fn harness() -> &'static Harness {
    static HARNESS: OnceLock<Harness> = OnceLock::new();
    HARNESS.get_or_init(|| parse_harness(HARNESS_TOML).unwrap_or_else(|err| panic!("{err}")))
}

// ---- branding ---------------------------------------------------------------------

pub fn product_name() -> &'static str {
    &harness().branding.product_name
}

pub fn bin_name() -> &'static str {
    &harness().branding.bin_name
}

pub fn cli_about() -> &'static str {
    &harness().branding.cli_about
}

/// The CLI's long --help text: the about line plus upstream's second paragraph.
pub fn cli_long_about() -> &'static str {
    static TEXT: OnceLock<String> = OnceLock::new();
    TEXT.get_or_init(|| {
        format!(
            "{}\n\nIf no subcommand is specified, options will be forwarded to the interactive CLI.",
            cli_about()
        )
    })
}

/// The CLI's usage line (upstream: `codex [OPTIONS] [PROMPT] ...`).
pub fn cli_usage() -> &'static str {
    static TEXT: OnceLock<String> = OnceLock::new();
    TEXT.get_or_init(|| {
        let bin = bin_name();
        format!("{bin} [OPTIONS] [PROMPT]\n       {bin} [OPTIONS] <COMMAND> [ARGS]")
    })
}

// ---- the agent's name in text ---------------------------------------------------------

/// Text the harness wrote for a model, with upstream's name for the agent replaced by
/// `product_name` (`[branding.agent_text]`): whole sentences from `rewrite` first, then the
/// bare word wherever it is not inside a `keep` phrase. Borrowed when nothing changes.
pub fn agent_text(text: &str) -> Cow<'_, str> {
    agent_text_with(&harness().branding, text)
}

/// `agent_text` for any branding.
pub fn agent_text_with<'a>(branding: &Branding, text: &'a str) -> Cow<'a, str> {
    let rules = &branding.agent_text;
    if rules.from.is_empty() || !text.contains(rules.from.as_str()) {
        return Cow::Borrowed(text);
    }
    let mut source = Cow::Borrowed(text);
    for rule in &rules.rewrite {
        if !rule.from.is_empty() && source.contains(rule.from.as_str()) {
            source = Cow::Owned(source.replace(rule.from.as_str(), &rule.to));
        }
    }
    let names = agent_names(branding, &source);
    if names.is_empty() {
        return source;
    }
    let mut out = String::with_capacity(source.len() + names.len() * branding.product_name.len());
    let mut copied = 0;
    for start in names {
        out.push_str(&source[copied..start]);
        out.push_str(&branding.product_name);
        copied = start + rules.from.len();
    }
    out.push_str(&source[copied..]);
    Cow::Owned(out)
}

/// Byte offsets in `text` where upstream's name stands for the agent: a whole word (not part
/// of an identifier or a model name like `gpt-5-Codex`) outside every `keep` phrase. The name
/// check (`scripts/provenance-name-check.py`) and the tests use this to prove none is left.
pub fn agent_names(branding: &Branding, text: &str) -> Vec<usize> {
    let rules = &branding.agent_text;
    let from = rules.from.as_str();
    if from.is_empty() {
        return Vec::new();
    }
    text.match_indices(from)
        .map(|(start, _)| start)
        .filter(|&start| {
            let end = start + from.len();
            let before = text[..start].chars().next_back();
            let after = text[end..].chars().next();
            if before.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '-')
                || after.is_some_and(|c| c.is_alphanumeric() || c == '_')
            {
                return false;
            }
            !rules.keep.iter().any(|phrase| {
                phrase.match_indices(from).any(|(offset, _)| {
                    start >= offset
                        && text
                            .get(start - offset..)
                            .is_some_and(|tail| tail.starts_with(phrase.as_str()))
                })
            })
        })
        .collect()
}

/// `--help` text: the agent's name as above, and the fork's config home where upstream's
/// text says `~/.codex`.
pub fn help_text(text: &str) -> String {
    agent_text(text).replace("~/.codex", &format!("~/{}", home_dir_name()))
}

/// The CLI's clap command with every help string (commands, subcommands, arguments) passed
/// through `help_text`. Hook: cli/src/config_override_args.rs.
pub fn cli_command(command: clap::Command) -> clap::Command {
    let about = command.get_about().map(ToString::to_string);
    let long_about = command.get_long_about().map(ToString::to_string);
    let after_help = command.get_after_help().map(ToString::to_string);
    let after_long_help = command.get_after_long_help().map(ToString::to_string);
    let mut command = command;
    if let Some(text) = about {
        command = command.about(help_text(&text));
    }
    if let Some(text) = long_about {
        command = command.long_about(help_text(&text));
    }
    if let Some(text) = after_help {
        command = command.after_help(help_text(&text));
    }
    if let Some(text) = after_long_help {
        command = command.after_long_help(help_text(&text));
    }
    command
        .mut_args(|arg| {
            let help = arg.get_help().map(ToString::to_string);
            let long_help = arg.get_long_help().map(ToString::to_string);
            let mut arg = arg;
            if let Some(text) = help {
                arg = arg.help(help_text(&text));
            }
            if let Some(text) = long_help {
                arg = arg.long_help(help_text(&text));
            }
            arg
        })
        .mut_subcommands(cli_command)
}

// ---- config home ------------------------------------------------------------------

/// The config home's directory name under $HOME (upstream: `.codex`).
pub fn home_dir_name() -> &'static str {
    &harness().branding.home_dir_name
}

/// The config home: `$PROVENANCE_HOME`, else `$HOME/.provenance`.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var(&harness().branding.home_env)
        .ok()
        .filter(|val| !val.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(home_dir_name())))
}

/// Resolve the config home, create it, and export it as `CODEX_HOME`, so every upstream
/// code path and child process uses it instead of the real Codex home. An inherited
/// `CODEX_HOME` is replaced: point `PROVENANCE_HOME` elsewhere instead.
///
/// Call once at process start, before any threads are spawned (arg0 does).
pub fn init_home_env() {
    if let Some(home) = home_dir() {
        let _ = std::fs::create_dir_all(&home);
        // SAFETY: called at startup while the process is still single-threaded.
        unsafe { std::env::set_var("CODEX_HOME", home) };
    }
}

// ---- provider and defaults ----------------------------------------------------------

/// The fork's built-in provider id (`tierlm`).
pub fn provider_id() -> &'static str {
    &harness().provider.id
}

/// The provider to use when config names none. Hooks pass upstream's default
/// (`"openai"`) so the line still shows what upstream does; the fork always uses its own.
pub fn default_provider(_upstream_default: &str) -> &'static str {
    provider_id()
}

/// The default model (tier) for a provider when config and flags name none: the
/// harness's default tier for the fork's provider, nothing for any other provider.
pub fn default_model(provider_id: &str) -> Option<String> {
    let provider = &harness().provider;
    (provider_id == provider.id).then(|| provider.default_model.clone())
}

/// `check_for_update_on_startup` when config leaves it unset (upstream: `true`).
pub fn check_for_update_on_startup(_upstream_default: bool) -> bool {
    harness().defaults.check_for_update_on_startup
}

// ---- model metadata ---------------------------------------------------------------

/// [model_defaults] as JSON: layered over upstream's fallback metadata for every model
/// the catalog does not describe.
pub fn model_defaults() -> &'static Map<String, Value> {
    static JSON: OnceLock<Map<String, Value>> = OnceLock::new();
    JSON.get_or_init(|| metadata(&harness().model_defaults))
}

/// The models the fork's provider offers, in catalog order: each tier (priority 1..n,
/// listed in pickers), then `<source>/<tier>` for every source in [sources] (hidden).
/// Each entry's metadata is [model_defaults] + the tier (+ the source).
pub fn catalog_entries() -> Vec<CatalogEntry> {
    catalog_entries_for(harness())
}

/// `catalog_entries` for any parsed harness.
pub fn catalog_entries_for(harness: &Harness) -> Vec<CatalogEntry> {
    let defaults = metadata(&harness.model_defaults);
    let mut entries = Vec::new();
    for (priority, tier) in (1..).zip(&harness.tiers) {
        let mut fields = defaults.clone();
        fields.insert("visibility".into(), Value::from("list"));
        fields.insert("priority".into(), Value::from(priority));
        merge_json_map(&mut fields, &metadata(&tier.metadata));
        entries.push(CatalogEntry {
            slug: tier.slug.clone(),
            metadata: fields,
        });
    }
    let mut pinned = Vec::new();
    for (source, source_fields) in &harness.sources {
        for tier_entry in &entries {
            let mut fields = tier_entry.metadata.clone();
            fields.insert("visibility".into(), Value::from("none"));
            merge_json_map(&mut fields, &metadata(source_fields));
            pinned.push(CatalogEntry {
                slug: format!("{source}/{}", tier_entry.slug),
                metadata: fields,
            });
        }
    }
    entries.extend(pinned);
    entries
}

/// Deep-merge `overlay` into `base`: objects merge key by key, anything else replaces.
pub fn merge_json_map(base: &mut Map<String, Value>, overlay: &Map<String, Value>) {
    for (key, value) in overlay {
        match (base.get_mut(key), value) {
            (Some(Value::Object(base_obj)), Value::Object(overlay_obj)) => {
                merge_json_map(base_obj, overlay_obj);
            }
            _ => {
                base.insert(key.clone(), value.clone());
            }
        }
    }
}

fn metadata(table: &toml::Table) -> Map<String, Value> {
    metadata_json(table).unwrap_or_else(|err| panic!("{err}"))
}

/// A harness metadata table as ModelInfo JSON fields, with `instructions_file` resolved.
fn metadata_json(table: &toml::Table) -> Result<Map<String, Value>, String> {
    let mut fields = match serde_json::to_value(table) {
        Ok(Value::Object(fields)) => fields,
        Ok(other) => return Err(format!("harness.toml: expected a table, got {other}")),
        Err(err) => return Err(format!("harness.toml: {err}")),
    };
    if let Some(file) = fields.remove("instructions_file") {
        let name = file
            .as_str()
            .ok_or_else(|| "harness.toml: instructions_file must be a string".to_string())?;
        let text = prompt_file(name).ok_or_else(|| {
            format!(
                "harness.toml: instructions_file {name:?} is not in codex-rs/provenance/prompts/"
            )
        })?;
        let mut messages = Map::new();
        messages.insert("instructions_template".into(), Value::from(text));
        merge_json_map(
            &mut fields,
            &Map::from_iter([("model_messages".to_string(), Value::Object(messages))]),
        );
    }
    Ok(fields)
}

/// A file under codex-rs/provenance/prompts/, by name.
pub fn prompt_file(name: &str) -> Option<&'static str> {
    PROMPT_FILES
        .iter()
        .find(|(file, _)| *file == name)
        .map(|(_, text)| *text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn harness_toml_parses() {
        let harness = parse_harness(HARNESS_TOML).unwrap_or_else(|err| panic!("{err}"));
        assert!(!harness.tiers.is_empty());
    }

    #[test]
    fn default_model_only_for_the_fork_provider() {
        assert_eq!(
            default_model(provider_id()).as_deref(),
            Some(harness().provider.default_model.as_str())
        );
        assert_eq!(default_model("openai"), None);
    }

    #[test]
    fn catalog_lists_tiers_in_order() {
        let entries = catalog_entries();
        let slugs: Vec<&str> = entries.iter().map(|e| e.slug.as_str()).collect();
        let tiers: Vec<&str> = harness().tiers.iter().map(|t| t.slug.as_str()).collect();
        assert_eq!(&slugs[..tiers.len()], tiers.as_slice());
        assert_eq!(entries[0].metadata["priority"], Value::from(1));
        assert_eq!(entries[0].metadata["visibility"], Value::from("list"));
        // [model_defaults] reaches every tier.
        for (key, value) in model_defaults() {
            assert_eq!(&entries[0].metadata[key], value, "{key}");
        }
    }

    #[test]
    fn rejects_unknown_default_tier_and_missing_prompt() {
        let bad_default = HARNESS_TOML.replace(
            &format!("default_model = {:?}", harness().provider.default_model),
            "default_model = \"no-such-tier\"",
        );
        assert!(parse_harness(&bad_default).is_err());
        let bad_prompt =
            format!("{HARNESS_TOML}\n[sources.x]\ninstructions_file = \"missing.md\"\n");
        assert!(parse_harness(&bad_prompt).is_err());
    }

    #[test]
    fn sources_add_hidden_pinned_entries() {
        let source = format!("{HARNESS_TOML}\n[sources.luna]\ncontext_window = 64000\n");
        let harness = parse_harness(&source).unwrap_or_else(|err| panic!("{err}"));
        let entries = catalog_entries_for(&harness);
        let tiers = harness.tiers.len();
        assert_eq!(entries.len(), tiers * 2);
        let pinned = &entries[tiers];
        assert_eq!(pinned.slug, format!("luna/{}", harness.tiers[0].slug));
        assert_eq!(pinned.metadata["context_window"], Value::from(64000));
        assert_eq!(pinned.metadata["visibility"], Value::from("none"));
        assert_eq!(
            pinned.metadata["display_name"],
            entries[0].metadata["display_name"]
        );
    }

    #[test]
    fn agent_text_names_the_agent_and_keeps_the_product() {
        let branding = &harness().branding;
        let name = branding.product_name.as_str();
        assert_eq!(agent_text("no name here"), Cow::Borrowed("no name here"));
        assert_eq!(
            agent_text("You are Codex. Ask Codex, not codex; see Codex's notes."),
            format!("You are {name}. Ask {name}, not codex; see {name}'s notes.")
        );
        // Identifiers, env vars and model names are not the agent's name.
        for kept in [
            "CODEX_HOME",
            "~/.codex/config.toml",
            "gpt-5.3-codex",
            "gpt-5-Codex",
            "CodexErr",
            "Codex_x",
        ] {
            assert_eq!(agent_text(kept), kept);
        }
        // The other product keeps its name.
        for phrase in &branding.agent_text.keep {
            let text = format!("see {phrase} for that");
            assert_eq!(agent_text(&text), text.as_str(), "{phrase}");
        }
        assert_eq!(
            agent_text("Codex Cloud tasks run in Codex"),
            format!("Codex Cloud tasks run in {name}")
        );
        assert_eq!(
            help_text("loaded from `~/.codex/config.toml` by Codex"),
            format!("loaded from `~/{}/config.toml` by {name}", home_dir_name())
        );
    }

    #[test]
    fn agent_text_rewrites_leave_no_agent_name() {
        let branding = &harness().branding;
        for rule in &branding.agent_text.rewrite {
            let out = agent_text(&format!("Before. {} After Codex.", rule.from)).into_owned();
            assert!(out.contains(rule.to.as_str()), "{out}");
            assert_eq!(agent_names(branding, &out), Vec::<usize>::new(), "{out}");
        }
    }

    #[test]
    fn cli_help_names_the_fork() {
        let command = clap::Command::new("x")
            .about("Run Codex")
            .arg(
                clap::Arg::new("c")
                    .long("c")
                    .help("from `~/.codex/config.toml`"),
            )
            .subcommand(clap::Command::new("exec").about("Run Codex non-interactively"));
        let mut command = cli_command(command);
        let help = command.render_long_help().to_string();
        let name = product_name();
        assert!(help.contains(&format!("Run {name}")), "{help}");
        assert!(
            help.contains(&format!("Run {name} non-interactively")),
            "{help}"
        );
        assert!(
            help.contains(&format!("~/{}/config.toml", home_dir_name())),
            "{help}"
        );
        assert!(agent_names(&harness().branding, &help).is_empty(), "{help}");
    }

    #[test]
    fn merge_is_deep() {
        let mut base = serde_json::json!({"a": {"x": 1, "y": 2}, "b": 1})
            .as_object()
            .cloned()
            .unwrap_or_default();
        let overlay = serde_json::json!({"a": {"y": 3}, "c": 4})
            .as_object()
            .cloned()
            .unwrap_or_default();
        merge_json_map(&mut base, &overlay);
        assert_eq!(
            Value::Object(base),
            serde_json::json!({"a": {"x": 1, "y": 3}, "b": 1, "c": 4})
        );
    }
}
