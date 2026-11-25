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
//
// provenance-core: electron/router.ts (one that already answers, else the app's own copy).
//
// Test switches (scripts/app-router-check.ts): PROVENANCE_USER_DATA=<dir> keeps every file
// (settings, logs, the router's home) there instead of Application Support, so a check never
// meets the installed app's state or its single-instance lock; PROVENANCE_HEADLESS=1 opens no
// window and no Dock icon, and prints one "PROVENANCE_READY {json}" line once it is serving.

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
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
import { startUiServer, type UiServer } from "../server/app.ts";
import { DiscordPresence, PRESENCE, sanitizePresence } from "./discord-presence.ts";
import { RouterSupervisor, type RouterPolicy } from "./router.ts";

app.setName("Provenance");

const isDev = !app.isPackaged;
const devVite = isDev && process.env.PROVENANCE_APP_VITE === "1";
const headless = process.env.PROVENANCE_HEADLESS === "1";
if (process.env.PROVENANCE_USER_DATA) app.setPath("userData", process.env.PROVENANCE_USER_DATA);
if (headless) app.setActivationPolicy?.("accessory"); // no Dock icon, never the active app
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
  /**
   * The provenance binary (`provenance app-server` is spawned from it). Empty (or the old
   * default "~/.local/bin/provenance"): ~/.local/bin/provenance when it exists, else the one
   * inside the app (resolveAgent).
   */
  provenanceBin: string;
  /** Where your own provenance-core (tierlm) router answers, if you run one. */
  routerUrl: string;
  /**
   * auto: use the router at routerUrl when it answers at launch, else the app's own;
   * external: only routerUrl (never start one); bundled: always the app's own.
   */
  router: RouterPolicy;
  /** A launchd agent that runs your own router: waited for at launch, never started by the app. */
  routerLaunchdLabel: string;
  /** Default working directory for new threads (empty: last used, else home). */
  defaultCwd: string;
  /** Local port for the UI server (127.0.0.1 only). */
  port: number;
  /** Show activity in Discord (the app menu's switch; only with a Discord client id). */
  discordPresence: boolean;
  /** The Discord application id for Rich Presence (empty: the one in discord-presence.ts). */
  discordClientId: string;
}

const DEFAULT_SETTINGS: Settings = {
  provenanceBin: "",
  routerUrl: "http://127.0.0.1:4141",
  router: "auto",
  routerLaunchdLabel: "",
  defaultCwd: "",
  port: 41730,
  discordPresence: true,
  discordClientId: "",
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
  // From before the app had its own router: autoStartRouter false meant "never start one".
  const old = raw as { autoStartRouter?: boolean };
  if (raw.router === undefined && old.autoStartRouter === false) s.router = "external";
  if (!["auto", "external", "bundled"].includes(s.router)) s.router = "auto";
  // Env still wins, like the CLI server (PROVENANCE_BIN: resolveAgent).
  if (process.env.TIERLM_URL) s.routerUrl = process.env.TIERLM_URL;
  if (process.env.PROVENANCE_ROUTER_AUTOSTART === "0") s.router = "external";
  const r = process.env.PROVENANCE_ROUTER as RouterPolicy | undefined;
  if (r && ["auto", "external", "bundled"].includes(r)) s.router = r;
  s.discordPresence = s.discordPresence !== false;
  if (typeof s.discordClientId !== "string") s.discordClientId = "";
  return s;
}

function ensureSettingsFile(): void {
  if (existsSync(settingsPath)) return;
  writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
}

const settings = loadSettings();

// ---- which provenance binary -----------------------------------------------------

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
const BIN_NAME = IS_WIN ? "provenance.exe" : "provenance";
const LOCAL_BIN = IS_WIN
  ? path.join(process.env.LOCALAPPDATA ?? homedir(), "Provenance", "bin", BIN_NAME)
  : `~/.local/bin/${BIN_NAME}`;
type AgentSource = "PROVENANCE_BIN" | "settings" | "~/.local/bin" | "bundled" | "missing";

/**
 * The binary app-server runs from, first match wins:
 *   1. PROVENANCE_BIN (env), 2. provenanceBin in settings.json, when set to a path other than
 *   the old default; both used as given, even when missing (the banner then says so);
 *   3. ~/.local/bin/provenance (or %LOCALAPPDATA%\Provenance\bin\provenance.exe on Windows)
 *   when it exists, so a developer's newer binary beats the app's copy;
 *   4. the copy inside the app (Resources/agent/provenance[.exe], scripts/fetch-agent.ts),
 *   so the app alone can run threads.
 */
function resolveAgent(s: Settings): { path: string; source: AgentSource } {
  if (process.env.PROVENANCE_BIN)
    return { path: expandHome(process.env.PROVENANCE_BIN), source: "PROVENANCE_BIN" };
  const configured = s.provenanceBin.trim();
  if (configured && configured !== LOCAL_BIN && configured !== "~/.local/bin/provenance")
    return { path: expandHome(configured), source: "settings" };
  const local = expandHome(LOCAL_BIN);
  if (existsSync(local)) return { path: local, source: "~/.local/bin" };
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, "agent", BIN_NAME)
    : path.join(app.getAppPath(), "vendor/agent", BIN_NAME);
  if (existsSync(bundled)) return { path: bundled, source: "bundled" };
  return { path: local, source: "missing" };
}

const agent = resolveAgent(settings);
const bin = agent.path;

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
  if (IS_WIN) {
    const parts = [path.dirname(bin), ...(process.env.PATH ?? "").split(path.delimiter)];
    process.env.PATH = [...new Set(parts.filter(Boolean))].join(path.delimiter);
    return;
  }
  const fromShell = await loginShellPath();
  const extra = [
    path.dirname(bin),
    path.join(homedir(), ".local/bin"),
    ...(IS_MAC ? ["/opt/homebrew/bin"] : []),
    "/usr/local/bin",
  ];
  const parts = [
    ...(fromShell ?? process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(path.delimiter),
    ...extra,
  ];
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(path.delimiter);
  console.log(`PATH from ${fromShell ? "login shell" : "fallback"}`);
}

// ---- provenance-core (electron/router.ts) --------------------------------------

const router = new RouterSupervisor({
  policy: settings.router,
  configuredUrl: settings.routerUrl,
  launchdLabel: settings.routerLaunchdLabel.trim() || undefined,
  // Contents/Resources holds router/ and browser/; a checkout has them in vendor/.
  resources: app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "vendor"),
  home: path.join(userData, "router"),
  logFile: path.join(logDir, "provenance-core.log"),
  // A new URL (the app's own router took over, or its port was taken): app-server reads it at start.
  onUrlChange: () => ui?.bridge.restart(),
});

// ---- Discord Rich Presence (electron/discord-presence.ts) --------------------------------------

const discordClientId = (s: Settings) => s.discordClientId.trim() || PRESENCE.clientId;
// Never from a headless check: it must not reach a Discord running on the same Mac.
const presence = new DiscordPresence({
  clientId: headless ? "" : discordClientId(settings),
  enabled: settings.discordPresence,
  log: (m) => console.log(m),
});

/** The menu switch: saved to settings.json (in memory first, so the watcher sees no change). */
function setDiscordPresence(on: boolean): void {
  settings.discordPresence = on;
  presence.configure(headless ? "" : discordClientId(settings), on);
  try {
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      raw = { ...DEFAULT_SETTINGS };
    }
    writeFileSync(settingsPath, JSON.stringify({ ...raw, discordPresence: on }, null, 2) + "\n");
  } catch (e) {
    console.warn("can't save settings.json:", String(e));
  }
}

/** settings.json edited by hand: the Discord keys apply at once, no relaunch. */
function applyDiscordSettings(next: Settings): void {
  if (
    next.discordPresence === settings.discordPresence &&
    next.discordClientId === settings.discordClientId
  )
    return;
  settings.discordPresence = next.discordPresence;
  settings.discordClientId = next.discordClientId;
  presence.configure(headless ? "" : discordClientId(settings), settings.discordPresence);
  buildMenu();
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
  if (!ui || headless) return;
  const state = loadWindowState();
  const iconPath = path.join(app.getAppPath(), "design/icon/icon-512.png");
  const w = new BrowserWindow({
    ...state,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "Provenance",
    ...(IS_MAC
      ? {
          titleBarStyle: "hiddenInset" as const,
          // Centred on the 40 px header (--header-height in tokens.css).
          trafficLightPosition: { x: 14, y: 13 },
        }
      : {
          autoHideMenuBar: true,
          ...(existsSync(iconPath) ? { icon: iconPath } : {}),
        }),
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
    // Nothing reports turns now: say idle rather than a timer that may never stop.
    presence.update({ ...lastPresence, working: false, since: null });
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
  const appSettingsItems: MenuItemConstructorOptions[] = [
    { label: "Preferences…", accelerator: "CmdOrCtrl+,", click: openPreferences },
    { label: "Models & Accounts…", click: () => send("app:open-accounts") },
    { label: "Welcome…", click: () => send("app:open-welcome") },
    {
      label: "Show activity in Discord",
      type: "checkbox",
      checked: settings.discordPresence,
      // Hidden until a Discord client id is configured: presence is off without one.
      visible: !!discordClientId(settings),
      click: (item) => setDiscordPresence(item.checked),
    },
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(IS_MAC
      ? ([
          {
            label: "Provenance",
            submenu: [
              { role: "about" },
              { type: "separator" },
              ...appSettingsItems,
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
        ] as MenuItemConstructorOptions[])
      : []),
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
        ...(!IS_MAC
          ? ([{ type: "separator" }, ...appSettingsItems] as MenuItemConstructorOptions[])
          : []),
        { type: "separator" },
        { role: IS_MAC ? "close" : "quit" },
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
ipcMain.handle("app:start-router", () => router.ensure());
ipcMain.handle("app:open-preferences", () => openPreferences());
// The page's coarse state for Discord: tier or fallback, working or not, since when. Nothing else.
let lastPresence = sanitizePresence(null);
ipcMain.on("app:presence", (e, raw: unknown) => {
  if (!win || e.sender !== win.webContents) return;
  lastPresence = sanitizePresence(raw);
  presence.update(lastPresence);
});

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
        applyDiscordSettings(next);
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
      `launch ${app.getVersion()} packaged=${app.isPackaged} bin=${bin} (${agent.source}) router=${settings.router} (${settings.routerUrl})`,
    );
    if (isDev && process.platform === "darwin") {
      const icon = nativeImage.createFromPath(
        path.join(app.getAppPath(), "design/icon/icon-512.png"),
      );
      if (!icon.isEmpty()) app.dock?.setIcon(icon);
    }
    if (headless) app.dock?.hide();
    buildMenu();
    await fixPath(); // before the router starts: it runs osascript, open, codesign from PATH
    // Decides which router (a quick check of routerUrl) and starts the app's own if needed;
    // it comes up meanwhile, and the UI polls /api/health for the banner.
    await router.start();

    const root = app.getAppPath();
    const opts = {
      root,
      prod: !devVite,
      host: "127.0.0.1",
      bin,
      router: () => router.connection(),
      cwd: currentCwd,
      routerStatus: () => router.status(),
      clientTitle: "Provenance",
      // Fallback threads (Claude Code / Codex) and the "through Provenance" Codex home.
      dataDir: userData,
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
    if (!headless) watchSettings();
    else
      process.stdout.write(
        `PROVENANCE_READY ${JSON.stringify({ ui: ui.url, router: router.connection().url, mode: router.status().mode, routerPid: router.pid ?? null, bin, binSource: agent.source })}\n`,
      );
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

// Quit: the UI server and app-server, then the app's own router (it closes its browsers and
// any sign-in window). A kill or crash skips this; the router then stops by itself
// (--watch-stdin), and "exit" is the last chance to make sure.
let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  const server = ui;
  ui = null;
  const uiClosed = server
    ? Promise.race([server.close(), new Promise((r) => setTimeout(r, 1500))])
    : Promise.resolve();
  void Promise.all([uiClosed, router.stop(), presence.shutdown()]).finally(() => app.quit());
});
process.on("exit", () => router.killNow());
for (const sig of IS_WIN
  ? (["SIGTERM", "SIGINT"] as const)
  : (["SIGTERM", "SIGINT", "SIGHUP"] as const))
  process.on(sig, () => app.quit());
