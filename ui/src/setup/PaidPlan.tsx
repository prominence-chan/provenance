// A ChatGPT account on a paid plan (Plus, Pro…): the router holds it back until the person says
// so, since using it here spends that account's own usage. Shown on the account itself (its row,
// and the Ready step right after its sign-in), never as a toast. The two ways on: sign in to this
// slot again with another account, or confirm (POST …/confirm {confirm: "paid_plan"}).

import { useState } from "react";
import { confirmPaidPlan, planText, type WebAccount, type WebProvider } from "./web";

export function paidPlanTitle(provider: WebProvider, a: WebAccount): string {
  const plan = planText(a);
  return `This account is on ${provider.name}${plan && plan !== "Paid" ? ` ${plan}` : " with a paid plan"}`;
}

export const PAID_PLAN_TEXT =
  "Using it here still spends that account's own usage, likely faster than Codex would. Provenance won't use it until you choose.";

export function PaidPlanConfirm({
  provider,
  account: a,
  onDifferent,
  onConfirmed,
  centered,
  busy,
}: {
  provider: WebProvider;
  account: WebAccount;
  /** Sign in to this slot again, with another account. */
  onDifferent: () => void;
  onConfirmed: () => void;
  /** On the Ready step: a centred block of its own instead of a row's part. */
  centered?: boolean;
  busy?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = `paid-${provider.id}-${a.id}`;
  const anyway = async () => {
    setSaving(true);
    setErr(null);
    const r = await confirmPaidPlan(provider.id, a.id);
    setSaving(false);
    if (!r.ok) return setErr(r.detail);
    onConfirmed();
  };
  const actions = (
    <div className={centered ? "setup-actions" : "paid-actions"}>
      <button
        className={`btn${centered ? " setup-cta" : ""}`}
        onClick={onDifferent}
        disabled={busy || saving}
        autoFocus={centered}
      >
        Use a different account
      </button>
      <button
        className={`btn${centered ? " setup-cta" : ""}`}
        onClick={() => void anyway()}
        disabled={busy || saving}
      >
        {saving ? "Saving…" : "Use it anyway"}
      </button>
    </div>
  );
  return (
    <div
      className={`paid-confirm${centered ? " paid-confirm-centered" : ""}`}
      role="group"
      aria-labelledby={`${id}-title`}
      data-paid-confirm={a.id}
    >
      {centered ? (
        <h3 id={`${id}-title`} className="setup-title" aria-live="polite">
          {paidPlanTitle(provider, a)}
        </h3>
      ) : (
        <p id={`${id}-title`} className="paid-title">
          {paidPlanTitle(provider, a)}
        </p>
      )}
      <p className={centered ? "setup-text" : "paid-text"}>{PAID_PLAN_TEXT}</p>
      {err && (
        <p className="setup-row-msg" role="alert">
          {err}
        </p>
      )}
      {actions}
    </div>
  );
}
