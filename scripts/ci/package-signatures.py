"""What local-build.sh builds of packages/, and the signature that says whether each changed.

A package is a directory packages/<language>/<name> holding its language's manifest. Its
signature is one line capturing everything its build reads:

- the toolchain image that builds it (argv: the TypeScript, Rust, Python, Go and Kotlin
  images, in that order);
- every file under its directory;
- what every package of the repository is built from: version.json, the spec, and the
  scripts that generate from the spec;
- what its language's packages share: for TypeScript the files beside them and the root's
  package.json and lockfile, for Rust the workspace's manifest, lockfile and toolchain (a
  Kotlin package's lockfile, wrapper and version catalog are its own files);
- the signature of each package of the repository it depends on, and every file of each
  other directory it does: the closure, read from its manifest, so a change to a package
  it is built on changes it too.

stdin is what the repository holds, NUL-separated, as `git ls-files -z --cached --others
--exclude-standard` lists it on the host: git refuses a checkout another user owns, as a
root container sees one. Each line out is a package: its directory, its language, the
name its build takes, its signature, and the output a build leaves in it ('' for none).
"""

import hashlib
import json
import os
import re
import sys
import tomllib
from pathlib import Path

MANIFESTS = {"package.json": "typescript", "Cargo.toml": "rust", "pyproject.toml": "python", "go.mod": "go", "build.gradle.kts": "kotlin"}
EVERY_PACKAGE = ("version.json", "specs/src/", "scripts/spec/", "scripts/bus/")
SHARED = {
    "typescript": ("package.json", "package-lock.json"),
    "rust": ("packages/rust/Cargo.toml", "packages/rust/Cargo.lock", "packages/rust/rust-toolchain.toml"),
    "python": (),
    "go": (),
    "kotlin": (),
}

toolchains = dict(zip(("typescript", "rust", "python", "go", "kotlin"), sys.argv[1:6], strict=True))
files = sorted(f for f in sys.stdin.buffer.read().decode().split("\0") if f)


def toml(path: str) -> dict:
    return tomllib.loads(Path(path).read_text())


def manifest_json(path: str) -> dict:
    return json.loads(Path(path).read_text())


def digest(paths: list[str]) -> str:
    h = hashlib.sha256()
    for path in paths:
        h.update(path.encode() + b"\0")
        # A link is its target, not what it points at: the spec it reaches is hashed as the spec.
        h.update(str(Path(path).readlink()).encode() if Path(path).is_symlink() else Path(path).read_bytes())
        h.update(b"\0")
    return h.hexdigest()


def under(prefix: str) -> list[str]:
    return [f for f in files if f == prefix or f.startswith(prefix.rstrip("/") + "/")]


packages: dict[str, dict[str, str]] = {}
for f in files:
    m = re.fullmatch(r"packages/([^/]+)/([^/]+)/([^/]+)", f)
    if m and MANIFESTS.get(m[3]) == m[1]:
        packages[f"packages/{m[1]}/{m[2]}"] = {"language": m[1], "manifest": f}
if not packages:
    sys.exit("package-signatures: found no package under packages/<language>/<name>")

npm_dirs = {manifest_json(p["manifest"])["name"]: d for d, p in packages.items() if p["language"] == "typescript"}
workspace = toml("packages/rust/Cargo.toml").get("workspace", {}).get("dependencies", {})


def resolve(base: str, relative: str) -> str:
    return os.path.normpath(os.path.join(base, relative))


def dependencies(directory: str) -> set[str]:
    """The directories of the repository this package is built on, from its manifest."""
    language, manifest = packages[directory]["language"], packages[directory]["manifest"]
    found: set[str] = set()
    if language == "typescript":
        stated = manifest_json(manifest)
        for table in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            found |= {npm_dirs[name] for name in stated.get(table, {}) if name in npm_dirs}
    elif language == "rust":
        stated = toml(manifest)
        tables = [stated.get(t, {}) for t in ("dependencies", "dev-dependencies", "build-dependencies")]
        tables += [
            target.get(t, {})
            for target in stated.get("target", {}).values()
            for t in ("dependencies", "dev-dependencies", "build-dependencies")
        ]
        for table in tables:
            for name, spec in table.items():
                if not isinstance(spec, dict):
                    continue
                if "path" in spec:
                    found.add(resolve(directory, spec["path"]))
                elif spec.get("workspace") and "path" in workspace.get(name, {}):
                    found.add(resolve("packages/rust", workspace[name]["path"]))
    elif language == "python":
        stated = toml(manifest)
        for spec in stated.get("tool", {}).get("uv", {}).get("sources", {}).values():
            if isinstance(spec, dict) and "path" in spec:
                found.add(resolve(directory, spec["path"]))
    elif language == "go":
        for target in re.findall(r"=>\s*(\.{1,2}/\S*)", Path(manifest).read_text()):
            found.add(resolve(directory, target))
    found.discard(directory)
    return found


every_package = digest([f for prefix in EVERY_PACKAGE for f in under(prefix)])
signatures: dict[str, str] = {}


def signature(directory: str, seen: tuple[str, ...] = ()) -> str:
    if directory in signatures:
        return signatures[directory]
    if directory in seen:
        sys.exit(f"package-signatures: {' -> '.join((*seen, directory))} depend on one another")
    language = packages[directory]["language"]
    shared = [f for f in files if f in SHARED[language]]
    if language == "typescript":
        shared += [f for f in files if re.fullmatch(r"packages/typescript/[^/]+", f)]
    parts = [f"toolchain:{toolchains[language]}", f"every:{every_package}", f"shared:{digest(shared)}", f"own:{digest(under(directory))}"]
    for dependency in sorted(dependencies(directory)):
        if dependency in packages:
            parts.append(f"{dependency}:{signature(dependency, (*seen, directory))}")
        elif under(dependency):
            parts.append(f"{dependency}:{digest(under(dependency))}")
        else:
            sys.exit(f"package-signatures: {packages[directory]['manifest']} depends on {dependency}, which the repository does not hold")
    signatures[directory] = hashlib.sha256("\n".join(parts).encode()).hexdigest()
    return signatures[directory]


for directory in sorted(packages):
    language = packages[directory]["language"]
    if language == "rust":
        name = toml(packages[directory]["manifest"])["package"]["name"]
    else:
        name = directory.rsplit("/", 1)[1]
    output = f"{directory}/dist" if language in ("typescript", "python") else ""
    print("\t".join((directory, language, name, signature(directory), output)))
