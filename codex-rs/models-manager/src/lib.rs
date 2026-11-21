pub mod cache;
mod catalog;
pub mod collaboration_mode_presets;
pub(crate) mod config;
pub mod manager;
pub mod model_info;
pub mod model_presets;
mod originator;
pub mod test_support;

pub use catalog::CatalogModel;
pub use catalog::ModelOrigin;
pub use codex_protocol::auth::AuthMode;
pub use config::ModelsManagerConfig;
pub use originator::ModelCatalogOriginator;

/// Load the bundled model catalog shipped with `codex-models-manager`.
pub fn bundled_models_response()
-> std::result::Result<codex_protocol::openai_models::ModelsResponse, serde_json::Error> {
    serde_json::from_str(include_str!("../models.json"))
}

/// Provenance: the tierlm strength tiers offered by the built-in `tierlm` provider.
pub fn tierlm_models_response() -> codex_protocol::openai_models::ModelsResponse {
    const TIERS: [(&str, &str, &str); 4] = [
        ("corona", "Corona", "Hyperfrontier: strongest pooled models"),
        ("flare", "Flare", "Frontier: default for everyday coding"),
        ("ember", "Ember", "Strong mid tier: capable, plentiful"),
        ("cinder", "Cinder", "Fast: small models for quick tasks"),
    ];
    let models = TIERS
        .into_iter()
        .zip(1..)
        .map(|((slug, display_name, description), priority)| {
            codex_protocol::openai_models::ModelInfo {
                display_name: display_name.to_string(),
                description: Some(description.to_string()),
                visibility: codex_protocol::openai_models::ModelVisibility::List,
                priority,
                ..model_info::fallback_model_info(slug)
            }
        })
        .collect();
    codex_protocol::openai_models::ModelsResponse { models }
}

/// Convert the client version string to a whole version string (e.g. "1.2.3-alpha.4" -> "1.2.3").
pub fn client_version_to_whole() -> String {
    format!(
        "{}.{}.{}",
        env!("CARGO_PKG_VERSION_MAJOR"),
        env!("CARGO_PKG_VERSION_MINOR"),
        env!("CARGO_PKG_VERSION_PATCH")
    )
}
