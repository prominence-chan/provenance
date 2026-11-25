// Stock Codex's `codex exec --json` output, one JSON event per line, turned into thread items:
//
//   thread.started {thread_id}              -> the session to `codex exec resume` next turn
//   item.started / item.updated / item.completed {item}
//        agent_message      -> agentMessage          reasoning     -> reasoning
//        command_execution  -> commandExecution      file_change   -> fileChange (paths, no diff)
//        mcp_tool_call      -> mcpToolCall           web_search    -> webSearch
//        todo_list          -> plan                  error         -> a note on the turn
//   turn.completed                           -> done
//   turn.failed {error}, error {message}     -> failed / a note
//
// exec prints whole items (no text deltas), so a message appears when it is complete.

import type { FallbackUsage } from "../../shared/fallback-api.ts";
import { extractUsage } from "./agy-stream.ts";
import {
  agentMessage,
  command,
  fileChange,
  mcpCall,
  plan,
  reasoning,
  unwrapShell,
  webSearch,
  type ChangeKind,
  type Item,
  type Sink,
} from "./items.ts";

export interface CodexSink extends Sink {
  usage?: (u: FallbackUsage) => void;
}

type Json = Record<string, unknown>;

export class CodexStream {
  private sink: CodexSink;
  private cwd: string;
  private prefix: string;
  private open = new Map<string, Item>();
  private finished = false;

  constructor(sink: CodexSink, cwd: string, prefix: string) {
    this.sink = sink;
    this.cwd = cwd;
    this.prefix = prefix;
  }

  get done(): boolean {
    return this.finished;
  }

  line(raw: string): void {
    let ev: Json;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    switch (ev.type) {
      case "thread.started":
        if (typeof ev.thread_id === "string") this.sink.session(ev.thread_id);
        return;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const it = (ev.item ?? {}) as Json;
        const done = ev.type === "item.completed";
        if (it.type === "error") {
          if (done) this.sink.error(String(it.message ?? "error"), false);
          return;
        }
        const item = this.toItem(it, done);
        if (!item) return;
        if (done) {
          this.open.delete(item.id);
          this.sink.completed(item);
        } else {
          this.open.set(item.id, item);
          this.sink.started(item);
        }
        return;
      }
      case "turn.completed":
        this.end();
        this.finished = true;
        this.sink.done("completed");
        return;
      case "turn.failed": {
        this.end();
        this.finished = true;
        const err = (ev.error ?? {}) as Json;
        this.sink.done("failed", String(err.message ?? "Codex stopped with an error"));
        return;
      }
      case "error":
        this.sink.error(String(ev.message ?? "error"), false);
        return;
      case "rate_limit_event":
      case "rate_limits": {
        const u = extractUsage(ev);
        if (u) this.sink.usage?.(u);
        return;
      }
      default: {
        const u = extractUsage(ev);
        if (u) this.sink.usage?.(u);
        return;
      }
    }
  }

  end(): void {
    for (const it of this.open.values())
      this.sink.completed(
        it.status === "inProgress"
          ? { ...it, status: "failed", completedAtMs: Date.now() }
          : { ...it, completedAtMs: Date.now() },
      );
    this.open.clear();
  }

  private toItem(it: Json, done: boolean): Item | null {
    const id = `${this.prefix}-${String(it.id ?? "item")}`;
    const status = (s: unknown): "inProgress" | "completed" | "failed" | "declined" =>
      s === "in_progress"
        ? "inProgress"
        : s === "failed"
          ? "failed"
          : s === "declined"
            ? "declined"
            : done
              ? "completed"
              : "inProgress";
    switch (it.type) {
      case "agent_message":
        return agentMessage(id, String(it.text ?? ""), done);
      case "reasoning":
        return reasoning(id, String(it.text ?? ""), done);
      case "command_execution":
        return command(id, unwrapShell(String(it.command ?? "")), this.cwd, {
          status: status(it.status),
          output: typeof it.aggregated_output === "string" ? it.aggregated_output : null,
          exitCode: typeof it.exit_code === "number" ? it.exit_code : null,
        });
      case "file_change": {
        const changes = Array.isArray(it.changes) ? (it.changes as Json[]) : [];
        return fileChange(
          id,
          changes.map((c) => ({
            path: String(c.path ?? ""),
            kind: (["add", "delete", "update"].includes(String(c.kind))
              ? c.kind
              : "update") as ChangeKind,
            diff: "",
          })),
          status(it.status),
        );
      }
      case "mcp_tool_call": {
        const err = (it.error ?? null) as Json | null;
        const s = status(it.status);
        return mcpCall(
          id,
          String(it.server ?? "mcp"),
          String(it.tool ?? "tool"),
          it.arguments,
          s === "declined" ? "failed" : s,
          it.result ?? null,
          err ? String(err.message ?? "failed") : null,
        );
      }
      case "web_search":
        return webSearch(id, String(it.query ?? ""), done);
      case "todo_list": {
        const items = Array.isArray(it.items) ? (it.items as Json[]) : [];
        const text = items
          .map((t) => `- [${t.completed ? "x" : " "}] ${String(t.text ?? "")}`)
          .join("\n");
        return plan(id, text);
      }
      default:
        return null;
    }
  }
}
