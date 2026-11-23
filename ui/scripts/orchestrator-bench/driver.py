#!/usr/bin/env python3
"""Runs the fixed subset, one run at a time: prepare -> agent turn (tests hidden) -> grade.

  driver.py <mode,mode,...> [task ...]     modes: experimental hyperexperimental stock

Stops starting runs after CALL_BUDGET model calls or HOURS of wall clock since the first run
(state in budget.json).

Env (all optional): BENCH_UI (the ui folder of the worktree to run), BENCH_HIDDEN (tests, solutions,
finished runs: outside every sandbox-writable root), BENCH_MODEL (the model name every arm is given:
a tier, or a concrete id of the router's catalog such as chatgpt-web/luna, which the router serves
strictly), BENCH_SERVED_BY (the one catalog id that may serve: every ledger entry of a run is checked
against it and a run with any other is kept as invalid and awaits review; the call budget then counts
that model's ledger entries), BENCH_CALL_BUDGET, BENCH_HOURS, BENCH_REQUIRE_AC (1: start no run while the Mac is on battery). A run whose turn failed on the router with almost nothing spent is retried
after a pause (3 times), then once on pool/<tier>.
"""
import collections, json, os, shutil, signal, subprocess, sys, time, urllib.request

BENCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.environ.get("BENCH_UI") or "/Users/yufan/Desktop/Development/provenance-wt-bench/ui"
TASKS_PY = os.path.join(BENCH, "harness", "tasks.py")
RUNS = os.path.join(BENCH, "runs")  # only the run in progress; finished runs move to HIDDEN/runs
HIDDEN = os.environ.get("BENCH_HIDDEN") or "/Users/yufan/Desktop/Development/provenance-wt-bench/.bench-hidden"
os.environ["BENCH_HIDDEN"] = HIDDEN  # tasks.py reads the same one
LEDGER = os.path.expanduser("~/.tierlm/usage-ledger.jsonl")
TIER = os.environ.get("BENCH_MODEL") or "solstice"
SERVED_BY = os.environ.get("BENCH_SERVED_BY") or None
LIMIT_MIN = 25
CALL_BUDGET = int(os.environ.get("BENCH_CALL_BUDGET") or 1600)
HOURS = float(os.environ.get("BENCH_HOURS") or 8.0)
ROUTER = "http://127.0.0.1:4141"
ORDER = ["sqlite-db-truncate", "cancel-async-tasks", "modernize-scientific-stack", "db-wal-recovery",
         "model-extraction-relu-logits", "regex-log", "polyglot-c-py", "sparql-university",
         "constraints-scheduling", "large-scale-text-editing"]


def log(*a):
    line = time.strftime("%H:%M:%S ") + " ".join(str(x) for x in a)
    print(line, flush=True)
    open(os.path.join(BENCH, "driver.log"), "a").write(line + "\n")


def budget():
    p = os.path.join(BENCH, "budget.json")
    if os.path.exists(p):
        return json.load(open(p))
    return {"first_run_at": None, "calls": 0}


def save_budget(b):
    json.dump(b, open(os.path.join(BENCH, "budget.json"), "w"))


def tasks(*a, capture=True):
    r = subprocess.run(["python3", "-I", TASKS_PY, *a], capture_output=capture, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"tasks.py {a}: {r.stdout}{r.stderr}")
    return r.stdout


def tier_available():
    try:
        d = json.load(urllib.request.urlopen("http://127.0.0.1:4141/v1/sources", timeout=10))
        for t in d["tiers"]:
            if t["tier"] == TIER:
                return [(s["id"], s.get("remaining"), s.get("busy")) for s in t["sources"] if s.get("available")]
    except Exception as e:
        return None
    return []


def web_gate():
    """For a run that one web model must serve: ("ok" | "wait" | "signed-out" | "unknown", seconds, text).
    Reads GET /web/accounts: the accounts of the provider that has the model."""
    try:
        d = json.load(urllib.request.urlopen(ROUTER + "/web/accounts", timeout=15))
    except Exception as e:
        return "unknown", 60, f"router not answering: {e}"
    for p in d.get("providers", []):
        if any(m.get("id") == SERVED_BY for m in p.get("models", [])):
            accs = p.get("accounts", [])
            brief = ", ".join(f"{a['id']}:{'in' if a.get('signed_in') else 'OUT'}"
                              f"{' blocked ' + str(int(a.get('blocked_for_s') or 0)) + 's (' + str(a.get('reason')) + ')' if a.get('blocked') else ''}"
                              f" {a.get('today')}/{a.get('daily_cap')}" for a in accs)
            signed = [a for a in accs if a.get("signed_in")]
            if not signed:
                return "signed-out", 0, brief
            free = [a for a in signed if not a.get("blocked") and (a.get("today") or 0) < (a.get("daily_cap") or 1e9)]
            if free:
                return "ok", 0, brief
            waits = [a.get("blocked_for_s") or 0 for a in signed if a.get("blocked")]
            return "wait", (min(waits) if waits else 1800), brief
    return "unknown", 60, f"no web provider has {SERVED_BY}"


def on_ac():
    try:
        return "AC Power" in subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return True  # not a Mac, or pmset not answering: nothing to wait for


def ledger_rows(t0, t1):
    rows = []
    try:
        for l in open(LEDGER):
            try:
                d = json.loads(l)
            except Exception:
                continue
            if t0 <= d.get("ts", 0) <= t1:
                rows.append(d)
    except Exception:
        pass
    return rows


def ledger_keys_before(t0):
    keys = set()
    try:
        for l in open(LEDGER):
            try:
                d = json.loads(l)
            except Exception:
                continue
            if d.get("ts", 0) < t0:
                keys.add(d.get("key"))
    except Exception:
        pass
    return keys


def one(mode, task, model, attempt):
    name = f"{task}--{mode}" + (f"--try{attempt}" if attempt else "")
    run_dir = os.path.join(RUNS, name)
    if os.path.exists(run_dir):
        shutil.rmtree(run_dir)
    os.makedirs(run_dir)
    tasks("prepare", task, run_dir)
    job = tasks("job", task, run_dir)
    open(os.path.join(run_dir, "job.txt"), "w").write(job)
    cwd = tasks("cwd", task, run_dir).strip()
    venv = tasks("venv", task).strip()
    out = os.path.join(run_dir, "record")
    # zsh -lc puts the system folders first (path_helper), so a PATH prefix alone does not make
    # the task's python the agent's python3: a ZDOTDIR that sources the user's own files and
    # then puts the task's venv first does.
    zdot = os.path.join(run_dir, "zdot")
    os.makedirs(zdot)
    home = os.path.expanduser("~")
    for f in (".zshenv", ".zprofile", ".zshrc"):
        open(os.path.join(zdot, f), "w").write(
            f'[ -f "{home}/{f}" ] && source "{home}/{f}"\nexport PATH="{venv}:$PATH"\n')
    env = dict(os.environ, ZDOTDIR=zdot)
    # The tests and reference solutions are unreadable while the agent works.
    os.chmod(HIDDEN, 0)
    t0 = time.time()
    try:
        p = subprocess.Popen(["node", "scripts/orchestrator-bench.ts", mode, "--cwd", cwd, "--job-file",
                              os.path.join(run_dir, "job.txt"), "--out", out, "--model", model, "--limit-min",
                              str(LIMIT_MIN), "--path-prefix", venv], cwd=UI, env=env,
                             stdout=open(os.path.join(run_dir, "runner.log"), "w"), stderr=subprocess.STDOUT,
                             start_new_session=True)
        try:
            p.wait(timeout=LIMIT_MIN * 60 + 180)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGTERM)
            time.sleep(3)
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    finally:
        os.chmod(HIDDEN, 0o755)
    t1 = time.time()
    # Anything the run left behind (a worker's command, a server the agent started).
    subprocess.run(["pkill", "-f", run_dir], capture_output=True)
    rp = os.path.join(out, "result.json")
    res = json.load(open(rp)) if os.path.exists(rp) else {
        "mode": mode, "status": "runner-killed", "timedOut": True, "modelCalls": 0, "roles": {}, "error": "the runner did not finish", "guard": None}
    old = ledger_keys_before(t0)
    rows = ledger_rows(t0, t1 + 5)
    res["ledger_window_all"] = dict(collections.Counter(r.get("model") for r in rows))
    res["ledger_window_new_keys"] = dict(collections.Counter(r.get("model") for r in rows if r.get("key") not in old))
    res["ledger_new_key_calls"] = sum(1 for r in rows if r.get("key") not in old)
    res["wall_seconds"] = round((res.get("wallMs") or 0) / 1000, 1) or round(t1 - t0, 1)
    # By key, not by time: the runner lists the keys its requests have in the ledger (the stock thread,
    # each worker thread, each plain call's session), so other users of the router do not blur it.
    keys = set(res.get("ledgerKeys") or [])
    mine = [r for r in ledger_rows(t0 - 5, t1 + 30) if r.get("key") in keys]
    res["ledger_calls"] = sum(1 for r in mine if r.get("model"))
    res["ledger_served"] = dict(collections.Counter(r.get("model") or "(nothing)" for r in mine))
    res["ledger_ctx"] = dict(collections.Counter(f for r in mine for f in (r.get("ctx") or [])))
    res["ledger_pruned"] = sum(1 for r in mine if r.get("pruned"))
    res["ledger_pruned_saved"] = sum(int((r.get("pruned") or {}).get("before") or 0) - int((r.get("pruned") or {}).get("after") or 0) for r in mine)
    res["ledger_max_in"] = max([r.get("in") or 0 for r in mine] or [0])
    res["ledger_sum_in"] = sum(r.get("in") or 0 for r in mine)
    res["ledger_sum_out"] = sum(r.get("out") or 0 for r in mine)
    res["invalid"] = None
    if SERVED_BY:
        other = {m: n for m, n in res["ledger_served"].items() if m not in (SERVED_BY, "(nothing)")}
        hdr = {m: n for m, n in (res.get("servedBy") or {}).items() if m != SERVED_BY}
        if other or hdr:
            res["invalid"] = f"served elsewhere: ledger {other}, reply headers {hdr}"
        elif not keys and res.get("status") != "runner-killed":
            res["invalid"] = "the runner listed no ledger keys: who served is unverified"
    g = json.loads(tasks("grade", task, run_dir))
    rec = {"task": task, "mode": mode, "model": model, "attempt": attempt, "run_dir": run_dir, "passed": g["passed"],
           "grade_summary": g["summary"], **{k: res.get(k) for k in (
               "status", "timedOut", "error", "guard", "modelCalls", "roles", "workers", "workerCalls",
               "workerMaxInputTokens", "steps", "retries", "threadId", "maxInputTokens", "totalInputTokens", "servedBy", "approvalsDeclined",
               "ledger_window_all", "ledger_window_new_keys", "ledger_new_key_calls", "wall_seconds",
               "ledgerKeys", "ledger_calls", "ledger_served", "ledger_ctx", "ledger_pruned", "ledger_pruned_saved",
               "ledger_max_in", "ledger_sum_in", "ledger_sum_out", "invalid")}}
    # A timeout is a failure whatever the folder holds? No: the official harness grades what is there
    # after an agent timeout too; we do the same and flag it.
    b = budget()
    b["calls"] += (res["ledger_calls"] if SERVED_BY else
                   (res.get("modelCalls") or 0) or (res.get("ledger_new_key_calls") or 0))
    save_budget(b)
    # Finished: out of the agent's reach (its tests copy, grade log and transcript included).
    kept = os.path.join(HIDDEN, "runs", name)
    if os.path.exists(kept):
        shutil.rmtree(kept)
    shutil.move(run_dir, kept)
    rec["run_dir"] = kept
    au = subprocess.run(["python3", "-I", os.path.join(BENCH, "harness", "audit.py"), kept], capture_output=True, text=True).stdout.strip()
    rec["audit"] = au
    log("AUDIT " + au.replace("\n", " ;; ")[:400])
    log(f"{name}: {'PASS' if g['passed'] else 'FAIL'} status={res.get('status')} timedOut={res.get('timedOut')} "
        f"calls={res.get('modelCalls')} wall={rec['wall_seconds']}s guard={res.get('guard')} err={(res.get('error') or '')[:120]} | "
        f"ledger {res['ledger_served']} ctx={res['ledger_ctx']} pruned={res['ledger_pruned']} maxIn={res['ledger_max_in']} retries={res.get('retries')} | budget calls={b['calls']}")
    return rec


def records():
    rp = os.path.join(BENCH, "results.jsonl")
    return [json.loads(l) for l in open(rp)] if os.path.exists(rp) else []


def state(task, mode):
    """final | blocked (a failed attempt awaits review) | pending, and the next attempt number."""
    rs = [r for r in records() if r["task"] == task and r["mode"] == mode]
    if any(r.get("final") for r in rs):
        return "final", len(rs)
    runs = [r for r in rs if "release" not in r]
    released = sum(1 for r in rs if r.get("release"))
    review = sum(1 for r in runs if r.get("needs_review"))
    return ("blocked" if review > released else "pending"), len(runs)


def main():
    """Arm by arm (stock, then experimental, then hyperexperimental), the fixed task order inside
    each. A run that passed, or failed with the turn completed or at the time limit, is final. A
    run whose turn failed or whose runner died is kept as needs_review and the driver moves on:
    it is run again only after mark.py releases it (or mark.py makes it final as it stands)."""
    modes = sys.argv[1].split(",")
    todo = sys.argv[2:] or ORDER
    rp = os.path.join(BENCH, "results.jsonl")
    while True:
        ran = blocked = 0
        for mode in modes:
            for task in todo:
                st, attempt = state(task, mode)
                if st == "final":
                    continue
                if st == "blocked":
                    blocked += 1
                    continue
                if os.path.exists(os.path.join(BENCH, "STOP")):
                    log("STOP file: not starting more runs")
                    return
                b = budget()
                if b["first_run_at"] is None:
                    b["first_run_at"] = time.time()
                    save_budget(b)
                for _ in range(10):  # the wall clock jumped a day ahead once and came back: wait it out
                    if time.time() - b["first_run_at"] < 12 * 3600:
                        break
                    time.sleep(30)
                if b["calls"] >= CALL_BUDGET or time.time() - b["first_run_at"] > HOURS * 3600:
                    log(f"budget reached (calls={b['calls']}, hours={(time.time() - b['first_run_at']) / 3600:.2f}): not starting {task} {mode}")
                    return
                # BENCH_REQUIRE_AC=1: no run starts on battery (a laptop on battery sleeps under the
                # run: every call then times out). Waits, a minute at a time, for AC power.
                while os.environ.get("BENCH_REQUIRE_AC") and not on_ac():
                    if os.path.exists(os.path.join(BENCH, "STOP")):
                        log("STOP file: not starting more runs")
                        return
                    log(f"WAIT 60s before {task} {mode}: on battery")
                    time.sleep(60)
                # One web model must serve: wait while its accounts are blocked (at most 30 minutes a
                # wait), stop when every account is signed out. Never another model.
                waited = 0
                while SERVED_BY:
                    st, secs, brief = web_gate()
                    if st == "ok":
                        break
                    if st == "signed-out":
                        log(f"every account of {SERVED_BY} is signed out ({brief}): stopping")
                        return
                    if time.time() - b["first_run_at"] > HOURS * 3600:
                        log(f"budget of hours reached while waiting ({brief})")
                        return
                    nap = max(60, min(int(secs) + 10, 1800))
                    log(f"WAIT {nap}s before {task} {mode}: {st} ({brief})")
                    time.sleep(nap)
                    waited += nap
                for w in range(0 if SERVED_BY else 4):
                    av = tier_available()
                    if av is None or any((r or 0) >= 0.08 for _, r, _ in av):
                        break
                    log(f"solstice nearly used up ({av}): waiting 5 minutes")
                    time.sleep(300)
                log(f"start {task} {mode} model={TIER} attempt={attempt} (tier sources available: {tier_available()})")
                rec = one(mode, task, TIER, attempt)
                ran += 1
                ok_end = rec["passed"] or rec.get("status") == "completed" or (rec.get("timedOut") and rec.get("status") != "runner-killed")
                rec = dict(rec)
                rec["waited_before_s"] = waited
                if rec.get("invalid"):
                    ok_end = False
                    log(f"INVALID {task} {mode}: {rec['invalid']}")
                if ok_end:
                    rec["final"] = True
                else:
                    rec["needs_review"] = True
                    log(f"NEEDS REVIEW {task} {mode}: status={rec.get('status')} err={(rec.get('error') or '')[:300]}")
                open(rp, "a").write(json.dumps(rec) + "\n")
        if not ran:
            if not blocked:
                log("all requested runs done")
                return
            if os.path.exists(os.path.join(BENCH, "STOP")):
                log("STOP file: leaving with runs awaiting review")
                return
            time.sleep(60)


if __name__ == "__main__":
    main()
