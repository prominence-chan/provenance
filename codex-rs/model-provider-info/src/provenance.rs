//! Provenance (fork-owned file): the fork's built-in provider.
//!
//! Settings come from `[provider]` in codex-rs/provenance/harness.toml. Hooks: the entry
//! in `built_in_model_providers` and `pub mod provenance;` in lib.rs.

use crate::ModelProviderInfo;
use crate::WireApi;
use crate::create_oss_provider_with_base_url;

pub use codex_provenance::provider_id;

/// The router provider: Responses API at `[provider] base_url` (overridden by the
/// `base_url_env` env var), with the optional `token_env` env var sent as a bearer
/// token. Needs no OpenAI login.
pub fn create_provider() -> ModelProviderInfo {
    let settings = &codex_provenance::harness().provider;
    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let base_url = env(&settings.base_url_env).unwrap_or_else(|| settings.base_url.clone());
    ModelProviderInfo {
        name: settings.name.clone(),
        experimental_bearer_token: env(&settings.token_env).map(Into::into),
        ..create_oss_provider_with_base_url(&base_url, WireApi::Responses)
    }
}
