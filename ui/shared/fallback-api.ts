// Fallbacks: Claude Code and Codex, for threads the free models can't carry. Shapes the UI server
// (server/fallback/) answers on GET /api/fallbacks and the page reads (src/fallback/).
//
// Three ways a thread can run on a fallback (the "model" a thread is started with says which):
//   claude:<model>    the `claude` CLI runs the turn (claude -p, stream-json), in the thread's folder
//   codex:<model>     the stock `codex` CLI runs the turn (codex exec --json)
//   codex-pv:<model>  the provenance binary runs the turn itself, with its own harness, on your Codex
//                     ChatGPT login: its model requests go through provenance-core's pass-through
//                     (history pruning, usage ledger) on to OpenAI, never to the tiers
//                     (server/fallback/codex-route.ts)
// <model> is empty for the CLI's own default.

import type { FallbackEffort } from "./orchestrator-api.ts";

export type FallbackCli = "claude" | "codex";

/** What a CLI's health check found. Nothing here is a secret: no tokens, no e-mail. */
export interface CliHealth {
  id: FallbackCli;
  /** Found on PATH or in a usual install folder. */
  installed: boolean;
  path: string | null;
  version: string | null;
  /** Signed in (null: couldn't tell, e.g. an older CLI without a status command). */
  signedIn: boolean | null;
  /** How: "ChatGPT", "API key", "Claude subscription (max)", "Anthropic API key". */
  account: string | null;
  /** One line when something is wrong (not installed, not signed in, didn't run). */
  problem: string | null;
  /** How to fix `problem`, a command or a step, one line. */
  fix: string | null;
}

export interface FallbackModel {
  /** What is passed to the CLI's --model ("" = the CLI's default). */
  id: string;
  label: string;
  /** Marked default by the CLI itself. */
  isDefault?: boolean;
  /**
   * Reasoning efforts it takes, lowest first (Claude Code: what its --effort takes, the same for
   * every model; Codex: the catalog's per model, and for "Default" every listed model's). Empty:
   * the CLI takes none (an older Claude Code), so nothing is offered.
   */
  efforts?: FallbackEffort[];
  /** The effort it runs at when none is sent (Codex's catalog says; unknown otherwise). */
  defaultEffort?: FallbackEffort | null;
}

export interface FallbacksInfo {
  claude: CliHealth & { models: FallbackModel[] };
  codex: CliHealth & {
    models: FallbackModel[];
    /** "Through Provenance": the provenance binary on your Codex ChatGPT login. */
    provenance: {
      /** Codex is signed in with ChatGPT and the provenance binary is there. */
      ready: boolean;
      problem: string | null;
      models: FallbackModel[];
    };
  };
  checkedAt: number;
}

export type FallbackMode = "claude" | "codex" | "codex-pv";

/** Fallback model keys ("claude:opus", "codex-pv:") <-> mode + CLI model. */
export function parseFallbackModel(key: string | null | undefined): {
  mode: FallbackMode;
  model: string;
} | null {
  if (!key) return null;
  const m = /^(claude|codex|codex-pv):(.*)$/.exec(key);
  return m ? { mode: m[1] as FallbackMode, model: m[2] } : null;
}

export function fallbackModelKey(mode: FallbackMode, model: string): string {
  return `${mode}:${model}`;
}
