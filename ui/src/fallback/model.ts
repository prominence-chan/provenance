// Where a thread runs, from the "model" it is started with:
//   "solstice", "luna/solstice"  -> main      provenance app-server on provenance-core's tiers (/rpc)
//   "codex-pv:<model>"           -> codex     a second provenance app-server on your Codex login (/rpc/codex)
//   "claude:<model>", "codex:<model>" -> fallback  the claude / codex CLI runs it (/rpc/fallback)
// (shared/fallback-api.ts has the key format; server/app.ts the three endpoints.)

import {
  parseFallbackModel,
  type FallbackMode,
  type FallbacksInfo,
} from "../../shared/fallback-api";

export type BackendId = "main" | "codex" | "fallback";

export function backendOfModel(model: string | null | undefined): BackendId {
  const f = parseFallbackModel(model);
  if (!f) return "main";
  return f.mode === "codex-pv" ? "codex" : "fallback";
}

/** A fallback thread's id says where it lives before any list has loaded (server/fallback/backend.ts). */
export function backendOfThreadId(id: string): BackendId | null {
  return id.startsWith("fb-") ? "fallback" : null;
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
