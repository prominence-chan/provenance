// provenance-core for the desktop app. On start the app uses a router that already answers at
// the configured URL (someone runs their own, e.g. a launchd agent: it is left exactly as it
// is), otherwise it runs the copy bundled in Provenance.app (Contents/Resources/router: a
// relocatable Python with the router and its dependencies, see scripts/fetch-router.ts):
//
//   - on a free 127.0.0.1 port chosen once per launch (kept across restarts, so the URL the UI
//     server and `provenance app-server` were given stays right), with its own home under
//     ~/Library/Application Support/Provenance/router and a random bearer token per launch
//     (any web page can POST to localhost; the token keeps them out);
//   - with the web bridge on, pointed at the app's own browser (PCORE_BROWSER_APP), driven by
//     patchright through Electron's own Node (PLAYWRIGHT_NODEJS_PATH: the `node` wrapper next
//     to the router), so no second Node is shipped;
//   - watched: restarted with backoff when it exits, or when /health stops answering;
//   - stopped on quit. It also stops by itself when the app is gone however it went (a crash,
//     kill -9): it holds the read end of a pipe the app keeps open (`serve --watch-stdin`), and
//     its browsers have watchdogs of their own (provenance-core browser_host / web_setup).

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, renameSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { RouterMode, WireHealth } from "../shared/router-api.ts";
import type { RouterConnection, RouterStatus } from "../server/app.ts";

/** auto: an answering router at the configured URL, else the bundled one. */
export type RouterPolicy = "auto" | "external" | "bundled";

export interface RouterOptions {
  policy: RouterPolicy;
  /** Where an external router is looked for (settings.routerUrl). */
  configuredUrl: string;
  /** A launchd agent that runs the user's own router: waited for (never started or restarted). */
  launchdLabel?: string;
  /** Folder that holds router/ and browser/ (Contents/Resources, or ui/vendor in a checkout). */
  resources: string;
  /** The router's home (PCORE_HOME). */
  home: string;
  logFile: string;
  /** Called when the router's URL changed (the UI server re-reads it; app-server needs a restart). */
  onUrlChange?: (url: string) => void;
  log?: (...a: unknown[]) => void;
}

const HEALTH_EVERY_MS = 5000;
const HEALTH_MISSES = 4; // ~20 s without an answer from a router that was up: restart it
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
const STABLE_MS = 120_000; // up this long: the next crash starts the backoff over
const LOG_MAX = 5 * 1024 * 1024;

export class RouterSupervisor {
  private mode: RouterMode = "external";
  private url: string;
  private readonly token = randomBytes(24).toString("hex");
  private child: ChildProcess | null = null;
  private port = 0;
  private stopping = false;
  private crashes = 0;
  private upSince = 0;
  private misses = 0;
  private healthTimer: NodeJS.Timeout | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private state: RouterStatus = { up: false, message: "Checking provenance-core…" };
  private readonly log: (...a: unknown[]) => void;
  private readonly opts: RouterOptions;

  constructor(opts: RouterOptions) {
    this.opts = opts;
    this.url = opts.configuredUrl.replace(/\/$/, "");
    this.log = opts.log ?? ((...a) => console.log("[router]", ...a));
  }

  /** The router's folder in this build, or null when it has none (a checkout without vendor/router). */
  get bundledDir(): string | null {
    const dir = path.join(this.opts.resources, "router");
    return existsSync(path.join(dir, "python/bin/python3")) ? dir : null;
  }

  connection(): RouterConnection {
    return { url: this.url, token: this.mode === "bundled" ? this.token : undefined };
  }

  status(): RouterStatus {
    return { ...this.state, mode: this.mode };
  }

  /** The bundled router's process, while it runs (for logs and checks). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /**
   * Decide which router to use and, for the bundled one, start it. Resolves once the
   * decision is made (the URL is final); the bundled router comes up in the background.
   */
  async start(): Promise<void> {
    const { policy } = this.opts;
    if (policy !== "bundled" && (await answers(this.opts.configuredUrl))) return this.useExternal();
    if (
      policy === "auto" &&
      this.opts.launchdLabel &&
      (await agentLoaded(this.opts.launchdLabel))
    ) {
      // The user's own router is managed by launchd (KeepAlive): give it time to come back
      // rather than start a second one with an empty home.
      this.state = { up: false, message: `Waiting for ${this.opts.launchdLabel}…` };
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        if (await answers(this.opts.configuredUrl)) return this.useExternal();
      }
    }
    if (policy === "external" || !this.bundledDir) {
      this.useExternal();
      this.state = {
        up: false,
        message:
          policy === "external"
            ? "This app is set to use your own router (router: external in Preferences)."
            : "This build has no router of its own.",
      };
      return;
    }
    await this.useBundled();
  }

  /** The banner's "Start it" / "Retry": restart the bundled router, or switch to it. */
  async ensure(): Promise<RouterStatus> {
    if (this.mode === "bundled") {
      if (!(await this.healthy())) await this.restartNow("asked to restart");
    } else if (await answers(this.url)) {
      this.state = { up: true };
    } else if (this.opts.policy === "auto" && this.bundledDir) {
      await this.useBundled();
    }
    for (let i = 0; i < 40 && !this.state.up; i++) await sleep(500);
    return this.status();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.healthTimer);
    clearTimeout(this.restartTimer);
    await this.kill();
  }

  /** Synchronous last resort (process "exit"): no router outlives the app. */
  killNow(): void {
    try {
      this.child?.kill("SIGKILL");
    } catch {
      // gone
    }
  }

  // ---- external ------------------------------------------------------------------------

  private useExternal(): void {
    this.mode = "external";
    this.url = this.opts.configuredUrl.replace(/\/$/, "");
    this.state = { up: true };
    this.log(`using the router at ${this.url}`);
    this.watch();
  }

  // ---- bundled -------------------------------------------------------------------------

  private async useBundled(): Promise<void> {
    const changed = this.mode !== "bundled";
    this.mode = "bundled";
    this.port = await freePort();
    this.url = `http://127.0.0.1:${this.port}`;
    if (changed) this.opts.onUrlChange?.(this.url);
    this.spawn();
    this.watch();
  }

  private spawn(): void {
    const dir = this.bundledDir!;
    mkdirSync(this.opts.home, { recursive: true, mode: 0o700 });
    rotate(this.opts.logFile);
    const out = openSync(this.opts.logFile, "a");
    // Only what the router should see: the user's PATH and HOME (it runs osascript, open,
    // codesign, ditto), no PCORE_* / TIERLM_* / PYTHON* from a shell that set them for
    // another router. -I (isolated) also ignores PYTHON* and the user's site-packages; -B:
    // nothing is written into the signed app bundle (its .pyc files are compiled at build).
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env))
      if (!/^(PCORE_|TIERLM_|PYTHON|PLAYWRIGHT_|ELECTRON_)/.test(k)) env[k] = v;
    Object.assign(env, {
      PCORE_HOME: this.opts.home,
      PCORE_TOKEN: this.token,
      PCORE_BASE_URL: this.url,
      PCORE_CHATGPT_WEB: "1", // the web chats are on; a site can be turned off in Models & accounts
      PCORE_CHATGPT_WEB_DRIVER: "patchright", // the stock driver is stopped by chatgpt.com's browser check
      PCORE_BROWSER_APP: path.join(this.opts.resources, "browser"),
      PLAYWRIGHT_NODEJS_PATH: path.join(dir, "node"),
      PROVENANCE_ELECTRON: process.execPath, // what that wrapper runs (in a checkout: node_modules' Electron)
    });
    const args = [
      "-I",
      "-B",
      "-m",
      "provenance_core",
      "serve",
      "--catalog",
      path.join(dir, "catalog.app.yaml"),
      "--scores",
      path.join(this.opts.home, "scores.yaml"),
      "--host",
      "127.0.0.1",
      "--port",
      String(this.port),
      "--watch-stdin",
    ];
    const child = spawn(path.join(dir, "python/bin/python3"), args, {
      cwd: this.opts.home,
      env,
      stdio: ["pipe", out, out], // stdin stays open while the app lives: its EOF stops the router
    });
    closeSync(out);
    this.child = child;
    this.upSince = 0;
    this.misses = 0;
    this.state = { up: false, message: "Starting provenance-core…" };
    this.log(
      `started the bundled router (pid ${child.pid}) on ${this.url}, home ${this.opts.home}`,
    );
    child.stdin?.on("error", () => {}); // EPIPE once it's gone
    child.on("error", (e) => this.log("could not start:", e.message));
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      this.state = {
        up: false,
        message: `provenance-core stopped (${signal ?? `exit code ${code}`}); restarting. Log: ${this.opts.logFile}`,
      };
      this.log(`exited (${signal ?? code})`);
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.upSince && Date.now() - this.upSince > STABLE_MS) this.crashes = 0;
    const wait = BACKOFF_MS[Math.min(this.crashes, BACKOFF_MS.length - 1)];
    this.crashes++;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(async () => {
      if (this.stopping) return;
      // The port was taken meanwhile (another program): a new one, and tell the UI server.
      if (!(await portFree(this.port))) {
        this.port = await freePort();
        this.url = `http://127.0.0.1:${this.port}`;
        this.opts.onUrlChange?.(this.url);
      }
      this.spawn();
    }, wait);
  }

  private async restartNow(why: string): Promise<void> {
    this.log(`restarting: ${why}`);
    await this.kill();
    this.crashes = 0;
    if (!this.stopping) this.spawn();
  }

  private async kill(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    const gone = new Promise<void>((r) => child.once("exit", () => r()));
    child.stdin?.end(); // --watch-stdin: a clean shutdown (its browsers and sign-in window close)
    child.kill("SIGTERM");
    const t = setTimeout(() => child.kill("SIGKILL"), 8000);
    await gone;
    clearTimeout(t);
  }

  // ---- watching ------------------------------------------------------------------------

  private watch(): void {
    clearInterval(this.healthTimer);
    const tick = async () => {
      const ok = await this.healthy();
      if (ok) {
        if (!this.state.up) this.log("up");
        this.misses = 0;
        if (!this.upSince) this.upSince = Date.now();
        this.state = { up: true };
        return;
      }
      if (this.mode === "external") {
        this.state = { up: false, message: this.state.up ? undefined : this.state.message };
        return;
      }
      // Bundled and not answering: starting (no answer yet), or hung after being up.
      if (this.child && this.upSince && ++this.misses >= HEALTH_MISSES)
        await this.restartNow("no answer from /health");
    };
    void tick();
    this.healthTimer = setInterval(() => void tick(), HEALTH_EVERY_MS);
    // A fast first answer: the bundled router takes a second or two to start.
    if (this.mode === "bundled")
      void (async () => {
        for (let i = 0; i < 30 && !this.state.up && !this.stopping; i++) {
          await sleep(300);
          if (await this.healthy()) {
            this.upSince ||= Date.now();
            this.state = { up: true };
            this.log("up");
          }
        }
      })();
  }

  private async healthy(): Promise<boolean> {
    try {
      const { url, token } = this.connection();
      const r = await fetch(`${url}/health`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(2500),
      });
      if (r.ok) return ((await r.json()) as Partial<WireHealth>).ok !== false;
      // An older router without /health: up if it lists its models.
      return r.status === 404 && (await answers(url, token));
    } catch {
      return false;
    }
  }
}

// ---- helpers ---------------------------------------------------------------------------

async function answers(url: string, token?: string): Promise<boolean> {
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/v1/models`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function agentLoaded(label: string): Promise<boolean> {
  const uid = process.getuid?.() ?? 501;
  return new Promise((r) =>
    execFile("/bin/launchctl", ["print", `gui/${uid}/${label}`], { timeout: 5000 }, (err) =>
      r(!err),
    ),
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** One old log kept: provenance-core.log -> provenance-core.log.1 once it passes 5 MB. */
function rotate(file: string): void {
  try {
    if (statSync(file).size > LOG_MAX) renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
