// Lenient parsers for what the free models write back in plain text: the planner's task list
// (Experimental), the translator's action list (Hyperexperimental) and the small keyword
// verdicts the other roles end with. Nothing here relies on JSON or on a model following the
// format exactly: numbering, bullets, bold, code fences, lowercase keywords and stray prose are
// all tolerated, and what can't be read is reported instead of thrown.

import { parseNeeds } from "./request.ts";

export interface MiniTask {
  title: string;
  /** What "done" means for this task ("" when the planner gave none). */
  done: string;
  /** The pieces of the request this task depends on, by number (request.ts requestLines). */
  needs?: number[];
  /** More than fits a title: the points a follow-up task has to settle (written by code). */
  detail?: string;
  /** The task is the whole request, for one worker. */
  whole?: boolean;
  /** The task that settles what the finish check found: it is not revised when it fails. */
  followUp?: boolean;
}

export interface Plan {
  /** The planner answered the user directly: nothing to do in the folder. */
  answer: string | null;
  tasks: MiniTask[];
  /** The planner said one worker can do the whole job ("ONE"). */
  one: boolean;
  /** The planner's reason why one worker is not enough ("LARGE: …"), when it gave one. */
  large: string | null;
}

/** Leading list / markdown decoration: "- ", "* ", "3.", "3)", "#", ">", "**". */
function strip(line: string): string {
  return line
    .replace(/^\s*(?:[-*•>]+\s+|#{1,6}\s*)*/, "")
    .replace(/\*\*/g, "") // bold only: "__" belongs to names like __init__.py
    .trim();
}

function unquote(s: string): string {
  const t = s.trim();
  const m = /^(`+|"|')([\s\S]*)\1$/.exec(t);
  return (m ? m[2] : t).trim();
}

const TASK_RE =
  /^(?:(?:mini[- ]?)?(?:task|step)\s*#?\s*(\d+)?\s*[:.)\-–—]+|(\d+)\s*[.):\-–—]+)\s*(.*)$/i;
const DONE_RE =
  /^(?:done[- ]?(?:when|if|criteria|criterion|means)?|definition of done|acceptance(?: criteria)?|success(?: criteria)?|verify|check)\s*[:\-–—]+\s*(.*)$/i;
const INLINE_DONE_RE =
  /\s*[(\[;.\-–—|]*\s*\b(?:done when|done if|done criteria|acceptance|definition of done)\s*[:\-–—]?\s*([^)\]]*)[)\]]?\s*$/i;
const ANSWER_RE = /^(?:answer|final answer|reply|no tasks?(?: needed)?)\s*[:\-–—]+\s*(.*)$/i;
const NEEDS_RE =
  /^(?:needs?|request (?:lines?|pieces?)|pieces?|depends on|from the request)\s*[:\-–—]+\s*(.*)$/i;
const ONE_RE = /^(?:one(?: task| worker)?|single(?: task)?|size\s*[:\-–—]\s*small|small)\s*[.!]?$/i;
const LARGE_RE = /^(?:large|size\s*[:\-–—]\s*large|split)\s*[:\-–—]+\s*(.*)$/i;

/**
 * "TASK 1: … / DONE WHEN: …" in whatever shape it came back. Also takes "1. …", "- Task: …",
 * "Step 2 - …", done-criteria on the same line ("… (done when: …)") or on following lines, and
 * continuation lines. `ANSWER: …` with no tasks means the request needs no work.
 */
export function parsePlan(text: string, maxTasks = 12): Plan {
  const tasks: MiniTask[] = [];
  let answer: string | null = null;
  let one = false;
  let large: string | null = null;
  let answerOpen = false;
  let inDone = false;
  /** Still inside the last task's lines (a blank line ends it: what follows is prose). */
  let open = false;
  /**
   * After that blank line, bullets still belong to the task ("Write a query that:", a blank
   * line, then its conditions as a list) until a line of prose comes.
   */
  let bullets = false;
  const lines = text.replace(/\r/g, "").split("\n");
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) continue; // a fence around the whole list
    const line = strip(raw);
    if (!line) {
      bullets = open || bullets;
      open = false;
      continue;
    }
    const a = ANSWER_RE.exec(line);
    if (a && !tasks.length) {
      answer = a[1].trim();
      answerOpen = true;
      continue;
    }
    if (!tasks.length && ONE_RE.test(line)) {
      one = true;
      continue;
    }
    const big = LARGE_RE.exec(line);
    if (big && !tasks.length) {
      large = big[1].trim() || "it does not fit one worker";
      answerOpen = false;
      continue;
    }
    const needs = NEEDS_RE.exec(line);
    if (needs && tasks.length) {
      const got = parseNeeds(needs[1]);
      if (got.length) tasks[tasks.length - 1].needs = got;
      inDone = false;
      open = false;
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
    const bullet = /^\s*[-*•]\s+\S/.test(raw);
    if (!open && !(bullets && bullet)) bullets = false;
    if (tasks.length && (open || (bullets && bullet))) {
      const cur = tasks[tasks.length - 1];
      if (inDone) cur.done = `${cur.done} ${line}`.trim();
      else if (!cur.title) cur.title = line;
      else if (cur.title.length + line.length < 400) cur.title = `${cur.title} ${line}`;
    }
  }
  const kept = tasks
    .filter((t) => t.title)
    .map((t) => ({
      title: clip(t.title, 500),
      done: clip(t.done, 300),
      ...(t.needs ? { needs: t.needs } : {}),
    }))
    .slice(0, maxTasks);
  if (kept.length) return { answer: null, tasks: kept, one, large };
  return { answer: answer && answer.trim() && !one ? answer.trim() : null, tasks: [], one, large };
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/**
 * A reply that declines instead of planning ("I can't run commands on your computer", "as an AI
 * I don't have access to your files"). Only asked of a reply with no task list in it.
 */
export function looksLikeRefusal(text: string): boolean {
  const t = text.replace(/[’‘]/g, "'");
  return (
    /\bI(?:'m| am)? (?:can't|cannot|can not|could not|couldn't|won't be able to|not able to|unable to|do not|don't)\b[^.\n]{0,120}\b(?:run|execute|access|open|read|modify|inspect|interact|commands?|files?|computer|machine|system|terminal|shell|tools?|environment)\b/i.test(
      t,
    ) ||
    /\bas an? (?:ai|language model|text-based)\b/i.test(t) ||
    /\bI (?:do not|don't) have (?:access|the ability|a way|tools)\b/i.test(t) ||
    /\byou(?:'ll| will)? (?:need|have) to run (?:these|this|the|them)\b/i.test(t)
  );
}

/** "continue", "go on", "keep going", "try again": a message that only asks to resume. */
export function isContinue(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[\s.!…]+$/g, "");
  return (
    t.length <= 60 &&
    /^(?:ok(?:ay)?[, ]+|yes[, ]+|please[, ]+|now[, ]+)*(?:continue|go on|go ahead|keep going|carry on|resume|proceed|try again|retry|again|next|finish(?: it| the job| up)?|pick up where (?:you|it) (?:left off|stopped))(?:[, ]+please)?(?: (?:from|with|where)\b.*)?$/.test(
      t,
    )
  );
}

/** Words that say a task (or a request) makes or changes something, rather than only looks. */
const PRODUCE_RE =
  /\b(?:creat(?:e|es|ing)|writ(?:e|es|ing)|produc(?:e|es|ing)|generat(?:e|es|ing)|fix(?:es|ing)?|implement(?:s|ing)?|recover(?:s|ing)?|repair(?:s|ing)?|sav(?:e|es|ing)|add(?:s|ing)?|updat(?:e|es|ing)|modif(?:y|ies|ying)|build(?:s|ing)?|convert(?:s|ing)?|export(?:s|ing)?|mak(?:e|es|ing)|rewrit(?:e|es|ing)|refactor(?:s|ing)?|chang(?:e|es|ing)|edit(?:s|ing)?|delet(?:e|es|ing)|remov(?:e|es|ing)|renam(?:e|es|ing)|install(?:s|ing)?|migrat(?:e|es|ing)|port(?:s|ing)?|replac(?:e|es|ing)|patch(?:es|ing)?|restor(?:e|es|ing)|extract(?:s|ing)?|appl(?:y|ies|ying)|configur(?:e|es|ing)|set(?:ting)? up|mov(?:e|es|ing)|merg(?:e|es|ing)|compil(?:e|es|ing)|modernis(?:e|es|ing)|moderniz(?:e|es|ing)|upgrad(?:e|es|ing)|output(?:s|ting)?)\b/i;

/** Does the text ask for (or describe) making or changing something? */
export function producesSomething(text: string): boolean {
  return PRODUCE_RE.test(text);
}

function baseName(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p;
}

/**
 * The check behind "a plan must end by producing what was asked": when the request asks for
 * something to be made or changed, some task must make it. With deliverables named in the
 * request (files that don't exist yet) a task has to name one of them; otherwise a task has to
 * say it creates or changes something. A plan of looking only (ls, read, dump, query) fails.
 */
export function planProduces(tasks: MiniTask[], request: string, deliverables: string[]): boolean {
  if (!tasks.length) return true;
  if (!deliverables.length && !producesSomething(request)) return true; // a question: looking is the job
  const texts = tasks.map((t) => `${t.title} ${t.done}`);
  if (deliverables.length) {
    const names = deliverables.map((d) => baseName(d).toLowerCase());
    return texts.some((t) => names.some((n) => t.toLowerCase().includes(n)));
  }
  return texts.some((t) => producesSomething(t));
}

/** The task that is added to a plan that only looks. */
export function producingTask(request: string, deliverables: string[]): MiniTask {
  const list = deliverables.join(", ");
  return {
    title: clip(
      `Using what the notes show, produce what the request asks for${list ? ` (create ${list})` : ""}: ${request.replace(/\s+/g, " ").trim()}`,
      500,
    ),
    done: list
      ? `${list} ${deliverables.length === 1 ? "exists" : "exist"} with the content the request describes, and you have checked it`
      : "what the request asks for exists, and you have checked it",
  };
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
  /** Lifted command blocks that no action named (not run; the next Think is told). */
  unrun: string[];
  /**
   * Actions refused before anything runs: a WRITE with no content, a `cat > file` with no
   * heredoc body (it would wait for input forever). `at` is how many actions precede it: the
   * executor runs those, then stops the step and tells the next Think what was refused.
   */
  rejected: { at: number; text: string }[];
}

/** A file's content as the Think step wrote it, lifted out of its text (liftFiles). */
export interface LiftedFile {
  path: string;
  content: string;
}

export interface Lifted {
  files: LiftedFile[];
  /** The Think text with each lifted body replaced by a one-line marker. */
  plan: string;
}

/** The fence the Think step is asked to put a file in: ```file:<path>. */
export const FILE_BLOCK_HELP = "```file:path/to/name.py\n<the whole file>\n```";

const SHELL_LANGS =
  /^(?:bash|sh|zsh|shell|console|terminal|shellsession|fish|powershell|ps1|cmd|bat)$/i;
const FILE_TOKEN =
  /`([^`\s]+\.[A-Za-z0-9_+-]{1,10})`|(?:^|[\s"'(])((?:[\w.~-]*\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9_+-]{0,9})(?=$|[\s"'),:;])/g;

function fileMarker(path: string, content: string): string {
  const n = content === "" ? 0 : content.split("\n").length;
  return `[file block: ${path} (${n} line${n === 1 ? "" : "s"}) is held by the executor; for it output only "WRITE: ${path}", with no content]`;
}

function cleanPath(p: string): string {
  return unquote(p.trim().replace(/[,;:]+$/, "")).replace(/[,;:]+$/, "");
}

/** `cat > path <<'EOF'` or `cat <<'EOF' > path` (or tee): the path, the delimiter, quoted or not. */
function heredocWrite(
  line: string,
): { path: string; delim: string; quoted: boolean; dash: boolean } | null {
  const a =
    /^\s*(?:\$\s+)?(?:cat|tee)\s*>?\s*(\S+)\s*<<(-?)\s*(['"]?)([A-Za-z_]\w*)\3\s*(?:>\s*\/dev\/null\s*)?$/.exec(
      line,
    );
  if (a && (/^\s*(?:\$\s+)?cat\s*>[^>]/.test(line) || /^\s*(?:\$\s+)?tee\s+[^-]/.test(line)))
    return { path: cleanPath(a[1]), dash: a[2] === "-", quoted: a[3] !== "", delim: a[4] };
  const b = /^\s*(?:\$\s+)?cat\s*<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2\s*>\s*(\S+)\s*$/.exec(line);
  if (b) return { path: cleanPath(b[4]), dash: b[1] === "-", quoted: b[2] !== "", delim: b[3] };
  return null;
}

/**
 * Take the file bodies out of the Think step's text, so no later step has to copy them: what a
 * model wrote once is what gets written. Lifted, verbatim:
 *   - a fenced block named for its file: ```file:src/a.py (also ```python file:src/a.py, and
 *     path= / filename=);
 *   - a fenced block (not shell) right under a line that names exactly one file and says its
 *     content follows ("Create `fix.py` with this exact content:", "File: fix.py");
 *   - a complete `cat > file <<'EOF' … EOF` heredoc, when the shell would not change the body
 *     (a quoted delimiter, or no $, backtick or backslash in it).
 * A block that is never closed (a reply cut off) is left where it is: half a file is not written.
 */
export function liftFiles(text: string): Lifted {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  const files = new Map<string, string>();
  const put = (path: string, content: string) => {
    files.delete(path);
    files.set(path, content);
    out.push(fileMarker(path, content));
  };
  /** The file a label line names, when it names exactly one and says content follows. */
  const labelled = (): string | null => {
    let k = out.length - 1;
    while (k >= 0 && !out[k].trim()) k--;
    if (k < 0 || out.length - 1 - k > 1) return null;
    const label = strip(out[k]);
    const direct = /^(?:file|path|filename|file ?name)\s*[:=]\s*(\S.*)$/i.exec(label);
    if (direct) {
      const p = cleanPath(direct[1]);
      return p && !/\s/.test(p) ? p : null;
    }
    // "Create `fix.py` with this content:" or "Action 1 - Create probe.py" (a line that says a
    // file is made and names exactly one); never a line about running something or its output.
    const saysContent =
      /\bcontents?\b|\bfollowing code\b|\bcode below\b/i.test(label) && /[:：]\s*$/.test(label);
    const saysMake =
      /\b(?:create|write|save|add|put|make)\b/i.test(label) &&
      !/\b(?:run|execute|output|prints?|expected|result|shows?)\b/i.test(label);
    if (!saysContent && !saysMake) return null;
    const found = new Set<string>();
    for (const m of label.matchAll(FILE_TOKEN)) found.add(cleanPath(m[1] ?? m[2]));
    return found.size === 1 ? [...found][0] : null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*(.*?)\s*$/.exec(line);
    if (fence) {
      const info = fence[2];
      const named = /^(?:[\w+#.-]+[\s,]+)?(?:file|path|filename)\s*[:=]\s*(\S.*)$/i.exec(info);
      const lang = /^[\w+#.-]*/.exec(info)?.[0] ?? "";
      const path = named
        ? cleanPath(named[1])
        : !SHELL_LANGS.test(lang) && !/[:=]/.test(info)
          ? labelled()
          : null;
      if (path && !/[\s$]/.test(path)) {
        let close = -1;
        for (let k = i + 1; k < lines.length; k++) {
          const t = lines[k].trim();
          if (t.startsWith(fence[1]) && t.replace(/[`~]/g, "") === "" && t[0] === fence[1][0]) {
            close = k;
            break;
          }
        }
        if (close !== -1 && lines.slice(i + 1, close).some((l) => l.trim())) {
          put(path, lines.slice(i + 1, close).join("\n"));
          i = close + 1;
          continue;
        }
      }
      out.push(line);
      i++;
      continue;
    }
    const h = heredocWrite(line);
    if (h && h.path && !/[$`]/.test(h.path)) {
      let end = -1;
      for (let k = i + 1; k < lines.length; k++)
        if ((h.dash ? lines[k].trim() : lines[k].replace(/\s+$/, "")) === h.delim) {
          end = k;
          break;
        }
      if (end !== -1) {
        const body = lines.slice(i + 1, end);
        if (body.some((l) => l.trim()) && (h.quoted || !/[$`\\]/.test(body.join("\n")))) {
          put(h.path, (h.dash ? body.map((l) => l.replace(/^\t+/, "")) : body).join("\n"));
          i = end + 1;
          continue;
        }
      }
    }
    out.push(line);
    i++;
  }
  return {
    files: [...files].map(([path, content]) => ({ path, content })),
    plan: out.join("\n"),
  };
}

/** A shell block of the Think step, lifted out of its text (liftCommands). */
export interface LiftedCommand {
  id: string;
  script: string;
}

function commandMarker(id: string, script: string): string {
  const n = script.split("\n").length;
  return `[command block ${id} (${n} line${n === 1 ? "" : "s"}) is held by the executor; for it output only "RUN: ${id}"]`;
}

/**
 * Take the shell blocks out of the Think step's text (after liftFiles), so that no later step
 * copies a command: a chat page renders `__name__` as bold and drops what is in braces, and a
 * translator that retypes a twenty-line script loses a character somewhere. Lifted, verbatim: a
 * closed fenced block marked as shell (```bash, ```sh, ```console …), and an unmarked one right
 * under a line that says to run it. The block runs as one script, so a `cd` in it holds for the
 * lines after it. A block that holds a file marker is left for the translator.
 */
export function liftCommands(plan: string): { plan: string; commands: LiftedCommand[] } {
  const lines = plan.split("\n");
  const out: string[] = [];
  const commands: LiftedCommand[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*(.*?)\s*$/.exec(line);
    if (!fence) {
      out.push(line);
      i++;
      continue;
    }
    let close = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k].trim();
      if (t.startsWith(fence[1]) && t.replace(/[`~]/g, "") === "" && t[0] === fence[1][0]) {
        close = k;
        break;
      }
    }
    const lang = /^[\w+#.-]*/.exec(fence[2])?.[0] ?? "";
    let k = out.length - 1;
    while (k >= 0 && !out[k].trim()) k--;
    const label = k >= 0 && out.length - 1 - k <= 1 ? strip(out[k]) : "";
    const shell =
      SHELL_LANGS.test(lang) ||
      (fence[2] === "" &&
        /\b(?:run|execute|command|commands|shell|terminal)\b/i.test(label) &&
        !/\b(?:output|prints?|expected|shows?)\b[^:]*[:：]\s*$/i.test(label));
    const body = close === -1 ? [] : lines.slice(i + 1, close);
    // (a console transcript's "$ " prompts come off; its output lines are not there to tell apart)
    const script = body
      .map((l) => l.replace(/^\s*\$\s+/, ""))
      .join("\n")
      .replace(/^\n+|\s+$/g, "");
    if (!shell || close === -1 || !script.trim()) {
      // not ours: copy the block through untouched
      const end = close === -1 ? i : close;
      for (let j = i; j <= end; j++) out.push(lines[j]);
      i = end + 1;
      continue;
    }
    // A file lifted out of the block (a heredoc) stays where it was, as its marker; the commands
    // before and after it are blocks of their own.
    let part: string[] = [];
    const flush = () => {
      const text = part.join("\n").replace(/^\n+|\s+$/g, "");
      part = [];
      if (!text.trim()) return;
      const id = `C${commands.length + 1}`;
      commands.push({ id, script: text });
      out.push(commandMarker(id, text));
    };
    for (const l of script.split("\n")) {
      if (l.startsWith("[file block: ")) {
        flush();
        out.push(l);
      } else part.push(l);
    }
    flush();
    i = close + 1;
  }
  return { plan: out.join("\n"), commands };
}

/** What a model's retyping changes without meaning to: emphasis marks, braces, quotes, spacing. */
function skeleton(s: string): string {
  return s.replace(/[*_`{}\\"'\s]/g, "");
}

function isSubsequence(small: string, big: string): boolean {
  let j = 0;
  for (let i = 0; i < big.length && j < small.length; i++) if (big[i] === small[j]) j++;
  return j === small.length;
}

/**
 * A one-line command as the Think step wrote it, when the translator's copy is that command with
 * characters lost or turned into markdown (`np.__version__` came back as `np.**version**`, a set
 * literal without its braces). The candidates are the plan's own code: its backticked spans and
 * the lines of its code blocks. Returned unchanged when the plan holds it as it is, or when no
 * single candidate is clearly the same command.
 */
export function restoreCommand(command: string, plan: string): string {
  const cmd = command.trim();
  if (!cmd || cmd.includes("\n") || plan.includes(cmd)) return command;
  const candidates = new Set<string>();
  for (const m of plan.matchAll(/`([^`\n]{4,})`/g)) candidates.add(m[1].trim());
  let fenced = false;
  for (const raw of plan.split("\n")) {
    if (/^\s*(?:`{3,}|~{3,})/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    const line = raw.replace(/^\s*\$\s+/, "").trim();
    if (line.length >= 4 && (fenced || /^\s{4,}\S/.test(raw))) candidates.add(line);
  }
  const want = skeleton(cmd);
  if (want.length < 6) return command;
  const same = [...candidates].filter((c) => skeleton(c) === want);
  if (same.length === 1) return same[0];
  if (same.length > 1) return command;
  const close = [...candidates].filter((c) => {
    const have = skeleton(c);
    return have.length >= 12 && want.length / have.length >= 0.8 && isSubsequence(want, have);
  });
  return close.length === 1 ? close[0] : command;
}

/**
 * A path as the plan (or the request's must-match list) spells it, when the translator's copy is
 * that name with marks lost or changed. Unchanged when it is there as written or nothing matches.
 */
export function restorePath(p: string, plan: string, exact: string[] = []): string {
  if (!p || plan.includes(p) || exact.includes(p)) return p;
  const candidates = new Set<string>(exact.filter((e) => /[./]/.test(e) && !/\s/.test(e)));
  for (const m of plan.matchAll(FILE_TOKEN)) candidates.add(cleanPath(m[1] ?? m[2]));
  const want = skeleton(p);
  const same = [...candidates].filter((c) => skeleton(c) === want);
  return same.length === 1 ? same[0] : p;
}

function normPath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+/g, "/");
}

/** The lifted file a path means: the same path, one a suffix of the other, or the only one of that name. */
export function matchFile(files: LiftedFile[], p: string): LiftedFile | null {
  const want = normPath(p);
  const exact = files.find((f) => normPath(f.path) === want);
  if (exact) return exact;
  const suffix = files.filter((f) => {
    const have = normPath(f.path);
    return have.endsWith(`/${want}`) || want.endsWith(`/${have}`);
  });
  if (suffix.length === 1) return suffix[0];
  const same = files.filter((f) => baseName(f.path) === baseName(want));
  return same.length === 1 ? same[0] : null;
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
const NONE_RE =
  /^(?:none|no actions?(?: needed| required)?|nothing(?: to (?:do|run))?|done)\s*[.!]?$/i;
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
  if (
    b.length >= 2 &&
    /^(`{3,}|~{3,})/.test(b[0].trim()) &&
    /^(`{3,}|~{3,})\s*$/.test(b.at(-1)!.trim())
  )
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
 * with bold or backticks; RUN followed by a fenced block (each line a command, or one script) or
 * carrying a heredoc on the lines under it; WRITE / REPLACE content in <<< >>> or a code fence;
 * READ "path:10-20" / "path lines 10 to 20". Prose lines are ignored. At most `max` actions.
 *
 * `files` are the bodies lifted from the Think text (liftFiles): a WRITE that names one gets that
 * body, verbatim, whatever the translator copied or dropped; so does a bare `cat > file`; a
 * lifted file no action mentions is written first. A WRITE with no content and nothing lifted
 * for it, or a `cat >` with no heredoc body, is not an action: it goes to `rejected`.
 */
export function parseActions(
  text: string,
  max = 8,
  files: LiftedFile[] = [],
  commands: LiftedCommand[] = [],
): ParsedActions {
  const lines = text.replace(/\r/g, "").split("\n");
  const actions: Action[] = [];
  const problems: string[] = [];
  const rejected: { at: number; text: string }[] = [];
  const used = new Set<string>();
  const usedCommands = new Set<string>();
  const writeLifted = (f: LiftedFile) => {
    if (!used.has(f.path)) actions.push({ kind: "write", path: f.path, content: f.content });
    used.add(f.path);
  };
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
        // A lifted block, named by its marker: the script as the Think step wrote it.
        const held = /^\[?(?:command )?(?:block )?(C\d+)\]?$/i.exec(command.trim());
        const lifted = held ? commands.find((c) => c.id === held[1].toUpperCase()) : undefined;
        if (lifted) {
          usedCommands.add(lifted.id);
          actions.push({ kind, command: lifted.script });
          break;
        }
        if (!command) {
          const b = readBlock(lines, i);
          if (b) {
            command = b.body.trim();
            i = b.next;
          }
        }
        if (!command) {
          problems.push(`RUN without a command: ${clip(raw.trim(), 80)}`);
          break;
        }
        // A heredoc opened on the RUN line: its body is the lines under it, up to the delimiter.
        const here = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(command);
        const complete = (c: string, delim: string) =>
          c.split("\n").some((l, n) => n > 0 && l.trim() === delim);
        if (here && !command.includes("\n")) {
          for (let k = i; k < Math.min(lines.length, i + 600); k++)
            if (lines[k].trim() === here[2]) {
              command = [arg.replace(/^`+|`+$/g, ""), ...lines.slice(i, k + 1)].join("\n");
              i = k + 1;
              break;
            }
        }
        const first = command.split("\n")[0];
        const write = heredocWrite(first);
        const bare = /^\s*cat\s*>\s*(\S+)\s*$/.exec(command);
        const target = bare
          ? cleanPath(bare[1])
          : write && !complete(command, write.delim)
            ? write.path
            : null;
        if (target !== null) {
          const f = matchFile(files, target);
          if (f) writeLifted(f);
          else
            rejected.push({
              at: actions.length,
              text: `RUN: ${clip(first.trim(), 120)} was not run: it has no heredoc body, so it would write nothing and wait for input. Give the file in a file block (${"```"}file:${target}) instead.`,
            });
          break;
        }
        if (here && !complete(command, here[2])) {
          rejected.push({
            at: actions.length,
            text: `RUN: ${clip(first.trim(), 120)} was not run: the heredoc (<<${here[2]}) has no body. Put the script in a file block and run the file.`,
          });
          break;
        }
        actions.push({ kind, command });
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
        const p = cleanPath(arg.replace(/\s+(?:with(?: content)?|content)\s*:?\s*$/i, ""));
        const b = readBlock(lines, i);
        if (b) i = b.next;
        if (!p) {
          problems.push(`WRITE without a path: ${clip(raw.trim(), 80)}`);
          break;
        }
        // The body the Think step wrote wins over whatever was copied here.
        const f = matchFile(files, p);
        if (f) writeLifted(f);
        else if (b && b.body.trim()) actions.push({ kind, path: p, content: b.body });
        else
          rejected.push({
            at: actions.length,
            text: `WRITE: ${p} was not done: ${b ? "its content was empty" : "no content came with it"}. Give the whole file in a file block (${"```"}file:${p}); for an empty file use RUN: touch ${p}.`,
          });
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
          problems.push(
            `REPLACE ${p}: the block needs the old text, a === line, then the new text`,
          );
        else actions.push({ kind, path: p, find: parts.find, with: parts.with });
        break;
      }
    }
  }
  // A file block is an instruction to write that file, whether or not an action repeated it.
  const unmentioned = files.filter((f) => !used.has(f.path));
  if (unmentioned.length) {
    actions.unshift(
      ...unmentioned.map((f) => ({ kind: "write" as const, path: f.path, content: f.content })),
    );
    for (const r of rejected) r.at += unmentioned.length;
  }
  if (actions.length > max) {
    problems.push(`${actions.length - max} action(s) beyond the limit of ${max} were dropped`);
    actions.length = max;
  }
  // A translator that typed a lifted block's command out instead of naming the block: the
  // block's own text is what runs.
  const flat = (t: string) => t.replace(/\s+/g, " ").trim();
  for (const c of commands) {
    if (usedCommands.has(c.id)) continue;
    const typed = actions.find(
      (a) =>
        a.kind === "run" &&
        (flat(a.command) === flat(c.script) || skeleton(a.command) === skeleton(c.script)),
    );
    if (typed && typed.kind === "run") {
      typed.command = c.script;
      usedCommands.add(c.id);
      continue;
    }
    // Or typed it out line by line, one RUN each (a `cd` would then hold for nothing): the lines
    // become the one script again, where the first of them stood.
    const want = c.script.split("\n").map(flat).filter(Boolean);
    const at = want.map((l) =>
      actions.findIndex(
        (a) => a.kind === "run" && (flat(a.command) === l || skeleton(a.command) === skeleton(l)),
      ),
    );
    if (want.length > 1 && at.every((n) => n !== -1) && new Set(at).size === at.length) {
      const first = Math.min(...at);
      actions[first] = { kind: "run", command: c.script };
      for (const n of at.filter((x) => x !== first).sort((a, b) => b - a)) {
        actions.splice(n, 1);
        for (const r of rejected) if (r.at > n) r.at--;
      }
      usedCommands.add(c.id);
    }
  }
  const unrun = commands.filter((c) => !usedCommands.has(c.id)).map((c) => c.id);
  return {
    actions,
    none: none && !actions.length && !rejected.length,
    problems,
    rejected,
    unrun,
  };
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
  const m =
    /^\W*status\W+(done|complete[d]?|success|ok|blocked|failed|fail|partial|incomplete)\b/im.exec(
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
  const m =
    /^\W{0,4}(?:finished|final answer|all done|task complete[d]?)\W{0,4}\s*[:\-–—]\s*/im.exec(t);
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
