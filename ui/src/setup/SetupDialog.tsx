// "Models & accounts": signing in to the chat sites provenance-core drives (ChatGPT, Qwen,
// Gemini), all inside the app. Four steps on one rail: Site -> Account -> Sign in -> Ready.
// The router opens one visible browser window beside the app for the sign-in itself,
// closes it when it sees the sign-in finish, then checks the site in its background
// browser; this screen polls it about once a second meanwhile. API: setup/web.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { appShell } from "../app-shell";
import { TierGlyph } from "../components/TierBadge";
import { refreshSources } from "../store/actions";
import { tierOf } from "../theme/tiers";
import { closeSetup, useSetupOpen } from "./open";
import { SetupArt, type ArtKind } from "./SetupArt";
import {
  accountName,
  addAccount,
  cancelLogin,
  checkedText,
  getAccounts,
  getLogin,
  loginActive,
  modelOn,
  nextAccountId,
  prepareBrowser,
  removeAccount,
  siteHost,
  startLogin,
  type BrowserStatus,
  type Login,
  type Unavailable,
  type WebAccount,
  type WebAccounts,
  type WebModel,
  type WebProvider,
} from "./web";

type View =
  | { step: "sites" }
  | { step: "site"; provider: string }
  | { step: "signin"; provider: string; account: string }
  | { step: "ready"; provider: string; account: string };

const STEPS = ["Site", "Account", "Sign in", "Ready"] as const;
const STEP_INDEX: Record<View["step"], number> = { sites: 0, site: 1, signin: 2, ready: 3 };

/** A message under one account row (a 409, a failed add or remove). */
interface RowMsg {
  account: string;
  text: string;
}

export function SetupDialog() {
  const { open, provider: startProvider, firstRun } = useSetupOpen();
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<WebAccounts | null>(null);
  const [unavailable, setUnavailable] = useState<Unavailable | null>(null);
  const [view, setView] = useState<View>({ step: "sites" });
  const [login, setLogin] = useState<Login | null>(null);
  const [rowMsg, setRowMsg] = useState<RowMsg | null>(null);
  const [closedNote, setClosedNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const reload = useCallback(async () => {
    const r = await getAccounts();
    if (r.ok) {
      setData(r.value);
      setUnavailable(null);
    } else setUnavailable(r.why);
    return r;
  }, []);

  // Open / close the native dialog with the store; each opening starts fresh.
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setView(startProvider ? { step: "site", provider: startProvider } : { step: "sites" });
      setLogin(null);
      setRowMsg(null);
      setClosedNote(null);
      d.showModal();
      // Focus the panel, not the first button: no focus ring on open, Tab still starts at the top.
      d.querySelector<HTMLElement>(".setup-panel")?.focus();
      void reload();
    } else if (!open && d.open) d.close();
  }, [open, startProvider, reload]);

  // Keep the accounts fresh while open: every second while something moves (the browser
  // downloading, a sign-in), else every 4 s (also notices the router coming back).
  const moving = data?.browser.preparing || view.step === "signin";
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => void reload(), moving ? 1000 : 4000);
    return () => window.clearInterval(t);
  }, [open, moving, reload]);

  // Follow the sign-in once a second until it lands.
  const seenActive = useRef(false);
  useEffect(() => {
    if (!open || view.step !== "signin") return;
    const { provider, account } = view;
    let stop = false;
    const tick = async () => {
      const r = await getLogin(provider, account);
      if (stop) return;
      if (!r.ok) {
        if (r.down) setUnavailable("down");
        return;
      }
      const s = r.value.state;
      if (loginActive(s)) seenActive.current = true;
      if (s === "signed_in") {
        setLogin(r.value);
        setView({ step: "ready", provider, account });
        void reload();
        void refreshSources(); // the tier picker lists the site's models now
        return;
      }
      if (s === "idle" && seenActive.current) {
        // Closed from elsewhere (the window shut before the sign-in finished).
        setClosedNote("The sign-in window closed before the sign-in finished.");
        setRowMsg(null);
        setView({ step: "site", provider });
        return;
      }
      if (s !== "idle") setLogin(r.value);
    };
    void tick();
    const t = window.setInterval(() => void tick(), 1000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [open, view, reload]);

  const provider =
    view.step === "sites" ? null : (data?.providers.find((p) => p.id === view.provider) ?? null);

  const signIn = async (p: string, a: string) => {
    setBusy(`signin:${a}`);
    setRowMsg(null);
    setClosedNote(null);
    const r = await startLogin(p, a);
    setBusy(null);
    if (!r.ok) {
      if (r.down) setUnavailable("down");
      else setRowMsg({ account: a, text: r.detail });
      return;
    }
    seenActive.current = loginActive(r.value.state);
    setLogin(r.value);
    setView({ step: "signin", provider: p, account: a });
  };

  const cancel = async (p: string, a: string, to: View) => {
    setBusy("cancel");
    await cancelLogin(p, a);
    setBusy(null);
    setLogin(null);
    setView(to);
    void reload();
  };

  const close = () => {
    // Closing mid sign-in cancels it, so no window is left open beside the app.
    if (view.step === "signin" && login && loginActive(login.state))
      void cancelLogin(view.provider, view.account);
    closeSetup();
  };

  const back = () => {
    if (view.step === "site") setView({ step: "sites" });
    else if (view.step === "signin") {
      if (login && loginActive(login.state))
        void cancel(view.provider, view.account, { step: "site", provider: view.provider });
      else setView({ step: "site", provider: view.provider });
    } else if (view.step === "ready") setView({ step: "site", provider: view.provider });
    setRowMsg(null);
  };

  const startRouter = () => {
    if (!appShell) return void reload();
    setStarting(true);
    void appShell
      .startRouter()
      .then(() => reload())
      .finally(() => setStarting(false));
  };

  const stepIndex = STEP_INDEX[view.step];
  let body: React.ReactNode;
  if (unavailable === "down") {
    body = (
      <PageState
        title="Can't reach provenance-core"
        text="Sign-ins go through provenance-core, and it isn't answering."
        action={
          <button className="btn-primary setup-cta" onClick={startRouter} disabled={starting}>
            {starting ? "Starting…" : appShell ? "Start it" : "Try again"}
          </button>
        }
      />
    );
  } else if (unavailable === "unsupported") {
    body = (
      <PageState
        title="This provenance-core can't sign in from the app"
        text="Update provenance-core, then open this again."
        action={
          <button className="btn setup-cta" onClick={() => void reload()}>
            Try again
          </button>
        }
      />
    );
  } else if (!data) {
    body = <div className="setup-loading" aria-busy="true" />;
  } else if (view.step === "sites") {
    body = (
      <SitesStep
        data={data}
        firstRun={firstRun}
        onPick={(id) => {
          setRowMsg(null);
          setClosedNote(null);
          setView({ step: "site", provider: id });
        }}
        onPrepare={() => void prepareBrowser().then(() => reload())}
      />
    );
  } else if (!provider) {
    body = (
      <PageState
        title="That site isn't set up in provenance-core"
        text="Pick another site."
        action={
          <button className="btn setup-cta" onClick={() => setView({ step: "sites" })}>
            All sites
          </button>
        }
      />
    );
  } else if (view.step === "site") {
    body = (
      <SiteStep
        provider={provider}
        browser={data.browser}
        busy={busy}
        rowMsg={rowMsg}
        note={closedNote}
        onSignIn={(a) => void signIn(provider.id, a)}
        onAdd={async () => {
          const id = nextAccountId(provider.accounts.map((a) => a.id));
          setBusy("add");
          const r = await addAccount(id);
          setBusy(null);
          if (!r.ok) setRowMsg({ account: "", text: r.detail });
          else setRowMsg(null);
          await reload();
        }}
        onRemove={async (a) => {
          setBusy(`remove:${a}`);
          const r = await removeAccount(a);
          setBusy(null);
          setRowMsg(r.ok ? null : { account: a, text: r.detail });
          await reload();
        }}
        onPrepare={() => void prepareBrowser().then(() => reload())}
      />
    );
  } else if (view.step === "signin") {
    body = (
      <SignInStep
        provider={provider}
        account={view.account}
        login={login}
        browser={data.browser}
        busy={busy}
        onCancel={() =>
          void cancel(provider.id, view.account, { step: "site", provider: provider.id })
        }
        onRetry={() => void signIn(provider.id, view.account)}
        onBack={back}
      />
    );
  } else {
    body = (
      <ReadyStep
        provider={provider}
        account={view.account}
        onDone={close}
        onAnother={() => setView({ step: "sites" })}
      />
    );
  }

  const pageState = unavailable !== null;
  return (
    <dialog
      ref={ref}
      className="setup-dialog"
      aria-labelledby="setup-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div className="setup-panel" data-step={view.step} tabIndex={-1}>
        <header className="setup-head">
          {view.step !== "sites" && !pageState ? (
            <button className="icon-btn setup-back" aria-label="Back" title="Back" onClick={back}>
              <IconBack />
            </button>
          ) : (
            <span className="setup-back-space" />
          )}
          <h2 id="setup-title">Models &amp; accounts</h2>
          <button className="icon-btn setup-close" aria-label="Close" title="Close" onClick={close}>
            <IconClose />
          </button>
        </header>
        <ol className="setup-rail" aria-label="Steps" data-hidden={pageState || undefined}>
          {STEPS.map((s, i) => (
            <li
              key={s}
              className={i < stepIndex ? "done" : i === stepIndex ? "current" : ""}
              aria-current={i === stepIndex ? "step" : undefined}
            >
              <span className="setup-rail-num">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <div className="setup-body">{body}</div>
      </div>
    </dialog>
  );
}

// ---- step 1: which site -----------------------------------------------------------

function SitesStep({
  data,
  firstRun,
  onPick,
  onPrepare,
}: {
  data: WebAccounts;
  firstRun: boolean;
  onPick: (id: string) => void;
  onPrepare: () => void;
}) {
  return (
    <div className="setup-step">
      <p className="setup-lead">
        {firstRun
          ? "Nothing is signed in yet. Sign in to a chat site to use its models in Provenance."
          : "Sign in to a chat site to use its models in Provenance."}
      </p>
      <BrowserStrip browser={data.browser} onPrepare={onPrepare} />
      <ul className="setup-sites">
        {data.providers.map((p) => (
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
    </div>
  );
}

/** The site's state in one status line: ready on N accounts, signing in, blocked, not signed in. */
function SiteStatus({ provider }: { provider: WebProvider }) {
  const ok = provider.accounts.filter((a) => a.signedIn === true && !a.blocked);
  const blocked = provider.accounts.filter((a) => a.signedIn === true && a.blocked);
  let cls = "";
  let text = "Not signed in";
  if (provider.accounts.some((a) => loginActive(a.login.state))) {
    cls = "dot-busy";
    text = "Signing in…";
  } else if (ok.length) {
    cls = "dot-ok";
    text = ok.length === 1 ? "Ready" : `Ready on ${ok.length} accounts`;
  } else if (blocked.length) {
    cls = "dot-warn";
    text = "Blocked";
  }
  return (
    <span className="setup-status">
      <span className={`dot ${cls || "dot-off"}`} />
      {text}
    </span>
  );
}

/** The browser sign-ins need, while it isn't ready: download it, its progress, or its error. */
function BrowserStrip({ browser, onPrepare }: { browser: BrowserStatus; onPrepare: () => void }) {
  if (browser.ready) return null;
  if (browser.preparing) {
    const pct = browser.progress === null ? null : Math.round(browser.progress * 100);
    return (
      <div className="setup-browser" role="status">
        <span className="setup-browser-text">
          Downloading the sign-in browser{pct === null ? "…" : ` · ${pct}%`}
        </span>
        {pct !== null && (
          <span className="setup-meter" aria-hidden>
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="setup-browser" role={browser.error ? "alert" : undefined}>
      <span className="setup-browser-text">
        {browser.error
          ? `The browser download stopped: ${browser.error}`
          : "Sign-ins need Provenance's own browser, a one-time download of about 200 MB."}
      </span>
      <button className="btn-primary" onClick={onPrepare}>
        {browser.error ? "Try again" : "Download"}
      </button>
    </div>
  );
}

// ---- step 2: which account ----------------------------------------------------------

function SiteStep({
  provider,
  browser,
  busy,
  rowMsg,
  note,
  onSignIn,
  onAdd,
  onRemove,
  onPrepare,
}: {
  provider: WebProvider;
  browser: BrowserStatus;
  busy: string | null;
  rowMsg: RowMsg | null;
  note: string | null;
  onSignIn: (account: string) => void;
  onAdd: () => void;
  onRemove: (account: string) => void;
  onPrepare: () => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  // One primary action: Sign in on the first account that needs it.
  const primary = provider.accounts.find((a) => a.signedIn !== true)?.id ?? null;
  return (
    <div className="setup-step">
      <div className="setup-site-head">
        <Monogram name={provider.name} />
        <div>
          <h3>{provider.name}</h3>
          {provider.url && <span className="meta">{siteHost(provider.url)}</span>}
        </div>
      </div>

      <h4 className="setup-label">Models</h4>
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

      <h4 className="setup-label">Accounts</h4>
      <BrowserStrip browser={browser} onPrepare={onPrepare} />
      {note && <p className="setup-note">{note}</p>}
      <ul className="setup-accounts">
        {provider.accounts.map((a) => (
          <li key={a.id} data-account={a.id}>
            <div className="setup-account">
              <div className="setup-account-text">
                <span className="setup-account-name">{accountName(a.id)}</span>
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
                  <button className="btn" onClick={() => setConfirm(null)}>
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
                  <button
                    className={a.id === primary ? "btn-primary" : "btn"}
                    disabled={busy !== null && busy.startsWith("signin:")}
                    onClick={() => onSignIn(a.id)}
                  >
                    {busy === `signin:${a.id}`
                      ? "Opening…"
                      : a.signedIn === true
                        ? "Sign in again"
                        : "Sign in"}
                  </button>
                </span>
              )}
            </div>
            {rowMsg?.account === a.id && (
              <p className="setup-row-msg" role="alert">
                {rowMsg.text}
              </p>
            )}
          </li>
        ))}
      </ul>
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

function AccountStatus({ account: a }: { account: WebAccount }) {
  let cls = "dot-off";
  let text: string;
  if (loginActive(a.login.state)) {
    cls = "dot-busy";
    text = "Signing in…";
  } else if (a.signedIn === true && a.blocked) {
    cls = "dot-warn";
    text = a.reason ? `Blocked: ${a.reason}` : "Blocked";
  } else if (a.signedIn === true) {
    cls = "dot-ok";
    text = "Signed in";
  } else if (a.signedIn === false) {
    cls = "dot-err";
    text = "Signed out";
  } else text = "Not signed in yet";
  const facts = [a.checkedAt !== null ? checkedText(a.checkedAt) : null].filter(Boolean);
  const showUsage = a.signedIn === true && a.dailyCap !== null;
  return (
    <span className="setup-account-status">
      <span className="setup-status">
        <span className={`dot ${cls}`} />
        {text}
      </span>
      {facts.map((f) => (
        <span key={f} className="meta">
          {f}
        </span>
      ))}
      {showUsage && (
        <span className="meta setup-usage" title="Requests today against the daily cap">
          <span className="setup-meter small" aria-hidden>
            <span style={{ width: `${Math.min(100, (a.today / a.dailyCap!) * 100)}%` }} />
          </span>
          {a.today} of {a.dailyCap}&nbsp;today
        </span>
      )}
    </span>
  );
}

// ---- step 3: signing in -------------------------------------------------------------

function SignInStep({
  provider,
  account,
  login,
  browser,
  busy,
  onCancel,
  onRetry,
  onBack,
}: {
  provider: WebProvider;
  account: string;
  login: Login | null;
  browser: BrowserStatus;
  busy: string | null;
  onCancel: () => void;
  onRetry: () => void;
  onBack: () => void;
}) {
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
  if (state === "preparing") {
    art = "download";
    title = "Getting the sign-in browser ready";
    text = "A one-time download of about 200 MB. The sign-in window opens when it's done.";
    actions = cancelBtn;
  } else if (state === "verifying") {
    art = "verifying";
    title = `Checking ${provider.name}`;
    text = "The window closed by itself. Provenance is making sure it can use the account.";
    actions = cancelBtn;
  } else if (state === "failed") {
    art = "failed";
    title = `Couldn't sign in to ${provider.name}`;
    text = login?.reason ?? "provenance-core didn't say why.";
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
    text = (
      <>
        A browser window opened beside Provenance on {host}. Sign in there as usual; it closes by
        itself when you're done.
      </>
    );
    actions = cancelBtn;
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
        <span className="setup-meter wide" aria-hidden data-empty={pct === null || undefined}>
          <span style={{ width: `${pct ?? 0}%` }} />
        </span>
      )}
      {state === "open" && (
        <p className="meta setup-hint">Can't see it? It may be behind this window.</p>
      )}
      <div className="setup-actions">{actions}</div>
      <p className="meta setup-which">
        {provider.name} · {accountName(account)}
      </p>
    </div>
  );
}

// ---- step 4: ready ------------------------------------------------------------------

function ReadyStep({
  provider,
  account,
  onDone,
  onAnother,
}: {
  provider: WebProvider;
  account: string;
  onDone: () => void;
  onAnother: () => void;
}) {
  const models = provider.models.filter((m) => modelOn(m, account));
  return (
    <div className="setup-step setup-center" data-login="signed_in">
      <SetupArt kind="ready" host={siteHost(provider.url)} />
      <h3 className="setup-title" aria-live="polite">
        {provider.name} is ready
      </h3>
      <p className="setup-text">
        {models.length
          ? "Its models are in the tier picker now:"
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

// ---- shared bits --------------------------------------------------------------------

function PageState({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action: React.ReactNode;
}) {
  return (
    <div className="setup-step setup-center setup-page-state" role="alert">
      <h3 className="setup-title">{title}</h3>
      <p className="setup-text">{text}</p>
      <div className="setup-actions">{action}</div>
    </div>
  );
}

/** "GPT-6 Luna · solstice", one per model, each kept whole. */
function ModelLine({ models }: { models: WebModel[] }) {
  return (
    <span className="setup-model-line">
      {models.map((m) => (
        <span key={m.id} className="setup-model-chip meta" data-tier={tierOf(m.tier)?.id}>
          <TierGlyph tier={tierOf(m.tier)?.id ?? null} size={10} />
          {m.label} · {m.tier}
        </span>
      ))}
    </span>
  );
}

function Monogram({ name }: { name: string }) {
  return (
    <span className="setup-mono" aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const ic = {
  "width": 14,
  "height": 14,
  "viewBox": "0 0 24 24",
  "fill": "none",
  "stroke": "currentColor",
  "strokeWidth": 2,
  "strokeLinecap": "round" as const,
  "strokeLinejoin": "round" as const,
  "aria-hidden": true,
};
const IconBack = () => (
  <svg {...ic}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
);
const IconNext = () => (
  <svg {...ic} width={12} height={12} className="setup-next">
    <path d="M9 18l6-6-6-6" />
  </svg>
);
const IconClose = () => (
  <svg {...ic}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const IconTrash = () => (
  <svg {...ic} width={13} height={13} strokeWidth={1.8}>
    <path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13" />
  </svg>
);
const IconPlusSmall = () => (
  <svg {...ic} width={12} height={12}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/** For the sidebar foot and the app menu's entry point. */
export const IconAccounts = ({ size = 13 }: { size?: number }) => (
  <svg {...ic} width={size} height={size}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5" />
    <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.4.9 2.3 2.6 2.5 5.2" />
  </svg>
);
