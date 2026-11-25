// Antigravity (`agy --input-format stream-json --output-format stream-json`) NDJSON parser.
// Native Antigravity events carry `event`:
//   init        -> { conversation_id, init: { cwd, tools, permission_mode, model } }
//   step_update -> { step_update: { conversation_id, step_index, state: "ACTIVE"|"DONE",
//                    step_type: "user_input"|"agent_response"|"tool"|"checkpoint",
//                    tool_name, text_delta, tool_info: { name, parameters, output, error } } }
//   result      -> { result: { conversation_id, status: "SUCCESS"|..., response, error, usage } }
// Also supports Claude-style `type` envelopes and `rate_limit_event` usage updates.

import path from "node:path";
import type { FallbackUsage } from "../../shared/fallback-api.ts";
import {
  agentMessage,
  command,
  fileChange,
  reasoning,
  replaceDiff,
  toolCall,
  webSearch,
  type Item,
  type Sink,
} from "./items.ts";

type Json = Record<string, unknown>;

export interface AgySink extends Sink {
  usage?: (u: FallbackUsage) => void;
}

export class AgyStream {
  private sink: AgySink;
  private cwd: string;
  private prefix: string;
  private streaming: { id: string; text: string; stepKey?: string } | null = null;
  private emittedMessage = false;
  private tools = new Map<string, Item>();
  private n = 0;
  private finished = false;

  constructor(sink: AgySink, cwd: string, prefix: string) {
    this.sink = sink;
    this.cwd = cwd;
    this.prefix = prefix;
  }

  private nextId(kind: string): string {
    return `${this.prefix}-${kind}-${++this.n}`;
  }

  line(raw: string): void {
    let ev: Json;
    try {
      ev = JSON.parse(raw);
    } catch {
      if (raw.trim()) this.appendText(`${raw}\n`);
      return;
    }
    const sid =
      (typeof ev.conversation_id === "string" && ev.conversation_id) ||
      (typeof ev.conversationId === "string" && ev.conversationId) ||
      (typeof ev.session_id === "string" && ev.session_id) ||
      (typeof (ev.step_update as Json | undefined)?.conversation_id === "string" &&
        String((ev.step_update as Json).conversation_id)) ||
      (typeof (ev.result as Json | undefined)?.conversation_id === "string" &&
        String((ev.result as Json).conversation_id)) ||
      null;
    if (sid) this.sink.session(sid);

    if (ev.rate_limit_info || ev.rateLimits || ev.rate_limits || ev.quota) {
      const u = extractUsage(ev);
      if (u) this.sink.usage?.(u);
    }

    // Native Antigravity stream-json format (`event`: "init" | "step_update" | "result")
    if (typeof ev.event === "string") {
      switch (ev.event) {
        case "init":
          return;
        case "step_update":
          return this.stepUpdate((ev.step_update ?? {}) as Json);
        case "result":
          return this.nativeResult((ev.result ?? ev) as Json);
        case "error": {
          const msg =
            (typeof ev.message === "string" && ev.message) ||
            (typeof ev.error === "string" && ev.error) ||
            "Antigravity error";
          this.sink.error(msg, false);
          return;
        }
        default:
          return;
      }
    }

    // Fallback compatibility for `type`-keyed envelopes
    switch (ev.type) {
      case "system":
        return;
      case "stream_event":
        return this.streamEvent((ev.event ?? {}) as Json);
      case "delta":
      case "text_delta":
      case "content_delta": {
        const d =
          (typeof ev.delta === "string" && ev.delta) ||
          (typeof ev.text === "string" && ev.text) ||
          "";
        if (d) this.appendText(d);
        return;
      }
      case "assistant":
      case "message": {
        const content = ((ev.message ?? {}) as Json).content ?? ev.content;
        if (typeof content === "string") {
          const id = this.streaming?.id ?? this.nextId("msg");
          this.streaming = null;
          if (content.trim()) {
            this.emittedMessage = true;
            this.sink.completed(agentMessage(id, content, true));
          }
        } else {
          this.assistant(content);
        }
        return;
      }
      case "tool_use":
      case "tool_call": {
        const id = String(ev.id ?? ev.call_id ?? this.nextId("call"));
        const name = String(ev.name ?? ev.tool ?? "tool");
        const input = (ev.input ?? ev.arguments ?? {}) as Json;
        this.closeStreaming();
        const item = this.toolItem(id, name, input);
        this.tools.set(id, item);
        this.sink.started(item);
        return;
      }
      case "tool_result": {
        const id = String(ev.tool_use_id ?? ev.call_id ?? ev.id ?? "");
        const item = this.tools.get(id);
        if (item) {
          this.tools.delete(id);
          const failed = ev.is_error === true || ev.error != null;
          const out = textOf(ev.output ?? ev.content ?? ev.result);
          this.sink.completed(finish(item, failed, out));
        }
        return;
      }
      case "user":
        return this.toolResults(((ev.message ?? {}) as Json).content);
      case "error": {
        const msg =
          (typeof ev.message === "string" && ev.message) ||
          (typeof ev.error === "string" && ev.error) ||
          "Antigravity error";
        this.sink.error(msg, false);
        return;
      }
      case "result":
        return this.legacyResult(ev);
      default:
        return;
    }
  }

  private stepUpdate(su: Json): void {
    const stepType = typeof su.step_type === "string" ? su.step_type : "";
    const state = typeof su.state === "string" ? su.state : "";
    const stepKey = su.step_index != null ? `step-${String(su.step_index)}` : undefined;

    if (stepType === "agent_response") {
      if (
        this.streaming &&
        stepKey &&
        this.streaming.stepKey &&
        this.streaming.stepKey !== stepKey
      ) {
        this.closeStreaming();
      }
      const delta = typeof su.text_delta === "string" ? su.text_delta : "";
      if (delta) this.appendText(delta, stepKey);
      if (state === "DONE") this.closeStreaming();
      return;
    }

    if (stepType === "tool") {
      this.closeStreaming();
      const key = stepKey ?? this.nextId("tool");
      const info = (su.tool_info ?? {}) as Json;
      const name = String(info.name ?? su.tool_name ?? "tool");
      const params = (info.parameters ?? {}) as Json;
      let item = this.tools.get(key);
      if (!item) {
        item = this.toolItem(key, name, params);
        this.tools.set(key, item);
        this.sink.started(item);
      }
      if (state === "DONE") {
        this.tools.delete(key);
        const errObj = info.error as Json | string | boolean | null | undefined;
        const failed = errObj != null && errObj !== false;
        const errText =
          typeof errObj === "string"
            ? errObj
            : errObj && typeof errObj === "object" && typeof errObj.message === "string"
              ? errObj.message
              : "";
        const out = textOf(info.output) || errText;
        this.sink.completed(finish(item, failed, out));
      }
    }
  }

  private nativeResult(res: Json): void {
    this.closeStreaming();
    const response = typeof res.response === "string" ? res.response : "";
    if (response.trim() && !this.emittedMessage) {
      this.emittedMessage = true;
      this.sink.completed(agentMessage(this.nextId("msg"), response, true));
    }
    this.end();
    this.finished = true;
    const status = typeof res.status === "string" ? res.status : "";
    const errText =
      typeof res.error === "string"
        ? res.error
        : res.error &&
            typeof res.error === "object" &&
            typeof (res.error as Json).message === "string"
          ? String((res.error as Json).message)
          : "";
    const failed = !!errText || (status !== "" && status !== "SUCCESS");
    if (failed) {
      this.sink.done("failed", errText || `Antigravity stopped (${status || "error"})`);
    } else {
      this.sink.done("completed");
    }
  }

  end(): void {
    this.closeStreaming();
    for (const it of this.tools.values()) this.sink.completed({ ...it, status: "failed" });
    this.tools.clear();
  }

  get done(): boolean {
    return this.finished;
  }

  private appendText(delta: string, stepKey?: string): void {
    if (!this.streaming) {
      const id = this.nextId("msg");
      this.streaming = { id, text: "", stepKey };
      this.sink.started(agentMessage(id, "", false));
    }
    this.streaming.text += delta;
    this.sink.delta(this.streaming.id, delta);
  }

  private streamEvent(e: Json): void {
    if (e.type === "content_block_start") {
      const block = (e.content_block ?? {}) as Json;
      if (block.type === "text") {
        this.closeStreaming();
        const id = this.nextId("msg");
        this.streaming = { id, text: "" };
        this.sink.started(agentMessage(id, "", false));
      }
    } else if (e.type === "content_block_delta") {
      const d = (e.delta ?? {}) as Json;
      if (d.type === "text_delta" && typeof d.text === "string") this.appendText(d.text);
    }
  }

  private closeStreaming(): void {
    if (!this.streaming) return;
    const { id, text } = this.streaming;
    this.streaming = null;
    if (text) {
      this.emittedMessage = true;
      this.sink.completed(agentMessage(id, text, true));
    }
  }

  private assistant(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const b of content as Json[]) {
      if (b.type === "text" && typeof b.text === "string") {
        const id = this.streaming?.id ?? this.nextId("msg");
        this.streaming = null;
        if (b.text.trim()) {
          this.emittedMessage = true;
          this.sink.completed(agentMessage(id, b.text, true));
        }
      } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        this.sink.completed(reasoning(this.nextId("think"), b.thinking, true));
      } else if (b.type === "tool_use" && typeof b.id === "string") {
        this.closeStreaming();
        const item = this.toolItem(b.id, String(b.name ?? "tool"), (b.input ?? {}) as Json);
        this.tools.set(b.id, item);
        this.sink.started(item);
      }
    }
  }

  private toolItem(useId: string, name: string, input: Json): Item {
    const id = `${this.prefix}-tool-${useId}`;
    const s = (...keys: string[]) => {
      for (const k of keys) if (typeof input[k] === "string") return input[k] as string;
      return "";
    };
    const rel = (p: string) => (p && path.isAbsolute(p) ? path.relative(this.cwd, p) || p : p);
    switch (name) {
      case "Bash":
      case "run_command":
        return command(id, s("command", "CommandLine"), this.cwd, { status: "inProgress" });
      case "Read":
      case "read_file": {
        const p = s("file_path", "Path", "AbsolutePath", "path");
        const cmd = `read ${rel(p)}`;
        return command(id, cmd, this.cwd, {
          status: "inProgress",
          actions: [{ type: "read", command: cmd, name: path.basename(p), path: p }],
        });
      }
      case "Edit":
      case "edit_file":
        return fileChange(
          id,
          [
            {
              path: rel(s("file_path", "Path", "path")),
              kind: "update",
              diff: replaceDiff(s("old_string", "Target"), s("new_string", "Replacement")),
            },
          ],
          "inProgress",
        );
      case "Write":
      case "write_file":
      case "write_to_file":
        return fileChange(
          id,
          [
            {
              path: rel(s("file_path", "Path", "TargetFile", "path")),
              kind: "add",
              diff: replaceDiff("", s("content", "Content", "CodeContent")),
            },
          ],
          "inProgress",
        );
      case "WebSearch":
      case "search_web":
        return webSearch(id, s("query"), false);
      default:
        return toolCall(id, name, input, "inProgress");
    }
  }

  private toolResults(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const b of content as Json[]) {
      if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const item = this.tools.get(b.tool_use_id);
      if (!item) continue;
      this.tools.delete(b.tool_use_id);
      const failed = b.is_error === true;
      this.sink.completed(finish(item, failed, textOf(b.content)));
    }
  }

  private legacyResult(ev: Json): void {
    this.closeStreaming();
    if (typeof ev.result === "string" && ev.result.trim() && !this.emittedMessage) {
      this.emittedMessage = true;
      this.sink.completed(agentMessage(this.nextId("msg"), ev.result, true));
    }
    this.end();
    this.finished = true;
    const failed =
      ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success");
    if (failed) {
      const why =
        (typeof ev.result === "string" && ev.result) ||
        (typeof ev.error === "string" && ev.error) ||
        String(ev.subtype ?? "Antigravity stopped with an error");
      this.sink.done("failed", why);
    } else this.sink.done("completed");
  }
}

export function extractUsage(ev: Json): FallbackUsage | null {
  const info = (ev.rate_limit_info ??
    ev.rateLimits ??
    ev.rate_limits ??
    ev.quota ??
    ev.utilization) as Json | undefined;
  if (!info || typeof info !== "object") return null;
  const limits = Array.isArray(info.limits) ? (info.limits as Json[]) : [];
  const weeklyFromLimits =
    limits.find((l) => l && l.kind === "weekly_all") ??
    limits.find((l) => l && l.group === "weekly");
  const sec = (info.secondary ?? info.seven_day ?? info.weekly ?? weeklyFromLimits) as
    Json | undefined;
  const pri = (info.primary ?? info.five_hour) as Json | undefined;
  const rem = (w: Json | undefined): number | null => {
    if (!w || typeof w !== "object") return null;
    const pctLeft =
      typeof w.remaining === "number"
        ? w.remaining
        : typeof w.remaining_percent === "number"
          ? w.remaining_percent
          : typeof w.remainingPercent === "number"
            ? w.remainingPercent
            : null;
    if (pctLeft !== null) return clamp01(pctLeft > 1 ? pctLeft / 100 : pctLeft);
    const pctUsed =
      typeof w.usedPercent === "number"
        ? w.usedPercent
        : typeof w.used_percent === "number"
          ? w.used_percent
          : typeof w.used_percentage === "number"
            ? w.used_percentage
            : typeof w.usedPercentage === "number"
              ? w.usedPercentage
              : typeof w.percent === "number"
                ? w.percent
                : null;
    if (pctUsed !== null) return clamp01(1 - (pctUsed > 1 ? pctUsed / 100 : pctUsed));
    if (typeof w.utilization === "number")
      return clamp01(1 - (w.utilization > 1 ? w.utilization / 100 : w.utilization));
    return null;
  };
  const resets = (w: Json | undefined): number | null => {
    const raw = w?.resetsAt ?? w?.resets_at;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
    if (typeof raw === "string" && raw.trim()) {
      const ms = Date.parse(raw);
      return Number.isFinite(ms) ? ms : null;
    }
    return null;
  };
  let weeklyRemaining = rem(sec);
  let weeklyResetsAt = resets(sec);
  let primaryRemaining = rem(pri);
  let primaryResetsAt = resets(pri);
  const kind = typeof info.rateLimitType === "string" ? info.rateLimitType : "";
  const win = typeof info.window === "string" ? info.window : "";
  if (weeklyRemaining === null && (kind.startsWith("seven_day") || win === "weekly")) {
    weeklyRemaining = rem(info);
    weeklyResetsAt = resets(info);
  } else if (primaryRemaining === null && (kind === "five_hour" || win === "five_hour")) {
    primaryRemaining = rem(info);
    primaryResetsAt = resets(info);
  }
  if (weeklyRemaining === null && primaryRemaining === null) return null;
  return {
    weeklyRemaining,
    weeklyResetsAt,
    primaryRemaining,
    primaryResetsAt,
    updatedAt: Date.now(),
  };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return (c as Json[])
      .map((p) => (typeof p.text === "string" ? p.text : p.type === "image" ? "[image]" : ""))
      .join("\n");
  return "";
}

function finish(item: Item, failed: boolean, out: string): Item {
  const done = { completedAtMs: Date.now() };
  switch (item.type) {
    case "commandExecution": {
      const read = (item.commandActions as { type: string }[]).some((a) => a.type === "read");
      return {
        ...item,
        ...done,
        status: failed ? "failed" : "completed",
        exitCode: failed ? 1 : 0,
        aggregatedOutput: read && !failed ? "" : out,
      };
    }
    case "fileChange":
      return { ...item, ...done, status: failed ? "failed" : "completed" };
    case "webSearch":
      return { ...item, ...done };
    default:
      return {
        ...item,
        ...done,
        status: failed ? "failed" : "completed",
        success: !failed,
        contentItems: out ? [{ type: "inputText", text: out.slice(0, 20_000) }] : null,
      };
  }
}
