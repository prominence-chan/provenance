// Fallbacks: Claude Code, Codex, and Antigravity, for threads the free models can't carry. Shapes
// the UI server (server/fallback/) answers on GET /api/fallbacks and the page reads (src/fallback/).
//
// Four ways a thread can run on a fallback (the "model" a thread is started with says which):
//   claude:<model>       the `claude` CLI runs the turn (claude -p, stream-json)
//   codex:<model>        the stock `codex` CLI runs the turn (codex exec --json)
//   codex-pv:<model>     the provenance binary runs the turn on your Codex ChatGPT login through
//                        provenance-core's pass-through (server/fallback/codex-route.ts)
//   antigravity:<model>  the `agy` CLI runs the turn (agy -p --output-format stream-json)
// <model> is empty for the CLI's own default.

import type { FallbackEffort } from "./orchestrator-api.ts";

export type FallbackCli = "claude" | "codex" | "antigravity";

/** Weekly (and optional short-window) remaining usage for a fallback subscription. */
export interface FallbackUsage {
  /** Share of weekly usage remaining (0..1); null when the CLI hasn't reported one. */
  weeklyRemaining: number | null;
  /** Unix seconds when the weekly window resets, if known. */
  weeklyResetsAt?: number | null;
  /** Share of primary (e.g. 5-hour) window remaining (0..1), if known. */
  primaryRemaining?: number | null;
  /** Unix seconds when the primary window resets, if known. */
  primaryResetsAt?: number | null;
  /** Unix seconds when this snapshot was observed. */
  updatedAt?: number | null;
}

/** What a CLI's health check found. Nothing here is a secret: no tokens, no e-mail. */
export interface CliHealth {
  id: FallbackCli;
  /** Found on PATH or in a usual install folder. */
  installed: boolean;
  path: string | null;
  version: string | null;
  /** Signed in (null: couldn't tell, e.g. an older CLI without a status command). */
  signedIn: boolean | null;
  /** How: "ChatGPT", "API key", "Claude subscription (max)", "Anthropic API key", "Antigravity". */
  account: string | null;
  /** One line when something is wrong (not installed, not signed in, didn't run). */
  problem: string | null;
  /** How to fix `problem`, a command or a step, one line. */
  fix: string | null;
  /** Latest known weekly / short-window remaining usage for this fallback, if observed. */
  usage?: FallbackUsage | null;
}

export interface FallbackModel {
  /** What is passed to the CLI's --model ("" = the CLI's default). */
  id: string;
  label: string;
  /** Marked default by the CLI itself. */
  isDefault?: boolean;
  /**
   * Reasoning efforts it takes, lowest first. Empty: the CLI takes none, so nothing is offered.
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
  antigravity?: CliHealth & { models: FallbackModel[] };
  checkedAt: number;
}

export type FallbackMode = "claude" | "codex" | "codex-pv" | "antigravity";

/** Fallback model keys ("claude:opus", "codex-pv:", "antigravity:gemini-4-neon-high") <-> mode + CLI model. */
export function parseFallbackModel(key: string | null | undefined): {
  mode: FallbackMode;
  model: string;
} | null {
  if (!key) return null;
  const m = /^(claude|codex|codex-pv|antigravity):(.*)$/.exec(key);
  return m ? { mode: m[1] as FallbackMode, model: m[2] } : null;
}

export function fallbackModelKey(mode: FallbackMode, model: string): string {
  return `${mode}:${model}`;
}
