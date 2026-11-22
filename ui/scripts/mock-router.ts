// A stand-in for provenance-core's sign-in API (`/web/*`) plus `/v1/models` and `/v1/sources`,
// with the state transitions the real router goes through. For developing the "Models &
// accounts" screen and for `npm run e2e:setup`; it never opens a browser.
//
//   node scripts/mock-router.ts                 # :4199, "fresh" (nothing signed in)
//   MOCK_SCENARIO=signed node scripts/mock-router.ts
//   MOCK_AUTO=1 ...                             # a sign-in completes by itself after 4 s
//   TIERLM_URL=http://127.0.0.1:4199 npm run dev
//
// Scenarios: fresh (browser ready, nothing signed in), signed (ChatGPT + Qwen on main,
// Gemini on b, one blocked), nobrowser (browser not prepared yet).
//
// Control routes (tests only, never on the real router):
//   POST /mock/reset    {"scenario": "fresh"}
//   POST /mock/finish   {"provider", "account", "ok": true | false, "reason"?}  the user
//                       finishes (or gives up on) signing in inside the window
//   POST /mock/down     {"down": true}   every other route then drops the connection
//   GET  /mock/state    the whole state, for assertions
//
// The router API it mirrors (built in provenance-core separately):
//   GET  /web/accounts, POST /web/accounts {account}, DELETE /web/accounts/{id}
//   POST /web/login {provider, account} -> {state:"open"} | 409 {detail}
//   GET  /web/login?provider&account     -> {state, reason}
//   POST /web/login/cancel {provider, account} -> {state:"idle"}
//   POST /web/browser/prepare

import http from "node:http";

type LoginState = "idle" | "preparing" | "open" | "verifying" | "signed_in" | "failed";

interface Account {
  signed_in: boolean | null;
  checked_at: number | null;
  blocked: boolean;
  reason: string | null;
  today: number;
  daily_cap: number;
  login: { state: LoginState; reason: string | null };
}

interface Model {
  id: string;
  label: string;
  tier: string;
  /** Source id in /v1/sources (the part before "/<tier>"). */
  source: string;
  accounts: string[] | null;
}

interface Provider {
  id: string;
  name: string;
  url: string;
  cap: number;
  models: Model[];
}

const PROVIDERS: Provider[] = [
  {
    id: "chatgpt-web",
    name: "ChatGPT",
    url: "https://chatgpt.com",
    cap: 500,
    models: [
      {
        id: "chatgpt-web/luna",
        label: "GPT-6 Luna",
        tier: "solstice",
        source: "luna",
        accounts: null,
      },
    ],
  },
  {
    id: "qwen-web",
    name: "Qwen",
    url: "https://chat.qwen.ai",
    cap: 2000,
    models: [
      {
        id: "qwen-web/qwen4-max",
        label: "Qwen4-Max",
        tier: "solstice",
        source: "qwen4-max",
        accounts: null,
      },
      {
        id: "qwen-web/qwen3.7-plus",
        label: "Qwen3.7-Plus",
        tier: "spark",
        source: "qwen3.7-plus",
        accounts: null,
      },
    ],
  },
  {
    id: "gemini-web",
    name: "Gemini",
    url: "https://gemini.google.com",
    cap: 300,
    models: [
      {
        id: "gemini-web/neon",
        label: "Gemini Neon",
        tier: "nova",
        source: "neon",
        accounts: ["b"],
      },
      {
        id: "gemini-web/hydrogen",
        label: "Gemini Hydrogen",
        tier: "ember",
        source: "hydrogen",
        accounts: null,
      },
      {
        id: "gemini-web/auto",
        label: "Gemini Auto",
        tier: "spark",
        source: "auto",
        accounts: null,
      },
    ],
  },
];

const VERSION = "157.0.8103.78";
const VERIFY_MS = Number(process.env.MOCK_VERIFY_MS ?? 1500);
const PREPARE_MS = Number(process.env.MOCK_PREPARE_MS ?? 3000);
const AUTO = process.env.MOCK_AUTO === "1";

interface State {
  browser: {
    mode: string;
    ready: boolean;
    version: string | null;
    preparing: boolean;
    error: string | null;
  };
  accountIds: string[];
  /** provider id -> account id -> account */
  accounts: Record<string, Record<string, Account>>;
  down: boolean;
}

const now = () => Math.floor(Date.now() / 1000);

function blank(cap: number): Account {
  return {
    signed_in: null,
    checked_at: null,
    blocked: false,
    reason: null,
    today: 0,
    daily_cap: cap,
    login: { state: "idle", reason: null },
  };
}

function scenario(name: string): State {
  const st: State = {
    browser: { mode: "bundled", ready: true, version: VERSION, preparing: false, error: null },
    accountIds: ["main"],
    accounts: {},
    down: false,
  };
  for (const p of PROVIDERS) st.accounts[p.id] = { main: blank(p.cap) };
  if (name === "nobrowser") {
    st.browser = { mode: "bundled", ready: false, version: null, preparing: false, error: null };
  }
  if (name === "signed") {
    st.accountIds = ["main", "b"];
    for (const p of PROVIDERS) st.accounts[p.id].b = blank(p.cap);
    const t = now();
    Object.assign(st.accounts["chatgpt-web"].main, {
      signed_in: true,
      checked_at: t - 300,
      today: 38,
    });
    Object.assign(st.accounts["chatgpt-web"].b, {
      signed_in: true,
      checked_at: t - 5400,
      today: 500,
      blocked: true,
      reason: "Daily limit reached; it resets at midnight.",
    });
    Object.assign(st.accounts["qwen-web"].main, {
      signed_in: true,
      checked_at: t - 60,
      today: 112,
    });
    Object.assign(st.accounts["gemini-web"].main, { signed_in: false, checked_at: t - 86400 });
    Object.assign(st.accounts["gemini-web"].b, { signed_in: true, checked_at: t - 900, today: 7 });
  }
  return st;
}

let state = scenario(process.env.MOCK_SCENARIO ?? "fresh");
/** Bumped on every reset so timers from an earlier scenario do nothing. */
let epoch = 0;
let prepareProgress = 0;

function later(ms: number, fn: () => void): void {
  const e = epoch;
  setTimeout(() => {
    if (e === epoch) fn();
  }, ms);
}

function startPrepare(): void {
  if (state.browser.ready || state.browser.preparing) return;
  state.browser.preparing = true;
  state.browser.error = null;
  prepareProgress = 0;
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    later((PREPARE_MS * i) / steps, () => {
      prepareProgress = i / steps;
      if (i < steps) return;
      if (process.env.MOCK_PREPARE_FAIL === "1") {
        state.browser.preparing = false;
        state.browser.error = "The download stopped: no internet connection.";
        return;
      }
      state.browser = {
        mode: "bundled",
        ready: true,
        version: VERSION,
        preparing: false,
        error: null,
      };
      // A sign-in that was waiting for the browser opens its window now.
      for (const accs of Object.values(state.accounts))
        for (const a of Object.values(accs))
          if (a.login.state === "preparing") a.login = { state: "open", reason: null };
    });
  }
}

function inProgress(): { provider: string; account: string } | null {
  for (const [provider, accs] of Object.entries(state.accounts))
    for (const [account, a] of Object.entries(accs))
      if (["preparing", "open", "verifying"].includes(a.login.state)) return { provider, account };
  return null;
}

function finish(provider: string, account: string, ok: boolean, reason?: string): boolean {
  const a = state.accounts[provider]?.[account];
  if (!a || a.login.state !== "open") return false;
  // The router sees the sign-in finish, closes the window and checks the site in the background.
  a.login = { state: "verifying", reason: null };
  later(VERIFY_MS, () => {
    if (a.login.state !== "verifying") return;
    if (ok) {
      a.login = { state: "signed_in", reason: null };
      Object.assign(a, { signed_in: true, checked_at: now(), blocked: false, reason: null });
    } else {
      const why =
        reason ??
        `${PROVIDERS.find((p) => p.id === provider)?.name} still shows its sign-in page. Sign in again and wait for the chat to appear.`;
      a.login = { state: "failed", reason: why };
      Object.assign(a, { signed_in: false, checked_at: now() });
    }
  });
  return true;
}

function accountsBody() {
  return {
    browser: state.browser.preparing
      ? { ...state.browser, progress: prepareProgress }
      : state.browser,
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      url: p.url,
      models: p.models.map(({ id, label, tier, accounts }) => ({ id, label, tier, accounts })),
      accounts: state.accountIds.map((id) => ({ id, ...state.accounts[p.id][id] })),
    })),
  };
}

function sourcesBody() {
  const tiers = ["nova", "solstice", "ember", "spark"].map((tier) => {
    const sources: unknown[] = [
      {
        id: "pool",
        label: "Token pool",
        kind: "pool",
        model: `pool/${tier}`,
        remaining: 0.9,
        busy: 0,
        available: true,
        pinnable: true,
      },
    ];
    for (const p of PROVIDERS)
      for (const m of p.models.filter((m) => m.tier === tier)) {
        const accs = Object.entries(state.accounts[p.id]).filter(
          ([id, a]) => a.signed_in && !a.blocked && (!m.accounts || m.accounts.includes(id)),
        );
        sources.push({
          id: m.source,
          label: m.label,
          kind: "web",
          model: `${m.source}/${tier}`,
          remaining: accs.length ? 0.8 : 0,
          busy: 0,
          available: accs.length > 0,
          pinnable: accs.length > 0,
        });
      }
    return { tier, sources };
  });
  return { tiers };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function target(body: Record<string, unknown>): { provider: string; account: string; a?: Account } {
  const provider = String(body.provider ?? "");
  const account = String(body.account ?? "");
  return { provider, account, a: state.accounts[provider]?.[account] };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const m = req.method ?? "GET";

  if (p.startsWith("/mock/")) {
    const body = m === "POST" ? await readJson(req) : {};
    if (p === "/mock/reset") {
      epoch++;
      state = scenario(String(body.scenario ?? "fresh"));
      return send(res, 200, { ok: true });
    }
    if (p === "/mock/down") {
      state.down = body.down !== false;
      return send(res, 200, { down: state.down });
    }
    if (p === "/mock/finish") {
      const { provider, account } = target(body);
      const ok = finish(provider, account, body.ok !== false, body.reason as string | undefined);
      return send(res, ok ? 200 : 409, { ok });
    }
    if (p === "/mock/state") return send(res, 200, state);
    return send(res, 404, { detail: "Not Found" });
  }

  if (state.down) {
    req.socket.destroy(); // like a router that isn't running
    return;
  }

  if (p === "/v1/models" && m === "GET") {
    return send(res, 200, {
      data: ["nova", "solstice", "ember", "spark"].map((id) => ({ id, owned_by: "tierlm" })),
    });
  }
  if (p === "/v1/sources" && m === "GET") return send(res, 200, sourcesBody());

  if (p === "/web/accounts" && m === "GET") return send(res, 200, accountsBody());
  if (p === "/web/accounts" && m === "POST") {
    const id = String((await readJson(req)).account ?? "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id))
      return send(res, 400, { detail: "Account names are lowercase letters and digits." });
    if (state.accountIds.includes(id))
      return send(res, 409, { detail: `There is already an account called ${id}.` });
    state.accountIds.push(id);
    for (const pr of PROVIDERS) state.accounts[pr.id][id] = blank(pr.cap);
    return send(res, 200, accountsBody());
  }
  const del = /^\/web\/accounts\/([^/]+)$/.exec(p);
  if (del && m === "DELETE") {
    const id = decodeURIComponent(del[1]);
    if (id === "main") return send(res, 409, { detail: "The main account can't be removed." });
    if (!state.accountIds.includes(id)) return send(res, 404, { detail: `No account ${id}.` });
    const busy = inProgress();
    if (busy?.account === id)
      return send(res, 409, { detail: "A sign-in is open on this account. Cancel it first." });
    state.accountIds = state.accountIds.filter((x) => x !== id);
    for (const pr of PROVIDERS) delete state.accounts[pr.id][id];
    return send(res, 200, accountsBody());
  }

  if (p === "/web/login" && m === "GET") {
    const { a } = target(Object.fromEntries(url.searchParams));
    if (!a) return send(res, 404, { detail: "No such site or account." });
    return send(res, 200, a.login);
  }
  if (p === "/web/login" && m === "POST") {
    const { provider, account, a } = target(await readJson(req));
    if (!a) return send(res, 404, { detail: "No such site or account." });
    const busy = inProgress();
    if (busy && (busy.provider !== provider || busy.account !== account)) {
      const name = PROVIDERS.find((x) => x.id === busy.provider)?.name;
      return send(res, 409, {
        detail: `A sign-in window is already open (${name}, account ${busy.account}). Finish or cancel it first.`,
      });
    }
    if (busy) return send(res, 200, a.login); // same one again: nothing new
    if (!state.browser.ready) {
      a.login = { state: "preparing", reason: null };
      startPrepare();
    } else {
      a.login = { state: "open", reason: null };
    }
    if (AUTO) {
      const waitOpen = () => {
        if (a.login.state === "preparing") return later(500, waitOpen);
        later(4000, () => finish(provider, account, true));
      };
      waitOpen();
    }
    return send(res, 200, { state: a.login.state });
  }
  if (p === "/web/login/cancel" && m === "POST") {
    const { a } = target(await readJson(req));
    if (!a) return send(res, 404, { detail: "No such site or account." });
    a.login = { state: "idle", reason: null };
    return send(res, 200, { state: "idle" });
  }
  if (p === "/web/browser/prepare" && m === "POST") {
    startPrepare();
    return send(res, 200, accountsBody().browser);
  }
  send(res, 404, { detail: "Not Found" });
}

export function startMockRouter(
  port: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { detail: String(e) }));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = addr && typeof addr === "object" ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        close: () =>
          new Promise<void>((r) => {
            epoch++;
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

if (import.meta.main) {
  const { url } = await startMockRouter(Number(process.env.PORT ?? 4199));
  console.log(`[mock-router] ${url} (scenario ${process.env.MOCK_SCENARIO ?? "fresh"})`);
}
