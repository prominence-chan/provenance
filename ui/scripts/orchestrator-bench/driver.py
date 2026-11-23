#!/usr/bin/env python3
"""Runs the fixed subset, one run at a time: prepare -> agent turn (tests hidden) -> grade.

  driver.py <mode,mode,...> [task ...]     modes: experimental hyperexperimental stock

Stops starting runs after CALL_BUDGET model calls or HOURS of wall clock since the first run
(state in budget.json). A run whose turn failed on the router with almost nothing spent is retried
after a pause (3 times), then once on pool/<tier>.
"""
import collections, json, os, shutil, signal, subprocess, sys, time, urllib.request

BENCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = "/Users/yufan/Desktop/Development/provenance-wt-bench/ui"
TASKS_PY = os.path.join(BENCH, "harness", "tasks.py")
RUNS = os.path.join(BENCH, "runs")
LEDGER = os.path.expanduser("~/.tierlm/usage-ledger.jsonl")
TIER = "solstice"
LIMIT_MIN = 25
CALL_BUDGET = 900
HOURS = 5.0
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
    os.chmod(os.path.join(BENCH, "dataset"), 0)
    os.chmod(os.path.join(BENCH, "validate"), 0)
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
        os.chmod(os.path.join(BENCH, "dataset"), 0o755)
        os.chmod(os.path.join(BENCH, "validate"), 0o755)
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
    g = json.loads(tasks("grade", task, run_dir))
    rec = {"task": task, "mode": mode, "model": model, "attempt": attempt, "run_dir": run_dir, "passed": g["passed"],
           "grade_summary": g["summary"], **{k: res.get(k) for k in (
               "status", "timedOut", "error", "guard", "modelCalls", "roles", "workers", "workerCalls",
               "workerMaxInputTokens", "steps", "maxInputTokens", "totalInputTokens", "servedBy", "approvalsDeclined",
               "ledger_window_all", "ledger_window_new_keys", "ledger_new_key_calls", "wall_seconds")}}
    # A timeout is a failure whatever the folder holds? No: the official harness grades what is there
    # after an agent timeout too; we do the same and flag it.
    open(os.path.join(BENCH, "results.jsonl"), "a").write(json.dumps(rec) + "\n")
    b = budget()
    b["calls"] += (res.get("modelCalls") or 0) or (res.get("ledger_new_key_calls") or 0)
    save_budget(b)
    log(f"{name}: {'PASS' if g['passed'] else 'FAIL'} status={res.get('status')} timedOut={res.get('timedOut')} "
        f"calls={res.get('modelCalls')} wall={rec['wall_seconds']}s guard={res.get('guard')} err={(res.get('error') or '')[:120]} | budget calls={b['calls']}")
    return rec


def main():
    modes = sys.argv[1].split(",")
    todo = sys.argv[2:] or ORDER
    done = set()
    rp = os.path.join(BENCH, "results.jsonl")
    if os.path.exists(rp):
        for l in open(rp):
            d = json.loads(l)
            if d.get("final"):
                done.add((d["task"], d["mode"]))
    for task in todo:
        for mode in modes:
            if (task, mode) in done:
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
            model, attempt = TIER, 0
            ov = os.path.join(BENCH, "overrides.json")
            if os.path.exists(ov):
                model = json.load(open(ov)).get(f"{task}|{mode}", TIER)
            # The allowance is shared: when the tier is nearly used up, wait for it to recover
            # instead of draining it (4 waits of 5 minutes, then a lower tier for this run).
            for w in range(5):
                av = tier_available()
                if av is None or any((r or 0) >= 0.08 for _, r, _ in av):
                    break
                if w == 4:
                    model = "ember"
                    log("solstice still nearly used up: this run goes to the tier ember")
                    break
                log(f"solstice nearly used up ({av}): waiting 5 minutes")
                time.sleep(300)
            while True:
                av = tier_available()
                log(f"start {task} {mode} model={model} attempt={attempt} (tier sources available: {av})")
                rec = one(mode, task, model, attempt)
                err = (rec.get("error") or "")
                stalled = (not rec["passed"]) and rec.get("status") == "failed" and any(
                    x in err for x in ("503", "502", "429", "No free model", "empty reply", "isn't answering", "model call failed"))
                if not stalled:
                    break
                attempt += 1
                empty = "empty reply" in err  # the pool's first model answers this prompt with nothing: waiting long does not help
                if attempt <= (1 if empty else 2):
                    log(f"router could not serve: waiting {1 if empty else 4} minute(s)")
                    time.sleep(60 if empty else 240)
                elif attempt == (2 if empty else 3):
                    # an empty reply comes from the pool's first model for this prompt, so pool/<tier>
                    # would meet it again: go one tier down instead
                    model = "ember" if "empty reply" in err else f"pool/{TIER}"
                    log(f"falling back to {model}")
                else:
                    break
            rec["final"] = True
            open(rp, "a").write(json.dumps(rec) + "\n")
    log("all requested runs done")


if __name__ == "__main__":
    main()
