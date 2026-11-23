// "Models & accounts": signing in to the chat sites provenance-core drives (ChatGPT, Qwen,
// Gemini), all inside the app. Four steps on one rail: Site -> Account -> Sign in -> Ready,
// plus the token pool's API keys beside them. The router opens one visible browser window
// beside the app for the sign-in itself, closes it when it sees the sign-in finish, then
// checks the site in its background browser; this screen polls it about once a second
// meanwhile. API: setup/web.ts. Steps: SiteSteps.tsx, SignInSteps.tsx, KeysStep.tsx.

import { useCallback, useEffect, useRef, useState } from "react";
import { appShell } from "../app-shell";
import { FallbacksStep } from "../fallback/FallbacksStep";
import { refreshSources } from "../store/actions";
import { KeysStep } from "./KeysStep";
import { closeSetup, useSetupOpen } from "./open";
import { IconBack, IconClose, PageState } from "./parts";
import { ReadyStep, SignInStep } from "./SignInSteps";
import { SiteStep, SitesStep, type RowMsg } from "./SiteSteps";
import {
  addAccount,
  besideThisWindow,
  cancelLogin,
  getAccounts,
  getLogin,
  getPoolHelp,
  getPoolKeys,
  loginActive,
  nextAccountId,
  prepareBrowser,
  removeAccount,
  startLogin,
  type Login,
  type PoolHelpData,
  type PoolProvider,
  type Unavailable,
  type WebAccounts,
} from "./web";

export { IconAccounts } from "./parts"; // the sidebar foot imports it from here

type View =
  | { step: "sites" }
  | { step: "site"; provider: string }
  | { step: "signin"; provider: string; account: string; switching?: boolean }
  | { step: "ready"; provider: string; account: string }
  | { step: "keys" }
  | { step: "fallbacks" };

const STEPS = ["Site", "Account", "Sign in", "Ready"] as const;
const STEP_INDEX: Record<Exclude<View["step"], "keys" | "fallbacks">, number> = {
  sites: 0,
  site: 1,
  signin: 2,
  ready: 3,
};

export function SetupDialog() {
  const { open, provider: startProvider, firstRun, view: startView } = useSetupOpen();
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<WebAccounts | null>(null);
  const [pool, setPool] = useState<PoolProvider[] | null>(null);
  const [help, setHelp] = useState<PoolHelpData | null>(null);
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
  const reloadPool = useCallback(async () => {
    const [r, h] = await Promise.all([getPoolKeys(), getPoolHelp()]);
    setPool(r.ok ? r.value : null); // an older router can't set keys from the app: no pool row
    setHelp(h); // an older router has no instructions: the keys page is as it was
    if (r.ok) void refreshSources(); // a key changes what the tier picker offers
  }, []);

  // Open / close the native dialog with the store; each opening starts fresh.
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setView(
        startView === "keys"
          ? { step: "keys" }
          : startView === "fallbacks"
            ? { step: "fallbacks" }
            : startProvider
              ? { step: "site", provider: startProvider }
              : { step: "sites" },
      );
      setLogin(null);
      setRowMsg(null);
      setClosedNote(null);
      d.showModal();
      void reload();
      void reloadPool();
    } else if (!open && d.open) d.close();
  }, [open, startProvider, startView, reload, reloadPool]);

  // Each step starts with the focus on the panel, not on a button that may be gone: no focus
  // ring on arrival, and Tab starts at the top of the new step.
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>(".setup-panel")?.focus();
  }, [open, view.step]);

  // Keep the accounts fresh while open: every second while something moves (the browser
  // being set up, a sign-in), else every 4 s (also notices the router coming back).
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
        // The accounts first, so Ready opens on what the router now knows of the account (a
        // paid plan asks before it is used) instead of changing under the person.
        stop = true;
        window.clearInterval(t);
        setLogin(r.value);
        await reload();
        setView({ step: "ready", provider, account });
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
    const t = window.setInterval(() => void tick(), 1000);
    void tick();
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [open, view, reload]);

  const provider =
    view.step === "sites" || view.step === "keys" || view.step === "fallbacks"
      ? null
      : (data?.providers.find((p) => p.id === view.provider) ?? null);

  const signIn = async (p: string, a: string, switching = false) => {
    setBusy(`signin:${a}`);
    setRowMsg(null);
    setClosedNote(null);
    const r = await startLogin(p, a, besideThisWindow());
    setBusy(null);
    if (!r.ok) {
      if (r.down) setUnavailable("down");
      else setRowMsg({ account: a, text: r.detail });
      return;
    }
    seenActive.current = loginActive(r.value.state);
    setLogin(r.value);
    setView({ step: "signin", provider: p, account: a, switching });
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
    if (view.step === "site" || view.step === "keys" || view.step === "fallbacks")
      setView({ step: "sites" });
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
      .then(() => Promise.all([reload(), reloadPool()]))
      .finally(() => setStarting(false));
  };

  const prepare = () => void prepareBrowser().then(() => reload());

  let body: React.ReactNode;
  if (view.step === "fallbacks") {
    body = <FallbacksStep />; // the CLIs on this Mac: no router needed
  } else if (unavailable === "down") {
    body = (
      <PageState
        title="The model router isn't answering"
        text="Sign-ins and models go through provenance-core, Provenance's model router, and it isn't answering right now."
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
        title="This router can't set up sign-ins from the app"
        text="The provenance-core Provenance is using is older than this app. Update it, then open this again."
        action={
          <button className="btn setup-cta" onClick={() => void reload()}>
            Try again
          </button>
        }
      />
    );
  } else if (!data) {
    body = <div className="setup-loading" aria-busy="true" aria-label="Loading" />;
  } else if (view.step === "sites") {
    body = (
      <SitesStep
        data={data}
        pool={pool}
        firstRun={firstRun}
        onPick={(id) => {
          setRowMsg(null);
          setClosedNote(null);
          setView({ step: "site", provider: id });
        }}
        onKeys={() => setView({ step: "keys" })}
        onFallbacks={() => setView({ step: "fallbacks" })}
        onPrepare={prepare}
      />
    );
  } else if (view.step === "keys") {
    body = pool ? (
      <KeysStep
        pool={pool}
        help={help}
        accounts={data}
        focus={startView === "keys" ? startProvider : null}
        onChanged={() => void reloadPool()}
        onFallbacks={() => setView({ step: "fallbacks" })}
      />
    ) : (
      <div className="setup-loading" aria-busy="true" aria-label="Loading" />
    );
  } else if (!provider) {
    body = (
      <PageState
        title="That site isn't set up in the router"
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
        onSignIn={(a, switching) => void signIn(provider.id, a, switching)}
        onReload={() => void reload().then(() => void refreshSources())}
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
        onPrepare={prepare}
        onChanged={(p) => {
          setData((d) => d && { ...d, providers: d.providers.map((x) => (x.id === p.id ? p : x)) });
          void refreshSources(); // on / off changes what the tier picker offers
        }}
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
        switching={view.switching}
        onCancel={() =>
          void cancel(provider.id, view.account, { step: "site", provider: provider.id })
        }
        onRetry={() => void signIn(provider.id, view.account, view.switching)}
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
        onDifferent={() => void signIn(provider.id, view.account, true)}
        onReload={() => void reload().then(() => void refreshSources())}
      />
    );
  }

  const pageState = unavailable !== null && view.step !== "fallbacks";
  const aside = view.step === "keys" || view.step === "fallbacks";
  const stepIndex = aside ? -1 : STEP_INDEX[view.step];
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
        {/* The keys and fallbacks pages are beside the four steps, not of them: no rail there. */}
        <ol
          className="setup-rail"
          aria-label="Steps"
          data-hidden={pageState || undefined}
          data-gone={(aside && !pageState) || undefined}
        >
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
