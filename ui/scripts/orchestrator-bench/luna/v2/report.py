#!/usr/bin/env python3
"""report.py: v1 against v2 per task and arm, and what the finish check did in each v2 run."""
import json, os, re
S = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
H = "/Users/yufan/Desktop/Development/provenance-wt-bench-luna/.bench-hidden"
ORDER = ["sqlite-db-truncate", "cancel-async-tasks", "modernize-scientific-stack", "db-wal-recovery",
         "model-extraction-relu-logits", "regex-log", "polyglot-c-py", "sparql-university",
         "constraints-scheduling", "large-scale-text-editing"]
MODES = ["stock", "experimental", "hyperexperimental"]
def load(d):
    return [r for r in (json.loads(l) for l in open(os.path.join(S, d, "results.jsonl"))) if "release" not in r]
v1, v2 = load("bench-luna"), load("bench-luna-v2")
def fin(rows, t, m):
    f = [r for r in rows if r["task"] == t and r["mode"] == m and r.get("final")]
    return f[-1] if f else None
def big(r):
    if r["mode"] == "stock": return f"{r.get('maxInputTokens')}t"
    m = max([v["maxPromptChars"] for v in (r.get("roles") or {}).values()] or [0])
    w = r.get("workerMaxInputTokens")
    return f"{m}c" + (f"/{w}t" if w else "")
def cell(r):
    if not r: return "-"
    return f"{'PASS' if r['passed'] else 'FAIL'} {r.get('ledger_calls')}c {round(r['wall_seconds'])}s {big(r)}"
for m in MODES:
    print("==", m)
    for t in ORDER:
        print(f"{t:30} v1 {cell(fin(v1,t,m)):34} v2 {cell(fin(v2,t,m))}")
    for name, rows in (("v1", v1), ("v2", v2)):
        f = [fin(rows, t, m) for t in ORDER]; f = [r for r in f if r]
        print(f"   {name}: pass {sum(r['passed'] for r in f)}/{len(f)} calls {sum(r.get('ledger_calls') or 0 for r in f)} wall {round(sum(r['wall_seconds'] for r in f))}s ctx {[r['ledger_ctx'] for r in f if r.get('ledger_ctx')]}")
print("== finish check (v2)")
tot = dict(review=0, follow=0)
fence = dict(replies=0, rawleft=0, odd=0, tr=0, trbr=0, unbal=0)
for m in ("hyperexperimental", "experimental"):
    for t in ORDER:
        r = fin(v2, t, m)
        if not r: continue
        rd = r["run_dir"]; tp = rd + "/record/traces.jsonl"
        rows = [json.loads(l) for l in open(tp)] if os.path.exists(tp) else []
        ms = [d for d in rows if d.get("type") == "model"]
        fence["replies"] += len(ms); fence["rawleft"] += sum("```raw" in d["reply"] for d in ms); fence["odd"] += sum(d["reply"].count("```") % 2 for d in ms)
        tr = [d for d in ms if d["role"] == "translate"]; fence["tr"] += len(tr); fence["trbr"] += sum("{" in d["reply"] for d in tr); fence["unbal"] += sum(d["reply"].count("{") != d["reply"].count("}") for d in tr)
        rv = [d for d in ms if d["role"] == "review"]
        txt = " ".join(d["reply"] for d in rv)
        met = len(re.findall(r"\|\s*MET\b", txt)); ns = len(re.findall(r"\|\s*NOT SHOWN\b", txt)); vi = len(re.findall(r"\|\s*VIOLATED\b", txt))
        tot["review"] += len(rv)
        print(f"{m[:5]} {t:30} {'PASS' if r['passed'] else 'FAIL'} finish={r.get('finish')} review calls {len(rv)} met {met} not-shown {ns} violated {vi} guard={str(r.get('guard'))[:40]}")
print("fences/braces in v2 plain replies:", fence, "| review calls", tot["review"])
print("== invalid attempts v2")
for r in v2:
    if not r.get("final"): print("  ", r["task"], r["mode"], "try", r.get("attempt"), "calls", r.get("ledger_calls"), "|", str(r.get("invalid"))[:110])
print("v2 Luna calls in runs:", sum(r.get("ledger_calls") or 0 for r in v2), "| served:", {k for r in v2 for k in (r.get("ledger_served") or {})}, "| slept:", [r.get("slept_seconds") for r in v2 if (r.get("slept_seconds") or 0) > 5])
