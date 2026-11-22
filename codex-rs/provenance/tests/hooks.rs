//! Merge guards: these fail when an upstream merge drops, moves or bypasses a fork hook.
//!
//! - `hook_manifest_matches_tree`: every file in hooks.toml carries exactly its count of
//!   `PROVENANCE-HOOK` tags, and no other upstream file carries one.
//! - `no_new_openai_default_sites`: upstream added a new place that falls back to the
//!   `openai` provider, which the fork has to hook too.
//! - the rest drive the real upstream crates and check the fork's behaviour survived.
//!
//! Run: `cargo test -p codex-provenance` (scripts/sync-upstream.sh runs it after a merge).

use std::path::Path;
use std::path::PathBuf;

use codex_core::config::ConfigBuilder;
use codex_models_manager::ModelsManagerConfig;
use codex_models_manager::manager::ModelsManager;
use codex_models_manager::manager::StaticModelsManager;
use codex_protocol::openai_models::ModelOrigin;
use codex_provenance::HOOK_TAG;
use codex_provenance::harness;
use pretty_assertions::assert_eq;
use serde::Deserialize;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[derive(Deserialize)]
struct Manifest {
    hook: Vec<HookEntry>,
    owned: Owned,
}

#[derive(Deserialize)]
struct HookEntry {
    file: String,
    count: usize,
    #[allow(dead_code)]
    why: String,
}

#[derive(Deserialize)]
struct Owned {
    paths: Vec<String>,
}

fn manifest() -> Manifest {
    // Read at test time (not compiled into the crate), so editing it rebuilds nothing.
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("hooks.toml");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("hooks.toml: {err}"));
    toml::from_str(&text).unwrap_or_else(|err| panic!("hooks.toml: {err}"))
}

/// `pattern` from hooks.toml [owned]: `*` matches one path segment, trailing `/` a tree.
fn owned(path: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| {
        if let Some(dir) = pattern.strip_suffix('/') {
            return path.starts_with(&format!("{dir}/"));
        }
        let (pat, p): (Vec<&str>, Vec<&str>) =
            (pattern.split('/').collect(), path.split('/').collect());
        pat.len() == p.len() && pat.iter().zip(&p).all(|(a, b)| *a == "*" || a == b)
    })
}

/// Repository files (relative paths), skipping build output, dependencies and VCS data.
fn repo_files() -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if name == ".git" || name == "node_modules" || name.starts_with("target") {
                    continue;
                }
                walk(root, &path, out);
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let root = repo_root();
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    out.sort();
    out
}

#[test]
fn hook_manifest_matches_tree() {
    let manifest = manifest();
    let root = repo_root();
    let mut problems = Vec::new();
    for hook in &manifest.hook {
        match std::fs::read_to_string(root.join(&hook.file)) {
            Ok(text) => {
                let found = text.matches(HOOK_TAG).count();
                if found != hook.count {
                    problems.push(format!(
                        "{}: expected {} {HOOK_TAG} tag(s), found {found}",
                        hook.file, hook.count
                    ));
                }
            }
            Err(err) => problems.push(format!("{}: {err}", hook.file)),
        }
    }
    let listed: Vec<&str> = manifest.hook.iter().map(|h| h.file.as_str()).collect();
    for file in repo_files() {
        if listed.contains(&file.as_str()) || owned(&file, &manifest.owned.paths) {
            continue;
        }
        let Ok(bytes) = std::fs::read(root.join(&file)) else {
            continue;
        };
        if bytes
            .windows(HOOK_TAG.len())
            .any(|w| w == HOOK_TAG.as_bytes())
        {
            problems.push(format!(
                "{file}: has a {HOOK_TAG} tag but is not in hooks.toml"
            ));
        }
    }
    assert!(
        problems.is_empty(),
        "fork hooks out of step with codex-rs/provenance/hooks.toml (see docs/UPSTREAM.md):\n  {}",
        problems.join("\n  ")
    );
}

#[test]
fn no_new_openai_default_sites() {
    // Upstream falls back to the `openai` provider in a handful of places; each is hooked to
    // `codex_provenance::default_provider`. A new one would silently use OpenAI.
    let needles = [
        "unwrap_or(\"openai\")",
        "unwrap_or_else(||\"openai\"",
        "unwrap_or(OPENAI_PROVIDER_ID)",
        "unwrap_or_else(||OPENAI_PROVIDER_ID",
        "unwrap_or(codex_model_provider_info::OPENAI_PROVIDER_ID)",
    ];
    let root = repo_root();
    let mut sites = Vec::new();
    for file in repo_files() {
        let is_test = file.ends_with("_tests.rs")
            || file.ends_with("/tests.rs")
            || file.contains("/tests/")
            || file.contains("test_support")
            || file.contains("test-support");
        if !file.starts_with("codex-rs/") || !file.ends_with(".rs") || is_test {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(root.join(&file)) else {
            continue;
        };
        for (n, line) in text.lines().enumerate() {
            let squashed: String = line.chars().filter(|c| !c.is_whitespace()).collect();
            if needles.iter().any(|needle| squashed.contains(needle)) {
                sites.push(format!("{file}:{}: {}", n + 1, line.trim()));
            }
        }
    }
    assert!(
        sites.is_empty(),
        "upstream code that defaults to the openai provider; hook each with \
         codex_provenance::default_provider(..) and a {HOOK_TAG} tag (docs/UPSTREAM.md):\n  {}",
        sites.join("\n  ")
    );
}

#[test]
fn cli_binary_is_named_after_branding() {
    let text = std::fs::read_to_string(repo_root().join("codex-rs/cli/Cargo.toml"))
        .unwrap_or_else(|err| panic!("cli/Cargo.toml: {err}"));
    let cargo: toml::Table = toml::from_str(&text).unwrap_or_else(|err| panic!("{err}"));
    let bin = codex_provenance::bin_name();
    assert_eq!(cargo["package"]["default-run"].as_str(), Some(bin));
    let main_bin = cargo["bin"]
        .as_array()
        .and_then(|bins| {
            bins.iter()
                .find(|b| b["path"].as_str() == Some("src/main.rs"))
        })
        .unwrap_or_else(|| panic!("cli/Cargo.toml has no [[bin]] for src/main.rs"));
    assert_eq!(main_bin["name"].as_str(), Some(bin));
}

#[test]
fn built_in_provider_is_the_router() {
    let settings = &harness().provider;
    let providers = codex_model_provider_info::built_in_model_providers(None);
    let provider = providers
        .get(codex_provenance::provider_id())
        .unwrap_or_else(|| panic!("no built-in {} provider", settings.id));
    let expected_url = std::env::var(&settings.base_url_env)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| settings.base_url.clone());
    assert_eq!(provider.base_url.as_deref(), Some(expected_url.as_str()));
    assert_eq!(provider.name, settings.name);
    assert!(!provider.requires_openai_auth);
}

#[test]
fn tier_catalog_comes_from_harness() {
    use codex_models_manager::provenance::catalog_for_provider;
    assert_eq!(catalog_for_provider("openai"), None);
    let catalog = catalog_for_provider(codex_provenance::provider_id())
        .unwrap_or_else(|| panic!("no catalog for the fork's provider"));
    let slugs: Vec<&str> = catalog.models.iter().map(|m| m.slug.as_str()).collect();
    let tiers: Vec<&str> = harness().tiers.iter().map(|t| t.slug.as_str()).collect();
    assert_eq!(&slugs[..tiers.len()], tiers.as_slice());
    for (i, (model, tier)) in catalog.models.iter().zip(&harness().tiers).enumerate() {
        let expected_name = tier.metadata.get("display_name").and_then(|v| v.as_str());
        assert_eq!(
            Some(model.display_name.as_str()),
            expected_name.or(Some(&tier.slug))
        );
        assert_eq!(model.priority, i as i32 + 1);
        assert_eq!(
            model.visibility,
            codex_protocol::openai_models::ModelVisibility::List
        );
    }
    assert_eq!(
        catalog.models[0].context_window,
        codex_provenance::model_defaults()
            .get("context_window")
            .and_then(serde_json::Value::as_i64)
    );
}

#[test]
fn model_list_default_is_the_default_tier() {
    // Upstream marks the first picker-visible model (the strongest tier) as the default.
    let catalog = codex_models_manager::provenance::tier_catalog();
    let manager = StaticModelsManager::new(None, catalog, ModelOrigin::ExplicitConfig);
    let presets = manager
        .try_list_models()
        .unwrap_or_else(|_| panic!("models lock"));
    let defaults: Vec<&str> = presets
        .iter()
        .filter(|preset| preset.is_default)
        .map(|preset| preset.model.as_str())
        .collect();
    assert_eq!(defaults, vec![harness().provider.default_model.as_str()]);
    // The order stays the tiers' (strongest first).
    assert_eq!(presets[0].model, harness().tiers[0].slug);
}

#[test]
fn model_info_round_trips_through_json() {
    // The harness layers its metadata over ModelInfo as JSON; that must be lossless.
    let info = codex_models_manager::model_info::model_info_from_slug("round-trip");
    let back = codex_models_manager::provenance::with_metadata(
        info.clone(),
        &serde_json::Map::from_iter([("slug".to_string(), serde_json::json!("round-trip"))]),
    );
    assert_eq!(back, info);
}

#[tokio::test]
async fn unknown_and_pinned_models_resolve() {
    let catalog = codex_models_manager::provenance::tier_catalog();
    let manager = StaticModelsManager::new(None, catalog, ModelOrigin::ExplicitConfig);
    let config = ModelsManagerConfig::default();
    let tier = &harness().tiers[harness().tiers.len() - 1].slug;

    // `<source>/<tier>` keeps its slug and gets the tier's metadata.
    let pinned = format!("pool/{tier}");
    let resolved = manager.get_model_info(&pinned, &config).await;
    assert_eq!(resolved.model.slug, pinned);
    let tier_info = manager.get_model_info(tier, &config).await;
    assert_eq!(resolved.model.display_name, tier_info.model.display_name);
    assert_eq!(
        resolved.model.context_window,
        tier_info.model.context_window
    );

    // A model no catalog knows gets upstream's fallback plus [model_defaults].
    let unknown = manager.get_model_info("no-such-model", &config).await;
    assert_eq!(unknown.origin, ModelOrigin::Synthetic);
    assert_eq!(
        unknown.model.context_window,
        codex_provenance::model_defaults()
            .get("context_window")
            .and_then(serde_json::Value::as_i64)
    );
    assert!(!unknown.model.supports_reasoning_summary_parameter);
}

async fn load_config(config_toml: &str) -> codex_core::config::Config {
    let home = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(home.path().join("config.toml"), config_toml)
        .unwrap_or_else(|err| panic!("{err}"));
    let config = ConfigBuilder::default()
        .codex_home(home.path().to_path_buf())
        .loader_overrides(codex_config::LoaderOverrides::without_managed_config_for_tests())
        .fallback_cwd(Some(home.path().to_path_buf()))
        .build()
        .await
        .unwrap_or_else(|err| panic!("config: {err}"));
    drop(home);
    config
}

#[tokio::test]
async fn config_defaults_to_the_fork() {
    let config = load_config("").await;
    assert_eq!(config.model_provider_id, codex_provenance::provider_id());
    assert_eq!(
        config.model.as_deref(),
        Some(harness().provider.default_model.as_str())
    );
    assert_eq!(
        config.check_for_update_on_startup,
        harness().defaults.check_for_update_on_startup
    );
    let catalog = config
        .model_catalog
        .unwrap_or_else(|| panic!("no tier catalog in config"));
    assert_eq!(
        catalog.models.len(),
        codex_provenance::catalog_entries().len()
    );
}

#[tokio::test]
async fn other_providers_keep_upstream_defaults() {
    let config =
        load_config("model_provider = \"openai\"\ncheck_for_update_on_startup = true\n").await;
    assert_eq!(config.model_provider_id, "openai");
    assert_eq!(config.model, None);
    assert_eq!(config.model_catalog, None);
    assert!(config.check_for_update_on_startup);
}

#[test]
fn config_home_defaults_to_the_fork() {
    let name = codex_provenance::home_dir_name();
    if std::env::var_os(&harness().branding.home_env).is_none() {
        let home = codex_provenance::home_dir().unwrap_or_else(|| panic!("no home dir"));
        assert!(home.ends_with(name), "{}", home.display());
    }
    if std::env::var_os("CODEX_HOME").is_none() {
        let home = codex_utils_home_dir::find_codex_home().unwrap_or_else(|err| panic!("{err}"));
        assert!(home.as_path().ends_with(name), "{}", home.display());
    }
}
