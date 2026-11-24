// Saved sign-in and automatic re-sign-in, per account:
// - Password login (opt-in): the router keeps the password in this Mac's keychain and, when the
//   site signs the account out, signs it back in by itself, stopping to ask the person whenever
//   the site wants a code, a captcha or anything unusual.
// - Remembered SSO login (Google / Microsoft / Apple): re-signs in via the remembered provider
//   without storing any password.
// API: PUT/PATCH/DELETE /web/accounts/{provider}/{account}/autologin, POST …/autologin/try.
//
// The password lives only in its own <input> (uncontrolled: never React state, never the store)
// until Save reads it into the one PUT body; the field is emptied right after. It is never shown
// again, logged, or put in a URL (the form posts nowhere: method="post", submit prevented).

import { useRef, useState } from "react";
import { Status } from "./parts";
import {
  accountName,
  enableSsoAutologin,
  forgetAutologin,
  isSsoLoginMethod,
  loginMethodName,
  queuedRetryText,
  saveAutologin,
  setAutologinEnabled,
  siteHost,
  tryAutologin,
  whenText,
  type Autologin,
  type WebAccount,
  type WebProvider,
} from "./web";

/** The auto sign-in's state in plain words, from running/queued/paused flags and its last try. */
function stateOf(al: Autologin): { cls: string; text: string } {
  const t = al.last_try;
  const wrong = al.paused === "wrong_password" || t?.result === "wrong_password";
  if (al.running) return { cls: "dot-warn", text: "Signing back in…" };
  if (wrong)
    return {
      cls: "dot-err",
      text: "Wrong password: saved sign-in switched off until you update it",
    };
  if (al.paused === "needs_person")
    return {
      cls: "dot-warn",
      text: `Needs you: ${t?.detail ?? al.note ?? "the site asked for something only you can give"}`,
    };
  if (!al.enabled) return { cls: "dot-off", text: "Off" };
  if (al.queued) return { cls: "dot-warn", text: queuedRetryText(al.next_try_in_s) };
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
 * The line under an account row: an offer to keep it signed in, a remembered method note, or
 * the active/saved auto sign-in with Try now / Turn off / Forget. Nothing when the router has
 * no saved sign-in, or the site can't (its reason is shown once by the caller).
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
  if (!al) return null;

  const method = al.method;
  const sso = isSsoLoginMethod(method);
  const otherMethod = method === "github" || method === "other";

  if (open && al.supported)
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

  if (!al.supported) {
    if (otherMethod) {
      const label = loginMethodName(method, al.method_label);
      return (
        <div className="autologin" data-autologin="method" data-autologin-method={method}>
          <div className="autologin-text">
            <span className="autologin-who">Signed in via {label}</span>
            <span className="meta">
              {al.reason ?? `Automatic re-sign-in isn't available for ${label}.`}
            </span>
          </div>
        </div>
      );
    }
    return null;
  }

  const run = async (what: string, fn: () => Promise<{ ok: boolean; detail?: string }>) => {
    setBusy(what);
    setErr(null);
    const r = await fn();
    setBusy(null);
    if (!r.ok) setErr(r.detail ?? "That didn't work.");
    onChanged();
  };

  if (al.saved || sso) {
    const st = stateOf(al);
    const wrong = al.paused === "wrong_password" || al.last_try?.result === "wrong_password";
    const who = al.username ?? a.email;
    const isSsoCard = !al.saved && sso;
    const ssoName = isSsoCard ? loginMethodName(method, al.method_label) : null;
    const dataState = wrong
      ? "wrong_password"
      : al.running
        ? "running"
        : al.queued
          ? "queued"
          : al.enabled
            ? "on"
            : "off";
    return (
      <div
        className="autologin"
        data-autologin={dataState}
        data-autologin-method={method ?? undefined}
      >
        <div className="autologin-text">
          <span className="autologin-who">
            {isSsoCard ? (
              <>Auto sign-in via {ssoName}</>
            ) : (
              <>
                Saved sign-in
                {who ? (
                  <>
                    {" "}
                    for <bdi>{who}</bdi>
                  </>
                ) : null}
              </>
            )}
          </span>
          <span className="autologin-status">
            <Status cls={st.cls} text={st.text} />
            {isSsoCard && <span className="meta">No password stored</span>}
            {al.attempts_today > 0 && (
              <span className="meta">
                {al.attempts_today}&nbsp;attempt{al.attempts_today === 1 ? "" : "s"}&nbsp;today
              </span>
            )}
            {al.note && !st.text.includes(al.note) && <span className="meta">{al.note}</span>}
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
            {wrong && !isSsoCard ? (
              <button className="btn" onClick={onOpen}>
                Update
              </button>
            ) : (
              <>
                {al.enabled && (
                  <button
                    className="btn"
                    disabled={busy !== null || al.running}
                    onClick={() => void run("try", () => tryAutologin(provider.id, a.id))}
                  >
                    {busy === "try" || al.running ? "Trying…" : "Try now"}
                  </button>
                )}
                <button
                  className="btn"
                  disabled={busy !== null || al.running}
                  onClick={() =>
                    void run("toggle", () =>
                      isSsoCard && !al.enabled
                        ? enableSsoAutologin(provider.id, a.id, method)
                        : setAutologinEnabled(provider.id, a.id, !al.enabled),
                    )
                  }
                >
                  {al.enabled ? "Turn off" : "Turn on"}
                </button>
              </>
            )}
            <button
              className="btn"
              disabled={busy !== null || al.running}
              onClick={() => setForget(true)}
            >
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

  // Worth offering once the account has been signed in here (signed out counts: that's when
  // it helps); before its first sign-in there is nothing to keep.
  if (a.signed_in === null && !method && !al.needs_credentials) return null;

  if (method === "password" || al.needs_credentials) {
    return (
      <div
        className="autologin"
        data-autologin="needs_credentials"
        data-autologin-method="password"
      >
        <div className="autologin-text">
          <span className="autologin-who">Signed in with email &amp; password</span>
          <span className="meta">
            Provenance doesn't store your login without asking. Give Provenance your email and
            password if you want automatic re-sign-in.
          </span>
        </div>
        <span className="autologin-actions">
          <button className="btn" onClick={onOpen}>
            Save sign-in…
          </button>
        </span>
      </div>
    );
  }

  if (otherMethod) {
    const label = loginMethodName(method, al.method_label);
    return (
      <div className="autologin" data-autologin="method" data-autologin-method={method}>
        <div className="autologin-text">
          <span className="autologin-who">Signed in via {label}</span>
          <span className="meta">
            Automatic re-sign-in isn't available for {label}. If {provider.name} also accepts email
            &amp; password, you can save one.
          </span>
        </div>
        <span className="autologin-actions">
          <button className="btn" onClick={onOpen}>
            Save password…
          </button>
        </span>
      </div>
    );
  }

  return (
    <button className="setup-add autologin-offer" onClick={onOpen}>
      Keep signed in…
    </button>
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
  const needsCreds =
    !a.autologin?.saved && (a.autologin?.method === "password" || a.autologin?.needs_credentials);

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
        {needsCreds && "Provenance doesn't store your login without asking. "}
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
 * Right after a manual sign-in: reassures the person when SSO auto sign-in is active, offers
 * turning SSO back on without a password, or offers the explicit opt-in password form.
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const al = a.autologin;
  if (!al) return null;

  const method = al.method ?? (a.login.state === "signed_in" ? a.login.method : null);
  const sso = isSsoLoginMethod(method);
  const otherMethod = method === "github" || method === "other";

  if (al.supported && sso && !al.saved) {
    const label = loginMethodName(method, al.method_label);
    if (al.enabled) {
      return (
        <div className="keep-offer keep-offer-sso" data-autologin-method={method} role="status">
          <span className="keep-offer-text">
            <span className="keep-offer-title">
              <Status cls="dot-ok" text={`Auto sign-in via ${label}`} />
            </span>
            <span className="meta">
              Provenance remembered your {label} sign-in and will automatically sign back in if{" "}
              {provider.name} signs you out. No password is stored.
            </span>
          </span>
        </div>
      );
    }
    const turnOn = async () => {
      setBusy(true);
      setErr(null);
      const r = await enableSsoAutologin(provider.id, a.id, method);
      setBusy(false);
      if (!r.ok) {
        setErr(r.detail);
        return;
      }
      onChanged();
    };
    return (
      <div className="keep-offer" data-autologin-method={method}>
        <span className="keep-offer-text">
          <span className="keep-offer-title">Keep this account signed in via {label}?</span>
          <span className="meta">
            Provenance remembered your {label} sign-in and can automatically sign back in if{" "}
            {provider.name} signs you out. No password is stored.
          </span>
          {err && (
            <span className="setup-row-msg" role="alert">
              {err}
            </span>
          )}
        </span>
        <button className="btn" disabled={busy} onClick={() => void turnOn()}>
          {busy ? "Turning on…" : "Turn on"}
        </button>
      </div>
    );
  }

  if (!al.supported) {
    if (otherMethod) {
      const label = loginMethodName(method, al.method_label);
      return (
        <div className="keep-offer" data-autologin-method={method}>
          <span className="keep-offer-text">
            <span className="keep-offer-title">Signed in via {label}</span>
            <span className="meta">
              {al.reason ?? `Automatic re-sign-in isn't available for ${label}.`}
            </span>
          </span>
        </div>
      );
    }
    return null;
  }

  if (al.saved && !saved) return null;
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
  if (otherMethod) {
    const label = loginMethodName(method, al.method_label);
    return (
      <div className="keep-offer" data-autologin-method={method}>
        <span className="keep-offer-text">
          <span className="keep-offer-title">Signed in via {label}</span>
          <span className="meta">
            Automatic re-sign-in isn't available for {label}. If {provider.name} also accepts email
            &amp; password, you can save one.
          </span>
        </span>
        <button className="btn" onClick={() => setOpen(true)}>
          Save password…
        </button>
      </div>
    );
  }
  if (method === "password" || al.needs_credentials) {
    return (
      <div className="keep-offer" data-autologin-method="password">
        <span className="keep-offer-text">
          <span className="keep-offer-title">Keep this account signed in?</span>
          <span className="meta">
            Provenance remembers you signed in with email &amp; password, and doesn't store your
            login without asking. Give Provenance your email and password if you want automatic
            re-sign-in.
          </span>
        </span>
        <button className="btn" onClick={() => setOpen(true)}>
          Save sign-in…
        </button>
      </div>
    );
  }
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
