// The UI server as a library: one HTTP server on one port that serves
//   - the React app (Vite dev middleware with HMR, or the built `dist/`)
//   - GET /api/info    -> defaults for the UI (cwd, binary, tiers source)
//   - GET /api/tiers   -> tier list from tierlm (/v1/models, owned_by=tierlm)
//   - GET /api/sources -> each tier's sources and usage left (provenance-core /v1/sources)
//   - GET /api/health  -> is the provenance binary there, is provenance-core up (and whose it is)
//   - GET /api/usage   -> which models served a turn (provenance-core /v1/pcore/usage), and what
//                        fitting its history took (its "context" flags)
//   - GET /api/fallbacks -> Claude Code / Codex health and models (fallback/health.ts; ?refresh=1)
//   - /api/web/*, /api/pool/* -> provenance-core's setup API (accounts, sign-in window, browser,
//                        per-site settings, API keys); the routes are shared/router-api.ts's table
//   - WS  /rpc         -> JSON-RPC relay to `provenance app-server` (see bridge.ts)
//   - WS  /rpc/codex   -> a second `provenance app-server` for "Run Codex through Provenance": its
//                        own home, linked to your Codex login, OpenAI provider (fallback/codex-home.ts),
//                        model requests through the router's pass-through (fallback/codex-route.ts);
//                        started on first use
//   - WS  /rpc/fallback -> threads run by the claude / codex CLIs, same protocol (fallback/backend.ts)
//   - WS  /rpc/orchestrator -> tier threads driven by the Experimental / Hyperexperimental
//                        orchestrators, same protocol (orchestrator/backend.ts); they use a third
//                        `provenance app-server` of their own (orchestrator/appserver.ts), started
//                        on first use
//
// Used by server/main.ts (the `npm run dev` / `npm start` CLI) and by the desktop
// app (electron/main.ts), which runs it inside Electron's own Node.

import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import {
  ROUTER_ROUTES,
  type RouterInfo,
  type UiHealth,
  type WireHealth,
} from "../shared/router-api.ts";
import { AppServerBridge } from "./bridge.ts";
import { FallbackBackend } from "./fallback/backend.ts";
import { defaultSearchPath } from "./fallback/cli.ts";
import { codexHomeEnv, prepareCodexHome } from "./fallback/codex-home.ts";
import { codexPvArgs, maskCodexSubKey } from "./fallback/codex-route.ts";
import { getFallbacks, type FallbackEnv } from "./fallback/health.ts";
import { AppServerProcess } from "./orchestrator/appserver.ts";
import { capsFromEnv, OrchestratorBackend } from "./orchestrator/backend.ts";
import { makeCallModel } from "./orchestrator/router.ts";

/** Used when tierlm is unreachable. Keep in sync with tierlm's tier names. */
const FALLBACK_TIERS = ["nova", "solstice", "ember", "spark"];
const DEFAULT_TIER = "solstice";

/** What the host knows about the router beyond what it answers (the app starting its own). */
export type RouterStatus = Pick<RouterInfo, "up" | "message" | "mode">;

/** Where provenance-core is, and the bearer token it wants (the app's own router has one). */
export interface RouterConnection {
  url: string;
  token?: string;
}

export interface UiServerOptions {
  /** Directory that holds index.html (prod) or the Vite project root (dev). */
  root: string;
  /** Serve `${root}/dist` (true) or run Vite in middleware mode (false). */
  prod: boolean;
  port: number;
  host: string;
  bin: string;
  /** The router, or a getter for it: the app's own router can move to another port on a restart. */
  router: RouterConnection | (() => RouterConnection);
  /** Extra environment for `provenance app-server` (e.g. PROVENANCE_HOME for a scratch run). */
  appServerEnv?: NodeJS.ProcessEnv;
  /** Returns the current default cwd and whether it came from a launcher. */
  cwd: () => { defaultCwd: string; fromLauncher: boolean };
  /** Extra router state from the host (e.g. the app trying to start it). */
  routerStatus?: () => RouterStatus | undefined;
  clientTitle?: string;
  /**
   * Where fallback threads (Claude Code / Codex CLI) and the "through Provenance" home live.
   * Default ~/.provenance-ui; the desktop app passes its Application Support folder.
   */
  dataDir?: string;
  /** Where to look for claude / codex (PATH-style); default PATH plus the usual install folders. */
  fallbackSearchPath?: string;
  /** Where stock Codex keeps its login (default $CODEX_HOME or ~/.codex). */
  codexLoginHome?: string;
}

export interface UiServer {
  port: number;
  url: string;
  bridge: AppServerBridge;
  close: () => Promise<void>;
}

export async function startUiServer(opts: UiServerOptions): Promise<UiServer> {
  const conn = (): RouterConnection => {
    const c = typeof opts.router === "function" ? opts.router() : opts.router;
    return { url: c.url.replace(/\/$/, ""), token: c.token };
  };
  /** fetch() to the router, with its token when it has one. */
  const routerFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
    const { url, token } = conn();
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${url}${path}`, { ...init, headers });
  };
  const bridge = new AppServerBridge({
    bin: opts.bin,
    clientInfo: {
      name: "provenance_ui",
      title: opts.clientTitle ?? "Provenance UI",
      version: "0.1.0",
    },
    // app-server's built-in tierlm provider reads these at start (codex-rs model-provider-info:
    // TIERLM_BASE_URL, TIERLM_TOKEN), so the agent always talks to the same router as this page.
    // Without a token of ours, an inherited TIERLM_TOKEN (your router's) is left as it is.
    env: () => {
      const { url, token } = conn();
      return {
        ...opts.appServerEnv,
        TIERLM_BASE_URL: `${url}/v1`,
        ...(token ? { TIERLM_TOKEN: token } : {}),
      };
    },
  });
  bridge.start();

  // ---- fallbacks: Claude Code, Codex in the background, Codex through Provenance ----------
  const dataDir = opts.dataDir ?? path.join(homedir(), ".provenance-ui");
  const codexHome = path.join(dataDir, "codex-home");
  const fallbackEnv = (): FallbackEnv => ({
    searchPath: opts.fallbackSearchPath ?? defaultSearchPath(),
    provenanceBin: opts.bin,
    codexHome,
    codexLoginHome: opts.codexLoginHome,
    router: conn(),
  });
  const fallback = new FallbackBackend({
    dir: path.join(dataDir, "fallback"),
    searchPath: () => fallbackEnv().searchPath,
  });
  /** The second app-server, started when the page first opens /rpc/codex. */
  let codexBridge: AppServerBridge | null = null;
  const codexServer = (): AppServerBridge => {
    if (codexBridge) return codexBridge;
    try {
      prepareCodexHome(codexHome, opts.codexLoginHome);
    } catch (e) {
      console.warn("[codex-home]", String(e));
    }
    codexBridge = new AppServerBridge({
      bin: opts.bin,
      // read at every start: the app's own router can come back on another port
      args: () => codexPvArgs(conn()),
      mask: maskCodexSubKey,
      clientInfo: {
        name: "provenance_ui",
        title: opts.clientTitle ?? "Provenance UI",
        version: "0.1.0",
      },
      env: () => codexHomeEnv(codexHome),
      log: (...a) => console.log("[codex-bridge]", ...a),
    });
    codexBridge.start();
    return codexBridge;
  };

  // ---- orchestrators: Experimental / Hyperexperimental threads on the tiers ----------------
  // Their own app-server: same binary, home and router as the main one, run in an empty folder.
  let orchestratorServer: AppServerProcess | null = null;
  const orchestrator = new OrchestratorBackend({
    dir: path.join(dataDir, "orchestrator"),
    appServer: () =>
      (orchestratorServer ??= new AppServerProcess({
        bin: opts.bin,
        runDir: path.join(dataDir, "orchestrator", "run"),
        env: () => {
          const { url, token } = conn();
          return {
            ...opts.appServerEnv,
            TIERLM_BASE_URL: `${url}/v1`,
            ...(token ? { TIERLM_TOKEN: token } : {}),
          };
        },
      })),
    callModel: makeCallModel(conn),
    caps: capsFromEnv(process.env),
  });

  async function fetchTiers(): Promise<{ tiers: string[]; source: string }> {
    try {
      const res = await routerFetch("/v1/models", { signal: AbortSignal.timeout(2000) });
      const body = (await res.json()) as { data?: { id: string; owned_by?: string }[] };
      const tiers = (body.data ?? []).filter((m) => m.owned_by === "tierlm").map((m) => m.id);
      if (tiers.length) return { tiers, source: "tierlm" };
    } catch {
      // fall through
    }
    return { tiers: FALLBACK_TIERS, source: "fallback" };
  }

  /** Up, and which router it is (its /health; an older router without it only says it's up). */
  async function routerInfo(): Promise<RouterInfo> {
    const url = conn().url;
    try {
      const res = await routerFetch("/health", { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const h = (await res.json()) as Partial<WireHealth>;
        return { url, up: true, pid: h.pid, home: h.home, version: h.version };
      }
      const models = await routerFetch("/v1/models", { signal: AbortSignal.timeout(1500) });
      return { url, up: models.ok };
    } catch {
      return { url, up: false };
    }
  }

  function sendJson(res: http.ServerResponse, body: unknown): void {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  /**
   * /api/web/<route>, /api/pool/<route> -> provenance-core's own: the setup API behind
   * "Models & accounts" (accounts, one sign-in window, the bundled browser, per-site
   * settings, API keys). Only the routes in ROUTER_ROUTES pass, with the router's status and
   * body as-is (a 409's {detail} included). Router down: 502 {detail, down: true}. Writes
   * must come from our own page (a JSON body and our Origin), since they open windows,
   * change accounts and store keys. Bodies are never logged (a PUT carries an API key).
   */
  async function proxyRouter(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const routerPath = url.pathname.slice("/api".length);
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (!ROUTER_ROUTES.some((r) => r.method === method && r.path.test(routerPath))) {
      reply(404, { detail: "Not Found" });
      return;
    }
    let body: string | undefined;
    if (method !== "GET") {
      if (!sameOrigin(req) || !req.headers.origin) {
        reply(403, { detail: "Forbidden" });
        return;
      }
      if (method !== "DELETE") {
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          reply(415, { detail: "Send JSON" });
          return;
        }
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 16_384) {
            reply(413, { detail: "Too large" });
            return;
          }
        }
        body = raw || "{}";
      }
    }
    try {
      const r = await routerFetch(`${routerPath}${url.search}`, {
        method,
        body,
        headers: body ? { "content-type": "application/json" } : undefined,
        signal: AbortSignal.timeout(method === "GET" ? 3000 : 15_000),
      });
      const text = await r.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { detail: text.slice(0, 300) || r.statusText };
      }
      reply(r.status, parsed);
    } catch {
      reply(502, { detail: "provenance-core isn't answering.", down: true });
    }
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/info") {
      const { defaultCwd, fromLauncher } = opts.cwd();
      sendJson(res, {
        defaultCwd,
        cwdFromLauncher: fromLauncher,
        bin: opts.bin,
        defaultTier: DEFAULT_TIER,
        tierlmUrl: conn().url,
      });
      return true;
    }
    if (url.pathname === "/api/tiers") {
      sendJson(res, { ...(await fetchTiers()), defaultTier: DEFAULT_TIER });
      return true;
    }
    if (url.pathname === "/api/sources") {
      // Which sources serve each tier (pool, web models) and how much each has left.
      // Router down or without /v1/sources: no tiers, and the picker shows plain tiers.
      try {
        const r = await routerFetch("/v1/sources", { signal: AbortSignal.timeout(2000) });
        const body = r.ok ? ((await r.json()) as { tiers?: unknown }) : null;
        if (Array.isArray(body?.tiers)) {
          sendJson(res, { tiers: body.tiers, source: "tierlm" });
          return true;
        }
      } catch {
        // fall through
      }
      sendJson(res, { tiers: [], source: "fallback" });
      return true;
    }
    if (url.pathname.startsWith("/api/web/") || url.pathname.startsWith("/api/pool/")) {
      await proxyRouter(req, res, url);
      return true;
    }
    if (url.pathname === "/api/health") {
      const info = await routerInfo();
      const extra = opts.routerStatus?.();
      const body: UiHealth = {
        bin: { path: opts.bin, exists: existsSync(opts.bin) },
        router: { ...info, mode: extra?.mode, message: info.up ? undefined : extra?.message },
      };
      sendJson(res, body);
      return true;
    }
    if (url.pathname === "/api/fallbacks") {
      sendJson(res, await getFallbacks(fallbackEnv(), url.searchParams.has("refresh")));
      return true;
    }
    if (url.pathname === "/api/usage") {
      // key = thread id, turn = turn id, since/until = the turn's window (unix s)
      const q = new URLSearchParams();
      for (const k of ["key", "turn", "since", "until"]) {
        const v = url.searchParams.get(k);
        if (v) q.set(k, v);
      }
      try {
        const r = await routerFetch(`/v1/pcore/usage?${q}`, {
          signal: AbortSignal.timeout(3000),
        });
        sendJson(res, r.ok ? await r.json() : { models: [], unavailable: r.status });
      } catch {
        sendJson(res, { models: [], unavailable: true });
      }
      return true;
    }
    return false;
  }

  const MIME: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json",
  };

  const dist = path.join(opts.root, "dist");
  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    let file = path.join(dist, path.normalize(urlPath));
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
      file = path.join(dist, "index.html"); // SPA fallback
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  }

  const server = http.createServer();
  let appHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void = serveStatic;
  let closeVite: (() => Promise<void>) | undefined;

  if (opts.prod) {
    if (!existsSync(path.join(dist, "index.html"))) {
      bridge.stop();
      throw new Error(`${dist}/index.html not found: run \`npm run build\` first.`);
    }
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({
      root: opts.root,
      configFile: path.join(opts.root, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    appHandler = (req, res) => vite.middlewares(req, res);
    closeVite = () => vite.close();
  }

  server.on("request", (req, res) => {
    handleApi(req, res)
      .then((handled) => {
        if (!handled) appHandler(req, res);
      })
      .catch((err) => {
        res.writeHead(500);
        res.end(String(err));
      });
  });

  // The bridge can run commands, so only our own pages may open /rpc. Browsers
  // don't apply CORS to WebSockets: without this check any website could
  // connect to ws://localhost:<port>/rpc.
  function sameOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients (smoke test); a page always sends one
    try {
      const o = new URL(origin);
      return (
        (o.hostname === "localhost" || o.hostname === "127.0.0.1") &&
        Number(o.port || 80) === actualPort
      );
    } catch {
      return false;
    }
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const where = new URL(req.url ?? "/", "http://localhost").pathname;
    if (
      where !== "/rpc" &&
      where !== "/rpc/codex" &&
      where !== "/rpc/fallback" &&
      where !== "/rpc/orchestrator"
    )
      return; // Vite HMR handles its own
    if (!sameOrigin(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (where === "/rpc/fallback") fallback.attach(ws);
      else if (where === "/rpc/orchestrator") orchestrator.attach(ws);
      else if (where === "/rpc/codex") codexServer().attach(ws);
      else bridge.attach(ws);
    });
  });

  let actualPort = opts.port;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      const addr = server.address();
      if (addr && typeof addr === "object") actualPort = addr.port;
      resolve();
    });
  });

  return {
    port: actualPort,
    url: `http://localhost:${actualPort}`,
    bridge,
    close: async () => {
      bridge.stop();
      codexBridge?.stop();
      fallback.stop();
      orchestrator.stop();
      orchestratorServer?.stop();
      // ws 8 leaves open sockets alone on close(); upgraded sockets would keep server.close() waiting.
      for (const c of wss.clients) c.terminate();
      wss.close();
      await closeVite?.();
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await closed;
    },
  };
}
