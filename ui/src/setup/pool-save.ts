// Saving a token pool key and reading what came of it, the same way for the keys page, the
// assistant thread's key card and a key caught in the composer: the value goes to the router in
// one PUT /pool/keys/{id} body and nowhere else, and only the outcome comes back.

import { redact, type KeyOutcome } from "./assist-text";
import { setPoolKeys, type PoolProvider } from "./web";

export async function savePoolKey(
  provider: string,
  values: Record<string, string>,
): Promise<{ outcome: KeyOutcome; provider: PoolProvider | null }> {
  const secrets = Object.values(values);
  const r = await setPoolKeys(provider, values);
  // A reason never carries the value back, even if a router's message would quote it.
  if (!r.ok)
    return { outcome: { kind: "not_saved", reason: redact(r.detail, secrets) }, provider: null };
  const p = (r.value ?? null) as
    (PoolProvider & { check?: { ok?: boolean; detail?: string } }) | null;
  if (p?.check && p.check.ok === false)
    return {
      outcome: {
        kind: "rejected",
        reason: redact(p.check.detail || "the provider refused it", secrets),
      },
      provider: p,
    };
  if (p && p.usable === false) {
    const missing = (p.vars ?? []).filter((v) => !v.set).map((v) => v.name);
    return {
      outcome: {
        kind: "rejected",
        reason: missing.length
          ? `it still needs ${missing.join(", ")}`
          : "the router can't use it yet",
      },
      provider: p,
    };
  }
  return { outcome: { kind: "working" }, provider: p };
}
