// Steps 3 and 4 of Models & accounts: the sign-in window is open (or the browser is being
// set up first, or the router is checking the site), then ready.

import { useState } from "react";
import { TierGlyph } from "../components/TierBadge";
import { tierOf } from "../theme/tiers";
import { PaidPlanConfirm } from "./PaidPlan";
import { browserStageText } from "./parts";
import { KeepSignedInOffer } from "./SavedSignIn";
import { SetupArt, type ArtKind } from "./SetupArt";
import {
  accountName,
  modelOn,
  showLogin,
  siteHost,
  type BrowserStatus,
  type Login,
  type WebProvider,
} from "./web";

export function SignInStep({
  provider,
  account,
  login,
  browser,
  busy,
  switching,
  onCancel,
  onRetry,
  onBack,
}: {
  provider: WebProvider;
  account: string;
  login: Login | null;
  browser: BrowserStatus;
  busy: string | null;
  /** Putting another account in this slot (away from a paid plan): sign out there first. */
  switching?: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onBack: () => void;
}) {
  const [hint, setHint] = useState<string | null>(null);
  const [showing, setShowing] = useState(false);
  const host = siteHost(provider.url) || provider.name;
  const state = login?.state ?? "open";
  let art: ArtKind = "open";
  let title: string;
  let text: React.ReactNode;
  let actions: React.ReactNode;
  const cancelBtn = (
    <button className="btn setup-cta" onClick={onCancel} disabled={busy === "cancel"}>
      {busy === "cancel" ? "Cancelling…" : "Cancel"}
    </button>
  );
  const show = async () => {
    setShowing(true);
    const r = await showLogin(provider.id, account);
    setShowing(false);
    setHint(
      r.ok && r.value.shown
        ? null
        : "Couldn't bring it forward. Look for the sign-in browser in the Dock or with ⌘-Tab.",
    );
  };
  if (state === "preparing") {
    art = "download";
    title = browser.preparing ? browserStageText(browser).replace(/…$/, "") : "Getting ready";
    text =
      login?.reason && !browser.preparing
        ? login.reason
        : "This happens once. The sign-in window opens as soon as it's done.";
    actions = cancelBtn;
  } else if (state === "verifying") {
    art = "verifying";
    title = `Checking ${provider.name}`;
    text = "The sign-in window closed. Provenance is making sure it can use the account.";
    actions = cancelBtn;
  } else if (state === "failed") {
    art = "failed";
    title = `Couldn't sign in to ${provider.name}`;
    text = login?.reason ?? "The router didn't say why.";
    actions = (
      <>
        <button className="btn-primary setup-cta" onClick={onRetry} disabled={busy !== null}>
          {busy?.startsWith("signin:") ? "Opening…" : "Try again"}
        </button>
        <button className="btn setup-cta" onClick={onBack}>
          Back
        </button>
      </>
    );
  } else {
    title = `Sign in to ${provider.name} in the new window`;
    text = switching ? (
      <>
        A browser window opened beside Provenance on {host}. Sign out of the account that's there,
        then sign in with the other one; it closes by itself when you're done.
      </>
    ) : (
      <>
        A browser window opened beside Provenance on {host}. Sign in there as usual; it closes by
        itself when you're done.
      </>
    );
    actions = (
      <>
        <button className="btn setup-cta" onClick={() => void show()} disabled={showing}>
          Show the window
        </button>
        {cancelBtn}
      </>
    );
  }
  const pct =
    state === "preparing" && browser.progress !== null ? Math.round(browser.progress * 100) : null;
  return (
    <div className="setup-step setup-center" data-login={state}>
      <SetupArt kind={art} host={host} />
      <h3 className="setup-title" aria-live="polite">
        {title}
      </h3>
      <p className={`setup-text ${state === "failed" ? "bad" : ""}`}>{text}</p>
      {state === "preparing" && (
        <span
          className="setup-meter wide"
          role="progressbar"
          aria-label="Sign-in browser"
          aria-valuenow={pct ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          data-empty={pct === null || undefined}
        >
          <span style={{ width: `${pct ?? 0}%` }} />
        </span>
      )}
      {state === "open" && (
        <p className="meta setup-hint" role={hint ? "status" : undefined}>
          {hint ?? "Can't see it? Show the window brings it to the front."}
        </p>
      )}
      <div className="setup-actions">{actions}</div>
      <p className="meta setup-which">
        {provider.name} · {accountName(account)}
      </p>
    </div>
  );
}

export function ReadyStep({
  provider,
  account,
  onDone,
  onAnother,
  onDifferent,
  onReload,
}: {
  provider: WebProvider;
  account: string;
  onDone: () => void;
  onAnother: () => void;
  /** Sign in to this slot again with another account (a paid plan's way out). */
  onDifferent: () => void;
  onReload: () => void;
}) {
  const models = provider.models.filter((m) => modelOn(m, account));
  const acc = provider.accounts.find((a) => a.id === account);
  const email = acc?.email;
  // A paid plan: connected, but not used until the person chooses (setup/PaidPlan.tsx).
  if (acc?.needs_confirmation)
    return (
      <div className="setup-step setup-center" data-login="signed_in" data-paid-plan>
        <SetupArt kind="ready" host={siteHost(provider.url)} />
        <PaidPlanConfirm
          provider={provider}
          account={acc}
          centered
          onDifferent={onDifferent}
          onConfirmed={onReload}
        />
        <p className="meta setup-which">
          {email ? `${email} · ` : ""}
          {provider.name} · {accountName(account)}
        </p>
      </div>
    );
  return (
    <div className="setup-step setup-center" data-login="signed_in">
      <SetupArt kind="ready" host={siteHost(provider.url)} />
      <h3 className="setup-title" aria-live="polite">
        {provider.name} is ready
      </h3>
      <p className="setup-text">
        {email ? `Signed in as ${email}. ` : ""}
        {models.length
          ? provider.enabled
            ? "Its models are in the tier picker now:"
            : `Turn on Use ${provider.name} to put its models in the tier picker:`
          : `${accountName(account)} is signed in.`}
      </p>
      {models.length > 0 && (
        <ul className="setup-models setup-models-ready">
          {models.map((m) => (
            <li key={m.id} data-tier={tierOf(m.tier)?.id}>
              <TierGlyph tier={tierOf(m.tier)?.id ?? null} size={13} />
              <span className="setup-model-name">{m.label}</span>
              <span className="meta">{m.tier}</span>
            </li>
          ))}
        </ul>
      )}
      {acc && <KeepSignedInOffer provider={provider} account={acc} onChanged={onReload} />}
      <div className="setup-actions">
        <button className="btn-primary setup-cta" onClick={onDone} autoFocus>
          Done
        </button>
        <button className="btn setup-cta" onClick={onAnother}>
          Set up another site
        </button>
      </div>
    </div>
  );
}
