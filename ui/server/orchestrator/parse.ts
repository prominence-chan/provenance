// Lenient parsers for what the free models write back in plain text: the planner's task list
// (Experimental), the translator's action list (Hyperexperimental) and the small keyword
// verdicts the other roles end with. Nothing here relies on JSON or on a model following the
// format exactly: numbering, bullets, bold, code fences, lowercase keywords and stray prose are
// all tolerated, and what can't be read is reported instead of thrown.

export interface MiniTask {
  title: string;
  /** What "done" means for this task ("" when the planner gave none). */
  done: string;
}

export interface Plan {
  /** The planner answered the user directly: nothing to do in the folder. */
  answer: string | null;
  tasks: MiniTask[];
}

/** Leading list / markdown decoration: "- ", "* ", "3.", "3)", "#", ">", "**". */
function strip(line: string): string {
  return line
    .replace(/^\s*(?:[-*•>]+\s+|#{1,6}\s*)*/, "")
    .replace(/\*\*|__/g, "")
    .trim();
}

function unquote(s: string): string {
  const t = s.trim();
  const m = /^(`+|"|')([\s\S]*)\1$/.exec(t);
  return (m ? m[2] : t).trim();
}

const TASK_RE = /^(?:(?:mini[- ]?)?(?:task|step)\s*#?\s*(\d+)?\s*[:.)\-–—]+|(\d+)\s*[.):\-–—]+)\s*(.*)$/i;
const DONE_RE =
  /^(?:done[- ]?(?:when|if|criteria|criterion|means)?|definition of done|acceptance(?: criteria)?|success(?: criteria)?|verify|check)\s*[:\-–—]+\s*(.*)$/i;
const INLINE_DONE_RE =
  /\s*[(\[;.\-–—|]*\s*\b(?:done when|done if|done criteria|acceptance|definition of done)\s*[:\-–—]?\s*([^)\]]*)[)\]]?\s*$/i;
const ANSWER_RE = /^(?:answer|final answer|reply|no tasks?(?: needed)?)\s*[:\-–—]+\s*(.*)$/i;

/**
 * "TASK 1: … / DONE WHEN: …" in whatever shape it came back. Also takes "1. …", "- Task: …",
 * "Step 2 - …", done-criteria on the same line ("… (done when: …)") or on following lines, and
 * continuation lines. `ANSWER: …` with no tasks means the request needs no work.
 */
export function parsePlan(text: string, maxTasks = 12): Plan {
  const tasks: MiniTask[] = [];
  let answer: string | null = null;
  let answerOpen = false;
  let inDone = false;
  /** Still inside the last task's lines (a blank line ends it: what follows is prose). */
  let open = false;
  const lines = text.replace(/\r/g, "").split("\n");
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) continue; // a fence around the whole list
    const line = strip(raw);
    if (!line) {
      open = false;
      continue;
    }
    const a = ANSWER_RE.exec(line);
    if (a && !tasks.length) {
      answer = a[1].trim();
      answerOpen = true;
      continue;
    }
    const t = TASK_RE.exec(line);
    if (t) {
      answerOpen = false;
      inDone = false;
      open = true;
      let title = t[3].trim();
      let done = "";
      const inline = INLINE_DONE_RE.exec(title);
      if (inline && inline.index > 0) {
        done = inline[1].trim();
        title = title.slice(0, inline.index).trim();
      }
      tasks.push({ title: title.replace(/[\s:;,.\-–—]+$/, ""), done });
      continue;
    }
    const d = DONE_RE.exec(line);
    if (d && tasks.length) {
      const cur = tasks[tasks.length - 1];
      cur.done = cur.done ? `${cur.done} ${d[1].trim()}` : d[1].trim();
      inDone = true;
      open = true;
      continue;
    }
    if (answerOpen && answer !== null) {
      answer += `\n${line}`;
      continue;
    }
    // A continuation of the task or of its done-criteria (wrapped lines, sub-bullets).
    if (tasks.length && open) {
      const cur = tasks[tasks.length - 1];
      if (inDone) cur.done = `${cur.done} ${line}`.trim();
      else if (!cur.title) cur.title = line;
      else if (cur.title.length + line.length < 400) cur.title = `${cur.title} ${line}`;
    }
  }
  const kept = tasks
    .filter((t) => t.title)
    .map((t) => ({ title: clip(t.title, 500), done: clip(t.done, 300) }))
    .slice(0, maxTasks);
  if (kept.length) return { answer: null, tasks: kept };
  return { answer: answer && answer.trim() ? answer.trim() : null, tasks: [] };
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

// ---- Hyperexperimental: the action vocabulary --------------------------------------------------

export type Action =
  | { kind: "run"; command: string }
  | { kind: "read"; path: string; start: number | null; end: number | null }
  | { kind: "list"; path: string }
  | { kind: "search"; pattern: string; path: string | null }
  | { kind: "write"; path: string; content: string }
  | { kind: "replace"; path: string; find: string; with: string };

export interface ParsedActions {
  actions: Action[];
  /** The translator said there is nothing to run (the plan was "done" or only talk). */
  none: boolean;
  /** Lines that looked like actions but couldn't be read (shown to the next Think). */
  problems: string[];
}

/** The vocabulary as the translator is told it (also the reference for the parser below). */
export const ACTION_HELP = `RUN: <one shell command>
READ: <file path> [first-last line numbers]
LIST: <folder path>
SEARCH: <text or regex> IN <path>
WRITE: <file path>
<<<
entire new file content
>>>
REPLACE: <file path>
<<<
exact existing text
===
new text
>>>
NONE`;

const VERBS: Record<string, Action["kind"]> = {
  run: "run",
  exec: "run",
  execute: "run",
  shell: "run",
  bash: "run",
  sh: "run",
  cmd: "run",
  command: "run",
  read: "read",
  cat: "read",
  open: "read",
  view: "read",
  show: "read",
  list: "list",
  ls: "list",
  dir: "list",
  search: "search",
  grep: "search",
  find: "search",
  rg: "search",
  write: "write",
  create: "write",
  save: "write",
  overwrite: "write",
  replace: "replace",
  edit: "replace",
  patch: "replace",
  modify: "replace",
  update: "replace",
};

const VERB_RE = new RegExp(
  `^(?:\\d+\\s*[.)]\\s*)?(?:action\\s*\\d*\\s*[:.-]\\s*)?(${Object.keys(VERBS).join("|")})(?:[ _-]?(?:file|command|cmd|dir|folder))?\\s*(?::|=>|->|\\s-\\s)\\s*(.*)$`,
  "i",
);
// "RUN npm test" without the colon: only for the vocabulary's own words, in capitals.
const BARE_RE = /^(?:\d+\s*[.)]\s*)?(RUN|READ|LIST|SEARCH|WRITE|REPLACE)\s+(\S.*)$/;
const NONE_RE = /^(?:none|no actions?(?: needed| required)?|nothing(?: to (?:do|run))?|done)\s*[.!]?$/i;
const SEP_RE = /^\s*(?:={3,}|-{3,}\s*(?:with|new)?\s*-*|with:|new:|into:|by:)\s*$/i;

interface Block {
  body: string;
  /** Index of the first line after the block. */
  next: number;
}

/** A content block starting at or after line i: <<< … >>>, or a ``` fence. Blank lines before it are skipped. */
function readBlock(lines: string[], i: number): Block | null {
  let j = i;
  while (j < lines.length && !lines[j].trim()) j++;
  if (j >= lines.length) return null;
  const open = lines[j].trim();
  const fence = /^(`{3,}|~{3,})/.exec(open);
  if (fence) {
    const close = fence[1];
    const body: string[] = [];
    for (let k = j + 1; k < lines.length; k++) {
      if (lines[k].trim().startsWith(close) && lines[k].trim().replace(/[`~]/g, "") === "")
        return { body: body.join("\n"), next: k + 1 };
      body.push(lines[k]);
    }
    return { body: body.join("\n"), next: lines.length }; // never closed: take the rest
  }
  if (/^<{3,}/.test(open)) {
    const body: string[] = [];
    const first = open.replace(/^<{3,}\s?/, "");
    if (first) body.push(first);
    for (let k = j + 1; k < lines.length; k++) {
      const m = /^(.*?)\s*>{3,}\s*$/.exec(lines[k]);
      if (m && !/^\s*>{3,}\S/.test(lines[k])) {
        if (m[1].trim()) body.push(m[1]);
        return { body: unfence(body).join("\n"), next: k + 1 };
      }
      body.push(lines[k]);
    }
    return { body: unfence(body).join("\n"), next: lines.length };
  }
  return null;
}

/** <<< with a ``` fence inside it (both markers at once): keep only what the fence holds. */
function unfence(body: string[]): string[] {
  const b = body.slice();
  while (b.length && !b[0].trim()) b.shift();
  while (b.length && !b[b.length - 1].trim()) b.pop();
  if (b.length >= 2 && /^(`{3,}|~{3,})/.test(b[0].trim()) && /^(`{3,}|~{3,})\s*$/.test(b.at(-1)!.trim()))
    return b.slice(1, -1);
  return body;
}

function splitReplace(body: string): { find: string; with: string } | null {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => SEP_RE.test(l));
  if (at === -1) return null;
  return { find: lines.slice(0, at).join("\n"), with: lines.slice(at + 1).join("\n") };
}

function parseRead(arg: string): Action | null {
  let rest = unquote(arg);
  let start: number | null = null;
  let end: number | null = null;
  const range =
    /[\s,:(\[]+(?:lines?\s*)?(\d+)\s*(?:-|–|—|to|\.\.|,|:)\s*(\d+)\s*[)\]]?\s*$/i.exec(rest) ??
    /[\s,(\[]+(?:lines?|from line)\s*(\d+)()\s*[)\]]?\s*$/i.exec(rest);
  if (range) {
    start = Number(range[1]);
    end = range[2] ? Number(range[2]) : null;
    rest = rest.slice(0, range.index);
  }
  const p = unquote(rest);
  if (!p) return null;
  if (start !== null && end !== null && end < start) [start, end] = [end, start];
  return { kind: "read", path: p, start, end };
}

function parseSearch(arg: string): Action | null {
  const a = arg.trim();
  // The pattern may hold " in ": split on the LAST " IN " (capitals first, then any case).
  const at = Math.max(a.lastIndexOf(" IN "), a.lastIndexOf(" in "));
  let pattern = a;
  let where: string | null = null;
  if (at > 0) {
    const after = unquote(a.slice(at + 4));
    if (after && !/\s/.test(after)) {
      pattern = a.slice(0, at);
      where = after;
    }
  }
  pattern = unquote(pattern);
  return pattern ? { kind: "search", pattern, path: where } : null;
}

/**
 * The translator's reply as actions. Accepts the vocabulary in any case, numbered or bulleted,
 * with bold or backticks; RUN followed by a fenced block (each line a command, or one script);
 * WRITE / REPLACE content in <<< >>> or a code fence; READ "path:10-20" / "path lines 10 to 20".
 * Prose lines are ignored. At most `max` actions are kept.
 */
export function parseActions(text: string, max = 8): ParsedActions {
  const lines = text.replace(/\r/g, "").split("\n");
  const actions: Action[] = [];
  const problems: string[] = [];
  let none = false;
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = strip(raw);
    i++;
    if (!line) continue;
    if (NONE_RE.test(line)) {
      none = true;
      continue;
    }
    const m = VERB_RE.exec(line) ?? BARE_RE.exec(line);
    if (!m) continue; // prose, or the fence around a whole answer
    const kind = VERBS[m[1].toLowerCase()];
    const arg = m[2].trim();
    switch (kind) {
      case "run": {
        let command = unquote(arg);
        if (!command) {
          const b = readBlock(lines, i);
          if (b) {
            command = b.body.trim();
            i = b.next;
          }
        }
        if (command) actions.push({ kind, command });
        else problems.push(`RUN without a command: ${clip(raw.trim(), 80)}`);
        break;
      }
      case "read": {
        const a = parseRead(arg);
        if (a) actions.push(a);
        else problems.push(`READ without a path: ${clip(raw.trim(), 80)}`);
        break;
      }
      case "list":
        actions.push({ kind, path: unquote(arg) || "." });
        break;
      case "search": {
        const a = parseSearch(arg);
        if (a) actions.push(a);
        else problems.push(`SEARCH without a pattern: ${clip(raw.trim(), 80)}`);
        break;
      }
      case "write": {
        const p = unquote(arg.replace(/\s+(?:with(?: content)?|content)\s*:?\s*$/i, ""));
        const b = readBlock(lines, i);
        if (!p) problems.push(`WRITE without a path: ${clip(raw.trim(), 80)}`);
        else if (!b) problems.push(`WRITE ${p}: no content block (<<< … >>>) followed`);
        else {
          actions.push({ kind, path: p, content: b.body });
          i = b.next;
        }
        break;
      }
      case "replace": {
        const p = unquote(arg);
        const b = readBlock(lines, i);
        if (!p || !b) {
          problems.push(`REPLACE ${p || "(no path)"}: no <<< old === new >>> block followed`);
          break;
        }
        i = b.next;
        let parts = splitReplace(b.body);
        if (!parts) {
          // Two blocks in a row: old, then new.
          const b2 = readBlock(lines, i);
          if (b2) {
            parts = { find: b.body, with: b2.body };
            i = b2.next;
          }
        }
        if (!parts || !parts.find.trim())
          problems.push(`REPLACE ${p}: the block needs the old text, a === line, then the new text`);
        else actions.push({ kind, path: p, find: parts.find, with: parts.with });
        break;
      }
    }
  }
  if (actions.length > max) {
    problems.push(`${actions.length - max} action(s) beyond the limit of ${max} were dropped`);
    actions.length = max;
  }
  return { actions, none: none && !actions.length, problems };
}

/** One line for an action (rows, notes, prompts). */
export function describeAction(a: Action): string {
  switch (a.kind) {
    case "run":
      return `RUN: ${a.command}`;
    case "read":
      return `READ: ${a.path}${a.start ? ` ${a.start}-${a.end ?? ""}` : ""}`;
    case "list":
      return `LIST: ${a.path}`;
    case "search":
      return `SEARCH: ${a.pattern}${a.path ? ` IN ${a.path}` : ""}`;
    case "write":
      return `WRITE: ${a.path} (${a.content.split("\n").length} lines)`;
    case "replace":
      return `REPLACE: ${a.path}`;
  }
}

// ---- keyword verdicts ------------------------------------------------------------------------

export interface Report {
  status: "done" | "blocked" | "partial";
  text: string;
}

/**
 * A worker's last message. It is asked to end with "STATUS: DONE | BLOCKED | PARTIAL"; without
 * that line, wording decides (a report that says it couldn't is not "done").
 */
export function parseReport(text: string): Report {
  const m = /^\W*status\W+(done|complete[d]?|success|ok|blocked|failed|fail|partial|incomplete)\b/im.exec(
    text,
  );
  let status: Report["status"];
  if (m) {
    const w = m[1].toLowerCase();
    status = /^(done|complete|success|ok)/.test(w)
      ? "done"
      : /^(blocked|fail)/.test(w)
        ? "blocked"
        : "partial";
  } else if (
    /\b(blocked|could ?n[o']t|cannot|can't|unable to|failed to|not able to|permission denied)\b/i.test(
      text,
    )
  )
    status = "blocked";
  else status = text.trim() ? "done" : "partial";
  return { status, text: text.trim() };
}

export interface Thought {
  /** The work is finished: the answer for the user. */
  final: string | null;
  /** What to do next, in free form (when not finished). */
  next: string;
}

/**
 * The Think step's reply: either a plan for the next step, or "FINISHED:" followed by the answer
 * for the user. The marker must start a line (models mention "finished" in passing).
 */
export function parseThought(text: string): Thought {
  const t = text.trim();
  const m = /^\W{0,4}(?:finished|final answer|all done|task complete[d]?)\W{0,4}\s*[:\-–—]\s*/im.exec(t);
  if (m) {
    const final = t
      .slice(m.index + m[0].length)
      .replace(/^[\s*_:]+/, "")
      .trim();
    if (final) return { final, next: "" };
  }
  if (/^\W{0,4}(?:finished|done)\W{0,4}$/im.test(t) && t.length < 40)
    return { final: "Done.", next: "" };
  return { final: null, next: t };
}
