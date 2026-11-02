"""Hold the public generation groups to their owners and check non-repairing behavior."""

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "codegen", Path(__file__).with_name("run.py")
)
codegen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(codegen)


class RecordingGeneration(codegen.Generation):
    def __init__(self, check, cache):
        self.check = check
        self.engine = "runtime"
        self.node_image = "node"
        self.go_image = "golang"
        self.python_image = "python"
        self.installed = False
        self.bundled = False
        self.done = set()
        self.cache = cache
        self.commands = []

    def run(self, image, *command, root=None, mounts=()):
        self.commands.append((image, command))
        if mounts and command[:2] == ("go", "run"):
            output = command[command.index("-o") + 1]
            (mounts[0][0] / Path(output).name).write_bytes(b"changed output")
        if root is not None and command[:3] == ("npm", "run", "prebuild"):
            (root / "packages/typescript/core/generated.ts").write_bytes(
                b"changed output"
            )


class GenerationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = Path(self.temp.name)

    def test_every_root_generation_command_has_a_public_group(self):
        scripts = json.loads((codegen.ROOT / "package.json").read_text())["scripts"]
        names = {
            key.removeprefix("generate:")
            for key in scripts
            if key.startswith("generate:") and not key.endswith(":check")
        }
        self.assertEqual(names, set(codegen.GROUPS) - {"typescript", "discovery-go"})
        for name in names:
            self.assertIn("generate:" + name + ":check", scripts)

    def test_shared_bus_and_installation_are_run_once(self):
        operation = RecordingGeneration(False, self.cache)
        for group in codegen.GROUPS:
            operation.group(group)
        commands = [command for _, command in operation.commands]
        self.assertEqual(commands.count(("npm", "run", "generate:bus")), 1)
        self.assertEqual(
            commands.count(("npm", "ci", "--include=optional", "--ignore-scripts")), 1
        )

    def test_committed_go_drift_fails_without_writing_source(self):
        root = self.cache / "repository"
        root.mkdir()
        source = root / "generate.go"
        source.write_text(
            '//go:generate sh -c "container run image go run example.org/generator@v1 -o generated.go schema.json"\n'
        )
        output = root / "generated.go"
        output.write_bytes(b"committed output")
        operation = RecordingGeneration(True, self.cache)
        with (
            patch.object(codegen, "ROOT", root),
            self.assertRaisesRegex(RuntimeError, "stale"),
        ):
            operation.go_directive("generate.go")
        self.assertEqual(output.read_bytes(), b"committed output")

    def test_typescript_drift_is_checked_in_an_isolated_tree(self):
        root = self.cache / "repository"
        for directory in ("specs", "packages/codegen", "packages/typescript/core"):
            (root / directory).mkdir(parents=True)
        (root / "package.json").write_text("{}")
        generated = root / "packages/typescript/core/generated.ts"
        generated.write_bytes(b"committed output")
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        subprocess.run(["git", "-C", str(root), "add", "."], check=True)
        operation = RecordingGeneration(True, self.cache)
        with (
            patch.object(codegen, "ROOT", root),
            self.assertRaisesRegex(RuntimeError, "stale"),
        ):
            operation.typescript()
        self.assertEqual(generated.read_bytes(), b"committed output")

    def test_unknown_group_fails_before_runtime_detection(self):
        with (
            patch.object(codegen.sys, "argv", ["run.py", "generate-missing"]),
            patch.object(codegen, "runtime") as engine,
        ):
            with self.assertRaisesRegex(RuntimeError, "Unknown"):
                codegen.main()
            engine.assert_not_called()


if __name__ == "__main__":
    unittest.main()
