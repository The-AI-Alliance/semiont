"""Run smoke preparation and cleanup against stand-ins, without starting services."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class SmokeDocumentsTest(unittest.TestCase):
    def test_requested_images_are_used_and_machine_documents_are_restored(self) -> None:
        for tag in ("local", "latest", "0.7.1"):
            for start_status in (0, 1):
                with self.subTest(tag=tag, start_status=start_status), tempfile.TemporaryDirectory() as temporary:
                    self.run_smoke(Path(temporary), tag, start_status)

    def run_smoke(self, root: Path, tag: str, start_status: int) -> None:
        source = Path(__file__).with_name("smoke-stack.sh")
        script = root / "tests/stack/smoke-stack.sh"
        script.parent.mkdir(parents=True)
        shutil.copyfile(source, script)
        for directory in ("apps/launcher/dist", "packages/go/launcher", "packages/go/sdk", "bin", "state home"):
            (root / directory).mkdir(parents=True)
        documents = {
            "browser": "image: ghcr.io/the-ai-alliance/semiont-browser:previous\nkeep: browser-setting\n",
            "worker": "image: ghcr.io/the-ai-alliance/semiont-worker:previous\nkeep: worker-setting\n",
        }
        for name, text in documents.items():
            (root / "state home" / f"{name}.yaml").write_text(text)
        launcher = root / "apps/launcher/dist/semiont"
        launcher.write_text(f"#!{sys.executable}\n" + '''import json
import os
from pathlib import Path
import sys
root = Path(os.environ["SMOKE_TEST_ROOT"])
command = sys.argv[1]
if command == "--version":
    print("smoke-test launcher")
elif command == "init":
    stack = Path.cwd() / ".semiont/stack"
    stack.mkdir(parents=True)
    (stack / "gateway.yaml").write_text("image: ghcr.io/the-ai-alliance/semiont-gateway:latest\\n")
elif command == "settings":
    print(root / "state home" / f"{sys.argv[2]}.yaml")
elif command == "start":
    snapshot = {name: (root / "state home" / f"{name}.yaml").read_text() for name in ("browser", "worker")}
    snapshot["gateway"] = (Path.cwd() / ".semiont/stack/gateway.yaml").read_text()
    (root / "started.json").write_text(json.dumps(snapshot))
    sys.exit(int(os.environ["SMOKE_TEST_START_STATUS"]))
''')
        launcher.chmod(0o755)
        for name, body in {
            "curl": "printf 'access-control-allow-origin: http://localhost:3000\\n'",
            "nc": "exit 1",
            "smoke-test-runtime": "exit 0",
        }.items():
            executable = root / "bin" / name
            executable.write_text(f"#!/bin/sh\n{body}\n")
            executable.chmod(0o755)
        result = subprocess.run(
            ["bash", str(script), tag],
            env={
                **os.environ,
                "PATH": str(root / "bin") + os.pathsep + os.environ["PATH"],
                "SMOKE_TEST_ROOT": str(root),
                "SMOKE_TEST_START_STATUS": str(start_status),
                "SMOKE_RUNTIME": "smoke-test-runtime",
                "SMOKE_KB": str(root / "kb"),
            },
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, start_status, result.stdout + result.stderr)
        started = json.loads((root / "started.json").read_text())
        for name in ("browser", "worker", "gateway"):
            self.assertIn(f"image: ghcr.io/the-ai-alliance/semiont-{name}:{tag}\n", started[name])
        for name, original in documents.items():
            self.assertEqual((root / "state home" / f"{name}.yaml").read_text(), original)
            self.assertIn(f"keep: {name}-setting\n", started[name])


if __name__ == "__main__":
    unittest.main()
