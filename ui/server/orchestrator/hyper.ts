// Hyperexperimental: every step is three new chats and one execution, and the only thing carried
// from step to step (and from turn to turn) is a summary.
//
//   a. think      a new chat, no tools: the goal, a one-line listing of the folder, the summary
//                 and the last step's results -> free-form text saying what to do next, or
//                 "FINISHED: <answer for the user>".
//   b. translate  another new chat: that text, the folder and the platform -> actions in a small
//                 fixed vocabulary (RUN, READ, LIST, SEARCH, WRITE, REPLACE; parse.ts reads it
//                 forgivingly). It never sees the goal, the summary or any history.
//   c. execute    each action runs through the orchestrators' app-server as a sandboxed command
//                 (command/exec with the thread's sandbox as an explicit policy; exec below), never
//                 a shell of our own. Rows appear in the thread as commands and file changes.
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
// Guards (backend.ts Caps): steps per turn, model calls per turn, time per command; and the turn
// stops when a step is the same as the one before it twice, or two steps in a row yield no action.

import { command, fileChange, type Item } from "../fallback/items.ts";
import {
  folderBrief,
  Interrupted,
  platformName,
  sandboxPolicyFor,
  StopTurn,
  errText,
  type Run,
} from "./backend.ts";
import { clip, clipMiddle } from "./notes.ts";
import { describeAction, parseActions, parseThought, type Action } from "./parse.ts";
import {
  RESULTS_LIMIT,
  SUMMARY_LIMIT,
  summarizePrompt,
  thinkPrompt,
  translatePrompt,
} from "./prompts.ts";

type Json = Record<string, unknown>;

const SHELL = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
const MAX_WRITE_CHARS = 200_000;
const READ_LINES = 250;

export async function runHyper(run: Run): Promise<void> {
  const caps = run.caps;
  const goal = run.text;
  let summary = run.thread.summary;
  let results = "";
  let lastSig = "";
  let repeats = 0;
  let empty = 0;
  for (let step = 1; ; step++) {
    run.check();
    if (step > caps.steps)
      throw new StopTurn(
        "cap",
        `Stopped after ${caps.steps} steps, the limit for one message. Send another message to go on from the summary.`,
      );
    run.stats.steps = step;
    // a. think
    const thought = parseThought(
      await run.model(
        "think",
        thinkPrompt({
          goal,
          folder: folderBrief(run.cwd),
          summary,
          results,
          step,
          stepsLeft: caps.steps - step,
        }),
      ),
    );
    if (thought.final !== null) {
      run.say(thought.final);
      run.thread.summary = clipMiddle(
        `${summary}\n\nThe request "${clip(goal, 300)}" was answered: ${clip(thought.final, 400)}`.trim(),
        SUMMARY_LIMIT,
      );
      run.save();
      return;
    }
    run.say(thought.next);
    // b. translate
    const parsed = parseActions(
      await run.model("translate", translatePrompt(thought.next, run.cwd, platformName())),
    );
    // c. execute
    const lines: string[] = [];
    for (const problem of parsed.problems) lines.push(`(not understood) ${problem}`);
    if (!parsed.actions.length) {
      empty++;
      lines.push(
        "No action could be read from the last plan. Say the commands and the file content concretely.",
      );
      if (empty >= 2)
        throw new StopTurn("cap", "Stopped: two steps in a row produced nothing that could be run.");
    } else empty = 0;
    const sig = parsed.actions.map(signature).join("\n");
    if (sig && sig === lastSig) {
      repeats++;
      if (repeats >= 2)
        throw new StopTurn("cap", "Stopped: the same step came back three times in a row.");
    } else repeats = 0;
    lastSig = sig;
    for (const action of parsed.actions) {
      run.check();
      const result = await execute(run, action);
      lines.push(`${describeAction(action)}\n${result}`);
    }
    results = clipMiddle(lines.join("\n\n"), RESULTS_LIMIT);
    // d. summarize
    let next: string;
    try {
      next = await run.model(
        "summarize",
        summarizePrompt({ goal, summary, intent: thought.next, results }),
        900,
      );
    } catch (e) {
      if (!(e instanceof StopTurn) || e.kind !== "router" || run.interrupted) throw e;
      // Keep what happened even if nobody could write it up; the turn ends on this error.
      run.thread.summary = clipMiddle(
        `${summary}\n\nStep ${step}: ${parsed.actions.map(describeAction).join("; ")}`.trim(),
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
async function sandboxed(run: Run, argv: string[], policy: Json, timeoutMs: number): Promise<ExecResult> {
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

/** Run one action; returns what the next Think is told about it. */
async function execute(run: Run, a: Action): Promise<string> {
  const cwd = run.cwd;
  const policy = sandboxPolicyFor(run.thread.sandbox, cwd);
  const ask = mustAsk(run.thread.approvalPolicy);
  const session = (run.backend.sessionApprovals.get(run.threadId) ??
    run.backend.sessionApprovals
      .set(run.threadId, { commands: new Set(), files: false })
      .get(run.threadId))!;
  const id = run.nextId("act");
  const t0 = Date.now();
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
          ? [{ type: "read" as const, command: shown, name: a.path.split("/").pop() ?? a.path, path: a.path }]
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
          durationMs: Date.now() - t0,
        }),
      );
      return a.kind === "search" && r.exitCode === 0 && !r.stdout.trim() ? "(no matches)" : text;
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
          return "[the user declined to run this command]";
        }
      }
      const r = await sandboxed(run, [SHELL, "-lc", a.command], policy, run.caps.commandMs);
      const text = output(r);
      run.complete(
        command(id, a.command, cwd, {
          status: r.exitCode === 0 ? "completed" : "failed",
          output: text,
          exitCode: r.exitCode,
          durationMs: Date.now() - t0,
        }),
      );
      return text;
    }
    case "write":
    case "replace": {
      const before = await sandboxed(run, ["/bin/sh", "-c", 'cat "$1"', "sh", a.path], READ_ONLY, 30_000);
      const exists = before.exitCode === 0;
      let content: string;
      if (a.kind === "write") content = a.content;
      else {
        if (!exists) {
          const item = fileChange(id, [{ path: a.path, kind: "update", diff: "" }], "failed");
          run.complete(item, true);
          return `[failed: ${a.path} does not exist or cannot be read; use WRITE to create it]`;
        }
        const replaced = replaceIn(before.stdout, a.find, a.with);
        if (replaced === null) {
          run.complete(fileChange(id, [{ path: a.path, kind: "update", diff: "" }], "failed"), true);
          return `[failed: the old text was not found in ${a.path}; READ the file and copy the exact text]`;
        }
        content = replaced;
      }
      if (content && !content.endsWith("\n")) content += "\n";
      if (content.length > MAX_WRITE_CHARS) {
        run.complete(fileChange(id, [{ path: a.path, kind: "update", diff: "" }], "failed"), true);
        return `[failed: ${content.length} characters is more than one write takes (${MAX_WRITE_CHARS})]`;
      }
      const kind = exists ? "update" : "add";
      const change = [{ path: a.path, kind, diff: lineDiff(exists ? before.stdout : "", content) } as const];
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
          return "[the user declined this file change]";
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
      if (r.exitCode !== 0) return `[failed: ${clip(output(r), 300)}]`;
      return `[${exists ? "updated" : "created"} ${a.path}, ${content.split("\n").length - 1} lines]`;
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
      return [...lines.slice(0, i), ...(repl === "" ? [] : repl.split("\n")), ...lines.slice(i + w.length)].join(
        "\n",
      );
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
