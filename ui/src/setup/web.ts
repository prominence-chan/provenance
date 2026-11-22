// Client for provenance-core's sign-in API, through the UI server's /api/web/* proxy
// (server/app.ts). Shapes follow the router's contract; anything missing or malformed
// is normalised here so the screen never has to guess.

export type LoginState = "idle" | "preparing" | "open" | "verifying" | "signed_in" | "failed";

export interface Login {
  state: LoginState;
  reason: string | null;
}

export interface WebAccount {
  id: string;
  /** true / false, or null when the router has never checked. */
  signedIn: boolean | null;
  /** Unix seconds of the last check, null = never. */
  checkedAt: number | null;
  blocked: boolean;
  reason: string | null;
  today: number;
  dailyCap: number | null;
  login: Login;
}

export interface WebModel {
  id: string;
  label: string;
  tier: string;
  /** null = usable on every account; otherwise only on these account ids. */
  accounts: string[] | null;
}

export interface WebProvider {
  id: string;
  name: string;
  url: string;
  models: WebModel[];
  accounts: WebAccount[];
}

export interface BrowserStatus {
  mode: string;
  ready: boolean;
  version: string | null;
  preparing: boolean;
  error: string | null;
  /** 0-1 while preparing, when the router reports it (not in the contract yet). */
  progress: number | null;
}

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
    res = await fetch(`/api/web${path}`, {
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
  const j = (json ?? {}) as { detail?: unknown; down?: unknown };
  return {
    ok: false,
    status: res.status,
    detail: detailText(j.detail) ?? (res.statusText || `HTTP ${res.status}`),
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

const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);
const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

function parseLogin(v: unknown): Login {
  const o = (v ?? {}) as Record<string, unknown>;
  const states: LoginState[] = ["idle", "preparing", "open", "verifying", "signed_in", "failed"];
  const state = states.includes(o.state as LoginState) ? (o.state as LoginState) : "idle";
  return { state, reason: typeof o.reason === "string" && o.reason ? o.reason : null };
}

export function parseAccounts(v: unknown): WebAccounts | null {
  const o = (v ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o.providers)) return null;
  const b = (o.browser ?? {}) as Record<string, unknown>;
  const progress = num(b.progress);
  return {
    browser: {
      mode: str(b.mode, "bundled"),
      ready: b.ready !== false,
      version: typeof b.version === "string" ? b.version : null,
      preparing: b.preparing === true,
      error: typeof b.error === "string" && b.error ? b.error : null,
      progress: progress === null ? null : Math.max(0, Math.min(1, progress)),
    },
    providers: (o.providers as Record<string, unknown>[])
      .filter((p) => typeof p?.id === "string")
      .map((p) => ({
        id: p.id as string,
        name: str(p.name, p.id as string),
        url: str(p.url),
        models: (Array.isArray(p.models) ? (p.models as Record<string, unknown>[]) : [])
          .filter((m) => typeof m?.id === "string")
          .map((m) => ({
            id: m.id as string,
            label: str(m.label, m.id as string),
            tier: str(m.tier),
            accounts: Array.isArray(m.accounts) ? m.accounts.map(String) : null,
          })),
        accounts: (Array.isArray(p.accounts) ? (p.accounts as Record<string, unknown>[]) : [])
          .filter((a) => typeof a?.id === "string")
          .map((a) => ({
            id: a.id as string,
            signedIn: typeof a.signed_in === "boolean" ? a.signed_in : null,
            checkedAt: num(a.checked_at),
            blocked: a.blocked === true,
            reason: typeof a.reason === "string" && a.reason ? a.reason : null,
            today: num(a.today) ?? 0,
            dailyCap: num(a.daily_cap),
            login: parseLogin(a.login),
          })),
      })),
  };
}

export async function getAccounts(): Promise<
  { ok: true; value: WebAccounts } | { ok: false; why: Unavailable }
> {
  const r = await call<unknown>("GET", "/accounts");
  if (r.ok) {
    const value = parseAccounts(r.value);
    return value ? { ok: true, value } : { ok: false, why: "unsupported" };
  }
  return { ok: false, why: r.down ? "down" : "unsupported" };
}

export async function startLogin(provider: string, account: string): Promise<Result<Login>> {
  const r = await call<unknown>("POST", "/login", { provider, account });
  return r.ok ? { ok: true, value: parseLogin(r.value) } : r;
}

export async function getLogin(provider: string, account: string): Promise<Result<Login>> {
  const q = new URLSearchParams({ provider, account });
  const r = await call<unknown>("GET", `/login?${q}`);
  return r.ok ? { ok: true, value: parseLogin(r.value) } : r;
}

export function cancelLogin(provider: string, account: string): Promise<Result<unknown>> {
  return call("POST", "/login/cancel", { provider, account });
}

export function addAccount(account: string): Promise<Result<unknown>> {
  return call("POST", "/accounts", { account });
}

export function removeAccount(account: string): Promise<Result<unknown>> {
  return call("DELETE", `/accounts/${encodeURIComponent(account)}`);
}

export function prepareBrowser(): Promise<Result<unknown>> {
  return call("POST", "/browser/prepare", {});
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
  if (s < 3600) return `checked ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `checked ${Math.round(s / 3600)} h ago`;
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

/** Any account on any site signed in (and not blocked)? Decides the first-run prompt. */
export function anySignedIn(a: WebAccounts): boolean {
  return a.providers.some((p) => p.accounts.some((x) => x.signedIn === true));
}
