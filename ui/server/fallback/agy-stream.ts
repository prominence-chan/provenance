// Antigravity (`agy -p --output-format stream-json`) NDJSON output parser.
// Supports both Claude-style stream-json envelopes (system/init, stream_event, assistant, user,
// result) and Antigravity's native conversation/delta/tool events, falling back to plain text if
// a line is not JSON.

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
  private streaming: { id: string; text: string } | null = null;
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
      // Plain text fallback if agy prints text outside JSON
      if (raw.trim()) this.appendText(`${raw}\n`);
      return;
    }
    const sid =
      (typeof ev.conversation_id === "string" && ev.conversation_id) ||
      (typeof ev.conversationId === "string" && ev.conversationId) ||
      (typeof ev.session_id === "string" && ev.session_id) ||
      null;
    if (sid) this.sink.session(sid);

    if (ev.rate_limit_info || ev.rateLimits || ev.quota) {
      const u = extractUsage(ev);
      if (u) this.sink.usage?.(u);
    }

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
          if (content.trim()) this.sink.completed(agentMessage(id, content, true));
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
          "Antigravity hit an error";
        this.sink.error(msg, ev.fatal !== false);
        return;
      }
      case "result":
      case "done":
      case "complete":
        return this.result(ev);
      default:
        return;
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

  private appendText(d: string): void {
    if (!this.streaming) {
      const id = this.nextId("msg");
      this.streaming = { id, text: "" };
      this.sink.started(agentMessage(id, "", false));
    }
    this.streaming.text += d;
    this.sink.delta(this.streaming.id, d);
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
    if (text) this.sink.completed(agentMessage(id, text, true));
  }

  private assistant(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const b of content as Json[]) {
      if (b.type === "text" && typeof b.text === "string") {
        const id = this.streaming?.id ?? this.nextId("msg");
        this.streaming = null;
        if (b.text.trim()) this.sink.completed(agentMessage(id, b.text, true));
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
    const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
    const rel = (p: string) => (p && path.isAbsolute(p) ? path.relative(this.cwd, p) || p : p);
    switch (name) {
      case "run_command":
      case "Bash":
        return command(id, s("CommandLine") || s("command"), this.cwd, { status: "inProgress" });
      case "read_file":
      case "Read": {
        const p = s("Path") || s("file_path");
        const cmd = `read ${rel(p)}`;
        return command(id, cmd, this.cwd, {
          status: "inProgress",
          actions: [{ type: "read", command: cmd, name: path.basename(p), path: p }],
        });
      }
      case "edit_file":
      case "Edit":
        return fileChange(
          id,
          [
            {
              path: rel(s("Path") || s("file_path")),
              kind: "update",
              diff: replaceDiff(
                s("Target") || s("old_string"),
                s("Replacement") || s("new_string"),
              ),
            },
          ],
          "inProgress",
        );
      case "write_file":
      case "Write":
        return fileChange(
          id,
          [
            {
              path: rel(s("Path") || s("file_path")),
              kind: "add",
              diff: replaceDiff("", s("Content") || s("content")),
            },
          ],
          "inProgress",
        );
      case "search_web":
      case "WebSearch":
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

  private result(ev: Json): void {
    if (typeof ev.result === "string" && ev.result.trim() && !this.streaming) {
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
