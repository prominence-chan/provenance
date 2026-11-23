// Headless check that a run of tool rows folds into its "Ran …" summary the moment the
// assistant starts writing after it (not when the turn ends), and that a summary the user
// opened stays open. No real app-server, router or model: this file is also its own fake
// `provenance app-server` (JSON-RPC on stdio) that streams a scripted turn one step at a time,
// each step released by the check over a Unix socket. Nothing opens on screen.
//
//   npm run build && npm run e2e:toolgroup     # SHOTS=dir for the screenshots, DEV=1 for Vite

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

if (process.argv[2] === "app-server") await fakeAppServer(process.env.TOOLGROUP_CTL!);
else await check();

// ---- the fake app-server -------------------------------------------------------------------

async function fakeAppServer(ctl: string): Promise<void> {
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const note = (method: string, params: unknown) => send({ method, params });
  const t0 = Date.now();
  const cwd = tmpdir();
  const thread = {
    id: "thr-1",
    environments: null,
    extra: null,
    sessionId: "ses-1",
    forkedFromId: null,
    attachedToThreadId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "full",
    modelProvider: "fake",
    model: "solstice",
    reasoningEffort: null,
    createdAt: Math.floor(t0 / 1000),
    updatedAt: Math.floor(t0 / 1000),
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd,
    cliVersion: "0.0.0",
    originator: null,
    source: "vscode",
    canAcceptDirectInput: null,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    daybreakEnabled: null,
    daybreakProgramPropagationEnrolled: null,
    turns: [],
  };
  const T = "turn-1";
  const turn = (status: string, items: unknown[] = []) => ({
    id: T,
    rootTurnId: null,
    items,
    itemsView: "full",
    status,
    error: null,
    startedAt: Math.floor(t0 / 1000),
    completedAt: status === "inProgress" ? null : Math.floor(Date.now() / 1000),
    durationMs: status === "inProgress" ? null : Date.now() - t0,
  });
  const cmd = (id: string, command: string, status: string, read?: string) => ({
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command,
    cwd,
    processId: null,
    source: "agent",
    status,
    commandActions: read
      ? [{ type: "read", command, name: read, path: `${cwd}/${read}` }]
      : [{ type: "unknown", command }],
    aggregatedOutput: status === "inProgress" ? "" : "fine\n",
    exitCode: status === "inProgress" ? null : 0,
    durationMs: status === "inProgress" ? null : 120,
  });
  const msg = (id: string, text: string) => ({
    type: "agentMessage",
    id,
    text,
    moderation: null,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  });
  const base = { threadId: thread.id, turnId: T };
  const started = (item: unknown) =>
    note("item/started", { ...base, item, startedAtMs: Date.now() });
  const completed = (item: object) =>
    note("item/completed", {
      ...base,
      item: { ...item, completedAtMs: Date.now() },
      completedAtMs: Date.now(),
    });
  const delta = (itemId: string, d: string) =>
    note("item/agentMessage/delta", { ...base, itemId, delta: d });

  // The scripted turn, one step per POST /step from the check.
  const all: unknown[] = [];
  const steps: (() => void)[] = [
    // 0: two commands, done; nothing written after them yet.
    () => {
      for (const c of [
        cmd("c1", "ls -la", "completed"),
        cmd("c2", "cat a.txt", "completed", "a.txt"),
      ]) {
        started({ ...c, status: "inProgress" });
        completed(c);
        all.push(c);
      }
    },
    // 1: the reply item starts, still empty.
    () => started(msg("m1", "")),
    // 2: its first characters.
    () => delta("m1", "Here"),
    // 3: more of it, then done; a second run of tools starts (one still running).
    () => {
      delta("m1", " is what I found.");
      completed(msg("m1", "Here is what I found."));
      all.push(msg("m1", "Here is what I found."));
      started(cmd("c3", "npm test", "inProgress"));
    },
    // 4: the second run finishes, a second reply starts writing.
    () => {
      completed(cmd("c3", "npm test", "completed"));
      for (const c of [cmd("c4", "git status", "completed")]) {
        started({ ...c, status: "inProgress" });
        completed(c);
      }
      all.push(cmd("c3", "npm test", "completed"), cmd("c4", "git status", "completed"));
      started(msg("m2", ""));
      delta("m2", "All");
    },
    // 5: the turn ends.
    () => {
      delta("m2", " tests pass.");
      completed(msg("m2", "All tests pass."));
      all.push(msg("m2", "All tests pass."));
      note("turn/completed", { threadId: thread.id, turn: turn("completed", all) });
    },
  ];
  let next = 0;
  http
    .createServer((req, res) => {
      if (next < steps.length) steps[next++]();
      res.end(String(next));
    })
    .listen(ctl);

  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const m = JSON.parse(line) as { id?: number | string; method?: string };
    if (m.id === undefined || !m.method) return;
    const reply = (result: unknown) => send({ id: m.id, result });
    switch (m.method) {
      case "initialize":
        return reply({ userAgent: "fake-app-server", platformFamily: "unix", platformOs: "macos" });
      case "thread/list":
        return reply({ data: [], readStates: null, nextCursor: null, backwardsCursor: null });
      case "thread/start":
        return reply({
          thread,
          model: "solstice",
          modelProvider: "fake",
          serviceTier: null,
          disabledPluginIds: [],
          cwd,
          runtimeWorkspaceRoots: [],
          instructionSources: [],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly" },
          activePermissionProfile: null,
          reasoningEffort: null,
          multiAgentMode: "disabled",
        });
      case "turn/start":
        reply({ turn: turn("inProgress") });
        return note("turn/started", { threadId: thread.id, turn: turn("inProgress") });
      default:
        return send({ id: m.id, error: { code: -32601, message: `fake: no ${m.method}` } });
    }
  });
}

// ---- the check -------------------------------------------------------------------------------

async function check(): Promise<void> {
  const { chromium } = await import("playwright");
  const { startUiServer } = await import("../server/app.ts");
  const { findChromium } = await import("./chromium.ts");
  const { kit } = await import("./e2e-kit.ts");
  const { startMockRouter } = await import("./mock-router.ts");

  const root = path.resolve(path.dirname(self), "..");
  const { log, shot, check, shots } = kit(
    "toolgroup-e2e",
    process.env.SHOTS ?? path.join(tmpdir(), "provenance-toolgroup-e2e"),
  );
  const scratch = mkdtempSync(path.join(tmpdir(), "provenance-toolgroup-"));
  const ctl = path.join(scratch, "ctl.sock");
  const bin = path.join(scratch, "provenance");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${self}" "$@"\n`);
  chmodSync(bin, 0o755);

  const mock = await startMockRouter(0);
  // Something signed in (the welcome, which would still open for the missing fallbacks, is
  // marked seen below: this check is about the conversation).
  await fetch(`${mock.url}/mock/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: "signed" }),
  });
  const ui = await startUiServer({
    root,
    prod: !process.env.DEV,
    port: 0,
    host: "127.0.0.1",
    bin,
    router: { url: mock.url },
    appServerEnv: { TOOLGROUP_CTL: ctl },
    cwd: () => ({ defaultCwd: tmpdir(), fromLauncher: false }),
  });
  log(`UI ${ui.url}, screenshots in ${shots}`);

  const step = () =>
    new Promise<void>((resolve, reject) =>
      http
        .request({ socketPath: ctl, method: "POST", path: "/step" }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        })
        .on("error", reject)
        .end(),
    );

  const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.addInitScript(() => localStorage.setItem("provenance-ui.welcome-done", "1"));
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const turn = page.locator(".turn").last();
  const summaries = turn.locator(":scope > details.tool-summary");
  const liveGroups = turn.locator(":scope > .tool-group");
  /** Let the notifications land and React render. */
  const settle = () => page.waitForTimeout(400);

  try {
    await page.goto(ui.url);
    await page.waitForSelector(".conn .dot-ok", { timeout: 30_000 });
    await page.getByRole("button", { name: "New thread" }).click();
    await page.fill(".composer textarea", "look around");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".turn .working", { timeout: 10_000 });

    await step(); // two commands done, nothing after them
    await settle();
    check((await liveGroups.count()) === 1, "the finished commands show as a live group");
    check(
      (await liveGroups.first().locator(".tool-row").count()) === 2,
      "both command rows are visible",
    );
    check((await summaries.count()) === 0, "no summary yet: no text after the group");
    await shot(page, "1-live-group");

    await step(); // empty reply item
    await settle();
    check((await summaries.count()) === 0, "an empty reply item does not fold the group");

    await step(); // first characters
    await turn.locator(":scope > details.tool-summary").first().waitFor({ timeout: 2_000 });
    check((await summaries.count()) === 1, "first streamed characters fold the group");
    check(
      /Ran 1 command, read 1 file/.test(
        await summaries.first().locator(":scope > summary").innerText(),
      ),
      `summary reads "${await summaries.first().locator(":scope > summary").innerText()}"`,
    );
    check(
      !(await summaries.first().evaluate((d) => (d as HTMLDetailsElement).open)),
      "folded shut",
    );
    check((await turn.locator(".turn-footer").count()) === 0, "while the turn is still running");
    check(/Here/.test(await turn.locator(".agent-message").first().innerText()), "the text shows");
    await shot(page, "2-folded-on-first-text");

    // The user opens it: later deltas and the turn ending must leave it open.
    await summaries.first().locator(":scope > summary").click();
    check(
      await summaries.first().evaluate((d) => (d as HTMLDetailsElement).open),
      "user opened it",
    );

    await step(); // rest of the reply, second run of tools starts
    await settle();
    check(
      await summaries.first().evaluate((d) => (d as HTMLDetailsElement).open),
      "the opened summary stays open as more text streams",
    );
    check((await liveGroups.count()) === 1, "the new, running group is live (not folded)");

    await step(); // second run done, second reply writes
    await settle();
    check((await summaries.count()) === 2, "the second group folds on its reply's first text");
    check(
      !(await summaries.nth(1).evaluate((d) => (d as HTMLDetailsElement).open)),
      "the second summary is shut",
    );
    check(
      await summaries.first().evaluate((d) => (d as HTMLDetailsElement).open),
      "the first, user-opened summary is still open",
    );

    await step(); // turn ends
    await turn.locator(".turn-footer").waitFor({ timeout: 5_000 });
    check(
      await summaries.first().evaluate((d) => (d as HTMLDetailsElement).open),
      "the user-opened summary is still open after the turn ends",
    );
    check(
      !(await summaries.nth(1).evaluate((d) => (d as HTMLDetailsElement).open)),
      "the other summary is still shut after the turn ends",
    );
    await shot(page, "3-turn-done");
    check(!errors.length, `no page errors${errors.length ? ` (${errors.join("; ")})` : ""}`);
    log("PASS");
  } finally {
    await browser.close();
    await ui.close();
    await mock.close();
  }
}
