// One token pool provider's key, with how to get it (from the router's /pool/help): what you get,
// what you need, how long, the numbered steps with the site's own control names, a button that
// opens its keys page in your browser, the key field (its format as the hint, its pattern as a
// soft check), any extra field (Cloudflare's account id), and what to watch out for. Used by the
// keys page (KeysStep.tsx) and by the setup assistant's key card (PoolAssist.tsx).
//
// Values stay in their own <input>s (uncontrolled: never React state) until Save reads them into
// the one PUT body; the fields are emptied once the router has them.

import { useEffect, useRef, useState } from "react";
import { keyFits, type KeyOutcome } from "./assist-text";
import { shortName } from "./KeysStep";
import { usePoolData } from "./PoolAssist";
import { savePoolKey } from "./pool-save";
import {
  accountName,
  cancelLogin,
  clearPoolKeys,
  getWebOpen,
  openWebPage,
  siteHost,
  type PoolHelp,
  type PoolProvider,
} from "./web";

/** A line of the router's help text: **bold** for a control's name, `code`, and bare links. */
export function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4)
          return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (p.startsWith("`") && p.endsWith("`") && p.length > 2)
          return <code key={i}>{p.slice(1, -1)}</code>;
        if (/^https?:\/\//.test(p)) {
          const url = p.replace(/[.,;:]+$/, "");
          return (
            <span key={i}>
              <a href={url} target="_blank" rel="noreferrer">
                {url.replace(/^https:\/\//, "")}
              </a>
              {p.slice(url.length)}
            </span>
          );
        }
        return p;
      })}
    </>
  );
}

/** "No key needed", "Free", "Trial credit", "No free tier". */
export function FreeBadge({ help }: { help: PoolHelp | undefined }) {
  const t = help?.free_tier;
  if (!t) return null;
  const text = {
    anonymous: "No key needed",
    free: "Free",
    trial: "Trial credit",
    none: "No free tier",
  }[t];
  return (
    <span className="setup-plan key-badge" data-free={t}>
      {text}
    </span>
  );
}

export function GuideFacts({ help, time = true }: { help: PoolHelp; time?: boolean }) {
  const needs = help.needs.join(" ");
  if (!needs && !(time && help.time_minutes)) return null;
  return (
    <p className="meta key-guide-facts">
      {time && help.time_minutes ? `About ${help.time_minutes}\u00a0min. ` : ""}
      {needs && (
        <>
          You need: <Inline text={needs} />
        </>
      )}
    </p>
  );
}

/** What the provider does with prompts (trains on them, people read them): the person decides on it. */
const DATA_USE = /\b(train|improve|human reviewers|logged|log prompts|uses? the content)/i;
const REASSURING = /\b(does not retain|may not use|no such use)/i;
export const isDataUse = (g: string) => DATA_USE.test(g) && !REASSURING.test(g);

/** Before the steps, where the person decides whether to go on: what happens to their prompts. */
export function DataUse({ help }: { help: PoolHelp }) {
  const items = help.gotchas.filter(isDataUse);
  if (!items.length) return null;
  return (
    <div className="key-datause" role="note">
      <p className="key-datause-title">What happens to your prompts</p>
      <ul>
        {items.map((g, i) => (
          <li key={i}>
            <Inline text={g} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GuideSteps({ help }: { help: PoolHelp }) {
  if (!help.steps.length) return null;
  const name = shortName(help.name);
  const note =
    help.confidence === "docs-only"
      ? `From ${name}'s docs: the page's button names may differ.`
      : help.confidence === "uncertain"
        ? "These steps may be out of date: where the page differs, follow the page."
        : null;
  return (
    <>
      <ol className="key-steps">
        {help.steps.map((s, i) => (
          <li key={i}>
            <Inline text={s} />
          </li>
        ))}
      </ol>
      {note && <p className="meta key-confidence">{note}</p>}
    </>
  );
}

/** The other things worth knowing (the prompts' use is shown apart), folded. */
export function GoodToKnow({ help }: { help: PoolHelp }) {
  const items = help.gotchas.filter((g) => !isDataUse(g));
  if (!items.length && !help.terms_note) return null;
  return (
    <details className="key-more">
      <summary>Good to know ({items.length + (help.terms_note ? 1 : 0)})</summary>
      <ul className="key-gotchas">
        {items.map((g, i) => (
          <li key={i}>
            <Inline text={g} />
          </li>
        ))}
        {help.terms_note && (
          <li>
            Terms: <Inline text={help.terms_note} />
          </li>
        )}
      </ul>
    </details>
  );
}

export function OpenKeysPage({ help }: { help: PoolHelp }) {
  const url = help.keys_url || help.signup_url;
  if (!url) return null;
  // A plain link: the desktop app opens it in the person's own browser (electron/main.ts).
  return (
    <a className="btn key-open" href={url} target="_blank" rel="noreferrer">
      Open {siteHost(url)}
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </svg>
    </a>
  );
}

/** The ways to open the keys page: the person's browser, or a signed-in web account's window. */
export function OpenButtons({ help }: { help: PoolHelp }) {
  return (
    <div className="key-open-row">
      <OpenKeysPage help={help} />
      <OpenSignedIn help={help} />
    </div>
  );
}

/**
 * "Open in your signed-in Gemini window (Account B)": the router opens the key page in that web
 * account's own browser profile (POST /web/open), already signed in to the same Google account,
 * for the person to act in; the app automates nothing there. Hidden without `open_with`, on a
 * router without /web/open, or when that account isn't signed in.
 */
export function OpenSignedIn({ help }: { help: PoolHelp }) {
  const data = usePoolData(!!help.open_with?.length, true);
  const [opened, setOpened] = useState<{ provider: string; account: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // While the window is open, notice it closing (by the person, or the router).
  useEffect(() => {
    if (!opened) return;
    const t = window.setInterval(async () => {
      const w = await getWebOpen();
      if (w && !w.open) setOpened(null);
    }, 2000);
    return () => window.clearInterval(t);
  }, [opened]);
  if (!help.open_with?.length || !data?.webOpen || !data.accounts) return null;
  const url = help.keys_url || help.signup_url;
  const ways = help.open_with
    .map((o) => {
      const site = data.accounts!.providers.find((p) => p.id === o.provider);
      const acc = site?.accounts.find((a) => a.id === o.account);
      return site && acc && acc.signed_in === true ? { ...o, site, acc } : null;
    })
    .filter((x) => x !== null);
  if (!ways.length || !url) return null;
  const google = /google|gemini/i.test(help.name);
  if (opened) {
    const w = ways.find((x) => x.provider === opened.provider && x.account === opened.account);
    return (
      <span className="key-signed-open" role="status">
        <span className="meta">
          Open in your {w?.site.name ?? "signed-in"} window: make the key there, then paste it
          below.
        </span>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void cancelLogin(opened.provider, opened.account);
            setOpened(null);
          }}
        >
          Close that window
        </button>
      </span>
    );
  }
  return (
    <>
      {ways.map((w) => (
        <span key={`${w.provider}/${w.account}`} className="key-signed">
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-open-with={`${w.provider}/${w.account}`}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              const r = await openWebPage(w.provider, w.account, url);
              setBusy(false);
              if (r.ok) setOpened({ provider: w.provider, account: w.account });
              else setErr(r.detail);
            }}
          >
            Open in your signed-in {w.site.name} window ({accountName(w.account)})
          </button>
        </span>
      ))}
      <span className="meta key-signed-note">
        It opens with the {google ? "Google account" : "account"} already signed in for{" "}
        {ways[0].site.name}, so there's no second sign-in.
      </span>
      {err && (
        <p className="setup-row-msg" role="alert">
          {err}
        </p>
      )}
    </>
  );
}

/** The key's own variable(s) and the extra fields, as the router names them. */
function fieldsOf(p: PoolProvider, help?: PoolHelp) {
  const extra = new Map((help?.extra_fields ?? []).map((f) => [f.var, f]));
  const main = p.vars.filter((v) => !extra.has(v.name));
  return p.vars.map((v) => {
    const x = extra.get(v.name);
    const isKey = !x;
    return {
      v,
      isKey,
      label: x ? x.label : main.length === 1 || v.name === help?.key_var ? "API key" : v.name,
      hint: x ? [x.where, x.format].filter(Boolean).join(" ") : help?.key_format || null,
    };
  });
}

export function KeyForm({
  pool: p,
  help,
  name,
  autoFocus,
  onDone,
  extraActions,
  showRemove = true,
}: {
  pool: PoolProvider;
  help?: PoolHelp;
  name: string;
  autoFocus?: boolean;
  /** After a save (any outcome) or a removal. */
  onDone: (o: KeyOutcome | "removed") => void;
  /** Beside Save (the key card's Skip). */
  extraActions?: React.ReactNode;
  showRemove?: boolean;
}) {
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const [filled, setFilled] = useState<Record<string, boolean>>({});
  const [misfit, setMisfit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; tone: "bad" | "warn" } | null>(null);
  const fromApp = p.vars.some((v) => v.from === "app");
  const fields = fieldsOf(p, help);

  const save = async () => {
    const vals: Record<string, string> = {};
    for (const f of fields) {
      const val = refs.current[f.v.name]?.value.trim();
      if (val) vals[f.v.name] = val;
    }
    if (!Object.keys(vals).length) return setErr({ text: "Paste the key first.", tone: "bad" });
    setBusy(true);
    setErr(null);
    const { outcome } = await savePoolKey(p.id, vals);
    setBusy(false);
    if (outcome.kind === "not_saved") setErr({ text: outcome.reason, tone: "bad" });
    else {
      for (const el of Object.values(refs.current)) if (el) el.value = "";
      setFilled({});
      setMisfit(false);
      if (outcome.kind === "rejected")
        setErr({ text: `Saved, but ${name} can't be used yet: ${outcome.reason}.`, tone: "warn" });
    }
    onDone(outcome);
  };
  const remove = async () => {
    setBusy(true);
    setErr(null);
    const r = await clearPoolKeys(p.id);
    setBusy(false);
    if (!r.ok) return setErr({ text: r.detail, tone: "bad" });
    onDone("removed");
  };

  return (
    <form
      className="setup-key-form"
      method="post" // never a GET: a key can't end up in a URL
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {fields.map((f, i) => (
        <label key={f.v.name} className="setup-key-field">
          <span className="key-label">
            <span>{f.label}</span>
            {f.v.set && (
              <span className="meta">
                set{f.v.from === "env" ? " by the router's setup" : ""}: paste to replace
              </span>
            )}
          </span>
          {f.hint && (
            <span className="meta key-hint">
              <Inline text={f.hint} />
            </span>
          )}
          <input
            ref={(el) => {
              refs.current[f.v.name] = el;
            }}
            className="setup-input"
            name={f.v.name}
            type={f.isKey ? "password" : "text"}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus={autoFocus && i === 0}
            data-key-field={f.isKey || undefined}
            onInput={(e) => {
              const v = e.currentTarget.value.trim();
              setFilled((x) => (x[f.v.name] === !!v ? x : { ...x, [f.v.name]: !!v }));
              if (f.isKey) setMisfit(!!v && keyFits(help, v) === false);
            }}
          />
          {f.isKey && misfit && (
            <span className="key-misfit" role="status">
              This doesn't look like a {name} key.
            </span>
          )}
        </label>
      ))}
      {err && (
        <p className={err.tone === "bad" ? "setup-row-msg" : "key-warn"} role="alert">
          {err.text}
        </p>
      )}
      <span className="setup-key-actions">
        {showRemove && fromApp && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void remove()}
          >
            Remove key
          </button>
        )}
        {extraActions}
        <button
          type="submit"
          className="btn-primary"
          disabled={busy || !Object.values(filled).some(Boolean)}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </span>
    </form>
  );
}

/** The whole guide for the keys page's open row. */
export function KeyGuide({
  pool,
  help,
  name,
  onDone,
}: {
  pool: PoolProvider;
  help: PoolHelp;
  name: string;
  onDone: (o: KeyOutcome | "removed") => void;
}) {
  return (
    <div className="key-guide">
      {help.what_you_get && (
        <p className="key-guide-get">
          <Inline text={help.what_you_get} />
        </p>
      )}
      {/* How long is on the row already. */}
      <GuideFacts help={help} time={false} />
      <DataUse help={help} />
      <GuideSteps help={help} />
      <OpenButtons help={help} />
      {pool.vars.length > 0 && <KeyForm pool={pool} help={help} name={name} onDone={onDone} />}
      <GoodToKnow help={help} />
    </div>
  );
}
