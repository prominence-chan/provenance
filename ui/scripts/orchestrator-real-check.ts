// The orchestrators against the real `provenance app-server` (and, for three of the modes, the
// real router and its free models). Nothing on screen; a throwaway PROVENANCE_HOME; the work
// happens in a scratch folder. Not part of any automatic check: the model modes spend the shared
// free allowance.
//
//   node scripts/orchestrator-real-check.ts sandbox            no model: Hyperexperimental's
//        execute step under each preset, with the real sandbox (scripted think / translate), and
//        the environment of a RUN against the harness's own shell (thread/shellCommand, which
//        uses the same shell snapshot as the model's shell tool): the same python3, the same PATH
//   node scripts/orchestrator-real-check.ts experimental [model]   one small job, real models
//   node scripts/orchestrator-real-check.ts hyperexperimental [model]
//   node scripts/orchestrator-real-check.ts stock [model]      the same job on the stock harness
//                                                              in one thread, for comparison
//
// Env: ORC_MAX_CALLS (a cap on one run's model calls), PROVENANCE_BIN (default ~/.local/bin/provenance), TIERLM_URL (default
// http://127.0.0.1:4141), PCORE_TOKEN / TIERLM_TOKEN (never printed), ORC_REAL_DIR (where the
// scratch goes; default the system temp folder), ORC_JOB (the request).
// Prints what each turn cost: model calls per role, the largest prompt per role (characters),
// the workers' requests and their largest input (tokens, as app-server reports them), and writes
// the largest prompt of each role to <scratch>/prompts/.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { AppServerProcess } from "../server/orchestrator/appserver.ts";
import { OrchestratorBackend, type TraceEvent } from "../server/orchestrator/backend.ts";
import { makeCallModel, type CallModel } from "../server/orchestrator/router.ts";

const mode = process.argv[2] ?? "sandbox";
const model = process.argv[3] ?? "pool/spark";
const bin = process.env.PROVENANCE_BIN ?? path.join(homedir(), ".local/bin/provenance");
const routerUrl = (process.env.TIERLM_URL ?? "http://127.0.0.1:4141").replace(/\/$/, "");
const token = process.env.PCORE_TOKEN || process.env.TIERLM_TOKEN || undefined;
const JOB =
  process.env.ORC_JOB ??
  "Make a tiny Python module mathx.py with two functions, add(a, b) and mul(a, b), and a test file test_mathx.py that uses unittest to test both. Run the tests with python3 -m unittest and make sure they pass.";
const log = (...a: unknown[]) => console.log(`[orchestrator-real ${mode}]`, ...a);
function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`expected: ${what}`);
  log(`  ok: ${what}`);
}
if (!existsSync(bin)) throw new Error(`no provenance binary at ${bin}`);

const here = path.dirname(fileURLToPath(import.meta.url));
// The sandbox mode needs folders that are NOT under a temp folder (workspace-write lets every
// command write to temp folders, so a temp scratch couldn't show a refused write).
const base = mode === "sandbox" ? path.resolve(here, "..") : (process.env.ORC_REAL_DIR ?? tmpdir());
const scratch = realpathSync(
  mkdtempSync(path.join(base, mode === "sandbox" ? ".orc-sandbox-check-" : "provenance-orc-real-")),
);
const work = path.join(scratch, "work");
const outside = path.join(scratch, "outside");
mkdirSync(work);
mkdirSync(outside);
const env = () => ({
  PROVENANCE_HOME: path.join(scratch, "provenance-home"),
  TIERLM_BASE_URL: `${routerUrl}/v1`,
  ...(token ? { TIERLM_TOKEN: token } : {}),
});
mkdirSync(env().PROVENANCE_HOME);
const appServer = new AppServerProcess({
  bin,
  runDir: path.join(scratch, "run"),
  env,
  log: () => {},
});
const traces: TraceEvent[] = [];
const cleanup = () => {
  appServer.stop();
  // (the app-server may still be writing as it stops: try again rather than leave the folder)
  if (mode === "sandbox")
    rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
};

type Item = {
  type: string;
  text?: string;
  command?: string;
  status?: string;
  exitCode?: number;
  aggregatedOutput?: string;
  changes?: { path: string }[];
};
type Turn = {
  id: string;
  status: string;
  items: Item[];
  error: { message: string } | null;
  durationMs: number;
  orchestration?: Record<string, unknown>;
};

async function withBackend<T>(
  callModel: CallModel,
  f: (c: {
    call: (m: string, p: unknown) => Promise<Record<string, unknown>>;
    turnDone: (id: string, ms?: number) => Promise<Turn>;
    approvals: string[];
  }) => Promise<T>,
): Promise<T> {
  const backend = new OrchestratorBackend({
    dir: path.join(scratch, "data"),
    appServer: () => appServer,
    callModel,
    // ORC_MAX_CALLS bounds a real run's model calls (the turn stops with a partial result).
    ...(Number(process.env.ORC_MAX_CALLS) > 0
      ? { caps: { modelCalls: Number(process.env.ORC_MAX_CALLS) } }
      : {}),
    log: () => {},
    trace: (e) => traces.push(e),
  });
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  wss.on("connection", (ws) => backend.attach(ws));
  const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
  const done = new Map<string, Turn>();
  const waits = new Map<
    number,
    (m: { result?: Record<string, unknown>; error?: { message: string } }) => void
  >();
  const approvals: string[] = [];
  let seq = 0;
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    if (m.id !== undefined && !m.method) return void waits.get(m.id)?.(m);
    if (m.id !== undefined && m.method) {
      // Nobody is here to approve: decline, and say so in the output.
      approvals.push(`${m.method}: ${m.params?.command ?? m.params?.reason ?? ""}`);
      return void ws.send(
        JSON.stringify(
          /requestApproval$/.test(m.method) && !/permissions/.test(m.method)
            ? { id: m.id, result: { decision: "decline" } }
            : { id: m.id, error: { code: -32601, message: "nobody is here to answer" } },
        ),
      );
    }
    if (m.method === "turn/completed") done.set(m.params.threadId, m.params.turn);
    if (m.method === "item/completed" && process.env.ORC_VERBOSE) {
      const it = m.params.item as Item;
      log(
        `    · ${it.type}${it.command ? ` ${it.command.slice(0, 100)} -> ${it.status}` : it.changes ? ` ${it.changes.map((c) => c.path).join(", ")} -> ${it.status}` : it.text ? ` ${it.text.replace(/\s+/g, " ").slice(0, 140)}` : ""}`,
      );
    }
  });
  await new Promise((r) => ws.once("open", r));
  const call = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++seq;
      waits.set(id, (m) =>
        m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {}),
      );
      ws.send(JSON.stringify({ id, method, params }));
    });
  const turnDone = async (threadId: string, ms = 20 * 60_000) => {
    const t0 = Date.now();
    while (!done.has(threadId)) {
      if (Date.now() - t0 > ms) {
        await call("turn/interrupt", { threadId });
        throw new Error("the turn took too long and was interrupted");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const t = done.get(threadId)!;
    done.delete(threadId);
    return t;
  };
  try {
    return await f({ call, turnDone, approvals });
  } finally {
    backend.stop();
    ws.close();
    wss.close();
  }
}
const text = (s: string) => [{ type: "text", text: s, text_elements: [] }];

function report(turn: Turn): void {
  const byRole = new Map<string, { calls: number; max: TraceEvent & { type: "model" } }>();
  for (const t of traces) {
    if (t.type !== "model") continue;
    const r = byRole.get(t.role);
    if (!r) byRole.set(t.role, { calls: 1, max: t });
    else {
      r.calls++;
      if (t.promptChars > r.max.promptChars) r.max = t;
    }
  }
  mkdirSync(path.join(scratch, "prompts"), { recursive: true });
  log(
    `turn ${turn.status} in ${Math.round(turn.durationMs / 1000)} s${turn.error ? `: ${turn.error.message}` : ""}`,
  );
  log(`cost: ${JSON.stringify(turn.orchestration)}`);
  for (const [role, r] of byRole) {
    const file = path.join(scratch, "prompts", `${role}.txt`);
    writeFileSync(
      file,
      `--- instructions (${r.max.instructions.length})\n${r.max.instructions}\n--- input (${r.max.input.length})\n${r.max.input}\n--- reply (${r.max.reply.length})\n${r.max.reply}\n`,
    );
    log(
      `  ${role}: ${r.calls} call(s), largest prompt ${r.max.promptChars} characters, served by ${r.max.servedBy ?? "?"} (${file})`,
    );
  }
  const workers = traces.filter((t) => t.type === "worker");
  for (const w of workers)
    if (w.type === "worker")
      log(
        `  worker "${w.task.slice(0, 60)}": ${w.status}, brief ${w.brief.length} characters, ${w.calls} request(s), largest input ${w.maxInputTokens} tokens`,
      );
  log("items:");
  for (const it of turn.items)
    log(
      `  ${it.type}${it.command ? `: ${it.command.slice(0, 110)} -> ${it.status}${it.exitCode != null ? ` (${it.exitCode})` : ""}` : it.changes ? `: ${it.changes.map((c) => c.path).join(", ")} -> ${it.status}` : it.text ? `: ${it.text.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
    );
  log(`folder now: ${readdirSync(work).join(", ") || "(empty)"}`);
}

try {
  if (mode === "sandbox") {
    // Think and translate are scripted; everything else (app-server, command/exec, the sandbox) is real.
    let parity = false;
    const PARITY_CMD = 'command -v python3; echo "$PATH"';
    const script: CallModel = async (c) => {
      const role = c.instructions.startsWith("You direct")
        ? "think"
        : c.instructions.startsWith("Turn the PLAN")
          ? "translate"
          : "summarize";
      const step = Number(/This is step (\d+)/.exec(c.input)?.[1] ?? 0);
      const reply =
        role === "think"
          ? step === 1
            ? "do the writes"
            : "FINISHED: done"
          : role === "translate"
            ? parity
              ? `RUN: ${PARITY_CMD}`
              : `WRITE: inside.txt\n<<<\nhello\n>>>\nWRITE: ${outside}/escape.txt\n<<<\nno\n>>>\nRUN: echo ran > by-run.txt; echo x > ${outside}/escape2.txt; cat inside.txt\nREAD: inside.txt\nREPLACE: inside.txt\n<<<\nhello\n===\nhello again\n>>>\nSEARCH: again IN .`
            : "wrote things";
      return { text: reply, promptChars: 0, servedBy: "script", session: "script", ms: 0 };
    };
    await withBackend(script, async ({ call, turnDone, approvals }) => {
      const run = async (sandbox: string, approvalPolicy: string) => {
        for (const f of readdirSync(work)) rmSync(path.join(work, f), { recursive: true });
        for (const f of readdirSync(outside)) rmSync(path.join(outside, f));
        const th = (
          await call("thread/start", {
            model,
            cwd: work,
            sandbox,
            approvalPolicy,
            config: { orchestrator: "hyperexperimental" },
          })
        ).thread as { id: string };
        await call("turn/start", { threadId: th.id, input: text("go") });
        return turnDone(th.id, 60_000);
      };
      log("workspace write (Auto)");
      let t = await run("workspace-write", "on-request");
      const st = (t: Turn) =>
        t.items
          .filter((i) => i.type !== "userMessage" && i.type !== "agentMessage")
          .map((i) => `${i.type}:${i.status}`)
          .join(" ");
      check(t.status === "completed", `turn completed (${st(t)})`);
      check(
        readFileSync(path.join(work, "inside.txt"), "utf8") === "hello again\n",
        "a file inside the thread's folder was written, then edited",
      );
      check(
        !existsSync(path.join(outside, "escape.txt")),
        "WRITE outside the folder was refused by the sandbox",
      );
      check(
        t.items[3].type === "fileChange" && t.items[3].status === "failed",
        "and shows as failed",
      );
      check(
        existsSync(path.join(work, "by-run.txt")) && !existsSync(path.join(outside, "escape2.txt")),
        "RUN wrote inside the folder, and its write outside was refused",
      );
      check(
        /not permitted/i.test(t.items[4].aggregatedOutput ?? "") &&
          /hello/.test(t.items[4].aggregatedOutput ?? ""),
        "the command saw 'Operation not permitted' and still read the file",
      );
      check(/hello\n\[lines 1-250 of 1\]/.test(t.items[5].aggregatedOutput ?? ""), "READ works");
      check(/inside\.txt:1:hello again/.test(t.items[7].aggregatedOutput ?? ""), "SEARCH works");
      check(approvals.length === 0, "nothing was asked (Auto)");
      log("read only");
      t = await run("read-only", "on-request");
      check(
        t.status === "completed" &&
          readdirSync(work).length === 0 &&
          readdirSync(outside).length === 0,
        `nothing was written anywhere (${st(t)})`,
      );
      check(
        t.items.filter((i) => i.type === "fileChange").every((i) => i.status === "failed"),
        "every file change failed in the sandbox",
      );
      log("ask every time, nobody approves");
      t = await run("workspace-write", "untrusted");
      check(
        approvals.length === 3 && readdirSync(work).length === 0,
        `each write and the command asked first (${approvals.length}), and declined means not done`,
      );
      check(
        t.items
          .filter(
            (i) =>
              i.type === "fileChange" ||
              (i.type === "commandExecution" && i.command?.startsWith("echo")),
          )
          .every((i) => i.status === "declined" || i.status === "failed"),
        "their rows show as declined (the REPLACE fails: no file)",
      );
      log("full access");
      t = await run("danger-full-access", "never");
      check(
        existsSync(path.join(outside, "escape.txt")) &&
          existsSync(path.join(outside, "escape2.txt")),
        "full access writes outside the folder, as the preset says",
      );
      log("environment: a RUN against the harness's own shell");
      parity = true;
      t = await run("workspace-write", "on-request");
      const ours = (
        t.items.find((i) => i.type === "commandExecution" && i.command === PARITY_CMD)
          ?.aggregatedOutput ?? ""
      ).trim();
      // The harness's side: a thread's own shell command (no model involved). Its snapshot is
      // made in the background when the thread starts, so ask until it is in use (the answer
      // stops changing) or a few seconds have passed.
      const outputs: string[] = [];
      let tid = "";
      const off = appServer.listen((m) => {
        if (m.params.threadId !== tid || m.method !== "item/completed") return;
        const it = m.params.item as Item;
        if (it.type === "commandExecution") outputs.push((it.aggregatedOutput ?? "").trim());
      });
      const th = await appServer.request("thread/start", {
        model,
        cwd: work,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        ephemeral: true,
      });
      tid = String((th.thread as { id: string }).id);
      let theirs = "";
      for (let i = 0; i < 8 && theirs !== ours; i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? 1500 : 1000));
        const n = outputs.length;
        await appServer.request("thread/shellCommand", { threadId: tid, command: PARITY_CMD });
        for (let k = 0; k < 100 && outputs.length === n; k++)
          await new Promise((r) => setTimeout(r, 100));
        theirs = outputs.at(-1) ?? "";
      }
      off();
      const [ourPy, ourPath] = ours.split("\n");
      const [theirPy, theirPath] = theirs.split("\n");
      log(`  python3: RUN ${ourPy} | harness ${theirPy}`);
      log(
        `  PATH entries: RUN ${ourPath?.split(":").length} | harness ${theirPath?.split(":").length}`,
      );
      check(!!ourPy && ourPy === theirPy, "a RUN finds the same python3 as the harness's shell");
      check(!!ourPath && ourPath === theirPath, "and has the same PATH, entry for entry");
    });
    log("all good");
  } else if (mode === "experimental" || mode === "hyperexperimental") {
    log(`model ${model}, router ${routerUrl}, folder ${work}`);
    await withBackend(
      makeCallModel(() => ({ url: routerUrl, token })),
      async ({ call, turnDone, approvals }) => {
        const th = (
          await call("thread/start", {
            model,
            cwd: work,
            sandbox: "workspace-write",
            approvalPolicy: "on-request",
            config: { orchestrator: mode },
          })
        ).thread as { id: string };
        await call("turn/start", { threadId: th.id, input: text(JOB) });
        const t = await turnDone(th.id);
        report(t);
        if (approvals.length) log(`approvals asked and declined: ${approvals.join(" | ")}`);
        const rec = JSON.parse(
          readFileSync(path.join(scratch, "data", "threads", `${th.id}.json`), "utf8"),
        ) as { notes: unknown; summary: string };
        log(
          mode === "experimental"
            ? `notes: ${JSON.stringify(rec.notes)}`
            : `summary (${rec.summary.length} characters): ${rec.summary}`,
        );
      },
    );
  } else if (mode === "stock") {
    // The same job, one thread on the stock harness: how many requests, how large they grow.
    log(`model ${model}, router ${routerUrl}, folder ${work}`);
    let calls = 0;
    let maxInput = 0;
    let totalInput = 0;
    const items: string[] = [];
    let tid = "";
    const finished = new Promise<{ status: string; error?: { message: string } | null }>(
      (resolve) => {
        appServer.listen((m) => {
          if (m.params.threadId !== tid) return;
          if (m.id !== undefined) return void appServer.respond(m.id, { decision: "decline" });
          if (m.method === "thread/tokenUsage/updated") {
            const last = (m.params.tokenUsage as { last: { inputTokens: number } }).last;
            calls++;
            maxInput = Math.max(maxInput, last.inputTokens);
            totalInput += last.inputTokens;
          } else if (m.method === "item/completed") {
            const it = m.params.item as Item;
            items.push(
              `${it.type}${it.command ? `: ${it.command.slice(0, 110)} -> ${it.status}` : it.changes ? `: ${it.changes.map((c) => c.path).join(", ")}` : it.text ? `: ${it.text.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
            );
          } else if (m.method === "turn/completed") resolve(m.params.turn as { status: string });
        });
      },
    );
    const t0 = Date.now();
    const th = await appServer.request("thread/start", {
      model,
      cwd: work,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ephemeral: true,
    });
    tid = String((th.thread as { id: string }).id);
    await appServer.request("turn/start", { threadId: tid, input: text(JOB) });
    const turn = await Promise.race([
      finished,
      new Promise<{ status: string }>((r) =>
        setTimeout(() => r({ status: "timed out after 20 min" }), 20 * 60_000),
      ),
    ]);
    log(`turn ${turn.status} in ${Math.round((Date.now() - t0) / 1000)} s`);
    log(
      `cost: ${calls} request(s), largest input ${maxInput} tokens, input over all requests ${totalInput} tokens`,
    );
    log("items:");
    for (const i of items) log(`  ${i}`);
    log(`folder now: ${readdirSync(work).join(", ") || "(empty)"}`);
  } else throw new Error(`unknown mode ${mode}`);
} finally {
  cleanup();
}
process.exit(0);
