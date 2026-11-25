// Offline check of the orchestrators' server side (server/orchestrator/): the parsers, the notes,
// and both orchestrators end to end over a real WebSocket, against a stand-in router (an HTTP
// server that answers POST /v1/responses as a stream, scripted per role) and a stand-in
// app-server (scripts/fixtures/fake-orc-appserver.mjs). No model, no account, nothing on screen.
//
//   npm run check:orchestrator
//
// Covers: plan / action / report parsing with messy input; notes staying under their bound;
// Experimental: a multi-task job, a direct answer, a follow-up planned from the notes, a blocker
// and a revised plan, the caps (tries per task, tasks, model calls), interrupt, a worker's
// approval relayed to the page, router and capacity errors ending the turn; Hyperexperimental: a
// job over three steps (write, run, replace), each call a single-message request, the summary
// bound, the sandbox policy each action is run with, the loop guards, interrupt, "Ask every
// time", read only, a router error; threads read back by a new backend, a turn cut off by a crash.
// And what the benchmark asked for: a model call that fails is retried with a wait and a status
// line (then succeeds; or gives up, keeps the notes / summary, and "continue" resumes); an empty
// reply sent as response.failed is retried; interrupt during a wait; a worker whose model request
// failed is run again; file bodies lifted from the think text and written verbatim; a WRITE with
// no content refused and fed back; a plan that only looks gets a producing task, and a missing
// deliverable is said; a worker out of budget is stopped and the plan revised; a planner that
// declines is asked again; guards that ignore a wall clock jumping a day; the PATH a RUN sees.
// And what the second benchmark round asked for: the finish check (a reviewer only when it can
// add something, given the evidence; its checks run by code; a fix task only for a check that
// fails, and none when the budget is nearly gone); what a command is (a look, or more);
// Hyperexperimental's working memory (the log, kept facts, pinned files that rotate, long outputs
// saved and shown head and tail), actions read straight from the think text, repeats answered
// from memory, the look limit and the no-progress stop, paths read against the folder and the
// request; Experimental's revision discipline and a worker's context budget with its hand-over;
// and two long jobs (twelve files with long outputs; a worker whose context fills up three times)
// in which the largest prompt of every role and the largest request of every worker stay within
// budget for the whole run.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { AppServerProcess } from "../server/orchestrator/appserver.ts";
import {
  capsFromEnv,
  DEFAULT_CAPS,
  OrchestratorBackend,
  RETRY_DELAYS_MS,
  WORKER_CALLS,
  WORKER_MINUTES,
  type TraceEvent,
} from "../server/orchestrator/backend.ts";
import {
  changedSince,
  codeFindings,
  createContextState,
  deliverablesIn,
  findingLines,
  finishText,
  followUpTask,
  snapshot,
  unwrap,
  updateContextState,
} from "../server/orchestrator/experimental.ts";
import {
  captureScript,
  filesLooked,
  lineDiff,
  mustAsk,
  normaliseRun,
  parseCapturedEnv,
  replaceIn,
  resolveTarget,
  userShell,
} from "../server/orchestrator/hyper.ts";
import {
  addApproval,
  addCommand,
  addDone,
  addFile,
  addProblem,
  addRequest,
  emptyNotes,
  failureDigest,
  mergeHandover,
  NOTES_LIMIT,
  notesText,
  renderHandover,
  reportSections,
} from "../server/orchestrator/notes.ts";
import {
  balanceFences,
  directPlan,
  keepLines,
  lookOnly,
  looksLikeShell,
  tidyFences,
  isContinue,
  liftCommands,
  liftFiles,
  looksLikeRefusal,
  parseActions,
  parsePlan,
  parseReport,
  parseThought,
  planProduces,
  restoreCommand,
  restorePath,
} from "../server/orchestrator/parse.ts";
import {
  BRIEF_BUDGET,
  foldPrompt,
  HANDOVER_BRIEF_BUDGET,
  ONE_WORKER_CHARS,
  plannerPrompt,
  PROMPT_BUDGET,
  reviewPrompt,
  revisePrompt,
  SUMMARY_LIMIT,
  THINK_BUDGET,
  thinkPrompt,
  thinkRoom,
  translatePrompt,
  WORKER_BASE,
  workerBrief,
} from "../server/orchestrator/prompts.ts";
import {
  commandsEvidence,
  reviewWorth,
  tailOf,
  uncheckedOf,
  unsafeCheck,
  type Check,
} from "../server/orchestrator/finish.ts";
import {
  addKept,
  addLog,
  emptyMemory,
  foldByCode,
  MAX_PINS,
  MEMORY_LIMIT,
  needsFold,
  pin,
  PINS_LIMIT,
  renderMemory,
  renderPins,
  RESULTS_MAX,
  showOutput,
  takeForFold,
} from "../server/orchestrator/memory.ts";
import {
  exactNames,
  nearMiss,
  numbered,
  parseChecks,
  requestExcerpt,
  requestLines,
  strayPaths,
} from "../server/orchestrator/request.ts";
import { makeCallModel, RouterError } from "../server/orchestrator/router.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a: unknown[]) => console.log("[orchestrator-check]", ...a);
function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`expected: ${what}`);
  log(`  ok: ${what}`);
}

// ---- parsers ----------------------------------------------------------------------------------
log("plan parser");
{
  const p = parsePlan(`Here's the plan:

**Task 1:** Create \`mathx.py\` with add and mul
- Done when: the file imports cleanly
2) Write test_mathx.py covering both functions (done when: tests exist)
### Step 3 - Run the tests
   with pytest -q
Acceptance: pytest passes

Let me know if you want changes!`);
  check(
    p.tasks.length === 3,
    `three tasks out of bold, "2)" and "### Step 3 -" (${p.tasks.length})`,
  );
  check(
    p.tasks[0].title === "Create `mathx.py` with add and mul" &&
      p.tasks[0].done === "the file imports cleanly",
    "task 1: title, and its done-criteria from the bullet under it",
  );
  check(
    p.tasks[1].title === "Write test_mathx.py covering both functions" &&
      p.tasks[1].done === "tests exist",
    "task 2: done-criteria taken out of the parentheses",
  );
  check(
    p.tasks[2].title === "Run the tests with pytest -q" && /^pytest passes/.test(p.tasks[2].done),
    `task 3: a wrapped title, "Acceptance:" as done (${JSON.stringify(p.tasks[2])})`,
  );
  const strict = parsePlan("TASK 1: A\nDONE WHEN: a\nTASK 2: B\nDONE WHEN: b\n");
  check(strict.tasks.length === 2 && strict.tasks[1].done === "b", "the format as asked for");
  const fenced = parsePlan("```\ntask 1 - do x\ndone: x works\n```");
  check(
    fenced.tasks.length === 1 && fenced.tasks[0].done === "x works",
    "lowercase, dashes, inside a fence",
  );
  const ans = parsePlan("ANSWER: The tests already pass.\nNothing to change.");
  check(
    ans.tasks.length === 0 && ans.answer === "The tests already pass.\nNothing to change.",
    "ANSWER: with no tasks is a direct reply (both lines)",
  );
  const junk = parsePlan("I am not sure what you mean.");
  check(junk.tasks.length === 0 && junk.answer === null, "prose with no list: no tasks, no answer");
  check(parsePlan("1. a\n2. b\n3. c\n4. d", 2).tasks.length === 2, "the task limit holds");
  check(
    parsePlan("TASK 1: Create textkit/__init__.py and tests/__init__.py").tasks[0].title ===
      "Create textkit/__init__.py and tests/__init__.py",
    "names with double underscores survive",
  );
}

log("action parser");
{
  const a = parseActions(`Sure, here are the actions:

1. **WRITE:** \`src/mathx.py\`
\`\`\`python
def add(a, b):
    return a + b
\`\`\`
2. RUN: \`python3 -m pytest -q\`
3. read: src/mathx.py lines 1-20
- Search: "def add" in src
LIST src
REPLACE: src/mathx.py
<<<
    return a + b
===
    return a + b  # sum
>>>
run:
\`\`\`bash
git status
\`\`\`
That's all!`);
  const kinds = a.actions.map((x) => x.kind).join(",");
  check(kinds === "write,run,read,search,list,replace,run", `seven actions in order (${kinds})`);
  const [w, r, rd, s, l, rp, r2] = a.actions;
  check(
    w.kind === "write" &&
      w.path === "src/mathx.py" &&
      w.content === "def add(a, b):\n    return a + b",
    "WRITE: backticked path, content from a code fence, indentation kept",
  );
  check(r.kind === "run" && r.command === "python3 -m pytest -q", "RUN: backticks taken off");
  check(
    rd.kind === "read" && rd.path === "src/mathx.py" && rd.start === 1 && rd.end === 20,
    "READ: a line range in words",
  );
  check(
    s.kind === "search" && s.pattern === "def add" && s.path === "src",
    "SEARCH: quoted pattern, lowercase in",
  );
  check(l.kind === "list" && l.path === "src", "LIST without a colon");
  check(
    rp.kind === "replace" &&
      rp.find === "    return a + b" &&
      rp.with === "    return a + b  # sum",
    "REPLACE: <<< old === new >>>",
  );
  check(
    r2.kind === "run" && r2.command === "git status",
    "RUN with the command in a fence under it",
  );
  const rr = parseActions("READ: a.py:10-12\nREAD: `b.py` (lines 5 to 3)\nREAD: c.py");
  const [x, y, z] = rr.actions as { path: string; start: number | null; end: number | null }[];
  check(x.path === "a.py" && x.start === 10 && x.end === 12, "READ path:10-12");
  check(y.path === "b.py" && y.start === 3 && y.end === 5, "READ (lines 5 to 3), put in order");
  check(z.path === "c.py" && z.start === null, "READ without a range");
  const twoBlocks = parseActions("EDIT: a.txt\n```\nold\n```\n```\nnew\n```");
  const tb = twoBlocks.actions[0];
  check(
    tb?.kind === "replace" && tb.find === "old" && tb.with === "new",
    "EDIT with two fences: old then new",
  );
  const both = parseActions("WRITE: a.txt\n<<<\n```\nhello\n```\n>>>");
  check(
    both.actions[0]?.kind === "write" && both.actions[0].content === "hello",
    "<<< with a fence inside it",
  );
  const none = parseActions("NONE");
  check(none.none && !none.actions.length, "NONE");
  const bad = parseActions("WRITE: a.txt\nRUN: echo hi");
  check(
    bad.actions.length === 1 &&
      bad.actions[0].kind === "run" &&
      bad.rejected.length === 1 &&
      bad.rejected[0].at === 0 &&
      /WRITE: a\.txt was not done: no content came with it/.test(bad.rejected[0].text),
    "a WRITE with no content is refused, and says where in the step it stood",
  );
  const many = parseActions(Array.from({ length: 12 }, (_, i) => `RUN: echo ${i}`).join("\n"), 6);
  check(
    many.actions.length === 6 && many.problems.length === 1,
    "the action limit holds, and says so",
  );
  const prose = parseActions("We should run the tests and read the file to find the bug.");
  check(!prose.actions.length && !prose.none, "prose that mentions run / read is not an action");
  const inSearch = parseActions("SEARCH: import os in sys IN src/app");
  const si = inSearch.actions[0];
  check(
    si?.kind === "search" && si.pattern === "import os in sys" && si.path === "src/app",
    'SEARCH splits on the last " IN "',
  );
}

log("file bodies: lifted from the think text, never copied");
{
  const thinkText = [
    "Create the script and a data file, then run it.",
    "",
    "```file:lifted.py",
    "import os",
    "# RUN: rm -rf /   (a comment that looks like an action)",
    'print("lifted", "$HOME `date` <<<")',
    "```",
    "",
    "```bash",
    "cat > here.txt <<'EOF'",
    "line one $NOT_EXPANDED",
    "WRITE: not-an-action.txt",
    "EOF",
    "python3 lifted.py",
    "```",
  ].join("\n");
  const l = liftFiles(thinkText);
  check(
    l.files.length === 2 &&
      l.files[0].path === "lifted.py" &&
      l.files[0].content ===
        'import os\n# RUN: rm -rf /   (a comment that looks like an action)\nprint("lifted", "$HOME `date` <<<")' &&
      l.files[1].path === "here.txt" &&
      l.files[1].content === "line one $NOT_EXPANDED\nWRITE: not-an-action.txt",
    "a ```file:<path> block and a complete cat > heredoc are lifted, byte for byte",
  );
  check(
    !l.plan.includes("import os") &&
      !l.plan.includes("NOT_EXPANDED") &&
      l.plan.includes(
        '[file block: lifted.py (3 lines) is held by the executor; for it output only "WRITE: lifted.py", with no content]',
      ) &&
      l.plan.includes("[file block: here.txt (2 lines)") &&
      l.plan.includes("python3 lifted.py"),
    "the plan the translator sees has a marker for each, and the commands",
  );
  const viaWrite = parseActions(
    "WRITE: lifted.py\nRUN: cat > here.txt\nRUN: python3 lifted.py",
    8,
    l.files,
  );
  check(
    viaWrite.actions.map((a) => a.kind).join() === "write,write,run" &&
      viaWrite.actions[0].kind === "write" &&
      viaWrite.actions[0].content === l.files[0].content &&
      viaWrite.actions[1].kind === "write" &&
      viaWrite.actions[1].path === "here.txt" &&
      !viaWrite.rejected.length,
    "a bare WRITE: <path> gets the lifted body; a bare cat > <path> becomes that write",
  );
  const copied = parseActions(
    "WRITE: ./lifted.py\n<<<\nimport os  # the translator's lossy copy\n>>>",
    8,
    l.files,
  );
  check(
    copied.actions.some(
      (a) => a.kind === "write" && a.path === "lifted.py" && a.content === l.files[0].content,
    ) && !copied.actions.some((a) => a.kind === "write" && a.content.includes("lossy")),
    "what the think step wrote wins over what the translator copied",
  );
  const forgot = parseActions("RUN: python3 lifted.py", 8, l.files);
  check(
    forgot.actions.map((a) => a.kind).join() === "write,write,run",
    "a lifted file no action mentions is written first",
  );
  const abs = parseActions("WRITE: recover.py,", 8, [{ path: "/w/app/recover.py", content: "x" }]);
  check(
    abs.actions.length === 1 &&
      abs.actions[0].kind === "write" &&
      abs.actions[0].path === "/w/app/recover.py",
    'a relative name with a stray comma ("WRITE: recover.py,") finds the block given by its full path',
  );
  // the three shapes the benchmark run lost a file on
  const lost1 = parseActions("RUN: cat > /w/app/recover.py");
  const lost2 = parseActions("WRITE: recover.py,\nRUN: python3 recover.py");
  const lost3 = parseActions("RUN: cat > recover.py <<'PY'\nRUN: python3 recover.py");
  check(
    !lost1.actions.length &&
      lost1.rejected.length === 1 &&
      /no heredoc body/.test(lost1.rejected[0].text) &&
      /```file:\/w\/app\/recover\.py/.test(lost1.rejected[0].text) &&
      !lost1.none,
    "cat > file with no heredoc is refused before it can run, and says how to give the file",
  );
  check(
    lost2.rejected.length === 1 && lost2.rejected[0].at === 0 && lost2.actions.length === 1,
    "WRITE with no body is refused; the action after it is kept apart (it won't run)",
  );
  check(
    lost3.rejected.length === 1 && lost3.actions.length === 1 && lost3.actions[0].kind === "run",
    "a heredoc opened with nothing under it is refused",
  );
  const emptyBody = parseActions("WRITE: a.txt\n<<<\n>>>\nREPLACE: b.txt\n<<<\n===\nnew\n>>>");
  check(
    emptyBody.rejected.length === 1 &&
      /its content was empty/.test(emptyBody.rejected[0].text) &&
      emptyBody.problems.length === 1 &&
      !emptyBody.actions.length,
    "a WRITE with an empty body and a REPLACE with no old text never become actions",
  );
  const here = parseActions("RUN: python3 - <<'PY'\nimport sys\nprint(1)\nPY\nRUN: echo done");
  check(
    here.actions.length === 2 &&
      here.actions[0].kind === "run" &&
      here.actions[0].command === "python3 - <<'PY'\nimport sys\nprint(1)\nPY" &&
      !here.rejected.length,
    "a RUN whose heredoc body follows on the next lines keeps it",
  );
  const cut = liftFiles("```file:half.py\nprint(1)\nprint(");
  check(
    !cut.files.length && cut.plan.includes("print("),
    "a file block that is never closed is not lifted (half a file is not written)",
  );
  const label = liftFiles(
    "1. Create the script `fix_wal.py` with this exact content:\n\n```python\nprint(1)\n```\n2. Run the script `fix_wal.py` to see the content:\n```bash\npython3 fix_wal.py\n```",
  );
  check(
    label.files.length === 1 &&
      label.files[0].path === "fix_wal.py" &&
      label.files[0].content === "print(1)" &&
      label.plan.includes("python3 fix_wal.py"),
    'a fence under "Create `x` with this exact content:" is that file; a shell fence under a line naming a file is not',
  );
  const expanding = liftFiles("cat > a.sh <<EOF\necho $HOME\nEOF");
  check(
    !expanding.files.length,
    "a heredoc the shell would expand ($ under an unquoted delimiter) is left to the shell",
  );
  const twoFiles = [
    { path: "a/x.py", content: "1" },
    { path: "b/x.py", content: "2" },
  ];
  check(
    parseActions("WRITE: x.py", 8, twoFiles).rejected.length === 1 &&
      parseActions("WRITE: b/x.py", 8, twoFiles).actions.some(
        (a) => a.kind === "write" && a.content === "2",
      ),
    "a name that could mean two lifted files is not guessed at",
  );
}

log("plans: refusals, continue, a plan that only looks");
{
  check(
    looksLikeRefusal("I'm sorry, but I can't run commands on your computer.") &&
      looksLikeRefusal("As an AI language model I don’t have access to your files.") &&
      looksLikeRefusal("I cannot execute these; you'll need to run these yourself.") &&
      !looksLikeRefusal("TASK 1: Run the tests\nDONE WHEN: they pass") &&
      !looksLikeRefusal("The tests already pass; nothing to change."),
    "a reply that declines to plan is recognised; a plan or an answer is not",
  );
  check(
    [
      "continue",
      "Continue.",
      "go on",
      "ok, keep going",
      "please continue",
      "try again",
      "resume from there",
    ].every(isContinue) &&
      !isContinue("continue by adding a README and a license file to the project") &&
      !isContinue("add tests"),
    '"continue" and its kin are a request to resume; a new request is not',
  );
  const looking = parsePlan(
    "TASK 1: Inspect the folder with ls\nDONE WHEN: listed\nTASK 2: Dump the first bytes of main.db\nDONE WHEN: dumped",
  ).tasks;
  check(
    !planProduces(looking, "Fix the WAL file and create recovered.json", ["recovered.json"]) &&
      !planProduces(looking, "Repair the database", []) &&
      planProduces(looking, "What is in this folder?", []) &&
      planProduces([...looking, { title: "Write recovered.json from the rows", done: "" }], "x", [
        "recovered.json",
      ]) &&
      planProduces([{ title: "Fix the import in app.py", done: "" }], "Fix the bug", []),
    "a plan of looking only fails for a request that asks for something; a question may be all looking",
  );
  check(
    plannerPrompt("x", "y", "", true).instructions.length < 3000 &&
      thinkPrompt({ goal: "", folder: "", memory: "", pins: "", results: "", step: 1, left: "" })
        .instructions.length < 3000 &&
      reviewPrompt({ request: "", cwd: "", files: "", commands: "", settled: "", unchecked: "" })
        .instructions.length < 3000 &&
      foldPrompt({ goal: "", digest: "", kept: [], entries: "" }).instructions.length < 3000 &&
      translatePrompt("", "", "").instructions.length < 3000 &&
      WORKER_BASE.length < 3000,
    "every role's instructions stay under the 3,000 characters the router's web path allows",
  );
  check(
    /copy the file and work on the copy/.test(WORKER_BASE) && /read-only/.test(WORKER_BASE),
    "a worker is told to copy input files before tools that may change them, and to prefer read-only modes",
  );
}

log("router errors: which are worth waiting for; caps");
{
  const r = (status: number, m = "x") => new RouterError(status, m);
  check(
    [0, 429, 500, 502, 503, 504].every((c) => r(c).retryable) &&
      [400, 401, 403, 404].every((c) => !r(c).retryable),
    "429, 5xx and no answer are retried; a refused token or a bad request is not",
  );
  check(
    r(502, "empty reply from kilo/x").empty && !r(502, "upstream reset").empty,
    "an empty reply is told apart",
  );
  check(
    RETRY_DELAYS_MS.join() === "5000,20000,60000,120000" &&
      DEFAULT_CAPS.retryDelaysMs === RETRY_DELAYS_MS &&
      DEFAULT_CAPS.workerCalls === WORKER_CALLS &&
      DEFAULT_CAPS.workerMs === WORKER_MINUTES * 60_000 &&
      DEFAULT_CAPS.workerCalls < DEFAULT_CAPS.modelCalls,
    `defaults: waits of 5, 20, 60, 120 s; a worker gets ${WORKER_CALLS} requests and ${WORKER_MINUTES} minutes of its own`,
  );
  const c = capsFromEnv({
    PROVENANCE_ORC_RETRY_S: "1, 2.5",
    PROVENANCE_ORC_WORKER_CALLS: "9",
    PROVENANCE_ORC_WORKER_MINUTES: "3",
    PROVENANCE_ORC_WORKER_TOKENS: "9000",
    PROVENANCE_ORC_HANDOFFS: "6",
    PROVENANCE_ORC_MODEL_CALLS: "200",
    PROVENANCE_ORC_TURN_MINUTES: "90",
  });
  check(
    c.retryDelaysMs?.join() === "1000,2500" &&
      c.workerCalls === 9 &&
      c.workerMs === 180_000 &&
      c.workerContextTokens === 9000 &&
      c.handoffs === 6 &&
      c.modelCalls === 200 &&
      c.turnMs === 90 * 60_000 &&
      capsFromEnv({ PROVENANCE_ORC_WORKER_TOKENS: "12" }).workerContextTokens === undefined &&
      capsFromEnv({ PROVENANCE_ORC_RETRY_S: "off" }).retryDelaysMs?.length === 0 &&
      Object.keys(capsFromEnv({ PROVENANCE_ORC_RETRY_S: "soon" })).length === 0,
    "the waits, the worker's budgets (requests, minutes, context, handoffs) and the turn's (model calls, minutes) can be set from the environment; nonsense is ignored",
  );
}

log("reports, thoughts, small helpers");
{
  check(parseReport("RESULT: ok\nSTATUS: DONE").status === "done", "STATUS: DONE");
  check(parseReport("**STATUS:** BLOCKED").status === "blocked", "bold STATUS: BLOCKED");
  check(parseReport("status - partial").status === "partial", "status - partial");
  check(
    parseReport("I could not install the package.").status === "blocked",
    "no status line, says it couldn't: blocked",
  );
  check(
    parseReport("Created the file and ran it.").status === "done",
    "no status line, plain success: done",
  );
  const sec = reportSections(
    "Done.\n\n**RESULT:** made a.py\nCHANGES: a.py\n- b.py\nVALIDATION: ran x\nBLOCKERS: none\nSTATUS: DONE",
  );
  check(
    sec.result === "made a.py" && sec.changes === "a.py b.py" && sec.blockers === "",
    "report sections; BLOCKERS: none is empty",
  );
  const hsec = reportSections(
    [
      "RESULT: fixed cacheutils (32 -> 21 failures)",
      "CHANGES: boltons/cacheutils.py",
      "VALIDATION: pytest -q -> 21 failed",
      "FAILURES:",
      "- dictutils.py:142 OMD.popall drops last key",
      "- iterutils.py:88 windowed skips final chunk",
      "TRIED: checked setutils (clean); slice broke fill=None",
      "NEXT: edit dictutils.py:142 and run pytest tests/test_dictutils.py",
      "STATUS: PARTIAL",
    ].join("\n"),
  );
  check(
    hsec.failures.includes("dictutils.py:142") &&
      hsec.failures.includes("iterutils.py:88") &&
      hsec.tried.includes("slice broke fill=None") &&
      hsec.next.includes("dictutils.py:142"),
    "report sections extract structured FAILURES, TRIED and NEXT fields for hand-overs",
  );
  const fdig = failureDigest(
    [
      "=== test session starts ===",
      ...Array.from({ length: 20 }, (_, i) => `noise line ${i}`),
      "FAILED tests/test_dictutils.py::test_popall - AssertionError: wrong",
      "FAILED tests/test_iterutils.py::test_windowed - ValueError: bad",
      "========================= 21 failed, 340 passed in 1.4s =========================",
    ].join("\n"),
  );
  check(
    fdig.includes("FAILED tests/test_dictutils.py::test_popall") &&
      fdig.includes("21 failed, 340 passed") &&
      !fdig.includes("noise line 0"),
    "failureDigest pulls concrete failing test lines and summary out of verbose output",
  );
  // Context tracker: stateless vs stateful delta-mode (chatgpt-web) vs flat LOOPCALLS vs restart.
  {
    const stateless = createContextState();
    check(
      updateContextState(stateless, 6500, 100) === 6500 &&
        updateContextState(stateless, 9000, 100) === 9000 &&
        updateContextState(stateless, 12000, 100) === 12000 &&
        !stateless.deltaMode,
      "context tracker: monotonic stateless requests stay in full-history mode",
    );
    const loop = createContextState();
    updateContextState(loop, 6500, 50);
    updateContextState(loop, 7000, 50);
    updateContextState(loop, 7000, 50);
    check(
      !loop.deltaMode && loop.tokens === 7000,
      "context tracker: flat LOOPCALLS without tool output does not false-trigger delta mode",
    );
    const delta = createContextState();
    const seq = [3259, 2615, 2170, 2615]; // boltons worker 1 actual delta pattern
    const got = seq.map((n) => updateContextState(delta, n, 200));
    check(
      delta.deltaMode && got[1] === 3259 + 200 + 2615 && got[3] >= 11_000 && got[3] < 12_000,
      `context tracker: stateful web-chat deltas accumulate and fire near 11k (${got.join(" -> ")})`,
    );
    const resent = createContextState();
    updateContextState(resent, 3347, 150);
    updateContextState(resent, 3347, 150); // resent fresh prompt, no tools
    const afterDrop = updateContextState(resent, 600, 150);
    check(
      resent.deltaMode && afterDrop === 3347 + 150 + 600,
      "context tracker: resent initial prompt is not double-counted; next drop enters delta mode",
    );
    const shortStart = createContextState();
    updateContextState(shortStart, 2500, 100, 0);
    updateContextState(shortStart, 2615, 100, 2500);
    const third = updateContextState(shortStart, 2615, 100, 2500);
    check(
      shortStart.deltaMode && third === 2615 + 100 + 2615,
      "context tracker: flat 10KB deltas after tool output enter delta mode even when call 1 was smaller",
    );
    const restarted = updateContextState(delta, 14500, 100);
    check(
      restarted === 14500,
      "context tracker: a bridge restart with a full fresh prompt resets instead of double-counting",
    );
  }
  // Cumulative handover merge + render + long-request brief budget.
  {
    const h1 = mergeHandover(null, {
      n: 1,
      report:
        "RESULT: fixed cacheutils\nCHANGES: cacheutils.py\nVALIDATION: pytest -> 21 failed\nFAILURES:\n- dictutils.py:142 OMD.popall\n- iterutils.py:88 windowed\nTRIED: naive slice broke fill=None\nNEXT: edit dictutils.py:142\nSTATUS: PARTIAL",
      files: [{ path: "cacheutils.py", kind: "update" }],
      checks: [{ cmd: "pytest -q", ok: false, exit: 1, summary: "21 failed, 340 passed" }],
    });
    const h2 = mergeHandover(h1, {
      n: 2,
      report: "RESULT: fixed dictutils; down to 10 failures\nSTATUS: PARTIAL",
      files: [{ path: "dictutils.py", kind: "update" }],
      checks: [
        {
          cmd: "pytest -q",
          ok: false,
          exit: 1,
          summary: "FAILED tests/test_iterutils.py::test_windowed\n10 failed, 351 passed",
        },
      ],
    });
    const rendered2 = renderHandover(h2, 2500);
    check(
      rendered2.includes("fixed dictutils; down to 10 failures") &&
        rendered2.includes("iterutils.py:88 windowed") &&
        rendered2.includes("naive slice broke fill=None") &&
        rendered2.includes("FAILED tests/test_iterutils.py::test_windowed"),
      "terse successor hand-over still carries forward earlier failure groups, tried fixes and recorded pytest failures",
    );
    const h3 = mergeHandover(h2, {
      n: 3,
      report: "",
      files: [{ path: "iterutils.py", kind: "update" }],
      checks: [],
    });
    const rendered3 = renderHandover(h3, 2500);
    check(
      rendered3.includes("worker 3 gave no hand-over") &&
        rendered3.includes("iterutils.py:88 windowed") &&
        rendered3.includes("iterutils.py (update)"),
      "empty wrap-up preserves prior hand-over analysis plus the stopped worker's recorded file changes",
    );
    const huge = mergeHandover(null, {
      n: 1,
      report: [
        `RESULT: ${"fixed early modules cleanly. ".repeat(30)}`,
        `CHANGES: ${"boltons/cacheutils.py updated, ".repeat(20)}`,
        `VALIDATION: .venv/bin/pytest -q -> 21 failed, 340 passed`,
        `FAILURES:\n- CRITICAL_GROUP_ALPHA: boltons/dictutils.py:142 OMD.popall\n- ${"detail line ".repeat(60)}\n- CRITICAL_GROUP_OMEGA: boltons/iterutils.py:88 windowed`,
        `TRIED: DEAD_END_MARKER naive slice broke fill=None; ${"checked extra ".repeat(25)}`,
        `NEXT: EXACT_NEXT_STEP edit boltons/dictutils.py:142 and run pytest tests/test_dictutils.py`,
        `STATUS: PARTIAL`,
      ].join("\n"),
      files: [{ path: "boltons/cacheutils.py", kind: "update" }],
      checks: [],
    });
    const renderedHuge = renderHandover(huge, 1600);
    check(
      renderedHuge.length <= 1600 &&
        renderedHuge.includes("CRITICAL_GROUP_ALPHA") &&
        renderedHuge.includes("CRITICAL_GROUP_OMEGA") &&
        renderedHuge.includes("DEAD_END_MARKER") &&
        renderedHuge.includes("EXACT_NEXT_STEP"),
      `oversized structured hand-over compacts by section instead of clipping FAILURES/TRIED out of the middle (${renderedHuge.length} <= 1600)`,
    );
    const longReq = `${"Fix the seeded bugs across boltons modules. ".repeat(48)}Run pytest -q.`;
    const hb = workerBrief({
      request: longReq,
      exact: [],
      task: {
        title: "Do everything THE REQUEST above asks for, and check it",
        done: "",
        detail: rendered2,
        whole: true,
        handover: true,
      },
      index: 1,
      total: 1,
      later: [],
      notes: emptyNotes(),
      cwd: "/data/app",
      requestFile: "/tmp/provenance-requests/long.txt",
    });
    check(
      hb.length <= HANDOVER_BRIEF_BUDGET &&
        hb.includes(longReq) &&
        hb.includes("iterutils.py:88 windowed"),
      `hand-over brief fits a 2k+ request whole alongside the working analysis (${hb.length} <= ${HANDOVER_BRIEF_BUDGET})`,
    );
  }
  check(parseThought("FINISHED: It works.").final === "It works.", "FINISHED: is final");
  check(
    parseThought("Checked it.\n\n**FINISHED:** All good.").final === "All good.",
    "bold FINISHED after a line of text",
  );
  check(
    parseThought("Once finished: we will test. Run pytest.").final === null,
    '"finished" inside a sentence is not final',
  );
  check(replaceIn("a\n  b\nc\n", "b", "B") === "a\n  B\nc\n", "replace: exact text");
  check(
    replaceIn("a\n    return x  \nc\n", "return x", "return y") === "a\n    return y  \nc\n",
    "replace: exact substring wins",
  );
  check(
    replaceIn("if x:\n\treturn 1\n", "if x:\n    return 1", "if x:\n    return 2") ===
      "if x:\n    return 2\n",
    "replace: same lines, other indentation",
  );
  check(replaceIn("abc", "zzz", "y") === null, "replace: not found is null");
  check(
    lineDiff("a\nb\nc\n", "a\nB\nc\n") === "@@ -2,1 +2,1 @@\n-b\n+B",
    "line diff of the changed middle",
  );
  check(
    mustAsk("untrusted") &&
      mustAsk({ granular: {} }) &&
      !mustAsk("on-request") &&
      !mustAsk("never"),
    "Ask every time (and any unknown policy) asks; Auto and Full access don't",
  );
}

log("notes");
{
  const n = emptyNotes();
  addRequest(n, "Build the thing ".repeat(100));
  for (let i = 0; i < 60; i++) {
    addDone(
      n,
      `Task number ${i} with a fairly long title to take up room`,
      `it did part ${i} and wrote things down at length `.repeat(4),
    );
    addFile(n, `src/file${i}.py`, "add");
    addCommand(n, `pytest tests/test_${i}.py -q`, i % 3 !== 0);
    if (i % 10 === 0) addProblem(n, `problem ${i}: something went wrong here`);
  }
  const text = notesText(n);
  check(
    text.length <= NOTES_LIMIT,
    `60 tasks of notes fit the bound (${text.length} <= ${NOTES_LIMIT})`,
  );
  check(text.startsWith("GOAL: Build the thing"), "the goal is kept");
  check(
    n.folded > 50 && /\(\d+ earlier tasks finished\)/.test(text),
    `the oldest tasks were folded into a count (${n.folded})`,
  );
  check(
    text.includes("Task number 59") && !text.includes("Task number 3 "),
    "the newest task is there, an old one is not",
  );
  check(
    text.includes("FAILED: pytest tests/test_57.py") &&
      text.includes("ok: pytest tests/test_59.py"),
    "recent commands with how they ended",
  );
}

log("the request, word for word: exact names, numbered pieces, excerpts");
{
  // A request shaped like the ones that went wrong: the output's name sits in the middle of a
  // long text, between two lists, and a count is stated once.
  const LONG = [
    "Find a 1-hour slot for Alice, Bob and Carol during January 15-19, 2024 (business hours: 9 AM - 6 PM).",
    "",
    "Availability:",
    ...Array.from(
      { length: 9 },
      (_, i) =>
        `- Person P${i + 1}: prefers mornings, can do early afternoons if needed, never after 2 PM; this rule is for weekdays only.`,
    ),
    "",
    "Input: three calendars (`/data/app/alice_calendar.ics`, `/data/app/bob_calendar.ics`, `/data/app/carol_calendar.ics`).",
    "",
    'Output: Create `/data/app/meeting_scheduled.ics` with a 1-hour "Team Planning Meeting" for all 3 attendees.',
    "",
    "Technical requirements:",
    ...Array.from(
      { length: 16 },
      (_, i) =>
        `- Requirement R${i + 1}: the file must keep header H${i + 1} exactly as the standard writes it, in UTC (YYYYMMDDTHHMMSSZ), with --strict-mode on.`,
    ),
    '- Call `schedule_meeting(start, end)` and print "DONE" within 5 seconds; tolerance 1e-6.',
  ].join("\n");
  check(LONG.length > 3000, `(a request of ${LONG.length} characters)`);
  const exact = exactNames(LONG);
  check(
    [
      "/data/app/alice_calendar.ics",
      "/data/app/meeting_scheduled.ics",
      "Team Planning Meeting",
      "schedule_meeting(start, end)",
      "--strict-mode",
      "DONE",
      "1-hour",
      "3 attendees",
      "5 seconds",
      "1e-6",
    ].every((x) => exact.includes(x)),
    `code copies the exact names out of the request: paths, quoted strings, flags, calls, numbers with their units (${exact.length}: ${exact.slice(0, 6).join(" | ")} …)`,
  );
  check(
    !exact.includes("1") && !exact.includes("2") && exact.join(" | ").length <= 900,
    "list numbering is not a name; the list is bounded",
  );
  check(
    exactNames("See https://example.com/a.json, version v1.2.3, e.g. this.").length === 0,
    "a URL, a version and an abbreviation are not names",
  );
  const lines = requestLines(LONG);
  check(lines.join("\n") === LONG, "the request in pieces is the request, character for character");
  const longLine = `${"A sentence that goes on. ".repeat(30)}The file is out_final.csv.`;
  check(
    requestLines(longLine).length > 1 &&
      requestLines(longLine).every((l) => l.length <= 320) &&
      requestLines(longLine).join("") === longLine,
    "a paragraph on one line is cut at sentence ends, losing nothing",
  );
  const num = numbered(LONG, 4000);
  const outAt = lines.findIndex((l) => l.includes("meeting_scheduled.ics")) + 1;
  check(
    num.includes(`[${outAt}] Output: Create \`/data/app/meeting_scheduled.ics\``),
    "the planner sees every piece with its number (the middle of a long request is not cut away)",
  );
  const planP = plannerPrompt(LONG, "/data/app (macOS); contains: a.ics", "", false, exact);
  check(
    planP.instructions.length + planP.input.length <= PROMPT_BUDGET &&
      planP.input.includes("meeting_scheduled.ics") &&
      planP.input.includes("MUST MATCH EXACTLY"),
    `the planner's prompt holds it within the budget (${planP.instructions.length + planP.input.length} <= ${PROMPT_BUDGET})`,
  );
  const ex = requestExcerpt(LONG, 1500, [outAt]);
  check(
    !ex.whole &&
      ex.text.length <= 1500 &&
      ex.text.includes("Output: Create `/data/app/meeting_scheduled.ics`") &&
      ex.text.startsWith("Find a 1-hour slot") &&
      /\[… \d+ lines? of the request left out here …\]/.test(ex.text),
    "an excerpt keeps the pieces a task needs word for word, fills up from the top, and marks every gap",
  );
  check(requestExcerpt("short one", 100).whole, "a request that fits is given whole");
  // The brief of a task in a split job, for that long request.
  const notes = emptyNotes();
  addRequest(notes, LONG);
  addDone(notes, "Read the calendars", "20 events found, none recurring");
  addFile(notes, "events.json", "add");
  addCommand(notes, "python3 parse.py", true);
  addApproval(notes, "rm -f /tmp/x");
  const before = JSON.stringify(notes);
  const brief = workerBrief({
    request: LONG,
    exact,
    task: {
      title: "Write the calendar file for the slot found",
      done: "the file exists and parses",
      needs: [outAt],
    },
    index: 2,
    total: 3,
    later: [{ title: "Validate it", done: "" }],
    notes,
    cwd: "/data/app",
    folder: "/data/app (macOS); contains: alice_calendar.ics",
    requestFile: "/tmp/provenance-requests/t.txt",
  });
  check(
    brief.length <= BRIEF_BUDGET,
    `the brief is within its budget (${brief.length} <= ${BRIEF_BUDGET})`,
  );
  check(
    brief.includes(
      'Output: Create `/data/app/meeting_scheduled.ics` with a 1-hour "Team Planning Meeting"',
    ) &&
      /MUST MATCH EXACTLY[^\n]*\/data\/app\/meeting_scheduled\.ics/.test(brief) &&
      brief.includes("(Shortened here. All of it is in /tmp/provenance-requests/t.txt"),
    "it quotes the piece the task needs word for word, lists the exact names, and says where the whole request is",
  );
  check(
    brief.includes("- Read the calendars: 20 events found") &&
      brief.includes(
        "NEEDS APPROVAL (asked and declined: do without, do not ask again):\n- rm -f /tmp/x",
      ) &&
      JSON.stringify(notes) === before,
    "the notes are in it, cut to the room that is left without folding what is stored",
  );
  // Measured on the lengths of the benchmark's ten requests (characters).
  const sizes = [561, 663, 848, 904, 979, 1269, 1518, 1985, 2253, 3455];
  const wholeIn = sizes.filter((n) => {
    const r = `${"word ".repeat(Math.ceil(n / 5)).slice(0, n - 1)}.`;
    const b = workerBrief({
      request: r,
      exact: [],
      task: {
        title: "Do everything THE REQUEST above asks for, and check it",
        done: "",
        whole: true,
      },
      index: 1,
      total: 1,
      later: [],
      notes: emptyNotes(),
      cwd: "/data/app",
    });
    return b.includes(r) && b.length <= BRIEF_BUDGET;
  });
  check(
    wholeIn.length === 9 && sizes.filter((n) => n + 300 <= ONE_WORKER_CHARS).length === 9,
    `nine of the ten benchmark request lengths fit a one-worker brief whole, with a 300-character folder listing to spare (${wholeIn.join(", ")})`,
  );
  check(
    WORKER_BASE.length < 3000,
    `the worker's base instructions stay under the router's 3,000 (${WORKER_BASE.length})`,
  );
  const rev = revisePrompt(LONG, notesText(notes), { title: "t", done: "" }, "r", [], exact);
  const rvw = reviewPrompt({
    request: LONG,
    cwd: "/data/app",
    files: "- a.ics (add, exists, 300 bytes)\n".repeat(80),
    commands: commandsEvidence(
      Array.from({ length: 80 }, (_, i) => ({
        cmd: `python3 check.py --case ${i}`,
        ok: true,
        exit: 0,
        tail: `case ${i}: ok\nall passed`,
      })),
    ),
    settled: "- a.ics exists under exactly that name",
    unchecked: "the 1e-6 tolerance",
  });
  const frameArgs = {
    goal: LONG,
    exact,
    requestFile: "/tmp/provenance-requests/t.txt",
    folder: "/data/app (macOS); contains: a.ics",
    step: 3,
    left: "40 model calls, 12 minutes",
  };
  const thk = thinkPrompt({
    ...frameArgs,
    memory: "s".repeat(MEMORY_LIMIT),
    pins: "p".repeat(PINS_LIMIT),
    results: "r".repeat(RESULTS_MAX),
  });
  check(
    [rev, rvw].every((p) => p.instructions.length + p.input.length <= PROMPT_BUDGET) &&
      thk.instructions.length + thk.input.length <= THINK_BUDGET,
    `with the longest inputs the reviser's and the reviewer's prompt stay within the budget, and the think prompt within its own (${[rev, rvw].map((p) => p.instructions.length + p.input.length).join(", ")} <= ${PROMPT_BUDGET}; ${thk.instructions.length + thk.input.length} <= ${THINK_BUDGET})`,
  );
  check(
    thk.input.startsWith("GOAL:\nFind a 1-hour slot") &&
      thk.input.includes("(Shortened here. All of it is in /tmp/provenance-requests/t.txt") &&
      /MUST MATCH EXACTLY[^\n]*meeting_scheduled\.ics/.test(thk.input) &&
      /LAST STEP RESULTS:\nr{300,}/.test(thk.input) &&
      /MEMORY:\ns{300,}/.test(thk.input) &&
      thinkRoom(frameArgs) > 4000,
    `the think prompt has the request's own words, the exact names and where the rest is; memory, pins and results share what is left (${thinkRoom(frameArgs)} characters with the longest goal)`,
  );
  check(
    /exit 0: python3 check\.py --case 79\n    \| case 79: ok\n    \| all passed$/.test(
      rvw.input.split("\n\nSETTLED BY CODE")[0],
    ) &&
      /earlier commands? not listed/.test(rvw.input) &&
      /THE WORK SAYS IT DID NOT CHECK:\nthe 1e-6 tolerance/.test(rvw.input) &&
      !/MUST MATCH EXACTLY/.test(rvw.input),
    "the reviewer is given each command with its exit code and the end of its output (the newest kept), what code settled and what the work says it did not check; not the must-match list",
  );
}

log("the finish check: what code finds, what the reviewer says");
{
  check(
    nearMiss("meeting_scheduled.ics", ["notes.txt", "meeting.ics"]) === "meeting.ics" &&
      nearMiss("/data/app/out.json", ["sub/out.json"]) === "sub/out.json" &&
      nearMiss("recovered.json", ["recoverd.json"]) === "recoverd.json" &&
      nearMiss("report.md", ["notes.txt", "data.csv"]) === null,
    "a file of nearly the asked name, or of that name elsewhere, is a near miss; an unrelated file is not",
  );
  const stray = strayPaths(
    {
      files: ["/mnt/data/meeting.ics"],
      commands: ["python3 a.py > /mnt/data/out.txt", "echo hi > /tmp/x", "cp a /data/app/b.ics"],
      reports: ["CHANGES: created /mnt/data/app/meeting.ics"],
    },
    "/work",
    "Write to /data/app/b.ics",
  );
  check(
    stray.join("|") === "/mnt/data/meeting.ics|/mnt/data/out.txt|/mnt/data/app/meeting.ics",
    `paths outside the folder that the request does not name are found; temp files and named paths are not (${stray.join("|")})`,
  );
  const dir = mkdtempSync(path.join(tmpdir(), "provenance-orc-finish-"));
  writeFileSync(path.join(dir, "meeting.ics"), "BEGIN:VCALENDAR\n");
  const req = `Create ${dir}/meeting_scheduled.ics with the slot.`;
  const dl = deliverablesIn(req, dir);
  check(
    dl.join() === "meeting_scheduled.ics",
    "a file the request names by its full path is a deliverable, whatever its type",
  );
  const f = codeFindings({
    deliverables: dl,
    cwd: dir,
    request: req,
    files: ["meeting.ics"],
    commands: [],
    reports: [],
    lastCheck: { cmd: "python3 validate.py", ok: false },
  });
  const fl = findingLines(f);
  check(
    f.near[0]?.have === "meeting.ics" &&
      /`meeting_scheduled\.ics`, named in the request, does not exist; `meeting\.ics` was made instead: a near miss/.test(
        fl[0],
      ) &&
      /the last recorded check failed: `python3 validate\.py`/.test(fl[1]),
    "code flags the near miss by name, and a last check that failed",
  );
  const pc = parseChecks(`Here is what the evidence does not show:

**CHECK 1:** the meeting is exactly 60 minutes
\`\`\`bash
python3 - <<'PY'
import re
print("ok")
PY
\`\`\`

- R2: handles a missing argument | RUN: \`python3 slot.py; test $? -eq 2\`
3. tolerance 1e-6
   Run: python3 check.py --tol 1e-6
CHECK 4: a fourth one
RUN: true
Check 5: no command for this one
Overall the job looks fine.`);
  check(
    pc.checks.length === 3 &&
      pc.checks[0].requirement === "the meeting is exactly 60 minutes" &&
      pc.checks[0].command === "python3 - <<'PY'\nimport re\nprint(\"ok\")\nPY" &&
      pc.checks[1].command === "python3 slot.py; test $? -eq 2" &&
      pc.checks[1].requirement === "handles a missing argument" &&
      pc.checks[2].command === "python3 check.py --tol 1e-6",
    "the reviewer's checks are read in whatever shape: a block under the check, a RUN on the line or under it; at most three",
  );
  check(
    parseChecks("ALL SHOWN").allShown &&
      !parseChecks("Looks good to me!").allShown &&
      parseChecks("Looks good to me!").checks.length === 0 &&
      parseChecks("| CHECK 1: the count | RUN: `wc -l a.csv` |").checks[0]?.command ===
        "wc -l a.csv" &&
      parseChecks("CHECK 1: something with no command").checks.length === 0,
    "ALL SHOWN is a review with nothing to run; a reply with neither is no review; a check without a command is not a check",
  );
  const ev = (cmd: string, ok = true) => ({ cmd, ok, exit: ok ? 0 : 1, tail: "" });
  check(
    reviewWorth({ changed: true, split: false, unchecked: "", commands: [ev("python3 t.py")] }) ===
      null &&
      reviewWorth({ changed: false, split: true, unchecked: "x", commands: [] }) === null &&
      /split/.test(
        reviewWorth({ changed: true, split: true, unchecked: "", commands: [ev("x")] }) ?? "",
      ) &&
      /did not check/.test(
        reviewWorth({
          changed: true,
          split: false,
          unchecked: "a real Ctrl+C",
          commands: [ev("x")],
        }) ?? "",
      ) &&
      /no recorded command/.test(
        reviewWorth({ changed: true, split: false, unchecked: "", commands: [ev("x", false)] }) ??
          "",
      ),
    "a reviewer is worth a call only for a split job, for work that names something unchecked, or when nothing ran the result",
  );
  check(
    uncheckedOf("FINISHED: done.\nNOT CHECKED: nothing") === "" &&
      uncheckedOf("All good.\n\nNot checked: Nothing.\n\nMore words.") === "" &&
      uncheckedOf("Done.\n**NOT CHECKED:** a real keyboard interrupt\nin a terminal\n\nBye") ===
        "a real keyboard interrupt in a terminal" &&
      uncheckedOf("Wrote it and ran it.") === "",
    "what an answer says it did not check is read from its NOT CHECKED line (nothing is nothing)",
  );
  check(
    unsafeCheck("rm -rf build && make", dir, req) !== null &&
      unsafeCheck("python3 -c 'import os; print(1)' > /etc/x", dir, req) !== null &&
      unsafeCheck("pip install rdflib && python3 q.py", dir, req) !== null &&
      unsafeCheck("git reset --hard", dir, req) !== null &&
      unsafeCheck("", dir, req) !== null &&
      unsafeCheck("python3 -c \"print('rm -rf nothing')\" && test -s meeting.ics", dir, req) ===
        null &&
      unsafeCheck("gcc main.c -o /tmp/m && /tmp/m 10 | grep -qx 55", dir, req) === null,
    "a reviewer's command that would delete, install, reset or write outside the folder is not run as a check; one that only runs and looks is",
  );
  const failed: Check[] = [
    {
      requirement: "handles a keyboard interrupt",
      command: "python3 sigint_test.py",
      state: "failed",
      output: "cleanup did not run\n[exit 1]",
    },
  ];
  const t = followUpTask(failed, fl);
  check(
    t.followUp === true &&
      /- \(recorded\) `meeting_scheduled\.ics`, named in the request, does not exist/.test(
        t.detail ?? "",
      ) &&
      /- CHECK FAILED: handles a keyboard interrupt\n  command: python3 sigint_test\.py\n  it printed: cleanup did not run/.test(
        t.detail ?? "",
      ) &&
      /whether the work or the check is wrong/.test(t.detail ?? ""),
    "what failed becomes one task, written by code: the failing command, what it printed, and the rule that a wrong check is named, not satisfied",
  );
  const passed: Check = {
    requirement: "it imports",
    command: "python3 -c 'import run'",
    state: "passed",
    output: "",
  };
  const notRun: Check = {
    requirement: "the query runs",
    command: "arq --query q",
    state: "not-run",
    output: "it could not be run (exit 127): arq: command not found",
  };
  const ft = finishText({
    reviewed: true,
    checks: [passed, ...failed, notRun],
    fix: { ran: false, why: "too little was left" },
    skipped: null,
  });
  check(
    /\*\*Finish check\.\*\* 1 further check was run on the result and passed:\n- it imports: `python3 -c 'import run'`\n1 check \*\*failed\*\*:\n- handles a keyboard interrupt: `python3 sigint_test\.py` → cleanup did not run[^\n]*\nNo fix task was run \(too little was left\): treat this as \*\*not verified\*\*[^\n]*\n\*\*Not verified\*\* \(the check could not be run\):\n- the query runs: it could not be run \(exit 127\)/.test(
      ft,
    ) &&
      finishText({ reviewed: true, checks: [], fix: null, skipped: null }) === "" &&
      finishText({ reviewed: false, checks: [], fix: null, skipped: null }) === "" &&
      /not reviewed \(the reviewer could not be reached\)/.test(
        finishText({
          reviewed: false,
          checks: [],
          fix: null,
          skipped: "the reviewer could not be reached",
        }),
      ),
    "the answer says which checks passed, which failed and which could not be run (not verified); with nothing to say it adds nothing",
  );
  check(
    tailOf("a\n\nb\nc\n", 100, 2) === "b\nc" && tailOf("x".repeat(500), 50).length === 50,
    "the end of an output is kept as evidence, bounded",
  );
}

log("what a command is: a look, or more");
{
  const looks: [string, boolean][] = [
    ["ls -la", true],
    ["cd /app && python3 test.py", false],
    ["cat > f.txt <<'EOF'\nhello\nEOF\npython3 x.py", false],
    ["cat a.py | head -n 5", true],
    ["pwd && ls -l x && sed -n '1,260p' x.ttl", true],
    ["sed -i 's/a/b/' x", false],
    ['TARGET="/a/b"\necho "=== x ==="\ncat "$TARGET"\nwc -l "$TARGET"', true],
    ['for cmd in arq riot; do command -v "$cmd" || true; done\nls -l s.sparql', true],
    ["python3 - <<'PY'\nimport re\nprint(1)\nPY", false],
    ["grep -n foo x 2>/dev/null | head", true],
    ["echo hi > out.txt", false],
    ["mkdir -p x", false],
    ["printf '%s\\n' '--- a ---'\ncat regex.txt\nls -l regex.txt", true],
    ["gcc a.c -o a && ./a 10", false],
    ['cd "/x y" || exit 1\ncat f', true],
    ["if test -f s; then\n  wc -c s\n  cat -n s\nfi", true],
    ["nl -ba \"$T\" | sed -n '1,70p'", true],
    ["find . -name '*.pyc' -delete", false],
  ];
  const wrong = looks.filter(([c, want]) => lookOnly(c) !== want).map(([c]) => c);
  check(
    wrong.length === 0,
    `a script only looks when every command in it does: a cd in front of a test, a cat that writes a heredoc and a python heredoc are more than a look (${wrong.length ? `wrong: ${JSON.stringify(wrong)}` : `${looks.length} cases`})`,
  );
}

log("plans: one worker unless the job is large; pieces by number");
{
  const one = parsePlan("ONE");
  check(
    one.one && !one.tasks.length && one.answer === null,
    '"ONE" is a plan: the whole job, one worker',
  );
  const big = parsePlan(
    "LARGE: five files, two stages\nTASK 1: Write the parser\nNEEDS: 2-4, 7\nDONE WHEN: it parses\nTASK 2: Wire it up\nNEEDS: all\nDONE WHEN: ok",
  );
  check(
    big.large === "five files, two stages" &&
      big.tasks.length === 2 &&
      big.tasks[0].needs?.join() === "2,3,4,7" &&
      big.tasks[1].needs === undefined &&
      big.tasks[0].done === "it parses",
    "LARGE gives the reason; NEEDS names request pieces by number",
  );
  const bullets = parsePlan(
    "TASK 1: Inspect the graph\n\nDONE WHEN: documented\n\nTASK 2: Create `solution.sparql`. Write a query that:\n\n- Selects full professors.\n- Requires more than 10 students.\n\nDONE WHEN: saved\n\nThat is the plan.",
  );
  check(
    bullets.tasks.length === 2 &&
      /Write a query that Selects full professors\. Requires more than 10 students/.test(
        bullets.tasks[1].title,
      ) &&
      bullets.tasks[1].done === "saved",
    "a task's conditions listed after a blank line stay with the task (they were dropped before)",
  );
}

log("hyperexperimental: commands are lifted too, and a retyped name is set back");
{
  const think =
    "First look, then run the probe.\n\n```bash\ncd /data/app\npython3 -c 'import numpy as np; print(np.__version__, {1, 2})'\n```\n\nAlso run `python3 steal.py --rows 30` and read `stolen_A1.npy`.";
  const lc = liftCommands(think);
  check(
    lc.commands.length === 1 &&
      lc.commands[0].script ===
        "cd /data/app\npython3 -c 'import numpy as np; print(np.__version__, {1, 2})'" &&
      lc.plan.includes(
        '[command block C1 (2 lines) is held by the executor; for it output only "RUN: C1"]',
      ) &&
      !lc.plan.includes("np.__version__"),
    "a shell block is taken out of the plan: the translator sees a marker, never the script",
  );
  const a1 = parseActions("RUN: C1\nRUN: python3 steal.py --rows 30", 8, [], lc.commands);
  check(
    a1.actions.length === 2 &&
      a1.actions[0].kind === "run" &&
      a1.actions[0].command === lc.commands[0].script &&
      a1.unrun.length === 0,
    "RUN: C1 runs the block as one script, exactly as written (the cd holds for the next line)",
  );
  const a2 = parseActions(
    "RUN: cd /data/app\nRUN: python3 -c 'import numpy as np; print(np.**version**, 1, 2)'",
    8,
    [],
    lc.commands,
  );
  check(
    a2.actions.length === 1 &&
      a2.actions[0].kind === "run" &&
      a2.actions[0].command === lc.commands[0].script,
    "a translator that typed the block out line by line, mangled, still runs the block's own text",
  );
  check(
    parseActions("READ: a.txt", 8, [], lc.commands).unrun.join() === "C1",
    "a block no action named is reported as not run",
  );
  check(
    restoreCommand("python3 steal.py --rows 30", think) === "python3 steal.py --rows 30" &&
      restoreCommand("echo **init** a,b done", "Run `echo __init__ {a,b} done` now.") ===
        "echo __init__ {a,b} done" &&
      restoreCommand("ls -la", "Run `echo hi`.") === "ls -la",
    "a one-line command comes back as the plan wrote it when the copy lost its marks; an unrelated one is left alone",
  );
  check(
    restorePath("stolen**A1.npy", think) === "stolen_A1.npy" &&
      restorePath("meeting-scheduled.ics", "write it", ["/data/app/meeting_scheduled.ics"]) ===
        "meeting-scheduled.ics" &&
      restorePath("other.txt", think) === "other.txt",
    "so does a path; a different name is not guessed at",
  );
  const mixed = liftCommands(
    liftFiles("Do it.\n\n```bash\ncat > here.txt <<'EOF'\nline\nEOF\npython3 lifted.py\n```").plan,
  );
  check(
    mixed.commands.length === 1 &&
      mixed.commands[0].script === "python3 lifted.py" &&
      /\[file block: here\.txt[^\n]*\n\[command block C1/.test(mixed.plan),
    "a block that holds a file and a command gives a marker for each",
  );
}

// ---- fences a chat page left out of order (a real Luna reply of 2026-11-23) ----------------------
{
  log("fences: a stray fence, an echoed prompt line, an unmarked file body");
  const F = "```";
  const reply1 = [
    "Create the requested file.",
    "",
    `${F}file:/w/app/run.py`,
    "import asyncio",
    "",
    "async def run_tasks(tasks, n):",
    "    pass",
    F,
    "",
    "Run the following commands to verify the implementation and its import path:",
    "",
    `${F}bash`,
    "cd /w/app",
    "python3 -c 'from run import run_tasks'",
    F,
    "",
    "Then test it:",
    "",
    `${F}bash`,
    "python3 - <<'PY'",
    "import run",
    "PY",
    F,
    "",
    F,
    "",
    F,
  ].join("\n");
  const t1 = tidyFences(reply1);
  check(
    !/```\s*\n\s*```\s*$/.test(t1) && (t1.match(/```/g) ?? []).length === 6,
    "an empty block at the end is dropped",
  );
  const l1 = liftFiles(t1);
  const c1 = liftCommands(l1.plan);
  check(
    l1.files.length === 1 &&
      l1.files[0].content === "import asyncio\n\nasync def run_tasks(tasks, n):\n    pass" &&
      c1.commands.length === 2 &&
      c1.commands[0].script === "cd /w/app\npython3 -c 'from run import run_tasks'",
    "the file body and both command blocks come out whole, none taking a line of another",
  );
  const tail = "This is step 3; 11 steps left after it.";
  const reply3 = `Run the import check:\n\n${F}bash\ncd /w/app\npython3 -c 'import run'\n\n${tail}\n\n${F}\n\n${F}`;
  const c3 = liftCommands(liftFiles(tidyFences(reply3, ["LAST STEP RESULTS: …", tail])).plan);
  check(
    c3.commands.length === 1 && c3.commands[0].script === "cd /w/app\npython3 -c 'import run'",
    "a line that repeats the end of the prompt is never inside a command block",
  );
  const open = tidyFences(`Run this:\n\n${F}bash\nls -la`);
  check(
    liftCommands(open).commands[0]?.script === "ls -la",
    "a command block left open is closed at the end of the reply",
  );
  const half = liftFiles(tidyFences(`${F}file:a.py\nimport os\nx = 1`));
  check(half.files.length === 0, "a file block left open is still not written (half a file)");
  const reply4 = [
    "Replace the entire `run.py` file with the following implementation. `asyncio.TaskGroup` ensures that children are awaited.",
    "",
    F,
    "import asyncio",
    "from collections.abc import Awaitable, Callable",
    F,
    "",
    "Next, run the following verification script.",
    "",
    `${F}bash`,
    "python3 -c 'import run'",
    F,
  ].join("\n");
  const l4 = liftFiles(tidyFences(reply4));
  const c4 = liftCommands(l4.plan);
  check(
    l4.files.length === 1 &&
      l4.files[0].path === "run.py" &&
      l4.files[0].content.startsWith("import asyncio") &&
      c4.commands.length === 1 &&
      c4.commands[0].script === "python3 -c 'import run'",
    "an unmarked block under a sentence that assigns it to one named file is that file's body, not a command",
  );
  const py = liftCommands(`Run the following:\n\n${F}\nimport asyncio\nprint(1)\n${F}`);
  check(
    py.commands.length === 0 &&
      py.skipped.length === 1 &&
      /does not read as shell/.test(py.skipped[0]),
    "an unmarked block that is not shell is not run under 'run the following': the next step is asked",
  );
  check(
    liftCommands(`Run the following:\n\n${F}\nls -la\nFOO=$(pwd) make test\n${F}`).commands
      .length === 1,
    "an unmarked block of shell under 'run' is still a command",
  );
  check(
    liftCommands(`Replace \`run.py\` now:\n\n${F}\nls\n${F}`).commands.length === 0,
    "a file called run.py in the sentence is not the word run",
  );
  check(
    looksLikeShell("cd /w/app\nls") &&
      looksLikeShell("python3 - <<'PY'\nimport os\nPY") &&
      looksLikeShell("# note\nFOO=1 ./run.sh") &&
      !looksLikeShell("import asyncio\nprint(1)") &&
      !looksLikeShell('{"a": 1}') &&
      !looksLikeShell("PREFIX uni: <http://x/>\nSELECT ?a WHERE {}") &&
      !looksLikeShell("x = compute(3)") &&
      !looksLikeShell("def main():\n    pass"),
    "what reads as shell and what does not (Python, JSON, a query)",
  );
  const bad = liftFiles(`${F}file:/w/app/run.py\nimport asyncio\nx = 1\ncd /w/app\n${F}`);
  check(
    bad.files.length === 0 &&
      bad.flagged.length === 1 &&
      /ends with the line `cd \/w\/app`/.test(bad.flagged[0]),
    "a file body that ends with a shell command is flagged, not written",
  );
  check(
    liftFiles(`${F}file:/w/app/go.sh\necho hi\ncd /w/app\n${F}`).files.length === 1,
    "a shell script may end with a shell command",
  );
  check(
    balanceFences(`Did it.\n\n${F}bash\ncd /w/app`) === `Did it.\n\n${F}bash\ncd /w/app\n${F}` &&
      balanceFences(`a\n${F}\nb\n${F}`) === `a\n${F}\nb\n${F}`,
    "a text that leaves a fence open is closed at its end; a balanced one is left alone",
  );
}

{
  log("finish check: a review that came back as a table is read");
  const table = [
    '| CHECK 1: Output format `[{"word": "…", "value": M}]` | RUN: `python3 -m json.tool recover.json` |',
    "| --- | --- |",
    "| CHECK 2: Use the exact field names `word` and `value` | RUN: `grep -c '\"word\"' recover.json` |",
  ].join("\n");
  const rv = parseChecks(table);
  check(
    rv.checks.length === 2 &&
      rv.checks[0].command === "python3 -m json.tool recover.json" &&
      rv.checks[1].command === "grep -c '\"word\"' recover.json" &&
      !rv.checks.some((c) => /\|/.test(c.requirement)),
    "table rows give the same checks as plain lines: two commands, no pipes left in the requirements",
  );
}

log("hyperexperimental: the working memory is kept by code and stays within its bounds");
{
  const m = emptyMemory("An earlier request was answered: made mathx.py.");
  for (let step = 1; step <= 40; step++) {
    addLog(m, step, `Step ${step}: write module_${step}.py and run its test, as planned before`, [
      `WRITE: src/module_${step}.py (120 lines): ok`,
      `RUN: python3 -m unittest tests.test_module_${step}: ${step % 5 ? "ok" : 'exit 1 "AssertionError: 3 != 4"'}`,
    ]);
    addKept(m, [`module_${step}.py exports run_${step}(rows) and needs the column id_${step}`]);
    if (needsFold(m)) foldByCode(m, takeForFold(m));
    pin(m, `src/module_${step}.py`, step);
  }
  const text = renderMemory(m);
  check(
    text.length <= MEMORY_LIMIT &&
      m.log.length < 12 &&
      m.folded + m.log.length === 40 &&
      /STEPS \(recorded by code/.test(text) &&
      /40\. Step 40: write module_40\.py/.test(text) &&
      /EARLIER STEPS \(\d+, folded\)/.test(text) &&
      /KEPT FACTS/.test(text) &&
      /module_40\.py exports run_40/.test(text) &&
      !/module_3\.py exports/.test(text) &&
      /BEFORE THIS JOB:\nAn earlier request was answered/.test(text),
    `after forty steps the memory is within its bound (${text.length} <= ${MEMORY_LIMIT}): the latest steps as lines, the older ones folded, the newest kept facts, what came before the job`,
  );
  check(
    m.pins.length === MAX_PINS &&
      m.pins.map((x) => x.path).join() === "src/module_39.py,src/module_40.py",
    "the pins rotate: forty files were pinned, the last two are",
  );
  const big = Array.from(
    { length: 400 },
    (_, i) => `line ${i + 1} of the big file, with some words`,
  ).join("\n");
  const small = "def add(a, b):\n    return a + b\n";
  const contents = new Map<string, string | null>([
    ["src/module_39.py", big],
    ["src/module_40.py", small],
  ]);
  const pinned = renderPins(m, contents, 2000);
  check(
    pinned.length <= 2000 &&
      /--- src\/module_40\.py \(all 2 lines, as on disk now\) ---\n1\| def add\(a, b\):\n2\|     return a \+ b/.test(
        pinned,
      ) &&
      /--- src\/module_39\.py \(lines 1-\d+ of 400, as on disk now; for others: READ: src\/module_39\.py <first>-<last>\) ---\n  1\| line 1 of/.test(
        pinned,
      ),
    `pinned files are shown with line numbers within their share (${pinned.length} <= 2000): the newest whole, the older one as far as it fits, with how to read the rest`,
  );
  pin(m, "src/module_39.py", 41, 200, 240);
  const moved = renderPins(m, contents, 2400);
  check(
    /--- src\/module_39\.py \(lines 200-2\d\d of 400/.test(moved) &&
      /200\| line 200 of/.test(moved),
    "a pin's window follows the range that was read",
  );
  contents.set("src/module_40.py", null);
  renderPins(m, contents, 2400);
  check(
    m.pins.length === 1 && m.pins[0].path === "src/module_39.py",
    "a pinned file that is gone (or no longer text) is unpinned",
  );
  const out = Array.from({ length: 300 }, (_, i) => `row ${i + 1}: ${"x".repeat(30)}`).join("\n");
  const shown = showOutput(out, 900, "/tmp/provenance-requests/t-out/step3-1.txt");
  const gap =
    /\[… lines (\d+)-(\d+) of 300 are not shown; the whole output is saved: READ: \/tmp\/provenance-requests\/t-out\/step3-1\.txt (\d+)-(\d+) …\]/.exec(
      shown,
    );
  check(
    shown.length <= 900 &&
      shown.startsWith("row 1: ") &&
      shown.endsWith(`row 300: ${"x".repeat(30)}`) &&
      !!gap &&
      gap[1] === gap[3] &&
      gap[2] === gap[4] &&
      Number(gap[1]) > 5 &&
      Number(gap[2]) < 296,
    `a long output is shown once as its first and last whole lines, with the lines left out and the file and range that hold them (${shown.length} <= 900)`,
  );
  check(
    showOutput("short\noutput\n", 900, null) === "short\noutput" &&
      showOutput("", 900, null) === "(no output)",
    "a short output is shown whole",
  );
}

log("hyperexperimental: where an action points, and what needs no translator");
{
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "provenance-orc-target-")));
  const app = path.join(dir, "app");
  mkdirSync(path.join(app, "polyglot"), { recursive: true });
  mkdirSync(path.join(app, "src"));
  writeFileSync(path.join(app, "src", "a.py"), "x = 1\n");
  const request = `Write me a single file in ${app}/polyglot/main.py.c which is a polyglot.`;
  const job = {
    original: request,
    exact: exactNames(request),
    deliverables: deliverablesIn(request, app),
  };
  const w = resolveTarget("main.py.c", app, job, "write");
  check(
    w.path === "polyglot/main.py.c" &&
      /the request names this file as polyglot\/main\.py\.c/.test(w.note ?? ""),
    "a bare file name the request gives in a subfolder is written at the request's own path, and the result says so (the benchmark's polyglot run wrote it one folder up and never recovered)",
  );
  check(
    resolveTarget("app/polyglot/main.py.c", app, job, "write").path === "polyglot/main.py.c" &&
      resolveTarget("app/src/a.py", app, job, "replace").path === "src/a.py" &&
      resolveTarget("src/a.py", app, job, "read").path === "src/a.py" &&
      resolveTarget(`${app}/src/a.py`, app, job, "replace").path === "src/a.py" &&
      resolveTarget("notes/new.txt", app, job, "write").path === "notes/new.txt",
    "a relative path that repeats the folder's own name loses it; paths inside the folder are shown relative to it",
  );
  const out = resolveTarget("/etc/hosts.new", app, job, "write");
  const home = resolveTarget("~/tools/x.py", app, job, "write");
  check(
    /outside the working folder .* the request does not name it/.test(out.refuse ?? "") &&
      !!home.refuse &&
      !!resolveTarget("/usr/lib", app, job, "list").refuse &&
      !resolveTarget("/usr/include/stdio.h", app, job, "read").refuse &&
      !resolveTarget(`${tmpdir()}/provenance-requests/x-out/step1-1.txt`, app, job, "read")
        .refuse &&
      !resolveTarget("/tmp/scratch.txt", app, job, "write").refuse,
    "a write, a listing or a search outside the folder that the request does not name is refused with the reason; a READ of one file, and temp folders, are not",
  );
  const named = { ...job, original: `${request} Also save a copy to /srv/out/copy.c.` };
  check(
    !resolveTarget("/srv/out/copy.c", app, named, "write").refuse,
    "a path outside the folder that the request names is allowed",
  );
  check(
    normaliseRun(`cd "${app}" && python3 t.py`, app) === "python3 t.py" &&
      normaliseRun(`cd ${app} || exit 1\n\necho hi`, app) === "echo hi" &&
      normaliseRun(`cd ${app}/polyglot && ls`, app) === `cd ${app}/polyglot && ls` &&
      normaliseRun(`cd ${app}`, app) === `cd ${app}`,
    "a leading cd into the working folder is dropped from a command (every command starts there); any other cd stays",
  );
  const fl = filesLooked(
    'TARGET="polyglot/main.py.c"\necho "=== x ==="\ncat "$TARGET"\nsed -n \'85,115p\' src/a.py\nnl -ba src/b.py | head',
  );
  check(
    fl.map((f) => `${f.path}:${f.start}-${f.end ?? ""}`).join() ===
      "polyglot/main.py.c:1-,src/a.py:85-115,src/b.py:1-",
    "the files a looking command printed are known (cat, sed -n with its range, nl; a variable set in the script is filled in): they are pinned like a READ",
  );
  const dp = directPlan(
    'Write it and run it.\n\n[file block: a.py (3 lines) is held by the executor; for it output only "WRITE: a.py", with no content]\n\n[command block C1 (2 lines) is held by the executor; for it output only "RUN: C1"]\n- READ: b.py 1-40\nREPLACE: a.py\n<<<\nx\n===\ny\n>>>',
  );
  check(
    dp.sure &&
      dp.text === "WRITE: a.py\nRUN: C1\nREAD: b.py 1-40\nREPLACE: a.py\n<<<\nx\n===\ny\n>>>",
    "a think text that holds only lifted blocks and plain action lines is its own action list, in the order written",
  );
  check(
    !directPlan(
      'Then run `python3 x.py` to check.\n[command block C1 (2 lines) is held by the executor; for it output only "RUN: C1"]',
    ).sure &&
      !directPlan("I think we should consider things carefully.").sure &&
      !directPlan(
        'Old:\n```c\n#if 0\n```\nNew:\n```c\n#if 1\n```\n[command block C1 (1 line) is held by the executor; for it output only "RUN: C1"]',
      ).sure,
    "a command given inside a sentence, a block that was not lifted, or no action at all still goes to the translator",
  );
  check(
    keepLines(
      "Found it.\nKEEP: the table is words(word, value)\n- KEEP: 10 rows, page size 4096\n```\nKEEP: not this\n```",
    ).join("|") === "the table is words(word, value)|10 rows, page size 4096" &&
      parseThought("BLOCKED: no SPARQL engine is installed and none can be").blocked ===
        "no SPARQL engine is installed and none can be" &&
      parseThought("Run it.\n```bash\nls\n```\nBLOCKED: later maybe").blocked === null &&
      parseThought("FINISHED: done").blocked === null,
    "KEEP: lines are the think step's own notes (outside code blocks); BLOCKED: ends the job only in a reply that gives nothing to run",
  );
}

// ---- stand-in router --------------------------------------------------------------------------
interface Seen {
  role: string;
  instructions: string;
  input: string;
  session: string;
  body: Record<string, unknown>;
}
const seen: Seen[] = [];
let summaries = 0;
const ROLES: [string, string][] = [
  ["You decide how a coding request", "planner"],
  ["A coding job is being done", "revise"],
  ["Write the reply to the user", "final"],
  ["You check a finished coding job", "review"],
  ["You direct a coding job", "think"],
  ["Turn the PLAN into actions", "translate"],
  ["You keep the digest", "summarize"],
];
/** Failures the stand-in router serves before it answers: by role and a word in the prompt. */
type Fault = {
  role: string;
  match: RegExp;
  /** An HTTP status, a stream that ends in response.failed ("empty reply"), or a blank reply. */
  kind: number | "failed-empty" | "blank";
  times: number;
};
const faults: Fault[] = [];
const LIFT_THINK = [
  "Create the script and a data file, then run it.",
  "",
  "```file:lifted.py",
  "import os",
  "# RUN: rm -rf /   (a comment that looks like an action)",
  'print("lifted", "$HOME `date` <<<")',
  "```",
  "",
  "```bash",
  "cat > here.txt <<'EOF'",
  "line one $NOT_EXPANDED",
  "WRITE: not-an-action.txt",
  "EOF",
  "python3 lifted.py",
  "```",
].join("\n");
function answer(role: string, whole: string, instructions = ""): string | number {
  const step = Number(/This is step (\d+)/.exec(whole)?.[1] ?? 0);
  // The planner and think are scripted by the request alone (the notes repeat older requests).
  const input =
    role === "planner" || role === "think"
      ? (/^(?:REQUEST|GOAL):\n([\s\S]*?)\n\nFOLDER/.exec(whole)?.[1] ?? whole)
      : whole;
  switch (role) {
    case "planner":
      if (/r503/.test(input)) return 503;
      if (/notools always/.test(input)) return "TASK 1: NOTOOLS ALWAYS do it\nDONE WHEN: ok";
      if (/notools/.test(input)) return "TASK 1: NOTOOLS write it\nDONE WHEN: ok";
      if (/hello/.test(input)) return "ANSWER: Hi! Nothing to do in the folder.";
      if (/declinetwice/.test(input)) return "I cannot access your files or run anything here.";
      if (/decline/.test(input))
        return instructions.includes("Your last reply said")
          ? "TASK 1: Follow up on it\nDONE WHEN: done"
          : "I'm sorry, but I can't run commands on your computer. You could run these yourself:\n\nls -la";
      if (/inspectonly/.test(input))
        return "TASK 1: Inspect the files with ls and dump the header of main.db\nDONE WHEN: listed";
      if (/flaky/.test(input))
        return "LARGE: three stages\nTASK 1: Set up\nDONE WHEN: ok\nTASK 2: FLAKY thing\nDONE WHEN: ok\nTASK 3: Wrap up\nDONE WHEN: ok";
      // A planner that respells what the request names: the file and the count.
      if (/paraphrase/.test(input))
        return "LARGE: two stages, each with its own check\nTASK 1: Write the 20 rows to rows_final.csv NEARMISS rows_final.csv\nNEEDS: 1\nDONE WHEN: rows_final.csv has 20 rows\nTASK 2: Check the csv\nNEEDS: 2\nDONE WHEN: ok";
      if (/smalljob/.test(input))
        return "TASK 1: Look at the folder\nDONE WHEN: seen\nTASK 2: Tidy it\nDONE WHEN: tidy\nTASK 3: Check it\nDONE WHEN: ok";
      if (/onejob|stalejob/.test(input)) return "ONE";
      if (/partlyjob/.test(input))
        return "LARGE: two stages\nTASK 1: PARTLY inspect the inputs\nDONE WHEN: seen\nTASK 2: Write the script\nDONE WHEN: it runs";
      if (/askalways/.test(input)) return "TASK 1: ASKME ALWAYS run it";
      if (/budget/.test(input)) return "TASK 1: LOOPCALLS circle";
      if (/quiet/.test(input)) return "TASK 1: QUIETTASK think slowly";
      if (/multi/.test(input))
        return "LARGE: three files, each with its own check\n\nHere's the plan:\n\n**Task 1:** Create `mathx.py` with add and mul\n- Done when: the file imports cleanly\n2) Write test_mathx.py covering both functions (done when: tests exist)\n### Step 3 - Run the tests\nAcceptance: pytest passes";
      if (/blocked/.test(input))
        return "LARGE: three stages\nTASK 1: Set up\nDONE WHEN: ok\nTASK 2: BLOCKME install the thing\nDONE WHEN: installed\nTASK 3: Use the thing\nDONE WHEN: used";
      if (/stuck/.test(input)) return "TASK 1: BLOCKME forever\nDONE WHEN: never";
      if (/many/.test(input))
        return `LARGE: seven parts\n${Array.from(
          { length: 7 },
          (_, i) => `TASK ${i + 1}: Part ${i + 1}\nDONE WHEN: ok`,
        ).join("\n")}`;
      if (/slow/.test(input)) return "TASK 1: SLOWTASK wait a long time";
      if (/askme/.test(input)) return "TASK 1: ASKME run it";
      if (/nocap/.test(input)) return "TASK 1: NOCAP";
      if (/calls/.test(input)) return "TASK 1: LOOPCALLS";
      if (/silent/.test(input)) return "TASK 1: IDLETASK";
      if (/claims/.test(input)) return "TASK 1: FAILLAST run the check";
      return "TASK 1: Follow up on it\nDONE WHEN: done";
    case "revise":
      if (/BLOCKME forever/.test(input)) return "TASK 1: BLOCKME forever\nDONE WHEN: never";
      if (/REQUEST:\n\[1\] calls/.test(input)) return "TASK 1: LOOPCALLS more";
      if (/REQUEST:\n\[1\] stalejob/.test(input))
        return "TASK 1: LOOKSONLY verify it another way\nDONE WHEN: verified\nTASK 2: LOOKSONLY verify it once more\nDONE WHEN: verified";
      return "1. Do the thing another way\n   Done when: it works\n2. Use the thing";
    case "final":
      return "All done: the tasks finished.";
    case "review":
      // The reviewer names what the evidence does not show, each with one command; code runs them.
      if (/mumble/.test(input)) return "R1: Make the thing the request";
      if (/checkpass/.test(input))
        return "Two things are not shown.\n\nCHECK 1: the folder still holds its README\n```bash\ntest -s README.md && echo readme ok\n```\n\nCHECK 2: the count is three | RUN: `printf 'a\\nb\\nc\\n' | wc -l | grep -q 3`";
      if (/checkfail/.test(input)) {
        const mark = /FIXES (\w+)/.exec(input)?.[1] ?? "fixedmark";
        return `CHECK 1: the marker exists after the job\n\`\`\`bash\ntest -f ${mark}.txt || { echo ${mark}.txt is missing; exit 1; }\n\`\`\``;
      }
      if (/checkunsafe/.test(input))
        return "CHECK 1: the build folder is clean\n```bash\nrm -rf build && test ! -d build\n```\nCHECK 2: a tool nobody has\n```bash\nno-such-tool-orc --version\n```";
      if (/hfinish/.test(input))
        return "CHECK 1: hfin.txt holds 4 lines\n```bash\ntest \"$(wc -l < hfin.txt | tr -d ' ')\" -eq 4 || { echo \"hfin.txt has $(wc -l < hfin.txt | tr -d ' ') lines, not 4\"; exit 1; }\n```";
      return "ALL SHOWN";
    case "think":
      if (/module/.test(input)) {
        if (step === 1)
          return 'First create mathx.py with this content:\n```python\ndef add(a, b):\n    return a + b\n```\nThen run `python3 -c "import mathx; print(mathx.add(2, 3))"` to check it.';
        if (step === 2)
          return "Now replace the return line in mathx.py so it carries a comment, then search for def add and list the folder.";
        return "It printed 5.\n\nFINISHED: Created mathx.py with add(); running it printed 5.";
      }
      if (/hfinish/.test(input)) {
        if (step === 1) return "Write the file.\n\n```file:hfin.txt\na\nb\nc\n```";
        if (step === 2) return "FINISHED: wrote hfin.txt.";
        if (step === 3)
          return "Add the fourth line and count them, from the folder itself.\n\n```file:hfin.txt\na\nb\nc\nd\n```\n\n```bash\ncd . && wc -l hfin.txt\necho __counted__ {a,b}\n```";
        return "FINISHED: hfin.txt has 4 lines, counted with wc -l.\nNOT CHECKED: nothing";
      }
      if (/hlooking/.test(input))
        return step <= 2
          ? `Read it again, part ${step}: run cat README.md | head -n ${step}.`
          : "BLOCKED: README.md is all there is; nothing here says what to write.";
      if (/hpoly/.test(input))
        return step === 1
          ? "Create `poly.txt` with this exact content:\n```\nhi\n```\n\nAnd a copy for the system:\n\n```file:/etc/orc-nope.txt\nx\n```"
          : "FINISHED: wrote poly.txt.\nNOT CHECKED: nothing";
      if (/hlong/.test(input)) {
        if (step > 12)
          return "FINISHED: all twelve modules are written and were run.\nNOT CHECKED: nothing";
        const body = Array.from(
          { length: 60 },
          (_, i) =>
            `def f${step}_${i}(rows):\n    return [r for r in rows if r % ${i + 2} == ${step}]`,
        ).join("\n");
        // (a long output was saved: one step reads a range of it instead of running the command again)
        const saved = /saved: READ: (\S+step\d+-\d+\.txt) \d+-\d+/.exec(whole)?.[1];
        return [
          `Step ${step}: write mod_${step}.py and run it over the rows.`,
          `KEEP: mod_${step}.py exports f${step}_0 … f${step}_59 and was written in step ${step}`,
          "",
          `\`\`\`file:src/mod_${step}.py`,
          body,
          "```",
          "",
          "```bash",
          `python3 -c "for i in range(400): print('step ${step} row', i, 'x' * 40)"`,
          "```",
          ...(step === 3 && saved ? ["", `READ: ${saved} 100-102`] : []),
        ].join("\n");
      }
      if (/hmangle/.test(input))
        return step === 1 ? "Run `echo __init__ {a,b} done` now." : "FINISHED: Echoed.";
      if (/retryok/.test(input)) return "FINISHED: Got through.";
      if (/retryfail/.test(input))
        return /\n1\. Run echo one\./.test(whole) ? "FINISHED: Resumed fine." : "Run echo one.";
      if (/emptyreply/.test(input)) return "FINISHED: After an empty reply.";
      if (/liftjob/.test(input)) return step === 1 ? LIFT_THINK : "FINISHED: Lifted.";
      if (/nobody/.test(input))
        return step === 1
          ? "Write big.py with the parser in it."
          : step === 2
            ? "I think we should consider things carefully."
            : step === 3
              ? "Here it is.\n\n```file:big.py\nprint('big')\n```\nThen run it with python3."
              : "FINISHED: big.py written and run.";
      if (/pathcheck/.test(input))
        return step === 1 ? "Run echo PATHIS $PATH" : "FINISHED: Path seen.";
      if (/again/.test(input)) return "Run echo same once more.";
      if (/steps/.test(input)) return `Run touch step-${step}.txt now.`;
      if (/nothing/.test(input)) return "I think we should consider things carefully.";
      if (/hslow/.test(input)) return "Run sleep 30.";
      if (/hask|hro/.test(input))
        return step === 1
          ? "Write notes.txt saying hello, then run echo hi."
          : "FINISHED: Tried it.";
      if (/h503/.test(input)) return "Do the h503 thing.";
      return "FINISHED: Nothing to do.";
    case "translate":
      if (/h503/.test(input)) return 503;
      // (a chat page's rendering of the copy: the dunder as bold, the braces gone)
      if (/echo __init__/.test(input)) return "RUN: echo **init** a,b done";
      if (/Read it again, part (\d)/.test(input))
        return `RUN: cat README.md | head -n ${/part (\d)/.exec(input)?.[1]}`;
      if (/echo one/.test(input)) return "RUN: echo one";
      if (/file block: lifted\.py/.test(input))
        return "WRITE: lifted.py\nRUN: cat > here.txt\nRUN: python3 lifted.py";
      if (/big\.py with the parser/.test(input)) return "WRITE: big.py\nRUN: python3 big.py";
      if (/file block: big\.py/.test(input)) return "WRITE: big.py\nRUN: python3 big.py";
      if (/PATHIS/.test(input)) return "RUN: echo PATHIS $PATH";
      if (/create mathx\.py/.test(input))
        return 'Sure, here are the actions:\n\n1. **WRITE:** `mathx.py`\n```python\ndef add(a, b):\n    return a + b\n```\n2. RUN: `python3 -c "import mathx; print(mathx.add(2, 3))"`\n3. read: mathx.py lines 1-2';
      if (/replace the return line/.test(input))
        return 'REPLACE: mathx.py\n<<<\nreturn a + b\n===\nreturn a + b  # sum\n>>>\nSEARCH: "def add" IN .\nLIST: .';
      if (/echo same/.test(input)) return "RUN: echo same";
      if (/touch step-/.test(input))
        return `RUN: touch step-${/touch step-(\d+)/.exec(input)?.[1]}.txt`;
      if (/sleep 30/.test(input)) return "RUN: sleep 30";
      if (/notes\.txt/.test(input)) return "WRITE: notes.txt\n<<<\nhello\n>>>\nRUN: echo hi";
      return "NONE";
    case "summarize":
      return `SUMMARY v${++summaries}: mathx.py holds add(); the check printed 5. ${"More detail than anyone needs. ".repeat(140)}`;
  }
  return 404;
}
const router = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url !== "/v1/responses" || req.method !== "POST") return void res.writeHead(404).end();
    const body = JSON.parse(raw) as Record<string, unknown>;
    const instructions = String(body.instructions ?? "");
    const msgs = body.input as { role: string; content: { text: string }[] }[];
    const input = msgs.map((m) => m.content.map((c) => c.text).join("")).join("\n");
    const role = ROLES.find(([start]) => instructions.startsWith(start))?.[1] ?? "?";
    seen.push({
      role,
      instructions,
      input,
      session: String(req.headers["x-pcore-session"] ?? ""),
      body,
    });
    if (/hangcall/.test(input)) return; // never answers: only an interrupt ends this call
    const fault = faults.find((f) => f.times > 0 && f.role === role && f.match.test(input));
    if (fault) fault.times--;
    if (fault?.kind === "failed-empty" || fault?.kind === "blank") {
      res.writeHead(200, { "content-type": "text/event-stream", "x-pcore-model": "fake/empty" });
      res.write(`event: x\ndata: ${JSON.stringify({ type: "response.created" })}\n\n`);
      res.write(
        `event: x\ndata: ${JSON.stringify(
          fault.kind === "blank"
            ? { type: "response.completed", response: { output: [] } }
            : {
                type: "response.failed",
                response: {
                  error: { code: "empty_reply", message: "empty reply from fake/empty" },
                },
              },
        )}\n\n`,
      );
      return void res.end();
    }
    const out = fault ? (fault.kind as number) : answer(role, input, instructions);
    if (typeof out === "number") {
      res.writeHead(out, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({
          error: {
            message: "no model in spark (or below) could serve this: [pool/spark: 429]",
            code: "no_capacity",
          },
        }),
      );
    }
    res.writeHead(200, { "content-type": "text/event-stream", "x-pcore-model": "fake/model" });
    const ev = (o: unknown) => res.write(`event: x\ndata: ${JSON.stringify(o)}\n\n`);
    const half = Math.floor(out.length / 2);
    ev({ type: "response.created" });
    ev({ type: "response.output_text.delta", delta: out.slice(0, half) });
    ev({ type: "response.output_text.delta", delta: out.slice(half) });
    ev({
      type: "response.completed",
      response: { output: [{ type: "message", content: [{ type: "output_text", text: out }] }] },
    });
    res.end();
  });
});
await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
const routerUrl = `http://127.0.0.1:${(router.address() as { port: number }).port}`;

// ---- the backend over a real WebSocket ----------------------------------------------------------
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "provenance-orchestrator-check-")));
const work = path.join(scratch, "work");
mkdirSync(work);
writeFileSync(path.join(work, "README.md"), "scratch\n");
const dataDir = path.join(scratch, "data");
const fakeLog = path.join(scratch, "appserver.jsonl");
writeFileSync(fakeLog, "");
process.env.FAKE_ORC_LOG = fakeLog;
type LogLine = {
  threadStart?: Record<string, unknown>;
  turnStart?: {
    threadId: string;
    brief: string;
    approvalPolicy?: unknown;
    sandboxPolicy?: { type: string; writableRoots?: string[]; networkAccess?: boolean };
  };
  exec?: {
    command: string[];
    cwd: string;
    sandboxPolicy: { type: string; writableRoots?: string[] };
    env: { PATH: string | null; TERM: string | null } | null;
  };
  interrupt?: string;
  terminate?: string;
  approval?: { decision?: string };
};
const fake = () =>
  readFileSync(fakeLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogLine);
const traces: TraceEvent[] = [];
// The shells the stand-in app-server starts read this folder's .zshrc, not the user's: it puts a
// marker folder at the front of PATH, the way pyenv or nvm do from ~/.zshrc.
const zdot = path.join(scratch, "zdot");
mkdirSync(zdot);
writeFileSync(path.join(zdot, ".zshrc"), 'export PATH="/orc-marker-bin:$PATH"\necho rc noise\n');
const appServer = new AppServerProcess({
  bin: path.join(here, "fixtures/fake-orc-appserver.mjs"),
  runDir: path.join(dataDir, "run"),
  env: () => ({ ZDOTDIR: zdot }),
  log: () => {},
});
const CAPS = {
  tasks: 4,
  attempts: 2,
  replans: 3,
  steps: 4,
  noProgressSteps: 3,
  lookSteps: 2,
  modelCalls: 30,
  workerCalls: 12,
  workerMs: 20_000,
  workerIdleMs: 1500,
  commandMs: 10_000,
  retryDelaysMs: [30, 60, 90],
};
const makeBackend = () =>
  new OrchestratorBackend({
    dir: dataDir,
    appServer: () => appServer,
    callModel: makeCallModel(() => ({ url: routerUrl })),
    caps: CAPS,
    log: () => {},
    trace: (e) => traces.push(e),
  });
let backend = makeBackend();
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => wss.once("listening", r));
wss.on("connection", (ws) => backend.attach(ws));
const port = (wss.address() as { port: number }).port;

type TurnItem = {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregatedOutput?: string;
  status?: string;
  exitCode?: number;
  changes?: { path: string; diff: string; kind: { type: string } }[];
};
type Turn = {
  id: string;
  status: string;
  durationMs?: number;
  items: TurnItem[];
  error: { message: string } | null;
  orchestration?: {
    modelCalls: number;
    retries: number;
    workers: number;
    workerCalls: number;
    steps: number;
    roles: Record<string, { calls: number; maxPromptChars: number }>;
    workerMaxInputTokens: number;
    finish?: {
      requirements: number;
      open: number;
      code: number;
      followUps: number;
      reviewed?: boolean;
      passed?: number;
    };
    handoffs?: number;
    direct?: number;
    refused?: number;
  };
};
type Msg = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
};
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const notes: Msg[] = [];
const waits = new Map<number, (m: Msg) => void>();
let seq = 0;
ws.on("message", (d) => {
  const m = JSON.parse(String(d)) as Msg;
  if (m.id !== undefined && !m.method) waits.get(m.id as number)?.(m);
  else notes.push(m);
});
await new Promise((r) => ws.once("open", r));
const call = (method: string, params: unknown) =>
  new Promise<Msg>((resolve) => {
    const id = ++seq;
    waits.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const until = async <T>(
  what: string,
  f: () => T | undefined | false | null,
  ms = 20_000,
): Promise<T> => {
  const t0 = performance.now(); // (one check below moves the wall clock)
  for (;;) {
    const v = f();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const turnDone = (threadId: string, ms = 20_000) =>
  until(
    `turn/completed in ${threadId}`,
    () => {
      const n = notes.find((x) => x.method === "turn/completed" && x.params?.threadId === threadId);
      if (!n) return null;
      notes.splice(notes.indexOf(n), 1);
      return n.params!.turn as Turn;
    },
    ms,
  );
const text = (s: string) => [{ type: "text", text: s, text_elements: [] }];
const start = async (orchestrator: string, extra: Record<string, unknown> = {}) => {
  const r = await call("thread/start", {
    model: orchestrator === "hyperexperimental" ? "luna/solstice" : "pool/spark",
    cwd: work,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    config: { orchestrator },
    ...extra,
  });
  if (r.error) throw new Error(r.error.message);
  return (r.result as { thread: { id: string; orchestrator: string } }).thread;
};
const say = async (threadId: string, s: string, extra: Record<string, unknown> = {}) => {
  const r = await call("turn/start", { threadId, input: text(s), ...extra });
  if (r.error) throw new Error(r.error.message);
};
const stored = (id: string) =>
  JSON.parse(readFileSync(path.join(dataDir, "threads", `${id}.json`), "utf8")) as {
    notes: ReturnType<typeof emptyNotes>;
    summary: string;
    openGoal?: string | null;
    orchestrator: string;
    turns: Turn[];
  };
const last = (t: Turn) => t.items.at(-1)?.text ?? "";
const kindsOf = (t: Turn) => t.items.map((i) => i.type).join(",");

check(
  notes.some((n) => n.method === "bridge/status"),
  "the page gets a ready status on connect",
);
const refused = await call("thread/start", { model: "pool/spark", cwd: work });
check(
  /config\.orchestrator/.test(refused.error?.message ?? ""),
  "thread/start without an orchestrator is refused",
);
const refused2 = await call("thread/start", {
  model: "claude:opus",
  cwd: work,
  config: { orchestrator: "experimental" },
});
check(/tier/.test(refused2.error?.message ?? ""), "a fallback model is refused");

// ---- Experimental -------------------------------------------------------------------------------
log("experimental: a multi-task job");
const ex = await start("experimental");
check(
  ex.id.startsWith("orc-experimental-") && ex.orchestrator === "experimental",
  "thread/start: an orc- thread that records its orchestrator",
);
await say(ex.id, "multi: make a tiny module with a test and run it");
let turn = await turnDone(ex.id);
check(turn.status === "completed", "turn completed");
check(
  kindsOf(turn) ===
    "userMessage,agentMessage," +
      Array(3).fill("agentMessage,commandExecution,fileChange").join(",") +
      ",agentMessage",
  `items: the plan, then per task a header and the worker's command and edit, then the answer (${kindsOf(turn)})`,
);
check(
  /^Plan, 3 tasks:/.test(turn.items[1].text ?? "") &&
    /3\. Run the tests/.test(turn.items[1].text ?? ""),
  "the plan is shown",
);
check(
  /\*\*Task 2 of 3:\*\* Write test_mathx.py/.test(turn.items[5].text ?? ""),
  "each task is announced",
);
check(
  turn.items[3].id.startsWith(`${turn.id}-w1-`) &&
    turn.items[3].command?.startsWith("/bin/zsh -lc 'python3 check.py Create mathxpy"),
  "worker items keep their content under ids of this turn",
);
check(last(turn) === "All done: the tasks finished.", "the final answer comes from the final call");
check(
  notes.some(
    (n) => n.method === "item/commandExecution/outputDelta" && n.params?.threadId === ex.id,
  ),
  "a worker's command output streams into the visible thread",
);
check(
  notes.some((n) => n.method === "turn/plan/updated" && (n.params?.plan as unknown[]).length === 3),
  "turn/plan/updated carries the task list",
);
let lines = fake();
const starts = lines.filter((l) => l.threadStart).map((l) => l.threadStart!);
check(starts.length === 3, "three workers, three fresh threads");
check(
  starts.every(
    (s) =>
      s.ephemeral === true &&
      s.sandbox === "workspace-write" &&
      s.approvalPolicy === "on-request" &&
      s.model === "pool/spark" &&
      s.cwd === work,
  ),
  "each worker thread is ephemeral, with the thread's tier, folder, sandbox and approval preset",
);
const briefs = lines.filter((l) => l.turnStart).map((l) => l.turnStart!.brief);
check(
  briefs.every((b) => b.length <= BRIEF_BUDGET),
  `every brief is within its budget (largest ${Math.max(...briefs.map((b) => b.length))} <= ${BRIEF_BUDGET})`,
);
check(
  /YOUR TASK \(1 of 3\): Create `mathx\.py`/.test(briefs[0]) &&
    /DONE WHEN: the file imports cleanly/.test(briefs[0]) &&
    /\(none: you are first\)/.test(briefs[0]),
  "the first brief: the task, its done-criteria, no notes yet",
);
check(
  /DONE \(as reported by workers\):\n- Create `mathx\.py` with add and mul: finished/.test(
    briefs[1],
  ) &&
    /FILES CHANGED \(recorded\): f-\d+\.txt \(add\)/.test(briefs[1]) &&
    /- ok: python3 check.py Create mathxpy/.test(briefs[1]),
  "the second brief carries the notes: what was reported, files and commands as recorded",
);
check(
  /LATER TASKS[^\n]*Run the tests/.test(briefs[1]) && !/LATER TASKS/.test(briefs[2]),
  "a brief names the later tasks as not its own",
);
check(
  briefs.every((b) => !b.includes("STILL TO DO")) &&
    briefs.every(
      (b) =>
        /run the result the way the request says it will be used/.test(b) &&
        /keep a copy of any input before a tool that may change it opens it/.test(b) &&
        /check the result against every size, count or shape the request states/.test(b),
    ),
  "a brief carries the three rules of checking (run it as used, copy before you open, hold it to the stated sizes), and not the planner's to-do list",
);
const turnStarts = lines.filter((l) => l.turnStart).map((l) => l.turnStart!);
check(
  turnStarts.every(
    (t) =>
      t.approvalPolicy === "on-request" &&
      t.sandboxPolicy?.type === "workspaceWrite" &&
      t.sandboxPolicy.writableRoots?.length === 0 &&
      t.sandboxPolicy.networkAccess === false,
  ),
  "a worker's turn/start carries the preset the way the page sends it for a normal thread",
);
let rec = stored(ex.id);
check(
  rec.orchestrator === "experimental" &&
    rec.notes.done.length === 3 &&
    rec.notes.files.length >= 1 &&
    rec.notes.pending.length === 0,
  "the thread file keeps the orchestrator and the notes; nothing is left to do",
);
check(notesText(rec.notes).length <= NOTES_LIMIT, "notes under the bound");
{
  const snap = snapshot(work);
  writeFileSync(path.join(work, "made-by-a-command.txt"), "x");
  writeFileSync(path.join(work, "README.md"), "scratch, edited\n");
  const ch = changedSince(work, snap)
    .map((c) => `${c.path}:${c.kind}`)
    .sort()
    .join(",");
  check(
    ch === "README.md:update,made-by-a-command.txt:add",
    `files a command wrote are found by comparing the folder (${ch})`,
  );
  check(
    unwrap("/bin/zsh -lc 'npm test'") === "npm test" &&
      unwrap('/bin/zsh -lc "echo \\"hi\\" > a.txt"') === 'echo "hi" > a.txt' &&
      unwrap("ls -la") === "ls -la",
    "the shell wrapper comes off a command, single- or double-quoted",
  );
}
check(
  turn.orchestration?.modelCalls === 9 &&
    turn.orchestration.workers === 3 &&
    turn.orchestration.workerCalls === 6 &&
    turn.orchestration.roles.planner.calls === 1 &&
    turn.orchestration.roles.review.calls === 1 &&
    turn.orchestration.roles.final.calls === 1,
  `the turn records what it cost: 9 model calls = planner + 3 workers x 2 + the finish check + final (${JSON.stringify(turn.orchestration)})`,
);
check(
  turn.orchestration?.finish?.reviewed === true &&
    turn.orchestration.finish.requirements === 0 &&
    turn.orchestration.finish.open === 0 &&
    turn.orchestration.finish.followUps === 0,
  "and what the finish check came to: a split job is reviewed, the reviewer named nothing the evidence does not show, no fix task",
);
const exSeen = seen.slice();
check(
  exSeen.length === 3 &&
    exSeen[0].role === "planner" &&
    exSeen[1].role === "review" &&
    exSeen[2].role === "final",
  "three plain calls reached the router: the planner, the finish check, the closing words",
);
check(
  /THE REQUEST, word for word:\n"""\nmulti: make a tiny module with a test and run it\n"""/.test(
    exSeen[1].input,
  ) &&
    /EVIDENCE, files changed:\n- f-\d+\.txt \(add, /.test(exSeen[1].input) &&
    /EVIDENCE, commands run[^\n]*\n- exit 0: python3 check\.py Create mathxpy[^\n]*\n    \| out/.test(
      exSeen[1].input,
    ) &&
    /SETTLED BY CODE[^\n]*\n- nothing was written outside the working folder[^\n]*\n- the last recorded command exited 0/.test(
      exSeen[1].input,
    ) &&
    !/CLAIMED|finished "/.test(exSeen[1].input),
  "the reviewer reads the request word for word against the evidence: each command with its exit code and the end of its output, the files, what code settled; nothing in the workers' own words",
);
check(
  exSeen.every(
    (s) =>
      (s.body.input as unknown[]).length === 1 &&
      s.body.store === false &&
      s.body.stream === true &&
      !("previous_response_id" in s.body) &&
      !("tools" in s.body) &&
      s.body.model === "pool/spark",
  ),
  "each is one user message, streamed, not stored, no tools, nothing to attach it to an earlier chat",
);
check(
  new Set(exSeen.map((s) => s.session)).size === exSeen.length &&
    exSeen.every((s) => s.session.startsWith("orc-")),
  "each has a session key of its own",
);
check(
  /FOLDER: .*work \(.*\); contains: README\.md/.test(exSeen[0].input),
  "the planner sees a one-line listing of the folder",
);
check(
  /DONE \(as reported/.test(exSeen[2].input) && /LAST WORKER'S REPORT/.test(exSeen[2].input),
  "the final call is written from the notes",
);

log("experimental: a follow-up starts from the notes");
seen.length = 0;
await say(ex.id, "now a follow-up on that");
turn = await turnDone(ex.id);
check(
  turn.status === "completed" && /RESULT: finished "Follow up on it"/.test(last(turn)),
  "a one-task turn answers with the worker's report, no final call",
);
check(!/STATUS:/.test(last(turn)), "without its STATUS line");
check(
  seen.map((s) => s.role).join(",") === "planner" &&
    turn.orchestration?.finish?.reviewed === false &&
    turn.orchestration.modelCalls === 3,
  "one plain call, the planner: a job one worker did whole, ran, and reports nothing unchecked about gets no reviewer (3 model calls: planner + the worker's 2; it was 4 with the review)",
);
check(
  /GOAL: multi: make a tiny module/.test(seen[0].input) &&
    /- Run the tests with pytest|Run the tests/.test(seen[0].input) &&
    !seen[0].input.includes("All done: the tasks finished."),
  "the planner got the notes (goal, finished tasks), not the earlier conversation",
);
const fb = fake()
  .filter((l) => l.turnStart)
  .at(-1)!.turnStart!.brief;
check(
  /EARLIER IN THIS THREAD: multi: make a tiny module/.test(fb) &&
    /THE REQUEST, word for word[^\n]*\n"""\nnow a follow-up on that\n"""/.test(fb) &&
    /YOUR TASK \(1 of 1\): now a follow-up on that\nA planner suggested this order of work[^\n]*1\. Follow up on it/.test(
      fb,
    ),
  "the worker's brief has the new request word for word, the thread's earlier goal, and the planner's task only as a suggestion",
);

log("experimental: a direct answer");
seen.length = 0;
const hello = await start("experimental");
await say(hello.id, "hello");
turn = await turnDone(hello.id);
check(
  turn.status === "completed" &&
    last(turn) === "Hi! Nothing to do in the folder." &&
    turn.orchestration?.workers === 0 &&
    seen.length === 1,
  "ANSWER: from the planner is the reply: one call, no worker",
);

log("experimental: a blocker, a revised plan");
seen.length = 0;
const bl = await start("experimental");
await say(bl.id, "blocked: do the thing");
turn = await turnDone(bl.id);
check(turn.status === "completed", "turn completed");
check(
  seen.map((s) => s.role).join(",") === "planner,revise,review,final",
  "the planner was asked to revise after the blocked task",
);
const rv = seen[1].input;
check(
  /TASK THAT HIT A PROBLEM: BLOCKME install the thing/.test(rv) &&
    /frobnicate is missing/.test(rv) &&
    /1\. Use the thing/.test(rv),
  "the revision sees the task, its report and what was still planned",
);
check(
  turn.items.some((i) => /Revised plan:\n\n1\. Do the thing another way/.test(i.text ?? "")),
  "the revised plan is shown",
);
rec = stored(bl.id);
check(
  rec.notes.problems.some((p) => /frobnicate/.test(p)) && rec.notes.done.length === 3,
  "the notes keep the problem and the three finished tasks",
);

seen.length = 0;
const li = await start("experimental");
await say(li.id, "claims done");
turn = await turnDone(li.id);
check(
  seen.map((s) => s.role).join(",") === "planner,revise,review,final" &&
    /reported done, but its last command failed: python3 check\.py FAILLAST/.test(seen[1].input) &&
    /ImportError: no module named frob/.test(seen[1].input),
  "a worker that says DONE over a failed last command is not believed: the planner gets the command and its output",
);

log("experimental: caps");
const st = await start("experimental");
await say(st.id, "stuck: this cannot work");
turn = await turnDone(st.id);
check(
  turn.status === "completed" &&
    /^Stopped: the task "BLOCKME forever" came up 3 times/.test(last(turn)),
  `tries per task: a plain message (${last(turn).split("\n")[0]})`,
);
check(
  /Where things stand:/.test(last(turn)) && /PROBLEMS HIT/.test(last(turn)),
  "with where things stand",
);
const many = await start("experimental");
await say(many.id, "many parts");
turn = await turnDone(many.id);
check(
  /^Stopped after 4 tasks, the limit for one message\. Not done: "Part 5", "Part 6", "Part 7"/.test(
    last(turn),
  ),
  "tasks per turn: stops and names what is left",
);
const calls = await start("experimental");
let before = fake().filter((l) => l.interrupt).length;
await say(calls.id, "calls: loop on model calls");
turn = await turnDone(calls.id);
check(
  turn.status === "completed" &&
    /^Stopped with the job partly done: "LOOPCALLS more" hit a problem \(the worker stopped: it used its budget of 8 model requests for one task\), and 28 of this turn's 30 model calls are used: not enough is left to revise the plan and run it\. Not done: "LOOPCALLS more"\. Send "continue" to go on\./.test(
      last(turn),
    ),
  `budgets follow what is left: the turn stops with a partial result that says what is not done, before the wall (${last(turn).split("\n")[0]})`,
);
check(
  fake().filter((l) => l.interrupt).length === before + 2 &&
    turn.orchestration?.modelCalls === 28 &&
    turn.orchestration.workerCalls === 26,
  "the one worker of the unsplit job had 18 requests (one and a half tasks' worth), the next only the 8 that were left; the reserve for the finish was never spent on work",
);
check(
  /Where things stand:/.test(last(turn)) &&
    stored(calls.id)
      .notes.pending.map((t) => t.title)
      .join("|") === "LOOPCALLS more",
  'the notes keep the task that is left, so "continue" goes on from it',
);
{
  // The same with time: when the turn's minutes are nearly used, no task is started.
  const caps = backend.caps as { turnMs: number };
  const keep = caps.turnMs;
  caps.turnMs = 60_000; // less than one task's minimum plus the reserve
  const tm = await start("experimental");
  await say(tm.id, "many parts");
  turn = await turnDone(tm.id);
  caps.turnMs = keep;
  check(
    turn.status === "completed" &&
      /^Stopped with the job partly done: 0 of this turn's 1 minutes are used, and what is left is not enough for another task\. Not done: "Part 1", "Part 2"/.test(
        last(turn),
      ) &&
      turn.orchestration?.workers === 0,
    `and with the turn's time: too little left for a task ends the turn before one is started (${last(turn).split("\n")[0].slice(0, 90)})`,
  );
}

const idleT = await start("experimental");
await say(idleT.id, "silent model");
turn = await turnDone(idleT.id);
check(
  turn.status === "failed" &&
    /^The model stopped answering: a worker heard nothing from it for/.test(
      turn.error?.message ?? "",
    ),
  "a worker whose model goes silent is stopped, and the turn ends saying so",
);

log("experimental: interrupt");
const sl = await start("experimental");
await say(sl.id, "slow job");
await until("the worker's command", () =>
  notes.some(
    (n) =>
      n.method === "item/started" &&
      n.params?.threadId === sl.id &&
      (n.params.item as TurnItem).type === "commandExecution",
  ),
);
let t0 = Date.now();
await call("turn/interrupt", { threadId: sl.id });
turn = await turnDone(sl.id, 8000);
check(
  turn.status === "interrupted" && Date.now() - t0 < 3000,
  `interrupt stops the worker (${Date.now() - t0} ms)`,
);
check(
  turn.items.some((i) => i.type === "commandExecution" && i.status === "failed"),
  "the command it was in shows as not finished",
);
check(
  (await call("thread/read", { threadId: sl.id })).result !== undefined &&
    (
      (await call("thread/list", {})).result as { data: { id: string; status: { type: string } }[] }
    ).data.find((t) => t.id === sl.id)?.status.type === "idle",
  "the thread is idle again",
);
await say(sl.id, "hello");
turn = await turnDone(sl.id);
check(turn.status === "completed", "and takes the next message");

const hg = await start("experimental");
seen.length = 0;
await say(hg.id, "hangcall");
await until("the planner call", () => seen.length === 1);
t0 = Date.now();
await call("turn/interrupt", { threadId: hg.id });
turn = await turnDone(hg.id, 5000);
check(
  turn.status === "interrupted" && Date.now() - t0 < 1500 && turn.error === null,
  `interrupt during a plain model call ends it at once (${Date.now() - t0} ms)`,
);

log("experimental: a worker's approval request");
const ak = await start("experimental", { approvalPolicy: "untrusted" });
await say(ak.id, "askme: run it");
const reqMsg = await until("the approval request", () =>
  notes.find((n) => n.method === "item/commandExecution/requestApproval"),
);
check(
  reqMsg.params?.threadId === ak.id && typeof reqMsg.id === "string",
  "the page is asked, under the visible thread's id",
);
const live = (await call("thread/turns/list", { threadId: ak.id, sortDirection: "desc" }))
  .result as { data: Turn[] };
check(
  live.data[0].items.some((i) => i.id === reqMsg.params?.itemId && i.status === "inProgress"),
  "its itemId is the command row in the visible turn",
);
check(reqMsg.params?.turnId === live.data[0].id, "and its turnId the visible turn");
// a page that connects now still sees the question
const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
const late: Msg[] = [];
ws2.on("message", (d) => late.push(JSON.parse(String(d)) as Msg));
await until("the late page's copy", () => late.some((m) => m.id === reqMsg.id));
check(true, "a page that connects later gets the open request too");
ws2.close();
ws.send(JSON.stringify({ id: reqMsg.id, result: { decision: "accept" } }));
turn = await turnDone(ak.id);
check(
  turn.status === "completed" &&
    turn.items.some((i) => i.type === "commandExecution" && i.status === "completed"),
  "approved: the worker ran it and finished",
);
check(
  fake().some((l) => l.approval?.decision === "accept"),
  "the harness got the user's decision",
);
check(
  notes.some((n) => n.method === "serverRequest/resolved" && n.params?.requestId === reqMsg.id),
  "serverRequest/resolved clears the card",
);
check(
  fake()
    .filter((l) => l.threadStart)
    .at(-1)!.threadStart!.approvalPolicy === "untrusted",
  "the worker thread got the thread's approval policy",
);

log("experimental: router and capacity errors");
seen.length = 0;
const r5 = await start("experimental");
await say(r5.id, "r503 please");
turn = await turnDone(r5.id);
check(
  turn.status === "failed" &&
    /^No free model could take this right now \(the router answered 503: no model in spark/.test(
      turn.error?.message ?? "",
    ),
  `a 503 ends the turn with a plain message (${turn.error?.message.slice(0, 60)}…)`,
);
check(
  seen.length === 4 && turn.orchestration?.retries === 3 && turn.orchestration.modelCalls === 1,
  "after the three waits of this check's schedule (four tries, counted as one call)",
);
check(
  turn.items.filter((i) => i.type === "agentMessage").length === 1 &&
    /^No model became free in .* \(3 retries\)\.$/.test(last(turn)),
  `the waiting shows as one status line, closed when it gave up (${last(turn)})`,
);
check(
  notes.some((n) => n.method === "error" && n.params?.threadId === r5.id),
  "an error notification goes out",
);
check(
  stored(r5.id).notes.requests[0] === "r503 please",
  "the request is in the notes although nothing could plan it (a later continue has a goal)",
);
const nc = await start("experimental");
await say(nc.id, "nocap now");
turn = await turnDone(nc.id);
check(
  turn.status === "failed" &&
    /^No free model could take this right now/.test(turn.error?.message ?? ""),
  "a worker that finds no model ends the turn the same way",
);

// ---- Hyperexperimental ----------------------------------------------------------------------------
log("hyperexperimental: web chat models only");
{
  const rejected = await call("thread/start", {
    model: "pool/spark",
    cwd: work,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    config: { orchestrator: "hyperexperimental" },
  });
  check(
    !!rejected.error && /web chat models/i.test(rejected.error.message),
    `pool/spark rejected for hyperexperimental (${rejected.error?.message ?? "allowed"})`,
  );
}
log("hyperexperimental: a job over three steps");
seen.length = 0;
writeFileSync(fakeLog, "");
const hy = await start("hyperexperimental");
await say(hy.id, "module ZEBRA-GOAL: make mathx.py with add and check it");
turn = await turnDone(hy.id);
check(turn.status === "completed", "turn completed");
check(
  kindsOf(turn) ===
    "userMessage,agentMessage,fileChange,commandExecution,commandExecution,agentMessage,fileChange,commandExecution,commandExecution,agentMessage",
  `items: per step the plan in words, then its actions; then the answer (${kindsOf(turn)})`,
);
check(
  last(turn) === "Created mathx.py with add(); running it printed 5.",
  "FINISHED: is the answer",
);
check(
  readFileSync(path.join(work, "mathx.py"), "utf8") === "def add(a, b):\n    return a + b  # sum\n",
  "the file was written, then edited",
);
const w1 = turn.items[2];
check(
  w1.status === "completed" &&
    w1.changes?.[0].path === "mathx.py" &&
    w1.changes[0].kind.type === "add" &&
    w1.changes[0].diff.includes("+def add(a, b):"),
  "WRITE shows as an added file with its diff",
);
const c1 = turn.items[3];
check(
  c1.command === 'python3 -c "import mathx; print(mathx.add(2, 3))"' &&
    c1.aggregatedOutput === "5" &&
    c1.exitCode === 0,
  "RUN shows as a command with its output",
);
check(
  turn.items[4].command === "READ: mathx.py 1-2" &&
    /def add\(a, b\):\n {4}return a \+ b\n\[lines 1-2 of 2\]/.test(
      turn.items[4].aggregatedOutput ?? "",
    ),
  "READ shows the lines and how many there are",
);
const e1 = turn.items[6];
check(
  e1.changes?.[0].kind.type === "update" &&
    e1.changes[0].diff === "@@ -2,1 +2,1 @@\n-    return a + b\n+    return a + b  # sum",
  "REPLACE shows as an update with the changed line",
);
check(
  /mathx\.py:1:def add/.test(turn.items[7].aggregatedOutput ?? "") &&
    /mathx\.py/.test(turn.items[8].aggregatedOutput ?? ""),
  "SEARCH and LIST answer",
);
check(
  seen.map((s) => s.role).join(",") === "think,translate,think,translate,think",
  "per step a think, and a translate only because these replies give their actions in prose; no call to summarize a step, and no reviewer for a job that ran its result and names nothing unchecked",
);
check(
  seen.every(
    (s) =>
      (s.body.input as unknown[]).length === 1 &&
      s.body.store === false &&
      !("previous_response_id" in s.body),
  ) && new Set(seen.map((s) => s.session)).size === seen.length,
  "every call is a single-message request with its own session key",
);
const within = (s: Seen) =>
  s.instructions.length + s.input.length <= (s.role === "think" ? THINK_BUDGET : PROMPT_BUDGET);
check(
  seen.every(within),
  `every prompt is within its budget (largest think ${Math.max(...seen.filter((s) => s.role === "think").map((s) => s.instructions.length + s.input.length))} <= ${THINK_BUDGET}, largest other ${Math.max(...seen.filter((s) => s.role !== "think").map((s) => s.instructions.length + s.input.length))} <= ${PROMPT_BUDGET})`,
);
const tr = seen.filter((s) => s.role === "translate");
check(
  tr.every((s) => !s.input.includes("ZEBRA-GOAL") && !s.input.includes("MEMORY")),
  "translate sees only the plan in words, the folder and the platform",
);
check(
  tr[0].input.startsWith(`Working folder: ${work}\nPlatform: `) &&
    tr[0].input.includes("First create mathx.py"),
  "(it does see those)",
);
const th2 = seen.filter((s) => s.role === "think")[1].input;
check(
  /MEMORY:\nSTEPS \(recorded by code[^\n]*\n1\. First create mathx\.py with this content: → WRITE: mathx\.py \(2 lines\): ok; RUN: python3 -c [^\n]*: ok "5"; READ: mathx\.py 1-2: ok\n/.test(
    th2,
  ) &&
    /LAST STEP RESULTS:\nWRITE: mathx\.py \(2 lines\)\n\[created mathx\.py, 2 lines\]/.test(th2) &&
    /RUN: python3 [^\n]*\n5\n/.test(th2),
  "the next think gets the memory code kept (one line for the step: what was meant, each action and how it ended) and the last step's results",
);
check(
  /PINNED FILES:\n--- mathx\.py \(all 2 lines, as on disk now\) ---\n1\| def add\(a, b\):\n2\| {5}return a \+ b\n/.test(
    th2,
  ),
  "and the file it wrote, pinned as it is on disk, with line numbers: nothing has to be read back",
);
check(!th2.includes("```python"), "not the earlier think's own text");
const th3 = seen.filter((s) => s.role === "think")[2].input;
check(
  /2\. Now replace the return line[^\n]* → REPLACE: mathx\.py: ok; SEARCH: def add IN \.: ok; LIST: \.: ok/.test(
    th3,
  ) && /2\| {5}return a \+ b {2}# sum\n/.test(th3),
  "after the REPLACE the pin shows the changed line, and the log has the step",
);
check(
  /This is step 3\. Left in this turn: \d+ model calls, \d+ minutes?\./.test(th3),
  "a think is told what the turn has left (calls and minutes), not a count of steps",
);
rec = stored(hy.id);
check(
  rec.summary.length <= SUMMARY_LIMIT &&
    /^STEPS \(recorded by code/.test(rec.summary) &&
    /was answered: Created mathx\.py/.test(rec.summary),
  `the stored summary is the memory as text, within its bound (${rec.summary.length} <= ${SUMMARY_LIMIT}), and ends with the answer given`,
);
check(
  turn.orchestration?.modelCalls === 5 &&
    turn.orchestration.steps === 3 &&
    turn.orchestration.finish?.reviewed === false &&
    turn.orchestration.finish.code === 0,
  "5 model calls over 3 steps (it was 8: a summarize call per step and a reviewer are gone)",
);
lines = fake();
const execs = lines.filter((l) => l.exec).map((l) => l.exec!);
const isCapture = (e: (typeof execs)[number]) => (e.command[2] ?? "").includes("__ORC_ENV_BEGIN__");
const isRun = (e: (typeof execs)[number]) => e.command.length === 3 && !isCapture(e);
check(!lines.some((l) => l.threadStart), "no worker thread: actions run through command/exec");
const zsh = /\/zsh$/.test(userShell());
if (zsh) {
  const caps = execs.filter(isCapture);
  check(
    caps.length === 1 &&
      caps[0].command[0] === userShell() &&
      caps[0].command[1] === "-lc" &&
      caps[0].command[2] === captureScript(userShell()) &&
      caps[0].sandboxPolicy.type === "readOnly",
    "the shell environment is captured once, the harness's way (login shell + the rc file), read-only",
  );
  const runs = execs.filter(isRun);
  check(
    runs.length === 1 &&
      runs[0].command[0] === userShell() &&
      runs[0].command[1] === "-c" &&
      runs[0].env?.PATH?.startsWith("/orc-marker-bin:"),
    "RUN goes out as a non-login shell with the captured environment (the rc file's PATH first)",
  );
} else
  log(`  (skipped: the login shell here is ${userShell()}, the PATH checks are written for zsh)`);
{
  const b64 = Buffer.from(
    "PATH=/a:/b\0FOO=x=y\0PWD=/z\0SHLVL=2\0CODEX_SANDBOX=seatbelt\0",
  ).toString("base64");
  const env = parseCapturedEnv(`rc noise\n__ORC_ENV_BEGIN__\n${b64}\n`);
  check(
    env?.PATH === "/a:/b" &&
      env.FOO === "x=y" &&
      !("PWD" in env) &&
      !("SHLVL" in env) &&
      !("CODEX_SANDBOX" in env),
    "the captured environment is read back; what the shell sets per command is left out",
  );
  check(
    parseCapturedEnv("no marker") === null &&
      parseCapturedEnv(`__ORC_ENV_BEGIN__\n${Buffer.from("FOO=1\0").toString("base64")}`) === null,
    "a capture without the marker or without PATH is not used (RUN falls back to a login shell)",
  );
}
check(
  execs.every((e) => e.cwd === work && e.sandboxPolicy && typeof e.sandboxPolicy.type === "string"),
  "every command names the thread's folder and an explicit sandbox policy",
);
const isWrite = (e: (typeof execs)[number]) => e.command.join(" ").includes("base64 --decode");
check(
  execs.filter((e) => isWrite(e) || isRun(e)).length === 3 &&
    execs
      .filter((e) => isWrite(e) || isRun(e))
      .every(
        (e) =>
          e.sandboxPolicy.type === "workspaceWrite" &&
          e.sandboxPolicy.writableRoots?.join() === work,
      ),
  "writes and RUN use the thread's policy: workspace write, the thread's folder the writable root",
);
check(
  execs.filter((e) => !isWrite(e) && !isRun(e)).every((e) => e.sandboxPolicy.type === "readOnly"),
  "reads, searches and listings use the read-only policy",
);

log("hyperexperimental: a follow-up starts from the summary");
seen.length = 0;
await say(hy.id, "anything else?");
turn = await turnDone(hy.id);
check(
  turn.status === "completed" &&
    seen.length === 1 &&
    /MEMORY:\nBEFORE THIS JOB:\nThe request "module ZEBRA-GOAL[^\n]*was answered: Created mathx\.py/.test(
      seen[0].input,
    ) &&
    !/PINNED FILES|STEPS \(recorded/.test(seen[0].input) &&
    /GOAL:\nanything else\?/.test(seen[0].input),
  "the next turn's first think gets what the last job came to and the new message; that job's log and pins are gone",
);

log("hyperexperimental: a conversation moved here starts from its hand-over");
seen.length = 0;
const hh = await start("hyperexperimental");
await say(hh.id, "anything else?", {
  additionalContext: {
    provenance_handover: { value: "HANDOVER-QUUX: the parser was split", kind: "application" },
  },
});
turn = await turnDone(hh.id);
check(
  turn.status === "completed" &&
    /MEMORY:\nBEFORE THIS JOB:\nHANDOVER-QUUX/.test(seen[0]?.input ?? ""),
  "its first think gets the hand-over as what came before",
);
const typedItem = turn.items[0] as { type: string; content?: { text: string }[] };
check(
  typedItem.type === "userMessage" && typedItem.content?.[0]?.text === "anything else?",
  "the turn's user message is exactly what was typed",
);
check(
  !JSON.stringify(stored(hh.id).turns).includes("HANDOVER-QUUX"),
  "the hand-over is in none of the thread's items",
);

log("hyperexperimental: loop guards");
const ag = await start("hyperexperimental");
await say(ag.id, "again and again");
turn = await turnDone(ag.id);
check(
  turn.status === "completed" &&
    /^Stopped: 3 steps in a row changed no file and ran nothing new, so the job was not moving\./.test(
      last(turn),
    ) &&
    /Where things stand:\n\nSTEPS \(recorded by code[^\n]*\n1\. Run echo same once more\. → RUN: echo same: ok\n2\. [^\n]*a repeat of step 1, not run/.test(
      last(turn),
    ),
  `a job that is circling stops early, with a plain message and what was done (${last(turn).split("\n")[0]})`,
);
check(
  turn.items.filter((i) => i.type === "commandExecution").length === 1 &&
    turn.orchestration?.refused === 2 &&
    turn.orchestration.steps === 3,
  "the same look with nothing changed in between ran once: the repeats were answered from memory",
);
const agThinks = seen.filter((s) => s.role === "think" && /again and again/.test(s.input));
check(
  /LAST STEP RESULTS:\nRUN: echo same\n\(not run again: the same as in step 1, and nothing has changed since\) It came to: ok, 1 line, starting: same/.test(
    agThinks[2]?.input ?? "",
  ) &&
    /\(recorded\) The last 2 steps only looked\. This step must write a file, make a change or run something, or reply BLOCKED:/.test(
      agThinks[2]?.input ?? "",
    ),
  "the think is told the earlier result instead, and after the look limit that the next step must act or say what blocks it",
);
const sp = await start("hyperexperimental");
await say(sp.id, "steps without end");
turn = await turnDone(sp.id);
check(
  /^Stopped after 4 steps, the limit for one message\./.test(last(turn)) &&
    turn.items.filter((i) => i.type === "commandExecution").length === 4,
  "a job that keeps advancing is not stopped for circling: only the backstop on steps (4 here, 40 in the app), the calls or the minutes end it",
);
const no = await start("hyperexperimental");
await say(no.id, "nothing concrete");
turn = await turnDone(no.id);
check(
  /^Stopped: two steps in a row produced nothing that could be run\./.test(last(turn)),
  "two steps with no action: stopped",
);

log("hyperexperimental: interrupt");
const hs = await start("hyperexperimental");
await say(hs.id, "hslow");
await until("the sleep", () =>
  notes.some(
    (n) =>
      n.method === "item/started" &&
      n.params?.threadId === hs.id &&
      (n.params.item as TurnItem).command === "sleep 30",
  ),
);
await new Promise((r) => setTimeout(r, 150));
t0 = Date.now();
await call("turn/interrupt", { threadId: hs.id });
turn = await turnDone(hs.id, 8000);
check(
  turn.status === "interrupted" && Date.now() - t0 < 3000,
  `interrupt stops the command (${Date.now() - t0} ms)`,
);
check(
  fake().some((l) => l.terminate),
  "the process was terminated through app-server",
);
check(
  turn.items.at(-1)?.type === "commandExecution" && turn.items.at(-1)?.status === "failed",
  "its row shows as not finished",
);

log("hyperexperimental: Ask every time, and read only");
writeFileSync(fakeLog, "");
const ha = await start("hyperexperimental", { approvalPolicy: "untrusted" });
await say(ha.id, "hask");
const fileReq = await until("the file approval", () =>
  notes.find((n) => n.method === "item/fileChange/requestApproval" && n.params?.threadId === ha.id),
);
check(
  !existsSync(path.join(work, "notes.txt")) && !fake().some((l) => l.exec && isWrite(l.exec)),
  "the write waits for the user",
);
const pendingTurn = (
  (await call("thread/turns/list", { threadId: ha.id, sortDirection: "desc" })).result as {
    data: Turn[];
  }
).data[0];
check(
  pendingTurn.items.some(
    (i) =>
      i.id === fileReq.params?.itemId &&
      i.type === "fileChange" &&
      i.changes?.[0].diff.includes("+hello"),
  ),
  "the request points at the file row with its diff",
);
ws.send(JSON.stringify({ id: fileReq.id, result: { decision: "accept" } }));
const cmdReq = await until("the command approval", () =>
  notes.find(
    (n) => n.method === "item/commandExecution/requestApproval" && n.params?.threadId === ha.id,
  ),
);
check(
  cmdReq.params?.command === "echo hi" &&
    cmdReq.params.cwd === work &&
    readFileSync(path.join(work, "notes.txt"), "utf8") === "hello\n",
  "approved: written; then the command asks, with its text and folder",
);
ws.send(JSON.stringify({ id: cmdReq.id, result: { decision: "decline" } }));
turn = await turnDone(ha.id);
check(
  turn.status === "completed" &&
    turn.items.some((i) => i.type === "commandExecution" && i.status === "declined"),
  "denied: the command row is declined, the turn goes on",
);
check(!fake().some((l) => l.exec && isRun(l.exec)), "and it never ran");
check(
  seen.some(
    (s) => s.role === "think" && s.input.includes("[the user declined to run this command]"),
  ),
  "the model is told it was declined",
);
const hr = await start("hyperexperimental", { sandbox: "read-only" });
writeFileSync(fakeLog, "");
await say(hr.id, "hro");
turn = await turnDone(hr.id);
const roExecs = fake()
  .filter((l) => l.exec)
  .map((l) => l.exec!);
check(
  roExecs.length > 0 && roExecs.every((e) => e.sandboxPolicy.type === "readOnly"),
  "a read-only thread: every command, the write included, goes out under the read-only policy",
);
check(
  turn.items.some((i) => i.type === "fileChange" && i.status === "failed"),
  "the write fails in the sandbox and shows as failed",
);
const fa = await start("hyperexperimental", {
  sandbox: "danger-full-access",
  approvalPolicy: "never",
});
writeFileSync(fakeLog, "");
await say(fa.id, "hask");
turn = await turnDone(fa.id);
const faExecs = fake()
  .filter((l) => l.exec)
  .map((l) => l.exec!);
check(
  turn.status === "completed" &&
    faExecs
      .filter((e) => isWrite(e) || isRun(e))
      .every((e) => e.sandboxPolicy.type === "dangerFullAccess") &&
    faExecs
      .filter((e) => !isWrite(e) && !isRun(e))
      .every((e) => e.sandboxPolicy.type === "readOnly"),
  "full access: writes and RUN unrestricted without asking, reads still read-only",
);
const sw = await start("hyperexperimental", { sandbox: "read-only" });
writeFileSync(fakeLog, "");
await say(sw.id, "hask", {
  sandboxPolicy: { type: "workspaceWrite" },
  approvalPolicy: "on-request",
});
turn = await turnDone(sw.id);
check(
  fake().some((l) => l.exec && isWrite(l.exec) && l.exec.sandboxPolicy.type === "workspaceWrite"),
  "the composer's preset at turn/start replaces the thread's",
);

log("hyperexperimental: a router error");
const h5 = await start("hyperexperimental");
await say(h5.id, "h503");
turn = await turnDone(h5.id);
check(
  turn.status === "failed" &&
    /^No free model could take this right now/.test(turn.error?.message ?? ""),
  "a 503 mid-step ends the turn with the plain message",
);

// ---- what the benchmark asked for ------------------------------------------------------------------
const waitLines = (t: Turn) =>
  t.items.filter((i) => i.type === "agentMessage" && /free model/.test(i.text ?? ""));
const sawStatus = (threadId: string, re: RegExp) =>
  notes.some(
    (n) =>
      n.method === "item/started" &&
      n.params?.threadId === threadId &&
      re.test((n.params.item as TurnItem).text ?? ""),
  );
const interrupts = () => fake().filter((l) => l.interrupt).length;

log("retries: a model call the router can't serve is waited out inside the turn");
seen.length = 0;
faults.push({ role: "think", match: /retryok/, kind: 503, times: 2 });
const rk = await start("hyperexperimental");
await say(rk.id, "retryok");
turn = await turnDone(rk.id);
check(
  turn.status === "completed" && last(turn) === "Got through.",
  "two 503s, then an answer: the turn completes",
);
check(
  seen.length === 3 && turn.orchestration?.retries === 2 && turn.orchestration.modelCalls === 1,
  "three requests reached the router; they count as one model call and two retries",
);
check(
  sawStatus(rk.id, /^Waiting for a free model… retry 1 in .* \(no model is free\)\.$/) &&
    sawStatus(rk.id, /^Waiting for a free model… retry 2 in /),
  "while waiting the thread shows a status line, rewritten at each retry",
);
check(
  waitLines(turn).length === 1 &&
    /^Waited .* for a free model \(2 retries\)\.$/.test(waitLines(turn)[0].text ?? ""),
  `it is one item, closed when the model answered (${waitLines(turn)[0]?.text})`,
);
for (const kind of [429, 502, 500]) {
  seen.length = 0;
  faults.push({ role: "planner", match: /hello/, kind, times: 1 });
  const t = await start("experimental");
  await say(t.id, "hello");
  turn = await turnDone(t.id);
  check(
    turn.status === "completed" && seen.length === 2 && turn.orchestration?.retries === 1,
    `a ${kind} is retried too`,
  );
}
seen.length = 0;
faults.push(
  { role: "think", match: /emptyreply/, kind: "failed-empty", times: 1 },
  { role: "think", match: /emptyreply/, kind: "blank", times: 1 },
);
const er = await start("hyperexperimental");
await say(er.id, "emptyreply");
turn = await turnDone(er.id);
check(
  turn.status === "completed" &&
    last(turn) === "After an empty reply." &&
    seen.length === 3 &&
    turn.orchestration?.retries === 2,
  'a stream that ends in response.failed ("empty reply"), then a blank reply: both retried',
);
check(
  sawStatus(er.id, /\(a model sent an empty reply\)\.$/),
  "the status line says it was an empty reply",
);

log("retries used up: the turn ends, the summary is kept, and continue resumes");
seen.length = 0;
faults.push({ role: "think", match: /retryfail[\s\S]*This is step 2\./, kind: 503, times: 99 });
const rf = await start("hyperexperimental");
await say(rf.id, "retryfail: do the two things");
turn = await turnDone(rf.id);
check(
  turn.status === "failed" &&
    /^No free model could take this right now \(the router answered 503/.test(
      turn.error?.message ?? "",
    ) &&
    / What was done so far is kept: send "continue" to go on from there\.$/.test(
      turn.error?.message ?? "",
    ),
  "step 2 never gets a model: after the waits the turn ends with the plain message, and says how to go on",
);
check(
  seen.map((s) => s.role).join(",") === "think,translate,think,think,think,think" &&
    turn.items.some((i) => i.command === "echo one" && i.status === "completed"),
  "step 1 ran in full; step 2's think was tried four times",
);
rec = stored(rf.id);
check(
  /^STEPS \(recorded by code[^\n]*\n1\. Run echo one\. → RUN: echo one: ok/.test(rec.summary) &&
    rec.openGoal === "retryfail: do the two things",
  "the thread keeps the memory (the step that ran, as code recorded it) and the request it did not finish",
);
faults.length = 0;
seen.length = 0;
await say(rf.id, "continue");
turn = await turnDone(rf.id);
check(
  turn.status === "completed" &&
    last(turn) === "Resumed fine." &&
    seen.length === 1 &&
    /GOAL:\nretryfail: do the two things\n/.test(seen[0].input) &&
    /MEMORY:\nSTEPS \(recorded by code[^\n]*\n1\. Run echo one\./.test(seen[0].input),
  '"continue" is thought about with the unfinished request and the memory, not started over',
);
check(stored(rf.id).openGoal === null, "once finished, nothing is left open");

log("experimental: a worker whose model request failed is run again; then continue");
const flakyFile = `${fakeLog}.flaky`;
writeFileSync(flakyFile, "2");
writeFileSync(fakeLog, "");
seen.length = 0;
const fl = await start("experimental");
await say(fl.id, "flaky job");
turn = await turnDone(fl.id);
check(
  turn.status === "completed" &&
    fake().filter((l) => /YOUR TASK \(2 of 3\): FLAKY thing/.test(l.turnStart?.brief ?? ""))
      .length === 3 &&
    turn.orchestration?.retries === 2,
  "the worker's turn failed twice for want of a model: the task was run again each time, after a wait",
);
check(
  waitLines(turn).length === 1 &&
    /^Waited .* \(2 retries\)\.$/.test(waitLines(turn)[0].text ?? "") &&
    turn.items.filter((i) => /^\*\*Task 2 of 3:\*\*/.test(i.text ?? "")).length === 1 &&
    seen.map((s) => s.role).join(",") === "planner,review,final",
  `one status line, the task announced once, and no revision: it was not the task's fault (${JSON.stringify(waitLines(turn).map((i) => i.text))} ${turn.items.filter((i) => /^\*\*Task 2 of 3:\*\*/.test(i.text ?? "")).length} ${seen.map((s) => s.role).join(",")})`,
);
check(stored(fl.id).notes.done.length === 3, "all three tasks finished");
writeFileSync(flakyFile, "99");
seen.length = 0;
const fx = await start("experimental");
await say(fx.id, "flaky job");
turn = await turnDone(fx.id);
check(
  turn.status === "failed" &&
    /^No free model could take this right now/.test(turn.error?.message ?? "") &&
    /send "continue"/.test(turn.error?.message ?? ""),
  "no model for the whole schedule: the turn ends with the plain message",
);
rec = stored(fx.id);
check(
  rec.notes.done.length === 1 &&
    rec.notes.pending.map((t) => t.title).join("|") === "FLAKY thing|Wrap up" &&
    /STILL TO DO \(planned, not finished\):\n1\. FLAKY thing\n2\. Wrap up/.test(
      notesText(rec.notes),
    ),
  "the notes keep the finished task and the two still to do",
);
writeFileSync(flakyFile, "0");
seen.length = 0;
await say(fx.id, "continue");
turn = await turnDone(fx.id);
rec = stored(fx.id);
check(
  turn.status === "completed" &&
    /^Going on from where the last turn stopped, 2 tasks left:/.test(turn.items[1].text ?? "") &&
    seen.map((s) => s.role).join(",") === "review,final" &&
    turn.orchestration?.workers === 2,
  '"continue" runs the two tasks that were left, without planning again',
);
check(
  rec.notes.done.length === 3 && rec.notes.pending.length === 0 && rec.notes.requests.length === 1,
  "and the notes end with all three done, nothing pending",
);

log("interrupt during a wait");
{
  const caps = backend.caps as { retryDelaysMs: number[] };
  const keep = caps.retryDelaysMs;
  caps.retryDelaysMs = [20_000];
  faults.push({ role: "think", match: /waitint/, kind: 503, times: 99 });
  const wi = await start("hyperexperimental");
  await say(wi.id, "waitint");
  await until("the waiting line", () =>
    sawStatus(wi.id, /^Waiting for a free model… retry 1 in 20 s/),
  );
  t0 = performance.now();
  await call("turn/interrupt", { threadId: wi.id });
  turn = await turnDone(wi.id, 5000);
  check(
    turn.status === "interrupted" && performance.now() - t0 < 1000 && turn.error === null,
    `turn/interrupt ends a 20 s wait at once (${Math.round(performance.now() - t0)} ms)`,
  );
  check(/^Stopped while waiting for a free model/.test(last(turn)), "and the status line says so");
  caps.retryDelaysMs = keep;
  faults.length = 0;
}

log("hyperexperimental: file bodies are written once, as the think step gave them");
seen.length = 0;
const lf = await start("hyperexperimental");
await say(lf.id, "liftjob");
turn = await turnDone(lf.id);
check(turn.status === "completed" && last(turn) === "Lifted.", "turn completed");
check(
  readFileSync(path.join(work, "lifted.py"), "utf8") ===
    'import os\n# RUN: rm -rf /   (a comment that looks like an action)\nprint("lifted", "$HOME `date` <<<")\n' &&
    readFileSync(path.join(work, "here.txt"), "utf8") ===
      "line one $NOT_EXPANDED\nWRITE: not-an-action.txt\n" &&
    !existsSync(path.join(work, "not-an-action.txt")),
  "both files hold exactly what the think step wrote (action-like lines inside them are content)",
);
check(
  turn.items.some(
    (i) => i.command === "python3 lifted.py" && i.aggregatedOutput === "lifted $HOME `date` <<<",
  ),
  "and the script runs",
);
check(
  seen.map((s) => s.role).join(",") === "think,think" &&
    turn.orchestration?.direct === 1 &&
    turn.orchestration.modelCalls === 2,
  "a reply made of a file block and a shell block needs no translator: its actions are read straight from it (2 model calls for the turn; it was 5)",
);
check(
  /PINNED FILES:\n[\s\S]*--- lifted\.py \(all 3 lines, as on disk now\) ---\n1\| import os/.test(
    seen[1].input,
  ) &&
    /RUN: python3 lifted\.py\nlifted \$HOME `date` <<</.test(seen[1].input) &&
    /1\. Create the script and a data file, then run it\. → WRITE: lifted\.py \(3 lines\): ok; WRITE: here\.txt \(2 lines\): ok; RUN: python3 lifted\.py: ok "lifted \$HOME `date` <<<"/.test(
      seen[1].input,
    ),
  "the next think has the files as written (pinned), the run's output, and the step in the log",
);

log("hyperexperimental: a WRITE with no content is refused and fed back");
seen.length = 0;
const nb = await start("hyperexperimental");
await say(nb.id, "nobody wrote the body");
turn = await turnDone(nb.id);
check(
  turn.status === "completed" && last(turn) === "big.py written and run.",
  `refused once, then a step with nothing, then the file: the turn still finishes (${last(turn).slice(0, 60)})`,
);
{
  const th = seen.filter((s) => s.role === "think");
  check(
    th[1].input.includes(
      "(refused, nothing was written or run) WRITE: big.py was not done: no content came with it. Give the whole file in a file block (```file:big.py)",
    ) &&
      th[1].input.includes(
        "(not run, because the action before it was refused) RUN: python3 big.py",
      ),
    "the next think is told what was refused, how to give the file, and what did not run",
  );
  check(
    turn.items.filter((i) => i.type === "fileChange").length === 1 &&
      turn.items.filter((i) => i.command === "python3 big.py").length === 1 &&
      readFileSync(path.join(work, "big.py"), "utf8") === "print('big')\n",
    "nothing was written or run for the refused step; the file block of step 3 was",
  );
  check(
    th.length === 4,
    'the refused step did not count toward "nothing runnable" (a step with nothing followed it)',
  );
}

log("experimental: a plan must produce what was asked");
{
  writeFileSync(path.join(work, "main.db"), "x");
  const d = deliverablesIn(
    `Fix README.md and create zz-out/result.json, plus \`zz-notes.txt\` and ${work}/zz-abs.json. Read main.db. See https://example.com/a.json, v1.2.3, e.g. this; not /no-such-dir-zz/app/out.json.`,
    work,
  );
  check(
    d.join("|") === "zz-out/result.json|zz-notes.txt|zz-abs.json",
    `the files a request names that are not there are its deliverables (${d.join("|")})`,
  );
}
seen.length = 0;
let ioFrom = fake().filter((l) => l.turnStart).length;
const io = await start("experimental");
await say(io.id, "inspectonly: recover the rows from main.db and create out-xyz.json");
turn = await turnDone(io.id);
let ioBriefs = fake()
  .filter((l) => l.turnStart)
  .slice(ioFrom)
  .map((l) => l.turnStart!.brief);
check(
  ioBriefs.length === 2 &&
    /YOUR TASK \(1 of 1\): inspectonly: recover the rows from main\.db and create out-xyz\.json\n/.test(
      ioBriefs[0],
    ) &&
    /MUST MATCH EXACTLY[^\n]*main\.db \| out-xyz\.json/.test(ioBriefs[0]),
  "a plan that only inspects does not narrow the job: the one worker's task is the request itself, with its names",
);
check(
  seen.map((s) => s.role).join(",") === "planner" && turn.orchestration?.finish?.reviewed === false,
  "the task ran and the file is not there: code finds that by itself, and no reviewer is asked about a job that is not finished",
);
check(
  /YOUR TASK \(2 of 2\): Fix what the finish check found, and run the failing check again/.test(
    ioBriefs[1],
  ) &&
    /- \(recorded\) `out-xyz\.json`, named in the request, does not exist/.test(ioBriefs[1]) &&
    turn.orchestration?.finish?.code === 1 &&
    turn.orchestration.finish.followUps === 1,
  "one more task is made from it, by code (the planner is not asked again)",
);
check(
  turn.status === "completed" &&
    last(turn).startsWith(
      "**Not finished.** `out-xyz.json`, named in the request, does not exist.\n\nDone.\n\nRESULT: finished",
    ),
  "and the reply says first that the deliverable does not exist, whatever the worker wrote",
);
seen.length = 0;
ioFrom = fake().filter((l) => l.turnStart).length;
const iok = await start("experimental");
await say(iok.id, "inspectonly: recover the rows and create out-ok.json MAKES out-ok.json");
turn = await turnDone(iok.id);
ioBriefs = fake()
  .filter((l) => l.turnStart)
  .slice(ioFrom)
  .map((l) => l.turnStart!.brief);
check(
  turn.status === "completed" &&
    existsSync(path.join(work, "out-ok.json")) &&
    ioBriefs.length === 1 &&
    seen.map((s) => s.role).join(",") === "planner" &&
    /^Done\.\n\nRESULT: finished/.test(last(turn)) &&
    turn.orchestration?.finish?.code === 0 &&
    turn.orchestration.finish.followUps === 0,
  "when the worker makes the file, the turn ends as usual: the code check finds nothing, and nothing more is spent",
);

log("experimental: a worker out of budget is stopped, and the plan revised");
seen.length = 0;
before = interrupts();
const bu = await start("experimental");
await say(bu.id, "budget test");
turn = await turnDone(bu.id);
check(
  turn.status === "completed" &&
    interrupts() === before + 1 &&
    seen.map((s) => s.role).join(",") === "planner,revise,review,final",
  "a worker that used its 18 requests is stopped; the turn goes on with a revised plan",
);
check(
  /The worker was stopped: it used its budget of 18 model requests for one task\. It had not finished\./.test(
    seen[1].input,
  ) && /TASK THAT HIT A PROBLEM: budget test/.test(seen[1].input),
  "the planner is told why, and which task",
);
check(
  stored(bu.id).notes.problems.some((p) => /used its budget of 18 model requests/.test(p)) &&
    traces.some((t) => t.type === "worker" && t.status === "stopped (calls)" && t.calls === 18) &&
    turn.orchestration?.workerCalls === 22,
  "the notes keep it; the turn spent 18 + 2 + 2 worker requests, not the turn's whole allowance",
);

log("experimental: a planner that declines is asked again");
seen.length = 0;
const dc = await start("experimental");
await say(dc.id, "decline to plan");
turn = await turnDone(dc.id);
check(
  seen.map((s) => s.role).join(",") === "planner,planner" &&
    !seen[0].instructions.includes("Your last reply said") &&
    seen[1].instructions.includes("Your last reply said you cannot run commands"),
  '"I can\'t run commands on your computer" is not a plan: one more call, with a firmer prompt',
);
check(
  turn.status === "completed" &&
    /RESULT: finished "Follow up on it"/.test(last(turn)) &&
    !turn.items.some((i) => /can't run commands/.test(i.text ?? "")),
  "the second plan is used, and the refusal is never shown",
);
seen.length = 0;
const dc2 = await start("experimental");
await say(dc2.id, "declinetwice please");
turn = await turnDone(dc2.id);
check(
  seen.map((s) => s.role).join(",") === "planner,planner" &&
    turn.status === "completed" &&
    turn.orchestration?.workers === 1 &&
    /RESULT: finished "declinetwice please"/.test(last(turn)) &&
    !turn.items.some((i) => /cannot access your files/.test(i.text ?? "")),
  "declined twice: the request itself goes to a worker (which has the tools)",
);

log("clocks: the wall clock jumps a day mid-turn");
{
  writeFileSync(fakeLog, "");
  const qt = await start("experimental");
  await say(qt.id, "quiet worker");
  await until("the worker's turn", () => fake().some((l) => l.turnStart));
  const realNow = Date.now;
  Date.now = () => realNow() + 24 * 3600_000;
  try {
    turn = await turnDone(qt.id);
  } finally {
    Date.now = realNow;
  }
  check(
    turn.status === "completed" && /RESULT: finished "QUIETTASK think slowly"/.test(last(turn)),
    `a worker that is quiet for 1.3 s (the idle guard is 1.5 s) is not stopped when the date changes (${turn.error?.message ?? turn.status})`,
  );
  check(
    (turn.durationMs ?? 1e9) < 30_000,
    `and the turn's duration is what it took, not a day (${turn.durationMs} ms)`,
  );
}

log("environment: a RUN sees the PATH the harness's shell tool gives");
if (zsh) {
  const pc = await start("hyperexperimental");
  await say(pc.id, "pathcheck");
  turn = await turnDone(pc.id);
  const out = turn.items.find((i) => i.command === "echo PATHIS $PATH")?.aggregatedOutput ?? "";
  check(
    out.startsWith("PATHIS /orc-marker-bin:") && !out.includes("rc noise"),
    "what ~/.zshrc puts first on PATH is first for a RUN (and the rc file's own output is not in it)",
  );
  const bare = spawnSync(userShell(), ["-lc", "echo $PATH"], {
    env: { ...process.env, ZDOTDIR: zdot },
    encoding: "utf8",
  }).stdout;
  check(
    !bare.startsWith("/orc-marker-bin:"),
    "(a bare login shell, what RUN used before, does not read it)",
  );
}

// ---- the request word for word, the finish check, one worker, approvals ---------------------------
log("experimental: a planner that respells a file name and a count");
{
  seen.length = 0;
  const from = fake().filter((l) => l.turnStart).length;
  const pp = await start("experimental");
  const REQ =
    "paraphrase UNSETTLED: write the 30 rows to exact_rows_final.csv\nand run it the way `python3 -m loader --strict` would";
  await say(pp.id, REQ);
  turn = await turnDone(pp.id);
  const pb = fake()
    .filter((l) => l.turnStart)
    .slice(from)
    .map((l) => l.turnStart!.brief);
  check(
    /\[1\] paraphrase UNSETTLED: write the 30 rows to exact_rows_final\.csv\n\[2\] and run it/.test(
      seen[0].input,
    ) &&
      /MUST MATCH EXACTLY[^\n]*exact_rows_final\.csv \| python3 -m loader --strict \| --strict \| 30 rows/.test(
        seen[0].input,
      ),
    "the planner is shown the request in numbered pieces, with the exact names code copied out of it",
  );
  check(
    pb.length === 4 &&
      /YOUR TASK \(1 of 3\): Write the 20 rows to rows_final\.csv/.test(pb[0]) &&
      /YOUR TASK \(3 of 3\): Using what the notes show, produce what the request asks for \(create exact_rows_final\.csv\)/.test(
        pb[2],
      ) &&
      pb.every(
        (b) =>
          b.includes(`"""\n${REQ}\n"""`) &&
          /MUST MATCH EXACTLY[^\n]*exact_rows_final\.csv[^\n]*30 rows/.test(b) &&
          b.length <= BRIEF_BUDGET,
      ),
    "the planner wrote 20 rows and rows_final.csv (so a task that names the real file is added by code); every brief still carries the request word for word and the exact file name and count",
  );
  check(
    seen.map((x) => x.role).join(",") === "planner,final" &&
      /YOUR TASK \(4 of 4\): Fix what the finish check found, and run the failing check again/.test(
        pb[3],
      ) &&
      /- \(recorded\) `exact_rows_final\.csv`, named in the request, does not exist; `rows_final\.csv` was made instead: a near miss/.test(
        pb[3],
      ) &&
      /A file the request names must exist under exactly that name and place\./.test(pb[3]),
    "at the end code flags the near-miss file by name; that goes straight to one fix task, written by code: no reviewer and no planner in between",
  );
  const ans = last(turn);
  check(
    turn.status === "completed" &&
      ans.startsWith(
        "**Not finished.** `exact_rows_final.csv`, named in the request, does not exist; `rows_final.csv` was made instead: a near miss, not the file asked for",
      ),
    `the fix task could not settle it, and the answer says first what is not there (${ans.split("\n")[0].slice(0, 70)}…)`,
  );
  check(
    turn.orchestration?.finish?.requirements === 0 &&
      turn.orchestration.finish.reviewed === false &&
      turn.orchestration.finish.code === 1 &&
      turn.orchestration.finish.followUps === 1 &&
      turn.orchestration.workers === 4 &&
      turn.orchestration.roles.review === undefined,
    "one fix task and no reviewer call, both counted on the turn",
  );
  check(
    stored(pp.id).notes.original === REQ &&
      stored(pp.id).notes.exact.includes("exact_rows_final.csv") &&
      stored(pp.id).notes.deliverables.join() === "exact_rows_final.csv",
    "the notes keep the request as written, its exact names and the file it has to produce",
  );
}

log("experimental: a small job is one task");
{
  seen.length = 0;
  let from = fake().filter((l) => l.turnStart).length;
  const sm = await start("experimental");
  await say(sm.id, "smalljob: tidy the folder");
  turn = await turnDone(sm.id);
  let sb = fake()
    .filter((l) => l.turnStart)
    .slice(from)
    .map((l) => l.turnStart!.brief);
  check(
    sb.length === 1 &&
      turn.orchestration?.workers === 1 &&
      /^You are the worker for this job\./.test(sb[0]) &&
      /YOUR TASK \(1 of 1\): smalljob: tidy the folder\nA planner suggested this order of work \(it has not seen the files; the request decides\): 1\. Look at the folder 2\. Tidy it 3\. Check it\n/.test(
        sb[0],
      ) &&
      /FOLDER: .*work \(/.test(sb[0]) &&
      !turn.items.some((i) => /^Plan, \d+ tasks/.test(i.text ?? "")),
    "a planner that lists three tasks for a request that fits one brief, without saying why the job is large: one worker gets the whole request, the list only as a suggestion",
  );
  check(
    seen.map((x) => x.role).join(",") === "planner" &&
      turn.orchestration?.modelCalls === 3 &&
      /^Done\.\n\nRESULT: finished/.test(last(turn)),
    "it costs 3 model calls: the planner and the worker's 2 requests (the code check is free, and a job one worker ran whole gets no reviewer); the worker's report is the answer",
  );
  seen.length = 0;
  from = fake().filter((l) => l.turnStart).length;
  const oj = await start("experimental");
  await say(oj.id, "onejob: rename the thing");
  turn = await turnDone(oj.id);
  sb = fake()
    .filter((l) => l.turnStart)
    .slice(from)
    .map((l) => l.turnStart!.brief);
  check(
    sb.length === 1 &&
      /YOUR TASK \(1 of 1\): onejob: rename the thing\nDONE WHEN: what the request asks for exists exactly as it names it, and you have run it/.test(
        sb[0],
      ) &&
      /RESULT: finished "onejob: rename the thing"/.test(last(turn)),
    '"ONE" from the planner: the request is the task',
  );
}

log(
  "experimental: the finish check: a reviewer only when it can add something, its checks run by code",
);
{
  const briefsFrom = (from: number) =>
    fake()
      .filter((l) => l.turnStart)
      .slice(from)
      .map((l) => l.turnStart!.brief);
  const mb = await start("experimental");
  await say(mb.id, "onejob mumble UNCHECKED: rename the thing");
  turn = await turnDone(mb.id);
  check(
    turn.status === "completed" &&
      /RESULT: finished/.test(last(turn)) &&
      last(turn).endsWith(
        "Finish check: not reviewed (the reviewer's reply could not be read); nothing beyond the recorded commands was verified.",
      ) &&
      turn.orchestration?.finish?.requirements === 0 &&
      turn.orchestration.workers === 1,
    "a reviewer's reply that is cut off or in no form is not a review: the answer says so, and no task is made of it",
  );
  // The work names something as not checked: a reviewer is asked, and its commands are run by code.
  seen.length = 0;
  let from = fake().filter((l) => l.turnStart).length;
  const cp = await start("experimental");
  await say(cp.id, "onejob checkpass UNCHECKED: make the runner");
  turn = await turnDone(cp.id);
  const cpReview = seen.find((x) => x.role === "review")?.input ?? "";
  check(
    seen.map((x) => x.role).join(",") === "planner,review" &&
      /THE WORK SAYS IT DID NOT CHECK:\na real keyboard interrupt \(a cancelled task was tested instead\)/.test(
        cpReview,
      ) &&
      /EVIDENCE, commands run[^\n]*\n- exit 0: python3 check\.py onejob checkpass[^\n]*\n {4}\| out/.test(
        cpReview,
      ),
    "a worker that names something under NOT CHECKED gets a reviewer, which is told what that was and given the commands with their exit codes and output",
  );
  const cpRows = turn.items
    .filter((i) => i.type === "commandExecution")
    .map((i) => i.command ?? "");
  check(
    briefsFrom(from).length === 1 &&
      turn.orchestration?.workers === 1 &&
      turn.orchestration.modelCalls === 4 &&
      cpRows.includes("test -s README.md && echo readme ok") &&
      cpRows.includes("printf 'a\\nb\\nc\\n' | wc -l | grep -q 3") &&
      turn.orchestration.finish?.reviewed === true &&
      turn.orchestration.finish.requirements === 2 &&
      turn.orchestration.finish.passed === 2 &&
      turn.orchestration.finish.open === 0 &&
      turn.orchestration.finish.followUps === 0,
    `the reviewer's two checks were run by code, as rows in the thread, and passed: no worker and no further model call (4 calls: planner, the worker's 2, the review)`,
  );
  check(
    /RESULT: finished[\s\S]*\n\n\*\*Finish check\.\*\* 2 further checks were run on the result and passed:\n- the folder still holds its README: `test -s README\.md && echo readme ok`\n- the count is three: `printf [^\n]*`$/.test(
      last(turn),
    ),
    "the answer says which checks were run and that they passed",
  );
  // A check that fails buys one bounded fix task, with the failing command and its output as the brief.
  seen.length = 0;
  from = fake().filter((l) => l.turnStart).length;
  const cf = await start("experimental");
  await say(cf.id, "onejob checkfail UNCHECKED FIXES fixedmark: make the runner");
  turn = await turnDone(cf.id);
  let fb2 = briefsFrom(from);
  check(
    fb2.length === 2 &&
      /YOUR TASK \(2 of 2\): Fix what the finish check found, and run the failing check again\nAfter the work was reported done, this was found:\n- CHECK FAILED: the marker exists after the job\n {2}command: test -f fixedmark\.txt \|\| \{ echo fixedmark\.txt is missing; exit 1; \}\n {2}it printed: fixedmark\.txt is missing\n\[exit 1\]/.test(
        fb2[1],
      ) &&
      /decide from the request whether the work or the check is wrong/.test(fb2[1]) &&
      fb2[1].length <= BRIEF_BUDGET,
    "a check that failed becomes one fix task: its brief is the failing command and what it printed",
  );
  check(
    seen.map((x) => x.role).join(",") === "planner,review" &&
      existsSync(path.join(work, "fixedmark.txt")) &&
      turn.items.filter((i) => i.command?.startsWith("test -f fixedmark.txt")).length === 2 &&
      turn.orchestration?.finish?.followUps === 1 &&
      turn.orchestration.finish.passed === 1 &&
      turn.orchestration.finish.open === 0 &&
      turn.orchestration.modelCalls === 6 &&
      /\*\*Finish check\.\*\* 1 further check was run on the result and passed:\n- the marker exists after the job: `test -f fixedmark\.txt[^\n]*` \(failed at first; passes after the fix\)$/.test(
        last(turn),
      ),
    "after the fix the failing command is run again, by code, and passes: the answer says it failed at first (6 calls: planner, worker 2, review, fix task 2)",
  );
  from = fake().filter((l) => l.turnStart).length;
  const cu = await start("experimental");
  await say(cu.id, "onejob checkfail UNCHECKED UNSETTLED FIXES unsettledmark: make the runner");
  turn = await turnDone(cu.id);
  check(
    briefsFrom(from).length === 2 &&
      turn.orchestration?.finish?.open === 1 &&
      /\*\*Finish check\.\*\* 1 check \*\*failed\*\*:\n- the marker exists after the job: `test -f unsettledmark\.txt[^\n]*` → unsettledmark\.txt is missing \[exit 1\]\nA fix task was run for it, and it still fails: treat this as \*\*not verified\*\* \(the check itself may be what is wrong\)\.$/.test(
        last(turn),
      ) &&
      !seen.some((x) => x.role === "revise"),
    "a fix task that does not settle it is not planned around: the answer says the check still fails and calls it not verified",
  );
  // With too little left for a fix that could finish, none is started.
  {
    const caps = backend.caps as { modelCalls: number };
    const keep = caps.modelCalls;
    caps.modelCalls = 8;
    from = fake().filter((l) => l.turnStart).length;
    const cb = await start("experimental");
    await say(cb.id, "onejob checkfail UNCHECKED FIXES nevermark: make the runner");
    turn = await turnDone(cb.id);
    caps.modelCalls = keep;
    check(
      briefsFrom(from).length === 1 &&
        turn.status === "completed" &&
        turn.orchestration?.modelCalls === 4 &&
        !existsSync(path.join(work, "nevermark.txt")) &&
        /1 check \*\*failed\*\*:[\s\S]*\nNo fix task was run \(4 of this turn's 8 model calls are used; too little was left to start a fix that could finish\): treat this as \*\*not verified\*\*/.test(
          last(turn),
        ),
      "with the budget nearly gone no fix is started: the answer reports the failed check as not verified",
    );
  }
  // A reviewer's command is not run when it would change things, and a check that cannot run is not a failure.
  from = fake().filter((l) => l.turnStart).length;
  mkdirSync(path.join(work, "build"), { recursive: true });
  const cx = await start("experimental");
  await say(cx.id, "onejob checkunsafe UNCHECKED: make the runner");
  turn = await turnDone(cx.id);
  check(
    briefsFrom(from).length === 1 &&
      existsSync(path.join(work, "build")) &&
      !turn.items.some((i) => /rm -rf build/.test(i.command ?? "")) &&
      turn.orchestration?.finish?.open === 2 &&
      turn.orchestration.finish.followUps === 0 &&
      /\*\*Finish check\.\*\* \*\*Not verified\*\* \(the check could not be run\):\n- the build folder is clean: it would change things \(`rm`\), and a check only looks and runs\n- a tool nobody has: it could not be run \(exit 127\)/.test(
        last(turn),
      ),
    "a reviewer's command that deletes is never run, and one whose tool is missing did not fail: both are reported as not verified, and no fix task is spent on them",
  );
}

log("experimental: PARTIAL with other tasks still planned is progress, not a reason to plan again");
{
  seen.length = 0;
  const pj = await start("experimental");
  await say(pj.id, "partlyjob: inspect, then write it");
  turn = await turnDone(pj.id);
  const n = stored(pj.id).notes;
  check(
    turn.status === "completed" &&
      seen.map((x) => x.role).join(",") === "planner,review,final" &&
      turn.orchestration?.workers === 2 &&
      n.done.length === 2 &&
      /PARTLY inspect the inputs \(partly\): looked at it/.test(n.done[0]) &&
      n.problems.some((p) =>
        /left open: None for the inspection; the script itself is not written yet/.test(p),
      ),
    "a worker that finished its inspection and reported PARTIAL because the job is not done yet: the next task runs, no revision (what it left open is in the notes)",
  );
}

log("experimental: a declined approval does not consume a revision");
{
  seen.length = 0;
  let from = fake().filter((l) => l.turnStart).length;
  const decline = (threadId: string, n: number) =>
    until(`approval ${n} of ${threadId}`, () => {
      const asked = notes.filter(
        (m) =>
          m.method === "item/commandExecution/requestApproval" && m.params?.threadId === threadId,
      );
      if (asked.length < n) return null;
      ws.send(JSON.stringify({ id: asked[n - 1].id, result: { decision: "decline" } }));
      return true;
    });
  const dk = await start("experimental", { approvalPolicy: "untrusted" });
  await say(dk.id, "askme: run the checker");
  await decline(dk.id, 1);
  turn = await turnDone(dk.id);
  let db = fake()
    .filter((l) => l.turnStart)
    .slice(from)
    .map((l) => l.turnStart!.brief);
  check(
    turn.status === "completed" &&
      db.length === 2 &&
      !/was refused/.test(db[0]) &&
      /RECORDED: an earlier worker on this task asked approval for a command and was refused: python3 check\.py ASKME run it\. Nobody will approve it\./.test(
        db[1],
      ) &&
      /NEEDS APPROVAL \(asked and declined: do without, do not ask again\):\n- python3 check\.py ASKME run it/.test(
        db[1],
      ),
    "the worker was refused an approval: the task is run once more with that recorded, and the notes hold it once",
  );
  check(
    !seen.some((x) => x.role === "revise") &&
      stored(dk.id).notes.approvals.join() === "python3 check.py ASKME run it" &&
      stored(dk.id).notes.problems.length === 0 &&
      turn.items.some((i) =>
        /^An approval was declined \(`python3 check\.py ASKME run it`\)\. Running the task again without it\.$/.test(
          i.text ?? "",
        ),
      ),
    "no revision was spent on it, and it is not a problem of the plan",
  );
  check(
    /RESULT: finished "ASKME run it"/.test(last(turn)) &&
      /\n\nNeeds approval \(asked and declined, so not run\): `python3 check\.py ASKME run it`\.$/.test(
        last(turn),
      ) &&
      !/Not verified|last recorded check failed/.test(last(turn)),
    "the second worker did without it; the answer reports the command that needs approval (a command that never ran is not a failed check)",
  );
  seen.length = 0;
  from = fake().filter((l) => l.turnStart).length;
  const da = await start("experimental", { approvalPolicy: "untrusted" });
  await say(da.id, "askalways: run the checker");
  await decline(da.id, 1);
  await decline(da.id, 2);
  turn = await turnDone(da.id);
  db = fake()
    .filter((l) => l.turnStart)
    .slice(from)
    .map((l) => l.turnStart!.brief);
  check(
    turn.status === "completed" &&
      db.length === 2 &&
      seen.map((x) => x.role).join(",") === "planner" &&
      turn.items.some((i) =>
        /^That task needs an approval that was declined twice/.test(i.text ?? ""),
      ) &&
      stored(da.id).notes.problems.some((p) =>
        /not finished, it needs approval: python3 check\.py ASKME ALWAYS run it/.test(p),
      ) &&
      /Needs approval \(asked and declined, so not run\): `python3 check\.py ASKME ALWAYS run it`\.$/.test(
        last(turn),
      ),
    "refused twice: the job carries on without the task and says so; still no revision, and no reviewer for a turn that changed nothing",
  );
}

log("hyperexperimental: FINISHED is checked before it is the answer");
{
  seen.length = 0;
  const hf = await start("hyperexperimental");
  await say(hf.id, "hfinish: put 4 lines in hfin.txt");
  turn = await turnDone(hf.id);
  check(
    seen.map((x) => x.role).join(",") === "think,think,review,think,think",
    `nothing ran the file that was written, so the first FINISHED goes to a reviewer; its check is run by code, fails, and goes back to think (${seen.map((x) => x.role).join(",")})`,
  );
  const rvIn = seen.find((x) => x.role === "review")!.input;
  check(
    /THE REQUEST, word for word:\n"""\nhfinish: put 4 lines in hfin\.txt\n"""/.test(rvIn) &&
      /- hfin\.txt \(add, exists, 6 bytes\)\n {4}\| a\n {4}\| b\n {4}\| c/.test(rvIn) &&
      /EVIDENCE, commands run[^\n]*\n\(none recorded\)/.test(rvIn) &&
      /SETTLED BY CODE[^\n]*\n- hfin\.txt exists under exactly that name/.test(rvIn),
    "the reviewer gets the request word for word, the file with its first lines, that no command was run, and what code has settled",
  );
  const th3 = seen.filter((x) => x.role === "think")[2].input;
  check(
    /LAST STEP RESULTS:\nYou said FINISHED\. Before the answer went out it was checked, and this was found:\n- CHECK FAILED: hfin\.txt holds 4 lines\n {2}command: test "\$\(wc -l < hfin\.txt[^\n]*\n {2}it printed: hfin\.txt has 3 lines, not 4\n\[exit 1\]/.test(
      th3,
    ) && /PINNED FILES:\n--- hfin\.txt \(all 3 lines/.test(th3),
    "the next think is told the check that failed, with its command and what it printed (and still has the file pinned)",
  );
  const ran = turn.items.find(
    (i) => i.type === "commandExecution" && /__counted__/.test(i.command ?? ""),
  );
  check(
    !seen.some((x) => x.role === "translate") &&
      ran?.command === "cd . && wc -l hfin.txt\necho __counted__ {a,b}" &&
      /4 hfin\.txt\n__counted__/.test(ran.aggregatedOutput ?? ""),
    "the fix step's file block and shell block ran as the think step wrote them, with no translate call",
  );
  check(
    turn.status === "completed" &&
      /^hfin\.txt has 4 lines, counted with wc -l\.\nNOT CHECKED: nothing\n\n\*\*Finish check\.\*\* 1 further check was run on the result and passed:\n- hfin\.txt holds 4 lines: `test [^\n]*` \(failed at first; passes after the fix\)$/.test(
        last(turn),
      ) &&
      turn.orchestration?.finish?.open === 0 &&
      turn.orchestration.finish.passed === 1 &&
      turn.orchestration.finish.followUps === 1 &&
      turn.orchestration.roles.review.calls === 1 &&
      turn.orchestration.modelCalls === 5,
    `after the fix the failing check is run again by code and passes, and the answer says so (${last(turn).split("\n")[0]}); 5 model calls for the turn (it was 9)`,
  );
  check(seen.every(within), "every prompt of the turn is within its budget");
  seen.length = 0;
  const hl = await start("hyperexperimental");
  await say(hl.id, "hlooking");
  turn = await turnDone(hl.id);
  {
    const th = seen.filter((x) => x.role === "think");
    check(
      turn.status === "completed" &&
        th.length === 3 &&
        !/only looked/.test(th[1].input) &&
        /\(recorded\) The last 2 steps only looked\. This step must write a file, make a change or run something, or reply BLOCKED: with what is missing\./.test(
          th[2].input,
        ) &&
        /PINNED FILES:\n--- README\.md \(all \d+ lines?, as on disk now\)/.test(th[2].input),
      "after the look limit (2 here, 3 in the app) the think is told that the next step must act or say what blocks it; what it read with a command is pinned",
    );
    check(
      /^\*\*Not finished\.\*\* README\.md is all there is; nothing here says what to write\.\n\nWhere things stand:\n\nSTEPS \(recorded by code/.test(
        last(turn),
      ) && stored(hl.id).openGoal === "hlooking",
      "BLOCKED: ends the turn with what is missing and where things stand; the request stays open for the next message",
    );
  }
  seen.length = 0;
  const hm = await start("hyperexperimental");
  await say(hm.id, "hmangle");
  turn = await turnDone(hm.id);
  check(
    turn.items.some(
      (i) => i.command === "echo __init__ {a,b} done" && /__init__/.test(i.aggregatedOutput ?? ""),
    ) && seen.map((x) => x.role).join(",") === "think,translate,think",
    "a one-line command given inside a sentence goes to the translator, and what it sent back with its marks lost runs as the think step wrote it (a turn that changed nothing has no finish check)",
  );
}

// ---- what the second benchmark round asked for -----------------------------------------------------
log("hyperexperimental: a write lands where the request says, and never outside the folder");
{
  seen.length = 0;
  mkdirSync(path.join(work, "polysub"), { recursive: true });
  const hp = await start("hyperexperimental");
  await say(hp.id, `hpoly: write ${work}/polysub/poly.txt holding hi`);
  turn = await turnDone(hp.id);
  const th = seen.filter((x) => x.role === "think");
  check(
    turn.status === "completed" &&
      readFileSync(path.join(work, "polysub", "poly.txt"), "utf8") === "hi\n" &&
      !existsSync(path.join(work, "poly.txt")) &&
      /WRITE: polysub\/poly\.txt \(1 lines\)\n\[created polysub\/poly\.txt, 1 lines\]\n\(the request names this file as polysub\/poly\.txt: it was written there, not at poly\.txt\)/.test(
        th[1].input,
      ),
    "a file the step named by its bare name is written at the path the request gives for it, and the result says so",
  );
  check(
    !existsSync("/etc/orc-nope.txt") &&
      /WRITE: \/etc\/orc-nope\.txt \(1 lines\)\n\(refused, nothing was written\) \/etc\/orc-nope\.txt is outside the working folder [^\n]*, and the request does not name it\. Paths are relative to the working folder/.test(
        th[1].input,
      ) &&
      turn.orchestration?.refused === 1 &&
      !fake().some((l) => l.exec?.command.join(" ").includes("orc-nope")),
    "a write outside the folder that the request does not name is refused before anything runs, with the reason",
  );
}

log("hyperexperimental: a long job (twelve files, long outputs) stays within every budget");
{
  seen.length = 0;
  const caps = backend.caps as { steps: number; modelCalls: number };
  const keep = { ...caps };
  caps.steps = 20;
  caps.modelCalls = 60;
  const hlj = await start("hyperexperimental");
  await say(hlj.id, "hlong: write the twelve parts under src/ and run each");
  turn = await turnDone(hlj.id, 60_000);
  caps.steps = keep.steps;
  caps.modelCalls = keep.modelCalls;
  const th = seen.filter((x) => x.role === "think");
  const size = (x: Seen) => x.instructions.length + x.input.length;
  const largest = (role: string) => Math.max(0, ...seen.filter((x) => x.role === role).map(size));
  check(
    turn.status === "completed" &&
      /^all twelve modules are written and were run\./.test(last(turn)) &&
      th.length === 13 &&
      existsSync(path.join(work, "src", "mod_12.py")),
    `the job ran to its end: twelve steps and FINISHED (${last(turn).split("\n")[0]})`,
  );
  check(
    largest("think") <= THINK_BUDGET &&
      seen.filter((x) => x.role !== "think").every((x) => size(x) <= PROMPT_BUDGET),
    `the largest prompt of each role stayed within its budget for the whole run: think ${largest("think")} <= ${THINK_BUDGET}, fold ${largest("summarize")} <= ${PROMPT_BUDGET}`,
  );
  const pinHeads = th.map((x) => (x.input.match(/^--- src\/mod_\d+\.py[ :]/gm) ?? []).length);
  check(
    Math.max(...pinHeads) <= MAX_PINS &&
      /--- src\/mod_11\.py \(lines 1-\d+ of 120, as on disk now; for others: READ: src\/mod_11\.py <first>-<last>\) ---\n {2}1\| def f11_0\(rows\):/.test(
        th[11].input,
      ) &&
      /^--- src\/mod_10\.py: pinned, no room to show it this step/m.test(th[11].input) &&
      !/^--- src\/mod_9\.py/m.test(th[11].input),
    `the pinned files rotate instead of growing: never more than ${MAX_PINS} in a prompt (${pinHeads.join("")}), the newest first in line for the room`,
  );
  const memOf = (x: Seen) =>
    /\n\nMEMORY:\n([\s\S]*?)\n\n(?:PINNED FILES|LAST STEP RESULTS):/.exec(x.input)?.[1] ?? "";
  check(
    th.every((x) => memOf(x).length <= MEMORY_LIMIT) &&
      /EARLIER STEPS \(\d+, folded\):\nSUMMARY v\d+/.test(memOf(th[12])) &&
      /KEPT FACTS[^\n]*\n(?:- [^\n]*\n)*- mod_12\.py exports f12_0/.test(memOf(th[12])) &&
      /\n12\. Step 12: write mod_12\.py and run it over the rows\. → WRITE: src\/mod_12\.py \(120 lines\): ok; RUN: python3 -c [^\n]*: ok "step 12 row 399 x+"/.test(
        memOf(th[12]),
      ),
    `the memory stays within its bound in every prompt (largest ${Math.max(...th.map((x) => memOf(x).length))} <= ${MEMORY_LIMIT}): the latest steps by code, the older ones folded, the facts the think step asked to keep`,
  );
  const gap =
    /\[… lines (\d+)-(\d+) of 400 are not shown; the whole output is saved: READ: (\S+step2-2\.txt) \d+-\d+ …\]/.exec(
      th[2].input,
    );
  check(
    !!gap &&
      readFileSync(gap[3], "utf8").split("\n").length === 401 &&
      /step 2 row 0 x+\n/.test(th[2].input) &&
      /step 2 row 399 x+/.test(th[2].input),
    "a long output is shown once, as its first and last lines, with the lines left out and the file that holds all of it",
  );
  check(
    new RegExp(
      `READ: ${gap?.[3].replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&")} 100-102\\nstep 2 row 99 x+\\nstep 2 row 100 x+\\nstep 2 row 101 x+\\n\\[lines 100-102 of 400\\]`,
    ).test(th[3].input),
    "and a later step reads a range of the saved output instead of running the command again",
  );
  const folds = seen.filter((x) => x.role === "summarize").length;
  check(
    !seen.some((x) => x.role === "translate" || x.role === "review") &&
      turn.orchestration?.direct === 12 &&
      folds >= 1 &&
      folds <= 4 &&
      turn.orchestration.modelCalls === 13 + folds,
    `twelve steps cost ${turn.orchestration?.modelCalls} model calls (13 think + ${folds} folds of the log; three chats a step and a review made it 38): no translate call, no summary per step, no reviewer for a job that ran its results`,
  );
}

log("experimental: a worker whose context fills up hands over to a fresh one");
{
  const briefsFrom = (from: number) =>
    fake()
      .filter((l) => l.turnStart)
      .slice(from)
      .map((l) => l.turnStart!.brief);
  seen.length = 0;
  let from = fake().filter((l) => l.turnStart).length;
  let tracesFrom = traces.length;
  const lj = await start("experimental");
  await say(lj.id, "onejob GROWS 3: build the long thing, part by part");
  turn = await turnDone(lj.id, 60_000);
  let lb = briefsFrom(from);
  const budget = backend.caps.workerContextTokens;
  check(
    turn.status === "completed" &&
      lb.length === 7 &&
      [1, 3, 5].every((i) => lb[i].startsWith("Stop here: this thread's context is nearly full")) &&
      turn.orchestration?.handoffs === 3 &&
      turn.orchestration.workers === 4,
    "a long job in one worker: three times its requests reach the context budget, it is stopped and asked for its hand-over on the same thread, and a fresh worker goes on",
  );
  const workerTraces = traces.slice(tracesFrom).filter((t) => t.type === "worker");
  check(
    workerTraces.every((t) => t.type === "worker" && t.maxInputTokens < budget + 3000) &&
      (turn.orchestration?.workerMaxInputTokens ?? 1e9) < budget + 3000 &&
      workerTraces
        .slice(0, 3)
        .every((t) => t.type === "worker" && t.status === "handed over (context)"),
    `no worker's request grew past its budget by more than the step that crossed it (largest ${turn.orchestration?.workerMaxInputTokens} tokens, budget ${budget}): the bridge never has to cut a worker's thread`,
  );
  check(
    [2, 4, 6].every(
      (i, n) =>
        new RegExp(
          `YOUR TASK \\(1 of 1\\): onejob GROWS 3: build the long thing, part by part\\n\\(recorded\\) An earlier worker on this task was stopped when its context was nearly full \\(hand-over ${n + 1}\\)\\. Its report:\\nRESULT: the first half is written and its check passed`,
        ).test(lb[i]) &&
        /BLOCKERS: LEFT TO DO: write the second half; the format is one row per line, id first/.test(
          lb[i],
        ) &&
        /Go on from the files as they are now\. Do not redo what is finished/.test(lb[i]),
    ) && lb.filter((_, i) => i % 2 === 0).every((b) => b.length <= BRIEF_BUDGET),
    `each fresh worker's brief carries the hand-over in the stopped worker's own words (what is done, what is left, what it learned), within the brief's budget (largest ${Math.max(...lb.filter((_, i) => i % 2 === 0).map((b) => b.length))} <= ${BRIEF_BUDGET})`,
  );
  check(
    seen.map((x) => x.role).join(",") === "planner" &&
      /RESULT: finished "onejob GROWS 3: build the long thing, part by part/.test(last(turn)) &&
      notesText(stored(lj.id).notes).length <= NOTES_LIMIT &&
      stored(lj.id).notes.done.length === 4,
    "no planner call was spent on it: the job stayed one task, carried by the notes and the hand-overs; the last worker's report is the answer",
  );
  // A context that fills up twice with nothing changed is a task too big for a worker: the planner splits it.
  seen.length = 0;
  from = fake().filter((l) => l.turnStart).length;
  const dj = await start("experimental");
  await say(dj.id, "onejob GROWS DRY: read everything first");
  turn = await turnDone(dj.id, 60_000);
  lb = briefsFrom(from);
  const dryRevise = seen.find((x) => x.role === "revise")?.input ?? "";
  check(
    turn.status === "completed" &&
      seen.map((x) => x.role).join(",") === "planner,revise,review,final" &&
      /the worker stopped: its context filled up 2 times without the task finishing: the task is too big for one worker/.test(
        dryRevise,
      ) &&
      /write the second half; the format is one row per line/.test(dryRevise) &&
      /YOUR TASK \(1 of 2\): Do the thing another way/.test(lb.at(-2) ?? ""),
    "a worker that fills its context twice without changing anything sends its hand-over working state to the planner to split what is left",
  );
  // Stateful web-chat delta context (chatgpt-web reuse_chat): triggers hand-over near 11k instead
  // of ~14.5k, and carries failure groups, tried fixes, files and next actions across terse and
  // empty hand-overs.
  seen.length = 0;
  from = fake().filter((l) => l.turnStart).length;
  tracesFrom = traces.length;
  const dl = await start("experimental");
  await say(dl.id, "onejob GROWS DELTA: fix seeded library bugs until pytest passes");
  turn = await turnDone(dl.id, 60_000);
  lb = briefsFrom(from);
  const deltaTraces = traces.slice(tracesFrom).filter((t) => t.type === "worker");
  check(
    turn.status === "completed" &&
      seen.map((x) => x.role).join(",") === "planner" &&
      turn.orchestration?.handoffs === 3 &&
      turn.orchestration.workers === 4 &&
      deltaTraces.every((t) => t.type === "worker" && t.maxInputTokens < budget + 2500) &&
      deltaTraces.slice(0, 3).every((t) => t.type === "worker" && t.calls <= 6),
    `delta-mode web chat hands over right around ${budget} tokens without ever reaching 14.5k (peak ${turn.orchestration?.workerMaxInputTokens} tokens, calls per worker: ${deltaTraces.map((t) => (t.type === "worker" ? t.calls : 0)).join(",")})`,
  );
  check(
    lb.length === 7 &&
      /boltons\/dictutils\.py:142 OMD\.popall/.test(lb[2]) &&
      /naive slice in windowed broke fill=None/.test(lb[2]) &&
      /NEXT: edit boltons\/dictutils\.py:142/.test(lb[2]) &&
      // Worker 2 wrote a terse report, yet Worker 3's brief still keeps Worker 1's failure groups,
      // tried fixes, AND Worker 2's recorded pytest failure line and edited file.
      /fixed dictutils; failing tests reduced from 21 to 10/.test(lb[4]) &&
      /boltons\/iterutils\.py:88 windowed skips final short chunk/.test(lb[4]) &&
      /naive slice in windowed broke fill=None/.test(lb[4]) &&
      /FAILED tests\/test_iterutils\.py::test_windowed/.test(lb[4]) &&
      // Worker 3 gave an empty wrap-up, yet Worker 4's brief preserves prior analysis + iterutils.py.
      /worker 3 gave no hand-over/.test(lb[6]) &&
      /boltons\/iterutils\.py:88 windowed skips final short chunk/.test(lb[6]) &&
      /iterutils\.py \(update\)/.test(lb[6]) &&
      lb.filter((_, i) => i % 2 === 0).every((b) => b.length <= HANDOVER_BRIEF_BUDGET),
    "concrete failure groups, tried fixes, edited files, recorded pytest failures and next actions survive structured, terse and empty hand-overs",
  );
}

log("experimental: what no plan gets past is not planned around");
{
  seen.length = 0;
  let from = fake().filter((l) => l.turnStart).length;
  const eb = await start("experimental");
  await say(eb.id, "onejob ENVBLOCK MAKES envq.sparql: write the query to envq.sparql and run it");
  turn = await turnDone(eb.id);
  check(
    turn.status === "completed" &&
      seen.map((x) => x.role).join(",") === "planner,review" &&
      fake().filter((l) => l.turnStart).length === from + 1 &&
      turn.orchestration?.modelCalls === 4 &&
      turn.items.some((i) =>
        /^Part of this cannot be run here \(cannot execute: arq missing\)\. Going on without it: it will be reported as not verified\.$/.test(
          i.text ?? "",
        ),
      ) &&
      /NOT CHECKED: running the query: no SPARQL engine is installed/.test(last(turn)) &&
      !/^\*\*Not finished/.test(last(turn)),
    "a worker that made the file and reports PARTIAL only because a tool is missing is not sent back to the planner: 4 model calls, and the answer says what was not checked (the benchmark's SPARQL job spent 3 revisions and 26 more calls here)",
  );
  check(
    /THE WORK SAYS IT DID NOT CHECK:\nrunning the query: no SPARQL engine is installed/.test(
      seen[1].input,
    ),
    "the reviewer is told what the work could not check",
  );
  seen.length = 0;
  from = fake().filter((l) => l.turnStart).length;
  const sj = await start("experimental");
  await say(sj.id, "stalejob BLOCKME MAKES stale.json: make stale.json and verify it");
  turn = await turnDone(sj.id);
  check(
    turn.status === "completed" &&
      seen.map((x) => x.role).join(",") === "planner,revise,review,final" &&
      fake().filter((l) => l.turnStart).length === from + 2 &&
      turn.items.some((i) => /^The revised plan changed nothing \(/.test(i.text ?? "")) &&
      stored(sj.id).notes.pending.length === 0,
    "a revised plan whose first task changes nothing and does not finish is not revised again, and its remaining tasks are not run: one revision, two workers",
  );
}

// ---- restart ----------------------------------------------------------------------------------------
log("read back");
const cut = await start("experimental");
await say(cut.id, "slow job");
await until("the worker's command", () =>
  notes.some(
    (n) =>
      n.method === "item/started" &&
      n.params?.threadId === cut.id &&
      (n.params.item as TurnItem).type === "commandExecution",
  ),
);
// (the thread file is written at task boundaries: write it now, as a crash would find it mid-task)
const old = backend;
old.save((old as unknown as { threads: Map<string, never> }).threads.get(cut.id)!);
backend = makeBackend(); // "the app restarted": a new backend reads the same folder
const list = (await backend.handle("thread/list", {})) as {
  data: { id: string; orchestrator: string; preview: string }[];
};
check(
  list.data.length >= 20 &&
    list.data.some((t) => t.id === ex.id && t.orchestrator === "experimental") &&
    list.data.some((t) => t.id === hy.id && t.orchestrator === "hyperexperimental"),
  `a new backend reads the threads back, each with its orchestrator (${list.data.length})`,
);
const back = (await backend.handle("thread/turns/list", {
  threadId: ex.id,
  sortDirection: "asc",
})) as { data: Turn[] };
check(
  back.data.length === 2 && back.data[0].items.length === 12 && back.data[0].status === "completed",
  "turns and items are readable",
);
const cutBack = (await backend.handle("thread/turns/list", {
  threadId: cut.id,
  sortDirection: "desc",
})) as { data: Turn[] };
check(
  cutBack.data[0].status === "interrupted" &&
    cutBack.data[0].items.every((i) => i.status !== "inProgress"),
  "a turn cut off mid-task reads back as interrupted, nothing left running",
);
const resumed = (await backend.handle("thread/resume", { threadId: hy.id })) as {
  model: string;
  orchestrator: string;
  sandbox: { type: string };
};
check(
  resumed.model === "luna/solstice" &&
    resumed.orchestrator === "hyperexperimental" &&
    resumed.sandbox.type === "workspaceWrite",
  "thread/resume gives the model, orchestrator and sandbox",
);
old.stop();
await turnDone(cut.id, 8000);
// the restored thread carries on from its notes
seen.length = 0;
const ws3 = new WebSocket(`ws://127.0.0.1:${port}`);
const got: Msg[] = [];
ws3.on("message", (d) => got.push(JSON.parse(String(d)) as Msg));
await new Promise((r) => ws3.once("open", r));
ws3.send(
  JSON.stringify({
    id: 1,
    method: "turn/start",
    params: { threadId: ex.id, input: text("one more follow-up") },
  }),
);
await until("the restored thread's turn", () =>
  got.some((m) => m.method === "turn/completed" && (m.params?.turn as Turn).status === "completed"),
);
check(
  seen[0]?.role === "planner" &&
    /GOAL: multi: make a tiny module/.test(seen[0].input) &&
    /LATER REQUEST: now a follow-up/.test(seen[0].input),
  "after the restart a new message is planned from the stored notes",
);
const arch = await backend.handle("thread/archive", { threadId: hello.id });
check(
  arch &&
    !((await backend.handle("thread/list", {})) as { data: { id: string }[] }).data.some(
      (t) => t.id === hello.id,
    ),
  "archive hides a thread",
);

log(
  "experimental: a worker that ran nothing is run again once, and its excuse stays out of the notes",
);
seen.length = 0;
let idleFrom = fake().filter((l) => l.turnStart).length;
const nt = await start("experimental");
await say(nt.id, "notools job");
turn = await turnDone(nt.id);
let idleBriefs = fake()
  .filter((l) => l.turnStart)
  .slice(idleFrom)
  .map((l) => l.turnStart!.brief);
check(
  turn.status === "completed" &&
    idleBriefs.length === 2 &&
    !/ran no command/.test(idleBriefs[0]) &&
    /RECORDED: an earlier worker on this task ran no command/.test(idleBriefs[1]) &&
    idleBriefs[1].length <= BRIEF_BUDGET,
  "the task got a second worker, whose brief records that the first ran nothing",
);
check(
  !seen.some((s) => s.role === "revise") &&
    stored(nt.id).notes.problems.length === 0 &&
    stored(nt.id).notes.done.length === 1,
  "no revision and no problem noted: the second worker's work is the task's result",
);
seen.length = 0;
idleFrom = fake().filter((l) => l.turnStart).length;
const nta = await start("experimental");
await say(nta.id, "notools always job");
turn = await turnDone(nta.id);
idleBriefs = fake()
  .filter((l) => l.turnStart)
  .slice(idleFrom)
  .map((l) => l.turnStart!.brief);
const idleRevise = seen.find((s) => s.role === "revise")?.input ?? "";
check(
  /YOUR TASK \(1 of 1\): notools always job\n[^\n]*NOTOOLS ALWAYS/.test(idleBriefs[0]) &&
    /YOUR TASK \(1 of 1\): notools always job\n[^\n]*NOTOOLS ALWAYS/.test(idleBriefs[1]) &&
    /YOUR TASK \(1 of 2\): Do the thing another way/.test(idleBriefs[2] ?? "") &&
    /\(recorded\) Twice a worker given this task stopped without running any command/.test(
      idleRevise,
    ),
  "the same twice goes to the planner as a record that nothing was tried",
);
check(
  stored(nta.id).notes.problems.some((p) =>
    /two workers stopped without running any command/.test(p),
  ) && !stored(nta.id).notes.problems.some((p) => /unavailable/i.test(p)),
  "the notes say nothing was tried, not that the terminal is missing",
);

log(
  "a concrete model name is passed through unchanged; every call can be found in the router's ledger",
);
seen.length = 0;
const tracesBefore = traces.length;
const startsBefore = fake().filter((l) => l.threadStart).length;
const named = await start("experimental", { model: "chatgpt-web/luna" });
await say(named.id, "many parts");
turn = await turnDone(named.id);
const namedStarts = fake()
  .filter((l) => l.threadStart)
  .slice(startsBefore) as (LogLine & { threadId?: string })[];
check(
  seen.length > 0 && seen.every((s) => s.body.model === "chatgpt-web/luna"),
  "plain calls name the model as the thread has it (a router's concrete model id, not only a tier)",
);
check(
  namedStarts.length === 4 && namedStarts.every((l) => l.threadStart!.model === "chatgpt-web/luna"),
  "worker threads are started with the same name",
);
const namedTraces = traces.slice(tracesBefore);
const modelTraces = namedTraces.filter((t) => t.type === "model");
check(
  modelTraces.length === seen.length &&
    modelTraces.every((t, i) => t.type === "model" && t.session === seen[i].session),
  "each plain call's trace carries the session key the router saw (its key in the usage ledger)",
);
const workerTraces = namedTraces.filter((t) => t.type === "worker");
check(
  workerTraces.length === 4 &&
    workerTraces.every(
      (t, i) => t.type === "worker" && !!t.threadId && t.threadId === namedStarts[i].threadId,
    ),
  "each worker's trace carries its harness thread id (the key of its requests in the ledger)",
);
check(
  workerTraces.every(
    (t) => t.type === "worker" && /STATUS: DONE/.test(t.report) && t.commands === 1,
  ),
  "and the worker's own report and how many commands it ran",
);
const colon = await call("thread/start", {
  model: "solstice:none",
  cwd: work,
  config: { orchestrator: "experimental" },
});
check(!!colon.error, "a model name with a fallback suffix is still refused");

const roles = new Map<string, number>();
for (const t of traces)
  if (t.type === "model") roles.set(t.role, Math.max(roles.get(t.role) ?? 0, t.promptChars));
log(
  `largest prompt per role in this run (characters): ${[...roles].map(([r, n]) => `${r} ${n}`).join(", ")}`,
);

ws.close();
ws3.close();
wss.close();
router.close();
appServer.stop();
log("all good");
process.exit(0);
