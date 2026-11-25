// Steps 1 and 2 of Models & accounts: which site (plus the token pool's keys), then which
// account on it, with the site's own switches (use it at all, its daily limit).

import { useEffect, useState } from "react";
import { TierGlyph } from "../components/TierBadge";
import { fallbacks } from "../fallback/available";
import { useAppState } from "../store/store";
import { tierOf } from "../theme/tiers";
import {
  AccountStatus,
  BrowserStrip,
  IconKey,
  IconNext,
  IconPlusSmall,
  IconTrash,
  ModelLine,
  Monogram,
  PlanLabel,
  RouterNote,
  SiteStatus,
  Status,
} from "./parts";
import { PaidPlanConfirm } from "./PaidPlan";
import { SavedSignIn } from "./SavedSignIn";
import {
  accountName,
  shownProviders,
  siteHost,
  updateProvider,
  type BrowserStatus,
  type PoolProvider,
  type WebAccounts,
  type WebProvider,
} from "./web";

/** A message under one account row (a 409, a failed add or remove). */
export interface RowMsg {
  account: string;
  text: string;
}

// ---- step 1: which site -----------------------------------------------------------

export function SitesStep({
  data,
  pool,
  firstRun,
  onPick,
  onKeys,
  onFallbacks,
  onPrepare,
}: {
  data: WebAccounts;
  /** The token pool's providers; null when the router can't set keys from the app. */
  pool: PoolProvider[] | null;
  firstRun: boolean;
  onPick: (id: string) => void;
  onKeys: () => void;
  onFallbacks: () => void;
  onPrepare: () => void;
}) {
  const sites = shownProviders(data);
  return (
    <div className="setup-step">
      <p className="setup-lead">
        {firstRun || !data.providers.some((p) => p.accounts.some((a) => a.signed_in === true))
          ? "Nothing's connected yet. Sign in to a chat site to use its models."
          : "Sign in to a chat site to use its models in Provenance."}
      </p>
      <BrowserStrip browser={data.browser} onPrepare={onPrepare} />
      {sites.length ? (
        <ul className="setup-sites">
          {sites.map((p) => (
            <li key={p.id}>
              <button className="setup-site" onClick={() => onPick(p.id)} data-provider={p.id}>
                <Monogram name={p.name} />
                <span className="setup-site-text">
                  <span className="setup-site-name">{p.name}</span>
                  <ModelLine models={p.models} />
                </span>
                <SiteStatus provider={p} />
                <IconNext />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="setup-note">This router has no chat sites set up.</p>
      )}
      {pool && (
        <>
          <h4 className="meta setup-label">Or with API keys</h4>
          <button className="setup-site setup-pool" onClick={onKeys} data-provider="pool">
            <span className="setup-mono" aria-hidden>
              <IconKey />
            </span>
            <span className="setup-site-text">
              <span className="setup-site-name">Token pool</span>
              <span className="meta">Pooled free API tiers across {pool.length} providers</span>
            </span>
            <PoolStatus pool={pool} />
            <IconNext />
          </button>
        </>
      )}
      <h4 className="meta setup-label">For threads that outgrow them</h4>
      <button
        className="setup-site setup-fallbacks"
        onClick={onFallbacks}
        data-provider="fallbacks"
      >
        <Monogram name="F" />
        <span className="setup-site-text">
          <span className="setup-site-name">Fallbacks</span>
          <span className="meta">Claude Code, Codex, and Antigravity</span>
        </span>
        <FallbackStatus />
        <IconNext />
      </button>
      <RouterNote />
    </div>
  );
}

function FallbackStatus() {
  const prefs = useAppState((s) => s.settings.fallbacks);
  const info = useAppState((s) => s.fallbackInfo);
  const list = fallbacks(prefs, info);
  const ready = list.filter((f) => f.ready).map((f) => f.name);
  if (ready.length) return <Status cls="dot-ok" text={ready.join(", ")} />;
  if (list.some((f) => f.on)) return <Status cls="dot-warn" text="Needs a look" />;
  return <Status cls="dot-off" text="Off" />;
}

export function PoolStatus({ pool }: { pool: PoolProvider[] }) {
  const keyed = pool.filter((p) => p.usable && !p.anonymous).length;
  const open = pool.filter((p) => p.usable && p.anonymous).length;
  if (keyed) return <Status cls="dot-ok" text={`${keyed} with keys`} />;
  if (open) return <Status cls="dot-warn" text="Needs API keys" />;
  return <Status cls="dot-off" text="Needs API keys" />;
}

// ---- step 2: which account ----------------------------------------------------------

export function SiteStep({
  provider,
  browser,
  busy,
  rowMsg,
  note,
  onSignIn,
  onAdd,
  onRemove,
  onPrepare,
  onChanged,
  onReload,
}: {
  provider: WebProvider;
  browser: BrowserStatus;
  busy: string | null;
  rowMsg: RowMsg | null;
  note: string | null;
  /** `switching`: signing in again to put another account in this slot (a paid plan's way out). */
  onSignIn: (account: string, switching?: boolean) => void;
  onAdd: () => void;
  onRemove: (account: string) => void;
  onPrepare: () => void;
  /** After a setting changed: the site as the router now has it. */
  onChanged: (p: WebProvider) => void;
  /** Read the accounts again (a saved sign-in or a plan changed). */
  onReload: () => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [keepOpen, setKeepOpen] = useState<string | null>(null);
  // A site that can't sign back in by itself (a Google account) says why once, not per account.
  const reasons = new Set(
    provider.accounts.map((a) => (a.autologin && !a.autologin.supported ? a.autologin.reason : "")),
  );
  const siteReason = reasons.size === 1 && !reasons.has("") ? [...reasons][0] : null;
  // One primary action: Sign in on the first account that needs it.
  const primary = provider.accounts.find((a) => a.signed_in !== true)?.id ?? null;

  return (
    <div className="setup-step">
      <div className="setup-site-head">
        <Monogram name={provider.name} />
        <div>
          <h3>{provider.name}</h3>
          {provider.url && <span className="meta">{siteHost(provider.url)}</span>}
        </div>
      </div>

      {provider.changeable && <SiteSettings provider={provider} onChanged={onChanged} />}

      <h4 className="meta setup-label">Models</h4>
      <ul className="setup-models">
        {provider.models.map((m) => (
          <li key={m.id} data-tier={tierOf(m.tier)?.id}>
            <TierGlyph tier={tierOf(m.tier)?.id ?? null} size={13} />
            <span className="setup-model-name">{m.label}</span>
            <span className="meta">
              {m.tier}
              {m.accounts && ` · only on ${m.accounts.map(accountName).join(", ")}`}
            </span>
          </li>
        ))}
      </ul>

      <h4 className="meta setup-label">Accounts</h4>
      <BrowserStrip browser={browser} onPrepare={onPrepare} />
      {note && <p className="setup-note">{note}</p>}
      <ul className="setup-accounts">
        {provider.accounts.map((a) => (
          <li key={a.id} data-account={a.id}>
            <div className="setup-account">
              <div className="setup-account-text">
                <span className="setup-account-name">
                  {accountName(a.id)}
                  <PlanLabel account={a} />
                </span>
                <AccountStatus account={a} />
              </div>
              {confirm === a.id ? (
                <span className="setup-confirm">
                  <span className="meta">Remove from all sites?</span>
                  <button
                    className="btn btn-danger"
                    disabled={busy === `remove:${a.id}`}
                    onClick={() => {
                      setConfirm(null);
                      onRemove(a.id);
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
                  {a.id !== "main" && (
                    <button
                      className="icon-btn setup-remove"
                      aria-label={`Remove ${accountName(a.id)}`}
                      title="Remove account"
                      onClick={() => setConfirm(a.id)}
                    >
                      <IconTrash />
                    </button>
                  )}
                  {/* A paid plan waiting for an answer has its own two ways on, below. */}
                  {!a.needs_confirmation && (
                    <button
                      className={a.id === primary ? "btn-primary" : "btn"}
                      disabled={busy !== null && busy.startsWith("signin:")}
                      onClick={() => onSignIn(a.id)}
                    >
                      {busy === `signin:${a.id}`
                        ? "Opening…"
                        : a.signed_in === true
                          ? "Sign in again"
                          : "Sign in"}
                    </button>
                  )}
                </span>
              )}
            </div>
            {a.signed_in === true && a.needs_confirmation ? (
              <PaidPlanConfirm
                provider={provider}
                account={a}
                busy={busy !== null && busy.startsWith("signin:")}
                onDifferent={() => onSignIn(a.id, true)}
                onConfirmed={onReload}
              />
            ) : (
              <SavedSignIn
                provider={provider}
                account={a}
                open={keepOpen === a.id}
                onOpen={() => setKeepOpen(a.id)}
                onClose={() => setKeepOpen(null)}
                onChanged={onReload}
              />
            )}
            {a.autologin &&
              !a.autologin.supported &&
              a.autologin.reason &&
              !siteReason &&
              a.autologin.method !== "github" &&
              a.autologin.method !== "other" && (
                <p className="meta autologin-unsupported">{a.autologin.reason}</p>
              )}
            {rowMsg?.account === a.id && (
              <p className="setup-row-msg" role="alert">
                {rowMsg.text}
              </p>
            )}
          </li>
        ))}
      </ul>
      {siteReason && <p className="meta autologin-unsupported">{siteReason}</p>}
      <button className="setup-add" onClick={onAdd} disabled={busy === "add"}>
        <IconPlusSmall />
        {busy === "add" ? "Adding…" : "Add another account"}
      </button>
      {rowMsg?.account === "" && (
        <p className="setup-row-msg" role="alert">
          {rowMsg.text}
        </p>
      )}
    </div>
  );
}

/** "Use ChatGPT" and its daily limit: kept by the router (PATCH /web/providers/{id}). */
function SiteSettings({
  provider: p,
  onChanged,
}: {
  provider: WebProvider;
  onChanged: (p: WebProvider) => void;
}) {
  const [cap, setCap] = useState(String(p.daily_cap));
  const [saving, setSaving] = useState<"enabled" | "cap" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // A fresh value from the router (another window, a reload) replaces an untouched field.
  useEffect(() => setCap(String(p.daily_cap)), [p.id, p.daily_cap]);
  const locked = p.enabled_by === "env-off";
  const capDirty = cap.trim() !== String(p.daily_cap);

  const save = async (
    patch: { enabled?: boolean; daily_cap?: number },
    what: "enabled" | "cap",
  ) => {
    setSaving(what);
    setErr(null);
    const r = await updateProvider(p.id, patch);
    setSaving(null);
    if (r.ok) onChanged(r.value);
    else setErr(r.detail);
  };
  const saveCap = () => {
    const n = Number(cap.trim());
    if (!Number.isInteger(n) || n < 1)
      return setErr("The daily limit is a whole number, 1 or more.");
    void save({ daily_cap: n }, "cap");
  };

  return (
    <div className="setup-settings" data-enabled={p.enabled || undefined}>
      <label className="setup-switch-row">
        <span className="setup-switch-text">
          <span>Use {p.name}</span>
          <span className="meta">
            {locked
              ? "Turned off for this router (PCORE_CHATGPT_WEB=0)"
              : p.enabled
                ? "Its models serve your threads once an account is signed in"
                : "Off: Provenance won't send it anything"}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={p.enabled}
          disabled={locked || saving === "enabled"}
          aria-checked={p.enabled}
          onChange={(e) => void save({ enabled: e.target.checked }, "enabled")}
        />
      </label>
      <form
        className="setup-cap-row"
        noValidate // our own message, in words, instead of the browser's bubble
        onSubmit={(e) => {
          e.preventDefault();
          saveCap();
        }}
      >
        <label htmlFor={`cap-${p.id}`} className="setup-switch-text">
          <span>Daily limit</span>
          <span className="meta">
            Chats per account per day, to stay well inside the site's own limits
          </span>
        </label>
        <span className="setup-cap-field">
          <input
            id={`cap-${p.id}`}
            className="setup-input setup-input-num"
            type="number"
            inputMode="numeric"
            min={1}
            max={10000}
            step={1}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape" || !capDirty) return;
              e.preventDefault(); // Escape undoes the edit first; the next one closes the dialog
              setCap(String(p.daily_cap));
            }}
          />
          {capDirty && (
            <button className="btn" type="submit" disabled={saving === "cap"}>
              {saving === "cap" ? "Saving…" : "Save"}
            </button>
          )}
        </span>
      </form>
      {err && (
        <p className="setup-row-msg" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
