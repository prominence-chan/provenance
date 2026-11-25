#!/usr/bin/env node
// A stand-in for the `agy` (Antigravity) CLI (scripts/fallback-check.ts, scripts/subagents-e2e.ts):
// mirrors real `agy`:
//   --version   -> stdout "1.5.14"
//   --help      -> stderr usage text (Go flag package writes help to stderr)
//   models      -> stdout TSV rows (`id\tLabel`)
//   -p /usage   -> stdout TSV weekly + 5h remaining limits per model group
//   --input-format stream-json --output-format stream-json -> reads {"event":"user",...} on stdin
//                  and emits init, step_update (tool + agent_response text_delta), and result.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (argv[0] === "--version") {
  console.log("1.5.14");
  process.exit(0);
}
if (argv[0] === "--help") {
  console.error(
    `Usage of antigravity:\n  --model                         Model for the current CLI session\n  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)\n  --conversation                  Resume a previous conversation by ID`,
  );
  process.exit(0);
}
if (argv[0] === "-p" && argv[1] === "/usage") {
  console.log("Gemini Models\tWeekly Limit Remaining\t92%\t2026-12-01T14:47:23Z");
  console.log("Gemini Models\tFive Hour Limit Remaining\t93%\t2026-11-25T08:13:55Z");
  console.log("Claude and GPT models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z");
  console.log("Claude and GPT models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z");
  process.exit(0);
}
if (argv[0] === "models") {
  if (process.env.FAKE_SIGNED_OUT === "1") {
    console.error("Not signed in. Run `agy login` to authenticate.");
    process.exit(1);
  }
  console.log("gemini-4-neon-high\tGemini 4 Neon (High)");
  console.log("gemini-4-neon-medium\tGemini 4 Neon (Medium)");
  console.log("claude-sonnet-4-6\tClaude Sonnet 4.6");
  process.exit(0);
}

// Mirror real agy guard against `-p --output-format ...`
const pIdx = argv.indexOf("-p");
if (pIdx >= 0 && argv[pIdx + 1]?.startsWith("--")) {
  console.error(
    `Error: -p took "${argv[pIdx + 1]}" as its prompt, so the intended prompt was left as an argument and ignored.`,
  );
  process.exit(2);
}

let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLI_LOG)
    appendFileSync(
      process.env.FAKE_CLI_LOG,
      JSON.stringify({ cli: "agy", argv, stdin, cwd: process.cwd() }) + "\n",
    );
  const convIdx = argv.indexOf("--conversation");
  const session = convIdx >= 0 ? argv[convIdx + 1] : randomUUID();
  const reply = `Antigravity handled it (${convIdx >= 0 ? "resumed" : "new"}).`;
  out({
    event: "init",
    conversation_id: session,
    init: {
      cwd: process.cwd(),
      tools: ["run_command", "read_file"],
      permission_mode: "accept-edits",
    },
  });
  out({
    event: "step_update",
    step_update: {
      conversation_id: session,
      step_index: 0,
      state: "DONE",
      step_type: "user_input",
    },
  });
  out({
    event: "step_update",
    step_update: {
      conversation_id: session,
      step_index: 1,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "echo agy_ok" },
        output: "agy_ok\n",
      },
    },
  });
  out({
    event: "step_update",
    step_update: {
      conversation_id: session,
      step_index: 2,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: "Antigravity handled ",
    },
  });
  out({
    event: "step_update",
    step_update: {
      conversation_id: session,
      step_index: 2,
      state: "DONE",
      step_type: "agent_response",
      text_delta: `it (${convIdx >= 0 ? "resumed" : "new"}).`,
    },
  });
  out({
    event: "result",
    result: {
      conversation_id: session,
      status: "SUCCESS",
      response: reply,
      num_turns: 1,
    },
  });
});
