// Finding and running the fallback CLIs (claude, codex) and the provenance binary from the UI
// server. A GUI app's PATH is minimal, so besides PATH the usual install folders are searched.

import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** PATH plus where claude / codex / node usually land on a Mac. */
export function defaultSearchPath(): string {
  const h = homedir();
  const dirs = [
    ...(process.env.PATH ?? "").split(":"),
    path.join(h, ".local/bin"),
    path.join(h, ".claude/local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(h, ".npm-global/bin"),
    path.join(h, ".bun/bin"),
    path.join(h, ".volta/bin"),
    ...nvmBins(h),
  ];
  return [...new Set(dirs.filter(Boolean))].join(":");
}

function nvmBins(h: string): string[] {
  const root = path.join(h, ".nvm/versions/node");
  try {
    return readdirSync(root)
      .sort()
      .reverse()
      .map((v) => path.join(root, v, "bin"));
  } catch {
    return [];
  }
}

/** The first executable `name` in `searchPath`, or null. */
export function findCli(name: string, searchPath: string): string | null {
  for (const dir of searchPath.split(":")) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      // not here
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
  const env = { ...process.env, ...opts.env };
  if (opts.searchPath) env.PATH = opts.searchPath;
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        env,
        cwd: opts.cwd ?? homedir(),
        timeout: opts.timeoutMs ?? 10_000,
        maxBuffer: 8 * 1024 * 1024,
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
