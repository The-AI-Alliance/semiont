"""What this project is made of, each part held to its rule.

Hand-written code states no type by force: it has no `cast`, names no `Any`,
and silences no checker. What the manifest says a second time, after the
SDK's, says the same. What it requires is what the source imports, and the
SDK it is checked against is the one in this repository. It is the services'
own code: it ships its types to them, no index takes it, every Python service
of the repository is built on it, and none keeps a copy of a module of it.
Two modules name OpenTelemetry and one what exports, one makes a request of
its own, and nothing here reads the process's environment or its arguments:
a service hands them in.
"""

import re
import sys
import tomllib
from pathlib import Path

from pydantic import JsonValue, TypeAdapter
from spec import PROJECT, ROOT, SDK

SRC = PROJECT / "src/semiont_service"
SOURCES = sorted(path for top in ("src", "tests") for path in (PROJECT / top).rglob("*.py"))
SERVICES = sorted(path.parent for path in ROOT.glob("images/*/pyproject.toml"))

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
    assert sorted(path.name for path in SRC.rglob("*.py")) == [
        "__init__.py",
        "archivist.py",
        "catalog.py",
        "config.py",
        "connect.py",
        "content.py",
        "follower.py",
        "health.py",
        "lanes.py",
        "log.py",
        "observability.py",
        "white_space.py",
    ]


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
    assert set(tools(ours, "dev")) == set(checkers)
    assert tools(ours, "dev") == {name: tools(theirs, "dev")[name] for name in checkers}

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
    # A distribution is imported by its own name, but for OpenTelemetry's three: its API, its SDK and its OTLP exporter
    # are each a part of the one package.
    part_of_opentelemetry = {
        "opentelemetry-api": "opentelemetry",
        "opentelemetry-sdk": "opentelemetry.sdk",
        "opentelemetry-exporter-otlp-proto-http": "opentelemetry.exporter.otlp.proto.http",
    }
    names = set(map(name_of, required(toml(PROJECT / "pyproject.toml"))))
    declared = {"opentelemetry" if name in part_of_opentelemetry else name.replace("-", "_") for name in names}
    everything = imported(sorted(SRC.rglob("*.py")))
    roots = {module.split(".")[0] for module in everything}
    # Every module imported from outside the standard library is declared, and nothing declared goes unused.
    assert roots - set(sys.stdlib_module_names) - {"semiont_service"} == declared
    assert declared == {"httpx", "opentelemetry", "pydantic", "semiont"}
    # The one request a service makes itself is for a resource's bytes, of the Archivist.
    assert modules({"httpx"}) == ["archivist.py"]
    assert names >= set(part_of_opentelemetry)
    for distribution, part in part_of_opentelemetry.items():
        assert any(module == part or module.startswith(f"{part}.") for module in everything), f"nothing imports {distribution}"
    # The API is what is left of OpenTelemetry once the other two are taken away, and something imports that too.
    others = tuple(part for part in part_of_opentelemetry.values() if part != "opentelemetry")
    assert any(module.split(".")[0] == "opentelemetry" and not module.startswith(others) for module in everything)


def test_what_exports_a_service_s_telemetry_is_at_the_versions_the_sdk_states_for_its_own_drivers() -> None:
    # OpenTelemetry's SDK and its exporter are no dependency of the SDK's: only a process that exports takes them.
    # The SDK states their versions once, for the drivers its conformance suite runs, and this manifest says the same.
    ours = {name_of(requirement): requirement for requirement in required(toml(PROJECT / "pyproject.toml"))}
    theirs = tools(toml(SDK / "pyproject.toml"), "conformance")
    assert set(theirs) == {"opentelemetry-sdk", "opentelemetry-exporter-otlp-proto-http"}
    assert {name: ours[name] for name in theirs} == theirs


def test_a_dependency_the_sdk_bounds_is_named_here_without_a_bound_of_its_own() -> None:
    manifest = toml(PROJECT / "pyproject.toml")
    bounded_by_the_sdk = {name_of(requirement) for requirement in required(toml(SDK / "pyproject.toml"))}
    assert bounded_by_the_sdk >= {"httpx", "opentelemetry-api", "pydantic"}
    # The repository's own packages are at the repository's one version, wherever they are named.
    of_the_repository = set(table(table(table(manifest["tool"], "tool")["uv"], "uv")["sources"], "sources"))
    for requirement in required(manifest):
        if name_of(requirement) in bounded_by_the_sdk | of_the_repository:
            assert requirement == name_of(requirement), f"{requirement}: the versions of {name_of(requirement)} are stated elsewhere"


def test_the_sdk_is_the_one_in_this_repository() -> None:
    sources = table(table(table(toml(PROJECT / "pyproject.toml")["tool"], "tool")["uv"], "uv")["sources"], "sources")
    assert sources == {"semiont": {"path": "../sdk", "editable": True}}
    assert (PROJECT / "../sdk").resolve() == SDK.resolve()
    # And the lockfile took it from there.
    locked = toml(PROJECT / "uv.lock")["package"]
    assert isinstance(locked, list)
    taken_from = {table(package, "a package")["name"]: table(package, "a package")["source"] for package in locked}
    assert taken_from["semiont"] == {"editable": "../sdk"}
    assert taken_from["semiont-service"] == {"editable": "."}


def test_it_is_the_services_own_code_and_every_python_service_is_built_on_it() -> None:
    # Beside its modules, the marker of a typed package: the services are checked against its types.
    beside = sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*") if path.is_file() and path.suffix not in (".py", ".pyc"))
    assert beside == ["py.typed"]
    # No index takes an upload that says this.
    project = table(toml(PROJECT / "pyproject.toml")["project"], "project")
    assert "Private :: Do Not Upload" in texts(project["classifiers"], "classifiers")
    # Every Python service of the repository requires it, takes it from here, and no package of the repository does.
    assert len(SERVICES) >= 2
    for service in SERVICES:
        manifest = toml(service / "pyproject.toml")
        assert "semiont-service" in required(manifest), f"images/{service.name} is not built on semiont-service"
        sources = table(table(table(manifest["tool"], "tool")["uv"], "uv")["sources"], "sources")
        assert sources["semiont-service"] == {"path": "../../packages/python/service", "editable": True}, service.name
    for package in sorted(path.parent for path in ROOT.glob("packages/python/*/pyproject.toml")):
        if package != PROJECT:
            requires = {name_of(requirement) for requirement in required(toml(package / "pyproject.toml"))}
            assert "semiont-service" not in requires, package.name


def test_no_service_keeps_a_copy_of_a_module_here() -> None:
    # What a service is called and its one logger are its own, and so is what of its document only it has: a service
    # has a `config.py` and a `log.py`. How a document is read and how a log is written are stated here and nowhere else,
    # and so are how a service follows the record, the order it does each resource's work in and how it reads the
    # catalog whole. So are what reads a resource's bytes and the reader that asks the Archivist for them and for its
    # annotations, what white space is, and how long a start waits for what it connects to.
    stated_here = {
        "archivist.py": ("class Archivist(", "class AnnotationReads", "class Authorizes", "class AnnotationsUnread"),
        "catalog.py": ("_UNTIL_THE_ARCHIVIST_ANSWERS", "bus.peer-unavailable"),
        "config.py": ("def config_path_of(", "def read_config", "def service_account_of(", "def set_in("),
        "connect.py": ("def connected", "_CONNECT_SECONDS"),
        "content.py": ("class ContentReads", "class ContentUnread"),
        "follower.py": ("class Follower",),
        "health.py": ("def bind_health(",),
        "lanes.py": ("class Lanes",),
        "log.py": ("def configure(", "logging.Formatter"),
        "observability.py": ("def install(", "def report_the_process(", "class Exporting"),
        "white_space.py": ("WHITE_SPACE: Final",),
    }
    for module, marks in stated_here.items():
        ours = (SRC / module).read_text(encoding="utf-8")
        for mark in marks:
            assert mark in ours, f"{module} no longer states {mark}"
    for service in SERVICES:
        for path in sorted((service / "src").rglob("*.py")):
            source = path.read_text(encoding="utf-8")
            for marks in stated_here.values():
                for mark in marks:
                    assert mark not in source, f"{path.relative_to(ROOT)} states {mark}, which is semiont_service's"
        assert not list((service / "src").rglob("follower.py")), service.name
        assert not list((service / "src").rglob("health.py")), service.name
        assert not list((service / "src").rglob("lanes.py")), service.name
        assert not list((service / "src").rglob("observability.py")), service.name
        assert not list((service / "src").rglob("archivist.py")), service.name
        assert not list((service / "src").rglob("connect.py")), service.name
        assert not list((service / "src").rglob("white_space.py")), service.name


def test_two_modules_name_opentelemetry_and_one_what_exports() -> None:
    # The log reads the trace an event was logged in, through OpenTelemetry's API. What exports, the SDK and its
    # exporter, is installed by one module, which also takes the process's own readings.
    assert modules({"opentelemetry"}) == ["log.py", "observability.py"]
    assert modules({"opentelemetry.sdk", "opentelemetry.exporter"}) == ["observability.py"]


def test_nothing_here_reads_the_process_s_environment_or_its_arguments() -> None:
    # A service reads them, in one module, and hands them on: what is read here is what it was handed.
    reading = re.compile(r"\bos\.environ\b|\bos\.getenv\b|\bsys\.argv\b|\bgetenv\(")
    assert sorted(path.name for path in SRC.rglob("*.py") if reading.search(path.read_text(encoding="utf-8"))) == []
