// Session notes: the only thing an Experimental thread carries from task to task and from turn
// to turn. Kept as data and rendered to a bounded text; no model writes them.
//
// What goes in comes from two places, kept apart (chat-on-steroids' handoff rule: "a message
// saying it did something is not evidence; a recorded tool call that succeeded is"):
//   - recorded: files the harness changed and commands it ran with their exit codes, read off
//     the worker thread's own items;
//   - reported: one line per task from the worker's report (its RESULT), and its BLOCKERS.
// When the text would pass the bound, the oldest entries are folded first: finished-task lines
// into a count, then old commands, then old files. The user's request is never folded.
//
// The notes also hold where the plan stands: the tasks still to do (kept current as tasks start
// and finish, so a turn that ends early leaves the list "continue" resumes from) and the files
// the request names that did not exist when it was made (what the job has to produce).
//
// And they hold the request itself, as written (`original`), with the exact names code copied
// out of it (`exact`; request.ts): what every brief quotes word for word, whatever a planner made
// of it. Commands a worker asked approval for and was refused are kept once each (`approvals`).

export interface Notes {
  /** What the user asked for, newest last (each clipped). The first is the thread's goal. */
  requests: string[];
  /** Finished tasks, oldest first: "title: result". */
  done: string[];
  /** How many finished-task lines were folded away. */
  folded: number;
  /** Files changed, newest last. */
  files: { path: string; kind: string }[];
  /** Commands run, newest last. */
  commands: { cmd: string; ok: boolean }[];
  /** Open problems (blockers reported and not since resolved), newest last. */
  problems: string[];
  /** Tasks planned and not finished, in order (empty when a plan ran to its end). */
  pending: PendingTask[];
  /** Files the latest request names that it did not find: what has to exist at the end. */
  deliverables: string[];
  /** The latest request that started a job, word for word (bounded only by ORIGINAL_LIMIT). */
  original: string;
  /** The exact names in it: paths, quoted strings, flags, numbers with units (request.ts). */
  exact: string[];
  /** Commands whose approval was asked and declined, newest last (each once). */
  approvals: string[];
  /**
   * Working hand-over state for the task currently being handed across fresh workers (Experimental).
   * Cleared when the task finishes or a new request starts; kept across "continue".
   */
  handover?: Handover | null;
}

/**
 * Structured working analysis carried across Experimental's worker context hand-overs.
 * Prevents successor workers from repeating earlier investigation when a later worker writes a
 * terse report or times out during wrap-up.
 */
export interface Handover {
  /** Number of hand-overs folded into this state for the current task. */
  count: number;
  /** The most recent non-empty worker hand-over report (and which hand-over wrote it). */
  latestReport: string;
  latestFrom: number;
  /** Completed milestones / clean areas reported across hand-overs, oldest first. */
  done: string[];
  /** Files created or edited across hand-overs (recorded + reported), newest last. */
  files: string[];
  /** Concrete remaining failure groups (file/module, test/error names, diagnosed cause). */
  failures: string[];
  /** Hand-over number that last updated `failures` (so stale fallback can be marked). */
  failuresFrom: number;
  /** Attempted fixes / hypotheses / dead ends accumulated across hand-overs. */
  tried: string[];
  /** Latest verification command and its outcome. */
  validation: string;
  /** Latest concrete next action for the incoming worker. */
  next: string;
  /** Latest unchecked / leftover caveats. */
  leftovers: string;
  /** Recorded ground truth from the just-stopped worker (files & recent check summary). */
  recordedFiles: string[];
  recordedChecks: string[];
}

export interface PendingTask {
  title: string;
  done: string;
  needs?: number[];
  detail?: string;
  whole?: boolean;
  followUp?: boolean;
  /** True when `detail` carries a structured worker hand-over. */
  handover?: boolean;
}

/** How much of a request is kept word for word (a request longer than this loses its middle). */
export const ORIGINAL_LIMIT = 16_000;

export const NOTES_LIMIT = 2400;

export function emptyNotes(): Notes {
  return {
    requests: [],
    done: [],
    folded: 0,
    files: [],
    commands: [],
    problems: [],
    pending: [],
    deliverables: [],
    original: "",
    exact: [],
    approvals: [],
    handover: null,
  };
}

export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** Keep the head and the tail of a long text (the task up top and the outcome at the end matter most). */
export function clipMiddle(s: string, n: number): string {
  if (s.length <= n) return s;
  const head = Math.floor((n - 30) * 0.4);
  const tail = n - 30 - head;
  return `${s.slice(0, head).trimEnd()}\n[… ${s.length - head - tail} characters left out …]\n${s.slice(-tail).trimStart()}`;
}

export function addRequest(n: Notes, text: string): void {
  n.requests.push(clip(text, n.requests.length ? 400 : 700));
  // The goal (first) stays; of the follow-ups only the latest three.
  if (n.requests.length > 4) n.requests.splice(1, n.requests.length - 4);
}

export function addFile(n: Notes, path: string, kind: string): void {
  const i = n.files.findIndex((f) => f.path === path);
  if (i !== -1) {
    // added then updated is still "added"; anything then deleted is "deleted"
    const was = n.files[i].kind;
    n.files.splice(i, 1);
    if (was === "add" && kind === "update") kind = "add";
  }
  n.files.push({ path, kind });
  if (n.files.length > 40) n.files.shift();
}

export function addCommand(n: Notes, cmd: string, ok: boolean): void {
  const c = clip(cmd, 120);
  const i = n.commands.findIndex((x) => x.cmd === c);
  if (i !== -1) n.commands.splice(i, 1); // the latest run of the same command is the one that counts
  n.commands.push({ cmd: c, ok });
  if (n.commands.length > 20) n.commands.shift();
}

export function addDone(n: Notes, title: string, result: string): void {
  n.done.push(`${clip(title, 90)}: ${clip(result, 220)}`);
}

export function addProblem(n: Notes, text: string): void {
  const p = clip(text, 260);
  if (!p || n.problems.includes(p)) return;
  n.problems.push(p);
  if (n.problems.length > 4) n.problems.shift();
}

export function clearProblems(n: Notes): void {
  n.problems = [];
}

/** A command that needed an approval nobody gave: recorded once. */
export function addApproval(n: Notes, cmd: string): void {
  const c = clip(cmd, 160);
  if (!c || n.approvals.includes(c)) return;
  n.approvals.push(c);
  if (n.approvals.length > 4) n.approvals.shift();
}

/** The plan as it stands: the task being worked on and those after it (at most 8 are kept). */
export function setPending(n: Notes, tasks: PendingTask[]): void {
  n.pending = tasks.slice(0, 8).map((t) => ({
    title: clip(t.title, 240),
    done: clip(t.done, 120),
    ...(t.needs?.length ? { needs: t.needs.slice(0, 60) } : {}),
    ...(t.detail ? { detail: t.detail.slice(0, 2800) } : {}),
    ...(t.whole ? { whole: true } : {}),
    ...(t.followUp ? { followUp: true } : {}),
    ...(t.handover ? { handover: true } : {}),
  }));
}

function render(n: Notes, withPending: boolean): string {
  const out: string[] = [];
  if (n.requests.length) {
    out.push(`GOAL: ${n.requests[0]}`);
    for (const r of n.requests.slice(1)) out.push(`LATER REQUEST: ${r}`);
  }
  if (n.done.length || n.folded) {
    out.push("DONE (as reported by workers):");
    if (n.folded) out.push(`- (${n.folded} earlier task${n.folded === 1 ? "" : "s"} finished)`);
    for (const d of n.done) out.push(`- ${d}`);
  }
  if (n.files.length)
    out.push(`FILES CHANGED (recorded): ${n.files.map((f) => `${f.path} (${f.kind})`).join(", ")}`);
  if (n.commands.length) {
    out.push("COMMANDS RUN (recorded, latest result):");
    for (const c of n.commands) out.push(`- ${c.ok ? "ok" : "FAILED"}: ${c.cmd}`);
  }
  if (n.problems.length) {
    out.push("PROBLEMS HIT (later tasks may have fixed them):");
    for (const p of n.problems) out.push(`- ${p}`);
  }
  if (n.approvals.length) {
    out.push("NEEDS APPROVAL (asked and declined: do without, do not ask again):");
    for (const a of n.approvals) out.push(`- ${a}`);
  }
  if (withPending && n.pending.length) {
    out.push("STILL TO DO (planned, not finished):");
    n.pending.slice(0, 6).forEach((t, i) => out.push(`${i + 1}. ${clip(t.title, 110)}`));
    if (n.pending.length > 6) out.push(`(and ${n.pending.length - 6} more)`);
  }
  return out.join("\n");
}

/**
 * The notes as text, at most `limit` characters. Folds the notes themselves (oldest first) until
 * they fit, so what is stored is always what is shown. The tasks still to do are shown (never
 * folded) unless `withPending` is false: a worker's brief names the later tasks itself.
 */
export function notesText(n: Notes, limit = NOTES_LIMIT, withPending = true): string {
  let text = render(n, withPending);
  for (let guard = 0; text.length > limit && guard < 200; guard++) {
    if (n.done.length > 2) {
      n.done.shift();
      n.folded++;
    } else if (n.commands.length > 3) n.commands.shift();
    else if (n.files.length > 5) n.files.shift();
    else if (n.problems.length > 1) n.problems.shift();
    else if (n.requests.length > 1) n.requests.splice(1, 1);
    else if (n.done.length) {
      n.done.shift();
      n.folded++;
    } else break;
    text = render(n, withPending);
  }
  return text.length > limit ? clipMiddle(text, limit) : text;
}

/**
 * The notes as text for a reader with less room than the notes' own bound (a worker's brief),
 * without folding what is stored: the fold is made on a copy.
 */
export function notesView(n: Notes, limit: number, withPending = false): string {
  return notesText(structuredClone(n), limit, withPending);
}

/**
 * RESULT / CHANGES / VALIDATION / FAILURES / TRIED / NEXT / NOT CHECKED / BLOCKERS out of a
 * worker's report (any may be missing).
 */
export function reportSections(text: string): {
  result: string;
  changes: string;
  validation: string;
  failures: string;
  tried: string;
  next: string;
  unchecked: string;
  blockers: string;
} {
  const out = {
    result: "",
    changes: "",
    validation: "",
    failures: "",
    tried: "",
    next: "",
    unchecked: "",
    blockers: "",
  };
  let cur: keyof typeof out | null = null;
  const loose: string[] = [];
  const multiline = new Set<keyof typeof out>(["failures", "tried", "next"]);
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*#>]+\s*)*/, "").replace(/\*\*/g, "");
    const m =
      /^(result|done|changes?|validation|verification|remaining failures?|open failures?|failures?|tried|attempted(?: fixes)?|attempts?|next(?: actions?| steps?)?|not checked|unchecked|not verified|blockers?|status)\s*[:\-–—]\s*(.*)$/i.exec(
        line,
      );
    if (m) {
      const k = m[1].toLowerCase();
      cur =
        k === "result" || k === "done"
          ? "result"
          : k.startsWith("change")
            ? "changes"
            : k.startsWith("valid") || k.startsWith("verif")
              ? "validation"
              : k.includes("failure")
                ? "failures"
                : k === "tried" || k.startsWith("attempt")
                  ? "tried"
                  : k.startsWith("next")
                    ? "next"
                    : k.startsWith("not ") || k === "unchecked"
                      ? "unchecked"
                      : k.startsWith("blocker")
                        ? "blockers"
                        : null;
      if (cur && m[2].trim())
        out[cur] = out[cur]
          ? `${out[cur]}${multiline.has(cur) ? "\n" : " "}${m[2].trim()}`
          : m[2].trim();
      continue;
    }
    if (!line.trim()) continue;
    if (cur) {
      const sep = multiline.has(cur) && out[cur] ? "\n" : " ";
      out[cur] = `${out[cur]}${out[cur] ? sep : ""}${line.trim()}`.trim();
    } else loose.push(line.trim());
  }
  if (!out.result) out.result = loose.join(" ");
  const emptyWord = /^(none|no|n\/a|nothing|-)\.?$/i;
  for (const k of ["blockers", "unchecked", "failures", "tried", "next"] as const)
    if (emptyWord.test(out[k].trim())) out[k] = "";
  return out;
}

const FAILURE_LINE_RE =
  /^\s*(?:FAILED|ERROR|FAIL\b|✗|×|not ok\b|--- FAIL:|AssertionError|TypeError|ValueError|AttributeError|ImportError|KeyError|IndexError|RuntimeError|SyntaxError|NameError|ZeroDivisionError|Traceback|error\[E\d+\]|=+\s*\d+\s+failed|\d+\s+failed\b)/i;

/**
 * High-signal failure lines out of a command's output (e.g. pytest's `FAILED path::test - ...` and
 * summary line), falling back to the tail when no structured failure lines appear. Bounded.
 */
export function failureDigest(output: string, maxChars = 600): string {
  const lines = output
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  if (!lines.length) return "";
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    if (!FAILURE_LINE_RE.test(l)) continue;
    const c = clip(l, 150);
    if (seen.has(c)) continue;
    seen.add(c);
    hits.push(c);
  }
  const chosen = hits.length ? hits.slice(-10) : lines.slice(-8).map((l) => clip(l, 150));
  const out: string[] = [];
  let used = 0;
  for (let i = chosen.length - 1; i >= 0; i--) {
    const line = chosen[i];
    if (used + line.length + 1 > maxChars && out.length) break;
    out.unshift(line);
    used += line.length + 1;
  }
  const omitted = hits.length > out.length ? hits.length - out.length : 0;
  const text = `${omitted > 0 ? `(${omitted} more matching failure lines)\n` : ""}${out.join("\n")}`;
  return text.length > maxChars ? clipMiddle(text, maxChars) : text;
}

function splitItems(text: string): string[] {
  return text
    .split(/\n+|(?<=;)\s+/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

function mergeUnique(base: string[], added: string[], maxItems: number, maxLen: number): string[] {
  const out = [...base];
  const seen = new Set(out.map((s) => s.toLowerCase()));
  for (const raw of added) {
    const item = clip(raw, maxLen);
    const k = item.toLowerCase();
    if (!item || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out.slice(-maxItems);
}

/**
 * Fold a stopped worker's hand-over report and recorded tool facts into the task's cumulative
 * Handover state. Concrete failure groups, tried fixes, edited files and next actions survive
 * even if a later worker writes a terse report or times out on wrap-up.
 */
export function mergeHandover(
  prev: Handover | null | undefined,
  a: {
    n: number;
    report: string;
    files: { path: string; kind: string }[];
    checks: { cmd: string; ok: boolean; exit?: number | null; summary?: string }[];
  },
): Handover {
  const rep = a.report.trim();
  const sec = reportSections(rep);
  const base: Handover = prev
    ? structuredClone(prev)
    : {
        count: 0,
        latestReport: "",
        latestFrom: 0,
        done: [],
        files: [],
        failures: [],
        failuresFrom: 0,
        tried: [],
        validation: "",
        next: "",
        leftovers: "",
        recordedFiles: [],
        recordedChecks: [],
      };
  base.count = a.n;
  if (rep) {
    base.latestReport = rep;
    base.latestFrom = a.n;
  }
  if (sec.result) base.done = mergeUnique(base.done, [`part ${a.n}: ${sec.result}`], 6, 220);
  const recFiles = a.files.map((f) => `${f.path} (${f.kind})`);
  const repFiles = sec.changes ? splitItems(sec.changes) : [];
  base.files = mergeUnique(base.files, [...recFiles, ...repFiles], 20, 120);
  base.recordedFiles = recFiles.slice(-12);

  const newFailures = sec.failures ? splitItems(sec.failures) : [];
  if (newFailures.length) {
    // A worker that explicitly listed remaining failures replaces the prior list (fixed ones drop).
    base.failures = mergeUnique([], newFailures, 10, 220);
    base.failuresFrom = a.n;
  }
  if (sec.tried) base.tried = mergeUnique(base.tried, splitItems(sec.tried), 8, 200);
  if (sec.validation) base.validation = clip(sec.validation, 260);
  if (sec.next) base.next = clip(sec.next, 320);
  if (sec.blockers) base.leftovers = clip(sec.blockers, 360);
  else if (sec.unchecked) base.leftovers = clip(`NOT CHECKED: ${sec.unchecked}`, 360);

  const checkLines: string[] = [];
  for (const c of a.checks.slice(-3)) {
    const tag = c.ok ? "ok" : `FAILED${typeof c.exit === "number" ? ` (exit ${c.exit})` : ""}`;
    const head = `${tag}: ${clip(c.cmd, 140)}`;
    const detail =
      !c.ok && c.summary?.trim() ? `\n  ${c.summary.trim().replace(/\n/g, "\n  ")}` : "";
    checkLines.push(`${head}${detail}`);
  }
  base.recordedChecks = checkLines;
  if (!base.validation && checkLines.length) base.validation = clip(checkLines.at(-1)!, 260);
  return base;
}

function compactStructuredReport(report: string, maxChars: number): string {
  if (report.length <= maxChars) return report;
  const s = reportSections(report);
  if (!s.failures && !s.tried && !s.next) return clipMiddle(report, maxChars);
  // Keep every critical working-analysis section proportionally instead of middle-clipping FAILURES away.
  const entries: [string, string, number][] = [
    ["RESULT", s.result, 0.14],
    ["CHANGES", s.changes, 0.11],
    ["VALIDATION", s.validation, 0.1],
    ["FAILURES", s.failures, 0.34],
    ["TRIED", s.tried, 0.13],
    ["NEXT", s.next, 0.12],
    ["NOT CHECKED", s.unchecked, 0.05],
    ["BLOCKERS", s.blockers, 0.08],
  ].filter(([, v]) => Boolean(v)) as [string, string, number][];
  const totalWeight = entries.reduce((sum, [, , w]) => sum + w, 0) || 1;
  const avail = Math.max(200, maxChars - 24);
  const lines = entries.map(([label, val, w]) => {
    const share = Math.max(80, Math.floor((avail * w) / totalWeight) - label.length - 3);
    const body = val.length <= share ? val : clipMiddle(val, share);
    return `${label}: ${body}`;
  });
  lines.push("STATUS: PARTIAL");
  const out = lines.join("\n");
  return out.length <= maxChars ? out : clipMiddle(out, maxChars);
}

/**
 * Render a task's Handover state into the worker's task detail, keeping the latest report up top
 * (in its own words) and appending carried-forward working analysis and recorded ground truth
 * without letting naive middle-clipping drop failure groups, tried fixes, or next actions.
 */
export function renderHandover(h: Handover, maxChars = 2400): string {
  const intro = `(recorded) An earlier worker on this task was stopped when its context was nearly full (hand-over ${h.count}). Its report:`;
  const outro =
    "Go on from the files as they are now. Do not redo what is finished, and do not read again what the report already tells you.";
  const budget = Math.max(400, maxChars - intro.length - outro.length - 4);
  const latestFromThis = h.latestReport && h.latestFrom === h.count;
  const repSec = reportSections(h.latestReport);

  const extra: string[] = [];
  // Carry forward earlier progress / analysis that the latest report omitted (or when wrap-up failed).
  const carried: string[] = [];
  if (h.done.length > (latestFromThis && repSec.result ? 1 : 0)) {
    const earlierDone = latestFromThis && repSec.result ? h.done.slice(0, -1) : h.done;
    if (earlierDone.length)
      carried.push(`EARLIER PROGRESS:\n${earlierDone.map((d) => `- ${d}`).join("\n")}`);
  }
  if (h.failures.length && (!latestFromThis || !repSec.failures)) {
    const note =
      h.failuresFrom && h.failuresFrom < h.count
        ? ` (from hand-over ${h.failuresFrom}; recheck what still fails)`
        : "";
    carried.push(`REMAINING FAILURES${note}:\n${h.failures.map((f) => `- ${f}`).join("\n")}`);
  }
  if (h.tried.length && (!latestFromThis || !repSec.tried)) {
    carried.push(
      `ALREADY TRIED (do not repeat dead ends):\n${h.tried.map((t) => `- ${t}`).join("\n")}`,
    );
  }
  if (h.next && (!latestFromThis || !repSec.next)) {
    carried.push(`NEXT ACTION:\n- ${h.next}`);
  }
  if (carried.length) extra.push(`CARRIED FORWARD FROM EARLIER HAND-OVERS:\n${carried.join("\n")}`);

  const rec: string[] = [];
  if (h.recordedFiles.length)
    rec.push(`Files changed by stopped worker: ${h.recordedFiles.join(", ")}`);
  if (h.files.length > h.recordedFiles.length) {
    const others = h.files.filter((f) => !h.recordedFiles.includes(f));
    if (others.length) rec.push(`All files changed on this task: ${others.slice(-10).join(", ")}`);
  }
  if (h.recordedChecks.length)
    rec.push(`Latest recorded checks:\n${h.recordedChecks.map((c) => `- ${c}`).join("\n")}`);
  if (rec.length) extra.push(`RECORDED BY HARNESS:\n${rec.join("\n")}`);

  const extraText = extra.join("\n");
  const headText = latestFromThis
    ? h.latestReport
    : h.latestReport
      ? `(worker ${h.count} gave no hand-over; last report was from hand-over ${h.latestFrom})\n${h.latestReport}`
      : "(it gave no hand-over; use the recorded facts and notes below)";

  let body: string;
  if (!extraText) {
    body = compactStructuredReport(headText, budget);
  } else if (headText.length + extraText.length + 2 <= budget) {
    body = `${headText}\n\n${extraText}`;
  } else {
    // Share the budget: latest report keeps at least half (section-preserving), carried/recorded keeps the rest.
    const extraShare = Math.min(extraText.length, Math.max(450, Math.floor(budget * 0.42)));
    const headShare = Math.max(300, budget - extraShare - 2);
    body = `${compactStructuredReport(headText, headShare)}\n\n${clipMiddle(extraText, extraShare)}`;
  }
  return `${intro}\n${body}\n${outro}`;
}
