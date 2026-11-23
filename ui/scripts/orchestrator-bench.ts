// One benchmark run of an orchestrator (or the stock harness) against the real
// `provenance app-server` and the real router: one job, one folder, one turn, everything recorded.
// Grown from orchestrator-real-check.ts; nothing on screen, a throwaway PROVENANCE_HOME. Not part
// of any automatic check: it spends the shared free allowance.
//
//   node scripts/orchestrator-bench.ts <experimental|hyperexperimental|stock> \
//        --cwd <folder the agent works in> --job-file <file with the user message> \
//        --out <folder for the records> [--model solstice] [--limit-min 25] [--path-prefix <dir>]
//
// The job's preparation and its grading are the caller's (this script neither sees nor runs any
// test). Sandbox workspace-write, approval policy on-request with nobody there: every approval is
// declined and listed. Writes to --out:
//   result.json   status, wall time, model calls, largest prompt per role, the guard that ended
//                 the turn if any, which sources served (as the router's reply header says; for
//                 workers and the stock harness read the router's ledger over the time window)
//   turn.json     the turn with all its items (commands, outputs, file changes, messages)
//   traces.jsonl  every plain model call (full prompt and reply) and every worker (its brief)
//   events.jsonl  the stock harness's item and token-usage notifications
//   thread.json   the orchestrator's thread record (notes / summary)
// Env: PROVENANCE_BIN, TIERLM_URL, PCORE_TOKEN / TIERLM_TOKEN (never printed).

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { AppServerProcess } from "../server/orchestrator/appserver.ts";
import { OrchestratorBackend, type TraceEvent } from "../server/orchestrator/backend.ts";
import { makeCallModel } from "../server/orchestrator/router.ts";

const mode = process.argv[2];
const arg = (name: string, dflt?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (dflt !== undefined) return dflt;
  throw new Error(`missing --${name}`);
};
if (!["experimental", "hyperexperimental", "stock"].includes(mode))
  throw new Error("mode: experimental | hyperexperimental | stock");
const cwd = path.resolve(arg("cwd"));
const out = path.resolve(arg("out"));
const job = readFileSync(arg("job-file"), "utf8").trim();
const model = arg("model", "solstice");
const limitMs = Number(arg("limit-min", "25")) * 60_000;
const pathPrefix = arg("path-prefix", "");
const bin = process.env.PROVENANCE_BIN ?? path.join(homedir(), ".local/bin/provenance");
const routerUrl = (process.env.TIERLM_URL ?? "http://127.0.0.1:4141").replace(/\/$/, "");
const token = process.env.PCORE_TOKEN || process.env.TIERLM_TOKEN || undefined;
const log = (...a: unknown[]) => console.log(`[bench ${mode}]`, ...a);
if (!existsSync(bin)) throw new Error(`no provenance binary at ${bin}`);
if (!existsSync(cwd)) throw new Error(`no folder ${cwd}`);
mkdirSync(out, { recursive: true });
mkdirSync(path.join(out, "home"), { recursive: true });

const appServer = new AppServerProcess({
  bin,
  runDir: path.join(out, "run"),
  env: () => ({
    PROVENANCE_HOME: path.join(out, "home"),
    TIERLM_BASE_URL: `${routerUrl}/v1`,
    ...(token ? { TIERLM_TOKEN: token } : {}),
    ...(pathPrefix ? { PATH: `${pathPrefix}:${process.env.PATH ?? ""}` } : {}),
  }),
  log: () => {},
});
const text = (s: string) => [{ type: "text", text: s, text_elements: [] }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const startedAt = Date.now();
const monoT0 = performance.now();

type Result = {
  mode: string;
  model: string;
  cwd: string;
  startedAt: number;
  endedAt: number;
  wallMs: number;
  status: string;
  timedOut: boolean;
  error: string | null;
  guard: string | null;
  modelCalls: number;
  roles: Record<string, { calls: number; maxPromptChars: number }>;
  workers?: number;
  workerCalls?: number;
  workerMaxInputTokens?: number;
  steps?: number;
  retries?: number;
  threadId?: string;
  maxInputTokens?: number;
  totalInputTokens?: number;
  servedBy: Record<string, number>;
  /** The keys this run's requests have in the router's usage ledger: the stock thread, each
   *  worker thread, each plain call's session. The caller checks who served them. */
  ledgerKeys: string[];
  approvalsDeclined: string[];
  finalMessage: string;
};
const finish = (r: Result): never => {
  writeFileSync(path.join(out, "result.json"), JSON.stringify(r, null, 1));
  log(
    `${r.status}${r.timedOut ? " (timed out)" : ""} in ${Math.round(r.wallMs / 1000)} s, ${r.modelCalls} model call(s)${r.guard ? `, guard: ${r.guard}` : ""}${r.error ? `, error: ${r.error}` : ""}`,
  );
  appServer.stop();
  process.exit(0);
};

if (mode === "stock") {
  let calls = 0;
  let maxInput = 0;
  let totalInput = 0;
  let tid = "";
  let turnId = "";
  let finalMessage = "";
  const approvals: string[] = [];
  const items: unknown[] = [];
  const finished = new Promise<{ status: string; error?: { message: string } | null }>((resolve) => {
    appServer.listen((m) => {
      if (m.params.threadId !== tid) return;
      if (m.id !== undefined) {
        approvals.push(`${m.method}: ${String(m.params.command ?? m.params.reason ?? "")}`);
        return void appServer.respond(m.id, { decision: "decline" });
      }
      if (m.method === "thread/tokenUsage/updated") {
        const last = (m.params.tokenUsage as { last: { inputTokens: number } }).last;
        calls++;
        maxInput = Math.max(maxInput, last.inputTokens);
        totalInput += last.inputTokens;
        appendFileSync(
          path.join(out, "events.jsonl"),
          `${JSON.stringify({ at: Date.now(), usage: m.params.tokenUsage })}\n`,
        );
      } else if (m.method === "item/completed") {
        const it = m.params.item as { type: string; text?: string };
        items.push(it);
        if (it.type === "agentMessage" && it.text) finalMessage = it.text;
        appendFileSync(path.join(out, "events.jsonl"), `${JSON.stringify({ at: Date.now(), item: it })}\n`);
      } else if (m.method === "turn/started") {
        turnId = String((m.params.turn as { id: string }).id);
      } else if (m.method === "error") {
        appendFileSync(path.join(out, "events.jsonl"), `${JSON.stringify({ at: Date.now(), error: m.params })}\n`);
      } else if (m.method === "turn/completed")
        resolve(m.params.turn as { status: string; error?: { message: string } | null });
    });
  });
  const th = await appServer.request("thread/start", {
    model,
    cwd,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    ephemeral: true,
  });
  tid = String((th.thread as { id: string }).id);
  const started = await appServer.request("turn/start", { threadId: tid, input: text(job) });
  turnId ||= String((started.turn as { id?: string } | undefined)?.id ?? "");
  let timedOut = false;
  let turn = await Promise.race([
    finished,
    sleep(limitMs).then(() => null),
  ]);
  if (!turn) {
    timedOut = true;
    await appServer.request("turn/interrupt", { threadId: tid, turnId }).catch(() => {});
    turn = (await Promise.race([finished, sleep(30_000).then(() => null)])) ?? { status: "interrupted" };
  }
  writeFileSync(path.join(out, "turn.json"), JSON.stringify({ ...turn, items }, null, 1));
  finish({
    mode,
    model,
    cwd,
    startedAt,
    endedAt: Date.now(),
    wallMs: Math.round(performance.now() - monoT0),
    status: turn.status,
    timedOut,
    error: turn.error?.message ?? null,
    guard: null,
    modelCalls: calls,
    roles: {},
    maxInputTokens: maxInput,
    totalInputTokens: totalInput,
    threadId: tid,
    servedBy: {},
    ledgerKeys: [tid],
    approvalsDeclined: approvals,
    finalMessage,
  });
}

// ---- the orchestrators -----------------------------------------------------------------
const servedBy: Record<string, number> = {};
const ledgerKeys = new Set<string>();
// A worker cut off by the time limit never reaches its trace: take the thread id as it starts too.
appServer.listen((m) => {
  const id = m.method === "thread/started" && (m.params.thread as { id?: string } | undefined)?.id;
  if (id) ledgerKeys.add(String(id));
});
const trace = (e: TraceEvent) => {
  const key = e.type === "model" ? e.session : e.threadId;
  if (key) ledgerKeys.add(key);
  appendFileSync(path.join(out, "traces.jsonl"), `${JSON.stringify({ at: Date.now(), ...e })}\n`);
  if (e.type === "model") servedBy[e.servedBy ?? "?"] = (servedBy[e.servedBy ?? "?"] ?? 0) + 1;
};
const backend = new OrchestratorBackend({
  dir: path.join(out, "data"),
  appServer: () => appServer,
  callModel: makeCallModel(() => ({ url: routerUrl, token })),
  log: () => {},
  trace,
});
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => wss.once("listening", r));
wss.on("connection", (ws) => backend.attach(ws));
const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
type Turn = {
  id: string;
  status: string;
  items: { type: string; text?: string }[];
  error: { message: string } | null;
  durationMs: number;
  orchestration?: {
    modelCalls: number;
    roles: Record<string, { calls: number; maxPromptChars: number }>;
    workers: number;
    workerCalls: number;
    workerMaxInputTokens: number;
    steps: number;
    stopped: string | null;
  };
};
let doneTurn: Turn | null = null;
const waits = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
const approvals: string[] = [];
let seq = 0;
ws.on("message", (d) => {
  const m = JSON.parse(String(d));
  if (m.id !== undefined && !m.method) return void waits.get(m.id)?.(m);
  if (m.id !== undefined && m.method) {
    // Nobody is here to approve: decline, and say so in the result.
    approvals.push(`${m.method}: ${m.params?.command ?? m.params?.reason ?? ""}`);
    return void ws.send(
      JSON.stringify(
        /requestApproval$/.test(m.method) && !/permissions/.test(m.method)
          ? { id: m.id, result: { decision: "decline" } }
          : { id: m.id, error: { code: -32601, message: "nobody is here to answer" } },
      ),
    );
  }
  if (m.method === "turn/completed") doneTurn = m.params.turn;
});
await new Promise((r) => ws.once("open", r));
const call = (method: string, params: unknown) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++seq;
    waits.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {})));
    ws.send(JSON.stringify({ id, method, params }));
  });
const th = (
  await call("thread/start", {
    model,
    cwd,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    config: { orchestrator: mode },
  })
).thread as { id: string };
await call("turn/start", { threadId: th.id, input: text(job) });
let timedOut = false;
// The limit is measured on the monotonic clock: a wall-clock jump must not end a run.
const monoStart = performance.now();
while (!doneTurn) {
  if (!timedOut && performance.now() - monoStart > limitMs) {
    timedOut = true;
    await call("turn/interrupt", { threadId: th.id }).catch(() => {});
  }
  if (timedOut && performance.now() - monoStart > limitMs + 60_000) break;
  await sleep(200);
}
const threadFile = path.join(out, "data", "threads", `${th.id}.json`);
if (existsSync(threadFile)) copyFileSync(threadFile, path.join(out, "thread.json"));
const turn: Turn =
  doneTurn ??
  ({ id: "", status: "interrupted", items: [], error: null, durationMs: Date.now() - startedAt } as Turn);
writeFileSync(path.join(out, "turn.json"), JSON.stringify(turn, null, 1));
const o = turn.orchestration;
backend.stop();
ws.close();
wss.close();
finish({
  mode,
  model,
  cwd,
  startedAt,
  endedAt: Date.now(),
  wallMs: Math.round(performance.now() - monoT0),
  status: turn.status,
  timedOut,
  error: turn.error?.message ?? null,
  guard: o?.stopped ?? null,
  modelCalls: o?.modelCalls ?? 0,
  roles: o?.roles ?? {},
  workers: o?.workers,
  workerCalls: o?.workerCalls,
  workerMaxInputTokens: o?.workerMaxInputTokens,
  steps: o?.steps,
  retries: (o as { retries?: number } | undefined)?.retries,
  servedBy,
  ledgerKeys: [...ledgerKeys],
  approvalsDeclined: approvals,
  finalMessage: [...turn.items].reverse().find((i) => i.type === "agentMessage")?.text ?? "",
});
