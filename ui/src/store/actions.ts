// Side-effecting actions: everything that talks to app-server lives here.
// Components call these; they never touch the RpcClient directly.
//
// Four backends speak the same protocol (fallback/model.ts): the main app-server on the tiers
// (/rpc), a second one for "Codex through Provenance" (/rpc/codex, connected once that mode is
// on or was used), the Claude Code / Codex CLI threads (/rpc/fallback), and the tier threads an
// experimental orchestrator drives (/rpc/orchestrator). Threads from all of them share one list
// and one store; each request goes to the thread's own backend.

import type { FallbacksInfo } from "../../shared/fallback-api";
import { threadBrief } from "../fallback/brief";
import { chosenEffort } from "../fallback/effort";
import {
  backendOfModel,
  backendOfThreadId,
  modelKeyFor,
  wireModel,
  type BackendId,
} from "../fallback/model";
import type {
  BridgeStatus,
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  SandboxMode,
  SandboxPolicy,
  ServerNotification,
  ServerRequest,
  Thread,
} from "../protocol";
import { RpcClient } from "../rpc/client";
import { isAssistView } from "../setup/assist-text";
import { splitModel } from "../theme/tiers";
import { applyNotification, turnFromProtocol, upsertThreadInList } from "./reducer";
import {
  saveSettings,
  type AppState,
  type Settings,
  type Source,
  type ThreadView,
  type TurnUsage,
  type TurnView,
} from "./state";
import { getState, setState } from "./store";

const HISTORY_TURNS = 50;

let noticeSeq = 1;

/** Per backend: generation of the process we last initialized against (null = none yet). */
const readyGeneration: Record<BackendId, number | null> = {
  main: null,
  codex: null,
  fallback: null,
  orchestrator: null,
};
const everReady: Record<BackendId, boolean> = {
  main: false,
  codex: false,
  fallback: false,
  orchestrator: false,
};
const readyWaiters: Record<BackendId, (() => void)[]> = {
  main: [],
  codex: [],
  fallback: [],
  orchestrator: [],
};

/** A server request (approval) as kept in the store: which backend asked. */
type TaggedRequest = ServerRequest & { _backend?: BackendId };

function makeClient(id: BackendId): RpcClient {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}${id === "main" ? "/rpc" : `/rpc/${id}`}`;
  return new RpcClient(
    {
      onSocketState: (open) => {
        if (!open) readyGeneration[id] = null; // bridge may have restarted: re-sync on next ready
        setState((s) => ({
          ...s,
          ...(id === "main" ? { socketOpen: open } : {}),
          backendReady: { ...s.backendReady, [id]: open && s.backendReady[id] },
        }));
      },
      onBridgeStatus: (status: BridgeStatus) => {
        setState((s) => ({
          ...s,
          ...(id === "main" ? { bridge: status } : {}),
          backendReady: { ...s.backendReady, [id]: status.state === "ready" },
        }));
        if (status.state === "ready" && status.generation !== readyGeneration[id]) {
          readyGeneration[id] = status.generation;
          void onReady(id, everReady[id]);
          everReady[id] = true;
        }
      },
      onNotification: (n) => onNotification(id, n),
      onServerRequest: (req) =>
        setState((s) =>
          s.serverRequests.some(
            (r) => String(r.id) === String(req.id) && (r as TaggedRequest)._backend === id,
          )
            ? s
            : { ...s, serverRequests: [...s.serverRequests, tagRequest(req, id)] },
        ),
    },
    url,
  );
}

function tagRequest(req: ServerRequest, id: BackendId): ServerRequest {
  const tagged: TaggedRequest = { ...req };
  tagged._backend = id;
  return tagged;
}

function onNotification(id: BackendId, n: ServerNotification): void {
  if (n.method === "serverRequest/resolved") {
    // Request ids are per app-server: only this backend's request is resolved.
    const rid = String(n.params.requestId);
    setState((s) => ({
      ...s,
      serverRequests: s.serverRequests.filter(
        (r) => !(String(r.id) === rid && ((r as TaggedRequest)._backend ?? "main") === id),
      ),
    }));
    return;
  }
  setState((s) => {
    let next = applyNotification(s, n);
    if (n.method === "thread/started" && next.threadBackend[n.params.thread.id] !== id)
      next = { ...next, threadBackend: { ...next.threadBackend, [n.params.thread.id]: id } };
    return next;
  });
  if (n.method === "warning" || n.method === "configWarning" || n.method === "deprecationNotice") {
    const p = n.params as { message?: string; summary?: string };
    notify("warn", p.message ?? p.summary ?? n.method);
  }
}

export const rpc = makeClient("main");
const clients: Record<BackendId, RpcClient> = {
  main: rpc,
  codex: makeClient("codex"),
  fallback: makeClient("fallback"),
  orchestrator: makeClient("orchestrator"),
};
const connected = new Set<BackendId>();

function connect(id: BackendId): void {
  if (connected.has(id)) return;
  connected.add(id);
  clients[id].connect();
}

/** Connect a backend if needed and wait until it is ready (it may be starting up). */
async function ensureBackend(id: BackendId, timeoutMs = 30_000): Promise<void> {
  connect(id);
  if (getState().backendReady[id] && readyGeneration[id] !== null) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(new Error(id === "codex" ? "Codex through Provenance didn't start" : "not ready")),
      timeoutMs,
    );
    readyWaiters[id].push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

const CODEX_USED_KEY = "provenance-ui.codex-pv-used";
function codexUsed(): boolean {
  try {
    return !!localStorage.getItem(CODEX_USED_KEY);
  } catch {
    return false;
  }
}

/** Which backend a thread lives on. */
export function backendOf(threadId: string): BackendId {
  return getState().threadBackend[threadId] ?? backendOfThreadId(threadId) ?? "main";
}

const clientFor = (threadId: string) => clients[backendOf(threadId)];

/**
 * Where a message on `model` goes. A tier thread stays with the orchestrator it was started with
 * (the stock harness on "main", or the orchestrator backend); a new tier thread follows the
 * composer's orchestrator choice.
 */
function targetBackend(model: string, threadId: string | null): BackendId {
  const b = backendOfModel(model);
  if (b !== "main") return b;
  const cur = threadId ? backendOf(threadId) : null;
  if (cur === "main" || cur === "orchestrator") return cur;
  return getState().settings.orchestrator === "provenance" ? "main" : "orchestrator";
}

/** Called on first connect and whenever a backend restarts. */
async function onReady(id: BackendId, reconnected: boolean): Promise<void> {
  await clients[id].request("initialize", {
    clientInfo: { name: "provenance_ui", title: "Provenance UI", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  for (const w of readyWaiters[id].splice(0)) w();
  void refreshThreads();
  // After a reconnect/restart app-server may not have the thread loaded: re-attach.
  const sel = getState().selectedThreadId;
  if (sel && backendOf(sel) === id)
    void openThread(sel, { force: reconnected || getState().views[sel]?.load !== "ready" });
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
    settings.model = validModel(settings.model, list);
    return { ...s, settings, tiers: list };
  });
  connect("main");
  connect("fallback");
  connect("orchestrator");
  if (getState().settings.fallbacks.codex === "provenance" || codexUsed()) connect("codex");
  void refreshSources(); // once, so a pinned source shows its label; the picker refreshes it
  void refreshFallbacks();
}

/** Claude Code / Codex health and models (GET /api/fallbacks); `force` checks again now. */
export async function refreshFallbacks(force = false): Promise<FallbacksInfo | null> {
  try {
    const info = (await (
      await fetch(`/api/fallbacks${force ? "?refresh=1" : ""}`)
    ).json()) as FallbacksInfo;
    if (!info?.claude || !info?.codex) return null;
    setState((s) => ({ ...s, fallbackInfo: info }));
    return info;
  } catch {
    return null;
  }
}

/** Turn a fallback on or off (Models & accounts -> Fallbacks, the welcome). */
export function setFallbackPrefs(patch: Partial<Settings["fallbacks"]>): void {
  const fallbacks = { ...getState().settings.fallbacks, ...patch };
  const model = getState().settings.model;
  // A model of a fallback that was just turned off goes back to the default tier.
  const m = /^(claude|codex|codex-pv):/.exec(model)?.[1];
  const off =
    (m === "claude" && !fallbacks.claude) ||
    (m === "codex" && fallbacks.codex !== "background") ||
    (m === "codex-pv" && fallbacks.codex !== "provenance");
  updateSettings({ fallbacks, ...(off ? { model: validModel(null, getState().tiers) } : {}) });
  if (fallbacks.codex === "provenance") connect("codex");
}

/** Keep a saved model whose tier still exists (pinned "luna/solstice" included), else the default. */
function validModel(model: unknown, tiers: string[]): string {
  if (typeof model === "string" && tiers.includes(splitModel(model).tier)) return model;
  if (typeof model === "string" && /^(claude|codex|codex-pv):/.test(model)) return model; // a fallback
  return tiers.includes("solstice") ? "solstice" : tiers[0];
}

/**
 * Re-read which sources serve each tier (GET /api/sources). Called when the tier picker
 * opens, not on a timer. Router down or too old to list sources: an empty map, and the
 * picker shows the plain tiers as before.
 */
export async function refreshSources(): Promise<void> {
  let sources: Record<string, Source[]> = {};
  try {
    const body = (await (await fetch("/api/sources")).json()) as { tiers?: unknown };
    sources = parseSources(body.tiers);
  } catch {
    // leave it empty
  }
  setState((s) => ({ ...s, sources }));
}

function parseSources(tiers: unknown): Record<string, Source[]> {
  const out: Record<string, Source[]> = {};
  if (!Array.isArray(tiers)) return out;
  for (const t of tiers as { tier?: unknown; sources?: unknown }[]) {
    if (typeof t?.tier !== "string" || !Array.isArray(t.sources)) continue;
    out[t.tier] = (t.sources as Record<string, unknown>[])
      .filter((x) => typeof x?.model === "string" && typeof x?.id === "string")
      .map((x) => ({
        id: x.id as string,
        label: typeof x.label === "string" && x.label ? x.label : (x.id as string),
        kind: typeof x.kind === "string" ? x.kind : "",
        model: x.model as string,
        remaining: typeof x.remaining === "number" ? x.remaining : null,
        busy: typeof x.busy === "number" ? x.busy : 0,
        available: x.available !== false,
        pinnable: x.pinnable === true,
        needs: x.needs === "keys" || x.needs === "signin" ? x.needs : null,
      }));
  }
  return out;
}

/** Re-read the tier list (e.g. once provenance-core comes up after launch). */
export async function refreshTiers(): Promise<void> {
  try {
    const t = (await (await fetch("/api/tiers")).json()) as { tiers: string[] };
    if (!t.tiers?.length) return;
    setState((s) => {
      const settings = { ...s.settings, model: validModel(s.settings.model, t.tiers) };
      return { ...s, settings, tiers: t.tiers };
    });
  } catch {
    // keep the current list
  }
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

/** Every ready backend's threads, in one list, most recent first. */
export async function refreshThreads(): Promise<void> {
  setState((s) => ({ ...s, threadsLoading: true }));
  const ids = [...connected].filter((id) => getState().backendReady[id]);
  const results = await Promise.all(
    ids.map((id) =>
      clients[id]
        .request("thread/list", { limit: 100, sortKey: "updated_at" })
        .then((r) => ({ id, threads: r.data, error: null as unknown }))
        .catch((error: unknown) => ({ id, threads: null as Thread[] | null, error })),
    ),
  );
  const mainError = results.find((r) => r.id === "main" && r.error)?.error;
  setState((s) => {
    const fetched = new Map(results.filter((r) => r.threads).map((r) => [r.id, r.threads!]));
    const threadBackend = { ...s.threadBackend };
    const all: Thread[] = [];
    for (const [id, list] of fetched) {
      for (const t of list) threadBackend[t.id] = id;
      all.push(...list);
    }
    // A backend that didn't answer this time keeps the threads it had.
    for (const t of s.threads) {
      const b = threadBackend[t.id] ?? "main";
      if (!fetched.has(b) && !all.some((x) => x.id === t.id)) all.push(t);
    }
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return { ...s, threads: all, threadBackend, threadsLoading: false };
  });
  if (mainError) notify("error", `Couldn't list threads: ${errText(mainError)}`);
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
  const backend = backendOf(threadId);
  const client = clients[backend];
  try {
    if (backend !== "main") await ensureBackend(backend);
    // Resume subscribes this connection to the thread's live events.
    const resumed = await client.request("thread/resume", { threadId, excludeTurns: true });
    const history = await client.request("thread/turns/list", {
      threadId,
      limit: HISTORY_TURNS,
      sortDirection: "desc",
      itemsView: "full",
    });
    const turns = history.data.slice().reverse().map(turnFromProtocol);
    const model = modelKeyFor(backend, resumed.model);
    setState((s) => {
      const prev = s.views[threadId];
      // Keep any turn that streamed in while we were fetching history.
      const live = (prev?.turns ?? []).filter((t) => !turns.some((h) => h.id === t.id));
      const view: ThreadView = {
        ...(prev ?? blankView(resumed.thread, "ready")),
        thread: resumed.thread,
        load: "ready",
        turns: [...turns, ...live],
        model,
        cwd: resumed.cwd,
      };
      return {
        ...upsertThreadInList(s, resumed.thread, false),
        views: { ...s.views, [threadId]: view },
        threadBackend: { ...s.threadBackend, [threadId]: backend },
      };
    });
    // A thread stays on what it runs on: opening one that lives elsewhere (Claude Code, Codex)
    // points the picker at its model, so the next message continues it there.
    const cur = getState().settings.model;
    if (
      model &&
      getState().selectedThreadId === threadId &&
      targetBackend(cur, threadId) !== backend
    )
      updateSettings({ model });
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
    await clientFor(threadId).request("thread/archive", { threadId });
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

/** What a send can pin instead of the composer's settings (the token pool's setup assistant). */
export interface SendOptions {
  /** Send to this thread (null: start a new one), whatever is selected. */
  threadId?: string | null;
  model?: string;
  approvalPolicy?: Settings["approvalPolicy"];
  sandbox?: SandboxMode;
  /** A new thread's name. */
  name?: string;
}

/** The setup assistant's thread: read only, in its own scratch folder, on its own fallback. */
const ASSIST_PRESET = { approvalPolicy: "on-request", sandbox: "read-only" } as const;

/**
 * Send a message: starts a new thread first when on the "new thread" screen. When the picker
 * points at another backend than the open thread's (a tier thread, Claude Code picked), the
 * message starts a new thread there instead, with a brief of this one first. The token pool's
 * setup assistant's thread always stays where it is, read only, in its scratch folder.
 */
export async function sendMessage(
  text: string,
  cwdInput?: string,
  opts: SendOptions = {},
): Promise<void> {
  let settings: Settings = {
    ...getState().settings,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
    ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
  };
  let threadId = opts.threadId !== undefined ? opts.threadId : getState().selectedThreadId;
  const pinned = threadId ? getState().views[threadId] : undefined;
  if (pinned && isAssistView(pinned)) {
    settings = { ...settings, ...ASSIST_PRESET, model: pinned.model ?? settings.model };
    cwdInput = pinned.cwd ?? cwdInput;
  }
  const target = targetBackend(settings.model, threadId);
  let prompt = text;
  let carriedFrom: string | null = null;
  if (threadId && backendOf(threadId) !== target) {
    const view = getState().views[threadId];
    if (view) {
      prompt = `${threadBrief(view)}\n\n${text}`;
      carriedFrom = view.thread.name || view.thread.preview?.split("\n")[0] || null;
    }
    threadId = null;
  }
  const cwd = (cwdInput ?? settings.cwd).trim();
  // Only override an existing thread's cwd when the user changed it.
  const cwdOverride = threadId && cwd === getState().views[threadId]?.cwd ? null : cwd || null;
  const client = clients[target];
  // A fallback's reasoning effort rides on every turn, so a resumed thread keeps it.
  const effort = chosenEffort(settings, getState().fallbackInfo);
  setState((s) => ({ ...s, sending: true }));
  try {
    if (target !== "main") await ensureBackend(target);
    if (!threadId) {
      threadId = await startThread(target, settings, cwd);
      // A carried-over thread is named after the one it continues, not after its brief.
      if (opts.name) void nameThread(threadId, opts.name);
      else if (carriedFrom) void nameThread(threadId, `${carriedFrom.slice(0, 80)} (continued)`);
    }
    const res = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      // Per-turn overrides: these stick for subsequent turns too.
      model: wireModel(settings.model),
      cwd: cwdOverride,
      approvalPolicy: settings.approvalPolicy,
      sandboxPolicy: sandboxPolicyFor(settings.sandbox),
      ...(effort ? { effort } : {}),
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

/**
 * Start the token pool's setup assistant: a new thread on a fallback (`model`), read only, in an
 * empty scratch folder of the app's, whose first message is the brief (setup/assist-text.ts).
 */
export async function startAssistThread(model: string, cwd: string, brief: string, name: string) {
  updateSettings({ model }); // the picker shows what the thread runs on, as opening it would
  setState((s) => ({ ...s, selectedThreadId: null }));
  await sendMessage(brief, cwd, { threadId: null, model, ...ASSIST_PRESET, name });
}

async function nameThread(threadId: string, name: string): Promise<void> {
  try {
    await clientFor(threadId).request("thread/name/set", { threadId, name });
    setState((s) => ({
      ...s,
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, name } : t)),
      views: s.views[threadId]
        ? {
            ...s.views,
            [threadId]: { ...s.views[threadId], thread: { ...s.views[threadId].thread, name } },
          }
        : s.views,
    }));
  } catch {
    // an app-server without names: the thread keeps its first message as its title
  }
}

async function startThread(target: BackendId, settings: Settings, cwd: string): Promise<string> {
  const started = await clients[target].request("thread/start", {
    model: wireModel(settings.model),
    cwd: cwd || null,
    approvalPolicy: settings.approvalPolicy,
    sandbox: settings.sandbox,
    // The orchestrator backend keeps this for the thread's life (server/orchestrator/backend.ts).
    ...(target === "orchestrator" ? { config: { orchestrator: settings.orchestrator } } : {}),
  });
  const threadId = started.thread.id;
  if (target === "codex") {
    try {
      localStorage.setItem(CODEX_USED_KEY, "1"); // keep listing these threads if the mode goes off
    } catch {
      // fine
    }
  }
  const view: ThreadView = {
    ...blankView(started.thread, "ready"),
    model: settings.model,
    cwd: started.cwd,
  };
  setState((s) => ({
    ...upsertThreadInList(s, started.thread, true),
    views: { ...s.views, [threadId]: view },
    selectedThreadId: threadId,
    threadBackend: { ...s.threadBackend, [threadId]: target },
  }));
  return threadId;
}

/**
 * Carry a thread over to a fallback (the "too large" suggestion): a new thread on `model` whose
 * first message is a brief of this one, so the fallback can continue the work.
 */
export async function continueElsewhere(threadId: string, model: string): Promise<void> {
  const view = getState().views[threadId];
  if (!view) return;
  updateSettings({ model });
  setState((s) => ({ ...s, selectedThreadId: threadId }));
  await sendMessage("Continue the task from where it stands.", view.cwd ?? undefined);
}

export async function interrupt(threadId: string): Promise<void> {
  const v = getState().views[threadId];
  const turn = v?.turns.findLast((t) => t.status === "inProgress");
  if (!turn) return;
  try {
    await clientFor(threadId).request("turn/interrupt", { threadId, turnId: turn.id });
  } catch (e) {
    notify("error", `Interrupt failed: ${errText(e)}`);
  }
}

// ---- model attribution -----------------------------------------------------

const usageInFlight = new Set<string>();

/**
 * Which concrete models served a finished turn, from provenance-core's usage ledger (via
 * /api/usage), and what its history pruning saved. Requests are keyed by thread id + turn id
 * (Codex's client_metadata); the turn's
 * time window catches entries without a turn id. A turn the ledger doesn't know (older than the
 * ledger, or another router) stores an empty result and shows nothing.
 */
export async function loadTurnUsage(threadId: string, turn: TurnView, retry = true): Promise<void> {
  // The router knows the tiers' turns and Codex-through-Provenance ones (its pass-through), not the CLIs'.
  const where = backendOf(threadId);
  // (nor an orchestrator's: its calls aren't made under the visible thread's id)
  if (usageInFlight.has(turn.id) || where === "fallback" || where === "orchestrator") return;

  usageInFlight.add(turn.id);
  const q = new URLSearchParams({ key: threadId, turn: turn.id });
  if (turn.startedAt) q.set("since", String(turn.startedAt - 2));
  if (turn.completedAt) q.set("until", String(turn.completedAt + 5));
  let usage: TurnUsage = { requests: 0, input_tokens: 0, output_tokens: 0, models: [] };
  try {
    const r = (await (await fetch(`/api/usage?${q}`)).json()) as Partial<TurnUsage>;
    usage = {
      requests: r.requests ?? 0,
      input_tokens: r.input_tokens ?? 0,
      output_tokens: r.output_tokens ?? 0,
      models: r.models ?? [],
      ...(r.context ? { context: r.context } : {}),
      ...(r.pruned ? { pruned: r.pruned } : {}),
    };
  } catch {
    // leave it empty
  } finally {
    usageInFlight.delete(turn.id);
  }
  // A turn that just finished may race the ledger write: look once more shortly after.
  const fresh = turn.completedAt != null && Date.now() / 1000 - turn.completedAt < 30;
  if (!usage.models.length && retry && fresh) {
    setTimeout(() => void loadTurnUsage(threadId, turn, false), 1500);
    return;
  }
  setState((s) => ({ ...s, usage: { ...s.usage, [turn.id]: usage } }));
}

// ---- approvals -------------------------------------------------------------

const clientOfRequest = (req: ServerRequest) => clients[(req as TaggedRequest)._backend ?? "main"];

export function answerCommandApproval(
  req: ServerRequest,
  decision: CommandExecutionApprovalDecision,
): void {
  clientOfRequest(req).respond(req.id, { decision });
  dropServerRequest(req);
}

export function answerFileChangeApproval(
  req: ServerRequest,
  decision: FileChangeApprovalDecision,
): void {
  clientOfRequest(req).respond(req.id, { decision });
  dropServerRequest(req);
}

/** For server requests the UI doesn't implement yet: reply with a JSON-RPC error. */
export function rejectServerRequest(req: ServerRequest): void {
  clientOfRequest(req).respondError(
    req.id,
    -32601,
    `provenance-ui does not support ${req.method} yet`,
  );
  dropServerRequest(req);
}

function dropServerRequest(req: ServerRequest): void {
  setState((s) => ({
    ...s,
    serverRequests: s.serverRequests.filter((r) => r !== req),
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

export async function projectMove(params: {
  projectId: string;
  beforeProjectId?: string;
}): Promise<void> {
  setState((s) => ({ ...s, threadsLoading: true }));
  try {
    await rpc.request("project/move", params);
    await refreshThreads();
  } catch (e) {
    notify("error", `Couldn't move project: ${errText(e)}`);
  } finally {
    setState((s) => ({ ...s, threadsLoading: false }));
  }
}

export async function projectDelete(projectId: string): Promise<void> {
  setState((s) => ({ ...s, threadsLoading: true }));
  try {
    await rpc.request("project/delete", { projectId });
    await refreshThreads();
  } catch (e) {
    notify("error", `Couldn't delete project: ${errText(e)}`);
  } finally {
    setState((s) => ({ ...s, threadsLoading: false }));
  }
}

export type { AppState };
