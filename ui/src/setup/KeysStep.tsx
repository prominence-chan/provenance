// The token pool's API keys (Models & accounts → Token pool): which providers have a key, and
// for each, how to get one (the router's /pool/help: steps, its keys page, what to watch out
// for) beside the field to add it; and a way to have Claude Code or Codex walk you through it
// (PoolAssist.tsx). Keys go to the router (PUT /pool/keys/{provider}), which keeps them in
// its own home, readable by this user only; they never come back to the page.

import { useState } from "react";
import type { KeyOutcome } from "./assist-text";
import { FreeBadge, KeyForm, KeyGuide } from "./KeyGuide";
import { Status } from "./parts";
import { AssistNote, GeminiKeyPrompt } from "./PoolAssist";
import type { PoolHelp, PoolHelpData, PoolProvider, WebAccounts } from "./web";

/** What a person knows these providers as (the router knows them by catalog id). */
const NAMES: Record<string, string> = {
  google: "Google AI Studio",
  groq: "Groq",
  cerebras: "Cerebras",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  nvidia: "NVIDIA",
  cloudflare: "Cloudflare Workers AI",
  kilo: "Kilo",
  ovh: "OVHcloud",
  zai: "Z.ai",
  sambanova: "SambaNova",
  cohere: "Cohere",
  inception: "Inception",
};

/** "Groq" for "Groq (GroqCloud)": the name in a sentence or on a button. */
export const shortName = (name: string): string => name.replace(/\s*\([^)]*\)$/, "") || name;

export const providerName = (id: string): string =>
  NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

export function KeysStep({
  pool,
  help,
  accounts,
  focus,
  onChanged,
  onFallbacks,
}: {
  pool: PoolProvider[];
  /** How to get each key, in the order to do them; null from a router without /pool/help. */
  help: PoolHelpData | null;
  /** The web accounts (a signed-in Gemini account points at Google's free key). */
  accounts: WebAccounts | null;
  /** Open this provider first (the Gemini prompt in the welcome). */
  focus?: string | null;
  onChanged: () => void;
  /** The assistant needs a fallback first: go to the Fallbacks page. */
  onFallbacks: () => void;
}) {
  // With the router's help: its recommended order, then any provider it doesn't explain, then
  // the ones not worth setting up for free (folded, with why). Without it: providers that work
  // first, then the ones a key would add; each group in catalog order.
  const list = help?.providers ?? [];
  const order = list.map((h) => h.id);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const sorted = help
    ? [...pool].sort((a, b) => rank(a.id) - rank(b.id))
    : [...pool].sort((a, b) => Number(b.usable) - Number(a.usable));
  const notWorth = sorted.filter((p) => helpOf(help, p.id)?.recommended === false);
  const main = sorted.filter((p) => !notWorth.includes(p));
  // One provider open at a time: at first the next one to set up, in the recommended order.
  const [editing, setEditing] = useState<string | null>(() =>
    focus && pool.some((p) => p.id === focus)
      ? focus
      : help
        ? (main.find((p) => !p.usable && p.vars.length && helpOf(help, p.id))?.id ?? null)
        : null,
  );
  const [showNotWorth, setShowNotWorth] = useState(
    () => !!editing && notWorth.some((p) => p.id === editing),
  );
  const working = pool.filter((p) => p.usable).length;
  const row = (p: PoolProvider) => (
    <KeyRow
      key={p.id}
      p={p}
      help={helpOf(help, p.id)}
      open={editing === p.id}
      onOpen={() => setEditing(editing === p.id ? null : p.id)}
      onDone={(o) => {
        if (o === "removed" || o.kind === "working") setEditing(null);
        onChanged();
      }}
    />
  );
  return (
    <div className="setup-step">
      <div className="setup-site-head">
        <div>
          <h3>Token pool</h3>
          <span className="meta">
            {working ? `${working} of ${pool.length} providers working` : "No provider working yet"}
          </span>
        </div>
      </div>
      <p className="setup-lead setup-keys-lead">
        Free API tiers, pooled by tier. Each provider needs a free key from its own site; the router
        keeps it on this Mac, readable by you only.
      </p>
      <GeminiKeyPrompt
        accounts={accounts}
        pool={pool}
        help={help}
        onGet={() => {
          setEditing("google");
          requestAnimationFrame(() =>
            document
              .querySelector('.setup-keys li[data-pool="google"]')
              ?.scrollIntoView({ block: "start", behavior: "smooth" }),
          );
        }}
      />
      {help && <AssistNote help={help} pool={pool} onFallbacks={onFallbacks} />}
      <ul className="setup-accounts setup-keys">{main.map(row)}</ul>
      {notWorth.length > 0 && (
        <>
          <button
            className="setup-add key-notworth-toggle"
            aria-expanded={showNotWorth}
            onClick={() => setShowNotWorth((v) => !v)}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
              style={{ transform: showNotWorth ? "rotate(90deg)" : undefined }}
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
            Not worth setting up for free ({notWorth.length})
          </button>
          {showNotWorth && (
            <ul className="setup-accounts setup-keys key-notworth">{notWorth.map(row)}</ul>
          )}
        </>
      )}
    </div>
  );
}

const helpOf = (help: PoolHelpData | null, id: string): PoolHelp | undefined =>
  help?.providers.find((h) => h.id === id);

function KeyRow({
  p,
  help,
  open,
  onOpen,
  onDone,
}: {
  p: PoolProvider;
  help: PoolHelp | undefined;
  open: boolean;
  onOpen: () => void;
  onDone: (o: KeyOutcome | "removed") => void;
}) {
  const fromApp = p.vars.some((v) => v.from === "app");
  const fromEnv = p.vars.some((v) => v.from === "env");
  const missing = p.vars.filter((v) => !v.set);
  const fullName = help?.name ?? providerName(p.id);
  const name = shortName(fullName);
  let cls = "dot-off";
  let text = "Needs a key";
  if (p.usable && p.anonymous && !p.vars.some((v) => v.set)) {
    cls = "dot-ok";
    text = "Works without a key";
  } else if (p.usable) {
    cls = "dot-ok";
    text = fromEnv && !fromApp ? "Key from the router's setup" : "Key set";
  } else if (p.vars.some((v) => v.set)) {
    cls = "dot-warn";
    text = `Needs ${missing.map((v) => v.name).join(", ")}`;
  }

  return (
    <li data-pool={p.id} data-open={open || undefined}>
      <div className="setup-account">
        <div className="setup-account-text">
          <span className="setup-account-name">
            {fullName}
            <FreeBadge help={help} />
          </span>
          <span className="setup-account-status">
            <Status cls={cls} text={text} />
            <span className="meta key-row-meta">
              {help?.recommended === false && help.why_not
                ? help.why_not
                : !p.usable && help?.time_minutes
                  ? `about ${help.time_minutes}\u00a0min`
                  : `${p.models} model${p.models === 1 ? "" : "s"}${p.tiers.length ? ` · ${p.tiers.join(", ")}` : ""}`}
            </span>
          </span>
        </div>
        {p.vars.length > 0 && (
          <span className="setup-account-actions">
            <button className="btn" onClick={onOpen} aria-expanded={open}>
              {open ? (help ? "Hide" : "Cancel") : p.vars.some((v) => v.set) ? "Change" : "Add key"}
            </button>
          </span>
        )}
      </div>
      {open &&
        (help ? (
          <KeyGuide pool={p} help={help} name={name} onDone={onDone} />
        ) : (
          <KeyForm pool={p} name={name} autoFocus onDone={onDone} />
        ))}
    </li>
  );
}
