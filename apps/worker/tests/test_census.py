"""What this project is made of, each part held to its rule.

Hand-written code states no type by force: it has no `cast`, names no `Any`,
and silences no checker. What the manifest says a second time, after the
SDK's, says the same. What it requires is what the source imports, and the
SDK and the inference drivers it is checked against are the ones in this
repository. It is a service's code and no library: it carries no marker of a
typed package, no index takes it, and no other Python package of the
repository requires it. It does nothing by provider: of the inference
package it imports what a client is, and no driver. And one module names
OpenTelemetry, and one names the logger.
"""

import re
import sys
import tomllib
from pathlib import Path

from pydantic import JsonValue, TypeAdapter
from spec import PROJECT, ROOT, SDK

SRC = PROJECT / "src/semiont_worker"
SOURCES = sorted(path for top in ("src", "tests") for path in (PROJECT / top).rglob("*.py"))
INFERENCE = ROOT / "packages/inference-python"

FORCED = re.compile(r"\bcast\(|#\s*type:\s*ignore|#\s*pyright:\s*ignore|#\s*noqa\b|\btyping\.Any\b|^\s*from typing import [^\n]*\bAny\b")

type Toml = dict[str, JsonValue]

_TOML = TypeAdapter[Toml](Toml)


def toml(path: Path) -> Toml:
    """The table a TOML file holds."""
    with path.open("rb") as file:
        return _TOML.validate_python(tomllib.load(file))


def table(value: JsonValue, what: str) -> Toml:
    """`value`, which is a table."""
    assert isinstance(value, dict), f"{what} is not a table"
    return value


def texts(value: JsonValue, what: str) -> list[str]:
    """`value`, which is a list of text."""
    assert isinstance(value, list), f"{what} is not a list"
    found: list[str] = []
    for item in value:
        assert isinstance(item, str), f"{what} holds something that is not text"
        found.append(item)
    return found


def name_of(requirement: str) -> str:
    """The distribution a requirement names, without its extras and its versions."""
    return re.split(r"[\[=<>!~ ]", requirement, maxsplit=1)[0]


def required(manifest: Toml) -> list[str]:
    """What a project requires, as its manifest writes each requirement."""
    return texts(table(manifest["project"], "project")["dependencies"], "dependencies")


def tools(manifest: Toml, group: str) -> dict[str, str]:
    """What a group of a project's manifest brings, each with the requirement that names it."""
    stated = table(manifest["dependency-groups"], "dependency-groups")[group]
    return {name_of(requirement): requirement for requirement in texts(stated, f"the {group} group")}


def settings(manifest: Toml, tool: str, *, but: tuple[str, ...]) -> Toml:
    """What a manifest tells one tool, less the settings named."""
    return {key: value for key, value in table(table(manifest["tool"], "tool")[tool], tool).items() if key not in but}


def imported(sources: list[Path]) -> set[str]:
    """Every module the files import, as each is written."""
    naming = re.compile(r"^(?:from ([\w.]+) import |import ([\w.]+))", re.MULTILINE)
    return {found.group(1) or found.group(2) for path in sources for found in naming.finditer(path.read_text(encoding="utf-8"))}


def test_the_walk_found_the_project() -> None:
    assert len(SOURCES) > 10
    assert len(list(SRC.rglob("*.py"))) > 5


def test_no_hand_written_line_forces_a_type_or_silences_a_checker() -> None:
    forced = [
        f"{path.relative_to(PROJECT)}:{number}: {line.strip()}"
        for path in SOURCES
        if path.name != "test_census.py"
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if FORCED.search(line)
    ]
    assert forced == []


def test_the_checkers_and_their_strictness_are_the_sdks() -> None:
    # This project's manifest states them a second time. A pin or a setting moved in one and not the other fails here.
    ours, theirs = toml(PROJECT / "pyproject.toml"), toml(SDK / "pyproject.toml")

    checkers = ("mypy", "pyright", "pytest", "ruff")
    assert set(tools(ours, "dev")) == {*checkers, "opentelemetry-sdk"}
    assert {name: tools(ours, "dev")[name] for name in checkers} == {name: tools(theirs, "dev")[name] for name in checkers}
    # What reads this service's telemetry in memory is what the SDK's conformance drivers export theirs with, as the SDK states it.
    assert tools(ours, "dev")["opentelemetry-sdk"] == tools(theirs, "conformance")["opentelemetry-sdk"]

    # What each reads is its own project's; everything else is the same.
    assert settings(ours, "mypy", but=("files",)) == settings(theirs, "mypy", but=("files",))
    assert settings(ours, "pyright", but=("include",)) == settings(theirs, "pyright", but=("include",))
    assert settings(ours, "pydantic-mypy", but=()) == settings(theirs, "pydantic-mypy", but=())
    assert settings(ours, "pytest", but=()) == settings(theirs, "pytest", but=())
    # The SDK's formatter is told which of its modules are generated, and its linter which of its tests are
    # programs that must not type-check. This project has neither.
    assert settings(ours, "ruff", but=("lint",)) == settings(theirs, "ruff", but=("lint", "extend-exclude"))
    our_lint = table(settings(ours, "ruff", but=())["lint"], "ruff's lint")
    their_lint = table(settings(theirs, "ruff", but=())["lint"], "ruff's lint")
    assert our_lint == {key: value for key, value in their_lint.items() if key != "per-file-ignores"}
    # Which Pythons the two run on is lint:python-version's to hold: it is the one gate that reads that line.
    assert ours["build-system"] == theirs["build-system"]


def test_what_the_manifest_requires_is_what_the_source_imports() -> None:
    # A distribution is imported by its own name, but for the one named here.
    imported_as = {"opentelemetry-api": "opentelemetry"}
    declared = {imported_as.get(name, name.replace("-", "_")) for name in map(name_of, required(toml(PROJECT / "pyproject.toml")))}
    roots = {module.split(".")[0] for module in imported(sorted(SRC.rglob("*.py")))}
    # Every module imported from outside the standard library is declared, and nothing declared goes unused.
    assert roots - set(sys.stdlib_module_names) - {"semiont_worker"} == declared
    assert declared == {"opentelemetry", "pydantic", "semiont", "semiont_inference"}


def test_a_dependency_the_sdk_bounds_is_named_here_without_a_bound_of_its_own() -> None:
    manifest = toml(PROJECT / "pyproject.toml")
    bounded_by_the_sdk = {name_of(requirement) for requirement in required(toml(SDK / "pyproject.toml"))}
    assert bounded_by_the_sdk >= {"opentelemetry-api", "pydantic"}
    # The repository's own packages are at the repository's one version, wherever they are named.
    of_the_repository = set(table(table(table(manifest["tool"], "tool")["uv"], "uv")["sources"], "sources"))
    for requirement in required(manifest):
        if name_of(requirement) in bounded_by_the_sdk | of_the_repository:
            assert requirement == name_of(requirement), f"{requirement}: the versions of {name_of(requirement)} are stated elsewhere"


def test_the_sdk_and_the_inference_drivers_are_the_ones_in_this_repository() -> None:
    # The manifest names both by their paths here. A source the inference package states for the SDK is read
    # only where that package is the project, so without the SDK's own line here the SDK would come from an index.
    sources = table(table(table(toml(PROJECT / "pyproject.toml")["tool"], "tool")["uv"], "uv")["sources"], "sources")
    assert sources == {
        "semiont": {"path": "../../packages/sdk-python", "editable": True},
        "semiont-inference": {"path": "../../packages/inference-python", "editable": True},
    }
    assert (PROJECT / "../../packages/sdk-python").resolve() == SDK.resolve()
    assert (PROJECT / "../../packages/inference-python").resolve() == INFERENCE.resolve()
    # And the lockfile took each from there.
    locked = toml(PROJECT / "uv.lock")["package"]
    assert isinstance(locked, list)
    taken_from = {table(package, "a package")["name"]: table(package, "a package")["source"] for package in locked}
    assert taken_from["semiont"] == {"editable": "../../packages/sdk-python"}
    assert taken_from["semiont-inference"] == {"editable": "../../packages/inference-python"}
    assert taken_from["semiont-worker"] == {"editable": "."}


def test_it_is_a_service_s_code_and_no_library() -> None:
    # Nothing beside its modules: no marker of a typed package, which is for whoever imports one, and no data.
    beside = sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*") if path.is_file() and path.suffix not in (".py", ".pyc"))
    assert beside == []
    # No index takes an upload that says this.
    project = table(toml(PROJECT / "pyproject.toml")["project"], "project")
    assert "Private :: Do Not Upload" in texts(project["classifiers"], "classifiers")
    # And no other Python package of the repository requires it.
    for package in (SDK, INFERENCE):
        assert "semiont-worker" not in {name_of(requirement) for requirement in required(toml(package / "pyproject.toml"))}, package.name


def test_the_source_does_nothing_by_provider() -> None:
    # What differs between providers is said by the client. Of the inference package the source imports
    # what a client is, what it answers and how it fails, and names no driver.
    of_inference = {module for module in imported(sorted(SRC.rglob("*.py"))) if module.split(".")[0] == "semiont_inference"}
    assert of_inference == {"semiont_inference.interface"}


def test_one_module_names_opentelemetry_and_one_names_the_logger() -> None:
    # What the service tells OpenTelemetry is the rows of one table, and what it logs goes through one logger:
    # each has one module, and every other module asks that one.
    sources = sorted(SRC.rglob("*.py"))
    assert sorted(
        str(path.relative_to(SRC)) for path in sources if "opentelemetry" in {module.split(".")[0] for module in imported([path])}
    ) == ["telemetry.py"]
    assert sorted(str(path.relative_to(SRC)) for path in sources if "getLogger(" in path.read_text(encoding="utf-8")) == ["log.py"]
    assert (SRC / "log.py").read_text(encoding="utf-8").count('getLogger("semiont_worker")') == 1
