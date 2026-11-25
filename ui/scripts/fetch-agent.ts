// Builds vendor/agent/ (git-ignored): the `provenance` binary the desktop app ships, so someone
// with only the app can run threads. electron-builder copies it to Resources/agent/
// (`extraResources` in package.json); the app uses it when PROVENANCE_BIN is unset, settings.json
// names no provenanceBin and no local install exists (electron/main.ts, resolveAgent).
//
//   node scripts/fetch-agent.ts               # part of `npm run app:build*`
//   AGENT_BIN=/path/to/provenance ...         # default: ../codex-rs/target/release/provenance[.exe]

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const EXT = IS_WIN ? ".exe" : "";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(
  process.env.AGENT_BIN ?? path.join(root, `../codex-rs/target/release/provenance${EXT}`),
);
const repo = path.resolve(root, "..");
const dest = path.join(root, "vendor/agent");
const bin = path.join(dest, `provenance${EXT}`);
const stamp = path.join(dest, "VERSION.json");
const log = (...a: unknown[]) => console.log("[fetch-agent]", ...a);

if (!existsSync(src)) {
  console.error(
    `[fetch-agent] ${src} not found. Build it first (cd codex-rs && cargo build --release -p codex-cli --bin provenance -j 4), or set AGENT_BIN.`,
  );
  process.exit(1);
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const srcSha = sha256(src);

function stripAndSign(file: string): void {
  if (!IS_WIN) {
    try {
      execFileSync("strip", [file]);
    } catch {
      // keep unstripped binary if strip is unavailable
    }
  }
  if (IS_MAC) {
    execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", file]);
  }
}

let old: { sourceSha256?: string } = {};
try {
  old = JSON.parse(readFileSync(stamp, "utf8"));
} catch {
  // none yet
}
if (old.sourceSha256 === srcSha && existsSync(bin)) {
  log(`vendor/agent is up to date (${src})`);
} else {
  mkdirSync(dest, { recursive: true });
  const tmp = `${bin}.tmp`;
  copyFileSync(src, tmp);
  stripAndSign(tmp);
  renameSync(tmp, bin);
  const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  if (!/^provenance \d/.test(version)) {
    rmSync(bin, { force: true });
    console.error(`[fetch-agent] ${src} says "${version}": not a provenance binary`);
    process.exit(1);
  }
  const info = {
    version,
    platform: `${process.platform}-${process.arch}`,
    size: statSync(bin).size,
    sha256: sha256(bin),
    source: src.startsWith(repo + path.sep) ? path.relative(repo, src) : path.basename(src),
    sourceSize: statSync(src).size,
    sourceSha256: srcSha,
    built: new Date().toISOString(),
  };
  writeFileSync(stamp, JSON.stringify(info, null, 2) + "\n");
  log(
    `${version}: ${(info.sourceSize / 1e6).toFixed(0)} MB -> ${(info.size / 1e6).toFixed(0)} MB, from ${src}`,
  );
}

const hostName = `codex-code-mode-host${EXT}`;
const hostSrc = [
  process.env.AGENT_HOST,
  path.join(path.dirname(src), hostName),
  path.join(root, "../codex-rs/target/release", hostName),
].find((p): p is string => !!p && existsSync(p));
const hostBin = path.join(dest, hostName);
if (!hostSrc) {
  console.error(
    `[fetch-agent] ${hostName} not found (set AGENT_HOST, or cargo build --release -p codex-code-mode-host): ` +
      `"Run Codex through Provenance" cannot run tools without it.`,
  );
  process.exit(1);
}
const hostStamp = path.join(dest, "HOST.sha256");
const hostSha = sha256(hostSrc);
if (
  !existsSync(hostBin) ||
  !existsSync(hostStamp) ||
  readFileSync(hostStamp, "utf8").trim() !== hostSha
) {
  const tmp = `${hostBin}.tmp`;
  copyFileSync(hostSrc, tmp);
  stripAndSign(tmp);
  renameSync(tmp, hostBin);
  writeFileSync(hostStamp, hostSha + "\n");
  log(
    `${hostName}: ${(statSync(hostBin).size / 1e6).toFixed(0)} MB, from ${path.basename(path.dirname(hostSrc))}`,
  );
} else {
  log(`${hostName} is up to date`);
}

// The app's protocol types should be the ones this binary speaks.
const gen = mkdtempSync(path.join(tmpdir(), "provenance-agent-types-"));
try {
  const r = spawnSync(bin, ["app-server", "generate-ts", "--experimental", "--out", gen], {
    stdio: "ignore",
  });
  if (r.status !== 0) throw new Error(`generate-ts exited ${r.status}`);
  const committed = path.join(root, "src/protocol/generated");
  const differ = diffTrees(gen, committed);
  if (differ.length)
    log(
      `WARNING: src/protocol/generated does not match this binary (${differ.length} files, e.g. ${differ.slice(0, 3).join(", ")}): PROVENANCE_BIN=${bin} npm run gen:protocol`,
    );
  else log("protocol types match src/protocol/generated");
} finally {
  rmSync(gen, { recursive: true, force: true });
}

function diffTrees(a: string, b: string): string[] {
  const files = (dir: string, rel = ""): string[] =>
    readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(dir, path.join(rel, e.name)) : [path.join(rel, e.name)],
    );
  const left = new Set(files(a));
  const right = existsSync(b) ? new Set(files(b)) : new Set<string>();
  const out: string[] = [];
  for (const f of new Set([...left, ...right]))
    if (
      !left.has(f) ||
      !right.has(f) ||
      !readFileSync(path.join(a, f)).equals(readFileSync(path.join(b, f)))
    )
      out.push(f);
  return out.sort();
}
