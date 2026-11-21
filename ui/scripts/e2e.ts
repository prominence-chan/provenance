// Headless browser check of the real UI (Playwright, its own Chromium; never your Chrome).
//
//   npm run dev        # in another terminal (NO_OPEN=1 to skip opening a tab)
//   npm run e2e        # MODEL=spark to pick another tier, SHOT=path for the screenshot
//   APPROVAL=1 npm run e2e   # also exercise a command approval (touches a file in /tmp)
//
// Flow: new thread -> pick tier -> send "reply with just ok" -> wait for the
// streamed assistant message -> reload -> reopen the thread from the sidebar and
// check the history renders (thread/resume + thread/turns/list).
//
// Uses Playwright's bundled Chromium if installed (`npx playwright install
// chromium`), otherwise falls back to any cached headless shell in
// ~/Library/Caches/ms-playwright, or CHROMIUM_PATH.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const port = Number(process.env.PORT ?? 5173);
const model = process.env.MODEL ?? "ember";
const shot = process.env.SHOT ?? "/tmp/provenance-ui-e2e.png";
const prompt = "reply with just ok";
const log = (...a: unknown[]) => console.log("[e2e]", ...a);

function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (existsSync(chromium.executablePath())) return undefined; // Playwright's own
  const cache = path.join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse()) {
    const bin = path.join(cache, dir, "chrome-headless-shell-mac-arm64/chrome-headless-shell");
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

const executablePath = findChromium();
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => log("page error:", e.message));

/** The tier picker is a custom listbox: open it, click the option. */
async function pickTier(m: string): Promise<void> {
  await page.click('button[title="Model tier"]');
  await page.click(`.tier-menu [role="option"][data-model="${m}"]`);
}

try {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector(".conn .dot-ok", { timeout: 60_000 });
  log("UI loaded, app-server ready");

  await page.getByRole("button", { name: "New thread" }).click();
  await pickTier(model);
  await page.fill('input[placeholder="working directory"]', "/tmp");

  let replied = false;
  for (let attempt = 1; attempt <= 4 && !replied; attempt++) {
    await page.fill(".composer textarea", prompt);
    await page.keyboard.press("Enter");
    log(`attempt ${attempt}: sent "${prompt}" with ${model}`);
    // Wait for this turn to finish (footer, error card, or interrupted note).
    const turns = page.locator(".turn");
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
    const last = turns.last();
    const text = (await last.locator(".agent-message").allInnerTexts()).join(" ").trim();
    log(`attempt ${attempt}: assistant text = ${JSON.stringify(text)}`);
    replied = /\bok\b/i.test(text);
    if (!replied)
      log(
        `attempt ${attempt}: ${(await last.locator(".error-card").allInnerTexts()).join(" ") || "no ok"}`,
      );
  }
  if (!replied) throw new Error("no streamed reply rendered");

  const title = await page.locator(".thread-row.selected .thread-title").innerText();
  const header = await page.locator(".thread-header").innerText();
  log(
    `sidebar selected thread: ${JSON.stringify(title)}; header: ${JSON.stringify(header.replace(/\n/g, " | "))}`,
  );
  await page.screenshot({ path: shot });
  log(`screenshot: ${shot}`);

  // Reload and resume the thread from the sidebar.
  await page.reload();
  await page.waitForSelector(".conn .dot-ok", { timeout: 60_000 });
  await page.locator(".thread-row", { hasText: prompt }).first().click();
  await page.waitForSelector(".agent-message", { timeout: 30_000 });
  const history = await page.locator(".user-bubble").count();
  log(
    `after reload: resumed thread shows ${history} user message(s) and ${await page.locator(".agent-message").count()} assistant message(s)`,
  );
  if (process.env.APPROVAL) await approvalFlow();
  log("PASS");
} catch (e) {
  await page.screenshot({ path: shot }).catch(() => {});
  log("FAIL:", e instanceof Error ? e.message : e, `(screenshot: ${shot})`);
  process.exitCode = 1;
} finally {
  await browser.close();
}

/** New thread in "Ask every time" mode; the model must request approval to run a command. */
async function approvalFlow(): Promise<void> {
  const marker = `/tmp/provenance-ui-approval-${Date.now()}`;
  await page.getByRole("button", { name: "New thread" }).click();
  await pickTier(model);
  await page.selectOption('select[title^="approval:"]', "ask");
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.fill(
      ".composer textarea",
      `Use your shell tool to run exactly this command: touch ${marker}\nThen reply "done".`,
    );
    await page.keyboard.press("Enter");
    log(`approval attempt ${attempt}: asked model to run touch ${marker}`);
    const appeared = await page
      .waitForSelector(".approval", { timeout: 120_000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      log("  no approval card (model may not have called the tool); retrying");
      continue;
    }
    log(
      `  approval card: ${JSON.stringify((await page.locator(".approval").first().innerText()).replace(/\n/g, " | "))}`,
    );
    await page.screenshot({ path: shot.replace(/\.png$/, "-approval.png") });
    await page
      .locator(".approval")
      .first()
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    await page.waitForSelector(".approval", { state: "detached", timeout: 30_000 });
    await page.waitForFunction(() => !document.querySelector(".send-btn.stop"), null, {
      timeout: 180_000,
    });
    const cards = await page.locator(".cmd summary").allInnerTexts();
    log(`  command cards: ${JSON.stringify(cards)}; file created: ${existsSync(marker)}`);
    if (!existsSync(marker)) throw new Error("approved command did not run");
    return;
  }
  throw new Error("model never requested approval");
}
