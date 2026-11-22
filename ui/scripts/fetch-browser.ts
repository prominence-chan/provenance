// Puts the Chrome for Testing build provenance-core drives into vendor/browser/ (git-ignored),
// which electron-builder ships unmodified as Provenance.app/Contents/Resources/browser/
// (`extraResources` in package.json). provenance-core looks there first and makes its own
// background-only copy on first use, so a new install needs no ~200 MB download before its
// first sign-in (provenance-core docs/TECHNICAL.md, "Bundled browser").
//
//   node scripts/fetch-browser.ts             # part of `npm run app:build`
//   BROWSER_SOURCE=download ...               # skip the local copy, always download
//   BROWSER_DEST=/some/dir ...                # somewhere else than vendor/browser
//
// Source, in order: vendor/browser already at the pinned version (nothing to do); the same
// build provenance-core already prepared on this Mac (~/.tierlm/browser/<v>/plain/, only
// read); Google's Chrome for Testing bucket (~190 MB zip, md5-checked, unpacked with ditto
// so the framework's symlinks survive). Bump VERSION to ship a newer build: it must be at
// least as new as the installed Chrome's major version for provenance-core to use it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const VERSION = "157.0.8103.78";
const PLATFORM = "mac-arm64";
const APP = "Google Chrome for Testing.app";
const URL_ = `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${PLATFORM}/chrome-${PLATFORM}.zip`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.resolve(process.env.BROWSER_DEST ?? path.join(root, "vendor/browser"));
const local = path.join(homedir(), ".tierlm/browser", VERSION, "plain", APP);
const log = (...a: unknown[]) => console.log("  • browser:", ...a);

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

function appVersion(app: string): string | null {
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
  run("ditto", ["-x", "-k", zip, path.join(tmp, "unpacked")]);
  rmSync(zip);
  const app = path.join(tmp, "unpacked", `chrome-${PLATFORM}`, APP);
  if (!existsSync(app)) throw new Error(`no ${APP} in the download`);
  return app;
}

const target = path.join(dest, APP);
if (appVersion(target) === VERSION) {
  log(`${VERSION} already in ${path.relative(root, dest) || dest}`);
  process.exit(0);
}

const tmp = path.join(path.dirname(dest), `.browser-tmp-${process.pid}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
try {
  let app: string;
  if (process.env.BROWSER_SOURCE !== "download" && appVersion(local) === VERSION) {
    log(`copying ${VERSION} from ${local.replace(homedir(), "~")}`);
    app = path.join(tmp, APP);
    run("ditto", [local, app]); // keeps symlinks and the bundle exactly as it is
  } else {
    app = await download(tmp);
  }
  const v = appVersion(app);
  if (v !== VERSION) throw new Error(`expected ${VERSION}, got ${v ?? "no app"}`);
  run("xattr", ["-cr", app]); // no quarantine flag inside the shipped app
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  renameSync(app, target);
  log(
    `${VERSION} ready in ${path.relative(root, dest) || dest} (${run("du", ["-sh", target]).split("\t")[0]})`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
