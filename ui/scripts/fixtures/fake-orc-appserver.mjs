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
//   FLAKY      the turn fails (no model) while the number in $FAKE_ORC_LOG.flaky is above 0
//              (each failure takes one off)     QUIETTASK  silent for 1.3 s, then finishes
//   NOTOOLS    runs nothing and reports that the terminal is unavailable, unless its brief
//              records that an earlier worker ran nothing (NOTOOLS ALWAYS: even then)
//   MAKES <name>  also writes that file in the folder (in the request or the task)
//   PARTLY     reports STATUS: PARTIAL (its commands passed; the rest is the job's remainder)
//   NEARMISS <name>  (in the task) also writes that file: a planner's respelling of the name asked for
//   the finish check's fix task reports BLOCKED when the request says UNSETTLED; otherwise it
//              writes <word>.txt for "FIXES <word>" in the request (the first worker does not)
//   GROWS      its requests grow past the context budget (12,000 input tokens) after its command
//              and edit, until it is interrupted; asked to wrap up it reports PARTIAL with what is
//              LEFT TO DO. A worker whose brief carries that hand-over finishes (GROWS <n>: the
//              first n workers grow; GROWS DRY: always grows, before it has run or changed anything;
//              GROWS DELTA: simulates stateful web-chat delta usage [3300, 2615, 2170, 2615, ...]
//              with structured, terse, and empty wrap-ups across 3 hand-overs)
//   LOOKSONLY  runs its command, changes no file, and reports BLOCKED
//   UNCHECKED  its report names something under NOT CHECKED
//   ENVBLOCK   reports PARTIAL: a tool is missing (its command passed, its file is written)
//   ASKME      once its brief records a refused approval, it does without (ASKME ALWAYS: asks again)
//   (anything else: a command, an edit, STATUS: DONE)
// command/exec honours `env` (laid over this process's environment), like the real one.
// Appends what it was asked to $FAKE_ORC_LOG as JSON lines.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

const usage = (threadId, turnId, input, output = 50) =>
  note("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: {
      total: {
        totalTokens: input + output,
        inputTokens: input,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: output,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: input + output,
        inputTokens: input,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: output,
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
  // (the task line and what stands under it: a job that was not split carries the planner's
  // suggestion there)
  const shown = (
    /YOUR TASK \(\d+ of \d+\):\s*([\s\S]*?)\nDONE WHEN:/.exec(brief)?.[1] ?? brief.slice(0, 80)
  ).replace(/\s+/g, " ");
  // (of a job that was not split, the first thing the planner suggested scripts the worker)
  const task = /the request decides\): 1\. (.*?)(?: 2\. |$)/.exec(shown)?.[1] ?? shown;
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
  if (/^Stop here: this thread's context is nearly full/.test(brief)) {
    // the hand-over a worker is asked for when its context is full
    if (th.deltaMode) {
      usage(threadId, turnId, 280, 120);
      if (th.deltaStage === 0) {
        say(
          [
            "RESULT: diagnosed all 32 failures across 3 modules; cacheutils is clean",
            "CHANGES: boltons/cacheutils.py (fixed LRU eviction)",
            "VALIDATION: .venv/bin/pytest -q -> 21 failed, 340 passed",
            "FAILURES:",
            "- boltons/dictutils.py:142 OMD.popall drops last key (test_omd_popall)",
            "- boltons/iterutils.py:88 windowed skips final short chunk (test_windowed)",
            "TRIED: checked setutils first — already passing; naive slice in windowed broke fill=None",
            "NEXT: edit boltons/dictutils.py:142 OMD.popall and run .venv/bin/pytest tests/test_dictutils.py",
            "NOT CHECKED: full suite after dictutils/iterutils fixes",
            "BLOCKERS: LEFT TO DO: finish dictutils and iterutils",
            "STATUS: PARTIAL",
          ].join("\n"),
        );
      } else if (th.deltaStage === 1) {
        // Simulates a terse successor that only reports count/status and omits FAILURES/TRIED/NEXT.
        say(
          "RESULT: fixed dictutils; failing tests reduced from 21 to 10\nCHANGES: boltons/dictutils.py\nVALIDATION: .venv/bin/pytest -q -> 10 failed\nBLOCKERS: LEFT TO DO: fix remaining 10 tests\nSTATUS: PARTIAL",
        );
      } else {
        // Simulates a worker whose wrap-up produces no text at all.
      }
      return finish("completed");
    }
    usage(threadId, turnId, 12500);
    say(
      "RESULT: the first half is written and its check passed\nCHANGES: f-half.txt\nVALIDATION: ran python3 check.py, passed\nNOT CHECKED: the second half\nBLOCKERS: LEFT TO DO: write the second half; the format is one row per line, id first\nSTATUS: PARTIAL",
    );
    return finish("completed");
  }
  if (/GROWS DELTA/.test(task)) {
    const stage = Number(/\(hand-over (\d+)\)/.exec(brief)?.[1] ?? 0);
    th.deltaMode = true;
    th.deltaStage = stage;
    usage(threadId, turnId, 3300, 200);
    if (stage < 3) {
      const cid = randomUUID();
      const pytestCmd = ".venv/bin/pytest -q";
      const pytestOut =
        stage === 0
          ? "collected 361 items\nFAILED tests/test_dictutils.py::test_omd_popall - AssertionError: missing key\nFAILED tests/test_iterutils.py::test_windowed - ValueError: bad chunk\n21 failed, 340 passed in 1.2s\n"
          : "collected 361 items\nFAILED tests/test_iterutils.py::test_windowed - ValueError: bad chunk\n10 failed, 351 passed in 1.1s\n";
      item("item/started", cmdItem(cid, pytestCmd, th.cwd, "inProgress"));
      item("item/completed", cmdItem(cid, pytestCmd, th.cwd, "failed", pytestOut, 1));
      const fid = randomUUID();
      const fname = stage === 0 ? "cacheutils.py" : stage === 1 ? "dictutils.py" : "iterutils.py";
      const file = {
        id: fid,
        type: "fileChange",
        changes: [{ path: `${th.cwd}/${fname}`, kind: { type: "update" }, diff: "+fix" }],
        status: "completed",
      };
      item("item/started", { ...file, status: "inProgress" });
      item("item/completed", file);
      // Emit chatgpt-web-like delta token counts (< 3300 each): cumulative context crosses 11k on delta #3.
      for (const delta of [2615, 2170, 2615, 2615, 2615, 14500]) {
        if (th.interrupted) break;
        usage(threadId, turnId, delta, 200);
        await sleep(15);
      }
      return finish("interrupted");
    }
    const cid = randomUUID();
    item("item/started", cmdItem(cid, ".venv/bin/pytest -q", th.cwd, "inProgress"));
    item(
      "item/completed",
      cmdItem(cid, ".venv/bin/pytest -q", th.cwd, "completed", "361 passed\n", 0),
    );
    say(
      "RESULT: all 361 tests pass\nCHANGES: iterutils.py\nVALIDATION: .venv/bin/pytest -q passed\nBLOCKERS: none\nSTATUS: DONE",
    );
    return finish("completed");
  }
  usage(threadId, turnId, 6000 + brief.length / 4);
  if (/NOTOOLS/.test(task) && (/ALWAYS/.test(task) || !/ran no command/.test(brief))) {
    say("BLOCKERS: Local terminal execution unavailable.\nSTATUS: BLOCKED");
    return finish("completed");
  }
  if (/NOCAP/.test(task)) {
    note("error", {
      threadId,
      turnId,
      willRetry: false,
      error: { message: "no model in spark (or below) could serve this: [pool: 429]" },
    });
    return finish("failed", "no model in spark (or below) could serve this: [pool: 429]");
  }
  if (/FLAKY/.test(task)) {
    const file = `${process.env.FAKE_ORC_LOG}.flaky`;
    const left = existsSync(file) ? Number(readFileSync(file, "utf8")) || 0 : 0;
    if (left > 0) {
      writeFileSync(file, String(left - 1));
      const message = /STREAM/.test(task)
        ? "stream disconnected before completion: error sending request"
        : "no model in spark (or below) could serve this: [pool: 429]";
      note("error", { threadId, turnId, willRetry: false, error: { message } });
      return finish("failed", message);
    }
  }
  if (/QUIETTASK/.test(task)) {
    await sleep(1300); // a slow model, not a silent one
    say(`RESULT: finished "${task}"\nSTATUS: DONE`);
    return finish("completed");
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
  if (/GROWS DRY/.test(task)) {
    for (let n = 9000; !th.interrupted; n += 3000) {
      usage(threadId, turnId, n);
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
  // ASKME asks approval for its command; once its brief records a refusal it does without
  // (ASKME ALWAYS asks again).
  if (/ASKME/.test(task) && (/ASKME ALWAYS/.test(task) || !/was refused/.test(brief))) {
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
  if (/FAILLAST/.test(task)) {
    // says done over a command that failed
    item(
      "item/completed",
      cmdItem(cid, command, th.cwd, "failed", "ImportError: no module named frob\n", 1),
    );
    say("RESULT: all good\nSTATUS: DONE");
    return finish("completed");
  }
  note("item/commandExecution/outputDelta", { threadId, turnId, itemId: cid, delta: "out\n" });
  item("item/completed", cmdItem(cid, command, th.cwd, "completed", "out\n", 0));
  if (/LOOKSONLY/.test(task)) {
    usage(threadId, turnId, 7500 + brief.length / 4);
    say(
      "RESULT: looked again; nothing new\nCHANGES: none\nVALIDATION: none\nBLOCKERS: there is still nothing to run it with\nSTATUS: BLOCKED",
    );
    return finish("completed");
  }
  const fid = randomUUID();
  const file = {
    id: fid,
    type: "fileChange",
    changes: [{ path: `${th.cwd}/f-${task.length}.txt`, kind: { type: "add" }, diff: "+x" }],
    status: "completed",
  };
  item("item/started", { ...file, status: "inProgress" });
  item("item/completed", file);
  const makes = /MAKES ([\w.-]+)/.exec(`${task} ${brief}`)?.[1];
  if (makes) writeFileSync(`${th.cwd}/${makes}`, "[]\n");
  const fixes = /FIXES (\w+)/.exec(brief)?.[1];
  if (fixes && /Fix what the finish check found/.test(task) && !/UNSETTLED/.test(brief))
    writeFileSync(`${th.cwd}/${fixes}.txt`, "fixed\n");
  if (
    /GROWS/.test(task) &&
    !/GROWS DRY/.test(task) &&
    Number(/\(hand-over (\d+)\)/.exec(brief)?.[1] ?? 0) < Number(/GROWS (\d+)/.exec(task)?.[1] ?? 1)
  ) {
    // a long job in one thread: each request larger than the last, until someone stops it
    for (let n = 9000; !th.interrupted; n += 3000) {
      usage(threadId, turnId, n);
      await sleep(15);
    }
    return finish("interrupted");
  }
  const near = /NEARMISS ([\w.-]+)/.exec(task)?.[1];
  if (near) writeFileSync(`${th.cwd}/${near}`, "a near miss\n");
  usage(threadId, turnId, 7500 + brief.length / 4);
  if (th.interrupted) return finish("interrupted");
  if (/Fix what the finish check found/.test(task) && /UNSETTLED/.test(brief))
    say(
      "RESULT: the checks could not be run\nCHANGES: none\nVALIDATION: none\nNOT CHECKED: every open point\nBLOCKERS: wc is missing\nSTATUS: BLOCKED",
    );
  else if (/ENVBLOCK/.test(task))
    say(
      `RESULT: wrote the query; it could not be executed here\nCHANGES: f-${task.length}.txt\nVALIDATION: ran ${command}, passed\nNOT CHECKED: running the query: no SPARQL engine is installed, and pip install failed (no network)\nBLOCKERS: cannot execute: arq missing\nSTATUS: PARTIAL`,
    );
  else if (/UNCHECKED/.test(task))
    say(
      `RESULT: finished "${task}"\nCHANGES: f-${task.length}.txt\nVALIDATION: ran ${command}, passed\nNOT CHECKED: a real keyboard interrupt (a cancelled task was tested instead)\nBLOCKERS: none\nSTATUS: DONE`,
    );
  else if (/PARTLY/.test(task))
    say(
      `RESULT: looked at it; "${task}" is as far as it goes\nCHANGES: none\nVALIDATION: ran ${command}, passed\nBLOCKERS: None for the inspection; the script itself is not written yet.\nSTATUS: PARTIAL`,
    );
  else if (/BLOCKME/.test(task))
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
      env: p.env ? { PATH: p.env.PATH ?? null, TERM: p.env.TERM ?? null } : null,
    },
  });
  const type = p.sandboxPolicy?.type;
  const script = p.command.join(" ");
  const writes =
    script.includes("base64 --decode") ||
    (p.command.length === 3 &&
      !p.command[2].includes("__ORC_ENV_BEGIN__") &&
      /(^|\s)(touch|rm|mkdir)\s|>/.test(p.command[2] ?? ""));
  if (type === "readOnly" && writes)
    return send({
      id,
      result: { exitCode: 1, stdout: "", stderr: "sh: Operation not permitted\n" },
    });
  const child = spawn(p.command[0], p.command.slice(1), {
    cwd: p.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: p.env ? { ...process.env, ...p.env } : process.env,
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
      log({ threadStart: p, threadId: id });
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
      log({
        turnStart: {
          threadId: p.threadId,
          brief,
          approvalPolicy: p.approvalPolicy,
          sandboxPolicy: p.sandboxPolicy,
        },
      });
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
