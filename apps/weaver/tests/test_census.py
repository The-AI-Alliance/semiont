"""What this project is made of, each part held to its rule.

Hand-written code states no type by force: it has no `cast`, names no `Any`,
and silences no checker. What the manifest says a second time, after the
SDK's, says the same. What it requires is what the source imports, and the
SDK and the graph stores it is checked against are the ones in this
repository. It is a service's code and no library: it carries no marker of a
typed package, no index takes it, and no other Python package of the
repository requires it. It does nothing by database: of the graph package it
imports what a store is, what the graph is to hold, and the one function
that makes a store, and no store. It requires no database's client: each is
an extra, and its image asks for every one.

What it copies from the protocol, it copies under a gate: the events it
follows are the ones the protocol's page lists, and the payload it reads
each as is the one the bus registry names. What installs its telemetry is a
copy of the Worker service's module, and is held to it.
"""

import ast
import re
import tomllib
from pathlib import Path

from pydantic import JsonValue, TypeAdapter
from spec import PROJECT, ROOT, SDK, SPEC, objects, read

from semiont_weaver.recorded import FOLLOWED, PAYLOADS

SRC = PROJECT / "src/semiont_weaver"
SOURCES = sorted(path for top in ("src", "tests") for path in (PROJECT / top).rglob("*.py"))
GRAPH = ROOT / "packages/graph-python"

FORCED = re.compile(r"\bcast\(|#\s*type:\s*ignore|#\s*pyright:\s*ignore|#\s*noqa\b|\btyping\.Any\b|^\s*from typing import [^\n]*\bAny\b")

type Toml = dict[str, JsonValue]

_TOML = TypeAdapter[Toml](Toml)


def toml(path: Path) -> Toml:
    """The table a TOML file holds."""
    with path.open("rb") as file:
        return _TOML.validate_python(tomllib.load(file))


def table(of: JsonValue, what: str) -> Toml:
    assert isinstance(of, dict), f"{what} is not a table"
    return of


def listed(of: JsonValue, what: str) -> list[str]:
    assert isinstance(of, list), f"{what} is not a list"
    found: list[str] = []
    for item in of:
        assert isinstance(item, str), f"{what} holds something that is not text"
        found.append(item)
    return found


def name_of(requirement: str) -> str:
    """The distribution a requirement names, without its extras and its versions."""
    return re.split(r"[\[=<>!~ ]", requirement, maxsplit=1)[0]


def importing(library: str) -> list[str]:
    """The modules of this project that import `library`, by their paths in it."""
    names_it = re.compile(rf"^\s*(import|from)\s+{library}\b", re.MULTILINE)
    return sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*.py") if names_it.search(path.read_text(encoding="utf-8")))


MANIFEST = toml(PROJECT / "pyproject.toml")


def test_the_walk_found_the_project() -> None:
    assert len(SOURCES) > 15


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
    theirs = toml(SDK / "pyproject.toml")

    def tools(of: Toml) -> dict[str, str]:
        dev = listed(table(of["dependency-groups"], "dependency-groups")["dev"], "dev")
        return {name_of(requirement): requirement for requirement in dev}

    shared = set(tools(MANIFEST)) & set(tools(theirs))
    assert shared >= {"mypy", "pyright", "pytest", "ruff"}
    assert {name: tools(MANIFEST)[name] for name in shared} == {name: tools(theirs)[name] for name in shared}

    def settings(of: Toml, tool: str, *, but: tuple[str, ...]) -> Toml:
        return {key: value for key, value in table(table(of["tool"], "tool")[tool], tool).items() if key not in but}

    # What each reads is its own project's; everything else is the same.
    assert settings(MANIFEST, "mypy", but=("files",)) == settings(theirs, "mypy", but=("files",))
    assert settings(MANIFEST, "pyright", but=("include",)) == settings(theirs, "pyright", but=("include",))
    assert settings(MANIFEST, "pydantic-mypy", but=()) == settings(theirs, "pydantic-mypy", but=())
    assert settings(MANIFEST, "pytest", but=()) == settings(theirs, "pytest", but=())
    # The SDK's formatter is told which of its modules are generated, and its linter which of its tests are
    # programs that must not type-check. This project has neither.
    assert settings(MANIFEST, "ruff", but=("lint",)) == settings(theirs, "ruff", but=("lint", "extend-exclude"))
    our_lint = table(settings(MANIFEST, "ruff", but=())["lint"], "ruff's lint")
    their_lint = table(settings(theirs, "ruff", but=())["lint"], "ruff's lint")
    assert our_lint == {key: value for key, value in their_lint.items() if key != "per-file-ignores"}
    assert MANIFEST["build-system"] == theirs["build-system"]


def test_what_the_manifest_requires_is_what_the_source_imports() -> None:
    requirements = listed(table(MANIFEST["project"], "project")["dependencies"], "dependencies")
    assert {name_of(requirement) for requirement in requirements} == {
        "opentelemetry-api",
        "opentelemetry-exporter-otlp-proto-http",
        "opentelemetry-sdk",
        "pydantic",
        "semiont",
        "semiont-graph",
    }
    # OpenTelemetry's API, its SDK and its OTLP exporter are three distributions, and each a part of the one package.
    imported = (
        "opentelemetry",
        r"opentelemetry\.sdk",
        r"opentelemetry\.exporter\.otlp\.proto\.http",
        "pydantic",
        "semiont",
        "semiont_graph",
    )
    for library in imported:
        assert importing(library), f"{library} is required and nothing imports it"
    # A dependency the SDK bounds is named here without a bound of its own.
    sdk = toml(SDK / "pyproject.toml")
    bounded = {name_of(requirement) for requirement in listed(table(sdk["project"], "project")["dependencies"], "its")}
    assert bounded >= {"opentelemetry-api", "pydantic"}
    for requirement in requirements:
        if name_of(requirement) in bounded:
            assert requirement == name_of(requirement), f"{requirement}: the SDK states the versions of {name_of(requirement)}"
    # OpenTelemetry's SDK and its exporter are no dependency of the SDK's: only a process that exports takes them.
    # The SDK states their versions once, for the drivers its conformance suite runs, and this manifest says the same.
    for_its_drivers = listed(table(sdk["dependency-groups"], "dependency-groups")["conformance"], "conformance")
    assert {name_of(requirement) for requirement in for_its_drivers} == {"opentelemetry-sdk", "opentelemetry-exporter-otlp-proto-http"}
    assert set(for_its_drivers) <= set(requirements)


def test_what_installs_the_telemetry_is_the_worker_service_s_under_this_one_s_name() -> None:
    # A second copy of one module. It is held to the first: the same code, with the Weaver's name where the
    # Worker's has its own. What the code does is held where the first is, by the Worker's tests.
    def code(source: str) -> str:
        """A module's code, without the words written beside it: its documentation is each service's own."""
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
                node.body = [
                    statement
                    for statement in node.body
                    if not (
                        isinstance(statement, ast.Expr)
                        and isinstance(statement.value, ast.Constant)
                        and isinstance(statement.value.value, str)
                    )
                ]
        return ast.dump(tree)

    theirs = (ROOT / "apps/worker/src/semiont_worker/observability.py").read_text(encoding="utf-8")
    ours = (SRC / "observability.py").read_text(encoding="utf-8")
    assert code(ours) == code(theirs.replace("semiont_worker", "semiont_weaver").replace("semiont-worker", "semiont-weaver"))


def test_the_sdk_and_the_graph_stores_are_the_ones_in_this_repository() -> None:
    sources = table(table(table(MANIFEST["tool"], "tool")["uv"], "uv")["sources"], "sources")
    assert sources == {
        "semiont": {"path": "../../packages/sdk-python", "editable": True},
        "semiont-graph": {"path": "../../packages/graph-python", "editable": True},
    }
    assert (PROJECT / "../../packages/sdk-python/pyproject.toml").resolve() == SDK / "pyproject.toml"
    assert (PROJECT / "../../packages/graph-python/pyproject.toml").resolve() == GRAPH / "pyproject.toml"


def test_it_is_a_service_s_code_and_no_library() -> None:
    assert not (SRC / "py.typed").exists()
    assert "Private :: Do Not Upload" in listed(table(MANIFEST["project"], "project")["classifiers"], "classifiers")
    for other in sorted(ROOT.glob("packages/*/pyproject.toml")) + sorted(ROOT.glob("apps/*/pyproject.toml")):
        if other.parent != PROJECT:
            assert "semiont-weaver" not in other.read_text(encoding="utf-8"), f"{other.relative_to(ROOT)} requires the Weaver"


def test_the_source_does_nothing_by_database() -> None:
    # What stands between the service and a database is the interface. It asks for a store by the name its
    # configuration states, in the one module that reads that, and names no store anywhere.
    graph_modules = sorted(
        {
            found.group(1)
            for path in SRC.rglob("*.py")
            for found in re.finditer(r"^\s*from semiont_graph\.(\w+) import ", path.read_text(encoding="utf-8"), re.MULTILINE)
        }
    )
    assert graph_modules == ["codec", "factory", "interface"]
    assert importing(r"semiont_graph\.factory") == ["service.py"]
    for client in ("neo4j", "gremlin_python"):
        assert importing(client) == []


def test_a_databases_client_is_an_extra_and_the_image_asks_for_every_one() -> None:
    extras = table(table(MANIFEST["project"], "project")["optional-dependencies"], "extras")
    of_the_graph = table(table(toml(GRAPH / "pyproject.toml")["project"], "project")["optional-dependencies"], "its extras")
    # An extra for each of the graph package's, which brings that one and nothing else.
    assert extras == {name: [f"semiont-graph[{name}]"] for name in of_the_graph}
    dev = listed(table(MANIFEST["dependency-groups"], "dependency-groups")["dev"], "dev")
    assert f"semiont-weaver[{','.join(sorted(extras))}]" in dev


def test_one_module_names_the_logger_and_one_reads_the_process_s_environment() -> None:
    naming = sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*.py") if "getLogger(" in path.read_text(encoding="utf-8"))
    assert naming == ["log.py"]
    reading = sorted(
        str(path.relative_to(SRC))
        for path in SRC.rglob("*.py")
        if re.search(r"\bos\.environ\b|\bsys\.argv\b", path.read_text(encoding="utf-8"))
    )
    assert reading == ["service.py"]


def test_nothing_in_the_fold_or_the_weaver_reads_a_clock_or_derives_who_a_thing_is_by() -> None:
    # The graph says what the record says: every date in it is one an event carried, and who a thing is by is
    # who its event records. A fold that read the time would date everything again at every rebuild.
    for module in ("fold.py", "weaver.py", "recorded.py", "marks.py", "lanes.py", "history.py"):
        source = (SRC / module).read_text(encoding="utf-8")
        assert not re.search(r"\bdatetime\b|\btime\.time\b|\.now\(|\.utcnow\(", source), f"{module} reads a clock"
        assert not re.search(r"\buser_id\b|userId", source), f"{module} reads who sent an event"


def test_the_events_it_follows_are_the_ones_the_protocol_lists() -> None:
    page = (ROOT / "docs/protocol/WEAVER.md").read_text(encoding="utf-8")
    rule = re.search(r"\*\*It follows nine recorded events:\*\*(.*?)\. Every other event", page, re.DOTALL)
    assert rule is not None, "docs/protocol/WEAVER.md no longer lists what a Weaver follows"
    assert sorted(re.findall(r"`([a-z]+:[a-z-]+)`", rule.group(1))) == sorted(FOLLOWED)
    assert len(FOLLOWED) == 9


def test_the_payload_it_reads_each_followed_event_as_is_the_one_the_bus_registry_names() -> None:
    registry = objects(read(SPEC / "bus/registry.json")["channels"], "channels")
    named = {row["event"]: row["payload"] for row in registry if row.get("shape") == "storedEvent" and row.get("event") in FOLLOWED}
    assert {event: shape.__name__ for event, shape in PAYLOADS.items()} == named
    assert sorted(PAYLOADS) == sorted(FOLLOWED)


def naming(text: str) -> list[str]:
    """The modules of this project whose source holds `text`, by their paths in it."""
    return sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*.py") if text in path.read_text(encoding="utf-8"))


def test_it_opens_no_file_of_the_record() -> None:
    # It reads history from the Archivist, over the bus. What touches a file is the module that keeps its marks, the
    # one that reads its document, the one that reads the process's environment and names where the marks go, and
    # the one that reads what the kernel and the supervisor say of the process, for its telemetry.
    touching = sorted(
        str(path.relative_to(SRC))
        for path in SRC.rglob("*.py")
        if re.search(r"\bPath\b|\bopen\(|\bos\.\w", path.read_text(encoding="utf-8"))
    )
    assert touching == ["checkpoint.py", "config.py", "observability.py", "service.py"]


def test_the_marks_have_one_writer_and_the_signal_one_emitter() -> None:
    # A mark says everything at or below it was applied. One module holds the marks and decides what raises
    # one, and one line says a mark on the bus: a second of either could say what the first would not.
    assert naming("_applied[") == ["marks.py"]
    assert naming("WEAVE_APPLIED") == ["weaver.py"]
    assert (SRC / "weaver.py").read_text(encoding="utf-8").count("emit(WEAVE_APPLIED") == 1


def test_the_fold_has_a_rule_for_each_event_followed_and_for_no_other() -> None:
    cases = re.findall(r'^        case "([a-z]+:[a-z-]+)":', (SRC / "fold.py").read_text(encoding="utf-8"), re.MULTILINE)
    assert sorted(cases) == sorted(FOLLOWED)


def test_reconcile_holds_an_annotation_to_what_the_codec_says_and_to_no_list_of_its_own() -> None:
    # The graph is no copy of a view. Whether it is right is asked of what the codec says it is to hold, so
    # that widening or narrowing what is stored changes what reconcile compares with no second list to keep.
    source = (SRC / "weaver.py").read_text(encoding="utf-8")
    assert "written(annotation) != written(intended_graph_annotation(recorded))" in source


def test_the_variables_it_reads_by_name_are_the_ones_the_protocol_lists() -> None:
    page = (ROOT / "docs/protocol/WEAVER.md").read_text(encoding="utf-8")
    section = re.search(r"^## Environment\n(.*?)^## ", page, re.DOTALL | re.MULTILINE)
    assert section is not None, "docs/protocol/WEAVER.md no longer has an Environment section"
    listed_there = {
        name
        for row in section.group(1).splitlines()
        if row.startswith("| ") and not row.startswith("| Variable")
        for name in re.findall(r"`([A-Z][A-Z0-9_]+)`", row.split("|")[1])
    }
    read_here = {
        name for path in SRC.rglob("*.py") for name in re.findall(r'"([A-Z][A-Z0-9]*_[A-Z0-9_]+)"', path.read_text(encoding="utf-8"))
    }
    assert read_here == listed_there
    # Its service account, and what says where its telemetry goes and under what name.
    assert read_here == {
        "SEMIONT_OIDC_CLIENT_ID",
        "SEMIONT_OIDC_CLIENT_SECRET",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_SERVICE_NAME",
        "OTEL_SDK_DISABLED",
        "OTEL_CONSOLE_EXPORTER",
        "OTEL_METRICS_EXPORTER",
        "OTEL_METRIC_EXPORT_INTERVAL",
        "SUPERVISE_EVENTS",
        "SUPERVISE_NAME",
    }
