// Every prompt the orchestrators write, in one place so they can be read and measured.
//
// Budget: a plain call (planner, revise, final, review, translate, the fold of Hyperexperimental's
// log) is at most PROMPT_BUDGET characters of instructions + input, about 2k tokens: a fraction of
// what a free web chat takes (~15k tokens; some message boxes stop near 25k characters). The Think
// call alone gets THINK_BUDGET (about 3k tokens): it carries the working memory and the pinned
// files that keep the job from reading the same thing step after step. run.model() enforces the
// budget it is given by cutting the middle of an over-long input. A worker's brief is at most
// BRIEF_BUDGET; what the stock harness adds around it (its own instructions and tool list) is the
// harness's, and is the same for the first request of any thread. Every role's instructions stay
// under the 3,000 characters above which the router's web path swaps them for its own prompt.

import { clip, clipMiddle, notesView, type Notes } from "./notes.ts";
import { ACTION_HELP, FILE_BLOCK_HELP, type MiniTask } from "./parse.ts";
import { platformLabel } from "./platform.ts";
import { exactLine, numbered, requestExcerpt } from "./request.ts";

export const PROMPT_BUDGET = 8000;
/** The Think call's own budget: goal, working memory, pinned files and the last results. */
export const THINK_BUDGET = 12_000;
export const BRIEF_BUDGET = 4800;
/** Hyperexperimental's working memory as it is stored on the thread for a reader (and a hand-over's share). */
export const SUMMARY_LIMIT = 2500;
/**
 * A request this long (with the one-line folder listing) is one worker's job without question:
 * it fits a brief whole, beside the rules and the report form (which take about 2,000 of the
 * brief's 4,800 characters). Of the benchmark's ten requests nine are under it (560 to 2,250
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
 * result to the sizes the request states. Two things the second benchmark round added to the
 * first: a failure case the request names is exercised for real (every arm "tested" a keyboard
 * interrupt by cancelling a task, and every arm's result hung on a real one), and test inputs a
 * worker writes vary what the request leaves open (a regex was checked only on lines that ended
 * with the date, and matched no others).
 */
export const VERIFY_RULES = `Before you call it done: (1) run the result the way the request says it will be used, and each failure case the request itself names for real (an interrupt as a real SIGINT to the running program while work is still queued, a missing argument, an extreme input; where it names none, invent none), and say what you ran; inputs you make up for a test must differ in what the request leaves open (where in a line or file a thing stands, what comes before and after it, order, how many), not repeat one shape; (2) keep a copy of any input before a tool that may change it opens it (sqlite3, an editor, a formatter, an installer), and prefer read-only modes; (3) check the result against every size, count or shape the request states, and do not hard-code what it says is unknown.`;

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
NOT CHECKED: what the request asks for that you did not run, and why (or: nothing)
BLOCKERS: none, or what stopped you
STATUS: DONE or BLOCKED or PARTIAL (DONE also when all that is left is a check that cannot be run here: name it under NOT CHECKED)`;

/**
 * What a worker is told when its thread has grown close to what a web chat takes: stop, and
 * write the hand-over the next worker starts from (experimental.ts runWorker).
 */
export const WRAP_UP = `Stop here: this thread's context is nearly full, and another worker with a fresh one goes on from your report. Run no more commands. Write the report now in the form you were given, with STATUS: PARTIAL. Under RESULT say exactly what is finished and true now. Under BLOCKERS write "LEFT TO DO:" and then, precisely, what remains and what you learned that the next worker needs (file names, formats, values, the command that checks the result), so that it does not have to read again what you read.`;

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
 * The finish check's reviewer (finish.ts): a fresh chat that reads the request against the
 * evidence and names at most three things the evidence does not show, each with the one command
 * that settles it. It gives no verdicts: the commands are run by code, and their exit codes are
 * the verdicts. It is given no account of the work in the workers' own words beyond what they
 * say they did NOT check.
 */
export function reviewPrompt(a: {
  request: string;
  cwd: string;
  /** Files changed this turn, with sizes and short excerpts. */
  files: string;
  /** Commands run this turn: exit code, command, the end of the output. */
  commands: string;
  /** What code has already checked (not to be asked again). */
  settled: string;
  /** What the work itself says it did not check ("" for nothing). */
  unchecked: string;
}): Prompt {
  const instructions = `You check a finished coding job before the answer goes to the person. You cannot run anything yourself: the commands you name are run for you, exactly as written, in the working folder.

Read THE REQUEST and the EVIDENCE: the files that were changed, with excerpts, and every command that was run, with its exit code and the end of its output. A command that ran the result and exited 0 shows that it runs; a file listed with a size exists. Never ask for what the evidence shows or what SETTLED BY CODE lists.

Name at most three things the request asks for that the evidence does NOT show and that decide whether the result works the way the request says it will be used: its stated usage never run on the real file; a case it names that no command exercised for real (an interrupt, a bad input, the edge of a format); a stated size, count or shape nobody checked. Most important first. A placeholder in an example of the request (testwordXY, N, <name>, ...) is not a literal: never require it.

For each give ONE check: a shell command (a short script is fine) that exits 0 only if the requirement holds and prints what it found. It runs from the working folder, takes no input, finishes within 30 seconds, installs nothing and changes none of the job's files. In exactly this form:

CHECK 1: <the requirement, in the request's words>
\`\`\`bash
<the command>
\`\`\`

If the evidence shows everything that matters, reply with only: ALL SHOWN`;
  const room = PROMPT_BUDGET - instructions.length - 260;
  const files = clipMiddle(a.files || "(none recorded)", 2000);
  const commands = a.commands || "(none recorded)";
  const settled = clipMiddle(a.settled || "(nothing)", 500);
  const unchecked = a.unchecked ? clipMiddle(a.unchecked, 400) : "";
  const req = requestExcerpt(
    a.request,
    Math.max(
      900,
      room - files.length - commands.length - settled.length - unchecked.length - a.cwd.length,
    ),
  ).text;
  return {
    instructions,
    input: `THE REQUEST, word for word:\n"""\n${req}\n"""\n\nWORKING FOLDER: ${a.cwd} (${platformLabel()})\n\nEVIDENCE, files changed:\n${files}\n\nEVIDENCE, commands run (exit code, command, end of output):\n${commands}\n\nSETTLED BY CODE (do not ask again):\n${settled}${unchecked ? `\n\nTHE WORK SAYS IT DID NOT CHECK:\n${unchecked}` : ""}`,
  };
}

// ---- Hyperexperimental -------------------------------------------------------------------------

const THINK_INSTRUCTIONS = `You direct a coding job one step at a time. You cannot touch the machine: you write what to do, an executor does exactly that, and you are shown the results. You remember nothing between steps; all that is known is below. MEMORY is kept by code: the steps so far and how each action ended. PINNED FILES are the files being worked on as they are on disk now, refreshed every step: never read them again. LAST RESULTS are shown this once: a fact from them you will need later, write as a line starting KEEP: and it stays in MEMORY. A long output is saved whole, and its result names the file and lines to READ: do not run a command again to see more of it. GOAL is the person's request word for word: use its names, paths and values exactly as written.

A step is up to 6 actions, run in order and stopped at the first that fails. Put looking, changing and checking in ONE step when they do not need each other's output (write the file, run it, show the result). Every command starts in FOLDER (a cd does not carry to the next action); a path outside FOLDER that the goal does not name is refused. Do not search outside FOLDER for tools: when one is missing, use what is there (python3) or say so.
- A command: in a \`\`\`bash block, run as one script exactly as written.
- A file you create or rewrite: once, whole, in a block fenced exactly like this (saved as written; never in a heredoc or an echo):
${FILE_BLOCK_HELP}
- A small change: a line REPLACE: <path>, then <<<, the exact old text, ===, the new text, >>>.
- Looking: READ: <path> <first>-<last> | LIST: <folder> | SEARCH: <regex> IN <path>
An action that repeats an earlier one with nothing changed since is not run again. After three steps that only look, the next must change or run something.
${VERIFY_RULES}

When the goal is reached and checked, reply with a line starting FINISHED: and the answer for the user: what was run to check it, then a line NOT CHECKED: <what was not, or nothing>. If the job cannot go on, reply BLOCKED: <what is missing>.`;

interface ThinkFrame {
  /** The request, as the person wrote it. */
  goal: string;
  exact?: string[];
  /** Where the whole request can be read, when this prompt cannot hold all of it. */
  requestFile?: string | null;
  /** What came before this request in the thread, in a line ("" when nothing). */
  before?: string;
  folder: string;
  step: number;
  /** What the turn may still spend, in words ("31 model calls, 14 minutes"). */
  left: string;
  /** A line code adds when the job is not moving (the look limit, a finish check's findings). */
  nudge?: string;
}

function thinkFrame(a: ThinkFrame): { head: string; tail: string; names: string; whole: boolean } {
  const goal = requestExcerpt(a.goal, 2200);
  const pointer =
    !goal.whole && a.requestFile
      ? `\n(Shortened here. All of it is in ${a.requestFile}: READ there what you need.)`
      : "";
  const before = a.before ? `\n${a.before}` : "";
  return {
    head: `GOAL:\n${goal.text}${pointer}${before}`,
    tail: `This is step ${a.step}. Left in this turn: ${a.left}.${a.nudge ? `\n${a.nudge}` : ""}`,
    names: exactLine(a.exact ?? [], 500),
    whole: goal.whole,
  };
}

/**
 * What a Think prompt has left for the working memory, the pinned files and the last results
 * together, once the instructions, the goal, the folder line and the closing line are in.
 */
export function thinkRoom(a: ThinkFrame): number {
  const f = thinkFrame(a);
  const names = f.whole ? 0 : f.names.length + 1;
  return (
    THINK_BUDGET -
    THINK_INSTRUCTIONS.length -
    f.head.length -
    names -
    a.folder.length -
    f.tail.length -
    110
  );
}

/**
 * The Think prompt. The three variable parts share what thinkRoom leaves: the memory as it is
 * given (hyper.ts renders it within its own bound), then the last results (shown once, so they
 * come before the pins: never less than a screenful), then the pinned files in what is left.
 */
export function thinkPrompt(
  a: ThinkFrame & {
    /** The working memory, rendered (memory.ts renderMemory). */
    memory: string;
    /** The pinned files, rendered within the room the caller worked out (memory.ts renderPins). */
    pins: string;
    /** The last step's results (shown once). */
    results: string;
  },
): Prompt {
  const f = thinkFrame(a);
  const room = thinkRoom(a);
  const memory = a.memory || "(nothing done yet)";
  // The names stand for what a shortened goal lost. Beside the whole goal they only repeat it:
  // then they are given when nothing else loses room for them.
  const need = memory.length + a.results.length + a.pins.length;
  const names = !f.whole || room - need >= f.names.length + 1 ? f.names : "";
  const left = room - (f.whole && names ? names.length + 1 : 0);
  const results = a.results
    ? clipMiddle(a.results, Math.max(900, left - memory.length - Math.min(a.pins.length, 300)))
    : "(none yet)";
  const pinRoom = left - memory.length - results.length;
  const pins =
    a.pins && a.pins.length <= pinRoom
      ? a.pins
      : a.pins
        ? clipMiddle(a.pins, Math.max(0, pinRoom))
        : "";
  return {
    instructions: THINK_INSTRUCTIONS,
    input: `${f.head}${names ? `\n${names}` : ""}\n\nFOLDER: ${a.folder}\n\nMEMORY:\n${memory}${pins && pinRoom >= 200 ? `\n\nPINNED FILES:\n${pins}` : ""}\n\nLAST STEP RESULTS:\n${results}\n\n${f.tail}`,
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

/**
 * The fold of Hyperexperimental's log (the only "summarize" call left): when the log of steps
 * outgrows its share of the memory, its oldest entries and the digest so far become a new digest.
 */
export function foldPrompt(a: {
  goal: string;
  exact?: string[];
  digest: string;
  kept: string[];
  /** The log entries being folded in, one per line. */
  entries: string;
}): Prompt {
  const names = exactLine(a.exact ?? [], 400);
  return {
    instructions: `You keep the digest of a coding job's earlier steps: with the KEPT FACTS it is all the job remembers of them. Rewrite the DIGEST so that it takes in STEPS TO FOLD IN. Keep: files created or changed with a few words on what each holds, what was found out (names of functions and columns, formats, values), what failed and why, what was decided, what is still open. Write names, paths and numbers exactly as they appear, and record only what the steps show (a command that failed, failed). Do not repeat a kept fact. Drop what no longer matters. Plain text, under 110 words, no preamble.`,
    input: `GOAL: ${clip(a.goal, 500)}${names ? `\n${names}` : ""}\n\nKEPT FACTS (already remembered):\n${a.kept.length ? a.kept.map((k) => `- ${k}`).join("\n") : "(none)"}\n\nDIGEST SO FAR:\n${a.digest || "(empty)"}\n\nSTEPS TO FOLD IN:\n${clipMiddle(a.entries, 3000)}`,
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
- Your context is small. Never print a long file or a long output whole: read ranges (sed -n '1,120p', head, tail, grep -n), and send a long command's output to a file and read the part you need.
- Input files may be the evidence the job is about: before a tool that can change a file opens it (sqlite3, a database or archive tool, a formatter, an installer), copy the file and work on the copy, and prefer read-only modes.
- Create or change files with apply_patch when you have it, otherwise with a heredoc. Keep changes small and in the style of the code around them. Use the names, paths and values of the request exactly as it writes them.
- Stay inside the working folder. Do not search the rest of the machine (the home folder, system folders, package caches) for tools or libraries: command -v <tool> or python3 -c "import <lib>" says at once whether one is there. If a check needs one that is missing, try once with what is there (python3 and its standard library); if that cannot do it, write "cannot execute: <tool> missing" under NOT CHECKED and finish the rest. Do not commit, push, reset or discard with git, and do not install anything globally, unless the task says so. Commands that force-delete (rm -f), use sudo or write outside the folder need an approval that may never come: do without them. In zsh, status and path are reserved variable names.
- When a command fails, read the error and fix the cause; never repeat the same command unchanged. If you are blocked (a refused permission, an unclear task), stop and say so.
- Before you report done, run the result the way the request says it will be used, including the failure cases it names, and check it against any size, count or shape the request states. Say what you ran and what you did not check.
- Do not ask questions: make the reasonable choice and mention it. No plans or narration between tool calls; end with one short report in the form the task asks for.`;
