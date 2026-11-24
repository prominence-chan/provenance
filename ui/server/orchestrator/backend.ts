// OrchestratorBackend: tier threads driven by one of the two experimental orchestrators
// (shared/orchestrator-api.ts), served to the page over WebSocket /rpc/orchestrator with the same
// JSON-RPC methods and notifications app-server uses, like /rpc/fallback (fallback/backend.ts), so
// the page's store, reducer and thread view handle them unchanged.
//
//   requests:      initialize, thread/list, thread/start, thread/resume, thread/read,
//                  thread/turns/list, thread/archive, thread/name/set, turn/start, turn/interrupt
//   notifications: thread/started, thread/status/changed, thread/archived, thread/name/updated,
//                  turn/started, turn/plan/updated, item/started, item/completed,
//                  item/commandExecution/outputDelta, thread/tokenUsage/updated, error,
//                  serverRequest/resolved, turn/completed
//   server requests (approvals, answered by the page): item/commandExecution/requestApproval,
//                  item/fileChange/requestApproval (and whatever a worker's harness asks)
//
// thread/start takes the orchestrator in `config.orchestrator` ("experimental" |
// "hyperexperimental"); the thread keeps it for good. What a turn does is in experimental.ts and
// hyper.ts; this file is the thread store, the protocol, and the per-turn Run they work through
// (model calls with their budget and caps, items, approvals, interrupt).
//
// Threads are JSON files in <dir>/threads, written when a turn starts, after each task / step and
// when it ends. Ids start with ORCHESTRATOR_ID_PREFIX. Besides its turns a thread stores the only
// context it carries: Experimental's notes (with the tasks still to do), Hyperexperimental's
// summary and the request it has not finished. A turn that ends early (no model after the
// retries, a guard, an interrupt) leaves them as they stand, so "continue" picks the work up.
//
// A conversation moved here from another backend (shared/thread-links.ts) starts with a hand-over
// brief in its first turn/start's `additionalContext` ({key: {value, kind}}, app-server's field).
// It seeds the context the thread carries, within that context's own bound: Hyperexperimental's
// summary, Experimental's goal (the notes' first request). It never becomes an item: the turn's
// user message is what the person typed, and a turn with no message of its own shows none.
//
// A plain model call that the router can't serve is retried inside the turn (Run.model): the
// waits are Caps.retryDelaysMs, a status line in the thread says so, and turn/interrupt ends the
// wait at once. Guards and timeouts read the monotonic clock (clock.ts).

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import {
  ORCHESTRATOR_ID_PREFIX,
  isOrchestrator,
  type Orchestrator,
} from "../../shared/orchestrator-api.ts";
import { agentMessage, contextText, userMessage, type Item } from "../fallback/items.ts";
import type { AppServer } from "./appserver.ts";
import { mono } from "./clock.ts";
import { runExperimental } from "./experimental.ts";
import { runHyper } from "./hyper.ts";
import { clipMiddle, emptyNotes, notesText, type Notes } from "./notes.ts";
import { PROMPT_BUDGET, SUMMARY_LIMIT, type Prompt } from "./prompts.ts";

/** How much of a hand-over brief Experimental keeps as its goal (its notes stay bounded). */
const HANDOVER_GOAL_CHARS = 1500;
import {
  CALL_TIMEOUT_MS,
  RouterError,
  retryReason,
  routerProblem,
  type CallModel,
} from "./router.ts";

type Json = Record<string, unknown>;
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** Loop guards, per user turn. */
export interface Caps {
  /** Experimental: worker runs (retries and revised tasks included). */
  tasks: number;
  /** Experimental: times the same task may be tried. */
  attempts: number;
  /** Experimental: times the planner may revise the list. */
  replans: number;
  /** Hyperexperimental: think -> translate -> execute -> summarize rounds. */
  steps: number;
  /** Every model call of the turn: plain calls plus the workers' own requests. */
  modelCalls: number;
  /** Experimental: one worker's own budget of model requests (then it is stopped, and the planner revises). */
  workerCalls: number;
  /** Experimental: one worker's own budget of time (the same). */
  workerMs: number;
  /** A worker with nothing running and no word from the model for this long is stopped. */
  workerIdleMs: number;
  /** One RUN action. */
  commandMs: number;
  /**
   * The whole turn, in time: what a worker or a step may still take is cut to what is left of it,
   * and when too little is left for another task the turn ends with what it has (a partial
   * result that says so), not at a wall.
   */
  turnMs: number;
  /**
   * The waits before each retry of a model call the router couldn't serve (429, 5xx, no answer,
   * a timeout, an empty reply), and of a worker whose own request failed for good. When they are
   * used up the turn ends with the plain message. [] means no retries.
   */
  retryDelaysMs: number[];
}

/** 5 s, 20 s, 60 s, 120 s: four retries, about three and a half minutes of patience per call. */
export const RETRY_DELAYS_MS = [5_000, 20_000, 60_000, 120_000];
/**
 * A worker's own budget. In the benchmark's transcripts a worker that finished its task used 2
 * to 15 requests and under 3 minutes; the one that circled used 70 requests and 20 minutes.
 */
export const WORKER_CALLS = 24;
export const WORKER_MINUTES = 10;
export const TURN_MINUTES = 22;

export const DEFAULT_CAPS: Caps = {
  tasks: 10,
  attempts: 2,
  replans: 3,
  steps: 14,
  modelCalls: 80,
  workerCalls: WORKER_CALLS,
  workerMs: WORKER_MINUTES * 60_000,
  workerIdleMs: 5 * 60_000,
  commandMs: 120_000,
  turnMs: TURN_MINUTES * 60_000,
  retryDelaysMs: RETRY_DELAYS_MS,
};

/**
 * Caps set from the environment (the app passes its own): PROVENANCE_ORC_RETRY_S="5,20,60,120"
 * (seconds before each retry; "0" or "off" for none), PROVENANCE_ORC_WORKER_CALLS,
 * PROVENANCE_ORC_WORKER_MINUTES, PROVENANCE_ORC_TURN_MINUTES. Anything unreadable is ignored.
 */
export function capsFromEnv(env: NodeJS.ProcessEnv): Partial<Caps> {
  const out: Partial<Caps> = {};
  const retry = env.PROVENANCE_ORC_RETRY_S?.trim();
  if (retry) {
    if (/^(0|off|none)$/i.test(retry)) out.retryDelaysMs = [];
    else {
      const secs = retry.split(/[\s,]+/).map(Number);
      if (secs.length <= 12 && secs.every((n) => Number.isFinite(n) && n >= 0 && n <= 3600))
        out.retryDelaysMs = secs.map((n) => Math.round(n * 1000));
    }
  }
  const calls = Number(env.PROVENANCE_ORC_WORKER_CALLS);
  if (Number.isInteger(calls) && calls >= 2 && calls <= 500) out.workerCalls = calls;
  const minutes = Number(env.PROVENANCE_ORC_WORKER_MINUTES);
  if (Number.isFinite(minutes) && minutes >= 0.5 && minutes <= 240)
    out.workerMs = Math.round(minutes * 60_000);
  const turn = Number(env.PROVENANCE_ORC_TURN_MINUTES);
  if (Number.isFinite(turn) && turn >= 1 && turn <= 600) out.turnMs = Math.round(turn * 60_000);
  return out;
}

export type Role = "planner" | "revise" | "final" | "review" | "think" | "translate" | "summarize";

/** What a turn cost; kept on the turn (`orchestration`) and readable from the thread file. */
export interface Stats {
  orchestrator: Orchestrator;
  /** Plain calls + worker requests. */
  modelCalls: number;
  /** Times a model call (or a worker whose request failed) was tried again after a wait. */
  retries: number;
  roles: Partial<Record<Role, { calls: number; maxPromptChars: number }>>;
  workers: number;
  workerCalls: number;
  /** Largest request a worker's harness sent (input tokens, as app-server reports them). */
  workerMaxInputTokens: number;
  steps: number;
  stopped: string | null;
  /**
   * The finish check of a turn that changed something: how many requirements the reviewer
   * listed, how many it found not shown or violated, what code found on its own (a missing or
   * misnamed file, a path outside the folder, a failed last check), and how many follow-up tasks
   * (Experimental) or steps (Hyperexperimental) were run for them. Absent when no check ran.
   */
  finish?: { requirements: number; open: number; code: number; followUps: number };
}

export type TraceEvent =
  | {
      type: "model";
      role: Role;
      instructions: string;
      input: string;
      promptChars: number;
      reply: string;
      ms: number;
      servedBy: string | null;
      /** The call's key in the router's usage ledger (absent from stand-ins that give none). */
      session?: string;
    }
  | {
      type: "worker";
      task: string;
      brief: string;
      calls: number;
      maxInputTokens: number;
      status: string;
      /** The worker's harness thread: the key of its requests in the router's usage ledger. */
      threadId: string | null;
      /** The worker's last message as it wrote it, and how many commands it ran. */
      report: string;
      commands: number;
    };

/** Ends the turn: "cap" with a plain message as the answer, the others as a failed turn. */
export class StopTurn extends Error {
  kind: "cap" | "router" | "failed";
  constructor(kind: "cap" | "router" | "failed", message: string) {
    super(message);
    this.kind = kind;
  }
}

export class Interrupted extends Error {
  constructor() {
    super("interrupted");
  }
}

interface TurnRecord {
  id: string;
  rootTurnId: null;
  items: Item[];
  itemsView: "full";
  status: "inProgress" | "completed" | "failed" | "interrupted";
  error: {
    message: string;
    codexErrorInfo: null;
    additionalDetails: null;
    misalignment: null;
  } | null;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  orchestration?: Stats;
}

export interface ThreadRecord {
  thread: Json & { id: string; cwd: string; turns: [] };
  orchestrator: Exclude<Orchestrator, "provenance">;
  /** The tier, or "<source>/<tier>". */
  model: string;
  sandbox: SandboxMode;
  /** AskForApproval as the page sent it ("untrusted" | "on-request" | "never" | an object). */
  approvalPolicy: unknown;
  turns: TurnRecord[];
  /** Experimental: the session notes. */
  notes: Notes;
  /** Hyperexperimental: the summary. */
  summary: string;
  /** Hyperexperimental: the request a turn ended without finishing ("continue" takes it up). */
  openGoal?: string | null;
  /**
   * Hyperexperimental: the request being worked on, word for word, with what code read out of it
   * when it arrived: the exact names (request.ts) and the files it names that were not there.
   */
  job?: { original: string; exact: string[]; deliverables: string[] } | null;
  archived?: boolean;
}

export interface OrchestratorBackendOptions {
  /** Where the threads are kept. */
  dir: string;
  /** The orchestrators' app-server (workers, command/exec); made on first use. */
  appServer: () => AppServer;
  /** One plain model call (router.ts's makeCallModel in the app; a stand-in in checks). */
  callModel: CallModel;
  caps?: Partial<Caps>;
  log?: (...a: unknown[]) => void;
  /** Every model call and worker, with the full prompt (checks and measurements). */
  trace?: (e: TraceEvent) => void;
}

interface PendingRequest {
  msg: Json;
  threadId: string;
  resolve: (result: Json) => void;
}

const USER_AGENT = "provenance-orchestrator";

export class OrchestratorBackend {
  private opts: OrchestratorBackendOptions;
  private clients = new Set<WebSocket>();
  private threads = new Map<string, ThreadRecord>();
  private running = new Map<string, Run>();
  private requests = new Map<string, PendingRequest>();
  private requestSeq = 1;
  private loaded = false;
  /** Per thread, for this run of the app: what "Approve for session" covered. */
  readonly sessionApprovals = new Map<string, { commands: Set<string>; files: boolean }>();
  readonly caps: Caps;
  readonly log: (...a: unknown[]) => void;

  constructor(opts: OrchestratorBackendOptions) {
    this.opts = opts;
    this.caps = { ...DEFAULT_CAPS, ...opts.caps };
    this.log = opts.log ?? ((...a) => console.log("[orchestrator]", ...a));
  }

  private get threadDir(): string {
    return path.join(this.opts.dir, "threads");
  }

  get appServer(): AppServer {
    return this.opts.appServer();
  }

  get callModel(): CallModel {
    return this.opts.callModel;
  }

  trace(e: TraceEvent): void {
    this.opts.trace?.(e);
  }

  attach(ws: WebSocket): void {
    this.clients.add(ws);
    this.send(ws, {
      method: "bridge/status",
      params: { state: "ready", initializeResult: { userAgent: USER_AGENT }, generation: 1 },
    });
    // A page that just loaded still has to see the approvals a turn is waiting on.
    for (const r of this.requests.values()) this.send(ws, r.msg);
    ws.on("message", (data) => {
      let msg: Json;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.id === undefined || msg.id === null) return;
      if (typeof msg.method !== "string") {
        // The answer to one of our requests (an approval).
        const r = this.requests.get(String(msg.id));
        // (the page refuses request types it has no card for with a JSON-RPC error: kept as such)
        if (r)
          r.resolve(
            msg.error ? { decision: "decline", rpcError: msg.error } : ((msg.result ?? {}) as Json),
          );
        return;
      }
      const id = msg.id;
      this.handle(msg.method, (msg.params ?? {}) as Json)
        .then((result) => this.send(ws, { id, result }))
        .catch((e: unknown) => this.send(ws, { id, error: { code: -32000, message: errText(e) } }));
    });
    ws.on("close", () => this.clients.delete(ws));
  }

  /** Stop every running turn (the app is quitting). */
  stop(): void {
    for (const r of this.running.values()) r.interrupt();
  }

  // ---- requests --------------------------------------------------------------------

  async handle(method: string, p: Json): Promise<unknown> {
    this.load();
    switch (method) {
      case "initialize":
        return { userAgent: USER_AGENT };
      case "thread/list": {
        const data = [...this.threads.values()]
          .filter((t) => !t.archived)
          .map((t) => this.threadView(t))
          .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
          .slice(0, typeof p.limit === "number" ? p.limit : 100);
        return { data, nextCursor: null, backwardsCursor: null, readStates: null };
      }
      case "thread/start":
        return this.startThread(p);
      case "thread/resume":
        return this.threadResponse(this.get(p.threadId));
      case "thread/read":
        return { thread: this.threadView(this.get(p.threadId)) };
      case "thread/turns/list": {
        const t = this.get(p.threadId);
        const turns = p.sortDirection === "asc" ? t.turns : t.turns.slice().reverse();
        const limit = typeof p.limit === "number" ? p.limit : 50;
        return { data: turns.slice(0, limit), nextCursor: null, backwardsCursor: null };
      }
      case "thread/archive": {
        const t = this.get(p.threadId);
        this.running.get(t.thread.id)?.interrupt();
        t.archived = true;
        this.save(t);
        this.broadcast("thread/archived", { threadId: t.thread.id });
        return {};
      }
      case "thread/name/set": {
        const t = this.get(p.threadId);
        t.thread.name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : null;
        this.save(t);
        this.broadcast("thread/name/updated", { threadId: t.thread.id, threadName: t.thread.name });
        return {};
      }
      case "turn/start":
        return this.startTurn(p);
      case "turn/interrupt":
        this.running.get(String(p.threadId))?.interrupt();
        return {};
      default:
        throw new Error(`${method} is not available for orchestrator threads`);
    }
  }

  private get(id: unknown): ThreadRecord {
    const t = typeof id === "string" ? this.threads.get(id) : undefined;
    if (!t) throw new Error(`no orchestrator thread ${String(id)}`);
    return t;
  }

  private startThread(p: Json): unknown {
    const want = (p.config as Json | null | undefined)?.orchestrator ?? p.orchestrator;
    if (!isOrchestrator(want) || want === "provenance")
      throw new Error(
        "An orchestrator thread needs config.orchestrator: experimental or hyperexperimental",
      );
    const model = typeof p.model === "string" ? p.model.trim() : "";
    if (!model || model.includes(":"))
      throw new Error("An orchestrator thread needs a tier as its model");
    const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : process.env.HOME || "/";
    if (!isDir(cwd)) throw new Error(`The folder ${cwd} doesn't exist`);
    const now = Math.floor(Date.now() / 1000);
    // The id names the orchestrator: the page reads it there (src/orchestrator/thread.ts).
    const id = `${ORCHESTRATOR_ID_PREFIX}${want}-${randomUUID()}`;
    const rec: ThreadRecord = {
      thread: {
        id,
        sessionId: id,
        forkedFromId: null,
        attachedToThreadId: null,
        parentThreadId: null,
        preview: "",
        ephemeral: false,
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "legacy",
        environments: null,
        extra: { orchestrator: want },
        modelProvider: "tierlm",
        model,
        reasoningEffort: null,
        createdAt: now,
        updatedAt: now,
        recencyAt: null,
        status: { type: "idle" },
        path: null,
        cwd,
        cliVersion: "",
        originator: "provenance-ui",
        source: "unknown",
        canAcceptDirectInput: null,
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        daybreakEnabled: null,
        daybreakProgramPropagationEnrolled: null,
        turns: [],
        orchestrator: want,
      },
      orchestrator: want,
      model,
      sandbox: sandboxMode(p.sandbox) ?? "workspace-write",
      approvalPolicy: p.approvalPolicy ?? "on-request",
      turns: [],
      notes: emptyNotes(),
      summary: "",
    };
    this.threads.set(id, rec);
    this.save(rec);
    this.broadcast("thread/started", { thread: this.threadView(rec) });
    return this.threadResponse(rec);
  }

  private threadView(t: ThreadRecord): Json {
    const status = this.running.has(t.thread.id)
      ? { type: "active", activeFlags: [] }
      : { type: "idle" };
    return { ...t.thread, status, turns: [] };
  }

  private threadResponse(t: ThreadRecord): Json {
    return {
      thread: this.threadView(t),
      model: t.model,
      modelProvider: t.thread.modelProvider,
      cwd: t.thread.cwd,
      serviceTier: null,
      disabledPluginIds: [],
      runtimeWorkspaceRoots: [],
      instructionSources: [],
      approvalPolicy: t.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: sandboxPolicyFor(t.sandbox, t.thread.cwd),
      activePermissionProfile: null,
      reasoningEffort: null,
      multiAgentMode: "explicitRequestOnly",
      orchestrator: t.orchestrator,
    };
  }

  private startTurn(p: Json): unknown {
    const t = this.get(p.threadId);
    if (this.running.has(t.thread.id)) throw new Error("A turn is already running in this thread");
    const typed = inputText(p.input);
    const context = t.turns.length ? "" : contextText(p.additionalContext);
    if (!typed.trim() && !context.trim()) throw new Error("Nothing to send");
    if (context) {
      if (t.orchestrator === "hyperexperimental") t.summary = clipMiddle(context, SUMMARY_LIMIT);
      else t.notes.requests = [clipMiddle(context, HANDOVER_GOAL_CHARS)];
    }
    // A turn that only carries on asks the orchestrator to go on.
    const text = typed.trim() ? typed : "continue";
    if (typeof p.model === "string" && p.model) {
      if (p.model.includes(":")) throw new Error("This thread runs on the tiers");
      t.model = p.model;
      t.thread.model = p.model;
    }
    if (typeof p.cwd === "string" && p.cwd && isDir(p.cwd)) t.thread.cwd = p.cwd;
    // The composer's preset, as it stands for this turn (and the next ones).
    const mode = policyMode(p.sandboxPolicy);
    if (mode) t.sandbox = mode;
    if (p.approvalPolicy !== undefined && p.approvalPolicy !== null)
      t.approvalPolicy = p.approvalPolicy;

    const now = Math.floor(Date.now() / 1000);
    const turn: TurnRecord = {
      id: `orct-${randomUUID()}`,
      rootTurnId: null,
      items: [],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: now,
      completedAt: null,
      durationMs: null,
    };
    t.turns.push(turn);
    if (!t.thread.preview && typed.trim()) t.thread.preview = typed.slice(0, 400);
    t.thread.updatedAt = now;
    const run = new Run(this, t, turn, text);
    this.running.set(t.thread.id, run);
    this.save(t);

    const threadId = t.thread.id;
    this.broadcast("thread/status/changed", {
      threadId,
      status: { type: "active", activeFlags: [] },
    });
    this.broadcast("turn/started", { threadId, turn: { ...turn, items: [] } });
    const user = typed.trim() ? userMessage(`${turn.id}-user`, typed) : null;
    if (user) run.complete(user, true);
    // Answer turn/start first, then run.
    setImmediate(() => void this.runTurn(t, run));
    return { turn: { ...turn, items: user ? [user] : [] } };
  }

  private async runTurn(t: ThreadRecord, run: Run): Promise<void> {
    const threadId = t.thread.id;
    const turn = run.turn;
    const t0 = mono.now();
    let failure: string | null = null;
    try {
      if (t.orchestrator === "experimental") await runExperimental(run);
      else await runHyper(run);
    } catch (e) {
      if (run.interrupted || e instanceof Interrupted) run.interrupted = true;
      else if (e instanceof StopTurn && e.kind === "cap") {
        // A guard stopped the work: say so plainly, with where things stand.
        run.stats.stopped = e.message;
        const standing = t.orchestrator === "experimental" ? notesText(t.notes) : t.summary;
        run.say(`${e.message}${standing ? `\n\nWhere things stand:\n\n${standing}` : ""}`);
      } else if (e instanceof StopTurn) {
        failure = e.message;
        // What was done stays in the notes / summary: the next message can take it up.
        const kept = t.orchestrator === "experimental" ? t.notes.done.length > 0 : !!t.summary;
        if (e.kind === "router" && kept)
          failure += ' What was done so far is kept: send "continue" to go on from there.';
      } else {
        failure = `The orchestrator hit an error: ${errText(e)}`;
        this.log(`turn failed in ${threadId}:`, e);
      }
    }
    run.close();
    this.running.delete(threadId);
    // Whatever was still running when the turn ended didn't finish.
    for (const item of turn.items) {
      if (item.status !== "inProgress") continue;
      item.status = "failed";
      item.completedAtMs = Date.now();
      this.broadcast("item/completed", { threadId, turnId: turn.id, item });
    }
    turn.completedAt = Math.floor(Date.now() / 1000);
    turn.durationMs = Math.round(mono.now() - t0);
    turn.status = run.interrupted ? "interrupted" : failure ? "failed" : "completed";
    turn.error =
      failure && !run.interrupted
        ? { message: failure, codexErrorInfo: null, additionalDetails: null, misalignment: null }
        : null;
    turn.orchestration = run.stats;
    t.thread.updatedAt = turn.completedAt;
    this.save(t);
    if (turn.error)
      this.broadcast("error", {
        threadId,
        turnId: turn.id,
        error: { message: failure, codexErrorInfo: null, additionalDetails: null },
        willRetry: false,
      });
    this.broadcast("turn/completed", { threadId, turn });
    this.broadcast("thread/status/changed", { threadId, status: { type: "idle" } });
  }

  // ---- approvals: our requests to the page ------------------------------------------

  /** Ask the page (an approval). Resolves with its answer; `cancel()` withdraws the question. */
  request(
    threadId: string,
    method: string,
    params: Json,
  ): { answer: Promise<Json>; cancel: () => void } {
    const id = `orc-req-${this.requestSeq++}`;
    const msg = { id, method, params };
    let settle!: (r: Json) => void;
    const answer = new Promise<Json>((res) => (settle = res));
    const resolve = (result: Json) => {
      if (!this.requests.delete(id)) return;
      this.broadcast("serverRequest/resolved", { threadId, requestId: id });
      settle(result);
    };
    this.requests.set(id, { msg, threadId, resolve });
    this.broadcastRaw(msg);
    return { answer, cancel: () => resolve({ decision: "cancel" }) };
  }

  // ---- store -----------------------------------------------------------------------

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    mkdirSync(this.threadDir, { recursive: true });
    for (const f of readdirSync(this.threadDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(path.join(this.threadDir, f), "utf8")) as ThreadRecord;
        if (!rec?.thread?.id || !Array.isArray(rec.turns)) continue;
        rec.notes = { ...emptyNotes(), ...rec.notes };
        rec.summary = typeof rec.summary === "string" ? rec.summary : "";
        // A turn left running by a quit or crash didn't finish, nor did what it was in.
        for (const turn of rec.turns) {
          if (turn.status !== "inProgress") continue;
          turn.status = "interrupted";
          turn.completedAt ??= turn.startedAt;
          for (const item of turn.items) if (item.status === "inProgress") item.status = "failed";
        }
        this.threads.set(rec.thread.id, rec);
      } catch (e) {
        this.log(`skipped unreadable thread file ${f}: ${String(e)}`);
      }
    }
  }

  save(t: ThreadRecord): void {
    try {
      mkdirSync(this.threadDir, { recursive: true });
      const file = path.join(this.threadDir, `${t.thread.id}.json`);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(t));
      renameSync(tmp, file);
    } catch (e) {
      this.log(`couldn't save thread ${t.thread.id}: ${String(e)}`);
    }
  }

  // ---- wire ------------------------------------------------------------------------

  broadcast(method: string, params: unknown): void {
    this.broadcastRaw({ method, params });
  }

  private broadcastRaw(msg: unknown): void {
    const text = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(text);
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}

/**
 * One user turn as an orchestrator sees it: the thread, the user's message, the abort signal,
 * and the only ways to spend (model calls) or show (items, approvals) anything.
 */
export class Run {
  readonly backend: OrchestratorBackend;
  readonly thread: ThreadRecord;
  readonly turn: TurnRecord;
  /** The user's message for this turn. */
  readonly text: string;
  readonly stats: Stats;
  interrupted = false;
  /** When the turn began (monotonic). */
  readonly t0 = mono.now();
  private ac = new AbortController();
  private open = new Set<() => void>();
  private seq = 0;
  private savedAt = 0;

  constructor(backend: OrchestratorBackend, thread: ThreadRecord, turn: TurnRecord, text: string) {
    this.backend = backend;
    this.thread = thread;
    this.turn = turn;
    this.text = text;
    this.stats = {
      orchestrator: thread.orchestrator,
      modelCalls: 0,
      retries: 0,
      roles: {},
      workers: 0,
      workerCalls: 0,
      workerMaxInputTokens: 0,
      steps: 0,
      stopped: null,
    };
  }

  get signal(): AbortSignal {
    return this.ac.signal;
  }
  get caps(): Caps {
    return this.backend.caps;
  }
  get cwd(): string {
    return this.thread.thread.cwd;
  }
  get threadId(): string {
    return this.thread.thread.id;
  }
  get appServer(): AppServer {
    return this.backend.appServer;
  }

  interrupt(): void {
    this.interrupted = true;
    this.ac.abort();
    this.close();
  }

  /** Withdraw every question still open (the turn is over or interrupted). */
  close(): void {
    for (const cancel of [...this.open]) cancel();
    this.open.clear();
  }

  /** Throws when the turn was interrupted. */
  check(): void {
    if (this.interrupted || this.ac.signal.aborted) throw new Interrupted();
  }

  nextId(kind: string): string {
    return `${this.turn.id}-${kind}${++this.seq}`;
  }

  save(): void {
    this.savedAt = mono.now();
    this.backend.save(this.thread);
  }

  /** Wait, or throw Interrupted the moment the turn is interrupted. */
  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.interrupted || this.ac.signal.aborted) return reject(new Interrupted());
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Interrupted());
      };
      const timer = setTimeout(() => {
        this.ac.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      this.ac.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ---- items -----------------------------------------------------------------------

  private upsert(item: Item): void {
    const i = this.turn.items.findIndex((x) => x.id === item.id);
    if (i === -1) this.turn.items.push(item);
    else this.turn.items[i] = item;
  }

  start(item: Item): void {
    this.upsert(item);
    this.backend.broadcast("item/started", { threadId: this.threadId, turnId: this.turn.id, item });
  }

  complete(item: Item, fresh = false): void {
    const known = this.turn.items.some((x) => x.id === item.id);
    this.upsert(item);
    if (fresh || !known)
      this.backend.broadcast("item/started", {
        threadId: this.threadId,
        turnId: this.turn.id,
        item,
      });
    this.backend.broadcast("item/completed", {
      threadId: this.threadId,
      turnId: this.turn.id,
      item,
    });
    // Keep the file close to what is on screen (a crash mid-task then loses a second, not the task).
    if (mono.now() - this.savedAt > 1000) this.save();
  }

  /** A finished assistant message in the visible thread. */
  say(text: string): void {
    this.complete(agentMessage(this.nextId("msg"), text, true), true);
  }

  /** A status line: one message, rewritten in place under the same id (`done` ends it). */
  status(id: string, text: string, done: boolean): void {
    const item = agentMessage(id, text, done);
    if (done) this.complete(item);
    else this.start(item);
  }

  outputDelta(itemId: string, delta: string): void {
    this.backend.broadcast("item/commandExecution/outputDelta", {
      threadId: this.threadId,
      turnId: this.turn.id,
      itemId,
      delta,
    });
  }

  plan(steps: { step: string; status: "pending" | "inProgress" | "completed" }[]): void {
    this.backend.broadcast("turn/plan/updated", {
      threadId: this.threadId,
      turnId: this.turn.id,
      explanation: null,
      plan: steps,
    });
  }

  notify(method: string, params: Json): void {
    this.backend.broadcast(method, { ...params, threadId: this.threadId, turnId: this.turn.id });
  }

  // ---- spending --------------------------------------------------------------------

  /** What the turn may still spend: model calls and time. */
  left(): { calls: number; ms: number } {
    return {
      calls: this.caps.modelCalls - this.stats.modelCalls,
      ms: this.caps.turnMs - (mono.now() - this.t0),
    };
  }

  /** Count model calls against the turn's cap; throws StopTurn("cap") when it is used up. */
  spend(n = 1, worker = false): void {
    if (this.stats.modelCalls + n > this.caps.modelCalls)
      throw new StopTurn(
        "cap",
        `Stopped: this turn reached its limit of ${this.caps.modelCalls} model calls.`,
      );
    this.stats.modelCalls += n;
    if (worker) this.stats.workerCalls += n;
  }

  /**
   * One plain model call in a new chat: instructions + one user message, nothing else. The
   * prompt is held to PROMPT_BUDGET (an over-long input loses its middle).
   *
   * A call the router can't serve now (429, 5xx, no answer, a timeout, a failed stream, an empty
   * reply) is tried again after each of caps.retryDelaysMs, with a status line in the thread;
   * interrupt ends the wait at once. Only when the waits are used up, or the failure is one that
   * waiting can't cure (a refused token), does the turn end with the plain message. The call
   * counts once against the turn's model calls however often it is tried.
   */
  async model(role: Role, prompt: Prompt, maxOutputTokens?: number): Promise<string> {
    const room = Math.max(1000, PROMPT_BUDGET - prompt.instructions.length);
    const input = prompt.input.length > room ? clipMiddle(prompt.input, room) : prompt.input;
    this.check();
    this.spend();
    const wait = new ModelWait(this);
    // Calls that hang until their own timeout must not stretch the patience to an hour: no new
    // try once the waits plus one call's timeout have passed.
    const t0 = mono.now();
    const patience = this.caps.retryDelaysMs.reduce((a, b) => a + b, 0) + CALL_TIMEOUT_MS;
    for (;;) {
      this.check();
      try {
        const reply = await this.backend.callModel({
          model: this.thread.model,
          instructions: prompt.instructions,
          input,
          signal: this.ac.signal,
          maxOutputTokens,
        });
        wait.end(true);
        const promptChars = prompt.instructions.length + input.length;
        const r = (this.stats.roles[role] ??= { calls: 0, maxPromptChars: 0 });
        r.calls++;
        r.maxPromptChars = Math.max(r.maxPromptChars, promptChars);
        this.backend.trace({
          type: "model",
          role,
          instructions: prompt.instructions,
          input,
          promptChars,
          reply: reply.text,
          ms: reply.ms,
          servedBy: reply.servedBy,
          session: reply.session,
        });
        return reply.text;
      } catch (e) {
        if (this.interrupted || this.ac.signal.aborted) throw new Interrupted();
        if (e instanceof StopTurn) throw e;
        const retryable = e instanceof RouterError ? e.retryable : true;
        if (retryable && wait.left > 0 && mono.now() - t0 < patience) {
          await wait.pause(retryReason(e));
          continue;
        }
        wait.end(false);
        throw new StopTurn(
          "router",
          e instanceof RouterError
            ? routerProblem(e.status, e.message)
            : `The model call failed: ${errText(e)}`,
        );
      }
    }
  }

  // ---- approvals -------------------------------------------------------------------

  /** Ask the page; resolves {decision: "cancel"} if the turn ends first. */
  async ask(method: string, params: Json): Promise<Json> {
    const q = this.backend.request(this.threadId, method, {
      ...params,
      threadId: this.threadId,
      turnId: this.turn.id,
    });
    this.open.add(q.cancel);
    try {
      return await q.answer;
    } finally {
      this.open.delete(q.cancel);
    }
  }
}

/**
 * The waits of one thing that needs a model and can't get one (a plain call, a worker): the
 * schedule is caps.retryDelaysMs, and the thread shows one status line for it, rewritten at each
 * retry ("Waiting for a free model… retry 2 in 20 s") and closed when the wait is over.
 */
export class ModelWait {
  private run: Run;
  private id: string | null = null;
  private t0 = 0;
  /** Retries made so far. */
  retries = 0;

  constructor(run: Run) {
    this.run = run;
  }

  /** Retries still allowed. */
  get left(): number {
    return this.run.caps.retryDelaysMs.length - this.retries;
  }

  /** Show the status line and wait out the next delay. Throws Interrupted on interrupt. */
  async pause(why: string): Promise<void> {
    const ms = this.run.caps.retryDelaysMs[this.retries] ?? 0;
    this.retries++;
    this.run.stats.retries++;
    if (!this.id) {
      this.id = this.run.nextId("wait");
      this.t0 = mono.now();
    }
    this.run.status(
      this.id,
      `Waiting for a free model… retry ${this.retries} in ${seconds(ms)} (${why}).`,
      false,
    );
    try {
      await this.run.sleep(ms);
    } catch (e) {
      this.run.status(this.id, `Stopped while waiting for a free model (${why}).`, true);
      throw e;
    }
  }

  /** Close the status line (a no-op when nothing was waited for). */
  end(ok: boolean): void {
    if (!this.id) return;
    const n = `${this.retries} ${this.retries === 1 ? "retry" : "retries"}`;
    const took = seconds(mono.now() - this.t0);
    this.run.status(
      this.id,
      ok ? `Waited ${took} for a free model (${n}).` : `No model became free in ${took} (${n}).`,
      true,
    );
    this.id = null;
    this.retries = 0;
  }
}

function seconds(ms: number): string {
  const s = ms / 1000;
  return s >= 10 || Number.isInteger(s) ? `${Math.round(s)} s` : `${s.toFixed(1)} s`;
}

// ---- helpers ---------------------------------------------------------------------------

export function sandboxMode(v: unknown): SandboxMode | null {
  return v === "read-only" || v === "workspace-write" || v === "danger-full-access" ? v : null;
}

function policyMode(p: unknown): SandboxMode | null {
  const type = (p as { type?: string } | null)?.type;
  if (type === "readOnly") return "read-only";
  if (type === "dangerFullAccess") return "danger-full-access";
  if (type === "workspaceWrite") return "workspace-write";
  return null;
}

/**
 * The thread's sandbox as an app-server SandboxPolicy. The thread's folder is named as a
 * writable root: command/exec takes the server's own folder as the workspace, not the thread's.
 */
export function sandboxPolicyFor(mode: SandboxMode, cwd: string): Json {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "workspace-write")
    return {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  return { type: "readOnly", networkAccess: false };
}

/**
 * The preset's sandbox as the page sends it with turn/start for a normal thread
 * (src/store/actions.ts sandboxPolicyFor): the thread's own folder is always writable under
 * workspace write, so no root is named. Worker threads are sent the same.
 */
export function pageSandboxPolicy(mode: SandboxMode): Json {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "workspace-write")
    return {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  return { type: "readOnly", networkAccess: false };
}

/** "<cwd> (macOS); contains: a.py, src/, …": a few hundred characters the planner can start from. */
export function folderBrief(cwd: string): string {
  let names: string[] = [];
  try {
    names = readdirSync(cwd, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") || e.name === ".github")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  } catch {
    return `${cwd} (${platformName()}); could not be listed`;
  }
  const shown = names.slice(0, 40);
  const more = names.length - shown.length;
  return `${cwd} (${platformName()}); contains: ${shown.length ? shown.join(", ") : "nothing yet"}${more > 0 ? `, and ${more} more` : ""}`;
}

export function platformName(): string {
  return process.platform === "darwin"
    ? "macOS, zsh"
    : process.platform === "win32"
      ? "Windows"
      : "Linux, sh";
}

function inputText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return (input as Json[])
    .filter((x) => x?.type === "text" && typeof x.text === "string")
    .map((x) => x.text as string)
    .join("\n\n");
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
