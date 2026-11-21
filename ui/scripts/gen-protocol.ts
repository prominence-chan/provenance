// Regenerates src/protocol/generated from the installed provenance binary.
//
//   npm run gen:protocol
//
// The types come from the Rust structs in codex-rs/app-server-protocol (via ts-rs),
// so re-run this whenever the binary is rebuilt with protocol changes.
// Set PROVENANCE_BIN to point at a different binary.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "src/protocol/generated");
const bin = process.env.PROVENANCE_BIN ?? path.join(homedir(), ".local/bin/provenance");

if (!existsSync(bin)) {
  console.error(`provenance binary not found at ${bin} (set PROVENANCE_BIN)`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
// --experimental: the UI opts into experimentalApi during initialize, so include those fields.
execFileSync(bin, ["app-server", "generate-ts", "--experimental", "--out", out], { stdio: "inherit" });
console.log(`wrote protocol types to ${path.relative(root, out)}`);
