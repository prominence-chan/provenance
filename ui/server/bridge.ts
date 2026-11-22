// AppServerBridge: owns ONE `provenance app-server` child process (JSON-RPC over
// newline-delimited JSON on stdio) and multiplexes it to any number of browser
// WebSocket clients.
//
// Why one shared process instead of one per tab: turns keep running (and
// approvals stay answerable) across page reloads, and several tabs see the same
// live threads.
//
// What the bridge does to messages:
//   - client requests  {id, method, params}: id is rewritten to a bridge-unique
//     upstream id, and restored on the response so each client sees its own ids.
//   - `initialize` / `initialized` from clients are answered/dropped locally; the
//     bridge performs the real handshake once per child process.
//   - server notifications {method, params}: broadcast to every client.
//   - server requests {id, method, params} (approvals etc.): broadcast to every
//     client and remembered until someone answers, so a freshly loaded tab still
//     sees pending approvals. Client responses are forwarded upstream as-is.
//   - the bridge emits its own notification `bridge/status` (see BridgeStatus).
//
// If the binary is missing (e.g. being replaced by a rebuild) or the child exits,
// the bridge retries with backoff and reports status to clients.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import readline from "node:readline";
import type { WebSocket } from "ws";

type Id = number | string;
type Json = Record<string, unknown>;

export type BridgeStatus =
  | { state: "starting"; attempt: number }
  | { state: "ready"; initializeResult: unknown; generation: number }
  | { state: "down"; error: string; retryInMs: number };

export interface BridgeOptions {
  bin: string;
  args?: string[];
  clientInfo: { name: string; title: string | null; version: string };
  /** Extra environment, read at every start (the router's URL can change between starts). */
  env?: () => NodeJS.ProcessEnv;
  log?: (...args: unknown[]) => void;
}

interface PendingClientRequest {
  ws: WebSocket;
  clientId: Id;
}

export class AppServerBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private clients = new Set<WebSocket>();
  private nextUpstreamId = 1;
  private pending = new Map<Id, PendingClientRequest>();
  /** Server -> client requests that nobody has answered yet, keyed by id. */
  private serverRequests = new Map<string, Json>();
  private status: BridgeStatus = { state: "starting", attempt: 0 };
  private generation = 0;
  private attempt = 0;
  private stopped = false;
  /** The pending retry after a failed start: cleared by restart() and stop(), or two would run. */
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly log: (...args: unknown[]) => void;
  private readonly opts: BridgeOptions;

  constructor(opts: BridgeOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((...a) => console.log("[bridge]", ...a));
  }

  start(): void {
    this.stopped = false;
    void this.launch();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.child?.kill();
    this.child = null;
  }

  /** Start a fresh app-server now (it reads its environment, e.g. the router's URL, at start). */
  restart(): void {
    clearTimeout(this.retryTimer);
    const old = this.child;
    this.child = null; // its exit handler then does nothing
    old?.kill();
    this.failPending("app-server restarted");
    this.attempt = 0;
    if (!this.stopped) void this.launch();
  }

  // ---- client side -------------------------------------------------------

  attach(ws: WebSocket): void {
    this.clients.add(ws);
    this.sendTo(ws, { method: "bridge/status", params: this.status });
    for (const req of this.serverRequests.values()) this.sendTo(ws, req);

    ws.on("message", (data) => {
      let msg: Json;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      this.fromClient(ws, msg);
    });
    ws.on("close", () => {
      this.clients.delete(ws);
      for (const [upId, p] of this.pending) if (p.ws === ws) this.pending.delete(upId);
    });
  }

  private fromClient(ws: WebSocket, msg: Json): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === "string" ? msg.method : undefined;

    // Response to a server-initiated request (approval decision etc.).
    if (hasId && !method) {
      const key = String(msg.id);
      if (!this.serverRequests.has(key)) return; // already answered by another tab
      this.serverRequests.delete(key);
      this.writeUpstream(msg);
      return;
    }
    if (!method) return;

    // Notification from client.
    if (!hasId) {
      if (method === "initialized") return; // bridge already sent it upstream
      this.writeUpstream(msg);
      return;
    }

    const clientId = msg.id as Id;
    if (method === "initialize") {
      if (this.status.state === "ready") {
        this.sendTo(ws, { id: clientId, result: this.status.initializeResult });
      } else {
        this.sendTo(ws, { id: clientId, error: { code: -32000, message: "app-server not ready" } });
      }
      return;
    }
    if (!this.child || this.status.state !== "ready") {
      this.sendTo(ws, {
        id: clientId,
        error: { code: -32000, message: `app-server not ready (${this.status.state})` },
      });
      return;
    }
    const upId = this.nextUpstreamId++;
    this.pending.set(upId, { ws, clientId });
    this.writeUpstream({ ...msg, id: upId });
  }

  // ---- upstream side -----------------------------------------------------

  private async launch(): Promise<void> {
    if (this.stopped) return;
    this.attempt += 1;
    this.setStatus({ state: "starting", attempt: this.attempt });

    if (!existsSync(this.opts.bin)) {
      this.scheduleRetry(`binary not found: ${this.opts.bin}`);
      return;
    }

    const child = spawn(this.opts.bin, ["app-server", ...(this.opts.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.opts.env?.() },
    });
    this.child = child;
    const gen = ++this.generation;
    const internal = new Map<Id, (msg: Json) => void>();

    child.on("error", (err) => {
      if (this.child === child) this.child = null;
      this.scheduleRetry(`spawn failed: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.failPending("app-server exited");
      this.scheduleRetry(`app-server exited (code ${code ?? "null"}, signal ${signal ?? "none"})`);
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString().trimEnd();
      if (text) this.log("[app-server stderr]", text);
    });

    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log("non-JSON line from app-server:", line.slice(0, 200));
        return;
      }
      const id = msg.id as Id | undefined;
      // Responses to the bridge's own handshake requests.
      if (id !== undefined && !msg.method && internal.has(id)) {
        internal.get(id)!(msg);
        internal.delete(id);
        return;
      }
      this.fromUpstream(msg);
    });

    // Handshake.
    const initId = `bridge-init-${gen}`;
    const initResult = await new Promise<Json>((resolve) => {
      internal.set(initId, resolve);
      this.writeUpstream({
        id: initId,
        method: "initialize",
        params: {
          clientInfo: this.opts.clientInfo,
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      });
    });
    if (this.child !== child) return;
    if (initResult.error) {
      child.kill();
      this.scheduleRetry(`initialize failed: ${JSON.stringify(initResult.error)}`);
      return;
    }
    this.writeUpstream({ method: "initialized" });
    this.attempt = 0;
    this.serverRequests.clear();
    this.setStatus({ state: "ready", initializeResult: initResult.result, generation: gen });
    this.log(`app-server ready (pid ${child.pid})`);
  }

  private fromUpstream(msg: Json): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && !msg.method) {
      // Response to a client request.
      const p = this.pending.get(msg.id as Id);
      if (!p) return;
      this.pending.delete(msg.id as Id);
      this.sendTo(p.ws, { ...msg, id: p.clientId });
      return;
    }
    if (hasId && msg.method) {
      // Server -> client request: remember until answered.
      this.serverRequests.set(String(msg.id), msg);
    } else if (msg.method === "serverRequest/resolved") {
      const params = msg.params as { requestId?: Id } | undefined;
      if (params?.requestId !== undefined) this.serverRequests.delete(String(params.requestId));
    }
    this.broadcast(msg);
  }

  private writeUpstream(msg: Json): void {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  private failPending(reason: string): void {
    for (const [, p] of this.pending) {
      this.sendTo(p.ws, { id: p.clientId, error: { code: -32001, message: reason } });
    }
    this.pending.clear();
  }

  private scheduleRetry(error: string): void {
    if (this.stopped) return;
    const retryInMs = Math.min(1000 * 2 ** Math.max(0, this.attempt - 1), 10_000);
    this.log(`${error}; retrying in ${retryInMs}ms`);
    this.setStatus({ state: "down", error, retryInMs });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.launch(), retryInMs);
  }

  private setStatus(status: BridgeStatus): void {
    this.status = status;
    this.broadcast({ method: "bridge/status", params: status });
  }

  private broadcast(msg: Json): void {
    const text = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(text);
  }

  private sendTo(ws: WebSocket, msg: Json): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}
