"""Exercise Make/session boundaries without starting a runtime or publishing packages."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class BuildEntrypointsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "checkout with spaces"
        self.root.mkdir()
        paths = [
            "Makefile",
            "packages/codegen",
            "images/scripts",
            "apps/desktop/build.sh",
            ".node-version",
            "apps/launcher/go.mod",
            "packages/go/scripts",
            "packages/rust/scripts",
            "packages/rust/rust-toolchain.toml",
            "packages/python/scripts",
            "packages/python/sdk/pyproject.toml",
            "packages/typescript/scripts/node-version.sh",
            "packages/kotlin/scripts",
            "packages/kotlin/sdk/.java-version",
            "packages/swift/scripts",
            "packages/swift/sdk/.swift-version",
            "packages/csharp/scripts",
            "packages/csharp/sdk/global.json",
        ]
        for relative in paths:
            source, target = ROOT / relative, self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(
                    source, target, ignore=shutil.ignore_patterns("__pycache__")
                )
            else:
                shutil.copy2(source, target)
        (self.root / "apps/desktop/release").mkdir(parents=True)
        (self.root / "images/worker").mkdir(parents=True)
        (self.root / "images/worker/Dockerfile").write_text("FROM scratch\n")
        self.log = Path(self.temp.name) / "runtime.jsonl"
        self.engine = Path(self.temp.name) / "fake-runtime"
        self.engine.write_text(f"""#!{sys.executable}
import json,sys,subprocess
from pathlib import Path
args=sys.argv[1:]
with Path({str(self.log)!r}).open('a') as log: log.write(json.dumps(args)+'\\n')
if args and args[0]=='exec' and args[-1].startswith("ip route"):
 print('127.0.0.1'); sys.exit(0)
if any(a.endswith('package-signatures.py') for a in args):
 print('packages/rust/sdk\\trust\\tsemiont\\tsignature\\t')
 print('packages/typescript/core\\ttypescript\\tcore\\tother-signature\\t'); sys.exit(0)
if args and args[0]=='exec' and 'python3' in args:
 sys.exit(subprocess.run([sys.executable,*args[args.index('python3')+1:]]).returncode)
""")
        self.engine.chmod(0o755)
        self.cache = Path(self.temp.name) / "cache"
        self.env = {
            **os.environ,
            "CONTAINER_RUNTIME": str(self.engine),
            "XDG_CACHE_HOME": str(self.cache),
        }
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)

    def run_make(self, *args):
        return subprocess.run(
            ["make", "-C", str(self.root), *args],
            check=False,
            env=self.env,
            text=True,
            capture_output=True,
        )

    def calls(self):
        calls = (
            [json.loads(line) for line in self.log.read_text().splitlines()]
            if self.log.exists()
            else []
        )
        return [
            args
            for args in calls
            if not any("semiont-python-tools-" in arg for arg in args)
            or any(arg.endswith("package-signatures.py") for arg in args)
        ]

    def test_help_and_dry_run_are_side_effect_free(self):
        for arguments in [("help",), ("-n", "local-build")]:
            result = self.run_make(*arguments)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.log.exists())
        self.assertFalse(self.cache.exists())

    def test_plan_does_not_build_or_write_cache(self):
        result = self.run_make("plan", "PACKAGE_NAMES=rust", "IMAGE_NAMES=worker")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.cache.exists())
        self.assertTrue(
            all(
                "package-signatures.py" in " ".join(args)
                or args[:2] == ["image", "inspect"]
                for args in self.calls()
            )
        )
        self.assertIn("package-signatures.py", " ".join(self.calls()[0]))

    def test_state_lookups_do_not_consume_the_remaining_package_plan(self):
        result = self.run_make("plan")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("packages/rust/sdk", result.stdout)
        self.assertIn("packages/typescript/core", result.stdout)

    def test_package_selection_does_not_build_images_registry_or_launcher(self):
        result = self.run_make("packages", "PACKAGE_NAMES=rust")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 2, calls)
        self.assertIn("cargo build", " ".join(calls[1]))
        self.assertNotIn(" go build", " ".join(calls[1]))
        self.assertNotIn("verdaccio", " ".join(calls[1]))

    def test_launcher_is_independent_of_package_planning(self):
        (self.root / "packages/swift/sdk/.swift-version").unlink()
        result = self.run_make("launcher")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(self.calls()), 1)
        self.assertIn("go build", " ".join(self.calls()[0]))
        self.assertNotIn("package-signatures", " ".join(self.calls()[0]))

    def test_smoke_tag_does_not_select_an_image(self):
        self.env["IMAGES"] = "local"
        result = self.run_make("plan", "PACKAGE_NAMES=rust")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("Unknown image", result.stdout)

    def test_parallel_public_goals_are_refused_before_runtime_work(self):
        result = self.run_make("-j", "packages", "launcher")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("one public operation", result.stderr)
        self.assertFalse(self.log.exists())

    def test_failed_package_does_not_record_success(self):
        self.engine.write_text(
            self.engine.read_text()
            + "\nif any('cargo build' in a for a in args): sys.exit(7)\n"
        )
        result = self.run_make("packages", "PACKAGE_NAMES=rust")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.cache / "semiont/local-build-state.json").exists())

    def test_warm_image_is_reused_only_when_the_runtime_has_it(self):
        state = self.cache / "semiont/local-build-state.json"
        state.parent.mkdir(parents=True)
        dockerfile = (self.root / "images/worker/Dockerfile").read_bytes()
        signature = (
            "dockerfile:"
            + hashlib.sha256(dockerfile).hexdigest()
            + " sources:"
            + hashlib.sha256().hexdigest()
        )
        state.write_text(json.dumps({"images/worker": signature}))
        result = self.run_make("images-only", "FANOUT=0")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("unchanged", result.stdout)
        self.assertTrue(any(args[:2] == ["image", "inspect"] for args in self.calls()))
        self.assertFalse(any(args[0] == "build" for args in self.calls()))

    def test_publication_preflight_failure_does_not_start_a_registry(self):
        self.engine.write_text(
            self.engine.read_text()
            + "\nif any('stage-local-publish.mjs' in a for a in args): sys.exit(7)\n"
        )
        result = self.run_make("npm-publish-local")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.calls()), 1)
        self.assertIn("verify", self.calls()[0])

    def test_failed_publication_leaves_no_host_staging_directory(self):
        self.engine.write_text(self.engine.read_text() + "\nsys.exit(7)\n")
        self.cache.mkdir()
        source = self.root / "images/scripts/local-build/publication.sh"
        result = subprocess.run(
            [
                "bash",
                "-c",
                (
                    'RT="$1"; REPO_ROOT="$2"; CACHE_ROOT="$3"; NODE_IMAGE=node; HOST_ADDR=localhost; VERDACCIO_TOKEN=test; '
                    'source "$4"; publish_local_npm'
                ),
                "test",
                str(self.engine),
                str(self.root),
                str(self.cache),
                str(source),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_root_owned_publication_files_do_not_require_host_cleanup(self):
        # Model Linux Docker: container-created directories cannot be unlinked by the host.
        self.engine.write_text(
            self.engine.read_text()
            + """
for argument in args:
 if argument.endswith(':/publish'):
  stage=Path(argument[:-len(':/publish')])
  protected=stage/'container-owned'
  protected.mkdir()
  (protected/'artifact').write_text('published artifact')
  protected.chmod(0o555)
"""
        )
        self.cache.mkdir()
        source = self.root / "images/scripts/local-build/publication.sh"
        try:
            result = subprocess.run(
                [
                    "bash",
                    "-e",
                    "-c",
                    (
                        'RT="$1"; REPO_ROOT="$2"; CACHE_ROOT="$3"; NODE_IMAGE=node; HOST_ADDR=localhost; VERDACCIO_TOKEN=test; '
                        'source "$4"; publish_local_npm'
                    ),
                    "test",
                    str(self.engine),
                    str(self.root),
                    str(self.cache),
                    str(source),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(list(self.cache.iterdir()), [])
        finally:
            for protected in self.cache.glob("local-npm.*/container-owned"):
                protected.chmod(0o755)

    def test_local_operations_do_not_execute_host_python_or_node(self):
        bin_dir = Path(self.temp.name) / "host-bin"
        bin_dir.mkdir()
        marker = Path(self.temp.name) / "host-runtime-used"
        for name in ("python3", "node", "npm"):
            command = bin_dir / name
            command.write_text(f"#!/bin/sh\nprintf forbidden > '{marker}'\nexit 99\n")
            command.chmod(0o755)
        self.env["PATH"] = str(bin_dir) + os.pathsep + "/usr/bin:/bin"
        for operation in (
            ("plan",),
            ("packages", "PACKAGE_NAMES=rust"),
            ("generate-bus",),
        ):
            result = self.run_make(*operation)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(marker.exists())

    def test_missing_cached_image_rebuilds_and_a_failed_build_keeps_state(self):
        state = self.cache / "semiont/local-build-state.json"
        state.parent.mkdir(parents=True)
        state.write_text('{"images/worker":"verified"}')
        self.engine.write_text(
            self.engine.read_text()
            + "\nif args[:2]==['image','inspect']: sys.exit(1)\nif args and args[0]=='build': sys.exit(9)\n"
        )
        before = state.read_bytes()
        result = self.run_make("images-only", "FANOUT=0")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any(args[0] == "build" for args in self.calls()))
        self.assertEqual(state.read_bytes(), before)

    def test_secondary_fanout_failure_does_not_discard_an_unchanged_primary_image(self):
        self.test_warm_image_is_reused_only_when_the_runtime_has_it()
        bin_dir = Path(self.temp.name) / "engines"
        bin_dir.mkdir()
        for name in ("container", "docker", "podman"):
            command = bin_dir / name
            command.write_text(
                "#!/bin/sh\n"
                + (
                    '[ "$2" = list ] && exit 0\nexit 7\n'
                    if name == "docker"
                    else "exit 1\n"
                )
            )
            command.chmod(0o755)
        self.env["PATH"] = str(bin_dir) + os.pathsep + "/usr/bin:/bin"
        result = self.run_make("images-only", "FANOUT=1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Fan-out of", result.stdout)
        self.assertIn("failed (build unaffected", result.stdout)
        self.assertFalse(any(args[0] == "build" for args in self.calls()))

    def test_desktop_selects_linux_without_rosetta(self):
        bin_dir = Path(self.temp.name) / "bin"
        bin_dir.mkdir()
        uname = bin_dir / "uname"
        uname.write_text(
            '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n'
        )
        uname.chmod(0o755)
        self.env["PATH"] = str(bin_dir) + os.pathsep + self.env["PATH"]
        result = self.run_make("desktop")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("--platform", self.calls()[0])
        self.assertNotIn("--rosetta", self.calls()[0])
        self.assertIn("--linux deb --x64", " ".join(self.calls()[0]))
        result = self.run_make("desktop-macos")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("macOS host", result.stderr)


if __name__ == "__main__":
    unittest.main()
