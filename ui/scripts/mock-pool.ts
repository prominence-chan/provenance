// The token pool's side of the stand-in router (scripts/mock-router.ts): GET/PUT/POST/DELETE
// /pool/keys…, PATCH/DELETE /pool/keys/{provider}/{key_id}, GET /pool/help and POST
// /pool/help/{provider}/outcome, mirroring provenance-core's server.py, pool_keys.py and
// pool_help.py (its `main`, af5f6f7) route by route: the same shapes, ids ("main", "k" + 6 hex),
// status codes and messages. Key values are never kept: a hash to find a second copy, the last
// four characters (of a key of 12 or more, as the router shows them), and what the check said.
//
// The check, made up for the stand-in: Google and Groq are checked (a key with REJECT in it is
// refused, marked and not used), Cloudflare softly (refused but still used), the others not at
// all (ok: null).

import { createHash, randomBytes } from "node:crypto";
import type {
  WireConsidered,
  WireKeyCheck,
  WireMultipleKeys,
  WirePoolHelpProvider,
  WirePoolKey,
  WirePoolProvider,
  WireRemovedProvider,
} from "../shared/router-api.ts";

type Reply = { status: number; body: unknown };
type Obj = Record<string, unknown>;

// ---- the catalog's API providers (the ones /pool/keys lists) ---------------------------------
interface CatalogProvider {
  id: string;
  /** The first key's variable; null: takes no key. */
  keyVar: string | null;
  /** ${VAR}s of its address (each key may bring its own, as `extras`). */
  urlVars: string[];
  noAuth: boolean;
  models: number;
  tiers: string[];
  /** How the router checks a key: hard (refused keys are not used), soft (only said), none. */
  check: "hard" | "soft" | null;
  until?: string;
}

const CATALOG: CatalogProvider[] = [
  {
    id: "groq",
    keyVar: "GROQ_API_KEY",
    urlVars: [],
    noAuth: false,
    models: 5,
    tiers: ["solstice", "spark"],
    check: "hard",
  },
  {
    id: "google",
    keyVar: "GEMINI_API_KEY",
    urlVars: [],
    noAuth: false,
    models: 7,
    tiers: ["solstice", "ember"],
    check: "hard",
  },
  {
    id: "kilo",
    keyVar: null,
    urlVars: [],
    noAuth: true,
    models: 10,
    tiers: ["solstice", "ember", "spark"],
    check: null,
  },
  {
    id: "cloudflare",
    keyVar: "CLOUDFLARE_API_TOKEN",
    urlVars: ["CLOUDFLARE_ACCOUNT_ID"],
    noAuth: false,
    models: 4,
    tiers: ["solstice", "ember"],
    check: "soft",
  },
  {
    id: "nvidia",
    keyVar: "NVIDIA_API_KEY",
    urlVars: [],
    noAuth: false,
    models: 6,
    tiers: ["solstice", "ember"],
    check: null,
  },
  {
    id: "cohere",
    keyVar: "COHERE_API_KEY",
    urlVars: [],
    noAuth: false,
    models: 2,
    tiers: ["ember"],
    check: null,
  },
  {
    id: "inception",
    keyVar: "INCEPTION_API_KEY",
    urlVars: [],
    noAuth: false,
    models: 1,
    tiers: ["spark"],
    check: null,
    until: "2026-12-28",
  },
];

/** pool_help.yaml `removed:` (not in the catalog any more). */
const REMOVED: (Omit<WireRemovedProvider, "leftover_key" | "note"> & {
  key_var: string;
  sources: string[];
})[] = [
  {
    id: "mistral",
    name: "Mistral AI",
    removed: "2026-11-23",
    reason:
      "No free API tier any more. Mistral's docs: free mode \"doesn't include API access. Creating API keys and using the API require billing activation and pay-as-you-go.\"",
    key_var: "MISTRAL_API_KEY",
    sources: ["https://docs.mistral.ai/admin/billing-usage/usage-limits"],
  },
  {
    id: "cerebras",
    name: "Cerebras Inference",
    removed: "2026-11-23",
    reason:
      'Needs a payment card and has no standing free tier. Cerebras: "Is there a permanently free tier?" "No. The Free Trial is time- and credit-bounded: $5 in credits that expire 30 days after they\'re granted."',
    key_var: "CEREBRAS_API_KEY",
    sources: ["https://inference-docs.cerebras.ai/support/rate-limits"],
  },
];

const CONSIDERED: WireConsidered[] = [
  {
    name: "Together AI",
    allowance: null,
    why_not: "A US$15 credit purchase is required before a key can be made.",
    source: "https://docs.together.ai/docs/billing",
  },
  {
    name: "DeepSeek",
    allowance: "None stated",
    why_not: "No free tier on its pricing or rate-limit pages.",
    source: "https://api-docs.deepseek.com/quick_start/pricing",
  },
  {
    name: "GitHub Models",
    allowance: null,
    why_not: "Retired on 2026-07-30.",
    source: "https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models",
  },
];

/** pool_help.yaml's multiple_keys, as on the router's main. */
const MULTI: Record<string, WireMultipleKeys> = {
  kilo: {
    allowed: "no",
    note: 'Kilo\'s terms: an individual or entity "may not have more than one Account" (employees of one organization may each have their own). The free limit is per IP address anyway, so a second key adds nothing.',
  },
  google: {
    allowed: "check_terms",
    note: 'The Gemini API terms and rate-limit page read on the checked date say nothing about several accounts ("Rate limits are applied per project, not per API key"). The Google APIs Terms of Service they incorporate were not read; read them before adding a second account\'s key.',
  },
  groq: {
    allowed: "no",
    note: 'Groq\'s acceptable use policy forbids use "beyond published parameters, rate limits, or use limitations, including by registering multiple accounts or orchestrating usage between multiple organizations". Limits are per organization, so a second key of the same organization adds nothing either.',
  },
  cloudflare: {
    allowed: "check_terms",
    note: "Cloudflare's self-serve agreement forbids use \"intended to circumvent Service-specific usage limits, quotas, or other restrictions\"; it does not mention several accounts as such. Read it before adding a second account's token.",
  },
  nvidia: {
    allowed: "check_terms",
    note: "NVIDIA's API catalog terms could not be read on the checked date (the page timed out); read them before adding a second account's key.",
  },
  cohere: {
    allowed: "no",
    note: 'Cohere\'s terms of use: you agree to "not register for more than one account".',
  },
  inception: {
    allowed: "yes",
    note: "Nothing about several accounts was found in Inception's terms on the checked date (an account may not be transferred or shared). The service ends on 2026-12-28 in any case.",
  },
};
const NO_TERMS: WireMultipleKeys = {
  allowed: "check_terms",
  note: "This provider's terms were not read; read them before adding a key from a second account.",
};
const multipleKeys = (id: string) => ({ ...(MULTI[id] ?? NO_TERMS) });

/**
 * GET /pool/help's providers, cut down from pool_help.yaml. Google AI Studio opens in Gemini's
 * signed-in window (Account B in "signed").
 */
const HELP: WirePoolHelpProvider[] = [
  {
    id: "kilo",
    name: "Kilo AI Gateway",
    free_tier: "anonymous",
    confidence: "seen",
    what_you_get:
      "The gateway's free models with no account and no key: 200 requests per hour per IP address.",
    needs: "Nothing. No account, no key.",
    time_minutes: 0,
    signup_url: "https://app.kilo.ai",
    keys_url: "https://app.kilo.ai",
    key_var: null,
    steps: ["Nothing to do. The pool calls Kilo's free models without a key."],
    key_format: "Not needed.",
    gotchas: [
      "Other free models may be routed to providers that log prompts and outputs and use them to improve their services.",
    ],
    checked: "2026-11-23",
  },
  {
    id: "google",
    name: "Google Gemini API (Google AI Studio)",
    free_tier: "free",
    confidence: "seen",
    what_you_get:
      "The Gemini Flash and Flash-Lite models and Gemma, free of charge on the free tier.",
    needs: "A Google account, age 18 or over, a supported country. No card.",
    time_minutes: 3,
    signup_url: "https://aistudio.google.com",
    keys_url: "https://aistudio.google.com/api-keys",
    key_var: "GEMINI_API_KEY",
    steps: [
      "Open https://aistudio.google.com/api-keys and sign in with your Google account.",
      "Accept the Terms of Service when asked.",
      "If no key is listed, click **Create API key**.",
      "Copy the key from the **API Keys** page and paste it into the app.",
    ],
    key_format: "Starts with `AIza`, 39 characters.",
    key_pattern: "^AIza[0-9A-Za-z_-]{35}$",
    gotchas: [
      'Free-tier prompts and answers are used by Google: "Google uses the content you submit to the Services and any generated responses to provide, improve, and develop Google products", and "human reviewers may read, annotate, and process your API input and output".',
      "Limits are per project, not per key, so a second key in the same project adds nothing.",
    ],
    terms_note: "Google's terms require age 18+.",
    checked: "2026-11-23",
    open_with: [{ provider: "gemini-web", account: "b" }],
  },
  {
    id: "groq",
    name: "Groq (GroqCloud)",
    free_tier: "free",
    confidence: "docs-only",
    what_you_get:
      "openai/gpt-oss-120b and qwen/qwen3.8-27b on the Free plan: 1,000 requests/day each.",
    needs: "A Groq account. No card for the Free plan.",
    time_minutes: 3,
    signup_url: "https://console.groq.com/home",
    keys_url: "https://console.groq.com/keys",
    key_var: "GROQ_API_KEY",
    steps: [
      "Open https://console.groq.com/keys and sign up or log in.",
      "On the **API Keys** page click **Create API Key**.",
      "Give the key a name such as `provenance` and confirm.",
      "Copy the key when it is shown and paste it into the app.",
    ],
    key_format: "Starts with `gsk_`.",
    key_pattern: "^gsk_\\S+$",
    gotchas: [
      "Groq says it does not retain inference data by default and may not use inputs or outputs for training unless you allow it.",
    ],
    checked: "2026-11-23",
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    free_tier: "free",
    confidence: "seen",
    what_you_get: "10,000 Neurons a day of open models on Cloudflare's network.",
    needs: "A Cloudflare account. No card.",
    time_minutes: 5,
    signup_url: "https://dash.cloudflare.com/sign-up",
    keys_url: "https://dash.cloudflare.com/profile/api-tokens",
    key_var: "CLOUDFLARE_API_TOKEN",
    steps: [
      "Open the API tokens page and sign in.",
      "Click **Create Token**, then **Use template** next to **Workers AI**.",
      "Click **Continue to summary**, then **Create Token**, and copy it.",
    ],
    key_format: "40 letters, digits, - and _.",
    key_pattern: "^[A-Za-z0-9_-]{40}$",
    extra_fields: [
      {
        var: "CLOUDFLARE_ACCOUNT_ID",
        label: "Account ID",
        where: "On the Workers AI page under **Use REST API** > **Get Account ID**.",
      },
    ],
    gotchas: ["The token needs the Workers AI template, not a global API key."],
    checked: "2026-11-23",
  },
  {
    id: "nvidia",
    name: "NVIDIA API Catalog (build.nvidia.com)",
    free_tier: "free",
    confidence: "seen",
    setup: "person",
    why_person:
      "NVIDIA asks for an email approval and a phone number with a one-time code before it issues a key, so this one is done by you, not by the assistant.",
    what_you_get:
      'The models with a "Free Endpoint" on build.nvidia.com, free "for prototyping" for NVIDIA Developer Program members.',
    needs:
      "An email address for an NVIDIA account, with the mailbox at hand, and a phone number that can receive a one-time code. No card.",
    time_minutes: 8,
    signup_url: "https://build.nvidia.com",
    keys_url: "https://build.nvidia.com",
    key_var: "NVIDIA_API_KEY",
    steps: [
      'Open https://build.nvidia.com and click **Login** at the top right ("Sign In to Get Started with NVIDIA AI").',
      "Type your email into **Enter your email ID** and click **Next**.",
      "If NVIDIA shows a page saying it has sent a confirmation to your email, open that email and approve it, then come back.",
      "On **Create an NVIDIA Cloud Account** type any name (for example `provenance`) and click **Create NVIDIA Cloud Account**.",
      "Back on build.nvidia.com a dialog says **We'll need to verify your phone number**: choose your **Location**, type your **Phone Number**, click **Send Code to Phone** and enter the code.",
      "Generate the API key; it is shown once, with its ID, name and expiration. Copy it and paste it into the app.",
    ],
    key_format: "Starts with `nvapi-`.",
    key_pattern: "^nvapi-[A-Za-z0-9_-]{40,}$",
    gotchas: [
      'The key is shown only once, is "for API testing use only" and is valid for 6 months: set a reminder to make a new one.',
    ],
    terms_note:
      "Free access through the Developer Program is for prototyping and testing only; production use needs an NVIDIA AI Enterprise license.",
    checked: "2026-11-23",
  },
  {
    id: "cohere",
    name: "Cohere",
    free_tier: "free",
    confidence: "seen",
    what_you_get: "Command models on a trial key: 1,000 calls a month.",
    needs: "A Cohere account. No card.",
    time_minutes: 3,
    signup_url: "https://dashboard.cohere.com",
    keys_url: "https://dashboard.cohere.com/api-keys",
    key_var: "COHERE_API_KEY",
    steps: ["Open the API keys page and copy the trial key."],
    key_format: "40 letters and digits.",
    gotchas: [],
    checked: "2026-11-23",
  },
  {
    id: "inception",
    name: "Inception Labs (Mercury)",
    free_tier: "trial",
    recommended: false,
    why_not:
      "New sign-ups are closed, and the API ends after 2026-12-28. Only for someone who already has an account.",
    confidence: "seen",
    what_you_get: "Mercury, a fast diffusion model.",
    needs: "An existing Inception account.",
    time_minutes: 2,
    signup_url: "https://platform.inceptionlabs.ai",
    keys_url: "https://platform.inceptionlabs.ai/dashboard/api-keys",
    key_var: "INCEPTION_API_KEY",
    steps: [
      "If you have an account, open https://platform.inceptionlabs.ai and log in.",
      "Open the API keys page of the dashboard and generate a key.",
      "Copy the key and paste it into the app.",
    ],
    key_format: "Starts with `sk_`.",
    gotchas: [],
    checked: "2026-11-23",
    until: "2026-12-28",
  },
];

const ASSISTANT_NOTES = [
  "A provider with `setup: person` needs something only the person can do (a phone code, an email approval, their own details or a payment step). Do not walk it step by step or wait on it: say what it gives, point to its written steps, let the person do it on their own and paste the key into the key card when they have it, and move on to the next provider meanwhile.",
  "Walk the person through one provider at a time, in this order; skip any whose `needs` they cannot meet.",
  "The person does every click themselves. Never create an account, sign in, accept terms or request a key for them.",
];

// ---- state -----------------------------------------------------------------------------------
interface Key {
  id: string;
  hash: string;
  last4: string;
  label: string | null;
  tier: "free" | "paid" | null;
  limits: Obj | null;
  /** The ${VAR}s this key brings (Cloudflare's account id), set or not. */
  extras: Record<string, boolean>;
  enabled: boolean;
  added: string | null;
  source: "app" | "env";
  /** The provider refused it (the router's REJECTED, this process only). */
  rejected: string | null;
}

interface PoolState {
  keys: Record<string, Key[]>;
  /** Variables set, and from where (the first keys, the ${VAR}s set with PUT). */
  vars: Record<string, "app" | "env">;
  /** Removed providers whose key is still saved. */
  leftovers: Set<string>;
  /** Each POST /pool/help/{id}/outcome taken. */
  outcomes: { provider: string; body: Obj }[];
  /** What the outcomes file holds (seeded), for `experience`. */
  rows: Obj[];
}

let flags = { older: false, noMultiKey: false };
export function setPoolFlags(f: { older: boolean; noMultiKey: boolean }): void {
  flags = f;
}
const multiKey = () => !flags.older && !flags.noMultiKey;

const hashOf = (v: string) => createHash("sha256").update(v).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);
const last4 = (v: string) => (v.length >= 12 ? v.slice(-4) : "");

/** Earlier setups of Groq: 11 of 14 worked, 3 stuck at step 3. */
function seedRows(): Obj[] {
  const rows: Obj[] = [];
  for (let i = 0; i < 14; i++)
    rows.push({
      provider: "groq",
      date: "2026-11-2" + (i % 2),
      result: i < 11 ? "saved_working" : "gave_up",
      source: "assistant",
      ...(i < 3
        ? {
            step_notes: [
              {
                step: 3,
                ok: false,
                note: "the **Display name** field is required now; any name works.",
              },
            ],
          }
        : {}),
    });
  return rows;
}

let st: PoolState;
export function resetPool(scenario: string): void {
  st = { keys: {}, vars: {}, leftovers: new Set(), outcomes: [], rows: seedRows() };
  if (scenario === "signed") {
    st.vars.GEMINI_API_KEY = "app";
    st.keys.google = [
      {
        id: "main",
        hash: hashOf("seeded-google-key-x7Qa"),
        last4: "x7Qa",
        label: null,
        tier: null,
        limits: null,
        extras: {},
        enabled: true,
        added: "2026-11-02",
        source: "app",
        rejected: null,
      },
    ];
  }
}
resetPool("fresh");

// ---- views (pool_keys.py) --------------------------------------------------------------------
const providerVars = (p: CatalogProvider) => [...(p.keyVar ? [p.keyVar] : []), ...p.urlVars];
const missingVars = (p: CatalogProvider, k: Key | null) =>
  p.urlVars.filter((v) => !(k?.extras[v] || st.vars[v]));

function unusable(p: CatalogProvider, k: Key): string | null {
  if (!k.enabled) return "Turned off.";
  if (k.rejected) return k.rejected;
  const miss = missingVars(p, k);
  return miss.length ? `Needs ${miss.join(", ")}.` : null;
}

function keyView(p: CatalogProvider, k: Key): WirePoolKey {
  const reason = unusable(p, k);
  return {
    id: k.id,
    label: k.label,
    tier: k.tier,
    usable: reason === null,
    reason,
    added: k.added,
    last4: k.last4,
    limits: k.limits,
    enabled: k.enabled,
    source: k.source,
  };
}

const keysOf = (p: CatalogProvider) => (p.keyVar ? (st.keys[p.id] ?? []) : []);
const usableOf = (p: CatalogProvider) =>
  keysOf(p).some((k) => unusable(p, k) === null) || (p.noAuth && !missingVars(p, null).length);

function providerView(p: CatalogProvider): WirePoolProvider {
  const base: WirePoolProvider = {
    id: p.id,
    usable: usableOf(p),
    anonymous: p.noAuth && !p.urlVars.length,
    vars: providerVars(p).map((v) => ({ name: v, set: !!st.vars[v], from: st.vars[v] ?? null })),
    models: p.models,
    tiers: p.tiers,
  };
  if (!multiKey()) return base;
  const expired = !!p.until && today() > p.until;
  return {
    ...base,
    keys: keysOf(p).map((k) => keyView(p, k)),
    multiple_keys: multipleKeys(p.id),
    until: p.until ?? null,
    expired,
    note: p.until
      ? expired
        ? `${p.id} stopped on ${p.until}; its models are no longer offered.`
        : `Temporary: ${p.id} is used until ${p.until}, when its API shuts down.`
      : null,
  };
}

function removedView(): WireRemovedProvider[] {
  return REMOVED.map((r) => {
    const left = st.leftovers.has(r.id);
    return {
      id: r.id,
      name: r.name,
      removed: r.removed,
      reason: r.reason,
      leftover_key: left,
      note: left
        ? `A key for ${r.name} is still saved; it is ignored. DELETE /pool/keys/${r.id} removes it.`
        : null,
    };
  });
}

// ---- changes ---------------------------------------------------------------------------------
class SetupError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}
const conflict = (msg: string) => new SetupError(409, msg);

function providerOf(id: string): CatalogProvider {
  const p = CATALOG.find((x) => x.id === id);
  if (p) return p;
  const gone = REMOVED.find((r) => r.id === id);
  if (gone)
    throw new SetupError(
      404,
      `${gone.name} was removed from the pool on ${gone.removed}: ${gone.reason}`,
    );
  throw new SetupError(404, `There is no API provider called ${id}.`);
}

function value(v: unknown, name: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > 4096 || /[\r\n\0]/.test(s))
    throw conflict(`${name} must be one line of text (up to 4096 characters).`);
  return s;
}

function meta(body: Obj, v?: string): Partial<Pick<Key, "label" | "tier" | "limits" | "enabled">> {
  const out: Partial<Pick<Key, "label" | "tier" | "limits" | "enabled">> = {};
  if ("label" in body) {
    const lab = body.label;
    if (lab !== null && (typeof lab !== "string" || lab.length > 80 || /[\r\n\0]/.test(lab)))
      throw conflict("label is a short line of text (up to 80 characters), or null.");
    const l = typeof lab === "string" ? lab.trim() : "";
    if (l && v && ((v.includes(l) && l.length >= 8) || l.includes(v)))
      throw conflict("The label must not contain the key.");
    out.label = l || null;
  }
  if ("tier" in body) {
    const t = body.tier === "" || body.tier === "unknown" ? null : body.tier;
    if (t !== null && t !== "free" && t !== "paid")
      throw conflict('tier is "free", "paid" or "unknown".');
    out.tier = t as Key["tier"];
  }
  if ("limits" in body || "limits_scale" in body) {
    const lim = (body.limits && typeof body.limits === "object" ? body.limits : {}) as Obj;
    const scale = body.limits_scale ?? lim.scale;
    out.limits =
      scale != null || Object.keys(lim).length
        ? { ...lim, ...(scale != null ? { scale } : {}) }
        : null;
  }
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") throw conflict("enabled is true or false.");
    out.enabled = body.enabled;
  }
  return out;
}

/** The validity check (pool_keys.check), made up: REJECT in a key is a 401. */
function check(p: CatalogProvider, k: Key | null, v: string | null): WireKeyCheck {
  if (!k || !v) return { ok: null, detail: "No key was set." };
  if (!p.check)
    return {
      ok: null,
      detail: "This provider has no free check; the first request will show whether the key works.",
    };
  const miss = missingVars(p, k);
  if (miss.length) return { ok: null, detail: `Not checked: ${miss.join(", ")} is missing.` };
  if (!v.includes("REJECT")) {
    k.rejected = null;
    return { ok: true, detail: "The provider accepted the key." };
  }
  const why = "The provider did not accept this key (HTTP 401).";
  if (p.check === "soft")
    return { ok: false, detail: `${why} It was saved and will be tried; check it and its extras.` };
  k.rejected = why;
  return { ok: false, detail: `${why} It was saved but is not used; replace or remove it.` };
}

function saved(p: CatalogProvider, keyId: string, v: string | null) {
  const k = keysOf(p).find((x) => x.id === keyId) ?? null;
  const c = check(p, k, v);
  return { ...providerView(p), ...(multiKey() ? { key_id: k ? keyId : null, check: c } : {}) };
}

function setKeys(p: CatalogProvider, values: unknown, m: Obj) {
  const names = providerVars(p);
  if (!names.length) throw conflict(`${p.id} does not take a key.`);
  if (!values || typeof values !== "object" || !Object.keys(values).length)
    throw conflict('Send the key as {"values": {"<variable>": "<key>"}}.');
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(values as Obj)) {
    if (!names.includes(k))
      throw conflict(`${p.id} does not use ${k}; it uses ${names.join(", ")}.`);
    clean[k] = value(v, k);
  }
  const fresh = p.keyVar ? clean[p.keyVar] : undefined;
  const ks = (st.keys[p.id] ??= []);
  if (fresh && ks.some((k) => k.id !== "main" && k.hash === hashOf(fresh)))
    throw conflict(`That key is already one of ${p.id}'s keys.`);
  const mm = meta(m, fresh);
  for (const k of Object.keys(clean)) st.vars[k] = "app";
  let main = ks.find((k) => k.id === "main");
  if (fresh) {
    if (!main) {
      main = {
        id: "main",
        hash: "",
        last4: "",
        label: null,
        tier: null,
        limits: null,
        extras: {},
        enabled: true,
        added: null,
        source: "app",
        rejected: null,
      };
      ks.unshift(main);
    }
    if (main.hash !== hashOf(fresh)) main.added = today();
    Object.assign(main, {
      hash: hashOf(fresh),
      last4: last4(fresh),
      source: "app",
      rejected: null,
    });
  }
  if (main) Object.assign(main, mm);
  return fresh ?? null;
}

function addKey(p: CatalogProvider, body: Obj): { id: string; v: string } {
  if (!p.keyVar) throw conflict(`${p.id} does not take a key.`);
  const v = value(body.key, "key");
  const ks = (st.keys[p.id] ??= []);
  if (ks.some((k) => k.hash === hashOf(v)))
    throw conflict(`That key is already one of ${p.id}'s keys.`);
  const mm = meta(body, v);
  const extras = body.extras ?? {};
  if (!extras || typeof extras !== "object")
    throw conflict('extras is an object such as {"<variable>": "<value>"}.');
  const ex: Record<string, string> = {};
  for (const [k, x] of Object.entries(extras as Obj)) {
    if (!p.urlVars.includes(k))
      throw conflict(
        `${p.id} does not use ${k}` +
          (p.urlVars.length ? `; it uses ${p.urlVars.join(", ")}.` : "; it takes no extras."),
      );
    ex[k] = value(x, k);
  }
  const miss = p.urlVars.filter((x) => !(ex[x] || st.vars[x]));
  if (!ks.some((k) => k.id === "main")) {
    if (miss.length) throw conflict(`${p.id} also needs ${miss.join(", ")} (send it in extras).`);
    setKeys(p, { [p.keyVar]: v, ...ex }, body);
    return { id: "main", v };
  }
  if (miss.length)
    throw conflict(`${p.id} also needs ${miss.join(", ")} for this key (send it in extras).`);
  let id = "";
  do id = `k${randomBytes(3).toString("hex")}`;
  while (ks.some((k) => k.id === id));
  ks.push({
    id,
    hash: hashOf(v),
    last4: last4(v),
    label: null,
    tier: null,
    limits: null,
    extras: Object.fromEntries(Object.keys(ex).map((x) => [x, true])),
    enabled: true,
    added: today(),
    source: "app",
    rejected: null,
    ...mm,
  });
  return { id, v };
}

const outside = (vars: string[]) =>
  `${vars.join(", ")} comes from the router's environment (keys.env or the shell), not from the app; remove it there.`;

function clearFirst(p: CatalogProvider): string[] {
  const out = providerVars(p).filter((v) => st.vars[v] === "env");
  for (const v of providerVars(p)) if (st.vars[v] === "app") delete st.vars[v];
  return out;
}

// ---- outcomes (pool_help.py) -----------------------------------------------------------------
const RESULTS = ["saved_working", "saved_rejected", "skipped", "gave_up"];
const PREFIXED =
  /(?<![A-Za-z0-9])(sk-|sk_|gsk_|csk-|eyJ|AIza|hf_|cf[ua]t_|nvapi-|vck_|cpk_|xai-|ghp_|github_pat_|pk_)[A-Za-z0-9_-]{12,}/;
const EMAIL = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/;
const entropy = (s: string) => {
  const c = new Map<string, number>();
  for (const ch of s) c.set(ch, (c.get(ch) ?? 0) + 1);
  return -[...c.values()].reduce((a, n) => a + (n / s.length) * Math.log2(n / s.length), 0);
};
const mixed = (s: string) => /\d/.test(s) && /[A-Za-z]/.test(s);
function looksLikeKey(text: string): boolean {
  if (PREFIXED.test(text)) return true;
  const pats = HELP.flatMap((h) => [
    h.key_pattern,
    ...(h.extra_fields ?? []).map((f) => (f as unknown as Obj).pattern as string),
  ])
    .filter((x): x is string => !!x)
    .map((x) => new RegExp(x));
  if (
    text
      .split(/\s+/)
      .some((w) =>
        pats.some((r) => r.test(w.replace(/^["'`.,;:()[\]<>]+|["'`.,;:()[\]<>]+$/g, ""))),
      )
  )
    return true;
  for (const t of text.match(/[A-Za-z0-9_-]{20,}/g) ?? []) {
    if (t.split(/[-_]/).some((seg) => seg.length >= 20 && mixed(seg) && entropy(seg) >= 3.0))
      return true;
    if (t.length >= 32 && mixed(t) && entropy(t) >= 3.8) return true;
  }
  return false;
}
class OutcomeError extends Error {}
function text(v: unknown, what: string, limit: number): string {
  if (typeof v !== "string" || !v.trim() || v.length > limit)
    throw new OutcomeError(`${what} is text of up to ${limit} characters.`);
  const s = v.split(/\s+/).filter(Boolean).join(" ");
  if (looksLikeKey(s))
    throw new OutcomeError(
      `${what} looks as if it holds a key or an account id; nothing was recorded. Leave it out.`,
    );
  if (EMAIL.test(s))
    throw new OutcomeError(
      `${what} holds an email address; nothing was recorded. Leave personal details out.`,
    );
  return s;
}

function recordOutcome(pid: string, body: unknown): Obj {
  if (!HELP.some((h) => h.id === pid))
    throw new SetupError(404, `There are no key instructions for a provider called ${pid}.`);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new OutcomeError("Send the outcome as a JSON object.");
  const b = body as Obj;
  if (
    Object.keys(b).some(
      (k) => !["result", "minutes", "step_notes", "labels_seen", "source"].includes(k),
    )
  )
    throw new OutcomeError(
      "Only result, minutes, step_notes, labels_seen and source are recorded.",
    );
  if (!RESULTS.includes(b.result as string))
    throw new OutcomeError(`result is one of ${RESULTS.join(", ")}.`);
  if (b.source !== "assistant" && b.source !== "manual")
    throw new OutcomeError("source is one of assistant, manual.");
  const row: Obj = { date: today(), provider: pid, result: b.result, source: b.source };
  if (b.minutes != null) {
    if (typeof b.minutes !== "number" || b.minutes < 0 || b.minutes > 600)
      throw new OutcomeError("minutes is a number from 0 to 600.");
    row.minutes = Math.round(b.minutes * 10) / 10;
  }
  if (b.step_notes != null) {
    if (!Array.isArray(b.step_notes) || b.step_notes.length > 40)
      throw new OutcomeError("step_notes is a list of up to 40 notes.");
    row.step_notes = b.step_notes.map((n: Obj) => {
      if (!n || typeof n !== "object" || typeof n.ok !== "boolean")
        throw new OutcomeError(
          'Each step note is {"step": <number or text>, "ok": true | false, "note": "..."}.',
        );
      const step = n.step;
      if (typeof step !== "number" && typeof step !== "string")
        throw new OutcomeError("A step is its number (1 for the first) or its text.");
      if (typeof step === "number" && (!Number.isInteger(step) || step < 0 || step > 100))
        throw new OutcomeError("A step number is between 1 and the number of steps.");
      return {
        step: typeof step === "number" ? step : text(step, "A step", 300),
        ok: n.ok,
        ...(n.note != null ? { note: text(n.note, "A step note", 500) } : {}),
      };
    });
  }
  if (b.labels_seen != null) {
    if (!Array.isArray(b.labels_seen) || b.labels_seen.length > 60)
      throw new OutcomeError("labels_seen is a list of up to 60 labels.");
    row.labels_seen = b.labels_seen.map((x) => text(x, "A label", 120));
  }
  st.rows.push(row);
  st.outcomes.push({ provider: pid, body: b });
  return row;
}

function experience(pid: string) {
  const rows = st.rows.filter((r) => r.provider === pid);
  const worked = rows.filter((r) => r.result === "saved_working");
  const help = HELP.find((h) => h.id === pid);
  const by = new Map<number | string, { count: number; notes: string[] }>();
  for (const r of rows)
    for (const n of (r.step_notes as Obj[] | undefined) ?? []) {
      if (n.ok !== false) continue;
      let step = n.step as number | string;
      if (typeof step === "string") {
        const i = (help?.steps ?? []).findIndex(
          (s) => s.trim().toLowerCase() === (step as string).trim().toLowerCase(),
        );
        if (i >= 0) step = i + 1;
      }
      const t = by.get(step) ?? { count: 0, notes: [] };
      t.count++;
      if (typeof n.note === "string" && !t.notes.includes(n.note)) t.notes.push(n.note);
      by.set(step, t);
    }
  const trouble = [...by.entries()]
    .map(([step, t]) => ({ step, count: t.count, notes: t.notes.slice(0, 3) }))
    .sort((a, b) => b.count - a.count || String(a.step).localeCompare(String(b.step)))
    .slice(0, 5);
  return {
    tries: rows.length,
    worked: worked.length,
    last_worked:
      worked
        .map((r) => String(r.date ?? ""))
        .sort()
        .at(-1) || null,
    common_trouble: trouble,
  };
}

// ---- the routes ------------------------------------------------------------------------------
/** A /pool/* request, or null when it isn't one of these routes. */
export function handlePool(method: string, path: string, body: unknown): Reply | null {
  const b = (body && typeof body === "object" ? body : {}) as Obj;
  try {
    if (path === "/pool/keys" && method === "GET")
      return {
        status: 200,
        body: {
          providers: CATALOG.map(providerView),
          ...(multiKey() ? { removed: removedView() } : {}),
        },
      };
    if (path === "/pool/help" && method === "GET") {
      if (flags.older) return { status: 404, body: { detail: "Not Found" } };
      if (!multiKey())
        return {
          status: 200,
          body: { checked: "2026-11-23", assistant_notes: ASSISTANT_NOTES, providers: HELP },
        };
      return {
        status: 200,
        body: {
          checked: "2026-11-23",
          assistant_notes: ASSISTANT_NOTES,
          providers: HELP.map((h) => ({
            ...h,
            multiple_keys: multipleKeys(h.id),
            experience: experience(h.id),
          })),
          removed: REMOVED,
          considered: CONSIDERED,
        },
      };
    }
    const out = /^\/pool\/help\/([^/]+)\/outcome$/.exec(path);
    if (out && method === "POST") {
      if (!multiKey()) return { status: 404, body: { detail: "Not Found" } };
      const pid = decodeURIComponent(out[1]);
      try {
        const row = recordOutcome(pid, body);
        return { status: 200, body: { recorded: row, experience: experience(pid) } };
      } catch (e) {
        if (e instanceof OutcomeError)
          return { status: 400, body: { detail: e.message, reason: e.message } };
        throw e;
      }
    }
    const one = /^\/pool\/keys\/([^/]+)\/([^/]+)$/.exec(path);
    if (one && (method === "PATCH" || method === "DELETE")) {
      if (!multiKey()) return { status: 404, body: { detail: "Not Found" } };
      const p = providerOf(decodeURIComponent(one[1]));
      const kid = decodeURIComponent(one[2]);
      const k = keysOf(p).find((x) => x.id === kid);
      if (!k) throw new SetupError(404, `${p.id} has no key with the id ${kid}.`);
      if (method === "PATCH") {
        const unknown = Object.keys(b).filter(
          (x) => !["label", "tier", "limits", "limits_scale", "enabled"].includes(x),
        );
        if (unknown.length)
          throw conflict(
            `${unknown.join(", ")} cannot be changed; label, tier, limits and enabled can.`,
          );
        const mm = meta(b);
        if (!Object.keys(mm).length) throw conflict("Nothing to change.");
        Object.assign(k, mm);
        if (mm.enabled === true) k.rejected = null;
        return { status: 200, body: providerView(p) };
      }
      if (kid === "main") {
        const env = clearFirst(p);
        if (k.source !== "env") st.keys[p.id] = keysOf(p).filter((x) => x !== k);
        if (env.length) throw conflict(outside(env));
      } else st.keys[p.id] = keysOf(p).filter((x) => x !== k);
      return { status: 200, body: providerView(p) };
    }
    const key = /^\/pool\/keys\/([^/]+)$/.exec(path);
    if (!key) return null;
    const id = decodeURIComponent(key[1]);
    if (method === "DELETE") {
      const gone = REMOVED.find((r) => r.id === id);
      if (gone) {
        st.leftovers.delete(id);
        return { status: 200, body: removedView().find((r) => r.id === id) };
      }
      const p = providerOf(id);
      const env = clearFirst(p);
      st.keys[p.id] = keysOf(p).filter((k) => k.source === "env");
      if (env.length) throw conflict(outside(env));
      return { status: 200, body: providerView(p) };
    }
    if (method === "PUT") {
      const p = providerOf(id);
      const v = setKeys(
        p,
        b.values,
        Object.fromEntries(
          ["label", "tier", "limits", "limits_scale"].filter((x) => x in b).map((x) => [x, b[x]]),
        ),
      );
      return { status: 200, body: saved(p, "main", v) };
    }
    if (method === "POST") {
      if (!multiKey()) return { status: 405, body: { detail: "Method Not Allowed" } };
      const p = providerOf(id);
      const { id: kid, v } = addKey(p, b);
      return { status: 200, body: saved(p, kid, v) };
    }
    return null;
  } catch (e) {
    if (e instanceof SetupError)
      return { status: e.status, body: { detail: e.message, reason: e.message } };
    throw e;
  }
}

// ---- for the checks --------------------------------------------------------------------------
/** A first key from the router's environment (keys.env), or a leftover key for a removed provider. */
export function poolControl(
  what: "envkey" | "leftover",
  provider: string,
  v = "FAKE-env-key-for-tests-0000",
): void {
  if (what === "leftover") return void st.leftovers.add(provider);
  const p = providerOf(provider);
  if (!p.keyVar) return;
  st.vars[p.keyVar] = "env";
  const ks = (st.keys[p.id] ??= []);
  const main: Key = {
    id: "main",
    hash: hashOf(v),
    last4: last4(v),
    label: null,
    tier: null,
    limits: null,
    extras: {},
    enabled: true,
    added: null,
    source: "env",
    rejected: null,
  };
  const at = ks.findIndex((k) => k.id === "main");
  if (at >= 0) ks[at] = main;
  else ks.unshift(main);
}

/** The key pages POST /web/open may open, with the accounts that can. */
export const keyPages = () => HELP;

/** Usable providers (for /v1/sources and /health). */
export function poolUsable(): { id: string; usable: boolean; anonymous: boolean }[] {
  return CATALOG.map((p) => ({ id: p.id, usable: usableOf(p), anonymous: p.noAuth }));
}
export const poolCount = () => CATALOG.length;

/** For GET /mock/state: variables set, each provider's keys, the outcomes taken. */
export function poolState() {
  const keys: Record<string, boolean> = {};
  for (const v of Object.keys(st.vars)) keys[v] = true;
  return {
    keys,
    poolKeys: Object.fromEntries(CATALOG.map((p) => [p.id, keysOf(p).map((k) => keyView(p, k))])),
    outcomes: st.outcomes,
    leftovers: [...st.leftovers],
  };
}
