// One plain model call to the router (provenance-core): no tools, one user message, a new chat.
//
// POST <router>/v1/responses, streamed. Why this shape (provenance-core's responses_api.py and
// chatgpt_web.py): a tier's web sources only serve /v1/responses; a web chat is only continued
// when a request carries the earlier assistant turns, so a single user message with no
// previous_response_id and store:false always opens a new (temporary) chat; a random
// X-PCore-Session keeps the router from steering the call to "the model that answered this
// session last"; instructions stay far under the 3000 characters above which the web path swaps
// them for its own coding prompt. Streaming is what makes interrupt work: closing the stream
// frees the router's window (a non-streamed request runs to its end whatever the client does).
//
// The router answers "nobody can serve this" with 503 (and a named model with 429): those end
// the caller's turn with a plain message; they are not retried here.

import { randomUUID } from "node:crypto";

export interface RouterConn {
  url: string;
  token?: string;
}

export interface ModelCall {
  /** The tier, or "<source>/<tier>" as the picker pins it. */
  model: string;
  /** Short role instructions (kept under 3000 characters; see above). */
  instructions: string;
  /** The single user message. */
  input: string;
  signal: AbortSignal;
  /** Cap on the reply (tokens). */
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface ModelReply {
  text: string;
  /** Characters sent (instructions + input). */
  promptChars: number;
  /** Which concrete model answered, when the router says (X-PCore-Model). */
  servedBy: string | null;
  ms: number;
}

export class RouterError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type CallModel = (call: ModelCall) => Promise<ModelReply>;

const DEFAULT_TIMEOUT_MS = 8 * 60_000;

/** A message for the user from a router failure. */
export function routerProblem(status: number, detail: string): string {
  const d = detail.replace(/\s+/g, " ").trim().slice(0, 300);
  if (status === 503)
    return `No free model could take this right now (the router answered 503${d ? `: ${d}` : ""}). Try again in a while, or pick another tier.`;
  if (status === 429)
    return `The model is rate limited right now (429${d ? `: ${d}` : ""}). Try again in a while, or pick another tier.`;
  if (status === 401 || status === 403) return "The router refused the request (its token didn't match).";
  if (status === 0) return `The router isn't answering${d ? ` (${d})` : ""}.`;
  return `The router answered ${status}${d ? `: ${d}` : ""}.`;
}

export function makeCallModel(conn: () => RouterConn): CallModel {
  return async (call) => {
    const { url, token } = conn();
    const t0 = Date.now();
    const timeout = AbortSignal.timeout(call.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = AbortSignal.any([call.signal, timeout]);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "accept": "text/event-stream",
      "x-pcore-session": `orc-${randomUUID()}`,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(`${url.replace(/\/$/, "")}/v1/responses`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          model: call.model,
          instructions: call.instructions,
          input: [{ role: "user", content: [{ type: "input_text", text: call.input }] }],
          stream: true,
          store: false,
          max_output_tokens: call.maxOutputTokens ?? 3000,
        }),
      });
    } catch (e) {
      if (call.signal.aborted) throw e;
      throw new RouterError(0, timeout.aborted ? "timed out" : errText(e));
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new RouterError(res.status, errorMessage(body));
    }
    let text = "";
    let finalText: string | null = null;
    let failure: string | null = null;
    const onEvent = (data: string) => {
      if (data === "[DONE]") return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(data);
      } catch {
        return;
      }
      const type = ev.type;
      if (type === "response.output_text.delta" && typeof ev.delta === "string") text += ev.delta;
      else if (type === "response.completed" || type === "response.incomplete") {
        const out = outputText(ev.response);
        if (out) finalText = out;
      } else if (type === "response.failed" || type === "error") {
        const r = (ev.response ?? ev) as { error?: { message?: string }; message?: string };
        failure = r.error?.message ?? r.message ?? "the model call failed";
      } else if (ev.error && typeof ev.error === "object") {
        failure = (ev.error as { message?: string }).message ?? "the model call failed";
      }
    };
    try {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let at: number;
        while ((at = buf.search(/\r?\n\r?\n/)) !== -1) {
          const block = buf.slice(0, at);
          buf = buf.slice(at).replace(/^\r?\n\r?\n/, "");
          const data = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (data) onEvent(data);
        }
      }
    } catch (e) {
      if (call.signal.aborted) throw e;
      throw new RouterError(0, timeout.aborted ? "timed out waiting for the reply" : errText(e));
    }
    if (failure !== null) {
      const f = String(failure);
      throw new RouterError(/no model in|no capacity|none available/i.test(f) ? 503 : 502, f);
    }
    const reply = (finalText ?? text).trim();
    if (!reply) throw new RouterError(502, "the model sent an empty reply");
    return {
      text: reply,
      promptChars: call.instructions.length + call.input.length,
      servedBy: res.headers.get("x-pcore-model"),
      ms: Date.now() - t0,
    };
  };
}

function outputText(response: unknown): string {
  const out = (response as { output?: unknown })?.output;
  if (!Array.isArray(out)) return "";
  const parts: string[] = [];
  for (const item of out as { type?: string; content?: { type?: string; text?: string }[] }[]) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content)
      if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
  }
  return parts.join("");
}

function errorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string }; detail?: unknown };
    if (j.error?.message) return j.error.message;
    if (typeof j.detail === "string") return j.detail;
  } catch {
    // not JSON
  }
  return body.slice(0, 300);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
