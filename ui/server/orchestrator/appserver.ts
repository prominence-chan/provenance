// The orchestrators' own `provenance app-server`: a third process (after /rpc's and /rpc/codex's)
// that only this backend talks to, started on first use. It runs the worker threads of
// Experimental and the sandboxed commands of Hyperexperimental (command/exec).
//
// Why its own process and not the page's: app-server broadcasts every thread's events to every
// client of the bridge, so worker threads on the shared one would show up in the page's list and
// their approval requests would reach the page under ids it can't place. Here the backend is the
// only client: it decides what the page sees. Same binary, same home (so the same config, rules
// and login), same router environment as the main one.
//
// The process is started in an empty folder of its own: command/exec's sandbox takes the SERVER's
// working directory as the workspace root (codex-rs app-server command_exec_processor.rs), so it
// must not be a folder that matters; a thread's folder is passed as an explicit writable root.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import readline from "node:readline";

type Json = Record<string, unknown>;

export interface ServerMessage {
  /** Present on a server -> client request (an approval): answer with respond(). */
  id?: number | string;
  method: string;
  params: Json;
}

/** What the orchestrators need from an app-server (the real one below, or a stand-in in checks). */
export interface AppServer {
  request(method: string, params: unknown): Promise<Json>;
  respond(id: number | string, result: unknown): void;
  /** Refuse a server request (one the page has no answer for). */
  respondError(id: number | string, code: number, message: string): void;
  /** Notifications and server requests; returns the unsubscribe. */
  listen(fn: (msg: ServerMessage) => void): () => void;
  /** Called when the process goes away (everything in flight is lost). */
  onExit(fn: (reason: string) => void): () => void;
  stop(): void;
}

export interface AppServerOptions {
  bin: string;
  /** Extra environment, read at every start (the router's URL can change). */
  env: () => NodeJS.ProcessEnv;
  /** An empty folder to run in (created). */
  runDir: string;
  args?: string[];
  log?: (...a: unknown[]) => void;
}

interface Proc {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  pending: Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>;
}

export class AppServerProcess implements AppServer {
  private opts: AppServerOptions;
  private proc: Proc | null = null;
  private nextId = 1;
  private listeners = new Set<(msg: ServerMessage) => void>();
  private exitListeners = new Set<(reason: string) => void>();
  private log: (...a: unknown[]) => void;

  constructor(opts: AppServerOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((...a) => console.log("[orchestrator app-server]", ...a));
  }

  listen(fn: (msg: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onExit(fn: (reason: string) => void): () => void {
    this.exitListeners.add(fn);
    return () => this.exitListeners.delete(fn);
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    p?.child.kill();
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  async request(method: string, params: unknown): Promise<Json> {
    const p = this.start();
    await p.ready;
    if (this.proc !== p) throw new Error("app-server stopped");
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      p.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  private write(msg: unknown): void {
    const c = this.proc?.child;
    if (c && c.stdin.writable) c.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private start(): Proc {
    if (this.proc) return this.proc;
    if (!existsSync(this.opts.bin))
      throw new Error(`The provenance binary isn't at ${this.opts.bin}`);
    mkdirSync(this.opts.runDir, { recursive: true });
    const child = spawn(this.opts.bin, ["app-server", ...(this.opts.args ?? [])], {
      cwd: this.opts.runDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.opts.env() },
    });
    const pending: Proc["pending"] = new Map();
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    ready.catch(() => {}); // a request awaiting it reports the failure
    const proc: Proc = { child, ready, pending };
    this.proc = proc;
    const initId = this.nextId++;
    let stderr = "";
    const gone = (reason: string) => {
      if (this.proc === proc) this.proc = null;
      const err = new Error(reason);
      readyReject(err);
      for (const w of pending.values()) w.reject(err);
      pending.clear();
      for (const fn of this.exitListeners) fn(reason);
    };
    child.on("error", (e) => gone(`Couldn't start app-server: ${e.message}`));
    child.on("exit", (code, signal) => {
      const tail = stderr.trim().split("\n").slice(-2).join(" · ").slice(0, 300);
      gone(`app-server stopped (${signal ?? `exit ${code}`})${tail ? `: ${tail}` : ""}`);
    });
    child.stdin.on("error", () => {});
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const hasId = msg.id !== undefined && msg.id !== null;
      if (hasId && typeof msg.method !== "string") {
        if (msg.id === initId) {
          if (msg.error) {
            readyReject(new Error(`app-server initialize failed: ${JSON.stringify(msg.error)}`));
            child.kill();
          } else {
            this.write({ method: "initialized" });
            this.log(`ready (pid ${child.pid})`);
            readyResolve();
          }
          return;
        }
        const w = pending.get(msg.id as number);
        if (!w) return;
        pending.delete(msg.id as number);
        if (msg.error) {
          const e = msg.error as { message?: string };
          w.reject(new Error(e.message ?? JSON.stringify(msg.error)));
        } else w.resolve((msg.result ?? {}) as Json);
        return;
      }
      if (typeof msg.method !== "string") return;
      const out: ServerMessage = {
        method: msg.method,
        params: (msg.params ?? {}) as Json,
        ...(hasId ? { id: msg.id as number | string } : {}),
      };
      for (const fn of this.listeners) fn(out);
    });
    child.stdin.write(
      `${JSON.stringify({
        id: initId,
        method: "initialize",
        params: {
          clientInfo: { name: "provenance_orchestrator", title: "Provenance", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      })}\n`,
    );
    return proc;
  }
}
