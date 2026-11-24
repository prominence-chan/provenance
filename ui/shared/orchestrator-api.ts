// Who drives a thread on the tiers (the free models). Chosen in the composer where a fallback
// shows its reasoning effort; a fallback (Claude Code, Codex) has no orchestrator choice.
//
//   provenance         the Codex harness as it is (provenance app-server): one thread, one growing
//                      history, pruned and compacted by the router. The default.
//   experimental       a custom orchestrator on the same harness: a worker in a fresh thread
//                      does the job from a brief that quotes the request word for word (several
//                      workers, one after the other, when the job is large or a worker's context
//                      fills up), notes kept by code carry what was done, and the result is
//                      checked before the answer. In two benchmark rounds on a free web model it
//                      is the one that beat the stock harness (8 of 10 tasks against 6).
//   hyperexperimental  no tool calls at all: every step is one fresh plain-text chat that says
//                      what to do next; code runs it and keeps the memory (a log of the steps,
//                      the files being worked on, long outputs saved to disk). Every request
//                      stays small however long the job runs, and it works with a model that
//                      cannot drive the harness's tools. It is slower, and on every benchmark so
//                      far it finished fewer tasks than Experimental (4 of 10 against 8): pick it
//                      only when Experimental's workers cannot get the model to call tools, or to
//                      try it.
//
// The page stores the choice in settings (`orchestrator`) and sends threads of the last two to the
// orchestrator backend (WebSocket /rpc/orchestrator), which speaks the same JSON-RPC protocol as
// app-server, like /rpc/fallback does. Thread ids there start with ORCHESTRATOR_ID_PREFIX.

export type Orchestrator = "provenance" | "experimental" | "hyperexperimental";

export const ORCHESTRATORS: { id: Orchestrator; name: string; blurb: string }[] = [
  { id: "provenance", name: "Provenance", blurb: "One thread, the standard harness" },
  {
    id: "experimental",
    name: "Experimental",
    blurb: "A fresh worker per job, checked at the end",
  },
  {
    id: "hyperexperimental",
    name: "Hyperexperimental",
    blurb: "A plain chat per step, no tool calls; unproven",
  },
];

export const DEFAULT_ORCHESTRATOR: Orchestrator = "provenance";

export const ORCHESTRATOR_ID_PREFIX = "orc-";

export function isOrchestrator(v: unknown): v is Orchestrator {
  return v === "provenance" || v === "experimental" || v === "hyperexperimental";
}

/**
 * Reasoning efforts a fallback's CLI takes (the composer shows the ones its model supports).
 * Claude Code's `--effort` takes low..max (its --help); Codex's catalog (`codex debug models`,
 * model/list) lists low..ultra per model, and its enum also knows none and minimal (older models).
 */
export type FallbackEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

/** Every effort, lowest first. */
export const FALLBACK_EFFORTS: FallbackEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export function isFallbackEffort(v: unknown): v is FallbackEffort {
  return typeof v === "string" && (FALLBACK_EFFORTS as string[]).includes(v);
}
