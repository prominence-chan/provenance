#!/usr/bin/env node
// A stand-in for the `agy` (Antigravity) CLI (scripts/fallback-check.ts, scripts/subagents-e2e.ts):
// answers --version, --help, models, and prints a short `-p --output-format stream-json` turn with
// a rate_limit_event carrying weekly remaining usage.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (argv[0] === "--version") {
  console.log("1.5.14");
  process.exit(0);
}
if (argv[0] === "--help") {
  console.log(
    `Usage: agy [options]\n  --model <model>         Model to use\n  --effort <level>        Reasoning effort level (low, medium, high, xhigh, max)\n  --conversation <id>     Resume an existing conversation`,
  );
  process.exit(0);
}
if (argv[0] === "models") {
  if (process.env.FAKE_SIGNED_OUT === "1") {
    console.error("Not signed in. Run `agy login` to authenticate.");
    process.exit(1);
  }
  console.log("gemini-4-neon-high             Gemini 4 Neon (High)");
  console.log("gemini-4-neon-medium           Gemini 4 Neon (Medium)");
  console.log("claude-sonnet-4-6              Claude Sonnet 4.6");
  process.exit(0);
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
  out({ type: "system", subtype: "init", conversation_id: session });
  out({
    type: "rate_limit_event",
    rate_limit_info: {
      weekly: { remaining_percent: 78, resets_at: Date.now() + 3 * 86_400_000 },
      primary: { remaining_percent: 92, resets_at: Date.now() + 2 * 3_600_000 },
    },
  });
  out({
    type: "assistant",
    message: {
      id: "agy_msg_1",
      role: "assistant",
      content: [
        { type: "text", text: `Antigravity handled it (${convIdx >= 0 ? "resumed" : "new"}).` },
      ],
    },
    conversation_id: session,
  });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `Antigravity handled it (${convIdx >= 0 ? "resumed" : "new"}).`,
    conversation_id: session,
  });
});
