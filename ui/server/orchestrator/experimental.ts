// Experimental: a planner and fresh workers.
//
//   1. plan    one plain call (a new chat, no tools): the request, a one-line listing of the
//              folder and the session notes -> a short ordered list of mini tasks, each with what
//              "done" means. Parsed leniently from plain text (parse.ts). "ANSWER: …" instead of
//              a list means the request needs no work, and is the reply. A reply that declines
//              ("I can't run commands on your computer") is not a plan: the planner is asked once
//              more, firmly, and failing that the request itself is the one task. A plan that
//              only looks around, for a request that asks for something to be made, gets a last
//              task that makes it (parse.ts planProduces).
//   2. work    each task runs as a worker: a fresh, hidden (ephemeral) thread on the
//              orchestrators' app-server, i.e. the stock harness with its tools, the thread's
//              sandbox and approval preset (sent the way the page sends them for a normal
//              thread), on the thread's tier. It gets a brief (prompts.ts): goal, this task, its
//              done-criteria, the bounded notes. Its commands, file changes and approval requests
//              appear in the visible thread as they happen; its last message is its report
//              (RESULT / CHANGES / VALIDATION / BLOCKERS / STATUS).
//   3. fold    after each worker the notes take what was recorded (files changed, commands and
//              how they exited) and one line of what was reported. A worker that reports BLOCKED
//              or PARTIAL, or that used up its own budget of requests or minutes, sends the
//              remaining list back to the planner for a revision. A worker whose model request
//              failed (after the harness's own retries) is not a failed task: the task is run
//              again after a wait, on the schedule plain calls use.
//   4. check   when the list is done, the files the request named and did not find must exist:
//              if one doesn't, the planner is asked once for the tasks that make it.
//   5. answer  a short reply written from the notes (one plain call), or, for a job that was a
//              single task, that worker's own report. A deliverable that is missing, or a last
//              recorded command that failed, is stated first, whatever the reply says.
//
// Between turns only the notes are kept: a follow-up message is planned from them, not from the
// history. They also hold the tasks still to do, so after a turn that ended early (no model, a
// guard, an interrupt) "continue" runs what was left without planning again. Workers run one at
// a time; runWorker holds no state outside its arguments, so tasks the planner marked
// independent could be run side by side later.
//
// Guards (backend.ts Caps): worker runs per turn, tries per task, plan revisions, model calls per
// turn (workers' requests counted as app-server reports them), requests and minutes per worker.
// A guard that stops the work ends the turn with a plain message and the notes. Time is read off
// the monotonic clock (clock.ts).

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Item } from "../fallback/items.ts";
import type { ServerMessage } from "./appserver.ts";
import {
  folderBrief,
  Interrupted,
  ModelWait,
  pageSandboxPolicy,
  StopTurn,
  errText,
  type Run,
} from "./backend.ts";
import { mono } from "./clock.ts";
import {
  addCommand,
  addDone,
  addFile,
  addProblem,
  addRequest,
  clip,
  clipMiddle,
  NOTES_LIMIT,
  notesText,
  reportSections,
  setPending,
} from "./notes.ts";
import {
  isContinue,
  looksLikeRefusal,
  parsePlan,
  parseReport,
  planProduces,
  producingTask,
  type MiniTask,
  type Plan,
} from "./parse.ts";
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
/** A worker turn that failed for a reason no wait will cure. */
const NO_RETRY_RE =
  /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid (?:api )?(?:key|token)|not logged in|sign in/i;
/** A worker turn that failed because the task outgrew the model: the planner's to split. */
const TOO_BIG_RE = /context (?:window|length)|maximum context|token limit|too (?:long|large)/i;

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
  /** Its last few commands of any kind (what a worker that was stopped had been doing). */
  recent: { cmd: string; ok: boolean }[];
  /** It was stopped because it used up its own budget. */
  budget: "calls" | "minutes" | null;
  /** Its turn failed in the harness (a model request that never got through), not at the task. */
  modelFailure: boolean;
  /** The worker's harness thread id (null until it started). */
  threadId: string | null;
}

const LOOKING_RE =
  /^\s*(?:ls|cat|find|sed -n|head|tail|pwd|rg|grep|wc|echo|printf|mkdir|touch|cd|tree|which|file|stat)\b/;

/** File types a request can name as something to produce. */
const FILE_EXT = new Set(
  "py js mjs cjs ts tsx jsx json jsonl md txt csv tsv yaml yml toml html htm css scss sh bash zsh rs go c h cc cpp hpp java kt rb php sql db sqlite sqlite3 xml ini cfg conf log out png jpg jpeg gif svg pdf ipynb lock r jl swift pl lua zip tar gz tgz patch diff bin dat parquet npy pkl proto gradle cmake mk tex rst wasm".split(
    " ",
  ),
);

/**
 * The files a request names that do not exist: what the job is to produce ("… create
 * recovered.json", "a test file test_mathx.py"). Paths relative to the folder where they can be;
 * at most four. A name whose folder (for an absolute path) isn't there is not counted.
 */
export function deliverablesIn(request: string, cwd: string): string[] {
  const out: string[] = [];
  const re =
    /(?:^|[\s"'`(\[=])((?:\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w.@+-]+\.([A-Za-z][A-Za-z0-9]{0,7}))(?=$|[\s"'`)\],:;?!]|\.(?:\s|$))/g;
  for (const m of request.matchAll(re)) {
    if (!FILE_EXT.has(m[2].toLowerCase())) continue;
    const abs = path.resolve(cwd, m[1]);
    if (existsSync(abs)) continue;
    if (path.isAbsolute(m[1]) && !existsSync(path.dirname(abs))) continue;
    const shown = abs.startsWith(`${cwd}/`) ? path.relative(cwd, abs) : abs;
    if (!out.includes(shown)) out.push(shown);
    if (out.length >= 4) break;
  }
  return out;
}

function missing(deliverables: string[], cwd: string): string[] {
  return deliverables.filter((d) => !existsSync(path.resolve(cwd, d)));
}

/** The plan for a request: one call, and one firmer call if the first declined to plan. */
async function makePlan(run: Run, request: string, notes: string): Promise<Plan> {
  const folder = folderBrief(run.cwd);
  let text = await run.model("planner", plannerPrompt(request, folder, notes));
  let plan = parsePlan(text);
  if (!plan.tasks.length && looksLikeRefusal(text)) {
    text = await run.model("planner", plannerPrompt(request, folder, notes, true));
    plan = parsePlan(text);
    // Declined twice: not an answer to show. The request itself becomes the one task.
    if (!plan.tasks.length && looksLikeRefusal(text)) plan = { answer: null, tasks: [] };
  }
  return plan;
}

export async function runExperimental(run: Run): Promise<void> {
  const notes = run.thread.notes;
  const caps = run.caps;
  const request = run.text;
  // The plan is made from the notes as they were; the request joins them before the first call,
  // so it is kept even when no model can be reached to plan it.
  const before = notesText(notes);
  const resuming = isContinue(request) && notes.requests.length > 0;
  if (!resuming) {
    addRequest(notes, request);
    notes.deliverables = deliverablesIn(request, run.cwd);
  }
  const goal = notes.requests[0];
  /** What the work is measured against: this request, or the one being resumed. */
  const job = resuming ? (notes.requests.at(-1) ?? request) : request;
  run.save();

  let queue: MiniTask[];
  if (resuming && notes.pending.length) {
    // The list the last turn left: run it, no planning.
    queue = notes.pending.map((t) => ({ ...t }));
    run.say(
      `Going on from where the last turn stopped, ${queue.length} task${queue.length === 1 ? "" : "s"} left:\n\n${queue.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}`,
    );
  } else {
    const plan = await makePlan(run, request, before);
    if (!plan.tasks.length && plan.answer) {
      run.say(plan.answer);
      return;
    }
    if (plan.tasks.length) {
      queue = plan.tasks.slice();
      if (!planProduces(queue, job, notes.deliverables))
        queue.push(producingTask(job, notes.deliverables));
    } else {
      // Nothing readable came back: the request itself is the one task.
      queue = [{ title: clip(job, 500), done: "" }];
    }
    if (queue.length > 1)
      run.say(
        `Plan, ${queue.length} tasks:\n\n${queue.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}`,
      );
  }

  const finished: MiniTask[] = [];
  const attempts = new Map<string, number>();
  let ran = 0;
  /** Workers started (reruns after a model failure included): names their rows. */
  let started = 0;
  let replans = 0;
  let lastReport = "";
  let gaveUp: string | null = null;
  let endChecked = false;
  /** The last command a worker of this turn ran that was a check (not a look around). */
  let lastCheck: { cmd: string; ok: boolean } | null = null;
  let wait: ModelWait | null = null;
  /** Tasks whose worker once ended without using a tool at all (run again once, saying so). */
  const idled = new Set<string>();
  const showPlan = (current: MiniTask | null) =>
    run.plan([
      ...finished.map((t) => ({ step: t.title, status: "completed" as const })),
      ...(current ? [{ step: current.title, status: "inProgress" as const }] : []),
      ...queue.map((t) => ({ step: t.title, status: "pending" as const })),
    ]);
  const list = (tasks: MiniTask[]) => tasks.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
  setPending(notes, queue);
  run.save();

  for (;;) {
    while (queue.length) {
      run.check();
      const task = queue.shift()!;
      // The notes always say what is left: whatever ends this turn, "continue" starts here.
      setPending(notes, [task, ...queue]);
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
      if (total > 1 && !wait) run.say(`**Task ${finished.length + 1} of ${total}:** ${task.title}`);
      const brief = workerBrief({
        goal,
        task,
        index: finished.length + 1,
        total,
        later: queue,
        // (the goal has its own line in the brief, and the later tasks theirs)
        notes: notesText(notes, NOTES_LIMIT, false).replace(/^GOAL: .*\n?/, ""),
        cwd: run.cwd,
        idleBefore: idled.has(key),
      });
      const snap = snapshot(run.cwd);
      const res = await runWorker(run, brief, ++started);
      // Files a command wrote (a heredoc, a generator) never show as file changes: compare the folder.
      for (const f of changedSince(run.cwd, snap))
        if (!res.files.some((x) => x.path === f.path)) res.files.push(f);
      run.backend.trace({
        type: "worker",
        task: task.title,
        brief,
        calls: res.calls,
        maxInputTokens: res.maxInputTokens,
        status: res.budget ? `stopped (${res.budget})` : res.modelFailure ? "no model" : res.status,
        threadId: res.threadId,
        report: res.report,
        commands: res.commands.length,
      });
      // Recorded facts first: they hold whatever the report says, and whatever stopped the worker.
      for (const c of res.commands) {
        addCommand(notes, c.cmd, c.ok);
        lastCheck = c;
      }
      for (const f of res.files) addFile(notes, f.path, f.kind);
      run.check();
      if (res.modelFailure) {
        // The harness tried its own retries and gave up. That says nothing about the task: wait
        // and run it again (what it changed so far is in the notes).
        const why = res.error ?? "the model request failed";
        wait ??= new ModelWait(run);
        if (NO_RETRY_RE.test(why) || wait.left <= 0) {
          wait.end(false);
          addProblem(notes, `${clip(task.title, 80)}: no model was available`);
          run.save();
          throw new StopTurn(
            "router",
            CAPACITY_RE.test(why)
              ? routerProblem(503, why)
              : `A worker's model request failed, and waiting didn't help: ${clip(why, 300)}`,
          );
        }
        // Not a try of the task and not one of the turn's worker runs: the schedule of waits
        // bounds these reruns, and the requests the worker did make count as model calls.
        attempts.set(key, tries - 1);
        ran--;
        queue.unshift(task);
        run.save();
        await wait.pause(CAPACITY_RE.test(why) ? "no model is free" : "a worker's request failed");
        continue;
      }
      if (wait) {
        wait.end(true);
        wait = null;
      }
      const rep = parseReport(res.report);
      const sec = reportSections(res.report);
      // A worker that ran no command and changed no file, and does not report done, never
      // started (a chat model that looked for the shell among its own tools and gave up). What
      // it says about missing tools is no fact about this machine and must not reach the notes,
      // where the planner would plan around it: the task is run once more, with that recorded
      // in the brief. Not a try of the task and not one of the turn's worker runs.
      const idleWorker =
        res.status === "completed" &&
        !res.budget &&
        res.commands.length === 0 &&
        res.files.length === 0 &&
        rep.status !== "done";
      if (idleWorker && !idled.has(key)) {
        idled.add(key);
        attempts.set(key, tries - 1);
        ran--;
        queue.unshift(task);
        run.say("The worker stopped without running anything. Running the task again.");
        run.save();
        continue;
      }
      lastReport = res.report;
      // A report is a claim; the last command's exit code is a record. "Done" over a failed last
      // command is treated as not done.
      const contradicted = rep.status === "done" && res.lastFailure !== null;
      if (res.status === "completed" && rep.status === "done" && !contradicted) {
        addDone(notes, task.title, sec.result || "done");
        finished.push(task);
        setPending(notes, queue);
        run.save();
        continue;
      }
      // A blocker, a surprise, or a worker out of budget: note it, and let the planner revise
      // what remains.
      const why =
        res.status === "failed"
          ? `the worker stopped: ${res.error ?? "no reason given"}`
          : contradicted
            ? `it reported done, but its last command failed: ${clip(res.lastFailure!.cmd, 100)}`
            : sec.blockers ||
              sec.result ||
              `it ended without a report${res.lastFailure ? `; its last command failed: ${clip(res.lastFailure.cmd, 100)}` : ""}`;
      const trail = res.recent.length
        ? `\nIts last commands:\n${res.recent.map((c) => `- ${c.ok ? "ok" : "FAILED"}: ${clip(c.cmd, 140)}`).join("\n")}`
        : "";
      // With no report to go on, the planner gets what the failed command printed.
      const evidence = res.budget
        ? `(recorded) The worker was stopped: ${res.error}. It had not finished.${res.report ? `\nThe last thing it said: ${clip(res.report, 300)}` : ""}${trail}${res.lastFailure ? `\nThe last one failed with:\n${res.lastFailure.output}` : ""}`
        : (contradicted
            ? `${res.report}\n\n(recorded) Its last command, ${clip(res.lastFailure!.cmd, 160)}, failed with:\n${res.lastFailure!.output}`
            : res.report) ||
          res.error ||
          (res.lastFailure
            ? `(no report) The last command, ${clip(res.lastFailure.cmd, 160)}, failed with:\n${res.lastFailure.output}`
            : "");
      // The same twice: recorded as what it is, not as the missing tool it names.
      addProblem(
        notes,
        idleWorker
          ? `${clip(task.title, 80)}: two workers stopped without running any command (the shell works; nothing was tried)`
          : `${clip(task.title, 80)}: ${why}`,
      );
      if (rep.status === "partial" && sec.result)
        addDone(notes, `${task.title} (partly)`, sec.result);
      else if (res.budget && res.report.trim())
        addDone(notes, `${task.title} (stopped part way)`, sec.result || res.report);
      run.save();
      if (replans >= caps.replans)
        throw new StopTurn(
          "cap",
          `Stopped: the plan was revised ${replans} times and "${clip(task.title, 120)}" still didn't finish.`,
        );
      replans++;
      const revised = parsePlan(
        await run.model(
          "revise",
          revisePrompt(
            job,
            notesText(notes),
            task,
            idleWorker
              ? `(recorded) Twice a worker given this task stopped without running any command or changing any file. Workers here have a working shell and can create files with it; whatever the worker said about missing tools or access is not a fact about this machine.${res.report ? `\nWhat it said: ${clip(res.report, 300)}` : ""}`
              : evidence,
            queue,
          ),
        ),
        5,
      );
      if (!revised.tasks.length) {
        gaveUp = revised.answer ?? `The work stopped at "${clip(task.title, 120)}": ${why}`;
        queue = [];
        break;
      }
      queue = revised.tasks;
      setPending(notes, queue);
      run.say(`That hit a problem (${clip(why, 200)}). Revised plan:\n\n${list(queue)}`);
    }
    // The list is done. Is what the request named there? If not, ask once for the tasks that make it.
    const gone = gaveUp ? [] : missing(notes.deliverables, run.cwd);
    if (!gone.length || endChecked || replans >= caps.replans) break;
    endChecked = true;
    replans++;
    const names = gone.join(", ");
    const revised = parsePlan(
      await run.model(
        "revise",
        revisePrompt(
          job,
          notesText(notes),
          { title: `Produce ${names}`, done: "" },
          `(recorded) Every planned task ran, but ${names} ${gone.length === 1 ? "does" : "do"} not exist. Plan the task or tasks that create ${gone.length === 1 ? "it" : "them"} from what the notes show.`,
          [],
        ),
      ),
      5,
    );
    if (!revised.tasks.length) {
      gaveUp = revised.answer;
      break;
    }
    queue = revised.tasks;
    setPending(notes, queue);
    run.say(`The planned tasks ran, but ${names} was not produced. More tasks:\n\n${list(queue)}`);
  }
  setPending(notes, []);
  run.save();
  showPlan(null);

  // What was recorded at the end stands above whatever the reply says.
  const gone = missing(notes.deliverables, run.cwd);
  const facts: string[] = [];
  if (gone.length)
    facts.push(
      `${gone.map((g) => `\`${g}\``).join(", ")}, named in the request, ${gone.length === 1 ? "does" : "do"} not exist.`,
    );
  if (lastCheck && !lastCheck.ok)
    facts.push(`The last recorded check failed: \`${clip(lastCheck.cmd, 160)}\`.`);
  const verdict = facts.length
    ? `**${gone.length ? "Not finished" : "Not verified"}.** ${facts.join(" ")}\n\n`
    : "";
  if (gaveUp) {
    run.say(verdict + gaveUp);
    return;
  }
  // One task, done: its report is the answer (no call needed to rephrase it).
  if (ran === 1 && finished.length === 1 && lastReport.trim()) {
    run.say(verdict + lastReport.replace(/^\W*status\W+\w+\W*$/im, "").trim());
    return;
  }
  const checks = [
    ...notes.deliverables.map((d) => {
      const size = fileSize(path.resolve(run.cwd, d));
      return `${d}: ${size === null ? "MISSING" : `exists (${size} bytes)`}`;
    }),
    ...(lastCheck
      ? [`last check: ${lastCheck.ok ? "passed" : "FAILED"}: ${clip(lastCheck.cmd, 160)}`]
      : []),
  ].join("\n");
  let answer: string;
  try {
    answer = await run.model("final", finalPrompt(job, notesText(notes), lastReport, checks), 600);
  } catch (e) {
    if (!(e instanceof StopTurn) || run.interrupted) throw e;
    // The work is done; only the closing words are missing.
    answer = `The tasks ran, but the closing summary couldn't be written (${e.message})\n\n${notesText(notes)}`;
  }
  run.say(verdict + answer);
}

function fileSize(p: string): number | null {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
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
    recent: [],
    budget: null,
    modelFailure: false,
    threadId: null,
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
    out.threadId = wid;
  } catch (e) {
    throw new StopTurn("failed", `Couldn't start a worker: ${errText(e)}`);
  }
  const prefix = `${run.turn.id}-w${n}-`;
  let workerTurn: string | null = null;
  let capStop: StopTurn | null = null;
  let harnessFailed = false;
  let settle!: (status: WorkerResult["status"]) => void;
  const done = new Promise<WorkerResult["status"]>((res) => (settle = res));
  const interruptWorker = () => {
    if (workerTurn)
      as.request("turn/interrupt", { threadId: wid, turnId: workerTurn }).catch(() => {});
    // If it doesn't confirm, don't wait for it.
    setTimeout(() => settle("interrupted"), 4000).unref();
  };

  // For the idle guard: when the worker last said anything (on the monotonic clock: a wall clock
  // that jumps must not look like silence), and what is legitimately pending.
  let lastWord = mono.now();
  let asking = 0;
  const busy = new Set<string>();
  const onMessage = (m: ServerMessage) => {
    const p = m.params;
    if ((p.threadId ?? p.conversationId) !== wid) return;
    lastWord = mono.now();
    if (m.id !== undefined) {
      // The harness asks before running or changing something: the user answers in the visible thread.
      const params: Json = { ...p };
      if (typeof p.itemId === "string") params.itemId = prefix + p.itemId;
      const id = m.id;
      asking++;
      void run.ask(m.method, params).then((answer) => {
        asking--;
        lastWord = mono.now();
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
          out.recent.push({ cmd, ok });
          if (out.recent.length > 5) out.recent.shift();
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
        // Its own budget: a worker that has not finished in this many requests is circling.
        if (!capStop && !out.budget && out.calls >= run.caps.workerCalls) {
          out.budget = "calls";
          interruptWorker();
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
        // A turn the harness itself ends as failed is a model request that never got through.
        if (turn?.status === "failed") harnessFailed = true;
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
    harnessFailed = true;
    settle("failed");
  });
  const onAbort = () => interruptWorker();
  run.signal.addEventListener("abort", onAbort, { once: true });
  let idle = false;
  const idleTimer = setInterval(() => {
    // A command that runs long or a question to the user is not silence; a model that says nothing is.
    if (idle || busy.size || asking || mono.now() - lastWord < run.caps.workerIdleMs) return;
    idle = true;
    interruptWorker();
  }, 1000);
  // (a timer, so on the monotonic clock)
  const timer = setTimeout(() => {
    out.budget ??= "minutes";
    interruptWorker();
  }, run.caps.workerMs);
  try {
    if (run.signal.aborted) throw new Interrupted();
    const t = await as.request("turn/start", {
      threadId: wid,
      input: [{ type: "text", text: brief, text_elements: [] }],
      // The preset again, as the page sends it with every turn of a normal thread
      // (src/store/actions.ts): the same approval policy and the same explicit sandbox policy,
      // so a worker asks and is confined exactly as a normal thread with this preset is.
      approvalPolicy: run.thread.approvalPolicy,
      sandboxPolicy: pageSandboxPolicy(run.thread.sandbox),
    });
    workerTurn = String((t.turn as Json | undefined)?.id ?? "");
    if (run.signal.aborted) interruptWorker();
    out.status = await done;
  } catch (e) {
    if (e instanceof Interrupted || run.signal.aborted) out.status = "interrupted";
    else {
      out.status = "failed";
      out.error = errText(e);
      harnessFailed = true; // the request to the app-server itself failed
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
  // It finished in the same moment the budget ran out: it finished.
  if (out.budget && out.status === "completed") out.budget = null;
  if (out.budget) {
    out.status = "failed";
    out.error =
      out.budget === "calls"
        ? `it used its budget of ${run.caps.workerCalls} model requests for one task`
        : `it used its budget of ${minutes(run.caps.workerMs)} for one task`;
  } else if (out.status === "failed" && harnessFailed && !TOO_BIG_RE.test(out.error ?? ""))
    out.modelFailure = true;
  if (out.status === "interrupted") {
    out.status = "failed";
    out.error ??= "it was interrupted";
  }
  return out;
}

function minutes(ms: number): string {
  const m = ms / 60_000;
  return m >= 1
    ? `${Math.round(m)} minute${Math.round(m) === 1 ? "" : "s"}`
    : `${Math.round(ms / 1000)} seconds`;
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
