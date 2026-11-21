// Headless end-to-end check of the bridge (no browser):
//   1. connect to ws://127.0.0.1:$PORT/rpc and wait for bridge/status ready
//   2. initialize, thread/start (model $MODEL, default "ember"), turn/start "reply with just ok"
//   3. stream item/agentMessage/delta until turn/completed; assert the reply
//   4. thread/list includes the thread; thread/resume + thread/turns/list return it
//
// Start the server first (`npm run dev` or `npm start`), then: npm run smoke
// Retries the turn a few times because free upstream models sometimes 503.

const port = Number(process.env.PORT ?? 5173);
const model = process.env.MODEL ?? "ember";
const attempts = Number(process.env.ATTEMPTS ?? 4);

type Msg = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
let nextId = 1;
const pending = new Map<number, (m: Msg) => void>();
const listeners = new Set<(m: Msg) => void>();

ws.onmessage = (ev) => {
  const m: Msg = JSON.parse(String(ev.data));
  if (m.id !== undefined && !m.method && pending.has(m.id as number)) {
    pending.get(m.id as number)!(m);
    pending.delete(m.id as number);
    return;
  }
  for (const l of listeners) l(m);
};

function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function waitFor(pred: (m: Msg) => boolean, timeoutMs: number): Promise<Msg> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      listeners.delete(l);
      reject(new Error("timeout"));
    }, timeoutMs);
    const l = (m: Msg) => {
      if (pred(m)) {
        clearTimeout(t);
        listeners.delete(l);
        resolve(m);
      }
    };
    listeners.add(l);
  });
}

const log = (...a: unknown[]) => console.log("[smoke]", ...a);

await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error(`cannot connect to ws://127.0.0.1:${port}/rpc`));
});
log("connected");
const ready = waitFor((m) => m.method === "bridge/status" && m.params.state === "ready", 60_000);
await ready;
log("bridge ready");

await request("initialize", {
  clientInfo: { name: "provenance_ui_smoke", title: null, version: "0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
});

const started = await request("thread/start", { model, cwd: "/tmp", approvalPolicy: "on-request", sandbox: "read-only" });
const threadId: string = started.thread.id;
log(`thread/start -> ${threadId} (model ${started.model}, provider ${started.modelProvider})`);

let reply = "";
let ok = false;
for (let i = 1; i <= attempts && !ok; i++) {
  let streamed = "";
  let deltas = 0;
  const onDelta = (m: Msg) => {
    if (m.method === "item/agentMessage/delta" && m.params.threadId === threadId) {
      streamed += m.params.delta;
      deltas++;
    }
    if (m.method === "error" && m.params.threadId === threadId) log(`  error notification: ${m.params.error.message} (willRetry=${m.params.willRetry})`);
  };
  listeners.add(onDelta);
  const done = waitFor((m) => m.method === "turn/completed" && m.params.threadId === threadId, 180_000);
  const turn = await request("turn/start", {
    threadId,
    model,
    input: [{ type: "text", text: "reply with just ok", text_elements: [] }],
  });
  log(`attempt ${i}: turn/start -> ${turn.turn.id}`);
  const completed = await done;
  listeners.delete(onDelta);
  const status = completed.params.turn.status;
  log(`attempt ${i}: turn/completed status=${status} deltas=${deltas} streamed=${JSON.stringify(streamed)}`);
  if (status === "completed" && streamed.trim()) {
    reply = streamed;
    ok = true;
  } else if (completed.params.turn.error) {
    log(`  turn error: ${completed.params.turn.error.message}`);
  }
}
if (!ok) {
  log("FAIL: no successful streamed reply");
  process.exit(1);
}

const list = await request("thread/list", { limit: 20, sortKey: "updated_at" });
const listed = list.data.find((t: { id: string }) => t.id === threadId);
log(`thread/list: ${list.data.length} threads; new thread listed=${!!listed} preview=${JSON.stringify(listed?.preview)}`);

const resumed = await request("thread/resume", { threadId, excludeTurns: true });
const turns = await request("thread/turns/list", { threadId, limit: 10, sortDirection: "desc", itemsView: "full" });
const items = turns.data.flatMap((t: { items: { type: string }[] }) => t.items.map((it) => it.type));
log(`thread/resume ok (cwd ${resumed.cwd}); history items: ${items.join(", ")}`);

const pass = /\bok\b/i.test(reply) && !!listed && items.includes("agentMessage");
log(pass ? `PASS: reply=${JSON.stringify(reply.trim())}` : "FAIL");
ws.close();
process.exit(pass ? 0 : 1);
