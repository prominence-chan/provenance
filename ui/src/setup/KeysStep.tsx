// The token pool's API keys (Models & accounts → Token pool): which providers have a key, and
// a field to add one. Keys go to the router (PUT /pool/keys/{provider}), which keeps them in
// its own home, readable by this user only; they never come back to the page.

import { useState } from "react";
import { Status } from "./parts";
import { clearPoolKeys, setPoolKeys, type PoolProvider } from "./web";

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

export const providerName = (id: string): string =>
  NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

export function KeysStep({ pool, onChanged }: { pool: PoolProvider[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  // Providers that work first, then the ones a key would add; each group in catalog order.
  const sorted = [...pool].sort((a, b) => Number(b.usable) - Number(a.usable));
  const working = pool.filter((p) => p.usable).length;
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
      <ul className="setup-accounts setup-keys">
        {sorted.map((p) => (
          <KeyRow
            key={p.id}
            p={p}
            open={editing === p.id}
            onOpen={() => setEditing(editing === p.id ? null : p.id)}
            onDone={() => {
              setEditing(null);
              onChanged();
            }}
          />
        ))}
      </ul>
    </div>
  );
}

function KeyRow({
  p,
  open,
  onOpen,
  onDone,
}: {
  p: PoolProvider;
  open: boolean;
  onOpen: () => void;
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fromApp = p.vars.some((v) => v.from === "app");
  const fromEnv = p.vars.some((v) => v.from === "env");
  const missing = p.vars.filter((v) => !v.set);
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

  const save = async () => {
    const vals = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
    if (!Object.keys(vals).length) return setErr("Paste the key first.");
    setBusy(true);
    setErr(null);
    const r = await setPoolKeys(p.id, vals);
    setBusy(false);
    if (!r.ok) return setErr(r.detail);
    setValues({});
    onDone();
  };
  const remove = async () => {
    setBusy(true);
    setErr(null);
    const r = await clearPoolKeys(p.id);
    setBusy(false);
    if (!r.ok) return setErr(r.detail);
    onDone();
  };

  return (
    <li data-pool={p.id}>
      <div className="setup-account">
        <div className="setup-account-text">
          <span className="setup-account-name">{providerName(p.id)}</span>
          <span className="setup-account-status">
            <Status cls={cls} text={text} />
            <span className="meta">
              {p.models} model{p.models === 1 ? "" : "s"}
              {p.tiers.length ? ` · ${p.tiers.join(", ")}` : ""}
            </span>
          </span>
        </div>
        {p.vars.length > 0 && (
          <span className="setup-account-actions">
            <button className="btn" onClick={onOpen} aria-expanded={open}>
              {open ? "Cancel" : p.vars.some((v) => v.set) ? "Change" : "Add key"}
            </button>
          </span>
        )}
      </div>
      {open && (
        <form
          className="setup-key-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {p.vars.map((v, i) => (
            <label key={v.name} className="setup-key-field">
              <span className="meta">
                {v.name}
                {v.set ? ` · set${v.from === "env" ? " by the router's setup" : ""}` : ""}
              </span>
              <input
                className="setup-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoFocus={i === 0}
                placeholder={v.set ? "Paste a new value to replace it" : "Paste it here"}
                value={values[v.name] ?? ""}
                onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
              />
            </label>
          ))}
          <span className="setup-key-actions">
            {fromApp && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                Remove key
              </button>
            )}
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </span>
        </form>
      )}
      {err && (
        <p className="setup-row-msg" role="alert">
          {err}
        </p>
      )}
    </li>
  );
}
