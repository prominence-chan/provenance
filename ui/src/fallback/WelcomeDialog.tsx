// The welcome: what Provenance is -> free models (the sites and the token pool, each row opening
// Models & accounts there and coming back here) -> fallbacks (Claude Code, Codex: health and a
// switch each) -> done. Opens by itself once when nothing is set up (setup/open.ts), and from
// the app menu (Provenance > Welcome…). Closing it at any step skips the rest.

import { useCallback, useEffect, useRef, useState } from "react";
import { HeroSun } from "../components/effects/HeroSun";
import { IconBack, IconClose, IconNext, Monogram, SiteStatus } from "../setup/parts";
import {
  closeWelcome,
  openWelcome,
  useWelcomeOpen,
  welcomeToSetup,
  type WelcomeStep,
} from "../setup/open";
import { PoolStatus } from "../setup/SiteSteps";
import {
  anySignedIn,
  getAccounts,
  getPoolKeys,
  shownProviders,
  type PoolProvider,
  type WebAccounts,
} from "../setup/web";
import { useAppState } from "../store/store";
import { fallbacks } from "./available";
import { FallbacksStep } from "./FallbacksStep";

const STEPS: { id: WelcomeStep; label: string }[] = [
  { id: "intro", label: "Welcome" },
  { id: "models", label: "Models" },
  { id: "fallbacks", label: "Fallbacks" },
  { id: "done", label: "Done" },
];

export function WelcomeDialog() {
  const { open, step: startStep } = useWelcomeOpen();
  const ref = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<WelcomeStep>("intro");
  const [data, setData] = useState<WebAccounts | null>(null);
  const [pool, setPool] = useState<PoolProvider[] | null>(null);
  const [down, setDown] = useState(false);

  const reload = useCallback(async () => {
    const [a, p] = await Promise.all([getAccounts(), getPoolKeys()]);
    setData(a.ok ? a.value : null);
    setDown(!a.ok && a.why === "down");
    setPool(p.ok ? p.value : null);
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setStep(startStep);
      d.showModal();
      void reload();
    } else if (!open && d.open) d.close();
  }, [open, startStep, reload]);

  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>(".setup-panel")?.focus();
  }, [open, step]);

  const index = STEPS.findIndex((s) => s.id === step);
  const go = (to: WelcomeStep) => {
    setStep(to);
    openWelcome(to); // remembered, so coming back from Models & accounts lands here
  };

  let body: React.ReactNode;
  if (step === "intro") body = <Intro onNext={() => go("models")} onSkip={closeWelcome} />;
  else if (step === "models")
    body = (
      <Models data={data} pool={pool} down={down} onRetry={reload} onNext={() => go("fallbacks")} />
    );
  else if (step === "fallbacks")
    body = (
      <div className="setup-step">
        <FallbacksStep />
        <div className="setup-actions welcome-actions">
          <button className="btn-primary setup-cta" onClick={() => go("done")}>
            Next
          </button>
        </div>
      </div>
    );
  else body = <Done data={data} pool={pool} onDone={closeWelcome} />;

  return (
    <dialog
      ref={ref}
      className="welcome-dialog"
      aria-labelledby="welcome-title"
      onCancel={(e) => {
        e.preventDefault();
        closeWelcome();
      }}
      onClick={(e) => e.target === e.currentTarget && closeWelcome()}
    >
      <div className="setup-panel" data-step={step} tabIndex={-1}>
        <header className="setup-head">
          {index > 0 ? (
            <button
              className="icon-btn setup-back"
              aria-label="Back"
              title="Back"
              onClick={() => go(STEPS[index - 1].id)}
            >
              <IconBack />
            </button>
          ) : (
            <span className="setup-back-space" />
          )}
          <h2 id="welcome-title">Welcome</h2>
          <button
            className="icon-btn setup-close"
            aria-label="Close"
            title="Close"
            onClick={closeWelcome}
          >
            <IconClose />
          </button>
        </header>
        <ol className="setup-rail" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li
              key={s.id}
              className={i < index ? "done" : i === index ? "current" : ""}
              aria-current={i === index ? "step" : undefined}
            >
              <span className="setup-rail-num">{i + 1}</span>
              {s.label}
            </li>
          ))}
        </ol>
        <div className="setup-body">{body}</div>
      </div>
    </dialog>
  );
}

function Intro({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div className="setup-step setup-center welcome-intro">
      <HeroSun size={112} />
      <h3 className="setup-title">Provenance runs on free models</h3>
      <p className="setup-text">
        A coding agent on chat sites you sign in to and free API tiers, pooled into four tiers. When
        a thread outgrows them, it can continue in Claude Code or Codex.
      </p>
      <div className="setup-actions">
        <button className="btn-primary setup-cta" onClick={onNext} autoFocus>
          Get started
        </button>
        <button className="btn setup-cta" onClick={onSkip}>
          Skip
        </button>
      </div>
    </div>
  );
}

function Models({
  data,
  pool,
  down,
  onRetry,
  onNext,
}: {
  data: WebAccounts | null;
  pool: PoolProvider[] | null;
  down: boolean;
  onRetry: () => void;
  onNext: () => void;
}) {
  const fresh = !data || !anySignedIn(data);
  return (
    <div className="setup-step">
      <p className="setup-lead">
        Sign in to a chat site or add free API keys. One is enough to start.
      </p>
      {down ? (
        <p className="setup-note">
          The model router isn't answering yet.{" "}
          <button className="setup-add welcome-inline" onClick={onRetry}>
            Try again
          </button>
        </p>
      ) : !data ? (
        <div className="setup-loading welcome-loading" aria-busy="true" aria-label="Loading" />
      ) : (
        <ul className="setup-sites">
          {shownProviders(data).map((p) => (
            <li key={p.id}>
              <button
                className="setup-site"
                data-provider={p.id}
                onClick={() => welcomeToSetup(p.id, undefined, fresh)}
              >
                <Monogram name={p.name} />
                <span className="setup-site-text">
                  <span className="setup-site-name">{p.name}</span>
                </span>
                <SiteStatus provider={p} />
                <IconNext />
              </button>
            </li>
          ))}
          {pool && (
            <li>
              <button
                className="setup-site setup-pool"
                data-provider="pool"
                onClick={() => welcomeToSetup(null, "keys")}
              >
                <Monogram name="T" />
                <span className="setup-site-text">
                  <span className="setup-site-name">Token pool</span>
                </span>
                <PoolStatus pool={pool} />
                <IconNext />
              </button>
            </li>
          )}
        </ul>
      )}
      <div className="setup-actions welcome-actions">
        <button className="btn-primary setup-cta" onClick={onNext}>
          Next
        </button>
      </div>
    </div>
  );
}

function Done({
  data,
  pool,
  onDone,
}: {
  data: WebAccounts | null;
  pool: PoolProvider[] | null;
  onDone: () => void;
}) {
  const prefs = useAppState((s) => s.settings.fallbacks);
  const info = useAppState((s) => s.fallbackInfo);
  const sites = data
    ? shownProviders(data)
        .filter((p) => p.enabled && p.accounts.some((a) => a.signed_in === true))
        .map((p) => p.name)
    : [];
  const keyed = (pool ?? []).filter((p) => p.usable && !p.anonymous).length;
  const models = [...sites, ...(keyed ? ["Token pool"] : [])];
  const fbs = fallbacks(prefs, info)
    .filter((f) => f.ready)
    .map((f) => (f.mode === "codex-pv" ? "Codex through Provenance" : f.name));
  return (
    <div className="setup-step setup-center">
      <h3 className="setup-title">{models.length ? "You're set" : "Nothing set up yet"}</h3>
      <dl className="welcome-summary">
        <dt className="meta">Models</dt>
        <dd>{models.length ? models.join(", ") : "None yet"}</dd>
        <dt className="meta">Fallbacks</dt>
        <dd>{fbs.length ? fbs.join(", ") : "None"}</dd>
      </dl>
      <p className="meta setup-hint">Models &amp; accounts has all of this, any time.</p>
      <div className="setup-actions">
        <button className="btn-primary setup-cta" onClick={onDone} autoFocus>
          Start
        </button>
      </div>
    </div>
  );
}
