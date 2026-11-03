"""Hold the public generation inventory and isolated metadata comparisons to their owners."""

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "operations", Path(__file__).with_name("operations.py")
)
operations = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(operations)


class GenerationTest(unittest.TestCase):
    def test_every_root_generation_command_has_a_public_group(self):
        scripts = json.loads((operations.ROOT / "package.json").read_text())["scripts"]
        names = {
            key.removeprefix("generate:")
            for key in scripts
            if key.startswith("generate:") and not key.endswith(":check")
        }
        self.assertEqual(names, set(operations.GROUPS) - {"typescript", "discovery-go"})
        for name in names:
            self.assertIn("generate:" + name + ":check", scripts)

    def test_every_group_has_a_real_drift_and_regeneration_case(self):
        spec = importlib.util.spec_from_file_location(
            "verify_groups", Path(__file__).with_name("verify_groups.py")
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules", {"operations": operations}):
            spec.loader.exec_module(module)
        self.assertEqual(set(module.OUTPUTS), set(operations.GROUPS))
        for output in module.OUTPUTS.values():
            self.assertTrue((operations.ROOT / output).is_file(), output)

    def test_go_generator_arguments_come_from_the_directive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "generate.go").write_text(
                '//go:generate sh -c "container run image go run example.org/generator@v1 -o generated.go schema.json"\n'
            )
            with patch.object(operations, "ROOT", root):
                command, output = operations.go_command("generate.go")
            self.assertEqual(
                command,
                ["example.org/generator@v1", "-o", "generated.go", "schema.json"],
            )
            self.assertEqual(output, "generated.go")

    def test_typescript_drift_comparison_never_repairs_the_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root, temp = Path(directory) / "source", Path(directory) / "generated"
            root.mkdir()
            temp.mkdir()
            (root / "owned.ts").write_bytes(b"stale source")
            (temp / "owned.ts").write_bytes(b"correct output")
            (temp / "tracked.json").write_text('["owned.ts"]')
            with (
                patch.object(operations, "ROOT", root),
                self.assertRaisesRegex(RuntimeError, "stale"),
            ):
                operations.compare_typescript(temp)
            self.assertEqual((root / "owned.ts").read_bytes(), b"stale source")

    def test_unknown_group_is_rejected_without_a_runtime(self):
        result = subprocess.run(
            [
                "bash",
                str(operations.ROOT / "packages/codegen/run.sh"),
                "generate-missing",
            ],
            check=False,
            capture_output=True,
            text=True,
            env={"PATH": "/usr/bin:/bin"},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unknown generation group", result.stderr)


if __name__ == "__main__":
    unittest.main()
