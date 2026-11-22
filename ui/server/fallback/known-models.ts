// Model names for the fallbacks' pickers when the CLI itself doesn't list them. Edit freely: this
// is the only hand-kept list.
//
// - Claude Code has no command that lists models. Its `--help` names a few aliases ("e.g.
//   'fable', 'opus', or 'sonnet'"), which the health check reads first; these are added after
//   them (an alias always means the latest model of that family, so they don't go stale).
// - Codex lists its own models (`codex debug models`, and the provenance binary's catalog for
//   "through Provenance"); this list is used only when that fails.
//
// The CLI's own default ("Default", no --model) is always offered first, so an empty list still works.

export const CLAUDE_MODELS: { id: string; label: string }[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

export const CODEX_MODELS: { id: string; label: string }[] = [];
