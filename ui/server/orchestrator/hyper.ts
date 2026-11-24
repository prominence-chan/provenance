// Hyperexperimental: every step is three new chats and one execution, and the only thing carried
// from step to step (and from turn to turn) is a summary.
//
//   a. think      a new chat, no tools: the goal, a one-line listing of the folder, the summary
//                 and the last step's results -> free-form text saying what to do next, or
//                 "FINISHED: <answer for the user>". A file it wants written it gives once, whole,
//                 in a block fenced ```file:<path>.
//   b. translate  another new chat: that text, the folder and the platform -> actions in a small
//                 fixed vocabulary (RUN, READ, LIST, SEARCH, WRITE, REPLACE; parse.ts reads it
//                 forgivingly). It never sees the goal, the summary or any history, and it never
//                 copies a file: the bodies are lifted out of the think text first (parse.ts
//                 liftFiles; a complete `cat > f <<'EOF'` heredoc counts too) and attached to the
//                 WRITE that names them, verbatim. Translate only decides the actions.
//   c. execute    each action runs through the orchestrators' app-server as a sandboxed command
//                 (command/exec with the thread's sandbox as an explicit policy; exec below), never
//                 a shell of our own. Rows appear in the thread as commands and file changes.
//                 A WRITE with no content, or a `cat > f` with no heredoc body, is refused before
//                 anything runs: what came before it in the step runs, the rest doesn't, and the
//                 next think is told what was refused and how to give the file.
//   d. summarize  a third new chat folds the step (what was intended, the actions and their cut
//                 results) into the summary, which is then cut to SUMMARY_LIMIT. Back to a.
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
// Environment: a RUN sees what a command of the stock harness's shell tool sees (shellEnv below),
// not what a bare login shell gives.
//
// Guards (backend.ts Caps): steps per turn, model calls per turn, time per command; and the turn
// stops when a step is the same as the one before it twice, or two steps in a row yield no action
// (a step whose only fault was a refused write is fed back once without counting).
//
// The request travels word for word: every Think gets it as written (whole when it fits its share
// of the prompt, else its head and tail with the path of a file that holds all of it), with the
// exact names code copied out of it (request.ts). Neither it nor anything exact passes through
// the translate step: file bodies and shell blocks are lifted out of the Think text and attached
// to the actions that name them, and a one-line command or a path the translator did retype is
// set back to the Think step's spelling where characters were lost (parse.ts restoreCommand).
//
// FINISHED is checked before it is the answer, once per turn that changed something: by code
// (every file the request names exists under exactly that name; nothing was written outside the
// folder to a path the request does not name; the last recorded command did not fail), then by
// one fresh chat that reads the request against what was recorded (prompts.ts reviewPrompt).
// What is open goes to the next Think as its results, for at most two more steps; the answer
// says what code found and what stayed not verified.
//
// A summary holds a few lines of a file, never the file. The Think prompt says so (what a step
// reads is shown once: use it now), the summarizer is asked to keep the facts the job needs from
// what was read, and after two steps in a row that only looked the next Think is told that
// nothing has been written yet and that reading again will not help.
//
// A turn that ends without FINISHED (no model after the retries, a guard, an interrupt) leaves
// the summary and the request on the thread: the next message, "continue" or anything else, is
// thought about with both.

import { userInfo } from "node:os";
import { command, fileChange, type Item } from "../fallback/items.ts";
import type { AppServer } from "./appserver.ts";
import {
  folderBrief,
  Interrupted,
  platformName,
  sandboxPolicyFor,
  StopTurn,
  errText,
  type Run,
} from "./backend.ts";
import { mono } from "./clock.ts";
import {
  codeFindings,
  deliverablesIn,
  filesEvidence,
  findingCount,
  findingLines,
  finishText,
  LOOKING_RE,
  requestFile,
  REVIEW_TOKENS,
} from "./experimental.ts";
import { clip, clipMiddle, ORIGINAL_LIMIT } from "./notes.ts";
import {
  describeAction,
  isContinue,
  liftCommands,
  liftFiles,
  parseActions,
  parseThought,
  restoreCommand,
  restorePath,
  type Action,
} from "./parse.ts";
import {
  RESULTS_LIMIT,
  reviewPrompt,
  SUMMARY_LIMIT,
  summarizePrompt,
  thinkPrompt,
  translatePrompt,
} from "./prompts.ts";
import {
  exactNames,
  parseReview,
  requestExcerpt,
  type Review,
  type ReviewItem,
} from "./request.ts";

type Json = Record<string, unknown>;

const MAX_WRITE_CHARS = 200_000;
const READ_LINES = 250;
/** Steps the finish check may add after a FINISHED it did not accept (then the turn ends anyway). */
const FOLLOW_UP_STEPS = 2;
/** Kept back from the steps' budget: the finish check's one call. */
const RESERVE_MS = 30_000;

export async function runHyper(run: Run): Promise<void> {
  const caps = run.caps;
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
      deliverables: deliverablesIn(original, run.cwd),
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
  run.save();
  let summary = run.thread.summary;
  let results = "";
  let lastSig = "";
  let repeats = 0;
  let empty = 0;
  let refusedBefore = false;
  /** What this turn changed and ran: the finish check's material. */
  const turnFiles = new Map<string, string>();
  const turnCommands: { cmd: string; ok: boolean }[] = [];
  let lastCheck: { cmd: string; ok: boolean } | null = null;
  /** The finish check, once per turn: what it left open, and the steps run for it since. */
  let review: Review | null = null;
  let openItems: ReviewItem[] = [];
  let checked = false;
  let skipped: string | null = null;
  let followSteps = 0;
  /** Steps in a row that only looked (read, listed, searched): the job is not moving. */
  let looked = 0;
  const found = () =>
    codeFindings({
      deliverables: job.deliverables,
      cwd: run.cwd,
      request: goal,
      files: [...turnFiles.keys()],
      commands: turnCommands.map((c) => c.cmd),
      reports: [],
      lastCheck,
    });
  /** The answer: what code found first, then the model's words, then what the check left open. */
  const finish = (answer: string, settled: boolean) => {
    const lines = findingLines(found());
    const facts = lines.length
      ? `**${found().gone.length ? "Not finished" : "Not verified"}.** ${lines.map((l) => `${l[0].toUpperCase()}${l.slice(1)}.`).join(" ")}\n\n`
      : "";
    const tail = finishText({
      review,
      open: openItems,
      followUp: followSteps
        ? {
            ran: true,
            done: settled,
            result: "",
            why: "the steps allowed for it ran out",
          }
        : null,
      skipped,
      steps: true,
    });
    run.say(`${facts}${answer}${tail ? `\n\n${tail}` : ""}`);
    run.thread.summary = clipMiddle(
      `${summary}\n\nThe request "${clip(goal, 300)}" was answered: ${clip(answer, 400)}`.trim(),
      SUMMARY_LIMIT,
    );
    run.thread.openGoal = null;
    run.thread.job = null;
    run.save();
  };
  let pendingFinal = "";
  for (let step = 1; ; step++) {
    run.check();
    if (step > caps.steps) {
      // (the steps ran out while the finish check's points were being settled: an answer, not a guard)
      if (followSteps) return finish(pendingFinal, false);
      throw new StopTurn(
        "cap",
        `Stopped after ${caps.steps} steps, the limit for one message. Send another message to go on from the summary.`,
      );
    }
    if (run.left().ms < RESERVE_MS) {
      if (followSteps) return finish(pendingFinal, false);
      throw new StopTurn(
        "cap",
        `Stopped with the job partly done: ${Math.round((mono.now() - run.t0) / 60_000)} of this turn's ${Math.round(caps.turnMs / 60_000)} minutes are used. Send "continue" to go on from the summary.`,
      );
    }
    run.stats.steps = step;
    // a. think
    const stepsLeft = followSteps
      ? Math.min(caps.steps - step, FOLLOW_UP_STEPS - followSteps)
      : caps.steps - step;
    const thought = parseThought(
      await run.model(
        "think",
        thinkPrompt({
          goal,
          exact: job.exact,
          requestFile: wholeAt,
          before,
          folder: folderBrief(run.cwd),
          summary,
          results,
          step,
          stepsLeft,
        }),
      ),
    );
    if (thought.final !== null) {
      // The finish check, once per turn that changed something: what code can tell, then one
      // fresh reader of the request against what was recorded. What is open goes back to the
      // next Think as its results, for at most FOLLOW_UP_STEPS more steps.
      const changed = turnFiles.size > 0 || turnCommands.length > 0;
      if (checked || !changed) return finish(thought.final, true);
      checked = true;
      const code = found();
      const lines = findingLines(code);
      if (run.left().calls >= 1) {
        try {
          review = parseReview(
            await run.model(
              "review",
              reviewPrompt({
                request: goal,
                exact: job.exact,
                files: filesEvidence(
                  [...turnFiles].map(([p, kind]) => ({ path: p, kind })),
                  job.deliverables,
                  run.cwd,
                ),
                commands: turnCommands
                  .slice(-14)
                  .map((c) => `- ${c.ok ? "ok" : "FAILED"}: ${clip(c.cmd, 150)}`)
                  .join("\n"),
                found: lines.map((l) => `- ${l}`).join("\n"),
                claims: `- ${clip(thought.final, 400)}`,
              }),
              REVIEW_TOKENS,
            ),
          );
          if (!review.items.length) {
            review = null;
            skipped = "the reviewer's reply could not be read";
          } else openItems = review.open;
        } catch (e) {
          if (!(e instanceof StopTurn) || run.interrupted) throw e;
          skipped = "the reviewer could not be reached";
        }
      } else skipped = "this turn's model calls were used up";
      run.stats.finish = {
        requirements: review?.items.length ?? 0,
        open: openItems.length,
        code: findingCount(code),
        followUps: 0,
      };
      const canGoOn = caps.steps - step >= 1 && run.left().calls >= 4;
      if ((!openItems.length && !lines.length) || !canGoOn) {
        if (openItems.length || lines.length) skipped ??= "no step was left for it";
        return finish(thought.final, true);
      }
      pendingFinal = thought.final;
      run.say(
        `**Finish check:** ${openItems.length + lines.length} point${openItems.length + lines.length === 1 ? "" : "s"} not shown by what was recorded. Going on to settle ${openItems.length + lines.length === 1 ? "it" : "them"}.`,
      );
      results = clipMiddle(
        [
          "You said FINISHED. Before the answer goes out, a reviewer read the request against what was recorded. These points are open:",
          ...lines.map((l) => `- (recorded) ${l}`),
          ...openItems.map(
            (o) =>
              `- ${o.verdict === "violated" ? "VIOLATED" : "NOT SHOWN"}: ${clip(o.requirement, 200)}${o.note ? ` — ${clip(o.note, 200)}` : ""}`,
          ),
          "Run the check named for each (or a better one) on the real result, the way the request says it will be used. Where a check fails or a point is violated, fix the work and check again. A file the request names must exist under exactly that name and place. Then reply FINISHED: with the answer, saying which points were checked and how, and which were not.",
        ].join("\n"),
        RESULTS_LIMIT,
      );
      continue;
    }
    if (followSteps >= FOLLOW_UP_STEPS) return finish(pendingFinal, false);
    if (checked) {
      followSteps++;
      run.stats.finish!.followUps = followSteps;
    }
    run.say(thought.next);
    // b. translate: the file bodies and the shell blocks stay here; the translator sees a marker
    // for each, and what it does copy (a one-line command, a path) is set back to the Think
    // step's own spelling where the copy lost or changed characters.
    const lifted = liftFiles(thought.next);
    const cmds = liftCommands(lifted.plan);
    const parsed = parseActions(
      await run.model("translate", translatePrompt(cmds.plan, run.cwd, platformName())),
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
    // c. execute, up to the first refused action
    const lines: string[] = [];
    for (const problem of parsed.problems) lines.push(`(not understood) ${problem}`);
    const stopAt = parsed.rejected.length ? parsed.rejected[0].at : parsed.actions.length;
    const todo = parsed.actions.slice(0, stopAt);
    const skippedActions = parsed.actions.slice(stopAt);
    if (!todo.length) {
      if (parsed.rejected.length && !refusedBefore) {
        // The first time, a refused write is only fed back: the next think can give the file.
        refusedBefore = true;
      } else {
        empty++;
        if (!parsed.rejected.length)
          lines.push(
            "No action could be read from the last plan. Say the commands concretely, and give file content in a file block.",
          );
        if (empty >= 2) {
          if (followSteps) return finish(pendingFinal, false);
          throw new StopTurn(
            "cap",
            "Stopped: two steps in a row produced nothing that could be run.",
          );
        }
      }
    } else {
      empty = 0;
      refusedBefore = false;
    }
    const sig = todo.map(signature).join("\n");
    if (sig && sig === lastSig) {
      repeats++;
      if (repeats >= 2) {
        if (followSteps) return finish(pendingFinal, false);
        throw new StopTurn("cap", "Stopped: the same step came back three times in a row.");
      }
    } else repeats = 0;
    lastSig = sig;
    let onlyLooked = todo.length > 0;
    for (const action of todo) {
      run.check();
      const result = await execute(run, action);
      lines.push(`${describeAction(action)}\n${result.text}`);
      if (
        action.kind === "write" ||
        action.kind === "replace" ||
        (action.kind === "run" && !LOOKING_RE.test(action.command))
      )
        onlyLooked = false;
      // Recorded, for the finish check: what was written, and the commands that were more than a look.
      if (action.kind === "run") {
        if (!result.declined && (!result.ok || !LOOKING_RE.test(action.command))) {
          lastCheck = { cmd: action.command, ok: result.ok };
          turnCommands.push(lastCheck);
        }
      } else if ((action.kind === "write" || action.kind === "replace") && result.ok)
        turnFiles.set(action.path, result.created ? "add" : "update");
    }
    for (const r of parsed.rejected) lines.push(`(refused, nothing was written or run) ${r.text}`);
    if (skippedActions.length)
      lines.push(
        `(not run, because of the refused action before ${skippedActions.length === 1 ? "it" : "them"}) ${skippedActions.map(describeAction).join("; ")}`,
      );
    if (parsed.unrun.length)
      lines.push(
        `(not run: no action named the plan's command block${parsed.unrun.length === 1 ? "" : "s"} ${parsed.unrun.join(", ")})`,
      );
    // A summary holds a few lines of a file, not the file: a Think that keeps reading to "have
    // it all" before it writes never gets there. After two steps of only looking it is told so.
    looked = onlyLooked ? looked + 1 : 0;
    if (looked >= 2)
      lines.unshift(
        `(recorded) The last ${looked} steps only looked; nothing was written or run. What a step reads is shown once, here below, and will not be shown again: write the files or make the change now from what is here, rather than reading again.`,
      );
    results = clipMiddle(lines.join("\n\n"), RESULTS_LIMIT);
    // d. summarize
    let next: string;
    try {
      next = await run.model(
        "summarize",
        summarizePrompt({ goal, exact: job.exact, summary, intent: cmds.plan, results }),
        900,
      );
    } catch (e) {
      if (!(e instanceof StopTurn) || e.kind !== "router" || run.interrupted) throw e;
      // Keep what happened even if nobody could write it up; the turn ends on this error.
      run.thread.summary = clipMiddle(
        `${summary}\n\nStep ${step} ran but was not summarized (no model): ${clipMiddle(results, 700)}`.trim(),
        SUMMARY_LIMIT,
      );
      run.save();
      throw e;
    }
    summary = clipMiddle(next.trim(), SUMMARY_LIMIT);
    run.thread.summary = summary;
    run.save();
  }
}

function signature(a: Action): string {
  return a.kind === "write"
    ? `write ${a.path} ${a.content.length}`
    : a.kind === "replace"
      ? `replace ${a.path} ${a.find.length} ${a.with.length}`
      : describeAction(a);
}

// ---- execute ---------------------------------------------------------------------------

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let processSeq = 0;

/**
 * One sandboxed command through app-server (command/exec): `policy` is always explicit, the
 * thread's folder is the working directory, and an interrupt terminates the process.
 */
async function sandboxed(
  run: Run,
  argv: string[],
  policy: Json,
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<ExecResult> {
  run.check();
  const processId = `orc-${process.pid}-${++processSeq}`;
  const as = run.appServer;
  const onAbort = () => void as.request("command/exec/terminate", { processId }).catch(() => {});
  run.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const r = await as.request("command/exec", {
      command: argv,
      processId,
      cwd: run.cwd,
      sandboxPolicy: policy,
      timeoutMs,
      outputBytesCap: 256 * 1024,
      ...(env ? { env } : {}),
    });
    if (run.signal.aborted) throw new Interrupted();
    return {
      exitCode: typeof r.exitCode === "number" ? r.exitCode : -1,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
    };
  } catch (e) {
    if (e instanceof Interrupted || run.signal.aborted) throw new Interrupted();
    return { exitCode: -1, stdout: "", stderr: `could not run: ${errText(e)}` };
  } finally {
    run.signal.removeEventListener("abort", onAbort);
  }
}

const READ_ONLY: Json = { type: "readOnly", networkAccess: false };

// ---- the environment of a RUN ------------------------------------------------------------------
//
// What a command of the stock harness's shell tool sees (codex-rs core: shell_snapshot.rs,
// tools/runtimes/mod.rs maybe_wrap_shell_lc_with_snapshot, unified_exec/process_manager.rs):
//   1. once per thread the harness runs the user's login shell (`$SHELL -lc`) with a prefix that
//      also sources the interactive rc file (~/.zshrc, ~/.bashrc), and snapshots every exported
//      variable (PATH included);
//   2. each command then runs in a NON-login shell (`$SHELL -c`) with the snapshot's exports laid
//      over the app-server's environment plus a few fixed values (no colours, no pager).
// A bare `zsh -lc <command>`, which is what command/exec was given before, differs in both: it
// never reads ~/.zshrc (where pyenv, nvm and the like usually put themselves on PATH), and macOS's
// /etc/zprofile (path_helper) moves the system folders to the front of PATH on every command: the
// user's python3 lost to /usr/bin/python3.
//
// command/exec has no snapshot and no switch for one, but it takes `env` overrides. So the same
// two steps are done here: capture the exported environment once (per app-server and folder,
// refreshed after ENV_TTL_MS) with the harness's own prefix, under the read-only policy, then run
// each RUN as `$SHELL -c` with those exports as `env`. If the capture fails, RUN falls back to
// `-lc` as before.

/** The fixed values the shell tool sets (UNIFIED_EXEC_ENV); the captured exports go over them. */
const TOOL_ENV: Record<string, string> = {
  NO_COLOR: "1",
  TERM: "dumb",
  LANG: "C.UTF-8",
  LC_CTYPE: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  COLORTERM: "",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
  CODEX_CI: "1",
};
/** The harness's rc prefixes (shell-command/src/startup.rs), their output dropped. */
const RC_PREFIX: Record<string, string> = {
  zsh: `{ if [[ -n "\${ZDOTDIR-}" ]]; then rc="$ZDOTDIR/.zshrc"; elif [[ -n "\${HOME-}" ]]; then rc="$HOME/.zshrc"; else rc=; fi; [[ -r "$rc" ]] && . "$rc"; } >/dev/null 2>&1 </dev/null`,
  bash: `{ if [ -z "\${BASH_ENV-}" ] && [ -n "\${HOME-}" ] && [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi; } >/dev/null 2>&1 </dev/null`,
};
const ENV_MARK = "__ORC_ENV_BEGIN__";
const ENV_TTL_MS = 10 * 60_000;
/** Not carried over: the shell sets these itself for each command. */
const ENV_SKIP = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

/** The user's login shell, as the harness picks it; zsh on macOS and sh elsewhere if unknown. */
export function userShell(): string {
  let shell = "";
  try {
    shell = userInfo().shell ?? "";
  } catch {
    // no passwd entry
  }
  shell ||= process.env.SHELL ?? "";
  if (/\/(?:zsh|bash)$/.test(shell)) return shell;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

/** The script that prints the exported environment the shell tool's snapshot would hold. */
export function captureScript(shell: string): string | null {
  const prefix = RC_PREFIX[shell.split("/").pop() ?? ""];
  if (!prefix) return null;
  return `${prefix}\nprintf '\\n%s\\n' ${ENV_MARK}\nenv -0 | base64`;
}

/** `env -0 | base64` after the marker -> the variables (null when it can't be read). */
export function parseCapturedEnv(stdout: string): Record<string, string> | null {
  const at = stdout.lastIndexOf(ENV_MARK);
  if (at === -1) return null;
  const raw = Buffer.from(
    stdout.slice(at + ENV_MARK.length).replace(/\s+/g, ""),
    "base64",
  ).toString("utf8");
  const env: Record<string, string> = {};
  for (const entry of raw.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ENV_SKIP.has(key)) continue;
    if (key.startsWith("CODEX_SANDBOX")) continue; // set for the capture's own sandbox, not the user's
    env[key] = entry.slice(eq + 1);
  }
  return env.PATH ? env : null;
}

interface ShellEnv {
  shell: string;
  /** null: the capture failed; RUN uses a login shell as before. */
  env: Record<string, string> | null;
  at: number;
}
const shellEnvs = new WeakMap<AppServer, Map<string, Promise<ShellEnv>>>();

/** The shell and environment a RUN in this thread's folder gets (captured once, then reused). */
async function shellEnv(run: Run): Promise<ShellEnv> {
  const as = run.appServer;
  let byCwd = shellEnvs.get(as);
  if (!byCwd) shellEnvs.set(as, (byCwd = new Map()));
  const cached = byCwd.get(run.cwd);
  if (cached) {
    const got = await cached;
    if (mono.now() - got.at < ENV_TTL_MS) return got;
  }
  const shell = userShell();
  const script = captureScript(shell);
  const capture = (async (): Promise<ShellEnv> => {
    if (!script) return { shell, env: null, at: mono.now() };
    try {
      const r = await as.request("command/exec", {
        command: [shell, "-lc", script],
        cwd: run.cwd,
        sandboxPolicy: READ_ONLY,
        timeoutMs: 15_000,
        outputBytesCap: 1024 * 1024,
      });
      const env =
        r.exitCode === 0 && typeof r.stdout === "string" ? parseCapturedEnv(r.stdout) : null;
      if (!env)
        run.backend.log(`couldn't read the shell environment (${shell}); RUN uses a login shell`);
      return { shell, env: env ? { ...TOOL_ENV, ...env } : null, at: mono.now() };
    } catch (e) {
      run.backend.log(`couldn't read the shell environment: ${errText(e)}`);
      return { shell, env: null, at: mono.now() };
    }
  })();
  byCwd.set(run.cwd, capture);
  const got = await capture;
  run.check();
  return got;
}

/** Does the thread's approval preset want the user asked before this? Unknown policies ask. */
export function mustAsk(approvalPolicy: unknown): boolean {
  return approvalPolicy !== "never" && approvalPolicy !== "on-request";
}

function output(r: ExecResult, limit = 1400): string {
  const text = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join("\n");
  const body = text ? clipMiddle(text, limit) : "(no output)";
  return r.exitCode === 0
    ? body
    : `${body}\n[exit ${r.exitCode === 124 ? "124: timed out" : r.exitCode}]`;
}

/** What an action came to: the text the next Think is told, and whether it did what it was for. */
interface Done {
  text: string;
  ok: boolean;
  /** The user declined it (it did not run). */
  declined?: boolean;
  /** A write that made a new file. */
  created?: boolean;
}

/** Run one action; returns what the next Think is told about it. */
async function execute(run: Run, a: Action): Promise<Done> {
  const cwd = run.cwd;
  const policy = sandboxPolicyFor(run.thread.sandbox, cwd);
  const ask = mustAsk(run.thread.approvalPolicy);
  const session = (run.backend.sessionApprovals.get(run.threadId) ??
    run.backend.sessionApprovals
      .set(run.threadId, { commands: new Set(), files: false })
      .get(run.threadId))!;
  const id = run.nextId("act");
  const t0 = mono.now();
  switch (a.kind) {
    case "read":
    case "list":
    case "search": {
      const argv =
        a.kind === "read"
          ? [
              "/bin/sh",
              "-c",
              'sed -n "$2,$3p" "$1" && printf "[lines %s-%s of %s]\\n" "$2" "$3" "$(wc -l < "$1" | tr -d " ")"',
              "sh",
              a.path,
              String(a.start ?? 1),
              String(a.end ?? (a.start ?? 1) + READ_LINES - 1),
            ]
          : a.kind === "list"
            ? ["/bin/sh", "-c", 'ls -la "$1" | head -n 80', "sh", a.path]
            : [
                "/bin/sh",
                "-c",
                'grep -rnIE --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.venv -e "$1" "$2" | head -n 60',
                "sh",
                a.pattern,
                a.path ?? ".",
              ];
      const shown = describeAction(a);
      const actions =
        a.kind === "read"
          ? [
              {
                type: "read" as const,
                command: shown,
                name: a.path.split("/").pop() ?? a.path,
                path: a.path,
              },
            ]
          : a.kind === "list"
            ? [{ type: "listFiles" as const, command: shown, path: a.path }]
            : [{ type: "search" as const, command: shown, query: a.pattern, path: a.path }];
      run.start(command(id, shown, cwd, { status: "inProgress", actions }));
      const r = await sandboxed(run, argv, READ_ONLY, 30_000);
      const text = output(r, a.kind === "read" ? 2400 : 1400);
      run.complete(
        command(id, shown, cwd, {
          status: r.exitCode === 0 ? "completed" : "failed",
          output: text,
          exitCode: r.exitCode,
          actions,
          durationMs: Math.round(mono.now() - t0),
        }),
      );
      return {
        text: a.kind === "search" && r.exitCode === 0 && !r.stdout.trim() ? "(no matches)" : text,
        ok: r.exitCode === 0,
      };
    }
    case "run": {
      run.start(command(id, a.command, cwd, { status: "inProgress" }));
      if (ask && !session.commands.has(a.command)) {
        const answer = await run.ask("item/commandExecution/requestApproval", {
          itemId: id,
          command: a.command,
          cwd,
          reason: null,
        });
        run.check();
        if (answer.decision === "acceptForSession") session.commands.add(a.command);
        else if (answer.decision !== "accept") {
          run.complete(command(id, a.command, cwd, { status: "declined" }));
          if (answer.decision === "cancel") run.interrupt();
          run.check();
          return { text: "[the user declined to run this command]", ok: false, declined: true };
        }
      }
      // The shell tool's way: a non-login shell over the captured environment (see shellEnv).
      const sh = await shellEnv(run);
      const r = sh.env
        ? await sandboxed(run, [sh.shell, "-c", a.command], policy, run.caps.commandMs, sh.env)
        : await sandboxed(run, [sh.shell, "-lc", a.command], policy, run.caps.commandMs);
      const text = output(r);
      run.complete(
        command(id, a.command, cwd, {
          status: r.exitCode === 0 ? "completed" : "failed",
          output: text,
          exitCode: r.exitCode,
          durationMs: Math.round(mono.now() - t0),
        }),
      );
      return { text, ok: r.exitCode === 0 };
    }
    case "write":
    case "replace": {
      const before = await sandboxed(
        run,
        ["/bin/sh", "-c", 'cat "$1"', "sh", a.path],
        READ_ONLY,
        30_000,
      );
      const exists = before.exitCode === 0;
      let content: string;
      if (a.kind === "write") content = a.content;
      else {
        if (!exists) {
          const item = fileChange(id, [{ path: a.path, kind: "update", diff: "" }], "failed");
          run.complete(item, true);
          return {
            text: `[failed: ${a.path} does not exist or cannot be read; use WRITE to create it]`,
            ok: false,
          };
        }
        const replaced = replaceIn(before.stdout, a.find, a.with);
        if (replaced === null) {
          run.complete(
            fileChange(id, [{ path: a.path, kind: "update", diff: "" }], "failed"),
            true,
          );
          return {
            text: `[failed: the old text was not found in ${a.path}; READ the file and copy the exact text]`,
            ok: false,
          };
        }
        content = replaced;
      }
      if (content && !content.endsWith("\n")) content += "\n";
      if (content.length > MAX_WRITE_CHARS) {
        run.complete(fileChange(id, [{ path: a.path, kind: "update", diff: "" }], "failed"), true);
        return {
          text: `[failed: ${content.length} characters is more than one write takes (${MAX_WRITE_CHARS})]`,
          ok: false,
        };
      }
      const kind = exists ? "update" : "add";
      const change = [
        { path: a.path, kind, diff: lineDiff(exists ? before.stdout : "", content) } as const,
      ];
      const item = (status: "inProgress" | "completed" | "failed" | "declined"): Item =>
        fileChange(id, [...change], status);
      run.start(item("inProgress"));
      if (ask && !session.files) {
        const answer = await run.ask("item/fileChange/requestApproval", {
          itemId: id,
          reason: null,
          grantRoot: null,
        });
        run.check();
        if (answer.decision === "acceptForSession") session.files = true;
        else if (answer.decision !== "accept") {
          run.complete(item("declined"));
          if (answer.decision === "cancel") run.interrupt();
          run.check();
          return { text: "[the user declined this file change]", ok: false, declined: true };
        }
      }
      const r = await sandboxed(
        run,
        [
          "/bin/sh",
          "-c",
          'mkdir -p "$(dirname "$1")" && printf %s "$2" | base64 --decode > "$1"',
          "sh",
          a.path,
          Buffer.from(content, "utf8").toString("base64"),
        ],
        policy,
        30_000,
      );
      run.complete(item(r.exitCode === 0 ? "completed" : "failed"));
      if (r.exitCode !== 0) return { text: `[failed: ${clip(output(r), 300)}]`, ok: false };
      return {
        text: `[${exists ? "updated" : "created"} ${a.path}, ${content.split("\n").length - 1} lines]`,
        ok: true,
        created: !exists,
      };
    }
  }
}

/**
 * `find` replaced by `to` once: the exact text, else the same lines ignoring trailing spaces,
 * else ignoring indentation too (models re-indent what they quote). null when it isn't there.
 */
export function replaceIn(text: string, find: string, to: string): string | null {
  const at = text.indexOf(find);
  if (at !== -1 && find) return text.slice(0, at) + to + text.slice(at + find.length);
  const want = find.replace(/\n+$/, "").split("\n");
  if (!want.some((l) => l.trim())) return null;
  const lines = text.split("\n");
  for (const norm of [(s: string) => s.trimEnd(), (s: string) => s.trim()]) {
    const w = want.map(norm);
    for (let i = 0; i + w.length <= lines.length; i++) {
      let same = true;
      for (let j = 0; j < w.length; j++)
        if (norm(lines[i + j]) !== w[j]) {
          same = false;
          break;
        }
      if (!same) continue;
      const repl = to.replace(/\n+$/, "");
      return [
        ...lines.slice(0, i),
        ...(repl === "" ? [] : repl.split("\n")),
        ...lines.slice(i + w.length),
      ].join("\n");
    }
  }
  return null;
}

/** A small diff for the file row: the changed middle between the common first and last lines. */
export function lineDiff(before: string, after: string): string {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  return [
    `@@ -${head + 1},${removed.length} +${head + 1},${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");
}
