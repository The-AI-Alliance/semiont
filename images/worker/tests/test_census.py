"""What this project is made of, each part held to its rule.

Hand-written code states no type by force: it has no `cast`, names no `Any`,
and silences no checker. What the manifest says a second time, after the
SDK's, says the same. What it requires is what the source imports, and the
SDK and the inference drivers it is checked against are the ones in this
repository. It is a service's code and no library: it carries no marker of a
typed package, no index takes it, and no other Python package of the
repository requires it. It does nothing by provider: of the inference
package it imports what a client is and no driver, but for the one module
that makes each agent's client and the one that answers for their limits.
It requires no provider's library: each is an extra, and its image asks for
every one.
One module tells OpenTelemetry of the service's work, one names the logger,
and one reads the process's environment. How its document is read, how its
log is written and what exports its telemetry are every Python service's, in
the package the service is built on (`packages/python/service`).
"""

import re
import sys
import tomllib
from pathlib import Path

from pydantic import JsonValue, TypeAdapter
from spec import PROJECT, ROOT, SDK

from semiont_worker.config import SERVICE

SRC = PROJECT / "src/semiont_worker"
SOURCES = sorted(path for top in ("src", "tests") for path in (PROJECT / top).rglob("*.py"))
INFERENCE = ROOT / "packages/python/inference"
SHARED = ROOT / "packages/python/service"

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
    """Every module the files import, as each is written: at a module's top, and where a function imports what it alone needs."""
    naming = re.compile(r"^[ ]*(?:from ([\w.]+) import |import ([\w.]+)$)", re.MULTILINE)
    return {found.group(1) or found.group(2) for path in sources for found in naming.finditer(path.read_text(encoding="utf-8"))}


def modules(names: set[str]) -> list[str]:
    """The modules of the source that import a module whose name begins with one of `names`, by their paths in the package."""
    return sorted(
        str(path.relative_to(SRC))
        for path in SRC.rglob("*.py")
        if any(module == name or module.startswith(f"{name}.") for module in imported([path]) for name in names)
    )


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

    checkers = ("mypy", "pyright", "pytest", "pytest-cov", "ruff")
    assert set(tools(ours, "dev")) == {*checkers, "semiont-worker"}
    assert {name: tools(ours, "dev")[name] for name in checkers} == {name: tools(theirs, "dev")[name] for name in checkers}

    # What each reads is its own project's; everything else is the same.
    assert settings(ours, "mypy", but=("files",)) == settings(theirs, "mypy", but=("files",))
    assert settings(ours, "pyright", but=("include",)) == settings(theirs, "pyright", but=("include",))
    assert settings(ours, "pydantic-mypy", but=()) == settings(theirs, "pydantic-mypy", but=())
    assert settings(ours, "pytest", but=()) == settings(theirs, "pytest", but=())
    # A coverage run measures its own project's source, and reports as the SDK's does.
    our_run = table(settings(ours, "coverage", but=())["run"], "coverage's run")
    their_run = table(settings(theirs, "coverage", but=())["run"], "coverage's run")
    assert {key: our_run[key] for key in our_run if key != "source"} == {key: their_run[key] for key in their_run if key != "source"}
    # The SDK's formatter is told which of its modules are generated, and its linter which of its tests are
    # programs that must not type-check. This project has neither.
    assert settings(ours, "ruff", but=("lint",)) == settings(theirs, "ruff", but=("lint", "extend-exclude"))
    our_lint = table(settings(ours, "ruff", but=())["lint"], "ruff's lint")
    their_lint = table(settings(theirs, "ruff", but=())["lint"], "ruff's lint")
    assert our_lint == {key: value for key, value in their_lint.items() if key != "per-file-ignores"}
    # Which Pythons the two run on is lint:python-version's to hold: it is the one gate that reads that line.
    assert ours["build-system"] == theirs["build-system"]


def test_what_the_manifest_requires_is_what_the_source_imports() -> None:
    # A distribution is imported by its own name, but for OpenTelemetry's API, which is imported as `opentelemetry`.
    names = set(map(name_of, required(toml(PROJECT / "pyproject.toml"))))
    declared = {"opentelemetry" if name == "opentelemetry-api" else name.replace("-", "_") for name in names}
    everything = imported(sorted(SRC.rglob("*.py")))
    roots = {module.split(".")[0] for module in everything}
    # Every module imported from outside the standard library is declared, and nothing declared goes unused.
    assert roots - set(sys.stdlib_module_names) - {"semiont_worker"} == declared
    assert declared == {"opentelemetry", "pydantic", "semiont", "semiont_inference", "semiont_service"}
    # Of OpenTelemetry the service takes the API alone. What exports, its SDK and its exporter, is the shared
    # package's to require, at the versions its own manifest states, and to import.
    assert not names & {"opentelemetry-sdk", "opentelemetry-exporter-otlp-proto-http"}
    assert not any(module.startswith(("opentelemetry.sdk", "opentelemetry.exporter")) for module in everything)


def test_a_dependency_the_sdk_bounds_is_named_here_without_a_bound_of_its_own() -> None:
    manifest = toml(PROJECT / "pyproject.toml")
    bounded_by_the_sdk = {name_of(requirement) for requirement in required(toml(SDK / "pyproject.toml"))}
    assert bounded_by_the_sdk >= {"opentelemetry-api", "pydantic"}
    # The repository's own packages are at the repository's one version, wherever they are named.
    of_the_repository = set(table(table(table(manifest["tool"], "tool")["uv"], "uv")["sources"], "sources"))
    for requirement in required(manifest):
        if name_of(requirement) in bounded_by_the_sdk | of_the_repository:
            assert requirement == name_of(requirement), f"{requirement}: the versions of {name_of(requirement)} are stated elsewhere"


def test_the_sdk_the_inference_drivers_and_the_service_package_are_the_ones_in_this_repository() -> None:
    # The manifest names each by its path here. A source another package states for the SDK is read only where
    # that package is the project, so without the SDK's own line here the SDK would come from an index.
    sources = table(table(table(toml(PROJECT / "pyproject.toml")["tool"], "tool")["uv"], "uv")["sources"], "sources")
    assert sources == {
        "semiont": {"path": "../../packages/python/sdk", "editable": True},
        "semiont-inference": {"path": "../../packages/python/inference", "editable": True},
        "semiont-service": {"path": "../../packages/python/service", "editable": True},
    }
    assert (PROJECT / "../../packages/python/sdk").resolve() == SDK.resolve()
    assert (PROJECT / "../../packages/python/inference").resolve() == INFERENCE.resolve()
    assert (PROJECT / "../../packages/python/service").resolve() == SHARED.resolve()
    # And the lockfile took each from there.
    locked = toml(PROJECT / "uv.lock")["package"]
    assert isinstance(locked, list)
    taken_from = {table(package, "a package")["name"]: table(package, "a package")["source"] for package in locked}
    assert taken_from["semiont"] == {"editable": "../../packages/python/sdk"}
    assert taken_from["semiont-inference"] == {"editable": "../../packages/python/inference"}
    assert taken_from["semiont-service"] == {"editable": "../../packages/python/service"}
    assert taken_from["semiont-worker"] == {"editable": "."}


def test_the_distribution_is_named_for_the_service() -> None:
    # Its telemetry is exported under its word for itself after `semiont-`, at the version of the distribution of
    # that name (`semiont_service.observability`): the manifest's name is that, or an exporting service does not start.
    assert table(toml(PROJECT / "pyproject.toml")["project"], "project")["name"] == f"semiont-{SERVICE}"


def test_it_is_a_service_s_code_and_no_library() -> None:
    # Nothing beside its modules: no marker of a typed package, which is for whoever imports one, and no data.
    beside = sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*") if path.is_file() and path.suffix not in (".py", ".pyc"))
    assert beside == []
    # No index takes an upload that says this.
    project = table(toml(PROJECT / "pyproject.toml")["project"], "project")
    assert "Private :: Do Not Upload" in texts(project["classifiers"], "classifiers")
    # And no other Python package of the repository requires it.
    for package in (SDK, INFERENCE, SHARED):
        assert "semiont-worker" not in {name_of(requirement) for requirement in required(toml(package / "pyproject.toml"))}, package.name


def test_the_source_does_nothing_by_provider() -> None:
    # What differs between providers is said by the client. Of the inference package the source imports
    # what a client is, what it answers and how it fails, and names no driver.
    beyond_what_a_client_is = {
        # The module that boots the service makes each agent's client, from what the configuration document names.
        "service.py": {"semiont_inference.factory"},
        # The module that is one agent answers a request for the limits of the service's models.
        "agent.py": {"semiont_inference.limits_report"},
    }
    for path in sorted(SRC.rglob("*.py")):
        of_inference = {module for module in imported([path]) if module.split(".")[0] == "semiont_inference"}
        allowed = beyond_what_a_client_is.get(str(path.relative_to(SRC)), set())
        assert of_inference - {"semiont_inference.interface"} == allowed, path.name
    # Each of the two exists, and imports what it is allowed.
    assert modules({"semiont_inference.factory"}) == ["service.py"]
    assert modules({"semiont_inference.limits_report"}) == ["agent.py"]


def test_one_module_names_opentelemetry_and_one_names_the_logger() -> None:
    # What the service tells OpenTelemetry of its work is the rows of one table, and has one module. What the
    # service logs goes through one logger. Every other module asks these.
    assert modules({"opentelemetry"}) == ["telemetry.py"]
    sources = sorted(SRC.rglob("*.py"))
    assert sorted(str(path.relative_to(SRC)) for path in sources if "getLogger(" in path.read_text(encoding="utf-8")) == ["log.py"]
    assert (SRC / "log.py").read_text(encoding="utf-8").count('getLogger("semiont_worker")') == 1


def test_one_module_reads_the_process_s_environment_and_the_variables_read_are_the_ones_the_protocol_lists() -> None:
    sources = {str(path.relative_to(SRC)): path.read_text(encoding="utf-8") for path in sorted(SRC.rglob("*.py"))}
    # The process's environment and its arguments are read in one place, and handed on from there.
    reading = re.compile(r"\bos\.environ\b|\bos\.getenv\b|\bsys\.argv\b|\bgetenv\(")
    assert sorted(name for name, source in sources.items() if reading.search(source)) == ["service.py"]

    # Every variable the service's code names, its own and the shared package's it is built on, as a variable's
    # name is written: capitals, joined by underscores.
    shared = [path.read_text(encoding="utf-8") for path in sorted((SHARED / "src").rglob("*.py"))]
    assert shared, "packages/python/service has no source: the variables it reads for the service are not seen"
    # A module's `__all__` names what it exports, in quotes too: a constant's name there is no variable read.
    texts = [re.sub(r"^__all__ = \[.*?\]$", "", source, flags=re.DOTALL | re.MULTILINE) for source in (*sources.values(), *shared)]
    named = {found for text in texts for found in re.findall(r'"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"', text)}
    document = (ROOT / "docs/protocol/WORKER-SERVICE.md").read_text(encoding="utf-8")
    section = re.search(r"\n## Environment\n(.*?)\n## ", document, re.DOTALL)
    assert section is not None
    listed = set(re.findall(r"`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`", section.group(1)))
    assert len(listed) >= 14
    not_read_here = {
        # Named by the section as the two the service does not read: how much it logs is its document's to say.
        "LOG_LEVEL",
        "LOG_FORMAT",
        # Read by OpenTelemetry's SDK, and not by the service's own code (E8).
        "OTEL_BSP_SCHEDULE_DELAY",
        # Read by the SDK, whose transport writes the bus log, and not by the service's own code (E9).
        "SEMIONT_BUS_LOG",
    }
    assert not_read_here <= listed
    assert named == listed - not_read_here


def test_a_providers_library_is_an_extra_and_the_image_asks_for_every_one() -> None:
    manifest = toml(PROJECT / "pyproject.toml")
    # The service requires the drivers, and no provider's library with them.
    assert "semiont-inference" in required(manifest)
    # An extra for each of the drivers' extras, of the same name, which brings that one and nothing else.
    of_the_drivers = table(table(toml(INFERENCE / "pyproject.toml")["project"], "project")["optional-dependencies"], "the drivers' extras")
    extras = table(table(manifest["project"], "project")["optional-dependencies"], "optional-dependencies")
    assert {extra: texts(brought, f"the extra {extra}") for extra, brought in extras.items()} == {
        extra: [f"semiont-inference[{extra}]"] for extra in of_the_drivers
    }
    # The image asks for every one, and so does the environment the checkers and the tests run in.
    syncs = [line.split() for line in (PROJECT / "Dockerfile").read_text(encoding="utf-8").splitlines() if line.startswith("RUN uv sync ")]
    assert len(syncs) == 1
    assert "--all-extras" in syncs[0]
    dev = texts(table(manifest["dependency-groups"], "dependency-groups")["dev"], "the dev group")
    assert f"semiont-worker[{','.join(sorted(extras))}]" in dev
