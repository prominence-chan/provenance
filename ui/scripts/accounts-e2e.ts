// Headless check of the account-setup additions, end to end in the page, against the mock router
// (scripts/mock-router.ts) and a stand-in `claude` (scripts/fixtures/fake-claude.mjs). Nothing
// real is called, no real credential or key is used (only obviously fake ones), and nothing opens
// on screen.
//
//   npm run build && npm run e2e:accounts      # SHOTS=dir for the screenshots
//
// Covers:
//   1. saved sign-in: the opt-in can't be saved without the agreement; the password never shows
//      up in the page's React state (while typed or after), the DOM, localStorage, the console,
//      any URL, the UI server's output, or the router's request log beyond the one PUT body;
//      Try now (signed back in / needs you / wrong password), Turn off and on, Forget; a site
//      that can't (Gemini) says why once
//   2. a paid ChatGPT plan: after its sign-in, a blocking confirmation instead of "ready"; it
//      isn't "set up" for the welcome until confirmed; Use a different account (signs in to the
//      slot again) and Use it anyway (confirms); the plan as a label (Free, Plus)
//   3. the token pool: instructions from /pool/help in its order (the next one open, set-up ones
//      collapsed), the keys page link, the soft key check, an extra field; the assistant note
//      (leads to Fallbacks without one); the assistant's thread: a brief without any key, read
//      only in an empty scratch folder, a key card from the marker, a key saved through
//      /pool/keys and never in the thread, the outcome sent by itself, Skip, and a key pasted
//      into the composer caught and saved instead
//      /pool/help as provenance-core serves it: badges for the free tier, the ones not worth it
//      last and folded with why, a note where the steps' button names may differ, what happens to
//      prompts before the steps; signed in to Gemini without a Google key: the prompt (welcome
//      and keys page) and "Open in your signed-in Gemini window" (POST /web/open, closed through
//      the cancel path), in the key card too
//   4. a router without /web/open (the button hidden) and one without any of the new endpoints:
//      all of it hidden, no errors
// Screenshots in dark and light, at the dialog's size and at 390 px.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { startUiServer } from "../server/app.ts";
import { findChromium } from "./chromium.ts";
import { dialog, kit, layoutProblems, welcomeDialog } from "./e2e-kit.ts";
import { startMockRouter } from "./mock-router.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const { log, shot, check, shots } = kit(
  "accounts-e2e",
  process.env.SHOTS ?? path.join(tmpdir(), "provenance-accounts-e2e"),
);

// Obviously fake values, made up for this check.
const PASSWORD = "FAKE-pw-for-tests-only-7Qx2";
const GROQ_KEY = `gsk_${"FAKEtestKEY0".repeat(4)}0123`; // gsk_ + 52
const GOOGLE_KEY = `AIza${"FAKEtestKEY".repeat(3)}xy`; // AIza + 35
const SECRETS = [PASSWORD, GROQ_KEY, GOOGLE_KEY];

// Everything this process prints (the UI server runs in it): checked for secrets at the end.
const printed: string[] = [];
for (const k of ["log", "warn", "error", "info"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    printed.push(a.map(String).join(" "));
    orig(...a);
  };
}

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "provenance-accounts-e2e-")));
const bin = path.join(scratch, "bin");
const dataDir = path.join(scratch, "data");
const work = path.join(scratch, "work");
for (const d of [bin, dataDir, work]) mkdirSync(d, { recursive: true });
symlinkSync(path.join(here, "fixtures/fake-claude.mjs"), path.join(bin, "claude"));
const cliLog = path.join(scratch, "cli.jsonl");
const replyFile = path.join(scratch, "reply.txt");
process.env.FAKE_CLI_LOG = cliLog;
process.env.FAKE_REPLY_FILE = replyFile;
const runs = () =>
  existsSync(cliLog)
    ? readFileSync(cliLog, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { cli: string; argv: string[]; stdin: string; cwd: string })
        .filter((r) => r.cli === "claude" && r.stdin !== undefined)
    : [];
const nodeDir = path.dirname(process.execPath);

const mock = await startMockRouter(0);
const ui = await startUiServer({
  root,
  prod: true,
  port: 0,
  host: "127.0.0.1",
  bin: path.join(here, "fixtures/fake-provenance.mjs"),
  router: { url: mock.url },
  cwd: () => ({ defaultCwd: work, fromLauncher: true }),
  dataDir,
  fallbackSearchPath: `${bin}:${nodeDir}:/usr/bin:/bin`,
  codexLoginHome: path.join(scratch, "no-codex"),
});
log(`mock router ${mock.url}, UI ${ui.url}, screenshots in ${shots}`);

const post = (route: string, body: unknown = {}, method = "POST") =>
  fetch(`${mock.url}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
type MockState = {
  autologin: Record<string, Record<string, { saved: boolean; enabled: boolean; username: string }>>;
  plans: Record<string, Record<string, { needs_confirmation: string | null }>>;
  keys: Record<string, boolean>;
  accounts: Record<string, Record<string, { login: { state: string } }>>;
};
const mockState = async () => (await fetch(`${mock.url}/mock/state`)).json() as Promise<MockState>;
const mockRequests = async () =>
  (await fetch(`${mock.url}/mock/requests`)).json() as Promise<
    { method: string; url: string; body: string }[]
  >;

async function layoutOk(page: Page, where: string): Promise<void> {
  const bad = await layoutProblems(page);
  check(!bad.length, `layout at ${where}${bad.length ? ` (${bad.join("; ")})` : ""}`);
}

/** Every string React holds for the page (props and hook state of every component). */
async function reactStrings(page: Page): Promise<string> {
  return page.evaluate(() => {
    const rootEl = document.getElementById("root") as unknown as Record<string, unknown>;
    const key = Object.keys(rootEl).find((k) => k.startsWith("__reactContainer$"));
    if (!key) return "(no react root)";
    const out: string[] = [];
    const seen = new WeakSet<object>();
    const collect = (v: unknown, depth: number) => {
      if (typeof v === "string") return void out.push(v);
      if (!v || typeof v !== "object" || depth > 7 || seen.has(v)) return;
      if (v instanceof Node || "stateNode" in v) return; // DOM nodes and fibers: walked apart
      seen.add(v);
      for (const x of Array.isArray(v) ? v : Object.values(v)) collect(x, depth + 1);
    };
    const stack = [rootEl[key] as Record<string, unknown>];
    let n = 0;
    while (stack.length && n++ < 200_000) {
      const f = stack.pop()!;
      collect(f.memoizedProps, 0);
      let h = f.memoizedState as Record<string, unknown> | null;
      for (let i = 0; h && typeof h === "object" && i < 200; i++) {
        collect(h.memoizedState ?? h, 0);
        h = (h.next as Record<string, unknown>) ?? null;
      }
      if (f.child) stack.push(f.child as Record<string, unknown>);
      if (f.sibling) stack.push(f.sibling as Record<string, unknown>);
    }
    return out.join("\n");
  });
}

/** Where a secret must not be: React state, the DOM and its fields, storage. */
async function pageHolds(page: Page, secret: string, inFields = true): Promise<string[]> {
  const where: string[] = [];
  if ((await reactStrings(page)).includes(secret)) where.push("React state");
  if ((await page.content()).includes(secret)) where.push("DOM");
  const store = await page.evaluate(() => {
    const all: string[] = [];
    for (const s of [localStorage, sessionStorage])
      for (let i = 0; i < s.length; i++) all.push(`${s.key(i)}=${s.getItem(s.key(i)!)}`);
    return all.join("\n");
  });
  if (store.includes(secret)) where.push("storage");
  if (inFields) {
    const fields = await page.evaluate(() =>
      [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value),
    );
    if (fields.some((v) => v.includes(secret))) where.push("a field");
  }
  return where;
}

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const consoleLines: string[] = [];
const urls: string[] = [];
const errors: string[] = [];
async function newPage(
  opts: { width?: number; theme?: "light"; fallbacks?: boolean } = {},
): Promise<Page> {
  const c = await browser.newContext({
    viewport: { width: opts.width ?? 1280, height: 820 },
  });
  c.setDefaultTimeout(20_000);
  await c.addInitScript(
    ([theme, fb]) => {
      localStorage.setItem("provenance-ui.welcome-done", "1");
      if (theme) localStorage.setItem("provenance-ui.theme", theme);
      if (fb && !localStorage.getItem("provenance-ui.settings"))
        localStorage.setItem(
          "provenance-ui.settings",
          JSON.stringify({ fallbacks: { claude: true, codex: "off" } }),
        );
    },
    [opts.theme ?? "", opts.fallbacks !== false] as const,
  );
  const p = await c.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => consoleLines.push(m.text()));
  p.on("request", (r) => urls.push(r.url()));
  await p.goto(ui.url);
  await p.waitForSelector(".composer textarea");
  return p;
}
const openSetup = async (p: Page) => {
  await p.click('button[title="Models & accounts"]');
  await p.waitForSelector(`${dialog} .setup-sites`);
};
const pickSite = async (p: Page, id: string) => {
  await p.click(`${dialog} .setup-site[data-provider="${id}"]`);
  await p.waitForSelector(`${dialog} .setup-accounts`);
};
const row = (p: Page, id: string) =>
  p.locator(`${dialog} .setup-accounts li[data-account="${id}"]`);
async function themed(p: Page, name: string, light: boolean) {
  await p.evaluate((l) => {
    if (l) document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
  }, light);
  await p.waitForTimeout(350);
  await shot(p, `${name}-${light ? "light" : "dark"}`);
}
/** Dark and light at the dialog's size, then dark at 390 px. */
async function allViews(p: Page, name: string) {
  await layoutOk(p, name);
  await themed(p, name, false);
  await themed(p, name, true);
  await p.evaluate(() => delete document.documentElement.dataset.theme);
  await p.setViewportSize({ width: 390, height: 760 });
  await p.waitForTimeout(250);
  await layoutOk(p, `${name} at 390 px`);
  await shot(p, `${name}-390`);
  await p.setViewportSize({ width: 1280, height: 820 });
}

/** Wait for the assistant's next turn to have run and finished. */
async function turnDone(p: Page, before: number): Promise<void> {
  for (let i = 0; i < 80 && runs().length <= before; i++) await p.waitForTimeout(250);
  await p.waitForFunction(() => !document.querySelector(".composer .send-btn.stop"), null, {
    timeout: 20_000,
  });
  await p.waitForTimeout(300);
}

let page: Page | null = null;
try {
  // ---- 1. saved sign-in ---------------------------------------------------------------------
  log("saved sign-in");
  await post("/mock/reset", { scenario: "signed" });
  await post("/mock/requests");
  page = await newPage();
  await openSetup(page);
  await pickSite(page, "chatgpt-web");
  check((await row(page, "main").locator(".setup-plan").innerText()) === "Free", "main reads Free");
  check((await row(page, "b").locator(".setup-plan").innerText()) === "Plus", "B reads Plus");
  await row(page, "main").getByRole("button", { name: "Keep signed in…" }).click();
  const form = row(page, "main").locator(".autologin-form");
  await form.waitFor();
  const terms = await form.innerText();
  check(
    /signs this account out, Provenance signs it back in by itself/.test(terms) &&
      /keychain/.test(terms) &&
      /never in Provenance's files/.test(terms) &&
      /nowhere but chatgpt\.com's own sign-in page/.test(terms) &&
      /code, a captcha or anything unusual/.test(terms),
    "the opt-in says what it does, where the password is kept and what it won't do",
  );
  const user = form.locator('input[autocomplete="username"]');
  const pw = form.locator('input[type="password"][autocomplete="current-password"]');
  check(
    (await user.inputValue()) === "ada@example.com",
    "username prefilled with the account's e-mail",
  );
  await pw.fill(PASSWORD);
  const save = form.getByRole("button", { name: "Save" });
  check(await save.isDisabled(), "Save stays off until the agreement is ticked");
  check(
    !(await form.locator('input[type="checkbox"]').isChecked()),
    "the agreement isn't preselected",
  );
  await form
    .locator('button[type="submit"]')
    .click({ force: true })
    .catch(() => {});
  await page.waitForTimeout(300);
  check(
    !(await mockRequests()).some((r) => r.method === "PUT" && r.url.includes("/autologin")),
    "nothing is sent without the agreement",
  );
  check(
    !(await reactStrings(page)).includes(PASSWORD),
    "while typed, the password is in its field only, not in React state",
  );
  await allViews(page, "autologin-optin");
  await form.locator('input[type="checkbox"]').check();
  check(await save.isEnabled(), "ticked: Save is on");
  await save.click();
  await row(page, "main").locator(".autologin").waitFor();
  const saved = await row(page, "main").locator(".autologin").innerText();
  check(
    /Saved sign-in for ada@example\.com/.test(saved),
    `the row says so (${saved.replace(/\n/g, " · ")})`,
  );
  check(
    ["Try now", "Turn off", "Forget"].every((b) => saved.includes(b)),
    "with Try now, Turn off and Forget",
  );
  const st1 = await mockState();
  check(
    st1.autologin["chatgpt-web"].main.saved &&
      st1.autologin["chatgpt-web"].main.username === "ada@example.com",
    "saved on the router",
  );
  const holds = await pageHolds(page, PASSWORD);
  check(
    !holds.length,
    `after saving, the password is nowhere in the page${holds.length ? ` (${holds})` : ""}`,
  );
  const reqs = await mockRequests();
  const withPw = reqs.filter((r) => r.body.includes(PASSWORD) || r.url.includes(PASSWORD));
  check(
    withPw.length === 1 &&
      withPw[0].method === "PUT" &&
      withPw[0].url === "/web/accounts/chatgpt-web/main/autologin" &&
      !withPw[0].url.includes(PASSWORD),
    "the router got it once, in the one PUT body",
  );
  check(JSON.parse(withPw[0].body).agree === true, "with the agreement in the same body");
  await allViews(page, "autologin-saved");

  await post("/mock/autologin", { result: "ok" });
  await row(page, "main").getByRole("button", { name: "Try now" }).click();
  await page.waitForFunction(() =>
    /Signed back in at/.test(
      document.querySelector('li[data-account="main"] .autologin')?.textContent ?? "",
    ),
  );
  check(true, "Try now: Signed back in at <time>");
  await post("/mock/autologin", { result: "needs_person", detail: "the site asked for a code" });
  await row(page, "main").getByRole("button", { name: "Try now" }).click();
  await page.waitForFunction(() =>
    /Needs you: the site asked for a code/.test(
      document.querySelector('li[data-account="main"] .autologin')?.textContent ?? "",
    ),
  );
  check(
    /2 attempts today/.test(await row(page, "main").locator(".autologin").innerText()),
    "needs you: the site asked for a code · 2 attempts today",
  );
  await row(page, "main").getByRole("button", { name: "Turn off" }).click();
  await page.waitForFunction(() =>
    /Turn on/.test(document.querySelector('li[data-account="main"] .autologin')?.textContent ?? ""),
  );
  check(!(await mockState()).autologin["chatgpt-web"].main.enabled, "Turn off: off on the router");
  await row(page, "main").getByRole("button", { name: "Turn on" }).click();
  await row(page, "main").getByRole("button", { name: "Try now" }).waitFor();
  check((await mockState()).autologin["chatgpt-web"].main.enabled, "Turn on: on again");
  await post("/mock/autologin", { result: "wrong_password" });
  await row(page, "main").getByRole("button", { name: "Try now" }).click();
  await page.waitForFunction(() =>
    /Wrong password: saved sign-in switched off until you update it/.test(
      document.querySelector('li[data-account="main"] .autologin')?.textContent ?? "",
    ),
  );
  check(
    await row(page, "main").getByRole("button", { name: "Update" }).isVisible(),
    "wrong password: switched off, with Update",
  );
  await shot(page, "autologin-wrong-password");
  await row(page, "main").getByRole("button", { name: "Forget" }).click();
  await row(page, "main").locator(".autologin").getByRole("button", { name: "Forget" }).click();
  await row(page, "main").getByRole("button", { name: "Keep signed in…" }).waitFor();
  check(!(await mockState()).autologin["chatgpt-web"]?.main, "Forget: gone from the router");

  await page.getByRole("button", { name: "Back" }).click();
  await pickSite(page, "gemini-web");
  const reasons = page.locator(`${dialog} .autologin-unsupported`);
  check(
    (await reasons.count()) === 1 &&
      /Google accounts can't be signed back in/.test(await reasons.innerText()),
    "Gemini (Google accounts) says why, once, under its accounts",
  );
  check((await page.locator(`${dialog} .autologin-offer`).count()) === 0, "and offers nothing");
  await page.getByRole("button", { name: "Close" }).click();

  // ---- 2. a paid ChatGPT plan -----------------------------------------------------------------
  log("paid plan");
  await post("/mock/reset", { scenario: "fresh" });
  await post("/pool/keys/google", { values: { GEMINI_API_KEY: "FAKE-key-for-tests" } }, "PUT");
  await page.reload();
  await page.waitForSelector(".composer textarea");
  await openSetup(page);
  await pickSite(page, "chatgpt-web");
  await row(page, "main").getByRole("button", { name: "Sign in" }).click();
  await page.waitForSelector(`${dialog} [data-login="open"]`);
  await post("/mock/finish", {
    provider: "chatgpt-web",
    account: "main",
    ok: true,
    plan: "paid",
    plan_label: "plus",
  });
  await page.waitForSelector(`${dialog} [data-paid-plan]`, { timeout: 10_000 });
  const paid = await page.locator(`${dialog} .setup-body`).innerText();
  check(
    /This account is on ChatGPT Plus/.test(paid) &&
      /still spends that account's own usage, likely faster than Codex would/.test(paid),
    "after its sign-in: the paid-plan confirmation, not 'ready'",
  );
  check(!/is ready/.test(paid), "no 'ChatGPT is ready'");
  check(
    (await page.locator(`${dialog} .autologin-form, ${dialog} .keep-offer`).count()) === 0,
    "nothing else offered meanwhile",
  );
  await allViews(page, "paid-plan-confirm");
  await page.getByRole("button", { name: "Use a different account" }).click();
  await page.waitForSelector(`${dialog} [data-login="open"]`);
  check(
    /Sign out of the account that's there/.test(
      await page.locator(`${dialog} .setup-text`).innerText(),
    ),
    "Use a different account: signs in to this slot again, saying to sign out first",
  );
  check(
    (await mockState()).accounts["chatgpt-web"].main.login.state === "open",
    "the router opened the sign-in window again",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForSelector(`${dialog} .setup-accounts`);
  const prow = row(page, "main");
  check(
    await prow.locator(".paid-confirm").isVisible(),
    "on the account row: still waiting for the choice",
  );
  check(/Connected, not in use/.test(await prow.innerText()), "connected, not in use");
  await shot(page, "paid-plan-row");
  await page.getByRole("button", { name: "Back" }).click();
  check(
    (await page
      .locator(`${dialog} .setup-site[data-provider="chatgpt-web"] .setup-status`)
      .innerText()) === "Needs your OK",
    "the site list says it needs your OK",
  );
  await page.getByRole("button", { name: "Close" }).click();
  await page.locator(".sidebar-setup").waitFor();
  await page.click(".sidebar-setup");
  await page.waitForSelector(`${welcomeDialog} .setup-sites`);
  check(
    (await page.locator(`${welcomeDialog} .setup-rail li[data-set]`).allTextContents()).every(
      (t) => !t.includes("Models"),
    ),
    "the welcome doesn't count it as set up",
  );
  check(
    /Claude Code can walk you through getting 2 free API keys/.test(
      await page.locator(`${welcomeDialog} .assist-note`).innerText(),
    ) &&
      (await page
        .locator(welcomeDialog)
        .getByRole("button", { name: "Set up with Claude Code" })
        .count()) === 1,
    "the welcome's models step offers the assistant too",
  );
  await layoutOk(page, "welcome models with the assistant note");
  await shot(page, "welcome-models-assist");
  await page.locator(welcomeDialog).getByRole("button", { name: "Close" }).click();
  await openSetup(page);
  await pickSite(page, "chatgpt-web");
  await prow.getByRole("button", { name: "Use it anyway" }).click();
  await prow.locator(".paid-confirm").waitFor({ state: "detached" });
  check(
    (await mockState()).plans["chatgpt-web"].main.needs_confirmation === null,
    "Use it anyway: confirmed on the router",
  );
  check(
    /Signed in/.test(await prow.innerText()) &&
      (await prow.locator(".setup-plan").innerText()) === "Plus",
    "the row: signed in, Plus",
  );
  await page.getByRole("button", { name: "Close" }).click();
  await page.waitForSelector(".sidebar-setup", { state: "detached", timeout: 8000 });
  check(true, "now it counts: nothing left to finish");

  // ---- 3. the token pool: instructions --------------------------------------------------------
  log("token pool instructions");
  await post("/mock/reset", { scenario: "signed" }); // Google's key set; Groq and Cloudflare not
  await openSetup(page);
  await page.click(`${dialog} .setup-pool`);
  await page.waitForSelector(`${dialog} .setup-keys`);
  const order = await page
    .locator(`${dialog} .setup-keys:not(.key-notworth) > li`)
    .evaluateAll((l) => l.map((x) => x.getAttribute("data-pool")));
  check(order.join() === "kilo,google,groq,cloudflare", `the help's order (${order})`);
  check(
    (await page.locator(`${dialog} li[data-pool="mistral"]`).count()) === 0,
    "a provider not worth it isn't in the list",
  );
  const toggle = page.locator(`${dialog} .key-notworth-toggle`);
  check(
    (await toggle.innerText()).includes("Not worth setting up for free (1)") &&
      (await toggle.getAttribute("aria-expanded")) === "false",
    "it's last, folded under Not worth setting up for free",
  );
  check(
    (await page.locator(`${dialog} li[data-pool="kilo"] .key-badge`).innerText()) ===
      "No key needed" &&
      (await page.locator(`${dialog} li[data-pool="google"] .key-badge`).innerText()) === "Free",
    "free tier badges: No key needed, Free",
  );
  const groq = page.locator(`${dialog} .setup-keys li[data-pool="groq"]`);
  check((await groq.getAttribute("data-open")) !== null, "the next one to set up is open");
  check(
    (await page.locator(`${dialog} .setup-keys li[data-open]`).count()) === 1,
    "one provider open at a time; Google (set up) collapsed",
  );
  const g = await groq.innerText();
  check(
    /gpt-oss-120b/.test(g) &&
      /about 3\u00a0min/.test(g) &&
      !/About 3/.test(g) &&
      /You need: A Groq account/.test(g) &&
      /click Create API Key\./.test(g),
    "what you get, what you need, how long, the numbered steps",
  );
  check(
    (await groq.locator(".key-steps strong").first().innerText()) === "API Keys",
    "the site's control names in bold",
  );
  check(
    /button names may differ/.test(await groq.locator(".key-confidence").innerText()),
    "docs-only steps: a quiet note that the button names may differ",
  );
  check(
    (await groq.locator("a.key-open").getAttribute("href")) === "https://console.groq.com/keys" &&
      (await groq.locator("a.key-open").getAttribute("target")) === "_blank",
    "Open console.groq.com opens the keys page outside the app",
  );
  check(/Starts with gsk_/.test(g), "the key format as the field's hint");
  check((await groq.locator(".key-datause").count()) === 0, "Groq: nothing to warn about prompts");
  await groq.locator("input[data-key-field]").fill("sk-this-is-not-groq");
  await groq.locator(".key-misfit").waitFor();
  check(
    /doesn't look like a Groq/.test(await groq.locator(".key-misfit").innerText()),
    "the soft check: this doesn't look like a Groq key",
  );
  check(
    await groq.getByRole("button", { name: "Save" }).isEnabled(),
    "and it doesn't block saving",
  );
  await allViews(page, "keys-instructions");
  await groq.locator("input[data-key-field]").fill(GROQ_KEY);
  check((await groq.locator(".key-misfit").count()) === 0, "a real-looking key: no warning");
  await groq.locator("input[data-key-field]").fill("");
  await page
    .locator(`${dialog} .setup-keys li[data-pool="cloudflare"]`)
    .getByRole("button", { name: "Add key" })
    .click();
  const cf = page.locator(`${dialog} .setup-keys li[data-pool="cloudflare"]`);
  check(
    /Account ID/.test(await cf.innerText()) && /Get Account ID/.test(await cf.innerText()),
    "Cloudflare's extra field, with where to find it",
  );
  check((await groq.getAttribute("data-open")) === null, "opening Cloudflare closed Groq");
  await toggle.click();
  const mistral = page.locator(`${dialog} .key-notworth li[data-pool="mistral"]`);
  check(
    /No free API tier\./.test(await mistral.innerText()) &&
      (await mistral.locator(".key-badge").innerText()) === "No free tier",
    "unfolded: Mistral, with why not",
  );
  await mistral.getByRole("button", { name: "Add key" }).click();
  check(
    (await mistral.locator("input[data-key-field]").count()) === 1,
    "still usable for someone who has a key",
  );
  await shot(page, "keys-not-worth");

  // The assistant note: without a fallback it leads to Fallbacks.
  check(
    /Claude Code can walk you through getting 2 free API keys/.test(
      await page.locator(`${dialog} .assist-note`).innerText(),
    ),
    "the note: Claude Code can walk you through getting 2 free API keys (not the ones not worth it)",
  );
  await page.getByRole("button", { name: "Close" }).click();
  const nofb = await newPage({ fallbacks: false });
  await openSetup(nofb);
  await nofb.click(`${dialog} .setup-pool`);
  await nofb.getByRole("button", { name: "Connect Claude Code or Codex" }).click();
  await nofb.waitForSelector(`${dialog} .fallback-row`);
  check(true, "no fallback ready: the note's button leads to the Fallbacks page");
  await nofb.context().close();

  // ---- 3a. signed in to Gemini, no Google key: the prompt and the signed-in window ----------
  log("gemini prompt and signed-in window");
  await post("/pool/keys/google", {}, "DELETE");
  await page.reload();
  await page.waitForSelector(".composer textarea");
  await page.click(".sidebar-setup");
  await page.waitForSelector(`${welcomeDialog} .setup-sites`);
  const prompt = page.locator(`${welcomeDialog} [data-gemini-prompt]`);
  check(
    /You're signed in to Gemini: get a free Gemini API key with the same Google account/.test(
      await prompt.innerText(),
    ),
    "the welcome's models step: signed in to Gemini, get its free API key",
  );
  await layoutOk(page, "welcome with the Gemini prompt");
  await shot(page, "welcome-gemini-prompt");
  await prompt.getByRole("button", { name: "Get the key" }).click();
  await page.waitForSelector(`${dialog} .setup-keys li[data-pool="google"][data-open]`);
  check(true, "Get the key: the keys page, Google open");
  const google = page.locator(`${dialog} .setup-keys li[data-pool="google"]`);
  check(
    (await page.locator(`${dialog} [data-gemini-prompt]`).count()) === 1,
    "the keys page has the same prompt",
  );
  const dataUse = google.locator(".key-datause");
  check(
    /human reviewers may read/.test(await dataUse.innerText()) &&
      (await google.evaluate((li) => {
        const d = li.querySelector(".key-datause");
        const st = li.querySelector(".key-steps");
        return !!d && !!st && !!(d.compareDocumentPosition(st) & Node.DOCUMENT_POSITION_FOLLOWING);
      })),
    "Google's free tier using prompts for training: up front, before the steps",
  );
  check(
    /Good to know \(2\)/.test(await google.locator(".key-more summary").innerText()),
    "the other notes folded",
  );
  const viaGemini = google.getByRole("button", {
    name: "Open in your signed-in Gemini window (Account B)",
  });
  check(await viaGemini.isVisible(), "Open in your signed-in Gemini window (Account B)");
  check(
    /already signed in for Gemini, so there's no second sign-in/.test(
      await google.locator(".key-signed-note").innerText(),
    ),
    "says it opens with the Google account already signed in",
  );
  await allViews(page, "keys-google-signed-in");
  await viaGemini.click();
  await google.locator(".key-signed-open").waitFor();
  const opened = (await mockState()) as unknown as {
    webOpen: { provider: string; account: string; url: string } | null;
  };
  check(
    opened.webOpen?.provider === "gemini-web" &&
      opened.webOpen.account === "b" &&
      opened.webOpen.url === "https://aistudio.google.com/api-keys",
    "POST /web/open {gemini-web, b, its keys_url}",
  );
  await shot(page, "keys-google-window-open");
  await google.getByRole("button", { name: "Close that window" }).click();
  await google.getByRole("button", { name: /Open in your signed-in Gemini window/ }).waitFor();
  check(
    ((await mockState()) as unknown as { webOpen: unknown }).webOpen === null,
    "Close that window: closed through the cancel path",
  );
  await page.getByRole("button", { name: "Close" }).click();
  await page.waitForSelector(welcomeDialog);
  await page.locator(welcomeDialog).getByRole("button", { name: "Close" }).click();

  // ---- 3b. the assistant's thread -----------------------------------------------------------
  log("assisted setup");
  writeFileSync(
    replyFile,
    "Three providers are left; about 11 minutes. Let's start with Groq: open its keys page and click Create API Key.\n\n[[provenance:pool-key groq]]",
  );
  await openSetup(page);
  await page.click(`${dialog} .setup-pool`);
  await page.getByRole("button", { name: "Set up with Claude Code" }).click();
  await page.waitForSelector(dialog, { state: "detached" });
  await page.waitForSelector('.key-card[data-live][data-key-card="groq"]', { timeout: 20_000 });
  const first = runs().at(-1)!;
  check(
    first.stdin.startsWith("[Provenance token pool setup]"),
    "the thread starts with the brief",
  );
  check(
    /\(card id: groq\)/.test(first.stdin) &&
      /click \*\*Create API Key\*\*/.test(first.stdin) &&
      /Not set up yet, in this order \(3/.test(first.stdin) &&
      /\[\[provenance:pool-key <id>\]\]/.test(first.stdin),
    "the brief: what's left with its steps, and the marker",
  );
  check(
    /Mistral AI \(card id: mistral\): No free API tier\./.test(first.stdin) &&
      /Skip the providers listed as not worth it/.test(first.stdin) &&
      /The router's general notes/.test(first.stdin) &&
      /Never create an account, sign in, accept terms/.test(first.stdin) &&
      /signed-in window for gemini-web \(b\)/.test(first.stdin),
    "and the router's notes, the ones not worth it (to skip), and Google's signed-in window",
  );
  check(
    /Never ask for, accept, repeat or keep a key, token or password in this chat/.test(
      first.stdin,
    ) &&
      /Don't create accounts, accept terms/.test(first.stdin) &&
      /nothing that could read keys or secrets/.test(first.stdin) &&
      /One provider at a time/.test(first.stdin) &&
      /Stop as soon as the person says so/.test(first.stdin) &&
      /sum up/.test(first.stdin),
    "the brief's rules: no keys in chat, no accounts or terms, no reading keys, one at a time, stop, sum up",
  );
  check(
    !SECRETS.some((s) => first.stdin.includes(s)) && !/FAKE-key/.test(first.stdin),
    "the brief holds no key",
  );
  check(
    first.cwd.startsWith(path.join(dataDir, "scratch")) && readdirSync(first.cwd).length === 0,
    `its folder is an empty scratch folder of the app's (${first.cwd})`,
  );
  check(
    first.argv.includes("dontAsk") && !first.argv.includes("acceptEdits"),
    "read only (claude --permission-mode dontAsk)",
  );
  check(
    (await page.locator(".user-message .user-brief summary").first().innerText()) ===
      "Setup brief for the assistant",
    "the brief is folded in the thread",
  );
  check(
    !(await page.locator(".agent-message").last().innerText()).includes("[[provenance"),
    "the marker shows as a card, not as text",
  );
  const card = page.locator('.key-card[data-live][data-key-card="groq"]');
  check(
    (await card.locator("a.key-open").getAttribute("href")) === "https://console.groq.com/keys" &&
      (await card.locator(".key-card-steps summary").innerText()).startsWith("Steps"),
    "the card: its steps and its keys page",
  );
  check(
    /Read only/.test(await page.locator(".composer .assist-perms").innerText()),
    "the composer says read only",
  );
  await allViews(page, "assist-thread-card");
  writeFileSync(
    replyFile,
    "Groq works. Next, Google: you're signed in to Gemini already.\n\n[[provenance:pool-key google]]",
  );
  await card.locator("input[data-key-field]").fill(GROQ_KEY);
  await card.getByRole("button", { name: "Save" }).click();
  await page.waitForSelector('.key-card[data-live][data-key-card="google"]', {
    timeout: 20_000,
  });
  check((await mockState()).keys.GROQ_API_KEY === true, "the key went to /pool/keys");
  const note = runs().at(-1)!;
  check(
    note.stdin === "[Provenance app] Groq key: saved and working.",
    `the outcome sent by itself (${note.stdin})`,
  );
  check(
    /Saved and working/.test(
      await page.locator('.key-card-closed[data-key-card="groq"]').innerText(),
    ),
    "the answered card says how it went",
  );
  check(
    /Groq key saved and working/.test(await page.locator(".assist-sent").first().innerText()),
    "the note shows as a quiet line, sent by Provenance",
  );

  const gcard = page.locator('.key-card[data-live][data-key-card="google"]');
  check(
    /human reviewers may read/.test(await gcard.locator(".key-datause").innerText()) &&
      (await gcard
        .getByRole("button", { name: "Open in your signed-in Gemini window (Account B)" })
        .isVisible()),
    "Google's card: what happens to prompts, and its signed-in Gemini window",
  );
  await allViews(page, "assist-google-card");

  // Skip
  writeFileSync(replyFile, "Fine, skipping Google. Paste nothing here, please.");
  const beforeSkip = runs().length;
  await gcard.getByRole("button", { name: "Skip" }).click();
  await turnDone(page, beforeSkip);
  check(
    runs().some((r) => r.stdin === "[Provenance app] Google Gemini API: skipped by the person."),
    "Skip sends: skipped by the person",
  );

  // A key pasted into the composer.
  writeFileSync(replyFile, "Thanks. Google is set up too.");
  await page.fill(".composer textarea", `here it is ${GOOGLE_KEY} thanks`);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".key-intercept");
  check(
    (await page.locator(".key-intercept select").inputValue()) === "google",
    "a pasted key is caught, and its provider recognised (Google, by its AIza prefix)",
  );
  check(
    (await page.locator(".composer textarea").inputValue()) === "",
    "and taken out of the composer",
  );
  const before = runs().length;
  await allViews(page, "assist-key-caught");
  await page
    .locator(".key-intercept")
    .getByRole("button", { name: /Save to Google Gemini API/ })
    .click();
  await page.waitForSelector(".key-intercept", { state: "detached" });
  await turnDone(page, before);
  check((await mockState()).keys.GEMINI_API_KEY === true, "saved to Google AI Studio instead");
  const red = runs().at(-1)!;
  check(
    /taken out and saved by the app/.test(red.stdin) &&
      /\[key removed by the app\]/.test(red.stdin),
    "the assistant gets a redacted note",
  );
  await page.waitForTimeout(1500);

  // Nowhere in the thread, its files, the CLI's input, or anywhere else.
  check(
    runs().every((r) => !SECRETS.some((s) => r.stdin.includes(s) || r.argv.join(" ").includes(s))),
    "no key or password in anything the CLI was given",
  );
  const threadFiles = readdirSync(path.join(dataDir, "fallback", "threads")).map((f) =>
    readFileSync(path.join(dataDir, "fallback", "threads", f), "utf8"),
  );
  check(
    threadFiles.length > 0 && threadFiles.every((t) => !SECRETS.some((s) => t.includes(s))),
    "no key in the thread's messages (its saved file)",
  );
  const turnText = await page.locator("body").innerText();
  check(!SECRETS.some((s) => turnText.includes(s)), "nor on screen");
  for (const s of [GROQ_KEY, GOOGLE_KEY]) {
    const h = await pageHolds(page, s);
    check(!h.length, `the key …${s.slice(-4)} is nowhere in the page${h.length ? ` (${h})` : ""}`);
  }
  const keyReqs = (await mockRequests()).filter((r) =>
    SECRETS.some((s) => r.body.includes(s) || r.url.includes(s)),
  );
  check(
    keyReqs.map((r) => `${r.method} ${r.url}`).join() ===
      "PUT /web/accounts/chatgpt-web/main/autologin,PUT /pool/keys/groq,PUT /pool/keys/google",
    `the router got each secret only in its one PUT (${keyReqs.map((r) => `${r.method} ${r.url}`).join(", ")})`,
  );

  // ---- 4. a router without the new endpoints ----------------------------------------------
  log("a router without /web/open");
  await post("/mock/reset", { scenario: "signed" });
  await post("/pool/keys/google", {}, "DELETE");
  await post("/mock/older", { older: false, noWebOpen: true });
  await openSetup(page);
  await page.click(`${dialog} .setup-pool`);
  await page.waitForSelector(`${dialog} .setup-keys li[data-pool="google"]`);
  if (
    (await page
      .locator(`${dialog} .setup-keys li[data-pool="google"]`)
      .getAttribute("data-open")) === null
  )
    await page
      .locator(`${dialog} .setup-keys li[data-pool="google"]`)
      .getByRole("button", { name: "Add key" })
      .click();
  await page.waitForSelector(`${dialog} li[data-pool="google"] .key-guide`);
  await page.waitForTimeout(500);
  check(
    (await page.locator(`${dialog} li[data-pool="google"] [data-open-with]`).count()) === 0 &&
      (await page.locator(`${dialog} li[data-pool="google"] a.key-open`).count()) === 1,
    "no signed-in window offered, the ordinary Open page still there",
  );
  await page.getByRole("button", { name: "Close" }).click();
  await post("/mock/older", { older: false, noWebOpen: false });

  log("older router");
  await post("/mock/reset", { scenario: "signed" });
  await post("/mock/older", { older: true });
  await page.reload();
  await page.waitForSelector(".composer textarea");
  await openSetup(page);
  await pickSite(page, "chatgpt-web");
  check(
    (await page
      .locator(
        `${dialog} .setup-plan, ${dialog} .autologin-offer, ${dialog} .autologin, ${dialog} .paid-confirm`,
      )
      .count()) === 0,
    "no plan label, no saved sign-in",
  );
  await page.getByRole("button", { name: "Back" }).click();
  await pickSite(page, "gemini-web");
  check(
    (await page.locator(`${dialog} .autologin-unsupported`).count()) === 0,
    "no reason line either",
  );
  await page.getByRole("button", { name: "Back" }).click();
  await page.click(`${dialog} .setup-pool`);
  await page.waitForSelector(`${dialog} .setup-keys`);
  check(
    (await page
      .locator(
        `${dialog} .assist-note, ${dialog} .key-guide, ${dialog} .setup-keys li[data-open], ${dialog} .key-badge, ${dialog} .key-notworth-toggle, ${dialog} [data-gemini-prompt]`,
      )
      .count()) === 0,
    "the keys page as before: no instructions, no assistant",
  );
  await page
    .locator(`${dialog} .setup-keys li[data-pool="groq"]`)
    .getByRole("button", { name: "Add key" })
    .click();
  check(
    (await page
      .locator(`${dialog} .setup-keys li[data-pool="groq"] input[type="password"]`)
      .count()) === 1,
    "keys still go in",
  );
  await layoutOk(page, "older router keys");
  await shot(page, "older-router-keys");
  await page.getByRole("button", { name: "Close" }).click();
  await page.click(".sidebar-setup").catch(() => {});
  await post("/mock/older", { older: false });

  // ---- nothing leaked anywhere ----------------------------------------------------------------
  check(
    !urls.some((u) => SECRETS.some((s) => u.includes(s) || u.includes(encodeURIComponent(s)))),
    `no secret in any URL the pages asked for (${urls.length} requests)`,
  );
  check(
    !consoleLines.some((l) => SECRETS.some((s) => l.includes(s))),
    "none in the pages' console",
  );
  check(!printed.some((l) => SECRETS.some((s) => l.includes(s))), "none in the UI server's output");
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  log("PASS");
} catch (e) {
  if (page) await page.screenshot({ path: path.join(shots, "failure.png") }).catch(() => {});
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
  rmSync(replyFile, { force: true });
}
process.exit(process.exitCode ?? 0);
