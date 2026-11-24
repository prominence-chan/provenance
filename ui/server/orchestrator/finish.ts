// The finish check: what stands between "the work says it is done" and the answer.
//
// What the second benchmark round showed about the first design (a reviewer giving a verdict per
// requirement, then a model-run task for whatever was "not shown"): of 102 verdicts 61 were "not
// shown", and nearly all of those for want of evidence, not of work: the reviewer was handed no
// command outputs, and a command that began with `cd` or `cat >` was not handed to it at all; no
// run passed because of it; two of three "violated" were a placeholder from an example read as a
// literal; and every review bought a follow-up task of model calls. So:
//
//   1. By code, always, free: every file the request names as output exists under exactly that
//      name (a near miss is called one), nothing was written outside the folder to a path the
//      request does not name, the last recorded check did not fail (codeFindings).
//   2. The reviewer is called only when it can add something (reviewWorth): the job was split
//      (no worker saw the whole), or the work itself lists something as not checked, or no
//      recorded command ran the result at all. A small job done by one worker that ran its
//      result and reports nothing unchecked gets no reviewer.
//   3. The reviewer is given the evidence (the files with excerpts, every command with its exit
//      code and the end of its output) and is asked not for verdicts but for at most three things
//      the evidence does not show, each with ONE command that settles it (reviewPrompt,
//      parseChecks). Those commands are run by code, under the thread's sandbox and approval
//      preset like any command (exec.ts): a check that passes costs no model call.
//   4. Only a check that FAILS (or something code found) is worth a fix: one bounded task
//      (Experimental) or a few more steps (Hyperexperimental) with the failing command and its
//      output as the brief. Afterwards the failing commands are run again, by code, and the
//      answer says what they came to. With too little budget left for a fix, none is started:
//      the answer says "not verified".

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { Run } from "./backend.ts";
import { StopTurn } from "./backend.ts";
import { execute } from "./exec.ts";
import { clip, clipMiddle } from "./notes.ts";
import type { MiniTask } from "./parse.ts";
import { reviewPrompt } from "./prompts.ts";
import { nearMiss, parseChecks, strayPaths } from "./request.ts";

/**
 * The reviewer's reply may be this long (tokens). Generous on purpose: a model that reasons
 * before it writes spends its allowance there first (a reply cut off after its first line is no
 * review; seen with 700 on a real run).
 */
export const REVIEW_TOKENS = 3000;
/** One settling command may take this long. */
const CHECK_MS = 60_000;
export const MAX_CHECKS = 3;

/** A command that was run, as recorded: the evidence the finish check works from. */
export interface Evidence {
  cmd: string;
  ok: boolean;
  /** Its exit code, when known. */
  exit?: number | null;
  /** The end of what it printed. */
  tail?: string;
}

/** The end of an output, as evidence: its last lines, bounded. */
export function tailOf(output: string, maxChars = 360, maxLines = 6): string {
  const lines = output
    .replace(/\s+$/, "")
    .split("\n")
    .filter((l) => l.trim());
  let text = lines.slice(-maxLines).join("\n");
  if (text.length > maxChars) text = `…${text.slice(-(maxChars - 1))}`;
  return text;
}

function fileSize(p: string): number | null {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}

function missing(deliverables: string[], cwd: string): string[] {
  return deliverables.filter((d) => !existsSync(path.resolve(cwd, d)));
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

/** The findings as lines (for a fix task, the answer). */
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
    out.push(
      `- ${f.path} (${f.kind}, ${size === null ? "not there now" : `exists, ${size} bytes`})`,
    );
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

/** The commands that were run as the reviewer sees them: exit code, command, the end of the output. Newest kept. */
export function commandsEvidence(commands: Evidence[], maxChars = 2400): string {
  const blocks: string[] = [];
  let used = 0;
  for (const c of [...commands].reverse()) {
    const code = c.exit ?? (c.ok ? 0 : 1);
    const tail = c.tail?.trim()
      ? `\n${c.tail
          .split("\n")
          .map((l) => `    | ${clip(l, 200)}`)
          .join("\n")}`
      : "";
    const block = `- exit ${code}: ${clip(c.cmd, 260)}${tail}`;
    if (used + block.length + 1 > maxChars && blocks.length) break;
    blocks.unshift(block.length > maxChars ? clipMiddle(block, maxChars) : block);
    used += block.length + 1;
    if (blocks.length >= 12) break;
  }
  const left = commands.length - blocks.length;
  return `${left > 0 ? `(${left} earlier command${left === 1 ? "" : "s"} not listed)\n` : ""}${blocks.join("\n")}`;
}

/** What code has already settled, for the reviewer not to ask again. */
export function settledLines(deliverables: string[], cwd: string, commands: Evidence[]): string {
  const out: string[] = [];
  for (const d of deliverables)
    if (fileSize(path.resolve(cwd, d)) !== null) out.push(`- ${d} exists under exactly that name`);
  out.push("- nothing was written outside the working folder to a path the request does not name");
  const last = commands.at(-1);
  if (last?.ok) out.push("- the last recorded command exited 0");
  return out.join("\n");
}

// ---- when a reviewer is worth a call -------------------------------------------------------------

/**
 * Why a reviewer should read this job, or null when it can add nothing: the job was done whole
 * by one worker (or one run of steps) that ran its result and names nothing as unchecked.
 */
export function reviewWorth(a: {
  /** Did the turn change or run anything? */
  changed: boolean;
  /** Was the job split among workers? */
  split: boolean;
  /** What the work itself says it did not check ("" for nothing). */
  unchecked: string;
  /** Commands that were more than a look. */
  commands: Evidence[];
}): string | null {
  if (!a.changed) return null;
  if (a.split) return "the job was split, so no worker saw the whole of it";
  if (a.unchecked.trim()) return "the work itself names something it did not check";
  if (!a.commands.some((c) => c.ok)) return "no recorded command ran the result";
  return null;
}

/** "NOT CHECKED: …" out of a report or a FINISHED answer ("" when it says nothing, or nothing is unchecked). */
export function uncheckedOf(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const at = lines.findIndex((l) =>
    /^\W*(?:not checked|not verified|unchecked|not tested)\W*[:\-–—]/i.test(l),
  );
  if (at === -1) return "";
  const parts = [
    lines[at].replace(/^\W*(?:not checked|not verified|unchecked|not tested)\W*[:\-–—]\s*/i, ""),
  ];
  // (the value may wrap: up to the next blank line or the next "Label:" line)
  for (let k = at + 1; k < Math.min(lines.length, at + 6); k++) {
    if (!lines[k].trim() || /^\W*[A-Za-z][A-Za-z ]{1,24}:/.test(lines[k])) break;
    parts.push(lines[k].trim());
  }
  const v = parts.join(" ").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return /^(?:none|no|n\/a|nothing|-)?\.?$/i.test(v) || /^nothing\b[^.]{0,40}\.?$/i.test(v)
    ? ""
    : v;
}

// ---- the settling commands -------------------------------------------------------------------------

export interface Check {
  requirement: string;
  command: string;
  /** passed, failed, or not run (refused as unsafe, declined, timed out, no time left). */
  state: "passed" | "failed" | "not-run";
  /** The end of what it printed (or why it was not run). */
  output: string;
  /** It failed first and passes now, after the fix. */
  fixed?: boolean;
}

const UNSAFE_RE =
  /(?:^|[\s;&|(`])(?:sudo|rm|rmdir|mv|dd|mkfs|shutdown|reboot|kill|pkill|killall|chmod|chown|truncate|brew|apt|apt-get|curl|wget|ssh|scp)\b|\bgit\s+(?:reset|clean|checkout|restore|push|commit|rebase|stash)\b|\b(?:pip3?|npm|pnpm|yarn|cargo|gem)\s+(?:install|add|i|uninstall|remove)\b|\bsed\s+-[a-zA-Z]*i/;

/** Why a reviewer's command is not run as a check, or null when it may be. */
export function unsafeCheck(command: string, cwd: string, request: string): string | null {
  const c = command.trim();
  if (!c) return "it is empty";
  if (c.length > 4000) return "it is too long for a check";
  // (python3 -c "…rm…" is a string, not a command: judged with quoted text and heredocs set aside)
  const bare = c.replace(/'[^']*'/g, "Q").replace(/"(?:\\.|[^"\\])*"/g, "Q");
  const m = UNSAFE_RE.exec(bare);
  if (m)
    return `it would change things (\`${clip(m[0].trim(), 40)}\`), and a check only looks and runs`;
  if (strayPaths({ files: [], commands: [c], reports: [] }, cwd, request).length)
    return "it writes outside the working folder";
  return null;
}

/** Run each check by code (no model): under the thread's sandbox and approval preset, as a row in the thread. */
export async function runChecks(run: Run, checks: Check[], request: string): Promise<void> {
  for (const c of checks) {
    run.check();
    const why = unsafeCheck(c.command, run.cwd, request);
    if (why) {
      c.state = "not-run";
      c.output = why;
      continue;
    }
    const ms = Math.min(CHECK_MS, run.caps.commandMs, run.left().ms - 5000);
    if (ms < 3000) {
      c.state = "not-run";
      c.output = "no time was left in this turn";
      continue;
    }
    const was = c.state;
    const r = await execute(run, { kind: "run", command: c.command }, { timeoutMs: ms });
    if (r.declined) {
      c.state = "not-run";
      c.output = "its approval was declined";
      continue;
    }
    const tail = tailOf(r.full ?? r.text, 500, 8);
    // 124 a timeout, 126/127 not runnable: the check did not run, it did not fail
    if (r.exitCode === 124 || r.exitCode === 126 || r.exitCode === 127 || r.exitCode === -1) {
      c.state = "not-run";
      c.output =
        r.exitCode === 124
          ? "it did not finish in time"
          : `it could not be run (exit ${r.exitCode}): ${clip(tail, 200)}`;
      continue;
    }
    c.state = r.ok ? "passed" : "failed";
    c.output = `${tail}${r.ok ? "" : `\n[exit ${r.exitCode}]`}`.trim();
    c.fixed = r.ok && was === "failed";
  }
}

export interface Reviewed {
  /** The reviewer was called and its reply could be read. */
  reviewed: boolean;
  /** Why no review came of it (not asked, unreachable, unreadable), when none did. */
  skipped: string | null;
  checks: Check[];
}

/**
 * One reviewer call (when `why` says it is worth one) and its checks run by code. Never throws
 * for a reviewer that cannot be reached or read: the answer then says the check did not run.
 */
export async function review(
  run: Run,
  a: {
    why: string | null;
    request: string;
    deliverables: string[];
    files: { path: string; kind: string }[];
    commands: Evidence[];
    unchecked: string;
  },
): Promise<Reviewed> {
  if (!a.why) return { reviewed: false, skipped: null, checks: [] };
  const left = run.left();
  if (left.calls < 1 || left.ms < 25_000)
    return {
      reviewed: false,
      skipped: `too little of this turn's budget was left to review it (${a.why})`,
      checks: [],
    };
  let text: string;
  try {
    text = await run.model(
      "review",
      reviewPrompt({
        request: a.request,
        cwd: run.cwd,
        files: filesEvidence(a.files, a.deliverables, run.cwd),
        commands: commandsEvidence(a.commands),
        settled: settledLines(a.deliverables, run.cwd, a.commands),
        unchecked: a.unchecked,
      }),
      REVIEW_TOKENS,
    );
  } catch (e) {
    if (!(e instanceof StopTurn) || run.interrupted) throw e;
    return { reviewed: false, skipped: "the reviewer could not be reached", checks: [] };
  }
  const parsed = parseChecks(text, MAX_CHECKS);
  if (!parsed.checks.length && !parsed.allShown)
    return { reviewed: false, skipped: "the reviewer's reply could not be read", checks: [] };
  const checks: Check[] = parsed.checks.map((c) => ({ ...c, state: "not-run", output: "" }));
  await runChecks(run, checks, a.request);
  return { reviewed: true, skipped: null, checks };
}

// ---- the fix -----------------------------------------------------------------------------------------

/** What a fix has to deal with, as lines: what code found, and each check that failed with its output. */
export function fixLines(failed: Check[], found: string[]): string[] {
  return [
    ...found.map((f) => `- (recorded) ${f}`),
    ...failed.map(
      (c) =>
        `- CHECK FAILED: ${clip(c.requirement, 200)}\n  command: ${clipMiddle(c.command, 700)}\n  it printed: ${clipMiddle(c.output || "(nothing)", 500)}`,
    ),
  ];
}

export const FIX_RULES =
  "For each: decide from the request whether the work or the check is wrong. If the work is wrong, fix it and run the same command again until it exits 0. If the check tests something the request does not ask for, change nothing and say so under NOT CHECKED. Never weaken the work, and never remove or loosen a check, to make it pass. A file the request names must exist under exactly that name and place.";

/** The one fix task (Experimental): written by code from the findings, never by a planner. */
export function followUpTask(failed: Check[], found: string[]): MiniTask {
  return {
    title: "Fix what the finish check found, and run the failing check again",
    detail: `After the work was reported done, this was found:\n${fixLines(failed, found).join("\n")}\n${FIX_RULES}`,
    done: "each failing command now exits 0 (name it under VALIDATION), or is named under NOT CHECKED with why the check is wrong",
    followUp: true,
  };
}

/** What the answer says about the finish check ("" when it has nothing to say). */
export function finishText(a: {
  reviewed: boolean;
  checks: Check[];
  /** A fix was attempted (a task, or more steps) for what failed or what code found. */
  fix: { ran: boolean; why: string } | null;
  skipped: string | null;
  /** Hyperexperimental: the fix was further steps of the same job, not a task of its own. */
  steps?: boolean;
}): string {
  const passed = a.checks.filter((c) => c.state === "passed");
  const failed = a.checks.filter((c) => c.state === "failed");
  const notRun = a.checks.filter((c) => c.state === "not-run");
  const out: string[] = [];
  if (!a.checks.length) {
    if (a.skipped)
      return `Finish check: not reviewed (${a.skipped}); nothing beyond the recorded commands was verified.`;
    return "";
  }
  const cmd = (c: Check) => `\`${clip(c.command, 140)}\``;
  if (passed.length)
    out.push(
      `${passed.length} further check${passed.length === 1 ? " was" : "s were"} run on the result and passed:\n${passed
        .map(
          (c) =>
            `- ${clip(c.requirement, 160)}: ${cmd(c)}${c.fixed ? " (failed at first; passes after the fix)" : ""}`,
        )
        .join("\n")}`,
    );
  if (failed.length) {
    const what = a.fix?.ran
      ? `${a.steps ? "More steps were" : "A fix task was"} run for ${failed.length === 1 ? "it" : "them"}, and ${failed.length === 1 ? "it still fails" : "they still fail"}`
      : `No ${a.steps ? "further step" : "fix task"} was run${a.fix?.why ? ` (${a.fix.why})` : ""}`;
    out.push(
      `${failed.length} check${failed.length === 1 ? "" : "s"} **failed**:\n${failed
        .map((c) => `- ${clip(c.requirement, 160)}: ${cmd(c)} → ${clip(c.output || "failed", 200)}`)
        .join(
          "\n",
        )}\n${what}: treat ${failed.length === 1 ? "this" : "these"} as **not verified** (the check itself may be what is wrong).`,
    );
  }
  if (notRun.length)
    out.push(
      `**Not verified** (the check could not be run):\n${notRun
        .map((c) => `- ${clip(c.requirement, 160)}: ${clip(c.output || "not run", 160)}`)
        .join("\n")}`,
    );
  return `**Finish check.** ${out.join("\n")}`;
}
