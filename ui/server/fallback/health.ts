// Health checks for the fallbacks (GET /api/fallbacks): is the CLI there, does it run, is it
// signed in, and which models it offers. Every check is local and spends no usage: `--version`,
// `claude auth status --json`, `codex login status`, `codex debug models`, and the provenance
// binary's `login status` / `debug models` on the "through Provenance" home, and the router's
// pass-through answering (its /_health, nothing forwarded). A missing CLI is a normal state ("not
// installed" + how to get it), never an error.

import type { CliHealth, FallbackModel, FallbacksInfo } from "../../shared/fallback-api.ts";
import { findCli, run } from "./cli.ts";
import { codexHomeEnv, codexLoginHome, prepareCodexHome } from "./codex-home.ts";
import { checkCodexRoute, type RouterRef } from "./codex-route.ts";
import { CLAUDE_MODELS, CODEX_MODELS } from "./known-models.ts";

export interface FallbackEnv {
  /** Where to look for claude / codex (PATH-style). */
  searchPath: string;
  /** The provenance binary (the app's agent). */
  provenanceBin: string;
  /** PROVENANCE_HOME for "through Provenance" (codex-home.ts). */
  codexHome: string;
  /** Where Codex keeps its login (default $CODEX_HOME or ~/.codex). */
  codexLoginHome?: string;
  /** The router "through Provenance" sends its model requests to (codex-route.ts); unset: not checked. */
  router?: RouterRef;
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
      fix: "Install it with: curl -fsSL https://claude.ai/install.sh | bash",
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
  return { ...h, models: claudeModels(help.stdout) };
}

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

/** `codex debug models` / `provenance debug models` JSON -> the listed (not hidden) models. */
export function catalogModels(json: string): FallbackModel[] | null {
  try {
    const d = JSON.parse(json) as {
      models?: { slug?: string; display_name?: string; visibility?: string; priority?: number }[];
    };
    const list = (d.models ?? [])
      .filter((m) => typeof m.slug === "string" && m.visibility !== "hide")
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => ({ id: m.slug!, label: m.display_name || m.slug! }));
    return list.length ? [DEFAULT, ...list] : null;
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

let cache: { at: number; info: Promise<FallbacksInfo> } | null = null;

/** Both checks, cached for 20 s (`refresh` checks again now). */
export function getFallbacks(env: FallbackEnv, refresh = false): Promise<FallbacksInfo> {
  if (!refresh && cache && Date.now() - cache.at < 20_000) return cache.info;
  const info = Promise.all([checkClaude(env), checkCodex(env)]).then(([claude, codex]) => ({
    claude,
    codex,
    checkedAt: Math.floor(Date.now() / 1000),
  }));
  cache = { at: Date.now(), info };
  info.catch(() => (cache = null));
  return info;
}
