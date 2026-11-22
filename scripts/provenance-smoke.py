#!/usr/bin/env python3
"""Smoke-test a built `provenance` binary through `provenance app-server` (JSON lines on stdio).

  scripts/provenance-smoke.py BIN                     # initialize + model/list, print the tiers
  scripts/provenance-smoke.py BIN --turn spark        # ... plus one real turn on that model
  scripts/provenance-smoke.py BIN --turn pool/spark   # a pinned <source>/<tier> name

Runs with a throwaway PROVENANCE_HOME (so ~/.provenance is never touched) unless --home is
given. A turn spends real router quota: keep them few. Exit status 0 = pass.
Used by scripts/sync-upstream.sh; see docs/UPSTREAM.md.
"""

import argparse
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time


class AppServer:
    def __init__(self, binary, home):
        env = dict(os.environ, PROVENANCE_HOME=home)
        env.pop("CODEX_HOME", None)
        self.proc = subprocess.Popen(
            [binary, "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            bufsize=1,
        )
        self.inbox = queue.Queue()
        self.stderr = []
        self.next_id = 1
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            line = line.strip()
            if line:
                try:
                    self.inbox.put(json.loads(line))
                except json.JSONDecodeError:
                    self.stderr.append("non-JSON stdout: " + line[:200])
        self.inbox.put(None)

    def _read_err(self):
        for line in self.proc.stderr:
            self.stderr.append(line.rstrip())

    def send(self, msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def wait(self, pred, timeout):
        deadline = time.time() + timeout
        while True:
            left = deadline - time.time()
            if left <= 0:
                raise TimeoutError("timed out waiting for app-server")
            msg = self.inbox.get(timeout=left)
            if msg is None:
                raise RuntimeError("app-server exited:\n" + "\n".join(self.stderr[-20:]))
            if pred(msg):
                return msg
            self.on_other(msg)

    def on_other(self, msg):
        pass

    def request(self, method, params, timeout=60):
        rid = self.next_id
        self.next_id += 1
        self.send({"id": rid, "method": method, "params": params})
        msg = self.wait(lambda m: m.get("id") == rid and "method" not in m, timeout)
        if "error" in msg:
            raise RuntimeError(f"{method}: {json.dumps(msg['error'])}")
        return msg["result"]

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("binary")
    ap.add_argument("--turn", metavar="MODEL", help="run one turn on MODEL (spends quota)")
    ap.add_argument("--prompt", default="reply with just ok")
    ap.add_argument("--home", help="PROVENANCE_HOME to use (default: a temp dir)")
    ap.add_argument("--expect-tiers", help="comma-separated tier slugs model/list must start with")
    args = ap.parse_args()

    home = args.home or tempfile.mkdtemp(prefix="provenance-smoke-")
    server = AppServer(args.binary, home)
    ok = True
    try:
        init = server.request(
            "initialize",
            {
                "clientInfo": {"name": "provenance_smoke", "title": None, "version": "0"},
                "capabilities": {"experimentalApi": True},
            },
        )
        server.send({"method": "initialized"})
        print(f"[smoke] initialize ok: {init.get('userAgent', '?')}")

        models = server.request("model/list", {})
        listed = [(m.get("model") or m.get("id"), m.get("displayName"), m.get("isDefault")) for m in models.get("data", [])]
        for slug, name, default in listed:
            print(f"[smoke] model/list: {slug:10} {name or '':10} {'(default)' if default else ''}")
        if args.expect_tiers:
            want = args.expect_tiers.split(",")
            got = [slug for slug, _, _ in listed][: len(want)]
            if got != want:
                print(f"[smoke] FAIL: model/list starts with {got}, expected {want}")
                ok = False

        if args.turn:
            started = server.request(
                "thread/start",
                {"model": args.turn, "cwd": home, "approvalPolicy": "never", "sandbox": "read-only"},
            )
            thread_id = started["thread"]["id"]
            print(f"[smoke] thread/start: model={started.get('model')} provider={started.get('modelProvider')}")
            if started.get("model") != args.turn:
                print(f"[smoke] FAIL: thread model {started.get('model')!r} != {args.turn!r}")
                ok = False
            streamed = []
            errors = []

            def on_other(msg):
                params = msg.get("params") or {}
                if msg.get("method") == "item/agentMessage/delta" and params.get("threadId") == thread_id:
                    streamed.append(params.get("delta", ""))
                if msg.get("method") == "error":
                    errors.append(json.dumps(params)[:300])

            server.on_other = on_other
            server.request(
                "turn/start",
                {
                    "threadId": thread_id,
                    "model": args.turn,
                    "input": [{"type": "text", "text": args.prompt, "text_elements": []}],
                },
            )
            done = server.wait(
                lambda m: m.get("method") == "turn/completed" and m["params"].get("threadId") == thread_id,
                240,
            )
            turn = done["params"]["turn"]
            reply = "".join(streamed).strip()
            print(f"[smoke] turn/completed: status={turn.get('status')} reply={reply!r}")
            for err in errors:
                print(f"[smoke]   error notification: {err}")
            if turn.get("status") != "completed" or not reply:
                print(f"[smoke] FAIL: turn error: {json.dumps(turn.get('error'))[:300]}")
                ok = False
    except Exception as err:  # noqa: BLE001
        print(f"[smoke] FAIL: {err}")
        ok = False
    finally:
        server.close()
    if not ok and server.stderr:
        print("[smoke] app-server stderr (last lines):")
        for line in server.stderr[-15:]:
            print("    " + line)
    print("[smoke] PASS" if ok else "[smoke] FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
