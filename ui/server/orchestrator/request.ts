// The person's request, kept as written.
//
// Between the request and whoever does the work stand models that rewrite: a planner that turns
// "save it as meeting_scheduled.ics" into "write the calendar file", a translator that copies a
// command and drops a character. Nothing in this file is written by a model. It gives the
// orchestrators three things, all made by code from the request's own text:
//
//   - the request itself, whole when it fits a prompt's share and otherwise the lines a task
//     depends on (the planner names them by number, it does not rewrite them), with what was left
//     out marked as left out (requestLines, requestExcerpt);
//   - the exact names in it: paths, file names, quoted and backticked strings, flags, identifiers
//     and numbers with their units (exactNames). They travel as a "must match exactly" list in
//     the notes, the briefs and the think prompt;
//   - the checks a turn ends with, as far as code can make them: every file the request names as
//     output is there under exactly that name (and a file of nearly that name is called what it
//     is, a near miss), and nothing was written to a path outside the folder that the request did
//     not name (nearMiss, strayPaths).
//
// The reviewer's reply (one plain call at the end of a turn that changed something; prompts.ts
// reviewPrompt) is read here too: per requirement MET / NOT SHOWN / VIOLATED, and the cheapest
// check that would settle what is not shown (parseReview).

import path from "node:path";

/** File types a request can name as something to produce or read. */
export const FILE_EXT = new Set(
  "py js mjs cjs ts tsx jsx json jsonl md txt csv tsv yaml yml toml html htm css scss sh bash zsh rs go c h cc cpp hpp java kt rb php sql db sqlite sqlite3 xml ini cfg conf log out png jpg jpeg gif svg pdf ipynb lock r jl swift pl lua zip tar gz tgz patch diff bin dat parquet npy npz pkl proto gradle cmake mk tex rst wasm ics rq sparql ttl rdf nt vim el wal bak env pem key crt service".split(
    " ",
  ),
);

const PATH_RE =
  /(?:^|[\s"'`(\[=<>])((?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w.@+-]+\.([A-Za-z][A-Za-z0-9]{0,7}))(?=$|[\s"'`)\],:;?!<>]|\.(?:\s|$))/g;
const DIR_RE =
  /(?:^|[\s"'`(\[=])((?:~|\.{1,2})?\/(?:[\w.@+-]+\/)*[\w.@+-]*)(?=$|[\s"'`)\],:;?!]|\.(?:\s|$))/g;

/** The file names and paths in a text, in order (a name counts when its extension is a file type). */
export function filesNamed(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    // A known file type, or any extension on a path written out as one (/app/out.ics, ./a.xyz).
    const explicit = /^(?:~\/|\.{1,2}\/|\/)/.test(m[1]) && /^[A-Za-z][A-Za-z0-9]{1,5}$/.test(m[2]);
    if (!FILE_EXT.has(m[2].toLowerCase()) && !explicit) continue;
    if (/^www\./i.test(m[1]) || /:\/\/\S*$/.test(text.slice(0, m.index! + 1))) continue;
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * What must not be respelled: copied out of the request by code, in order of appearance within
 * each kind. Paths and file names first, then backticked and quoted strings, flags and
 * identifiers, then numbers with what they count. Bounded by `max` entries and `maxChars`.
 */
export function exactNames(request: string, max = 28, maxChars = 800): string[] {
  const text = request.replace(/\r/g, "");
  const kinds: string[][] = [[], [], [], [], []];
  const add = (kind: number, s: string) => {
    const v = s.trim();
    if (!v || v.length > (kind === 0 ? 220 : 120) || /\n/.test(v)) return;
    if (kinds.some((k) => k.includes(v))) return;
    kinds[kind].push(v);
  };
  for (const f of filesNamed(text)) add(0, f);
  for (const m of text.matchAll(DIR_RE)) {
    const d = m[1].replace(/\.$/, "");
    // a folder: at least two segments, or a well-known root ("/app", "/app/data/")
    if (d.length < 4 || /:\/\/\S*$/.test(text.slice(0, m.index! + 1))) continue;
    if (kinds[0].some((f) => f === d || f.startsWith(d.endsWith("/") ? d : `${d}/`))) continue;
    if (
      /^\/[\w.@+-]+\/?$/.test(d) &&
      !/^\/(?:app|data|tmp|opt|srv|home|mnt|var|etc|usr|workspace|work)\/?$/.test(d)
    )
      continue;
    add(0, d);
  }
  // (spans are paired off in order whatever their length, so a long one cannot make the text
  // between two spans look like a span; a path in backticks is already listed)
  for (const m of text.matchAll(/`([^`\n]+)`/g))
    if (!kinds[0].includes(m[1].trim()) && /\w/.test(m[1])) add(1, m[1]);
  for (const m of text.matchAll(/(?:^|[\s(\[=:,])"([^"\n]{2,70})"(?=$|[\s)\],.:;?!])/g))
    if (/\w/.test(m[1])) add(1, m[1]);
  for (const m of text.matchAll(/(?:^|[\s(\[=:,])'([^'\n]{2,70})'(?=$|[\s)\],.:;?!])/g))
    if (/\w/.test(m[1])) add(1, m[1]);
  for (const m of text.matchAll(/(?:^|[\s(\[=`"'])(--[A-Za-z][\w-]*(?:=\S+)?)/g)) add(2, m[1]);
  for (const m of text.matchAll(/\b([A-Za-z_][\w.]*\([^()\n]{0,40}\))/g)) add(2, m[1]);
  for (const m of text.matchAll(
    /\b([A-Za-z]+(?:_[A-Za-z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g,
  )) {
    // (an identifier that is only part of a name already listed adds nothing)
    if (!kinds.some((k) => k.some((v) => v.includes(m[1])))) add(2, m[1]);
  }
  // Dates and times of day, as written.
  for (const m of text.matchAll(
    /\b(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?Z?)?|\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)\b/g,
  ))
    add(3, m[1]);
  // "30 neurons", "25 MB", "0.5 seconds", "1e-6", "30x10", "1-hour": a number and the word it
  // counts. List numbering ("1." at the start of a line) and the numbers 0-2 alone are left out.
  const UNIT =
    /^(?:ms|s|sec|secs|min|mins|h|hr|hrs|hour|day|week|month|year|b|kb|mb|gb|tb|kib|mib|gib|px|pt|em|hz|khz|mhz|k|m|million|billion|thousand|hundred|x|times|am|pm|bit|byte|char|line|row|col|column|item|file|step|try|retry|percent|digit|decimal|place)$/i;
  const STOP =
    /^(?:and|or|to|of|the|a|an|in|is|are|as|for|by|at|on|if|it|be|was|with|from|then|that|this|per|each|so|but|not|no)$/i;
  for (const m of text.matchAll(
    /(?:^|[\s(\[=~<>≤≥])(\d[\d,]*(?:\.\d+)?(?:e-?\d+)?(?:\s?[x×]\s?\d+)*)(?:(-[A-Za-z]{2,18})|(\s?%)|\s([A-Za-z][A-Za-z-]{0,18}))?(?=$|[\s)\],.:;?!])/gm,
  )) {
    const num = m[1].replace(/,$/, "");
    const at = m.index! + m[0].indexOf(m[1]);
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    if (/^\s*$/.test(text.slice(lineStart, at)) && /^[.)]/.test(text.slice(at + num.length)))
      continue; // "1." a list number
    if (/\d-\d/.test(text.slice(Math.max(0, at - 1), at + num.length + 2))) continue; // part of a date or a range
    // The word after a number is kept when it reads as what is counted: a unit, or a plural.
    const counted =
      m[4] &&
      !STOP.test(m[4]) &&
      !/[x×]/.test(num) &&
      (UNIT.test(m[4]) || /^[A-Za-z-]{3,}s$/.test(m[4]));
    const v = `${num}${m[2] ?? ""}${m[3] ? "%" : ""}${counted ? ` ${m[4]}` : ""}`;
    // (a bare whole number says least: it goes last, and 0-2 alone are left out)
    if (/^\d+$/.test(v)) {
      if (Number(v) >= 3 && v.length <= 9) add(4, v);
    } else add(3, v);
  }
  const out: string[] = [];
  let used = 0;
  for (const kind of kinds)
    for (const v of kind) {
      if (out.length >= max || used + v.length + 2 > maxChars) continue;
      out.push(v);
      used += v.length + 2;
    }
  return out;
}

/**
 * The must-match list as one line for a prompt, in at most `maxChars` characters ("" when there
 * is nothing, or no room for even one name). Names are never cut: one that does not fit is left
 * out whole. Absolute paths that share a long folder are written once under it ("in /long/folder/:
 * a.ics | b.ics"), which is the same paths in fewer characters.
 */
export function exactLine(exact: string[], maxChars = 800): string {
  if (!exact.length) return "";
  const head =
    "MUST MATCH EXACTLY (copied by code from the request: use these spellings and values, never a variant): ";
  const abs = exact.filter((e) => e.startsWith("/") && e.lastIndexOf("/") > 0);
  let prefix = "";
  if (abs.length >= 2) {
    const dirs = abs.map((e) => e.slice(0, e.lastIndexOf("/") + 1));
    // the folder most of them are in
    const count = new Map<string, number>();
    for (const d of dirs) count.set(d, (count.get(d) ?? 0) + 1);
    const [best, n] = [...count].sort((x, y) => y[1] - x[1])[0];
    if (n >= 2 && best.length >= 30) prefix = best;
  }
  const parts: string[] = [];
  let used = head.length + (prefix ? prefix.length + 10 : 0);
  const inFolder: string[] = [];
  for (const e of exact) {
    const short = prefix && e.startsWith(prefix) && e.length > prefix.length;
    const v = short ? e.slice(prefix.length) : e;
    if (used + v.length + 3 > maxChars) continue;
    used += v.length + 3;
    if (short) inFolder.push(v);
    else parts.push(v);
  }
  if (!parts.length && !inFolder.length) return "";
  const folder = inFolder.length ? [`in ${prefix}: ${inFolder.join(" | ")}`] : [];
  return `${head}${[...folder, ...parts].join(" | ")}`;
}

// ---- the request in pieces -----------------------------------------------------------------------

/**
 * The request cut into numbered pieces without changing a character: its lines, and a line longer
 * than 320 characters into its sentences. Joined back in order they are the request.
 */
export function requestLines(request: string): string[] {
  const out: string[] = [];
  for (const line of request.replace(/\r/g, "").split("\n")) {
    if (line.length <= 320) {
      out.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > 320) {
      // the last sentence end within the first 320 characters, else the last space
      const head = rest.slice(0, 320);
      let cut =
        Math.max(head.lastIndexOf(". "), head.lastIndexOf("; "), head.lastIndexOf("? ")) + 1;
      if (cut < 80) cut = head.lastIndexOf(" ");
      if (cut < 80) cut = 320;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    out.push(rest);
  }
  return out;
}

/** The request with its pieces numbered, for the planner to name by number: "[3] text". */
export function numbered(request: string, limit: number): string {
  const lines = requestLines(request);
  const text = lines.map((l, i) => (l.trim() ? `[${i + 1}] ${l}` : "")).join("\n");
  if (text.length <= limit) return text;
  // Too long even for the planner: the head and the tail, with their numbers, and the gap said.
  const keepHead: string[] = [];
  const keepTail: string[] = [];
  let used = 0;
  let i = 0;
  let j = lines.length - 1;
  while (i <= j) {
    const a = `[${i + 1}] ${lines[i]}`;
    if (used + a.length + 1 > limit * 0.6) break;
    keepHead.push(lines[i].trim() ? a : "");
    used += a.length + 1;
    i++;
  }
  while (j >= i) {
    const b = `[${j + 1}] ${lines[j]}`;
    if (used + b.length + 1 > limit - 60) break;
    keepTail.unshift(lines[j].trim() ? b : "");
    used += b.length + 1;
    j--;
  }
  const gap = j >= i ? [`[… pieces ${i + 1}-${j + 1} of the request are not shown here …]`] : [];
  return [...keepHead, ...gap, ...keepTail].join("\n");
}

/**
 * The request for one reader, word for word, in at most `budget` characters: all of it when it
 * fits; otherwise the pieces in `needs` (1-based numbers, as the planner named them) first, then
 * as many of the others as fit from the top down, in their original order, with every gap marked.
 */
export function requestExcerpt(
  request: string,
  budget: number,
  needs: number[] = [],
): { text: string; whole: boolean } {
  const whole = request.replace(/\r/g, "").trim();
  if (whole.length <= budget) return { text: whole, whole: true };
  const lines = requestLines(whole);
  const keep = new Set<number>();
  let used = 0;
  const cost = (i: number) => lines[i].length + 1;
  const take = (i: number) => {
    if (i < 0 || i >= lines.length || keep.has(i)) return true;
    if (used + cost(i) > budget - 80) return false;
    keep.add(i);
    used += cost(i);
    return true;
  };
  for (const n of needs) take(n - 1);
  for (let i = 0; i < lines.length; i++) if (!take(i) && lines[i].trim()) break;
  const out: string[] = [];
  let gap = 0;
  const flush = () => {
    if (gap) out.push(`[… ${gap} line${gap === 1 ? "" : "s"} of the request left out here …]`);
    gap = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      flush();
      out.push(lines[i]);
    } else if (lines[i].trim()) gap++;
  }
  flush();
  return { text: out.join("\n").trim(), whole: false };
}

/** "2-5, 9" / "lines 2 to 5 and 9" / "all" -> piece numbers (empty for "all" or nothing readable). */
export function parseNeeds(text: string, max = 400): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d+)\s*(?:-|–|—|to|\.\.)\s*(\d+)|(\d+)/g)) {
    const a = Number(m[1] ?? m[3]);
    const b = Number(m[2] ?? m[3]);
    if (!a || !b || a > max || b > max) continue;
    for (let n = Math.min(a, b); n <= Math.max(a, b) && out.length < 200; n++)
      if (!out.includes(n)) out.push(n);
  }
  return out;
}

// ---- the checks code can make ----------------------------------------------------------------------

function stemOf(p: string): { stem: string; ext: string } {
  const base = p.replace(/\/+$/, "").split("/").pop() ?? p;
  const dot = base.lastIndexOf(".");
  return dot > 0
    ? { stem: base.slice(0, dot).toLowerCase(), ext: base.slice(dot + 1).toLowerCase() }
    : { stem: base.toLowerCase(), ext: "" };
}

function words(stem: string): string[] {
  return stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

function editDistance(a: string, b: string, cap = 4): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The file among `made` that looks like an attempt at `wanted` under another name or in another
 * place: the same name elsewhere, or the same type with a name that shares a word with it, holds
 * it, or is a few letters off ("meeting.ics" for "meeting_scheduled.ics"). null when none does.
 */
export function nearMiss(wanted: string, made: string[]): string | null {
  const w = stemOf(wanted);
  const norm = (p: string) => p.replace(/^\.\//, "");
  let best: string | null = null;
  for (const m of made) {
    if (norm(m) === norm(wanted)) continue;
    const c = stemOf(m);
    if (c.stem === w.stem && c.ext === w.ext) return m; // the same name in another folder
    if (c.ext !== w.ext) {
      // another type counts only under the very same name ("out.txt" for "out.json")
      if (c.stem === w.stem && !best) best = m;
      continue;
    }
    const shared = words(c.stem).some((x) => words(w.stem).includes(x));
    const holds = c.stem.length >= 3 && (w.stem.includes(c.stem) || c.stem.includes(w.stem));
    if ((shared || holds || editDistance(c.stem, w.stem) <= 2) && !best) best = m;
  }
  return best;
}

const TEMP_RE = /^(?:\/private)?\/(?:tmp|var\/folders|var\/tmp)\/|^\/dev\//;

/**
 * Paths outside the working folder that something was written to (file changes recorded there, a
 * command's `>` redirect or `-o` target, a path a report lists under its changes) and that the
 * request does not name. Temp folders don't count. At most six.
 */
export function strayPaths(
  a: { files: string[]; commands: string[]; reports: string[] },
  cwd: string,
  request: string,
): string[] {
  const out: string[] = [];
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  const consider = (raw: string) => {
    const p = raw.replace(/^["'`]+|["'`,;:.)]+$/g, "");
    if (!p.startsWith("/") && !p.startsWith("~/")) return;
    if (p.startsWith(root) || p === cwd || TEMP_RE.test(p)) return;
    if (request.includes(p)) return;
    // a folder the request names covers what is inside it
    const dir = path.dirname(p);
    if (
      dir.length > 1 &&
      (request.includes(`${dir}/`) ||
        new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`).test(request))
    )
      return;
    if (!out.includes(p) && out.length < 6) out.push(p);
  };
  for (const f of a.files) consider(f);
  for (const c of a.commands) {
    for (const m of c.matchAll(/(?:^|[^<>&\d])>{1,2}\s*(["']?)((?:~|)\/[^\s"'|;&)]+)\1/g))
      consider(m[2]);
    for (const m of c.matchAll(/\s(?:-o|--output(?:=|\s))\s*(["']?)((?:~|)\/[^\s"'|;&)]+)\1/g))
      consider(m[2]);
  }
  for (const r of a.reports)
    for (const m of r.matchAll(
      /(?:^|[\s"'`(])((?:\/(?:mnt|home|root|Users|srv|opt|data|workspace|app|output|outputs|results)\/)[^\s"'`),;]+)/g,
    ))
      consider(m[1]);
  return out;
}

// ---- the reviewer's reply ---------------------------------------------------------------------------

export interface ReviewItem {
  requirement: string;
  verdict: "met" | "not-shown" | "violated";
  /** The evidence (met), what is wrong (violated), or the check that would settle it (not shown). */
  note: string;
}

export interface Review {
  items: ReviewItem[];
  /** Items that are not met, in the reviewer's order. */
  open: ReviewItem[];
}

const VERDICT_RE =
  /\b(NOT[ _-]?SHOWN|NOT[ _-]?VERIFIED|UNVERIFIED|UNKNOWN|UNCLEAR|VIOLATED|NOT[ _-]?MET|UNMET|FAILED|FAILS|MISSING|MET|SATISFIED|PASS(?:ED|ES)?|OK)\b/;

/**
 * "R1: <requirement> | MET | <evidence>" lines in whatever shape they came back: numbered or
 * bulleted, with | or - or : between the parts, the verdict in any case, the check on the same
 * line ("CHECK: …") or the next. Lines without a verdict are ignored. At most 12 items.
 */
export function parseReview(text: string): Review {
  const items: ReviewItem[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  for (const raw of lines) {
    const line = raw
      .replace(/^\s*(?:[-*•>]+\s+|#{1,6}\s*)*/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (!line) continue;
    const cont = /^(?:cheapest\s+)?check\s*[:\-–—]\s*(.+)$/i.exec(line);
    if (cont && items.length && items.at(-1)!.verdict !== "met") {
      const cur = items.at(-1)!;
      if (!/check\s*:/i.test(cur.note)) cur.note = `${cur.note} CHECK: ${cont[1].trim()}`.trim();
      continue;
    }
    if (!/^(?:R|req(?:uirement)?\s*)?#?\d+\s*[:.)\-–—|]/i.test(line)) continue;
    const body = line.replace(/^(?:R|req(?:uirement)?\s*)?#?\d+\s*[:.)\-–—|]+\s*/i, "");
    // The verdict is looked for in capitals first (a requirement's own words may say "missing").
    const m = VERDICT_RE.exec(body) ?? new RegExp(VERDICT_RE.source, "i").exec(body);
    if (!m) continue;
    const word = m[1].toUpperCase().replace(/[ _-]/g, "");
    const verdict: ReviewItem["verdict"] = /^(MET|SATISFIED|PASS|PASSED|PASSES|OK)$/.test(word)
      ? "met"
      : /^(VIOLATED|NOTMET|UNMET|FAILED|FAILS|MISSING)$/.test(word)
        ? "violated"
        : "not-shown";
    const clean = (s: string) => s.replace(/^[\s|:\-–—]+|[\s|:\-–—]+$/g, "");
    const requirement = clean(body.slice(0, m.index));
    const note = clean(body.slice(m.index + m[0].length));
    if (!requirement && !note) continue;
    items.push({ requirement: requirement || note, verdict, note: requirement ? note : "" });
    if (items.length >= 12) break;
  }
  return { items, open: items.filter((i) => i.verdict !== "met") };
}
