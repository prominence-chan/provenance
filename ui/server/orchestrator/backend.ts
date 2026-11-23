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
// context it carries: Experimental's notes, Hyperexperimental's summary.

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
import { agentMessage, userMessage, type Item } from "../fallback/items.ts";
import type { AppServer } from "./appserver.ts";
import { runExperimental } from "./experimental.ts";
import { runHyper } from "./hyper.ts";
import { clipMiddle, emptyNotes, notesText, type Notes } from "./notes.ts";
import { PROMPT_BUDGET, type Prompt } from "./prompts.ts";
import { RouterError, routerProblem, type CallModel } from "./router.ts";

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
  /** One worker's turn. */
  workerMs: number;
  /** A worker with nothing running and no word from the model for this long is stopped. */
  workerIdleMs: number;
  /** One RUN action. */
  commandMs: number;
}

export const DEFAULT_CAPS: Caps = {
  tasks: 10,
  attempts: 2,
  replans: 3,
  steps: 14,
  modelCalls: 80,
  workerMs: 20 * 60_000,
  workerIdleMs: 5 * 60_000,
  commandMs: 120_000,
};

export type Role = "planner" | "revise" | "final" | "think" | "translate" | "summarize";

/** What a turn cost; kept on the turn (`orchestration`) and readable from the thread file. */
export interface Stats {
  orchestrator: Orchestrator;
  /** Plain calls + worker requests. */
  modelCalls: number;
  roles: Partial<Record<Role, { calls: number; maxPromptChars: number }>>;
  workers: number;
  workerCalls: number;
  /** Largest request a worker's harness sent (input tokens, as app-server reports them). */
  workerMaxInputTokens: number;
  steps: number;
  stopped: string | null;
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
    }
  | {
      type: "worker";
      task: string;
      brief: string;
      calls: number;
      maxInputTokens: number;
      status: string;
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
    const text = inputText(p.input);
    if (!text.trim()) throw new Error("Nothing to send");
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
    if (!t.thread.preview) t.thread.preview = text.slice(0, 400);
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
    const user = userMessage(`${turn.id}-user`, text);
    run.complete(user, true);
    // Answer turn/start first, then run.
    setImmediate(() => void this.runTurn(t, run));
    return { turn: { ...turn, items: [user] } };
  }

  private async runTurn(t: ThreadRecord, run: Run): Promise<void> {
    const threadId = t.thread.id;
    const turn = run.turn;
    const t0 = Date.now();
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
      } else if (e instanceof StopTurn) failure = e.message;
      else {
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
    turn.durationMs = Date.now() - t0;
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
    this.savedAt = Date.now();
    this.backend.save(this.thread);
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
    if (Date.now() - this.savedAt > 1000) this.save();
  }

  /** A finished assistant message in the visible thread. */
  say(text: string): void {
    this.complete(agentMessage(this.nextId("msg"), text, true), true);
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
   * prompt is held to PROMPT_BUDGET (an over-long input loses its middle). A router that can't
   * serve (503, 429, a refused token) ends the turn with its message; another failure is tried
   * once more.
   */
  async model(role: Role, prompt: Prompt, maxOutputTokens?: number): Promise<string> {
    const room = Math.max(1000, PROMPT_BUDGET - prompt.instructions.length);
    const input = prompt.input.length > room ? clipMiddle(prompt.input, room) : prompt.input;
    for (let attempt = 0; ; attempt++) {
      this.check();
      this.spend();
      try {
        const reply = await this.backend.callModel({
          model: this.thread.model,
          instructions: prompt.instructions,
          input,
          signal: this.ac.signal,
          maxOutputTokens,
        });
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
        });
        return reply.text;
      } catch (e) {
        if (this.interrupted || this.ac.signal.aborted) throw new Interrupted();
        if (e instanceof StopTurn) throw e;
        const status = e instanceof RouterError ? e.status : -1;
        const final = [503, 429, 401, 403].includes(status) || attempt >= 1;
        if (!final) continue;
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
