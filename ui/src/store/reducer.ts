// Pure state transitions for app-server notifications.
//
// app-server streams a thread as: turn/started -> item/started -> deltas ->
// item/completed ... -> turn/completed. Items are keyed by id inside their turn;
// deltas append to the matching item. `item/completed` carries the final item
// and replaces whatever we accumulated.
//
// To support a new notification: add a `case` below (the switch is typed off the
// generated ServerNotification union, so params are fully typed).

import type { ServerNotification, Thread, ThreadItem, Turn } from "../protocol";
import type { AppState, ThreadView, TurnView } from "./state";

export function applyNotification(state: AppState, n: ServerNotification): AppState {
  switch (n.method) {
    case "thread/started":
      return upsertThreadInList(state, n.params.thread, true);

    case "thread/status/changed":
      return patchThread(state, n.params.threadId, { status: n.params.status });

    case "thread/name/updated":
      return patchThread(state, n.params.threadId, { name: n.params.threadName ?? null });

    case "thread/archived":
    case "thread/deleted":
      return { ...state, threads: state.threads.filter((t) => t.id !== n.params.threadId) };

    case "thread/tokenUsage/updated":
      return updateView(state, n.params.threadId, (v) => ({
        ...v,
        tokenUsage: n.params.tokenUsage,
      }));

    case "turn/started": {
      const s = bumpThread(state, n.params.threadId);
      return updateView(s, n.params.threadId, (v) => upsertTurn(v, n.params.turn));
    }

    case "turn/completed":
      return updateView(state, n.params.threadId, (v) => upsertTurn(v, n.params.turn));

    case "turn/diff/updated":
      return updateTurn(state, n.params.threadId, n.params.turnId, (t) => ({
        ...t,
        diff: n.params.diff,
      }));

    case "turn/plan/updated":
      return updateTurn(state, n.params.threadId, n.params.turnId, (t) => ({
        ...t,
        plan: n.params.plan,
      }));

    case "item/started":
    case "item/completed": {
      const { threadId, turnId, item } = n.params;
      let s = state;
      // A brand-new thread has an empty preview until the list is refetched.
      if (item.type === "userMessage") {
        const t = s.threads.find((x) => x.id === threadId);
        const text = item.content.find((c) => c.type === "text");
        if (t && !t.preview && text?.type === "text")
          s = patchThread(s, threadId, { preview: text.text });
      }
      return updateTurn(s, threadId, turnId, (t) => upsertItem(t, item));
    }

    case "item/agentMessage/delta": {
      const { threadId, turnId, itemId, delta } = n.params;
      return updateItem(state, threadId, turnId, itemId, (it) =>
        it.type === "agentMessage" ? { ...it, text: it.text + delta } : it,
      );
    }

    case "item/plan/delta": {
      const { threadId, turnId, itemId, delta } = n.params;
      return updateItem(state, threadId, turnId, itemId, (it) =>
        it.type === "plan" ? { ...it, text: it.text + delta } : it,
      );
    }

    case "item/reasoning/summaryPartAdded": {
      const { threadId, turnId, itemId, summaryIndex } = n.params;
      return updateItem(state, threadId, turnId, itemId, (it) =>
        it.type === "reasoning"
          ? { ...it, summary: setAt(it.summary, summaryIndex, (s) => s) }
          : it,
      );
    }

    case "item/reasoning/summaryTextDelta": {
      const { threadId, turnId, itemId, summaryIndex, delta } = n.params;
      return updateItem(state, threadId, turnId, itemId, (it) =>
        it.type === "reasoning"
          ? { ...it, summary: setAt(it.summary, summaryIndex, (s) => s + delta) }
          : it,
      );
    }

    case "item/reasoning/textDelta": {
      const { threadId, turnId, itemId, contentIndex, delta } = n.params;
      return updateItem(state, threadId, turnId, itemId, (it) =>
        it.type === "reasoning"
          ? { ...it, content: setAt(it.content, contentIndex, (s) => s + delta) }
          : it,
      );
    }

    case "item/commandExecution/outputDelta": {
      const { threadId, turnId, itemId, delta } = n.params;
      return updateItem(state, threadId, turnId, itemId, (it) =>
        it.type === "commandExecution"
          ? { ...it, aggregatedOutput: (it.aggregatedOutput ?? "") + delta }
          : it,
      );
    }

    case "item/fileChange/patchUpdated": {
      const { threadId, turnId, itemId, changes } = n.params;
      return updateItem(state, threadId, turnId, itemId, (it) =>
        it.type === "fileChange" ? { ...it, changes } : it,
      );
    }

    case "error": {
      const { threadId, turnId, error, willRetry } = n.params;
      return updateTurn(state, threadId, turnId, (t) => ({
        ...t,
        errors: [...t.errors, { message: error.message, willRetry }],
      }));
    }

    case "serverRequest/resolved":
      return {
        ...state,
        serverRequests: state.serverRequests.filter(
          (r) => String(r.id) !== String(n.params.requestId),
        ),
      };

    default:
      return state;
  }
}

// ---- helpers ---------------------------------------------------------------

export function emptyTurn(id: string): TurnView {
  return {
    id,
    status: "inProgress",
    error: null,
    durationMs: null,
    items: [],
    errors: [],
    diff: null,
    plan: null,
  };
}

export function turnFromProtocol(turn: Turn): TurnView {
  return {
    ...emptyTurn(turn.id),
    status: turn.status,
    error: turn.error,
    durationMs: turn.durationMs,
    items: turn.items,
  };
}

function upsertTurn(v: ThreadView, turn: Turn): ThreadView {
  const idx = v.turns.findIndex((t) => t.id === turn.id);
  if (idx === -1) return { ...v, turns: [...v.turns, turnFromProtocol(turn)] };
  const prev = v.turns[idx];
  // turn/completed carries only a summary of items; keep the streamed ones.
  const next: TurnView = {
    ...prev,
    status: turn.status,
    error: turn.error,
    durationMs: turn.durationMs,
    items: prev.items.length ? prev.items : turn.items,
  };
  return { ...v, turns: replaceAt(v.turns, idx, next) };
}

function upsertItem(t: TurnView, item: ThreadItem): TurnView {
  const idx = t.items.findIndex((i) => i.id === item.id);
  return { ...t, items: idx === -1 ? [...t.items, item] : replaceAt(t.items, idx, item) };
}

function updateView(
  state: AppState,
  threadId: string,
  fn: (v: ThreadView) => ThreadView,
): AppState {
  const v = state.views[threadId];
  if (!v) return state;
  return { ...state, views: { ...state.views, [threadId]: fn(v) } };
}

function updateTurn(
  state: AppState,
  threadId: string,
  turnId: string,
  fn: (t: TurnView) => TurnView,
): AppState {
  return updateView(state, threadId, (v) => {
    const idx = v.turns.findIndex((t) => t.id === turnId);
    if (idx === -1) return { ...v, turns: [...v.turns, fn(emptyTurn(turnId))] };
    return { ...v, turns: replaceAt(v.turns, idx, fn(v.turns[idx])) };
  });
}

function updateItem(
  state: AppState,
  threadId: string,
  turnId: string,
  itemId: string,
  fn: (it: ThreadItem) => ThreadItem,
): AppState {
  return updateTurn(state, threadId, turnId, (t) => {
    const idx = t.items.findIndex((i) => i.id === itemId);
    if (idx === -1) return t; // delta before item/started: ignore, item/completed will carry the full item
    return { ...t, items: replaceAt(t.items, idx, fn(t.items[idx])) };
  });
}

export function upsertThreadInList(state: AppState, thread: Thread, prepend: boolean): AppState {
  const idx = state.threads.findIndex((t) => t.id === thread.id);
  const threads =
    idx === -1
      ? prepend
        ? [thread, ...state.threads]
        : [...state.threads, thread]
      : replaceAt(state.threads, idx, { ...state.threads[idx], ...thread, turns: [] });
  return { ...state, threads };
}

/** Mark a thread as just-updated and move it to the top of the sidebar. */
function bumpThread(state: AppState, threadId: string): AppState {
  const t = state.threads.find((x) => x.id === threadId);
  if (!t) return state;
  const bumped = { ...t, updatedAt: Math.floor(Date.now() / 1000) };
  return { ...state, threads: [bumped, ...state.threads.filter((x) => x.id !== threadId)] };
}

function patchThread(state: AppState, threadId: string, patch: Partial<Thread>): AppState {
  const threads = state.threads.map((t) => (t.id === threadId ? { ...t, ...patch } : t));
  const v = state.views[threadId];
  const views = v
    ? { ...state.views, [threadId]: { ...v, thread: { ...v.thread, ...patch } } }
    : state.views;
  return { ...state, threads, views };
}

function replaceAt<T>(arr: T[], idx: number, value: T): T[] {
  const copy = arr.slice();
  copy[idx] = value;
  return copy;
}

function setAt(arr: string[], idx: number, fn: (s: string) => string): string[] {
  const copy = arr.slice();
  while (copy.length <= idx) copy.push("");
  copy[idx] = fn(copy[idx]);
  return copy;
}
