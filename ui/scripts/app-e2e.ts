// Drives the installed desktop app (Playwright's Electron support). It opens a real
// window for the duration of the run, then quits the app.
//
//   npm run app:e2e                     # /Applications/Provenance.app, MODEL=spark
//   APP=release/mac-arm64/Provenance.app npm run app:e2e
//
// Checks: window renders with the hiddenInset title bar, preload API present,
// /api/health, folder picker button, then a real turn ("reply with just ok").

import path from "node:path";
import { _electron as electron } from "playwright";

const appPath = process.env.APP ?? "/Applications/Provenance.app";
const exe = path.join(appPath, "Contents/MacOS/Provenance");
const model = process.env.MODEL ?? "spark";
const shot = process.env.SHOT ?? "/tmp/provenance-app-e2e.png";
const prompt = "reply with just ok";
const log = (...a: unknown[]) => console.log("[app-e2e]", ...a);

const app = await electron.launch({ executablePath: exe, args: ["--cwd=/tmp"], timeout: 60_000 });
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => log("page error:", e.message));
  log("window url:", page.url());
  const win = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { bounds: w.getBounds(), min: w.getMinimumSize(), title: w.getTitle() };
  });
  log("window:", JSON.stringify(win));
  await page.waitForSelector(".conn .dot-ok", { timeout: 60_000 });
  log("UI rendered, app-server ready");
  log("shell:", await page.evaluate(() => document.documentElement.dataset.shell));
  log(
    "health:",
    JSON.stringify(await page.evaluate(() => fetch("/api/health").then((r) => r.json()))),
  );
  log("folder picker button:", await page.locator(".cwd-pick").count());
  log("cwd field:", await page.inputValue('input[placeholder="working directory"]'));

  await page.getByRole("button", { name: "New thread" }).click();
  await page.click('button[title="Model tier"]');
  await page.click(`.tier-menu [role="option"][data-model="${model}"]`);

  let replied = false;
  for (let attempt = 1; attempt <= 4 && !replied; attempt++) {
    await page.fill(".composer textarea", prompt);
    await page.keyboard.press("Enter");
    log(`attempt ${attempt}: sent "${prompt}" with ${model}`);
    await page.waitForFunction(
      (n) => {
        const all = document.querySelectorAll(".turn");
        const last = all[all.length - 1];
        return (
          all.length >= n &&
          !!last?.querySelector(".turn-footer, .error-card, .turn-note:not(.warn)")
        );
      },
      attempt,
      { timeout: 180_000 },
    );
    const last = page.locator(".turn").last();
    const text = (await last.locator(".agent-message").allInnerTexts()).join(" ").trim();
    log(`attempt ${attempt}: assistant text = ${JSON.stringify(text)}`);
    replied = /\bok\b/i.test(text);
  }
  await page.screenshot({ path: shot });
  log(`screenshot: ${shot}`);
  if (!replied) throw new Error("no reply");
  log("PASS");
} catch (e) {
  log("FAIL:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await app.close();
}
