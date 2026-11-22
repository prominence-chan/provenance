// A brand-new user's first run of the PACKAGED app, without a window: someone who has only
// Provenance.app, with no ~/.provenance, no ~/.local/bin/provenance and no router of their own.
//
// The app runs with HOME set to an empty scratch folder (so ~/.local/bin/provenance and
// ~/.provenance are the scratch ones, i.e. missing), PROVENANCE_HEADLESS=1 (no window, no Dock
// icon) and PROVENANCE_USER_DATA in the scratch folder, with no PROVENANCE_* / CODEX_HOME /
// TIERLM_* / PCORE_* from this shell. Its settings.json holds only what keeps the check off
// the owner's things: port 0 (never the installed app's fixed UI port) and a routerUrl where
// nothing answers (a new user has no router at :4141; this Mac does).
//
// Checks, with evidence: the app picked the binary inside it (Contents/Resources/agent); its
// own router answers on its own port and pid (not the launchd one); app-server is that binary,
// started with HOME = the scratch home, TIERLM_BASE_URL = that router and its token; the
// Models & accounts dialog opens by itself and lists the sites and the token pool (headless
// Chromium on the app's UI); a thread runs a turn (TURN_MODEL, default spark: on a fresh router
// only the keyless pool can serve it); the thread's files are in the scratch ~/.provenance, not
// the real one; quitting ends app-server and the router.
//
//   npm run app:check:fresh        # APP=path/to/Provenance.app, TURN=0 skips the turn
//
// The turn is a real request to whichever source the fresh router picks (no sign-in, no key:
// the anonymous pool), so it spends none of the owner's quota but is not offline.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { UiHealth } from "../shared/router-api.ts";
import { findChromium } from "./chromium.ts";
import { skipWelcome } from "./e2e-kit.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.resolve(process.env.APP ?? path.join(root, "release/mac-arm64/Provenance.app"));
const exe = path.join(app, "Contents/MacOS/Provenance");
const turnModel = process.env.TURN_MODEL ?? "spark";
const wantTurn = process.env.TURN !== "0";
const log = (...a: unknown[]) => console.log("[app-fresh-check]", ...a);
function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`expected: ${what}`);
  log(`  ok: ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "provenance-fresh-")));
const home = path.join(scratch, "home");
const userData = path.join(scratch, "user-data");
const work = path.join(home, "work");
mkdirSync(work, { recursive: true });
mkdirSync(userData, { recursive: true });
writeFileSync(
  path.join(userData, "settings.json"),
  JSON.stringify({ port: 0, routerUrl: "http://127.0.0.1:9" }, null, 2),
);

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch {
    return "";
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
function listener(port: number): { pid: number; cmd: string } | null {
  const pid = Number(sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).split("\n")[0]);
  return pid ? { pid, cmd: sh("ps", ["-o", "command=", "-p", String(pid)]).trim() } : null;
}
function launchdRouterPid(): number | null {
  const line = sh("launchctl", ["list"])
    .split("\n")
    .find((l) => l.endsWith("\tcom.yufan.tierlm"));
  const pid = Number(line?.split("\t")[0]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}
/** Direct children of pid: [pid, command]. */
function children(pid: number): { pid: number; cmd: string }[] {
  return sh("pgrep", ["-P", String(pid)])
    .split("\n")
    .filter(Boolean)
    .map((p) => ({ pid: Number(p), cmd: sh("ps", ["-o", "command=", "-p", p]).trim() }));
}
/** One variable from a process's environment (`ps eww`; same user only). */
function envOf(pid: number, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}=(\\S*)`).exec(
    sh("ps", ["eww", "-o", "command=", "-p", String(pid)]),
  );
  return m?.[1];
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

// ---- JSON-RPC over the app's /rpc (as the page does) -------------------------------------
type Msg = { id?: number; method?: string; params?: any; result?: any; error?: any };
async function rpcClient(ui: string) {
  const ws = new WebSocket(`${ui.replace(/^http/, "ws")}/rpc`);
  let next = 1;
  const pending = new Map<number, (m: Msg) => void>();
  const listeners = new Set<(m: Msg) => void>();
  ws.onmessage = (ev) => {
    const m: Msg = JSON.parse(String(ev.data));
    if (m.id !== undefined && !m.method && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    } else for (const l of listeners) l(m);
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("cannot open /rpc"));
  });
  const waitMsg = (pred: (m: Msg) => boolean, ms: number) =>
    new Promise<Msg>((res, rej) => {
      const t = setTimeout(() => (listeners.delete(l), rej(new Error("timeout"))), ms);
      const l = (m: Msg) => {
        if (pred(m)) (clearTimeout(t), listeners.delete(l), res(m));
      };
      listeners.add(l);
    });
  const request = (method: string, params: unknown) =>
    new Promise<any>((res, rej) => {
      const id = next++;
      pending.set(id, (m) =>
        m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result),
      );
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, request, waitMsg, listeners };
}

let proc: ChildProcess | null = null;
let routerPid: number | null = null;
let appServerPid: number | null = null;
try {
  check(
    existsSync(path.join(app, "Contents/Resources/agent/provenance")),
    `${app} carries Contents/Resources/agent/provenance`,
  );
  check(
    !existsSync(path.join(home, ".provenance")) &&
      !existsSync(path.join(home, ".local/bin/provenance")),
    `HOME ${home}: no .provenance, no .local/bin/provenance`,
  );

  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!/^(PROVENANCE_|CODEX_HOME$|TIERLM_|PCORE_)/.test(k)) env[k] = v;
  Object.assign(env, { HOME: home, PROVENANCE_HEADLESS: "1", PROVENANCE_USER_DATA: userData });
  log(`launch ${exe} (HOME=${home})`);
  const p = spawn(exe, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  proc = p;
  p.stderr!.on("data", () => {});
  const ready = await new Promise<{
    ui: string;
    router: string;
    mode: string;
    routerPid: number | null;
    bin: string;
    binSource: string;
  }>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the app never said it was ready")), 60_000);
    readline.createInterface({ input: p.stdout! }).on("line", (l) => {
      if (!l.startsWith("PROVENANCE_READY ")) return;
      clearTimeout(t);
      resolve(JSON.parse(l.slice("PROVENANCE_READY ".length)));
    });
    p.once("exit", (c) => reject(new Error(`the app exited (${c}) before it was ready`)));
  });
  log(`  app pid ${p.pid}, ready: ${JSON.stringify(ready)}`);

  // ---- which binary ----------------------------------------------------------------------
  check(
    ready.binSource === "bundled" &&
      ready.bin === path.join(app, "Contents/Resources/agent/provenance"),
    `the app picked the binary inside it (${ready.bin}, ${ready.binSource})`,
  );

  // ---- which router ----------------------------------------------------------------------
  check(ready.mode === "bundled" && ready.routerPid, "the app started its own router");
  routerPid = ready.routerPid;
  const port = Number(new URL(ready.router).port);
  const health = await waitFor("the router answers", async () => {
    const h = await json<UiHealth>(`${ready.ui}/api/health`);
    return h.router.up && h.router.pid ? h : null;
  });
  check(
    health.bin.exists && health.bin.path === ready.bin,
    `/api/health: binary ${health.bin.path} exists`,
  );
  const lis = listener(port);
  check(
    lis?.pid === ready.routerPid &&
      health.router.pid === ready.routerPid &&
      lis.cmd.includes(path.join(app, "Contents/Resources/router/python/bin/python3")),
    `router pid ${lis?.pid} on 127.0.0.1:${port}: ${lis?.cmd.slice(0, 110)}…`,
  );
  check(health.router.home === path.join(userData, "router"), `router home ${health.router.home}`);
  const ld = launchdRouterPid();
  check(
    port !== 4141 && ld !== ready.routerPid,
    `not the launchd router (com.yufan.tierlm pid ${ld ?? "none"} on :4141)`,
  );

  // ---- app-server: the bundled binary, against that router, with a config home in HOME ------
  const as = await waitFor(
    "app-server running",
    async () => children(p.pid!).find((c) => c.cmd.includes("app-server")) ?? null,
  );
  appServerPid = as.pid;
  check(
    as.cmd.startsWith(path.join(app, "Contents/Resources/agent/provenance")),
    `app-server pid ${as.pid}: ${as.cmd}`,
  );
  check(
    envOf(as.pid, "TIERLM_BASE_URL") === `${ready.router}/v1`,
    `its TIERLM_BASE_URL is ${ready.router}/v1`,
  );
  check(!!envOf(as.pid, "TIERLM_TOKEN"), "it has the router's token (TIERLM_TOKEN set)");
  check(
    envOf(as.pid, "HOME") === home &&
      !envOf(as.pid, "PROVENANCE_HOME") &&
      !envOf(as.pid, "CODEX_HOME"),
    `its HOME is the scratch home, no PROVENANCE_HOME / CODEX_HOME given`,
  );
  await waitFor("config home created", async () => existsSync(path.join(home, ".provenance")));
  check(true, `it made its config home ${path.join(home, ".provenance")}`);
  const direct = await fetch(`${ready.router}/v1/models`);
  check(direct.status === 401, "the router refuses requests without the app's token");

  // ---- the Models & accounts dialog, as a new user sees it ------------------------------
  const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 820 } })
    ).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ready.ui);
    await skipWelcome(page); // nothing is set up: the welcome comes first
    await page.waitForSelector(".setup-dialog[open] .setup-sites", { timeout: 30_000 });
    const sites = await page
      .locator(".setup-dialog[open] .setup-site")
      .evaluateAll((els) =>
        els.map(
          (e) =>
            `${e.getAttribute("data-provider")}: ${e.querySelector(".setup-status")?.textContent ?? ""}`,
        ),
      );
    const pool = await page.locator(".setup-dialog[open] .setup-pool .setup-status").innerText();
    const note = await page.locator(".setup-dialog[open] .setup-router").innerText();
    check(
      sites.length >= 1,
      `the dialog opened by itself on first run: ${sites.join("; ")}; token pool: ${pool}`,
    );
    check(
      note.includes(String(ready.routerPid)) || /Provenance/.test(note),
      `router note: ${note.replace(/\s+/g, " ")}`,
    );
    await page.screenshot({ path: path.join(tmpdir(), "provenance-fresh-dialog.png") });
    log(`  screenshot ${path.join(tmpdir(), "provenance-fresh-dialog.png")}`);
    const tiers = await json<{ tiers: string[]; source: string }>(`${ready.ui}/api/tiers`);
    check(tiers.source === "tierlm", `tiers from the router: ${tiers.tiers.join(", ")}`);
    check(!errors.length, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } finally {
    await browser.close();
  }

  // ---- a turn ------------------------------------------------------------------------------
  if (wantTurn) {
    const rpc = await rpcClient(ready.ui);
    await rpc
      .waitMsg((m) => m.method === "bridge/status" && m.params.state === "ready", 60_000)
      .catch(() => {});
    await rpc.request("initialize", {
      clientInfo: { name: "provenance_fresh_check", title: null, version: "0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    const started = await rpc.request("thread/start", {
      model: turnModel,
      cwd: work,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const threadId: string = started.thread.id;
    log(`  thread/start ${threadId}: model ${started.model}, provider ${started.modelProvider}`);
    check(
      started.model === turnModel && started.modelProvider === "tierlm",
      `thread on ${turnModel} via the built-in tierlm provider`,
    );
    let ok = false;
    for (let i = 1; i <= 3 && !ok; i++) {
      let streamed = "";
      const onMsg = (m: Msg) => {
        if (m.method === "item/agentMessage/delta" && m.params.threadId === threadId)
          streamed += m.params.delta;
        if (m.method === "error" && m.params.threadId === threadId)
          log(`    error: ${m.params.error?.message}`);
      };
      rpc.listeners.add(onMsg);
      const done = rpc.waitMsg(
        (m) => m.method === "turn/completed" && m.params.threadId === threadId,
        180_000,
      );
      const since = Math.floor(Date.now() / 1000) - 1;
      const t = await rpc.request("turn/start", {
        threadId,
        model: turnModel,
        input: [{ type: "text", text: "reply with just ok", text_elements: [] }],
      });
      const completed = await done;
      rpc.listeners.delete(onMsg);
      const status = completed.params.turn.status;
      log(
        `  attempt ${i}: turn ${t.turn.id} ${status}, reply ${JSON.stringify(streamed.trim())}${completed.params.turn.error ? `, error ${completed.params.turn.error.message}` : ""}`,
      );
      if (status === "completed" && streamed.trim()) {
        ok = true;
        const usage = await json<{ models?: { model: string; requests: number }[] }>(
          `${ready.ui}/api/usage?key=${threadId}&turn=${t.turn.id}&since=${since}&until=${Math.ceil(Date.now() / 1000) + 1}`,
        );
        log(
          `  served by (router ledger): ${(usage.models ?? []).map((m) => `${m.model} x${m.requests}`).join(", ") || "?"}`,
        );
      } else if (i < 3) await sleep(3000);
    }
    check(ok, "a thread ran a turn and streamed a reply");
    rpc.ws.close();
    const sessions = path.join(home, ".provenance/sessions");
    const mine = sh("find", [sessions, "-name", `*${threadId}*`]).trim();
    check(!!mine, `its rollout is in the scratch config home (${mine.replace(home, "$HOME")})`);
    const real = path.join(homedir(), ".provenance/sessions");
    check(
      !existsSync(real) || !sh("find", [real, "-name", `*${threadId}*`]).trim(),
      "and not in the real ~/.provenance",
    );
  } else log("(TURN=0: no turn)");

  // ---- quit ------------------------------------------------------------------------------
  p.kill("SIGTERM");
  await new Promise((r) => p.once("exit", r));
  proc = null;
  await waitFor(
    "app-server and router gone",
    async () => (!alive(appServerPid!) && !alive(routerPid!)) || null,
    20_000,
  );
  check(true, `quit: app-server (pid ${appServerPid}) and the router (pid ${routerPid}) are gone`);
  log(`scratch home after the run: ${readdirSync(home).join(", ")}`);
  log("PASS");
} catch (e) {
  log("FAIL:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  if (proc && proc.exitCode === null) {
    proc.kill("SIGTERM");
    await sleep(4000);
  }
  for (const pid of [appServerPid, routerPid]) if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  const left = sh("pgrep", ["-fl", scratch]).split("\n").filter(Boolean);
  if (left.length) {
    log("WARNING: still running, ending them:", left.join(" | "));
    for (const l of left) process.kill(Number(l.split(" ")[0]), "SIGKILL");
  }
  rmSync(scratch, { recursive: true, force: true });
}
