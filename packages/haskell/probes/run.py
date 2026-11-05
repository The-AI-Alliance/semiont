#!/usr/bin/env python3
"""Real HTTP and native-lock peers for the Haskell P0 executable."""

import collections
import fcntl
import http.server
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import threading


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def compile_probes():
    with tempfile.TemporaryDirectory() as output:
        command = [
            "cabal", "exec", "--", "ghc", "-fno-code", "-XGHC2021",
            "-Wall", "-Werror", "-Wincomplete-patterns", "-isrc",
            "-outputdir", output,
        ]
        subprocess.run(command + ["refusals/Valid.hs"], check=True, timeout=30)
        expected = {
            "WrongPayload": "Bool",
            "MissingScope": "Scoped",
            "UncheckedIdentifier": "Illegal term-level use",
            "WrongOperation": "Int",
            "IncompleteOutcome": "non-exhaustive",
            "CoercedIdentifier": "constructor",
        }
        for name, diagnostic in expected.items():
            result = subprocess.run(
                command + [f"refusals/{name}.hs"], text=True,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30,
            )
            require(result.returncode != 0, f"{name} unexpectedly compiled")
            require(diagnostic in result.stdout, f"{name}: wrong refusal\n{result.stdout}")
            print(f"PASS compile refusal: {name}", flush=True)


def http_probes(binary):
    attempts = collections.Counter()
    disconnected = {name: threading.Event() for name in ("/stream", "/stall", "/headers")}
    errors = []

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def reply(self, body):
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()

        def do_GET(self):
            attempts[self.path] += 1
            if self.path == "/body":
                self.reply(b"body")
            elif self.path.startswith("/drop-"):
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
            elif self.path in disconnected:
                if self.path != "/headers":
                    self.send_response(200)
                    if self.path == "/stream":
                        self.send_header("Transfer-Encoding", "chunked")
                    else:
                        self.send_header("Content-Length", "4")
                    self.end_headers()
                if self.path == "/stream":
                    self.wfile.write(b"4\r\ndata\r\n")
                    self.wfile.flush()
                self.close_connection = True
                self.connection.settimeout(10)
                try:
                    require(self.connection.recv(1) == b"", "unread response socket reused")
                    disconnected[self.path].set()
                except OSError as error:
                    errors.append(error)
            else:
                self.send_error(404)

        def do_POST(self):
            if self.path.startswith("/drop-"):
                self.do_GET()
                return
            require(self.path == "/upload", "unknown upload URL")
            require(self.headers["Transfer-Encoding"] == "chunked", "upload was buffered")
            chunks = []
            while True:
                size = int(self.rfile.readline().strip(), 16)
                if size == 0:
                    require(self.rfile.readline() == b"\r\n", "invalid chunk ending")
                    break
                chunks.append(self.rfile.read(size))
                require(self.rfile.read(2) == b"\r\n", "invalid chunk separator")
            self.reply(b"".join(chunks))

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        # Established proxy settings are deliberately unusable. noProxy must win.
        environment = dict(os.environ, http_proxy="http://127.0.0.1:1", no_proxy="")
        subprocess.run(
            [binary, f"http://127.0.0.1:{server.server_port}"],
            check=True, timeout=30, env=environment,
        )
        for name, event in disconnected.items():
            require(event.wait(5), f"{name} socket did not close")
        require(not errors, f"HTTP peer errors: {errors}")
        require(attempts["/drop-default"] == 2, f"default retry count: {attempts}")
        require(attempts["/drop-off"] == 1, f"disabled retry count: {attempts}")
        print("PASS peer observed body socket closure and exact retry counts", flush=True)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def lock_probes(binary):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory, "native.lock")
        with path.open("w+") as peer:
            fcntl.flock(peer, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run([binary, "try-lock", str(path)], timeout=5)
            require(result.returncode == 1, "Haskell did not respect the Python flock holder")
            subprocess.run([binary, "cancel-lock", str(path)], check=True, timeout=5)
            waiter = subprocess.Popen(
                [binary, "wait-lock", str(path)], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                ready, _, _ = select.select([waiter.stdout], [], [], 5)
                require(ready and waiter.stdout.readline() == "waiting\n", "wait did not use the callback")
                fcntl.flock(peer, fcntl.LOCK_UN)
                output, error = waiter.communicate("retry\n", timeout=5)
                require(waiter.returncode == 0 and output == "held\n", f"controlled lock wait failed: {error}")
            finally:
                if waiter.poll() is None:
                    waiter.kill()
                    waiter.communicate(timeout=5)
            fcntl.flock(peer, fcntl.LOCK_UN)
            subprocess.run([binary, "try-lock", str(path)], check=True, timeout=5)
            for kill_holder in (False, True):
                holder = subprocess.Popen(
                    [binary, "hold-lock", str(path)], stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                try:
                    ready, _, _ = select.select([holder.stdout], [], [], 5)
                    require(ready and holder.stdout.readline() == "held\n", "Haskell holder failed to start")
                    try:
                        fcntl.flock(peer, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        pass
                    else:
                        raise AssertionError("Python did not respect the Haskell flock holder")
                    if kill_holder:
                        holder.kill()
                        holder.communicate(timeout=5)
                    else:
                        holder.communicate("release\n", timeout=5)
                        require(holder.returncode == 0, "Haskell holder failed to exit")
                    fcntl.flock(peer, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(peer, fcntl.LOCK_UN)
                finally:
                    if holder.poll() is None:
                        holder.kill()
                        holder.communicate(timeout=5)
        print("PASS cross-process flock, controlled/cancelled waits, release after exit/death", flush=True)


if __name__ == "__main__":
    require(len(sys.argv) == 2, "expected probe executable")
    compile_probes()
    http_probes(sys.argv[1])
    lock_probes(sys.argv[1])
