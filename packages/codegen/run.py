"""Container entry points for the repository's existing generation commands."""

import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GROUPS = (
    "bus",
    "typescript",
    "python",
    "go",
    "stack-go",
    "mcp-tools-go",
    "discovery-go",
    "encoding-cases",
    "model-catalogue",
)


def read_version(reader: str) -> str:
    return subprocess.check_output([str(ROOT / reader)], text=True).strip()


def runtime() -> str:
    if os.environ.get("CONTAINER_RUNTIME"):
        return os.environ["CONTAINER_RUNTIME"]
    for name in ("container", "docker", "podman"):
        if shutil.which(name):
            return name
    raise RuntimeError("Install a container runtime or set CONTAINER_RUNTIME")


class Generation:
    def __init__(self, check: bool) -> None:
        self.check = check
        self.engine = runtime()
        self.node_image = (
            "node:"
            + read_version("packages/typescript/scripts/node-version.sh")
            + "-alpine"
        )
        self.go_image = "golang:" + read_version("packages/go/scripts/go-toolchain.sh")
        self.python_image = (
            "python:"
            + read_version("packages/python/scripts/python-floor.sh")
            + "-alpine"
        )
        self.installed = False
        self.bundled = False
        self.done: set[str] = set()
        self.cache = (
            Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
            / "semiont"
            / "codegen"
        )
        self.cache.mkdir(parents=True, exist_ok=True)

    def run(
        self,
        image: str,
        *command: str,
        root: Path = ROOT,
        mounts: tuple[tuple[Path, str], ...] = (),
    ) -> None:
        args = [
            self.engine,
            "run",
            "--rm",
            "-m",
            "8g",
            "-v",
            f"{root}:/workspace",
            "-w",
            "/workspace",
        ]
        for source, destination in mounts:
            args += ["-v", f"{source}:{destination}"]
        subprocess.run([*args, image, *command], check=True)

    def npm(self, script: str) -> None:
        # package.json owns each command list, including the :check variant.
        self.run(self.node_image, "npm", "run", script)

    def install(self) -> None:
        if not self.installed:
            self.run(
                self.node_image, "npm", "ci", "--include=optional", "--ignore-scripts"
            )
            self.installed = True

    def bundle(self) -> None:
        if not self.bundled:
            self.install()
            self.npm("openapi:bundle")
            self.bundled = True

    def go_directive(self, source: str) -> None:
        # Keep generator pins/configuration in their existing go:generate owner.
        text = (ROOT / source).read_text()
        directive = next(
            line for line in text.splitlines() if line.startswith("//go:generate ")
        )
        command = shlex.split(directive.split(" go run ", 1)[1].removesuffix('"'))
        output_at = command.index("-o") + 1
        output = command[output_at]
        if not self.check:
            self.run(self.go_image, "go", "run", *command)
            return
        with tempfile.TemporaryDirectory(dir=self.cache) as directory:
            temp = Path(directory)
            command[output_at] = "/generated/output.go"
            self.run(
                self.go_image, "go", "run", *command, mounts=((temp, "/generated"),)
            )
            if (temp / "output.go").read_bytes() != (ROOT / output).read_bytes():
                raise RuntimeError(f"Generated output is stale: {output}")

    def typescript(self) -> None:
        self.install()
        if not self.check:
            self.run(
                self.node_image, "npm", "run", "prebuild", "--workspace=@semiont/core"
            )
            return
        # The core chain writes build-derived output and has no aggregate --check.
        # Run it on an isolated tree and compare only the repository's committed files.
        with tempfile.TemporaryDirectory(dir=self.cache) as directory:
            temp = Path(directory)
            for relative in ("protocol/specs", "packages/codegen", "packages/typescript/core"):
                shutil.copytree(
                    ROOT / relative,
                    temp / relative,
                    ignore=shutil.ignore_patterns(
                        "node_modules", "dist", "__pycache__"
                    ),
                )
            shutil.copy2(ROOT / "package.json", temp / "package.json")
            self.run(
                self.node_image,
                "npm",
                "run",
                "prebuild",
                "--workspace=@semiont/core",
                root=temp,
                mounts=((ROOT / "node_modules", "/workspace/node_modules"),),
            )
            tracked = (
                subprocess.check_output(
                    ["git", "ls-files", "-z", "packages/typescript/core"], cwd=ROOT
                )
                .decode()
                .split("\0")
            )
            for relative in filter(None, tracked):
                if (ROOT / relative).read_bytes() != (temp / relative).read_bytes():
                    raise RuntimeError(f"Generated output is stale: {relative}")

    def group(self, name: str) -> None:
        if name in self.done:
            return
        self.done.add(name)
        suffix = ":check" if self.check else ""
        if name == "typescript":
            self.group("bus")
            self.typescript()
        elif name == "python":
            self.npm("generate:python" + suffix)
            self.bundle()
            self.run(
                self.python_image,
                "sh",
                "-c",
                "pip install --quiet uv && UV_PROJECT_ENVIRONMENT=/venv uv run --project packages/python/sdk --locked "
                "python packages/python/sdk/scripts/generate_models.py"
                + (" --check" if self.check else ""),
            )
        elif name == "go":
            self.group("bus")
            self.npm("generate:go" + suffix)
            self.bundle()
            self.go_directive("packages/go/sdk/api/generate.go")
            self.run(
                self.node_image,
                "node",
                "packages/go/sdk/scripts/check-go-schema-coverage.mjs",
            )
        elif name == "discovery-go":
            self.go_directive("packages/go/launcher/discovery.go")
        else:
            if name in ("encoding-cases", "model-catalogue"):
                self.install()
            self.npm("generate:" + name + suffix)


def main() -> None:
    if len(sys.argv) != 2:
        raise RuntimeError("Supply generate[-GROUP] or check-generated[-GROUP]")
    match = re.fullmatch(r"(generate|check-generated)(?:-(.+))?", sys.argv[1])
    if match is None or (match[2] is not None and match[2] not in GROUPS):
        raise RuntimeError("Unknown generation operation: " + sys.argv[1])
    generation = Generation(check=match[1] == "check-generated")
    for group in GROUPS if match[2] is None else (match[2],):
        generation.group(group)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
