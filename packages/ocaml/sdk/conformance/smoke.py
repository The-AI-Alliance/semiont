"""Exercise the JSON-lines driver and its subscription against a loopback peer."""

import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading


requests = queue.Queue()
frames = queue.Queue()
retry = True


class Peer(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        requests.put((self.path, {}, self.headers["Authorization"]))
        self.send_response(200)
        if self.path == "/api/health":
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()
            self.wfile.write(bytes(range(256)))

    def do_POST(self):
        global retry
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.put((self.path, body, self.headers["Authorization"], self.headers["Idempotency-Key"]))
        if self.path == "/bus/subscribe":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            while (frame := frames.get(timeout=10)) is not None:
                self.wfile.write(frame)
                self.wfile.flush()
        else:
            if "correlationId" not in body and retry:
                retry = False
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b'{"error":"temporarily unavailable"}')
                return
            self.send_response(202)
            self.end_headers()
            self.wfile.write(b'{"subscribers":1}')
            if "correlationId" in body:
                reply = {
                    "channel": "mark:archive-ok",
                    "correlationId": body["correlationId"],
                    "payload": {},
                }
                frames.put(
                    ("event: bus-event\nid: reply-1\ndata: " + json.dumps(reply) + "\n\n").encode()
                )


def main():
    with ThreadingHTTPServer(("127.0.0.1", 0), Peer) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with subprocess.Popen(
            [str(Path(sys.argv[1]).resolve())],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        ) as driver:
            lines = queue.Queue()

            def receive():
                for line in driver.stdout:
                    lines.put(json.loads(line))

            threading.Thread(target=receive, daemon=True).start()

            def expect(predicate):
                while True:
                    line = lines.get(timeout=10)
                    if predicate(line):
                        return line

            def send(id, op, **args):
                driver.stdin.write(json.dumps({"id": id, "op": op, **args}) + "\n")
                driver.stdin.flush()

            try:
                assert expect(lambda line: line.get("ready")) == {"ready": True}
                send(
                    1,
                    "open",
                    baseUrl=f"http://127.0.0.1:{server.server_port}",
                    token="token",
                    channels=["mark:archive-ok", "mark:archive-failed"],
                    timing={"emitRetry": {"attempts": 2, "initialDelayMs": 1, "maxDelayMs": 1}},
                )
                path, opened, bearer, _ = requests.get(timeout=10)
                assert path == "/bus/subscribe" and bearer == "Bearer token"
                assert opened["pendingReplies"] == []
                expect(lambda line: line.get("state") == "open")
                send(2, "request", operation="mark:archive", payload={"resourceId": "res-1"})
                path, emitted, bearer, request_key = requests.get(timeout=10)
                assert path == "/bus/emit" and bearer == "Bearer token"
                assert emitted["clientId"] == opened["clientId"]
                assert emitted["correlationId"]
                assert expect(lambda line: line.get("id") == 2) == {"id": 2, "ok": {}}
                send(3, "emit", channel="beckon:focus", payload={"resourceId": "res-1"})
                first = requests.get(timeout=10)
                second = requests.get(timeout=10)
                assert first == second and first[3] and first[3] != request_key
                assert expect(lambda line: line.get("id") == 3)["ok"] == {"subscribers": 1}
                send(4, "health")
                assert requests.get(timeout=10) == ("/api/health", {}, None)
                assert expect(lambda line: line.get("id") == 4)["ok"] == {"status": "ok"}
                send(5, "get-stream", resource="res-1")
                assert requests.get(timeout=10) == ("/resources/res-1", {}, "Bearer token")
                content = expect(lambda line: line.get("id") == 5)["ok"]
                assert content["contentType"] == "application/octet-stream"
                assert base64.b64decode(content["bytes"]) == bytes(range(256))
                send(6, "close")
                assert expect(lambda line: line.get("id") == 6) == {"id": 6, "ok": None}
                driver.stdin.close()
                assert driver.wait(timeout=10) == 0
            finally:
                frames.put(None)
                if driver.poll() is None:
                    driver.kill()
                server.shutdown()


if __name__ == "__main__":
    main()
