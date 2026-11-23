// Headless check of a conversation moving between backends while staying one thread
// (shared/thread-links.ts, src/store/segments.ts, actions.ts handOver), end to end in the page,
// against the mock router and stand-ins for the provenance binary and claude
// (scripts/fixtures/fake-*.mjs). Nothing real is called and nothing opens on screen.
//
//   npm run build && npm run e2e:carry      # SHOTS=dir for the screenshots
//
// Walks: a tier thread moved to Claude Code by picking it and sending -> the same single sidebar
// entry and title, the earlier turns, one faint line, then the message exactly as typed; the CLI
// got the brief first; the brief is nowhere in the page (DOM, text as copied, the store), the
// fallback's thread file or the link file. A restart of the UI server: the stitched thread comes
// back and the next message resumes the Claude Code session (no brief again). Rename and archive
// act on the one entry. Back to the tiers (a new tier session, the brief as its developer
// instructions), then to Codex through Provenance while a tier turn is running (stopped first,
// never both). A thread carried over the old way (two threads) shows only what the person wrote,
// under "This was continued from another conversation". Light and dark, and phone width.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { startUiServer, type UiServer } from "../server/app.ts";
import { findChromium } from "./chromium.ts";
import { kit } from "./e2e-kit.ts";
import { startMockRouter } from "./mock-router.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const { log, shot, check, shots } = kit(
  "carry-e2e",
  process.env.SHOTS ?? path.join(tmpdir(), "provenance-carry-e2e"),
);

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "provenance-carry-e2e-")));
const bin = path.join(scratch, "bin");
const work = path.join(scratch, "work");
const codexLogin = path.join(scratch, "codex-login");
const dataDir = path.join(scratch, "data");
for (const d of [bin, work, codexLogin]) mkdirSync(d, { recursive: true });
symlinkSync(path.join(here, "fixtures/fake-claude.mjs"), path.join(bin, "claude"));
symlinkSync(path.join(here, "fixtures/fake-codex.mjs"), path.join(bin, "codex"));
const { appendFileSync } = await import("node:fs");
appendFileSync(path.join(codexLogin, "auth.json"), "{}"); // a Codex login to share (never read)
const cliLog = path.join(scratch, "cli.jsonl");
process.env.FAKE_CLI_LOG = cliLog;
process.env.FAKE_WORK = work;
type Run = {
  cli: string;
  argv: string[];
  stdin?: string;
  text?: string;
  method?: string;
  threadId?: string;
  status?: string;
  t?: number;
  developerInstructions?: string | null;
  additionalContext?: Record<string, { value: string }> | null;
};
const runs = () =>
  readFileSync(cliLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Run);
const openai = (r: Run) => r.argv.join(" ").includes('model_provider="openai"');
const nodeDir = path.dirname(process.execPath);

const mock = await startMockRouter(0);
await fetch(`${mock.url}/mock/reset`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scenario: "signed" }),
});
const serve = (port: number) =>
  startUiServer({
    root,
    prod: true,
    port,
    host: "127.0.0.1",
    bin: path.join(here, "fixtures/fake-provenance.mjs"),
    router: { url: mock.url },
    cwd: () => ({ defaultCwd: work, fromLauncher: true }),
    dataDir,
    fallbackSearchPath: `${bin}:${nodeDir}:/usr/bin:/bin`,
    codexLoginHome: codexLogin,
  });
let ui: UiServer = await serve(0);
const port = ui.port; // a restart comes back on the same origin (the page's storage is per origin)
log(`mock router ${mock.url}, UI ${ui.url}, screenshots in ${shots}`);

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
context.setDefaultTimeout(20_000);
await context.addInitScript(() => {
  if (localStorage.getItem("provenance-ui.settings")) return;
  localStorage.setItem(
    "provenance-ui.settings",
    JSON.stringify({ fallbacks: { claude: true, codex: "provenance" }, model: "solstice" }),
  );
  localStorage.setItem("provenance-ui.welcome-done", "1");
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));

const TITLE = /^Refactor the parser into modules$/;
const row = (title: RegExp) =>
  page.locator(".thread-row").filter({ has: page.locator(".thread-title", { hasText: title }) });
const entry = () => row(TITLE);
const titles = () => page.locator(".thread-title").allInnerTexts();
const carryLines = () => page.locator(".conversation .carry-line").allInnerTexts();

/** Close the welcome if it opened (this check is about threads). */
async function noWelcome(p: Page): Promise<void> {
  const w = p.locator(".welcome-dialog[open]");
  if (
    await w.waitFor({ timeout: 2500 }).then(
      () => true,
      () => false,
    )
  ) {
    await w.getByRole("button", { name: "Close" }).click();
    await w.waitFor({ state: "detached" });
  }
}
async function pick(p: Page, row: string, sub?: string): Promise<void> {
  await p.click('button[title="Model tier"]');
  if (sub) {
    await p.hover(`.tier-menu ${row}`);
    await p.click(`.tier-sub ${sub}`);
  } else await p.click(`.tier-menu ${row}`);
}
async function send(p: Page, text: string): Promise<void> {
  await p.fill(".composer textarea", text);
  await p.keyboard.press("Enter");
}
/** Everything the page could leak a brief through: its HTML, its text as copied, its store. */
async function pageHas(p: Page, needle: string): Promise<string[]> {
  return p.evaluate((needle) => {
    const where: string[] = [];
    if (document.documentElement.outerHTML.includes(needle)) where.push("DOM");
    const conv = document.querySelector(".conversation");
    if (conv) {
      const sel = getSelection()!;
      sel.selectAllChildren(conv);
      const copied = sel.toString();
      sel.removeAllRanges();
      if (copied.includes(needle)) where.push("copied text");
    }
    if (document.body.innerText.includes(needle)) where.push("page text");
    const state = (window as unknown as { __provenanceState: () => unknown }).__provenanceState();
    if (JSON.stringify(state).includes(needle)) where.push("store");
    for (let i = 0; i < localStorage.length; i++)
      if (localStorage.getItem(localStorage.key(i)!)?.includes(needle)) where.push("localStorage");
    return where;
  }, needle);
}
const fbThreadFiles = () => {
  const dir = path.join(dataDir, "fallback", "threads");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readFileSync(path.join(dir, f), "utf8"));
};
const linksFile = () => {
  try {
    return readFileSync(path.join(dataDir, "thread-links.json"), "utf8");
  } catch {
    return "";
  }
};
/** The visible order of the conversation: user bubbles, replies and faint lines, as text. */
const transcript = (p: Page) =>
  p.evaluate(() =>
    [
      ...document.querySelectorAll(".conversation :is(.user-bubble, .agent-message, .carry-line)"),
    ].map(
      (e) =>
        `${e.classList.contains("carry-line") ? "LINE" : e.classList.contains("user-bubble") ? "USER" : "AGENT"}: ${(e as HTMLElement).innerText.trim()}`,
    ),
  );

try {
  // ---- 1. a tier thread moved to Claude Code ------------------------------------------------
  log("tier -> Claude Code");
  await page.goto(`${ui.url}/?statecheck`);
  await page.waitForSelector(".composer textarea");
  await noWelcome(page);
  await entry().click();
  await page.waitForSelector('.agent-message:has-text("Looking at the tokenizer again.")');
  const before = (await titles()).length;
  await pick(page, '[data-fallback="claude"]', '[data-source-model="claude:opus"]');
  check(
    (await page.locator(".composer textarea").getAttribute("placeholder")) ===
      "Continue in Claude Code",
    "the composer says the message continues in Claude Code (no new thread)",
  );
  const MSG = "Now split the lexer tests too, keep  the spacing";
  await send(page, MSG);
  await page.waitForSelector('.agent-message:has-text("Done (new session).")', { timeout: 20_000 });
  check(
    (await titles()).length === before && (await entry().count()) === 1,
    "the sidebar keeps the same entries: one for this conversation, none new",
  );
  check(
    (await page.locator(".thread-header-name").innerText()) === "Refactor the parser into modules",
    "the thread stays open, under its own title",
  );
  const t1 = await transcript(page);
  check(
    t1.join("\n") ===
      [
        "USER: Refactor the parser into modules",
        "AGENT: The tests still fail on the tokenizer.",
        "USER: Keep going",
        "AGENT: Split lexer.ts out; the tokenizer test is next.",
        "USER: Fix the tokenizer test",
        "AGENT: Looking at the tokenizer again.",
        "LINE: Continued in Claude Code from the conversation above",
        `USER: ${MSG}`,
        "AGENT: Looking at it.",
        "AGENT: Done (new session).",
      ].join("\n"),
    "the earlier turns, the faint line, then the message exactly as typed, then the reply",
  );
  check(
    await page.evaluate(
      () =>
        document
          .querySelector(".conversation .carry-line")
          ?.nextElementSibling?.classList.contains("user-message") ?? false,
    ),
    "the line sits right over the person's message",
  );
  check(
    (await page
      .locator(
        ".conversation :is(.user-message details, .user-brief, .carry-line *, .carry-line[title], .carry-line[tabindex])",
      )
      .count()) === 0,
    "nothing in the line or the message opens, hovers or links to more",
  );
  const claude1 = runs()
    .filter((x) => x.cli === "claude")
    .at(-1)!;
  check(
    /^\[Hand-over: [^\n]*"Refactor the parser into modules"/.test(claude1.stdin ?? "") &&
      (claude1.stdin ?? "").includes("Looking at the tokenizer again.") &&
      (claude1.stdin ?? "").endsWith(`\n\n${MSG}`) &&
      !claude1.argv.includes("--resume"),
    "Claude Code got the brief, then the message, in a new session",
  );
  const brief = (claude1.stdin ?? "").slice(0, -(MSG.length + 2));
  check(/The goal \(the first request\)/.test(brief), "the brief carries the goal");
  check(
    /The latest request, verbatim:\nFix the tokenizer test/.test(brief),
    "and the latest request verbatim",
  );
  check(/Files changed so far: src\/parser\.ts/.test(brief), "and the files touched");
  check(brief.length < 16_500, `within its bound (${brief.length} characters)`);
  const MARK = "[Hand-over:";
  const goalLine = "The goal (the first request)";
  check(
    !(await pageHas(page, MARK)).length && !(await pageHas(page, goalLine)).length,
    `the brief is nowhere in the page: DOM, copied text, store, storage (${await pageHas(page, MARK)})`,
  );
  check(
    fbThreadFiles().every((f) => !f.includes(MARK) && !f.includes(goalLine)) &&
      fbThreadFiles().some((f) => f.includes(JSON.stringify(MSG))),
    "nor in Claude Code's thread file, whose user message is what was typed",
  );
  const links = JSON.parse(linksFile()) as {
    links: Record<string, { backend: string; threadId: string }[]>;
  };
  check(
    links.links["thr-strained"]?.map((x) => x.backend).join(",") === "main,fallback" &&
      !linksFile().includes(MARK),
    "the link file holds the conversation's two sessions (ids only)",
  );
  await shot(page, "moved-to-claude-dark");
  await page.evaluate(() => localStorage.setItem("provenance-ui.theme", "light"));
  await page.reload();
  await entry().click();
  await page.waitForSelector('.agent-message:has-text("Done (new session).")');
  await shot(page, "moved-to-claude-light");
  await page.setViewportSize({ width: 420, height: 800 });
  await page.waitForTimeout(300);
  await page.locator(".conversation .carry-line").scrollIntoViewIfNeeded();
  await shot(page, "moved-to-claude-phone-light");
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.evaluate(() => localStorage.removeItem("provenance-ui.theme"));

  // ---- 2. a restart ----------------------------------------------------------------------------
  log("restart");
  await ui.close();
  ui = await serve(port);
  await page.reload();
  await page.waitForSelector(".composer textarea");
  await entry().waitFor();
  check((await entry().count()) === 1, "after a restart: still one entry");
  check(
    !(await titles()).some((t) => t.startsWith("Now split the lexer")),
    "and Claude Code's session is not listed on its own",
  );
  await entry().click();
  await page.waitForSelector('.agent-message:has-text("Done (new session).")');
  check(
    (await transcript(page)).join("\n") === t1.join("\n"),
    "the stitched thread comes back as it was",
  );
  check(
    /Claude Code\s*· Opus/.test(await page.locator(".tier-picker-btn").innerText()),
    "with the picker on what serves it now",
  );
  await send(page, "And the parser docs");
  await page.waitForSelector('.agent-message:has-text("Done (resumed session).")');
  const claude2 = runs()
    .filter((x) => x.cli === "claude")
    .at(-1)!;
  check(
    claude2.stdin === "And the parser docs" && claude2.argv.includes("--resume"),
    "the next message resumes the Claude Code session, no brief again",
  );
  check((await carryLines()).length === 1, "still one faint line");

  // ---- 3. rename -------------------------------------------------------------------------------
  log("rename");
  await page.evaluate(() =>
    (
      window as unknown as { __provenanceRename: (id: string, n: string) => Promise<void> }
    ).__provenanceRename("thr-strained", "Parser split"),
  );
  await page.locator(".thread-title", { hasText: /^Parser split$/ }).waitFor();
  check(
    (await titles()).filter((t) => /Parser split|Refactor the parser/.test(t)).length === 1 &&
      (await page.locator(".thread-header-name").innerText()) === "Parser split",
    "renamed: the one entry and the header",
  );
  const NEW_TITLE = /^Parser split$/;
  const entry2 = () => row(NEW_TITLE);

  // ---- 4. back to the tiers --------------------------------------------------------------------
  log("Claude Code -> tier");
  await pick(page, '[data-model="solstice"]');
  check(
    (await page.locator(".composer textarea").getAttribute("placeholder")) ===
      "Continue in solstice",
    "back on a tier: the composer says so",
  );
  await send(page, "Back on the tiers now");
  await page.waitForSelector('.agent-message:has-text("ok from tierlm on solstice")');
  const tierStart = runs()
    .filter((x) => x.method === "thread/start" && !openai(x))
    .at(-1)!;
  const tierTurn = runs()
    .filter((x) => x.method === "turn/start" && !openai(x))
    .at(-1)!;
  check(
    (tierStart.developerInstructions ?? "").startsWith("[Hand-over:") &&
      (tierStart.developerInstructions ?? "").includes("Done (resumed session).") &&
      (tierStart.developerInstructions ?? "").includes("Claude Code"),
    "a new tier session, its instructions a brief that includes Claude Code's work",
  );
  check(
    tierTurn.text === "Back on the tiers now" &&
      !tierTurn.additionalContext &&
      tierTurn.threadId !== "thr-strained",
    "its first message exactly as typed (the brief isn't in it)",
  );
  check(
    (await carryLines()).join("|") ===
      "Continued in Claude Code from the conversation above|Continued on solstice from the conversation above",
    "a second faint line where it came back",
  );
  check((await entry2().count()) === 1 && (await titles()).length === before, "one entry still");
  check(!(await pageHas(page, MARK)).length, "and no brief in the page");

  // ---- 5. to Codex through Provenance, while a tier turn runs ----------------------------------
  log("tier -> Codex, mid-turn");
  await send(page, "Run the long check [slow]");
  await page.waitForSelector(".composer .send-btn.stop");
  await pick(page, '[data-fallback="codex"]', '[data-source-model="codex-pv:"]');
  await page.fill(".composer textarea", "Never mind, do it in Codex");
  check(
    (await page.locator(".composer .send-btn:not(.stop)").getAttribute("title")) ===
      "Stop, then continue in Codex (Enter)",
    "while it runs, a message for Codex reads stop-then-continue",
  );
  await shot(page, "mid-turn-switch-ready");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.agent-message:has-text("ok from openai")', { timeout: 30_000 });
  const all = runs();
  const slow = all.find(
    (x) => x.method === "turn/start" && x.text === "Run the long check [slow]",
  )!;
  const ended = all.find(
    (x) => x.method === "turn/ended" && x.threadId === slow.threadId && x.status === "interrupted",
  );
  const codexTurn = all.filter((x) => x.method === "turn/start" && openai(x)).at(-1)!;
  const codexStart = all.filter((x) => x.method === "thread/start" && openai(x)).at(-1)!;
  check(!!ended, "the running tier turn was stopped");
  check(
    !!ended && (codexTurn.t ?? 0) >= (ended.t ?? Infinity),
    "before Codex started: never both at once",
  );
  check(
    (codexStart.developerInstructions ?? "").includes("stopped before it finished") &&
      (codexStart.developerInstructions ?? "").includes("Run the long check [slow]"),
    "Codex's brief says the last turn was stopped, and what it was",
  );
  check(codexTurn.text === "Never mind, do it in Codex", "its message exactly as typed");
  check(
    (await page.locator(".turn-note", { hasText: "Interrupted" }).count()) === 1,
    "the stopped turn reads Interrupted",
  );
  check(
    (await carryLines()).join("|") ===
      "Continued in Claude Code from the conversation above|Continued on solstice from the conversation above|Continued in Codex from the conversation above",
    "and a third faint line where Codex took over",
  );
  check((await entry2().count()) === 1 && (await titles()).length === before, "one entry still");
  check(!(await pageHas(page, MARK)).length, "and no brief in the page");
  await shot(page, "moved-three-times-dark");

  // ---- 6. archive ---------------------------------------------------------------------------------
  log("archive");
  const fbId = links.links["thr-strained"][1].threadId;
  await entry2().hover();
  await entry2().getByRole("button", { name: "Archive thread" }).click();
  await entry2().waitFor({ state: "detached" });
  check((await titles()).length === before - 1, "archived: the one entry goes");
  for (let i = 0; i < 50 && linksFile().includes("thr-strained"); i++)
    await page.waitForTimeout(100);
  check(!linksFile().includes("thr-strained"), "every session archived, the link forgotten");
  check(
    JSON.parse(readFileSync(path.join(dataDir, "fallback", "threads", `${fbId}.json`), "utf8"))
      .archived === true,
    "Claude Code's session is archived too",
  );
  await page.reload();
  await page.waitForSelector(".composer textarea");
  await page.waitForTimeout(1500);
  check(
    (await titles()).length === before - 1 &&
      !(await titles()).some((t) => /Now split|Back on the tiers|Never mind/.test(t)),
    "after a reload nothing of it comes back as its own thread",
  );

  // ---- 7. a thread carried over the old way ---------------------------------------------------
  log("carried over the old way");
  await page.getByRole("button", { name: "New thread", exact: true }).first().click();
  await pick(page, '[data-fallback="claude"]', '[data-source-model="claude:opus"]');
  const OLD =
    '[Continued from the Provenance thread "Old work" in /tmp, which ran on other models. This is where it stands.]\n\n' +
    "What the user asked, in order:\n1. Old work\n\nCheck the files' current state before relying on this summary.\n\nContinue the task from where it stands.";
  await send(page, OLD);
  await page.waitForSelector('.agent-message:has-text("Done (new session).")');
  check(
    (await transcript(page)).slice(0, 2).join("|") ===
      "LINE: This was continued from another conversation|USER: Continue the task from where it stands.",
    "its first message: the faint line, then only what the person wrote",
  );
  check(
    !(await pageHas(page, "What the user asked, in order")).filter((w) => w !== "store").length &&
      (await page.locator(".conversation :is(.user-message details, .user-brief)").count()) === 0,
    "its brief shows nowhere, and nothing opens to show it",
  );
  check(
    (await titles()).includes("Old work (continued)") &&
      (await page.locator(".thread-header-name").innerText()) === "Old work (continued)",
    "and without a name its title is the other's, continued (not the brief's first line)",
  );
  await shot(page, "old-way-dark");

  check(!errors.length, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  log("all good");
} finally {
  await browser.close();
  await ui.close();
  await mock.close();
}
process.exit(0);
