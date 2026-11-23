// Reasoning effort for the fallbacks (the composer's effort control, ComposerSlot.tsx): which
// efforts the selected model takes, and which one a turn sends.
//
//   Claude Code              claude --effort <level>               (server/fallback/backend.ts)
//   Codex in the background  codex exec -c model_reasoning_effort="<level>"
//   Codex through Provenance turn/start { effort }                 (the second app-server)
//
// "Default" sends nothing: the CLI's (or the thread's) own effort. The choice is kept per fallback
// in settings.fallbackEffort; one the selected model doesn't take counts as Default (and comes back
// with a model that takes it).

import { parseFallbackModel, type FallbacksInfo } from "../../shared/fallback-api";
import type { FallbackEffort } from "../../shared/orchestrator-api";
import type { Settings } from "../store/state";
import { fallbackOf } from "./model";

export const EFFORT_LABEL: Record<FallbackEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

export interface EffortChoice {
  /** The efforts the model takes, lowest first; empty: none offered. Null until known. */
  efforts: FallbackEffort[] | null;
  /** What it runs at when none is sent, when the CLI says. */
  defaultEffort: FallbackEffort | null;
}

/** The efforts a fallback model key takes; null for a tier. */
export function effortsFor(model: string, info: FallbacksInfo | null): EffortChoice | null {
  const f = parseFallbackModel(model);
  if (!f) return null;
  const list =
    f.mode === "claude"
      ? info?.claude.models
      : f.mode === "codex"
        ? info?.codex.models
        : info?.codex.provenance.models;
  const m = list?.find((x) => x.id === f.model) ?? list?.find((x) => x.id === "");
  return { efforts: m ? (m.efforts ?? []) : null, defaultEffort: m?.defaultEffort ?? null };
}

/** The effort a turn on the selected model sends (null: none, the CLI's default). */
export function chosenEffort(settings: Settings, info: FallbacksInfo | null): FallbackEffort | null {
  const cli = fallbackOf(settings.model);
  if (!cli) return null;
  const want = settings.fallbackEffort[cli];
  if (!want) return null;
  const known = effortsFor(settings.model, info)?.efforts;
  return !known || known.includes(want) ? want : null;
}
