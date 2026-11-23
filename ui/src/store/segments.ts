// One conversation, the backend sessions behind it (shared/thread-links.ts). The page knows a
// conversation by its first session's thread id; these helpers say which session serves it now
// (where the next message goes), which conversation a session's thread belongs to (to show its
// events in the conversation), and what counts as moving it elsewhere.

import { parseFallbackModel } from "../../shared/fallback-api";
import type { LinkSegment } from "../../shared/thread-links";
import { backendOfModel, backendOfThreadId, type BackendId } from "../fallback/model";
import type { AppState, TurnView } from "./state";

export type Segment = LinkSegment;

/** The backend a thread itself lives on (its own id; for a conversation, its first session's). */
export function homeOf(s: AppState, threadId: string): BackendId {
  return s.threadBackend[threadId] ?? backendOfThreadId(threadId) ?? "main";
}

/** A conversation's sessions, oldest first; one for a conversation that never moved. */
export function segmentsOf(s: AppState, id: string): Segment[] {
  return (
    s.links[id] ?? [
      { backend: homeOf(s, id), threadId: id, model: s.views[id]?.model ?? null, at: 0 },
    ]
  );
}

/** The session that serves the conversation now: where its next message goes. */
export function currentSegment(s: AppState, id: string): Segment {
  const segs = segmentsOf(s, id);
  const cur = segs[segs.length - 1];
  if (segs.length > 1) return cur;
  // A conversation's own (first) thread: the model it reported when opened, or listed with.
  const listed = s.views[id]?.thread.model ?? s.threads.find((t) => t.id === id)?.model ?? null;
  return { ...cur, model: s.views[id]?.model ?? listed };
}

/** The thread id the conversation's next request goes to. */
export function servingThreadId(s: AppState, id: string): string {
  return currentSegment(s, id).threadId;
}

const owners = new WeakMap<AppState["links"], Map<string, [string, number]>>();

/**
 * The conversation a later session's thread belongs to, and which session it is (1 and up);
 * null for a conversation's own thread or any other.
 */
export function ownerOf(s: AppState, threadId: string): { id: string; segment: number } | null {
  let m = owners.get(s.links);
  if (!m) {
    m = new Map();
    for (const [id, segs] of Object.entries(s.links))
      segs.forEach((seg, i) => i > 0 && m!.set(seg.threadId, [id, i]));
    owners.set(s.links, m);
  }
  const hit = m.get(threadId);
  return hit ? { id: hit[0], segment: hit[1] } : null;
}

/** The session that served a turn of the conversation. */
export function segmentOfTurn(s: AppState, id: string, turn: TurnView): Segment {
  const segs = segmentsOf(s, id);
  return segs[Math.min(turn.segment ?? 0, segs.length - 1)];
}

/**
 * What serves a model: its backend, and for the CLIs which one (Claude Code and Codex in the
 * background share a backend but not a session).
 */
export function serviceKey(backend: BackendId, model: string | null | undefined): string {
  if (backend !== "fallback") return backend;
  return `fallback:${parseFallbackModel(model)?.mode ?? "?"}`;
}

/**
 * Where a message on `model` goes for this conversation. A tier keeps the conversation on the
 * tier harness it was on (the stock one on "main", or an orchestrator); coming back to the tiers
 * from a fallback, the last one it used there; never on the tiers, the composer's choice.
 */
export function targetBackend(s: AppState, model: string, threadId: string | null): BackendId {
  const b = backendOfModel(model);
  if (b !== "main") return b;
  if (threadId) {
    const back = segmentsOf(s, threadId)
      .map((x) => x.backend)
      .findLast((x) => x === "main" || x === "orchestrator");
    if (back) return back;
  }
  return s.settings.orchestrator === "provenance" ? "main" : "orchestrator";
}

/** Sending on `model` moves this conversation to another backend session. */
export function movesConversation(s: AppState, threadId: string, model: string): boolean {
  const cur = currentSegment(s, threadId);
  const target = targetBackend(s, model, threadId);
  return serviceKey(target, model) !== serviceKey(cur.backend, cur.model);
}

/**
 * The tier session a conversation is on, or goes back to on a tier (its latest on "main" or the
 * orchestrator backend); null for one that never ran on the tiers.
 */
export function tierSegmentOf(s: AppState, id: string): Segment | null {
  return (
    segmentsOf(s, id).findLast((x) => x.backend === "main" || x.backend === "orchestrator") ?? null
  );
}
