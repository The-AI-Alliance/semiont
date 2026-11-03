"""Runtime selection must be bounded, explicit and free of startup side effects."""

import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

HELPER = Path(__file__).with_name("container-runtime.sh")


class RuntimeSelectionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bin = Path(self.temp.name)
        self.log = self.bin / "calls"
        self.env = {**os.environ, "PATH": str(self.bin) + ":/usr/bin:/bin"}
        self.env.pop("CONTAINER_RUNTIME", None)
        for runtime in ("container", "docker", "podman"):
            self.engine(runtime, "exit 1")

    def engine(self, name, body):
        command = self.bin / name
        command.write_text(
            f'#!/bin/sh\nprintf "%s %s\\n" "{name}" "$*" >> "{self.log}"\n{body}\n'
        )
        command.chmod(0o755)

    def detect(self):
        return subprocess.run(
            [
                "/bin/bash",
                "-c",
                'source "$1"; detect_container_runtime',
                "test",
                str(HELPER),
            ],
            check=False,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_auto_selection_skips_stopped_engines(self):
        self.engine("docker", "exit 0")
        result = self.detect()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "docker\n")
        self.assertEqual(
            self.log.read_text().splitlines(),
            ["container system status", "docker info"],
        )

    def test_explicit_selection_never_falls_back_or_starts_services(self):
        self.env["CONTAINER_RUNTIME"] = "container"
        self.engine("docker", "exit 0")
        result = self.detect()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Selected runtime 'container' is not responding", result.stderr)
        self.assertIn("container system start", result.stderr)
        self.assertEqual(self.log.read_text().splitlines(), ["container system status"])

    def test_missing_explicit_executable_is_named(self):
        self.env["CONTAINER_RUNTIME"] = str(self.bin / "missing")
        result = self.detect()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not installed or not on PATH", result.stderr)
        self.assertFalse(self.log.exists())

    def test_no_responding_engine_explains_how_to_proceed(self):
        result = self.detect()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No container runtime is responding", result.stderr)
        self.assertIn("container system start", result.stderr)
        self.assertIn("docker", result.stderr)
        self.assertIn("podman", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_unresponsive_cli_cannot_hang_the_build(self):
        self.env["CONTAINER_RUNTIME"] = "container"
        self.engine("container", "exec sleep 30")
        started = time.monotonic()
        result = self.detect()
        elapsed = time.monotonic() - started
        self.assertNotEqual(result.returncode, 0)
        self.assertGreaterEqual(elapsed, 4)
        self.assertLess(elapsed, 8)
        self.assertIn("5 seconds", result.stderr)

    def test_no_installed_runtime_is_actionable(self):
        self.env["PATH"] = str(self.bin / "empty")
        result = self.detect()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Install Apple container, Docker or Podman", result.stderr)
