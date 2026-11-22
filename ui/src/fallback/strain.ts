// "This thread has outgrown the free models": signals, per finished turn, that a tier thread's
// history no longer fits what serves it, so the page can suggest moving it to Codex or Claude
// Code before the agent loops on a history it can't see whole.
//
// Per turn, from what is already on the page:
//   - provenance-core's context flags for the turn (/api/usage "context", context_signal.py):
//     over (no model takes the history at all) 3, trimmed (even compacted it didn't fit) 2,
//     restarted (a web chat was full) 2; compacted / summarised alone are normal and count 0
//   - the turn failed because the context window was exceeded: 3
//   - app-server compacted the thread's context itself: twice in the turn 2, once 1
//   - the agent repeated itself: the same command with the same result 3+ times in the turn 2
// The suggestion shows when the last three finished turns add up to 4 or more and the latest
// one counts at least 2, or when either of the last two counts 3 (one clear sign is enough).
// Dismissed, it stays away for that thread until the score is 4 higher than when dismissed.

import type { ThreadView, TurnUsage } from "../store/state";

export interface Strain {
  /** Sum over the last three finished turns. */
  score: number;
  suggest: boolean;
  /** For the tooltip and tests, in plain words. */
  reasons: string[];
}

export function turnStrain(
  turn: ThreadView["turns"][number],
  usage: TurnUsage | undefined,
): { points: number; reasons: string[] } {
  const reasons: string[] = [];
  let points = 0;
  const add = (p: number, why: string) => {
    points = Math.max(points, p);
    reasons.push(why);
  };
  const ctx = usage?.context ?? {};
  if (ctx.over) add(3, "no model could take the whole history");
  if (ctx.trimmed) add(2, "even compacted, the history had to be cut");
  if (ctx.restarted) add(2, "a chat filled up and had to start over");
  const err = turn.error;
  if (
    err &&
    (err.codexErrorInfo === "contextWindowExceeded" ||
      /context (window|length)|too (long|large) for the model/i.test(err.message))
  )
    add(3, "the context window was exceeded");
  const compactions = turn.items.filter((i) => i.type === "contextCompaction").length;
  if (compactions >= 2) add(2, "the context was compacted repeatedly");
  else if (compactions === 1) add(1, "the context was compacted");
  const seen = new Map<string, number>();
  for (const i of turn.items) {
    if (i.type !== "commandExecution") continue;
    const k = `${i.command}\u0000${i.exitCode}\u0000${(i.aggregatedOutput ?? "").slice(0, 2000)}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  if ([...seen.values()].some((n) => n >= 3)) add(2, "the agent repeated the same command");
  return { points, reasons };
}

export function threadStrain(v: ThreadView, usage: Record<string, TurnUsage>): Strain {
  const done = v.turns.filter((t) => t.status !== "inProgress").slice(-3);
  const per = done.map((t) => turnStrain(t, usage[t.id]));
  const score = per.reduce((n, p) => n + p.points, 0);
  const latest = per.at(-1)?.points ?? 0;
  const clear = per.slice(-2).some((p) => p.points >= 3);
  return {
    score,
    suggest: clear || (score >= 4 && latest >= 2),
    reasons: [...new Set(per.flatMap((p) => p.reasons))],
  };
}

const DISMISSED_KEY = "provenance-ui.strain-dismissed";

function dismissedMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

/** Dismissed at this score (null: never). */
export function dismissedAt(threadId: string): number | null {
  const v = dismissedMap()[threadId];
  return typeof v === "number" ? v : null;
}

export function dismissStrain(threadId: string, score: number): void {
  try {
    const m = dismissedMap();
    m[threadId] = score;
    // Keep the map small: the newest 200 threads.
    const keys = Object.keys(m);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete m[k];
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(m));
  } catch {
    // private mode: it may come back, which is fine
  }
}

/** Shown: suggested, and not dismissed unless it got clearly worse since. */
export function shouldShow(threadId: string, s: Strain): boolean {
  if (!s.suggest) return false;
  const at = dismissedAt(threadId);
  return at === null || s.score >= at + 4;
}
