#!/usr/bin/env python3
"""table.py: the result table from results.jsonl (final attempts), plus invalid attempts and totals."""
import json, os, sys
B = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rows = [json.loads(l) for l in open(os.path.join(B, "results.jsonl"))]
runs = [r for r in rows if "release" not in r]
ORDER = ["sqlite-db-truncate", "cancel-async-tasks", "modernize-scientific-stack", "db-wal-recovery",
         "model-extraction-relu-logits", "regex-log", "polyglot-c-py", "sparql-university",
         "constraints-scheduling", "large-scale-text-editing"]
MODES = ["stock", "experimental", "hyperexperimental"]
def big(r):
    if r["mode"] == "stock":
        return f"{r.get('maxInputTokens')}tok"
    roles = r.get("roles") or {}
    m = max([v["maxPromptChars"] for v in roles.values()] or [0])
    w = r.get("workerMaxInputTokens")
    return f"{m}ch" + (f"/w{w}tok" if w else "")
for t in ORDER:
    cells = []
    for m in MODES:
        f = [r for r in runs if r["task"] == t and r["mode"] == m and r.get("final")]
        if not f:
            cells.append("-")
            continue
        r = f[-1]
        cells.append(f"{'PASS' if r['passed'] else 'FAIL'} {round(r['wall_seconds'])}s {r.get('ledger_calls')}c {big(r)}"
                     + (" TIMEOUT" if r.get("timedOut") else "") + (f" try{r['attempt']}" if r.get("attempt") else ""))
    print(f"{t:30} | " + " | ".join(f"{c:38}" for c in cells))
for m in MODES:
    f = [r for r in runs if r["mode"] == m and r.get("final")]
    print(m, "pass", sum(1 for r in f if r["passed"]), "of", len(f), "| calls", sum(r.get("ledger_calls") or 0 for r in f),
          "| wall", round(sum(r["wall_seconds"] for r in f)), "s | ctx", [r.get("ledger_ctx") for r in f if r.get("ledger_ctx")],
          "| retries", sum(r.get("retries") or 0 for r in f))
print("invalid attempts:")
for r in runs:
    if not r.get("final"):
        print("  ", r["task"], r["mode"], "try", r.get("attempt"), "calls", r.get("ledger_calls"), "|", str(r.get("invalid"))[:150])
print("all Luna calls in runs:", sum(r.get("ledger_calls") or 0 for r in runs), "| served:", {k for r in runs for k in (r.get("ledger_served") or {})})
