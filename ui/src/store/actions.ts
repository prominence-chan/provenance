// Side-effecting actions: everything that talks to app-server lives here.
// Components call these; they never touch the RpcClient directly.

import type {
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  SandboxMode,
  SandboxPolicy,
  ServerRequest,
  Thread,
} from "../protocol";
import { RpcClient } from "../rpc/client";
import { applyNotification, turnFromProtocol, upsertThreadInList } from "./reducer";
import { saveSettings, type AppState, type Settings, type ThreadView } from "./state";
import { getState, setState } from "./store";

const HISTORY_TURNS = 50;

let noticeSeq = 1;

/** Generation of the app-server process we last initialized against (null = none yet). */
let readyGeneration: number | null = null;
let everReady = false;

export const rpc = new RpcClient({
  onSocketState: (open) => {
    if (!open) readyGeneration = null; // bridge may have restarted: re-sync on next ready
    setState((s) => ({ ...s, socketOpen: open }));
  },
  onBridgeStatus: (status) => {
    setState((s) => ({ ...s, bridge: status }));
    if (status.state === "ready" && status.generation !== readyGeneration) {
      readyGeneration = status.generation;
      void onReady(everReady);
      everReady = true;
    }
  },
  onNotification: (n) => {
    setState((s) => applyNotification(s, n));
    if (
      n.method === "warning" ||
      n.method === "configWarning" ||
      n.method === "deprecationNotice"
    ) {
      const p = n.params as { message?: string; summary?: string };
      notify("warn", p.message ?? p.summary ?? n.method);
    }
  },
  onServerRequest: (req) =>
    setState((s) =>
      s.serverRequests.some((r) => String(r.id) === String(req.id))
        ? s
        : { ...s, serverRequests: [...s.serverRequests, req] },
    ),
});

/** Called on first connect and whenever the bridge restarts app-server. */
async function onReady(reconnected: boolean): Promise<void> {
  await rpc.request("initialize", {
    clientInfo: { name: "provenance_ui", title: "Provenance UI", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  void refreshThreads();
  // After a reconnect/restart app-server may not have the thread loaded: re-attach.
  const sel = getState().selectedThreadId;
  if (sel) void openThread(sel, { force: reconnected || getState().views[sel]?.load !== "ready" });
}

export async function boot(): Promise<void> {
  const [info, tiers] = await Promise.all([
    fetch("/api/info").then((r) => r.json()) as Promise<{
      defaultCwd: string;
      cwdFromLauncher: boolean;
      defaultTier: string;
    }>,
    fetch("/api/tiers").then((r) => r.json()) as Promise<{ tiers: string[]; defaultTier: string }>,
  ]).catch(() => [null, null] as const);
  setState((s) => {
    const settings = { ...s.settings };
    // The launcher's directory wins; otherwise keep the last-used cwd.
    if (info && (info.cwdFromLauncher || !settings.cwd)) settings.cwd = info.defaultCwd;
    const list = tiers?.tiers?.length ? tiers.tiers : s.tiers;
    if (!list.includes(settings.model))
      settings.model = list.includes("solstice") ? "solstice" : list[0];
    return { ...s, settings, tiers: list };
  });
  rpc.connect();
}

export function notify(level: "info" | "warn" | "error", text: string): void {
  const id = noticeSeq++;
  setState((s) => ({ ...s, notices: [...s.notices, { id, level, text }] }));
  setTimeout(() => dismissNotice(id), level === "error" ? 10_000 : 6_000);
}

export function dismissNotice(id: number): void {
  setState((s) => ({ ...s, notices: s.notices.filter((n) => n.id !== id) }));
}

export function updateSettings(patch: Partial<Settings>): void {
  setState((s) => {
    const settings = { ...s.settings, ...patch };
    saveSettings(settings);
    return { ...s, settings };
  });
}

// ---- threads ---------------------------------------------------------------

export async function refreshThreads(): Promise<void> {
  setState((s) => ({ ...s, threadsLoading: true }));
  try {
    const res = await rpc.request("thread/list", { limit: 100, sortKey: "updated_at" });
    setState((s) => ({ ...s, threads: res.data, threadsLoading: false }));
  } catch (e) {
    setState((s) => ({ ...s, threadsLoading: false }));
    notify("error", `Couldn't list threads: ${errText(e)}`);
  }
}

export function newThread(): void {
  setState((s) => ({ ...s, selectedThreadId: null }));
}

/** Select a thread; resume it on app-server and load its history if needed. */
export async function openThread(threadId: string, opts: { force?: boolean } = {}): Promise<void> {
  setState((s) => ({ ...s, selectedThreadId: threadId }));
  const existing = getState().views[threadId];
  if (existing && existing.load !== "error" && !opts.force) return;

  const listed = getState().threads.find((t) => t.id === threadId);
  setState((s) => ({
    ...s,
    views: {
      ...s.views,
      [threadId]: existing
        ? { ...existing, load: "loading" }
        : listed
          ? blankView(listed, "loading")
          : blankView({ id: threadId } as Thread, "loading"),
    },
  }));
  try {
    // Resume subscribes this connection to the thread's live events.
    const resumed = await rpc.request("thread/resume", { threadId, excludeTurns: true });
    const history = await rpc.request("thread/turns/list", {
      threadId,
      limit: HISTORY_TURNS,
      sortDirection: "desc",
      itemsView: "full",
    });
    const turns = history.data.slice().reverse().map(turnFromProtocol);
    setState((s) => {
      const prev = s.views[threadId];
      // Keep any turn that streamed in while we were fetching history.
      const live = (prev?.turns ?? []).filter((t) => !turns.some((h) => h.id === t.id));
      const view: ThreadView = {
        ...(prev ?? blankView(resumed.thread, "ready")),
        thread: resumed.thread,
        load: "ready",
        turns: [...turns, ...live],
        model: resumed.model,
        cwd: resumed.cwd,
      };
      return {
        ...upsertThreadInList(s, resumed.thread, false),
        views: { ...s.views, [threadId]: view },
      };
    });
  } catch (e) {
    setState((s) => {
      const prev = s.views[threadId];
      return prev
        ? {
            ...s,
            views: { ...s.views, [threadId]: { ...prev, load: "error", loadError: errText(e) } },
          }
        : s;
    });
  }
}

export async function archiveThread(threadId: string): Promise<void> {
  try {
    await rpc.request("thread/archive", { threadId });
    setState((s) => ({
      ...s,
      threads: s.threads.filter((t) => t.id !== threadId),
      selectedThreadId: s.selectedThreadId === threadId ? null : s.selectedThreadId,
    }));
  } catch (e) {
    notify("error", `Archive failed: ${errText(e)}`);
  }
}

// ---- turns -----------------------------------------------------------------

/** Send a message: starts a new thread first when on the "new thread" screen. */
export async function sendMessage(text: string, cwdInput?: string): Promise<void> {
  const { settings } = getState();
  let threadId = getState().selectedThreadId;
  const cwd = (cwdInput ?? settings.cwd).trim();
  // Only override an existing thread's cwd when the user changed it.
  const cwdOverride = threadId && cwd === getState().views[threadId]?.cwd ? null : cwd || null;
  setState((s) => ({ ...s, sending: true }));
  try {
    if (!threadId) {
      const started = await rpc.request("thread/start", {
        model: settings.model,
        cwd: cwd || null,
        approvalPolicy: settings.approvalPolicy,
        sandbox: settings.sandbox,
      });
      threadId = started.thread.id;
      const view: ThreadView = {
        ...blankView(started.thread, "ready"),
        model: started.model,
        cwd: started.cwd,
      };
      setState((s) => ({
        ...upsertThreadInList(s, started.thread, true),
        views: { ...s.views, [threadId!]: view },
        selectedThreadId: threadId,
      }));
    }
    const res = await rpc.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      // Per-turn overrides: these stick for subsequent turns too.
      model: settings.model,
      cwd: cwdOverride,
      approvalPolicy: settings.approvalPolicy,
      sandboxPolicy: sandboxPolicyFor(settings.sandbox),
    });
    const tid = threadId;
    setState((s) => {
      const v = s.views[tid];
      if (!v) return s;
      const model = settings.model;
      const turns = v.turns.some((t) => t.id === res.turn.id)
        ? v.turns.map((t) => (t.id === res.turn.id ? { ...t, model } : t))
        : [...v.turns, { ...turnFromProtocol(res.turn), model }];
      return {
        ...s,
        views: {
          ...s.views,
          [tid]: { ...v, turns, cwd: cwdOverride ?? v.cwd, model: settings.model },
        },
      };
    });
  } catch (e) {
    notify("error", errText(e));
  } finally {
    setState((s) => ({ ...s, sending: false }));
  }
}

export async function interrupt(threadId: string): Promise<void> {
  const v = getState().views[threadId];
  const turn = v?.turns.findLast((t) => t.status === "inProgress");
  if (!turn) return;
  try {
    await rpc.request("turn/interrupt", { threadId, turnId: turn.id });
  } catch (e) {
    notify("error", `Interrupt failed: ${errText(e)}`);
  }
}

// ---- approvals -------------------------------------------------------------

export function answerCommandApproval(
  req: ServerRequest,
  decision: CommandExecutionApprovalDecision,
): void {
  rpc.respond(req.id, { decision });
  dropServerRequest(req);
}

export function answerFileChangeApproval(
  req: ServerRequest,
  decision: FileChangeApprovalDecision,
): void {
  rpc.respond(req.id, { decision });
  dropServerRequest(req);
}

/** For server requests the UI doesn't implement yet: reply with a JSON-RPC error. */
export function rejectServerRequest(req: ServerRequest): void {
  rpc.respondError(req.id, -32601, `provenance-ui does not support ${req.method} yet`);
  dropServerRequest(req);
}

function dropServerRequest(req: ServerRequest): void {
  setState((s) => ({
    ...s,
    serverRequests: s.serverRequests.filter((r) => String(r.id) !== String(req.id)),
  }));
}

// ---- utils -----------------------------------------------------------------

function blankView(thread: Thread, load: ThreadView["load"]): ThreadView {
  return {
    id: thread.id,
    thread,
    load,
    turns: [],
    tokenUsage: null,
    model: thread.model ?? null,
    cwd: thread.cwd ?? null,
  };
}

function sandboxPolicyFor(mode: SandboxMode): SandboxPolicy {
  switch (mode) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [], // cwd is always writable in workspace-write
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type { AppState };
