// Claude Code's `claude -p --output-format stream-json --verbose --include-partial-messages`
// output, one JSON object per line, turned into thread items:
//
//   system/init {session_id}                       -> the session to --resume next turn
//   stream_event content_block_start/delta (text)   -> an agentMessage that streams
//   assistant {message.content: [text | thinking | tool_use]}
//        text      -> that agentMessage, complete
//        thinking  -> reasoning
//        tool_use  -> Bash: a command; Read / Grep / Glob / LS: a command with its action (so the
//                     tool group says "read 2 files"); Edit / Write / MultiEdit / NotebookEdit: a
//                     file change; WebSearch: a web search; anything else: a tool call
//   user {message.content: [tool_result]}           -> that tool item, complete (output, failed)
//   result {subtype, is_error, result}              -> the turn ends
//
// Sub-agent traffic (parent_tool_use_id set) is left out: the Task call itself shows as one tool row.

import path from "node:path";
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

export class ClaudeStream {
  private sink: Sink;
  private cwd: string;
  private prefix: string;
  /** The agentMessage streaming now (content_block_start text .. its assistant message). */
  private streaming: { id: string; text: string } | null = null;
  private tools = new Map<string, Item>();
  private n = 0;
  private finished = false;

  constructor(sink: Sink, cwd: string, prefix: string) {
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
      return; // a stray non-JSON line (a warning): nothing to show
    }
    if (ev.parent_tool_use_id) return;
    switch (ev.type) {
      case "system":
        if (typeof ev.session_id === "string" && ev.subtype === "init")
          this.sink.session(ev.session_id);
        return;
      case "stream_event":
        return this.streamEvent((ev.event ?? {}) as Json);
      case "assistant":
        return this.assistant(((ev.message ?? {}) as Json).content);
      case "user":
        return this.toolResults(((ev.message ?? {}) as Json).content);
      case "result":
        return this.result(ev);
      default:
        return;
    }
  }

  /** The process ended without a result line (killed, crashed). */
  end(): void {
    this.closeStreaming();
    for (const it of this.tools.values()) this.sink.completed({ ...it, status: "failed" });
    this.tools.clear();
  }

  get done(): boolean {
    return this.finished;
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
      if (d.type === "text_delta" && typeof d.text === "string" && this.streaming) {
        this.streaming.text += d.text;
        this.sink.delta(this.streaming.id, d.text);
      }
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
      case "Bash":
        return command(id, s("command"), this.cwd, { status: "inProgress" });
      case "Read": {
        const p = s("file_path");
        const cmd = `read ${rel(p)}`;
        return command(id, cmd, this.cwd, {
          status: "inProgress",
          actions: [{ type: "read", command: cmd, name: path.basename(p), path: p }],
        });
      }
      case "Grep": {
        const cmd = `grep ${s("pattern")}${s("path") ? ` ${rel(s("path"))}` : ""}`;
        return command(id, cmd, this.cwd, {
          status: "inProgress",
          actions: [
            { type: "search", command: cmd, query: s("pattern"), path: rel(s("path")) || null },
          ],
        });
      }
      case "Glob":
      case "LS": {
        const cmd = name === "Glob" ? `glob ${s("pattern")}` : `ls ${rel(s("path"))}`;
        return command(id, cmd, this.cwd, {
          status: "inProgress",
          actions:
            name === "Glob"
              ? [
                  {
                    type: "search",
                    command: cmd,
                    query: s("pattern"),
                    path: rel(s("path")) || null,
                  },
                ]
              : [{ type: "listFiles", command: cmd, path: rel(s("path")) || null }],
        });
      }
      case "Edit":
        return fileChange(
          id,
          [
            {
              path: rel(s("file_path")),
              kind: "update",
              diff: replaceDiff(s("old_string"), s("new_string")),
            },
          ],
          "inProgress",
        );
      case "MultiEdit": {
        const edits = Array.isArray(input.edits) ? (input.edits as Json[]) : [];
        const diff = edits
          .map((e) => replaceDiff(String(e.old_string ?? ""), String(e.new_string ?? "")))
          .join("\n");
        return fileChange(id, [{ path: rel(s("file_path")), kind: "update", diff }], "inProgress");
      }
      case "Write":
        return fileChange(
          id,
          [{ path: rel(s("file_path")), kind: "add", diff: replaceDiff("", s("content")) }],
          "inProgress",
        );
      case "NotebookEdit":
        return fileChange(
          id,
          [
            {
              path: rel(s("notebook_path")),
              kind: "update",
              diff: replaceDiff("", s("new_source")),
            },
          ],
          "inProgress",
        );
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
      const out = resultText(b.content);
      this.sink.completed(finish(item, failed, out));
    }
  }

  private result(ev: Json): void {
    this.end();
    this.finished = true;
    const failed =
      ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success");
    if (failed) {
      const why =
        (typeof ev.result === "string" && ev.result) ||
        (Array.isArray(ev.errors) && ev.errors.join("; ")) ||
        String(ev.subtype ?? "Claude Code stopped with an error");
      this.sink.done("failed", why);
    } else this.sink.done("completed");
  }
}

function resultText(c: unknown): string {
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
      // A Read's output is the file itself: keep the row, not the text.
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
