// Experimental: a planner and fresh workers.
//
//   1. plan    one plain call (a new chat, no tools): the request, a one-line listing of the
//              folder and the session notes -> a short ordered list of mini tasks, each with what
//              "done" means. Parsed leniently from plain text (parse.ts). "ANSWER: …" instead of
//              a list means the request needs no work, and is the reply.
//   2. work    each task runs as a worker: a fresh, hidden (ephemeral) thread on the
//              orchestrators' app-server, i.e. the stock harness with its tools, the thread's
//              sandbox and approval preset, on the thread's tier. It gets a brief (prompts.ts):
//              goal, this task, its done-criteria, the bounded notes. Its commands, file changes
//              and approval requests appear in the visible thread as they happen; its last
//              message is its report (RESULT / CHANGES / VALIDATION / BLOCKERS / STATUS).
//   3. fold    after each worker the notes take what was recorded (files changed, commands and
//              how they exited) and one line of what was reported. A worker that reports BLOCKED
//              or PARTIAL (or whose turn failed) sends the remaining list back to the planner for
//              one revision.
//   4. answer  a short reply written from the notes (one plain call), or, for a job that was a
//              single task, that worker's own report.
//
// Between turns only the notes are kept: a follow-up message is planned from them, not from the
// history. Workers run one at a time; runWorker holds no state outside its arguments, so tasks
// the planner marked independent could be run side by side later.
//
// Guards (backend.ts Caps): worker runs per turn, tries per task, plan revisions, model calls per
// turn (workers' requests counted as app-server reports them), time per worker. A guard that
// stops the work ends the turn with a plain message and the notes.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Item } from "../fallback/items.ts";
import type { ServerMessage } from "./appserver.ts";
import { folderBrief, Interrupted, StopTurn, errText, type Run } from "./backend.ts";
import {
  addCommand,
  addDone,
  addFile,
  addProblem,
  addRequest,
  clip,
  clipMiddle,
  notesText,
  reportSections,
} from "./notes.ts";
import { parsePlan, parseReport, type MiniTask } from "./parse.ts";
import { finalPrompt, plannerPrompt, revisePrompt, WORKER_BASE, workerBrief } from "./prompts.ts";
import { routerProblem } from "./router.ts";

type Json = Record<string, unknown>;

/** Worker items mirrored into the visible thread (its messages and thinking stay with it). */
const SHOWN = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
]);

const CAPACITY_RE =
  /no model in|no[_ ]capacity|none available|could serve this|\b503\b|rate limit|\b429\b/i;

export interface WorkerResult {
  status: "completed" | "failed" | "interrupted";
  /** The worker's last message. */
  report: string;
  error: string | null;
  commands: { cmd: string; ok: boolean }[];
  files: { path: string; kind: string }[];
  calls: number;
  maxInputTokens: number;
  /** The last command, when it failed (what a worker that reports nothing was stuck on). */
  lastFailure: { cmd: string; output: string } | null;
}

const LOOKING_RE =
  /^\s*(?:ls|cat|find|sed -n|head|tail|pwd|rg|grep|wc|echo|printf|mkdir|touch|cd|tree|which|file|stat)\b/;

export async function runExperimental(run: Run): Promise<void> {
  const notes = run.thread.notes;
  const caps = run.caps;
  const request = run.text;
  // The plan is made from the notes as they were, then the request joins them.
  const before = notesText(notes);
  const planText = await run.model("planner", plannerPrompt(request, folderBrief(run.cwd), before));
  addRequest(notes, request);
  const goal = notes.requests[0];
  run.save();
  let plan = parsePlan(planText);
  if (!plan.tasks.length) {
    if (plan.answer) {
      run.say(plan.answer);
      return;
    }
    // Nothing readable came back: the request itself is the one task.
    plan = { answer: null, tasks: [{ title: clip(request, 500), done: "" }] };
  }

  let queue = plan.tasks.slice();
  const finished: MiniTask[] = [];
  const attempts = new Map<string, number>();
  let ran = 0;
  let replans = 0;
  let lastReport = "";
  let gaveUp: string | null = null;
  const showPlan = (current: MiniTask | null) =>
    run.plan([
      ...finished.map((t) => ({ step: t.title, status: "completed" as const })),
      ...(current ? [{ step: current.title, status: "inProgress" as const }] : []),
      ...queue.map((t) => ({ step: t.title, status: "pending" as const })),
    ]);
  if (queue.length > 1)
    run.say(
      `Plan, ${queue.length} tasks:\n\n${queue.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}`,
    );

  while (queue.length) {
    run.check();
    const task = queue.shift()!;
    const left = () => [task, ...queue].map((t) => `"${clip(t.title, 80)}"`).join(", ");
    if (ran >= caps.tasks)
      throw new StopTurn(
        "cap",
        `Stopped after ${ran} tasks, the limit for one message. Not done: ${left()}. Send another message to go on.`,
      );
    const key = task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const tries = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, tries);
    if (tries > caps.attempts)
      throw new StopTurn(
        "cap",
        `Stopped: the task "${clip(task.title, 120)}" came up ${tries} times without finishing.`,
      );
    ran++;
    showPlan(task);
    const total = finished.length + 1 + queue.length;
    if (total > 1) run.say(`**Task ${finished.length + 1} of ${total}:** ${task.title}`);
    const brief = workerBrief({
      goal,
      task,
      index: finished.length + 1,
      total,
      later: queue,
      // (the goal has its own line in the brief)
      notes: notesText(notes).replace(/^GOAL: .*\n?/, ""),
      cwd: run.cwd,
    });
    const snap = snapshot(run.cwd);
    const res = await runWorker(run, brief, ran);
    // Files a command wrote (a heredoc, a generator) never show as file changes: compare the folder.
    for (const f of changedSince(run.cwd, snap))
      if (!res.files.some((x) => x.path === f.path)) res.files.push(f);
    run.backend.trace({
      type: "worker",
      task: task.title,
      brief,
      calls: res.calls,
      maxInputTokens: res.maxInputTokens,
      status: res.status,
    });
    // Recorded facts first: they hold whatever the report says.
    for (const c of res.commands) addCommand(notes, c.cmd, c.ok);
    for (const f of res.files) addFile(notes, f.path, f.kind);
    run.check();
    if (res.status === "failed" && res.error && CAPACITY_RE.test(res.error)) {
      addProblem(notes, `${clip(task.title, 80)}: no model was available`);
      run.save();
      throw new StopTurn("router", routerProblem(503, res.error));
    }
    const rep = parseReport(res.report);
    const sec = reportSections(res.report);
    lastReport = res.report;
    if (res.status === "completed" && rep.status === "done") {
      addDone(notes, task.title, sec.result || "done");
      finished.push(task);
      run.save();
      continue;
    }
    // A blocker or a surprise: note it, and let the planner revise what remains.
    const why =
      res.status === "failed"
        ? `the worker stopped: ${res.error ?? "no reason given"}`
        : sec.blockers ||
          sec.result ||
          `it ended without a report${res.lastFailure ? `; its last command failed: ${clip(res.lastFailure.cmd, 100)}` : ""}`;
    // With no report to go on, the planner gets what the failed command printed.
    const evidence =
      res.report ||
      res.error ||
      (res.lastFailure
        ? `(no report) The last command, ${clip(res.lastFailure.cmd, 160)}, failed with:\n${res.lastFailure.output}`
        : "");
    addProblem(notes, `${clip(task.title, 80)}: ${why}`);
    if (rep.status === "partial" && sec.result)
      addDone(notes, `${task.title} (partly)`, sec.result);
    run.save();
    if (replans >= caps.replans)
      throw new StopTurn(
        "cap",
        `Stopped: the plan was revised ${replans} times and "${clip(task.title, 120)}" still didn't finish.`,
      );
    replans++;
    const revised = parsePlan(
      await run.model("revise", revisePrompt(request, notesText(notes), task, evidence, queue)),
      5,
    );
    if (!revised.tasks.length) {
      gaveUp = revised.answer ?? `The work stopped at "${clip(task.title, 120)}": ${why}`;
      queue = [];
      break;
    }
    queue = revised.tasks;
    run.say(
      `That hit a problem (${clip(why, 200)}). Revised plan:\n\n${queue.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}`,
    );
  }
  showPlan(null);

  if (gaveUp) {
    run.say(gaveUp);
    return;
  }
  // One task, done: its report is the answer (no call needed to rephrase it).
  if (ran === 1 && finished.length === 1 && lastReport.trim()) {
    run.say(lastReport.replace(/^\W*status\W+\w+\W*$/im, "").trim());
    return;
  }
  let answer: string;
  try {
    answer = await run.model("final", finalPrompt(request, notesText(notes), lastReport), 600);
  } catch (e) {
    if (!(e instanceof StopTurn) || run.interrupted) throw e;
    // The work is done; only the closing words are missing.
    answer = `The tasks ran, but the closing summary couldn't be written (${e.message})\n\n${notesText(notes)}`;
  }
  run.say(answer);
}

/**
 * One task in a fresh hidden thread of the harness. Mirrors its tool items into the visible
 * turn, relays its approval requests to the page, and returns its report and what it recorded.
 */
export async function runWorker(run: Run, brief: string, n: number): Promise<WorkerResult> {
  const as = run.appServer;
  const out: WorkerResult = {
    status: "failed",
    report: "",
    error: null,
    commands: [],
    files: [],
    calls: 0,
    maxInputTokens: 0,
    lastFailure: null,
  };
  run.stats.workers++;
  let wid: string;
  try {
    const started = await as.request("thread/start", {
      model: run.thread.model,
      cwd: run.cwd,
      approvalPolicy: run.thread.approvalPolicy,
      sandbox: run.thread.sandbox,
      ephemeral: true, // never on disk, never in the page's thread list
      ...(process.env.ORC_STOCK_BASE ? {} : { baseInstructions: WORKER_BASE }),
    });
    wid = String((started.thread as Json).id);
  } catch (e) {
    throw new StopTurn("failed", `Couldn't start a worker: ${errText(e)}`);
  }
  const prefix = `${run.turn.id}-w${n}-`;
  let workerTurn: string | null = null;
  let capStop: StopTurn | null = null;
  let settle!: (status: WorkerResult["status"]) => void;
  const done = new Promise<WorkerResult["status"]>((res) => (settle = res));
  const interruptWorker = () => {
    if (workerTurn)
      as.request("turn/interrupt", { threadId: wid, turnId: workerTurn }).catch(() => {});
    // If it doesn't confirm, don't wait for it.
    setTimeout(() => settle("interrupted"), 4000).unref();
  };

  // For the idle guard: when the worker last said anything, and what is legitimately pending.
  let lastWord = Date.now();
  let asking = 0;
  const busy = new Set<string>();
  const onMessage = (m: ServerMessage) => {
    const p = m.params;
    if ((p.threadId ?? p.conversationId) !== wid) return;
    lastWord = Date.now();
    if (m.id !== undefined) {
      // The harness asks before running or changing something: the user answers in the visible thread.
      const params: Json = { ...p };
      if (typeof p.itemId === "string") params.itemId = prefix + p.itemId;
      const id = m.id;
      asking++;
      void run.ask(m.method, params).then((answer) => {
        asking--;
        lastWord = Date.now();
        const refused = answer.rpcError as { code?: number; message?: string } | undefined;
        if (refused)
          as.respondError(id, refused.code ?? -32601, refused.message ?? "not supported");
        else as.respond(id, answer);
      });
      return;
    }
    switch (m.method) {
      case "item/started":
      case "item/completed": {
        const item = p.item as Item | undefined;
        if (!item) return;
        if (item.type === "agentMessage") {
          if (m.method === "item/completed" && typeof item.text === "string" && item.text.trim())
            out.report = item.text;
          return;
        }
        if (!SHOWN.has(item.type)) return;
        const shown = { ...item, id: prefix + item.id };
        if (m.method === "item/started") {
          busy.add(item.id);
          return run.start(shown);
        }
        busy.delete(item.id);
        run.complete(shown);
        if (item.type === "commandExecution" && typeof item.command === "string") {
          const cmd = unwrap(item.command);
          const ok = item.status === "completed" && (item.exitCode ?? 0) === 0;
          out.lastFailure = ok
            ? null
            : { cmd, output: clipMiddle(String(item.aggregatedOutput ?? "").trim(), 500) };
          // Looking around and writing files (those are under FILES) are not worth a line of notes.
          if (!ok || !LOOKING_RE.test(cmd)) out.commands.push({ cmd, ok });
        }
        if (item.type === "fileChange" && item.status === "completed")
          for (const c of (item.changes ?? []) as { path: string; kind?: { type?: string } }[])
            out.files.push({ path: relative(run.cwd, c.path), kind: c.kind?.type ?? "update" });
        return;
      }
      case "item/commandExecution/outputDelta":
        if (typeof p.itemId === "string" && typeof p.delta === "string")
          run.outputDelta(prefix + p.itemId, p.delta);
        return;
      case "thread/tokenUsage/updated": {
        // One of the worker's own model requests, as the harness reports it.
        const usage = p.tokenUsage as { last?: { inputTokens?: number } } | undefined;
        out.calls++;
        out.maxInputTokens = Math.max(out.maxInputTokens, usage?.last?.inputTokens ?? 0);
        run.stats.workerMaxInputTokens = Math.max(
          run.stats.workerMaxInputTokens,
          out.maxInputTokens,
        );
        run.notify("thread/tokenUsage/updated", { tokenUsage: p.tokenUsage });
        try {
          run.spend(1, true);
        } catch (e) {
          if (e instanceof StopTurn && !capStop) {
            capStop = e;
            interruptWorker();
          }
        }
        return;
      }
      case "error":
        if (p.willRetry !== true)
          out.error = String((p.error as { message?: string } | undefined)?.message ?? "error");
        return;
      case "turn/completed": {
        const turn = p.turn as { status?: string; error?: { message?: string } | null } | undefined;
        if (turn?.error?.message) out.error = turn.error.message;
        settle(
          turn?.status === "completed"
            ? "completed"
            : turn?.status === "interrupted"
              ? "interrupted"
              : "failed",
        );
        return;
      }
    }
  };
  const off = as.listen(onMessage);
  const offExit = as.onExit((reason) => {
    out.error = reason;
    settle("failed");
  });
  const onAbort = () => interruptWorker();
  run.signal.addEventListener("abort", onAbort, { once: true });
  let idle = false;
  const idleTimer = setInterval(() => {
    // A command that runs long or a question to the user is not silence; a model that says nothing is.
    if (idle || busy.size || asking || Date.now() - lastWord < run.caps.workerIdleMs) return;
    idle = true;
    interruptWorker();
  }, 1000);
  let tooLong = false;
  const timer = setTimeout(() => {
    tooLong = true;
    interruptWorker();
  }, run.caps.workerMs);
  try {
    if (run.signal.aborted) throw new Interrupted();
    const t = await as.request("turn/start", {
      threadId: wid,
      input: [{ type: "text", text: brief, text_elements: [] }],
    });
    workerTurn = String((t.turn as Json | undefined)?.id ?? "");
    if (run.signal.aborted) interruptWorker();
    out.status = await done;
  } catch (e) {
    if (e instanceof Interrupted || run.signal.aborted) out.status = "interrupted";
    else {
      out.status = "failed";
      out.error = errText(e);
    }
  } finally {
    clearTimeout(timer);
    clearInterval(idleTimer);
    off();
    offExit();
    run.signal.removeEventListener("abort", onAbort);
    // Let app-server unload the thread (it only lived in memory).
    as.request("thread/unsubscribe", { threadId: wid }).catch(() => {});
  }
  if (run.signal.aborted) throw new Interrupted();
  if (capStop) throw capStop;
  if (idle)
    throw new StopTurn(
      "router",
      `The model stopped answering: a worker heard nothing from it for ${Math.round(run.caps.workerIdleMs / 60_000)} minutes and was stopped. Try again in a while, or pick another tier.`,
    );
  if (tooLong) {
    out.status = "failed";
    out.error = `it ran longer than ${Math.round(run.caps.workerMs / 60_000)} minutes and was stopped`;
  }
  if (out.status === "interrupted") {
    out.status = "failed";
    out.error ??= "it was interrupted";
  }
  return out;
}

/** "/bin/zsh -lc 'npm test'" or '… -lc "npm test"' -> "npm test" (the harness wraps every command). */
export function unwrap(cmd: string): string {
  const m = /^\S*\/(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(cmd);
  if (!m) return cmd;
  return m[1] === "'" ? m[2].replace(/'\\''/g, "'") : m[2].replace(/\\(["$`\\])/g, "$1");
}

const SKIP_DIRS = new Set(["node_modules", "__pycache__", "target", "dist", "build", "venv"]);

/** Size and time of the folder's files (bounded), to see what a worker changed. */
export function snapshot(cwd: string, limit = 4000): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.size >= limit) return;
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 6) walk(full, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = statSync(full);
          out.set(path.relative(cwd, full), `${st.size}:${st.mtimeMs}`);
        } catch {
          // gone already
        }
      }
    }
  };
  walk(cwd, 0);
  return out;
}

export function changedSince(
  cwd: string,
  before: Map<string, string>,
): { path: string; kind: string }[] {
  const now = snapshot(cwd);
  const out: { path: string; kind: string }[] = [];
  for (const [p, sig] of now) {
    if (!before.has(p)) out.push({ path: p, kind: "add" });
    else if (before.get(p) !== sig) out.push({ path: p, kind: "update" });
  }
  for (const p of before.keys()) if (!now.has(p)) out.push({ path: p, kind: "delete" });
  return out.slice(0, 30);
}

function relative(cwd: string, p: string): string {
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return p.startsWith(root) ? p.slice(root.length) : p;
}
