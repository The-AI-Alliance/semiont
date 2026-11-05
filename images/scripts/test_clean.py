"""Run make clean over a copy of the repository's ignore rules, never over the checkout itself."""

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLCHAINS = ["node", "rust", "python", "go", "jdk", "swift", "dotnet"]
KEPT = [
    "node_modules/tsup/package.json",
    "packages/python/sdk/.venv/pyvenv.cfg",
    "packages/typescript/core/src/types.ts",
    "packages/rust/target/debug/semiont",
    "apps/desktop/config.toml",
    ".env",
    ".plans/PLAN.md",
]


def declared_outputs() -> list[str]:
    """The output package-signatures.py says each of the repository's packages leaves."""
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout
    plan = subprocess.run(
        [
            sys.executable,
            str(ROOT / "images/scripts/package-signatures.py"),
            *TOOLCHAINS,
        ],
        cwd=ROOT,
        input=listed,
        check=True,
        capture_output=True,
    ).stdout.decode()
    return [line.split("\t")[4] for line in plan.splitlines() if line.split("\t")[4]]


class CleanTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "checkout with spaces"
        ignores = subprocess.run(
            ["git", "ls-files", "--", ".gitignore", "*/.gitignore"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.split()
        for relative in ["Makefile", "images/scripts/clean.sh", *ignores]:
            (self.root / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, self.root / relative)
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)

    def leave(self, *paths: str) -> None:
        for relative in paths:
            (self.root / relative).parent.mkdir(parents=True, exist_ok=True)
            (self.root / relative).write_text("built\n")

    def clean(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["make", "-C", str(self.root), "clean"],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_every_declared_output_is_removed_and_nothing_else(self) -> None:
        outputs = declared_outputs()
        self.assertTrue(outputs)
        self.leave(*(f"{output}/artifact" for output in outputs), *KEPT)
        result = self.clean()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for output in outputs:
            self.assertFalse((self.root / output).exists(), output)
        for kept in KEPT:
            self.assertTrue((self.root / kept).exists(), kept)

    def test_a_tracked_file_under_an_output_removes_nothing(self) -> None:
        self.leave(
            "packages/typescript/core/dist/index.js", "apps/launcher/dist/semiont"
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(self.root),
                "add",
                "-f",
                "packages/typescript/core/dist/index.js",
            ],
            check=True,
        )
        result = self.clean()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("packages/typescript/core/dist/index.js", result.stderr)
        self.assertTrue((self.root / "apps/launcher/dist/semiont").exists())

    def test_an_output_git_does_not_ignore_removes_nothing(self) -> None:
        self.leave("apps/launcher/dist/semiont", "packages/python/sdk/dist/semiont.whl")
        (self.root / "apps/launcher/.gitignore").write_text("!dist/\n")
        result = self.clean()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("apps/launcher/dist", result.stderr)
        self.assertTrue((self.root / "packages/python/sdk/dist/semiont.whl").exists())


if __name__ == "__main__":
    unittest.main()
