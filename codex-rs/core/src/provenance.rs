//! Provenance (fork-owned file): the agent's name in what a model is sent.
//!
//! Upstream's prompts, tool descriptions and bundled skills call the agent "Codex". On the
//! fork's providers that word becomes the product name from codex-rs/provenance/harness.toml
//! (`[branding.agent_text]`), here, in the request, so upstream's prompt files stay as they
//! are and keep merging. Hooks: `pub mod provenance;` in lib.rs and the call at the end of
//! `build_responses_request` in client.rs.
//!
//! What is rewritten is text the harness wrote: the base instructions, tool descriptions and
//! the skills list. The conversation (the person's messages, AGENTS.md, developer
//! instructions passed by a client, tool output) is never touched: there "Codex" is somebody
//! else's word.
//!
//! Requests to the `openai` provider are returned unchanged: with `model_provider = "openai"`
//! (the app's "Run Codex through Provenance") the harness stays stock.

use std::sync::Arc;

use codex_api::ResponsesApiRequest;
use codex_model_provider_info::ModelProviderInfo;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::SKILLS_INSTRUCTIONS_OPEN_TAG;
use serde_json::Value;
use serde_json::value::RawValue;

use crate::client_common::Prompt;

/// Whether requests to this provider name the agent after the fork: every provider but
/// OpenAI's own.
pub fn names_agent_for(provider: &ModelProviderInfo) -> bool {
    !provider.is_openai()
}

/// `request` with the agent named after the fork, for a provider `names_agent_for` accepts.
pub(crate) fn name_agent(
    provider: &ModelProviderInfo,
    prompt: &Prompt,
    mut request: ResponsesApiRequest,
) -> Result<ResponsesApiRequest, serde_json::Error> {
    if !names_agent_for(provider) {
        return Ok(request);
    }
    name_agent_in_input(&prompt.base_instructions.text, &mut request.input);
    if request.tools.is_some() {
        let tools = serde_json::to_string(&*prompt.tools)?;
        if let Some(named) = name_agent_in_tools(&tools)? {
            request.tools = Some(Arc::<RawValue>::from(RawValue::from_string(named)?).into());
        }
    }
    Ok(request)
}

/// Rewrite the harness's own developer messages in `input`: the base instructions (the
/// message whose text is `base_instructions`) and the skills list.
pub fn name_agent_in_input(base_instructions: &str, input: &mut [ResponseItem]) {
    for item in input {
        let ResponseItem::Message { role, content, .. } = item else {
            continue;
        };
        if role.as_str() != "developer" {
            continue;
        }
        for part in content {
            let ContentItem::InputText { text } = part else {
                continue;
            };
            let harness_text = (!base_instructions.is_empty()
                && text.as_str() == base_instructions)
                || text.trim_start().starts_with(SKILLS_INSTRUCTIONS_OPEN_TAG);
            if !harness_text {
                continue;
            }
            if let Some(named) = named(text) {
                *text = named;
            }
        }
    }
}

/// The tools JSON with every `description` string rewritten; `None` when nothing changes
/// (the request then keeps upstream's bytes).
pub fn name_agent_in_tools(tools_json: &str) -> Result<Option<String>, serde_json::Error> {
    if !tools_json.contains(
        codex_provenance::harness()
            .branding
            .agent_text
            .from
            .as_str(),
    ) {
        return Ok(None);
    }
    let mut tools: Value = serde_json::from_str(tools_json)?;
    if !name_agent_in_descriptions(&mut tools) {
        return Ok(None);
    }
    serde_json::to_string(&tools).map(Some)
}

fn name_agent_in_descriptions(value: &mut Value) -> bool {
    match value {
        Value::Array(items) => items.iter_mut().fold(false, |changed, item| {
            name_agent_in_descriptions(item) || changed
        }),
        Value::Object(fields) => {
            let mut changed = false;
            for (key, field) in fields.iter_mut() {
                match field {
                    Value::String(text) if key.as_str() == "description" => {
                        if let Some(named) = named(text) {
                            *text = named;
                            changed = true;
                        }
                    }
                    other => changed |= name_agent_in_descriptions(other),
                }
            }
            changed
        }
        _ => false,
    }
}

/// `text` with the agent named after the fork, or `None` when it already is.
fn named(text: &str) -> Option<String> {
    match codex_provenance::agent_text(text) {
        std::borrow::Cow::Owned(named) => Some(named),
        std::borrow::Cow::Borrowed(_) => None,
    }
}
