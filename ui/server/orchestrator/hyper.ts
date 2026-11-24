// Hyperexperimental: a job done one step at a time by a model that keeps nothing between steps,
// with a working memory that code keeps for it.
//
//   a. think      a new chat, no tools: the goal word for word, a one-line listing of the folder,
//                 the working memory, the pinned files and the last step's results -> what to do
//                 next (several actions when they are independent: look, change, check), or
//                 "FINISHED: <answer>", or "BLOCKED: <what is missing>". A file it wants written
//                 it gives once, whole, in a block fenced ```file:<path>; commands in ```bash
//                 blocks; looks and small changes as READ / LIST / SEARCH / REPLACE lines. A line
//                 "KEEP: <fact>" goes into the memory as written.
//   b. actions    file bodies and shell blocks are lifted out of that text verbatim (parse.ts
//                 liftFiles, liftCommands). When the text then holds nothing but those blocks and
//                 plain action lines, the actions are read straight from it (parse.ts directPlan):
//                 no model call. Only a reply that says what to do in prose goes to the translate
//                 chat (the folder, the platform and the text with markers for the lifted blocks;
//                 it never sees the goal or the memory and never copies a file).
//   c. execute    each action runs through the orchestrators' app-server as a sandboxed command
//                 (exec.ts), in order, stopped at the first that fails or is refused. Before it
//                 runs, code checks it: a path is read against the working folder and the
//                 request's own paths (a bare name the request gives in a subfolder is written
//                 there; a write outside the folder that the request does not name is refused);
//                 a leading `cd <the folder>` is dropped (every command starts there); an action
//                 that repeats an earlier one with nothing changed since is answered from memory
//                 instead of being run; and after `lookSteps` steps that only looked, a step that
//                 only looks again is refused.
//   d. remember   by code (memory.ts): a line in the log for the step (what was meant, each
//                 action and how it ended), the files written or read pinned and re-read from
//                 disk before the next Think, long outputs saved whole with the path and line
//                 range in the result. No model summarizes a step. When the log outgrows its
//                 share its oldest half is folded into a digest by one model call (the only
//                 "summarize" left), or by code when no call can be had.
//
// In the second benchmark round every step cost three model calls (think, translate, summarize)
// and four of six failed runs ended at the step limit re-reading a file or an output: the summary
// could not hold a file, its rewrite lost what earlier steps had found, and a long output was
// shown cut in the middle. Nine in ten translate replies only named the lifted blocks.
//
// Sandbox and approvals (the composer's preset, kept on the thread):
//   - Reading (READ, LIST, SEARCH) always runs under the read-only policy.
//   - RUN, WRITE and REPLACE run under the thread's own policy: read only -> the kernel sandbox
//     refuses writes; workspace write -> the thread's folder (plus temp folders, as in the stock
//     harness) and no network; full access -> unrestricted. Nothing is ever run with a wider
//     policy than the thread's, and there is no way for a model to ask for more.
//   - "Ask every time" (approval policy untrusted, or any policy this file doesn't know): each
//     RUN, WRITE and REPLACE is shown to the user first, with the page's usual approval card;
//     Deny skips it, and the model is told. "Approve for session" covers that exact command, or
//     file changes, in this thread until the app restarts. Auto / Read only / Full access don't
//     ask: the sandbox is the limit.
//
// How long a turn runs: there is no fixed number of steps to use up. A run that is advancing
// goes on until the turn's model calls or minutes are spent (Caps.modelCalls, turnMs; `steps` is
// a far backstop); one that is circling stops early: `noProgressSteps` steps in a row that change
// no file and run nothing new end the turn with what it has, said plainly. Two steps in a row
// that yield no action end it too.
//
// The request travels word for word: every Think gets it as written (whole when it fits its share
// of the prompt, else its head and tail with the path of a file that holds all of it), with the
// exact names code copied out of it (request.ts). Nothing exact passes through a model on the
// way to the machine.
//
// FINISHED is checked before it is the answer, once per turn that changed something (finish.ts):
// by code (every file the request names exists under exactly that name; nothing was written
// outside the folder; the last recorded command did not fail); a reviewer only when the answer
// names something as not checked or nothing ran the result, and then its checks are commands that
// code runs. Only a check that fails (or something code found) goes back to Think, with the
// command and its output, for at most FOLLOW_UP_STEPS more steps; the failing commands are then
// run again by code, and the answer says what stayed not verified.
//
// A turn that ends without FINISHED (no model after the retries, a guard, an interrupt, BLOCKED)
// leaves the memory and the request on the thread: the next message, "continue" or anything
// else, is thought about with both.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { folderBrief, platformName, StopTurn, type Run } from "./backend.ts";
import { mono } from "./clock.ts";
import { execute } from "./exec.ts";
import { deliverablesIn, requestFile } from "./experimental.ts";
import {
  codeFindings,
  findingCount,
  findingLines,
  finishText,
  fixLines,
  FIX_RULES,
  review,
  reviewWorth,
  runChecks,
  tailOf,
  uncheckedOf,
  type Check,
  type Evidence,
} from "./finish.ts";
import {
  addKept,
  addLog,
  emptyMemory,
  fingerprint,
  foldByCode,
  foldWith,
  MEMORY_LIMIT,
  needsFold,
  pin,
  PINS_LIMIT,
  renderMemory,
  renderPins,
  RESULTS_MAX,
  reviveMemory,
  saveOutput,
  seenNote,
  showOutput,
  takeForFold,
  outputDir,
  type Memory,
} from "./memory.ts";
import { clip, clipMiddle, ORIGINAL_LIMIT } from "./notes.ts";
import {
  balanceFences,
  describeAction,
  directPlan,
  isContinue,
  keepLines,
  liftCommands,
  liftFiles,
  lookOnly,
  parseActions,
  parseThought,
  restoreCommand,
  restorePath,
  tidyFences,
  type Action,
} from "./parse.ts";
import {
  foldPrompt,
  SUMMARY_LIMIT,
  THINK_BUDGET,
  thinkPrompt,
  thinkRoom,
  translatePrompt,
} from "./prompts.ts";
import { exactNames, requestExcerpt, strayPaths } from "./request.ts";

export {
  captureScript,
  lineDiff,
  mustAsk,
  parseCapturedEnv,
  replaceIn,
  userShell,
} from "./exec.ts";

/** Steps a failed check (or something code found) may take after a FINISHED that was not accepted. */
const FOLLOW_UP_STEPS = 4;
/** Kept back from the steps' budget: the closing of the turn. */
const RESERVE_MS = 30_000;
/** A file larger than this is not pinned (it is read in ranges). */
const PIN_MAX_BYTES = 200_000;

interface Job {
  original: string;
  exact: string[];
  deliverables: string[];
}

// ---- where an action points -------------------------------------------------------------------------

/**
 * A path an action names, read against the working folder and the request:
 *   - relative paths are relative to the folder; one that repeats the folder's own last
 *     segments ("app/src/a.py" in …/app, where only src/a.py exists) loses them;
 *   - a file that is not there under the name given, while the request names exactly one path
 *     with that file name elsewhere, is that path (the request said /…/polyglot/main.py.c, the
 *     step said `main.py.c`): the request's place is the right one;
 *   - a path outside the folder that the request does not name is refused for anything but a
 *     READ (temp folders, where long outputs and the request's own file are kept, are allowed).
 */
export function resolveTarget(
  p: string,
  cwd: string,
  job: Job,
  kind: Action["kind"],
): { path: string; note?: string; refuse?: string } {
  const root = cwd.replace(/\/+$/, "");
  const inside = (abs: string) => abs === root || abs.startsWith(`${root}/`);
  const shown = (abs: string) => (inside(abs) ? path.relative(root, abs) || "." : abs);
  const home = process.env.HOME || "";
  const abs = p.startsWith("~/") && home ? path.join(home, p.slice(2)) : path.resolve(root, p);
  if (!inside(abs)) {
    if (kind === "read") return { path: abs };
    const stray = strayPaths({ files: [abs], commands: [], reports: [] }, root, job.original);
    if (stray.length)
      return {
        path: p,
        refuse: `${p} is outside the working folder ${root}, and the request does not name it. Paths are relative to the working folder: give one inside it.`,
      };
    return { path: abs };
  }
  if (existsSync(abs)) return { path: shown(abs) };
  // The folder's own last segments repeated in front of a relative path.
  if (!path.isAbsolute(p)) {
    const segs = p.replace(/^\.\//, "").split("/").filter(Boolean);
    const tail = root.split("/").filter(Boolean);
    for (let n = Math.min(segs.length - 1, tail.length, 3); n >= 1; n--) {
      if (segs.slice(0, n).join("/") !== tail.slice(-n).join("/")) continue;
      const cand = path.resolve(root, segs.slice(n).join("/"));
      const fits =
        existsSync(cand) ||
        (kind === "write" && existsSync(path.dirname(cand)) && !existsSync(path.dirname(abs)));
      if (fits)
        return {
          path: shown(cand),
          note: `(${p} was read as ${shown(cand)}: paths are relative to the working folder, which already ends in ${tail.slice(-n).join("/")})`,
        };
    }
  }
  // The request's own path for a file of this name.
  if (kind === "write" || kind === "replace" || kind === "read") {
    const base = path.basename(abs);
    const targets = new Set<string>();
    for (const name of [...job.exact, ...job.deliverables]) {
      if (/\s/.test(name) || !/[./]/.test(name) || name.endsWith("/")) continue;
      if (path.basename(name) !== base) continue;
      const t =
        name.startsWith("~/") && home ? path.join(home, name.slice(2)) : path.resolve(root, name);
      if (t !== abs) targets.add(t);
    }
    if (targets.size === 1) {
      const t = [...targets][0];
      if (kind === "write" || existsSync(t))
        return {
          path: shown(t),
          note: `(the request names this file as ${shown(t)}: ${kind === "write" ? "it was written" : "it was taken from"} there, not at ${shown(abs)})`,
        };
    }
  }
  return { path: shown(abs) };
}

/** A RUN without a leading `cd <the working folder>`: every command starts there already. */
export function normaliseRun(command: string, cwd: string): string {
  const esc = cwd.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^\\s*cd\\s+(["']?)${esc}/?\\1\\s*(?:\\|\\|\\s*exit(?:\\s+\\d+)?\\s*)?(?:&&|;|\\n)\\s*`,
  );
  const rest = command.replace(re, "");
  return rest.trim() ? rest : command;
}

/**
 * The files a command that only looks printed (cat, nl, head, tail, sed -n 'a,bp'), with the
 * range where it gave one: what a step read with a RUN is pinned like what it read with a READ.
 * `VAR="…"` lines of the same script are filled in first.
 */
export function filesLooked(script: string): { path: string; start: number; end: number | null }[] {
  const vars = new Map<string, string>();
  for (const m of script.matchAll(/^\s*([A-Za-z_]\w*)=(["']?)([^"'\n$`]*)\2\s*$/gm))
    vars.set(m[1], m[3]);
  const text = script.replace(
    /\$\{?([A-Za-z_]\w*)\}?/g,
    (all, name: string) => vars.get(name) ?? all,
  );
  const out: { path: string; start: number; end: number | null }[] = [];
  const re =
    /(?:^|[\n;&|]\s*)(?:cat(?:\s+-[A-Za-z]+)*|nl(?:\s+-[A-Za-z]+(?:\s+[a-z])?)*|head(?:\s+-n?\s*(\d+))?|tail(?:\s+-n?\s*\+?\d+)?|sed\s+-n\s+(["'])(\d+),(\d+|\$)p\2)\s+(["']?)([^\s"'|;&<>$`*?]+)\5/g;
  for (const m of text.matchAll(re)) {
    const start = m[3] ? Number(m[3]) : 1;
    const end = m[3] ? (m[4] === "$" ? null : Number(m[4])) : m[1] ? Number(m[1]) : null;
    if (!out.some((o) => o.path === m[6])) out.push({ path: m[6], start, end });
  }
  return out;
}

/** A command as a result line shows it: its first lines, not all of a long script. */
function echo(command: string): string {
  const lines = command.split("\n");
  const head = lines.slice(0, 3).join("\n");
  const cut = head.length > 260 ? `${head.slice(0, 259)}…` : head;
  return lines.length > 3 ? `${cut}\n… (${lines.length} lines)` : cut;
}

function isText(file: string): string | null {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > PIN_MAX_BYTES) return null;
    const text = readFileSync(file, "utf8");
    return /[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 4000)) ? null : text;
  } catch {
    return null;
  }
}

export async function runHyper(run: Run): Promise<void> {
  const caps = run.caps;
  const cwd = run.cwd;
  // The request: this message, or, when the last turn stopped short, that turn's request with
  // this message after it ("continue" alone means just: go on). It is kept word for word, with
  // what code reads out of it on arrival: the exact names, and the files it names that are not
  // there yet (what has to exist at the end).
  const open = run.thread.openGoal ?? "";
  const resuming = !!open && isContinue(run.text);
  if (!resuming || !run.thread.job) {
    const original = resuming ? open : run.text.trim();
    run.thread.job = {
      original: original.length > ORIGINAL_LIMIT ? clipMiddle(original, ORIGINAL_LIMIT) : original,
      exact: exactNames(original),
      deliverables: deliverablesIn(original, cwd),
    };
  }
  const job = run.thread.job;
  const goal = job.original;
  const before =
    open && !resuming
      ? `(Before this message, this request was left unfinished: ${clip(open, 600)})`
      : "";
  run.thread.openGoal = resuming ? open : clipMiddle(run.text.trim(), 1500);
  const wholeAt = requestExcerpt(goal, 2200).whole ? null : requestFile(run.threadId, goal);
  const mem: Memory = reviveMemory(run.thread.memory, run.thread.summary);
  run.thread.memory = mem;
  const store = () => {
    const keys = Object.keys(mem.seen);
    for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete mem.seen[k];
    run.thread.summary = balanceFences(clipMiddle(renderMemory(mem), SUMMARY_LIMIT));
    run.save();
  };
  store();
  let results = "";
  let empty = 0;
  let refusedBefore = false;
  /** What this turn changed and ran: the finish check's material. */
  const turnFiles = new Map<string, string>();
  const turnCommands: Evidence[] = [];
  let lastCheck: { cmd: string; ok: boolean } | null = null;
  /** Results of commands that were more than a look, as seen so far (a new one is progress). */
  const ran = new Set<string>();
  /** The finish check, once per turn: its checks, and the steps run since for what failed. */
  let checked = false;
  let reviewed = false;
  let checks: Check[] = [];
  let skipped: string | null = null;
  let fixing = false;
  let fixWhy = "";
  let followSteps = 0;
  let pendingFinal = "";
  /** Steps in a row that only looked, and steps in a row that changed nothing and ran nothing new. */
  let looked = 0;
  let idle = 0;
  const found = () =>
    codeFindings({
      deliverables: job.deliverables,
      cwd,
      request: goal,
      files: [...turnFiles.keys()],
      commands: turnCommands.map((c) => c.cmd),
      reports: [],
      lastCheck,
    });
  const failedChecks = () => checks.filter((c) => c.state === "failed");
  /** The answer: what code found first, then the model's words, then what the check came to. */
  const finish = async (answer: string) => {
    // What failed is run once more, by code: the record decides, not the answer's words.
    if (fixing && followSteps > 0 && failedChecks().length)
      await runChecks(run, failedChecks(), goal);
    const f = found();
    const lines = findingLines(f);
    const facts = lines.length
      ? `**${f.gone.length ? "Not finished" : "Not verified"}.** ${lines.map((l) => `${l[0].toUpperCase()}${l.slice(1)}.`).join(" ")}\n\n`
      : "";
    const tail = finishText({
      reviewed,
      checks,
      fix: fixing || fixWhy ? { ran: followSteps > 0, why: fixWhy } : null,
      skipped,
      steps: true,
    });
    if (run.stats.finish) {
      run.stats.finish.passed = checks.filter((c) => c.state === "passed").length;
      run.stats.finish.open = checks.filter((c) => c.state !== "passed").length;
      run.stats.finish.code = findingCount(f);
    }
    run.say(`${facts}${answer}${tail ? `\n\n${tail}` : ""}`);
    // The job is over: its log and pins go, what it came to stays as what came before.
    const closing = `The request "${clip(goal, 300)}" was answered: ${clip(answer, 400)}`;
    run.thread.memory = emptyMemory(
      `${mem.carried ? `${mem.carried}\n\n` : ""}${closing}`.slice(-1400),
    );
    run.thread.summary = clipMiddle(`${renderMemory(mem)}\n\n${closing}`.trim(), SUMMARY_LIMIT);
    run.thread.openGoal = null;
    run.thread.job = null;
    run.save();
  };
  const frame = (step: number, nudge = "") => {
    const l = run.left();
    return {
      goal,
      exact: job.exact,
      requestFile: wholeAt,
      before,
      folder: folderBrief(cwd),
      step,
      left: `${Math.max(0, l.calls)} model call${l.calls === 1 ? "" : "s"}, ${Math.max(0, Math.round(l.ms / 60_000))} minute${Math.round(l.ms / 60_000) === 1 ? "" : "s"}`,
      nudge,
    };
  };
  for (let step = 1; ; step++) {
    run.check();
    // The guards: a backstop on steps, the turn's minutes and calls, and a job that is not moving.
    const stop = (message: string) => {
      store();
      return new StopTurn("cap", message);
    };
    if (step > caps.steps) {
      if (fixing) return finish(pendingFinal);
      throw stop(
        `Stopped after ${caps.steps} steps, the limit for one message. Send another message to go on from where things stand.`,
      );
    }
    if (run.left().ms < RESERVE_MS || run.left().calls < 1) {
      if (fixing) return finish(pendingFinal);
      throw stop(
        run.left().calls < 1
          ? `Stopped with the job partly done: this turn's ${caps.modelCalls} model calls are used. Send "continue" to go on from where things stand.`
          : `Stopped with the job partly done: ${Math.round((mono.now() - run.t0) / 60_000)} of this turn's ${Math.round(caps.turnMs / 60_000)} minutes are used. Send "continue" to go on from where things stand.`,
      );
    }
    if (idle >= caps.noProgressSteps) {
      if (fixing) return finish(pendingFinal);
      throw stop(
        `Stopped: ${idle} steps in a row changed no file and ran nothing new, so the job was not moving. What was done so far is below; say what to do differently, or send "continue" to try again from there.`,
      );
    }
    run.stats.steps = step;
    // a. think
    const mustAct = looked >= caps.lookSteps;
    const nudge = mustAct
      ? `(recorded) The last ${looked} steps only looked. This step must write a file, make a change or run something, or reply BLOCKED: with what is missing. A step that only looks again will not be run. What was read is in MEMORY, the PINNED FILES and the saved outputs.`
      : "";
    const fr = frame(step, nudge);
    const room = thinkRoom(fr);
    const memory = renderMemory(mem, Math.max(600, Math.min(MEMORY_LIMIT, room - 1500)));
    const contents = new Map<string, string | null>();
    for (const p of mem.pins) contents.set(p.path, isText(path.resolve(cwd, p.path)));
    const shownResults = results
      ? clipMiddle(results, Math.max(900, Math.min(RESULTS_MAX, room - memory.length - 300)))
      : "";
    const pins = renderPins(
      mem,
      contents,
      Math.min(PINS_LIMIT, room - memory.length - shownResults.length - 40),
    );
    const thinking = thinkPrompt({ ...fr, memory, pins, results: shownResults });
    // The reply's fences are put in order before anything is read out of it, and a line that
    // only repeats the end of our own prompt is not the model's (parse.ts tidyFences).
    const promptTail = thinking.input
      .split("\n")
      .filter((l) => l.trim())
      .slice(-2);
    const reply = tidyFences(
      await run.model("think", thinking, undefined, THINK_BUDGET),
      promptTail,
    );
    addKept(mem, keepLines(reply));
    const thought = parseThought(reply);
    if (thought.blocked !== null) {
      // The job cannot go on, and says why: the turn ends with that, and the request stays open.
      if (fixing) return finish(pendingFinal);
      const lines = findingLines(found());
      store();
      run.say(
        `**Not finished.** ${thought.blocked}${lines.length ? `\n\n${lines.map((l) => `${l[0].toUpperCase()}${l.slice(1)}.`).join(" ")}` : ""}\n\nWhere things stand:\n\n${renderMemory(mem)}`,
      );
      return;
    }
    if (thought.final !== null) {
      // The finish check, once per turn that changed something (finish.ts): what code can tell;
      // a reviewer only when it can add something, its checks run by code; and only what fails
      // goes back to Think, for at most FOLLOW_UP_STEPS more steps.
      const changed = turnFiles.size > 0 || turnCommands.length > 0;
      if (checked || !changed) return finish(thought.final);
      checked = true;
      const code = found();
      const lines = findingLines(code);
      const unchecked = uncheckedOf(thought.final);
      const rv = await review(run, {
        // (what code found goes straight to a fix: a reviewer adds nothing to a missing file)
        why: lines.length
          ? null
          : reviewWorth({
              changed,
              split: false,
              unchecked,
              commands: turnCommands.filter((c) => !lookOnly(c.cmd)),
            }),
        request: goal,
        deliverables: job.deliverables,
        files: [...turnFiles].map(([p, kind]) => ({ path: p, kind })),
        commands: turnCommands,
        unchecked,
      });
      reviewed = rv.reviewed;
      checks = rv.checks;
      skipped = rv.skipped;
      const failed = failedChecks();
      run.stats.finish = {
        requirements: checks.length,
        open: checks.filter((c) => c.state !== "passed").length,
        code: findingCount(code),
        followUps: 0,
        reviewed,
        passed: checks.filter((c) => c.state === "passed").length,
      };
      if (!failed.length && !lines.length) return finish(thought.final);
      const l = run.left();
      if (step >= caps.steps || l.calls < 3 || l.ms < 60_000 + RESERVE_MS) {
        fixWhy = "too little of this turn's budget was left to fix it";
        return finish(thought.final);
      }
      pendingFinal = thought.final;
      fixing = true;
      idle = 0;
      looked = 0;
      const n = failed.length + lines.length;
      run.say(
        `**Finish check:** ${n} thing${n === 1 ? "" : "s"} found after FINISHED (${[lines.length ? `${lines.length} by code` : "", failed.length ? `${failed.length} check${failed.length === 1 ? "" : "s"} failed` : ""].filter(Boolean).join(", ")}). Going on to fix ${n === 1 ? "it" : "them"}.`,
      );
      results = [
        "You said FINISHED. Before the answer went out it was checked, and this was found:",
        ...fixLines(failed, lines),
        `${FIX_RULES} Then reply FINISHED: with the answer, saying what was fixed and what was not checked.`,
      ].join("\n");
      continue;
    }
    if (fixing && followSteps >= FOLLOW_UP_STEPS) return finish(pendingFinal);
    if (fixing) {
      followSteps++;
      run.stats.finish!.followUps = followSteps;
    }
    run.say(thought.next);
    // b. the actions. File bodies and shell blocks stay here, verbatim; when the text holds
    // nothing else that could be an instruction, the actions are read from it directly. Only
    // prose goes to the translator, which sees a marker for each block, and what it does copy
    // (a one-line command, a path) is set back to the Think step's own spelling.
    const lifted = liftFiles(thought.next);
    const cmds = liftCommands(lifted.plan);
    const direct = directPlan(cmds.plan);
    if (direct.sure) run.stats.direct = (run.stats.direct ?? 0) + 1;
    const parsed = parseActions(
      direct.sure
        ? direct.text
        : await run.model("translate", translatePrompt(cmds.plan, cwd, platformName())),
      8,
      lifted.files,
      cmds.commands,
    );
    for (const a of parsed.actions) {
      if (a.kind === "run") {
        if (!cmds.commands.some((c) => c.script === a.command))
          a.command = restoreCommand(a.command, thought.next);
      } else if (a.kind !== "search" && !lifted.files.some((f) => f.path === a.path))
        a.path = restorePath(a.path, thought.next, job.exact);
    }
    // c. execute, in order, up to the first action that is refused or fails
    const lines: string[] = [];
    const outcomes: string[] = [];
    for (const problem of parsed.problems) lines.push(`(not understood) ${problem}`);
    for (const f of lifted.flagged) lines.push(`(not written) ${f}`);
    for (const c of cmds.skipped) lines.push(`(not run) ${c}`);
    const stopAt = parsed.rejected.length ? parsed.rejected[0].at : parsed.actions.length;
    const todo = parsed.actions.slice(0, stopAt);
    let notRun = parsed.actions.slice(stopAt);
    if (!todo.length) {
      if (parsed.rejected.length && !refusedBefore) {
        // The first time, a refused write is only fed back: the next think can give the file.
        refusedBefore = true;
      } else {
        empty++;
        if (!parsed.rejected.length)
          lines.push(
            "No action could be read from the last reply. Give commands in ```bash blocks, files in ```file:<path> blocks, and looks as READ: / LIST: / SEARCH: lines.",
          );
        if (empty >= 2) {
          if (fixing) return finish(pendingFinal);
          throw stop("Stopped: two steps in a row produced nothing that could be run.");
        }
      }
    } else {
      empty = 0;
      refusedBefore = false;
    }
    const isLook = (a: Action) =>
      a.kind === "read" ||
      a.kind === "list" ||
      a.kind === "search" ||
      (a.kind === "run" && lookOnly(a.command));
    const allLook = todo.length > 0 && todo.every(isLook);
    let progressed = false;
    let stopped = "";
    // What the next Think has room for: the results are cut to it here, line by line, not later.
    const nextRoom = thinkRoom(frame(step + 1, nudge));
    const budget = Math.max(
      1200,
      Math.min(
        RESULTS_MAX,
        nextRoom - Math.min(MEMORY_LIMIT, renderMemory(mem).length + 500) - 1500,
      ),
    );
    const share = Math.max(500, Math.floor((budget - 200) / Math.max(1, todo.length)) - 120);
    const refuse = (a: Action, why: string) => {
      run.stats.refused = (run.stats.refused ?? 0) + 1;
      lines.push(`${describe(a)}\n${why}`);
    };
    const describe = (a: Action) =>
      a.kind === "run" ? `RUN: ${echo(a.command)}` : describeAction(a);
    for (let n = 0; n < todo.length; n++) {
      const action = todo[n];
      run.check();
      if (stopped) break;
      // Where it points, and whether it is run at all.
      let note = "";
      if (action.kind === "run") {
        action.command = normaliseRun(action.command, cwd);
        const stray = strayPaths({ files: [], commands: [action.command], reports: [] }, cwd, goal);
        if (stray.length) {
          refuse(
            action,
            `(refused, not run) it writes to ${stray[0]}, which is outside the working folder ${cwd} and not named in the request.`,
          );
          outcomes.push(`REFUSED a command writing outside the folder (${stray[0]})`);
          stopped = "refused";
          notRun = [...todo.slice(n + 1), ...notRun];
          break;
        }
      } else if (action.kind !== "search" || action.path) {
        const at = resolveTarget(
          action.kind === "search" ? action.path! : action.path,
          cwd,
          job,
          action.kind,
        );
        if (at.refuse) {
          refuse(
            action,
            `(refused, nothing was ${action.kind === "write" || action.kind === "replace" ? "written" : "read"}) ${at.refuse}`,
          );
          outcomes.push(
            `REFUSED ${action.kind.toUpperCase()} ${clip(at.path, 80)} (outside the folder)`,
          );
          stopped = "refused";
          notRun = [...todo.slice(n + 1), ...notRun];
          break;
        }
        action.path = at.path;
        note = at.note ?? "";
      }
      const look = isLook(action);
      const sig =
        action.kind === "write" || action.kind === "replace" ? "" : describeAction(action);
      if (look && mustAct && allLook) {
        refuse(
          action,
          `(not run) ${looked} steps in a row only looked. Write a file, make a change or run something in this step, or reply BLOCKED: with what is missing.`,
        );
        continue;
      }
      const prior = sig ? mem.seen[sig] : undefined;
      if (prior && prior.version === mem.version) {
        // The same action with nothing changed since: its result is known.
        refuse(
          action,
          `(not run again: the same as in step ${prior.step}, and nothing has changed since) It came to: ${prior.note}`,
        );
        outcomes.push(
          `${describeAction(action).split("\n")[0].slice(0, 70)}: a repeat of step ${prior.step}, not run`,
        );
        continue;
      }
      const result = await execute(run, action);
      const short = clip(describeAction(action).split("\n")[0], 90);
      if (action.kind === "write" || action.kind === "replace") {
        lines.push(`${describeAction(action)}\n${result.text}${note ? `\n${note}` : ""}`);
        outcomes.push(
          `${short}: ${result.ok ? (result.changed ? "ok" : "ok, no change") : clip(result.text, 90)}`,
        );
        if (result.ok) {
          turnFiles.set(action.path, result.created ? "add" : "update");
          if (result.changed) {
            progressed = true;
            mem.version++;
          }
          // The file as it is now is pinned: nobody has to read it back.
          let at = 1;
          if (action.kind === "replace" && result.content) {
            const first = action.with.split("\n").find((l) => l.trim()) ?? "";
            const i = first
              ? result.content.split("\n").findIndex((l) => l.includes(first.trim()))
              : -1;
            at = Math.max(1, i - 14);
          }
          pin(mem, action.path, step, at);
        } else if (!result.declined) stopped = "failed";
      } else {
        const full = result.full ?? result.text;
        const code = result.exitCode ?? (result.ok ? 0 : 1);
        const saved = full.length > share ? saveOutput(run.threadId, step, n + 1, full) : null;
        const body =
          action.kind === "search" && result.ok && !full.trim()
            ? "(no matches)"
            : result.declined
              ? result.text
              : showOutput(full, share, saved);
        const exit =
          result.declined || code === 0 ? "" : `\n[exit ${code === 124 ? "124: timed out" : code}]`;
        lines.push(`${describe(action)}\n${body}${exit}${note ? `\n${note}` : ""}`);
        const end = clip(tailOf(full, 100, 1), 100);
        outcomes.push(
          `${short}: ${result.declined ? "declined" : code === 0 ? "ok" : `exit ${code}`}${!look && end ? ` "${end}"` : ""}`,
        );
        if (action.kind === "run" && !result.declined) {
          if (!look) {
            // More than a look: it may have changed things, and what it came to is evidence.
            mem.version++;
            const key = `${action.command}\u0000${code}\u0000${fingerprint(full)}`;
            if (!ran.has(key)) progressed = true;
            ran.add(key);
          }
          // The record: what was more than a look, and any command that failed. Only a command
          // that was more than a look counts as "the last check" (a failed `ls` is not one).
          if (!look) lastCheck = { cmd: action.command, ok: result.ok };
          if (!look || !result.ok)
            turnCommands.push({
              cmd: action.command,
              ok: result.ok,
              exit: code,
              tail: tailOf(full),
            });
          if (!result.ok && !look) stopped = "failed";
        }
        if (!result.declined)
          mem.seen[sig] = { step, version: mem.version, note: seenNote(code, full, saved) };
        // What was read is pinned too (never one of our own saved outputs).
        if (result.ok) {
          const inOut = (p: string) => path.resolve(cwd, p).startsWith(outputDir(run.threadId));
          if (action.kind === "read" && !inOut(action.path))
            pin(mem, action.path, step, action.start ?? 1, action.end);
          else if (action.kind === "run" && look)
            for (const f of filesLooked(action.command)) {
              const at = resolveTarget(f.path, cwd, job, "read");
              if (!inOut(at.path) && isText(path.resolve(cwd, at.path)) !== null)
                pin(mem, at.path, step, f.start, f.end);
            }
        }
      }
      if (stopped === "failed") notRun = [...todo.slice(n + 1), ...notRun];
    }
    for (const r of parsed.rejected) lines.push(`(refused, nothing was written or run) ${r.text}`);
    if (notRun.length)
      lines.push(
        `(not run, because the action before ${notRun.length === 1 ? "it" : "them"} ${stopped === "failed" ? "failed" : "was refused"}) ${notRun.map((a) => clip(describeAction(a).split("\n")[0], 80)).join("; ")}`,
      );
    if (parsed.unrun.length)
      lines.push(
        `(not run: no action named the reply's command block${parsed.unrun.length === 1 ? "" : "s"} ${parsed.unrun.join(", ")})`,
      );
    for (const r of parsed.rejected) outcomes.push(`REFUSED ${clip(r.text, 70)}`);
    // A step that only looked (or did nothing) is not the job moving.
    if (todo.length) looked = allLook ? looked + 1 : 0;
    idle = progressed ? 0 : idle + 1;
    results = balanceFences(clipMiddle(lines.join("\n\n"), RESULTS_MAX));
    // d. remember: the step's line in the log, by code; a fold when the log outgrows its share.
    // (what was meant: the reply's first line of prose; the blocks are not prose)
    const intent =
      cmds.plan
        .split("\n")
        .map((l) => l.trim())
        .find(
          (l) =>
            l &&
            !/^(?:`{3,}|~{3,}|KEEP\s*:|\[|<{3,}|>{3,}|={3,}|(?:READ|LIST|SEARCH|REPLACE)\s*:)/.test(
              l,
            ),
        ) ?? "";
    addLog(mem, step, intent, outcomes);
    if (needsFold(mem)) {
      const taken = takeForFold(mem);
      const entries = taken.map((e) => `${e.step}. ${e.text}`).join("\n");
      if (run.left().calls > 4) {
        try {
          foldWith(
            mem,
            taken,
            await run.model(
              "summarize",
              foldPrompt({ goal, exact: job.exact, digest: mem.digest, kept: mem.kept, entries }),
              500,
            ),
          );
        } catch (e) {
          if (!(e instanceof StopTurn) || e.kind !== "router" || run.interrupted) {
            mem.log.unshift(...taken);
            store();
            throw e;
          }
          // (nobody to write it up: the entries themselves, shortened; the turn goes on)
          foldByCode(mem, taken);
        }
      } else foldByCode(mem, taken);
    }
    store();
  }
}
