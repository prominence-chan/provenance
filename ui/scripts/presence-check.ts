// Discord Rich Presence (electron/discord-presence.ts) against a stand-in Discord: TMPDIR is a
// scratch folder and this script listens on <it>/discord-ipc-0, speaking Discord's framing and
// handshake. The real Discord's socket is never looked at (the script checks every path the
// module would try is inside the scratch folder before anything connects).
//
//   npm run check:presence
//
// Checks: the activity's fields and strings, and that whatever else the page sends never reaches
// it; quiet with no client id and with no socket (and backing off); the handshake; SET_ACTIVITY
// with the expected fields; coalescing (at most one update per interval, the latest wins);
// clearing at once on switch-off and on quit; reconnecting when "Discord" restarts; an older
// client refusing large_url gets the activity without it; a refused client id stops retrying.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The scratch TMPDIR before the module reads anything; the other places Discord's socket can be
// are taken out of the environment.
const scratch = mkdtempSync(path.join(tmpdir(), "presence-check-"));
process.env.TMPDIR = scratch;
for (const k of ["XDG_RUNTIME_DIR", "TMP", "TEMP"]) delete process.env[k];

const { DiscordPresence, PRESENCE, buildActivity, sanitizePresence, socketPaths } =
  await import("../electron/discord-presence.ts");

const CLIENT_ID = "123456789012345678";
const sock0 = path.join(scratch, "discord-ipc-0");
let failures = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
}

async function until(what: string, cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// ---- a stand-in Discord ------------------------------------------------------------------------

interface Frame {
  op: number;
  data: Record<string, unknown>;
  at: number;
}

class FakeDiscord {
  server: Server | null = null;
  conns: Socket[] = [];
  frames: Frame[] = [];
  connections = 0;
  /** Reply to SET_ACTIVITY with an ERROR when the activity has large_url (an older client). */
  rejectLargeUrl = false;
  /** Close the handshake with 4000, as Discord does for an unknown client id. */
  rejectId = false;

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((c) => this.onConn(c));
      this.server.listen(sock0, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.destroy();
    this.conns = [];
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    rmSync(sock0, { force: true });
  }

  get sets(): Frame[] {
    return this.frames.filter((f) => f.op === 1 && f.data.cmd === "SET_ACTIVITY");
  }

  private send(c: Socket, op: number, data: unknown): void {
    const body = Buffer.from(JSON.stringify(data));
    const head = Buffer.alloc(8);
    head.writeUInt32LE(op, 0);
    head.writeUInt32LE(body.length, 4);
    c.write(Buffer.concat([head, body]));
  }

  private onConn(c: Socket): void {
    this.connections++;
    this.conns.push(c);
    let buf = Buffer.alloc(0);
    c.on("error", () => {});
    c.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const op = buf.readUInt32LE(0);
        const len = buf.readUInt32LE(4);
        if (buf.length < 8 + len) return;
        const data = JSON.parse(buf.subarray(8, 8 + len).toString("utf8"));
        buf = buf.subarray(8 + len);
        this.frames.push({ op, data, at: Date.now() });
        this.reply(c, op, data);
      }
    });
  }

  private reply(c: Socket, op: number, data: Record<string, unknown>): void {
    if (op === 0) {
      if (this.rejectId) {
        this.send(c, 2, { code: 4000, message: "Invalid Client ID" });
        c.end();
        return;
      }
      // Discord's READY carries the user: the module must not echo or log any of it.
      this.send(c, 1, {
        cmd: "DISPATCH",
        evt: "READY",
        data: {
          v: 1,
          config: {
            cdn_host: "cdn.discordapp.com",
            api_endpoint: "//discord.com/api",
            environment: "production",
          },
          user: {
            id: "1",
            username: "stand-in-user-xyz",
            discriminator: "0",
            global_name: "Stand In",
          },
        },
      });
      return;
    }
    if (op === 1 && data.cmd === "SET_ACTIVITY") {
      const args = data.args as { activity?: { assets?: Record<string, unknown> } };
      if (this.rejectLargeUrl && args.activity?.assets?.large_url) {
        this.send(c, 1, {
          cmd: "SET_ACTIVITY",
          evt: "ERROR",
          nonce: data.nonce,
          data: {
            code: 4000,
            message: 'child "activity" fails because "large_url" is not allowed',
          },
        });
        return;
      }
      this.send(c, 1, {
        cmd: "SET_ACTIVITY",
        evt: null,
        nonce: data.nonce,
        data: args.activity ?? null,
      });
    }
  }
}

// Everything the module logs, to check it stays quiet and never prints the READY user.
const logs: string[] = [];
const log = (m: string) => logs.push(m);
const working = (kind: string | null, since: number | null = Date.now() - 42_000) =>
  sanitizePresence({ kind, working: true, since });

// ---- checks --------------------------------------------------------------------------------------

await step("every socket path the module would try is inside the scratch TMPDIR", () => {
  const paths = socketPaths();
  assert.equal(paths.length, 10);
  for (const p of paths) assert.ok(p.startsWith(scratch + path.sep), p);
  assert.equal(paths[0], sock0);
});

await step("activity: the literal lines, images, hover texts and button", () => {
  const since = Date.now() - 42_000;
  const a = buildActivity(sanitizePresence({ kind: "solstice", working: true, since }));
  assert.deepEqual(a, {
    type: 0,
    details: "Solstice · Provenance Orchestrator",
    state: "Harness by SkyeNXT · coming soon",
    assets: {
      large_image: img("provenance"),
      large_text: "Provenance · harness by SkyeNXT",
      large_url: "https://github.com/prominence-chan/provenance",
      small_image: img("tier-solstice"),
      small_text: "Solstice tier · frontier",
    },
    instance: false,
    timestamps: { start: since },
    buttons: [
      { label: "Provenance on GitHub", url: "https://github.com/prominence-chan/provenance" },
    ],
  });
  const idle = buildActivity(sanitizePresence({ kind: "claude", working: false, since }));
  assert.equal(idle.details, "Claude Code · Fallback");
  assert.equal(idle.timestamps, undefined, "no timer while idle");
  assert.equal((idle.assets as Record<string, string>).small_text, "Claude Code fallback");
  const none = buildActivity(
    sanitizePresence({ kind: null, orchestrator: null, working: false, since: null }),
  );
  assert.equal(none.details, "Provenance");
  const hyper = buildActivity(
    sanitizePresence({ kind: "nova", orchestrator: "hyperexperimental", working: false }),
  );
  assert.equal(hyper.details, "Nova · Hyperexperimental Orchestrator");
  assert.equal(
    sanitizePresence({ kind: "nova", orchestrator: "SECRET" }).orchestrator,
    "provenance",
  );
  assert.equal(
    sanitizePresence({ kind: "codex", orchestrator: "experimental" }).orchestrator,
    null,
  );
  assert.equal((none.assets as Record<string, string>).small_image, undefined);
  for (const kind of ["spark", "ember", "nova", "codex"]) {
    const x = buildActivity(sanitizePresence({ kind, working: true, since }));
    assert.match(
      String(x.details),
      /^(Spark|Ember|Nova) · Provenance Orchestrator$|^Codex · Fallback$/,
    );
  }
  // Discord's limits: details/state 2-128 chars, button labels 1-32, at most two buttons.
  for (const s of [a.details, a.state, idle.details])
    assert.ok(String(s).length >= 2 && String(s).length <= 128);
  for (const b of a.buttons as { label: string; url: string }[]) {
    assert.ok(b.label.length >= 1 && b.label.length <= 32);
    assert.match(b.url, /^https:\/\//);
  }
  const lean = buildActivity(sanitizePresence({ kind: "nova", working: false }), true);
  assert.equal((lean.assets as Record<string, string>).large_url, undefined);
});

await step("sanitizePresence keeps only kind / working / since", () => {
  const raw = {
    kind: "nova",
    working: true,
    since: Date.now() - 1000,
    title: "SECRET-thread-title",
    prompt: "SECRET prompt",
    cwd: "/Users/someone/SECRET-project",
    account: "secret@example.com",
  };
  const s = sanitizePresence(raw);
  assert.deepEqual(Object.keys(s).sort(), ["kind", "orchestrator", "since", "working"]);
  assert.ok(!JSON.stringify(buildActivity(s)).includes("SECRET"));
  assert.equal(sanitizePresence({ kind: "SECRET-model-name", working: true }).kind, null);
  assert.equal(sanitizePresence({ kind: "toString" }).kind, null);
  assert.equal(sanitizePresence({ kind: "spark", working: "yes" }).working, false);
  assert.equal(sanitizePresence({ kind: "spark", working: true, since: "x" }).since, null);
  assert.equal(
    sanitizePresence({ kind: "spark", working: true, since: 1 }).since,
    null,
    "absurd start",
  );
  assert.equal(sanitizePresence({ kind: "spark", working: false, since: Date.now() }).since, null);
  assert.deepEqual(sanitizePresence(null), {
    kind: null,
    orchestrator: null,
    working: false,
    since: null,
  });
});

await step("no client id: nothing connects, nothing is logged", async () => {
  const fake = new FakeDiscord();
  await fake.start();
  try {
    const p = new DiscordPresence({
      clientId: "",
      enabled: true,
      minIntervalMs: 100,
      backoffMs: 20,
      log,
    });
    p.update(working("solstice"));
    p.configure("", true);
    p.update(working("nova"));
    await sleep(300);
    assert.equal(p.active, false);
    assert.equal(p.stats.attempts, 0);
    assert.equal(fake.connections, 0);
    await p.shutdown();
    assert.equal(fake.connections, 0);
    // A malformed id is the same as none.
    const q = new DiscordPresence({ clientId: "not-an-id", enabled: true, backoffMs: 20, log });
    q.update(working("spark"));
    await sleep(100);
    assert.equal(q.stats.attempts, 0);
    assert.equal(logs.length, 0, logs.join("\n"));
  } finally {
    await fake.stop();
  }
});

await step("switched off: nothing connects", async () => {
  const fake = new FakeDiscord();
  await fake.start();
  try {
    const p = new DiscordPresence({ clientId: CLIENT_ID, enabled: false, backoffMs: 20, log });
    p.update(working("spark"));
    await sleep(150);
    assert.equal(fake.connections, 0);
    await p.shutdown();
  } finally {
    await fake.stop();
  }
});

await step("no socket: quiet, no throw, retries back off", async () => {
  const p = new DiscordPresence({
    clientId: CLIENT_ID,
    enabled: true,
    backoffMs: 40,
    maxBackoffMs: 160,
    log,
  });
  // Nothing connects before there is something to show (lazy).
  await sleep(60);
  assert.equal(p.stats.attempts, 0);
  p.update(working("ember"));
  for (let i = 0; i < 20; i++) p.update(working(i % 2 ? "ember" : "nova")); // a burst must not storm
  await sleep(700);
  // 0, 40, 120, 280, 440, 600 ms: ~6 attempts; without backoff it would be dozens.
  assert.ok(p.stats.attempts >= 3 && p.stats.attempts <= 8, `attempts ${p.stats.attempts}`);
  assert.equal(logs.length, 0, logs.join("\n"));
  await p.shutdown();
  const n = p.stats.attempts;
  await sleep(300);
  assert.equal(p.stats.attempts, n, "no retries after quit");
});

await step("Discord starts later: picked up by the backoff, handshake, SET_ACTIVITY", async () => {
  const fake = new FakeDiscord();
  const p = new DiscordPresence({
    clientId: CLIENT_ID,
    enabled: true,
    minIntervalMs: 300,
    backoffMs: 50,
    log,
  });
  const since = Date.now() - 42_000;
  p.update(working("solstice", since));
  await sleep(120);
  await fake.start();
  try {
    await until("a SET_ACTIVITY", () => fake.sets.length === 1);
    const hs = fake.frames[0];
    assert.equal(hs.op, 0);
    assert.deepEqual(hs.data, { v: 1, client_id: CLIENT_ID });
    const set = fake.sets[0].data as {
      args: { pid: number; activity: Record<string, unknown> };
      nonce: string;
    };
    assert.equal(set.args.pid, process.pid);
    assert.equal(typeof set.nonce, "string");
    assert.deepEqual(
      set.args.activity,
      buildActivity(sanitizePresence({ kind: "solstice", working: true, since })),
    );
    const wire = JSON.stringify(fake.frames);
    assert.ok(!wire.includes("stand-in-user"), "READY's user went back out");
    assert.ok(!logs.join("\n").includes("stand-in-user"), "READY's user was logged");
    assert.deepEqual(logs, ["discord presence: connected"]);
    await p.shutdown();
  } finally {
    await fake.stop();
    logs.length = 0;
  }
});

await step("coalescing: one update per interval, the latest state wins; no repeats", async () => {
  const fake = new FakeDiscord();
  await fake.start();
  try {
    const interval = 400;
    const p = new DiscordPresence({
      clientId: CLIENT_ID,
      enabled: true,
      minIntervalMs: interval,
      backoffMs: 50,
      log,
    });
    p.update(working("spark"));
    await until("the first SET_ACTIVITY", () => fake.sets.length === 1);
    const t0 = fake.sets[0].at;
    for (const k of ["ember", "solstice", "nova", "claude"]) {
      p.update(sanitizePresence({ kind: k, working: false }));
      await sleep(20);
    }
    await sleep(interval + 150);
    assert.equal(fake.sets.length, 2, `sets: ${fake.sets.length}`);
    const second = fake.sets[1];
    assert.ok(second.at - t0 >= interval - 15, `gap ${second.at - t0} ms`);
    const act = (second.data.args as { activity: Record<string, unknown> }).activity;
    assert.equal(act.details, "Claude Code · Fallback");
    // The same state again sends nothing.
    p.update(sanitizePresence({ kind: "claude", working: false }));
    await sleep(interval + 100);
    assert.equal(fake.sets.length, 2);
    // The default interval is Discord's ~15 s.
    const d = new DiscordPresence({ clientId: CLIENT_ID, enabled: false });
    assert.equal((d as unknown as { minInterval: number }).minInterval, 15_000);
    await p.shutdown();
  } finally {
    await fake.stop();
    logs.length = 0;
  }
});

await step(
  "switch off clears at once (inside the interval), switch on shows it again",
  async () => {
    const fake = new FakeDiscord();
    await fake.start();
    try {
      const p = new DiscordPresence({
        clientId: CLIENT_ID,
        enabled: true,
        minIntervalMs: 5000,
        backoffMs: 50,
        log,
      });
      p.update(working("nova"));
      await until("the first SET_ACTIVITY", () => fake.sets.length === 1);
      const before = Date.now();
      p.configure(CLIENT_ID, false);
      await until("a clear", () => fake.sets.length === 2, 1000);
      assert.ok(Date.now() - before < 500, "clear waited for the interval");
      const clear = fake.sets[1].data as { args: Record<string, unknown> };
      assert.deepEqual(Object.keys(clear.args), ["pid"], "a clear has no activity");
      p.update(working("spark"));
      await sleep(200);
      assert.equal(fake.sets.length, 2, "updates while off must not send");
      await until(
        "the socket let go",
        () => fake.conns.every((c) => c.destroyed || c.readableEnded),
        2000,
      );
      p.configure(CLIENT_ID, true);
      await until("activity again", () => fake.sets.length === 3, 7000);
      const act = (fake.sets[2].data.args as { activity: Record<string, unknown> }).activity;
      assert.equal(act.details, "Spark · Provenance Orchestrator");
      await p.shutdown();
    } finally {
      await fake.stop();
      logs.length = 0;
    }
  },
);

await step("quit clears the activity and closes the socket", async () => {
  const fake = new FakeDiscord();
  await fake.start();
  try {
    const p = new DiscordPresence({
      clientId: CLIENT_ID,
      enabled: true,
      minIntervalMs: 200,
      backoffMs: 50,
      log,
    });
    p.update(working("ember"));
    await until("the first SET_ACTIVITY", () => fake.sets.length === 1);
    p.update(sanitizePresence({ kind: "ember", working: false })); // pending, never sent
    await p.shutdown();
    assert.equal(fake.sets.length, 2);
    assert.deepEqual(Object.keys((fake.sets[1].data as { args: object }).args), ["pid"]);
    await until(
      "the socket closed",
      () => fake.conns.every((c) => c.destroyed || c.readableEnded),
      2000,
    );
    assert.equal(fake.frames.at(-1)?.op, 2, "a CLOSE frame last");
    p.update(working("nova"));
    p.configure(CLIENT_ID, true);
    await sleep(300);
    assert.equal(fake.connections, 1, "nothing after quit");
    assert.equal(fake.sets.length, 2);
  } finally {
    await fake.stop();
    logs.length = 0;
  }
});

await step("Discord restarts: reconnects quietly and shows the current state", async () => {
  const fake = new FakeDiscord();
  await fake.start();
  try {
    const p = new DiscordPresence({
      clientId: CLIENT_ID,
      enabled: true,
      minIntervalMs: 200,
      backoffMs: 50,
      log,
    });
    p.update(working("solstice"));
    await until("the first SET_ACTIVITY", () => fake.sets.length === 1);
    await fake.stop();
    p.update(sanitizePresence({ kind: "nova", working: false }));
    await sleep(150);
    await fake.start();
    await until("a reconnect + SET_ACTIVITY", () => fake.sets.length === 2, 3000);
    assert.equal(fake.connections, 2);
    const act = (fake.sets[1].data.args as { activity: Record<string, unknown> }).activity;
    assert.equal(act.details, "Nova · Provenance Orchestrator");
    assert.ok(
      logs.every((l) => l === "discord presence: connected"),
      logs.join("\n"),
    );
    await p.shutdown();
  } finally {
    await fake.stop();
    logs.length = 0;
  }
});

await step("an older client refusing large_url gets the activity without it", async () => {
  const fake = new FakeDiscord();
  fake.rejectLargeUrl = true;
  await fake.start();
  try {
    const p = new DiscordPresence({
      clientId: CLIENT_ID,
      enabled: true,
      minIntervalMs: 200,
      backoffMs: 50,
      log,
    });
    p.update(working("spark"));
    await until("two SET_ACTIVITY", () => fake.sets.length === 2, 2000);
    const a2 = (fake.sets[1].data.args as { activity: { assets: Record<string, unknown> } })
      .activity;
    assert.equal(a2.assets.large_url, undefined);
    assert.equal(a2.assets.large_image, img("provenance"));
    await sleep(400);
    assert.equal(fake.sets.length, 2, "no loop");
    await p.shutdown();
  } finally {
    await fake.stop();
    logs.length = 0;
  }
});

await step(
  "a client id Discord refuses: one line in the log, no retries until it changes",
  async () => {
    const fake = new FakeDiscord();
    fake.rejectId = true;
    await fake.start();
    try {
      const p = new DiscordPresence({
        clientId: CLIENT_ID,
        enabled: true,
        minIntervalMs: 200,
        backoffMs: 30,
        log,
      });
      p.update(working("spark"));
      await until("a refused handshake", () => fake.connections === 1);
      await sleep(400);
      assert.equal(fake.connections, 1, "retried a refused id");
      assert.equal(p.active, false);
      assert.equal(logs.length, 1);
      fake.rejectId = false;
      p.configure("234567890123456789", true);
      await until("the new id's activity", () => fake.sets.length === 1, 2000);
      assert.deepEqual(fake.frames.filter((f) => f.op === 0).at(-1)?.data, {
        v: 1,
        client_id: "234567890123456789",
      });
      await p.shutdown();
    } finally {
      await fake.stop();
      logs.length = 0;
    }
  },
);

// ---- the page's side: what it reports through the preload -------------------------------------
// The built page (npm run build) in headless Chromium with a stand-in window.provenanceApp that
// records setPresence calls, against the mock router and toolgroup-e2e.ts's scripted fake
// app-server (one turn, released step by step). PAGE=0 skips it; skipped without dist/.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.PAGE === "0" || !existsSync(path.join(root, "dist/index.html"))) {
  console.log("skip the page's reports (PAGE=0, or no dist/: npm run build)");
} else {
  await step(
    "the page reports only {kind, working, since}: idle, working with a start, idle",
    async () => {
      const { chromium } = await import("playwright");
      const { startUiServer } = await import("../server/app.ts");
      const { findChromium } = await import("./chromium.ts");
      const { startMockRouter } = await import("./mock-router.ts");
      const ctl = path.join(scratch, "ctl.sock");
      const bin = path.join(scratch, "provenance");
      writeFileSync(
        bin,
        `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "scripts/toolgroup-e2e.ts")}" "$@"\n`,
      );
      chmodSync(bin, 0o755);
      const mock = await startMockRouter(0);
      await fetch(`${mock.url}/mock/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: "signed" }),
      });
      const ui = await startUiServer({
        root,
        prod: true,
        port: 0,
        host: "127.0.0.1",
        bin,
        router: { url: mock.url },
        appServerEnv: { TOOLGROUP_CTL: ctl },
        cwd: () => ({ defaultCwd: tmpdir(), fromLauncher: false }),
      });
      const release = () =>
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
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
        await page.addInitScript(() => {
          localStorage.setItem("provenance-ui.welcome-done", "1");
          const w = window as unknown as Record<string, unknown>;
          const calls: unknown[] = [];
          w.__presence = calls;
          const off = () => () => {};
          w.provenanceApp = {
            platform: "darwin",
            pickDirectory: async () => null,
            startRouter: async () => ({ up: true }),
            openPreferences: async () => {},
            onSetCwd: off,
            onNewThread: off,
            onOpenAccounts: off,
            onOpenWelcome: off,
            setPresence: (r: unknown) => calls.push(JSON.parse(JSON.stringify(r))),
          };
        });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        type Report = { kind: string | null; working: boolean; since: number | null };
        const reports = () =>
          page.evaluate(() => (window as unknown as { __presence: Report[] }).__presence);
        const last = async () => (await reports()).at(-1);
        await page.goto(ui.url);
        await page.waitForSelector(".conn .dot-ok", { timeout: 30_000 });
        assert.deepEqual(await last(), {
          kind: "solstice",
          orchestrator: "provenance",
          working: false,
          since: null,
        });
        await page.getByRole("button", { name: "New thread" }).click();
        const t0 = Date.now();
        await page.fill(".composer textarea", "SECRET prompt about SECRET-project");
        await page.keyboard.press("Enter");
        await page.waitForSelector(".turn .working", { timeout: 10_000 });
        await sleep(300);
        const w = await last();
        assert.equal(w?.kind, "solstice");
        assert.equal(w?.working, true);
        assert.ok(
          typeof w?.since === "number" && Math.abs(w.since - t0) < 10_000,
          `since ${w?.since}`,
        );
        for (let i = 0; i < 6; i++) await release(); // the scripted turn, to its end
        await page.locator(".turn .turn-footer").waitFor({ timeout: 5_000 });
        await sleep(300);
        assert.deepEqual(await last(), {
          kind: "solstice",
          orchestrator: "provenance",
          working: false,
          since: null,
        });
        const all = await reports();
        for (const r of all)
          assert.deepEqual(Object.keys(r).sort(), ["kind", "orchestrator", "since", "working"]);
        assert.ok(!JSON.stringify(all).includes("SECRET"), "the prompt reached a report");
        assert.ok(all.length <= 8, `${all.length} reports: only on change`);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
        await ui.close();
        await mock.close();
      }
    },
  );
}

rmSync(scratch, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall presence checks passed");
process.exit(failures ? 1 : 0);

/** An image as the app sends it: an uploaded asset key, or a URL when PRESENCE.imageBase is set. */
function img(key: string): string {
  return PRESENCE.imageBase ? `${PRESENCE.imageBase}/${key}.png` : key;
}
