// Headless check of the welcome, the fallbacks and the "too large" suggestion, end to end in the
// page, against the mock router and stand-ins for claude, codex and the provenance binary
// (scripts/fixtures/fake-*.mjs). Nothing real is called and nothing opens on screen.
//
//   npm run build && npm run e2e:welcome      # SHOTS=dir for the screenshots
//
// Walks: first launch with nothing set up -> the welcome opens -> Models (a site row opens
// Models & accounts there and comes back) -> Fallbacks (health, switches, Codex's two modes)
// -> Done; it doesn't open again. The model picker's Fallbacks section and its model lists; a
// Claude Code thread (streamed items, a resumed second turn); opening a tier thread points the
// picker back at its tier; a thread that has outgrown the free models shows the suggestion
// (router flags + repeated commands + compactions), a calm one doesn't; "Continue in Codex"
// carries a brief over to Codex through Provenance; dismissing it sticks. Then a Mac with
// neither CLI: "Not installed" with how to get each, and the picker's muted rows.

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { startUiServer } from "../server/app.ts";
import { findChromium } from "./chromium.ts";
import { kit, layoutProblems } from "./e2e-kit.ts";
import { startMockRouter } from "./mock-router.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const { log, shot, check, shots } = kit(
  "welcome-e2e",
  process.env.SHOTS ?? path.join(tmpdir(), "provenance-welcome-e2e"),
);

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "provenance-welcome-e2e-")));
const bin = path.join(scratch, "bin");
const work = path.join(scratch, "work");
const codexLogin = path.join(scratch, "codex-login");
const dataDir = path.join(scratch, "data");
for (const d of [bin, work, codexLogin]) mkdirSync(d, { recursive: true });
symlinkSync(path.join(here, "fixtures/fake-claude.mjs"), path.join(bin, "claude"));
symlinkSync(path.join(here, "fixtures/fake-codex.mjs"), path.join(bin, "codex"));
appendFileSync(path.join(codexLogin, "auth.json"), "{}"); // a Codex login to share (never read)
const cliLog = path.join(scratch, "cli.jsonl");
process.env.FAKE_CLI_LOG = cliLog;
process.env.FAKE_WORK = work;
const runs = () =>
  readFileSync(cliLog, "utf8")
    .trim()
    .split("\n")
    .map(
      (l) =>
        JSON.parse(l) as {
          cli: string;
          argv: string[];
          stdin?: string;
          text?: string;
          home?: string;
          method?: string;
        },
    );
const nodeDir = path.dirname(process.execPath);

const mock = await startMockRouter(0);
const serve = (searchPath: string, data: string) =>
  startUiServer({
    root,
    prod: true,
    port: 0,
    host: "127.0.0.1",
    bin: path.join(here, "fixtures/fake-provenance.mjs"),
    router: { url: mock.url },
    cwd: () => ({ defaultCwd: work, fromLauncher: true }),
    dataDir: data,
    fallbackSearchPath: searchPath,
    codexLoginHome: codexLogin,
  });
const ui = await serve(`${bin}:${nodeDir}:/usr/bin:/bin`, dataDir);
log(`mock router ${mock.url}, UI ${ui.url}, screenshots in ${shots}`);

const welcome = ".welcome-dialog[open]";
const setup = ".setup-dialog[open]:not(.welcome-dialog)";
async function layoutOk(page: Page, where: string): Promise<void> {
  const bad = await layoutProblems(page);
  check(!bad.length, `layout at ${where}${bad.length ? ` (${bad.join("; ")})` : ""}`);
}
async function railStep(page: Page): Promise<string> {
  return page.locator(`${welcome} .setup-rail li.current`).innerText();
}

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
context.setDefaultTimeout(20_000);
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  // ---- 1. first launch: the welcome -------------------------------------------------
  log("welcome");
  await page.goto(ui.url);
  await page.waitForSelector(`${welcome} .welcome-intro`, { timeout: 15_000 });
  check((await railStep(page)).includes("Welcome"), "opens by itself, on step 1");
  await layoutOk(page, "welcome intro");
  await shot(page, "welcome-intro");
  await page.getByRole("button", { name: "Get started" }).click();
  await page.waitForSelector(`${welcome} .setup-sites .setup-site`);
  check((await railStep(page)).includes("Models"), "Get started -> Models");
  const sites = await page.locator(`${welcome} .setup-sites .setup-status`).allInnerTexts();
  check(
    sites.length === 4 && sites.slice(0, 3).every((t) => t === "Not signed in"),
    "three sites and the token pool, none set up",
  );
  await shot(page, "welcome-models");
  await page.click(`${welcome} .setup-site[data-provider="chatgpt-web"]`);
  await page.waitForSelector(`${setup} .setup-accounts`);
  check(
    (await page.locator(`${welcome}`).count()) === 0,
    "a site row opens Models & accounts on that site, in place of the welcome",
  );
  await page.locator(setup).getByRole("button", { name: "Close" }).click();
  await page.waitForSelector(`${welcome} .setup-sites`);
  check(
    (await railStep(page)).includes("Models"),
    "closing it comes back to the welcome's Models step",
  );
  await page.locator(welcome).getByRole("button", { name: "Next" }).click();
  await page.waitForSelector(`${welcome} .fallback-row[data-cli="claude"] .dot-ok`, {
    timeout: 15_000,
  });
  check((await railStep(page)).includes("Fallbacks"), "Next -> Fallbacks");
  const claudeRow = await page.locator(`${welcome} .fallback-row[data-cli="claude"]`).innerText();
  check(
    /Ready/.test(claudeRow) && /9\.9\.9 · Claude subscription \(pro\)/.test(claudeRow),
    "Claude Code: ready, version and plan",
  );
  check(!claudeRow.includes("example.com"), "no e-mail shown");
  await page.waitForSelector(`${welcome} .fallback-row[data-cli="codex"] .dot-ok`);
  await page.locator(welcome).getByRole("switch", { name: "Use Claude Code" }).check();
  await page.locator(welcome).getByRole("switch", { name: "Use Codex" }).check();
  await page.waitForSelector(`${welcome} .fallback-modes`);
  check(
    await page.locator(`${welcome} .fallback-mode[data-mode="provenance"] input`).isChecked(),
    "Codex on: Run Codex through Provenance is picked (Codex's login is there)",
  );
  check(
    await page.locator(`${welcome} .fallback-mode[data-mode="background"] input`).isEnabled(),
    "Codex in the background is the other choice",
  );
  await layoutOk(page, "welcome fallbacks");
  await shot(page, "welcome-fallbacks");
  await page.locator(welcome).getByRole("button", { name: "Next" }).click();
  await page.waitForSelector(`${welcome} .welcome-summary`);
  const summary = await page.locator(`${welcome} .welcome-summary`).innerText();
  check(
    /Claude Code, Codex through Provenance/.test(summary) && /None yet/.test(summary),
    `Done sums it up (${summary.replace(/\n/g, " ")})`,
  );
  await shot(page, "welcome-done");
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForSelector(welcome, { state: "detached" });
  await page.reload();
  await page.waitForSelector(".composer textarea");
  await page.waitForTimeout(2500);
  check((await page.locator(welcome).count()) === 0, "it doesn't open again after finishing");

  // ---- 2. the picker's Fallbacks section --------------------------------------------
  log("picker");
  await page.click('button[title="Model tier"]');
  await page.waitForSelector('.tier-menu [data-fallback="claude"]');
  check(
    (await page.locator(".tier-menu .tier-section").innerText()) === "Fallbacks",
    "a Fallbacks section under the tiers",
  );
  await page.hover('.tier-menu [data-fallback="claude"]');
  await page.waitForSelector('.tier-sub[data-fallback="claude"]');
  const cm = await page.locator(".tier-sub .tier-sub-label").allInnerTexts();
  check(
    cm.join(",") === "Default,Fable,Opus,Sonnet,Haiku",
    `Claude Code's models on hover (${cm.join(", ")})`,
  );
  await shot(page, "picker-claude");
  await page.hover('.tier-menu [data-fallback="codex"]');
  await page.waitForSelector('.tier-sub[data-fallback="codex"]');
  const xm = await page.locator(".tier-sub .tier-sub-label").allInnerTexts();
  check(
    xm.join(",") === "Default,GPT-Fake-Sol,GPT-Fake-Luna,Through Provenance,In the background",
    `Codex's models, then how it runs (${xm.join(", ")})`,
  );
  check(
    (await page
      .locator('.tier-sub [data-codex-mode="provenance"][aria-selected="true"]')
      .count()) === 1,
    "through Provenance is checked",
  );
  await shot(page, "picker-codex");
  await page.hover('.tier-menu [data-fallback="claude"]');
  await page.waitForSelector('.tier-sub[data-fallback="claude"]');
  await page.click('.tier-sub [data-source-model="claude:opus"]');
  check(
    /Claude Code\s*· Opus/.test(await page.locator(".tier-picker-btn").innerText()),
    "picked: the button says Claude Code · Opus",
  );

  // ---- 3. a Claude Code thread ---------------------------------------------------------
  log("claude thread");
  await page.fill(".composer textarea", "Fix the typo in a.txt");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.turn .agent-message:has-text("Done (new session).")', {
    timeout: 20_000,
  });
  const turnText = (await page.locator(".turn").last().textContent()) ?? "";
  check(
    /Looking at it\./.test(turnText) && /echo hi/.test(turnText),
    "the streamed message and the command show",
  );
  check(/a\.txt/.test(turnText), "the edit shows");
  check(
    /Claude Code\s*· Opus/.test(await page.locator(".turn-footer").last().innerText()),
    "the turn footer says Claude Code · Opus",
  );
  await shot(page, "claude-thread");
  let r = runs()
    .filter((x) => x.cli === "claude")
    .at(-1)!;
  check(
    r.stdin === "Fix the typo in a.txt" && r.argv.includes("opus"),
    "claude ran with the prompt on stdin and --model opus",
  );
  await page.fill(".composer textarea", "Now the other one");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.turn .agent-message:has-text("Done (resumed session).")', {
    timeout: 20_000,
  });
  r = runs()
    .filter((x) => x.cli === "claude")
    .at(-1)!;
  check(r.argv.includes("--resume"), "the second turn resumed the session");

  // ---- 4. the "too large" suggestion ----------------------------------------------------
  log("suggestion");
  await fetch(`${mock.url}/mock/usage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turn: "turn-s3", context: { compacted: 4, trimmed: 3 } }),
  });
  await page.locator(".thread-title", { hasText: /^Refactor the parser into modules$/ }).click();
  await page.waitForSelector(".strain-note", { timeout: 15_000 });
  check(
    /solstice/.test(await page.locator(".tier-picker-btn").innerText()),
    "opening a tier thread points the picker back at its tier",
  );
  const note = await page.locator(".strain-note").innerText();
  check(
    /grown too large for the free models/.test(note) &&
      /Continue in Claude Code/.test(note) &&
      /Continue in Codex/.test(note),
    "the suggestion, with both fallbacks",
  );
  check(
    /trimmed|cut|repeated|compacted/.test(
      (await page.locator(".strain-note").getAttribute("title")) ?? "",
    ),
    "its tooltip says why",
  );
  await shot(page, "strain-note");
  await page.click('.thread-title:has-text("Add a README section")');
  await page.waitForSelector('.agent-message:has-text("Added it.")');
  check((await page.locator(".strain-note").count()) === 0, "a calm thread shows nothing");
  await page.locator(".thread-title", { hasText: /^Refactor the parser into modules$/ }).click();
  await page.waitForSelector(".strain-note");
  await page.locator(".strain-note").getByRole("button", { name: "Continue in Codex" }).click();
  await page.waitForSelector('.agent-message:has-text("ok from openai")', { timeout: 30_000 });
  const pv = runs()
    .filter((x) => x.cli === "provenance" && x.method === "turn/start")
    .at(-1)!;
  check(
    pv.argv.join(" ").includes('model_provider="openai"') &&
      pv.home === path.join(dataDir, "codex-home"),
    "it ran on the second app-server: OpenAI provider, its own home",
  );
  check(
    /^\[Continued from the Provenance thread "Refactor the parser/.test(pv.text ?? ""),
    "with a brief of the old thread first",
  );
  check(
    /Codex\s*· Default/.test(await page.locator(".tier-picker-btn").innerText()),
    "the picker follows the new thread",
  );
  await page.waitForSelector(
    '.thread-title:has-text("Refactor the parser into modules (continued)")',
  );
  check(true, "the new thread is named after the one it continues");
  await shot(page, "continued-in-codex");
  await page.locator(".thread-title", { hasText: /^Refactor the parser into modules$/ }).click();
  await page.waitForSelector(".strain-note");
  await page.locator(".strain-note").getByRole("button", { name: "Dismiss" }).click();
  check((await page.locator(".strain-note").count()) === 0, "dismissed");
  await page.reload();
  await page.locator(".thread-title", { hasText: /^Refactor the parser into modules$/ }).click();
  await page.waitForSelector('.agent-message:has-text("Looking at the tokenizer again.")');
  await page.waitForTimeout(800);
  check((await page.locator(".strain-note").count()) === 0, "and stays dismissed for that thread");

  // ---- 5. Models & accounts has the fallbacks too; narrow window ----------------------
  log("settings");
  await page.click('button[title="Model tier"]');
  await page.click(".tier-setup");
  await page.waitForSelector(`${setup} .setup-fallbacks`);
  await page.click(`${setup} .setup-fallbacks`);
  await page.waitForSelector(`${setup} .fallback-row`);
  check(
    (await page.locator(`${setup} .setup-rail[data-gone]`).count()) === 1,
    "Models & accounts has a Fallbacks page (no step rail)",
  );
  await page.setViewportSize({ width: 420, height: 760 });
  await layoutOk(page, "fallbacks page at phone width");
  await shot(page, "settings-fallbacks-narrow");
  await page.setViewportSize({ width: 1280, height: 820 });

  // ---- 6. a Mac with neither CLI --------------------------------------------------------
  log("nothing installed");
  const bare = await serve(`${nodeDir}:/usr/bin:/bin`, path.join(scratch, "data-bare"));
  const p2 = await context.newPage();
  p2.on("pageerror", (e) => errors.push(e.message));
  await p2.goto(bare.url);
  await p2.evaluate(() => localStorage.clear());
  await p2.reload();
  await p2.waitForSelector(`${welcome} .welcome-intro`, { timeout: 15_000 });
  await p2.getByRole("button", { name: "Get started" }).click();
  await p2.locator(welcome).getByRole("button", { name: "Next" }).click();
  await p2.waitForSelector(`${welcome} .fallback-row[data-cli="claude"] .dot-off`, {
    timeout: 15_000,
  });
  const rows = await p2.locator(`${welcome} .fallback-row`).allInnerTexts();
  check(
    rows.every((t) => /Not installed/.test(t)),
    "both read Not installed",
  );
  check(
    /curl -fsSL https:\/\/claude\.ai\/install\.sh/.test(rows[0]) &&
      /npm install -g @openai\/codex/.test(rows[1]),
    "each with a one-line how-to",
  );
  check(
    await p2.locator(welcome).getByRole("switch", { name: "Use Claude Code" }).isDisabled(),
    "a missing CLI can't be turned on",
  );
  check(
    (await p2.locator(`${welcome} [role="alert"], ${welcome} .error-card`).count()) === 0,
    "no error shown for it",
  );
  await shot(p2, "welcome-nothing-installed");
  await p2.locator(welcome).getByRole("button", { name: "Close" }).click();
  await p2.click('button[title="Model tier"]');
  await p2.waitForSelector('.tier-menu [data-fallback="claude"].muted');
  const muted = await p2.locator(".tier-menu .fallback-option").allInnerTexts();
  check(
    muted.every((t) => /Set up…/.test(t)),
    "the picker's fallback rows are muted and lead to setup",
  );
  await shot(p2, "picker-muted");
  await p2.click('.tier-menu [data-fallback="codex"]');
  await p2.waitForSelector(`${setup} .fallback-row`);
  check(true, "a muted row opens the Fallbacks page");
  await p2.close();
  await bare.close();

  check(!errors.length, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  log("all good");
} finally {
  await browser.close();
  await ui.close();
  await mock.close();
}
process.exit(0);
