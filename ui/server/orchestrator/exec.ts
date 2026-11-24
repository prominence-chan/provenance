// Running things on the machine, by code: one sandboxed command through the orchestrators'
// app-server (command/exec with an explicit sandbox policy), and the actions built on it (RUN,
// READ, LIST, SEARCH, WRITE, REPLACE). Hyperexperimental's execute step runs every action here;
// the finish check (finish.ts) runs its settling commands here too, for both orchestrators. No
// model is involved in any of it.

import { userInfo } from "node:os";
import { command, fileChange, type Item } from "../fallback/items.ts";
import type { AppServer } from "./appserver.ts";
import { Interrupted, sandboxPolicyFor, errText, type Run } from "./backend.ts";
import { mono } from "./clock.ts";
import { clip, clipMiddle } from "./notes.ts";
import { describeAction, type Action } from "./parse.ts";

type Json = Record<string, unknown>;

const MAX_WRITE_CHARS = 200_000;
const READ_LINES = 250;

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
export async function sandboxed(
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

export const READ_ONLY: Json = { type: "readOnly", networkAccess: false };

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

/** stdout then stderr, uncut. */
function joined(r: ExecResult): string {
  return [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join("\n");
}

function output(r: ExecResult, limit = 1400): string {
  const text = joined(r);
  const body = text ? clipMiddle(text, limit) : "(no output)";
  return r.exitCode === 0
    ? body
    : `${body}\n[exit ${r.exitCode === 124 ? "124: timed out" : r.exitCode}]`;
}

/** What an action came to: the text the next Think is told, and whether it did what it was for. */
export interface Done {
  text: string;
  ok: boolean;
  /** RUN, READ, LIST, SEARCH: how it exited, and everything it printed (uncut). */
  exitCode?: number;
  full?: string;
  /** WRITE, REPLACE: the file's content after it, and whether that differs from before. */
  content?: string;
  changed?: boolean;
  /** The user declined it (it did not run). */
  declined?: boolean;
  /** A write that made a new file. */
  created?: boolean;
}

/** Run one action; returns what the next Think is told about it. */
export async function execute(
  run: Run,
  a: Action,
  opts: { timeoutMs?: number } = {},
): Promise<Done> {
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
        exitCode: r.exitCode,
        full: joined(r),
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
        ? await sandboxed(
            run,
            [sh.shell, "-c", a.command],
            policy,
            opts.timeoutMs ?? run.caps.commandMs,
            sh.env,
          )
        : await sandboxed(
            run,
            [sh.shell, "-lc", a.command],
            policy,
            opts.timeoutMs ?? run.caps.commandMs,
          );
      const text = output(r);
      run.complete(
        command(id, a.command, cwd, {
          status: r.exitCode === 0 ? "completed" : "failed",
          output: text,
          exitCode: r.exitCode,
          durationMs: Math.round(mono.now() - t0),
        }),
      );
      return { text, ok: r.exitCode === 0, exitCode: r.exitCode, full: joined(r) };
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
        content,
        changed: !exists || before.stdout !== content,
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
