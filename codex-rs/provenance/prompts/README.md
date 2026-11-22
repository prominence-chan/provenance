# Prompt overrides

Put a prompt file here and name it from `../harness.toml` to replace the base instructions
(upstream's `codex-rs/models-manager/prompt.md`) for some or all models:

```toml
[model_defaults]
instructions_file = "base.md"     # every tier, pinned source and unknown model

[[tiers]]
slug = "spark"
instructions_file = "spark.md"    # just this tier
```

Every file in this directory is embedded at build time; unreferenced ones are ignored.
Nothing is overridden by default, so the fork uses upstream's prompt.

For a change that should not need a rebuild, use `model_instructions_file = "<path>"` in
`~/.provenance/config.toml` (upstream's per-user override), or an `AGENTS.md`.
