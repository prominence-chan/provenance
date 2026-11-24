// Every prompt the orchestrators write, in one place so they can be read and measured.
//
// Budget: a plain call (planner, revise, final, think, translate, summarize) is at most
// PROMPT_BUDGET characters of instructions + input, about 2k tokens: a fraction of what a free
// web chat takes (~15k tokens; some message boxes stop near 25k characters). run.model() enforces
// it by cutting the middle of an over-long input. A worker's brief is at most BRIEF_BUDGET; what
// the stock harness adds around it (its own instructions and tool list, ~25k characters) is the
// harness's, and is the same for the first request of any thread.

import { clip, clipMiddle, notesView, type Notes } from "./notes.ts";
import { ACTION_HELP, FILE_BLOCK_HELP, type MiniTask } from "./parse.ts";
import { exactLine, numbered, requestExcerpt } from "./request.ts";

export const PROMPT_BUDGET = 8000;
export const BRIEF_BUDGET = 4500;
/** Hyperexperimental's carried summary. */
export const SUMMARY_LIMIT = 2500;
/** The last step's results as they are kept (the next Think may be shown less: thinkPrompt). */
export const RESULTS_LIMIT = 3500;
/**
 * A request this long (with the one-line folder listing) is one worker's job without question:
 * it fits a brief whole, beside the rules and the report form (which take about 1,700 of the
 * brief's 4,500 characters). Of the benchmark's ten requests nine are under it (560 to 2,250
 * characters; the tenth is 3,500).
 */
export const ONE_WORKER_CHARS = 2700;
/** The request's share of a plain prompt that also carries other things (planner, reviewer, think). */
export const REQUEST_SHARE = 3000;

export interface Prompt {
  instructions: string;
  input: string;
}

const PLAN_FORMAT = `TASK 1: <what to do, naming the files exactly as the request spells them>
NEEDS: <the numbers of the request's pieces this task depends on, for example 2-4, 7>
DONE WHEN: <how the worker can tell it is done>
TASK 2: ...`;

/**
 * The three rules of checking, in one sentence each (the same in a worker's brief and in the
 * Think prompt): run it as it will be used, keep a copy of an input a tool may change, hold the
 * result to the sizes the request states.
 */
export const VERIFY_RULES = `Before you call it done: (1) run the result the way the request says it will be used, including each failure case the request itself names (an interrupt, a missing argument, an extreme input; where it names none, invent none), and say what you ran; (2) keep a copy of any input before a tool that may change it opens it (sqlite3, an editor, a formatter, an installer), and prefer read-only modes; (3) check the result against every size, count or shape the request states, and do not hard-code what it says is unknown.`;

// ---- Experimental ------------------------------------------------------------------------------

/**
 * `firm` is the second try, after a reply that declined ("I can't run commands on your
 * computer") instead of planning. The request is shown in numbered pieces so that a task can
 * point at the ones it needs instead of rewriting them.
 */
export function plannerPrompt(
  request: string,
  folder: string,
  notes: string,
  firm = false,
  exact: string[] = [],
): Prompt {
  const names = exactLine(exact, 700);
  return {
    instructions: `You decide how a coding request is carried out on the user's machine. You run nothing yourself and nobody asks you to: workers with a shell and file tools there do the work. Your only output is the decision.

The normal case is ONE worker for the whole job. It is given the request word for word, so there is nothing for you to restate. For that, reply with the single word:
ONE

Split the job only when one worker could not finish it in about twenty tool calls: it creates or changes more than three files, or it has stages that each need their own check. Then reply in exactly this form (two to five tasks):
LARGE: <one line: why one worker is not enough>
${PLAN_FORMAT}

A worker has no memory. It sees its task, the request pieces you list under NEEDS word for word, and brief notes from earlier tasks. Never put a name, path, number or format from the request into your own words: point to its piece. Put running or testing the code in the task that writes it. Looking around is at most the first task; the last task must produce what the request asks for and check it. If the notes list tasks STILL TO DO and the request is to continue, plan those, not the whole job again. Do not write code and do not explain.

If the request needs no work in the folder (a greeting, or a question the notes already answer), reply instead with one line: ANSWER: <your reply to the user>${
      firm
        ? `

Your last reply said you cannot run commands or reach the files. That is not asked of you: the workers do it. Reply with ONE or the TASK list now; any other reply is useless.`
        : ""
    }`,
    input: `REQUEST:\n${numbered(request.trim(), REQUEST_SHARE)}${names ? `\n\n${names}` : ""}\n\nFOLDER: ${folder}\n\nNOTES FROM EARLIER WORK:\n${notes || "(none: this is the start)"}`,
  };
}

export function revisePrompt(
  request: string,
  notes: string,
  failed: MiniTask,
  report: string,
  remaining: MiniTask[],
  exact: string[] = [],
): Prompt {
  const rest = remaining.length
    ? remaining.map((t, i) => `${i + 1}. ${clip(t.title, 200)}`).join("\n")
    : "(none)";
  const names = exactLine(exact, 500);
  return {
    instructions: `A coding job is being done by workers with no memory (each sees its task, the pieces of the request it NEEDS word for word, and brief notes). One task just ran into a problem. Write the task list for what REMAINS so the job can still finish: try another approach, split the task, or leave out what cannot be done. Do not repeat a task the same way it already failed, and do not redo finished work. A task that used up its budget was too big or went in circles: make it smaller and say exactly what to do. When what the request asks for already exists and only a check did not run, that is ONE task: run the check. Never put a name, path, number or format from the request into your own words: point to its piece under NEEDS. The list must still end by producing what the request asks for. At most 3 tasks. You run nothing yourself (workers with tools do); do not write code.

Reply in plain text in exactly this form:
${PLAN_FORMAT}

If nothing useful can still be done, reply instead with one line: ANSWER: <what is finished and what blocks the rest>`,
    input: `REQUEST:\n${numbered(request.trim(), 2000)}${names ? `\n\n${names}` : ""}\n\nNOTES:\n${notes}\n\nTASK THAT HIT A PROBLEM: ${clip(failed.title, 300)}\nITS REPORT:\n${clipMiddle(report.trim() || "(no report)", 900)}\n\nTASKS THAT WERE STILL PLANNED:\n${rest}`,
  };
}

const REPORT_FORM = `End with a short report in exactly this form:
RESULT: one or two sentences on what is true now
CHANGES: files you created or edited
VALIDATION: commands you ran and whether they passed
NOT CHECKED: what the request asks for that you did not run (or: nothing)
BLOCKERS: none, or what stopped you
STATUS: DONE or BLOCKED or PARTIAL`;

/**
 * A worker's brief. In order of what may never be cut: the rules and the report form; the
 * person's request word for word (whole when it fits, else the pieces this task needs and as
 * much of the rest as fits, with the gaps marked and the file that holds all of it named); the
 * must-match list; the task; then the notes and the folder listing in what room is left.
 */
export function workerBrief(a: {
  /** The request this job is for, as the person wrote it. */
  request: string;
  /** Exact names copied out of it by code (request.ts exactNames). */
  exact: string[];
  /** An earlier goal of the thread, when this request is a follow-up ("" otherwise). */
  earlier?: string;
  task: MiniTask;
  index: number;
  total: number;
  later: MiniTask[];
  notes: Notes;
  cwd: string;
  /** The one-line folder listing (shown when there is room). */
  folder?: string;
  /** Where the whole request can be read, when the brief cannot hold all of it. */
  requestFile?: string | null;
  /** An earlier worker on this task ended without using a tool at all: say so. */
  idleBefore?: boolean;
  /** Commands an earlier worker on this task asked approval for and was refused. */
  declinedBefore?: string[];
}): string {
  const whole = a.task.whole === true;
  const idle = a.idleBefore
    ? `\nRECORDED: an earlier worker on this task ran no command and changed no file before it stopped. The shell tool works on this machine: begin by running a command.`
    : "";
  const declined = a.declinedBefore?.length
    ? `\nRECORDED: an earlier worker on this task asked approval for a command and was refused: ${a.declinedBefore.map((c) => clip(c, 140)).join(" ; ")}. Nobody will approve it. Do the task another way (see the rules), or finish what can be finished without it.`
    : "";
  const later = a.later.length
    ? `\nLATER TASKS (other workers do these, not you): ${clip(a.later.map((t) => clip(t.title, 80)).join("; "), 300)}`
    : "";
  const opening = whole
    ? `You are the worker for this job. This message is all you know: do all THE REQUEST asks, check it, report, stop.`
    : `You are one worker in a larger job. This message is all you know; do only YOUR TASK, then stop.`;
  const task = `YOUR TASK (${a.index} of ${a.total}): ${a.task.title}${a.task.detail ? `\n${clipMiddle(a.task.detail, 1500)}` : ""}
DONE WHEN: ${clip(a.task.done, 240) || "the task is complete and you have checked it"}${later}${idle}${declined}`;
  const rules = `Rules: work in ${a.cwd}. ${whole ? "" : "Do only your task: it is DONE when its own done-criteria hold, even though the whole job is not finished yet. "}Read only the files you need. Use every name, path and value of the request exactly as written there. ${VERIFY_RULES} If an approval is refused, do not ask again: do it another way, or go on without it and name it under BLOCKERS. If you cannot finish, stop and say why rather than guess.

${REPORT_FORM}`;
  const earlier = a.earlier ? `EARLIER IN THIS THREAD: ${clip(a.earlier, 300)}\n` : "";
  const frame = (req: string, shortened: boolean, notes: string, folder: string, names: string) =>
    `${opening}

THE REQUEST, word for word (where a task's wording differs from it, the request is right):
"""
${req}
"""${shortened && a.requestFile ? `\n(Shortened here. All of it is in ${a.requestFile}: read there what you need.)` : ""}${names ? `\n${names}` : ""}
${earlier}${folder ? `FOLDER: ${folder}\n` : ""}
${task}

NOTES FROM EARLIER TASKS:
${notes || "(none: you are first)"}

${rules}`;
  const strip = (t: string) => t.replace(/^GOAL: .*\n?/, "").replace(/^LATER REQUEST: .*\n?/gm, "");
  const notesIn = (limit: number) => {
    const full = strip(notesView(a.notes, 1600));
    return full.length <= limit ? full : strip(notesView(a.notes, Math.max(300, limit)));
  };
  // What is left once the fixed parts are in. The request comes first: whole if it fits beside
  // a short version of the notes; then the notes, the folder listing, and the list of names
  // (which, beside the whole request, only repeats it). A request that does not fit is given in
  // its pieces, and then the names come before everything else: they stand for what was cut.
  const fixed = frame("", !!a.requestFile, "", "", "").length + (a.requestFile?.length ?? 0) + 40;
  const room = Math.max(600, BRIEF_BUDGET - fixed);
  const request = a.request.trim();
  const notesFloor = Math.min(notesIn(1600).length, 500);
  if (request.length <= room - notesFloor) {
    let left = room - request.length;
    const notes = notesIn(Math.max(notesFloor, left));
    left -= notes.length;
    const folder = a.folder && a.folder.length + 10 <= left ? a.folder : "";
    left -= folder ? folder.length + 10 : 0;
    const names = left > 140 ? exactLine(a.exact, Math.min(600, left - 2)) : "";
    return clipMiddle(frame(request, false, notes, folder, names), BRIEF_BUDGET);
  }
  const names = exactLine(a.exact, 600);
  const req = requestExcerpt(
    request,
    Math.max(700, room - notesFloor - names.length),
    a.task.needs ?? [],
  );
  let left = room - req.text.length - names.length;
  const notes = notesIn(Math.max(notesFloor, left));
  left -= notes.length;
  const folder = a.folder && a.folder.length + 10 <= left ? a.folder : "";
  return clipMiddle(frame(req.text, true, notes, folder, names), BRIEF_BUDGET);
}

/** `checks` is what was recorded when the tasks ended (does the deliverable exist, did the last check pass). */
export function finalPrompt(
  request: string,
  notes: string,
  lastReport: string,
  checks = "",
): Prompt {
  return {
    instructions: `Write the reply to the user for a coding job that workers just finished. Use only what is below. Say what was done and in which files, what a recorded command verified and what nobody verified, and any open problem. Do not claim more than the notes show. If RECORDED AT THE END shows a file that is MISSING or under another name, a last check that FAILED, or points NOT SHOWN, the job is not verified: say so first, and never call it a success. Under 120 words, plain text or light markdown, no preamble.`,
    input: `THE USER ASKED:\n${requestExcerpt(request, 1500).text}\n\nNOTES:\n${notes}\n\nLAST WORKER'S REPORT:\n${clipMiddle(lastReport.trim() || "(none)", 900)}${checks ? `\n\nRECORDED AT THE END:\n${clipMiddle(checks, 900)}` : ""}`,
  };
}

/**
 * The finish check: a fresh chat reads the request against what was recorded and answers per
 * requirement. It is given no account of the work in the workers' or the Think step's own words
 * beyond one line each: a claim is not evidence.
 */
export function reviewPrompt(a: {
  request: string;
  exact: string[];
  /** Files changed this turn, with sizes and short excerpts. */
  files: string;
  /** Commands run this turn with how they ended. */
  commands: string;
  /** What code already found (a missing file, a near miss, a failed last check). */
  found: string;
  /** What the workers or the Think step claim, one line each. */
  claims: string;
}): Prompt {
  const list = exactLine(a.exact, 500);
  const instructions = `You check a finished coding job before the answer goes to the person. You run nothing. Read THE REQUEST and list its requirements: what must exist and under which exact name and place, what it must do, every size, count, format and case it names, and how it will be used. Judge each one only from RECORDED: a recorded command that passed, a file listing or an excerpt is evidence; a statement under CLAIMED is not. A check that ran on something other than what the request names (another file, a sample, another way of running it) does not show the requirement.

Reply with one line per requirement, at most 10, in exactly this form and nothing else:
R1: <the requirement, in the request's words> | MET | <the recorded evidence>
R2: <requirement> | NOT SHOWN | CHECK: <the cheapest single command that would settle it>
R3: <requirement> | VIOLATED | <what the record shows instead>`;
  const room = PROMPT_BUDGET - instructions.length - 200;
  const files = clipMiddle(a.files || "(none recorded)", 2200);
  const commands = clipMiddle(a.commands || "(none recorded)", 1300);
  const found = clipMiddle(a.found || "(nothing)", 500);
  const claims = clipMiddle(a.claims || "(none)", 500);
  const req = requestExcerpt(
    a.request,
    Math.max(
      900,
      room - files.length - commands.length - found.length - claims.length - list.length,
    ),
  ).text;
  return {
    instructions,
    input: `THE REQUEST, word for word:\n"""\n${req}\n"""${list ? `\n${list}` : ""}\n\nRECORDED, files changed:\n${files}\n\nRECORDED, commands run (latest result of each):\n${commands}\n\nRECORDED, found by code:\n${found}\n\nCLAIMED (not evidence):\n${claims}`,
  };
}

// ---- Hyperexperimental -------------------------------------------------------------------------

export function thinkPrompt(a: {
  /** The request, as the person wrote it. */
  goal: string;
  exact?: string[];
  /** Where the whole request can be read, when this prompt cannot hold all of it. */
  requestFile?: string | null;
  /** What came before this request in the thread, in a line ("" when nothing). */
  before?: string;
  folder: string;
  summary: string;
  results: string;
  step: number;
  stepsLeft: number;
}): Prompt {
  const instructions = `You direct a coding job one small step at a time. You cannot touch the machine: you write, in plain words, what to do next, an executor does it, and you are shown the results. You have no memory; SUMMARY and LAST RESULTS below are everything known, and LAST RESULTS are shown this once: what you need from a file you read, use now (write the new file in this reply), because the summary keeps a few lines of it at most. Do not read the same thing twice. GOAL is the person's request word for word: use its names, paths and values exactly as written.

Say the next step concretely: the files to read and the commands to run, each command in a \`\`\`bash block (a block runs as one script, exactly as you write it). Give each file you create or rewrite once, whole, in a block fenced exactly like this (it is saved as written; never put file content in a heredoc, an echo or a command):

${FILE_BLOCK_HELP}

For a small change to an existing file give the exact old text and the new text instead. One small step, at most 5 actions. Do not repeat what the summary shows as done: a check it shows as passed is not run again. ${VERIFY_RULES}

When the goal is reached and checked, reply instead with a line starting FINISHED: followed by the answer for the user, saying what was run to check it and what was not checked.`;
  const goal = requestExcerpt(a.goal, 2200);
  const pointer =
    !goal.whole && a.requestFile
      ? `\n(Shortened here. All of it is in ${a.requestFile}: READ there what you need.)`
      : "";
  const before = a.before ? `\n${a.before}` : "";
  const summary = a.summary || "(nothing done yet)";
  const tail = `This is step ${a.step}; ${a.stepsLeft} step${a.stepsLeft === 1 ? "" : "s"} left after it.`;
  const base =
    instructions.length +
    goal.text.length +
    pointer.length +
    before.length +
    a.folder.length +
    summary.length +
    tail.length +
    90;
  // The names stand for what a shortened goal lost. Beside the whole goal they only repeat it:
  // then they are given when the last results lose nothing for it.
  const list = exactLine(a.exact ?? [], 500);
  const names =
    !goal.whole || PROMPT_BUDGET - base - list.length >= Math.min(a.results.length, RESULTS_LIMIT)
      ? list
      : "";
  const fixed = base + names.length;
  // The last results take the room that is left (never less than a screenful).
  const results = a.results
    ? clipMiddle(a.results, Math.max(900, Math.min(RESULTS_LIMIT, PROMPT_BUDGET - fixed)))
    : "(none yet)";
  return {
    instructions,
    input: `GOAL:\n${goal.text}${pointer}${before}${names ? `\n${names}` : ""}\n\nFOLDER: ${a.folder}\n\nSUMMARY SO FAR:\n${summary}\n\nLAST STEP RESULTS:\n${results}\n\n${tail}`,
  };
}

export function translatePrompt(plan: string, cwd: string, platform: string): Prompt {
  return {
    instructions: `Turn the PLAN into actions for an executor. Output only actions, in order, in exactly this vocabulary:

${ACTION_HELP}

Rules: copy commands exactly from the plan and add nothing the plan does not say. Where the plan shows [command block C1 ...], the executor already holds those commands: output only the line RUN: C1 for it. Where the plan shows [file block: <path> ...], the executor already holds that file: output only the line WRITE: <path> for it, with no content under it. Any other file content is copied exactly; never output a WRITE without content, and never a RUN that feeds a file through cat > or a heredoc. Paths are relative to the working folder. One RUN per command. WRITE replaces the whole file. At most 6 actions. No explanations. If the plan has nothing to execute, output NONE.`,
    input: `Working folder: ${cwd}\nPlatform: ${platform}\n\nPLAN:\n${clipMiddle(plan.trim(), 6000)}`,
  };
}

export function summarizePrompt(a: {
  goal: string;
  exact?: string[];
  summary: string;
  intent: string;
  results: string;
}): Prompt {
  const names = exactLine(a.exact ?? [], 400);
  return {
    instructions: `You keep the running summary of a coding job; it is the only memory the job has. Rewrite it to include the latest step. Record only what the results show (a command that failed, failed). Keep: files created or changed with one line on what each holds, files that were read with the facts the job needs from them (names of functions and columns, formats, values: enough that nobody has to read them again), commands that passed or failed with the key error text, decisions made, what was checked and how, and what is still left to do. Write names, paths and numbers exactly as they appear. Drop what no longer matters. Plain text, under 300 words, no preamble.`,
    input: `GOAL: ${clip(a.goal, 500)}${names ? `\n${names}` : ""}\n\nPREVIOUS SUMMARY:\n${a.summary || "(empty)"}\n\nLATEST STEP, WHAT WAS INTENDED:\n${clipMiddle(a.intent.trim(), 900)}\n\nLATEST STEP, ACTIONS AND RESULTS:\n${a.results}`,
  };
}

/**
 * A worker's base instructions, in place of the stock harness prompt (about 18,000 characters,
 * sent with every request of a thread): a worker has one small task and a brief that says the
 * rest. Kept under the 3,000 characters above which the router's web path would swap it for its
 * own prompt.
 */
export const WORKER_BASE = `You are a coding agent working in a terminal on the user's machine. You are given one small task: do it with your tools, check it, report, and stop.

- Use the shell tool to look around and to run things. Keep commands short and non-interactive: no editors, no pagers, nothing that waits for input. Look with ls, rg or grep, and sed -n; read a file before you change it.
- Input files may be the evidence the job is about: before a tool that can change a file opens it (sqlite3, a database or archive tool, a formatter, an installer), copy the file and work on the copy, and prefer read-only modes.
- Create or change files with apply_patch when you have it, otherwise with a heredoc. Keep changes small and in the style of the code around them. Use the names, paths and values of the request exactly as it writes them.
- Stay inside the working folder. Do not commit, push, reset or discard with git, and do not install anything globally, unless the task says so. Commands that force-delete (rm -f), use sudo or write outside the folder need an approval that may never come: do without them. In zsh, status and path are reserved variable names.
- When a command fails, read the error and fix the cause; never repeat the same command unchanged. If you are blocked (a missing tool, a refused permission, an unclear task), stop and say so.
- Before you report done, run the result the way the request says it will be used, including the failure cases it names, and check it against any size, count or shape the request states. Say what you ran and what you did not check.
- Do not ask questions: make the reasonable choice and mention it. No plans or narration between tool calls; end with one short report in the form the task asks for.`;
