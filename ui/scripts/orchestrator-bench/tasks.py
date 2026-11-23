#!/usr/bin/env python3
"""Local (Docker-free) preparation and grading of Terminal-Bench 2.x legacy tasks.

  tasks.py prepare <task> <run_dir>     build <run_dir>/app from the task's Dockerfile steps (hand-translated)
  tasks.py job <task> <run_dir>         print the instruction with /app rewritten to <run_dir>/app
  tasks.py cwd <task> <run_dir>         print the folder the agent starts in (the Dockerfile's last WORKDIR)
  tasks.py venv <task>                  print the bin dir standing in for the image's python
  tasks.py oracle <task> <run_dir>      run the task's reference solution (validation only)
  tasks.py grade <task> <run_dir>       copy the tests in, run the official pytest file, write grade.json

Every command that runs dataset code (setup scripts, solutions, tests) runs under sandbox-exec:
no writes outside <run_dir> and temp folders, no reads of the home folder except the toolchains.
"""
import json, os, re, shutil, subprocess, sys, time, gzip

BENCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Tests, reference solutions and finished runs live OUTSIDE the folders a workspace-write sandbox
# can write (so the agent cannot chmod its way in) and are mode 000 while an agent works.
HIDDEN = os.environ.get("BENCH_HIDDEN") or "/Users/yufan/Desktop/Development/provenance-wt-bench/.bench-hidden"
DATA = os.path.join(HIDDEN, "dataset", "tb", "legacy")
VENVS = os.path.join(BENCH, "venvs")
# The grader's interpreter (pytest and what the tests import): in the hidden folder when there is one
# there (out of the agent's reach), else next to the task venvs.
GRADER = next(p for p in (os.path.join(HIDDEN, "venvs", "grader"), os.path.join(VENVS, "grader"))
              if os.path.exists(p) or p.startswith(VENVS))
HOME = os.path.expanduser("~")

TASKS = {
    "fix-git": dict(venv="base", cwd="personal-site"),
    "gcode-to-text": dict(venv="base"),
    "sqlite-db-truncate": dict(venv="base"),
    "modernize-scientific-stack": dict(venv="sci"),
    "db-wal-recovery": dict(venv="base"),
    "regex-log": dict(venv="base"),
    "log-summary-date-ranges": dict(venv="base"),
    "openssl-selfsigned-cert": dict(venv="base"),
    "largest-eigenval": dict(venv="np230"),
    "cancel-async-tasks": dict(venv="base", pre_test=[("test.py", "test.py")]),
    "write-compressor": dict(venv="base"),
    "model-extraction-relu-logits": dict(venv="np"),
    "polyglot-rust-c": dict(venv="base"),
    "polyglot-c-py": dict(venv="base"),
    "constraints-scheduling": dict(venv="base"),
    "large-scale-text-editing": dict(venv="base"),
    "git-leak-recovery": dict(venv="base"),
    "sparql-university": dict(venv="base"),
}


def rewrite(text, app, tests=None):
    text = re.sub(r"/app(?![A-Za-z0-9_\-])", app, text)
    if tests:
        text = re.sub(r"/tests(?![A-Za-z0-9_\-])", tests, text)
    return text


def profile(run_dir):
    p = os.path.join(run_dir, "sandbox.sb")
    with open(p, "w") as f:
        f.write(f"""(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "{run_dir}") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/dev"))
(deny file-read* (subpath "{HOME}"))
(allow file-read* (subpath "{HOME}/.pyenv") (subpath "{HOME}/.cargo") (subpath "{HOME}/.rustup") (subpath "{os.path.join(HIDDEN, "venvs")}"))
(allow file-read-metadata (subpath "/Users"))
(deny file-write* (subpath "{BENCH}/dataset") (subpath "{BENCH}/harness") (subpath "{BENCH}/venvs"))
""")
    return p


def env_for(task, run_dir):
    fake = os.path.join(run_dir, "fakehome")
    os.makedirs(fake, exist_ok=True)
    e = dict(os.environ)
    e["HOME"] = fake
    e["PATH"] = os.path.join(VENVS, TASKS[task]["venv"], "bin") + ":" + e["PATH"]
    e.pop("PYTHONPATH", None)
    e["GIT_CONFIG_NOSYSTEM"] = "1"
    return e


def boxed(task, run_dir, argv, cwd, timeout, log):
    with open(log, "w") as f:
        try:
            r = subprocess.run(["sandbox-exec", "-f", profile(run_dir)] + argv, cwd=cwd, env=env_for(task, run_dir),
                               stdout=f, stderr=subprocess.STDOUT, timeout=timeout)
            return r.returncode
        except subprocess.TimeoutExpired:
            f.write("\n[harness] timed out\n")
            return 124


def app_dir(run_dir):
    return os.path.join(run_dir, "app")


def work_cwd(task, run_dir):
    return os.path.join(app_dir(run_dir), TASKS[task]["cwd"]) if TASKS[task].get("cwd") else app_dir(run_dir)


def prepare(task, run_dir):
    app = app_dir(run_dir)
    os.makedirs(app)
    env = os.path.join(DATA, task, "environment")
    cp = lambda src, dst=None: shutil.copy(os.path.join(env, src), os.path.join(app, dst or os.path.basename(src)))
    if task == "fix-git":
        shutil.copytree(os.path.join(env, "resources"), os.path.join(app, "resources"))
        with open(os.path.join(app, "setup.sh"), "w") as f:
            f.write(rewrite(open(os.path.join(env, "setup.sh")).read(), app))
        rc = boxed(task, run_dir, ["bash", os.path.join(app, "setup.sh")], app, 300, os.path.join(run_dir, "prepare.log"))
        if rc != 0:
            sys.exit(f"setup.sh failed ({rc})")
        shutil.rmtree(os.path.join(app, "resources"))
        os.remove(os.path.join(app, "setup.sh"))
    elif task == "gcode-to-text":
        with gzip.open(os.path.join(env, "text.gcode.gz")) as g, open(os.path.join(app, "text.gcode"), "wb") as f:
            shutil.copyfileobj(g, f)
    elif task == "sqlite-db-truncate":
        cp("trunc.db")
    elif task == "modernize-scientific-stack":
        shutil.copytree(os.path.join(env, "climate_analyzer"), os.path.join(app, "climate_analyzer"))
    elif task == "db-wal-recovery":
        cp("main.db")
        cp("main.db-wal.encrypted", "main.db-wal")
    elif task in ("regex-log", "cancel-async-tasks", "openssl-selfsigned-cert", "polyglot-rust-c", "polyglot-c-py"):
        pass
    elif task == "log-summary-date-ranges":
        gen = os.path.join(app, "log_generator_deterministic.py")
        with open(gen, "w") as f:
            f.write(rewrite(open(os.path.join(env, "log_generator_deterministic.py")).read(), app))
        rc = boxed(task, run_dir, ["python3", gen], app, 300, os.path.join(run_dir, "prepare.log"))
        if rc != 0:
            sys.exit(f"generator failed ({rc})")
        os.remove(gen)
    elif task == "largest-eigenval":
        cp("src/eigen.py")
        cp("src/eval.py")
    elif task == "write-compressor":
        cp("decomp.c")
        rc = boxed(task, run_dir, ["gcc", "-O3", "decomp.c", "-o", os.path.join(app, "decomp")], app, 120,
                   os.path.join(run_dir, "prepare.log"))
        if rc != 0:
            sys.exit(f"gcc failed ({rc})")
        cp("data.txt")
    elif task == "constraints-scheduling":
        for n in os.listdir(os.path.join(env, "inputs")):
            cp("inputs/" + n)
    elif task in ("large-scale-text-editing", "git-leak-recovery"):
        name, args = ("gen_large_csv.py", ["both"]) if task == "large-scale-text-editing" else ("challenge-setup.sh", [])
        sc = os.path.join(app, name)
        with open(sc, "w") as f:
            f.write(rewrite(open(os.path.join(env, name)).read(), app))
        rc = boxed(task, run_dir, (["python3"] if name.endswith(".py") else ["bash"]) + [sc] + args, app, 300,
                   os.path.join(run_dir, "prepare.log"))
        if rc != 0:
            sys.exit(f"{name} failed ({rc})")
        os.remove(sc)
    elif task == "sparql-university":
        cp("university_graph.ttl")
    elif task == "model-extraction-relu-logits":
        cp("forward.py")
    else:
        sys.exit(f"no recipe for {task}")
    os.makedirs(work_cwd(task, run_dir), exist_ok=True)


def job(task, run_dir):
    return rewrite(open(os.path.join(DATA, task, "instruction.md")).read(), app_dir(run_dir))


def oracle(task, run_dir):
    s = os.path.join(run_dir, "oracle-solve.sh")
    with open(s, "w") as f:
        f.write(rewrite(open(os.path.join(DATA, task, "solution", "solve.sh")).read(), app_dir(run_dir)))
    return boxed(task, run_dir, ["bash", s], work_cwd(task, run_dir), 1500, os.path.join(run_dir, "oracle.log"))


def grade(task, run_dir):
    app = app_dir(run_dir)
    tests = os.path.join(run_dir, "tests")
    if os.path.exists(tests):
        shutil.rmtree(tests)
    shutil.copytree(os.path.join(DATA, task, "tests"), tests)
    for name in os.listdir(tests):
        if name.endswith((".py", ".sh")):
            p = os.path.join(tests, name)
            open(p, "w").write(rewrite(open(os.path.join(DATA, task, "tests", name)).read(), app, tests))
    for src, dst in TASKS[task].get("pre_test", []):
        shutil.copy(os.path.join(tests, src), os.path.join(app, dst))
    t0 = time.time()
    rc = boxed(task, run_dir,
               [os.path.join(GRADER, "bin", "python"), "-m", "pytest", os.path.join(tests, "test_outputs.py"),
                "-rA", "-p", "no:cacheprovider"],
               work_cwd(task, run_dir), 900, os.path.join(run_dir, "grade.log"))
    res = dict(task=task, passed=rc == 0, pytest_exit=rc, grade_seconds=round(time.time() - t0, 1))
    tail = open(os.path.join(run_dir, "grade.log"), errors="replace").read().strip().splitlines()[-1:]
    res["summary"] = tail[0] if tail else ""
    json.dump(res, open(os.path.join(run_dir, "grade.json"), "w"), indent=1)
    return res


if __name__ == "__main__":
    cmd, task = sys.argv[1], sys.argv[2]
    run_dir = os.path.abspath(sys.argv[3]) if len(sys.argv) > 3 else None
    if cmd == "prepare":
        os.makedirs(run_dir, exist_ok=True)
        prepare(task, run_dir)
    elif cmd == "job":
        sys.stdout.write(job(task, run_dir))
    elif cmd == "cwd":
        print(work_cwd(task, run_dir))
    elif cmd == "venv":
        print(os.path.join(VENVS, TASKS[task]["venv"], "bin"))
    elif cmd == "oracle":
        print("oracle exit", oracle(task, run_dir))
    elif cmd == "grade":
        print(json.dumps(grade(task, run_dir)))
