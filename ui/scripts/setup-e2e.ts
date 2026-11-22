// Headless check of "Models & accounts" (src/setup/) against the mock router
// (scripts/mock-router.ts). Starts both itself: no running router, app-server or model
// quota needed, and nothing opens on screen (Playwright's headless Chromium).
//
//   npm run build && npm run e2e:setup     # SHOTS=dir for the screenshots, DEV=1 for Vite
//
// Walks: first run with nothing signed in -> sign-in success -> the tier picker lists the
// site's model; sign-in failure with retry; cancel; a 409 (another sign-in open), add and
// remove an account; browser not ready -> download; sign-in while the browser is being
// prepared; router down and back; a router without the API; phone width and light theme.

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { startUiServer } from "../server/app.ts";
import { findChromium } from "./chromium.ts";
import { startMockRouter } from "./mock-router.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.env.SHOTS ?? path.join(tmpdir(), "provenance-setup-e2e");
mkdirSync(shots, { recursive: true });
const log = (...a: unknown[]) => console.log("[setup-e2e]", ...a);

const mock = await startMockRouter(0);
const ui = await startUiServer({
  root,
  prod: !process.env.DEV,
  port: 0,
  host: "127.0.0.1",
  bin: "/nonexistent/provenance", // no app-server: this check never sends a turn
  tierlmUrl: mock.url,
  cwd: () => ({ defaultCwd: tmpdir(), fromLauncher: false }),
});
log(`mock router ${mock.url}, UI ${ui.url}, screenshots in ${shots}`);

async function control(route: string, body: unknown = {}): Promise<unknown> {
  const r = await fetch(`${mock.url}/mock/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
async function mockState(): Promise<{
  accountIds: string[];
  accounts: Record<string, Record<string, { login: { state: string }; signed_in: unknown }>>;
}> {
  return (await fetch(`${mock.url}/mock/state`)).json() as never;
}

let n = 0;
async function shot(page: Page, name: string): Promise<void> {
  const file = path.join(shots, `${String(++n).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  log(`  screenshot ${file}`);
}

function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`expected: ${what}`);
  log(`  ok: ${what}`);
}

const dialog = ".setup-dialog[open]";
const title = (page: Page) => page.locator(`${dialog} .setup-title`).innerText();
const currentStep = (page: Page) => page.locator(`${dialog} .setup-rail li.current`).innerText();

async function waitTitle(page: Page, re: RegExp, timeout = 10_000): Promise<string> {
  await page.waitForFunction(
    ([src, flags]) => {
      const el = document.querySelector(".setup-dialog[open] .setup-title");
      return !!el && new RegExp(src, flags).test(el.textContent ?? "");
    },
    [re.source, re.flags] as const,
    { timeout },
  );
  return title(page);
}

async function pickSite(page: Page, id: string): Promise<void> {
  await page.click(`${dialog} .setup-site[data-provider="${id}"]`);
  await page.waitForSelector(`${dialog} .setup-accounts`);
}

function account(page: Page, id: string) {
  return page.locator(`${dialog} .setup-accounts li[data-account="${id}"]`);
}

/** No sideways scroll inside the panel, and no button label wrapping to two lines. */
async function layoutOk(page: Page, where: string): Promise<void> {
  const bad = await page.evaluate(() => {
    const out: string[] = [];
    const body = document.querySelector(".setup-dialog[open] .setup-body");
    if (body && body.scrollWidth > body.clientWidth + 1) out.push("body scrolls sideways");
    for (const b of document.querySelectorAll<HTMLElement>(".setup-dialog[open] button")) {
      const lh = parseFloat(getComputedStyle(b).lineHeight) || 16;
      if (
        b.offsetParent &&
        b.innerText.trim() &&
        b.scrollHeight > Math.max(b.clientHeight, lh * 1.6)
      )
        out.push(`button wraps: ${b.innerText}`);
    }
    return out;
  });
  check(!bad.length, `layout at ${where}${bad.length ? ` (${bad.join("; ")})` : ""}`);
}

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  // ---- 1. first run: nothing signed in, the dialog opens by itself ------------------
  log("first run");
  await control("reset", { scenario: "fresh" });
  await page.goto(ui.url);
  await page.waitForSelector(`${dialog} .setup-sites`, { timeout: 15_000 });
  check(
    /Nothing is signed in yet/.test(await page.locator(`${dialog} .setup-lead`).innerText()),
    "first-run lead",
  );
  check((await currentStep(page)).includes("Site"), "rail on step 1, Site");
  check((await page.locator(`${dialog} .setup-site`).count()) === 3, "three sites listed");
  check(
    (await page.locator(`${dialog} .setup-status`).allInnerTexts()).every(
      (t) => t === "Not signed in",
    ),
    "every site reads Not signed in",
  );
  await layoutOk(page, "first run");
  await shot(page, "first-run-sites");

  // ---- 2. sign-in success -----------------------------------------------------------
  log("sign-in success (ChatGPT, main)");
  await pickSite(page, "chatgpt-web");
  check((await currentStep(page)).includes("Account"), "rail on step 2, Account");
  check(
    (await account(page, "main").locator(".btn-primary").innerText()) === "Sign in",
    "Sign in is the one primary action",
  );
  check((await page.locator(`${dialog} .btn-primary`).count()) === 1, "exactly one primary button");
  await layoutOk(page, "site step");
  await shot(page, "site-chatgpt");
  await account(page, "main").getByRole("button", { name: "Sign in" }).click();
  check(
    /new window/.test(await waitTitle(page, /Sign in to ChatGPT/)),
    "waiting state names the window",
  );
  check((await currentStep(page)).includes("Sign in"), "rail on step 3, Sign in");
  check(
    /beside Provenance on chatgpt\.com/.test(
      await page.locator(`${dialog} .setup-text`).innerText(),
    ),
    "says where the window is and which site",
  );
  await shot(page, "signin-window-open");
  await control("finish", { provider: "chatgpt-web", account: "main", ok: true });
  await waitTitle(page, /Checking ChatGPT/);
  await shot(page, "signin-verifying");
  await waitTitle(page, /ChatGPT is ready/);
  check((await currentStep(page)).includes("Ready"), "rail on step 4, Ready");
  check(
    (await page.locator(`${dialog} .setup-models-ready`).innerText()).includes("GPT-6 Luna"),
    "ready step lists the model",
  );
  await shot(page, "signin-ready");
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForSelector(dialog, { state: "detached", timeout: 5000 }).catch(() => {});
  check(!(await page.locator(dialog).count()), "Done closes the dialog");

  // The tier picker now offers the site's model, and its footer reopens the dialog.
  await page.click('button[title="Model tier"]');
  await page.hover('.tier-menu [data-model="solstice"]');
  await page.waitForSelector(".tier-sub");
  check(
    (await page.locator(".tier-sub").innerText()).includes("GPT-6 Luna"),
    "tier picker lists GPT-6 Luna",
  );
  await page.click(".tier-setup");
  await page.waitForSelector(`${dialog} .setup-sites`);
  check(
    (await page
      .locator(`${dialog} .setup-site[data-provider="chatgpt-web"] .setup-status`)
      .innerText()) === "Ready",
    "ChatGPT reads Ready in the site list (opened from the tier picker)",
  );
  await page.getByRole("button", { name: "Close" }).click();

  // ---- 3. sign-in failure, then retry ----------------------------------------------
  log("sign-in failure + retry (Gemini, main), opened from the sidebar");
  await page.getByRole("button", { name: "Models & accounts" }).click();
  await pickSite(page, "gemini-web");
  check(
    (await page.locator(`${dialog} .setup-models`).innerText()).includes("only on Account B"),
    "restricted model says which account",
  );
  await account(page, "main").getByRole("button", { name: "Sign in" }).click();
  await waitTitle(page, /Sign in to Gemini/);
  await control("finish", {
    provider: "gemini-web",
    account: "main",
    ok: false,
    reason: "Google asked for a verification code that wasn't entered.",
  });
  await waitTitle(page, /Couldn't sign in to Gemini/);
  check(
    (await page.locator(`${dialog} .setup-text`).innerText()).includes("verification code"),
    "failure shows the router's reason",
  );
  await layoutOk(page, "failure");
  await shot(page, "signin-failed");
  await page.getByRole("button", { name: "Try again" }).click();
  await waitTitle(page, /Sign in to Gemini in the new window/);
  await control("finish", { provider: "gemini-web", account: "main", ok: true });
  await waitTitle(page, /Gemini is ready/);
  const readyModels = await page.locator(`${dialog} .setup-models-ready`).innerText();
  check(
    readyModels.includes("Gemini Hydrogen") && !readyModels.includes("Gemini Neon"),
    "ready lists only the models this account gets",
  );

  // ---- 4. cancel -------------------------------------------------------------------
  log("cancel (Qwen, main)");
  await page.getByRole("button", { name: "Set up another site" }).click();
  await pickSite(page, "qwen-web");
  await account(page, "main").getByRole("button", { name: "Sign in" }).click();
  await waitTitle(page, /Sign in to Qwen/);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForSelector(`${dialog} .setup-accounts`);
  check((await currentStep(page)).includes("Account"), "cancel returns to the account step");
  check(
    (await mockState()).accounts["qwen-web"].main.login.state === "idle",
    "router told to cancel",
  );

  // ---- 5. a 409 (another sign-in is open), add + remove an account ------------------
  log("409, add and remove an account");
  await page.getByRole("button", { name: "Add another account" }).click();
  await account(page, "b").waitFor();
  check((await mockState()).accountIds.includes("b"), "account b added on the router");
  // Someone else (a terminal, another window) opens a sign-in meanwhile.
  await fetch(`${mock.url}/web/login`, {
    method: "POST",
    body: JSON.stringify({ provider: "chatgpt-web", account: "b" }),
  });
  await account(page, "b").getByRole("button", { name: "Sign in" }).click();
  await account(page, "b").locator(".setup-row-msg").waitFor();
  check(
    /already open/.test(await account(page, "b").locator(".setup-row-msg").innerText()),
    "409 detail shown under the account",
  );
  check((await currentStep(page)).includes("Account"), "a 409 keeps you on the account step");
  await shot(page, "signin-conflict-409");
  await fetch(`${mock.url}/web/login/cancel`, {
    method: "POST",
    body: JSON.stringify({ provider: "chatgpt-web", account: "b" }),
  });
  await account(page, "b").hover();
  await account(page, "b").getByRole("button", { name: "Remove Account B" }).click();
  await account(page, "b").getByRole("button", { name: "Remove", exact: true }).click();
  await account(page, "b").waitFor({ state: "detached" });
  check(!(await mockState()).accountIds.includes("b"), "account b removed on the router");
  await page.getByRole("button", { name: "Close" }).click();

  // ---- 6. browser not ready -> download --------------------------------------------
  log("browser not ready -> download");
  await control("reset", { scenario: "nobrowser" });
  await page.getByRole("button", { name: "Models & accounts" }).click();
  await page.waitForSelector(`${dialog} .setup-browser`);
  check(
    /one-time download/.test(await page.locator(`${dialog} .setup-browser`).innerText()),
    "strip explains the download",
  );
  await shot(page, "browser-not-ready");
  await page.locator(`${dialog} .setup-browser`).getByRole("button", { name: "Download" }).click();
  await page.waitForFunction(
    () =>
      /Downloading the sign-in browser · [1-9]/.test(
        document.querySelector(".setup-browser")?.textContent ?? "",
      ),
    null,
    { timeout: 8000 },
  );
  await shot(page, "browser-downloading");
  await page.waitForSelector(`${dialog} .setup-browser`, { state: "detached", timeout: 15_000 });
  check(true, "strip goes once the browser is ready");

  // Sign in while the browser is still being prepared: the window opens once it's ready.
  log("sign in while the browser is prepared");
  await control("reset", { scenario: "nobrowser" });
  await pickSite(page, "chatgpt-web");
  await account(page, "main").getByRole("button", { name: "Sign in" }).click();
  await waitTitle(page, /Getting the sign-in browser ready/);
  await page.waitForFunction(
    () => {
      const m = document.querySelector<HTMLElement>(".setup-meter.wide > span");
      return !!m && parseFloat(m.style.width) > 0;
    },
    null,
    { timeout: 8000 },
  );
  await shot(page, "signin-preparing");
  await waitTitle(page, /Sign in to ChatGPT in the new window/, 15_000);
  check(true, "moves on to the open window once the browser is ready");
  await page.getByRole("button", { name: "Close" }).click();
  await new Promise((r) => setTimeout(r, 300));
  check(
    (await mockState()).accounts["chatgpt-web"].main.login.state === "idle",
    "closing the dialog mid sign-in cancels it",
  );

  // ---- 7. router down and back -----------------------------------------------------
  log("router down");
  await control("reset", { scenario: "signed" });
  await page.getByRole("button", { name: "Models & accounts" }).click();
  await page.waitForSelector(`${dialog} .setup-sites`);
  await control("down", { down: true });
  await waitTitle(page, /Can't reach provenance-core/, 10_000);
  check(true, "router down page state");
  await shot(page, "router-down");
  await control("down", { down: false });
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForSelector(`${dialog} .setup-sites`, { timeout: 8000 });
  check(true, "back to the sites once the router answers");

  log("router without the sign-in API");
  await control("legacy", { legacy: true });
  await waitTitle(page, /can't sign in from the app/, 10_000);
  check(true, "older router page state");
  await shot(page, "router-unsupported");
  await control("legacy", { legacy: false });
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForSelector(`${dialog} .setup-sites`, { timeout: 8000 });

  // ---- 8. a signed-in mix, light theme, phone width -------------------------------
  await pickSite(page, "chatgpt-web");
  check(
    (await account(page, "b").innerText()).includes("Blocked: Daily limit reached"),
    "block reason shown",
  );
  check((await account(page, "main").innerText()).includes("38 of 500"), "usage against the cap");
  await layoutOk(page, "signed-in site");
  await shot(page, "site-signed-in-mix");
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await page.waitForTimeout(400); // let the colour transitions finish
  await shot(page, "site-signed-in-light");
  await page.evaluate(() => delete document.documentElement.dataset.theme);
  await page.setViewportSize({ width: 390, height: 760 });
  await layoutOk(page, "390 px");
  await shot(page, "site-phone-width");

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
  await mock.close();
}
