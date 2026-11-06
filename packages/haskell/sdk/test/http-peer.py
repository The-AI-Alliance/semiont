"""A real HTTP/SSE peer; route and response shapes come from the protocol."""

import email.parser
import http.server
import json
import pathlib
import queue
import socket
import sys
import threading


root = pathlib.Path(sys.argv[1])
fixtures = json.loads(pathlib.Path(sys.argv[2]).read_text())
specs = root / "protocol/specs/src"
spec = json.loads((specs / "openapi.json").read_text())
registry = json.loads((specs / "bus/registry.json").read_text())
routes = {}
for path, item in spec["paths"].items():
    document = json.loads((specs / item["$ref"]).read_text())
    for method, operation in document.items():
        if isinstance(operation, dict) and "operationId" in operation:
            routes[operation["operationId"]] = (method.upper(), path)
operations = {row["request"]: row for row in registry["operations"]}
channels = {row["channel"]: row for row in registry["channels"]}
state = {"requests": [], "subscriptions": [], "uploads": [], "disconnected": 0, "bodyClosed": 0, "headersClosed": 0}
controls = {"uploadStatuses": [], "emitStatuses": [], "subscribeFailures": [], "subscribeRetryAfter": "0", "refusedOperations": []}
subscribe_ready = threading.Event()
subscribe_ready.set()
gate = threading.Lock()
listeners = []


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def read_body(self):
        if self.headers.get("Transfer-Encoding") == "chunked":
            chunks = []
            while True:
                size = int(self.rfile.readline().strip(), 16)
                if not size:
                    self.rfile.readline()
                    return b"".join(chunks)
                chunks.append(self.rfile.read(size))
                assert self.rfile.read(2) == b"\r\n"
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def reply(self, body, status=200, media="application/json", headers=()):
        encoded = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", media)
        self.send_header("Content-Length", str(len(encoded)))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(encoded)
        self.wfile.flush()

    def do_GET(self):
        if self.path == "/test/state":
            with gate:
                snapshot = json.loads(json.dumps(state))
            self.reply(snapshot)
            return
        self.handle_request(b"")

    def do_POST(self):
        self.handle_request(self.read_body())

    def handle_request(self, raw):
        if self.path == "/test/config":
            configuration = json.loads(raw)
            with gate:
                controls.update(configuration)
            if "gateSubscribe" in configuration:
                if configuration["gateSubscribe"]:
                    subscribe_ready.clear()
                else:
                    subscribe_ready.set()
            self.reply({})
            return
        if self.path == "/test/publish":
            publication = json.loads(raw)
            with gate:
                for _, received in listeners:
                    received.put((publication["frame"], publication["id"]))
            self.reply({})
            return
        record = {"path": self.path, "method": self.command, "token": self.headers.get("Authorization"), "key": self.headers.get("Idempotency-Key"), "headers": {key.lower(): value for key, value in self.headers.items()}}
        with gate:
            state["requests"].append(record)
        if self.path == routes["subscribeToBus"][1]:
            body = json.loads(raw)
            with gate:
                record["body"] = body
            assert subscribe_ready.wait(10), "subscribe gate was not released"
            with gate:
                failures = controls["subscribeFailures"]
                refusal = failures.pop(0) if failures else None
                retry_after = controls["subscribeRetryAfter"]
            if refusal:
                self.reply({"error": "stream credential refused" if refusal == 401 else "stream temporarily unavailable"}, refusal, headers=[("Retry-After", retry_after)])
                return
            received = queue.Queue()
            with gate:
                state["subscriptions"].append(body)
                listeners.append((body, received))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b"event: ping\ndata:\n\n")
            self.wfile.flush()
            try:
                while True:
                    try:
                        frame, identity = received.get(timeout=0.02)
                    except queue.Empty:
                        self.connection.settimeout(0.001)
                        try:
                            if self.connection.recv(1, socket.MSG_PEEK) == b"":
                                break
                        except TimeoutError:
                            pass
                        continue
                    data = ("event: bus-event\nid: " + identity + "\ndata: " + json.dumps(frame, ensure_ascii=False) + "\n\n").encode()
                    for byte in data:
                        self.wfile.write(bytes([byte]))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with gate:
                    listeners.remove((body, received))
                    state["disconnected"] += 1
            return
        if self.path == routes["emitOnBus"][1]:
            body = json.loads(raw)
            with gate:
                record["body"] = body
                statuses = controls["emitStatuses"]
                refusal = statuses.pop(0) if statuses else None
            assert record["key"], "emit has no idempotency key"
            if refusal:
                self.reply({"error": "retry this emit"}, refusal, headers=[("Retry-After", "0")])
                return
            operation = operations.get(body["channel"])
            if operation:
                result = operation["failure"] if body["channel"] in controls["refusedOperations"] else operation["result"]
                channel = channels[result]
                payload = {} if channel["shape"] in ("empty", "void") else fixtures[channel["schema"]]
                frame = {"channel": result, "correlationId": body["correlationId"], "payload": payload}
                with gate:
                    for subscription, received in listeners:
                        if subscription["clientId"] == body["clientId"]:
                            received.put((frame, "e-" + frame["channel"] + ":" + frame["correlationId"]))
            self.reply({"subscribers": 1}, 202)
            return
        if self.path == routes["uploadResource"][1]:
            assert record["key"], "upload has no idempotency key"
            message = email.parser.BytesParser().parsebytes(("Content-Type: " + self.headers["Content-Type"] + "\r\nMIME-Version: 1.0\r\n\r\n").encode() + raw)
            parts = {part.get_param("name", header="Content-Disposition"): part.get_payload(decode=True).decode() for part in message.get_payload()}
            with gate:
                state["uploads"].append({"parts": parts, "key": record["key"], "token": record["token"]})
                statuses = controls["uploadStatuses"]
                refusal = statuses.pop(0) if statuses else None
            if refusal:
                self.reply({"error": "retry this keyed upload"}, refusal, headers=[("Retry-After", "0")])
            elif record["token"] == "Bearer renew-upload":
                self.reply({"error": "upload credential refused"}, 401)
            else:
                self.reply(fixtures["CreateResourceResponse"], 202)
            return
        for operation, schema in [("getHealth", "HealthResponse"), ("getCurrentUser", "UserResponse"), ("getStatus", "StatusResponse"), ("getProtectedResourceMetadata", "ProtectedResourceMetadata"), ("createMediaToken", "MediaTokenResponse")]:
            if self.path == routes[operation][1]:
                self.reply(fixtures[schema])
                return
        content_prefix = routes["getResourceRepresentation"][1].split("{id}")[0]
        if self.path.startswith(content_prefix):
            if record["token"] == "Bearer refused-content-override":
                self.reply({"error": "explicit content credential refused"}, 401)
                return
            suffix = self.path.rsplit("/", 1)[-1]
            schemas = {"jsonld": "GetResourceResponse", "annotations": "GetAnnotationsResponse", "anchored-text": "AnchoredTextAnswer"}
            if suffix in schemas:
                if self.path[len(content_prefix):].split("/", 1)[0] == "malformed":
                    self.reply(b"invalid", media="application/json")
                else:
                    self.reply(fixtures[schemas[suffix]])
            elif suffix == "refused":
                self.reply({"error": "gateway words preserved"}, 403)
            elif suffix in ("headers", "body"):
                if suffix == "body":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain")
                    self.send_header("Content-Length", "100")
                    self.end_headers()
                    self.wfile.write(b"a")
                    self.wfile.flush()
                self.connection.settimeout(10)
                assert self.connection.recv(1) == b"", "an abandoned response socket was reused"
                with gate:
                    state[suffix + "Closed"] += 1
            else:
                self.reply("hello λ".encode(), media="text/plain; charset=utf-8")
            return
        self.reply({"error": "unknown route"}, 404)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
print(server.server_port, flush=True)
try:
    sys.stdin.readline()
finally:
    server.shutdown()
    server.server_close()
