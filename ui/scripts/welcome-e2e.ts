// Headless check of the welcome, the fallbacks and the "too large" suggestion, end to end in the
// page, against the mock router and stand-ins for claude, codex and the provenance binary
// (scripts/fixtures/fake-*.mjs). Nothing real is called and nothing opens on screen.
//
//   npm run build && npm run e2e:welcome      # SHOTS=dir for the screenshots
//
// Walks: first launch with nothing set up -> the welcome opens -> Models (a site row opens
// Models & accounts there and comes back) -> Fallbacks (health, switches, Codex's two modes)
// -> Done; it doesn't open again, and the sidebar's "Finish setting up" (no site or key yet)
// opens it on Models. The model picker's Fallbacks section and its model lists; a picked
// fallback's colour on the picker row, the button, the composer and the turn; a
// Claude Code thread (streamed items, a resumed second turn; "Ask every time" warns that it runs
// without asking and runs it like Auto); opening a tier thread points the
// picker back at its tier; a thread that has outgrown the free models shows the suggestion
// (router flags + repeated commands + compactions), a calm one doesn't; dismissing it sticks;
// "Continue in Codex" moves the conversation to Codex through Provenance in the same thread (its
// app-server pointed at the router's pass-through, started with a brief it never shows, carrying
// on without a message; the turn's saved history in the footer). Then a Mac with
// neither CLI: "Not installed" with how to get each, and the picker's muted rows. Then when the
// welcome opens by itself: sites signed in but no fallback -> it opens, reading as partly set up,
// and "Finish setting up" leads to what is left until nothing is; everything set up -> it doesn't.
// The composer's slot after the model picker: a fallback's reasoning effort (only the efforts its
// model takes; chosen by keyboard and by pointer; on Claude Code's command line, in Codex through
// Provenance's turn/start, nothing for Default; kept per fallback across a reload), and on a tier
// the orchestrator (read only in an existing thread; chosen for new threads, kept).

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
          effort?: string | null;
          hasEffort?: boolean;
          developerInstructions?: string | null;
          additionalContext?: Record<string, { value: string }> | null;
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
/** The rail's steps already set up, as read out ("Models (set up)"). */
async function railSet(page: Page): Promise<string> {
  const t = await page.locator(`${welcome} .setup-rail li[data-set]`).allTextContents();
  return t.map((x) => x.trim()).join();
}
async function railStep(page: Page): Promise<string> {
  return page.locator(`${welcome} .setup-rail li.current`).innerText();
}
/** An element's computed text colour is the given colour token's. */
async function colourIs(page: Page, sel: string, token: string): Promise<boolean> {
  return page.evaluate(
    ([sel, token]) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(el).color === want;
    },
    [sel, token] as const,
  );
}
const post = (route: string, body: unknown, method = "POST") =>
  fetch(`${mock.url}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

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
  check(
    /can't ask for approval/i.test(
      await page.locator(`${welcome} .fallback-row[data-cli="claude"] .fallback-note`).innerText(),
    ) &&
      /can't ask for approval/i.test(
        await page.locator(`${welcome} .fallback-mode[data-mode="background"]`).innerText(),
      ),
    "Claude Code and Codex in the background say they can't ask for approval",
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
  // Fallbacks on, but no site or API key yet: the sidebar keeps a way back in.
  const hint = page.locator(".sidebar-setup");
  await hint.waitFor();
  check(
    (await hint.innerText()).trim() === "Finish setting up",
    "the sidebar says Finish setting up",
  );
  await hint.click();
  await page.waitForSelector(`${welcome} .setup-sites`);
  check((await railStep(page)).includes("Models"), "which opens the welcome on Models");
  check(
    (await railSet(page)) === "Fallbacks (set up)",
    "the rail ticks the fallbacks, already set up",
  );
  await page.locator(welcome).getByRole("button", { name: "Close" }).click();
  await page.waitForSelector(welcome, { state: "detached" });

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
  // Picked like a tier: its own colour on the button, the composer and the picker's row.
  check(
    (await page.locator('.tier-picker-btn[data-fallback="claude"]').count()) === 1 &&
      (await colourIs(page, ".tier-picker-btn > svg", "--fallback-claude")),
    "the button carries Claude Code's colour",
  );
  check(
    (await page.locator('.composer-shell[data-fallback="claude"]').count()) === 1,
    "so does the composer (its effect)",
  );
  await page.click('button[title="Model tier"]');
  await page.waitForSelector('.tier-menu [data-fallback="claude"][aria-selected="true"]');
  check(
    (await colourIs(
      page,
      '.tier-menu [data-fallback="claude"] .tier-option-glyph',
      "--fallback-claude",
    )) &&
      (await colourIs(
        page,
        '.tier-menu [data-fallback="claude"] .tier-option-check',
        "--fallback-claude",
      )) &&
      (await colourIs(
        page,
        '.tier-menu [data-fallback="codex"] .tier-option-glyph',
        "--fallback-codex",
      )),
    "the picker's rows: Claude Code's glyph and check in its colour, Codex's glyph in its own",
  );
  await page.hover('.tier-menu [data-fallback="claude"]');
  await page.waitForSelector('.tier-sub[data-fallback="claude"]');
  check(
    await colourIs(
      page,
      '.tier-sub [data-source-model="claude:opus"] .tier-option-check',
      "--fallback-claude",
    ),
    "and the submenu's check",
  );
  await shot(page, "picker-claude-selected");
  await page.keyboard.press("Escape");

  // The slot after the picker: Claude Code's reasoning effort, what its --effort takes.
  const slotBtn = page.locator(".composer .slot-btn");
  check(
    (await page.locator(".composer .slot-effort").count()) === 1 &&
      (await page.locator(".composer .slot-orchestrator").count()) === 0,
    "a fallback picked: the slot is the effort control, not the orchestrator",
  );
  check(
    (await slotBtn.innerText()).trim() === "Effort" &&
      (await slotBtn.getAttribute("data-value")) === "default",
    "at Default it reads Effort",
  );
  await slotBtn.click();
  await page.waitForSelector(".slot-menu-effort");
  const levels = await page.locator(".slot-menu-effort .tier-option-name").allInnerTexts();
  check(
    levels.join(",") === "Default,Low,Medium,High,Extra high,Max",
    `Claude Code's efforts: Default and what --effort takes (${levels.join(", ")})`,
  );
  check(
    await colourIs(page, '.slot-menu-effort [aria-selected="true"] .tier-option-check', "--fallback-claude"),
    "the effort list takes Claude Code's colour",
  );
  await shot(page, "effort-claude-open");
  await page.keyboard.press("Escape");
  check((await page.locator(".slot-menu").count()) === 0, "Escape closes it");

  // ---- 3. a Claude Code thread ---------------------------------------------------------
  log("claude thread");
  const perms = page.locator(".composer .picker-wrap select.picker");
  check((await page.locator(".composer-note").count()) === 0, "Auto: no note");
  await perms.selectOption("ask");
  const noAsk = await page.locator(".composer-note").innerText();
  check(
    /Claude Code can't ask for approval here: it will run without asking, like Auto/.test(noAsk),
    `Ask every time: the composer warns it runs without asking (${noAsk})`,
  );
  check(await page.locator(".composer .send-btn").isVisible(), "and sending stays possible");
  await layoutOk(page, "composer with the note");
  await shot(page, "composer-no-ask");
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
  check(
    (await page.locator('.turn[data-fallback="claude"]').count()) > 0 &&
      (await colourIs(
        page,
        '.turn-footer .tier-badge[data-fallback="claude"] > svg',
        "--fallback-claude",
      )),
    "the turn carries Claude Code's colour (its shimmer while it runs, the footer's badge)",
  );
  await shot(page, "claude-thread");
  let r = runs()
    .filter((x) => x.cli === "claude")
    .at(-1)!;
  check(
    r.stdin === "Fix the typo in a.txt" && r.argv.includes("opus"),
    "claude ran with the prompt on stdin and --model opus",
  );
  check(
    r.argv.includes("acceptEdits") && !r.argv.includes("dontAsk"),
    "Ask every time ran it like Auto (acceptEdits), not read only",
  );
  check(!r.argv.includes("--effort"), "Default effort: no --effort");
  // Choose High by keyboard, as in the model picker: arrow opens, arrows move, Enter picks.
  await slotBtn.focus();
  await page.keyboard.press("ArrowUp");
  await page.waitForSelector(".slot-menu-effort");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  check(
    (await slotBtn.innerText()).trim() === "High" &&
      (await page.locator(".slot-menu").count()) === 0,
    "keyboard: High chosen, the list closed",
  );
  check(
    await page.evaluate(() => {
        const r = document.querySelector(".composer .slot-btn .effort-meter rect.on");
        const probe = document.createElement("span");
        probe.style.color = "var(--fallback-claude)";
        document.body.append(probe);
        const want = getComputedStyle(probe).color;
        probe.remove();
        return !!r && getComputedStyle(r).fill === want;
      }),
    "its meter in Claude Code's colour",
  );
  check(
    (await page.evaluate(() => JSON.parse(localStorage.getItem("provenance-ui.settings") ?? "{}")))
      .fallbackEffort?.claude === "high",
    "kept in settings for Claude Code",
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
  check(
    r.argv.join(" ").includes("--effort high"),
    "with --effort high on the resumed session (the effort rides on every turn)",
  );
  await shot(page, "effort-claude-high");

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
  check(
    (await page.locator(".composer .slot-orchestrator .slot-btn.readonly").innerText()).trim() ===
      "Provenance" && (await page.locator(".composer .slot-effort").count()) === 0,
    "a tier thread: the slot shows its orchestrator, Provenance, read only",
  );
  await page.click(".composer .slot-btn", { force: true });
  check((await page.locator(".slot-menu").count()) === 0, "and it doesn't open there");
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
  // Dismissing it sticks (checked first: once the conversation is on Codex there is no note).
  await page.locator(".strain-note").getByRole("button", { name: "Dismiss" }).click();
  check((await page.locator(".strain-note").count()) === 0, "dismissed");
  await page.reload();
  await page.locator(".thread-title", { hasText: /^Refactor the parser into modules$/ }).click();
  await page.waitForSelector('.agent-message:has-text("Looking at the tokenizer again.")');
  await page.waitForTimeout(800);
  check((await page.locator(".strain-note").count()) === 0, "and stays dismissed for that thread");
  await page.evaluate(() => localStorage.removeItem("provenance-ui.strain-dismissed"));
  await page.reload();
  await page.locator(".thread-title", { hasText: /^Refactor the parser into modules$/ }).click();
  await page.waitForSelector(".strain-note");
  await fetch(`${mock.url}/mock/usage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pruned: { before: 50_000, after: 30_000 } }),
  });
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
    pv.argv.join(" ").includes(`openai_base_url="${mock.url}/codex-sub/open/backend-api/codex"`) &&
      pv.argv.includes("features.enable_request_compression=false"),
    "its model requests go to the router's pass-through, not straight to OpenAI",
  );
  await page.waitForSelector(".turn-footer .turn-saved", { timeout: 15_000 });
  const saved = await page.locator(".turn-footer .turn-saved").last();
  check(
    (await saved.innerText()) === "history 40% smaller" &&
      /30,000 of 50,000 characters/.test((await saved.getAttribute("title")) ?? ""),
    "the turn's footer says how much smaller the router made its history",
  );
  check(
    (await page.locator(".composer-note").count()) === 0,
    "through Provenance asks for approval itself: no note there",
  );
  const pvStart = runs()
    .filter(
      (x) =>
        x.cli === "provenance" &&
        x.method === "thread/start" &&
        x.argv.join(" ").includes('model_provider="openai"'),
    )
    .at(-1)!;
  check(
    /^\[Hand-over: [^\n]*"Refactor the parser into modules"/.test(
      pvStart.developerInstructions ?? "",
    ) && (pvStart.developerInstructions ?? "").includes("Looking at the tokenizer again."),
    "its session starts with a brief of the conversation, as its instructions",
  );
  check(
    pv.text === "" && /carry on/i.test(pv.additionalContext?.provenance_handover?.value ?? ""),
    "and the turn carries on without a message of the person's",
  );
  check(
    /Codex\s*· Default/.test(await page.locator(".tier-picker-btn").innerText()),
    "the picker follows the conversation",
  );
  check(pv.hasEffort === false, "Codex at Default effort: turn/start carries no effort");
  await page.click(".composer .slot-btn");
  await page.waitForSelector(".slot-menu-effort");
  const pvLevels = await page.locator(".slot-menu-effort .tier-option-name").allInnerTexts();
  check(
    pvLevels.join(",") === "Default,Low,Medium,High,Extra high,Max,Ultra",
    `Codex through Provenance, its default model: every listed model's efforts (${pvLevels.join(", ")})`,
  );
  await page.click('.slot-menu-effort [data-value="max"]');
  await page.fill(".composer textarea", "Go deeper");
  await page.keyboard.press("Enter");
  for (let i = 0; i < 100 && !runs().some((x) => x.text === "Go deeper"); i++)
    await page.waitForTimeout(100);
  const pv2 = runs()
    .filter((x) => x.cli === "provenance" && x.method === "turn/start")
    .at(-1)!;
  check(
    pv2.text === "Go deeper" && pv2.effort === "max",
    `pointer: Max chosen; turn/start carries effort "max" (${pv2.effort})`,
  );
  check(
    (await page.locator('.tier-picker-btn[data-fallback="codex"]').count()) === 1 &&
      (await page.locator('.composer-shell[data-fallback="codex"]').count()) === 1 &&
      (await page.locator('.turn[data-fallback="codex"]').count()) > 0,
    "Codex through Provenance carries Codex's colour on the button, the composer and the turn",
  );
  const titles = await page.locator(".thread-title").allInnerTexts();
  check(
    titles.filter((t) => /Refactor the parser/.test(t)).length === 1 &&
      !titles.some((t) => /continued/i.test(t)),
    "still one conversation in the sidebar, under its own title",
  );
  check(
    (await page.locator(".carry-line").allInnerTexts()).join("|") ===
      "Continued in Codex from the conversation above",
    "a faint line marks where it moved to Codex",
  );
  await shot(page, "continued-in-codex");
  await page.reload();
  await page.waitForSelector(".composer .slot-effort .slot-btn");
  check(
    (await page.locator(".composer .slot-btn").innerText()).trim() === "Max",
    "after a reload Codex's effort is still Max",
  );
  // A tier thread opened points the picker back at its tier, for what follows.
  await page.locator(".thread-title", { hasText: /^Add a README section$/ }).click();
  await page.waitForSelector('.agent-message:has-text("Added it.")');

  // ---- 4b. the orchestrator, for new threads on a tier --------------------------------
  log("orchestrator");
  await page.getByRole("button", { name: "New thread", exact: true }).first().click();
  const orch = page.locator(".composer .slot-orchestrator .slot-btn");
  await orch.waitFor();
  check(
    (await orch.innerText()).trim() === "Provenance" &&
      (await orch.getAttribute("aria-disabled")) === null,
    "a new thread on a tier: the orchestrator, Provenance by default, to choose",
  );
  await orch.click();
  await page.waitForSelector(".slot-menu-orchestrator");
  const orchRows = await page.locator(".slot-menu-orchestrator .slot-option").allInnerTexts();
  check(
    orchRows.length === 3 &&
      /Provenance\s+One thread/.test(orchRows[0]) &&
      /Experimental\s+A fresh worker per job/.test(orchRows[1]) &&
      /Hyperexperimental\s+A plain chat per step/.test(orchRows[2]),
    "three choices, each with its one line",
  );
  await page.hover('.slot-menu-orchestrator [data-value="experimental"]');
  await shot(page, "orchestrator-open");
  await page.click('.slot-menu-orchestrator [data-value="experimental"]');
  check((await orch.innerText()).trim() === "Experimental", "Experimental chosen");
  await page.reload();
  await page.waitForSelector(".composer .slot-orchestrator .slot-btn");
  check(
    (await page.locator(".composer .slot-orchestrator .slot-btn").innerText()).trim() ===
      "Experimental" &&
      (await page.evaluate(() => JSON.parse(localStorage.getItem("provenance-ui.settings") ?? "{}")))
        .orchestrator === "experimental",
    "kept as settings.orchestrator across a reload",
  );
  await page.locator(".thread-title", { hasText: /^Add a README section$/ }).click();
  await page.waitForSelector('.agent-message:has-text("Added it.")');
  check(
    (await page.locator(".composer .slot-orchestrator .slot-btn.readonly").innerText()).trim() ===
      "Provenance",
    "an existing thread still shows the orchestrator it was started with",
  );
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("provenance-ui.settings") ?? "{}");
    localStorage.setItem("provenance-ui.settings", JSON.stringify({ ...s, orchestrator: "bogus" }));
  });
  await page.reload();
  await page.getByRole("button", { name: "New thread", exact: true }).first().click();
  await page.waitForSelector(".composer .slot-orchestrator .slot-btn");
  check(
    (await page.locator(".composer .slot-orchestrator .slot-btn").innerText()).trim() ===
      "Provenance",
    "a saved value that isn't an orchestrator loads as the default",
  );

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

  // ---- 7. when the welcome opens by itself --------------------------------------------
  log("opening rule");
  /** A fresh install's page (its own storage), with these settings saved. */
  const freshPage = async (settings?: object, theme?: "light") => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    c.setDefaultTimeout(20_000);
    await c.addInitScript(
      ([s, t]) => {
        if (s) localStorage.setItem("provenance-ui.settings", s);
        if (t) localStorage.setItem("provenance-ui.theme", t);
      },
      [settings ? JSON.stringify(settings) : "", theme ?? ""] as const,
    );
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(ui.url);
    await p.waitForSelector(".composer textarea");
    return p;
  };
  const opened = async (p: Page) => {
    await p.waitForSelector(welcome, { timeout: 4000 }).catch(() => undefined);
    return (await p.locator(welcome).count()) === 1;
  };
  await post("/mock/reset", { scenario: "signed" }); // sites signed in, and an API key...
  await post("/pool/keys/google", {}, "DELETE"); // ...taken away for now
  const p3 = await freshPage();
  check(await opened(p3), "sites signed in, no fallback switched on: it opens");
  check(
    !/nothing|not set up/i.test(await p3.locator(`${welcome} .welcome-intro`).innerText()),
    "the intro doesn't say nothing is set up",
  );
  await p3.getByRole("button", { name: "Get started" }).click();
  await p3.waitForSelector(`${welcome} .setup-sites .setup-site`);
  check(
    /what's ready/.test(await p3.locator(`${welcome} .setup-lead`).innerText()),
    "Models reads as partly done",
  );
  check(
    (await p3.locator(`${welcome} .setup-site[data-provider="chatgpt-web"]`).innerText()).includes(
      "Ready",
    ),
    "the signed-in site reads Ready",
  );
  await layoutOk(p3, "welcome models, partly set up");
  await shot(p3, "welcome-partly-models-dark");
  await p3.locator(welcome).getByRole("button", { name: "Close" }).click();
  await p3.reload();
  await p3.waitForSelector(".composer textarea");
  check(!(await opened(p3)), "closed once: it doesn't open again");
  // No API key yet: "Finish setting up" leads to Models; with one, to Fallbacks.
  await p3.click(".sidebar-setup");
  await p3.waitForSelector(`${welcome} .setup-sites`);
  check((await railStep(p3)).includes("Models"), "Finish setting up: Models first (no API key)");
  await p3.locator(welcome).getByRole("button", { name: "Close" }).click();
  await post("/pool/keys/google", { values: { GEMINI_API_KEY: "test-key" } }, "PUT");
  await p3.reload();
  await p3.waitForSelector(".composer textarea");
  await p3.click(".sidebar-setup");
  await p3.waitForSelector(`${welcome} .fallback-row`);
  check(
    (await railStep(p3)).includes("Fallbacks"),
    "with a site and a key: Finish setting up opens on Fallbacks",
  );
  check((await railSet(p3)) === "Models (set up)", "the rail ticks Models");
  await p3.waitForSelector(`${welcome} .fallback-row[data-cli="claude"] .dot-ok`);
  await layoutOk(p3, "welcome fallbacks, partly set up");
  await shot(p3, "welcome-partly-fallbacks-dark");
  await p3.locator(welcome).getByRole("switch", { name: "Use Claude Code" }).check();
  await p3.locator(welcome).getByRole("button", { name: "Close" }).click();
  await p3.waitForSelector(".sidebar-setup", { state: "detached" });
  check(true, "everything set up: Finish setting up goes away");
  await p3.context().close();

  const p4 = await freshPage({ fallbacks: { claude: true, codex: "off" } });
  check(!(await opened(p4)), "everything set up on a fresh install: it doesn't open");
  check((await p4.locator(".sidebar-setup").count()) === 0, "and there is nothing to finish");
  await p4.context().close();

  // The same partly set-up welcome on paper.
  await post("/pool/keys/google", {}, "DELETE");
  const p5 = await freshPage(undefined, "light");
  check(await opened(p5), "light theme, partly set up: it opens");
  await p5.getByRole("button", { name: "Get started" }).click();
  await p5.waitForSelector(`${welcome} .setup-sites .setup-site`);
  await shot(p5, "welcome-partly-models-light");
  await p5.locator(welcome).getByRole("button", { name: "Close" }).click();
  await shot(p5, "sidebar-finish-light");
  await p5.context().close();

  check(!errors.length, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  log("all good");
} finally {
  await browser.close();
  await ui.close();
  await mock.close();
}
process.exit(0);
