// Offline check of the fallbacks' server side (server/fallback/): the health checks and the
// Claude Code / Codex thread backend, against stand-in CLIs (scripts/fixtures/fake-*.mjs) that
// print what the real ones print. No model, no account, no network, nothing on screen.
//
//   npm run check:fallback
//
// Covers: health for installed / signed out / missing CLIs and the "through Provenance" home;
// a Claude Code thread (streamed text, a command, an edit, sub-agent rows left out), its second
// turn resuming the CLI's session, the permission preset on the command line; a Codex thread
// (exec --json, then exec resume); interrupt; a failed turn; a CLI that went missing; threads
// read back from disk by a new backend.

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { FallbackBackend } from "../server/fallback/backend.ts";
import { checkClaude, checkCodex, checkThroughProvenance } from "../server/fallback/health.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a: unknown[]) => console.log("[fallback-check]", ...a);
function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`expected: ${what}`);
  log(`  ok: ${what}`);
}

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "provenance-fallback-check-")));
const bin = path.join(scratch, "bin");
const work = path.join(scratch, "work");
mkdirSync(bin);
mkdirSync(work);
symlinkSync(path.join(here, "fixtures/fake-claude.mjs"), path.join(bin, "claude"));
symlinkSync(path.join(here, "fixtures/fake-codex.mjs"), path.join(bin, "codex"));
const cliLog = path.join(scratch, "cli.jsonl");
process.env.FAKE_CLI_LOG = cliLog;
const nodeDir = path.dirname(process.execPath);
let searchPath = `${bin}:${nodeDir}:/usr/bin:/bin`;
const runs = () =>
  readFileSync(cliLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { cli: string; argv: string[]; stdin: string; cwd: string });

// ---- health ---------------------------------------------------------------------------------
log("health");
const env = {
  searchPath,
  provenanceBin: "/nonexistent/provenance",
  codexHome: path.join(scratch, "codex-home"),
  codexLoginHome: path.join(scratch, "no-codex-login"),
};
const claude = await checkClaude(env);
check(claude.installed && claude.version === "9.9.9", "claude found, version read");
check(
  claude.signedIn === true && claude.account === "Claude subscription (pro)",
  "claude signed in, plan, no e-mail",
);
check(
  !JSON.stringify(claude).includes("example.com"),
  "the e-mail from auth status is not passed on",
);
check(
  claude.models.map((m) => m.id).join(",") === ",fable,opus,sonnet,haiku",
  "claude models: Default, the --help aliases, then the known list",
);
const codex = await checkCodex(env);
check(
  codex.installed && codex.version === "9.9.9" && codex.account === "ChatGPT",
  "codex found, signed in with ChatGPT",
);
check(
  codex.models.map((m) => m.id).join(",") === ",fake-big,fake-small",
  "codex models from `codex debug models`, hidden left out",
);
check(
  !codex.provenance.ready && /Codex signed in/.test(codex.provenance.problem ?? ""),
  "through Provenance needs Codex's login",
);
process.env.FAKE_SIGNED_OUT = "1";
const out1 = await checkClaude(env);
const out2 = await checkCodex(env);
delete process.env.FAKE_SIGNED_OUT;
check(
  out1.signedIn === false && out1.problem === "Not signed in" && !!out1.fix,
  "claude signed out: says so, with a fix",
);
check(
  out2.signedIn === false && out2.problem === "Not signed in" && /codex login/.test(out2.fix ?? ""),
  "codex signed out: says so",
);
const bare = { ...env, searchPath: "/usr/bin:/bin" };
const [c0, x0] = await Promise.all([checkClaude(bare), checkCodex(bare)]);
check(
  !c0.installed && c0.problem === "Not installed" && /install/.test(c0.fix ?? ""),
  "claude missing: not installed + how to",
);
check(
  !x0.installed &&
    x0.problem === "Not installed" &&
    /npm install -g @openai\/codex/.test(x0.fix ?? ""),
  "codex missing: not installed + how to",
);
// A Codex login to share: the home links to it, and never copies it.
const login = path.join(scratch, "codex-login");
mkdirSync(login);
appendFileSync(path.join(login, "auth.json"), "{}");
const pv = await checkThroughProvenance({ ...env, codexLoginHome: login });
const { lstatSync, readlinkSync } = await import("node:fs");
const link = path.join(env.codexHome, "auth.json");
check(
  lstatSync(link).isSymbolicLink() && readlinkSync(link) === path.join(login, "auth.json"),
  "the home's auth.json links to Codex's",
);
check(
  readlinkSync(path.join(env.codexHome, "auth.lock")) === path.join(login, "auth.lock"),
  "and auth.lock, so both lock the same file",
);
check(
  !pv.ready && /provenance binary/.test(pv.problem ?? ""),
  "no provenance binary: not ready, says why",
);

// ---- the backend over a real WebSocket ----------------------------------------------------------
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => wss.once("listening", r));
const port = (wss.address() as { port: number }).port;
const dataDir = path.join(scratch, "data");
let backend = new FallbackBackend({ dir: dataDir, searchPath: () => searchPath, log: () => {} });
wss.on("connection", (ws) => backend.attach(ws));

type TurnItem = {
  type: string;
  text?: string;
  command?: string;
  aggregatedOutput?: string;
  status?: string;
  exitCode?: number;
  changes?: { path: string; diff: string }[];
};
type Msg = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
};
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const notes: Msg[] = [];
  const waits = new Map<number, (m: Msg) => void>();
  let seq = 0;
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as Msg;
    if (m.id !== undefined && !m.method) waits.get(m.id)?.(m);
    else notes.push(m);
  });
  await new Promise((r) => ws.once("open", r));
  const call = (method: string, params: unknown) =>
    new Promise<Msg>((resolve) => {
      const id = ++seq;
      waits.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const turnDone = async (threadId: string, ms = 20_000) => {
    const t0 = Date.now();
    for (;;) {
      const n = notes.find((x) => x.method === "turn/completed" && x.params?.threadId === threadId);
      if (n) {
        notes.splice(notes.indexOf(n), 1);
        return n.params!.turn as {
          status: string;
          items: TurnItem[];
          error: { message: string } | null;
        };
      }
      if (Date.now() - t0 > ms) throw new Error("turn never completed");
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { ws, notes, call, turnDone };
}
const c = await connect();
check(
  c.notes.some((n) => n.method === "bridge/status"),
  "the page gets a ready status on connect",
);
const text = (s: string) => [{ type: "text", text: s, text_elements: [] }];

log("claude thread");
const started = await c.call("thread/start", {
  model: "claude:opus",
  cwd: work,
  sandbox: "workspace-write",
});
const th = (started.result as { thread: { id: string; modelProvider: string } }).thread;
check(
  th.id.startsWith("fb-") && th.modelProvider === "claude-code",
  "thread/start: an fb- thread on claude-code",
);
await c.call("turn/start", { threadId: th.id, input: text("Fix the typo") });
let turn = await c.turnDone(th.id);
const kinds = turn.items.map((i) => i.type).join(",");
check(turn.status === "completed", "turn completed");
check(
  kinds === "userMessage,agentMessage,commandExecution,fileChange,agentMessage",
  `items in order (${kinds})`,
);
check(
  c.notes.filter((n) => n.method === "item/agentMessage/delta").length === 2,
  "streamed text arrives as deltas",
);
const cmd = turn.items[2] as {
  command: string;
  aggregatedOutput: string;
  status: string;
  exitCode: number;
};
check(
  cmd.command === "echo hi" && cmd.aggregatedOutput === "hi" && cmd.exitCode === 0,
  "the Bash call is a command with its output",
);
const edit = turn.items[3] as { changes: { path: string; diff: string }[] };
check(
  edit.changes[0].path === "a.txt" &&
    edit.changes[0].diff.includes("-one") &&
    edit.changes[0].diff.includes("+two"),
  "the Edit is a file change with a diff, path relative",
);
check((turn.items[4] as { text: string }).text === "Done (new session).", "final answer");
let r = runs().at(-1)!;
check(r.stdin === "Fix the typo" && r.cwd === work, "prompt on stdin, run in the thread's folder");
check(
  r.argv.join(" ").includes("--model opus") &&
    r.argv.includes("--permission-mode") &&
    r.argv.includes("acceptEdits") &&
    !r.argv.includes("--resume"),
  "argv: model, acceptEdits for Auto, no resume on the first turn",
);
await c.call("turn/start", {
  threadId: th.id,
  input: text("And again"),
  sandboxPolicy: { type: "dangerFullAccess" },
  approvalPolicy: "never",
});
turn = await c.turnDone(th.id);
r = runs().at(-1)!;
const firstSession = JSON.parse(
  readFileSync(path.join(dataDir, "threads", `${th.id}.json`), "utf8"),
).session;
check(
  r.argv.includes("--resume") && r.argv[r.argv.indexOf("--resume") + 1] === firstSession,
  "second turn resumes the CLI's session",
);
check(
  r.argv.includes("--dangerously-skip-permissions"),
  "Full access maps to --dangerously-skip-permissions",
);
check(
  (turn.items.at(-1) as { text: string }).text === "Done (resumed session).",
  "the resumed answer",
);
const list = (await c.call("thread/list", { limit: 10 })).result as {
  data: { id: string; preview: string }[];
};
check(
  list.data[0]?.id === th.id && list.data[0].preview === "Fix the typo",
  "thread/list has it, with its preview",
);
const turns = (
  await c.call("thread/turns/list", { threadId: th.id, limit: 50, sortDirection: "desc" })
).result as { data: { items: unknown[] }[] };
check(
  turns.data.length === 2 && turns.data[0].items.length === 5,
  "thread/turns/list: both turns, newest first, items kept",
);
const wrong = await c.call("turn/start", {
  threadId: th.id,
  input: text("x"),
  model: "codex:fake-big",
});
check(
  /runs on Claude Code/.test(wrong.error?.message ?? ""),
  "a codex model can't be sent to a Claude Code thread",
);

log("codex thread");
const cs = (await c.call("thread/start", { model: "codex:", cwd: work, sandbox: "read-only" }))
  .result as { thread: { id: string } };
await c.call("turn/start", { threadId: cs.thread.id, input: text("List files") });
turn = await c.turnDone(cs.thread.id);
r = runs().at(-1)!;
check(
  r.cli === "codex" &&
    r.argv.slice(0, 5).join(" ") === "exec --json --skip-git-repo-check -s read-only" &&
    r.argv.at(-1) === "-" &&
    r.argv.includes(work),
  "argv: exec --json, read only, -C folder, prompt on stdin",
);
check(
  turn.items.map((i) => i.type).join(",") ===
    "userMessage,reasoning,commandExecution,fileChange,agentMessage",
  "reasoning, command, file change, message",
);
check(
  (turn.items[2] as { command: string }).command === "ls",
  "the shell wrapper is taken off the command",
);
await c.call("turn/start", { threadId: cs.thread.id, input: text("More") });
turn = await c.turnDone(cs.thread.id);
r = runs().at(-1)!;
check(
  r.argv.slice(0, 2).join(" ") === "exec resume" && r.argv.includes('sandbox_mode="read-only"'),
  "second turn: exec resume with the sandbox kept",
);
check(
  (turn.items.at(-1) as { text: string }).text === "Done (resumed session).",
  "the resumed answer",
);

log("interrupt, failure, missing CLI");
process.env.FAKE_SLOW = "1";
await c.call("turn/start", { threadId: th.id, input: text("slow") });
await new Promise((res) => setTimeout(res, 600));
delete process.env.FAKE_SLOW;
const t0 = Date.now();
await c.call("turn/interrupt", { threadId: th.id });
turn = await c.turnDone(th.id, 10_000);
check(
  turn.status === "interrupted" && Date.now() - t0 < 8000,
  `interrupt stops the CLI (${Date.now() - t0} ms)`,
);
check(
  turn.items.some((i) => i.type === "commandExecution" && i.status === "failed"),
  "the command it was in shows as not finished",
);
process.env.FAKE_FAIL = "1";
await c.call("turn/start", { threadId: th.id, input: text("fail") });
turn = await c.turnDone(th.id);
delete process.env.FAKE_FAIL;
check(
  turn.status === "failed" && turn.error?.message === "Something broke",
  "an error result fails the turn with its message",
);
searchPath = `${nodeDir}:/usr/bin:/bin`;
await c.call("turn/start", { threadId: th.id, input: text("gone") });
turn = await c.turnDone(th.id);
check(
  turn.status === "failed" && /isn't installed/.test(turn.error?.message ?? ""),
  "a missing CLI fails the turn with a plain message",
);

log("read back");
backend = new FallbackBackend({ dir: dataDir, searchPath: () => searchPath, log: () => {} });
const again = (await backend.handle("thread/list", {})) as { data: { id: string }[] };
check(
  again.data.length === 2 && again.data.some((t) => t.id === th.id),
  "a new backend reads both threads back from disk",
);
const archived = await backend.handle("thread/archive", { threadId: cs.thread.id });
check(
  archived && ((await backend.handle("thread/list", {})) as { data: unknown[] }).data.length === 1,
  "archive hides a thread",
);

c.ws.close();
wss.close();
log("all good");
process.exit(0);
