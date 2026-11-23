// Saving a token pool key and reading what came of it, the same way for the keys page, the
// assistant thread's key card and a key caught in the composer: the value goes to the router in
// one body (PUT /pool/keys/{id} for the first key, POST for one more) and nowhere else, and only
// the outcome comes back: the router's own check of the key with the provider, where it gives
// one, else what its state says.

import { redact, type KeyOutcome } from "./assist-text";
import type { KeyTier } from "../../shared/router-api";
import { addPoolKey, setPoolKeys, type PoolProvider, type SaveAnswer } from "./web";

/** One more key beside the saved ones: its variable, and how the person names it. */
export interface AddKey {
  keyVar: string;
  label?: string;
  tier?: KeyTier | null;
}

export async function savePoolKey(
  provider: string,
  values: Record<string, string>,
  add?: AddKey,
): Promise<{ outcome: KeyOutcome; provider: PoolProvider | null }> {
  const secrets = Object.values(values);
  let r;
  if (add) {
    const { [add.keyVar]: key, ...extras } = values;
    r = await addPoolKey(provider, {
      key: key ?? "",
      ...(add.label?.trim() ? { label: add.label.trim().slice(0, 60) } : {}),
      ...(add.tier ? { tier: add.tier } : {}),
      ...(Object.keys(extras).length ? { extras } : {}),
    });
  } else r = await setPoolKeys(provider, values);
  // A reason never carries the value back, even if a router's message would quote it.
  if (!r.ok)
    return {
      outcome: {
        kind: "not_saved",
        reason: redact(r.detail, secrets),
      },
      provider: null,
    };
  const outcome = outcomeOf(r.value, secrets);
  // "Groq key 2": which one this is, when it joins others.
  const nth = add ? r.value.provider?.keys?.length : undefined;
  if (nth && (outcome.kind === "working" || outcome.kind === "rejected")) outcome.nth = nth;
  return { outcome, provider: r.value.provider };
}

function outcomeOf(a: SaveAnswer, secrets: string[]): KeyOutcome {
  const p = a.provider;
  // The router tried the key with the provider: its answer is the outcome.
  if (a.check)
    return a.check.ok
      ? (missingOf(p, secrets) ?? { kind: "working" })
      : {
          kind: "rejected",
          by: "provider",
          reason: redact(a.check.detail || "it refused the key", secrets),
        };
  // An older router: what its state says.
  if (a.key && !a.key.usable)
    return {
      kind: "rejected",
      by: "provider",
      reason: redact(a.key.reason || "it refused the key", secrets),
    };
  if (p && p.usable === false)
    return (
      missingOf(p, secrets) ?? {
        kind: "rejected",
        by: "router",
        reason: "the router can't use it yet",
      }
    );
  return { kind: "working" };
}

/** A provider that still needs another field (Cloudflare's account id) isn't working yet. */
function missingOf(p: PoolProvider | null, secrets: string[]): KeyOutcome | null {
  if (!p || p.usable !== false) return null;
  const missing = (p.vars ?? []).filter((v) => !v.set).map((v) => v.name);
  return missing.length
    ? {
        kind: "rejected",
        by: "router",
        reason: redact(`it still needs ${missing.join(", ")}`, secrets),
      }
    : null;
}
