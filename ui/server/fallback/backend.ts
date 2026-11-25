// FallbackBackend: threads that run on Claude Code (`claude -p`) or stock Codex (`codex exec`)
// instead of provenance app-server, served to the page over WebSocket /rpc/fallback with the same
// JSON-RPC methods and notifications app-server uses, so the page's store, reducer and thread view
// handle them unchanged.
//
//   requests:      initialize, thread/list, thread/start, thread/resume, thread/turns/list,
//                  thread/archive, thread/name/set, turn/start, turn/interrupt
//   notifications: thread/started, thread/status/changed, thread/archived, turn/started,
//                  item/started, item/agentMessage/delta, item/completed, error, turn/completed
//
// A turn is one CLI run in the thread's folder, with the prompt on stdin; the CLI's session id is
// kept, and the next turn resumes it (claude --resume <id>, codex exec resume <id>). Permissions
// follow the composer's preset: read only -> claude dontAsk / codex -s read-only; auto ->
// acceptEdits / workspace-write; full access -> --dangerously-skip-permissions /
// danger-full-access. The reasoning effort a turn/start carries (`effort`, the composer's choice)
// goes on that run's command line: claude --effort <level>, codex -c model_reasoning_effort=
// "<level>"; a turn without one runs at the CLI's own default. The CLIs can't ask the page for approval, so "Ask every time" runs like
// Auto (the composer and the Fallbacks page warn about it), and anything the CLI itself would
// still ask about is declined by the CLI (and shows as a failed tool row).
//
// Threads are JSON files in <dir>/threads, written when a turn starts and ends. Ids start with
// "fb-" so the page can tell where a thread lives before the lists have loaded.
//
// A conversation moved here from another backend (shared/thread-links.ts) is a thread whose
// first turn carries the hand-over brief in turn/start's `additionalContext` (app-server's field:
// {key: {value, kind}}): it goes to the CLI on stdin before the person's message, and nowhere
// else: not into the turn's items, not into the thread file. Once the CLI has a session the
// brief is in it, and a context sent again is left out. A turn with a context and no message of
// its own (carry on with the work) shows no user message at all.

import { execFile, spawn, type ChildProcess } from "node:child_process";
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
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { WebSocket } from "ws";
import { parseFallbackModel, type FallbackUsage } from "../../shared/fallback-api.ts";
import { isFallbackEffort, type FallbackEffort } from "../../shared/orchestrator-api.ts";
import { AgyStream } from "./agy-stream.ts";
import { ClaudeStream } from "./claude-stream.ts";
import { envWithPath, findCli, isWinBatch } from "./cli.ts";
import { CodexStream } from "./codex-stream.ts";
import { contextText, userMessage, type Item, type Sink } from "./items.ts";

type Json = Record<string, unknown>;
type Mode = "claude" | "codex" | "antigravity";
type Sandbox = "read-only" | "workspace-write" | "danger-full-access";

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
}

interface ThreadRecord {
  thread: Json & { id: string; cwd: string; turns: [] };
  mode: Mode;
  /** The CLI's --model ("" = its default). */
  model: string;
  /** The CLI's own session / thread id (claude session_id, codex thread_id). */
  session: string | null;
  sandbox: Sandbox;
  /** The reasoning effort its last turn ran at (null: the CLI's default). */
  effort?: FallbackEffort | null;
  turns: TurnRecord[];
  archived?: boolean;
}

interface Running {
  child: ChildProcess | null;
  turn: TurnRecord;
  interrupted: boolean;
}

export interface FallbackBackendOptions {
  /** Where the threads are kept. */
  dir: string;
  /** PATH-style list of folders to find claude / codex in. */
  searchPath: () => string;
  log?: (...a: unknown[]) => void;
}

const PROVIDER: Record<Mode, string> = {
  claude: "claude-code",
  codex: "codex-cli",
  antigravity: "antigravity",
};
const MODE_TITLE: Record<Mode, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};
const MODE_BIN: Record<Mode, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
};

export class FallbackBackend {
  private opts: FallbackBackendOptions;
  private clients = new Set<WebSocket>();
  private threads = new Map<string, ThreadRecord>();
  private running = new Map<string, Running>();
  private loaded = false;
  private log: (...a: unknown[]) => void;

  constructor(opts: FallbackBackendOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((...a) => console.log("[fallback]", ...a));
  }

  private get threadDir(): string {
    return path.join(this.opts.dir, "threads");
  }

  attach(ws: WebSocket): void {
    this.clients.add(ws);
    this.send(ws, {
      method: "bridge/status",
      params: {
        state: "ready",
        initializeResult: { userAgent: "provenance-fallback" },
        generation: 1,
      },
    });
    ws.on("message", (data) => {
      let msg: Json;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof msg.method !== "string" || msg.id === undefined || msg.id === null) return;
      const id = msg.id;
      this.handle(msg.method, (msg.params ?? {}) as Json)
        .then((result) => this.send(ws, { id, result }))
        .catch((e: unknown) =>
          this.send(ws, {
            id,
            error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
          }),
        );
    });
    ws.on("close", () => this.clients.delete(ws));
  }

  /** Stop every running turn (the app is quitting). */
  stop(): void {
    for (const r of this.running.values()) r.child?.kill("SIGTERM");
  }

  // ---- requests --------------------------------------------------------------------

  async handle(method: string, p: Json): Promise<unknown> {
    this.load();
    switch (method) {
      case "initialize":
        return { userAgent: "provenance-fallback" };
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
      case "thread/resume": {
        const t = this.get(p.threadId);
        return this.threadResponse(t);
      }
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
      case "turn/interrupt": {
        const r = this.running.get(String(p.threadId));
        if (r) {
          r.interrupted = true;
          killGently(r.child);
        }
        return {};
      }
      default:
        throw new Error(`${method} is not available for Claude Code / Codex threads`);
    }
  }

  private get(id: unknown): ThreadRecord {
    const t = typeof id === "string" ? this.threads.get(id) : undefined;
    if (!t) throw new Error(`no fallback thread ${String(id)}`);
    return t;
  }

  private startThread(p: Json): unknown {
    const parsed = parseFallbackModel(typeof p.model === "string" ? p.model : null);
    if (!parsed || parsed.mode === "codex-pv")
      throw new Error(
        "A fallback thread needs a claude:<model>, codex:<model>, or antigravity:<model> model",
      );
    const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : process.env.HOME || "/";
    if (!isDir(cwd)) throw new Error(`The folder ${cwd} doesn't exist`);
    const now = Math.floor(Date.now() / 1000);
    const id = `fb-${randomUUID()}`;
    const mode = parsed.mode as Mode;
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
        extra: null,
        modelProvider: PROVIDER[mode],
        model: `${mode}:${parsed.model}`,
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
      },
      mode,
      model: parsed.model,
      session: null,
      sandbox: sandboxFrom(p.sandbox, p.approvalPolicy),
      turns: [],
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
    return { ...t.thread, reasoningEffort: t.effort ?? null, status, turns: [] };
  }

  private threadResponse(t: ThreadRecord): Json {
    return {
      thread: this.threadView(t),
      model: t.thread.model,
      modelProvider: t.thread.modelProvider,
      cwd: t.thread.cwd,
      serviceTier: null,
      disabledPluginIds: [],
      runtimeWorkspaceRoots: [],
      instructionSources: [],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite" },
      activePermissionProfile: null,
      reasoningEffort: t.effort ?? null,
      multiAgentMode: "explicitRequestOnly",
    };
  }

  private startTurn(p: Json): unknown {
    const t = this.get(p.threadId);
    if (this.running.has(t.thread.id)) throw new Error("A turn is already running in this thread");
    const text = inputText(p.input);
    // What the model is told before the message (a hand-over brief): only into a new session.
    const context = t.session ? "" : contextText(p.additionalContext);
    if (!text.trim() && !context.trim()) throw new Error("Nothing to send");
    if (typeof p.model === "string" && p.model) {
      const m = parseFallbackModel(p.model);
      if (!m || m.mode !== t.mode) throw new Error(`This thread runs on ${MODE_TITLE[t.mode]}`);
      t.model = m.model;
      t.thread.model = `${t.mode}:${m.model}`;
    }
    if (typeof p.cwd === "string" && p.cwd && isDir(p.cwd)) t.thread.cwd = p.cwd;
    if (p.sandboxPolicy || p.approvalPolicy)
      t.sandbox = sandboxFrom(policyMode(p.sandboxPolicy) ?? t.sandbox, p.approvalPolicy);
    // Each turn says its effort (the page sends its choice every time); none: the CLI's default.
    t.effort = isFallbackEffort(p.effort) ? p.effort : null;

    const now = Math.floor(Date.now() / 1000);
    const turn: TurnRecord = {
      id: `fbt-${randomUUID()}`,
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
    if (!t.thread.preview && text.trim()) t.thread.preview = text.slice(0, 400);
    t.thread.updatedAt = now;
    const run: Running = { child: null, turn, interrupted: false };
    this.running.set(t.thread.id, run);
    this.save(t);

    const threadId = t.thread.id;
    this.broadcast("thread/status/changed", {
      threadId,
      status: { type: "active", activeFlags: [] },
    });
    this.broadcast("turn/started", { threadId, turn: { ...turn, items: [] } });
    // The person's message exactly as typed; none when the turn only carries on.
    const user = text.trim() ? userMessage(`${turn.id}-user`, text) : null;
    if (user) {
      this.upsert(turn, user);
      this.broadcast("item/started", { threadId, turnId: turn.id, item: user });
      this.broadcast("item/completed", { threadId, turnId: turn.id, item: user });
    }
    const prompt = context ? (text.trim() ? `${context}\n\n${text}` : context) : text;
    // Answer turn/start first, then run (a spawn error still ends the turn the usual way).
    setImmediate(() => this.runTurn(t, run, prompt));
    return { turn: { ...turn, items: user ? [user] : [] } };
  }

  private runTurn(t: ThreadRecord, run: Running, prompt: string): void {
    const threadId = t.thread.id;
    const turn = run.turn;
    const t0 = Date.now();
    let failure: string | null = null;
    let ended = false;
    const sink: Sink & { usage?: (u: FallbackUsage) => void } = {
      started: (item) => {
        this.upsert(turn, item);
        this.broadcast("item/started", { threadId, turnId: turn.id, item });
      },
      delta: (itemId, delta) => {
        const it = turn.items.find((i) => i.id === itemId);
        if (it && typeof it.text === "string") it.text += delta;
        this.broadcast("item/agentMessage/delta", { threadId, turnId: turn.id, itemId, delta });
      },
      completed: (item) => {
        this.upsert(turn, item);
        this.broadcast("item/completed", { threadId, turnId: turn.id, item });
      },
      session: (id) => {
        if (t.session !== id) {
          t.session = id;
          this.save(t);
        }
      },
      error: (message, fatal) => {
        if (fatal) failure = message;
        this.broadcast("error", {
          threadId,
          turnId: turn.id,
          error: { message, codexErrorInfo: null, additionalDetails: null },
          willRetry: !fatal,
        });
      },
      done: (status, message) => {
        if (status === "failed") failure = message ?? "failed";
      },
      usage: (u: FallbackUsage) => {
        this.saveUsage(t.mode, u);
      },
    };
    const searchPath = this.opts.searchPath();
    const binName = MODE_BIN[t.mode];
    const bin = findCli(binName, searchPath);
    const finish = () => {
      if (ended) return;
      ended = true;
      this.running.delete(threadId);
      turn.completedAt = Math.floor(Date.now() / 1000);
      turn.durationMs = Date.now() - t0;
      turn.status = run.interrupted ? "interrupted" : failure ? "failed" : "completed";
      turn.error =
        failure && !run.interrupted
          ? { message: failure, codexErrorInfo: null, additionalDetails: null, misalignment: null }
          : null;
      t.thread.updatedAt = turn.completedAt;
      this.save(t);
      this.broadcast("turn/completed", { threadId, turn });
      this.broadcast("thread/status/changed", { threadId, status: { type: "idle" } });
    };
    if (!bin) {
      failure = `${MODE_TITLE[t.mode]} isn't installed (no \`${binName}\` found)`;
      return finish();
    }
    const cwd = isDir(t.thread.cwd) ? t.thread.cwd : homedir();
    const args =
      t.mode === "claude"
        ? claudeArgs(t)
        : t.mode === "antigravity"
          ? agyArgs(t)
          : codexArgs(t, cwd);
    const parser =
      t.mode === "claude"
        ? new ClaudeStream(sink, cwd, turn.id)
        : t.mode === "antigravity"
          ? new AgyStream(sink, cwd, turn.id)
          : new CodexStream(sink, cwd, turn.id);
    const env = envWithPath(process.env, searchPath);
    // A nested Claude Code session (the app started from one) would refuse to run.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    this.log(`${t.mode} turn in ${cwd}: ${path.basename(bin)} ${args.join(" ")}`);
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: isWinBatch(bin),
      });
    } catch (e) {
      failure = `Couldn't start ${t.mode}: ${String(e)}`;
      return finish();
    }
    run.child = child;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on("error", (e) => {
      failure = `Couldn't start ${t.mode}: ${e.message}`;
      finish();
    });
    const lines = readline.createInterface({ input: child.stdout! });
    lines.on("line", (l) => {
      if (l.trim()) parser.line(l);
    });
    child.on("close", (code, signal) => {
      parser.end();
      if (!parser.done && !run.interrupted && !failure) {
        const tail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" · ");
        failure = `${t.mode} stopped (${signal ?? `exit ${code}`})${tail ? `: ${tail.slice(0, 400)}` : ""}`;
      }
      finish();
    });
    child.stdin?.on("error", () => {}); // it may exit before reading everything
    const stdinBody =
      t.mode === "antigravity"
        ? `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`
        : prompt;
    child.stdin?.end(stdinBody);
  }

  private upsert(turn: TurnRecord, item: Item): void {
    const i = turn.items.findIndex((x) => x.id === item.id);
    if (i === -1) turn.items.push(item);
    else turn.items[i] = item;
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
        if (!rec?.thread?.id) continue;
        // A turn left running by a quit or crash didn't finish.
        for (const turn of rec.turns)
          if (turn.status === "inProgress") {
            turn.status = "interrupted";
            turn.completedAt ??= turn.startedAt;
          }
        this.threads.set(rec.thread.id, rec);
      } catch (e) {
        this.log(`skipped unreadable thread file ${f}: ${String(e)}`);
      }
    }
  }

  private saveUsage(mode: Mode, usage: FallbackUsage): void {
    try {
      mkdirSync(this.opts.dir, { recursive: true });
      const file = path.join(this.opts.dir, "usage.json");
      let cur: Record<string, FallbackUsage> = {};
      if (existsSync(file)) {
        try {
          cur = JSON.parse(readFileSync(file, "utf8")) as Record<string, FallbackUsage>;
        } catch {
          cur = {};
        }
      }
      const prev = cur[mode];
      cur[mode] = {
        weeklyRemaining: usage.weeklyRemaining ?? prev?.weeklyRemaining ?? null,
        weeklyResetsAt: usage.weeklyResetsAt ?? prev?.weeklyResetsAt ?? null,
        primaryRemaining: usage.primaryRemaining ?? prev?.primaryRemaining ?? null,
        primaryResetsAt: usage.primaryResetsAt ?? prev?.primaryResetsAt ?? null,
        updatedAt: usage.updatedAt,
      };
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(cur, null, 2));
      renameSync(tmp, file);
    } catch {
      // ignore usage cache write failure
    }
  }

  private save(t: ThreadRecord): void {
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

  private broadcast(method: string, params: unknown): void {
    const text = JSON.stringify({ method, params });
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(text);
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}

// ---- argv --------------------------------------------------------------------------

export function claudeArgs(t: {
  model: string;
  session: string | null;
  sandbox: Sandbox;
  effort?: FallbackEffort | null;
}): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (t.sandbox === "danger-full-access") args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", t.sandbox === "read-only" ? "dontAsk" : "acceptEdits");
  if (t.model) args.push("--model", t.model);
  if (t.effort) args.push("--effort", t.effort);
  if (t.session) args.push("--resume", t.session);
  return args;
}

export function agyArgs(t: {
  model: string;
  session: string | null;
  sandbox: Sandbox;
  effort?: FallbackEffort | null;
}): string[] {
  // Streaming JSON on stdin/stdout avoids `-p` flag-value ambiguity and OS command-line length limits.
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (t.sandbox === "danger-full-access") args.push("--dangerously-skip-permissions");
  else if (t.sandbox === "read-only") args.push("--mode", "plan", "--sandbox");
  else args.push("--mode", "accept-edits");
  if (t.model) args.push("--model", t.model);
  if (t.effort) args.push("--effort", t.effort);
  if (t.session) args.push("--conversation", t.session);
  return args;
}

export function codexArgs(
  t: { model: string; session: string | null; sandbox: Sandbox; effort?: FallbackEffort | null },
  cwd: string,
): string[] {
  const model = [
    ...(t.model ? ["-m", t.model] : []),
    ...(t.effort ? ["-c", `model_reasoning_effort="${t.effort}"`] : []),
  ];
  if (t.session)
    return [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      `sandbox_mode="${t.sandbox}"`,
      ...model,
      t.session,
      "-",
    ];
  return ["exec", "--json", "--skip-git-repo-check", "-s", t.sandbox, ...model, "-C", cwd, "-"];
}

function sandboxFrom(sandbox: unknown, approval: unknown): Sandbox {
  // "Ask every time" can't ask here: it runs like Auto, without asking (the page says so). Never
  // more than that: full access only when the preset itself is Full access.
  if (approval === "untrusted") return "workspace-write";
  return sandbox === "read-only" || sandbox === "danger-full-access" ? sandbox : "workspace-write";
}

function policyMode(p: unknown): Sandbox | null {
  const type = (p as { type?: string } | null)?.type;
  if (type === "readOnly") return "read-only";
  if (type === "dangerFullAccess") return "danger-full-access";
  if (type === "workspaceWrite") return "workspace-write";
  return null;
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

/** Stop a fallback CLI cleanly across macOS, Linux, and Windows. */
function killGently(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      child.kill();
    } catch {
      // ignore
    }
    const pid = child.pid;
    const hard = setTimeout(() => {
      if (child.exitCode === null && pid) {
        execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
      }
    }, 2500);
    child.once("close", () => clearTimeout(hard));
    return;
  }
  child.kill("SIGINT");
  const term = setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 2500);
  const kill = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 6000);
  child.once("close", () => {
    clearTimeout(term);
    clearTimeout(kill);
  });
}
