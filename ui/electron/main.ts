// Provenance desktop app: an Electron shell around the web UI.
//
// The UI server (server/app.ts: static files + /api + the WebSocket bridge to
// `provenance app-server`) runs inside this process on Electron's own Node, so
// the app doesn't depend on a Node install or the shell's PATH. The window
// loads it from http://localhost:<port>. A fixed port keeps the page origin (and
// with it localStorage: settings, theme, collapsed projects) stable across launches.
//
// Bundled by esbuild (scripts/build-electron.mjs) into build-electron/main.cjs.
//
// Settings: ~/Library/Application Support/Provenance/settings.json (Preferences…).

import { execFile, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { startUiServer, type RouterStatus, type UiServer } from "../server/app.ts";

app.setName("Provenance");

const isDev = !app.isPackaged;
const devVite = isDev && process.env.PROVENANCE_APP_VITE === "1";
const userData = app.getPath("userData");
const settingsPath = path.join(userData, "settings.json");
const windowStatePath = path.join(userData, "window-state.json");
const logDir = path.join(userData, "logs");
mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, "main.log");

// ---- logging: Finder-launched apps have no stdout --------------------------

for (const level of ["log", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    try {
      const line = args
        .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack : JSON.stringify(a)))
        .join(" ");
      appendFileSync(logFile, `${new Date().toISOString()} ${level} ${line}\n`);
    } catch {
      // ignore
    }
  };
}

// ---- settings ----------------------------------------------------------------

interface Settings {
  /** The provenance binary (`provenance app-server` is spawned from it). */
  provenanceBin: string;
  /** provenance-core (tierlm) router. */
  routerUrl: string;
  /** Start provenance-core on launch if it isn't answering. */
  autoStartRouter: boolean;
  /** launchd agent to kickstart first (empty to skip). */
  routerLaunchdLabel: string;
  /** Script to run if there's no launchd agent (empty to skip). */
  routerStartScript: string;
  /** Default working directory for new threads (empty: last used, else home). */
  defaultCwd: string;
  /** Local port for the UI server (127.0.0.1 only). */
  port: number;
}

const DEFAULT_SETTINGS: Settings = {
  provenanceBin: "~/.local/bin/provenance",
  routerUrl: "http://127.0.0.1:4141",
  autoStartRouter: true,
  routerLaunchdLabel: "com.yufan.tierlm",
  routerStartScript: "~/.tierlm/serve.sh",
  defaultCwd: "",
  port: 41730,
};

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

function loadSettings(): Settings {
  let raw: Partial<Settings> = {};
  try {
    raw = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (e) {
    if (existsSync(settingsPath))
      console.error("settings.json unreadable, using defaults:", String(e));
  }
  const s = { ...DEFAULT_SETTINGS, ...raw };
  // Env still wins, like the CLI server.
  if (process.env.PROVENANCE_BIN) s.provenanceBin = process.env.PROVENANCE_BIN;
  if (process.env.TIERLM_URL) s.routerUrl = process.env.TIERLM_URL;
  if (process.env.PROVENANCE_ROUTER_AUTOSTART === "0") s.autoStartRouter = false;
  return s;
}

function ensureSettingsFile(): void {
  if (existsSync(settingsPath)) return;
  writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
}

const settings = loadSettings();
const bin = expandHome(settings.provenanceBin);

// ---- launch cwd (`provenance-ui` passes --cwd <dir>) -------------------------

function cwdFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--cwd=")) return a.slice(6);
    if (a === "--cwd" && argv[i + 1]) return argv[i + 1];
  }
  return undefined;
}

let launchCwd = cwdFromArgv(process.argv);
function currentCwd(): { defaultCwd: string; fromLauncher: boolean } {
  if (launchCwd) return { defaultCwd: launchCwd, fromLauncher: true };
  if (settings.defaultCwd)
    return { defaultCwd: expandHome(settings.defaultCwd), fromLauncher: true };
  return { defaultCwd: homedir(), fromLauncher: false };
}

// ---- single instance -----------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
let ui: UiServer | null = null;

app.on("second-instance", (_e, argv) => {
  const cwd = cwdFromArgv(argv);
  if (cwd) {
    launchCwd = cwd;
    win?.webContents.send("app:set-cwd", cwd);
  }
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else if (ui) {
    createWindow();
  }
});

// ---- PATH: give app-server (and the commands it runs) the user's login PATH --

async function loginShellPath(): Promise<string | undefined> {
  const sh = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    execFile(
      sh,
      ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'],
      { timeout: 4000, env: { ...process.env, TERM: "dumb" } },
      (err, stdout) => {
        const m = /__PATH__(.*?)__PATH__/.exec(String(stdout ?? ""));
        resolve(!err && m ? m[1] : undefined);
      },
    );
  });
}

async function fixPath(): Promise<void> {
  const fromShell = await loginShellPath();
  const extra = [
    path.dirname(bin),
    path.join(homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const parts = [
    ...(fromShell ?? process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":"),
    ...extra,
  ];
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(":");
  console.log(`PATH from ${fromShell ? "login shell" : "fallback"}`);
}

// ---- provenance-core -----------------------------------------------------------

const routerUrl = settings.routerUrl.replace(/\/$/, "");
let routerStatus: RouterStatus = { up: false, message: "checking provenance-core…" };
let routerStarting: Promise<RouterStatus> | null = null;

async function routerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${routerUrl}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }),
    ),
  );
}

async function tryStartRouter(): Promise<string[]> {
  const tried: string[] = [];
  const uid = process.getuid?.() ?? 501;
  const label = settings.routerLaunchdLabel.trim();
  if (label) {
    const target = `gui/${uid}/${label}`;
    const plist = path.join(homedir(), "Library/LaunchAgents", `${label}.plist`);
    if ((await run("/bin/launchctl", ["print", target])).ok) {
      const r = await run("/bin/launchctl", ["kickstart", "-k", target]);
      tried.push(`launchctl kickstart ${label}${r.ok ? "" : ` (failed: ${r.out})`}`);
      if (r.ok) return tried;
    } else if (existsSync(plist)) {
      const r = await run("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist]);
      tried.push(`launchctl bootstrap ${label}${r.ok ? "" : ` (failed: ${r.out})`}`);
      if (r.ok) return tried;
    }
  }
  const script = expandHome(settings.routerStartScript.trim());
  if (script && existsSync(script)) {
    const out = openSync(path.join(logDir, "provenance-core.log"), "a");
    const child = spawn("/bin/sh", [script], { detached: true, stdio: ["ignore", out, out] });
    child.on("error", (e) => console.error("router script failed:", e.message));
    child.unref();
    tried.push(script.replace(homedir(), "~"));
  }
  return tried;
}

/** Make sure provenance-core answers; start it if allowed. Shared by launch and the banner's button. */
function ensureRouter(): Promise<RouterStatus> {
  routerStarting ??= (async () => {
    if (await routerUp()) return (routerStatus = { up: true });
    if (!settings.autoStartRouter && routerStatus.message !== "manual") {
      return (routerStatus = {
        up: false,
        message: "Auto-start is off (autoStartRouter in Preferences).",
      });
    }
    routerStatus = { up: false, message: "Starting provenance-core…" };
    const tried = await tryStartRouter();
    if (!tried.length) {
      return (routerStatus = {
        up: false,
        message:
          "No launchd agent or start script found to start it. Set routerLaunchdLabel / routerStartScript in Preferences.",
      });
    }
    console.log("router: tried", tried.join("; "));
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await routerUp()) return (routerStatus = { up: true });
    }
    return (routerStatus = {
      up: false,
      message: `Tried ${tried.join(", ")}; still not answering after 20 s. Log: ${path.join(logDir, "provenance-core.log").replace(homedir(), "~")}`,
    });
  })().finally(() => {
    routerStarting = null;
  });
  return routerStarting;
}

// ---- window --------------------------------------------------------------------

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

function loadWindowState(): WindowState {
  const fallback = { width: 1200, height: 800 };
  try {
    const s = JSON.parse(readFileSync(windowStatePath, "utf8")) as WindowState;
    if (!(s.width > 0 && s.height > 0)) return fallback;
    if (s.x !== undefined && s.y !== undefined) {
      // Drop the position if it's no longer on any display (monitor unplugged).
      const d = screen.getDisplayMatching({ x: s.x, y: s.y, width: s.width, height: s.height });
      const a = d.workArea;
      const visible =
        s.x < a.x + a.width - 50 &&
        s.x + s.width > a.x + 50 &&
        s.y >= a.y - 10 &&
        s.y < a.y + a.height - 50;
      if (!visible)
        return { width: Math.min(s.width, a.width), height: Math.min(s.height, a.height) };
    }
    return s;
  } catch {
    return fallback;
  }
}

function saveWindowState(w: BrowserWindow): void {
  try {
    const b = w.getNormalBounds();
    writeFileSync(windowStatePath, JSON.stringify({ ...b, maximized: w.isMaximized() }));
  } catch {
    // ignore
  }
}

function isAppUrl(url: string): boolean {
  return !!ui && (url.startsWith(`${ui.url}/`) || url === ui.url);
}

function createWindow(): void {
  if (!ui) return;
  const state = loadWindowState();
  const w = new BrowserWindow({
    ...state,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "Provenance",
    titleBarStyle: "hiddenInset",
    // Centred on the 40 px header (--header-height in tokens.css).
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: "#0d0b0a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win = w;
  if (state.maximized) w.maximize();
  w.once("ready-to-show", () => w.show());

  let saveTimer: NodeJS.Timeout | undefined;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(w), 400);
  };
  w.on("resize", scheduleSave);
  w.on("move", scheduleSave);
  w.on("close", () => saveWindowState(w));
  w.on("closed", () => {
    if (win === w) win = null;
  });

  // Links: anything that isn't the app opens in the default browser.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
  });
  w.webContents.on("render-process-gone", (_e, d) => console.error("renderer gone:", d.reason));

  void w.loadURL(ui.url);
}

// ---- menu ----------------------------------------------------------------------

function openPreferences(): void {
  ensureSettingsFile();
  void shell.openPath(settingsPath).then((err) => {
    if (err) shell.showItemInFolder(settingsPath);
  });
}

async function pickDirectory(defaultPath?: string): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = {
    title: "Choose working directory",
    buttonLabel: "Choose",
    defaultPath: defaultPath && existsSync(defaultPath) ? defaultPath : homedir(),
    properties: ["openDirectory", "createDirectory"],
  };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

function buildMenu(): void {
  const send = (channel: string, ...args: unknown[]) => {
    if (!win && ui) createWindow();
    win?.webContents.send(channel, ...args);
  };
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Provenance",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Preferences…", accelerator: "CmdOrCtrl+,", click: openPreferences },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New Thread", accelerator: "CmdOrCtrl+N", click: () => send("app:new-thread") },
        {
          label: "Open Folder…",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const dir = await pickDirectory(currentCwd().defaultCwd);
            if (dir) send("app:set-cwd", dir);
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        ...(isDev
          ? ([{ role: "forceReload" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[])
          : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Provenance on GitHub",
          click: () =>
            void shell.openExternal(
              "https://github.com/prominence-chan/provenance/tree/provenance",
            ),
        },
        { label: "Show Logs", click: () => void shell.openPath(logDir) },
        {
          label: "Show Settings File",
          click: () => (ensureSettingsFile(), shell.showItemInFolder(settingsPath)),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC -----------------------------------------------------------------------

ipcMain.handle("app:pick-directory", (_e, defaultPath?: string) => pickDirectory(defaultPath));
ipcMain.handle("app:start-router", async () => {
  if (routerStatus.message?.startsWith("Auto-start is off"))
    routerStatus = { up: false, message: "manual" };
  return ensureRouter();
});
ipcMain.handle("app:open-preferences", () => openPreferences());

// ---- lifecycle -----------------------------------------------------------------

function watchSettings(): void {
  ensureSettingsFile();
  let prompted = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    watch(userData, (_ev, name) => {
      if (name !== "settings.json" || prompted) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const next = loadSettings();
        if (JSON.stringify(next) === JSON.stringify(settings)) return;
        prompted = true;
        const r = await dialog.showMessageBox({
          type: "info",
          message: "Settings changed",
          detail: "Relaunch Provenance to apply them? Running turns will stop.",
          buttons: ["Relaunch", "Later"],
          defaultId: 0,
          cancelId: 1,
        });
        prompted = false;
        if (r.response === 0) {
          app.relaunch();
          app.quit();
        }
      }, 300);
    });
  } catch (e) {
    console.warn("can't watch settings:", String(e));
  }
}

app.setAboutPanelOptions({
  applicationName: "Provenance",
  applicationVersion: app.getVersion(),
  copyright: "Provenance desktop app",
  credits: "Codex fork driving provenance-core tiers.",
});

app
  .whenReady()
  .then(async () => {
    console.log(
      `launch ${app.getVersion()} packaged=${app.isPackaged} bin=${bin} router=${routerUrl}`,
    );
    if (isDev && process.platform === "darwin") {
      const icon = nativeImage.createFromPath(
        path.join(app.getAppPath(), "design/icon/icon-512.png"),
      );
      if (!icon.isEmpty()) app.dock?.setIcon(icon);
    }
    buildMenu();
    const routerReady = ensureRouter(); // runs alongside; the UI polls /api/health for the banner
    await fixPath();

    const root = app.getAppPath();
    const opts = {
      root,
      prod: !devVite,
      host: "127.0.0.1",
      bin,
      tierlmUrl: routerUrl,
      cwd: currentCwd,
      routerStatus: () => routerStatus,
      clientTitle: "Provenance",
    };
    try {
      ui = await startUiServer({ ...opts, port: settings.port });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      console.warn(
        `port ${settings.port} busy; using a random one (UI settings won't carry over this run)`,
      );
      ui = await startUiServer({ ...opts, port: 0 });
    }
    console.log(`ui server on ${ui.url}`);
    createWindow();
    watchSettings();
    void routerReady.then((s) => console.log("router:", s.up ? "up" : s.message));
  })
  .catch((e) => {
    console.error("startup failed:", e);
    dialog.showErrorBox("Provenance couldn't start", String(e instanceof Error ? e.message : e));
    app.exit(1);
  });

app.on("activate", () => {
  if (!win && ui) createWindow();
});

// macOS: keep running with no windows (turns keep going); reopen from the Dock.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", (e) => {
  if (quitting || !ui) return;
  quitting = true;
  e.preventDefault();
  const server = ui;
  ui = null;
  void Promise.race([server.close(), new Promise((r) => setTimeout(r, 1500))]).finally(() =>
    app.quit(),
  );
});
