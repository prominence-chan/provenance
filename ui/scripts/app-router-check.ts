// Checks the router Provenance.app carries, in the packaged app itself, without a window:
// the app runs with PROVENANCE_HEADLESS=1 (no window, no Dock icon, never the active app) and
// PROVENANCE_USER_DATA=<scratch> (its settings, logs and router home there, so it meets neither
// the installed app's files nor its single-instance lock). app-server's state goes to a scratch
// PROVENANCE_HOME. Two launches:
//
//   1. routerUrl points where nothing answers, so the app starts its own router: it answers
//      (/v1/models, /web/accounts) on its own port and pid, not the launchd router's; it wants
//      its token; it prepared the sign-in browser from Contents/Resources/browser; killed, it
//      is restarted; on quit (SIGTERM) the router and everything under the scratch folder end.
//   2. the app is killed outright (SIGKILL, as a crash): its router stops by itself.
//
// Before that, without the app: the same supervisor (electron/router.ts) given a routerUrl that
// answers (the owner's launchd router, when it runs) uses it and starts nothing.
//
//   npm run app:check:router       # APP=path/to/Provenance.app, default release/mac-arm64

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { UiHealth, WireSources, WireWebAccounts } from "../shared/router-api.ts";
import { RouterSupervisor } from "../electron/router.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.resolve(process.env.APP ?? path.join(root, "release/mac-arm64/Provenance.app"));
const exe = path.join(app, "Contents/MacOS/Provenance");
const OWN_URL = process.env.OWN_ROUTER_URL ?? "http://127.0.0.1:4141";
const log = (...a: unknown[]) => console.log("[app-router-check]", ...a);
function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`expected: ${what}`);
  log(`  ok: ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "provenance-app-check-")));

/** Every process whose command line mentions the scratch folder (the router, its browsers). */
function underScratch(): string[] {
  try {
    return execFileSync("pgrep", ["-fl", scratch], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** pid listening on a TCP port, and its command. */
function listener(port: number): { pid: number; cmd: string } | null {
  try {
    const pid = Number(
      execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
        .split("\n")[0]
        .trim(),
    );
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return { pid, cmd };
  } catch {
    return null;
  }
}
function launchdRouterPid(): number | null {
  try {
    const line = execFileSync("launchctl", ["list"], { encoding: "utf8" })
      .split("\n")
      .find((l) => l.endsWith("\tcom.yufan.tierlm"));
    const pid = Number(line?.split("\t")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

interface Ready {
  ui: string;
  router: string;
  mode: string;
  routerPid: number | null;
}

function launch(name: string, settings: object): Promise<{ proc: ChildProcess; ready: Ready }> {
  const userData = path.join(scratch, name);
  mkdirSync(userData, { recursive: true });
  // port 0: never the installed app's fixed UI port (41730), should it start meanwhile
  writeFileSync(
    path.join(userData, "settings.json"),
    JSON.stringify({ port: 0, ...settings }, null, 2),
  );
  const proc = spawn(exe, [], {
    env: {
      ...process.env,
      PROVENANCE_HEADLESS: "1",
      PROVENANCE_USER_DATA: userData,
      PROVENANCE_HOME: path.join(scratch, `${name}-provenance-home`),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr!.on("data", () => {}); // Chromium's own chatter
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the app never said it was ready")), 60_000);
    readline.createInterface({ input: proc.stdout! }).on("line", (l) => {
      if (!l.startsWith("PROVENANCE_READY ")) return;
      clearTimeout(t);
      resolve({ proc, ready: JSON.parse(l.slice("PROVENANCE_READY ".length)) });
    });
    proc.once("exit", (c) => reject(new Error(`the app exited (${c}) before it was ready`)));
  });
}

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return (await r.json()) as T;
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | false>,
  ms = 30_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(500);
  }
}

const deadUrl = "http://127.0.0.1:9"; // the discard port: nothing answers there
let running: ChildProcess | null = null;
try {
  // ---- 0. an answering router is used as it is ----------------------------------------
  const own = await fetch(`${OWN_URL}/v1/models`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (own) {
    const sup = new RouterSupervisor({
      policy: "auto",
      configuredUrl: OWN_URL,
      resources: path.join(app, "Contents/Resources"),
      home: path.join(scratch, "unused-home"),
      logFile: path.join(scratch, "unused.log"),
      log: () => {},
    });
    await sup.start();
    check(
      sup.status().mode === "external" && sup.connection().url === OWN_URL && !sup.pid,
      `with ${OWN_URL} answering, the app uses it and starts nothing`,
    );
    await sup.stop();
  } else log(`(${OWN_URL} not answering: skipped the external check)`);

  // ---- 1. the app's own router --------------------------------------------------------
  log("launch 1: routerUrl answers nowhere -> the bundled router");
  const { proc, ready } = await launch("run1", { routerUrl: deadUrl, router: "auto" });
  running = proc;
  log(`  app pid ${proc.pid}, ready: ${JSON.stringify(ready)}`);
  check(ready.mode === "bundled" && ready.routerPid, "the app started its own router");
  const port = Number(new URL(ready.router).port);
  const health = await waitFor("the router answers", async () => {
    const h = await json<UiHealth>(`${ready.ui}/api/health`);
    return h.router.up && h.router.pid ? h : null;
  });
  check(health.router.mode === "bundled", "the UI server reports it as the app's own");
  check(
    health.router.pid === ready.routerPid,
    `/health pid ${health.router.pid} is the app's child`,
  );
  check(
    health.router.home === path.join(scratch, "run1/router"),
    `its home is the app's (${health.router.home})`,
  );
  const lis = listener(port);
  check(
    lis?.pid === ready.routerPid &&
      lis.cmd.includes("Contents/Resources/router/python/bin/python3"),
    `port ${port} is held by pid ${lis?.pid}: ${lis?.cmd.slice(0, 120)}`,
  );
  const ld = launchdRouterPid();
  const ldPort = listener(4141);
  check(
    port !== 4141 && (ld === null || ld !== ready.routerPid),
    `not the launchd router (launchd com.yufan.tierlm pid ${ld ?? "none"}, :4141 held by pid ${ldPort?.pid ?? "nobody"})`,
  );
  const direct = await fetch(`${ready.router}/v1/models`);
  check(direct.status === 401, "the router wants the app's token (a page elsewhere can't use it)");
  const tiers = await json<{ tiers: string[]; source: string }>(`${ready.ui}/api/tiers`);
  check(
    tiers.source === "tierlm" && tiers.tiers.join() === "nova,solstice,ember,spark",
    `/v1/models answers through the app: ${tiers.tiers.join(", ")}`,
  );
  const acc = await json<WireWebAccounts>(`${ready.ui}/api/web/accounts`);
  check(
    acc.providers.map((p) => p.id).join() === "chatgpt-web,qwen-web,gemini-web" &&
      acc.providers.every((p) => p.enabled && p.accounts.length === 1),
    "/web/accounts: ChatGPT, Qwen, Gemini, on, one account each (catalog.app.yaml)",
  );
  const browser = await waitFor(
    "the sign-in browser prepared from the app",
    async () => {
      const b = (await json<WireWebAccounts>(`${ready.ui}/api/web/accounts`)).browser;
      return b.ready ? b : null;
    },
    120_000,
  );
  check(
    browser.version === "157.0.8103.78",
    `browser ready (${browser.version}), copied from Resources/browser`,
  );
  const src = await json<{ tiers: WireSources["tiers"] }>(`${ready.ui}/api/sources`);
  const solstice = src.tiers.find((t) => t.tier === "solstice")?.sources ?? [];
  check(
    solstice.some((s) => s.kind === "web" && s.needs === "signin"),
    "sources: the chat sites need a sign-in",
  );
  log(
    `  sources (solstice): ${solstice.map((s) => `${s.label}${s.needs ? ` [needs ${s.needs}]` : ""}`).join(", ")}`,
  );

  // killed: restarted on the same port
  process.kill(ready.routerPid!, "SIGKILL");
  const again = await waitFor("restarted", async () => {
    const h = await json<UiHealth>(`${ready.ui}/api/health`);
    return h.router.up && h.router.pid && h.router.pid !== ready.routerPid ? h : null;
  });
  check(
    listener(port)?.pid === again.router.pid,
    `killed, it was restarted (pid ${again.router.pid}, same port)`,
  );

  // quit
  proc.kill("SIGTERM");
  await new Promise((r) => proc.once("exit", r));
  running = null;
  await waitFor(
    "everything gone",
    async () => (!underScratch().length && !alive(again.router.pid!)) || null,
    15_000,
  );
  check(true, "quit: the router and its browsers are gone");

  // ---- 2. a crash ---------------------------------------------------------------------
  log("launch 2: the app is killed outright");
  const second = await launch("run2", { routerUrl: deadUrl, router: "auto" });
  running = second.proc;
  await waitFor(
    "the router answers",
    async () => (await json<UiHealth>(`${second.ready.ui}/api/health`)).router.up || null,
  );
  const pid2 = second.ready.routerPid!;
  second.proc.kill("SIGKILL");
  await new Promise((r) => second.proc.once("exit", r));
  running = null;
  await waitFor(
    "the router stops by itself",
    async () => (!alive(pid2) && !underScratch().length) || null,
    30_000,
  );
  check(true, `after a crash the router (pid ${pid2}) stopped by itself (--watch-stdin)`);
  log("PASS");
} catch (e) {
  log("FAIL:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  if (running && running.exitCode === null) {
    running.kill("SIGTERM");
    await sleep(3000);
  }
  const left = underScratch();
  if (left.length) {
    log("WARNING: still running, ending them:", left.join(" | "));
    for (const l of left) process.kill(Number(l.split(" ")[0]), "SIGKILL");
  }
  rmSync(scratch, { recursive: true, force: true });
}
