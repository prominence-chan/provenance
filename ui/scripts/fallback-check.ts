// Offline check of the fallbacks' server side (server/fallback/): the health checks and the
// Claude Code / Codex thread backend, against stand-in CLIs (scripts/fixtures/fake-*.mjs) that
// print what the real ones print. No model, no account, no network, nothing on screen.
//
//   npm run check:fallback
//
// Covers: health for installed / signed out / missing CLIs and the "through Provenance" home;
// a Claude Code thread (streamed text, a command, an edit, sub-agent rows left out), its second
// turn resuming the CLI's session, the permission preset on the command line ("Ask every time"
// runs like Auto); a Codex thread (exec --json, then exec resume); interrupt; a failed turn; a CLI
// that went missing; threads read back from disk by a new backend. "Through Provenance": the
// router pass-through's key (the same as provenance-core's), its arguments, and the check that
// the router's pass-through answers. Reasoning effort: the levels each CLI offers (Claude Code's
// --help, Codex's catalog per model), --effort / -c model_reasoning_effort on the command line
// (new and resumed runs), none for a turn without one (Default) or with an unknown one.
// A conversation moved here (shared/thread-links.ts): the hand-over brief in turn/start's
// additionalContext reaches the CLI before the message and nowhere else (not the items, not the
// thread file), is left out once the CLI has a session, and a turn that only carries on shows no
// user message; the UI server's link store keeps a conversation's sessions across a restart.

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
import { ThreadLinkStore } from "../server/links.ts";
import { parseSegments } from "../shared/thread-links.ts";
import {
  checkAntigravity,
  checkClaude,
  checkCodex,
  checkThroughProvenance,
  getFallbacks,
  loadClaudeCachedUsage,
} from "../server/fallback/health.ts";
import {
  checkCodexRoute,
  codexPvArgs,
  codexSubKey,
  maskCodexSubKey,
} from "../server/fallback/codex-route.ts";
import http from "node:http";

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
symlinkSync(path.join(here, "fixtures/fake-agy.mjs"), path.join(bin, "agy"));
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
check(
  claude.models.every((m) => m.efforts?.join(",") === "low,medium,high,xhigh,max"),
  "claude efforts: what --help lists for --effort, for every model",
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
const effortsOf = (id: string) => codex.models.find((m) => m.id === id);
check(
  effortsOf("fake-small")?.efforts?.join(",") === "low,medium,high" &&
    effortsOf("fake-small")?.defaultEffort === "low" &&
    effortsOf("fake-big")?.efforts?.join(",") === "low,medium,high,xhigh,max,ultra",
  "codex efforts per model from the catalog, with its default",
);
check(
  effortsOf("")?.efforts?.join(",") === "low,medium,high,xhigh,max,ultra" &&
    !effortsOf("")?.defaultEffort,
  "codex Default (its config's model, unknown here): every listed model's efforts",
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

// ---- through Provenance: the router's pass-through --------------------------------------------
log("through the router");
check(
  codexSubKey("t0k-example") === "6f627cf214b49ef8ff5c3a507c87e31a" && codexSubKey() === "open",
  "the path key is provenance-core's codex_sub.path_key (a hash of the token; open without one)",
);
const pvArgs = codexPvArgs({ url: "http://127.0.0.1:4141/", token: "t0k-example" });
check(
  pvArgs.join(" ") ===
    '-c model_provider="openai" -c openai_base_url="http://127.0.0.1:4141/codex-sub/6f627cf214b49ef8ff5c3a507c87e31a/backend-api/codex" -c features.enable_request_compression=false',
  "app-server args: OpenAI provider, its base at the router's pass-through, no request compression",
);
check(
  !pvArgs.join(" ").includes("t0k-example") && !pvArgs.join(" ").includes("chatgpt_base_url"),
  "the token itself is never on the command line, and chatgpt_base_url is left alone",
);
check(
  maskCodexSubKey(
    "error sending request for url (http://x/codex-sub/6f627cf2/backend-api/codex)",
  ) === "error sending request for url (http://x/codex-sub/***/backend-api/codex)",
  "the key is masked in what app-server prints",
);
const fakeRouter = http.createServer((req, res) => {
  const ok = req.url === `/codex-sub/${codexSubKey("good")}/_health`;
  res.writeHead(ok ? 200 : req.url?.endsWith("/_health") ? 401 : 404).end(ok ? '{"ok":true}' : "");
});
await new Promise<void>((r) => fakeRouter.listen(0, "127.0.0.1", r));
const fr = `http://127.0.0.1:${(fakeRouter.address() as { port: number }).port}`;
check(
  (await checkCodexRoute({ url: fr, token: "good" })) === null,
  "a router with the pass-through: ok",
);
check(
  /didn't accept/.test((await checkCodexRoute({ url: fr, token: "other" })) ?? ""),
  "a wrong key: says so",
);
fakeRouter.close();
check(
  /isn't running/.test((await checkCodexRoute({ url: fr, token: "good" })) ?? ""),
  "no router: says it isn't running (never goes direct)",
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
for (let i = 0; i < 50 && !c.notes.some((n) => n.method === "bridge/status"); i++)
  await new Promise((r) => setTimeout(r, 10));
check(
  c.notes.some((n) => n.method === "bridge/status"),
  "the page gets a ready status on connect",
);
const text = (s: string) => [{ type: "text", text: s, text_elements: [] }];
const backendArchive = (threadId: string) => c.call("thread/archive", { threadId });

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
check(!r.argv.includes("--effort"), "no effort in turn/start (Default): no --effort");
await c.call("turn/start", {
  threadId: th.id,
  input: text("And again"),
  sandboxPolicy: { type: "dangerFullAccess" },
  approvalPolicy: "never",
  effort: "high",
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
  r.argv.join(" ").includes("--effort high") && r.argv.includes("--resume"),
  "turn/start effort high: --effort high, on the resumed session",
);
const resumed = (await c.call("thread/resume", { threadId: th.id })).result as {
  reasoningEffort: string | null;
  thread: { reasoningEffort: string | null };
};
check(
  resumed.reasoningEffort === "high" && resumed.thread.reasoningEffort === "high",
  "the thread reports the effort its last turn ran at",
);
check(
  (turn.items.at(-1) as { text: string }).text === "Done (resumed session).",
  "the resumed answer",
);
await c.call("turn/start", {
  threadId: th.id,
  input: text("Ask me first"),
  sandboxPolicy: { type: "workspaceWrite" },
  approvalPolicy: "untrusted",
});
turn = await c.turnDone(th.id);
r = runs().at(-1)!;
check(
  r.argv.includes("acceptEdits") &&
    !r.argv.includes("dontAsk") &&
    !r.argv.includes("--dangerously-skip-permissions"),
  "Ask every time: Claude Code runs like Auto (acceptEdits), not read only, not full access",
);
check(
  !r.argv.includes("--effort"),
  "back to Default: the next turn sends no --effort (each turn says its own)",
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
  turns.data.length === 3 && turns.data[0].items.length === 5,
  "thread/turns/list: all turns, newest first, items kept",
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
await c.call("turn/start", { threadId: cs.thread.id, input: text("List files"), effort: "xhigh" });
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
  r.argv.join(" ").includes('-c model_reasoning_effort="xhigh"'),
  'turn/start effort xhigh: -c model_reasoning_effort="xhigh"',
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
await c.call("turn/start", { threadId: cs.thread.id, input: text("More"), effort: "low" });
turn = await c.turnDone(cs.thread.id);
r = runs().at(-1)!;
check(
  r.argv.slice(0, 2).join(" ") === "exec resume" && r.argv.includes('sandbox_mode="read-only"'),
  "second turn: exec resume with the sandbox kept",
);
check(
  r.argv.join(" ").includes('-c model_reasoning_effort="low"') && r.argv.at(-1) === "-",
  "and the effort on the resumed run too",
);
check(
  (turn.items.at(-1) as { text: string }).text === "Done (resumed session).",
  "the resumed answer",
);
const ask = (
  await c.call("thread/start", {
    model: "codex:",
    cwd: work,
    sandbox: "workspace-write",
    approvalPolicy: "untrusted",
  })
).result as { thread: { id: string } };
await c.call("turn/start", { threadId: ask.thread.id, input: text("Ask first"), effort: "bogus" });
turn = await c.turnDone(ask.thread.id);
r = runs().at(-1)!;
check(
  r.argv.slice(0, 5).join(" ") === "exec --json --skip-git-repo-check -s workspace-write",
  "Ask every time: Codex runs with workspace-write, like Auto",
);
check(
  !r.argv.join(" ").includes("model_reasoning_effort"),
  "an effort no CLI knows: none sent (Codex's own default)",
);
await backendArchive(ask.thread.id);

log("a conversation moved here: the hand-over brief");
const BRIEF = "[Hand-over: HANDOVER-XYZZY the goal was to split the parser.]";
const handover = { provenance_handover: { value: BRIEF, kind: "application" } };
const ho = (
  await c.call("thread/start", { model: "claude:", cwd: work, sandbox: "workspace-write" })
).result as { thread: { id: string } };
await c.call("turn/start", {
  threadId: ho.thread.id,
  input: text("Now the lexer"),
  additionalContext: handover,
});
turn = await c.turnDone(ho.thread.id);
r = runs().at(-1)!;
check(
  r.stdin === `${BRIEF}\n\nNow the lexer` && !r.argv.includes("--resume"),
  "the CLI gets the brief, then the message, on stdin, in a new session",
);
const firstItem = turn.items[0] as { type: string; content?: { text: string }[] };
check(
  firstItem.type === "userMessage" &&
    firstItem.content?.length === 1 &&
    firstItem.content[0].text === "Now the lexer",
  "the turn's user message is exactly what was typed",
);
const hoFile = () => readFileSync(path.join(dataDir, "threads", `${ho.thread.id}.json`), "utf8");
check(!hoFile().includes("XYZZY"), "the brief is nowhere in the thread file");
check(!JSON.stringify(c.notes).includes("XYZZY"), "nor in anything sent to the page");
await c.call("turn/start", {
  threadId: ho.thread.id,
  input: text("And then?"),
  additionalContext: handover,
});
turn = await c.turnDone(ho.thread.id);
r = runs().at(-1)!;
check(
  r.stdin === "And then?" && r.argv.includes("--resume"),
  "once the CLI has its session, a brief sent again is left out",
);
const co = (
  await c.call("thread/start", { model: "codex:", cwd: work, sandbox: "workspace-write" })
).result as { thread: { id: string } };
await c.call("turn/start", {
  threadId: co.thread.id,
  input: [],
  additionalContext: {
    provenance_handover: { value: `${BRIEF}\n\nCarry on.`, kind: "application" },
  },
});
turn = await c.turnDone(co.thread.id);
r = runs().at(-1)!;
check(
  r.cli === "codex" && r.stdin === `${BRIEF}\n\nCarry on.`,
  "carrying on without a message: the CLI gets the brief and the instruction",
);
check(
  turn.status === "completed" && !turn.items.some((i) => i.type === "userMessage"),
  "and the turn shows no user message",
);
const coFile = readFileSync(path.join(dataDir, "threads", `${co.thread.id}.json`), "utf8");
check(
  !coFile.includes("XYZZY") && JSON.parse(coFile).thread.preview === "",
  "the thread file has no brief, and no preview made of it",
);
const nothing = await c.call("turn/start", { threadId: co.thread.id, input: [] });
check(
  /Nothing to send/.test(nothing.error?.message ?? ""),
  "no message and no brief: nothing to send",
);
await backendArchive(ho.thread.id);
await backendArchive(co.thread.id);

log("the conversation's link store");
const linksFile = path.join(scratch, "links", "thread-links.json");
const store = new ThreadLinkStore(linksFile);
const segs = parseSegments([
  { backend: "main", threadId: "thr-1", model: "solstice", at: 1 },
  { backend: "fallback", threadId: "fb-2", model: "claude:", at: 2 },
]);
check(segs?.length === 2, "two sessions make a conversation's link");
check(
  parseSegments([{ backend: "main", threadId: "thr-1" }]) === null &&
    parseSegments([
      { backend: "main", threadId: "a" },
      { backend: "elsewhere", threadId: "b" },
    ]) === null,
  "one session, or an unknown backend: not a link",
);
store.set("thr-1", segs);
check(
  new ThreadLinkStore(linksFile).all()["thr-1"]?.[1].threadId === "fb-2",
  "kept across a restart (a new store reads the file)",
);
store.set("thr-1", null);
check(
  Object.keys(new ThreadLinkStore(linksFile).all()).length === 0,
  "and forgotten when archived",
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

log("antigravity");
searchPath = `${bin}:${nodeDir}:/usr/bin:/bin`;
const agyHealth = await checkAntigravity(env);
check(
  agyHealth.installed &&
    agyHealth.version === "1.5.14" &&
    agyHealth.models.some((m) => m.id === "gemini-4-neon-high") &&
    agyHealth.usage?.weeklyRemaining === 0.92 &&
    agyHealth.usage?.buckets?.claude_gpt?.weeklyRemaining === 1,
  "antigravity found, version, models, and /usage weekly buckets read",
);
const agyStart = (await c.call("thread/start", {
  model: "antigravity:gemini-4-neon-high",
  cwd: work,
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
})) as { result: { thread: { id: string } } };
await c.call("turn/start", {
  threadId: agyStart.result.thread.id,
  input: [{ type: "text", text: "Check agy" }],
  effort: "high",
});
const agyTurn = await c.turnDone(agyStart.result.thread.id);
check(
  agyTurn.status === "completed" &&
    agyTurn.items.some(
      (i) => i.type === "agentMessage" && /Antigravity handled it/.test(i.text ?? ""),
    ),
  "antigravity turn completes and streams message",
);
const agyRun = runs()
  .filter((x) => x.cli === "agy")
  .at(-1)!;
check(
  agyRun.argv.includes("--model") &&
    agyRun.argv.includes("gemini-4-neon-high") &&
    agyRun.argv.includes("--effort") &&
    agyRun.argv.includes("high"),
  "antigravity runs with --model and --effort",
);
const savedAgy = JSON.parse(readFileSync(path.join(dataDir, "usage.json"), "utf8")) as {
  antigravity?: { weeklyRemaining?: number };
};
check(
  savedAgy.antigravity?.weeklyRemaining === 0.78,
  `antigravity persists stream weekly usage (${savedAgy.antigravity?.weeklyRemaining})`,
);
const agyAfter = await getFallbacks({ ...env, usageFile: path.join(dataDir, "usage.json") }, true);
check(
  agyAfter.antigravity?.usage?.weeklyRemaining === 0.92 &&
    agyAfter.antigravity?.usage?.buckets?.claude_gpt?.weeklyRemaining === 1,
  `antigravity refreshes live /usage buckets (${agyAfter.antigravity?.usage?.weeklyRemaining})`,
);

// Claude Code cached usage from ~/.claude.json (`cachedUsageUtilization`)
const fakeClaudeCfg = path.join(scratch, "claude.json");
const { writeFileSync } = await import("node:fs");
writeFileSync(
  fakeClaudeCfg,
  JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: Date.now(),
      utilization: {
        five_hour: { utilization: 25, resets_at: "2026-11-25T10:00:00Z" },
        seven_day: { utilization: 62, resets_at: "2026-11-28T00:59:59+00:00" },
      },
    },
  }),
);
const claudeLocal = loadClaudeCachedUsage(fakeClaudeCfg);
check(
  claudeLocal != null &&
    Math.abs((claudeLocal.weeklyRemaining ?? -1) - 0.38) < 0.001 &&
    Math.abs((claudeLocal.primaryRemaining ?? -1) - 0.75) < 0.001 &&
    typeof claudeLocal.weeklyResetsAt === "number",
  `claude local cachedUsageUtilization parsed (${JSON.stringify(claudeLocal)})`,
);

c.ws.close();
wss.close();
log("all good");
process.exit(0);
