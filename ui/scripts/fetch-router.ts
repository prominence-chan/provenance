// Builds vendor/router/ (git-ignored): provenance-core as Provenance.app ships it, so the app
// needs no Python install, venv or launchd job. electron-builder copies it unmodified to
// Provenance.app/Contents/Resources/router/ (`extraResources` in package.json), and the app
// starts it from there (electron/router.ts).
//
//   node scripts/fetch-router.ts              # part of `npm run app:build`
//   ROUTER_SRC=/path/to/provenance-core ...   # default: the sibling checkout ../../provenance-core
//
// Why a relocatable Python and not a frozen binary: python-build-standalone is CPython itself,
// built to run from any folder (what uv and others install). The router's own code stays
// plain .py files that can be read and patched in place, its dependencies are the ordinary
// wheels its test suite runs with (scripts/router-requirements.txt), and nothing has to learn
// about patchright's driver files or FastAPI's lazy imports the way a freezer must. A frozen
// binary would not be smaller either: it carries the same interpreter and libraries.
//
// What ends up in vendor/router/:
//   python/              CPython 3.13 (python-build-standalone, install_only_stripped), its own
//                        site-packages holding the pinned wheels and provenance_core itself;
//                        tkinter, idle, the test suite, pip and headers removed; every module
//                        compiled ahead (unchecked-hash .pyc), since the app runs it with -B so
//                        nothing is ever written inside the signed bundle
//   node                 patchright's driver runs on Electron's own Node through this wrapper
//                        (PLAYWRIGHT_NODEJS_PATH), so the driver's 117 MB Node is not shipped
//   catalog.yaml, catalog.app.yaml   the router's catalog and the app's overlay of it
//   VERSION.json         what was built from what (also how a rebuild is skipped)

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
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// python-build-standalone, pinned (release 20261026, CPython 3.13.18, macOS arm64).
const PBS = {
  release: "20261026",
  python: "3.13.18",
  file: "cpython-3.13.18+20261026-aarch64-apple-darwin-install_only_stripped.tar.gz",
  sha256: "8392b6ea51d94391befb2c31ebe75463f045d0b69dfcf5e1bb3234e1f5fa3405",
};
const PBS_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS.release}/${encodeURIComponent(PBS.file)}`;
const PYLIB = `lib/python${PBS.python.split(".").slice(0, 2).join(".")}`;

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

async function pythonTarball(): Promise<string> {
  mkdirSync(cache, { recursive: true });
  const file = path.join(cache, PBS.file);
  if (existsSync(file) && (await sha256(file)) === PBS.sha256) return file;
  log(`downloading ${PBS_URL}`);
  const res = await fetch(PBS_URL);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  const got = await sha256(tmp);
  if (got !== PBS.sha256) {
    rmSync(tmp, { force: true });
    throw new Error(`python-build-standalone download corrupted (sha256 ${got})`);
  }
  run("mv", [tmp, file]);
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
    const py = path.join(tmp, "python/bin/python3");
    log(
      `CPython ${run(py, ["-c", "import sys; print(sys.version.split()[0])"])}; installing the pinned wheels`,
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
    // Exactly the pinned set (pip may not add anything the list lacks).
    const got = run(py, ["-I", "-m", "pip", "freeze", "--exclude", "pip"])
      .split("\n")
      .map((l) => l.trim().toLowerCase().replace(/_/g, "-"))
      .filter(Boolean)
      .sort();
    const want = readFileSync(reqFile, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim().toLowerCase().replace(/_/g, "-"))
      .filter(Boolean)
      .sort();
    const extra = got.filter((g) => !want.includes(g));
    if (extra.length)
      throw new Error(`pip installed more than router-requirements.txt pins: ${extra.join(", ")}`);
    run(py, ["-I", "-m", "pip", "uninstall", "-y", "-q", "pip"]);
    const site = path.join(tmp, "python", PYLIB, "site-packages");
    rmSync(path.join(site, "patchright/driver/node"), { force: true }); // Electron's Node runs it
    for (const p of RM_FROM_PYTHON)
      rmSync(path.join(tmp, "python", p), { recursive: true, force: true });
    // bin/: only the interpreter (idle, pydoc, -config and the wheels' console scripts, whose
    // shebangs name the build folder, would not work from the app anyway)
    for (const f of readdirSync(path.join(tmp, "python/bin")))
      if (!/^python3?(\.\d+)?$/.test(f)) rmSync(path.join(tmp, "python/bin", f));
    for (const f of readdirSync(path.join(tmp, "python", PYLIB, "lib-dynload")))
      if (/^_tkinter/.test(f)) rmSync(path.join(tmp, "python", PYLIB, "lib-dynload", f));
    for (const f of readdirSync(path.join(tmp, "python/lib")))
      if (/^(tcl|tk|itcl|thread)\d/.test(f) || /^lib(tcl|tk)/.test(f))
        rmSync(path.join(tmp, "python/lib", f), { recursive: true, force: true });
    rmSync(path.join(dest, "python"), { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    run("mv", [path.join(tmp, "python"), path.join(dest, "python")]);
    writeFileSync(path.join(dest, ".python-stamp"), stamp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const NODE_WRAPPER = `#!/bin/sh
# patchright's driver (a Node program) runs on the app's own Electron in Node mode: the router
# is started with PLAYWRIGHT_NODEJS_PATH pointing here, and PROVENANCE_ELECTRON naming the app's
# executable (Contents/MacOS/Provenance). Written by scripts/fetch-router.ts.
exe="\${PROVENANCE_ELECTRON:-$(dirname "$0")/../../MacOS/Provenance}"
ELECTRON_RUN_AS_NODE=1 exec "$exe" "$@"
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
    .update(PBS.file + reqs)
    .digest("hex");
  const stampFile = path.join(dest, ".python-stamp");
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp)
    log("Python and wheels up to date");
  else await buildPython(stamp);

  const py = path.join(dest, "python/bin/python3");
  const site = path.join(dest, "python", PYLIB, "site-packages");
  // The router's own code, as plain files (re-copied every build: cheap, and always current).
  for (const pkg of ["provenance_core", "tierlm"]) {
    rmSync(path.join(site, pkg), { recursive: true, force: true });
    cpSync(path.join(src, pkg), path.join(site, pkg), {
      recursive: true,
      filter: (p) => !p.includes("__pycache__"),
    });
  }
  for (const f of ["catalog.yaml", "catalog.app.yaml"])
    copyFileSync(path.join(src, f), path.join(dest, f));
  writeFileSync(path.join(dest, "node"), NODE_WRAPPER);
  chmodSync(path.join(dest, "node"), 0o755);
  // Compile everything once (the app runs Python with -B: nothing is written into the bundle).
  // unchecked-hash: valid whatever the files' dates become when electron-builder copies them.
  run(py, [
    "-I",
    "-m",
    "compileall",
    "-q",
    "-j",
    "0",
    "--invalidation-mode",
    "unchecked-hash",
    path.join(dest, "python/lib"),
  ]);
  const version = run(py, ["-I", "-c", "import provenance_core as p; print(p.__version__)"]);
  const info = {
    python: PBS.python,
    pythonBuild: PBS.release,
    router: version,
    routerRev: routerRev(),
    wheels: reqs.split("\n").filter((l) => l && !l.startsWith("#")),
  };
  writeFileSync(path.join(dest, "VERSION.json"), JSON.stringify(info, null, 2) + "\n");
  // A quick check that it imports with nothing but itself (the way the app runs it).
  run(py, ["-I", "-B", "-c", "import provenance_core.server, patchright.async_api, uvicorn, yaml"]);
  log(
    `provenance-core ${version} (${info.routerRev}) ready in vendor/router (${run("du", ["-sh", dest]).split("\t")[0]})`,
  );
}

await main();
