// Copies the built app (npm run app:build) to /Applications/Provenance.app,
// quitting a running copy first.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "release/mac-arm64/Provenance.app");
const dest = process.env.PROVENANCE_APP_DEST ?? "/Applications/Provenance.app";
if (!existsSync(src)) {
  console.error(`${src} not found: run \`npm run app:build\` first.`);
  process.exit(1);
}
try {
  execFileSync("osascript", ["-e", 'tell application id "dev.prominence.provenance" to quit'], {
    stdio: "ignore",
  });
} catch {
  // not running
}
rmSync(dest, { recursive: true, force: true });
execFileSync("ditto", [src, dest], { stdio: "inherit" });
console.log(`installed ${dest}`);
