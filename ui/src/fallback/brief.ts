// A brief of a thread, for carrying it over to another backend (a tier thread continued in
// Claude Code or Codex): what the user asked, what changed, what ran last, and where the agent
// left off. Built from the thread as the page has it, by rules, in a few milliseconds; bounded
// so it fits any fallback's first message.

import type { ThreadItem } from "../protocol";
import type { ThreadView } from "../store/state";

const MAX_USER = 12;
const USER_CHARS = 1200;
const LAST_CHARS = 3000;
const TOTAL_CHARS = 14_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function threadBrief(v: ThreadView): string {
  const items = v.turns.flatMap((t) => t.items);
  const asks = items
    .filter((i): i is Extract<ThreadItem, { type: "userMessage" }> => i.type === "userMessage")
    .map((i) =>
      i.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
  const shown =
    asks.length > MAX_USER ? [...asks.slice(0, 2), ...asks.slice(-(MAX_USER - 2))] : asks;

  const files = new Map<string, string>();
  for (const i of items)
    if (i.type === "fileChange")
      for (const c of i.changes)
        files.set(
          c.path,
          c.kind.type === "add" ? "created" : c.kind.type === "delete" ? "deleted" : "edited",
        );

  const commands = items
    .filter(
      (i): i is Extract<ThreadItem, { type: "commandExecution" }> => i.type === "commandExecution",
    )
    .slice(-8)
    .map(
      (c) =>
        `\`${clip(c.command.replace(/\s+/g, " "), 160)}\`${c.exitCode != null ? ` (exit ${c.exitCode})` : ""}`,
    );

  const last = [...items].reverse().find((i) => i.type === "agentMessage" && i.text.trim());
  const title = v.thread.name || v.thread.preview?.split("\n")[0] || "a thread";

  const parts = [
    `[Continued from the Provenance thread "${clip(title, 120)}"${v.cwd ? ` in ${v.cwd}` : ""}, ` +
      "which ran on other models. This is where it stands.]",
    "What the user asked, in order:\n" +
      shown.map((a, n) => `${n + 1}. ${clip(a, USER_CHARS)}`).join("\n") +
      (asks.length > shown.length
        ? `\n(${asks.length - shown.length} more in between left out)`
        : ""),
  ];
  if (files.size)
    parts.push(
      "Files changed so far: " +
        [...files]
          .map(([p, k]) => `${p} (${k})`)
          .slice(0, 40)
          .join(", ") +
        (files.size > 40 ? `, and ${files.size - 40} more` : ""),
    );
  if (commands.length) parts.push("Last commands run: " + commands.join(", "));
  if (last && last.type === "agentMessage")
    parts.push("Where the agent left off:\n" + clip(last.text.trim(), LAST_CHARS));
  // The closing line always stays: it marks where the brief ends (splitBrief).
  return `${clip(parts.join("\n\n"), TOTAL_CHARS - BRIEF_END.length - 2)}\n\n${BRIEF_END}`;
}

const BRIEF_START = "[Continued from the Provenance thread ";
const BRIEF_END = "Check the files' current state before relying on this summary.";

/** A message that starts with a brief: the brief, and what the user wrote after it. */
export function splitBrief(text: string): { brief: string; rest: string } | null {
  if (!text.startsWith(BRIEF_START)) return null;
  const end = text.indexOf(BRIEF_END);
  if (end < 0) return null;
  const cut = end + BRIEF_END.length;
  return { brief: text.slice(0, cut), rest: text.slice(cut).trim() };
}
