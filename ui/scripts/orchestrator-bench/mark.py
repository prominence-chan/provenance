#!/usr/bin/env python3
"""mark.py release <task> <mode> <why>   run it again (the failed attempt stays on record as invalid)
   mark.py final <task> <mode> <why>     the last attempt stands as the result"""
import json, os, sys, time
BENCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
what, task, mode, why = sys.argv[1], sys.argv[2], sys.argv[3], " ".join(sys.argv[4:])
rp = os.path.join(BENCH, "results.jsonl")
rows = [json.loads(l) for l in open(rp)]
if what == "release":
    rows.append({"task": task, "mode": mode, "release": True, "why": why, "at": time.time()})
else:
    last = [r for r in rows if r["task"] == task and r["mode"] == mode and "release" not in r][-1]
    last["final"] = True
    last["review_note"] = why
open(rp, "w").write("".join(json.dumps(r) + "\n" for r in rows))
print(what, task, mode)
