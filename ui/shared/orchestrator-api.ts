// Who drives a thread on the tiers (the free models). Chosen in the composer where a fallback
// shows its reasoning effort; a fallback (Claude Code, Codex) has no orchestrator choice.
//
//   provenance         the Codex harness as it is (provenance app-server): one thread, one growing
//                      history, pruned and compacted by the router. The default.
//   experimental       a custom orchestrator on the same harness: the task is split into small
//                      tasks, each run by a worker in a fresh thread with a short brief, so no
//                      single chat has to hold the whole job.
//   hyperexperimental  the extreme version: every step is three fresh chats (say what to do next
//                      in plain words -> turn that into harness actions -> run them), and the only
//                      thing carried from step to step is a summary.
//
// The page stores the choice in settings (`orchestrator`) and sends threads of the last two to the
// orchestrator backend (WebSocket /rpc/orchestrator), which speaks the same JSON-RPC protocol as
// app-server, like /rpc/fallback does. Thread ids there start with ORCHESTRATOR_ID_PREFIX.

export type Orchestrator = "provenance" | "experimental" | "hyperexperimental";

export const ORCHESTRATORS: { id: Orchestrator; name: string; blurb: string }[] = [
  { id: "provenance", name: "Provenance", blurb: "One thread, the standard harness" },
  { id: "experimental", name: "Experimental", blurb: "Splits the task into small tasks for fresh workers" },
  {
    id: "hyperexperimental",
    name: "Hyperexperimental",
    blurb: "Every step in new chats, carrying only a summary",
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
