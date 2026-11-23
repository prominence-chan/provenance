// Where a thread runs, from the "model" it is started with:
//   "solstice", "luna/solstice"  -> main      provenance app-server on provenance-core's tiers (/rpc)
//   "codex-pv:<model>"           -> codex     a second provenance app-server on your Codex login (/rpc/codex)
//   "claude:<model>", "codex:<model>" -> fallback  the claude / codex CLI runs it (/rpc/fallback)
// A tier thread started with the Experimental or Hyperexperimental orchestrator lives on a fourth
// backend, "orchestrator" (/rpc/orchestrator): the model doesn't say so, the thread's id does.
// (shared/fallback-api.ts has the key format; server/app.ts the three endpoints.)

import {
  parseFallbackModel,
  type FallbackCli,
  type FallbackMode,
  type FallbacksInfo,
} from "../../shared/fallback-api";
import { ORCHESTRATOR_ID_PREFIX } from "../../shared/orchestrator-api";

export type BackendId = "main" | "codex" | "fallback" | "orchestrator";

export function backendOfModel(model: string | null | undefined): BackendId {
  const f = parseFallbackModel(model);
  if (!f) return "main";
  return f.mode === "codex-pv" ? "codex" : "fallback";
}

/** A fallback thread's id says where it lives before any list has loaded (server/fallback/backend.ts). */
export function backendOfThreadId(id: string): BackendId | null {
  if (id.startsWith(ORCHESTRATOR_ID_PREFIX)) return "orchestrator";
  return id.startsWith("fb-") ? "fallback" : null;
}

/**
 * Which fallback a model runs on, as its colour and effect know it ("codex-pv:" is Codex too);
 * null for a tier. The fallbacks' counterpart of tierOf (theme/tiers.ts): a model has one or
 * the other, and `data-fallback` carries it the way `data-tier` carries a tier.
 */
export function fallbackOf(model: string | null | undefined): FallbackCli | null {
  const f = parseFallbackModel(model);
  return f ? (f.mode === "claude" ? "claude" : "codex") : null;
}

export const MODE_NAME: Record<FallbackMode, string> = {
  "claude": "Claude Code",
  "codex": "Codex",
  "codex-pv": "Codex",
};

/** "Claude Code · Opus", "Codex · GPT-6.2-Sol"; null for a tier. */
export function fallbackLabel(
  model: string | null | undefined,
  info: FallbacksInfo | null,
): { name: string; model: string; mode: FallbackMode } | null {
  const f = parseFallbackModel(model);
  if (!f) return null;
  const list =
    f.mode === "claude"
      ? info?.claude.models
      : f.mode === "codex"
        ? info?.codex.models
        : info?.codex.provenance.models;
  const label = list?.find((m) => m.id === f.model)?.label ?? (f.model || "Default");
  return { name: MODE_NAME[f.mode], model: label, mode: f.mode };
}

/** What the server reports as a thread's model, as the page's model key. */
export function modelKeyFor(backend: BackendId, model: string | null): string | null {
  if (backend === "codex") return `codex-pv:${model ?? ""}`;
  return model;
}

/** The CLI / app-server model to send for a model key. */
export function wireModel(model: string): string | null {
  const f = parseFallbackModel(model);
  if (!f) return model;
  if (f.mode === "codex-pv") return f.model || null;
  return model; // the fallback backend takes the whole key
}
