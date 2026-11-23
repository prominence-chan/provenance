#!/usr/bin/env node
// A stand-in for the `claude` CLI (scripts/fallback-check.ts, scripts/welcome-e2e.ts): answers the
// health checks and prints a short `-p --output-format stream-json` turn shaped like Claude Code
// 2.1's. Each run appends {argv, stdin} to $FAKE_CLI_LOG. FAKE_SLOW=1: waits 30 s mid-turn (for
// interrupts); FAKE_FAIL=1: the turn ends with an error result.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (argv[0] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  console.log(
    JSON.stringify({
      loggedIn: process.env.FAKE_SIGNED_OUT !== "1",
      authMethod: "claude.ai",
      subscriptionType: "pro",
      email: "someone@example.com",
    }),
  );
  process.exit(process.env.FAKE_SIGNED_OUT === "1" ? 1 : 0);
}
if (argv[0] === "--help") {
  console.log(
    `Usage: claude [options]\n  --model <model>   Model for the current session. Use an\n                    alias for the latest model (e.g.\n                    'fable', 'opus', or 'sonnet') or a\n                    model's full name.\n  --effort <level>  Effort level for the current session\n                    (low, medium, high, xhigh, max)\n  -n, --name <name>  Name`,
  );
  process.exit(0);
}
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", async () => {
  if (process.env.FAKE_CLI_LOG)
    appendFileSync(
      process.env.FAKE_CLI_LOG,
      JSON.stringify({ cli: "claude", argv, stdin, cwd: process.cwd() }) + "\n",
    );
  const r = argv.indexOf("--resume");
  const session = r >= 0 ? argv[r + 1] : randomUUID();
  out({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: session,
    tools: ["Bash", "Read"],
  });
  out({
    type: "stream_event",
    event: { type: "message_start", message: { id: "msg_1" } },
    session_id: session,
    parent_tool_use_id: null,
  });
  out({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    session_id: session,
    parent_tool_use_id: null,
  });
  for (const t of ["Looking ", "at it."])
    out({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
      session_id: session,
      parent_tool_use_id: null,
    });
  out({
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      content: [{ type: "text", text: "Looking at it." }],
    },
    session_id: session,
    parent_tool_use_id: null,
  });
  out({
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "echo hi", description: "say hi" },
        },
      ],
    },
    session_id: session,
    parent_tool_use_id: null,
  });
  if (process.env.FAKE_SLOW === "1") await new Promise((res) => setTimeout(res, 30_000));
  out({
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "hi", is_error: false }],
    },
    session_id: session,
    parent_tool_use_id: null,
  });
  out({
    type: "assistant",
    message: {
      id: "msg_2",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Edit",
          input: { file_path: process.cwd() + "/a.txt", old_string: "one", new_string: "two" },
        },
      ],
    },
    session_id: session,
    parent_tool_use_id: null,
  });
  out({
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: "toolu_2", type: "tool_result", content: "ok", is_error: false }],
    },
    session_id: session,
    parent_tool_use_id: null,
  });
  out({
    type: "assistant",
    message: {
      id: "msg_3",
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_s", name: "Read", input: { file_path: "x" } }],
    },
    session_id: session,
    parent_tool_use_id: "toolu_task",
  });
  const answer = `Done (${r >= 0 ? "resumed" : "new"} session).`;
  out({
    type: "assistant",
    message: { id: "msg_4", role: "assistant", content: [{ type: "text", text: answer }] },
    session_id: session,
    parent_tool_use_id: null,
  });
  if (process.env.FAKE_FAIL === "1")
    out({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Something broke",
      session_id: session,
    });
  else
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      result: answer,
      session_id: session,
    });
});
