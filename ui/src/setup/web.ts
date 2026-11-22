// Client for provenance-core's setup API (sign-ins, per-site settings, API keys), through the
// UI server's /api/web/* and /api/pool/* proxy (server/app.ts). The shapes are the router's
// own (shared/router-api.ts); this module checks them and fills what an older router leaves
// out, so the screen never has to guess.

import type {
  KeysPut,
  LoginState,
  ProviderPatch,
  WindowBounds,
  WireAccount,
  WireBrowser,
  WireError,
  WireLogin,
  WirePoolProvider,
  WireProvider,
  WireWebModel,
} from "../../shared/router-api";

export type { LoginState } from "../../shared/router-api";

export type Login = Pick<WireLogin, "state" | "reason"> & { shown?: boolean };
export type WebAccount = Required<WireAccount>;
export type WebModel = WireWebModel;
export type WebProvider = Required<Omit<WireProvider, "accounts">> & { accounts: WebAccount[] };
export type BrowserStatus = Required<WireBrowser>;
export type PoolProvider = WirePoolProvider;

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

export async function getPoolKeys(): Promise<Result<PoolProvider[]>> {
  const r = await call<{ providers?: unknown }>("GET", "/pool/keys");
  if (!r.ok) return r;
  return { ok: true, value: objs(r.value?.providers) as unknown as PoolProvider[] };
}

export function setPoolKeys(provider: string, values: Record<string, string>) {
  const body: KeysPut = { values };
  return call<PoolProvider>("PUT", `/pool/keys/${encodeURIComponent(provider)}`, body);
}

export function clearPoolKeys(provider: string) {
  return call<PoolProvider>("DELETE", `/pool/keys/${encodeURIComponent(provider)}`);
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

/** Any account on any site signed in? Decides the first-run prompt. */
export function anySignedIn(a: WebAccounts): boolean {
  return a.providers.some((p) => p.accounts.some((x) => x.signed_in === true));
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
