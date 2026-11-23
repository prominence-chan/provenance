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
}

export const NOTES_LIMIT = 2400;

export function emptyNotes(): Notes {
  return { requests: [], done: [], folded: 0, files: [], commands: [], problems: [] };
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

function render(n: Notes): string {
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
  return out.join("\n");
}

/**
 * The notes as text, at most `limit` characters. Folds the notes themselves (oldest first) until
 * they fit, so what is stored is always what is shown.
 */
export function notesText(n: Notes, limit = NOTES_LIMIT): string {
  let text = render(n);
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
    text = render(n);
  }
  return text.length > limit ? clipMiddle(text, limit) : text;
}

/** RESULT / CHANGES / VALIDATION / BLOCKERS out of a worker's report (any may be missing). */
export function reportSections(text: string): {
  result: string;
  changes: string;
  validation: string;
  blockers: string;
} {
  const out = { result: "", changes: "", validation: "", blockers: "" };
  let cur: keyof typeof out | null = null;
  const loose: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*#>]+\s*)*/, "").replace(/\*\*|__/g, "");
    const m = /^(result|changes?|validation|verification|blockers?|status)\s*[:\-–—]\s*(.*)$/i.exec(
      line,
    );
    if (m) {
      const k = m[1].toLowerCase();
      cur =
        k === "result"
          ? "result"
          : k.startsWith("change")
            ? "changes"
            : k.startsWith("valid") || k.startsWith("verif")
              ? "validation"
              : k.startsWith("blocker")
                ? "blockers"
                : null;
      if (cur && m[2].trim()) out[cur] = m[2].trim();
      continue;
    }
    if (!line.trim()) continue;
    if (cur) out[cur] = `${out[cur]} ${line.trim()}`.trim();
    else loose.push(line.trim());
  }
  if (!out.result) out.result = loose.join(" ");
  if (/^(none|no|n\/a|nothing|-)\.?$/i.test(out.blockers.trim())) out.blockers = "";
  return out;
}
