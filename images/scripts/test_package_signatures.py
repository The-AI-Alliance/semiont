"""Run package-signatures.py over a small repository and read which packages it says changed."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("package-signatures.py")
TOOLCHAINS = ["node", "rust", "python", "go", "jdk", "swift", "dotnet"]


def signatures(root: Path) -> subprocess.CompletedProcess[str]:
    files = sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())
    return subprocess.run(
        [sys.executable, str(SCRIPT), *TOOLCHAINS],
        check=False,
        cwd=root,
        input="\0".join(files),
        capture_output=True,
        text=True,
    )


def signature_by_package(root: Path) -> dict[str, str]:
    run = signatures(root)
    if run.returncode != 0:
        raise AssertionError(
            f"package-signatures.py exited {run.returncode}: {run.stderr}"
        )
    return {
        line.split("\t")[0]: line.split("\t")[3] for line in run.stdout.splitlines()
    }


class PackageSignaturesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        for path, text in {
            "version.json": '{"version": "0.0.0"}\n',
            "protocol/specs/src/openapi.json": "{}\n",
            "packages/codegen/bus/generate-ts.mjs": "export {};\n",
            "packages/rust/Cargo.toml": "[workspace]\n",
            "packages/typescript/core/package.json": '{"name": "@semiont/core"}\n',
            "packages/python/sdk/pyproject.toml": '[project]\nname = "semiont"\n',
        }.items():
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            (self.root / path).write_text(text)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_a_generator_change_changes_every_package(self) -> None:
        before = signature_by_package(self.root)
        (self.root / "packages/codegen/bus/generate-ts.mjs").write_text(
            "export const changed = true;\n"
        )
        after = signature_by_package(self.root)
        self.assertEqual(
            sorted(before), ["packages/python/sdk", "packages/typescript/core"]
        )
        for package in before:
            self.assertNotEqual(before[package], after[package], package)

    def test_unstaged_deletions_are_not_read_from_the_git_index(self) -> None:
        root = self.root
        source = root / "packages/typescript/core/source.ts"
        source.write_text("export {};\n")
        before = signature_by_package(root)
        source.unlink()
        files = [
            str(path.relative_to(root)) for path in root.rglob("*") if path.is_file()
        ]
        files.append("packages/typescript/core/source.ts")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *TOOLCHAINS],
            cwd=root,
            input="\0".join(files),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        after = {
            line.split("\t")[0]: line.split("\t")[3]
            for line in result.stdout.splitlines()
        }
        self.assertNotEqual(
            before["packages/typescript/core"], after["packages/typescript/core"]
        )

    def test_a_shared_input_holding_no_file_fails(self) -> None:
        (self.root / "packages/codegen/bus/generate-ts.mjs").unlink()
        run = signatures(self.root)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("packages/codegen/", run.stderr)


if __name__ == "__main__":
    unittest.main()
