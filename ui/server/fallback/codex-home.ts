// "Run Codex through Provenance": a config home of the provenance binary's own (PROVENANCE_HOME)
// whose login is the one stock Codex keeps, so the fork can send its model requests to OpenAI
// with your Codex ChatGPT login.
//
// How: <home>/auth.json is a symlink to Codex's auth.json (and auth.lock to Codex's auth.lock).
// The fork's credential store follows the link both ways (codex-rs/login/src/auth/storage.rs:
// it reads through it, and a token refresh replaces the link's TARGET, never the link), and it
// takes its cross-process write lock on <home>/auth.lock, which then is the same file Codex
// locks. So the fork and Codex share one login: a refresh by either is seen by both, nothing is
// copied, and no token value passes through this app (it never opens either file).
//
// A real auth.json already in the home (someone ran `provenance login` there) is left alone and
// used instead. Everything else in the home (sessions, caches) is the fork's own, so threads run
// this way never mix with ~/.provenance (the tiers) or ~/.codex (Codex's own sessions).

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Where stock Codex keeps its login: $CODEX_HOME, else ~/.codex. */
export function codexLoginHome(): string {
  const env = process.env.CODEX_HOME;
  return env && env.trim() ? env : path.join(homedir(), ".codex");
}

export type HomeLogin = "linked" | "own" | "none";

/**
 * Make <home> and link its auth files to Codex's. "linked": the fork uses Codex's login; "own":
 * the home has a login of its own; "none": Codex has no auth.json to share.
 */
export function prepareCodexHome(home: string, loginHome = codexLoginHome()): HomeLogin {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = path.join(loginHome, "auth.json");
  const link = path.join(home, "auth.json");
  const kind = linkKind(link);
  if (kind === "file") return "own";
  if (!existsSync(target)) return "none";
  for (const f of ["auth.json", "auth.lock"]) {
    const l = path.join(home, f);
    const t = path.join(loginHome, f);
    const k = linkKind(l);
    if (k === "file") continue; // a real lock file: harmless, keep it
    if (k === "link" && readlinkSync(l) === t) continue;
    if (k === "link") unlinkSync(l); // pointed at another Codex home ($CODEX_HOME changed)
    symlinkSync(t, l);
  }
  return "linked";
}

function linkKind(p: string): "link" | "file" | "missing" {
  try {
    return lstatSync(p).isSymbolicLink() ? "link" : "file";
  } catch {
    return "missing";
  }
}

/** Environment for the provenance binary running on that home (never ~/.provenance, never ~/.codex). */
export function codexHomeEnv(home: string): NodeJS.ProcessEnv {
  return { PROVENANCE_HOME: home, CODEX_HOME: home };
}
