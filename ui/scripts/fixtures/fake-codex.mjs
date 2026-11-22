#!/usr/bin/env node
// A stand-in for the stock `codex` CLI (scripts/fallback-check.ts, scripts/welcome-e2e.ts): answers
// the health checks and prints a short `codex exec --json` turn shaped like Codex 0.16x's. Each run
// appends {argv, stdin} to $FAKE_CLI_LOG.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (argv[0] === "--version") {
  console.log("codex-cli 9.9.9");
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  if (process.env.FAKE_SIGNED_OUT === "1") {
    console.error("Not logged in");
    process.exit(1);
  }
  console.error("Logged in using ChatGPT");
  process.exit(0);
}
if (argv[0] === "debug" && argv[1] === "models") {
  console.log(JSON.stringify({ models: [
    { slug: "fake-big", display_name: "Fake Big", visibility: "list", priority: 1 },
    { slug: "fake-hidden", display_name: "Hidden", visibility: "hide", priority: 2 },
    { slug: "fake-small", display_name: "Fake Small", visibility: "list", priority: 3 },
  ] }));
  process.exit(0);
}
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ cli: "codex", argv, stdin, cwd: process.cwd() }) + "\n");
  const resume = argv[1] === "resume";
  const id = resume ? argv[argv.length - 2] : randomUUID();
  out({ type: "thread.started", thread_id: id });
  out({ type: "turn.started" });
  out({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Checking** the folder" } });
  out({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'ls'", aggregated_output: "", exit_code: null, status: "in_progress" } });
  out({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'ls'", aggregated_output: "a.txt\n", exit_code: 0, status: "completed" } });
  out({ type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: "a.txt", kind: "update" }], status: "completed" } });
  out({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: `Done (${resume ? "resumed" : "new"} session).` } });
  out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
});
