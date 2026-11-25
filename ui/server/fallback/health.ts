// Health checks for the fallbacks (GET /api/fallbacks): is the CLI there, does it run, is it
// signed in, and which models it offers. Every check is local and spends no usage: `--version`,
// `claude auth status --json`, `codex login status`, `codex debug models`, and the provenance
// binary's `login status` / `debug models` on the "through Provenance" home, and the router's
// pass-through answering (its /_health, nothing forwarded). A missing CLI is a normal state ("not
// installed" + how to get it), never an error.

import type {
  CliHealth,
  FallbackModel,
  FallbacksInfo,
  FallbackUsage,
  FallbackUsageWindow,
} from "../../shared/fallback-api.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  FALLBACK_EFFORTS,
  isFallbackEffort,
  type FallbackEffort,
} from "../../shared/orchestrator-api.ts";
import { extractUsage } from "./agy-stream.ts";
import { findCli, run } from "./cli.ts";
import { codexHomeEnv, codexLoginHome, prepareCodexHome } from "./codex-home.ts";
import { checkCodexRoute, type RouterRef } from "./codex-route.ts";
import { CLAUDE_MODELS, CODEX_MODELS } from "./known-models.ts";

export interface FallbackEnv {
  /** Where to look for claude / codex / agy (PATH-style). */
  searchPath: string;
  /** The provenance binary (the app's agent). */
  provenanceBin: string;
  /** PROVENANCE_HOME for "through Provenance" (codex-home.ts). */
  codexHome: string;
  /** Where Codex keeps its login (default $CODEX_HOME or ~/.codex). */
  codexLoginHome?: string;
  /** The router "through Provenance" sends its model requests to (codex-route.ts); unset: not checked. */
  router?: RouterRef;
  /** Optional file where observed fallback weekly usage snapshots are stored. */
  usageFile?: string;
  /** Optional override for Claude Code's local config JSON (default ~/.claude.json). */
  claudeConfigFile?: string;
}

function loadSavedUsage(file?: string): Partial<Record<CliHealth["id"], FallbackUsage>> {
  if (!file || !existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Partial<
      Record<CliHealth["id"], FallbackUsage>
    >;
  } catch {
    return {};
  }
}

/**
 * Read Claude Code's own locally cached utilization from ~/.claude.json (`cachedUsageUtilization`).
 * Plain local config metadata (no secrets/keychain), so weekly usage shows immediately on startup.
 */
export function loadClaudeCachedUsage(configFile?: string): FallbackUsage | null {
  const candidates = configFile
    ? [configFile]
    : [
        ...(process.env.CLAUDE_CONFIG_DIR
          ? [path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")]
          : []),
        path.join(homedir(), ".claude.json"),
        ...(process.platform === "win32" && process.env.APPDATA
          ? [path.join(process.env.APPDATA, "Claude", ".claude.json")]
          : []),
      ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        cachedUsageUtilization?: { fetchedAtMs?: unknown; utilization?: Record<string, unknown> };
      };
      const cached = raw?.cachedUsageUtilization;
      if (!cached?.utilization || typeof cached.utilization !== "object") continue;
      const parsed = extractUsage({ utilization: cached.utilization });
      if (!parsed) continue;
      const fetchedAt =
        typeof cached.fetchedAtMs === "number" && Number.isFinite(cached.fetchedAtMs)
          ? cached.fetchedAtMs
          : parsed.updatedAt;
      return { ...parsed, updatedAt: fetchedAt };
    } catch {
      // unreadable or malformed config; ignore
    }
  }
  return null;
}

function mergeUsage(
  a: FallbackUsage | null | undefined,
  b: FallbackUsage | null | undefined,
): FallbackUsage | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const [newer, older] = (a.updatedAt ?? 0) >= (b.updatedAt ?? 0) ? [a, b] : [b, a];
  const buckets =
    newer.buckets || older.buckets ? { ...older.buckets, ...newer.buckets } : undefined;
  return {
    weeklyRemaining: newer.weeklyRemaining ?? older.weeklyRemaining ?? null,
    weeklyResetsAt: newer.weeklyResetsAt ?? older.weeklyResetsAt ?? null,
    primaryRemaining: newer.primaryRemaining ?? older.primaryRemaining ?? null,
    primaryResetsAt: newer.primaryResetsAt ?? older.primaryResetsAt ?? null,
    ...(buckets ? { buckets } : {}),
    updatedAt: newer.updatedAt ?? older.updatedAt,
  };
}

const DEFAULT: FallbackModel = { id: "", label: "Default" };

function blank(id: CliHealth["id"]): CliHealth {
  return {
    id,
    installed: false,
    path: null,
    version: null,
    signedIn: null,
    account: null,
    problem: null,
    fix: null,
  };
}

export async function checkClaude(env: FallbackEnv): Promise<FallbacksInfo["claude"]> {
  const h = blank("claude");
  const bin = findCli("claude", env.searchPath);
  if (!bin) {
    return {
      ...h,
      problem: "Not installed",
      fix:
        process.platform === "win32"
          ? "Install it in PowerShell with: irm https://claude.ai/install.ps1 | iex"
          : "Install it with: curl -fsSL https://claude.ai/install.sh | bash",
      models: [DEFAULT, ...CLAUDE_MODELS],
    };
  }
  h.installed = true;
  h.path = bin;
  const opts = { searchPath: env.searchPath };
  const [ver, auth, help] = await Promise.all([
    run(bin, ["--version"], opts),
    run(bin, ["auth", "status", "--json"], opts),
    run(bin, ["--help"], opts),
  ]);
  if (ver.code !== 0) {
    h.problem = `It didn't run (${ver.failed ?? `exit ${ver.code}`})`;
    h.fix = "Reinstall it, or run `claude --version` in a terminal to see why.";
    return { ...h, models: [DEFAULT, ...CLAUDE_MODELS] };
  }
  h.version = /(\d+\.\d+\.\d+\S*)/.exec(ver.stdout)?.[1] ?? (ver.stdout.trim() || null);
  try {
    // Only the fields below are read; the e-mail and organisation are left where they are.
    const a = JSON.parse(auth.stdout) as {
      loggedIn?: boolean;
      authMethod?: string;
      subscriptionType?: string;
    };
    h.signedIn = a.loggedIn === true;
    if (h.signedIn) {
      h.account =
        a.authMethod === "claude.ai"
          ? `Claude subscription${a.subscriptionType ? ` (${a.subscriptionType})` : ""}`
          : a.authMethod
            ? a.authMethod.replace(/_/g, " ")
            : null;
    }
  } catch {
    h.signedIn = process.env.ANTHROPIC_API_KEY ? true : null; // an older CLI: can't tell cheaply
    if (h.signedIn) h.account = "Anthropic API key";
  }
  if (h.signedIn === false) {
    h.problem = "Not signed in";
    h.fix = "Run `claude` in a terminal once and sign in.";
  }
  const efforts = claudeEfforts(help.stdout);
  return { ...h, models: claudeModels(help.stdout).map((m) => ({ ...m, efforts })) };
}

/**
 * The levels Claude Code's `--effort <level>` takes, as its own --help lists them ("Effort level
 * for the current session (low, medium, high, xhigh, max)"); none for a CLI without the flag.
 */
export function claudeEfforts(help: string): FallbackEffort[] {
  const para = /--effort <level>([\s\S]*?)(?:\n\s{2}-|\n\n|$)/.exec(help)?.[1];
  if (para === undefined) return [];
  const listed = /\(([^)]*)\)/.exec(para)?.[1] ?? "";
  return sortEfforts(listed.split(/[\s,]+/).filter(isFallbackEffort));
}

const sortEfforts = (list: FallbackEffort[]) =>
  [...new Set(list)].sort((a, b) => FALLBACK_EFFORTS.indexOf(a) - FALLBACK_EFFORTS.indexOf(b));

/** Aliases the CLI's own --help names for --model ("e.g. 'fable', 'opus', or 'sonnet'"), then the known list. */
export function claudeModels(help: string): FallbackModel[] {
  const out: FallbackModel[] = [DEFAULT];
  const para = /--model <model>([\s\S]*?)(?:\n\s{2}-|\n\n|$)/.exec(help)?.[1] ?? "";
  const seen = new Set<string>();
  const add = (id: string, label: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label });
  };
  for (const m of para.matchAll(/'([a-z][a-z0-9.-]{1,30})'/g)) add(m[1], cap(m[1]));
  for (const m of CLAUDE_MODELS) add(m.id, m.label);
  return out;
}

const cap = (s: string) => s.slice(0, 1).toUpperCase() + s.slice(1);

export async function checkCodex(env: FallbackEnv): Promise<FallbacksInfo["codex"]> {
  const h = blank("codex");
  const bin = findCli("codex", env.searchPath);
  const provenance = checkThroughProvenance(env);
  if (!bin) {
    return {
      ...h,
      problem: "Not installed",
      fix: "Install it with: npm install -g @openai/codex",
      models: [DEFAULT, ...CODEX_MODELS],
      provenance: await provenance,
    };
  }
  h.installed = true;
  h.path = bin;
  const opts = { searchPath: env.searchPath };
  const [ver, status, models] = await Promise.all([
    run(bin, ["--version"], opts),
    run(bin, ["login", "status"], opts),
    run(bin, ["debug", "models"], { ...opts, timeoutMs: 15_000 }),
  ]);
  if (ver.code !== 0) {
    h.problem = `It didn't run (${ver.failed ?? `exit ${ver.code}`})`;
    h.fix = "Reinstall it, or run `codex --version` in a terminal to see why.";
    return { ...h, models: [DEFAULT, ...CODEX_MODELS], provenance: await provenance };
  }
  h.version = /(\d+\.\d+\.\d+\S*)/.exec(ver.stdout)?.[1] ?? (ver.stdout.trim() || null);
  const said = `${status.stdout}\n${status.stderr}`;
  const login = loginKind(said);
  h.signedIn = status.code === 0 && login !== null;
  h.account = h.signedIn ? login : null;
  if (!h.signedIn) {
    h.problem = "Not signed in";
    h.fix = "Run `codex login` in a terminal and sign in with ChatGPT.";
  }
  return {
    ...h,
    models: catalogModels(models.stdout) ?? [DEFAULT, ...CODEX_MODELS],
    provenance: await provenance,
  };
}

/** "Logged in using ChatGPT" / "Logged in using an API key" -> "ChatGPT" / "API key"; else null. */
export function loginKind(text: string): string | null {
  if (/not logged in/i.test(text)) return null;
  if (/logged in using chatgpt/i.test(text)) return "ChatGPT";
  if (/logged in using an api key|api key/i.test(text) && /logged in/i.test(text)) return "API key";
  if (/logged in/i.test(text)) return "Signed in";
  return null;
}

/**
 * `codex debug models` / `provenance debug models` JSON -> the listed (not hidden) models, each
 * with the reasoning efforts the catalog says it supports and its default. "Default" (no -m: the
 * model Codex's own config picks, which the page doesn't read) offers every listed model's.
 */
export function catalogModels(json: string): FallbackModel[] | null {
  try {
    const d = JSON.parse(json) as {
      models?: {
        slug?: string;
        display_name?: string;
        visibility?: string;
        priority?: number;
        supported_reasoning_levels?: { effort?: unknown }[];
        default_reasoning_level?: unknown;
      }[];
    };
    const list: FallbackModel[] = (d.models ?? [])
      .filter((m) => typeof m.slug === "string" && m.visibility !== "hide")
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => ({
        id: m.slug!,
        label: m.display_name || m.slug!,
        efforts: sortEfforts(
          (m.supported_reasoning_levels ?? []).map((l) => l?.effort).filter(isFallbackEffort),
        ),
        defaultEffort: isFallbackEffort(m.default_reasoning_level)
          ? m.default_reasoning_level
          : null,
      }));
    if (!list.length) return null;
    return [{ ...DEFAULT, efforts: sortEfforts(list.flatMap((m) => m.efforts ?? [])) }, ...list];
  } catch {
    return null;
  }
}

/**
 * "Through Provenance": the provenance binary on its own home, linked to Codex's login, asked
 * what it sees there (`login status`, `debug models` with the OpenAI provider). Local only.
 */
export async function checkThroughProvenance(
  env: FallbackEnv,
): Promise<FallbacksInfo["codex"]["provenance"]> {
  const fallback = [DEFAULT, ...CODEX_MODELS];
  let linked;
  try {
    linked = prepareCodexHome(env.codexHome, env.codexLoginHome ?? codexLoginHome());
  } catch (e) {
    return { ready: false, problem: `Couldn't prepare its folder: ${String(e)}`, models: fallback };
  }
  if (linked === "none")
    return { ready: false, problem: "Needs Codex signed in with ChatGPT", models: fallback };
  const opts = { env: codexHomeEnv(env.codexHome), timeoutMs: 15_000 };
  const [status, models, route] = await Promise.all([
    run(env.provenanceBin, ["login", "status"], opts),
    run(env.provenanceBin, ["debug", "models", "-c", 'model_provider="openai"'], opts),
    env.router ? checkCodexRoute(env.router) : Promise.resolve(null),
  ]);
  if (status.failed === "ENOENT")
    return { ready: false, problem: "The provenance binary is missing", models: fallback };
  const kind = loginKind(`${status.stdout}\n${status.stderr}`);
  if (status.code !== 0 || kind !== "ChatGPT")
    return { ready: false, problem: "Needs Codex signed in with ChatGPT", models: fallback };
  // Its model requests go through the router: without it there, it doesn't run (never direct).
  if (route) return { ready: false, problem: route, models: fallback };
  return { ready: true, problem: null, models: catalogModels(models.stdout) ?? fallback };
}

export async function checkAntigravity(
  env: FallbackEnv,
): Promise<NonNullable<FallbacksInfo["antigravity"]>> {
  const h = blank("antigravity");
  const bin = findCli("agy", env.searchPath);
  if (!bin) {
    return {
      ...h,
      problem: "Not installed",
      fix: "Install Antigravity CLI so `agy` is on your PATH.",
      models: [DEFAULT],
    };
  }
  h.installed = true;
  h.path = bin;
  const opts = { searchPath: env.searchPath };
  const [ver, help, modelsRes, usageRes] = await Promise.all([
    run(bin, ["--version"], opts),
    run(bin, ["--help"], opts),
    run(bin, ["models"], { ...opts, timeoutMs: 12_000 }),
    run(bin, ["-p", "/usage"], { ...opts, timeoutMs: 10_000 }),
  ]);
  if (ver.code !== 0) {
    h.problem = `It didn't run (${ver.failed ?? `exit ${ver.code}`})`;
    h.fix = "Reinstall it, or run `agy --version` in a terminal to see why.";
    return { ...h, models: [DEFAULT] };
  }
  h.version = /(\d+\.\d+\.\d+\S*)/.exec(ver.stdout)?.[1] ?? (ver.stdout.trim() || null);
  const efforts = agyEfforts(`${help.stdout}\n${help.stderr}`);
  const parsedModels = agyModels(modelsRes.stdout || modelsRes.stderr, efforts);
  const usage = usageRes.code === 0 ? parseAgyUsage(usageRes.stdout) : null;
  if (usage) h.usage = usage;
  if (modelsRes.code === 0 && parsedModels.length > 1) {
    h.signedIn = true;
    h.account = "Antigravity";
  } else if (
    /not logged in|sign in|authenticate|unauthorized/i.test(
      `${modelsRes.stdout}\n${modelsRes.stderr}`,
    )
  ) {
    h.signedIn = false;
    h.problem = "Not signed in";
    h.fix = "Run `agy` in a terminal once and sign in.";
  } else {
    h.signedIn = modelsRes.code === 0 ? true : null;
    if (h.signedIn) h.account = "Antigravity";
  }
  return { ...h, models: parsedModels };
}

/**
 * Parse `agy -p /usage` TSV rows:
 *   Gemini Models\tWeekly Limit Remaining\t92%\t2026-12-01T14:47:23Z
 *   Claude and GPT models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z
 */
export function parseAgyUsage(stdout: string): FallbackUsage | null {
  const clean = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "\n");
  const buckets: Record<string, FallbackUsageWindow> = {};
  const ensure = (key: string): FallbackUsageWindow =>
    (buckets[key] ??= {
      weeklyRemaining: null,
      weeklyResetsAt: null,
      primaryRemaining: null,
      primaryResetsAt: null,
    });
  for (const raw of clean.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.includes("\t") ? line.split("\t") : line.split(/\s{2,}/);
    if (cols.length < 3) continue;
    const [group, label, pctCol, resetCol] = cols.map((s) => s.trim());
    const pctMatch = /(\d+(?:\.\d+)?)\s*%/.exec(pctCol);
    if (!pctMatch) continue;
    const val = Math.max(0, Math.min(1, parseFloat(pctMatch[1]) / 100));
    let resetMs: number | null = null;
    if (resetCol) {
      const ms = Date.parse(resetCol);
      if (Number.isFinite(ms) && ms > 86_400_000) resetMs = ms;
    }
    const key = /claude|gpt/i.test(group)
      ? "claude_gpt"
      : /gemini/i.test(group)
        ? "gemini"
        : "default";
    const b = ensure(key);
    if (/weekly|7\s*day/i.test(label)) {
      b.weeklyRemaining = val;
      b.weeklyResetsAt = resetMs;
    } else if (/five\s*hour|5\s*h/i.test(label)) {
      b.primaryRemaining = val;
      b.primaryResetsAt = resetMs;
    }
  }
  const keys = Object.keys(buckets);
  if (!keys.length) return null;
  const primaryBucket = buckets.gemini ?? buckets[keys[0]];
  return {
    weeklyRemaining: primaryBucket.weeklyRemaining,
    weeklyResetsAt: primaryBucket.weeklyResetsAt,
    primaryRemaining: primaryBucket.primaryRemaining,
    primaryResetsAt: primaryBucket.primaryResetsAt,
    buckets,
    updatedAt: Date.now(),
  };
}

/** Parse `--effort ... (low|medium|high|xhigh|max)` from `agy --help`. */
export function agyEfforts(help: string): FallbackEffort[] {
  const line = /--effort[^\n]*/.exec(help)?.[0] ?? "";
  const listed = /\(([^)]*)\)/.exec(line)?.[1] ?? "";
  return sortEfforts(listed.split(/[\s,|/]+/).filter(isFallbackEffort));
}

/** Parse `agy models` rows (TSV when piped: "gemini-4-neon-high\tGemini 4 Neon (High)", or 2+ spaces on a TTY). */
export function agyModels(stdout: string, efforts: FallbackEffort[]): FallbackModel[] {
  const clean = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "\n");
  const out: FallbackModel[] = [{ ...DEFAULT, efforts }];
  const seen = new Set<string>();
  for (const raw of clean.split("\n")) {
    const line = raw.trim();
    if (!line || /fetching available models/i.test(line)) continue;
    const m = /^([a-z0-9][a-z0-9._-]{1,60})(?:\t+|\s{2,})(.+)$/.exec(line);
    if (!m) continue;
    const [, id, label] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    const suffix = /-(none|minimal|low|medium|high|xhigh|max|ultra)$/.exec(id)?.[1];
    const defaultEffort = suffix && isFallbackEffort(suffix) ? suffix : null;
    out.push({ id, label: label.trim(), efforts, ...(defaultEffort ? { defaultEffort } : {}) });
  }
  return out;
}

let cache: { at: number; info: Promise<FallbacksInfo> } | null = null;

function attachUsage(base: FallbacksInfo, env: FallbackEnv): FallbacksInfo {
  const savedUsage = loadSavedUsage(env.usageFile);
  const claudeLocal = loadClaudeCachedUsage(env.claudeConfigFile);
  return {
    ...base,
    claude: {
      ...base.claude,
      usage: mergeUsage(mergeUsage(base.claude.usage, savedUsage.claude), claudeLocal),
    },
    codex: { ...base.codex, usage: mergeUsage(base.codex.usage, savedUsage.codex) },
    antigravity: base.antigravity
      ? {
          ...base.antigravity,
          usage: mergeUsage(base.antigravity.usage, savedUsage.antigravity),
        }
      : undefined,
  };
}

/** All fallback checks, cached for 20 s (`refresh` checks again now); usage files are always read fresh. */
export function getFallbacks(env: FallbackEnv, refresh = false): Promise<FallbacksInfo> {
  if (!refresh && cache && Date.now() - cache.at < 20_000) {
    return cache.info.then((base) => attachUsage(base, env));
  }
  const info = Promise.all([checkClaude(env), checkCodex(env), checkAntigravity(env)]).then(
    ([claude, codex, antigravity]) => ({
      claude,
      codex,
      antigravity,
      checkedAt: Math.floor(Date.now() / 1000),
    }),
  );
  cache = { at: Date.now(), info };
  info.catch(() => (cache = null));
  return info.then((base) => attachUsage(base, env));
}
