// The UI server as a library: one HTTP server on one port that serves
//   - the React app (Vite dev middleware with HMR, or the built `dist/`)
//   - GET /api/info    -> defaults for the UI (cwd, binary, tiers source)
//   - GET /api/tiers   -> tier list from tierlm (/v1/models, owned_by=tierlm)
//   - GET /api/sources -> each tier's sources and usage left (provenance-core /v1/sources)
//   - GET /api/health  -> is the provenance binary there, is provenance-core up
//   - GET /api/usage   -> which models served a turn (provenance-core /v1/pcore/usage)
//   - WS  /rpc         -> JSON-RPC relay to `provenance app-server` (see bridge.ts)
//
// Used by server/main.ts (the `npm run dev` / `npm start` CLI) and by the desktop
// app (electron/main.ts), which runs it inside Electron's own Node.

import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { AppServerBridge } from "./bridge.ts";

/** Used when tierlm is unreachable. Keep in sync with tierlm's tier names. */
const FALLBACK_TIERS = ["nova", "solstice", "ember", "spark"];
const DEFAULT_TIER = "solstice";

export interface RouterStatus {
  up: boolean;
  /** e.g. "starting provenance-core…" or why it couldn't be started. */
  message?: string;
}

export interface UiServerOptions {
  /** Directory that holds index.html (prod) or the Vite project root (dev). */
  root: string;
  /** Serve `${root}/dist` (true) or run Vite in middleware mode (false). */
  prod: boolean;
  port: number;
  host: string;
  bin: string;
  tierlmUrl: string;
  /** Returns the current default cwd and whether it came from a launcher. */
  cwd: () => { defaultCwd: string; fromLauncher: boolean };
  /** Extra router state from the host (e.g. the app trying to start it). */
  routerStatus?: () => RouterStatus | undefined;
  clientTitle?: string;
}

export interface UiServer {
  port: number;
  url: string;
  bridge: AppServerBridge;
  close: () => Promise<void>;
}

export async function startUiServer(opts: UiServerOptions): Promise<UiServer> {
  const tierlmUrl = opts.tierlmUrl.replace(/\/$/, "");
  const bridge = new AppServerBridge({
    bin: opts.bin,
    clientInfo: {
      name: "provenance_ui",
      title: opts.clientTitle ?? "Provenance UI",
      version: "0.1.0",
    },
  });
  bridge.start();

  async function fetchTiers(): Promise<{ tiers: string[]; source: string }> {
    try {
      const res = await fetch(`${tierlmUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
      const body = (await res.json()) as { data?: { id: string; owned_by?: string }[] };
      const tiers = (body.data ?? []).filter((m) => m.owned_by === "tierlm").map((m) => m.id);
      if (tiers.length) return { tiers, source: "tierlm" };
    } catch {
      // fall through
    }
    return { tiers: FALLBACK_TIERS, source: "fallback" };
  }

  async function routerUp(): Promise<boolean> {
    try {
      const res = await fetch(`${tierlmUrl}/v1/models`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  function sendJson(res: http.ServerResponse, body: unknown): void {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
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
        tierlmUrl,
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
        const r = await fetch(`${tierlmUrl}/v1/sources`, { signal: AbortSignal.timeout(2000) });
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
    if (url.pathname === "/api/health") {
      const up = await routerUp();
      const extra = opts.routerStatus?.();
      sendJson(res, {
        bin: { path: opts.bin, exists: existsSync(opts.bin) },
        router: { url: tierlmUrl, up, message: up ? undefined : extra?.message },
      });
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
        const r = await fetch(`${tierlmUrl}/v1/pcore/usage?${q}`, {
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
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/rpc") return; // Vite HMR handles its own
    if (!sameOrigin(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => bridge.attach(ws));
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
      wss.close();
      await closeVite?.();
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await closed;
    },
  };
}
