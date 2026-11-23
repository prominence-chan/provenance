// Every prompt the orchestrators write, in one place so they can be read and measured.
//
// Budget: a plain call (planner, revise, final, think, translate, summarize) is at most
// PROMPT_BUDGET characters of instructions + input, about 2k tokens: a fraction of what a free
// web chat takes (~15k tokens; some message boxes stop near 25k characters). run.model() enforces
// it by cutting the middle of an over-long input. A worker's brief is at most BRIEF_BUDGET; what
// the stock harness adds around it (its own instructions and tool list, ~25k characters) is the
// harness's, and is the same for the first request of any thread.

import { clip, clipMiddle } from "./notes.ts";
import { ACTION_HELP, type MiniTask } from "./parse.ts";

export const PROMPT_BUDGET = 8000;
export const BRIEF_BUDGET = 4500;
/** Hyperexperimental's carried summary. */
export const SUMMARY_LIMIT = 2500;
/** The last step's results as the next Think sees them. */
export const RESULTS_LIMIT = 3500;

export interface Prompt {
  instructions: string;
  input: string;
}

const PLAN_FORMAT = `TASK 1: <what to do, naming the files>
DONE WHEN: <how the worker can tell it is done>
TASK 2: ...
DONE WHEN: ...`;

// ---- Experimental ------------------------------------------------------------------------------

export function plannerPrompt(request: string, folder: string, notes: string): Prompt {
  return {
    instructions: `You split a coding request into a short ordered list of small tasks. Each task goes to a separate worker that has tools (shell, file edits) but no memory: it sees only its own task, a one-line goal and brief notes from earlier tasks. So make each task small and self-contained (one file or one concern), say which files it touches, and put running or testing the code in the task that writes it or in a last task. Use as few tasks as the job needs, 1 to 6; a simple job is ONE task. Do not write code and do not explain.

Reply in plain text in exactly this form:
${PLAN_FORMAT}

If the request needs no work in the folder (a greeting, or a question the notes already answer), reply instead with one line: ANSWER: <your reply to the user>`,
    input: `REQUEST:\n${clipMiddle(request.trim(), 2500)}\n\nFOLDER: ${folder}\n\nNOTES FROM EARLIER WORK:\n${notes || "(none: this is the start)"}`,
  };
}

export function revisePrompt(
  request: string,
  notes: string,
  failed: MiniTask,
  report: string,
  remaining: MiniTask[],
): Prompt {
  const rest = remaining.length
    ? remaining.map((t, i) => `${i + 1}. ${clip(t.title, 200)}`).join("\n")
    : "(none)";
  return {
    instructions: `A coding job is split into small tasks for workers with no memory (each sees only its task and brief notes). One task just ran into a problem. Write the task list for what REMAINS so the job can still finish: try another approach, split the task, or leave out what cannot be done. Do not repeat a task the same way it already failed, and do not redo finished work. At most 5 tasks. Do not write code.

Reply in plain text in exactly this form:
${PLAN_FORMAT}

If nothing useful can still be done, reply instead with one line: ANSWER: <what is finished and what blocks the rest>`,
    input: `REQUEST:\n${clipMiddle(request.trim(), 1500)}\n\nNOTES:\n${notes}\n\nTASK THAT HIT A PROBLEM: ${clip(failed.title, 300)}\nITS REPORT:\n${clipMiddle(report.trim() || "(no report)", 900)}\n\nTASKS THAT WERE STILL PLANNED:\n${rest}`,
  };
}

export function workerBrief(a: {
  goal: string;
  task: MiniTask;
  index: number;
  total: number;
  later: MiniTask[];
  notes: string;
  cwd: string;
}): string {
  const later = a.later.length
    ? `\nLATER TASKS (other workers do these, not you): ${a.later.map((t) => clip(t.title, 80)).join("; ")}`
    : "";
  const text = `You are one worker in a larger job. This message is all you know; do only YOUR TASK, then stop.

OVERALL GOAL: ${clip(a.goal, 400)}
YOUR TASK (${a.index} of ${a.total}): ${a.task.title}
DONE WHEN: ${a.task.done || "the task is complete and you have checked it"}${later}

NOTES FROM EARLIER TASKS:
${a.notes || "(none: you are first)"}

Rules: work in ${a.cwd}. Do not redo earlier tasks or start later ones. Look before you change things, and check your work (run it) before you report. If you cannot finish, stop and say why rather than guess.

End with a short report in exactly this form:
RESULT: one or two sentences on what is true now
CHANGES: files you created or edited
VALIDATION: commands you ran and whether they passed
BLOCKERS: none, or what stopped you
STATUS: DONE or BLOCKED or PARTIAL`;
  return clipMiddle(text, BRIEF_BUDGET);
}

export function finalPrompt(request: string, notes: string, lastReport: string): Prompt {
  return {
    instructions: `Write the reply to the user for a coding job that workers just finished. Use only what is below. Say what was done and in which files, what a recorded command verified and what nobody verified, and any open problem. Do not claim more than the notes show. Under 120 words, plain text or light markdown, no preamble.`,
    input: `THE USER ASKED:\n${clipMiddle(request.trim(), 1200)}\n\nNOTES:\n${notes}\n\nLAST WORKER'S REPORT:\n${clipMiddle(lastReport.trim() || "(none)", 900)}`,
  };
}

// ---- Hyperexperimental -------------------------------------------------------------------------

export function thinkPrompt(a: {
  goal: string;
  folder: string;
  summary: string;
  results: string;
  step: number;
  stepsLeft: number;
}): Prompt {
  return {
    instructions: `You direct a coding job one small step at a time. You cannot touch the machine: you write, in plain words, what to do next, an executor does it, and you are shown the results. You have no memory; SUMMARY and LAST RESULTS below are everything known.

Say the next step concretely: the commands to run, the files to read, and for files to create or change the complete new content or the exact old and new text (write the code out in full). One small step, at most 5 actions. Do not repeat what the summary shows as done. Check the work (run it) before you finish.

When the goal is reached and checked, reply instead with a line starting FINISHED: followed by the answer for the user.`,
    input: `GOAL:\n${clipMiddle(a.goal.trim(), 1500)}\n\nFOLDER: ${a.folder}\n\nSUMMARY SO FAR:\n${a.summary || "(nothing done yet)"}\n\nLAST STEP RESULTS:\n${a.results || "(none yet)"}\n\nThis is step ${a.step}; ${a.stepsLeft} step${a.stepsLeft === 1 ? "" : "s"} left after it.`,
  };
}

export function translatePrompt(plan: string, cwd: string, platform: string): Prompt {
  return {
    instructions: `Turn the PLAN into actions for an executor. Output only actions, in order, in exactly this vocabulary:

${ACTION_HELP}

Rules: copy commands and file content exactly from the plan and add nothing the plan does not say. Paths are relative to the working folder. One RUN per command. WRITE replaces the whole file. At most 6 actions. No explanations. If the plan has nothing to execute, output NONE.`,
    input: `Working folder: ${cwd}\nPlatform: ${platform}\n\nPLAN:\n${clipMiddle(plan.trim(), 6000)}`,
  };
}

export function summarizePrompt(a: {
  goal: string;
  summary: string;
  intent: string;
  results: string;
}): Prompt {
  return {
    instructions: `You keep the running summary of a coding job; it is the only memory the job has. Rewrite it to include the latest step. Record only what the results show (a command that failed, failed). Keep: files created or changed with one line on what each holds, commands that passed or failed with the key error text, decisions made, and what is still left to do. Drop what no longer matters. Plain text, under 300 words, no preamble.`,
    input: `GOAL: ${clip(a.goal, 500)}\n\nPREVIOUS SUMMARY:\n${a.summary || "(empty)"}\n\nLATEST STEP, WHAT WAS INTENDED:\n${clipMiddle(a.intent.trim(), 900)}\n\nLATEST STEP, ACTIONS AND RESULTS:\n${a.results}`,
  };
}
