// Builds vendor/router/ (git-ignored): provenance-core as the desktop app ships it, so the app
// needs no system Python install, venv or background service. electron-builder copies it to
// Resources/router/ (`extraResources` in package.json), and the app starts it from there
// (electron/router.ts).
//
//   node scripts/fetch-router.ts              # part of `npm run app:build*`
//   ROUTER_SRC=/path/to/provenance-core ...   # default: the sibling checkout ../../provenance-core
//   PBS_TARGET=darwin-arm64|darwin-x64|win32-x64|linux-x64

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const PBS_RELEASE = "20261026";
const PBS_PYTHON = "3.13.18";
const PBS_TARGETS: Record<string, { file: string; sha256: string }> = {
  "darwin-arm64": {
    file: `cpython-${PBS_PYTHON}+${PBS_RELEASE}-aarch64-apple-darwin-install_only_stripped.tar.gz`,
    sha256: "8392b6ea51d94391befb2c31ebe75463f045d0b69dfcf5e1bb3234e1f5fa3405",
  },
  "darwin-x64": {
    file: `cpython-${PBS_PYTHON}+${PBS_RELEASE}-x86_64-apple-darwin-install_only_stripped.tar.gz`,
    sha256: "7412c19d896c99431b74a18a5643e110449a7f9590fbab179c3e5ab27b9aa9e3",
  },
  "win32-x64": {
    file: `cpython-${PBS_PYTHON}+${PBS_RELEASE}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
    sha256: "7369f7a35f261222a6ac8b3a87c1c88eeebee8af945d85346202591a64038dd3",
  },
  "linux-x64": {
    file: `cpython-${PBS_PYTHON}+${PBS_RELEASE}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
    sha256: "df15fe60d3ff55bf9dcf25824b5572756bb8816ff93865a273d3301d7066a8b7",
  },
};

const targetKey = process.env.PBS_TARGET ?? `${process.platform}-${process.arch}`;
const pbsTarget = PBS_TARGETS[targetKey];
if (!pbsTarget) {
  throw new Error(
    `unsupported platform target "${targetKey}" (supported: ${Object.keys(PBS_TARGETS).join(", ")})`,
  );
}
const IS_WIN = targetKey.startsWith("win32-");
const PBS_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${encodeURIComponent(pbsTarget.file)}`;
const PYLIB = IS_WIN ? "Lib" : `lib/python${PBS_PYTHON.split(".").slice(0, 2).join(".")}`;
const pyRel = IS_WIN ? "python/python.exe" : "python/bin/python3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(process.env.ROUTER_SRC ?? path.join(root, "../../provenance-core"));
const dest = path.join(root, "vendor/router");
const cache = path.join(root, "vendor/.cache");
const reqFile = path.join(root, "scripts/router-requirements.txt");
const log = (...a: unknown[]) => console.log("  • router:", ...a);

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: opts.cwd, env: cleanEnv() });
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(" ")}: ${(r.stderr || r.stdout || "").trim().slice(-2000)}`,
    );
  return r.stdout.trim();
}

/** No PYTHON* / PIP_* from the shell: the build must not pick up the user's own Python setup. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!/^(PYTHON|PIP_|VIRTUAL_ENV|CONDA)/.test(k)) env[k] = v;
  return env;
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

function dirSizeMb(dir: string): string {
  let bytes = 0;
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) bytes += statSync(full).size;
    }
  };
  walk(dir);
  return `${Math.round(bytes / 1e6)}M`;
}

async function pythonTarball(): Promise<string> {
  mkdirSync(cache, { recursive: true });
  const file = path.join(cache, pbsTarget.file);
  if (existsSync(file) && (await sha256(file)) === pbsTarget.sha256) return file;
  log(`downloading ${PBS_URL}`);
  const res = await fetch(PBS_URL);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  const got = await sha256(tmp);
  if (got !== pbsTarget.sha256) {
    rmSync(tmp, { force: true });
    throw new Error(`python-build-standalone download corrupted (sha256 ${got})`);
  }
  renameSync(tmp, file);
  return file;
}

/** The router's git revision (+ "-dirty" with a hash of the changes), for VERSION.json. */
function routerRev(): string {
  try {
    const rev = run("git", ["-C", src, "rev-parse", "--short", "HEAD"]);
    const diff = run("git", [
      "-C",
      src,
      "diff",
      "HEAD",
      "--",
      "provenance_core",
      "tierlm",
      "catalog.yaml",
      "catalog.app.yaml",
    ]);
    return diff
      ? `${rev}-dirty-${createHash("sha256").update(diff).digest("hex").slice(0, 8)}`
      : rev;
  } catch {
    return "unknown";
  }
}

const RM_FROM_PYTHON = [
  "include",
  "share",
  "lib/pkgconfig",
  `${PYLIB}/test`,
  `${PYLIB}/idlelib`,
  `${PYLIB}/tkinter`,
  `${PYLIB}/turtledemo`,
  `${PYLIB}/ensurepip`,
  `${PYLIB}/pydoc_data`,
  `${PYLIB}/config-3.13-darwin`,
];

async function buildPython(stamp: string): Promise<void> {
  const tarball = await pythonTarball();
  const tmp = path.join(path.dirname(dest), `.router-tmp-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    run("tar", ["-xzf", tarball, "-C", tmp]); // -> tmp/python/
    const py = path.join(tmp, pyRel);
    log(
      `CPython ${run(py, ["-c", "import sys; print(sys.version.split()[0])"])} (${targetKey}); installing the pinned wheels`,
    );
    run(py, [
      "-I",
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-warn-script-location",
      "--only-binary=:all:",
      "--no-compile",
      "-r",
      reqFile,
    ]);
    // Exactly the pinned set (pip may not add anything the list lacks; ignore platform-specific
    // extra deps like colorama on Windows only if explicitly needed, otherwise enforce strict pin).
    const got = run(py, ["-I", "-m", "pip", "freeze", "--exclude", "pip"])
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase().replace(/_/g, "-"))
      .filter(Boolean)
      .sort();
    const want = readFileSync(reqFile, "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*/, "").trim().toLowerCase().replace(/_/g, "-"))
      .filter(Boolean)
      .sort();
    const extra = got.filter((g) => !want.includes(g));
    if (extra.length && !IS_WIN)
      throw new Error(`pip installed more than router-requirements.txt pins: ${extra.join(", ")}`);
    run(py, ["-I", "-m", "pip", "uninstall", "-y", "-q", "pip"]);
    const site = path.join(tmp, "python", PYLIB, "site-packages");
    rmSync(path.join(site, IS_WIN ? "patchright/driver/node.exe" : "patchright/driver/node"), {
      force: true,
    }); // Electron's Node runs it
    for (const p of RM_FROM_PYTHON)
      rmSync(path.join(tmp, "python", p), { recursive: true, force: true });
    if (!IS_WIN) {
      for (const f of readdirSync(path.join(tmp, "python/bin")))
        if (!/^python3?(\.\d+)?$/.test(f)) rmSync(path.join(tmp, "python/bin", f));
      const dynload = path.join(tmp, "python", PYLIB, "lib-dynload");
      if (existsSync(dynload)) {
        for (const f of readdirSync(dynload))
          if (/^_tkinter/.test(f)) rmSync(path.join(dynload, f));
      }
      const libDir = path.join(tmp, "python/lib");
      if (existsSync(libDir)) {
        for (const f of readdirSync(libDir))
          if (/^(tcl|tk|itcl|thread)\d/.test(f) || /^lib(tcl|tk)/.test(f))
            rmSync(path.join(libDir, f), { recursive: true, force: true });
      }
    } else {
      rmSync(path.join(tmp, "python/tcl"), { recursive: true, force: true });
    }
    rmSync(path.join(dest, "python"), { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    renameSync(path.join(tmp, "python"), path.join(dest, "python"));
    writeFileSync(path.join(dest, ".python-stamp"), stamp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const NODE_WRAPPER_UNIX = `#!/bin/sh
# patchright's driver runs on the app's own Electron in Node mode: PLAYWRIGHT_NODEJS_PATH points
# here, and PROVENANCE_ELECTRON names the app's executable. Written by scripts/fetch-router.ts.
exe="\${PROVENANCE_ELECTRON:-$(dirname "$0")/../../MacOS/Provenance}"
ELECTRON_RUN_AS_NODE=1 exec "$exe" "$@"
`;

const NODE_WRAPPER_WIN = `@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if defined PROVENANCE_ELECTRON (
  "%PROVENANCE_ELECTRON%" %*
) else (
  "%~dp0..\\..\\Provenance.exe" %*
)
`;

async function main(): Promise<void> {
  if (!existsSync(path.join(src, "provenance_core/server.py")))
    throw new Error(`no provenance-core at ${src} (set ROUTER_SRC)`);
  if (!existsSync(path.join(src, "catalog.app.yaml")))
    throw new Error(
      `${src} has no catalog.app.yaml: it predates the app's own router (branch app-router)`,
    );
  const reqs = readFileSync(reqFile, "utf8");
  const stamp = createHash("sha256")
    .update(targetKey + pbsTarget.file + reqs)
    .digest("hex");
  const stampFile = path.join(dest, ".python-stamp");
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp)
    log("Python and wheels up to date");
  else await buildPython(stamp);

  const py = path.join(dest, pyRel);
  const site = path.join(dest, "python", PYLIB, "site-packages");
  for (const pkg of ["provenance_core", "tierlm"]) {
    rmSync(path.join(site, pkg), { recursive: true, force: true });
    cpSync(path.join(src, pkg), path.join(site, pkg), {
      recursive: true,
      filter: (p) => !p.includes("__pycache__"),
    });
  }
  for (const f of ["catalog.yaml", "catalog.app.yaml"])
    copyFileSync(path.join(src, f), path.join(dest, f));
  if (IS_WIN) {
    writeFileSync(path.join(dest, "node.cmd"), NODE_WRAPPER_WIN);
  } else {
    writeFileSync(path.join(dest, "node"), NODE_WRAPPER_UNIX);
    chmodSync(path.join(dest, "node"), 0o755);
  }
  run(py, [
    "-I",
    "-m",
    "compileall",
    "-q",
    "-j",
    "0",
    "--invalidation-mode",
    "unchecked-hash",
    path.join(dest, "python", PYLIB),
  ]);
  const version = run(py, ["-I", "-c", "import provenance_core as p; print(p.__version__)"]);
  const info = {
    platform: targetKey,
    python: PBS_PYTHON,
    pythonBuild: PBS_RELEASE,
    router: version,
    routerRev: routerRev(),
    wheels: reqs.split(/\r?\n/).filter((l) => l && !l.startsWith("#")),
  };
  writeFileSync(path.join(dest, "VERSION.json"), JSON.stringify(info, null, 2) + "\n");
  run(py, ["-I", "-B", "-c", "import provenance_core.server, patchright.async_api, uvicorn, yaml"]);
  log(`provenance-core ${version} (${info.routerRev}) ready in vendor/router (${dirSizeMb(dest)})`);
}

await main();
