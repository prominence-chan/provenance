// A brief of a conversation, for handing it to another backend (a tier thread continued in
// Claude Code or Codex, or back; shared/thread-links.ts): the goal, what was asked since, what
// the agent found and decided, the files it changed, what ran last, the plan, where it left off,
// and the latest request verbatim. Built from the conversation as the page has it, by rules, in a
// few milliseconds; bounded so it fits any backend's first message or instructions.
//
// The brief goes only to the model taking over (turn/start's additionalContext for Claude Code,
// Codex and the orchestrators, thread/start's developerInstructions for an app-server). The
// person never sees it and can't correct it, so it keeps what the model needs most first: when it
// would pass the bound, the in-between parts are left out before the goal, the state and the
// latest request are shortened.

import type { ThreadItem } from "../protocol";
import type { ThreadView, TurnView } from "../store/state";
import { MODE_NAME } from "./model";
import { parseFallbackModel } from "../../shared/fallback-api";

const TOTAL_CHARS = 16_000;
const GOAL_CHARS = 2000;
const LATEST_CHARS = 6000;
const ASK_CHARS = 500;
const MIDDLE_ASKS = 8;
const FINDING_CHARS = 400;
const FINDINGS = 6;
const LAST_CHARS = 3000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

type UserItem = Extract<ThreadItem, { type: "userMessage" }>;
type AgentItem = Extract<ThreadItem, { type: "agentMessage" }>;

const userText = (i: UserItem) =>
  i.content
    .map((c) => (c.type === "text" ? (splitBrief(c.text)?.rest ?? c.text) : ""))
    .join("\n")
    .trim();

/** "solstice", "Claude Code", "Codex": what served the turns, in order, each once. */
function modelsOf(v: ThreadView): string[] {
  const names = v.turns.map((t) => {
    const m = t.model ?? v.model;
    const f = parseFallbackModel(m);
    return f ? MODE_NAME[f.mode] : (m ?? "");
  });
  return [...new Set(names.filter(Boolean))];
}

function lastAgentText(t: TurnView): string {
  const a = t.items.findLast((i): i is AgentItem => i.type === "agentMessage" && !!i.text.trim());
  return a?.text.trim() ?? "";
}

export function threadBrief(v: ThreadView): string {
  const turns = v.turns;
  const items = turns.flatMap((t) => t.items);
  const asks = items
    .filter((i): i is UserItem => i.type === "userMessage")
    .map(userText)
    .filter(Boolean);
  const title = v.thread.name || v.thread.preview?.split("\n")[0] || "a conversation";
  const models = modelsOf(v);

  const head =
    `[Hand-over: you are taking over the Provenance conversation "${clip(title, 120)}"` +
    `${v.cwd ? ` in ${v.cwd}` : ""}, served until now by ${models.length ? models.join(", then ") : "other models"}. ` +
    "You haven't seen it; this is where it stands. The person doesn't see this hand-over: " +
    "answer as the next turn of the same conversation.]";

  // Always kept: the goal, where the work stands, the latest request.
  const goal = asks.length
    ? `The goal (the first request${asks.length === 1 ? ", verbatim" : ""}):\n${clip(asks[0], asks.length === 1 ? LATEST_CHARS : GOAL_CHARS)}`
    : "";
  const lastTurn = turns.at(-1);
  const lastText = [...turns].reverse().map(lastAgentText).find(Boolean) ?? "";
  const ending =
    lastTurn?.status === "interrupted"
      ? "\n(The last turn was stopped before it finished; what it was doing may be half done.)"
      : lastTurn?.status === "failed"
        ? `\n(The last turn failed${lastTurn.error?.message ? `: ${clip(lastTurn.error.message, 300)}` : ""}.)`
        : "";
  const state =
    lastText || ending
      ? `Where the agent left off:\n${clip(lastText, LAST_CHARS) || "(no reply yet)"}${ending}`
      : "";
  const latest =
    asks.length > 1 ? `The latest request, verbatim:\n${clip(asks.at(-1)!, LATEST_CHARS)}` : "";

  // Kept while they fit, most useful first.
  const optional: { at: number; text: string }[] = [];
  const files = new Map<string, string>();
  for (const i of items)
    if (i.type === "fileChange")
      for (const c of i.changes)
        files.set(
          c.path,
          c.kind.type === "add" ? "created" : c.kind.type === "delete" ? "deleted" : "edited",
        );
  if (files.size)
    optional.push({
      at: 3,
      text:
        "Files changed so far: " +
        [...files]
          .map(([p, k]) => `${p} (${k})`)
          .slice(0, 40)
          .join(", ") +
        (files.size > 40 ? `, and ${files.size - 40} more` : ""),
    });
  const plan = turns.findLast((t) => t.plan?.length)?.plan;
  if (plan)
    optional.push({
      at: 4,
      text:
        "The plan as it stood:\n" +
        plan.map((p) => `- [${p.status}] ${clip(p.step, 200)}`).join("\n"),
    });
  const commands = items
    .filter(
      (i): i is Extract<ThreadItem, { type: "commandExecution" }> => i.type === "commandExecution",
    )
    .slice(-8)
    .map(
      (c) =>
        `\`${clip(c.command.replace(/\s+/g, " "), 160)}\`${c.exitCode != null ? ` (exit ${c.exitCode})` : ""}`,
    );
  if (commands.length) optional.push({ at: 5, text: "Last commands run: " + commands.join(", ") });
  // What the agent reported at the end of earlier turns: its findings and decisions.
  const findings = turns
    .slice(0, -1)
    .map(lastAgentText)
    .filter(Boolean)
    .slice(-FINDINGS)
    .map((t) => `- ${clip(t.replace(/\s+/g, " "), FINDING_CHARS)}`);
  if (findings.length)
    optional.push({
      at: 2,
      text: "What the agent reported along the way:\n" + findings.join("\n"),
    });
  const middle = asks.slice(1, -1);
  if (middle.length) {
    const shown = middle.slice(-MIDDLE_ASKS);
    optional.push({
      at: 1,
      text:
        "Requests in between, in order:\n" +
        (middle.length > shown.length
          ? `(${middle.length - shown.length} earlier left out)\n`
          : "") +
        shown.map((a) => `- ${clip(a, ASK_CHARS)}`).join("\n"),
    });
  }

  const required = [head, goal, state, latest, BRIEF_END].filter(Boolean);
  let budget = TOTAL_CHARS - required.join("\n\n").length;
  const kept = new Set<number>();
  for (const o of [...optional].sort((a, b) => a.at - b.at))
    if (o.text.length + 2 <= budget) {
      kept.add(o.at);
      budget -= o.text.length + 2;
    }
  const pick = (at: number) => optional.find((o) => o.at === at && kept.has(at))?.text ?? "";
  // In reading order: the goal, what happened, where it stands, what is asked now.
  return [head, goal, pick(1), pick(2), pick(3), pick(5), pick(4), state, latest, BRIEF_END]
    .filter(Boolean)
    .join("\n\n");
}

/** What the model taking over is told when it should carry on without a new message. */
export const CARRY_ON =
  "The person moved this conversation to you without a new message: carry on with the work " +
  "that was in progress, from where it stands. Check the files' current state first.";

// Threads carried over before conversations stayed one (two threads, the brief as the new one's
// first message) start with this; splitBrief finds where it ends.
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

/**
 * Such a thread's title when it has no name of its own (its preview is the brief's start): what
 * naming it would have given it, "<the other's title> (continued)". Null for any other preview.
 */
export function carriedTitle(preview: string | null | undefined): string | null {
  const m = /^\[Continued from the Provenance thread "([^"\n]*)"/.exec(preview ?? "");
  return m ? `${m[1]} (continued)` : null;
}
