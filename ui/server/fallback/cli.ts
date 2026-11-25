// Finding and running the fallback CLIs (claude, codex, agy) and the provenance binary from the
// UI server. A GUI app's PATH is minimal, so besides PATH the usual install folders are searched
// on macOS, Linux, and Windows.

import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";

/** True for Windows batch/cmd shims that require `shell: true` under Node 20.12+. */
export function isWinBatch(file: string): boolean {
  return IS_WIN && /\.(cmd|bat)$/i.test(file);
}

/** Return a copy of `env` with PATH set cleanly (handling Windows' case-insensitive `Path`). */
export function envWithPath(base: NodeJS.ProcessEnv, searchPath?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (!searchPath) return env;
  if (IS_WIN) {
    for (const k of Object.keys(env)) {
      if (k.toLowerCase() === "path" && k !== "PATH") delete env[k];
    }
  }
  env.PATH = searchPath;
  return env;
}

/** PATH plus where claude / codex / agy / node usually land on macOS, Linux, and Windows. */
export function defaultSearchPath(): string {
  const h = homedir();
  const rawPath =
    process.env.PATH ??
    (IS_WIN
      ? (Object.entries(process.env).find(([k]) => k.toLowerCase() === "path")?.[1] ?? "")
      : "");
  const dirs = rawPath.split(path.delimiter);
  if (IS_WIN) {
    const appData = process.env.APPDATA ?? path.join(h, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA ?? path.join(h, "AppData", "Local");
    dirs.push(
      path.join(h, ".local", "bin"),
      path.join(h, ".claude", "local"),
      path.join(appData, "npm"),
      path.join(localAppData, "Programs", "claude"),
      path.join(localAppData, "Programs", "antigravity"),
      path.join(localAppData, "Volta", "bin"),
      path.join(h, ".bun", "bin"),
      path.join(h, ".volta", "bin"),
      ...(process.env.NVM_SYMLINK ? [process.env.NVM_SYMLINK] : []),
    );
  } else {
    dirs.push(
      path.join(h, ".local", "bin"),
      path.join(h, ".claude", "local"),
      ...(process.platform === "darwin" ? ["/opt/homebrew/bin"] : ["/snap/bin"]),
      "/usr/local/bin",
      "/usr/bin",
      path.join(h, ".npm-global", "bin"),
      path.join(h, ".bun", "bin"),
      path.join(h, ".volta", "bin"),
      ...nvmBins(h),
    );
  }
  return [...new Set(dirs.filter(Boolean))].join(path.delimiter);
}

function nvmBins(h: string): string[] {
  const root = path.join(h, ".nvm", "versions", "node");
  try {
    return readdirSync(root)
      .sort()
      .reverse()
      .map((v) => path.join(root, v, "bin"));
  } catch {
    return [];
  }
}

/** Executable candidate filenames for `name` on the current platform. */
function candidatesFor(name: string): string[] {
  if (!IS_WIN) return [name];
  if (/\.[a-z0-9]+$/i.test(name)) return [name];
  const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  return [...exts.map((ext) => `${name}${ext.toLowerCase()}`), name];
}

/** The first executable `name` in `searchPath`, or null. */
export function findCli(name: string, searchPath: string): string | null {
  const names = candidatesFor(name);
  const mode = IS_WIN ? constants.F_OK : constants.X_OK;
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of names) {
      const p = path.join(dir, candidate);
      try {
        accessSync(p, mode);
        if (statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Didn't start (ENOENT, EACCES) or ran out of time. */
  failed: string | null;
}

/** Run a short command; never throws. The env's PATH lets `#!/usr/bin/env node` scripts find node. */
export function run(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; searchPath?: string; timeoutMs?: number; cwd?: string } = {},
): Promise<RunResult> {
  const env = envWithPath({ ...process.env, ...opts.env }, opts.searchPath);
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        env,
        cwd: opts.cwd ?? homedir(),
        timeout: opts.timeoutMs ?? 10_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: isWinBatch(file),
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean }) | null;
        const code = e ? (typeof e.code === "number" ? e.code : null) : 0;
        const failed = !e
          ? null
          : e.killed
            ? "timed out"
            : typeof e.code === "string"
              ? e.code
              : null;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed });
      },
    );
  });
}
