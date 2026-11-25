import { useSyncExternalStore } from "react";
import type { Thread, ThreadItem, v2 } from "../protocol";
import type { ThreadView } from "../store/state";

export interface SubagentEvent {
  id: string;
  verb: string;
  status: string;
  prompt: string | null;
  message: string | null;
}

export interface SubagentInfo {
  id: string;
  name: string;
  role: string | null;
  status: v2.CollabAgentStatus;
  model: string | null;
  reasoningEffort: string | null;
  prompt: string | null;
  message: string | null;
  agentPath: string | null;
  toolCalls: number;
  events: SubagentEvent[];
  thread: Thread | null;
  order: number;
}

export function isSubagentActive(status: v2.CollabAgentStatus): boolean {
  return status === "running" || status === "pendingInit";
}

export function subagentStatusLabel(status: v2.CollabAgentStatus): string {
  switch (status) {
    case "pendingInit":
      return "Starting";
    case "running":
      return "Running";
    case "completed":
      return "Done";
    case "errored":
      return "Failed";
    case "interrupted":
      return "Stopped";
    case "shutdown":
      return "Closed";
    case "notFound":
      return "Not found";
  }
}

export function formatCollabVerb(tool: v2.CollabAgentTool, inProgress: boolean): string {
  switch (tool) {
    case "spawnAgent":
      return inProgress ? "Spawning subagent" : "Spawned subagent";
    case "sendInput":
    case "sendMessage":
      return inProgress ? "Messaging subagent" : "Messaged subagent";
    case "followupTask":
      return inProgress ? "Sending follow-up" : "Sent follow-up";
    case "resumeAgent":
      return inProgress ? "Resuming subagent" : "Resumed subagent";
    case "wait":
      return inProgress ? "Waiting for subagents" : "Waited for subagents";
    case "interruptAgent":
      return inProgress ? "Stopping subagent" : "Stopped subagent";
    case "closeAgent":
      return inProgress ? "Closing subagent" : "Closed subagent";
    case "listAgents":
      return inProgress ? "Listing subagents" : "Listed subagents";
  }
}

export function formatActivityVerb(kind: v2.SubAgentActivityKind): string {
  switch (kind) {
    case "started":
      return "Subagent started";
    case "interacted":
      return "Subagent updated";
    case "interrupted":
      return "Subagent stopped";
    case "completed":
      return "Subagent finished";
  }
}

function mapActivityStatus(kind: v2.SubAgentActivityKind): v2.CollabAgentStatus {
  switch (kind) {
    case "started":
    case "interacted":
      return "running";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "completed";
  }
}

function fallbackName(id: string, path: string | null, index: number): string {
  if (path) {
    const clean = path.replace(/^\/+|\/+$/g, "");
    const tail = clean.split("/").pop();
    if (tail) return tail;
  }
  if (id.length <= 16 && /^[a-zA-Z0-9._-]+$/.test(id)) return id;
  return `Subagent ${index}`;
}

/** Collect all subagents spawned or interacted with in a thread, enriched with child thread info. */
export function collectSubagents(
  view: ThreadView | undefined,
  allThreads: Thread[],
): SubagentInfo[] {
  if (!view) return [];
  const byId = new Map<string, SubagentInfo>();
  const childById = new Map<string, Thread>();
  for (const t of allThreads) childById.set(t.id, t);

  let seq = 0;
  const ensure = (id: string): SubagentInfo => {
    let cur = byId.get(id);
    if (!cur) {
      const child = childById.get(id) ?? null;
      cur = {
        id,
        name: child?.agentNickname || child?.name || fallbackName(id, null, ++seq),
        role: child?.agentRole ?? null,
        status: child?.status.type === "active" ? "running" : "pendingInit",
        model: child?.model ?? null,
        reasoningEffort: child?.reasoningEffort ?? null,
        prompt: child?.preview || null,
        message: null,
        agentPath: null,
        toolCalls: 0,
        events: [],
        thread: child,
        order: byId.size,
      };
      byId.set(id, cur);
    }
    return cur;
  };

  const visitItem = (item: ThreadItem) => {
    if (item.type === "collabAgentToolCall") {
      const ids = new Set<string>([
        ...item.receiverThreadIds,
        ...Object.keys(item.agentsStates ?? {}),
      ]);
      for (const id of ids) {
        if (!id) continue;
        const entry = ensure(id);
        entry.toolCalls++;
        if (item.prompt && (!entry.prompt || item.tool === "spawnAgent")) {
          entry.prompt = item.prompt;
        }
        if (item.model && !entry.model) entry.model = item.model;
        if (item.reasoningEffort && !entry.reasoningEffort)
          entry.reasoningEffort = item.reasoningEffort;
        const st = item.agentsStates?.[id];
        if (st) {
          entry.status = st.status;
          if (st.message) entry.message = st.message;
        } else if (item.tool === "spawnAgent") {
          if (item.status === "failed") entry.status = "errored";
          else if (item.status === "interrupted") entry.status = "interrupted";
          else if (entry.status === "pendingInit") entry.status = "running";
        } else if (item.tool === "closeAgent" && item.status === "completed") {
          entry.status = "shutdown";
        } else if (item.tool === "interruptAgent" && item.status === "completed") {
          entry.status = "interrupted";
        }
        entry.events.push({
          id: `${item.id}:${id}`,
          verb: formatCollabVerb(item.tool, item.status === "inProgress"),
          status: subagentStatusLabel(st?.status ?? entry.status),
          prompt: item.prompt ?? null,
          message: st?.message ?? null,
        });
      }
    } else if (item.type === "subAgentActivity") {
      const entry = ensure(item.agentThreadId);
      entry.agentPath = item.agentPath || entry.agentPath;
      if (item.agentPath && !entry.thread?.agentNickname && !entry.thread?.name) {
        entry.name = fallbackName(entry.id, item.agentPath, entry.order + 1);
      }
      if (item.model && !entry.model) entry.model = item.model;
      if (item.reasoningEffort && !entry.reasoningEffort)
        entry.reasoningEffort = item.reasoningEffort;
      entry.status = mapActivityStatus(item.kind);
      entry.events.push({
        id: item.id,
        verb: formatActivityVerb(item.kind),
        status: subagentStatusLabel(entry.status),
        prompt: null,
        message: null,
      });
    }
  };

  for (const turn of view.turns) {
    for (const item of turn.items) visitItem(item);
  }

  for (const t of allThreads) {
    if (t.parentThreadId !== view.id) continue;
    const entry = ensure(t.id);
    entry.thread = t;
    if (t.agentNickname || t.name) entry.name = t.agentNickname || t.name || entry.name;
    if (t.agentRole) entry.role = t.agentRole;
    if (t.model && !entry.model) entry.model = t.model;
    if (t.preview && !entry.prompt) entry.prompt = t.preview;
    if (t.status.type === "active") entry.status = "running";
    else if (t.status.type === "systemError") entry.status = "errored";
    else if (entry.status === "pendingInit") entry.status = "completed";
  }

  return [...byId.values()].sort((a, b) => a.order - b.order);
}

// ---- right panel open / focus state ---------------------------------------------------------

const OVERLAY_MQ = "(max-width: 1120px)";
const overlayMedia = typeof window !== "undefined" ? window.matchMedia(OVERLAY_MQ) : null;

interface PanelState {
  /** Per thread: explicit user toggle ("open" | "closed"). Absent = auto-open on wide screens only. */
  byThread: Record<string, "open" | "closed">;
  focusedId: string | null;
  /** Subagent currently drilled into inside the right panel (null = list view). */
  inspectedId: string | null;
  overlay: boolean;
}

let panel: PanelState = {
  byThread: {},
  focusedId: null,
  inspectedId: null,
  overlay: overlayMedia?.matches ?? false,
};
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
overlayMedia?.addEventListener("change", (e) => {
  panel = { ...panel, overlay: e.matches };
  emit();
});

export function useSubagentsPanel(): PanelState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => panel,
  );
}

export function isSubagentsPanelOpen(
  state: PanelState,
  threadId: string | null,
  hasSubagents: boolean,
): boolean {
  if (!threadId || !hasSubagents) return false;
  const pref = state.byThread[threadId];
  if (pref) return pref === "open";
  return !state.overlay;
}

export function toggleSubagentsPanel(threadId: string, open?: boolean): void {
  const currentlyOpen = isSubagentsPanelOpen(panel, threadId, true);
  const next = open ?? !currentlyOpen;
  panel = {
    ...panel,
    byThread: { ...panel.byThread, [threadId]: next ? "open" : "closed" },
  };
  emit();
}

export function focusSubagent(threadId: string, agentId: string): void {
  panel = {
    ...panel,
    byThread: { ...panel.byThread, [threadId]: "open" },
    focusedId: agentId,
    inspectedId: agentId,
  };
  emit();
}

export function inspectSubagent(threadId: string, agentId: string | null): void {
  panel = {
    ...panel,
    ...(agentId ? { byThread: { ...panel.byThread, [threadId]: "open" } } : {}),
    focusedId: agentId ?? panel.focusedId,
    inspectedId: agentId,
  };
  emit();
}
