// Headless check for:
// 1. Subagent UI support (`collabAgentToolCall` + `subAgentActivity` render cleanly without raw
//    "collabAgentToolCall" fallback, active subagents stay expanded while finished subagents
//    collapse to avoid overflow, clicking into any subagent opens inline detail + live turns
//    without leaving the main conversation, and "Full view" still opens child threads).
// 2. Hyperexperimental orchestrator gating (enabled on web chat models, disabled on API pool).
// 3. Bottom-left usage meter (tier remaining %, pinned source %, and weekly remaining % on
//    fallback, keeping `.conn .dot-ok` intact).
// 4. Antigravity fallback integration (health, switch, model picker, color ramp, weekly bar).
// 5. No duplicate "Auto" rows in TierPicker even when a source has id "auto".

import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

if (process.argv[2] === "app-server") await fakeAppServer();
else await check();

async function fakeAppServer(): Promise<void> {
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const now = Math.floor(Date.now() / 1000);
  const cwd = "/Users/dev/projects/api-gateway";
  const baseThread = (
    id: string,
    name: string,
    extra: Partial<{
      parentThreadId: string | null;
      agentNickname: string | null;
      agentRole: string | null;
      status: { type: string };
    }> = {},
  ) => ({
    id,
    environments: null,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    attachedToThreadId: null,
    parentThreadId: extra.parentThreadId ?? null,
    preview: name,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "full",
    modelProvider: "tierlm",
    model: "solstice",
    reasoningEffort: null,
    createdAt: now - 100,
    updatedAt: now - 10,
    recencyAt: null,
    status: extra.status ?? { type: "idle" },
    path: null,
    cwd,
    cliVersion: "0.171.0",
    originator: "provenance",
    source: "appServer",
    canAcceptDirectInput: null,
    threadSource: null,
    agentNickname: extra.agentNickname ?? null,
    agentRole: extra.agentRole ?? null,
    gitInfo: null,
    name,
    daybreakEnabled: null,
    daybreakProgramPropagationEnrolled: null,
    turns: [],
  });

  const threads = [
    baseThread("thr-parent", "Audit auth and retry modules"),
    baseThread("thr-sub-1", "Inspect src/auth/session.ts", {
      parentThreadId: "thr-parent",
      agentNickname: "Auth Auditor",
      agentRole: "research",
      status: { type: "idle" },
    }),
    baseThread("thr-sub-2", "Run webhook retry tests", {
      parentThreadId: "thr-parent",
      agentNickname: "Retry Verifier",
      agentRole: "worker",
      status: { type: "active" },
    }),
    baseThread("thr-sub-3", "Check rate limit headers", {
      parentThreadId: "thr-parent",
      agentNickname: "Header Scanner",
      agentRole: "research",
      status: { type: "idle" },
    }),
    baseThread("thr-sub-4", "Review TLS cert rotation", {
      parentThreadId: "thr-parent",
      agentNickname: "TLS Checker",
      agentRole: "research",
      status: { type: "idle" },
    }),
    baseThread("thr-sub-5", "Audit webhook signature HMAC", {
      parentThreadId: "thr-parent",
      agentNickname: "Crypto Reviewer",
      agentRole: "research",
      status: { type: "idle" },
    }),
  ];

  const parentTurns = [
    {
      id: "turn-p1",
      rootTurnId: null,
      status: "completed",
      error: null,
      startedAt: now - 40,
      completedAt: now - 10,
      durationMs: 28000,
      itemsView: "full",
      items: [
        {
          id: "u1",
          type: "userMessage",
          clientId: null,
          content: [
            { type: "text", text: "Audit auth and retry modules in parallel", text_elements: [] },
          ],
        },
        {
          id: "ca1",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "thr-parent",
          receiverThreadIds: ["thr-sub-1"],
          prompt: "Inspect src/auth/session.ts for concurrent token refresh races.",
          model: "solstice",
          reasoningEffort: "medium",
          agentsStates: {
            "thr-sub-1": {
              status: "completed",
              message:
                "Found unguarded `requestRefresh()` call on line 49; single-flight promise needed.",
            },
          },
        },
        {
          id: "ca2",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: "thr-parent",
          receiverThreadIds: ["thr-sub-2"],
          prompt: "Check webhook retry backoff and run tests/webhooks.test.ts.",
          model: "ember",
          reasoningEffort: null,
          agentsStates: {
            "thr-sub-2": {
              status: "running",
              message: "Running vitest on tests/webhooks.test.ts…",
            },
          },
        },
        {
          id: "ca3",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "thr-parent",
          receiverThreadIds: ["thr-sub-3", "thr-sub-4", "thr-sub-5"],
          prompt: "Verify rate limit headers, TLS cert rotation, and webhook HMAC verification.",
          model: "spark",
          reasoningEffort: null,
          agentsStates: {
            "thr-sub-3": { status: "completed", message: "Retry-After header matches spec." },
            "thr-sub-4": {
              status: "completed",
              message: "Cert hot-reload passes zero-downtime check.",
            },
            "thr-sub-5": {
              status: "errored",
              message: "Missing timingSafeEqual on legacy webhook path.",
            },
          },
        },
        {
          id: "a1",
          type: "agentMessage",
          text: "Spawned subagents to audit auth, TLS, HMAC, and webhook retries in parallel.",
          phase: null,
          moderation: null,
          memoryCitation: null,
          delivery: null,
          questions: null,
          completedAtMs: Date.now() - 10000,
        },
      ],
    },
  ];

  const sub1Turns = [
    {
      id: "turn-s1",
      rootTurnId: null,
      status: "completed",
      error: null,
      startedAt: now - 35,
      completedAt: now - 20,
      durationMs: 15000,
      itemsView: "full",
      items: [
        {
          id: "s1-cmd",
          type: "commandExecution",
          command: "rg -n requestRefresh src/auth/session.ts",
          cwd,
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "49:  const token = await requestRefresh(userId);\n",
          exitCode: 0,
          durationMs: 120,
        },
        {
          id: "s1-msg",
          type: "agentMessage",
          text: "Line 49 calls `requestRefresh(userId)` without deduplicating concurrent callers. Wrapping it in a per-user in-flight `Map<string, Promise<Token>>` prevents duplicate refresh storms.",
          phase: null,
          moderation: null,
          memoryCitation: null,
          delivery: null,
          questions: null,
          completedAtMs: Date.now() - 20000,
        },
      ],
    },
  ];

  const sub2Turns = [
    {
      id: "turn-s2",
      rootTurnId: null,
      status: "inProgress",
      error: null,
      startedAt: now - 12,
      completedAt: null,
      durationMs: null,
      itemsView: "full",
      items: [
        {
          id: "s2-cmd",
          type: "commandExecution",
          command: "npx vitest run tests/webhooks.test.ts",
          cwd,
          processId: null,
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: "RUN v3.1.0 tests/webhooks.test.ts\n",
          exitCode: null,
          durationMs: null,
        },
      ],
    },
  ];

  const byId = new Map(threads.map((t) => [t.id, t]));
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const m = JSON.parse(line) as {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (m.id === undefined || !m.method) return;
    const reply = (result: unknown) => send({ id: m.id, result });
    const p = m.params ?? {};
    switch (m.method) {
      case "initialize":
        return reply({ userAgent: "fake-subagents", platformFamily: "unix", platformOs: "macos" });
      case "thread/list":
        return reply({ data: threads, readStates: null, nextCursor: null, backwardsCursor: null });
      case "thread/resume": {
        const t = byId.get(String(p.threadId)) ?? threads[0];
        return reply({
          thread: t,
          model: t.model,
          modelProvider: "tierlm",
          serviceTier: null,
          disabledPluginIds: [],
          cwd: t.cwd,
          runtimeWorkspaceRoots: [],
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          activePermissionProfile: null,
          reasoningEffort: null,
          multiAgentMode: "enabled",
        });
      }
      case "thread/turns/list": {
        const tid = String(p.threadId);
        const data =
          tid === "thr-parent"
            ? parentTurns
            : tid === "thr-sub-1"
              ? sub1Turns
              : tid === "thr-sub-2"
                ? sub2Turns
                : [];
        return reply({ data, nextCursor: null, backwardsCursor: null });
      }
      default:
        return send({ id: m.id, error: { code: -32601, message: `fake: ${m.method}` } });
    }
  });
}

async function check(): Promise<void> {
  const { chromium } = await import("playwright");
  const { startUiServer } = await import("../server/app.ts");
  const { findChromium } = await import("./chromium.ts");
  const { kit, layoutProblems } = await import("./e2e-kit.ts");
  const { startMockRouter } = await import("./mock-router.ts");

  const here = path.dirname(self);
  const root = path.resolve(here, "..");
  const { log, shot, check, shots } = kit(
    "subagents-e2e",
    process.env.SHOTS ?? path.join(tmpdir(), "provenance-subagents-e2e"),
  );
  mkdirSync(shots, { recursive: true });
  const scratch = mkdtempSync(path.join(tmpdir(), "pv-subagents-"));
  const binDir = path.join(scratch, "bin");
  const dataDir = path.join(scratch, "data");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(path.join(dataDir, "fallback"), { recursive: true });
  // Pre-seed a saved weekly usage snapshot for Antigravity to test the weekly meter immediately.
  writeFileSync(
    path.join(dataDir, "fallback", "usage.json"),
    JSON.stringify({
      antigravity: {
        weeklyRemaining: 0.78,
        weeklyResetsAt: Date.now() + 3 * 86_400_000,
        primaryRemaining: 0.92,
        primaryResetsAt: Date.now() + 2 * 3_600_000,
        updatedAt: Date.now(),
      },
    }),
  );
  const bin = path.join(scratch, "provenance");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${self}" "$@"\n`);
  chmodSync(bin, 0o755);
  const fakeAgy = path.join(here, "fixtures/fake-agy.mjs");
  chmodSync(fakeAgy, 0o755);
  symlinkSync(fakeAgy, path.join(binDir, "agy"));
  const nodeDir = path.dirname(process.execPath);

  const mock = await startMockRouter(0);
  await fetch(`${mock.url}/mock/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: "signed" }),
  });
  await fetch(`${mock.url}/pool/keys/groq`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "gsk_test_key" }),
  });

  const ui = await startUiServer({
    root,
    prod: true,
    port: 0,
    host: "127.0.0.1",
    bin,
    router: { url: mock.url },
    cwd: () => ({ defaultCwd: "/Users/dev/projects/api-gateway", fromLauncher: false }),
    dataDir,
    fallbackSearchPath: `${binDir}:${nodeDir}:/usr/bin:/bin`,
  });

  const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
  const page = await browser.newPage({ viewport: { width: 1360, height: 820 } });
  await page.addInitScript(() => localStorage.setItem("provenance-ui.welcome-done", "1"));
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  try {
    await page.goto(ui.url);
    await page.waitForSelector(".conn .dot-ok", { timeout: 30_000 });
    await page.waitForSelector(".thread-row", { timeout: 15_000 });

    // 1. Bottom-left usage bar replaces "app-server ready" with tier remaining %
    const connText = await page.locator(".conn").innerText();
    check(
      !connText.includes("app-server ready") && /solstice/i.test(connText) && /%/.test(connText),
      `bottom-left shows usage bar instead of app-server ready (${connText.replace(/\n/g, " ")})`,
    );

    // 2. Child subagent threads are hidden from top-level sidebar
    const sidebarRows = await page.locator(".thread-row").count();
    check(sidebarRows === 1, `sidebar hides child subagents (got ${sidebarRows} row)`);

    // 3. Hyperexperimental enabled on web-backed solstice, disabled on pinned pool/solstice
    const orchBtn = page.locator(".composer .slot-orchestrator .slot-btn");
    await orchBtn.click();
    await page.waitForSelector(".slot-menu-orchestrator");
    const hyperWebDisabled = await page
      .locator('.slot-menu-orchestrator [data-value="hyperexperimental"]')
      .getAttribute("aria-disabled");
    check(hyperWebDisabled === null, "Hyperexperimental enabled on web-backed solstice");
    await page.keyboard.press("Escape");

    // Pick Token pool under solstice (non-web-chat API pool source) & verify no duplicate Auto
    await page.click('button[title="Model tier"]');
    await page.hover('.tier-menu [role="option"][data-model="solstice"]');
    await page.waitForSelector(".tier-sub .tier-sub-option", { timeout: 5_000 });
    const autoCount = await page
      .locator(".tier-sub .tier-sub-label")
      .evaluateAll((els) => els.filter((e) => e.textContent?.trim() === "Auto").length);
    check(autoCount === 1, `exactly one Auto option in tier submenu (got ${autoCount})`);
    await page.locator(".tier-sub .tier-sub-option", { hasText: "Token pool" }).click();
    await orchBtn.click();
    await page.waitForSelector(".slot-menu-orchestrator");
    const hyperPoolDisabled = await page
      .locator('.slot-menu-orchestrator [data-value="hyperexperimental"]')
      .getAttribute("aria-disabled");
    const hyperPoolText = await page
      .locator('.slot-menu-orchestrator [data-value="hyperexperimental"]')
      .innerText();
    check(
      hyperPoolDisabled === "true" && /Web chat models only/.test(hyperPoolText),
      `Hyperexperimental disabled on pool/solstice (${hyperPoolText.replace(/\n/g, " ")})`,
    );
    await page.keyboard.press("Escape");

    // 4. Open parent thread: verify Subagents right panel auto-opens, active expanded, finished collapsed
    await page.locator(".thread-row", { hasText: "Audit auth and retry modules" }).click();
    await page.waitForSelector(".subagents-panel", { timeout: 10_000 });
    const bodyText = await page.locator(".conversation").innerText();
    check(!bodyText.includes("collabAgentToolCall"), "never renders raw collabAgentToolCall text");
    const activeCards = await page.locator(".subagent-card.active").count();
    check(activeCards === 1, `active subagent shown at top (got ${activeCards})`);
    const finishedToggle = page.locator(".subagents-group-toggle");
    check(
      (await finishedToggle.getAttribute("aria-expanded")) === "false" &&
        /Finished\s*4/.test(await finishedToggle.innerText()),
      `finished subagents collapsed by default (${(await finishedToggle.innerText()).replace(/\n/g, " ")})`,
    );
    const badList = await layoutProblems(page);
    check(!badList.length, `layout clean on subagents panel (${badList.join("; ")})`);
    await shot(page, "subagents-panel-collapsed");

    // Expand finished subagents -> compact rows appear
    await finishedToggle.click();
    const compactRows = await page.locator(".subagent-row-compact").count();
    check(compactRows === 4, `expanding Finished reveals 4 compact rows (got ${compactRows})`);
    await shot(page, "subagents-panel-expanded");

    // 5. Click into active subagent -> inline drill-down shows live command execution inside right panel
    await page.locator(".subagent-card", { hasText: "Retry Verifier" }).click();
    await page.waitForSelector(".subagent-detail", { timeout: 5_000 });
    await page.waitForSelector('.subagent-transcript:has-text("vitest")', { timeout: 5_000 });
    check(
      (await page.locator(".thread-header-name").innerText()).includes("Audit auth"),
      "drilling into a subagent keeps main conversation open",
    );
    await shot(page, "subagents-detail-active");

    // Go back to list and click into finished Auth Auditor -> shows full command + findings
    await page.click('button[aria-label="All subagents"]');
    await page.locator(".subagent-row-compact", { hasText: "Auth Auditor" }).click();
    await page.waitForSelector('.subagent-transcript:has-text("requestRefresh")', {
      timeout: 5_000,
    });
    await shot(page, "subagents-detail-finished");

    // Click "Full view" -> opens child thread, then back to parent
    await page.locator(".subagent-detail").getByRole("button", { name: "Full view" }).click();
    await page.waitForSelector(".parent-back-btn", { timeout: 10_000 });
    await page.click(".parent-back-btn");
    await page.waitForSelector(".subagents-panel", { timeout: 10_000 });
    await page.click('button[aria-label="All subagents"]');

    // 6. Enable Antigravity fallback and verify picker + weekly usage bar
    await page.click('button[title="Model tier"]');
    await page.click('.tier-menu [data-fallback="antigravity"]');
    await page.waitForSelector(
      '.setup-dialog[open] .fallback-row[data-cli="antigravity"] .dot-ok',
      {
        timeout: 15_000,
      },
    );
    await page.getByRole("switch", { name: "Use Antigravity" }).check();
    await page.locator(".setup-dialog[open]").getByRole("button", { name: "Close" }).click();
    await page.click('button[title="Model tier"]');
    await page.hover('.tier-menu [data-fallback="antigravity"]');
    await page.waitForSelector('.tier-sub[data-fallback="antigravity"]');
    await page.click('.tier-sub [data-source-model="antigravity:gemini-4-neon-high"]');
    await page.waitForTimeout(350);
    const agyConn = await page.locator(".conn").innerText();
    check(
      /Weekly/.test(agyConn) && /92%/.test(agyConn),
      `Antigravity Gemini shows weekly remaining from agy -p /usage (${agyConn.replace(/\n/g, " ")})`,
    );
    await shot(page, "antigravity-weekly-bar");

    // Switching to an Antigravity Claude/GPT model switches to its Claude & GPT bucket (100%)
    await page.click('button[title="Model tier"]');
    await page.hover('.tier-menu [data-fallback="antigravity"]');
    await page.waitForSelector('.tier-sub[data-fallback="antigravity"]');
    await page.click('.tier-sub [data-source-model="antigravity:claude-sonnet-4-6"]');
    const agyClaudeConn = await page.locator(".conn").innerText();
    check(
      /Weekly/.test(agyClaudeConn) && /100%/.test(agyClaudeConn),
      `Antigravity Claude model switches to Claude & GPT bucket (${agyClaudeConn.replace(/\n/g, " ")})`,
    );

    // 7. Design screen check: light theme + tablet (768px) overlay + phone (390px) no horizontal overflow
    await page.click('button[title="Switch to light theme"]');
    await page.waitForTimeout(200);
    await shot(page, "subagents-panel-light");
    await page.click('button[title="Switch to dark theme"]');
    await page.setViewportSize({ width: 768, height: 820 });
    await page.waitForTimeout(250);
    const tabletOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    check(!tabletOverflow, "no horizontal overflow at 768px");
    await shot(page, "subagents-tablet");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const phoneOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    check(!phoneOverflow, "no horizontal overflow at 390px");
    await shot(page, "subagents-phone");

    check(!errors.length, `no page errors${errors.length ? ` (${errors.join("; ")})` : ""}`);
    log("PASS");
  } finally {
    await browser.close();
    await ui.close();
    await mock.close();
  }
}
