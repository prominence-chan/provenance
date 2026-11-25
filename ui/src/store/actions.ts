// Side-effecting actions: everything that talks to app-server lives here.
// Components call these; they never touch the RpcClient directly.
//
// Four backends speak the same protocol (fallback/model.ts): the main app-server on the tiers
// (/rpc), a second one for "Codex through Provenance" (/rpc/codex, connected once that mode is
// on or was used), the Claude Code / Codex CLI threads (/rpc/fallback), and the tier threads an
// experimental orchestrator drives (/rpc/orchestrator). Threads from all of them share one list
// and one store; each request goes to the thread's own backend.
//
// A conversation moved to another backend stays one thread on the page (shared/thread-links.ts,
// store/segments.ts): its later sessions' threads are hidden from the list, their events are
// shown in the conversation, and each message goes to the session serving it now.

import type { FallbackCli, FallbacksInfo, FallbackUsage } from "../../shared/fallback-api";
import { DEFAULT_ORCHESTRATOR, isHyperexperimentalAllowed } from "../../shared/orchestrator-api";
import type { LinkSegment, ThreadLinks } from "../../shared/thread-links";
import { CARRY_ON, threadBrief } from "../fallback/brief";
import { chosenEffort } from "../fallback/effort";
import { modelKeyFor, wireModel, type BackendId } from "../fallback/model";
import type {
  BridgeStatus,
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  SandboxMode,
  SandboxPolicy,
  ServerNotification,
  ServerRequest,
  Thread,
  Turn,
  v2,
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
import {
  currentSegment,
  homeOf,
  movesConversation,
  ownerOf,
  segmentOfTurn,
  segmentsOf,
  targetBackend as targetOf,
  type Segment,
} from "./segments";
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
            : { ...s, serverRequests: [...s.serverRequests, tagRequest(req, id, s)] },
        ),
    },
    url,
  );
}

function tagRequest(req: ServerRequest, id: BackendId, s: AppState): ServerRequest {
  const tagged: TaggedRequest = { ...req };
  tagged._backend = id;
  // A later session's request (an approval) shows in its conversation. Answers go by request id.
  const tid = (req.params as { threadId?: unknown }).threadId;
  const owner = typeof tid === "string" ? ownerOf(s, tid) : null;
  if (owner) tagged.params = { ...(req.params as object), threadId: owner.id } as never;
  return tagged;
}

/** Per backend: the conversation whose new session is being started there (its thread/started). */
const startingSegment = new Map<BackendId, string>();

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
  // A conversation's new session starting: not a new thread in the list.
  if (
    n.method === "thread/started" &&
    (startingSegment.has(id) || ownerOf(getState(), n.params.thread.id))
  ) {
    const tid = n.params.thread.id;
    setState((s) => ({ ...s, threadBackend: { ...s.threadBackend, [tid]: id } }));
    return;
  }
  // A later session's events belong to its conversation.
  const tid = (n.params as { threadId?: unknown }).threadId;
  const owner = typeof tid === "string" ? ownerOf(getState(), tid) : null;
  if (owner) {
    // Its own name and archiving are bookkeeping: the conversation keeps its own.
    if (
      n.method === "thread/name/updated" ||
      n.method === "thread/archived" ||
      n.method === "thread/deleted"
    )
      return;
    n = { ...n, params: { ...n.params, threadId: owner.id } } as ServerNotification;
  }
  if (n.method === "account/rateLimits/updated" && id === "codex") {
    const u = rateLimitToUsage(n.params.rateLimits);
    if (u) setState((s) => ({ ...s, fallbackUsage: { ...s.fallbackUsage, codex: u } }));
    return;
  }
  setState((s) => {
    let next = applyNotification(s, n);
    if (n.method === "thread/started" && next.threadBackend[n.params.thread.id] !== id)
      next = { ...next, threadBackend: { ...next.threadBackend, [n.params.thread.id]: id } };
    if (owner) next = tagTurn(next, owner.id, turnIdOf(n), owner.segment);
    return next;
  });
  if (n.method === "turn/completed") {
    if (id === "main" || id === "orchestrator") void refreshSources();
    else if (id === "fallback") void refreshFallbacks(true);
    else if (id === "codex") void refreshCodexRateLimits();
  }
  if (n.method === "warning" || n.method === "configWarning" || n.method === "deprecationNotice") {
    const p = n.params as { message?: string; summary?: string };
    notify("warn", p.message ?? p.summary ?? n.method);
  }
}

/** The turn a notification is about, if any. */
function turnIdOf(n: ServerNotification): string | null {
  const p = n.params as { turnId?: unknown; turn?: { id?: unknown } };
  if (typeof p.turnId === "string") return p.turnId;
  return typeof p.turn?.id === "string" ? p.turn.id : null;
}

/** Mark which of the conversation's sessions served a turn (set once). */
function tagTurn(s: AppState, threadId: string, turnId: string | null, segment: number): AppState {
  const v = s.views[threadId];
  if (!turnId || !v) return s;
  const i = v.turns.findIndex((t) => t.id === turnId);
  if (i === -1 || v.turns[i].segment === segment) return s;
  const turns = v.turns.slice();
  turns[i] = { ...turns[i], segment };
  return { ...s, views: { ...s.views, [threadId]: { ...v, turns } } };
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

/** Which backend serves a conversation now (its latest session's; for most, its own). */
export function backendOf(threadId: string): BackendId {
  return currentSegment(getState(), threadId).backend;
}

/** The backend serving the session of the conversation that ran this turn. */
export function turnBackend(threadId: string, turn: TurnView): BackendId {
  return segmentOfTurn(getState(), threadId, turn).backend;
}

/** Sending on `model` would move this conversation to another backend session. */
export function switchesBackend(threadId: string, model: string): boolean {
  return movesConversation(getState(), threadId, model);
}

/** Where a message on `model` goes (segments.ts). */
function targetBackend(model: string, threadId: string | null): BackendId {
  return targetOf(getState(), model, threadId);
}

/** Called on first connect and whenever a backend restarts. */
async function onReady(id: BackendId, reconnected: boolean): Promise<void> {
  await clients[id].request("initialize", {
    clientInfo: { name: "provenance_ui", title: "Provenance UI", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  for (const w of readyWaiters[id].splice(0)) w();
  void refreshThreads();
  if (id === "codex") void refreshCodexRateLimits();
  // After a reconnect/restart app-server may not have the thread loaded: re-attach.
  const sel = getState().selectedThreadId;
  if (sel && segmentsOf(getState(), sel).some((x) => x.backend === id))
    void openThread(sel, { force: reconnected || getState().views[sel]?.load !== "ready" });
}

export async function boot(): Promise<void> {
  // Which conversations moved between backends: before any list, so their sessions stay hidden.
  await refreshLinks();
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

/** The conversations that moved between backends (GET /api/links). */
async function refreshLinks(): Promise<void> {
  try {
    const body = (await (await fetch("/api/links")).json()) as { links?: ThreadLinks };
    if (body?.links && typeof body.links === "object") {
      const links = body.links;
      setState((s) => ({ ...s, links }));
    }
  } catch {
    // none known: every thread stands alone
  }
}

/** Store a conversation's sessions (null: forget them); the page's copy changes with it. */
async function saveLinks(id: string, segments: LinkSegment[] | null): Promise<void> {
  const r = await fetch(`/api/links/${encodeURIComponent(id)}`, {
    method: segments ? "PUT" : "DELETE",
    headers: { "content-type": "application/json" },
    body: segments ? JSON.stringify({ segments }) : undefined,
  });
  if (!r.ok) throw new Error(`Couldn't keep the conversation's link (${r.status})`);
  setState((s) => {
    const links = { ...s.links };
    if (segments) links[id] = segments;
    else delete links[id];
    return { ...s, links };
  });
}

/** Convert a Codex app-server RateLimitSnapshot into a FallbackUsage entry. */
function rateLimitToUsage(rl: v2.RateLimitSnapshot | null | undefined): FallbackUsage | null {
  if (!rl) return null;
  const rem = (w: v2.RateLimitWindow | null | undefined) =>
    w && Number.isFinite(w.usedPercent) ? Math.max(0, Math.min(1, 1 - w.usedPercent / 100)) : null;
  const ts = (n: number | null | undefined) =>
    typeof n === "number" && Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : null;
  const secondaryIsWeekly = !!rl.secondary;
  const primaryIsWeekly =
    !secondaryIsWeekly &&
    !!rl.primary &&
    (rl.primary.windowDurationMins == null || rl.primary.windowDurationMins >= 1440);
  const weekly = secondaryIsWeekly ? rl.secondary : primaryIsWeekly ? rl.primary : null;
  const primary = primaryIsWeekly ? null : rl.primary;
  const weeklyRemaining = rem(weekly);
  const primaryRemaining = rem(primary);
  if (weeklyRemaining == null && primaryRemaining == null) return null;
  return {
    weeklyRemaining,
    weeklyResetsAt: ts(weekly?.resetsAt),
    primaryRemaining,
    primaryResetsAt: ts(primary?.resetsAt),
    updatedAt: Date.now(),
  };
}

/** Read Codex through Provenance's account rate limits (weekly + 5h windows). */
export async function refreshCodexRateLimits(): Promise<void> {
  if (!getState().backendReady.codex) return;
  try {
    const res = (await clients.codex.request("account/rateLimits/read", undefined)) as
      v2.GetAccountRateLimitsResponse | null | undefined;
    const u = rateLimitToUsage(res?.rateLimits);
    if (u) setState((s) => ({ ...s, fallbackUsage: { ...s.fallbackUsage, codex: u } }));
  } catch {
    // older app-server or signed out
  }
}

/** Merge newly fetched usage snapshots into state, preferring the freshest timestamp. */
function mergeFallbackUsage(
  prev: Partial<Record<FallbackCli, FallbackUsage>>,
  info: FallbacksInfo,
): Partial<Record<FallbackCli, FallbackUsage>> {
  const next = { ...prev };
  const entries: [FallbackCli, FallbackUsage | null | undefined][] = [
    ["claude", info.claude.usage],
    ["codex", info.codex.usage],
    ["antigravity", info.antigravity?.usage],
  ];
  for (const [cli, u] of entries) {
    if (!u) continue;
    const cur = next[cli];
    if (!cur) {
      next[cli] = u;
    } else if ((u.updatedAt ?? 0) >= (cur.updatedAt ?? 0)) {
      const buckets = u.buckets || cur.buckets ? { ...cur.buckets, ...u.buckets } : undefined;
      next[cli] = {
        weeklyRemaining: u.weeklyRemaining ?? cur.weeklyRemaining ?? null,
        weeklyResetsAt: u.weeklyResetsAt ?? cur.weeklyResetsAt ?? null,
        primaryRemaining: u.primaryRemaining ?? cur.primaryRemaining ?? null,
        primaryResetsAt: u.primaryResetsAt ?? cur.primaryResetsAt ?? null,
        ...(buckets ? { buckets } : {}),
        updatedAt: u.updatedAt ?? cur.updatedAt,
      };
    } else {
      const buckets = u.buckets || cur.buckets ? { ...u.buckets, ...cur.buckets } : undefined;
      next[cli] = {
        weeklyRemaining: cur.weeklyRemaining ?? u.weeklyRemaining ?? null,
        weeklyResetsAt: cur.weeklyResetsAt ?? u.weeklyResetsAt ?? null,
        primaryRemaining: cur.primaryRemaining ?? u.primaryRemaining ?? null,
        primaryResetsAt: cur.primaryResetsAt ?? u.primaryResetsAt ?? null,
        ...(buckets ? { buckets } : {}),
        updatedAt: cur.updatedAt ?? u.updatedAt,
      };
    }
  }
  return next;
}

/** Claude Code / Codex / Antigravity health and models (GET /api/fallbacks); `force` checks again now. */
export async function refreshFallbacks(force = false): Promise<FallbacksInfo | null> {
  try {
    const info = (await (
      await fetch(`/api/fallbacks${force ? "?refresh=1" : ""}`)
    ).json()) as FallbacksInfo;
    if (!info?.claude || !info?.codex) return null;
    setState((s) => ({
      ...s,
      fallbackInfo: info,
      fallbackUsage: mergeFallbackUsage(s.fallbackUsage, info),
    }));
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
  const m = /^(claude|codex|codex-pv|antigravity):/.exec(model)?.[1];
  const off =
    (m === "claude" && !fallbacks.claude) ||
    (m === "codex" && fallbacks.codex !== "background") ||
    (m === "codex-pv" && fallbacks.codex !== "provenance") ||
    (m === "antigravity" && !fallbacks.antigravity);
  updateSettings({ fallbacks, ...(off ? { model: validModel(null, getState().tiers) } : {}) });
  if (fallbacks.codex === "provenance") connect("codex");
}

/** Keep a saved model whose tier still exists (pinned "luna/solstice" included), else the default. */
function validModel(model: unknown, tiers: string[]): string {
  if (typeof model === "string" && tiers.includes(splitModel(model).tier)) return model;
  if (typeof model === "string" && /^(claude|codex|codex-pv|antigravity):/.test(model))
    return model; // a fallback
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
    if (
      settings.orchestrator === "hyperexperimental" &&
      Object.keys(s.sources).length > 0 &&
      !isHyperexperimentalAllowed(settings.model, s.sources)
    ) {
      settings.orchestrator = DEFAULT_ORCHESTRATOR;
    }
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
    const threads = stitchList(all, s.links);
    threads.sort((a, b) => b.updatedAt - a.updatedAt);
    return { ...s, threads, threadBackend, threadsLoading: false };
  });
  if (mainError) notify("error", `Couldn't list threads: ${errText(mainError)}`);
}

/**
 * One entry per conversation: a moved conversation's later sessions are left out, and its entry
 * shows when it was last active and whether its current session is working.
 */
function stitchList(all: Thread[], links: ThreadLinks): Thread[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  const hidden = new Set(
    Object.values(links).flatMap((segs) => segs.slice(1).map((x) => x.threadId)),
  );
  return all
    .filter((t) => !hidden.has(t.id))
    .map((t) => {
      const segs = links[t.id];
      if (!segs) return t;
      const later = segs.slice(1).map((x) => byId.get(x.threadId));
      const cur = byId.get(segs[segs.length - 1].threadId);
      const updatedAt = Math.max(t.updatedAt, ...later.map((x) => x?.updatedAt ?? 0));
      return { ...t, updatedAt, ...(cur ? { status: cur.status } : {}) };
    });
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
  const segs = segmentsOf(getState(), threadId);
  try {
    // Each session the conversation had, oldest first, stitched into one list of turns.
    const loaded = await Promise.all(
      segs.map((seg, i) =>
        loadSegment(seg).then(
          (r) => ({ ...r, error: null as unknown }),
          (error: unknown) => {
            // The session serving it now must load; an earlier one that doesn't is said, and left out.
            if (i === segs.length - 1) throw error;
            return { resumed: null, turns: [] as TurnView[], model: null, error };
          },
        ),
      ),
    );
    const failed = loaded.find((x) => x.error);
    if (failed)
      notify(
        "warn",
        `Couldn't load an earlier part of this conversation: ${errText(failed.error)}`,
      );
    const turns = loaded.flatMap((x, i) =>
      x.turns.map((t) => ({
        ...t,
        model: t.model ?? x.model,
        ...(segs.length > 1 ? { segment: i } : {}),
      })),
    );
    const first = loaded[0].resumed;
    const last = loaded[loaded.length - 1];
    const model = last.model;
    setState((s) => {
      const prev = s.views[threadId];
      const thread = first?.thread ?? prev?.thread ?? listed ?? ({ id: threadId } as Thread);
      // Keep any turn that streamed in while we were fetching history.
      const live = (prev?.turns ?? []).filter((t) => !turns.some((h) => h.id === t.id));
      const view: ThreadView = {
        ...(prev ?? blankView(thread, "ready")),
        thread,
        load: "ready",
        turns: [...turns, ...live],
        model,
        cwd: last.resumed!.cwd,
      };
      let next: AppState = s;
      if (first) {
        // The conversation's entry: its own thread, as active and as recent as its latest session.
        const entry = s.threads.find((t) => t.id === threadId);
        const cur = last.resumed!.thread;
        next = upsertThreadInList(
          s,
          segs.length > 1
            ? {
                ...first.thread,
                status: cur.status,
                updatedAt: Math.max(first.thread.updatedAt, cur.updatedAt, entry?.updatedAt ?? 0),
              }
            : first.thread,
          false,
        );
      }
      const threadBackend = { ...next.threadBackend };
      segs.forEach((x) => (threadBackend[x.threadId] = x.backend));
      return { ...next, views: { ...next.views, [threadId]: view }, threadBackend };
    });
    // A thread stays on what it runs on: opening one that lives elsewhere (Claude Code, Codex)
    // points the picker at its model, so the next message continues it there.
    const cur = getState().settings.model;
    if (model && getState().selectedThreadId === threadId && switchesBackend(threadId, cur))
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

/**
 * Load a subagent child thread's turns and subscribe to its live events in `state.views[id]`
 * without changing `selectedThreadId`, so the right panel can inspect it in place.
 */
export async function loadSubagentPreview(
  agentThreadId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const existing = getState().views[agentThreadId];
  if (existing && existing.load !== "error" && !opts.force) return;
  const listed = getState().threads.find((t) => t.id === agentThreadId);
  setState((s) => ({
    ...s,
    views: {
      ...s.views,
      [agentThreadId]: existing
        ? { ...existing, load: "loading" }
        : listed
          ? blankView(listed, "loading")
          : blankView({ id: agentThreadId } as Thread, "loading"),
    },
  }));
  const segs = segmentsOf(getState(), agentThreadId);
  try {
    const loaded = await loadSegment(segs[segs.length - 1]);
    const turns = loaded.turns.map((t) => ({ ...t, model: t.model ?? loaded.model }));
    setState((s) => {
      const prev = s.views[agentThreadId];
      const thread =
        loaded.resumed.thread ?? prev?.thread ?? listed ?? ({ id: agentThreadId } as Thread);
      const live = (prev?.turns ?? []).filter((t) => !turns.some((h) => h.id === t.id));
      const view: ThreadView = {
        ...(prev ?? blankView(thread, "ready")),
        thread,
        load: "ready",
        turns: [...turns, ...live],
        model: loaded.model,
        cwd: loaded.resumed.cwd,
      };
      return {
        ...s,
        views: { ...s.views, [agentThreadId]: view },
        threadBackend: { ...s.threadBackend, [agentThreadId]: segs[segs.length - 1].backend },
      };
    });
  } catch (e) {
    setState((s) => {
      const prev = s.views[agentThreadId];
      return prev
        ? {
            ...s,
            views: {
              ...s.views,
              [agentThreadId]: { ...prev, load: "error", loadError: errText(e) },
            },
          }
        : s;
    });
  }
}

/** One session of a conversation: resumed (so its live events come here) and its turns. */
async function loadSegment(seg: Segment) {
  const client = clients[seg.backend];
  if (seg.backend !== "main") await ensureBackend(seg.backend);
  // Resume subscribes this connection to the thread's live events.
  const resumed = await client.request("thread/resume", {
    threadId: seg.threadId,
    excludeTurns: true,
  });
  const history = await client.request("thread/turns/list", {
    threadId: seg.threadId,
    limit: HISTORY_TURNS,
    sortDirection: "desc",
    itemsView: "full",
  });
  const turns = history.data.slice().reverse().map(turnFromProtocol);
  return { resumed, turns, model: modelKeyFor(seg.backend, resumed.model) ?? seg.model };
}

/** Archive a conversation: every session it had, so nothing of it comes back as its own thread. */
export async function archiveThread(threadId: string): Promise<void> {
  const segs = segmentsOf(getState(), threadId);
  try {
    await clients[segs[0].backend].request("thread/archive", { threadId });
    setState((s) => ({
      ...s,
      threads: s.threads.filter((t) => t.id !== threadId),
      selectedThreadId: s.selectedThreadId === threadId ? null : s.selectedThreadId,
    }));
  } catch (e) {
    notify("error", `Archive failed: ${errText(e)}`);
    return;
  }
  if (segs.length < 2) return;
  const later = await Promise.allSettled(
    segs.slice(1).map(async (x) => {
      if (x.backend !== "main") await ensureBackend(x.backend);
      await clients[x.backend].request("thread/archive", { threadId: x.threadId });
    }),
  );
  // Forgotten once all of it is archived; otherwise kept, so what is left stays hidden.
  if (later.every((r) => r.status === "fulfilled")) await saveLinks(threadId, null).catch(() => {});
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
  /** Moving the conversation with no message of its own: the model carries on with the work. */
  carryOn?: boolean;
}

/** The setup assistant's thread: read only, in its own scratch folder, on its own fallback. */
const ASSIST_PRESET = { approvalPolicy: "on-request", sandbox: "read-only" } as const;

/** Key of the hand-over in turn/start's additionalContext (the model sees it, the thread doesn't). */
const HANDOVER_KEY = "provenance_handover";

/** Backends of ours: they take the whole brief with the turn (app-servers cap additionalContext). */
const takesBriefWithTurn = (b: BackendId) => b === "fallback" || b === "orchestrator";

/**
 * Send a message: starts a new thread first when on the "new thread" screen. When the picker
 * points at another backend than the one serving the open conversation (a tier thread, Claude
 * Code picked), the conversation moves there and stays one thread (handOver). The token pool's
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
  const assist = !!pinned && isAssistView(pinned);
  if (pinned && assist) {
    settings = { ...settings, ...ASSIST_PRESET, model: pinned.model ?? settings.model };
    cwdInput = pinned.cwd ?? cwdInput;
  }
  if (threadId && !assist && switchesBackend(threadId, settings.model))
    return handOver(threadId, settings, text, cwdInput, !!opts.carryOn);
  if (!text.trim()) return;
  const target = threadId ? backendOf(threadId) : targetBackend(settings.model, null);
  if (
    !threadId &&
    target === "orchestrator" &&
    settings.orchestrator === "hyperexperimental" &&
    !isHyperexperimentalAllowed(settings.model, getState().sources)
  ) {
    notify("warn", "Hyperexperimental only works on web chat models.");
    return;
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
      if (opts.name) void nameThread(threadId, opts.name);
    }
    const segs = segmentsOf(getState(), threadId);
    const segment = segs.length - 1;
    const raw = segs[segment].threadId;
    const res = await client.request("turn/start", {
      threadId: raw,
      input: [{ type: "text", text, text_elements: [] }],
      // Per-turn overrides: these stick for subsequent turns too.
      model: wireModel(settings.model),
      cwd: cwdOverride,
      approvalPolicy: settings.approvalPolicy,
      sandboxPolicy: sandboxPolicyFor(settings.sandbox),
      ...(effort ? { effort } : {}),
      ...briefAgain(threadId, segment, target),
    });
    addTurn(threadId, res.turn, settings.model, segment, cwdOverride);
  } catch (e) {
    notify("error", errText(e));
  } finally {
    setState((s) => ({ ...s, sending: false }));
  }
}

/**
 * A session of ours that a conversation moved to and that hasn't finished a turn yet (its first
 * one failed, or was stopped): the brief goes with the next one too. The backend leaves it out
 * once the CLI has a session (server/fallback/backend.ts).
 */
function briefAgain(threadId: string, segment: number, target: BackendId) {
  if (segment === 0 || !takesBriefWithTurn(target)) return {};
  const v = getState().views[threadId];
  if (!v || v.turns.some((t) => (t.segment ?? 0) === segment && t.status === "completed"))
    return {};
  const before = { ...v, turns: v.turns.filter((t) => (t.segment ?? 0) < segment) };
  return {
    additionalContext: {
      [HANDOVER_KEY]: { value: threadBrief(before), kind: "application" as const },
    },
  };
}

/** Put a turn that turn/start answered into the conversation, with its model and session. */
function addTurn(
  threadId: string,
  turn: Turn,
  model: string,
  segment: number,
  cwd: string | null,
): void {
  setState((s) => {
    const v = s.views[threadId];
    if (!v) return s;
    const tag = segment > 0 ? { segment } : {};
    const turns = v.turns.some((t) => t.id === turn.id)
      ? v.turns.map((t) => (t.id === turn.id ? { ...t, model, ...tag } : t))
      : [...v.turns, { ...turnFromProtocol(turn), model, ...tag }];
    return {
      ...s,
      views: { ...s.views, [threadId]: { ...v, turns, cwd: cwd ?? v.cwd, model } },
    };
  });
}

/**
 * Move a conversation to another backend and go on there, in the same thread: a new session on
 * the target whose model gets a brief of the conversation (never shown), linked to the
 * conversation, then the person's message exactly as typed (or, with `carryOn`, none: the model
 * carries on with the work). A turn still running where it was is stopped first: two models never
 * work on one conversation at once.
 */
async function handOver(
  threadId: string,
  settings: Settings,
  text: string,
  cwdInput: string | undefined,
  carryOn: boolean,
): Promise<void> {
  const target = targetBackend(settings.model, threadId);
  const effort = chosenEffort(settings, getState().fallbackInfo);
  setState((s) => ({ ...s, sending: true }));
  try {
    await stopRunningTurn(threadId);
    if (target !== "main") await ensureBackend(target);
    const view = getState().views[threadId];
    if (!view) throw new Error("The conversation isn't loaded");
    const cwd = (cwdInput ?? view.cwd ?? settings.cwd).trim();
    // Everything so far, as the model taking over needs it.
    const brief = threadBrief(view);
    const appServer = !takesBriefWithTurn(target);
    // Until it is linked, the new session's thread/started is not a new thread in the list.
    startingSegment.set(target, threadId);
    let raw: string;
    let segs: Segment[];
    try {
      const started = await clients[target].request("thread/start", {
        model: wireModel(settings.model),
        cwd: cwd || null,
        approvalPolicy: settings.approvalPolicy,
        sandbox: settings.sandbox,
        // An app-server takes the brief as the new thread's developer instructions: whole, kept
        // through compaction, never an item of the thread.
        ...(appServer ? { developerInstructions: brief } : {}),
        ...(target === "orchestrator" ? { config: { orchestrator: settings.orchestrator } } : {}),
      });
      raw = started.thread.id;
      if (target === "codex") markCodexUsed();
      segs = [
        ...segmentsOf(getState(), threadId),
        {
          backend: target,
          threadId: raw,
          model: settings.model,
          at: Math.floor(Date.now() / 1000),
        },
      ];
      // Linked before the first turn, so a restart from here on finds it one conversation.
      await saveLinks(threadId, segs);
    } finally {
      startingSegment.delete(target);
    }
    const rawId = raw;
    setState((s) => ({
      ...s,
      threads: s.threads.filter((t) => t.id !== rawId),
      threadBackend: { ...s.threadBackend, [rawId]: target },
    }));
    const handover = carryOn ? `${brief}\n\n${CARRY_ON}` : brief;
    const context = appServer
      ? carryOn
        ? { [HANDOVER_KEY]: { value: CARRY_ON, kind: "application" as const } }
        : null
      : { [HANDOVER_KEY]: { value: handover, kind: "application" as const } };
    const typed = carryOn ? "" : text;
    const res = await clients[target].request("turn/start", {
      threadId: raw,
      input: typed.trim() ? [{ type: "text", text: typed, text_elements: [] }] : [],
      model: wireModel(settings.model),
      cwd: cwd || null,
      approvalPolicy: settings.approvalPolicy,
      sandboxPolicy: sandboxPolicyFor(settings.sandbox),
      ...(effort ? { effort } : {}),
      ...(context ? { additionalContext: context } : {}),
    });
    addTurn(threadId, res.turn, settings.model, segs.length - 1, cwd || null);
  } catch (e) {
    notify("error", errText(e));
  } finally {
    setState((s) => ({ ...s, sending: false }));
  }
}

/** Stop the conversation's running turn, if any, and wait until it has stopped. */
async function stopRunningTurn(threadId: string, timeoutMs = 20_000): Promise<void> {
  const running = () =>
    getState().views[threadId]?.turns.some((t) => t.status === "inProgress") ?? false;
  if (!running()) return;
  await interrupt(threadId);
  const t0 = Date.now();
  while (running()) {
    if (Date.now() - t0 > timeoutMs)
      throw new Error("The running turn didn't stop, so the conversation stayed where it was");
    await new Promise((r) => setTimeout(r, 100));
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

/** Rename a conversation: its own (first) thread holds the name. */
async function nameThread(threadId: string, name: string): Promise<void> {
  try {
    await clients[homeOf(getState(), threadId)].request("thread/name/set", { threadId, name });
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

export { nameThread as renameThread };

function markCodexUsed(): void {
  try {
    localStorage.setItem(CODEX_USED_KEY, "1"); // keep listing these threads if the mode goes off
  } catch {
    // fine
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
  if (target === "codex") markCodexUsed();
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
 * Move a conversation to a fallback without a new message (the "too large" suggestion): the same
 * thread goes on there, and the model carries on with the work in progress.
 */
export async function continueElsewhere(threadId: string, model: string): Promise<void> {
  const view = getState().views[threadId];
  if (!view) return;
  updateSettings({ model });
  setState((s) => ({ ...s, selectedThreadId: threadId }));
  await sendMessage("", view.cwd ?? undefined, { carryOn: true });
}

export async function interrupt(threadId: string): Promise<void> {
  const v = getState().views[threadId];
  const turn = v?.turns.findLast((t) => t.status === "inProgress");
  if (!turn) return;
  // The session that runs the turn.
  const seg = segmentOfTurn(getState(), threadId, turn);
  try {
    await clients[seg.backend].request("turn/interrupt", {
      threadId: seg.threadId,
      turnId: turn.id,
    });
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
  const seg = segmentOfTurn(getState(), threadId, turn);
  const where = seg.backend;
  // (nor an orchestrator's: its calls aren't made under the visible thread's id)
  if (usageInFlight.has(turn.id) || where === "fallback" || where === "orchestrator") return;

  usageInFlight.add(turn.id);
  // Its requests carry the id of the session that ran it.
  const q = new URLSearchParams({ key: seg.threadId, turn: turn.id });
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
