// Saved sign-in and automatic re-sign-in, per account (opt-in): the router keeps the password in
// this Mac's keychain and, when the site signs the account out, signs it back in by itself,
// stopping to ask the person whenever the site wants a code, a captcha or anything unusual.
// API: PUT/PATCH/DELETE /web/accounts/{provider}/{account}/autologin, POST …/autologin/try.
//
// The password lives only in its own <input> (uncontrolled: never React state, never the store)
// until Save reads it into the one PUT body; the field is emptied right after. It is never shown
// again, logged, or put in a URL (the form posts nowhere: method="post", submit prevented).

import { useRef, useState } from "react";
import { Status } from "./parts";
import {
  accountName,
  forgetAutologin,
  saveAutologin,
  setAutologinEnabled,
  siteHost,
  tryAutologin,
  whenText,
  type Autologin,
  type WebAccount,
  type WebProvider,
} from "./web";

/** The saved sign-in's state in plain words, from its last try. */
function stateOf(al: Autologin): { cls: string; text: string } {
  const t = al.last_try;
  if (t?.result === "wrong_password")
    return {
      cls: "dot-err",
      text: "Wrong password: saved sign-in switched off until you update it",
    };
  if (!al.enabled) return { cls: "dot-off", text: "Off" };
  if (!t) return { cls: "dot-ok", text: "On" };
  if (t.result === "ok") return { cls: "dot-ok", text: `Signed back in at ${whenText(t.at)}` };
  if (t.result === "needs_person")
    return {
      cls: "dot-warn",
      text: `Needs you: ${t.detail ?? "the site asked for something only you can give"}`,
    };
  return { cls: "dot-err", text: `Couldn't sign back in: ${t.detail ?? "no reason given"}` };
}

/**
 * The line under an account row: an offer to keep it signed in, or the saved sign-in with Turn
 * off / Forget / Try now. Nothing when the router has no saved sign-in, or the site can't
 * (its reason is shown once by the caller).
 */
export function SavedSignIn({
  provider,
  account: a,
  open,
  onOpen,
  onClose,
  onChanged,
}: {
  provider: WebProvider;
  account: WebAccount;
  /** The opt-in form is open on this account (one at a time). */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const al = a.autologin;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [forget, setForget] = useState(false);
  if (!al?.supported) return null;
  if (open)
    return (
      <KeepSignedInForm
        provider={provider}
        account={a}
        onSaved={() => {
          onClose();
          onChanged();
        }}
        onCancel={onClose}
      />
    );
  if (!al.saved) {
    // Worth offering once the account has been signed in here (signed out counts: that's when
    // it helps); before its first sign-in there is nothing to keep.
    if (a.signed_in === null) return null;
    return (
      <button className="setup-add autologin-offer" onClick={onOpen}>
        Keep signed in…
      </button>
    );
  }
  const run = async (what: string, fn: () => Promise<{ ok: boolean; detail?: string }>) => {
    setBusy(what);
    setErr(null);
    const r = await fn();
    setBusy(null);
    if (!r.ok) setErr(r.detail ?? "That didn't work.");
    onChanged();
  };
  const st = stateOf(al);
  const wrong = al.last_try?.result === "wrong_password";
  const who = al.username ?? a.email;
  return (
    <div
      className="autologin"
      data-autologin={wrong ? "wrong_password" : al.enabled ? "on" : "off"}
    >
      <div className="autologin-text">
        <span className="autologin-who">
          Saved sign-in
          {who ? (
            <>
              {" "}
              for <bdi>{who}</bdi>
            </>
          ) : null}
        </span>
        <span className="autologin-status">
          <Status cls={st.cls} text={st.text} />
          {al.attempts_today > 0 && (
            <span className="meta">
              {al.attempts_today}&nbsp;attempt{al.attempts_today === 1 ? "" : "s"}&nbsp;today
            </span>
          )}
        </span>
      </div>
      {forget ? (
        <span className="autologin-actions">
          <span className="meta">Forget it?</span>
          <button
            className="btn btn-danger"
            disabled={busy !== null}
            onClick={() => {
              setForget(false);
              void run("forget", () => forgetAutologin(provider.id, a.id));
            }}
          >
            Forget
          </button>
          <button className="btn" onClick={() => setForget(false)} autoFocus>
            Keep
          </button>
        </span>
      ) : (
        <span className="autologin-actions">
          {wrong ? (
            <button className="btn" onClick={onOpen}>
              Update
            </button>
          ) : (
            <>
              {al.enabled && (
                <button
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => void run("try", () => tryAutologin(provider.id, a.id))}
                >
                  {busy === "try" ? "Trying…" : "Try now"}
                </button>
              )}
              <button
                className="btn"
                disabled={busy !== null}
                onClick={() =>
                  void run("toggle", () => setAutologinEnabled(provider.id, a.id, !al.enabled))
                }
              >
                {al.enabled ? "Turn off" : "Turn on"}
              </button>
            </>
          )}
          <button className="btn" disabled={busy !== null} onClick={() => setForget(true)}>
            Forget
          </button>
        </span>
      )}
      {err && (
        <p className="setup-row-msg autologin-err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/** The opt-in: what it does, where the password is kept, what it won't do, and the agreement. */
export function KeepSignedInForm({
  provider,
  account: a,
  onSaved,
  onCancel,
  cancelLabel = "Cancel",
}: {
  provider: WebProvider;
  account: WebAccount;
  onSaved: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  const host = siteHost(provider.url) || provider.name;
  const pw = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState(a.autologin?.username ?? a.email ?? "");
  const [hasPw, setHasPw] = useState(false);
  const [agree, setAgree] = useState(false); // never preselected
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = `al-${provider.id}-${a.id}`;
  const ready = agree && username.trim() !== "" && hasPw && !busy;

  const save = async () => {
    const field = pw.current;
    if (!ready || !field) return;
    setBusy(true);
    setErr(null);
    const r = await saveAutologin(provider.id, a.id, username.trim(), field.value);
    setBusy(false);
    if (!r.ok) {
      // Keep what they typed so they can fix the username; the router said why in words.
      setErr(r.detail);
      return;
    }
    field.value = "";
    setHasPw(false);
    onSaved();
  };

  return (
    <form
      className="autologin-form"
      method="post" // never a GET: nothing typed here can end up in a URL
      autoComplete="on"
      aria-labelledby={`${id}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h4 id={`${id}-title`} className="autologin-title">
        Keep {accountName(a.id)} signed in
      </h4>
      <p className="autologin-lead">
        If {provider.name} signs this account out, Provenance signs it back in by itself with the
        sign-in you save here.
      </p>
      <ul className="autologin-terms">
        <li>
          The password is kept in this Mac's keychain, never in Provenance's files, and goes nowhere
          but {host}'s own sign-in page.
        </li>
        <li>
          When the site wants a code, a captcha or anything unusual, Provenance stops and asks you.
        </li>
      </ul>
      <label className="setup-key-field">
        <span className="meta">Email or username</span>
        <input
          className="setup-input autologin-input"
          name="username"
          type="text"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus={!username}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label className="setup-key-field">
        <span className="meta">Password</span>
        <input
          ref={pw}
          className="setup-input autologin-input"
          name="password"
          type="password"
          autoComplete="current-password"
          spellCheck={false}
          autoFocus={!!username}
          onInput={(e) => setHasPw(e.currentTarget.value !== "")}
        />
      </label>
      <label className="autologin-agree">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>I agree that Provenance signs this account back in by itself</span>
      </label>
      {err && (
        <p className="setup-row-msg" role="alert">
          {err}
        </p>
      )}
      <span className="setup-key-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="submit" className="btn-primary" disabled={!ready}>
          {busy ? "Saving…" : "Save"}
        </button>
      </span>
    </form>
  );
}

/**
 * Right after a manual sign-in: "Keep this account signed in?", optional and skippable (Done
 * skips it), with nothing preselected.
 */
export function KeepSignedInOffer({
  provider,
  account: a,
  onChanged,
}: {
  provider: WebProvider;
  account: WebAccount;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const al = a.autologin;
  if (!al?.supported || (al.saved && !saved)) return null;
  if (saved)
    return (
      <p className="keep-offer-done" role="status">
        <Status cls="dot-ok" text={`Saved sign-in for ${al.username ?? "this account"}`} />
      </p>
    );
  if (open)
    return (
      <div className="keep-offer keep-offer-open">
        <KeepSignedInForm
          provider={provider}
          account={a}
          cancelLabel="Not now"
          onSaved={() => {
            setSaved(true);
            onChanged();
          }}
          onCancel={() => setOpen(false)}
        />
      </div>
    );
  return (
    <div className="keep-offer">
      <span className="keep-offer-text">
        <span className="keep-offer-title">Keep this account signed in?</span>
        <span className="meta">
          If {provider.name} signs it out, Provenance can sign it back in by itself.
        </span>
      </span>
      <button className="btn" onClick={() => setOpen(true)}>
        Save sign-in…
      </button>
    </div>
  );
}
