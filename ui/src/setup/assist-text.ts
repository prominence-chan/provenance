// The token pool's assisted setup, as text: the brief that starts the assistant's thread, the
// marker the assistant ends a message with to ask for a key card, the one-line outcomes the app
// sends back, and the check that keeps a pasted key out of the chat. Pure functions, no I/O.
//
// The assistant (Claude Code or Codex, as a fallback thread) never sees a key: it asks for one
// with a line `[[provenance:pool-key <id>]]`; the page draws that line as a key card (the
// provider's steps, its keys page, the key field); the person pastes the key into the card; the
// app saves it through /pool/keys and sends the assistant only the outcome.

import type { ThreadView } from "../store/state";
import type { PoolHelp, PoolHelpData, PoolProvider, RemovedProvider } from "./web";

export const BRIEF_START = "[Provenance token pool setup]";
export const BRIEF_END = "[End of the setup brief]";
/** Every message the app writes into the thread on the person's behalf starts with this. */
export const NOTE_PREFIX = "[Provenance app] ";
export const ASSIST_NAME = "Set up the token pool";

/**
 * `[[provenance:pool-key <id>]]` (a key card; ` add`: one more key beside the saved ones) and
 * `[[provenance:pool-steps <id> {json}]]` (how that provider's steps went: read by the app, not
 * shown), each alone on its line.
 */
const MARKER =
  /^[ \t]*\[\[provenance:pool-(key|steps) ([A-Za-z0-9_.-]+)(?:[ \t]+(.*?))?\]\][ \t]*$/gm;
const MARKER_HEADS = ["[[provenance:pool-key ", "[[provenance:pool-steps "];
/** Any of the markers: worth reading the message for. */
export const HAS_MARKER = "[[provenance:pool-";

/** A marker still streaming in at the end of a message: hidden until it is whole. */
function dropPartial(text: string): string {
  const nl = text.lastIndexOf("\n");
  const line = text.slice(nl + 1).trim();
  if (!line.startsWith("[")) return text;
  const partial = MARKER_HEADS.some(
    (h) => h.startsWith(line) || (line.startsWith(h) && !line.endsWith("]]")),
  );
  return partial ? text.slice(0, nl + 1) : text;
}

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "card"; id: string; add: boolean }
  | { kind: "steps"; id: string; raw: string };

/** An assistant message as text, key cards and steps lines, in order. */
export function splitMarkers(text: string, streaming = false): MessagePart[] {
  const src = streaming ? dropPartial(text) : text;
  const out: MessagePart[] = [];
  let last = 0;
  for (const m of src.matchAll(MARKER)) {
    const before = src.slice(last, m.index).trim();
    if (before) out.push({ kind: "text", text: before });
    if (m[1] === "key") out.push({ kind: "card", id: m[2], add: m[3]?.trim() === "add" });
    else out.push({ kind: "steps", id: m[2], raw: m[3] ?? "" });
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
  | { kind: "working"; nth?: number }
  /** by: the provider refused it (the router's check), or the router can't use it yet. */
  | { kind: "rejected"; reason: string; by?: "provider" | "router"; nth?: number }
  | { kind: "not_saved"; reason: string }
  | { kind: "skipped" };

/** "Groq key", or "Groq key 2" for a further one. */
const keyWord = (name: string, nth?: number) => `${name} key${nth && nth > 1 ? ` ${nth}` : ""}`;

/** The line the assistant gets: never the key, only what happened (the provider's own check). */
export function outcomeNote(name: string, o: KeyOutcome): string {
  switch (o.kind) {
    case "working":
      return `${NOTE_PREFIX}${keyWord(name, o.nth)}: saved and working.`;
    case "rejected":
      return o.by === "router"
        ? `${NOTE_PREFIX}${keyWord(name, o.nth)}: saved, but it can't be used yet: ${o.reason}`
        : `${NOTE_PREFIX}${keyWord(name, o.nth)}: saved, but ${name} rejected it: ${o.reason}`;
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

/** The reason in a note read back: "401 Invalid API Key" of "… rejected it 401 Invalid API Key". */
export function noteReason(text: string): string | null {
  return text.match(/(?:rejected it|can't be used yet|not saved):? (.*)$/)?.[1] ?? null;
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

// ---- what a setup came to, for the router's guide (POST /pool/help/{id}/outcome) ------------

const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g;
const URLS = /\bhttps?:\/\/\S+/gi;
/** A run of letters and digits, mixed, long enough to be a key, a token or an account id. */
const TOKENISH = /[A-Za-z0-9_\-+/=.]{16,}/g;
const DIGITS = /\d[\d\s().-]{5,}\d/g;

/**
 * A line safe to send: no key (the providers' patterns, the known prefixes, anything long and
 * key-like), no e-mail address, no link, no long number (a phone, an account), one line, capped.
 */
export function scrub(text: string, help: PoolHelp[] = [], max = 120): string {
  let out = String(text).replace(/[\u0000-\u001f\u007f]+/g, " ");
  for (const h of help) {
    const re = searchPattern(h.key_pattern);
    if (re) out = out.replace(new RegExp(re.source, "g"), " ");
  }
  out = out
    .replace(new RegExp(KNOWN.source, "g"), " ")
    .replace(EMAIL, " ")
    .replace(URLS, " ")
    .replace(TOKENISH, (t) => (/[0-9]/.test(t) || t.length >= 24 ? " " : t))
    .replace(DIGITS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

export interface StepReport {
  step_notes: { step: number; ok: boolean; note?: string }[];
  labels_seen: string[];
}

/**
 * The assistant's `[[provenance:pool-steps <id> {"ok":[1,2],"differs":{"3":"…"}}]]`, as step
 * notes: whole step numbers only, each note scrubbed and capped; null when it doesn't parse.
 */
export function stepReport(raw: string, help: PoolHelp[] = []): StepReport | null {
  let v: unknown;
  try {
    v = JSON.parse(raw.trim() || "{}");
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as { ok?: unknown; differs?: unknown };
  const stepOf = (x: unknown) => {
    const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= 50 ? n : null;
  };
  const notes = new Map<number, { step: number; ok: boolean; note?: string }>();
  for (const x of Array.isArray(o.ok) ? o.ok.slice(0, 50) : []) {
    const n = stepOf(x);
    if (n) notes.set(n, { step: n, ok: true });
  }
  const labels: string[] = [];
  if (o.differs && typeof o.differs === "object" && !Array.isArray(o.differs))
    for (const [k, x] of Object.entries(o.differs as Record<string, unknown>).slice(0, 20)) {
      const n = stepOf(k);
      const note = typeof x === "string" ? scrub(x, help) : "";
      if (!n) continue;
      notes.set(n, note ? { step: n, ok: false, note } : { step: n, ok: false });
      // The control's name as the page has it: what's in quotes or bold, else the note itself.
      const named = note.match(/["“'*]{1,2}([^"”'*]{1,60})["”'*]{1,2}/)?.[1] ?? note;
      const label = scrub(
        named.replace(/^(?:the )?(?:button|link|tab|menu) is now called /i, ""),
        help,
        60,
      );
      if (label && !labels.includes(label)) labels.push(label);
    }
  const step_notes = [...notes.values()].sort((a, b) => a.step - b.step);
  return step_notes.length || labels.length
    ? { step_notes, labels_seen: labels.slice(0, 12) }
    : null;
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
export function poolBrief(
  help: PoolHelpData,
  pool: PoolProvider[],
  assistant: string,
  removedKeys: RemovedProvider[] = [],
): string {
  const removed = [...help.removed];
  for (const r of removedKeys) if (!removed.some((x) => x.id === r.id)) removed.push(r);
  const gone = new Set(removed.map((r) => r.id));
  const all = guided(help.providers, pool).filter((h) => !gone.has(h.id));
  const list = all.filter((h) => h.recommended);
  const todo = list.filter((h) => !poolSetUp(pool.find((p) => p.id === h.id)));
  const notWorth = all.filter((h) => !h.recommended && !poolSetUp(pool.find((p) => p.id === h.id)));
  const doneHelp = all.filter((h) => poolSetUp(pool.find((p) => p.id === h.id)));
  const keyCount = (id: string) => pool.find((p) => p.id === id)?.keys?.length ?? 0;
  const done = doneHelp.map((h) => {
    const n = keyCount(h.id);
    return `${h.name} (card id: ${h.id}${n ? `; ${n} key${n === 1 ? "" : "s"}` : ""})`;
  });
  // A router that keeps several keys per provider says so with a `keys` list.
  const multi = pool.some((p) => p.keys !== null);
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
    `- The app then sends you one line starting "${NOTE_PREFIX.trim()}": "<Provider> key: saved and working", "<Provider> key: saved, but <Provider> rejected it: <what the provider answered>" (the app tried the key with the provider itself), "not saved: <reason>" or "skipped by the person". You never see the key. After a rejection, help them fix it (a key copied with a space or cut short, a step missed) and show the card again; after "skipped", move on.`,
    ...(multi
      ? [
          "- A provider can hold several keys, one per account the person has: each account's limits add up, and a paid key usually has higher limits (Provenance uses all of them). Offer another key only when the person says they have another account. For it, end your message with this line instead, which shows a card that adds a key beside the saved ones rather than replacing them:",
          "  [[provenance:pool-key <id> add]]",
          "  Before they use a second account, pass on that provider's note on more than one key (below), once, in your own words. Where its terms don't allow a second account for more free usage, say so plainly: another key is for a separate paid account of theirs.",
        ]
      : []),
    "- When you are done with a provider (its key saved, skipped, or the person gives up), put this line alone in your next message, before any card line (which stays last). The app reads it to improve these steps for the next person and doesn't show it:",
    '  [[provenance:pool-steps <id> {"ok":[1,2,4],"differs":{"3":"button is now called Create key"}}]]',
    '  "ok": the step numbers below that went as written; "differs": each step whose page looked different, and what its control is called there. Only step numbers and the site\'s control names: never a key, an e-mail address, a name or anything else about the person.',
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
  const doneMulti = multi
    ? doneHelp.flatMap((h) => {
        const line = multipleLine(
          h,
          pool.find((p) => p.id === h.id),
        );
        return line ? [`- ${h.name} (card id: ${h.id}): ${line}`] : [];
      })
    : [];
  if (doneMulti.length)
    extra.push(
      "",
      "Set up already, if the person has another account (offer only when they say so):",
      ...doneMulti,
    );
  if (removed.length)
    extra.push(
      "",
      `No longer in the pool (don't offer them): ${removed.map((r) => `${r.name}${r.reason ? ` (${r.reason})` : ""}`).join(", ")}.`,
    );
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
      multi,
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

/** What the provider's terms say about a second account's key, for the brief. */
function multipleLine(h: PoolHelp, p: PoolProvider | undefined): string | null {
  const m = p?.multiple_keys ?? h.multiple_keys;
  if (!m) return null;
  const note = m.note ? `: ${m.note}` : "";
  if (m.allowed === "yes") return `more than one key is fine${note}`;
  if (m.allowed === "check_terms")
    return `more than one key: the person should check its terms first${note}`;
  return `its terms don't allow a second account for more free usage; another key only from a separate paid account of theirs${note}`;
}

/** "Available until 28 Dec 2026 (2026-12-28)". */
function untilLine(iso: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  const day = d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Available only until ${day}, then it leaves the pool: mention it once, when you get to it.`;
}

function providerBlock(h: PoolHelp, n: number, p: PoolProvider | undefined, multi = false): string {
  const lines = [`${n}. ${h.name} (card id: ${h.id})`];
  const until = p?.until ?? h.until;
  if (until) lines.push(`   ${untilLine(until)}`);
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
  const ml = multi ? multipleLine(h, p) : null;
  if (ml) lines.push(`   Several keys: ${ml}`);
  const x = h.experience;
  if (x?.tries) lines.push(`   Earlier setups: ${x.worked} of ${x.tries} got a working key.`);
  for (const t of x?.common_trouble ?? [])
    lines.push(`   People often get stuck${t.step ? ` at step ${t.step}` : ""}: ${t.note}`);
  return lines.join("\n");
}
