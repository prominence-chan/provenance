//! Provenance (fork-owned file): the tier catalog and fallback metadata.
//!
//! The data comes from codex-rs/provenance/harness.toml; this module only turns it into
//! `ModelInfo`s, starting from upstream's fallback (`model_info_from_slug`) so new
//! upstream fields keep their upstream defaults. Hooks: `pub mod provenance;` in lib.rs,
//! the fallback call in manager.rs `construct_model_info`, the default tier in manager.rs
//! `build_available_models`, and the catalog default in core's config (`catalog_for_provider`).

use codex_protocol::openai_models::ModelInfo;
use codex_protocol::openai_models::ModelPreset;
use codex_protocol::openai_models::ModelsResponse;
use serde_json::Map;
use serde_json::Value;

use crate::model_info::model_info_from_slug;

/// The catalog the fork's provider offers: every tier, plus `<source>/<tier>` for each
/// pinned source with its own metadata. Unlisted `<source>/<tier>` names resolve to the
/// tier through upstream's namespaced-slug lookup and keep their slug.
pub fn tier_catalog() -> ModelsResponse {
    let models = codex_provenance::catalog_entries()
        .into_iter()
        .map(|entry| {
            let base = quiet(|| model_info_from_slug(&entry.slug));
            with_metadata(base, &entry.metadata)
        })
        .collect();
    ModelsResponse { models }
}

/// The catalog to use when config.toml sets no `model_catalog_json`: the tier catalog
/// for the fork's provider, upstream's behaviour (`None`) for any other provider.
pub fn catalog_for_provider(provider_id: &str) -> Option<ModelsResponse> {
    (provider_id == codex_provenance::provider_id()).then(tier_catalog)
}

/// The default in a model list (model/list's `isDefault`, and the model a thread gets when
/// none is named): the harness's default tier when the list has it. Upstream marks the first
/// picker-visible model, which in the tier catalog is the strongest tier, not the default
/// one. A list without that tier (another provider's) keeps upstream's choice.
pub fn mark_default_tier(presets: &mut [ModelPreset]) {
    let tier = codex_provenance::harness().provider.default_model.as_str();
    if presets.iter().any(|preset| preset.model == tier) {
        for preset in presets.iter_mut() {
            preset.is_default = preset.model == tier;
        }
    }
}

/// Metadata for a model no catalog describes: upstream's fallback with the harness's
/// [model_defaults] layered on (128k context, no reasoning-summary parameter).
pub fn fallback_model_info(slug: &str) -> ModelInfo {
    with_metadata(
        model_info_from_slug(slug),
        codex_provenance::model_defaults(),
    )
}

/// Layer harness metadata (ModelInfo fields in JSON form) over `base`. Panics on a field
/// that does not fit ModelInfo; tests in codex-provenance build every entry, so a bad
/// harness.toml fails there first.
pub fn with_metadata(base: ModelInfo, metadata: &Map<String, Value>) -> ModelInfo {
    if metadata.is_empty() {
        return base;
    }
    let slug = base.slug.clone();
    let mut fields = match serde_json::to_value(base) {
        Ok(Value::Object(fields)) => fields,
        other => panic!("ModelInfo for {slug} did not serialize to an object: {other:?}"),
    };
    codex_provenance::merge_json_map(&mut fields, metadata);
    serde_json::from_value(Value::Object(fields)).unwrap_or_else(|err| {
        panic!("harness.toml metadata for {slug} does not fit ModelInfo: {err}")
    })
}

/// Run `f` without emitting tracing events: building the catalog goes through upstream's
/// fallback, which warns about an unknown model for every tier.
fn quiet<T>(f: impl FnOnce() -> T) -> T {
    tracing::subscriber::with_default(tracing::subscriber::NoSubscriber::default(), f)
}
