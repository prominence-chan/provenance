// Entry point: one HTTP server on one port that serves
//   - the React app (Vite dev middleware with HMR, or the built `dist/` with --prod)
//   - GET /api/info   -> defaults for the UI (cwd, binary, tiers source)
//   - GET /api/tiers  -> tier list from tierlm (/v1/models, owned_by=tierlm)
//   - WS  /rpc        -> JSON-RPC relay to `provenance app-server` (see bridge.ts)
//
// Run with Node >= 23.6 (native TypeScript type stripping), e.g. `npm run dev`.
//
// Env:
//   PORT              default 5173
//   HOST              default 127.0.0.1 (the bridge can run commands; keep it local)
//   PROVENANCE_BIN    default ~/.local/bin/provenance
//   PROVENANCE_UI_CWD default working directory offered to new threads (default: $HOME)
//   TIERLM_URL        default http://127.0.0.1:4141
//   NO_OPEN=1         don't open a browser even with --open

import { execFile } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { AppServerBridge } from "./bridge.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const prod = args.has("--prod");
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? "127.0.0.1";
const bin = process.env.PROVENANCE_BIN ?? path.join(homedir(), ".local/bin/provenance");
const defaultCwd = process.env.PROVENANCE_UI_CWD ?? homedir();
const tierlmUrl = (process.env.TIERLM_URL ?? "http://127.0.0.1:4141").replace(/\/$/, "");

/** Used when tierlm is unreachable. Keep in sync with tierlm's tier names. */
const FALLBACK_TIERS = ["nova", "solstice", "spark", "ember"];
const DEFAULT_TIER = "solstice";

const bridge = new AppServerBridge({
  bin,
  clientInfo: { name: "provenance_ui", title: "Provenance UI", version: "0.1.0" },
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

function sendJson(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/info") {
    sendJson(res, { defaultCwd, cwdFromLauncher: !!process.env.PROVENANCE_UI_CWD, bin, defaultTier: DEFAULT_TIER, tierlmUrl });
    return true;
  }
  if (url.pathname === "/api/tiers") {
    sendJson(res, { ...(await fetchTiers()), defaultTier: DEFAULT_TIER });
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
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const dist = path.join(root, "dist");
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

if (prod) {
  if (!existsSync(path.join(root, "dist/index.html"))) {
    console.error("dist/ not found: run `npm run build` first (or use `npm run dev`).");
    process.exit(1);
  }
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  appHandler = (req, res) => vite.middlewares(req, res);
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

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url ?? "/", "http://localhost").pathname !== "/rpc") return; // Vite HMR handles its own
  wss.handleUpgrade(req, socket, head, (ws) => bridge.attach(ws));
});

server.listen(port, host, () => {
  const url = `http://localhost:${port}`;
  console.log(`Provenance UI on ${url}  (${prod ? "prod" : "dev"}; app-server: ${bin})`);
  if (args.has("--open") && !process.env.NO_OPEN) execFile("open", [url], () => {});
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    bridge.stop();
    process.exit(0);
  });
}
