// A new user's first launch, as the app does it but without a window: the app's own router
// supervisor (electron/router.ts) starts the bundled router from vendor/router on a fresh home
// (nothing signed in, no browser prepared, no keys), the UI server serves the built page, and
// headless Chromium looks at it from the first second: the router coming up, the dialog
// opening by itself, the sign-in browser being set up, then each step at a phone width, in
// light and dark, and by keyboard alone. Screenshots only: for looking at, not asserting.
//
//   npm run build && node scripts/build-electron.mjs && node scripts/fetch-router.ts
//   node scripts/first-run-tour.ts            # SHOTS=dir

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { RouterSupervisor } from "../electron/router.ts";
import { startUiServer } from "../server/app.ts";
import { findChromium } from "./chromium.ts";
import { dialog, kit, skipWelcome } from "./e2e-kit.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { log, shot } = kit(
  "first-run-tour",
  process.env.SHOTS ?? path.join(tmpdir(), "provenance-first-run"),
);
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "provenance-first-run-")));
const router = new RouterSupervisor({
  policy: "bundled",
  configuredUrl: "http://127.0.0.1:9",
  resources: path.join(root, "vendor"),
  home: path.join(scratch, "router"),
  logFile: path.join(scratch, "provenance-core.log"),
});
await router.start();
const ui = await startUiServer({
  root,
  prod: true,
  port: 0,
  host: "127.0.0.1",
  bin: "/nonexistent/provenance",
  router: () => router.connection(),
  routerStatus: () => router.status(),
  cwd: () => ({ defaultCwd: scratch, fromLauncher: false }),
  dataDir: path.join(scratch, "ui-data"),
  codexLoginHome: path.join(scratch, "no-codex"),
});
const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const tour = async (name: string, width: number, height: number, theme: "dark" | "light") => {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  const page = await ctx.newPage();
  return { ctx, page, name };
};

try {
  const { page, ctx } = await tour("desktop", 1100, 760, "dark");
  await page.goto(ui.url);
  await page.waitForTimeout(400);
  await shot(page, "starting");
  await page.waitForSelector(".welcome-dialog[open]", { timeout: 60_000 });
  await shot(page, "welcome");
  await skipWelcome(page);
  await page.waitForSelector(`${dialog} .setup-sites`, { timeout: 60_000 });
  await shot(page, "first-run-dialog");
  await page
    .waitForSelector(`${dialog} .setup-browser`, { state: "detached", timeout: 120_000 })
    .catch(() => {});
  await shot(page, "browser-ready");
  // keyboard only: Tab to ChatGPT, Enter, Tab to its switch and Sign in
  const focusPath: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    focusPath.push(
      await page.evaluate(
        () =>
          (document.activeElement as HTMLElement)?.innerText?.split("\n")[0] ||
          document.activeElement?.getAttribute("aria-label") ||
          document.activeElement?.tagName ||
          "",
      ),
    );
  }
  log("Tab order:", focusPath.join(" → "));
  await page.keyboard.press("Shift+Tab");
  await page.click(`${dialog} .setup-site[data-provider="chatgpt-web"]`);
  await shot(page, "site");
  await page.click(`${dialog} .setup-pool`).catch(async () => {
    await page.getByRole("button", { name: "Back" }).click();
    await page.click(`${dialog} .setup-pool`);
  });
  await shot(page, "keys");
  await ctx.close();

  for (const [w, h, theme] of [
    [390, 760, "light"],
    [720, 520, "dark"],
    [720, 520, "light"],
  ] as const) {
    const t = await tour(`${w}-${theme}`, w, h, theme);
    await t.page.goto(ui.url);
    await skipWelcome(t.page);
    await t.page.waitForSelector(`${dialog} .setup-sites`, { timeout: 30_000 });
    await shot(t.page, `sites-${w}-${theme}`);
    await t.page.click(`${dialog} .setup-site[data-provider="gemini-web"]`);
    await shot(t.page, `site-${w}-${theme}`);
    await t.page.getByRole("button", { name: "Close" }).click();
    await t.page.click('button[title="Model tier"]');
    await t.page.hover('.tier-menu [data-model="solstice"]');
    await t.page.waitForTimeout(300);
    await shot(t.page, `tier-${w}-${theme}`);
    await t.ctx.close();
  }
  log("done");
} finally {
  await browser.close();
  await ui.close();
  await router.stop();
  rmSync(scratch, { recursive: true, force: true });
}
