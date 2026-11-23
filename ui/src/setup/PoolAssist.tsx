// The token pool's assisted setup: Claude Code or Codex (connected as a fallback) walks the
// person through getting each provider's key, in a normal, visible thread of the app's, so they
// can answer and type. The assistant never sees a key (assist-text.ts has the mechanism):
//
//   AssistNote      the line + "Set up with Claude Code" on the keys page and the welcome
//   startPoolAssist builds the brief from /pool/help and /pool/keys, makes an empty scratch
//                   folder (POST /api/scratch), and starts the read-only fallback thread
//   PoolKeyCard     what `[[provenance:pool-key <id>]]` in the assistant's message becomes: the
//                   provider's steps, its keys page and the key field (`<id> add`: one more key
//                   beside the saved ones, with the terms' note on a second account); the outcome
//                   goes back to the assistant as the next message, by itself, and to the router
//                   (pool-outcome.ts) with the assistant's notes on the steps
//   KeyIntercept    a key pasted into the composer of that thread: saved to the provider instead,
//                   and only a redacted note is sent

import { useEffect, useRef, useState } from "react";
import { fallbacks, type Fallback } from "../fallback/available";
import { fallbackModelKey } from "../../shared/fallback-api";
import { notify, sendMessage, startAssistThread } from "../store/actions";
import { useAppState } from "../store/store";
import {
  ASSIST_NAME,
  NOTE_PREFIX,
  guided,
  noteReason,
  outcomeNote,
  poolBrief,
  poolSetUp,
  redact,
  type KeyOutcome,
} from "./assist-text";
import {
  DataUse,
  GuideFacts,
  GuideSteps,
  KeyForm,
  OpenButtons,
  rejectedText,
  TermsNote,
} from "./KeyGuide";
import { providerName, shortName } from "./KeysStep";
import { assistResult, cardShown } from "./pool-outcome";
import { closeSetupDialogs } from "./open";
import { Status } from "./parts";
import { savePoolKey } from "./pool-save";
import {
  getAccounts,
  getPoolHelp,
  getPoolKeysAll,
  getWebOpen,
  inUse,
  ownKeys,
  type PoolHelpData,
  type PoolProvider,
  type RemovedProvider,
  type WebAccounts,
} from "./web";

/** The fallback that would run the assistant: Claude Code if it's ready, else Codex. */
export function useAssistant(): Fallback | null {
  const prefs = useAppState((s) => s.settings.fallbacks);
  const info = useAppState((s) => s.fallbackInfo);
  return fallbacks(prefs, info).find((f) => f.ready) ?? null;
}

/**
 * "Claude Code or Codex can walk you through these": shown while a provider the router explains
 * is still not set up. With a fallback ready it starts the assistant; without, it leads to the
 * Fallbacks step.
 */
export function AssistNote({
  help,
  pool,
  onFallbacks,
}: {
  help: PoolHelpData;
  pool: PoolProvider[];
  onFallbacks: () => void;
}) {
  const f = useAssistant();
  const [busy, setBusy] = useState(false);
  const open = guided(
    help.providers.filter((h) => h.recommended),
    pool,
  ).filter((h) => !poolSetUp(pool.find((p) => p.id === h.id)));
  // The ones only the person can do (`setup: person`) are counted apart.
  const left = open.filter((h) => !h.person);
  const theirs = open.length - left.length;
  if (!left.length) return null;
  return (
    <div className="assist-note" data-assist={f ? f.cli : "none"}>
      <span className="assist-note-text">
        {f
          ? `${f.name} can walk you through getting ${left.length === 1 ? "one more free API key" : `${left.length} free API keys, one at a time`}${theirs ? ` (${theirs} more you set up yourself)` : ""}. You paste each key into the app, never into the chat.`
          : "Once Claude Code or Codex is connected as a fallback, it can walk you through getting free API keys, one at a time."}
      </span>
      {f ? (
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void startPoolAssist(f).finally(() => setBusy(false));
          }}
        >
          {busy ? "Starting…" : `Set up with ${f.name}`}
        </button>
      ) : (
        <button className="btn" onClick={onFallbacks}>
          Connect Claude Code or Codex
        </button>
      )}
    </div>
  );
}

/** Start the assistant's thread. Nothing secret goes in: /pool/keys never sends a value back. */
export async function startPoolAssist(f: Fallback): Promise<void> {
  const [help, keys] = await Promise.all([getPoolHelp(), getPoolKeysAll()]);
  if (!help || !keys.ok) return notify("error", "The router can't explain its keys yet.");
  let cwd: string;
  try {
    const r = await fetch("/api/scratch?purpose=pool-setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    cwd = ((await r.json()) as { path: string }).path;
  } catch {
    return notify("error", "Couldn't make the assistant's folder.");
  }
  closeSetupDialogs();
  void reloadPoolData(); // the key cards read what is set up now
  await startAssistThread(
    fallbackModelKey(f.mode, ""),
    cwd,
    poolBrief(help, keys.value.providers, f.name, keys.value.removed),
    ASSIST_NAME,
  );
}

// ---- the key card ------------------------------------------------------------------------

/**
 * /pool/help, /pool/keys, the web accounts and whether the router can open a page in a signed-in
 * account's window (GET /web/open answers), for the cards, the composer and the "Open in your
 * signed-in … window" buttons: read once, after each save, and on demand.
 */
interface PoolData {
  help: PoolHelpData | null;
  pool: PoolProvider[] | null;
  removed: RemovedProvider[];
  accounts: WebAccounts | null;
  webOpen: boolean;
}
let cache: PoolData | null = null;
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();
export function reloadPoolData(): Promise<void> {
  loading = Promise.all([getPoolHelp(), getPoolKeysAll(), getAccounts(), getWebOpen()]).then(
    ([help, keys, accounts, open]) => {
      cache = {
        help,
        pool: keys.ok ? keys.value.providers : null,
        removed: keys.ok ? keys.value.removed : [],
        accounts: accounts.ok ? accounts.value : null,
        webOpen: open !== null,
      };
      loading = null;
      for (const s of subs) s();
    },
  );
  return loading;
}
/** `fresh`: read it again on mount (the keys page, where accounts may have changed meanwhile). */
export function usePoolData(want = true, fresh = false) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!want) return;
    const s = () => tick((n) => n + 1);
    subs.add(s);
    if ((fresh || !cache) && !loading) void reloadPoolData();
    return () => void subs.delete(s);
  }, [want, fresh]);
  return want ? cache : null;
}

/**
 * "You're signed in to Gemini: get a free Gemini API key with the same Google account": while a
 * Gemini account is signed in and no Google key is saved, the largest free addition for the
 * least effort after the providers that need no key.
 */
export function GeminiKeyPrompt({
  accounts,
  pool,
  help,
  onGet,
}: {
  accounts: WebAccounts | null;
  pool: PoolProvider[] | null;
  help: PoolHelpData | null;
  onGet: () => void;
}) {
  const g = help?.providers.find((h) => h.id === "google");
  const key = pool?.find((p) => p.id === "google");
  if (!g || !key || key.vars.some((v) => v.set) || !accounts) return null;
  const sites = new Set(["gemini-web", ...(g.open_with ?? []).map((o) => o.provider)]);
  const signed = accounts.providers.find(
    (p) => sites.has(p.id) && p.accounts.some((a) => inUse(a)),
  );
  if (!signed) return null;
  return (
    <div className="gemini-prompt" data-gemini-prompt>
      <span className="gemini-prompt-text">
        You're signed in to {signed.name}: get a free Gemini API key with the same Google account.
      </span>
      <button className="btn" onClick={onGet}>
        Get the key
      </button>
    </div>
  );
}

/** Send the app's note to the assistant's thread (never anything the person pasted). */
function tell(threadId: string, note: string): void {
  void sendMessage(note, undefined, { threadId });
}

export function PoolKeyCard({
  id,
  add = false,
  threadId,
  live,
  outcome,
}: {
  id: string;
  /** `[[provenance:pool-key <id> add]]`: one more key beside the saved ones. */
  add?: boolean;
  threadId: string | null;
  /** The newest card, not answered yet: it takes a key. */
  live: boolean;
  /** What the app told the assistant about this card, once answered. */
  outcome: { text: string; tone: string } | null;
}) {
  const data = usePoolData();
  const [sent, setSent] = useState<KeyOutcome | null>(null);
  const help = data?.help?.providers.find((h) => h.id === id);
  const pool = data?.pool?.find((p) => p.id === id);
  const name = shortName(help?.name ?? providerName(id));
  const sending = useAppState((s) => s.sending);
  // A router that keeps several keys per provider; else saving replaces the one there is.
  const multi = !!pool && pool.keys !== null;
  const another = add && multi && (ownKeys(pool!)?.length ?? 0) > 0;

  // The card is up: the minutes it takes count from here.
  const counted = useRef(false);
  useEffect(() => {
    if (!live || sent || !threadId || !data || counted.current) return;
    counted.current = true;
    cardShown(threadId, id, data.help?.providers);
  }, [live, sent, threadId, id, data]);

  const done = (o: KeyOutcome) => {
    setSent(o);
    void reloadPoolData();
    if (threadId) {
      // First: the note's own turn is the one whose reply may carry the steps line.
      assistResult(threadId, id, o);
      tell(threadId, outcomeNote(name, o));
    }
  };

  if (!live || sent) {
    const tone = sent
      ? sent.kind === "working" || sent.kind === "saved"
        ? "ok"
        : sent.kind === "skipped"
          ? "off"
          : "warn"
      : outcome?.tone;
    const notSaved = sent ? sent.kind === "not_saved" : /not saved/.test(outcome?.text ?? "");
    const why = sent && "reason" in sent ? sent.reason : noteReason(outcome?.text ?? "");
    const byRouter = sent
      ? sent.kind === "rejected" && sent.by === "router"
      : /can't be used yet/.test(outcome?.text ?? "");
    const t = !tone
      ? null
      : tone === "ok"
        ? (sent ? sent.kind === "saved" : /not checked/.test(outcome?.text ?? ""))
          ? "Saved (not checked)"
          : "Saved and working"
        : tone === "off"
          ? "Skipped"
          : notSaved
            ? `Not saved${why ? `: ${why}` : ""}`
            : rejectedText(name, {
                kind: "rejected",
                reason: why ?? "it refused the key",
                by: byRouter ? "router" : "provider",
              });
    return (
      <div className="key-card key-card-closed" data-key-card={id}>
        <span className="key-card-title">{add ? `Another ${name} key` : `${name} key`}</span>
        {t ? (
          <Status
            cls={tone === "ok" ? "dot-ok" : tone === "off" ? "dot-off" : "dot-warn"}
            text={t}
          />
        ) : (
          <span className="meta">Not answered</span>
        )}
      </div>
    );
  }
  if (!data) return <div className="key-card" data-key-card={id} aria-busy="true" />;
  const skip = (
    <button
      type="button"
      className="btn"
      disabled={sending}
      onClick={() => done({ kind: "skipped" })}
    >
      Skip
    </button>
  );
  if (!pool || !pool.vars.length)
    return (
      <div className="key-card" data-key-card={id}>
        <p className="key-card-title">{name}</p>
        <p className="meta key-card-sub">The token pool has no key to set for this one.</p>
        <span className="setup-key-actions">{skip}</span>
      </div>
    );
  const count = ownKeys(pool)?.length ?? 0;
  const terms = pool.multiple_keys ?? help?.multiple_keys ?? null;
  return (
    <div className="key-card" data-key-card={id} data-live data-add={another || undefined}>
      <div className="key-card-head">
        <p className="key-card-title">
          {another ? `Add another ${name} key` : `Add your ${name} key`}
        </p>
        <span className="meta key-card-sub">
          {another
            ? `Paste it here: it joins the ${count === 1 ? "key" : `${count} keys`} already saved, and the assistant only hears whether it works.`
            : "Paste it here: Provenance saves it, and the assistant only hears whether it works."}
        </span>
        {add && !multi && pool.vars.some((v) => v.set) && (
          <span className="meta key-card-sub">
            This router keeps one key per provider: saving replaces the one saved.
          </span>
        )}
      </div>
      {another && <TermsNote multi={terms} name={name} />}
      {help && !another && <DataUse help={help} />}
      {help && (
        <details className="key-card-steps">
          <summary>Steps{help.steps.length ? ` (${help.steps.length})` : ""}</summary>
          <GuideFacts help={help} />
          <GuideSteps help={help} />
        </details>
      )}
      {help && <OpenButtons help={help} />}
      <KeyForm
        pool={pool}
        help={help}
        name={name}
        autoFocus
        showRemove={false}
        extraActions={skip}
        add={another ? { multi: terms, defaultLabel: `Key ${count + 1}` } : undefined}
        onDone={(o) => o !== "removed" && o.kind !== "not_saved" && done(o)}
      />
    </div>
  );
}

// ---- a key pasted into the composer --------------------------------------------------------

/**
 * Shown in place of sending when a message in the assistant's thread holds something that looks
 * like a key: save it to a provider instead (only a note reaches the assistant), take it out and
 * send the rest, or go back to editing.
 */
export function KeyIntercept({
  threadId,
  text,
  keyText,
  guess,
  onEdit,
  onDone,
}: {
  threadId: string;
  text: string;
  keyText: string;
  guess: string | null;
  onEdit: () => void;
  onDone: () => void;
}) {
  const data = usePoolData();
  const choices = (data?.pool ?? []).filter((p) => p.vars.length > 0);
  const nameOf = (id: string) =>
    shortName(data?.help?.providers.find((h) => h.id === id)?.name ?? providerName(id));
  const [to, setTo] = useState<string>(
    guess ?? choices.find((p) => !p.usable)?.id ?? choices[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rest = redact(text, [keyText])
    .replace(/\[key removed by the app\]/g, "")
    .trim();

  const save = async () => {
    const p = choices.find((x) => x.id === to);
    if (!p) return;
    const h = data?.help?.providers.find((x) => x.id === to);
    const extra = new Set((h?.extra_fields ?? []).map((f) => f.var));
    const v =
      p.vars.find((x) => x.name === h?.key_var) ??
      p.vars.find((x) => !extra.has(x.name)) ??
      p.vars[0];
    setBusy(true);
    setErr(null);
    // Beside the saved ones where the router keeps several; else it sets (replaces) the one.
    const { outcome } = await savePoolKey(
      p.id,
      { [v.name]: keyText },
      ownKeys(p)?.length ? { keyVar: v.name } : undefined,
    );
    setBusy(false);
    if (outcome.kind === "not_saved") return setErr(outcome.reason);
    void reloadPoolData();
    const note = `${NOTE_PREFIX}A key the person pasted into the chat was taken out and saved by the app. ${outcomeNote(nameOf(p.id), outcome).slice(NOTE_PREFIX.length)}`;
    assistResult(threadId, p.id, outcome);
    tell(threadId, rest ? `${note}\n\n${redact(text, [keyText])}` : note);
    onDone();
  };

  return (
    <div className="key-intercept" role="alertdialog" aria-labelledby="key-intercept-title">
      <p id="key-intercept-title" className="key-intercept-title">
        That looks like an API key
      </p>
      <p className="key-intercept-text">
        Keys go into Provenance, not the chat, where the assistant would see it.
      </p>
      <span className="key-intercept-row">
        <label className="key-intercept-to">
          <span className="meta">Save it for</span>
          <select className="picker" value={to} onChange={(e) => setTo(e.target.value)}>
            {choices.map((p) => (
              <option key={p.id} value={p.id}>
                {nameOf(p.id)}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <button className="btn" onClick={onEdit} disabled={busy}>
          Edit message
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            tell(threadId, redact(text, [keyText]));
            onDone();
          }}
        >
          Send without it
        </button>
        <button className="btn-primary" disabled={busy || !to} onClick={() => void save()}>
          {busy ? "Saving…" : `Save to ${to ? nameOf(to) : "…"}`}
        </button>
      </span>
      {err && (
        <p className="setup-row-msg" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
