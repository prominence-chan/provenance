// The token pool's assisted setup, as text: the brief that starts the assistant's thread, the
// marker the assistant ends a message with to ask for a key card, the one-line outcomes the app
// sends back, and the check that keeps a pasted key out of the chat. Pure functions, no I/O.
//
// The assistant (Claude Code or Codex, as a fallback thread) never sees a key: it asks for one
// with a line `[[provenance:pool-key <id>]]`; the page draws that line as a key card (the
// provider's steps, its keys page, the key field); the person pastes the key into the card; the
// app saves it through /pool/keys and sends the assistant only the outcome.

import type { ThreadView } from "../store/state";
import type { PoolHelp, PoolHelpData, PoolProvider } from "./web";

export const BRIEF_START = "[Provenance token pool setup]";
export const BRIEF_END = "[End of the setup brief]";
/** Every message the app writes into the thread on the person's behalf starts with this. */
export const NOTE_PREFIX = "[Provenance app] ";
export const ASSIST_NAME = "Set up the token pool";

const MARKER = /^[ \t]*\[\[provenance:pool-key ([A-Za-z0-9_.-]+)\]\][ \t]*$/gm;
const MARKER_HEAD = "[[provenance:pool-key ";

/** A marker still streaming in at the end of a message: hidden until it is whole. */
function dropPartial(text: string): string {
  const nl = text.lastIndexOf("\n");
  const line = text.slice(nl + 1).trim();
  if (!line.startsWith("[")) return text;
  const partial =
    MARKER_HEAD.startsWith(line) || (line.startsWith(MARKER_HEAD) && !line.endsWith("]]"));
  return partial ? text.slice(0, nl + 1) : text;
}

export type MessagePart = { kind: "text"; text: string } | { kind: "card"; id: string };

/** An assistant message as text and key cards, in order. */
export function splitMarkers(text: string, streaming = false): MessagePart[] {
  const src = streaming ? dropPartial(text) : text;
  const out: MessagePart[] = [];
  let last = 0;
  for (const m of src.matchAll(MARKER)) {
    const before = src.slice(last, m.index).trim();
    if (before) out.push({ kind: "text", text: before });
    out.push({ kind: "card", id: m[1] });
    last = (m.index ?? 0) + m[0].length;
  }
  const rest = src.slice(last).trim();
  if (rest) out.push({ kind: "text", text: rest });
  return out;
}

export function isBrief(text: string): boolean {
  return text.startsWith(BRIEF_START);
}

/** The setup assistant's thread: its first message is the brief. */
export function isAssistView(v: ThreadView | undefined): boolean {
  const first = v?.turns[0]?.items.find((i) => i.type === "userMessage");
  if (!first || first.type !== "userMessage") return false;
  const c = first.content[0];
  return c?.type === "text" && isBrief(c.text);
}

/** The brief and anything after it (nothing, as the app sends it). */
export function splitAssistBrief(text: string): { brief: string; rest: string } | null {
  if (!isBrief(text)) return null;
  const end = text.indexOf(BRIEF_END);
  const cut = end < 0 ? text.length : end + BRIEF_END.length;
  return { brief: text.slice(0, cut), rest: text.slice(cut).trim() };
}

// ---- outcomes ------------------------------------------------------------------------------

export type KeyOutcome =
  | { kind: "working" }
  | { kind: "rejected"; reason: string }
  | { kind: "not_saved"; reason: string }
  | { kind: "skipped" };

/** The line the assistant gets: never the key, only what happened. */
export function outcomeNote(name: string, o: KeyOutcome): string {
  switch (o.kind) {
    case "working":
      return `${NOTE_PREFIX}${name} key: saved and working.`;
    case "rejected":
      return `${NOTE_PREFIX}${name} key: saved but rejected: ${o.reason}`;
    case "not_saved":
      return `${NOTE_PREFIX}${name} key: not saved: ${o.reason}`;
    case "skipped":
      return `${NOTE_PREFIX}${name}: skipped by the person.`;
  }
}

/** A note the app sent, read back for display ("Groq key saved and working"). */
export function parseNote(text: string): { text: string; tone: "ok" | "warn" | "off" } | null {
  if (!text.startsWith(NOTE_PREFIX)) return null;
  const body = text.slice(NOTE_PREFIX.length).trim();
  const tone = /saved and working/.test(body) ? "ok" : /skipped/.test(body) ? "off" : "warn";
  return { text: body.replace(/:\s*/, " ").replace(/\.$/, ""), tone };
}

// ---- keys pasted where they don't belong ---------------------------------------------------

/** Prefixes free API keys commonly start with; a pattern from /pool/help is checked first. */
const KNOWN = /(?:gsk_|sk-or-|sk-|csk-|nvapi-|AIza|xai-|hf_|sk_)[A-Za-z0-9_-]{16,}/;
/** Whose key a well-known prefix is, where /pool/help gives no pattern. */
const PREFIX_OF: Record<string, string> = {
  "gsk_": "groq",
  "AIza": "google",
  "sk-or-": "openrouter",
  "csk-": "cerebras",
  "nvapi-": "nvidia",
};
/** A long run of letters and digits, mixed, as most API keys are. */
const GENERIC = /[A-Za-z0-9_-]{32,}/g;

/** A provider's pattern, unanchored, to find a key inside a sentence; null when unusable. */
export function searchPattern(pattern: string | null | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern.replace(/^\^/, "").replace(/\$$/, ""));
  } catch {
    return null;
  }
}

/** Does this value look like the provider's key? null: no pattern to say. */
export function keyFits(help: PoolHelp | undefined, value: string): boolean | null {
  if (!help?.key_pattern) return null;
  try {
    return new RegExp(help.key_pattern).test(value.trim());
  } catch {
    return null;
  }
}

/** Something in a chat message that looks like an API key, and whose it seems to be. */
export function findKey(
  text: string,
  help: PoolHelp[],
): { key: string; provider: string | null } | null {
  for (const h of help) {
    const re = searchPattern(h.key_pattern);
    const m = re?.exec(text);
    if (m && m[0].length >= 12) return { key: m[0], provider: h.id };
  }
  const k = KNOWN.exec(text);
  if (k) {
    const id = Object.entries(PREFIX_OF).find(([pre]) => k[0].startsWith(pre))?.[1] ?? null;
    return { key: k[0], provider: id && help.some((h) => h.id === id) ? id : null };
  }
  for (const m of text.matchAll(GENERIC)) {
    const s = m[0];
    if (/[0-9]/.test(s) && /[A-Za-z]/.test(s) && !/^[0-9a-f]{40}$/.test(s))
      return { key: s, provider: null };
  }
  return null;
}

/** The text with every given secret taken out. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[key removed by the app]");
  return out;
}

// ---- the brief -------------------------------------------------------------------------------

/** Usable with a key of its own (or working without one): nothing to set up. */
export function poolSetUp(p: PoolProvider | undefined): boolean {
  return !!p && p.usable;
}

/** The providers /pool/help explains that the router can take a key for, in its order. */
export function guided(help: PoolHelp[], pool: PoolProvider[]): PoolHelp[] {
  return help.filter((h) => pool.some((p) => p.id === h.id && p.vars.length > 0));
}

const BRIEF_MAX = 40_000;

/**
 * The first message of the assistant's thread: how this works, the rules, what is set up, and
 * each provider still to do with its steps. Built from /pool/help and /pool/keys' state, which
 * carry no secrets (/pool/keys never sends a value back).
 */
export function poolBrief(help: PoolHelpData, pool: PoolProvider[], assistant: string): string {
  const all = guided(help.providers, pool);
  const list = all.filter((h) => h.recommended);
  const todo = list.filter((h) => !poolSetUp(pool.find((p) => p.id === h.id)));
  const notWorth = all.filter((h) => !h.recommended && !poolSetUp(pool.find((p) => p.id === h.id)));
  const done = list.filter((h) => poolSetUp(pool.find((p) => p.id === h.id))).map((h) => h.name);
  const minutes = todo.reduce((n, h) => n + (h.time_minutes || 0), 0);
  const head = [
    BRIEF_START,
    `You are ${assistant}, inside Provenance (a desktop coding app), helping the person get free API keys for its token pool: free API tiers Provenance pools for its models. The person sees this conversation and types to you here. You guide; the app saves the keys.`,
    "",
    "How it works",
    "- One provider at a time, in the order below. Tell the person exactly what to open and click, in short numbered steps that use the site's own button names.",
    "- When they are ready to paste a key, end your message with this line, alone on the last line:",
    "  [[provenance:pool-key <id>]]",
    "  The app shows that line as a card with the provider's steps, a button that opens its keys page, and the key field. The person pastes the key into the card, not into this chat.",
    `- The app then sends you one line starting "${NOTE_PREFIX.trim()}": "<Provider> key: saved and working", "saved but rejected: <reason>", "not saved: <reason>" or "skipped by the person". You never see the key. After a rejection, help them fix it (a key copied with a space or cut short, a step missed) and show the card again; after "skipped", move on.`,
    "",
    "Rules",
    "- Never ask for, accept, repeat or keep a key, token or password in this chat. If the person pastes one here, the app takes it out before it reaches you; remind them the card is the place.",
    "- Don't create accounts, accept terms, or sign in on the person's behalf. They make every click and every choice; you say which.",
    "- Don't run commands, read files or use tools: none are needed. In particular nothing that could read keys or secrets (environment variables, shell profiles, .env files, keychains, config folders). Your working folder is an empty scratch folder.",
    "- Don't invent steps. If a site looks different from the steps below, ask the person what they see.",
    "- Skip the providers listed as not worth it at the end, unless the person asks for one.",
    "- Before each provider, tell the person what it does with their prompts if its notes say (some free tiers train on them or let people read them), so they decide before signing up.",
    "- Stop as soon as the person says so.",
    "- When all are done or the person stops, sum up: which providers are set up now, which were skipped, and what is left.",
    "",
    `Already set up: ${done.length ? done.join(", ") : "none"}.`,
    "",
    todo.length
      ? `Not set up yet, in this order (${todo.length}${minutes ? `, about ${minutes} minutes in all` : ""}):`
      : "Every provider here is set up already: say so, and offer to check nothing else is needed.",
  ].join("\n");
  const extra: string[] = [];
  if (notWorth.length)
    extra.push(
      "",
      "Not worth setting up for the free pool (skip unless the person asks; their cards still work):",
      ...notWorth.map((h) => `- ${h.name} (card id: ${h.id}): ${h.why_not ?? "not recommended"}`),
    );
  if (help.notes.length)
    extra.push(
      "",
      "The router's general notes on these providers (where they differ from the rules above, the rules win: in this app the card checks and saves each key, never you):",
      ...help.notes.map((n) => `- ${n}`),
    );
  const tail = [
    ...extra,
    "",
    todo.length
      ? "Begin: greet the person in one line, say how many providers are left and roughly how long it takes, and start with the first one."
      : "",
    BRIEF_END,
  ].join("\n");
  const blocks = todo.map((h, i) =>
    providerBlock(
      h,
      i + 1,
      pool.find((p) => p.id === h.id),
    ),
  );
  let body = "";
  for (const b of blocks) {
    if (head.length + body.length + b.length + tail.length > BRIEF_MAX) {
      body += "\n(More providers follow; ask the app's card for their steps.)";
      break;
    }
    body += `\n\n${b}`;
  }
  return `${head}${body}\n${tail}`;
}

function providerBlock(h: PoolHelp, n: number, p: PoolProvider | undefined): string {
  const lines = [`${n}. ${h.name} (card id: ${h.id})`];
  if (h.what_you_get) lines.push(`   What you get: ${h.what_you_get}`);
  if (h.needs.length) lines.push(`   Needs: ${h.needs.join(" ")}`);
  if (h.free_tier) lines.push(`   Free tier: ${h.free_tier}`);
  if (h.confidence && h.confidence !== "seen")
    lines.push(
      `   Steps confidence: ${h.confidence} (the page's labels may differ; trust the page)`,
    );
  if (h.open_with?.length)
    lines.push(
      "   The card can also open the keys page in the person's own signed-in window for " +
        h.open_with.map((o) => `${o.provider} (${o.account})`).join(", ") +
        ", already signed in to the same account: no second sign-in.",
    );
  if (h.time_minutes) lines.push(`   Takes about ${h.time_minutes} min`);
  if (h.signup_url) lines.push(`   Sign up: ${h.signup_url}`);
  if (h.keys_url) lines.push(`   Keys page: ${h.keys_url}`);
  if (h.steps.length) {
    lines.push("   Steps:");
    h.steps.forEach((s, i) => lines.push(`     ${i + 1}. ${s}`));
  }
  if (h.key_format) lines.push(`   The key looks like: ${h.key_format}`);
  for (const f of h.extra_fields ?? [])
    lines.push(`   The card also asks for ${f.label}${f.where ? ` (${f.where})` : ""}`);
  if (p && p.vars.some((v) => v.set) && !p.usable)
    lines.push(
      `   Partly set up: still needs ${p.vars
        .filter((v) => !v.set)
        .map((v) => v.name)
        .join(", ")}`,
    );
  for (const g of h.gotchas) lines.push(`   Watch out: ${g}`);
  if (h.terms_note) lines.push(`   Terms: ${h.terms_note}`);
  return lines.join("\n");
}
