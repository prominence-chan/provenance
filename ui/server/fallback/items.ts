// Thread items in app-server's own shapes (codex-rs app-server-protocol v2 ThreadItem), built from
// what the fallback CLIs print, so the page renders a fallback thread with the components it
// already has (commands, file edits, tool calls, thinking, messages). The server has no generated
// protocol types (they live in src/protocol), so items are plain objects here; the field names
// follow src/protocol/generated/v2/ThreadItem.ts.

export type Item = Record<string, unknown> & { id: string; type: string };

/** Where a parser sends what it reads, in app-server's terms. */
export interface Sink {
  /** A new item, or a newer version of one already started (replaces it). */
  started(item: Item): void;
  /** Text appended to an agentMessage that is streaming. */
  delta(itemId: string, text: string): void;
  completed(item: Item): void;
  /** The CLI's own session / thread id, to resume with next turn. */
  session(id: string): void;
  /** A problem the CLI reported; `fatal` ends the turn as failed. */
  error(message: string, fatal: boolean): void;
  /** The CLI finished the turn (its own final event). */
  done(status: "completed" | "failed", message?: string): void;
}

const now = () => Date.now();

export function agentMessage(id: string, text: string, done: boolean): Item {
  return {
    id,
    type: "agentMessage",
    text,
    phase: null,
    moderation: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
    startedAtMs: now(),
    completedAtMs: done ? now() : null,
  };
}

export function userMessage(id: string, text: string): Item {
  return {
    id,
    type: "userMessage",
    clientId: null,
    content: [{ type: "text", text, text_elements: [] }],
    startedAtMs: now(),
    completedAtMs: now(),
  };
}

export function reasoning(id: string, text: string, done: boolean): Item {
  return {
    id,
    type: "reasoning",
    summary: [],
    content: text ? [text] : [],
    startedAtMs: now(),
    completedAtMs: done ? now() : null,
  };
}

type Action =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

export function command(
  id: string,
  cmd: string,
  cwd: string,
  opts: {
    status: "inProgress" | "completed" | "failed" | "declined";
    output?: string | null;
    exitCode?: number | null;
    actions?: Action[];
    durationMs?: number | null;
  },
): Item {
  return {
    id,
    type: "commandExecution",
    command: cmd,
    cwd,
    processId: null,
    pluginId: null,
    scriptPath: null,
    source: "agent",
    status: opts.status,
    commandActions: opts.actions ?? [],
    aggregatedOutput: opts.output ?? null,
    exitCode: opts.exitCode ?? null,
    durationMs: opts.durationMs ?? null,
    startedAtMs: now(),
    completedAtMs: opts.status === "inProgress" ? null : now(),
  };
}

export type ChangeKind = "add" | "delete" | "update";

export function fileChange(
  id: string,
  changes: { path: string; kind: ChangeKind; diff: string }[],
  status: "inProgress" | "completed" | "failed" | "declined",
): Item {
  return {
    id,
    type: "fileChange",
    changes: changes.map((c) => ({
      path: c.path,
      kind: c.kind === "update" ? { type: "update", move_path: null } : { type: c.kind },
      diff: c.diff,
    })),
    status,
    startedAtMs: now(),
    completedAtMs: status === "inProgress" ? null : now(),
  };
}

export function toolCall(
  id: string,
  tool: string,
  args: unknown,
  status: "inProgress" | "completed" | "failed",
  output?: string | null,
): Item {
  return {
    id,
    type: "dynamicToolCall",
    namespace: null,
    tool,
    arguments: args ?? null,
    status,
    contentItems: output ? [{ type: "inputText", text: output }] : null,
    success: status === "inProgress" ? null : status === "completed",
    durationMs: null,
    startedAtMs: now(),
    completedAtMs: status === "inProgress" ? null : now(),
  };
}

export function mcpCall(
  id: string,
  server: string,
  tool: string,
  args: unknown,
  status: "inProgress" | "completed" | "failed",
  result: unknown,
  error: string | null,
): Item {
  return {
    id,
    type: "mcpToolCall",
    server,
    tool,
    environmentId: null,
    status,
    arguments: args ?? null,
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
    result: result ?? null,
    error: error ? { message: error } : null,
    durationMs: null,
    startedAtMs: now(),
    completedAtMs: status === "inProgress" ? null : now(),
  };
}

export function webSearch(id: string, query: string, done: boolean): Item {
  return {
    id,
    type: "webSearch",
    query,
    action: { type: "search", query, queries: null },
    results: null,
    startedAtMs: now(),
    completedAtMs: done ? now() : null,
  };
}

export function plan(id: string, text: string): Item {
  return { id, type: "plan", text, startedAtMs: now(), completedAtMs: now() };
}

/** A unified-diff-ish body for one replaced string (Claude Code's Edit), so +/- counts read right. */
export function replaceDiff(oldText: string, newText: string): string {
  const lines = (s: string, mark: string) =>
    s === ""
      ? []
      : s
          .replace(/\n$/, "")
          .split("\n")
          .map((l) => mark + l);
  return ["@@", ...lines(oldText, "-"), ...lines(newText, "+")].join("\n");
}

/** "/bin/zsh -lc 'npm test'" -> "npm test" (Codex wraps every command in the shell). */
export function unwrapShell(cmd: string): string {
  const m = /^\/bin\/(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(cmd);
  return m ? m[1].replace(/'\\''/g, "'") : cmd;
}

/** turn/start's additionalContext ({key: {value, kind}}) as one text, in key order. */
export function contextText(ctx: unknown): string {
  if (!ctx || typeof ctx !== "object") return "";
  return Object.keys(ctx as Record<string, unknown>)
    .sort()
    .map((k) => (ctx as Record<string, { value?: unknown } | null>)[k]?.value)
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .join("\n\n");
}
