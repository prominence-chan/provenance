// Offline check of the orchestrators' server side (server/orchestrator/): the parsers, the notes,
// and both orchestrators end to end over a real WebSocket, against a stand-in router (an HTTP
// server that answers POST /v1/responses as a stream, scripted per role) and a stand-in
// app-server (scripts/fixtures/fake-orc-appserver.mjs). No model, no account, nothing on screen.
//
//   npm run check:orchestrator
//
// Covers: plan / action / report parsing with messy input; notes staying under their bound;
// Experimental: a multi-task job, a direct answer, a follow-up planned from the notes, a blocker
// and a revised plan, the caps (tries per task, tasks, model calls), interrupt, a worker's
// approval relayed to the page, router and capacity errors ending the turn; Hyperexperimental: a
// job over three steps (write, run, replace), each call a single-message request, the summary
// bound, the sandbox policy each action is run with, the loop guards, interrupt, "Ask every
// time", read only, a router error; threads read back by a new backend, a turn cut off by a crash.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { AppServerProcess } from "../server/orchestrator/appserver.ts";
import { OrchestratorBackend, type TraceEvent } from "../server/orchestrator/backend.ts";
import { changedSince, snapshot, unwrap } from "../server/orchestrator/experimental.ts";
import { lineDiff, mustAsk, replaceIn } from "../server/orchestrator/hyper.ts";
import {
  addCommand,
  addDone,
  addFile,
  addProblem,
  addRequest,
  emptyNotes,
  NOTES_LIMIT,
  notesText,
  reportSections,
} from "../server/orchestrator/notes.ts";
import {
  parseActions,
  parsePlan,
  parseReport,
  parseThought,
} from "../server/orchestrator/parse.ts";
import { BRIEF_BUDGET, PROMPT_BUDGET, SUMMARY_LIMIT } from "../server/orchestrator/prompts.ts";
import { makeCallModel } from "../server/orchestrator/router.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a: unknown[]) => console.log("[orchestrator-check]", ...a);
function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`expected: ${what}`);
  log(`  ok: ${what}`);
}

// ---- parsers ----------------------------------------------------------------------------------
log("plan parser");
{
  const p = parsePlan(`Here's the plan:

**Task 1:** Create \`mathx.py\` with add and mul
- Done when: the file imports cleanly
2) Write test_mathx.py covering both functions (done when: tests exist)
### Step 3 - Run the tests
   with pytest -q
Acceptance: pytest passes

Let me know if you want changes!`);
  check(
    p.tasks.length === 3,
    `three tasks out of bold, "2)" and "### Step 3 -" (${p.tasks.length})`,
  );
  check(
    p.tasks[0].title === "Create `mathx.py` with add and mul" &&
      p.tasks[0].done === "the file imports cleanly",
    "task 1: title, and its done-criteria from the bullet under it",
  );
  check(
    p.tasks[1].title === "Write test_mathx.py covering both functions" &&
      p.tasks[1].done === "tests exist",
    "task 2: done-criteria taken out of the parentheses",
  );
  check(
    p.tasks[2].title === "Run the tests with pytest -q" && /^pytest passes/.test(p.tasks[2].done),
    `task 3: a wrapped title, "Acceptance:" as done (${JSON.stringify(p.tasks[2])})`,
  );
  const strict = parsePlan("TASK 1: A\nDONE WHEN: a\nTASK 2: B\nDONE WHEN: b\n");
  check(strict.tasks.length === 2 && strict.tasks[1].done === "b", "the format as asked for");
  const fenced = parsePlan("```\ntask 1 - do x\ndone: x works\n```");
  check(
    fenced.tasks.length === 1 && fenced.tasks[0].done === "x works",
    "lowercase, dashes, inside a fence",
  );
  const ans = parsePlan("ANSWER: The tests already pass.\nNothing to change.");
  check(
    ans.tasks.length === 0 && ans.answer === "The tests already pass.\nNothing to change.",
    "ANSWER: with no tasks is a direct reply (both lines)",
  );
  const junk = parsePlan("I am not sure what you mean.");
  check(junk.tasks.length === 0 && junk.answer === null, "prose with no list: no tasks, no answer");
  check(parsePlan("1. a\n2. b\n3. c\n4. d", 2).tasks.length === 2, "the task limit holds");
}

log("action parser");
{
  const a = parseActions(`Sure, here are the actions:

1. **WRITE:** \`src/mathx.py\`
\`\`\`python
def add(a, b):
    return a + b
\`\`\`
2. RUN: \`python3 -m pytest -q\`
3. read: src/mathx.py lines 1-20
- Search: "def add" in src
LIST src
REPLACE: src/mathx.py
<<<
    return a + b
===
    return a + b  # sum
>>>
run:
\`\`\`bash
git status
\`\`\`
That's all!`);
  const kinds = a.actions.map((x) => x.kind).join(",");
  check(kinds === "write,run,read,search,list,replace,run", `seven actions in order (${kinds})`);
  const [w, r, rd, s, l, rp, r2] = a.actions;
  check(
    w.kind === "write" &&
      w.path === "src/mathx.py" &&
      w.content === "def add(a, b):\n    return a + b",
    "WRITE: backticked path, content from a code fence, indentation kept",
  );
  check(r.kind === "run" && r.command === "python3 -m pytest -q", "RUN: backticks taken off");
  check(
    rd.kind === "read" && rd.path === "src/mathx.py" && rd.start === 1 && rd.end === 20,
    "READ: a line range in words",
  );
  check(
    s.kind === "search" && s.pattern === "def add" && s.path === "src",
    "SEARCH: quoted pattern, lowercase in",
  );
  check(l.kind === "list" && l.path === "src", "LIST without a colon");
  check(
    rp.kind === "replace" &&
      rp.find === "    return a + b" &&
      rp.with === "    return a + b  # sum",
    "REPLACE: <<< old === new >>>",
  );
  check(
    r2.kind === "run" && r2.command === "git status",
    "RUN with the command in a fence under it",
  );
  const rr = parseActions("READ: a.py:10-12\nREAD: `b.py` (lines 5 to 3)\nREAD: c.py");
  const [x, y, z] = rr.actions as { path: string; start: number | null; end: number | null }[];
  check(x.path === "a.py" && x.start === 10 && x.end === 12, "READ path:10-12");
  check(y.path === "b.py" && y.start === 3 && y.end === 5, "READ (lines 5 to 3), put in order");
  check(z.path === "c.py" && z.start === null, "READ without a range");
  const twoBlocks = parseActions("EDIT: a.txt\n```\nold\n```\n```\nnew\n```");
  const tb = twoBlocks.actions[0];
  check(
    tb?.kind === "replace" && tb.find === "old" && tb.with === "new",
    "EDIT with two fences: old then new",
  );
  const both = parseActions("WRITE: a.txt\n<<<\n```\nhello\n```\n>>>");
  check(
    both.actions[0]?.kind === "write" && both.actions[0].content === "hello",
    "<<< with a fence inside it",
  );
  const none = parseActions("NONE");
  check(none.none && !none.actions.length, "NONE");
  const bad = parseActions("WRITE: a.txt\nRUN: echo hi");
  check(
    bad.actions.length === 1 && bad.actions[0].kind === "run" && bad.problems.length === 1,
    "a WRITE with no content is reported, the rest still runs",
  );
  const many = parseActions(Array.from({ length: 12 }, (_, i) => `RUN: echo ${i}`).join("\n"), 6);
  check(
    many.actions.length === 6 && many.problems.length === 1,
    "the action limit holds, and says so",
  );
  const prose = parseActions("We should run the tests and read the file to find the bug.");
  check(!prose.actions.length && !prose.none, "prose that mentions run / read is not an action");
  const inSearch = parseActions("SEARCH: import os in sys IN src/app");
  const si = inSearch.actions[0];
  check(
    si?.kind === "search" && si.pattern === "import os in sys" && si.path === "src/app",
    'SEARCH splits on the last " IN "',
  );
}

log("reports, thoughts, small helpers");
{
  check(parseReport("RESULT: ok\nSTATUS: DONE").status === "done", "STATUS: DONE");
  check(parseReport("**STATUS:** BLOCKED").status === "blocked", "bold STATUS: BLOCKED");
  check(parseReport("status - partial").status === "partial", "status - partial");
  check(
    parseReport("I could not install the package.").status === "blocked",
    "no status line, says it couldn't: blocked",
  );
  check(
    parseReport("Created the file and ran it.").status === "done",
    "no status line, plain success: done",
  );
  const sec = reportSections(
    "Done.\n\n**RESULT:** made a.py\nCHANGES: a.py\n- b.py\nVALIDATION: ran x\nBLOCKERS: none\nSTATUS: DONE",
  );
  check(
    sec.result === "made a.py" && sec.changes === "a.py b.py" && sec.blockers === "",
    "report sections; BLOCKERS: none is empty",
  );
  check(parseThought("FINISHED: It works.").final === "It works.", "FINISHED: is final");
  check(
    parseThought("Checked it.\n\n**FINISHED:** All good.").final === "All good.",
    "bold FINISHED after a line of text",
  );
  check(
    parseThought("Once finished: we will test. Run pytest.").final === null,
    '"finished" inside a sentence is not final',
  );
  check(replaceIn("a\n  b\nc\n", "b", "B") === "a\n  B\nc\n", "replace: exact text");
  check(
    replaceIn("a\n    return x  \nc\n", "return x", "return y") === "a\n    return y  \nc\n",
    "replace: exact substring wins",
  );
  check(
    replaceIn("if x:\n\treturn 1\n", "if x:\n    return 1", "if x:\n    return 2") ===
      "if x:\n    return 2\n",
    "replace: same lines, other indentation",
  );
  check(replaceIn("abc", "zzz", "y") === null, "replace: not found is null");
  check(
    lineDiff("a\nb\nc\n", "a\nB\nc\n") === "@@ -2,1 +2,1 @@\n-b\n+B",
    "line diff of the changed middle",
  );
  check(
    mustAsk("untrusted") &&
      mustAsk({ granular: {} }) &&
      !mustAsk("on-request") &&
      !mustAsk("never"),
    "Ask every time (and any unknown policy) asks; Auto and Full access don't",
  );
}

log("notes");
{
  const n = emptyNotes();
  addRequest(n, "Build the thing ".repeat(100));
  for (let i = 0; i < 60; i++) {
    addDone(
      n,
      `Task number ${i} with a fairly long title to take up room`,
      `it did part ${i} and wrote things down at length `.repeat(4),
    );
    addFile(n, `src/file${i}.py`, "add");
    addCommand(n, `pytest tests/test_${i}.py -q`, i % 3 !== 0);
    if (i % 10 === 0) addProblem(n, `problem ${i}: something went wrong here`);
  }
  const text = notesText(n);
  check(
    text.length <= NOTES_LIMIT,
    `60 tasks of notes fit the bound (${text.length} <= ${NOTES_LIMIT})`,
  );
  check(text.startsWith("GOAL: Build the thing"), "the goal is kept");
  check(
    n.folded > 50 && /\(\d+ earlier tasks finished\)/.test(text),
    `the oldest tasks were folded into a count (${n.folded})`,
  );
  check(
    text.includes("Task number 59") && !text.includes("Task number 3 "),
    "the newest task is there, an old one is not",
  );
  check(
    text.includes("FAILED: pytest tests/test_57.py") &&
      text.includes("ok: pytest tests/test_59.py"),
    "recent commands with how they ended",
  );
}

// ---- stand-in router --------------------------------------------------------------------------
interface Seen {
  role: string;
  instructions: string;
  input: string;
  session: string;
  body: Record<string, unknown>;
}
const seen: Seen[] = [];
let summaries = 0;
const ROLES: [string, string][] = [
  ["You split a coding request", "planner"],
  ["A coding job is split", "revise"],
  ["Write the reply to the user", "final"],
  ["You direct a coding job", "think"],
  ["Turn the PLAN into actions", "translate"],
  ["You keep the running summary", "summarize"],
];
function answer(role: string, whole: string): string | number {
  const step = Number(/This is step (\d+)/.exec(whole)?.[1] ?? 0);
  // The planner and think are scripted by the request alone (the notes repeat older requests).
  const input =
    role === "planner" || role === "think"
      ? (/^(?:REQUEST|GOAL):\n([\s\S]*?)\n\nFOLDER/.exec(whole)?.[1] ?? whole)
      : whole;
  switch (role) {
    case "planner":
      if (/r503/.test(input)) return 503;
      if (/hello/.test(input)) return "ANSWER: Hi! Nothing to do in the folder.";
      if (/multi/.test(input))
        return "Here's the plan:\n\n**Task 1:** Create `mathx.py` with add and mul\n- Done when: the file imports cleanly\n2) Write test_mathx.py covering both functions (done when: tests exist)\n### Step 3 - Run the tests\nAcceptance: pytest passes";
      if (/blocked/.test(input))
        return "TASK 1: Set up\nDONE WHEN: ok\nTASK 2: BLOCKME install the thing\nDONE WHEN: installed\nTASK 3: Use the thing\nDONE WHEN: used";
      if (/stuck/.test(input)) return "TASK 1: BLOCKME forever\nDONE WHEN: never";
      if (/many/.test(input))
        return Array.from(
          { length: 7 },
          (_, i) => `TASK ${i + 1}: Part ${i + 1}\nDONE WHEN: ok`,
        ).join("\n");
      if (/slow/.test(input)) return "TASK 1: SLOWTASK wait a long time";
      if (/askme/.test(input)) return "TASK 1: ASKME run it";
      if (/nocap/.test(input)) return "TASK 1: NOCAP";
      if (/calls/.test(input)) return "TASK 1: LOOPCALLS";
      if (/silent/.test(input)) return "TASK 1: IDLETASK";
      return "TASK 1: Follow up on it\nDONE WHEN: done";
    case "revise":
      if (/BLOCKME forever/.test(input)) return "TASK 1: BLOCKME forever\nDONE WHEN: never";
      return "1. Do the thing another way\n   Done when: it works\n2. Use the thing";
    case "final":
      return "All done: the tasks finished.";
    case "think":
      if (/module/.test(input)) {
        if (step === 1)
          return 'First create mathx.py with this content:\n```python\ndef add(a, b):\n    return a + b\n```\nThen run `python3 -c "import mathx; print(mathx.add(2, 3))"` to check it.';
        if (step === 2)
          return "Now replace the return line in mathx.py so it carries a comment, then search for def add and list the folder.";
        return "It printed 5.\n\nFINISHED: Created mathx.py with add(); running it printed 5.";
      }
      if (/again/.test(input)) return "Run echo same once more.";
      if (/steps/.test(input)) return `Run echo step ${step}.`;
      if (/nothing/.test(input)) return "I think we should consider things carefully.";
      if (/hslow/.test(input)) return "Run sleep 30.";
      if (/hask|hro/.test(input))
        return step === 1
          ? "Write notes.txt saying hello, then run echo hi."
          : "FINISHED: Tried it.";
      if (/h503/.test(input)) return "Do the h503 thing.";
      return "FINISHED: Nothing to do.";
    case "translate":
      if (/h503/.test(input)) return 503;
      if (/create mathx\.py/.test(input))
        return 'Sure, here are the actions:\n\n1. **WRITE:** `mathx.py`\n```python\ndef add(a, b):\n    return a + b\n```\n2. RUN: `python3 -c "import mathx; print(mathx.add(2, 3))"`\n3. read: mathx.py lines 1-2';
      if (/replace the return line/.test(input))
        return 'REPLACE: mathx.py\n<<<\nreturn a + b\n===\nreturn a + b  # sum\n>>>\nSEARCH: "def add" IN .\nLIST: .';
      if (/echo same/.test(input)) return "RUN: echo same";
      if (/echo step/.test(input)) return `RUN: echo step ${/echo step (\d+)/.exec(input)?.[1]}`;
      if (/sleep 30/.test(input)) return "RUN: sleep 30";
      if (/notes\.txt/.test(input)) return "WRITE: notes.txt\n<<<\nhello\n>>>\nRUN: echo hi";
      return "NONE";
    case "summarize":
      return `SUMMARY v${++summaries}: mathx.py holds add(); the check printed 5. ${"More detail than anyone needs. ".repeat(140)}`;
  }
  return 404;
}
const router = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url !== "/v1/responses" || req.method !== "POST") return void res.writeHead(404).end();
    const body = JSON.parse(raw) as Record<string, unknown>;
    const instructions = String(body.instructions ?? "");
    const msgs = body.input as { role: string; content: { text: string }[] }[];
    const input = msgs.map((m) => m.content.map((c) => c.text).join("")).join("\n");
    const role = ROLES.find(([start]) => instructions.startsWith(start))?.[1] ?? "?";
    seen.push({
      role,
      instructions,
      input,
      session: String(req.headers["x-pcore-session"] ?? ""),
      body,
    });
    if (/hangcall/.test(input)) return; // never answers: only an interrupt ends this call
    const out = answer(role, input);
    if (typeof out === "number") {
      res.writeHead(out, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({
          error: {
            message: "no model in spark (or below) could serve this: [pool/spark: 429]",
            code: "no_capacity",
          },
        }),
      );
    }
    res.writeHead(200, { "content-type": "text/event-stream", "x-pcore-model": "fake/model" });
    const ev = (o: unknown) => res.write(`event: x\ndata: ${JSON.stringify(o)}\n\n`);
    const half = Math.floor(out.length / 2);
    ev({ type: "response.created" });
    ev({ type: "response.output_text.delta", delta: out.slice(0, half) });
    ev({ type: "response.output_text.delta", delta: out.slice(half) });
    ev({
      type: "response.completed",
      response: { output: [{ type: "message", content: [{ type: "output_text", text: out }] }] },
    });
    res.end();
  });
});
await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
const routerUrl = `http://127.0.0.1:${(router.address() as { port: number }).port}`;

// ---- the backend over a real WebSocket ----------------------------------------------------------
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "provenance-orchestrator-check-")));
const work = path.join(scratch, "work");
mkdirSync(work);
writeFileSync(path.join(work, "README.md"), "scratch\n");
const dataDir = path.join(scratch, "data");
const fakeLog = path.join(scratch, "appserver.jsonl");
writeFileSync(fakeLog, "");
process.env.FAKE_ORC_LOG = fakeLog;
type LogLine = {
  threadStart?: Record<string, unknown>;
  turnStart?: { threadId: string; brief: string };
  exec?: {
    command: string[];
    cwd: string;
    sandboxPolicy: { type: string; writableRoots?: string[] };
  };
  interrupt?: string;
  terminate?: string;
  approval?: { decision?: string };
};
const fake = () =>
  readFileSync(fakeLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogLine);
const traces: TraceEvent[] = [];
const appServer = new AppServerProcess({
  bin: path.join(here, "fixtures/fake-orc-appserver.mjs"),
  runDir: path.join(dataDir, "run"),
  env: () => ({}),
  log: () => {},
});
const CAPS = {
  tasks: 4,
  attempts: 2,
  replans: 3,
  steps: 4,
  modelCalls: 30,
  workerMs: 20_000,
  workerIdleMs: 1500,
  commandMs: 10_000,
};
const makeBackend = () =>
  new OrchestratorBackend({
    dir: dataDir,
    appServer: () => appServer,
    callModel: makeCallModel(() => ({ url: routerUrl })),
    caps: CAPS,
    log: () => {},
    trace: (e) => traces.push(e),
  });
let backend = makeBackend();
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => wss.once("listening", r));
wss.on("connection", (ws) => backend.attach(ws));
const port = (wss.address() as { port: number }).port;

type TurnItem = {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregatedOutput?: string;
  status?: string;
  exitCode?: number;
  changes?: { path: string; diff: string; kind: { type: string } }[];
};
type Turn = {
  id: string;
  status: string;
  items: TurnItem[];
  error: { message: string } | null;
  orchestration?: {
    modelCalls: number;
    workers: number;
    workerCalls: number;
    steps: number;
    roles: Record<string, { calls: number; maxPromptChars: number }>;
  };
};
type Msg = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
};
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const notes: Msg[] = [];
const waits = new Map<number, (m: Msg) => void>();
let seq = 0;
ws.on("message", (d) => {
  const m = JSON.parse(String(d)) as Msg;
  if (m.id !== undefined && !m.method) waits.get(m.id as number)?.(m);
  else notes.push(m);
});
await new Promise((r) => ws.once("open", r));
const call = (method: string, params: unknown) =>
  new Promise<Msg>((resolve) => {
    const id = ++seq;
    waits.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const until = async <T>(
  what: string,
  f: () => T | undefined | false | null,
  ms = 20_000,
): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const turnDone = (threadId: string, ms = 20_000) =>
  until(
    `turn/completed in ${threadId}`,
    () => {
      const n = notes.find((x) => x.method === "turn/completed" && x.params?.threadId === threadId);
      if (!n) return null;
      notes.splice(notes.indexOf(n), 1);
      return n.params!.turn as Turn;
    },
    ms,
  );
const text = (s: string) => [{ type: "text", text: s, text_elements: [] }];
const start = async (orchestrator: string, extra: Record<string, unknown> = {}) => {
  const r = await call("thread/start", {
    model: "pool/spark",
    cwd: work,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    config: { orchestrator },
    ...extra,
  });
  if (r.error) throw new Error(r.error.message);
  return (r.result as { thread: { id: string; orchestrator: string } }).thread;
};
const say = async (threadId: string, s: string, extra: Record<string, unknown> = {}) => {
  const r = await call("turn/start", { threadId, input: text(s), ...extra });
  if (r.error) throw new Error(r.error.message);
};
const stored = (id: string) =>
  JSON.parse(readFileSync(path.join(dataDir, "threads", `${id}.json`), "utf8")) as {
    notes: ReturnType<typeof emptyNotes>;
    summary: string;
    orchestrator: string;
    turns: Turn[];
  };
const last = (t: Turn) => t.items.at(-1)?.text ?? "";
const kindsOf = (t: Turn) => t.items.map((i) => i.type).join(",");

check(
  notes.some((n) => n.method === "bridge/status"),
  "the page gets a ready status on connect",
);
const refused = await call("thread/start", { model: "pool/spark", cwd: work });
check(
  /config\.orchestrator/.test(refused.error?.message ?? ""),
  "thread/start without an orchestrator is refused",
);
const refused2 = await call("thread/start", {
  model: "claude:opus",
  cwd: work,
  config: { orchestrator: "experimental" },
});
check(/tier/.test(refused2.error?.message ?? ""), "a fallback model is refused");

// ---- Experimental -------------------------------------------------------------------------------
log("experimental: a multi-task job");
const ex = await start("experimental");
check(
  ex.id.startsWith("orc-") && ex.orchestrator === "experimental",
  "thread/start: an orc- thread that records its orchestrator",
);
await say(ex.id, "multi: make a tiny module with a test and run it");
let turn = await turnDone(ex.id);
check(turn.status === "completed", "turn completed");
check(
  kindsOf(turn) ===
    "userMessage,agentMessage," +
      Array(3).fill("agentMessage,commandExecution,fileChange").join(",") +
      ",agentMessage",
  `items: the plan, then per task a header and the worker's command and edit, then the answer (${kindsOf(turn)})`,
);
check(
  /^Plan, 3 tasks:/.test(turn.items[1].text ?? "") &&
    /3\. Run the tests/.test(turn.items[1].text ?? ""),
  "the plan is shown",
);
check(
  /\*\*Task 2 of 3:\*\* Write test_mathx.py/.test(turn.items[5].text ?? ""),
  "each task is announced",
);
check(
  turn.items[3].id.startsWith(`${turn.id}-w1-`) &&
    turn.items[3].command?.startsWith("/bin/zsh -lc 'echo Create mathxpy"),
  "worker items keep their content under ids of this turn",
);
check(last(turn) === "All done: the tasks finished.", "the final answer comes from the final call");
check(
  notes.some(
    (n) => n.method === "item/commandExecution/outputDelta" && n.params?.threadId === ex.id,
  ),
  "a worker's command output streams into the visible thread",
);
check(
  notes.some((n) => n.method === "turn/plan/updated" && (n.params?.plan as unknown[]).length === 3),
  "turn/plan/updated carries the task list",
);
let lines = fake();
const starts = lines.filter((l) => l.threadStart).map((l) => l.threadStart!);
check(starts.length === 3, "three workers, three fresh threads");
check(
  starts.every(
    (s) =>
      s.ephemeral === true &&
      s.sandbox === "workspace-write" &&
      s.approvalPolicy === "on-request" &&
      s.model === "pool/spark" &&
      s.cwd === work,
  ),
  "each worker thread is ephemeral, with the thread's tier, folder, sandbox and approval preset",
);
const briefs = lines.filter((l) => l.turnStart).map((l) => l.turnStart!.brief);
check(
  briefs.every((b) => b.length <= BRIEF_BUDGET),
  `every brief is within its budget (largest ${Math.max(...briefs.map((b) => b.length))} <= ${BRIEF_BUDGET})`,
);
check(
  /YOUR TASK \(1 of 3\): Create `mathx\.py`/.test(briefs[0]) &&
    /DONE WHEN: the file imports cleanly/.test(briefs[0]) &&
    /\(none: you are first\)/.test(briefs[0]),
  "the first brief: the task, its done-criteria, no notes yet",
);
check(
  /DONE \(as reported by workers\):\n- Create `mathx\.py` with add and mul: finished/.test(
    briefs[1],
  ) &&
    /FILES CHANGED \(recorded\): f-\d+\.txt \(add\)/.test(briefs[1]) &&
    /- ok: echo Create mathxpy/.test(briefs[1]),
  "the second brief carries the notes: what was reported, files and commands as recorded",
);
check(
  /LATER TASKS[^\n]*Run the tests/.test(briefs[1]) && !/LATER TASKS/.test(briefs[2]),
  "a brief names the later tasks as not its own",
);
let rec = stored(ex.id);
check(
  rec.orchestrator === "experimental" && rec.notes.done.length === 3 && rec.notes.files.length >= 1,
  "the thread file keeps the orchestrator and the notes",
);
check(notesText(rec.notes).length <= NOTES_LIMIT, "notes under the bound");
{
  const snap = snapshot(work);
  writeFileSync(path.join(work, "made-by-a-command.txt"), "x");
  writeFileSync(path.join(work, "README.md"), "scratch, edited\n");
  const ch = changedSince(work, snap)
    .map((c) => `${c.path}:${c.kind}`)
    .sort()
    .join(",");
  check(
    ch === "README.md:update,made-by-a-command.txt:add",
    `files a command wrote are found by comparing the folder (${ch})`,
  );
  check(
    unwrap("/bin/zsh -lc 'npm test'") === "npm test" &&
      unwrap('/bin/zsh -lc "echo \\"hi\\" > a.txt"') === 'echo "hi" > a.txt' &&
      unwrap("ls -la") === "ls -la",
    "the shell wrapper comes off a command, single- or double-quoted",
  );
}
check(
  turn.orchestration?.modelCalls === 8 &&
    turn.orchestration.workers === 3 &&
    turn.orchestration.workerCalls === 6 &&
    turn.orchestration.roles.planner.calls === 1 &&
    turn.orchestration.roles.final.calls === 1,
  `the turn records what it cost: 8 model calls = planner + 3 workers x 2 + final (${JSON.stringify(turn.orchestration)})`,
);
const exSeen = seen.slice();
check(
  exSeen.length === 2 && exSeen[0].role === "planner" && exSeen[1].role === "final",
  "two plain calls reached the router",
);
check(
  exSeen.every(
    (s) =>
      (s.body.input as unknown[]).length === 1 &&
      s.body.store === false &&
      s.body.stream === true &&
      !("previous_response_id" in s.body) &&
      !("tools" in s.body) &&
      s.body.model === "pool/spark",
  ),
  "each is one user message, streamed, not stored, no tools, nothing to attach it to an earlier chat",
);
check(
  new Set(exSeen.map((s) => s.session)).size === exSeen.length &&
    exSeen.every((s) => s.session.startsWith("orc-")),
  "each has a session key of its own",
);
check(
  /FOLDER: .*work \(.*\); contains: README\.md/.test(exSeen[0].input),
  "the planner sees a one-line listing of the folder",
);
check(
  /DONE \(as reported/.test(exSeen[1].input) && /LAST WORKER'S REPORT/.test(exSeen[1].input),
  "the final call is written from the notes",
);

log("experimental: a follow-up starts from the notes");
seen.length = 0;
await say(ex.id, "now a follow-up on that");
turn = await turnDone(ex.id);
check(
  turn.status === "completed" && /RESULT: finished "Follow up on it"/.test(last(turn)),
  "a one-task turn answers with the worker's report, no final call",
);
check(!/STATUS:/.test(last(turn)), "without its STATUS line");
check(seen.length === 1 && seen[0].role === "planner", "one plain call (the planner)");
check(
  /GOAL: multi: make a tiny module/.test(seen[0].input) &&
    /- Run the tests with pytest|Run the tests/.test(seen[0].input) &&
    !seen[0].input.includes("All done: the tasks finished."),
  "the planner got the notes (goal, finished tasks), not the earlier conversation",
);
const fb = fake()
  .filter((l) => l.turnStart)
  .at(-1)!.turnStart!.brief;
check(
  /OVERALL GOAL: multi: make a tiny module/.test(fb) && /LATER REQUEST: now a follow-up/.test(fb),
  "the worker's brief has the goal and the new request from the notes",
);

log("experimental: a direct answer");
seen.length = 0;
const hello = await start("experimental");
await say(hello.id, "hello");
turn = await turnDone(hello.id);
check(
  turn.status === "completed" &&
    last(turn) === "Hi! Nothing to do in the folder." &&
    turn.orchestration?.workers === 0 &&
    seen.length === 1,
  "ANSWER: from the planner is the reply: one call, no worker",
);

log("experimental: a blocker, a revised plan");
seen.length = 0;
const bl = await start("experimental");
await say(bl.id, "blocked: do the thing");
turn = await turnDone(bl.id);
check(turn.status === "completed", "turn completed");
check(
  seen.map((s) => s.role).join(",") === "planner,revise,final",
  "the planner was asked to revise after the blocked task",
);
const rv = seen[1].input;
check(
  /TASK THAT HIT A PROBLEM: BLOCKME install the thing/.test(rv) &&
    /frobnicate is missing/.test(rv) &&
    /1\. Use the thing/.test(rv),
  "the revision sees the task, its report and what was still planned",
);
check(
  turn.items.some((i) => /Revised plan:\n\n1\. Do the thing another way/.test(i.text ?? "")),
  "the revised plan is shown",
);
rec = stored(bl.id);
check(
  rec.notes.problems.some((p) => /frobnicate/.test(p)) && rec.notes.done.length === 3,
  "the notes keep the problem and the three finished tasks",
);

log("experimental: caps");
const st = await start("experimental");
await say(st.id, "stuck: this cannot work");
turn = await turnDone(st.id);
check(
  turn.status === "completed" &&
    /^Stopped: the task "BLOCKME forever" came up 3 times/.test(last(turn)),
  `tries per task: a plain message (${last(turn).split("\n")[0]})`,
);
check(
  /Where things stand:/.test(last(turn)) && /PROBLEMS HIT/.test(last(turn)),
  "with where things stand",
);
const many = await start("experimental");
await say(many.id, "many parts");
turn = await turnDone(many.id);
check(
  /^Stopped after 4 tasks, the limit for one message\. Not done: "Part 5", "Part 6", "Part 7"/.test(
    last(turn),
  ),
  "tasks per turn: stops and names what is left",
);
const calls = await start("experimental");
let before = fake().filter((l) => l.interrupt).length;
await say(calls.id, "calls: loop on model calls");
turn = await turnDone(calls.id);
check(
  turn.status === "completed" &&
    /^Stopped: this turn reached its limit of 30 model calls\./.test(last(turn)),
  "model calls per turn: a worker that keeps calling is stopped",
);
check(
  fake().filter((l) => l.interrupt).length === before + 1 && turn.orchestration?.modelCalls === 30,
  "the worker was interrupted at the limit",
);

const idleT = await start("experimental");
await say(idleT.id, "silent model");
turn = await turnDone(idleT.id);
check(
  turn.status === "failed" &&
    /^The model stopped answering: a worker heard nothing from it for/.test(
      turn.error?.message ?? "",
    ),
  "a worker whose model goes silent is stopped, and the turn ends saying so",
);

log("experimental: interrupt");
const sl = await start("experimental");
await say(sl.id, "slow job");
await until("the worker's command", () =>
  notes.some(
    (n) =>
      n.method === "item/started" &&
      n.params?.threadId === sl.id &&
      (n.params.item as TurnItem).type === "commandExecution",
  ),
);
let t0 = Date.now();
await call("turn/interrupt", { threadId: sl.id });
turn = await turnDone(sl.id, 8000);
check(
  turn.status === "interrupted" && Date.now() - t0 < 3000,
  `interrupt stops the worker (${Date.now() - t0} ms)`,
);
check(
  turn.items.some((i) => i.type === "commandExecution" && i.status === "failed"),
  "the command it was in shows as not finished",
);
check(
  (await call("thread/read", { threadId: sl.id })).result !== undefined &&
    (
      (await call("thread/list", {})).result as { data: { id: string; status: { type: string } }[] }
    ).data.find((t) => t.id === sl.id)?.status.type === "idle",
  "the thread is idle again",
);
await say(sl.id, "hello");
turn = await turnDone(sl.id);
check(turn.status === "completed", "and takes the next message");

const hg = await start("experimental");
seen.length = 0;
await say(hg.id, "hangcall");
await until("the planner call", () => seen.length === 1);
t0 = Date.now();
await call("turn/interrupt", { threadId: hg.id });
turn = await turnDone(hg.id, 5000);
check(
  turn.status === "interrupted" && Date.now() - t0 < 1500 && turn.error === null,
  `interrupt during a plain model call ends it at once (${Date.now() - t0} ms)`,
);

log("experimental: a worker's approval request");
const ak = await start("experimental", { approvalPolicy: "untrusted" });
await say(ak.id, "askme: run it");
const reqMsg = await until("the approval request", () =>
  notes.find((n) => n.method === "item/commandExecution/requestApproval"),
);
check(
  reqMsg.params?.threadId === ak.id && typeof reqMsg.id === "string",
  "the page is asked, under the visible thread's id",
);
const live = (await call("thread/turns/list", { threadId: ak.id, sortDirection: "desc" }))
  .result as { data: Turn[] };
check(
  live.data[0].items.some((i) => i.id === reqMsg.params?.itemId && i.status === "inProgress"),
  "its itemId is the command row in the visible turn",
);
check(reqMsg.params?.turnId === live.data[0].id, "and its turnId the visible turn");
// a page that connects now still sees the question
const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
const late: Msg[] = [];
ws2.on("message", (d) => late.push(JSON.parse(String(d)) as Msg));
await until("the late page's copy", () => late.some((m) => m.id === reqMsg.id));
check(true, "a page that connects later gets the open request too");
ws2.close();
ws.send(JSON.stringify({ id: reqMsg.id, result: { decision: "accept" } }));
turn = await turnDone(ak.id);
check(
  turn.status === "completed" &&
    turn.items.some((i) => i.type === "commandExecution" && i.status === "completed"),
  "approved: the worker ran it and finished",
);
check(
  fake().some((l) => l.approval?.decision === "accept"),
  "the harness got the user's decision",
);
check(
  notes.some((n) => n.method === "serverRequest/resolved" && n.params?.requestId === reqMsg.id),
  "serverRequest/resolved clears the card",
);
check(
  fake()
    .filter((l) => l.threadStart)
    .at(-1)!.threadStart!.approvalPolicy === "untrusted",
  "the worker thread got the thread's approval policy",
);

log("experimental: router and capacity errors");
seen.length = 0;
const r5 = await start("experimental");
await say(r5.id, "r503 please");
turn = await turnDone(r5.id);
check(
  turn.status === "failed" &&
    /^No free model could take this right now \(the router answered 503: no model in spark/.test(
      turn.error?.message ?? "",
    ),
  `a 503 ends the turn with a plain message (${turn.error?.message.slice(0, 60)}…)`,
);
check(seen.length === 1, "and is not retried");
check(
  notes.some((n) => n.method === "error" && n.params?.threadId === r5.id),
  "an error notification goes out",
);
const nc = await start("experimental");
await say(nc.id, "nocap now");
turn = await turnDone(nc.id);
check(
  turn.status === "failed" &&
    /^No free model could take this right now/.test(turn.error?.message ?? ""),
  "a worker that finds no model ends the turn the same way",
);

// ---- Hyperexperimental ----------------------------------------------------------------------------
log("hyperexperimental: a job over three steps");
seen.length = 0;
writeFileSync(fakeLog, "");
const hy = await start("hyperexperimental");
await say(hy.id, "module ZEBRA-GOAL: make mathx.py with add and check it");
turn = await turnDone(hy.id);
check(turn.status === "completed", "turn completed");
check(
  kindsOf(turn) ===
    "userMessage,agentMessage,fileChange,commandExecution,commandExecution,agentMessage,fileChange,commandExecution,commandExecution,agentMessage",
  `items: per step the plan in words, then its actions; then the answer (${kindsOf(turn)})`,
);
check(
  last(turn) === "Created mathx.py with add(); running it printed 5.",
  "FINISHED: is the answer",
);
check(
  readFileSync(path.join(work, "mathx.py"), "utf8") === "def add(a, b):\n    return a + b  # sum\n",
  "the file was written, then edited",
);
const w1 = turn.items[2];
check(
  w1.status === "completed" &&
    w1.changes?.[0].path === "mathx.py" &&
    w1.changes[0].kind.type === "add" &&
    w1.changes[0].diff.includes("+def add(a, b):"),
  "WRITE shows as an added file with its diff",
);
const c1 = turn.items[3];
check(
  c1.command === 'python3 -c "import mathx; print(mathx.add(2, 3))"' &&
    c1.aggregatedOutput === "5" &&
    c1.exitCode === 0,
  "RUN shows as a command with its output",
);
check(
  turn.items[4].command === "READ: mathx.py 1-2" &&
    /def add\(a, b\):\n {4}return a \+ b\n\[lines 1-2 of 2\]/.test(
      turn.items[4].aggregatedOutput ?? "",
    ),
  "READ shows the lines and how many there are",
);
const e1 = turn.items[6];
check(
  e1.changes?.[0].kind.type === "update" &&
    e1.changes[0].diff === "@@ -2,1 +2,1 @@\n-    return a + b\n+    return a + b  # sum",
  "REPLACE shows as an update with the changed line",
);
check(
  /mathx\.py:1:def add/.test(turn.items[7].aggregatedOutput ?? "") &&
    /mathx\.py/.test(turn.items[8].aggregatedOutput ?? ""),
  "SEARCH and LIST answer",
);
check(
  seen.map((s) => s.role).join(",") === "think,translate,summarize,think,translate,summarize,think",
  "three chats per step: think, translate, summarize",
);
check(
  seen.every(
    (s) =>
      (s.body.input as unknown[]).length === 1 &&
      s.body.store === false &&
      !("previous_response_id" in s.body),
  ) && new Set(seen.map((s) => s.session)).size === seen.length,
  "every call is a single-message request with its own session key",
);
check(
  seen.every((s) => s.instructions.length + s.input.length <= PROMPT_BUDGET),
  `every prompt is within the budget (largest ${Math.max(...seen.map((s) => s.instructions.length + s.input.length))} <= ${PROMPT_BUDGET})`,
);
const tr = seen.filter((s) => s.role === "translate");
check(
  tr.every((s) => !s.input.includes("ZEBRA-GOAL") && !s.input.includes("SUMMARY")),
  "translate sees only the plan in words, the folder and the platform",
);
check(
  tr[0].input.startsWith(`Working folder: ${work}\nPlatform: `) &&
    tr[0].input.includes("First create mathx.py"),
  "(it does see those)",
);
const th2 = seen.filter((s) => s.role === "think")[1].input;
check(
  /SUMMARY SO FAR:\nSUMMARY v1: mathx\.py holds add\(\)/.test(th2) &&
    /LAST STEP RESULTS:\nWRITE: mathx\.py \(2 lines\)\n\[created mathx\.py, 2 lines\]/.test(th2) &&
    /RUN: python3 [^\n]*\n5\n/.test(th2),
  "the next think gets the summary and the last step's results, nothing else",
);
check(!th2.includes("First create mathx.py"), "not the earlier think's own words");
const sm = seen.filter((s) => s.role === "summarize")[1].input;
check(
  /PREVIOUS SUMMARY:\nSUMMARY v1/.test(sm) &&
    /REPLACE: mathx\.py\n\[updated mathx\.py, 2 lines\]/.test(sm),
  "summarize folds the step into the previous summary",
);
rec = stored(hy.id);
check(
  rec.summary.length <= SUMMARY_LIMIT &&
    rec.summary.startsWith("SUMMARY v2") &&
    /was answered: Created mathx\.py/.test(rec.summary),
  `the stored summary is cut to its bound (${rec.summary.length} <= ${SUMMARY_LIMIT}) and ends with the answer given`,
);
check(
  turn.orchestration?.modelCalls === 7 && turn.orchestration.steps === 3,
  "7 model calls over 3 steps",
);
lines = fake();
const execs = lines.filter((l) => l.exec).map((l) => l.exec!);
check(!lines.some((l) => l.threadStart), "no worker thread: actions run through command/exec");
check(
  execs.every((e) => e.cwd === work && e.sandboxPolicy && typeof e.sandboxPolicy.type === "string"),
  "every command names the thread's folder and an explicit sandbox policy",
);
const isWrite = (e: (typeof execs)[number]) => e.command.join(" ").includes("base64 --decode");
const isRun = (e: (typeof execs)[number]) => e.command[1] === "-lc";
check(
  execs.filter((e) => isWrite(e) || isRun(e)).length === 3 &&
    execs
      .filter((e) => isWrite(e) || isRun(e))
      .every(
        (e) =>
          e.sandboxPolicy.type === "workspaceWrite" &&
          e.sandboxPolicy.writableRoots?.join() === work,
      ),
  "writes and RUN use the thread's policy: workspace write, the thread's folder the writable root",
);
check(
  execs.filter((e) => !isWrite(e) && !isRun(e)).every((e) => e.sandboxPolicy.type === "readOnly"),
  "reads, searches and listings use the read-only policy",
);

log("hyperexperimental: a follow-up starts from the summary");
seen.length = 0;
await say(hy.id, "anything else?");
turn = await turnDone(hy.id);
check(
  turn.status === "completed" &&
    seen.length === 1 &&
    /SUMMARY SO FAR:\nSUMMARY v2/.test(seen[0].input) &&
    /GOAL:\nanything else\?/.test(seen[0].input),
  "the next turn's first think gets the stored summary and the new message",
);

log("hyperexperimental: loop guards");
const ag = await start("hyperexperimental");
await say(ag.id, "again and again");
turn = await turnDone(ag.id);
check(
  turn.status === "completed" &&
    /^Stopped: the same step came back three times in a row\./.test(last(turn)),
  "the same step three times: stopped with a plain message",
);
check(
  turn.items.filter((i) => i.type === "commandExecution").length === 2,
  "(it ran twice, not the third time)",
);
const sp = await start("hyperexperimental");
await say(sp.id, "steps without end");
turn = await turnDone(sp.id);
check(
  /^Stopped after 4 steps, the limit for one message\./.test(last(turn)) &&
    turn.items.filter((i) => i.type === "commandExecution").length === 4,
  "steps per turn",
);
const no = await start("hyperexperimental");
await say(no.id, "nothing concrete");
turn = await turnDone(no.id);
check(
  /^Stopped: two steps in a row produced nothing that could be run\./.test(last(turn)),
  "two steps with no action: stopped",
);

log("hyperexperimental: interrupt");
const hs = await start("hyperexperimental");
await say(hs.id, "hslow");
await until("the sleep", () =>
  notes.some(
    (n) =>
      n.method === "item/started" &&
      n.params?.threadId === hs.id &&
      (n.params.item as TurnItem).command === "sleep 30",
  ),
);
await new Promise((r) => setTimeout(r, 150));
t0 = Date.now();
await call("turn/interrupt", { threadId: hs.id });
turn = await turnDone(hs.id, 8000);
check(
  turn.status === "interrupted" && Date.now() - t0 < 3000,
  `interrupt stops the command (${Date.now() - t0} ms)`,
);
check(
  fake().some((l) => l.terminate),
  "the process was terminated through app-server",
);
check(
  turn.items.at(-1)?.type === "commandExecution" && turn.items.at(-1)?.status === "failed",
  "its row shows as not finished",
);

log("hyperexperimental: Ask every time, and read only");
writeFileSync(fakeLog, "");
const ha = await start("hyperexperimental", { approvalPolicy: "untrusted" });
await say(ha.id, "hask");
const fileReq = await until("the file approval", () =>
  notes.find((n) => n.method === "item/fileChange/requestApproval" && n.params?.threadId === ha.id),
);
check(
  !existsSync(path.join(work, "notes.txt")) && !fake().some((l) => l.exec && isWrite(l.exec)),
  "the write waits for the user",
);
const pendingTurn = (
  (await call("thread/turns/list", { threadId: ha.id, sortDirection: "desc" })).result as {
    data: Turn[];
  }
).data[0];
check(
  pendingTurn.items.some(
    (i) =>
      i.id === fileReq.params?.itemId &&
      i.type === "fileChange" &&
      i.changes?.[0].diff.includes("+hello"),
  ),
  "the request points at the file row with its diff",
);
ws.send(JSON.stringify({ id: fileReq.id, result: { decision: "accept" } }));
const cmdReq = await until("the command approval", () =>
  notes.find(
    (n) => n.method === "item/commandExecution/requestApproval" && n.params?.threadId === ha.id,
  ),
);
check(
  cmdReq.params?.command === "echo hi" &&
    cmdReq.params.cwd === work &&
    readFileSync(path.join(work, "notes.txt"), "utf8") === "hello\n",
  "approved: written; then the command asks, with its text and folder",
);
ws.send(JSON.stringify({ id: cmdReq.id, result: { decision: "decline" } }));
turn = await turnDone(ha.id);
check(
  turn.status === "completed" &&
    turn.items.some((i) => i.type === "commandExecution" && i.status === "declined"),
  "denied: the command row is declined, the turn goes on",
);
check(!fake().some((l) => l.exec && isRun(l.exec)), "and it never ran");
check(
  seen.some(
    (s) => s.role === "summarize" && s.input.includes("[the user declined to run this command]"),
  ),
  "the model is told it was declined",
);
const hr = await start("hyperexperimental", { sandbox: "read-only" });
writeFileSync(fakeLog, "");
await say(hr.id, "hro");
turn = await turnDone(hr.id);
const roExecs = fake()
  .filter((l) => l.exec)
  .map((l) => l.exec!);
check(
  roExecs.length > 0 && roExecs.every((e) => e.sandboxPolicy.type === "readOnly"),
  "a read-only thread: every command, the write included, goes out under the read-only policy",
);
check(
  turn.items.some((i) => i.type === "fileChange" && i.status === "failed"),
  "the write fails in the sandbox and shows as failed",
);
const fa = await start("hyperexperimental", {
  sandbox: "danger-full-access",
  approvalPolicy: "never",
});
writeFileSync(fakeLog, "");
await say(fa.id, "hask");
turn = await turnDone(fa.id);
const faExecs = fake()
  .filter((l) => l.exec)
  .map((l) => l.exec!);
check(
  turn.status === "completed" &&
    faExecs
      .filter((e) => isWrite(e) || isRun(e))
      .every((e) => e.sandboxPolicy.type === "dangerFullAccess") &&
    faExecs
      .filter((e) => !isWrite(e) && !isRun(e))
      .every((e) => e.sandboxPolicy.type === "readOnly"),
  "full access: writes and RUN unrestricted without asking, reads still read-only",
);
const sw = await start("hyperexperimental", { sandbox: "read-only" });
writeFileSync(fakeLog, "");
await say(sw.id, "hask", {
  sandboxPolicy: { type: "workspaceWrite" },
  approvalPolicy: "on-request",
});
turn = await turnDone(sw.id);
check(
  fake().some((l) => l.exec && isWrite(l.exec) && l.exec.sandboxPolicy.type === "workspaceWrite"),
  "the composer's preset at turn/start replaces the thread's",
);

log("hyperexperimental: a router error");
const h5 = await start("hyperexperimental");
await say(h5.id, "h503");
turn = await turnDone(h5.id);
check(
  turn.status === "failed" &&
    /^No free model could take this right now/.test(turn.error?.message ?? ""),
  "a 503 mid-step ends the turn with the plain message",
);

// ---- restart ----------------------------------------------------------------------------------------
log("read back");
const cut = await start("experimental");
await say(cut.id, "slow job");
await until("the worker's command", () =>
  notes.some(
    (n) =>
      n.method === "item/started" &&
      n.params?.threadId === cut.id &&
      (n.params.item as TurnItem).type === "commandExecution",
  ),
);
// (the thread file is written at task boundaries: write it now, as a crash would find it mid-task)
const old = backend;
old.save((old as unknown as { threads: Map<string, never> }).threads.get(cut.id)!);
backend = makeBackend(); // "the app restarted": a new backend reads the same folder
const list = (await backend.handle("thread/list", {})) as {
  data: { id: string; orchestrator: string; preview: string }[];
};
check(
  list.data.length >= 20 &&
    list.data.some((t) => t.id === ex.id && t.orchestrator === "experimental") &&
    list.data.some((t) => t.id === hy.id && t.orchestrator === "hyperexperimental"),
  `a new backend reads the threads back, each with its orchestrator (${list.data.length})`,
);
const back = (await backend.handle("thread/turns/list", {
  threadId: ex.id,
  sortDirection: "asc",
})) as { data: Turn[] };
check(
  back.data.length === 2 && back.data[0].items.length === 12 && back.data[0].status === "completed",
  "turns and items are readable",
);
const cutBack = (await backend.handle("thread/turns/list", {
  threadId: cut.id,
  sortDirection: "desc",
})) as { data: Turn[] };
check(
  cutBack.data[0].status === "interrupted" &&
    cutBack.data[0].items.every((i) => i.status !== "inProgress"),
  "a turn cut off mid-task reads back as interrupted, nothing left running",
);
const resumed = (await backend.handle("thread/resume", { threadId: hy.id })) as {
  model: string;
  orchestrator: string;
  sandbox: { type: string };
};
check(
  resumed.model === "pool/spark" &&
    resumed.orchestrator === "hyperexperimental" &&
    resumed.sandbox.type === "workspaceWrite",
  "thread/resume gives the model, orchestrator and sandbox",
);
old.stop();
await turnDone(cut.id, 8000);
// the restored thread carries on from its notes
seen.length = 0;
const ws3 = new WebSocket(`ws://127.0.0.1:${port}`);
const got: Msg[] = [];
ws3.on("message", (d) => got.push(JSON.parse(String(d)) as Msg));
await new Promise((r) => ws3.once("open", r));
ws3.send(
  JSON.stringify({
    id: 1,
    method: "turn/start",
    params: { threadId: ex.id, input: text("one more follow-up") },
  }),
);
await until("the restored thread's turn", () =>
  got.some((m) => m.method === "turn/completed" && (m.params?.turn as Turn).status === "completed"),
);
check(
  seen[0]?.role === "planner" &&
    /GOAL: multi: make a tiny module/.test(seen[0].input) &&
    /LATER REQUEST: now a follow-up/.test(seen[0].input),
  "after the restart a new message is planned from the stored notes",
);
const arch = await backend.handle("thread/archive", { threadId: hello.id });
check(
  arch &&
    !((await backend.handle("thread/list", {})) as { data: { id: string }[] }).data.some(
      (t) => t.id === hello.id,
    ),
  "archive hides a thread",
);

const roles = new Map<string, number>();
for (const t of traces)
  if (t.type === "model") roles.set(t.role, Math.max(roles.get(t.role) ?? 0, t.promptChars));
log(
  `largest prompt per role in this run (characters): ${[...roles].map(([r, n]) => `${r} ${n}`).join(", ")}`,
);

ws.close();
ws3.close();
wss.close();
router.close();
appServer.stop();
log("all good");
process.exit(0);
