"""Exercise image input invalidation without building an image or modifying runtime state."""

import importlib.util
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "image_signature", Path(__file__).with_name("image-signature.py")
)
image_signature = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(image_signature)


class SignatureTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dockerfile = self.root / "Dockerfile"
        self.dockerfile.write_text("FROM scratch\nCOPY source.txt /source.txt\n")
        (self.root / "source.txt").write_text("first")

    def signature(self, registry="http://127.0.0.1:1", rust="rust", python="python"):
        return image_signature.signature(
            self.root, self.dockerfile, registry, rust, python
        )

    def test_copy_inputs_dockerfile_and_toolchain_all_invalidate(self):
        before = self.signature()
        (self.root / "source.txt").write_text("second")
        self.assertNotEqual(self.signature(), before)
        before = self.signature()
        self.dockerfile.write_text(self.dockerfile.read_text() + "ARG RUST_TOOLCHAIN\n")
        self.assertNotEqual(self.signature(), before)
        self.assertNotEqual(self.signature(rust="new"), self.signature(rust="old"))
        with self.assertRaises(FileNotFoundError):
            (self.root / "source.txt").unlink()
            self.signature()

    def test_transitive_npm_integrity_changes_without_a_version_bump(self):
        packages = {
            "@semiont/app": {
                "dist": {"integrity": "app"},
                "dependencies": {"@semiont/core": "*"},
            },
            "@semiont/core": {"dist": {"integrity": "first"}},
        }

        class Registry(BaseHTTPRequestHandler):
            def do_GET(self):
                from urllib.parse import unquote

                package = packages.get(unquote(self.path.lstrip("/")))
                if package is None:
                    self.send_error(404)
                    return
                body = json.dumps(
                    {
                        "dist-tags": {"latest": "same-version"},
                        "versions": {"same-version": package},
                    }
                ).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Registry)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            self.dockerfile.write_text("FROM scratch\nRUN npm install @semiont/app\n")
            address = f"http://127.0.0.1:{server.server_port}"
            before = self.signature(registry=address)
            packages["@semiont/core"]["dist"]["integrity"] = "second"
            self.assertNotEqual(self.signature(registry=address), before)
            del packages["@semiont/core"]
            self.assertEqual(self.signature(registry=address), "")
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
