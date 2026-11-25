// Puts the Chrome for Testing build provenance-core drives into vendor/browser/ (git-ignored),
// which electron-builder ships unmodified as Resources/browser/ (`extraResources` in package.json).
//
//   node scripts/fetch-browser.ts             # part of `npm run app:build*`
//   BROWSER_SOURCE=download ...               # skip local macOS cache, always download
//   BROWSER_DEST=/some/dir ...                # somewhere else than vendor/browser
//   BROWSER_TARGET=darwin-arm64|darwin-x64|win32-x64|linux-x64

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const VERSION = "157.0.8103.78";
const PLATFORM_MAP: Record<string, string> = {
  "darwin-arm64": "mac-arm64",
  "darwin-x64": "mac-x64",
  "win32-x64": "win64",
  "linux-x64": "linux64",
};
const targetKey = process.env.BROWSER_TARGET ?? `${process.platform}-${process.arch}`;
const PLATFORM = PLATFORM_MAP[targetKey];
if (!PLATFORM) {
  throw new Error(
    `unsupported browser target "${targetKey}" (supported: ${Object.keys(PLATFORM_MAP).join(", ")})`,
  );
}
const IS_MAC = targetKey.startsWith("darwin-");
const IS_WIN = targetKey.startsWith("win32-");
const APP = "Google Chrome for Testing.app";
const URL_ = `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${PLATFORM}/chrome-${PLATFORM}.zip`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.resolve(process.env.BROWSER_DEST ?? path.join(root, "vendor/browser"));
const local = path.join(homedir(), ".tierlm/browser", VERSION, "plain", APP);
const stampFile = path.join(dest, "VERSION.txt");
const log = (...a: unknown[]) => console.log("  • browser:", ...a);

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")}: ${(r.stderr || r.stdout || "").trim()}`);
  return r.stdout.trim();
}

function macAppVersion(app: string): string | null {
  const plist = path.join(app, "Contents/Info.plist");
  if (
    !existsSync(plist) ||
    !existsSync(path.join(app, "Contents/MacOS", APP.replace(/\.app$/, "")))
  )
    return null;
  try {
    return run("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist]);
  } catch {
    return null;
  }
}

function installedVersion(): string | null {
  if (IS_MAC) return macAppVersion(path.join(dest, APP));
  if (!existsSync(stampFile)) return null;
  const bin = path.join(dest, IS_WIN ? "chrome.exe" : "chrome");
  return existsSync(bin) ? readFileSync(stampFile, "utf8").trim() : null;
}

async function download(tmp: string): Promise<string> {
  log(`downloading ${URL_}`);
  const res = await fetch(URL_);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const want = (res.headers.get("x-goog-hash") ?? "")
    .split(",")
    .map((h) => h.trim())
    .find((h) => h.startsWith("md5="));
  const total = Number(res.headers.get("content-length") ?? 0);
  const md5 = createHash("md5");
  let got = 0;
  let shown = 0;
  const zip = path.join(tmp, "chrome.zip");
  const body = Readable.fromWeb(res.body as never);
  body.on("data", (chunk: Buffer) => {
    md5.update(chunk);
    got += chunk.length;
    if (total && got / total - shown >= 0.25) {
      shown = Math.floor((got / total) * 4) / 4;
      log(`${Math.round(shown * 100)}% of ${Math.round(total / 1e6)} MB`);
    }
  });
  await pipeline(body, createWriteStream(zip));
  if (want && Buffer.from(want.slice(4), "base64").toString("hex") !== md5.digest("hex"))
    throw new Error("download corrupted (md5 mismatch)");
  const unpacked = path.join(tmp, "unpacked");
  mkdirSync(unpacked, { recursive: true });
  if (IS_MAC) {
    run("ditto", ["-x", "-k", zip, unpacked]);
  } else if (IS_WIN) {
    run("tar", ["-xf", zip, "-C", unpacked]);
  } else {
    run("unzip", ["-q", zip, "-d", unpacked]);
  }
  rmSync(zip, { force: true });
  const inner = path.join(unpacked, `chrome-${PLATFORM}`);
  if (IS_MAC) {
    const app = path.join(inner, APP);
    if (!existsSync(app)) throw new Error(`no ${APP} in the download`);
    return app;
  }
  if (!existsSync(inner)) throw new Error(`no chrome-${PLATFORM} in the download`);
  return inner;
}

if (installedVersion() === `${VERSION}${IS_MAC ? "" : `:${PLATFORM}`}`) {
  log(`${VERSION} (${PLATFORM}) already in ${path.relative(root, dest) || dest}`);
  process.exit(0);
}

const tmp = path.join(path.dirname(dest), `.browser-tmp-${process.pid}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
try {
  if (IS_MAC) {
    let app: string;
    if (process.env.BROWSER_SOURCE !== "download" && macAppVersion(local) === VERSION) {
      log(`copying ${VERSION} from ${local.replace(homedir(), "~")}`);
      app = path.join(tmp, APP);
      run("ditto", [local, app]);
    } else {
      app = await download(tmp);
    }
    const v = macAppVersion(app);
    if (v !== VERSION) throw new Error(`expected ${VERSION}, got ${v ?? "no app"}`);
    run("xattr", ["-cr", app]);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    renameSync(app, path.join(dest, APP));
  } else {
    const dir = await download(tmp);
    rmSync(dest, { recursive: true, force: true });
    renameSync(dir, dest);
    writeFileSync(stampFile, `${VERSION}:${PLATFORM}\n`);
  }
  log(`${VERSION} (${PLATFORM}) ready in ${path.relative(root, dest) || dest}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
