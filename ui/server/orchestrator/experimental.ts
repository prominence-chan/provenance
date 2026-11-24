// Experimental: a planner and fresh workers.
//
//   1. plan    one plain call (a new chat, no tools): the request in numbered pieces, the exact
//              names code copied out of it, a one-line listing of the folder and the session
//              notes -> "ONE" (one worker does the whole job: the normal case), or "LARGE: why"
//              and a short ordered list of tasks, each with the request pieces it NEEDS (by
//              number) and what "done" means. Parsed leniently from plain text (parse.ts).
//              "ANSWER: …" means the request needs no work, and is the reply. A reply that
//              declines ("I can't run commands on your computer") is not a plan: the planner is
//              asked once more, firmly, and failing that the request goes to one worker. A list
//              that names none of the files the request asks for gets a last task that does
//              (parse.ts planProduces).
//   2. work    each task runs as a worker: a fresh, hidden (ephemeral) thread on the
//              orchestrators' app-server, i.e. the stock harness with its tools, the thread's
//              sandbox and approval preset (sent the way the page sends them for a normal
//              thread), on the thread's tier. It gets a brief (prompts.ts): goal, this task, its
//              done-criteria, the bounded notes. Its commands, file changes and approval requests
//              appear in the visible thread as they happen; its last message is its report
//              (RESULT / CHANGES / VALIDATION / BLOCKERS / STATUS).
//   3. fold    after each worker the notes take what was recorded (files changed, commands and
//              how they exited) and one line of what was reported. A worker that reports BLOCKED,
//              or that used up its own budget of requests or minutes, sends the remaining list
//              back to the planner for a revision; so does PARTIAL from the last task or from a
//              worker whose commands failed (PARTIAL with every command passed and other tasks
//              still planned is progress: the plan stands). A worker whose model request
//              failed (after the harness's own retries) is not a failed task: the task is run
//              again after a wait, on the schedule plain calls use.
//   4. check   when the list is done, the finish check, once per turn that changed something:
//              by code, every file the request names as output exists under exactly that name
//              (a file of nearly that name is a near miss and is called one), nothing was written
//              outside the folder to a path the request does not name, and the last recorded
//              check did not fail; then one plain call, a fresh reader given the request word for
//              word and what was recorded, answers per requirement MET / NOT SHOWN / VIOLATED
//              with the cheapest check for what is not shown. What is open becomes ONE more
//              task, written by code from those findings (never by the planner), and is not
//              revised if it fails.
//   5. answer  for a job that was not split, the worker's own report; for a split one, a short
//              reply written from the notes (one plain call). What code found (a missing or
//              misnamed file, a failed last check) is stated first, and what the finish check
//              left open is stated after it as not verified, whatever the reply says.
//
// The request travels word for word: every brief quotes it (whole when it fits; otherwise the
// pieces the planner named for the task by number, the rest as far as it fits, and the path of a
// file that holds all of it), with the exact names code copied out of it (request.ts). A planner
// or reviser never has to restate it, and what one restates wrongly does not outrank it.
//
// One worker is the normal case: the planner answers ONE, or a list without saying why the job
// is LARGE for a request that fits a brief, and the whole request goes to a single worker with a
// somewhat larger budget. A split is for a job the planner says would not fit, or a request no
// brief holds.
//
// A refused approval is not a fault of the plan. It is recorded once ("needs approval: …"), the
// task is run once more with that in its brief (do it another way), and if that is refused too
// the job goes on without the task and the answer says so. No revision is spent on it.
//
// Budgets follow what the turn has left (calls and minutes, a reserve kept for the finish check
// and the closing words): a worker gets no more than is left, a revision is made only when it
// and one more task still fit, and when too little is left the turn stops with what it has and
// says what is not done, instead of running into the cap.
//
// Between turns only the notes are kept: a follow-up message is planned from them, not from the
// history. They also hold the tasks still to do, so after a turn that ended early (no model, a
// guard, an interrupt) "continue" runs what was left without planning again. Workers run one at
// a time; runWorker holds no state outside its arguments, so tasks the planner marked
// independent could be run side by side later.
//
// Guards (backend.ts Caps): worker runs per turn, tries per task, plan revisions, model calls and
// minutes per turn (workers' requests counted as app-server reports them), requests and minutes
// per worker.
// A guard that stops the work ends the turn with a plain message and the notes. Time is read off
// the monotonic clock (clock.ts).

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
  addApproval,
  addCommand,
  addDone,
  addFile,
  addProblem,
  addRequest,
  clip,
  clipMiddle,
  notesText,
  ORIGINAL_LIMIT,
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
import {
  finalPrompt,
  ONE_WORKER_CHARS,
  plannerPrompt,
  reviewPrompt,
  revisePrompt,
  WORKER_BASE,
  workerBrief,
} from "./prompts.ts";
import {
  exactNames,
  filesNamed,
  nearMiss,
  parseReview,
  requestExcerpt,
  strayPaths,
  type Review,
  type ReviewItem,
} from "./request.ts";
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

/** Kept back from every task's budget: the finish check and the closing words. */
const RESERVE_CALLS = 2;
const RESERVE_MS = 45_000;
/** Less than this left (after the reserve) is not enough to start another task. */
const MIN_TASK_CALLS = 3;
const MIN_TASK_MS = 60_000;
/**
 * The reviewer's reply may be this long (tokens). Generous on purpose: a model that reasons
 * before it writes spends its allowance there first, and a reply cut off after "R1: …" is no
 * review (seen with 700 on a real run).
 */
export const REVIEW_TOKENS = 3000;
/** The one worker of an unsplit job gets this much more than a task of a split one. */
const WHOLE_JOB_FACTOR = 1.5;

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
  /** Commands it ran, looking around included (`commands` leaves those out). */
  ran: number;
  /** Commands (or changes) it asked approval for and was refused. */
  declined: string[];
}

/** What one worker may spend: its own share of what the turn has left. */
export interface WorkerBudget {
  calls: number;
  ms: number;
}

export const LOOKING_RE =
  /^\s*(?:ls|cat|find|sed -n|head|tail|pwd|rg|grep|wc|echo|printf|mkdir|touch|cd|tree|which|file|stat)\b/;

/**
 * The files a request names that do not exist: what the job is to produce ("… create
 * recovered.json", "a test file test_mathx.py", "save it to /app/meeting_scheduled.ics"). Paths
 * relative to the folder where they can be; at most eight. A name whose folder (for an absolute
 * path) isn't there is not counted.
 */
export function deliverablesIn(request: string, cwd: string): string[] {
  const out: string[] = [];
  for (const name of filesNamed(request)) {
    if (name.startsWith("~/")) continue;
    const abs = path.resolve(cwd, name);
    if (existsSync(abs)) continue;
    if (path.isAbsolute(name) && !existsSync(path.dirname(abs))) continue;
    const shown = abs.startsWith(`${cwd}/`) ? path.relative(cwd, abs) : abs;
    if (!out.includes(shown)) out.push(shown);
    if (out.length >= 8) break;
  }
  return out;
}

function missing(deliverables: string[], cwd: string): string[] {
  return deliverables.filter((d) => !existsSync(path.resolve(cwd, d)));
}

/**
 * The request as a file a worker (or a READ) can open, for a request no prompt holds whole. Under
 * the system temp folder (readable from every sandbox preset, and not in the person's project).
 */
export function requestFile(threadId: string, request: string): string | null {
  try {
    const dir = path.join(tmpdir(), "provenance-requests");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${threadId.replace(/[^\w.-]/g, "_")}.txt`);
    writeFileSync(file, request);
    return file;
  } catch {
    return null;
  }
}

/** What code can tell about the end of a job without asking anyone. */
export interface CodeFindings {
  /** Files the request names as output that do not exist. */
  gone: string[];
  /** Of those, the ones something of nearly that name was made for instead. */
  near: { want: string; have: string }[];
  /** Paths outside the folder that were written to and that the request does not name. */
  stray: string[];
  /** The last recorded check, when it failed. */
  failed: string | null;
}

export function codeFindings(a: {
  deliverables: string[];
  cwd: string;
  request: string;
  /** Files created or changed this turn (relative to the folder where they are inside it). */
  files: string[];
  commands: string[];
  reports: string[];
  lastCheck: { cmd: string; ok: boolean } | null;
}): CodeFindings {
  const gone = missing(a.deliverables, a.cwd);
  const wanted = new Set(a.deliverables);
  const made = a.files.filter((f) => !wanted.has(f) && existsSync(path.resolve(a.cwd, f)));
  const near: CodeFindings["near"] = [];
  for (const want of gone) {
    const have = nearMiss(want, made);
    if (have) near.push({ want, have });
  }
  return {
    gone,
    near,
    stray: strayPaths(
      {
        files: a.files.filter((f) => path.isAbsolute(f)),
        commands: a.commands,
        reports: a.reports,
      },
      a.cwd,
      a.request,
    ),
    failed: a.lastCheck && !a.lastCheck.ok ? a.lastCheck.cmd : null,
  };
}

/** The findings as lines (for the reviewer, a follow-up task, the answer). */
export function findingLines(f: CodeFindings): string[] {
  const out: string[] = [];
  for (const g of f.gone) {
    const n = f.near.find((x) => x.want === g);
    out.push(
      n
        ? `\`${g}\`, named in the request, does not exist; \`${n.have}\` was made instead: a near miss, not the file asked for (the request's name and place are the right ones)`
        : `\`${g}\`, named in the request, does not exist`,
    );
  }
  for (const s of f.stray)
    out.push(`\`${s}\` is outside the working folder and the request does not name it`);
  if (f.failed) out.push(`the last recorded check failed: \`${clip(f.failed, 160)}\``);
  return out;
}

export function findingCount(f: CodeFindings): number {
  return f.gone.length + f.stray.length + (f.failed ? 1 : 0);
}

/** A few hundred characters from the start of a small text file ("" for anything else). */
function excerpt(file: string, max = 520): string {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size === 0) return "";
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(Math.min(st.size, max * 2));
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const text = buf.subarray(0, n).toString("utf8");
    // (a binary file is not shown)
    if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) return "";
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return "";
  }
}

/** The files changed this turn as the reviewer sees them: kind, size, the head of the small ones. */
export function filesEvidence(
  files: { path: string; kind: string }[],
  deliverables: string[],
  cwd: string,
): string {
  const out: string[] = [];
  const wanted = new Set(deliverables);
  let shown = 0;
  const order = [...files].sort((a, b) => Number(wanted.has(b.path)) - Number(wanted.has(a.path)));
  for (const f of order.slice(0, 10)) {
    const abs = path.resolve(cwd, f.path);
    const size = fileSize(abs);
    out.push(`- ${f.path} (${f.kind}, ${size === null ? "not there now" : `${size} bytes`})`);
    if (size !== null && shown < 4) {
      const head = excerpt(abs);
      if (head) {
        out.push(
          head
            .split("\n")
            .slice(0, 14)
            .map((l) => `    | ${l}`)
            .join("\n"),
        );
        shown++;
      }
    }
  }
  for (const d of deliverables)
    if (!files.some((f) => f.path === d))
      out.push(
        `- ${d} (named in the request): ${fileSize(path.resolve(cwd, d)) === null ? "MISSING" : "exists, not changed this turn"}`,
      );
  return out.join("\n");
}

/** The follow-up task for what the finish check left open: written by code, never by a planner. */
export function followUpTask(open: ReviewItem[], found: string[]): MiniTask {
  const lines = [
    ...found.map((f) => `- (recorded) ${f}`),
    ...open.map(
      (o) =>
        `- ${o.verdict === "violated" ? "VIOLATED" : "NOT SHOWN"}: ${clip(o.requirement, 200)}${o.note ? ` — ${clip(o.note, 200)}` : ""}`,
    ),
  ];
  return {
    title: "Settle the open points of the finish check, and fix what the checks show",
    detail: `A reviewer read the request against what was recorded. These points are open:\n${lines.join("\n")}\nFor each: run the check named (or a better one) on the real result, the way the request says it will be used. Where a check fails or a point is violated, fix the work and run the check again. Never weaken or remove a check to make it pass. A file the request names must exist under exactly that name and place.`,
    done: "every open point is settled by a command you ran (name each in VALIDATION), or is listed under NOT CHECKED with the reason",
    followUp: true,
  };
}

/** What the answer says about the finish check ("" when it has nothing to say). */
export function finishText(a: {
  review: Review | null;
  open: ReviewItem[];
  followUp: { ran: boolean; done: boolean; result: string; why: string } | null;
  skipped: string | null;
  /** Hyperexperimental: the follow-up was further steps of the same job, not a task of its own. */
  steps?: boolean;
}): string {
  if (!a.review && !a.open.length)
    return a.skipped
      ? `Finish check: not run (${a.skipped}); nothing beyond the recorded commands was verified.`
      : "";
  const total = a.review?.items.length ?? 0;
  // (all shown met: the answer stays as it is)
  if (!a.open.length) return "";
  const list = a.open
    .map(
      (o) =>
        `- ${o.verdict === "violated" ? "violated" : "not shown"}: ${clip(o.requirement, 180)}${o.note ? ` (${clip(o.note, 160)})` : ""}`,
    )
    .join("\n");
  const head = `**Finish check.** Read against what was recorded, ${a.open.length} of ${total} requirement${total === 1 ? "" : "s"} ${a.open.length === 1 ? "was" : "were"} not shown met:\n${list}`;
  if (!a.followUp?.ran)
    return `${head}\n${a.steps ? "No further step" : "No follow-up task"} was run for ${a.open.length === 1 ? "it" : "them"}${a.skipped ? ` (${a.skipped})` : ""}: treat ${a.open.length === 1 ? "it" : "them"} as **not verified**.`;
  const it = a.open.length === 1 ? "it" : "them";
  if (a.steps)
    return a.followUp.done
      ? `${head}\nMore steps were then run for ${it}; the answer above says what was checked and what was not.`
      : `${head}\nMore steps were run for ${it} and did not settle ${it} (${clip(a.followUp.why || "they did not finish", 200)}): treat ${it} as **not verified**.`;
  return a.followUp.done
    ? `${head}\nA follow-up task then ran for ${it} and reported: ${clip(a.followUp.result || "done", 400)}`
    : `${head}\nA follow-up task ran for ${it} and did not settle ${it} (${clip(a.followUp.why || "it did not finish", 200)}): treat ${it} as **not verified**.`;
}

/** The plan for a request: one call, and one firmer call if the first declined to plan. */
async function makePlan(
  run: Run,
  request: string,
  notes: string,
  folder: string,
  exact: string[],
): Promise<Plan> {
  let text = await run.model("planner", plannerPrompt(request, folder, notes, false, exact));
  let plan = parsePlan(text);
  if (!plan.tasks.length && !plan.one && looksLikeRefusal(text)) {
    text = await run.model("planner", plannerPrompt(request, folder, notes, true, exact));
    plan = parsePlan(text);
    // Declined twice: not an answer to show. The request itself becomes the one task.
    if (!plan.tasks.length && looksLikeRefusal(text))
      plan = { answer: null, tasks: [], one: true, large: null };
  }
  return plan;
}

/**
 * The whole request as one worker's task. The request is in the brief word for word, so the
 * title only points at it; a short request is its own title. What a planner listed anyway is
 * kept as a suggested order, no more.
 */
function wholeTask(job: string, suggested: MiniTask[]): MiniTask {
  const flat = job.replace(/\s+/g, " ").trim();
  const order = suggested.length
    ? `A planner suggested this order of work (it has not seen the files; the request decides): ${suggested.map((t, i) => `${i + 1}. ${clip(t.title, 160)}`).join(" ")}`
    : "";
  return {
    title: flat.length <= 200 ? flat : "Do everything THE REQUEST above asks for, and check it",
    ...(order ? { detail: order } : {}),
    done: "what the request asks for exists exactly as it names it, and you have run it",
    whole: true,
  };
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
    // Word for word, and what code reads out of it: these go to every worker as they are.
    notes.original =
      request.trim().length > ORIGINAL_LIMIT
        ? clipMiddle(request.trim(), ORIGINAL_LIMIT)
        : request.trim();
    notes.exact = exactNames(request);
    notes.deliverables = deliverablesIn(request, run.cwd);
    notes.approvals = [];
  }
  /** What the work is measured against: this request, or the one being resumed, as written. */
  const job = resuming ? notes.original || (notes.requests.at(-1) ?? request) : notes.original;
  const exact = notes.exact;
  /** An earlier goal of the thread (or a hand-over), when this request follows one. */
  const earlier = notes.requests.length > 1 ? notes.requests[0] : "";
  const folder = folderBrief(run.cwd);
  /** For a request no brief holds whole: where a worker can read all of it. */
  const wholeAt = requestExcerpt(job, 1800).whole ? null : requestFile(run.threadId, job);
  run.save();

  let queue: MiniTask[];
  if (resuming && notes.pending.length) {
    // The list the last turn left: run it, no planning.
    queue = notes.pending.map((t) => ({ ...t }));
    run.say(
      `Going on from where the last turn stopped, ${queue.length} task${queue.length === 1 ? "" : "s"} left:\n\n${queue.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}`,
    );
  } else {
    const plan = await makePlan(run, job, before, folder, exact);
    if (!plan.tasks.length && plan.answer && !plan.one) {
      run.say(plan.answer);
      return;
    }
    // One worker unless the job would not fit one: the planner said so (LARGE, with its
    // reason), or the request alone is more than a brief holds.
    const fits = job.length + folder.length <= ONE_WORKER_CHARS;
    if (plan.tasks.length > 1 && (plan.large !== null || !fits)) {
      queue = plan.tasks.slice();
      if (!planProduces(queue, job, notes.deliverables))
        queue.push(producingTask(job, notes.deliverables));
    } else queue = [wholeTask(job, plan.tasks)];
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
  /** The reports of this turn's workers, in order (what the answer of an unsplit job is made of). */
  const reports: string[] = [];
  let gaveUp: string | null = null;
  /** The last command a worker of this turn ran that was a check (not a look around). */
  let lastCheck: { cmd: string; ok: boolean } | null = null;
  let wait: ModelWait | null = null;
  /** Tasks whose worker once ended without using a tool at all (run again once, saying so). */
  const idled = new Set<string>();
  /** Tasks a worker left unfinished over a refused approval (run again once, saying so). */
  const refused = new Map<string, string[]>();
  /** What this turn changed and ran: the finish check's material. */
  const turnFiles = new Map<string, string>();
  const turnCommands: { cmd: string; ok: boolean }[] = [];
  /** The finish check, once per turn: what it found, and how its follow-up went. */
  let review: Review | null = null;
  let open: ReviewItem[] = [];
  let checked = false;
  let skipped: string | null = null;
  let followUp: { ran: boolean; done: boolean; result: string; why: string } | null = null;
  /** How many reports there were when the job's own tasks ended (a follow-up's come after). */
  let ownReports = -1;
  const split = queue.length > 1;
  const showPlan = (current: MiniTask | null) =>
    run.plan([
      ...finished.map((t) => ({ step: t.title, status: "completed" as const })),
      ...(current ? [{ step: current.title, status: "inProgress" as const }] : []),
      ...queue.map((t) => ({ step: t.title, status: "pending" as const })),
    ]);
  const list = (tasks: MiniTask[]) => tasks.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
  /** What a task may still spend, the reserve for the finish kept back. */
  const room = () => {
    const l = run.left();
    return { calls: l.calls - RESERVE_CALLS, ms: l.ms - RESERVE_MS };
  };
  const enough = (r: { calls: number; ms: number }) =>
    r.calls >= MIN_TASK_CALLS && r.ms >= MIN_TASK_MS;
  const short = (r: { calls: number; ms: number }) =>
    r.calls < MIN_TASK_CALLS
      ? `${run.stats.modelCalls} of this turn's ${caps.modelCalls} model calls are used`
      : `${Math.round((mono.now() - run.t0) / 60_000)} of this turn's ${Math.round(caps.turnMs / 60_000)} minutes are used`;
  const found = () =>
    codeFindings({
      deliverables: notes.deliverables,
      cwd: run.cwd,
      request: job,
      files: [...turnFiles.keys()],
      commands: turnCommands.map((c) => c.cmd),
      reports,
      lastCheck,
    });
  /** What was recorded at the end stands above whatever a reply says. */
  const verdict = () => {
    const f = found();
    const lines = findingLines(f);
    if (!lines.length) return "";
    const head = f.gone.length ? "Not finished" : "Not verified";
    return `**${head}.** ${lines.map((l) => `${l[0].toUpperCase()}${l.slice(1)}.`).join(" ")}\n\n`;
  };
  setPending(notes, queue);
  run.save();

  try {
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
        // What is left decides what this task may spend, and whether it starts at all.
        const have = room();
        if (!enough(have)) {
          if (task.followUp) {
            // The job's own tasks ran; only the settling of the finish check does not fit.
            skipped = `${short(have)}; too little was left`;
            queue = [];
            break;
          }
          throw new StopTurn(
            "cap",
            `Stopped with the job partly done: ${short(have)}, and what is left is not enough for another task. Not done: ${left()}. Send "continue" to go on.`,
          );
        }
        const factor = task.whole ? WHOLE_JOB_FACTOR : 1;
        const budget: WorkerBudget = {
          calls: Math.max(2, Math.min(Math.round(caps.workerCalls * factor), have.calls)),
          ms: Math.max(1000, Math.min(Math.round(caps.workerMs * factor), have.ms)),
        };
        ran++;
        showPlan(task);
        const total = finished.length + 1 + queue.length;
        if (total > 1 && !wait)
          run.say(`**Task ${finished.length + 1} of ${total}:** ${task.title}`);
        else if (task.followUp && !wait)
          run.say(
            `**Finish check:** ${open.length + findingLines(found()).length} point${open.length + findingLines(found()).length === 1 ? "" : "s"} not shown by what was recorded. One more task to settle ${open.length + findingLines(found()).length === 1 ? "it" : "them"}.`,
          );
        const brief = workerBrief({
          request: job,
          exact,
          earlier,
          task,
          index: finished.length + 1,
          total,
          later: queue,
          notes,
          cwd: run.cwd,
          folder,
          requestFile: wholeAt,
          idleBefore: idled.has(key),
          declinedBefore: refused.get(key),
        });
        const snap = snapshot(run.cwd);
        const res = await runWorker(run, brief, ++started, budget);
        // Files a command wrote (a heredoc, a generator) never show as file changes: compare the folder.
        for (const f of changedSince(run.cwd, snap))
          if (!res.files.some((x) => x.path === f.path)) res.files.push(f);
        run.backend.trace({
          type: "worker",
          task: task.title,
          brief,
          calls: res.calls,
          maxInputTokens: res.maxInputTokens,
          status: res.budget
            ? `stopped (${res.budget})`
            : res.modelFailure
              ? "no model"
              : res.status,
          threadId: res.threadId,
          report: res.report,
          commands: res.ran,
        });
        // Recorded facts first: they hold whatever the report says, and whatever stopped the worker.
        for (const c of res.commands) {
          addCommand(notes, c.cmd, c.ok);
          lastCheck = c;
          turnCommands.push(c);
        }
        for (const f of res.files) {
          addFile(notes, f.path, f.kind);
          turnFiles.set(f.path, f.kind);
        }
        // An approval nobody gave is recorded once, whatever the worker made of it.
        for (const d of res.declined) addApproval(notes, d);
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
          await wait.pause(
            CAPACITY_RE.test(why) ? "no model is free" : "a worker's request failed",
          );
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
          res.ran === 0 &&
          res.files.length === 0 &&
          res.declined.length === 0 &&
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
        if (res.report.trim()) reports.push(res.report);
        // A report is a claim; the last command's exit code is a record. "Done" over a failed last
        // command is treated as not done.
        const contradicted = rep.status === "done" && res.lastFailure !== null;
        if (res.status === "completed" && rep.status === "done" && !contradicted) {
          addDone(notes, task.title, sec.result || "done");
          finished.push(task);
          if (task.followUp)
            followUp = { ran: true, done: true, result: sec.result || res.report, why: "" };
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
        // A refused approval is not a fault of the plan: no revision is spent on it. The task is
        // run once more with the refusal recorded (the worker is to do without that command);
        // if that is refused too, the job carries on without the task and the answer says so.
        if (res.declined.length && !res.budget && res.status === "completed") {
          const again = !refused.has(key);
          refused.set(key, [...(refused.get(key) ?? []), ...res.declined].slice(-3));
          if (rep.status === "partial" && sec.result)
            addDone(notes, `${task.title} (partly)`, sec.result);
          if (again) {
            attempts.set(key, tries - 1);
            queue.unshift(task);
            run.say(
              `An approval was declined (\`${clip(res.declined[0], 120)}\`). Running the task again without it.`,
            );
            run.save();
            continue;
          }
          addProblem(
            notes,
            `${clip(task.title, 80)}: not finished, it needs approval: ${clip(res.declined.at(-1)!, 120)}`,
          );
          finished.push(task);
          if (task.followUp) followUp = { ran: true, done: false, result: "", why };
          setPending(notes, queue);
          run.say(
            `That task needs an approval that was declined twice (\`${clip(res.declined.at(-1)!, 120)}\`). Going on without it.`,
          );
          run.save();
          continue;
        }
        // PARTIAL from a worker whose commands all ran, while other tasks are still planned: the
        // rest of its report is usually the job's remainder, which those tasks are for (a worker
        // that inspected and says "the script is not written yet"). The plan stands; the note
        // of what it left goes on to the next worker, and the finish check reads the result.
        if (
          rep.status === "partial" &&
          res.status === "completed" &&
          !res.budget &&
          !contradicted &&
          !idleWorker &&
          res.lastFailure === null &&
          res.ran > 0 &&
          queue.length > 0 &&
          !task.followUp
        ) {
          addDone(notes, `${task.title} (partly)`, sec.result || why);
          if (sec.blockers)
            addProblem(notes, `${clip(task.title, 80)}: left open: ${sec.blockers}`);
          finished.push(task);
          setPending(notes, queue);
          run.save();
          continue;
        }
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
        if (task.followUp) {
          // The settling of the finish check is one bounded task: it is not planned around.
          followUp = { ran: true, done: false, result: sec.result, why };
          finished.push(task);
          setPending(notes, queue);
          continue;
        }
        if (replans >= caps.replans)
          throw new StopTurn(
            "cap",
            `Stopped: the plan was revised ${replans} times and "${clip(task.title, 120)}" still didn't finish.`,
          );
        // A revision costs a call and at least one more task: only when both still fit.
        const after = room();
        if (!enough({ calls: after.calls - 1, ms: after.ms })) {
          setPending(notes, [task, ...queue]);
          throw new StopTurn(
            "cap",
            `Stopped with the job partly done: "${clip(task.title, 120)}" hit a problem (${clip(why, 160)}), and ${short({ calls: after.calls - 1, ms: after.ms })}: not enough is left to revise the plan and run it. Not done: ${left()}. Send "continue" to go on.`,
          );
        }
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
              exact,
            ),
          ),
          3,
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
      // The list is done. The finish check, once per turn: first what code can tell (is every
      // file the request names there, under exactly that name; was anything written outside the
      // folder; did the last check pass), then one fresh reader of the request against what was
      // recorded. What is open becomes one more task, written by code from the findings.
      if (gaveUp || checked) break;
      checked = true;
      ownReports = reports.length;
      const code = found();
      const lines = findingLines(code);
      const changed = turnFiles.size > 0 || turnCommands.length > 0;
      const have = run.left();
      if (changed && have.calls > RESERVE_CALLS - 1 && have.ms > RESERVE_MS / 3) {
        try {
          review = parseReview(
            await run.model(
              "review",
              reviewPrompt({
                request: job,
                exact,
                files: filesEvidence(
                  [...turnFiles].map(([p, kind]) => ({ path: p, kind })),
                  notes.deliverables,
                  run.cwd,
                ),
                commands: turnCommands
                  .slice(-14)
                  .map((c) => `- ${c.ok ? "ok" : "FAILED"}: ${clip(c.cmd, 150)}`)
                  .join("\n"),
                found: lines.map((l) => `- ${l}`).join("\n"),
                claims: reports
                  .slice(-3)
                  .map((r) => {
                    const s = reportSections(r);
                    return `- ${clip(s.result || r, 150)}${s.unchecked ? ` NOT CHECKED: ${clip(s.unchecked, 120)}` : ""}`;
                  })
                  .join("\n"),
              }),
              REVIEW_TOKENS,
            ),
          );
          if (!review.items.length) {
            // (cut off, or not in the form asked for: no verdicts to act on, and the answer says so)
            review = null;
            skipped = "the reviewer's reply could not be read";
          } else open = review.open;
        } catch (e) {
          if (!(e instanceof StopTurn) || run.interrupted) throw e;
          skipped = "the reviewer could not be reached";
        }
      } else if (changed) skipped = "too little of the turn's budget was left";
      run.stats.finish = {
        requirements: review?.items.length ?? 0,
        open: open.length,
        code: findingCount(code),
        followUps: 0,
      };
      if (!open.length && !lines.length) break;
      queue = [followUpTask(open, lines)];
      run.stats.finish.followUps = 1;
      setPending(notes, queue);
    }
  } catch (e) {
    // A guard ended the turn: what was recorded about the result goes with its message.
    if (e instanceof StopTurn && e.kind === "cap" && !run.interrupted) {
      const v = verdict().trim();
      if (v) e.message = `${e.message}\n\n${v}`;
    }
    throw e;
  }
  setPending(notes, []);
  run.save();
  showPlan(null);

  const facts = verdict();
  const finish = finishText({ review, open, followUp, skipped });
  const needs = notes.approvals.length
    ? `Needs approval (asked and declined, so not run): ${notes.approvals.map((a) => `\`${clip(a, 140)}\``).join("; ")}.`
    : "";
  const tailText = [finish, needs].filter(Boolean).join("\n\n");
  const withTail = (body: string) => `${facts}${body}${tailText ? `\n\n${tailText}` : ""}`;
  if (gaveUp) {
    run.say(withTail(gaveUp));
    return;
  }
  const clean = (r: string) => r.replace(/^\W*status\W+\w+\W*$/im, "").trim();
  // A job that was not split: the worker's own report is the answer (no call to rephrase it),
  // and what a follow-up task reported comes after it, in the finish check's own lines.
  if (!split && finished.length >= 1 && replans === 0 && reports.length) {
    const own = ownReports > 0 ? reports.slice(0, ownReports) : reports;
    run.say(withTail(clean(own.at(-1)!)));
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
    ...findingLines(found()).filter((l) => /near miss|outside the working folder/.test(l)),
    ...(open.length
      ? [
          `finish check, NOT SHOWN or VIOLATED: ${open.map((o) => clip(o.requirement, 120)).join("; ")}${followUp?.done ? " (a follow-up task then ran for these)" : ""}`,
        ]
      : []),
  ].join("\n");
  let answer: string;
  if (run.left().calls < 1) {
    answer = `The tasks ran; this turn's model calls are used up, so here are the notes instead of a summary.\n\n${notesText(notes)}`;
  } else
    try {
      answer = await run.model(
        "final",
        finalPrompt(job, notesText(notes), lastReport, checks),
        600,
      );
    } catch (e) {
      if (!(e instanceof StopTurn) || run.interrupted) throw e;
      // The work is done; only the closing words are missing.
      answer = `The tasks ran, but the closing summary couldn't be written (${e.message})\n\n${notesText(notes)}`;
    }
  run.say(withTail(answer));
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
export async function runWorker(
  run: Run,
  brief: string,
  n: number,
  budget: WorkerBudget = { calls: run.caps.workerCalls, ms: run.caps.workerMs },
): Promise<WorkerResult> {
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
    ran: 0,
    declined: [],
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
        // Nobody approved it (declined, or a page with no card for the question): recorded, so
        // the turn can tell a refused approval from a task that failed.
        if (
          /requestApproval$/.test(m.method) &&
          (refused || (answer.decision !== "accept" && answer.decision !== "acceptForSession"))
        )
          out.declined.push(
            typeof p.command === "string"
              ? unwrap(p.command)
              : String(p.reason ?? (m.method.includes("fileChange") ? "a file change" : m.method)),
          );
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
          // (a command nobody approved did not run: it is neither a result nor a failure)
          if (item.status === "declined") return;
          const ok = item.status === "completed" && (item.exitCode ?? 0) === 0;
          out.lastFailure = ok
            ? null
            : { cmd, output: clipMiddle(String(item.aggregatedOutput ?? "").trim(), 500) };
          // Looking around and writing files (those are under FILES) are not worth a line of notes.
          if (!ok || !LOOKING_RE.test(cmd)) out.commands.push({ cmd, ok });
          out.ran++;
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
        if (!capStop && !out.budget && out.calls >= budget.calls) {
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
  }, budget.ms);
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
        ? `it used its budget of ${budget.calls} model requests for one task`
        : `it used its budget of ${minutes(budget.ms)} for one task`;
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
