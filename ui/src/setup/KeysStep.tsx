// The token pool's API keys (Models & accounts → Token pool): which providers have a key, and
// for each, how to get one (the router's /pool/help: steps, its keys page, what to watch out
// for) beside the field to add it; and a way to have Claude Code or Codex walk you through it
// (PoolAssist.tsx). Keys go to the router (PUT /pool/keys/{provider}, POST for one more), which
// keeps them in its own home, readable by this user only; they never come back to the page.
//
// A provider can hold several keys, one per account (their limits add up; a paid one's are
// usually higher): the open provider lists them (name, plan, last four, working or why not) with
// Add another key. A router from before that (no `keys` list) gets the one-key page as it was.

import { useEffect, useRef, useState } from "react";
import type { KeyOutcome } from "./assist-text";
import {
  FreeBadge,
  GoodToKnow,
  GuideSteps,
  KeyForm,
  KeyGuide,
  OpenButtons,
  PersonBadge,
  rejectedText,
  TermsNote,
} from "./KeyGuide";
import { IconPlusSmall, IconTrash, Status } from "./parts";
import { AssistNote, GeminiKeyPrompt } from "./PoolAssist";
import { manualResult } from "./pool-outcome";
import type { KeyPatch } from "../../shared/router-api";
import {
  clearPoolKeys,
  dayText,
  isAnon,
  keyName,
  ownKeys,
  removePoolKey,
  shortReason,
  untilText,
  updatePoolKey,
  type PoolHelp,
  type PoolHelpData,
  type PoolKey,
  type PoolProvider,
  type RemovedProvider,
  type WebAccounts,
} from "./web";

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

/** The providers taken out of the pool, from /pool/keys and /pool/help, once each. */
export function removedOf(
  fromKeys: RemovedProvider[] | undefined,
  help: PoolHelpData | null,
): RemovedProvider[] {
  const out = [...(fromKeys ?? [])];
  for (const r of help?.removed ?? []) if (!out.some((x) => x.id === r.id)) out.push(r);
  return out;
}

export function KeysStep({
  pool: allPool,
  removed: removedKeys,
  help,
  accounts,
  focus,
  onChanged,
  onFallbacks,
}: {
  pool: PoolProvider[];
  /** Providers taken out of the pool (GET /pool/keys `removed`). */
  removed?: RemovedProvider[];
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
  const removed = removedOf(removedKeys, help);
  const gone = new Set(removed.map((r) => r.id));
  const pool = allPool.filter((p) => !gone.has(p.id));
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
      onReload={onChanged}
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
      {removed.length > 0 && <RemovedLine removed={removed} onChanged={onChanged} />}
    </div>
  );
}

/**
 * "No longer in the pool: Mistral AI (No free API tier any more), …": one folded line at the
 * bottom; open, each with why and since when, and a key still saved for one of them
 * (`leftover_key`) with Remove (DELETE /pool/keys/{id} forgets it).
 */
function RemovedLine({
  removed,
  onChanged,
}: {
  removed: RemovedProvider[];
  onChanged: () => void;
}) {
  // Unfolded when a key is left for one of them; it stays as it is while the person acts.
  const [unfolded] = useState(() => removed.some((r) => r.leftover));
  const [isOpen, setIsOpen] = useState(unfolded);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <details
      className="key-removed"
      open={unfolded || undefined}
      onToggle={(e) => setIsOpen(e.currentTarget.open)}
    >
      <summary>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        {/* Open, each one's reason is in the list below: said once. */}
        <span className="key-removed-line">
          No longer in the pool
          {isOpen
            ? ` (${removed.length})`
            : `: ${removed.map((r) => `${r.name}${r.reason ? ` (${shortReason(r.reason)})` : ""}`).join(", ")}`}
        </span>
      </summary>
      <ul className="key-removed-list">
        {removed.map((r) => (
          <li key={r.id} data-removed={r.id}>
            <span className="key-removed-text">
              <span>
                {r.name}
                {r.date && <span className="meta"> · since {dayText(r.date)}</span>}
              </span>
              {r.reason && <span className="meta">{r.reason}</span>}
            </span>
            {r.leftover &&
              (confirm === r.id ? (
                <span className="setup-confirm">
                  <span className="meta">Remove its saved key?</span>
                  <button
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setErr(null);
                      const res = await clearPoolKeys(r.id);
                      setBusy(false);
                      setConfirm(null);
                      if (!res.ok) setErr(res.detail);
                      else onChanged();
                    }}
                  >
                    Remove
                  </button>
                  <button className="btn" onClick={() => setConfirm(null)} autoFocus>
                    Keep
                  </button>
                </span>
              ) : (
                <span className="setup-account-actions">
                  <span className="meta">Key still saved</span>
                  <button className="btn" onClick={() => setConfirm(r.id)}>
                    Remove
                  </button>
                </span>
              ))}
          </li>
        ))}
      </ul>
      {err && (
        <p className="setup-row-msg" role="alert">
          {err}
        </p>
      )}
    </details>
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
  onReload,
}: {
  p: PoolProvider;
  help: PoolHelp | undefined;
  open: boolean;
  onOpen: () => void;
  /** A first key saved (working: the provider closes) or the last one removed. */
  onDone: (o: KeyOutcome | "removed") => void;
  /** A key added, renamed, switched or removed beside others: read the keys again, stay open. */
  onReload: () => void;
}) {
  const fromApp = p.vars.some((v) => v.from === "app");
  const fromEnv = p.vars.some((v) => v.from === "env");
  const missing = p.vars.filter((v) => !v.set);
  const fullName = help?.name ?? providerName(p.id);
  const name = shortName(fullName);
  // A router that keeps several keys lists them; a provider with none of the person's own yet
  // (none, or only the keyless slot) starts as before.
  const own = ownKeys(p);
  const keys = own?.length ? own : null;
  const anon = keys ? p.keys?.find(isAnon) : undefined;
  const inUse = keys?.filter((k) => k.usable && k.enabled).length ?? 0;
  // When the provider was opened, for the rough minutes a manual save reports.
  const openedAt = useRef<number | null>(null);
  useEffect(() => {
    openedAt.current = open ? Date.now() : null;
  }, [open]);
  // The save just made: which key (the router's key_id) and what the check said.
  const [fresh, setFresh] = useState<{ id: string | null; outcome: KeyOutcome } | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (!open) {
      setAdding(false);
      setFresh(null);
    }
  }, [open]);
  const saved = (o: KeyOutcome | "removed", keyId?: string | null, another = false) => {
    if (o !== "removed" && o.kind !== "not_saved") {
      setFresh({ id: keyId ?? null, outcome: o });
      setAdding(false);
      manualResult(p.id, o, openedAt.current);
      openedAt.current = Date.now();
    }
    if (another) onReload();
    else onDone(o);
  };

  let cls = "dot-off";
  let text = "Needs a key";
  if (keys) {
    cls = inUse ? "dot-ok" : "dot-warn";
    text =
      keys.length === 1
        ? inUse
          ? "Key set"
          : keys[0].enabled
            ? "Key not in use"
            : "Key off"
        : `${keys.length} keys · ${inUse} in use`;
  } else if (p.usable && p.anonymous && !p.vars.some((v) => v.set)) {
    cls = "dot-ok";
    text = "Works without a key";
  } else if (p.usable) {
    cls = "dot-ok";
    text = fromEnv && !fromApp ? "Key from the router's setup" : "Key set";
  } else if (p.vars.some((v) => v.set)) {
    cls = "dot-warn";
    text = `Needs ${missing.map((v) => v.name).join(", ")}`;
  }
  const until = p.until ?? help?.until ?? null;

  return (
    <li data-pool={p.id} data-open={open || undefined}>
      <div className="setup-account">
        <div className="setup-account-text">
          <span className="setup-account-name">
            {fullName}
            <FreeBadge help={help} />
            <PersonBadge help={help} />
          </span>
          <span className="setup-account-status">
            <Status cls={cls} text={text} />
            <span className="meta key-row-meta">
              {help?.recommended === false && help.why_not
                ? help.why_not
                : !p.usable && help?.time_minutes
                  ? `about ${help.time_minutes} min`
                  : `${p.models} model${p.models === 1 ? "" : "s"}${p.tiers.length ? ` · ${p.tiers.join(", ")}` : ""}`}
            </span>
            {until && <span className="meta key-until">{untilText(until, p.expired)}</span>}
          </span>
        </div>
        {p.vars.length > 0 && (
          <span className="setup-account-actions">
            <button className="btn" onClick={onOpen} aria-expanded={open}>
              {open
                ? help || keys
                  ? "Hide"
                  : "Cancel"
                : p.vars.some((v) => v.set) || keys
                  ? "Change"
                  : "Add key"}
            </button>
          </span>
        )}
      </div>
      {open &&
        (keys ? (
          <div className="key-guide key-manage">
            <ul className="key-list">
              {keys.map((k, i) => (
                <KeyItem
                  key={k.id}
                  provider={p.id}
                  k={k}
                  i={i}
                  name={name}
                  fresh={k.id === fresh?.id ? fresh.outcome : null}
                  last={keys.length === 1}
                  onChanged={onReload}
                  onRemoved={() => (keys.length === 1 ? onDone("removed") : onReload())}
                />
              ))}
              {anon && (
                <li className="key-item" data-key-id={anon.id}>
                  <span className="key-item-main">
                    <span className="key-item-name">No key needed</span>
                  </span>
                  <span className="key-item-state">
                    <Status
                      cls={anon.usable ? "dot-ok" : "dot-warn"}
                      text={anon.usable ? "In use" : (anon.reason ?? "Not in use")}
                    />
                  </span>
                </li>
              )}
            </ul>
            {adding ? (
              <div className="key-add" data-key-add>
                <TermsNote multi={p.multiple_keys ?? help?.multiple_keys ?? null} name={name} />
                {help && <OpenButtons help={help} />}
                {help && help.steps.length > 0 && (
                  <details className="key-card-steps">
                    <summary>Steps ({help.steps.length})</summary>
                    <GuideSteps help={help} />
                  </details>
                )}
                <KeyForm
                  pool={p}
                  help={help}
                  name={name}
                  autoFocus
                  add={{
                    multi: p.multiple_keys ?? help?.multiple_keys ?? null,
                    defaultLabel: `Key ${keys.length + 1}`,
                    onCancel: () => setAdding(false),
                  }}
                  onDone={(o, id) => saved(o, id, true)}
                />
              </div>
            ) : (
              <button className="setup-add key-add-another" onClick={() => setAdding(true)}>
                <IconPlusSmall />
                Add another key
              </button>
            )}
            {help && <GoodToKnow help={help} />}
          </div>
        ) : help ? (
          <KeyGuide pool={p} help={help} name={name} onDone={saved} />
        ) : (
          <KeyForm pool={p} name={name} autoFocus onDone={saved} />
        ))}
    </li>
  );
}

/**
 * One saved key: its name (renamed in place), plan, last four, in use or why not, on/off, Try
 * again for one the provider refused, and Remove (asks first; not for a key from the router's
 * environment, which is removed there).
 */
function KeyItem({
  provider,
  k,
  i,
  name,
  fresh,
  last,
  onChanged,
  onRemoved,
}: {
  provider: string;
  k: PoolKey;
  i: number;
  name: string;
  /** Just saved: what the check said. */
  fresh: KeyOutcome | null;
  /** The provider's only key: removing it closes the provider. */
  last: boolean;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const label = keyName(k, i);
  const env = k.source === "env";
  // Refused by the provider (not off, not missing a field): the person can have it tried again.
  const refused = k.enabled && !k.usable && !!k.reason && !/^Needs\b/.test(k.reason);
  const [cls, text] = !k.enabled
    ? ["dot-off", "Off"]
    : fresh?.kind === "rejected"
      ? ["dot-warn", rejectedText(name, fresh)]
      : !k.usable
        ? ["dot-warn", k.reason ?? "Not in use"]
        : fresh?.kind === "working"
          ? ["dot-ok", "Working"]
          : fresh?.kind === "saved"
            ? ["dot-ok", "Saved"]
            : ["dot-ok", "In use"];

  const patch = async (body: KeyPatch) => {
    setBusy(true);
    setErr(null);
    const r = await updatePoolKey(provider, k.id, body);
    setBusy(false);
    if (!r.ok) setErr(r.detail);
    else onChanged();
  };
  const rename = async (value: string) => {
    setEditing(false);
    const v = value.trim();
    if (v === (k.label ?? "") || (!k.label && v === label)) return;
    await patch({ label: v || null });
  };
  const remove = async () => {
    setBusy(true);
    setErr(null);
    const r = await removePoolKey(provider, k.id);
    setBusy(false);
    setConfirm(false);
    if (!r.ok) setErr(r.detail);
    else onRemoved();
  };

  return (
    <li className="key-item" data-key-id={k.id} data-off={!k.enabled || undefined}>
      <span className="key-item-main">
        {editing ? (
          <input
            className="setup-input key-item-input"
            defaultValue={k.label ?? ""}
            placeholder={`Key ${i + 1}`}
            maxLength={60}
            aria-label="Key name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void rename(e.currentTarget.value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
              }
            }}
            onBlur={(e) => void rename(e.currentTarget.value)}
          />
        ) : (
          <button
            type="button"
            className="key-item-label"
            title="Rename"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            {label}
          </button>
        )}
        {k.tier && (
          <span className="setup-plan" data-plan={k.tier}>
            {k.tier === "paid" ? "Paid" : "Free"}
          </span>
        )}
        {k.last4 && <span className="meta key-item-last4">…{k.last4}</span>}
      </span>
      {confirm ? (
        <span className="setup-confirm">
          <span className="meta">{last ? "Remove the only key?" : "Remove this key?"}</span>
          <button className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
          <button className="btn" onClick={() => setConfirm(false)} autoFocus>
            Keep
          </button>
        </span>
      ) : (
        <span className="key-item-state">
          <Status cls={cls} text={text} />
          {refused && (
            <button
              type="button"
              className="btn btn-small key-item-retry"
              disabled={busy}
              onClick={() => void patch({ enabled: true })}
            >
              Try again
            </button>
          )}
          <input
            type="checkbox"
            className="switch key-item-switch"
            checked={k.enabled}
            disabled={busy}
            aria-label={`Use ${label}`}
            title={
              k.enabled ? "In the pool: switch off to stop using it" : "Off: switch on to use it"
            }
            onChange={(e) => void patch({ enabled: e.currentTarget.checked })}
          />
          {env ? (
            <span
              className="meta key-item-env"
              title="Set in the router's keys.env or the shell: remove it there."
            >
              From the router's setup
            </span>
          ) : (
            <button
              className="icon-btn setup-remove"
              aria-label={`Remove ${label}`}
              title="Remove key"
              onClick={() => setConfirm(true)}
            >
              <IconTrash />
            </button>
          )}
        </span>
      )}
      {err && (
        <p className="setup-row-msg key-item-msg" role="alert">
          {err}
        </p>
      )}
    </li>
  );
}
