// CLI entry point for the web UI: `npm run dev` (Vite middleware + HMR) or
// `npm start` (--prod, serves dist/). The server itself lives in app.ts, which the
// desktop app (electron/main.ts) reuses.
//
// Run with Node >= 23.6 (native TypeScript type stripping).
//
// Env:
//   PORT              default 5173
//   HOST              default 127.0.0.1 (the bridge can run commands; keep it local)
//   PROVENANCE_BIN    default ~/.local/bin/provenance
//   PROVENANCE_UI_CWD default working directory offered to new threads (default: $HOME)
//   TIERLM_URL        default http://127.0.0.1:4141
//   PCORE_TOKEN       the router's bearer token, if it has one
//   NO_OPEN=1         don't open a browser even with --open

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startUiServer } from "./app.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const prod = args.has("--prod");
const bin = process.env.PROVENANCE_BIN ?? path.join(homedir(), ".local/bin/provenance");
const defaultCwd = process.env.PROVENANCE_UI_CWD ?? homedir();

let ui;
try {
  ui = await startUiServer({
    root,
    prod,
    port: Number(process.env.PORT ?? 5173),
    host: process.env.HOST ?? "127.0.0.1",
    bin,
    router: {
      url: process.env.TIERLM_URL ?? "http://127.0.0.1:4141",
      token: process.env.PCORE_TOKEN || undefined,
    },
    cwd: () => ({ defaultCwd, fromLauncher: !!process.env.PROVENANCE_UI_CWD }),
  });
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

console.log(`Provenance UI on ${ui.url}  (${prod ? "prod" : "dev"}; app-server: ${bin})`);
if (args.has("--open") && !process.env.NO_OPEN) execFile("open", [ui.url], () => {});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    ui.bridge.stop();
    process.exit(0);
  });
}
