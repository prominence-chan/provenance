// Headless check for:
// 1. Subagent UI support (`collabAgentToolCall` + `subAgentActivity` render cleanly without raw
//    "collabAgentToolCall" fallback, populate the right Subagents panel, toggle via header, and
//    open child threads).
// 2. Hyperexperimental orchestrator gating (enabled on web chat models, disabled on API pool).

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
          id: "a1",
          type: "agentMessage",
          text: "Spawned two subagents to audit auth and verify webhook retries in parallel.",
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
      case "thread/turns/list":
        return reply({
          data: p.threadId === "thr-parent" ? parentTurns : [],
          nextCursor: null,
          backwardsCursor: null,
        });
      default:
        return send({ id: m.id, error: { code: -32601, message: `fake: ${m.method}` } });
    }
  });
}

async function check(): Promise<void> {
  const { chromium } = await import("playwright");
  const { startUiServer } = await import("../server/app.ts");
  const { findChromium } = await import("./chromium.ts");
  const { kit } = await import("./e2e-kit.ts");
  const { startMockRouter } = await import("./mock-router.ts");

  const root = path.resolve(path.dirname(self), "..");
  const { log, shot, check, shots } = kit(
    "subagents-e2e",
    process.env.SHOTS ?? path.join(tmpdir(), "provenance-subagents-e2e"),
  );
  mkdirSync(shots, { recursive: true });
  const scratch = mkdtempSync(path.join(tmpdir(), "pv-subagents-"));
  const bin = path.join(scratch, "provenance");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${self}" "$@"\n`);
  chmodSync(bin, 0o755);

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

    // 1. Child subagent threads are hidden from top-level sidebar
    const sidebarRows = await page.locator(".thread-row").count();
    check(sidebarRows === 1, `sidebar hides child subagents (got ${sidebarRows} row)`);

    // 2. Hyperexperimental enabled on web-backed solstice, disabled on pinned pool/solstice
    const orchBtn = page.locator(".composer .slot-orchestrator .slot-btn");
    await orchBtn.click();
    await page.waitForSelector(".slot-menu-orchestrator");
    const hyperWebDisabled = await page
      .locator('.slot-menu-orchestrator [data-value="hyperexperimental"]')
      .getAttribute("aria-disabled");
    check(hyperWebDisabled === null, "Hyperexperimental enabled on web-backed solstice");
    await page.keyboard.press("Escape");

    // Pick Token pool under solstice (non-web-chat API pool source)
    await page.click('button[title="Model tier"]');
    await page.hover('.tier-menu [role="option"][data-model="solstice"]');
    await page.waitForSelector(".tier-sub .tier-sub-option", { timeout: 5_000 });
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

    // 3. Open parent thread: verify Subagents right panel auto-opens and no raw collabAgentToolCall
    await page.locator(".thread-row", { hasText: "Audit auth and retry modules" }).click();
    await page.waitForSelector(".subagents-panel", { timeout: 10_000 });
    const bodyText = await page.locator(".conversation").innerText();
    check(!bodyText.includes("collabAgentToolCall"), "never renders raw collabAgentToolCall text");
    const cards = await page.locator(".subagent-card").count();
    check(cards === 2, `right panel lists both subagents (got ${cards})`);
    const toggleText = await page.locator(".subagents-toggle").innerText();
    check(/1 active/.test(toggleText), `header toggle shows live active count (${toggleText})`);
    await shot(page, "subagents-panel");

    // 4. Close and reopen right panel via header toggle
    await page.click('button[aria-label="Close subagents panel"]');
    check((await page.locator(".subagents-panel").count()) === 0, "panel closes cleanly");
    await page.click(".subagents-toggle");
    await page.waitForSelector(".subagents-panel");

    // 5. Open a subagent thread and jump back to parent
    await page
      .locator(".subagent-card", { hasText: "Auth Auditor" })
      .getByRole("button", { name: "Open" })
      .click();
    await page.waitForSelector(".parent-back-btn", { timeout: 10_000 });
    await page.click(".parent-back-btn");
    await page.waitForSelector(".subagents-panel", { timeout: 10_000 });

    // 6. Design screen check: light theme + tablet (768px) overlay + phone (390px) no horizontal overflow
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
