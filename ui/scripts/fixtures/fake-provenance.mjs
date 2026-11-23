#!/usr/bin/env node
// A stand-in for the provenance binary (scripts/welcome-e2e.ts): `login status` and
// `debug models` for the "through Provenance" health check, and `app-server`, a tiny JSON-RPC
// app-server on stdio with two canned tier threads (one whose history has clearly outgrown
// the free models, one calm) and turns that answer at once. Run with `-c model_provider="openai"`
// it plays the "through Provenance" app-server (provider openai, no canned threads). Appends
// {argv, home, turns} to $FAKE_CLI_LOG.
import { appendFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";

const argv = process.argv.slice(2);
const home = process.env.PROVENANCE_HOME ?? "";
const logRun = (o) =>
  process.env.FAKE_CLI_LOG &&
  appendFileSync(
    process.env.FAKE_CLI_LOG,
    JSON.stringify({ cli: "provenance", argv, home, ...o }) + "\n",
  );
if (argv[0] === "login" && argv[1] === "status") {
  if (existsSync(path.join(home, "auth.json"))) {
    console.log("Logged in using ChatGPT");
    process.exit(0);
  }
  console.log("Not logged in");
  process.exit(1);
}
if (argv[0] === "debug" && argv[1] === "models") {
  console.log(
    JSON.stringify({
      models: [
        {
          slug: "gpt-fake-sol",
          display_name: "GPT-Fake-Sol",
          visibility: "list",
          priority: 1,
          default_reasoning_level: "low",
          supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map(
            (effort) => ({ effort, description: effort }),
          ),
        },
        {
          slug: "gpt-fake-luna",
          display_name: "GPT-Fake-Luna",
          visibility: "list",
          priority: 2,
          default_reasoning_level: "medium",
          supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({
            effort,
            description: effort,
          })),
        },
      ],
    }),
  );
  process.exit(0);
}
if (argv[0] !== "app-server") process.exit(2);

const openai = argv.join(" ").includes("model_provider");
const provider = openai ? "openai" : "tierlm";
const cwd = process.env.FAKE_WORK ?? process.cwd();
const now = Math.floor(Date.now() / 1000);
const thread = (id, preview, model, updatedAt) => ({
  id,
  sessionId: id,
  forkedFromId: null,
  attachedToThreadId: null,
  parentThreadId: null,
  preview,
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "legacy",
  environments: null,
  extra: null,
  modelProvider: provider,
  model,
  reasoningEffort: null,
  createdAt: updatedAt,
  updatedAt,
  recencyAt: null,
  status: { type: "idle" },
  path: null,
  cwd,
  cliVersion: "0.0.0",
  originator: "fake",
  source: "appServer",
  canAcceptDirectInput: null,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  daybreakEnabled: null,
  daybreakProgramPropagationEnrolled: null,
  turns: [],
});
const user = (id, text) => ({
  id,
  type: "userMessage",
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
});
const agent = (id, text) => ({
  id,
  type: "agentMessage",
  text,
  phase: null,
  moderation: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
  completedAtMs: Date.now(),
});
const cmd = (id, command, out, code) => ({
  id,
  type: "commandExecution",
  command,
  cwd,
  processId: null,
  pluginId: null,
  scriptPath: null,
  source: "agent",
  status: "completed",
  commandActions: [],
  aggregatedOutput: out,
  exitCode: code,
  durationMs: 1200,
});
const edit = (id, p) => ({
  id,
  type: "fileChange",
  changes: [{ path: p, kind: { type: "update", move_path: null }, diff: "@@\n-a\n+b" }],
  status: "completed",
});
const turn = (id, items, t) => ({
  id,
  rootTurnId: null,
  items,
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt: t,
  completedAt: t + 60,
  durationMs: 60000,
});

const threads = new Map();
const turns = new Map();
if (!openai) {
  threads.set(
    "thr-strained",
    thread("thr-strained", "Refactor the parser into modules", "solstice", now - 60),
  );
  turns.set("thr-strained", [
    turn(
      "turn-s1",
      [
        user("u1", "Refactor the parser into modules"),
        edit("e1", "src/parser.ts"),
        cmd("c1", "npm test", "1 failing", 1),
        cmd("c2", "npm test", "1 failing", 1),
        cmd("c3", "npm test", "1 failing", 1),
        agent("a1", "The tests still fail on the tokenizer."),
      ],
      now - 600,
    ),
    turn(
      "turn-s2",
      [
        user("u2", "Keep going"),
        { id: "k1", type: "contextCompaction" },
        cmd("c4", "npm run build", "ok", 0),
        { id: "k2", type: "contextCompaction" },
        agent("a2", "Split lexer.ts out; the tokenizer test is next."),
      ],
      now - 300,
    ),
    turn(
      "turn-s3",
      [user("u3", "Fix the tokenizer test"), agent("a3", "Looking at the tokenizer again.")],
      now - 120,
    ),
  ]);
  threads.set("thr-calm", thread("thr-calm", "Add a README section", "solstice", now - 3600));
  turns.set("thr-calm", [
    turn("turn-c1", [user("u9", "Add a README section"), agent("a9", "Added it.")], now - 3600),
  ]);
}

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const reply = (id, result) => out({ id, result });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined || !m.method) return;
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      return reply(m.id, { userAgent: `fake-provenance/${provider}` });
    case "thread/list":
      return reply(m.id, {
        data: [...threads.values()],
        nextCursor: null,
        backwardsCursor: null,
        readStates: null,
      });
    case "thread/resume": {
      const t = threads.get(p.threadId);
      if (!t) return out({ id: m.id, error: { code: -32000, message: "no such thread" } });
      return reply(m.id, { thread: t, model: t.model, modelProvider: provider, cwd: t.cwd });
    }
    case "thread/turns/list":
      return reply(m.id, {
        data: (turns.get(p.threadId) ?? []).slice().reverse(),
        nextCursor: null,
        backwardsCursor: null,
      });
    case "thread/start": {
      const id = randomUUID();
      const model = p.model ?? (openai ? "gpt-fake-sol" : "solstice");
      const t = thread(id, "", model, Math.floor(Date.now() / 1000));
      threads.set(id, t);
      turns.set(id, []);
      out({ method: "thread/started", params: { thread: t } });
      return reply(m.id, { thread: t, model, modelProvider: provider, cwd: p.cwd ?? cwd });
    }
    case "turn/start": {
      const t = threads.get(p.threadId);
      const text = (p.input ?? []).map((x) => x.text ?? "").join("\n");
      logRun({
        method: "turn/start",
        model: p.model ?? null,
        text: text.slice(0, 200),
        hasEffort: "effort" in p,
        effort: p.effort ?? null,
      });
      if (t && !t.preview) t.preview = text.slice(0, 200);
      const tid = randomUUID();
      const tr = turn(tid, [], Math.floor(Date.now() / 1000));
      tr.status = "inProgress";
      reply(m.id, { turn: tr });
      out({ method: "turn/started", params: { threadId: p.threadId, turn: tr } });
      const u = user(`${tid}-u`, text);
      out({ method: "item/completed", params: { threadId: p.threadId, turnId: tid, item: u } });
      const a = agent(`${tid}-a`, `ok from ${provider} on ${p.model ?? t?.model}`);
      setTimeout(() => {
        out({ method: "item/completed", params: { threadId: p.threadId, turnId: tid, item: a } });
        const done = {
          ...tr,
          status: "completed",
          items: [u, a],
          completedAt: tr.startedAt + 1,
          durationMs: 800,
        };
        turns.get(p.threadId)?.push(done);
        out({ method: "turn/completed", params: { threadId: p.threadId, turn: done } });
      }, 300);
      return;
    }
    case "turn/interrupt":
      return reply(m.id, {});
    case "thread/name/set": {
      const t = threads.get(p.threadId);
      if (t) t.name = p.name;
      out({ method: "thread/name/updated", params: { threadId: p.threadId, threadName: p.name } });
      return reply(m.id, {});
    }
    case "thread/archive":
      threads.delete(p.threadId);
      return reply(m.id, {});
    default:
      return out({ id: m.id, error: { code: -32601, message: `fake: ${m.method}` } });
  }
});
