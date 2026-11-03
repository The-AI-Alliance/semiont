"""The content identity shared by image planning and verified image builds."""

import hashlib
import json
import re
import shlex
import sys
import urllib.parse
import urllib.request
from pathlib import Path


def signature(
    root: Path, dockerfile: Path, registry: str, rust: str, python: str
) -> str:
    contents = dockerfile.read_bytes()
    text = contents.decode().replace("\\\n", " ")
    sources = hashlib.sha256()
    pending = []
    for line in text.splitlines():
        if re.search(r"\bnpm install\b", line) and not line.lstrip().startswith("#"):
            pending += re.findall(r"@semiont/[a-z-]+", line)
        if not re.match(r"^\s*COPY\s", line, re.IGNORECASE):
            continue
        words = shlex.split(line, comments=True)
        if (
            not words
            or words[0].upper() != "COPY"
            or any(word.startswith("--from") for word in words)
        ):
            continue
        for source in [word for word in words[1:-1] if not word.startswith("--")]:
            path = root / source
            if not path.exists():
                raise FileNotFoundError(f"Dockerfile COPY input is missing: {source}")
            files = (
                [path]
                if path.is_file()
                else sorted(file for file in path.rglob("*") if file.is_file())
            )
            for file in files:
                sources.update(str(file.relative_to(root)).encode())
                sources.update(file.read_bytes())
    parts = [
        "dockerfile:" + hashlib.sha256(contents).hexdigest(),
        "sources:" + sources.hexdigest(),
    ]
    # These are the build's derived ARG values, not another set of toolchain pins.
    for name, value in (("RUST_TOOLCHAIN", rust), ("PYTHON_FLOOR", python)):
        if re.search(r"^ARG " + name + r"(?:=|\s|$)", text, re.MULTILINE):
            parts.append(f"{name}:{value}")
    integrity = {}
    try:
        while pending:
            name = pending.pop()
            if name in integrity:
                continue
            url = registry.rstrip("/") + "/" + urllib.parse.quote(name, safe="")
            with urllib.request.urlopen(url, timeout=10) as response:
                package = json.load(response)
            latest = package["versions"][package["dist-tags"]["latest"]]
            integrity[name] = latest["dist"]["integrity"]
            pending += [
                dep
                for dep in latest.get("dependencies", {})
                if dep.startswith("@semiont/") and dep not in integrity
            ]
    except (OSError, ValueError, KeyError):
        # An unknown dependency identity never permits a cached image to be skipped.
        return ""
    return " ".join(
        parts + [name + ":" + integrity[name] for name in sorted(integrity)]
    )


if __name__ == "__main__":
    try:
        print(
            signature(
                Path(sys.argv[1]), Path(sys.argv[1]) / sys.argv[2], *sys.argv[3:6]
            )
        )
    except OSError as error:
        sys.exit(str(error))
