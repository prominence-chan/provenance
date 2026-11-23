#!/usr/bin/env node
// A stand-in for `provenance app-server` as the orchestrators use it (scripts/orchestrator-check.ts):
// worker threads (thread/start, turn/start, turn/interrupt, thread/unsubscribe) whose turns are
// scripted by words in the brief, and command/exec, which really runs the command (no sandbox
// here: it refuses the write helper under a read-only policy the way the real sandbox would, and
// logs the policy it was given so the check can see what was asked for).
//
// Words in a worker's task:
//   BLOCKME    reports STATUS: BLOCKED          SLOWTASK   runs until interrupted
//   ASKME      asks approval for its command    NOCAP      the turn fails: no model available
//   LOOPCALLS  keeps making "model requests"    IDLETASK   says nothing until interrupted
//   (anything else: a command, an edit, STATUS: DONE)
// Appends what it was asked to $FAKE_ORC_LOG as JSON lines.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

if (process.argv[2] !== "app-server") process.exit(2);
const log = (o) =>
  process.env.FAKE_ORC_LOG && appendFileSync(process.env.FAKE_ORC_LOG, JSON.stringify(o) + "\n");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const note = (method, params) => send({ method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const threads = new Map(); // id -> { cwd, interrupted, turnId, params }
const procs = new Map(); // processId -> child
const waits = new Map(); // server request id -> resolve
let reqSeq = 1;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = `srv-${reqSeq++}`;
    waits.set(id, resolve);
    send({ id, method, params });
  });

const usage = (threadId, turnId, input) =>
  note("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: {
      total: {
        totalTokens: input + 50,
        inputTokens: input,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 50,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: input + 50,
        inputTokens: input,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 50,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 16000,
    },
  });

const cmdItem = (id, command, cwd, status, output = null, exitCode = null) => ({
  id,
  type: "commandExecution",
  command: `/bin/zsh -lc '${command}'`,
  cwd,
  processId: null,
  pluginId: null,
  scriptPath: null,
  source: "agent",
  status,
  commandActions: [],
  aggregatedOutput: output,
  exitCode,
  durationMs: status === "inProgress" ? null : 5,
});

async function workerTurn(threadId, turnId, brief) {
  const th = threads.get(threadId);
  const task = /YOUR TASK \(\d+ of \d+\):\s*(.*)/.exec(brief)?.[1] ?? brief.slice(0, 80);
  const item = (method, it) => note(method, { threadId, turnId, item: it });
  const finish = (status, error = null) => {
    th.turnId = null;
    note("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        rootTurnId: null,
        items: [],
        itemsView: "notLoaded",
        status,
        error: error
          ? { message: error, codexErrorInfo: null, additionalDetails: null, misalignment: null }
          : null,
        startedAt: 0,
        completedAt: 0,
        durationMs: 1,
      },
    });
  };
  const say = (text) =>
    item("item/completed", { id: randomUUID(), type: "agentMessage", text, phase: null });
  note("turn/started", {
    threadId,
    turn: { id: turnId, items: [], status: "inProgress", error: null },
  });
  item("item/completed", {
    id: randomUUID(),
    type: "userMessage",
    content: [{ type: "text", text: brief }],
  });
  await sleep(10);
  usage(threadId, turnId, 6000 + brief.length / 4);
  if (/NOCAP/.test(task)) {
    note("error", {
      threadId,
      turnId,
      willRetry: false,
      error: { message: "no model in spark (or below) could serve this: [pool: 429]" },
    });
    return finish("failed", "no model in spark (or below) could serve this: [pool: 429]");
  }
  if (/IDLETASK/.test(task)) {
    while (!th.interrupted) await sleep(20); // the model never answers
    return finish("interrupted");
  }
  if (/LOOPCALLS/.test(task)) {
    while (!th.interrupted) {
      usage(threadId, turnId, 7000);
      await sleep(15);
    }
    return finish("interrupted");
  }
  const cid = randomUUID();
  if (/SLOWTASK/.test(task)) {
    item("item/started", cmdItem(cid, "sleep 600", th.cwd, "inProgress"));
    while (!th.interrupted) await sleep(20);
    return finish("interrupted");
  }
  const command = `python3 check.py ${task.replace(/[^a-zA-Z0-9 ]/g, "").slice(0, 30)}`;
  item("item/started", cmdItem(cid, command, th.cwd, "inProgress"));
  if (/ASKME/.test(task)) {
    const answer = await ask("item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: cid,
      command,
      cwd: th.cwd,
      reason: "fake needs approval",
    });
    log({ approval: answer });
    if (answer?.decision !== "accept" && answer?.decision !== "acceptForSession") {
      item("item/completed", cmdItem(cid, command, th.cwd, "declined"));
      say(
        "RESULT: the command was not allowed\nCHANGES: none\nVALIDATION: none\nBLOCKERS: the user declined the command\nSTATUS: BLOCKED",
      );
      return finish("completed");
    }
  }
  note("item/commandExecution/outputDelta", { threadId, turnId, itemId: cid, delta: "out\n" });
  item("item/completed", cmdItem(cid, command, th.cwd, "completed", "out\n", 0));
  const fid = randomUUID();
  const file = {
    id: fid,
    type: "fileChange",
    changes: [{ path: `${th.cwd}/f-${task.length}.txt`, kind: { type: "add" }, diff: "+x" }],
    status: "completed",
  };
  item("item/started", { ...file, status: "inProgress" });
  item("item/completed", file);
  usage(threadId, turnId, 7500 + brief.length / 4);
  if (th.interrupted) return finish("interrupted");
  if (/BLOCKME/.test(task))
    say(
      `**RESULT:** could not do "${task}"\n**BLOCKERS:** the dependency frobnicate is missing\n**STATUS:** BLOCKED`,
    );
  else
    say(
      `Done.\n\nRESULT: finished "${task}"\nCHANGES: f-${task.length}.txt\nVALIDATION: ran ${command}, passed\nBLOCKERS: none\nSTATUS: DONE`,
    );
  finish("completed");
}

function exec(id, p) {
  log({
    exec: {
      command: p.command,
      cwd: p.cwd,
      sandboxPolicy: p.sandboxPolicy,
      timeoutMs: p.timeoutMs,
    },
  });
  const type = p.sandboxPolicy?.type;
  const script = p.command.join(" ");
  const writes =
    script.includes("base64 --decode") ||
    (p.command[1] === "-lc" && /(^|\s)(touch|rm|mkdir)\s|>/.test(p.command[2] ?? ""));
  if (type === "readOnly" && writes)
    return send({
      id,
      result: { exitCode: 1, stdout: "", stderr: "sh: Operation not permitted\n" },
    });
  const child = spawn(p.command[0], p.command.slice(1), {
    cwd: p.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (p.processId) procs.set(p.processId, child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), p.timeoutMs ?? 10_000);
  child.on("error", (e) => send({ id, result: { exitCode: 127, stdout, stderr: String(e) } }));
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    if (p.processId) procs.delete(p.processId);
    send({ id, result: { exitCode: signal ? 137 : (code ?? -1), stdout, stderr } });
  });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id !== undefined && !m.method) return void waits.get(m.id)?.(m.result);
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      return send({ id: m.id, result: { userAgent: "fake-orc-appserver" } });
    case "initialized":
      return;
    case "thread/start": {
      const id = randomUUID();
      threads.set(id, { cwd: p.cwd, interrupted: false, turnId: null });
      log({ threadStart: p });
      note("thread/started", { thread: { id } });
      return send({ id: m.id, result: { thread: { id }, model: p.model, cwd: p.cwd } });
    }
    case "turn/start": {
      const th = threads.get(p.threadId);
      if (!th) return send({ id: m.id, error: { code: -32000, message: "no such thread" } });
      const turnId = randomUUID();
      th.turnId = turnId;
      th.interrupted = false;
      const brief = p.input?.[0]?.text ?? "";
      log({ turnStart: { threadId: p.threadId, brief } });
      send({ id: m.id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
      return void workerTurn(p.threadId, turnId, brief);
    }
    case "turn/interrupt": {
      const th = threads.get(p.threadId);
      if (th) th.interrupted = true;
      log({ interrupt: p.threadId });
      return send({ id: m.id, result: {} });
    }
    case "thread/unsubscribe":
      threads.delete(p.threadId);
      log({ unsubscribe: p.threadId });
      return send({ id: m.id, result: { status: "unsubscribed" } });
    case "command/exec":
      return exec(m.id, p);
    case "command/exec/terminate":
      procs.get(p.processId)?.kill("SIGKILL");
      log({ terminate: p.processId });
      return send({ id: m.id, result: {} });
    default:
      return send({ id: m.id, error: { code: -32601, message: `fake: no ${m.method}` } });
  }
});
