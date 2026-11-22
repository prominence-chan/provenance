// Bundles the Electron main process (which includes server/app.ts + bridge.ts + ws)
// and the preload into build-electron/*.cjs, so the packaged app needs no node_modules.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: "linked",
  logLevel: "info",
  // vite: only imported in dev mode (PROVENANCE_APP_VITE=1), from ui/node_modules.
  // bufferutil / utf-8-validate: optional ws accelerators.
  external: ["electron", "vite", "bufferutil", "utf-8-validate"],
};
await build({
  ...common,
  entryPoints: [path.join(root, "electron/main.ts")],
  outfile: path.join(root, "build-electron/main.cjs"),
});
await build({
  ...common,
  entryPoints: [path.join(root, "electron/preload.ts")],
  outfile: path.join(root, "build-electron/preload.cjs"),
});
