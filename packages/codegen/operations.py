"""Metadata operations executed inside the codegen Python tooling container."""

import json
import shlex
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GROUPS = tuple(Path(__file__).with_name("groups.txt").read_text().splitlines())


def go_command(source: str) -> tuple[list[str], str]:
    text = (ROOT / source).read_text()
    directive = next(
        line for line in text.splitlines() if line.startswith("//go:generate ")
    )
    command = shlex.split(directive.split(" go run ", 1)[1].removesuffix('"'))
    return command, command[command.index("-o") + 1]


def snapshot(cache: Path) -> Path:
    temp = Path(tempfile.mkdtemp(prefix="codegen-", dir=cache))
    for relative in ("specs", "packages/codegen", "packages/typescript/core"):
        shutil.copytree(
            ROOT / relative,
            temp / relative,
            ignore=shutil.ignore_patterns("node_modules", "dist", "__pycache__"),
        )
    shutil.copy2(ROOT / "package.json", temp / "package.json")
    tracked = list(filter(None, sys.stdin.buffer.read().decode().split("\0")))
    (temp / "tracked.json").write_text(json.dumps(tracked))
    return temp


def compare_typescript(temp: Path) -> None:
    for relative in json.loads((temp / "tracked.json").read_text()):
        if (ROOT / relative).read_bytes() != (temp / relative).read_bytes():
            raise RuntimeError(f"Generated output is stale: {relative}")


def main() -> None:
    operation, *args = sys.argv[1:]
    if operation == "go":
        command, _ = go_command(args[0])
        if args[1] == "true":
            command[command.index("-o") + 1] = "/generated/output.go"
        sys.stdout.buffer.write("\0".join(command).encode() + b"\0")
    elif operation == "compare-go":
        _, output = go_command(args[0])
        if Path(args[1]).read_bytes() != (ROOT / output).read_bytes():
            raise RuntimeError(f"Generated output is stale: {output}")
    elif operation == "snapshot":
        print(snapshot(Path(args[0])))
    elif operation == "compare-typescript":
        compare_typescript(Path(args[0]))
    elif operation == "clean":
        shutil.rmtree(args[0])
    else:
        raise RuntimeError(f"Unknown metadata operation: {operation}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        sys.exit(str(error))
