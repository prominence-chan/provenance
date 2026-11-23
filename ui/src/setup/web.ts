// Client for provenance-core's setup API (sign-ins, per-site settings, API keys), through the
// UI server's /api/web/* and /api/pool/* proxy (server/app.ts). The shapes are the router's
// own (shared/router-api.ts); this module checks them and fills what an older router leaves
// out, so the screen never has to guess.

import type {
  AccountPlan,
  AutologinPut,
  AutologinResult,
  KeyPatch,
  KeyPost,
  KeysPut,
  KeyTier,
  OutcomePost,
  LoginState,
  ProviderPatch,
  WindowBounds,
  WireAccount,
  WireBrowser,
  WireError,
  WireLogin,
  WebOpenPost,
  WireAutologin,
  WireKeyCheck,
  WireMultipleKeys,
  WirePoolHelpProvider,
  WirePoolKey,
  WirePoolProvider,
  WireRemovedProvider,
  WireProvider,
  WireWebModel,
} from "../../shared/router-api";

export type { LoginState } from "../../shared/router-api";

export type Login = Pick<WireLogin, "state" | "reason"> & { shown?: boolean };
export type WebAccount = Omit<Required<WireAccount>, "autologin"> & {
  /** null: the router has no saved sign-in (an older one): nothing about it is shown. */
  autologin: WireAutologin | null;
};
export type Autologin = WireAutologin;
export type PoolHelp = Omit<
  WirePoolHelpProvider,
  "needs" | "recommended" | "multiple_keys" | "until" | "experience"
> & {
  needs: string[];
  recommended: boolean;
  multiple_keys: MultipleKeys | null;
  until: string | null;
  experience: Experience | null;
};
export type MultipleKeys = WireMultipleKeys;
export type RemovedProvider = WireRemovedProvider;
export type KeyCheck = WireKeyCheck;
export type PoolKey = Omit<Required<WirePoolKey>, "limits"> & { limits: unknown };
/** Where people got stuck: at a step (1-based), or anywhere (null). */
export interface Trouble {
  step: number | null;
  note: string;
}
export interface Experience {
  tries: number;
  worked: number;
  last_worked: string | null;
  common_trouble: Trouble[];
}
export type WebModel = WireWebModel;
export type WebProvider = Required<Omit<WireProvider, "accounts">> & {
  accounts: WebAccount[];
  /** The router can turn it on or off and change its daily cap (an older one can't). */
  changeable: boolean;
};
export type BrowserStatus = Required<WireBrowser>;
export type PoolProvider = Omit<WirePoolProvider, "keys" | "multiple_keys" | "until"> & {
  /** null: a router from before several keys per provider (one key, set with PUT). */
  keys: PoolKey[] | null;
  multiple_keys: MultipleKeys | null;
  until: string | null;
};

export interface WebAccounts {
  browser: BrowserStatus;
  providers: WebProvider[];
}

/** Why a read gave no accounts: the router is down, or it has no /web API (older build). */
export type Unavailable = "down" | "unsupported";

export type Result<T> =
  { ok: true; value: T } | { ok: false; status: number; detail: string; down: boolean };

async function call<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, detail: "Provenance's own server isn't answering.", down: true };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // leave null
  }
  if (res.ok) return { ok: true, value: json as T };
  const j = (json ?? {}) as WireError;
  return {
    ok: false,
    status: res.status,
    detail: detailText(j.detail) ?? j.reason ?? (res.statusText || `HTTP ${res.status}`),
    down: j.down === true || res.status === 502,
  };
}

/** FastAPI-style detail: a string, or a list of {msg}. */
function detailText(d: unknown): string | null {
  if (typeof d === "string" && d) return d;
  if (Array.isArray(d)) {
    const msgs = d.map((x) => (x as { msg?: unknown })?.msg).filter((m) => typeof m === "string");
    if (msgs.length) return msgs.join("; ");
  }
  return null;
}

type Obj = Record<string, unknown>;
const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
const objs = (v: unknown): Obj[] =>
  Array.isArray(v) ? (v as Obj[]).filter((x) => typeof x?.id === "string") : [];

const STATES: LoginState[] = ["idle", "preparing", "open", "verifying", "signed_in", "failed"];

function parseLogin(v: unknown): Login {
  const o = (v ?? {}) as Obj;
  const state = STATES.includes(o.state as LoginState) ? (o.state as LoginState) : "idle";
  return {
    state,
    reason: strOrNull(o.reason),
    ...(typeof o.shown === "boolean" ? { shown: o.shown } : {}),
  };
}

const PLANS: AccountPlan[] = ["free", "paid", "unknown"];
const RESULTS: AutologinResult[] = ["ok", "wrong_password", "needs_person", "error"];

function parseAutologin(v: unknown): WireAutologin | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Obj;
  const t = (o.last_try ?? null) as Obj | null;
  return {
    supported: o.supported === true,
    reason: strOrNull(o.reason),
    enabled: o.enabled === true,
    saved: o.saved === true,
    username: strOrNull(o.username),
    attempts_today: num(o.attempts_today) ?? 0,
    last_try:
      t && typeof t === "object" && num(t.at) !== null
        ? {
            at: num(t.at)!,
            result: RESULTS.includes(t.result as AutologinResult)
              ? (t.result as AutologinResult)
              : "error",
            detail: strOrNull(t.detail),
          }
        : null,
  };
}

function parseAccount(a: Obj): WebAccount {
  return {
    id: a.id as string,
    signed_in: typeof a.signed_in === "boolean" ? a.signed_in : null,
    checked_at: num(a.checked_at),
    email: strOrNull(a.email),
    blocked: a.blocked === true,
    reason: strOrNull(a.reason),
    blocked_for_s: num(a.blocked_for_s) ?? 0,
    today: num(a.today) ?? 0,
    daily_cap: num(a.daily_cap) ?? 0,
    signing_in: a.signing_in === true,
    window_open: a.window_open === true,
    login: parseLogin(a.login),
    plan: PLANS.includes(a.plan as AccountPlan) ? (a.plan as AccountPlan) : "unknown",
    plan_label: strOrNull(a.plan_label),
    needs_confirmation: a.needs_confirmation === "paid_plan" ? "paid_plan" : null,
    autologin: parseAutologin(a.autologin),
  };
}

export function parseProvider(p: Obj): WebProvider {
  const models = objs(p.models).map((m) => ({
    id: m.id as string,
    label: str(m.label, m.id as string),
    tier: str(m.tier),
    model: str(m.model),
    accounts: Array.isArray(m.accounts) ? m.accounts.map(String) : null,
  }));
  const accounts = objs(p.accounts).map(parseAccount);
  const by = p.enabled_by;
  return {
    id: p.id as string,
    name: str(p.name, p.id as string),
    url: str(p.url),
    enabled: p.enabled !== false,
    enabled_by:
      by === "app" || by === "env" || by === "catalog" || by === "env-off" ? by : "catalog",
    daily_cap: num(p.daily_cap) ?? accounts[0]?.daily_cap ?? 0,
    shares_browser_with: strOrNull(p.shares_browser_with),
    models,
    accounts,
    changeable: typeof by === "string",
  };
}

export function parseAccounts(v: unknown): WebAccounts | null {
  const o = (v ?? {}) as Obj;
  if (!Array.isArray(o.providers)) return null;
  const b = (o.browser ?? {}) as Obj;
  const progress = num(b.progress);
  return {
    browser: {
      mode: str(b.mode, "bundled"),
      source: str(b.source, "cft"),
      ready: b.ready !== false,
      version: strOrNull(b.version),
      preparing: b.preparing === true,
      stage: strOrNull(b.stage),
      error: strOrNull(b.error),
      progress: progress === null ? null : Math.max(0, Math.min(1, progress)),
    },
    providers: objs(o.providers).map(parseProvider),
  };
}

export async function getAccounts(): Promise<
  { ok: true; value: WebAccounts } | { ok: false; why: Unavailable }
> {
  const r = await call<unknown>("GET", "/web/accounts");
  if (r.ok) {
    const value = parseAccounts(r.value);
    return value ? { ok: true, value } : { ok: false, why: "unsupported" };
  }
  return { ok: false, why: r.down ? "down" : "unsupported" };
}

export async function startLogin(
  provider: string,
  account: string,
  bounds?: WindowBounds,
): Promise<Result<Login>> {
  const r = await call<unknown>("POST", "/web/login", { provider, account, bounds });
  return r.ok ? { ok: true, value: parseLogin(r.value) } : r;
}

export async function getLogin(provider: string, account: string): Promise<Result<Login>> {
  const q = new URLSearchParams({ provider, account });
  const r = await call<unknown>("GET", `/web/login?${q}`);
  return r.ok ? { ok: true, value: parseLogin(r.value) } : r;
}

export function cancelLogin(provider: string, account: string): Promise<Result<unknown>> {
  return call("POST", "/web/login/cancel", { provider, account });
}

/** Bring the open sign-in window back to the front. */
export async function showLogin(provider: string, account: string): Promise<Result<Login>> {
  const r = await call<unknown>("POST", "/web/login/show", { provider, account });
  return r.ok ? { ok: true, value: parseLogin(r.value) } : r;
}

export function addAccount(account: string): Promise<Result<unknown>> {
  return call("POST", "/web/accounts", { account });
}

export function removeAccount(account: string): Promise<Result<unknown>> {
  return call("DELETE", `/web/accounts/${encodeURIComponent(account)}`);
}

export function prepareBrowser(): Promise<Result<unknown>> {
  return call("POST", "/web/browser/prepare", {});
}

/** Turn a site on or off, change its daily cap: kept by the router, answered with the site. */
export async function updateProvider(
  provider: string,
  patch: ProviderPatch,
): Promise<Result<WebProvider>> {
  const r = await call<unknown>("PATCH", `/web/providers/${encodeURIComponent(provider)}`, patch);
  return r.ok ? { ok: true, value: parseProvider((r.value ?? {}) as Obj) } : r;
}

const accountPath = (provider: string, account: string) =>
  `/web/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(account)}`;

/**
 * Save a sign-in for automatic re-sign-in. The password goes in this one request body and
 * nowhere else: the router keeps it in the keychain and never sends it back.
 */
export function saveAutologin(
  provider: string,
  account: string,
  username: string,
  password: string,
): Promise<Result<unknown>> {
  const body: AutologinPut = { agree: true, username, password };
  return call("PUT", `${accountPath(provider, account)}/autologin`, body);
}

export function setAutologinEnabled(provider: string, account: string, enabled: boolean) {
  return call("PATCH", `${accountPath(provider, account)}/autologin`, { enabled });
}

export function forgetAutologin(provider: string, account: string) {
  return call("DELETE", `${accountPath(provider, account)}/autologin`);
}

export function tryAutologin(provider: string, account: string) {
  return call("POST", `${accountPath(provider, account)}/autologin/try`, {});
}

/** "Use it anyway": the person accepts that a paid plan's own usage is spent. */
export function confirmPaidPlan(provider: string, account: string) {
  return call("POST", `${accountPath(provider, account)}/confirm`, { confirm: "paid_plan" });
}

/** /pool/help as the app uses it: every list a list, every field there. */
export interface PoolHelpData {
  checked: string;
  notes: string[];
  providers: PoolHelp[];
  removed: RemovedProvider[];
}

const ALLOWED = ["yes", "check_terms", "no"];
function parseMultiple(v: unknown): MultipleKeys | null {
  const o = (v ?? {}) as Obj;
  if (!ALLOWED.includes(o.allowed as string)) return null;
  return { allowed: o.allowed as MultipleKeys["allowed"], note: strOrNull(o.note) };
}

/** A date the router gives (2026-12-28), or null when it isn't one. */
function isoDate(v: unknown): string | null {
  const s = strOrNull(v);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
}

function parseRemoved(v: unknown): RemovedProvider[] {
  return objs(v).map((r) => ({
    id: r.id as string,
    name: str(r.name, r.id as string),
    reason: str(r.reason),
    date: str(r.date),
  }));
}

function parseExperience(v: unknown): Experience | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Obj;
  const trouble = (Array.isArray(o.common_trouble) ? o.common_trouble : [])
    .map((t): Trouble | null => {
      if (typeof t === "string") return t.trim() ? { step: null, note: t.trim() } : null;
      const x = (t ?? {}) as Obj;
      const note = str(x.note, str(x.text)).trim();
      const step = num(x.step);
      return note ? { step: step && step >= 1 ? Math.round(step) : null, note } : null;
    })
    .filter((t) => t !== null);
  return {
    tries: num(o.tries) ?? 0,
    worked: num(o.worked) ?? 0,
    last_worked: strOrNull(o.last_worked),
    common_trouble: trouble,
  };
}

const TIERS: KeyTier[] = ["free", "paid"];
function parseKey(k: Obj): PoolKey {
  return {
    id: k.id as string,
    label: strOrNull(k.label),
    tier: TIERS.includes(k.tier as KeyTier) ? (k.tier as KeyTier) : null,
    usable: k.usable === true,
    reason: strOrNull(k.reason),
    added: strOrNull(k.added),
    last4: strOrNull(k.last4)?.slice(-4) ?? null,
    limits: k.limits ?? null,
    enabled: k.enabled !== false,
  };
}

function parsePoolProvider(p: Obj): PoolProvider {
  return {
    ...(p as unknown as WirePoolProvider),
    keys: Array.isArray(p.keys) ? objs(p.keys).map(parseKey) : null,
    multiple_keys: parseMultiple(p.multiple_keys),
    until: isoDate(p.until),
  };
}

const FREE_TIERS = ["anonymous", "free", "trial", "none"];
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : [];

/** How to get each provider's key, in the order to do them; null from a router without it. */
export async function getPoolHelp(): Promise<PoolHelpData | null> {
  const r = await call<Obj>("GET", "/pool/help");
  if (!r.ok || !r.value) return null;
  const providers = objs(r.value.providers).map((p): PoolHelp => ({
    id: p.id as string,
    name: str(p.name, p.id as string),
    free_tier: FREE_TIERS.includes(p.free_tier as string)
      ? (p.free_tier as PoolHelp["free_tier"])
      : undefined,
    confidence: str(p.confidence),
    recommended: p.recommended !== false,
    why_not: strOrNull(p.why_not),
    what_you_get: str(p.what_you_get),
    needs: strs(p.needs),
    time_minutes: num(p.time_minutes) ?? 0,
    signup_url: safeUrl(p.signup_url),
    keys_url: safeUrl(p.keys_url),
    key_var: strOrNull(p.key_var),
    steps: strs(p.steps),
    key_format: str(p.key_format),
    key_pattern: strOrNull(p.key_pattern),
    extra_fields: (Array.isArray(p.extra_fields) ? (p.extra_fields as Obj[]) : [])
      .map((f) => {
        const v = str(f?.var, str(f?.id)); // `id` in drafts of the contract
        return { var: v, label: str(f?.label, v), where: str(f?.where), format: str(f?.format) };
      })
      .filter((f) => f.var),
    gotchas: strs(p.gotchas),
    terms_note: strOrNull(p.terms_note),
    checked: str(p.checked),
    open_with: (Array.isArray(p.open_with) ? (p.open_with as Obj[]) : [])
      .filter((o) => typeof o?.provider === "string" && typeof o?.account === "string")
      .map((o) => ({ provider: o.provider as string, account: o.account as string })),
    multiple_keys: parseMultiple(p.multiple_keys),
    until: isoDate(p.until),
    experience: parseExperience(p.experience),
  }));
  return {
    checked: str(r.value.checked),
    notes: strs(r.value.assistant_notes),
    providers,
    removed: parseRemoved(r.value.removed),
  };
}

/** POST /web/open: a provider's key page in a signed-in web account's own window. */
export function openWebPage(provider: string, account: string, url: string) {
  const body: WebOpenPost = { provider, account, url };
  return call<Obj>("POST", "/web/open", body);
}

/** GET /web/open: what is open; null when the router has no such window (an older one). */
export async function getWebOpen(): Promise<{
  open: boolean;
  provider: string | null;
  account: string | null;
} | null> {
  const r = await call<Obj>("GET", "/web/open");
  if (!r.ok) return null;
  const v = r.value ?? {};
  const state = str(v.state);
  return {
    open: v.open === true || state === "open",
    provider: strOrNull(v.provider),
    account: strOrNull(v.account),
  };
}

/** Only https pages open from the app (a keys page, a sign-up page). */
function safeUrl(v: unknown): string {
  const s = str(v);
  try {
    return new URL(s).protocol === "https:" ? s : "";
  } catch {
    return "";
  }
}

/** GET /pool/keys: each provider, its keys, and the providers taken out of the pool. */
export async function getPoolKeysAll(): Promise<
  Result<{ providers: PoolProvider[]; removed: RemovedProvider[] }>
> {
  const r = await call<Obj>("GET", "/pool/keys");
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      providers: objs(r.value?.providers).map(parsePoolProvider),
      removed: parseRemoved(r.value?.removed),
    },
  };
}

export async function getPoolKeys(): Promise<Result<PoolProvider[]>> {
  const r = await getPoolKeysAll();
  return r.ok ? { ok: true, value: r.value.providers } : r;
}

/** What a save answers: the provider as the router has it now (when it says), and its check. */
export interface SaveAnswer {
  provider: PoolProvider | null;
  check: KeyCheck | null;
  /** The key's own answer to POST, when the router answers with the key. */
  key: PoolKey | null;
}

function saveAnswer(v: unknown): SaveAnswer {
  const o = (v ?? {}) as Obj;
  const c = (o.check ?? null) as Obj | null;
  const check =
    c && typeof c === "object" && typeof c.ok === "boolean"
      ? { ok: c.ok, detail: strOrNull(c.detail) }
      : null;
  const isProvider = Array.isArray(o.vars);
  const k = (o.key ?? (!isProvider && typeof o.id === "string" ? o : null)) as Obj | null;
  return {
    provider: isProvider && typeof o.id === "string" ? parsePoolProvider(o) : null,
    check,
    key: k && typeof k.id === "string" ? parseKey(k) : null,
  };
}

/** PUT: set (or replace) the provider's first key. */
export async function setPoolKeys(
  provider: string,
  values: Record<string, string>,
): Promise<Result<SaveAnswer>> {
  const body: KeysPut = { values };
  const r = await call<unknown>("PUT", `/pool/keys/${encodeURIComponent(provider)}`, body);
  return r.ok ? { ok: true, value: saveAnswer(r.value) } : r;
}

/** POST: one more key beside the saved ones. */
export async function addPoolKey(provider: string, body: KeyPost): Promise<Result<SaveAnswer>> {
  const r = await call<unknown>("POST", `/pool/keys/${encodeURIComponent(provider)}`, body);
  return r.ok ? { ok: true, value: saveAnswer(r.value) } : r;
}

const keyPath = (provider: string, key: string) =>
  `/pool/keys/${encodeURIComponent(provider)}/${encodeURIComponent(key)}`;

export function updatePoolKey(provider: string, key: string, patch: KeyPatch) {
  return call<unknown>("PATCH", keyPath(provider, key), patch);
}

export function removePoolKey(provider: string, key: string) {
  return call<unknown>("DELETE", keyPath(provider, key));
}

/** All of a provider's keys. */
export function clearPoolKeys(provider: string) {
  return call<unknown>("DELETE", `/pool/keys/${encodeURIComponent(provider)}`);
}

/** POST /pool/help/{provider}/outcome. false: this router doesn't take outcomes (an older one). */
export async function postPoolOutcome(provider: string, body: OutcomePost): Promise<boolean> {
  const r = await call<unknown>("POST", `/pool/help/${encodeURIComponent(provider)}/outcome`, body);
  return r.ok || !(r.status === 404 || r.status === 405);
}

/** "Key 1", "Key 2": a key's name when the person gave it none. */
export const keyName = (k: PoolKey, i: number): string => k.label?.trim() || `Key ${i + 1}`;

/** "Available until 28 Dec 2026" (the date's spaces bound). */
export function untilText(iso: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  const day = d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Available until ${day.replace(/ /g, "\u00a0")}`;
}

// ---- small helpers the screen shares -----------------------------------------------

/** "main" -> "Main account", "b" -> "Account B", "work" -> "Account work". */
export function accountName(id: string): string {
  if (id === "main") return "Main account";
  return `Account ${id.length === 1 ? id.toUpperCase() : id}`;
}

/** The next free single-letter id after "main": b, c, d, ... */
export function nextAccountId(taken: string[]): string {
  for (let c = 98; c <= 122; c++) {
    const id = String.fromCharCode(c);
    if (!taken.includes(id)) return id;
  }
  return `a${taken.length + 1}`;
}

/** "checked just now", "checked 5 min ago", "checked 3 h ago", "checked yesterday", "checked Nov 2". */
export function checkedText(at: number | null): string {
  if (at === null) return "never checked";
  const s = Date.now() / 1000 - at;
  if (s < 90) return "checked just now";
  if (s < 3600) return `checked ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `checked ${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return "checked yesterday";
  return `checked ${new Date(at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** "chatgpt.com" from "https://chatgpt.com/". */
export function siteHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Accounts this model is usable on. */
export function modelOn(m: WebModel, account: string): boolean {
  return !m.accounts || m.accounts.includes(account);
}

/** True while a sign-in for this account is in flight on the router. */
export function loginActive(s: LoginState): boolean {
  return s === "preparing" || s === "open" || s === "verifying";
}

/**
 * Signed in and the router may use it: a paid ChatGPT plan waits for the person's "Use it
 * anyway" first (connected, not in use).
 */
export function inUse(a: WebAccount): boolean {
  return a.signed_in === true && a.needs_confirmation === null;
}

/** Any account on any site signed in and in use? Decides the first-run prompt. */
export function anySignedIn(a: WebAccounts): boolean {
  return a.providers.some((p) => p.accounts.some(inUse));
}

/** "Free", "Plus", "Paid"; null when the router doesn't know. */
export function planText(a: WebAccount): string | null {
  if (a.plan === "free") return "Free";
  if (a.plan !== "paid") return null;
  const l = a.plan_label?.trim();
  return l ? l.charAt(0).toUpperCase() + l.slice(1) : "Paid";
}

/** "14:02" today, "yesterday 14:02", "Nov 2, 14:02". */
export function whenText(at: number): string {
  const d = new Date(at * 1000);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return time;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** Sites worth showing: those with at least one model (a site without any has nothing to sign in for). */
export function shownProviders(a: WebAccounts): WebProvider[] {
  return a.providers.filter((p) => p.models.length > 0);
}

/**
 * Where the sign-in window should open: beside the app's window, on the side with room, else
 * over the app's right half; never off the screen. In screen points, as the router wants them.
 */
export function besideThisWindow(): WindowBounds {
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  const ax = s.availLeft ?? 0;
  const ay = s.availTop ?? 0;
  const aw = s.availWidth;
  const ah = s.availHeight;
  const width = Math.max(480, Math.min(1000, aw - 40));
  const height = Math.max(480, Math.min(820, ah - 40));
  const gap = 12;
  let left = window.screenX + window.outerWidth + gap;
  if (left + width > ax + aw) left = window.screenX - width - gap;
  if (left < ax) left = ax + aw - width - 20;
  const top = Math.min(Math.max(window.screenY + 30, ay + 10), ay + ah - height - 10);
  return {
    left: Math.round(Math.max(ax, left)),
    top: Math.round(Math.max(ay, top)),
    width,
    height,
  };
}
