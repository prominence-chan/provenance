// Models & accounts against a REAL provenance-core: the router's own server (its
// tests/serve_mock.py) with the web chats pointed at its mock chat page instead of real
// sites, a scratch home, and every browser headless (the background browser and the
// sign-in window alike). Headless Chromium drives the built UI. Nothing shows on screen,
// nothing reaches a real chat site, no model quota is used.
//
//   npm run build && npm run e2e:router
//
// Env: ROUTER_SRC (provenance-core checkout, default ../../provenance-core), ROUTER_PYTHON
// (default: the Python bundled into vendor/router by fetch-router.ts, so the shipped
// dependencies are what runs; else ROUTER_SRC/.venv), TURN=0 skips the real agent turn,
// SHOTS=dir for the screenshots.
//
// Walks: first run on a fresh home -> the browser set up (copied from vendor/browser) ->
// a sign-in opened beside the app (the window's position checked on the process), "Show the
// window" (headless: refused, as it must be), cancelled (window gone) -> signed in for real
// (cookie seen, window closed, page checked, e-mail shown) -> the tier picker pins the site ->
// a real turn through app-server to the mock page -> a site off and on, a daily limit ->
// an account added and removed -> an API key set and removed -> the router stops: the page
// says so -> no browser left behind.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { WirePoolKeys, WireSources, WireWebAccounts } from "../shared/router-api.ts";
import { startUiServer } from "../server/app.ts";
import { findChromium } from "./chromium.ts";
import { account, dialog, kit, layoutProblems, pickSite, waitTitle } from "./e2e-kit.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { log, shot, check, shots } = kit(
  "router-e2e",
  process.env.SHOTS ?? path.join(tmpdir(), "provenance-router-e2e"),
);
const src = path.resolve(process.env.ROUTER_SRC ?? path.join(root, "../../provenance-core"));
const vendored = path.join(root, "vendor/router/python/bin/python3");
const python =
  process.env.ROUTER_PYTHON ??
  (existsSync(vendored) ? vendored : path.join(src, ".venv/bin/python"));
const electron = path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const bin = path.join(homedir(), ".local/bin/provenance");
const wantTurn = process.env.TURN !== "0" && existsSync(bin);

// realpath: the router resolves its home (/var -> /private/var), and the processes are
// matched on the profile path it passes them
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "provenance-router-e2e-")));
const home = path.join(scratch, "router-home");

// ---- the real router ----------------------------------------------------------------
log(`router ${src} on ${python}`);
const harness = spawn(python, ["-B", path.join(src, "tests/serve_mock.py"), "--home", home], {
  cwd: src,
  env: {
    ...process.env,
    PYTHONPATH: src,
    // the shipped driver, on Electron's Node, as Provenance.app runs it
    PCORE_CHATGPT_WEB_DRIVER: "patchright",
    PLAYWRIGHT_NODEJS_PATH: path.join(root, "vendor/router/node"),
    PROVENANCE_ELECTRON: electron,
    PCORE_BROWSER_APP: path.join(root, "vendor/browser"),
  },
  stdio: ["pipe", "pipe", "inherit"], // stdin open while we run: its EOF stops the router
});
const info = await new Promise<{ url: string; mock: string; pid: number }>((resolve, reject) => {
  const rl = readline.createInterface({ input: harness.stdout! });
  rl.once("line", (l) => resolve(JSON.parse(l)));
  harness.once("exit", (c) => reject(new Error(`router exited (${c}) before it answered`)));
});
const R = info.url;
const rget = async <T>(p: string): Promise<T> => (await fetch(`${R}${p}`)).json() as Promise<T>;
const mockState = (body: object) =>
  fetch(`${R}/mock/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const ui = await startUiServer({
  root,
  prod: true,
  port: 0,
  host: "127.0.0.1",
  bin: wantTurn ? bin : "/nonexistent/provenance",
  router: { url: R },
  // app-server's own state in the scratch folder, never ~/.provenance
  appServerEnv: { PROVENANCE_HOME: path.join(scratch, "provenance-home") },
  cwd: () => ({ defaultCwd: scratch, fromLauncher: true }),
});
log(`router ${R} (pid ${info.pid}), mock page ${info.mock}, UI ${ui.url}, shots in ${shots}`);

/** Processes with a profile under the scratch home: the sign-in window, the background browser. */
function browsersOnHome(): string[] {
  try {
    return execFileSync("pgrep", ["-fl", `user-data-dir=${home}`], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const layoutOk = async (where: string) => {
  const bad = await layoutProblems(page);
  check(!bad.length, `layout at ${where}${bad.length ? ` (${bad.join("; ")})` : ""}`);
};

try {
  // ---- 1. first run on a fresh home --------------------------------------------------
  log("first run");
  await page.goto(ui.url);
  await page.waitForSelector(`${dialog} .setup-sites`, { timeout: 20_000 });
  check(true, "the dialog opens by itself: nothing is signed in");
  const statuses = await page.locator(`${dialog} .setup-sites .setup-status`).allInnerTexts();
  check(
    statuses.length === 2 && statuses.every((t) => t === "Not signed in"),
    `both sites read Not signed in (${statuses.join(", ")})`,
  );
  check(
    (await page.locator(`${dialog} .setup-pool .setup-status`).innerText()) === "Needs API keys",
    "the token pool needs keys",
  );
  check(
    (await page.locator(`${dialog} .setup-router`).innerText()).includes(`pid ${info.pid}`),
    "the router note names the router's process",
  );
  await shot(page, "first-run");

  // ---- 2. the sign-in browser, set up for real ----------------------------------------
  const strip = page.locator(`${dialog} .setup-browser`);
  if (await strip.count()) {
    log("browser set-up");
    await strip.getByRole("button", { name: "Set it up" }).click();
    await page.waitForSelector(`${dialog} .setup-browser`, { state: "detached", timeout: 120_000 });
    const b = (await rget<WireWebAccounts>("/web/accounts")).browser;
    check(b.ready && !!b.version, `the router's browser is ready (${b.version})`);
  }

  // ---- 3. a sign-in opened, shown, cancelled -------------------------------------------
  log("sign-in window: open, show, cancel");
  await mockState({ signin_auto: false });
  await page.click(`${dialog} .setup-site[data-provider="chatgpt-web"]`);
  await page.waitForSelector(`${dialog} .setup-accounts`);
  await account(page, "main").getByRole("button", { name: "Sign in" }).click();
  await waitTitle(page, /Sign in to ChatGPT in the new window/, 30_000);
  const want = await page.evaluate(() => ({ x: window.screenX, y: window.screenY }));
  const procs = browsersOnHome();
  const pos = procs.map((l) => /--window-position=(-?\d+),(-?\d+)/.exec(l)).find(Boolean);
  check(!!pos, "the sign-in window runs on the account's profile with an explicit position");
  check(
    !!pos && Number(pos[1]) !== 80 && Number(pos[2]) >= want.y,
    `it was placed by the app, not at the router's default (${pos?.[0]})`,
  );
  check(
    procs.some((l) => l.includes("--headless")),
    "and it is headless here (nothing shows)",
  );
  await page.getByRole("button", { name: "Show the window" }).click();
  await page.waitForFunction(() =>
    /Couldn't bring it forward/.test(document.querySelector(".setup-hint")?.textContent ?? ""),
  );
  check(true, "Show the window reaches the router (a headless window is never brought forward)");
  await shot(page, "signin-open");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForSelector(`${dialog} .setup-accounts`);
  for (let i = 0; i < 40 && browsersOnHome().length; i++)
    await new Promise((r) => setTimeout(r, 250));
  check(!browsersOnHome().length, "cancel closed the window");

  // ---- 4. signed in for real -----------------------------------------------------------
  log("sign-in, for real (the mock's sign-in page signs itself in)");
  await mockState({ signin_auto: true });
  await account(page, "main").getByRole("button", { name: "Sign in" }).click();
  await waitTitle(page, /ChatGPT is ready/, 90_000);
  check(
    (await page.locator(`${dialog} .setup-text`).innerText()).includes("person@example.com"),
    "ready, signed in as the page's e-mail",
  );
  await shot(page, "signin-ready");
  const acct = (await rget<WireWebAccounts>("/web/accounts")).providers[0].accounts[0];
  check(acct.signed_in === true && acct.email === "person@example.com", "the router agrees");
  await page.getByRole("button", { name: "Done" }).click();

  // ---- 5. the tier picker pins the site ------------------------------------------------
  await page.click('button[title="Model tier"]');
  await page.hover('.tier-menu [data-model="solstice"]');
  await page.waitForSelector('.tier-sub [data-source-model="luna/solstice"]');
  const luna = page.locator('.tier-sub [data-source-model="luna/solstice"]');
  check(
    (await luna.getAttribute("data-setup")) === null && /% left/.test(await luna.innerText()),
    `GPT-6 Luna can be pinned (${(await luna.innerText()).replace(/\s+/g, " ")})`,
  );
  await luna.click();

  // ---- 6. a real turn: UI -> app-server -> this router -> the mock page ----------------
  if (wantTurn) {
    log("a real turn on the pinned web source");
    await page.waitForSelector(".conn .dot-ok", { timeout: 60_000 });
    const before = (await rget<{ sent: number }>("/mock/sent")).sent;
    await page.fill(".composer textarea", "reply with just ok");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => /\bok\b/i.test(document.querySelector(".agent-message")?.textContent ?? ""),
      null,
      { timeout: 120_000 },
    );
    const after = (await rget<{ sent: number }>("/mock/sent")).sent;
    check(after > before, `the reply came from the mock page (${after - before} sent)`);
    await shot(page, "turn");
  } else log("(no real turn: TURN=0 or no provenance binary)");

  // ---- 7. a site off and on, a daily limit -----------------------------------------------
  log("site settings");
  await page.getByRole("button", { name: "Models & accounts" }).click();
  await pickSite(page, "other-web");
  await page.getByRole("switch").click();
  await page.waitForFunction(
    () => !(document.querySelector(".switch") as HTMLInputElement)?.checked,
  );
  const spark = (await rget<WireSources>("/v1/sources")).tiers.find((t) => t.tier === "spark")!;
  check(!spark.sources.some((s) => s.id === "auto"), "off: the router no longer offers its model");
  const saved = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"));
  check(saved.providers["other-web"].enabled === false, "kept in the router's settings.json");
  await page.getByRole("switch").click();
  await page.waitForFunction(
    () => (document.querySelector(".switch") as HTMLInputElement)?.checked,
  );
  await page.getByRole("button", { name: "Back" }).click();
  await pickSite(page, "chatgpt-web");
  await page.fill(`${dialog} .setup-input-num`, "40");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".setup-cap-field button"));
  const cap = (await rget<WireWebAccounts>("/web/accounts")).providers[0];
  check(cap.daily_cap === 40 && cap.accounts[0].daily_cap === 40, "daily limit 40 on the router");
  await layoutOk("site settings");
  await shot(page, "site-settings");

  // ---- 8. an account added and removed ------------------------------------------------
  log("accounts");
  await page.getByRole("button", { name: "Add another account" }).click();
  await account(page, "b").waitFor();
  check((await rget<WireWebAccounts>("/web/accounts")).accounts?.includes("b"), "account b added");
  await account(page, "b").hover();
  await account(page, "b").getByRole("button", { name: "Remove Account B" }).click();
  await account(page, "b").getByRole("button", { name: "Remove", exact: true }).click();
  await account(page, "b").waitFor({ state: "detached" });
  check(
    !(await rget<WireWebAccounts>("/web/accounts")).accounts?.includes("b"),
    "and removed again",
  );
  await page.getByRole("button", { name: "Back" }).click();

  // ---- 9. an API key -----------------------------------------------------------------
  log("API keys");
  await page.click(`${dialog} .setup-pool`);
  const row = page.locator(`${dialog} .setup-keys li[data-pool="example"]`);
  await row.getByRole("button", { name: "Add key" }).click();
  await row.locator('input[type="password"]').fill("sk-e2e-not-a-real-key");
  await row.getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(() =>
    /Key set/.test(
      document.querySelector('.setup-keys li[data-pool="example"]')?.textContent ?? "",
    ),
  );
  const keysFile = path.join(home, "keys.json");
  check(
    (statSync(keysFile).mode & 0o777) === 0o600,
    "kept in keys.json, readable by this user only",
  );
  const listed = JSON.stringify(await rget<WirePoolKeys>("/pool/keys"));
  check(!listed.includes("sk-e2e"), "the router never sends it back");
  await row.getByRole("button", { name: "Change" }).click();
  await row.getByRole("button", { name: "Remove key" }).click();
  await page.waitForFunction(() =>
    /Needs a key/.test(
      document.querySelector('.setup-keys li[data-pool="example"]')?.textContent ?? "",
    ),
  );
  check(!readFileSync(keysFile, "utf8").includes("sk-e2e"), "removed from keys.json");
  await shot(page, "keys");

  // ---- 10. the router goes away ----------------------------------------------------------
  log("router stops");
  harness.stdin!.end(); // as when the app that started it is gone
  await new Promise<void>((r) => harness.once("exit", () => r()));
  await waitTitle(page, /The model router isn't answering/, 15_000);
  check(true, "the dialog says the router isn't answering");
  for (let i = 0; i < 40 && browsersOnHome().length; i++)
    await new Promise((r) => setTimeout(r, 250));
  check(!browsersOnHome().length, "no browser left on the router's profiles");
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  log("PASS");
} catch (e) {
  await page.screenshot({ path: path.join(shots, "failure.png") }).catch(() => {});
  log(
    "FAIL:",
    e instanceof Error ? e.message : e,
    `(screenshot: ${path.join(shots, "failure.png")})`,
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  await ui.close();
  if (harness.exitCode === null) {
    harness.stdin!.end();
    await new Promise((r) => setTimeout(r, 3000));
    if (harness.exitCode === null) harness.kill();
  }
  const left = browsersOnHome();
  if (left.length) log("WARNING: still running:", left.join(" | "));
  rmSync(scratch, { recursive: true, force: true });
}
