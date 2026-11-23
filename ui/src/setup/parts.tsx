// Small pieces the Models & accounts steps share: status lines, the browser strip, the page
// states, the router note, icons.

import { useEffect, useState } from "react";
import type { UiHealth } from "../../shared/router-api";
import { TierGlyph } from "../components/TierBadge";
import { tierOf } from "../theme/tiers";
import {
  checkedText,
  inUse,
  loginActive,
  planText,
  type BrowserStatus,
  type WebAccount,
  type WebModel,
  type WebProvider,
} from "./web";

/** A site's state in one status line: off, signing in, ready on N accounts, blocked, not signed in. */
export function SiteStatus({ provider }: { provider: WebProvider }) {
  const ok = provider.accounts.filter((a) => inUse(a) && !a.blocked);
  const blocked = provider.accounts.filter((a) => inUse(a) && a.blocked);
  const unconfirmed = provider.accounts.some((a) => a.signed_in === true && !inUse(a));
  let cls = "dot-off";
  let text = "Not signed in";
  if (provider.accounts.some((a) => loginActive(a.login.state))) {
    cls = "dot-busy";
    text = "Signing in…";
  } else if (!provider.enabled) {
    text = "Off";
  } else if (ok.length) {
    cls = "dot-ok";
    text = ok.length === 1 ? "Ready" : `Ready on ${ok.length} accounts`;
  } else if (blocked.length) {
    cls = "dot-warn";
    text = "Paused";
  } else if (unconfirmed) {
    cls = "dot-warn";
    text = "Needs your OK";
  }
  return <Status cls={cls} text={text} />;
}

export function Status({ cls, text }: { cls: string; text: string }) {
  return (
    <span className="setup-status">
      <span className={`dot ${cls}`} />
      {text}
    </span>
  );
}

/** One account's state, who is signed in, when it was checked, and today's use. */
export function AccountStatus({ account: a }: { account: WebAccount }) {
  let cls = "dot-off";
  let text: string;
  if (loginActive(a.login.state)) {
    cls = "dot-busy";
    text = "Signing in…";
  } else if (a.signed_in === true && a.needs_confirmation) {
    cls = "dot-warn";
    text = "Connected, not in use";
  } else if (a.signed_in === true && a.blocked) {
    cls = "dot-warn";
    text = a.reason ?? "Paused for now";
  } else if (a.signed_in === true) {
    cls = "dot-ok";
    text = "Signed in";
  } else if (a.signed_in === false) {
    cls = "dot-err";
    text = "Signed out";
  } else text = "Not signed in yet";
  const showUsage = inUse(a) && a.daily_cap > 0;
  return (
    <span className="setup-account-status">
      <Status cls={cls} text={text} />
      {a.signed_in === true && a.email && (
        <span className="meta setup-email" title={a.email}>
          {a.email}
        </span>
      )}
      {a.checked_at !== null && <span className="meta">{checkedText(a.checked_at)}</span>}
      {showUsage && (
        <span className="meta setup-usage" title="Chats today against the daily limit">
          <span className="setup-meter small" aria-hidden>
            <span style={{ width: `${Math.min(100, (a.today / a.daily_cap) * 100)}%` }} />
          </span>
          {a.today} of {a.daily_cap}&nbsp;today
        </span>
      )}
    </span>
  );
}

/** The account's plan on its site, small beside its name ("Free", "Plus"); nothing when unknown. */
export function PlanLabel({ account: a }: { account: WebAccount }) {
  const t = a.signed_in === true ? planText(a) : null;
  if (!t) return null;
  return (
    <span className="setup-plan" data-plan={a.plan}>
      {t}
    </span>
  );
}

/** What the browser is doing while it's prepared, in words. */
export function browserStageText(b: BrowserStatus): string {
  const pct = b.progress === null ? null : Math.round(b.progress * 100);
  if (b.stage === "download" || pct !== null)
    return `Downloading the sign-in browser${pct === null ? "…" : ` · ${pct}%`}`;
  if (b.stage === "unpack") return "Unpacking the sign-in browser…";
  if (b.stage === "copy") return "Setting up the sign-in browser…";
  return "Getting the sign-in browser ready…";
}

/** The browser sign-ins need, while it isn't ready: get it, its progress, or its error. */
export function BrowserStrip({
  browser,
  onPrepare,
}: {
  browser: BrowserStatus;
  onPrepare: () => void;
}) {
  if (browser.ready) return null;
  if (browser.preparing) {
    const pct = browser.progress === null ? null : Math.round(browser.progress * 100);
    return (
      <div className="setup-browser" role="status">
        <span className="setup-browser-text">{browserStageText(browser)}</span>
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
          ? `The sign-in browser couldn't be set up: ${browser.error}`
          : "Sign-ins use a browser of Provenance's own. It needs setting up once (a download of about 200 MB if this app doesn't carry it)."}
      </span>
      <button className="btn-primary" onClick={onPrepare}>
        {browser.error ? "Try again" : "Set it up"}
      </button>
    </div>
  );
}

/** "GPT-6 Luna · solstice", one per model, each kept whole. */
export function ModelLine({ models }: { models: WebModel[] }) {
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

export function PageState({
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

export function Monogram({ name }: { name: string }) {
  return (
    <span className="setup-mono" aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Which router the app talks to, in one line under the site list: Provenance's own, or yours. */
export function RouterNote() {
  const [h, setH] = useState<UiHealth | null>(null);
  useEffect(() => {
    let stop = false;
    fetch("/api/health")
      .then((r) => r.json() as Promise<UiHealth>)
      .then((v) => !stop && setH(v))
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, []);
  const r = h?.router;
  if (!r?.up) return null;
  const where = r.url.replace(/^https?:\/\//, "");
  const what =
    r.mode === "bundled"
      ? `Models are routed by Provenance's own provenance-core${r.version ? ` ${r.version}` : ""}`
      : `Models are routed by your provenance-core at ${where}`;
  return (
    <p className="meta setup-router" title={r.home ? `${where} · ${r.home}` : where}>
      {what}
      {r.pid ? ` · pid ${r.pid}` : ""}
    </p>
  );
}

// ---- icons -------------------------------------------------------------------------

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
export const IconBack = () => (
  <svg {...ic}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
);
export const IconNext = () => (
  <svg {...ic} width={12} height={12} className="setup-next">
    <path d="M9 18l6-6-6-6" />
  </svg>
);
export const IconClose = () => (
  <svg {...ic}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconTrash = () => (
  <svg {...ic} width={13} height={13} strokeWidth={1.8}>
    <path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13" />
  </svg>
);
export const IconPlusSmall = () => (
  <svg {...ic} width={12} height={12}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconKey = () => (
  <svg {...ic} width={15} height={15} strokeWidth={1.8}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M17 6l3 3M15 8l2 2" />
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
