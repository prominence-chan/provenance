// The fallbacks against the REAL CLIs on this Mac: one tiny turn each, through the app's own code
// (server/fallback/backend.ts for claude and codex, the /rpc/codex app-server for "Codex through
// Provenance"). Spends a little of your Claude / Codex usage; signs nothing in or out; prints no
// token, e-mail or account detail.
//
//   node scripts/fallback-real-check.ts               # all three
//   ONLY=claude|codex|pv node scripts/fallback-real-check.ts
//   CLAUDE_SESSION=<id> CLAUDE_CWD=<dir>  resume that Claude Code session instead of a new one
//   CODEX_SESSION=<id>  CODEX_CWD=<dir>   resume that Codex session instead of a new one
//
// Everything the app keeps goes to a scratch folder; the main app-server runs on a scratch
// PROVENANCE_HOME and never sends a model request (its router URL answers nothing).

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startUiServer } from "../server/app.ts";
import { FallbackBackend } from "../server/fallback/backend.ts";
import { defaultSearchPath } from "../server/fallback/cli.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (...a: unknown[]) => console.log("[fallback-real]", ...a);
const only = process.env.ONLY;
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "provenance-fallback-real-")));
const work = path.join(scratch, "work");
mkdirSync(work);
let failed = false;

type Turn = {
  status: string;
  items: { type: string; text?: string; command?: string }[];
  error: { message: string } | null;
};

async function cliTurn(mode: "claude" | "codex", session: string | undefined, cwd: string) {
  const dir = path.join(scratch, `fallback-${mode}`);
  let backend = new FallbackBackend({ dir, searchPath: defaultSearchPath, log: () => {} });
  const model = mode === "claude" ? "claude:haiku" : "codex:";
  const started = (await backend.handle("thread/start", { model, cwd, sandbox: "read-only" })) as {
    thread: { id: string };
  };
  const id = started.thread.id;
  if (session) {
    // Resume an existing session: the backend reads the thread file back with it.
    const file = path.join(dir, "threads", `${id}.json`);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.session = session;
    writeFileSync(file, JSON.stringify(rec));
    backend = new FallbackBackend({ dir, searchPath: defaultSearchPath, log: () => {} });
  }
  const t0 = Date.now();
  await backend.handle("turn/start", {
    threadId: id,
    input: [{ type: "text", text: "Reply with just the word: two", text_elements: [] }],
  });
  let turn: Turn | undefined;
  while (Date.now() - t0 < 180_000) {
    await new Promise((r) => setTimeout(r, 500));
    const list = (await backend.handle("thread/turns/list", {
      threadId: id,
      sortDirection: "desc",
    })) as {
      data: Turn[];
    };
    if (list.data[0] && list.data[0].status !== "inProgress") {
      turn = list.data[0];
      break;
    }
  }
  const rec = JSON.parse(readFileSync(path.join(dir, "threads", `${id}.json`), "utf8"));
  const answer = turn?.items
    .filter((i) => i.type === "agentMessage")
    .at(-1)
    ?.text?.trim();
  const ok = turn?.status === "completed" && !!answer;
  log(
    `${mode}: ${turn?.status ?? "timed out"} in ${((Date.now() - t0) / 1000).toFixed(1)} s; items ${turn?.items.map((i) => i.type).join(",")}; ` +
      `answer ${JSON.stringify(answer)}; session ${session ? (rec.session === session ? "resumed (same id)" : `changed to ${rec.session}`) : rec.session ? "new, kept for the next turn" : "none"}` +
      (turn?.error ? `; error: ${turn.error.message}` : ""),
  );
  if (!ok) failed = true;
}

async function throughProvenance() {
  const bin = process.env.PROVENANCE_BIN ?? path.join(homedir(), ".local/bin/provenance");
  const ui = await startUiServer({
    root,
    prod: true,
    port: 0,
    host: "127.0.0.1",
    bin,
    router: { url: "http://127.0.0.1:9" }, // nothing there: the tiers' app-server sends nothing
    appServerEnv: { PROVENANCE_HOME: path.join(scratch, "provenance-home") },
    cwd: () => ({ defaultCwd: work, fromLauncher: true }),
    dataDir: path.join(scratch, "ui-data"),
  });
  const ws = new WebSocket(`${ui.url.replace("http", "ws")}/rpc/codex`);
  const waits = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  let completed!: (t: Turn) => void;
  const done = new Promise<Turn>((r) => (completed = r));
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    if (m.method === "bridge/status" && m.params.state === "ready") ready();
    else if (m.id !== undefined && !m.method) waits.get(m.id)?.(m);
    else if (m.method === "turn/completed") completed(m.params.turn);
  });
  let seq = 0;
  const call = (method: string, params: unknown) =>
    new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
      const id = ++seq;
      waits.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    await Promise.race([
      readyP,
      new Promise((_, rej) => setTimeout(() => rej(new Error("app-server not ready")), 60_000)),
    ]);
    await call("initialize", {
      clientInfo: { name: "check", title: null, version: "0" },
      capabilities: { experimentalApi: true },
    });
    const acct = await call("account/read", {});
    const a = (acct.result as { account?: { type?: string } } | undefined)?.account;
    log(`pv: the fork's home sees a ${a?.type ?? "missing"} login (linked to Codex's)`);
    const st = await call("thread/start", {
      cwd: work,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const r = st.result as { model: string; modelProvider: string; thread: { id: string } };
    if (!r) throw new Error(st.error?.message ?? "thread/start failed");
    const t0 = Date.now();
    await call("turn/start", {
      threadId: r.thread.id,
      input: [{ type: "text", text: "Reply with just the word: ok", text_elements: [] }],
      effort: "low",
    });
    const turn = await Promise.race([
      done,
      new Promise<Turn>((_, rej) => setTimeout(() => rej(new Error("turn timed out")), 180_000)),
    ]);
    const answer = turn.items
      .filter((i) => i.type === "agentMessage")
      .at(-1)
      ?.text?.trim();
    log(
      `pv: provider ${r.modelProvider}, model ${r.model}; ${turn.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s; answer ${JSON.stringify(answer)}`,
    );
    if (turn.status !== "completed" || !answer || r.modelProvider !== "openai") failed = true;
  } finally {
    ws.close();
    await ui.close();
  }
}

try {
  if (!only || only === "claude")
    await cliTurn("claude", process.env.CLAUDE_SESSION, process.env.CLAUDE_CWD ?? work);
  if (!only || only === "codex")
    await cliTurn("codex", process.env.CODEX_SESSION, process.env.CODEX_CWD ?? work);
  if (!only || only === "pv") await throughProvenance();
} catch (e) {
  log("failed:", e instanceof Error ? e.message : e);
  failed = true;
}
log(failed ? "FAILED" : "all good", `(scratch ${scratch})`);
process.exit(failed ? 1 : 0);
