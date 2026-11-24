#!/usr/bin/env python3
"""Check what a built `provenance` binary tells a model about its own name.

  scripts/provenance-name-check.py BIN                    # every tier in harness.toml
  scripts/provenance-name-check.py BIN --model pool/spark --model some-unknown-model
  scripts/provenance-name-check.py BIN --dump DIR         # also write each captured request

For each tier it starts a thread through `provenance app-server`, runs one turn against a
stand-in Responses endpoint on 127.0.0.1 (no router, no quota, no network), and reads the
request the binary sent: base instructions, tool descriptions, the skills list, everything.
It fails when "Codex" still stands for the agent anywhere in it. The word and the phrases
in which it names OpenAI's product instead come from `[branding.agent_text]` in
codex-rs/provenance/harness.toml, the same rules the binary applies.

It then runs one more turn with a provider named "OpenAI" (what `model_provider = "openai"`
uses, the app's "Run Codex through Provenance") and fails unless that request still says
"Codex": on that path the harness stays stock.

Runs with throwaway PROVENANCE_HOMEs. Exit status 0 = pass. See docs/UPSTREAM.md.
"""

import argparse
import http.server
import json
import os
import pathlib
import sys
import tempfile
import threading
import tomllib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
smoke = __import__("provenance-smoke")

ROOT = pathlib.Path(__file__).resolve().parent.parent
HARNESS = ROOT / "codex-rs" / "provenance" / "harness.toml"

REPLY = "ok"


def sse(event):
    return f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode()


class Responses(http.server.BaseHTTPRequestHandler):
    """POST .../responses: record the body, answer with one short assistant message."""

    captured = []
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({"data": [], "models": []}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.headers.get("Content-Encoding", "").lower() == "zstd":
            self.captured.append({"path": self.path, "error": "zstd body: cannot read"})
        else:
            try:
                self.captured.append({"path": self.path, "body": json.loads(raw)})
            except ValueError:
                self.captured.append({"path": self.path, "error": "not JSON"})
        n = len(self.captured)
        message = {
            "type": "message",
            "id": f"msg_{n}",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": REPLY, "annotations": []}],
        }
        usage = {
            "input_tokens": 1,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens": 1,
            "output_tokens_details": {"reasoning_tokens": 0},
            "total_tokens": 2,
        }
        out = b"".join(
            [
                sse({"type": "response.created", "response": {"id": f"resp_{n}"}}),
                sse({"type": "response.output_item.added", "output_index": 0, "item": {**message, "content": []}}),
                sse({"type": "response.output_text.delta", "output_index": 0, "item_id": f"msg_{n}", "content_index": 0, "delta": REPLY}),
                sse({"type": "response.output_item.done", "output_index": 0, "item": message}),
                sse({"type": "response.completed", "response": {"id": f"resp_{n}", "usage": usage}}),
            ]
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(out)
        self.close_connection = True


def agent_names(text, rules):
    """Offsets where rules['from'] stands for the agent (codex_provenance::agent_names)."""
    word, keep = rules["from"], rules.get("keep", [])
    found, at = [], text.find(word)
    while at != -1:
        end = at + len(word)
        before, after = text[at - 1 : at], text[end : end + 1]
        part_of_word = (before and (before.isalnum() or before in "_-")) or (after and (after.isalnum() or after == "_"))
        kept = any(
            text.startswith(phrase, at - off)
            for phrase in keep
            for off in range(len(phrase))
            if phrase.startswith(word, off) and at >= off
        )
        if not part_of_word and not kept:
            found.append(at)
        at = text.find(word, end)
    return found


def strings(value, path=""):
    """Every string in a JSON value, with where it is."""
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, list):
        for i, item in enumerate(value):
            label = item.get("name") or item.get("role") or item.get("type") if isinstance(item, dict) else None
            yield from strings(item, f"{path}[{i}{':' + str(label) if label else ''}]")
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from strings(item, f"{path}.{key}" if path else key)


def conversation_text(path, text, prompt):
    """Text that is the person's, not the harness's: the prompt this check sent."""
    return text == prompt


def run_turn(binary, home, env, model, prompt):
    """One thread, one turn; returns the requests the stand-in endpoint received."""
    before = len(Responses.captured)
    saved = dict(os.environ)
    os.environ.update(env)
    try:
        server = smoke.AppServer(binary, home)
    finally:
        os.environ.clear()
        os.environ.update(saved)
    try:
        server.request(
            "initialize",
            {
                "clientInfo": {"name": "provenance_name_check", "title": None, "version": "0"},
                "capabilities": {"experimentalApi": True},
            },
        )
        server.send({"method": "initialized"})
        params = {"cwd": home, "approvalPolicy": "never", "sandbox": "read-only"}
        if model:
            params["model"] = model
        started = server.request("thread/start", params)
        thread_id = started["thread"]["id"]
        turn = {"threadId": thread_id, "input": [{"type": "text", "text": prompt, "text_elements": []}]}
        if model:
            turn["model"] = model
        server.request("turn/start", turn)
        done = server.wait(
            lambda m: m.get("method") == "turn/completed" and m["params"].get("threadId") == thread_id,
            120,
        )
        status = done["params"]["turn"].get("status")
        if status != "completed":
            raise RuntimeError(f"turn {status}: {json.dumps(done['params']['turn'].get('error'))[:300]}")
        return started, Responses.captured[before:]
    except Exception:
        for line in server.stderr[-12:]:
            print("    " + line)
        raise
    finally:
        server.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("binary")
    ap.add_argument("--model", action="append", default=[], help="also check this model name (repeatable)")
    ap.add_argument("--dump", help="directory to write each captured request body to")
    ap.add_argument("--no-stock", action="store_true", help="skip the OpenAI-provider turn")
    args = ap.parse_args()

    harness = tomllib.loads(HARNESS.read_text())
    rules = harness["branding"]["agent_text"]
    name = harness["branding"]["product_name"]
    provider = harness["provider"]
    models = [tier["slug"] for tier in harness["tiers"]] + args.model
    prompt = "reply with just ok"

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Responses)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}/v1"
    dump = pathlib.Path(args.dump) if args.dump else None
    if dump:
        dump.mkdir(parents=True, exist_ok=True)

    ok = True
    for model in models:
        home = tempfile.mkdtemp(prefix="provenance-name-")
        try:
            started, requests = run_turn(args.binary, home, {provider["base_url_env"]: base}, model, prompt)
        except Exception as err:  # noqa: BLE001
            print(f"[name] {model}: FAIL: {err}")
            ok = False
            continue
        bodies = [r["body"] for r in requests if "body" in r]
        if not bodies or len(bodies) != len(requests):
            print(f"[name] {model}: FAIL: no readable request reached the endpoint ({requests})")
            ok = False
            continue
        hits, named, chars = [], 0, 0
        for n, body in enumerate(bodies):
            if dump:
                (dump / f"{model.replace('/', '_')}-{n}.json").write_text(json.dumps(body, indent=1))
            for path, text in strings(body):
                chars += len(text)
                named += text.count(name)
                if conversation_text(path, text, prompt):
                    continue
                for at in agent_names(text, rules):
                    hits.append((path, text[max(0, at - 70) : at + 70].replace("\n", " ")))
        tools = bodies[0].get("tools") or []
        print(
            f"[name] {model}: provider={started.get('modelProvider')} requests={len(bodies)} "
            f"tools={len(tools)} chars={chars} {name!r} x{named}, {rules['from']!r} as the agent x{len(hits)}"
        )
        for path, context in hits:
            print(f"[name]   {path}: ...{context}...")
        if hits or not named:
            ok = False

    if not args.no_stock:
        home = tempfile.mkdtemp(prefix="provenance-name-stock-")
        pathlib.Path(home, "config.toml").write_text(
            'model_provider = "stock"\nmodel = "stock-model"\n\n'
            f'[model_providers.stock]\nname = "OpenAI"\nbase_url = "{base}"\nwire_api = "responses"\n'
            "requires_openai_auth = false\nsupports_websockets = false\n"
        )
        try:
            started, requests = run_turn(args.binary, home, {}, None, prompt)
            text = json.dumps([r.get("body") for r in requests])
            stock = len(agent_names(text, rules))
            print(
                f"[name] stock (provider named OpenAI): provider={started.get('modelProvider')} "
                f"requests={len(requests)} {rules['from']!r} as the agent x{stock}, {name!r} x{text.count(name)}"
            )
            if dump:
                (dump / "stock-0.json").write_text(json.dumps(requests, indent=1))
            if not stock or name in text:
                print("[name]   FAIL: the OpenAI-provider request was renamed; it must stay as upstream writes it")
                ok = False
        except Exception as err:  # noqa: BLE001
            print(f"[name] stock: FAIL: {err}")
            ok = False

    httpd.shutdown()
    print("[name] PASS" if ok else "[name] FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
