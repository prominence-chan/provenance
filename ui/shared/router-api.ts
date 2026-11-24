// The wire shapes of provenance-core's HTTP API as the app uses it, in one place: the UI's
// client (src/setup/web.ts, src/store/actions.ts) parses them, the UI server (server/app.ts)
// proxies them, the desktop shell (electron/router.ts) reads /health, and the mock router
// (scripts/mock-router.ts) produces them. The router side is provenance-core's server.py and
// web_setup.py (docs/TECHNICAL.md there, "Account setup from the app" and "Provenance.app's
// router"). Types only, plus the proxy's route table: no runtime code the browser bundle
// would have to carry beyond that.

// ---- GET /web/accounts ---------------------------------------------------------------

export type LoginState = "idle" | "preparing" | "open" | "verifying" | "signed_in" | "failed";

export type LoginMethod = "google" | "password" | "microsoft" | "apple" | "github" | "other";

export type SsoLoginMethod = "google" | "microsoft" | "apple";

export interface WireLogin {
  state: LoginState;
  reason: string | null;
  provider?: string;
  account?: string;
  since?: number;
  /** How the window ended: "cookie" (signed in), "closed", "timeout". */
  how?: string | null;
  /** Detected login method once verified. */
  method?: LoginMethod | null;
  /** POST /web/login/show only: whether macOS brought the window forward. */
  shown?: boolean;
}

export interface WireAccount {
  id: string;
  /** true / false, or null when no check has run yet. */
  signed_in: boolean | null;
  checked_at: number | null;
  /** The identity the site showed at the last check. */
  email?: string | null;
  blocked: boolean;
  reason: string | null;
  blocked_for_s?: number;
  today: number;
  daily_cap: number;
  /** A sign-in window holds this account's browser profile. */
  signing_in?: boolean;
  /** Its background browser window is open. */
  window_open?: boolean;
  login: { state: LoginState; reason: string | null; method?: LoginMethod | null };
  /** The site's plan for this account (ChatGPT: free or a paid one); absent from older routers. */
  plan?: AccountPlan;
  /** The plan's own name, e.g. "plus", "pro" (null when free or unknown). */
  plan_label?: string | null;
  /** The router won't use the account until the person confirms this (POST …/confirm). */
  needs_confirmation?: "paid_plan" | null;
  /** Saved sign-in and automatic re-sign-in (…/autologin); absent from older routers. */
  autologin?: WireAutologin;
}

export type AccountPlan = "free" | "paid" | "unknown";

export type AutologinResult = "ok" | "wrong_password" | "needs_person" | "error";

export type AutologinPaused = "wrong_password" | "needs_person";

export interface WireAutologin {
  /** This site can be signed back in automatically (via saved password or remembered SSO). */
  supported: boolean;
  /** Why not, in words to show (e.g. a Google account), when unsupported. */
  reason: string | null;
  enabled: boolean;
  /** A sign-in is saved (the password is in the keychain; it never comes back). */
  saved: boolean;
  username: string | null;
  attempts_today: number;
  last_try: { at: number; result: AutologinResult; detail: string | null } | null;
  /** Remembered login method from the sign-in flow or explicit setup; absent from older routers. */
  method?: LoginMethod | null;
  /** Host/label when method === "other". */
  method_label?: string | null;
  /** True when method === "password" and credentials haven't been saved yet. */
  needs_credentials?: boolean;
  /** True when an automatic re-sign-in retry is queued. */
  queued?: boolean;
  /** Seconds until next queued/allowed try. */
  next_try_in_s?: number | null;
  /** True while an auto-relogin attempt is running. */
  running?: boolean;
  /** Why automatic re-sign-in is paused until the person intervenes. */
  paused?: AutologinPaused | null;
  /** Optional status note from the router. */
  note?: string | null;
}

/**
 * PUT /web/accounts/{provider}/{account}/autologin. Write-only: never answered with the password.
 * Supports both email/password credential save and passwordless SSO auto-relogin enable.
 */
export type AutologinPut =
  | {
      agree: true;
      username: string;
      password: string;
      method?: "password";
    }
  | {
      agree: true;
      method: SsoLoginMethod;
    };

export interface WireWebModel {
  id: string;
  label: string;
  tier: string;
  model?: string;
  /** null: on every account. */
  accounts: string[] | null;
}

/** What decides whether a site is used: the app's own switch, the router's environment, the catalog. */
export type EnabledBy = "app" | "env" | "catalog" | "env-off";

export interface WireProvider {
  id: string;
  name: string;
  url: string;
  enabled?: boolean;
  enabled_by?: EnabledBy;
  /** Chats per account per day. */
  daily_cap?: number;
  shares_browser_with?: string | null;
  models: WireWebModel[];
  accounts: WireAccount[];
}

export interface WireBrowser {
  mode: string;
  source?: string;
  ready: boolean;
  version: string | null;
  preparing: boolean;
  /** look | download | unpack | copy while preparing. */
  stage?: string | null;
  /** 0-1 while downloading, else null. */
  progress?: number | null;
  error: string | null;
}

export interface WireWebAccounts {
  browser: WireBrowser;
  /** Every account id (accounts are global: one browser profile, every site). */
  accounts?: string[];
  providers: WireProvider[];
}

/** PATCH /web/providers/{id}. Answered with the provider as WireProvider. */
export interface ProviderPatch {
  enabled?: boolean;
  daily_cap?: number;
}

/** POST /web/login: where the sign-in window opens, in screen points. */
export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A 4xx from the router: `detail` (and `reason`) are written to be shown as they are. */
export interface WireError {
  detail?: unknown;
  reason?: string;
  state?: LoginState;
  /** Set by the UI server when the router doesn't answer at all. */
  down?: boolean;
}

// ---- GET /v1/sources -------------------------------------------------------------------

/** Why a source can't serve: no API key for any of its models, or no account signed in. */
export type SourceNeeds = "keys" | "signin";

export interface WireSource {
  id: string;
  label: string;
  kind: "pool" | "web" | string;
  /** Send this as the model to pin the source, e.g. "luna/solstice". */
  model: string;
  remaining: number;
  busy: number;
  available: boolean;
  pinnable: boolean;
  needs?: SourceNeeds | null;
}

export interface WireSources {
  tiers: { tier: string; sources: WireSource[] }[];
}

// ---- GET /pool/keys, PUT/DELETE /pool/keys/{provider} ----------------------------------

export interface WireKeyVar {
  name: string;
  set: boolean;
  /** "app": set from the app (kept in the router's home); "env": the router's environment. */
  from: "app" | "env" | null;
}

export interface WirePoolProvider {
  id: string;
  usable: boolean;
  /** Works without a key. */
  anonymous: boolean;
  vars: WireKeyVar[];
  models: number;
  tiers: string[];
  /** Each saved key (several per provider: one per account). Absent on an older router. */
  keys?: WirePoolKey[];
  /** Whether the provider's terms allow a second account's key. */
  multiple_keys?: WireMultipleKeys;
  /** ISO date: the last day it is used (Inception, whose API shuts down). */
  until?: string | null;
  /** Past `until`: its models are no longer offered. */
  expired?: boolean;
  /** The router's own line about it (a temporary provider), for logs and the assistant. */
  note?: string | null;
}

export type KeyTier = "free" | "paid";

/** One saved key: never the value, only enough to tell it apart. */
export interface WirePoolKey {
  /** "main": the provider's first key (its variable); "k" + 6 hex: a further one; "anon": the keyless slot. */
  id: string;
  /** The person's name for it; null: "Key 1", "Key 2" by position. */
  label: string | null;
  tier: KeyTier | null;
  usable: boolean;
  /** Why it isn't usable (the provider's answer to the check). */
  reason: string | null;
  /** ISO day it was saved. */
  added: string | null;
  /** The key's last four characters ("" for a key too short to show them safely). */
  last4: string | null;
  /** The router's view of its limits (shape the router's; the app doesn't read it). */
  limits?: unknown;
  /** false: kept but not used (PATCH {enabled}); PATCH {enabled: true} also clears a rejection. */
  enabled?: boolean;
  /** "app": saved from the app; "env": the router's environment (keys.env, the shell), not removable here. */
  source?: "app" | "env" | "anonymous";
}

/** yes; check_terms: the person should read the terms first; no: not for more free usage. */
export interface WireMultipleKeys {
  allowed: "yes" | "check_terms" | "no";
  note: string | null;
}

/** A provider taken out of the pool, and why. It is no longer listed in `providers`. */
export interface WireRemovedProvider {
  id: string;
  name: string;
  reason: string;
  /** ISO date it was taken out. */
  removed: string;
  /** /pool/keys: a key for it is still saved (ignored); DELETE /pool/keys/{id} forgets it. */
  leftover_key?: boolean;
  note?: string | null;
}

/** /pool/help `considered`: a provider looked at and not added. */
export interface WireConsidered {
  name: string;
  allowance: string | null;
  why_not: string;
  source: string;
}

export interface WirePoolKeys {
  providers: WirePoolProvider[];
  removed?: WireRemovedProvider[];
}

/** PUT /pool/keys/{provider}: set or replace the first key. Values go one way: never sent back. */
export interface KeysPut {
  values: Record<string, string>;
  label?: string;
  tier?: KeyTier;
}

/**
 * What the router found when it tried a key just saved (PUT, POST): ok null = not checked (only some
 * providers have a free check; the first request shows whether it works).
 */
export interface WireKeyCheck {
  ok: boolean | null;
  detail: string | null;
}

/** PUT and POST answer with the provider's view, the key's id and the check. */
export type WireKeySaved = WirePoolProvider & { key_id: string | null; check: WireKeyCheck };

/** POST /pool/keys/{provider}: one more key (409 when that key is saved already). */
export interface KeyPost {
  key: string;
  label?: string;
  tier?: KeyTier;
  /** The provider's other fields for this key (Cloudflare's account id), by variable name. */
  extras?: Record<string, string>;
}

/** PATCH /pool/keys/{provider}/{key_id}: answers with the provider's view. */
export interface KeyPatch {
  label?: string | null;
  tier?: KeyTier | null;
  enabled?: boolean;
}

// ---- GET /pool/help: how to get each provider's key, in the order to do them -------------
// provenance-core's pool_help.yaml, as JSON (docs/pool-keys.md there is the same data as text).

export interface WirePoolHelpField {
  /** The variable it fills, as /pool/keys names it (e.g. CLOUDFLARE_ACCOUNT_ID). */
  var: string;
  label: string;
  /** Where to find it, one line (may use **bold** and `code`). */
  where: string;
  format?: string;
}

/** anonymous: no key at all; free: a standing free allowance; trial: one-time credit; none. */
export type FreeTier = "anonymous" | "free" | "trial" | "none";

/** seen: the docs name the controls; docs-only: the page's labels couldn't be read; uncertain. */
export type HelpConfidence = "seen" | "docs-only" | "uncertain";

export interface WirePoolHelpProvider {
  /** The /pool/keys provider id. */
  id: string;
  name: string;
  free_tier?: FreeTier;
  confidence?: HelpConfidence | string;
  /** false: not worth setting up for the free pool (shown last, with `why_not`). Default true. */
  recommended?: boolean;
  why_not?: string | null;
  what_you_get: string;
  /** One sentence (older drafts: a list). */
  needs: string | string[];
  time_minutes: number;
  signup_url: string;
  keys_url: string;
  /** The variable the key goes into (PUT /pool/keys/{id} {values: {<key_var>: key}}); null: none. */
  key_var?: string | null;
  /** Numbered steps with the site's own control names (may use **bold** and `code`). */
  steps: string[];
  /** What a key looks like, e.g. "Starts with `gsk_`." */
  key_format: string;
  /** A regular expression a key matches, for a soft check (never blocks saving). */
  key_pattern?: string | null;
  extra_fields?: WirePoolHelpField[];
  gotchas: string[];
  terms_note?: string | null;
  checked?: string;
  sources?: string[];
  /**
   * Web accounts whose signed-in browser profile can open this provider's key page already signed
   * in (Google AI Studio with a Gemini account): POST /web/open {provider, account, url}.
   */
  open_with?: { provider: string; account: string }[];
  multiple_keys?: WireMultipleKeys;
  until?: string | null;
  /**
   * "person": it needs something only the person can do (a phone code, an e-mail approval, their
   * own details, a payment step): they do it alone with the written steps, outside the assisted
   * walk-through. Absent: the assistant can walk them through it.
   */
  setup?: "person" | null;
  /** Why it needs the person, one sentence. */
  why_person?: string | null;
  /** What earlier setups (POST …/outcome) came to. */
  experience?: WirePoolExperience;
}

/** A step people reported as not matching: its number (1-based) or, where it couldn't be told, its text. */
export interface WireTrouble {
  step: number | string;
  count: number;
  notes: string[];
}

export interface WirePoolExperience {
  tries: number;
  worked: number;
  last_worked: string | null;
  common_trouble: WireTrouble[];
}

export interface WirePoolHelp {
  checked?: string;
  /** Rules for an assistant walking someone through these (the app's setup assistant gets them). */
  assistant_notes?: string[];
  providers: WirePoolHelpProvider[];
  removed?: (Omit<WireRemovedProvider, "leftover_key" | "note"> & { key_var?: string })[];
  considered?: WireConsidered[];
}

// ---- POST /pool/help/{provider}/outcome: how a setup went, for the next person's guide -----
// No key, e-mail or other personal detail: step numbers, the site's control names, a result. The
// router refuses the whole body (400) for an unknown field or anything shaped like a key or e-mail.

export type OutcomeResult = "saved_working" | "saved_rejected" | "skipped" | "gave_up";

export interface OutcomePost {
  result: OutcomeResult;
  /** Roughly, from the key card shown (the provider opened) to saved. */
  minutes?: number;
  /** Which steps went as written; where one didn't, what the page showed instead. */
  step_notes?: { step: number; ok: boolean; note?: string }[];
  /** The site's control names as the person saw them. */
  labels_seen?: string[];
  source: "assistant" | "manual";
}

// ---- POST/GET /web/open: a provider's key page in a signed-in web account's window ---------

/** POST /web/open. `url` must be that provider entry's keys_url or signup_url. */
export interface WebOpenPost {
  provider: string;
  account: string;
  url: string;
}

// ---- GET /health -------------------------------------------------------------------------

export interface WireHealth {
  ok: boolean;
  service: string;
  version: string;
  pid: number;
  home: string;
  uptime_s: number;
  api: { providers: number; usable: number; models: number };
  web: { providers: number; enabled: string[] };
  tiers: string[];
}

// ---- the UI server's own /api/health ---------------------------------------------------

/** Who runs the router the app uses: the app's own ("bundled"), or one already running. */
export type RouterMode = "bundled" | "external";

export interface RouterInfo {
  url: string;
  up: boolean;
  /** e.g. "Starting provenance-core…", or why it couldn't be started. */
  message?: string;
  mode?: RouterMode;
  /** From the router's /health while it answers. */
  pid?: number;
  home?: string;
  version?: string;
}

export interface UiHealth {
  bin: { path: string; exists: boolean };
  router: RouterInfo;
}

// ---- what the UI server passes through to the router (/api/web/*, /api/pool/*) -----------

export interface ProxyRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The router's path (the UI's is /api + this). */
  path: RegExp;
}

const ID = "[A-Za-z0-9_.-]+";
export const ROUTER_ROUTES: ProxyRoute[] = [
  { method: "GET", path: /^\/web\/accounts$/ },
  { method: "POST", path: /^\/web\/accounts$/ },
  { method: "DELETE", path: new RegExp(`^/web/accounts/${ID}$`) },
  { method: "PUT", path: new RegExp(`^/web/accounts/${ID}/${ID}/autologin$`) },
  { method: "PATCH", path: new RegExp(`^/web/accounts/${ID}/${ID}/autologin$`) },
  { method: "DELETE", path: new RegExp(`^/web/accounts/${ID}/${ID}/autologin$`) },
  { method: "POST", path: new RegExp(`^/web/accounts/${ID}/${ID}/autologin/try$`) },
  { method: "POST", path: new RegExp(`^/web/accounts/${ID}/${ID}/confirm$`) },
  { method: "PATCH", path: new RegExp(`^/web/providers/${ID}$`) },
  { method: "GET", path: /^\/web\/login$/ },
  { method: "POST", path: /^\/web\/login$/ },
  { method: "POST", path: /^\/web\/login\/cancel$/ },
  { method: "POST", path: /^\/web\/login\/show$/ },
  { method: "POST", path: /^\/web\/browser\/prepare$/ },
  { method: "GET", path: /^\/web\/open$/ },
  { method: "POST", path: /^\/web\/open$/ },
  { method: "GET", path: /^\/pool\/keys$/ },
  { method: "GET", path: /^\/pool\/help$/ },
  { method: "PUT", path: new RegExp(`^/pool/keys/${ID}$`) },
  { method: "DELETE", path: new RegExp(`^/pool/keys/${ID}$`) },
  { method: "POST", path: new RegExp(`^/pool/keys/${ID}$`) },
  { method: "PATCH", path: new RegExp(`^/pool/keys/${ID}/${ID}$`) },
  { method: "DELETE", path: new RegExp(`^/pool/keys/${ID}/${ID}$`) },
  { method: "POST", path: new RegExp(`^/pool/help/${ID}/outcome$`) },
];
