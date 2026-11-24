// Hyperexperimental's working memory: what the job knows from step to step, kept by code.
//
// A step used to end with a model rewriting a summary, and the summary was all the next step
// had. In the benchmark's transcripts that is where the steps went: a summary cannot hold a file,
// so every step read the file again; a rewritten summary dropped what an earlier step had found,
// so the check was run again; and a long output was shown cut in the middle, so the command was
// run again in smaller pieces. Here nothing passes through a model on its way to the next step:
//
//   - the log: one line per step, written by code (what was meant, each action and how it ended);
//   - kept facts: lines the Think step itself asked to keep ("KEEP: …"), as it wrote them;
//   - pinned files: the one or two files being worked on, read from disk again before every
//     Think, with line numbers (the newest takes the room it needs, an older one what is left;
//     a third replaces the oldest: the pins rotate, they do not grow);
//   - saved outputs: a long output is shown once with its first and last lines, and all of it is
//     in a file whose path and line count the result names, so the next step reads a range
//     instead of running the command again;
//   - seen: what each look (and each run) came to, with the state it was made in, so the same
//     look with nothing changed in between is answered from memory instead of being run.
//
// Everything has a bound. When the log outgrows its share, its oldest half is folded into a
// digest: by one model call when one can be had (the only "summarize" left), else by code.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clip, clipMiddle } from "./notes.ts";

export interface Pin {
  path: string;
  /** First line shown (1-based). */
  start: number;
  /** Last line wanted (null: as many as fit). */
  end: number | null;
  /** The step that pinned or last touched it. */
  step: number;
}

export interface Memory {
  /** What came before this job in the thread (a hand-over, the answers to earlier requests). */
  carried: string;
  /** The folded part of the log. */
  digest: string;
  /** How many steps the digest covers. */
  folded: number;
  /** One line per step, oldest first. */
  log: { step: number; text: string }[];
  /** Facts the Think step asked to keep, oldest first. */
  kept: string[];
  pins: Pin[];
  /** Counts every change of state (a file written, a command that was more than a look). */
  version: number;
  /** By action signature: when it last ran, the state it ran in, and what it came to. */
  seen: Record<string, { step: number; version: number; note: string }>;
}

export const MEMORY_LIMIT = 3000;
const LOG_SHARE = 1400;
const KEPT_LIMIT = 700;
const DIGEST_LIMIT = 700;
const CARRIED_LIMIT = 1500;
export const MAX_PINS = 2;
/** The pinned files' share of a Think prompt, at most. */
export const PINS_LIMIT = 3600;
/** One step's results as the next Think is shown them, at most. */
export const RESULTS_MAX = 4200;

export function emptyMemory(carried = ""): Memory {
  return {
    carried: clipMiddle(carried.trim(), CARRIED_LIMIT),
    digest: "",
    folded: 0,
    log: [],
    kept: [],
    pins: [],
    version: 0,
    seen: {},
  };
}

/** A stored memory, whatever shape an older thread file left it in. */
export function reviveMemory(m: Partial<Memory> | null | undefined, summary: string): Memory {
  const base = emptyMemory(summary);
  if (!m || typeof m !== "object") return base;
  return {
    carried: typeof m.carried === "string" ? m.carried : base.carried,
    digest: typeof m.digest === "string" ? m.digest : "",
    folded: typeof m.folded === "number" ? m.folded : 0,
    log: Array.isArray(m.log) ? m.log : [],
    kept: Array.isArray(m.kept) ? m.kept : [],
    pins: Array.isArray(m.pins) ? m.pins.slice(-MAX_PINS) : [],
    version: typeof m.version === "number" ? m.version : 0,
    seen: m.seen && typeof m.seen === "object" ? m.seen : {},
  };
}

export function addKept(m: Memory, facts: string[]): void {
  for (const f of facts) {
    const v = clip(f, 240);
    if (!v || m.kept.includes(v)) continue;
    m.kept.push(v);
  }
  // the oldest go first; what they said is in the digest if a fold has happened since
  while (m.kept.length > 1 && m.kept.join("\n").length + m.kept.length * 2 > KEPT_LIMIT)
    m.kept.shift();
}

export function addLog(m: Memory, step: number, intent: string, outcomes: string[]): void {
  // (emphasis marks go; an underscore is part of a name)
  const what = clip(
    intent
      .replace(/[`*]+/g, "")
      .replace(/^[#>\s]+/, "")
      .trim(),
    120,
  );
  m.log.push({
    step,
    text: clip(`${what ? `${what} ` : ""}→ ${outcomes.join("; ") || "nothing ran"}`, 460),
  });
}

function logText(m: Memory): string {
  return m.log.map((e) => `${e.step}. ${e.text}`).join("\n");
}

/** Has the log outgrown its share (so that its oldest half should be folded)? */
export function needsFold(m: Memory): boolean {
  return m.log.length > 3 && logText(m).length > LOG_SHARE;
}

/** The entries a fold takes out of the log: its oldest half (always leaving the last two). */
export function takeForFold(m: Memory): { step: number; text: string }[] {
  const n = Math.max(1, Math.min(m.log.length - 2, Math.ceil(m.log.length / 2)));
  return m.log.splice(0, n);
}

/** A fold without a model: the entries themselves, shortened. */
export function foldByCode(m: Memory, taken: { step: number; text: string }[]): void {
  const add = taken.map((e) => `${e.step}. ${clip(e.text, 110)}`).join(" | ");
  m.digest = clipMiddle(`${m.digest ? `${m.digest} | ` : ""}${add}`, DIGEST_LIMIT);
  m.folded += taken.length;
}

/** A fold a model wrote. */
export function foldWith(m: Memory, taken: { step: number; text: string }[], digest: string): void {
  m.digest = clipMiddle(digest.trim(), DIGEST_LIMIT);
  m.folded += taken.length;
}

/** The memory as the Think step (and a person reading where things stand) sees it. */
export function renderMemory(m: Memory, limit = MEMORY_LIMIT): string {
  const kept = m.kept.length
    ? `KEPT FACTS (as an earlier step wrote them):\n${m.kept.map((k) => `- ${k}`).join("\n")}`
    : "";
  const digest = m.digest ? `EARLIER STEPS (${m.folded}, folded):\n${m.digest}` : "";
  let log = m.log.length ? `STEPS (recorded by code: action → how it ended):\n${logText(m)}` : "";
  if (log.length > LOG_SHARE + 400) log = clipMiddle(log, LOG_SHARE + 400);
  const used = kept.length + digest.length + log.length + 6;
  const carried = m.carried
    ? `BEFORE THIS JOB:\n${clipMiddle(m.carried, Math.max(200, Math.min(CARRIED_LIMIT, limit - used)))}`
    : "";
  const text = [carried, digest, kept, log].filter(Boolean).join("\n\n");
  return text.length > limit ? clipMiddle(text, limit) : text;
}

// ---- pins ------------------------------------------------------------------------------------------

/** Pin a file (or move its window); the oldest pin makes room when there are more than MAX_PINS. */
export function pin(
  m: Memory,
  file: string,
  step: number,
  start = 1,
  end: number | null = null,
): void {
  m.pins = m.pins.filter((p) => p.path !== file);
  m.pins.push({ path: file, start: Math.max(1, start), end, step });
  while (m.pins.length > MAX_PINS) m.pins.shift();
}

export function unpin(m: Memory, file: string): void {
  m.pins = m.pins.filter((p) => p.path !== file);
}

/** Lines `start`.. of a text with their numbers, as many whole lines as fit `budget`. */
function numberedWindow(
  content: string,
  start: number,
  end: number | null,
  budget: number,
): { text: string; from: number; to: number; total: number } {
  const lines = content.replace(/\n$/, "").split("\n");
  const total = lines.length;
  let from = Math.min(Math.max(1, start), Math.max(1, total));
  const want = end === null ? total : Math.min(total, Math.max(end, from));
  const width = String(total).length;
  const row = (n: number) => `${String(n).padStart(width)}| ${clip1(lines[n - 1], 240)}`;
  // (when the whole file fits, the window is the whole file whatever was asked for)
  const all = lines.reduce((a, l) => a + Math.min(l.length, 240) + width + 3, 0);
  if (all <= budget) from = 1;
  const out: string[] = [];
  let used = 0;
  let to = from - 1;
  for (let n = from; n <= (all <= budget ? total : want); n++) {
    const r = row(n);
    if (used + r.length + 1 > budget && out.length) break;
    out.push(r);
    used += r.length + 1;
    to = n;
  }
  // room left after the wanted range: go on past it
  for (let n = to + 1; n <= total; n++) {
    const r = row(n);
    if (used + r.length + 1 > budget) break;
    out.push(r);
    used += r.length + 1;
    to = n;
  }
  return { text: out.join("\n"), from, to, total };
}

function clip1(line: string, n: number): string {
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

/**
 * The pinned files as text, in at most `budget` characters: the newest pin takes what it needs,
 * the older one what is left. `contents` is each pinned file as it is on disk now (null: gone or
 * not text; the pin is dropped). "" when nothing is pinned or nothing fits.
 */
export function renderPins(
  m: Memory,
  contents: Map<string, string | null>,
  budget: number,
): string {
  for (const p of [...m.pins]) if (contents.get(p.path) == null) unpin(m, p.path);
  if (!m.pins.length || budget < 300) return "";
  const out: string[] = [];
  let left = budget;
  for (const p of [...m.pins].reverse()) {
    const content = contents.get(p.path)!;
    if (left < 260) {
      out.unshift(
        `--- ${p.path}: pinned, no room to show it this step (READ: ${p.path} for a range) ---`,
      );
      continue;
    }
    const w = numberedWindow(content, p.start, p.end, left - 170);
    const whole = w.from === 1 && w.to === w.total;
    const head = whole
      ? `--- ${p.path} (all ${w.total} lines, as on disk now) ---`
      : `--- ${p.path} (lines ${w.from}-${w.to} of ${w.total}, as on disk now; for others: READ: ${p.path} <first>-<last>) ---`;
    const block = `${head}\n${w.text}`;
    out.unshift(block);
    left -= block.length + 2;
  }
  return out.join("\n\n");
}

// ---- outputs ---------------------------------------------------------------------------------------

/** Where one thread's long outputs are kept: the system temp folder (readable from every sandbox preset). */
export function outputDir(threadId: string): string {
  return path.join(tmpdir(), "provenance-requests", `${threadId.replace(/[^\w.-]/g, "_")}-out`);
}

/** Save a long output in full; null when it cannot be written. */
export function saveOutput(threadId: string, step: number, n: number, text: string): string | null {
  try {
    const dir = outputDir(threadId);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `step${step}-${n}.txt`);
    writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
    return file;
  } catch {
    return null;
  }
}

/**
 * An output as it is shown, once: whole when it fits `budget`, otherwise its first and last lines
 * with the count of what is between them and where all of it is (`saved`, when it was saved).
 * Whole lines only; a single very long line is cut.
 */
export function showOutput(full: string, budget: number, saved: string | null): string {
  const text = full.replace(/\s+$/, "");
  if (!text) return "(no output)";
  if (text.length <= budget) return text;
  const lines = text.split("\n").map((l) => clip1(l, 300));
  const note = 190 + (saved?.length ?? 0);
  const room = Math.max(200, budget - note);
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  let i = 0;
  let j = lines.length - 1;
  // the head gets a little more than half; then the tail; whole lines
  while (i <= j && used + lines[i].length + 1 <= room * 0.55) {
    used += lines[i].length + 1;
    head.push(lines[i++]);
  }
  while (j >= i && used + lines[j].length + 1 <= room) {
    used += lines[j].length + 1;
    tail.unshift(lines[j--]);
  }
  if (j < i) return lines.join("\n");
  if (!head.length && !tail.length) return clipMiddle(text, budget);
  const gap = `[… lines ${i + 1}-${j + 1} of ${lines.length} are not shown${
    saved ? `; the whole output is saved: READ: ${saved} ${i + 1}-${j + 1}` : ""
  } …]`;
  return [...head, gap, ...tail].join("\n");
}

/** A short, stable fingerprint of a text (to tell a new result from one already seen). */
export function fingerprint(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

/** What a look came to, in a line or two (what a repeat of it is answered with). */
export function seenNote(exitCode: number, full: string, saved: string | null): string {
  const lines = full.replace(/\s+$/, "").split("\n");
  const first = clip(lines.slice(0, 3).join(" ⏎ "), 200);
  return `${exitCode === 0 ? "ok" : `exit ${exitCode}`}, ${lines.length} line${lines.length === 1 ? "" : "s"}${first ? `, starting: ${first}` : ""}${saved ? ` (all of it: READ: ${saved})` : ""}`;
}
