"""What this project is made of, each part held to its rule.

Hand-written code states no type by force: it has no `cast`, names no `Any`,
and silences no checker. What the manifest says a second time, after the
SDK's, says the same. What the source imports, the manifest requires, and the
SDK and the packages it is checked against are the ones in this repository.
It is a service's code and no library: it carries no marker of a typed
package, no index takes it, and no other Python project of the repository
requires it. It does nothing by database and nothing by provider: it imports
no database's client and no provider's library, and requires none. Each is an
extra. It reads only: of the vector index it names what searches, and never
what writes. One module names the logger, one names OpenTelemetry, and one
reads the process's environment and its arguments, through the package every
Python service is built on. It opens no file of the record: what it reads of
the record and of its people it asks the Archivist on the bus. Every channel
its stream names is answered, followed or a reply to what it asks, and it
answers and follows no other. The variables its code reads
by name are the ones the protocol's page lists.

How its document is read, how its log is written and what exports its
telemetry are every Python service's, in the package the service is built on
(`packages/python/service`).
"""

import ast
import importlib
import re
import sys
import tomllib
from pathlib import Path

from pydantic import JsonValue, TypeAdapter
from semiont.bus import reply_channels_for
from semiont_vectors.store import VectorReader, VectorStore
from spec import PROJECT, ROOT, SDK

from semiont_librarian.config import SERVICE
from semiont_librarian.record import READ
from semiont_librarian.service import CHANNELS

SRC = PROJECT / "src/semiont_librarian"
SOURCES = sorted(path for top in ("src", "tests") for path in (PROJECT / top).rglob("*.py"))
GRAPH = ROOT / "packages/python/graph"
INFERENCE = ROOT / "packages/python/inference"
SHARED = ROOT / "packages/python/service"
VECTORS = ROOT / "packages/python/vectors"

# The modules whose names other code imports: every one of the package but its root and what begins with an underscore.
PUBLIC = sorted(path.stem for path in SRC.glob("*.py") if not path.stem.startswith("_"))

# What a Librarian is handed to read by, each a protocol, and the ways a read fails that it tells apart.
HANDED = [
    "AnchoredText",
    "Degraded",
    "Described",
    "GraphReads",
    "People",
    "PeopleUnread",
    "Projection",
    "Record",
    "Settled",
    "SmeltWaitTimedOut",
    "SmeltWaits",
    "WeaveWaitTimedOut",
    "WeaveWaits",
]

# What a database's client and a provider's library are imported as. The graph package and the inference drivers
# import them, each in the one module that asks through it.
VENDORS = ("neo4j", "gremlin_python", "qdrant_client", "anthropic", "openai", "google", "together")

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


def public(thing: object) -> set[str]:
    return {name for name in dir(thing) if not name.startswith("_")}


def naming(text: str) -> list[str]:
    """The modules of this project whose source holds `text`, by their paths in it."""
    return sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*.py") if text in path.read_text(encoding="utf-8"))


def imported() -> set[str]:
    """Every module the source imports, as each is written: at a module's top, and where a function imports what it alone needs."""
    names_one = re.compile(r"^[ ]*(?:from ([\w.]+) import |import ([\w.]+)$)", re.MULTILINE)
    sources = [path.read_text(encoding="utf-8") for path in sorted(SRC.rglob("*.py"))]
    return {found.group(1) or found.group(2) for source in sources for found in names_one.finditer(source)}


MANIFEST = toml(PROJECT / "pyproject.toml")


def test_the_walk_found_the_project() -> None:
    assert len(SOURCES) > 8


def test_every_module_states_its_public_names_and_has_each() -> None:
    assert {"config", "log", "reads"} <= set(PUBLIC)
    for module in PUBLIC:
        held = importlib.import_module(f"semiont_librarian.{module}")
        assert hasattr(held, "__all__"), f"semiont_librarian.{module} states no public names"
        stated = sorted(held.__all__)
        assert stated, f"semiont_librarian.{module} has no public name"
        assert len(set(stated)) == len(stated), f"semiont_librarian.{module} states a name twice"
        for name in stated:
            assert hasattr(held, name), f"semiont_librarian.{module} states {name} and has none"
    # What a Librarian is handed is the protocols its design lists, and no others.
    assert sorted(importlib.import_module("semiont_librarian.reads").__all__) == sorted(HANDED)
    assert importlib.import_module("semiont_librarian.config").__all__ == [
        "SERVICE",
        "Actor",
        "api_key_of",
        "embedding_key_of",
        "graph_password_of",
        "read_librarian_config",
    ]
    assert importlib.import_module("semiont_librarian.log").__all__ == ["LOG"]
    assert importlib.import_module("semiont_librarian.service").__all__ == ["CHANNELS", "boot", "health", "main"]


def test_a_public_name_is_imported_from_its_module_and_not_from_the_packages_root() -> None:
    # One path to each name, as the SDK has it. Read as Python, and not as text: a docstring may have a line that
    # begins with the word "from".
    root_statements = ast.parse((SRC / "__init__.py").read_text(encoding="utf-8")).body
    assert not [held for held in root_statements if isinstance(held, ast.Import | ast.ImportFrom)], "the package's root imports something"
    root = importlib.import_module("semiont_librarian")
    assert not hasattr(root, "__all__")
    for module in PUBLIC:
        for name in sorted(importlib.import_module(f"semiont_librarian.{module}").__all__):
            assert not hasattr(root, name), f"{name} can be imported from the package's root as well as from semiont_librarian.{module}"


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

    checkers = ("mypy", "pyright", "pytest", "pytest-cov", "ruff")
    # Beside them, the service itself with every extra, and what makes the histories of a property test, which the
    # SDK has no use for.
    assert set(tools(MANIFEST)) == {*checkers, "hypothesis", "semiont-librarian"}
    assert {name: tools(MANIFEST)[name] for name in checkers} == {name: tools(theirs)[name] for name in checkers}

    def settings(of: Toml, tool: str, *, but: tuple[str, ...]) -> Toml:
        return {key: value for key, value in table(table(of["tool"], "tool")[tool], tool).items() if key not in but}

    # What each reads is its own project's; everything else is the same.
    assert settings(MANIFEST, "mypy", but=("files",)) == settings(theirs, "mypy", but=("files",))
    assert settings(MANIFEST, "pyright", but=("include",)) == settings(theirs, "pyright", but=("include",))
    assert settings(MANIFEST, "pydantic-mypy", but=()) == settings(theirs, "pydantic-mypy", but=())
    assert settings(MANIFEST, "pytest", but=()) == settings(theirs, "pytest", but=())
    # A coverage run measures its own project's source, and reports as the SDK's does.
    our_run = table(settings(MANIFEST, "coverage", but=())["run"], "coverage's run")
    their_run = table(settings(theirs, "coverage", but=())["run"], "coverage's run")
    assert {key: our_run[key] for key in our_run if key != "source"} == {key: their_run[key] for key in their_run if key != "source"}
    # The SDK's formatter is told which of its modules are generated, and its linter which of its tests are
    # programs that must not type-check. This project has neither.
    assert settings(MANIFEST, "ruff", but=("lint",)) == settings(theirs, "ruff", but=("lint", "extend-exclude"))
    our_lint = table(settings(MANIFEST, "ruff", but=())["lint"], "ruff's lint")
    their_lint = table(settings(theirs, "ruff", but=())["lint"], "ruff's lint")
    assert our_lint == {key: value for key, value in their_lint.items() if key != "per-file-ignores"}
    # Which Pythons the two run on is lint:python-version's to hold: it is the one gate that reads that line.
    assert MANIFEST["build-system"] == theirs["build-system"]


def test_what_the_source_imports_the_manifest_requires() -> None:
    requirements = listed(table(MANIFEST["project"], "project")["dependencies"], "dependencies")
    required = {name_of(requirement) for requirement in requirements}
    assert required == {
        "opentelemetry-api",
        "pydantic",
        "semiont",
        "semiont-graph",
        "semiont-inference",
        "semiont-service",
        "semiont-vectors",
    }
    # Every module imported from outside the standard library is of a distribution the manifest requires, and
    # nothing required goes unused. A distribution is imported by its own name, but for OpenTelemetry's API, which
    # is imported as `opentelemetry`.
    declared = {"opentelemetry" if name == "opentelemetry-api" else name.replace("-", "_") for name in required}
    roots = {module.split(".")[0] for module in imported()}
    assert roots - set(sys.stdlib_module_names) - {"semiont_librarian"} == declared
    # Of OpenTelemetry the service takes the API alone, in the one module that counts what it counts. What exports,
    # its SDK and its exporter, is the shared package's to require, at the versions its own manifest states, and
    # to import.
    assert importing("opentelemetry") == ["telemetry.py"]
    assert importing(r"opentelemetry\.(sdk|exporter)") == []
    assert not required & {"opentelemetry-sdk", "opentelemetry-exporter-otlp-proto-http"}
    # A dependency the SDK bounds is named here without a bound of its own.
    sdk = toml(SDK / "pyproject.toml")
    bounded = {name_of(requirement) for requirement in listed(table(sdk["project"], "project")["dependencies"], "its")}
    assert bounded >= {"opentelemetry-api", "pydantic"}
    for requirement in requirements:
        if name_of(requirement) in bounded:
            assert requirement == name_of(requirement), f"{requirement}: the SDK states the versions of {name_of(requirement)}"


def test_the_sdk_and_the_packages_it_is_built_on_are_the_ones_in_this_repository() -> None:
    sources = table(table(table(MANIFEST["tool"], "tool")["uv"], "uv")["sources"], "sources")
    assert sources == {
        "semiont": {"path": "../../packages/python/sdk", "editable": True},
        "semiont-graph": {"path": "../../packages/python/graph", "editable": True},
        "semiont-inference": {"path": "../../packages/python/inference", "editable": True},
        "semiont-service": {"path": "../../packages/python/service", "editable": True},
        "semiont-vectors": {"path": "../../packages/python/vectors", "editable": True},
    }
    for there in (SDK, GRAPH, INFERENCE, SHARED, VECTORS):
        assert (PROJECT / "../../packages/python" / there.name / "pyproject.toml").resolve() == there / "pyproject.toml"
        assert (there / "pyproject.toml").is_file(), there.name
    # Every one of them the manifest requires is taken from here, and nothing else is.
    requirements = listed(table(MANIFEST["project"], "project")["dependencies"], "dependencies")
    assert {name_of(requirement) for requirement in requirements if name_of(requirement).startswith("semiont")} == set(sources)


def test_the_distribution_is_named_for_the_service() -> None:
    # Its telemetry is exported under its word for itself after `semiont-`, at the version of the distribution of
    # that name (`semiont_service.observability`): the manifest's name is that, or an exporting service does not start.
    assert SERVICE == "librarian"
    assert table(MANIFEST["project"], "project")["name"] == f"semiont-{SERVICE}"


def test_it_is_a_service_s_code_and_no_library() -> None:
    assert not (SRC / "py.typed").exists()
    beside = sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*") if path.is_file() and path.suffix not in (".py", ".pyc"))
    assert beside == []
    assert "Private :: Do Not Upload" in listed(table(MANIFEST["project"], "project")["classifiers"], "classifiers")
    for other in sorted(ROOT.glob("packages/python/*/pyproject.toml")) + sorted(ROOT.glob("images/*/pyproject.toml")):
        if other.parent != PROJECT:
            assert "semiont-librarian" not in other.read_text(encoding="utf-8"), f"{other.relative_to(ROOT)} requires the Librarian"


def test_the_source_imports_no_database_s_client_and_no_provider_s_library() -> None:
    # What stands between the service and a database, and between it and a provider, is a protocol of the package
    # that has the drivers. The one request it makes that is not the SDK's is the shared package's to make.
    for vendor in (*VENDORS, "httpx"):
        assert importing(vendor) == [], vendor


def test_a_client_and_a_library_are_each_an_extra_and_the_tests_ask_for_every_one() -> None:
    extras = table(table(MANIFEST["project"], "project")["optional-dependencies"], "extras")
    of_the_graph = table(table(toml(GRAPH / "pyproject.toml")["project"], "project")["optional-dependencies"], "the graph package's extras")
    of_inference = table(table(toml(INFERENCE / "pyproject.toml")["project"], "project")["optional-dependencies"], "the drivers' extras")
    assert not set(of_the_graph) & set(of_inference), "an extra of the graph package and one of the inference drivers have one name"
    # An extra for each of the two packages', which brings that one and nothing else.
    expected = {name: [f"semiont-graph[{name}]"] for name in of_the_graph} | {name: [f"semiont-inference[{name}]"] for name in of_inference}
    assert extras == expected
    dev = listed(table(MANIFEST["dependency-groups"], "dependency-groups")["dev"], "dev")
    assert f"semiont-librarian[{','.join(sorted(extras))}]" in dev


def test_it_reads_only() -> None:
    # A Librarian makes no collection, no index and no constraint in any store. Of the vector index it is handed
    # what searches, and names nothing that writes.
    assert naming("VectorStore") == []
    writes = (
        "create_resource",
        "update_resource",
        "delete_resource",
        "create_annotation",
        "update_annotation",
        "delete_annotation",
        "resolve_reference",
        "clear_database",
    )
    for writing in writes:
        assert naming(writing) == [], writing
    # What a writer of the index has and a reader of it has not is read off the two protocols, so that a member a
    # store is given later is held too: the Librarian calls none of them.
    of_a_writer_alone = public(VectorStore) - public(VectorReader)
    assert "upsert_resource_vectors" in of_a_writer_alone
    for member in sorted(of_a_writer_alone):
        assert naming(f".{member}(") == [], member


def test_it_opens_no_file_of_the_record() -> None:
    # What it reads of the record and of its people it asks the Archivist on the bus (`record.py`). The one module that
    # names a path is the one that reads its document, which names the path of the model catalogue.
    assert importing("pathlib") == ["service.py"]
    for opening in ("open(", ".read_bytes(", ".read_text(", "to_thread("):
        assert naming(opening) == [], opening


def test_one_module_names_the_logger_and_one_reads_the_process_s_environment_and_its_arguments() -> None:
    assert naming("getLogger(") == ["log.py"]
    assert (SRC / "log.py").read_text(encoding="utf-8").count('getLogger("semiont_librarian")') == 1
    reading = sorted(
        str(path.relative_to(SRC))
        for path in SRC.rglob("*.py")
        if re.search(r"\bos\.environ\b|\bos\.getenv\b|\bsys\.argv\b|\bgetenv\(", path.read_text(encoding="utf-8"))
    )
    assert reading == ["service.py"]
    # It hands both over whole, to what reads a document's path, a service's account and where telemetry goes
    # (`semiont_service`), and to what reads a variable the document names. It looks nothing up in either itself.
    service = (SRC / "service.py").read_text(encoding="utf-8")
    assert re.findall(r"os\.environ\b(.?)", service) == [")", ")"]
    assert re.findall(r"sys\.argv(.{4})", service) == ["[1:]"]
    # A variable is read by the name the document gives it, in the one module that knows the document's members.
    assert naming("set_in(") == ["config.py"]


def test_what_makes_a_store_a_provider_and_a_client_is_asked_by_the_module_that_starts_the_service() -> None:
    # The Librarian is handed what it reads by. What a document names is made into a store, a provider or a client
    # by each package's own factory, in the module that reads the document, and the reader of a resource's bytes
    # there too.
    for factory in (r"semiont_graph\.factory", r"semiont_vectors\.factory", r"semiont_inference\.factory", r"semiont_service\.archivist"):
        assert importing(factory) == ["service.py"], factory
    # A reader of the index is asked for, and never what writes one.
    assert "create_vector_reader(" in (SRC / "service.py").read_text(encoding="utf-8")
    # What answers a request for a model's limits is every service's that holds a model, asked by what takes the frames.
    assert importing(r"semiont_inference\.limits_report") == ["librarian.py"]
    # The order it works in is every Python service's lanes.
    assert importing(r"semiont_service\.lanes") == ["librarian.py"]


def test_every_channel_its_stream_names_is_answered_followed_or_a_reply_to_what_it_asks_and_no_other_is() -> None:
    assert len(CHANNELS) == len(set(CHANNELS)) == 16
    # The replies of the three reads of the Archivist, and no other reply.
    replies = reply_channels_for(*READ)
    assert len(replies) == 6
    assert set(replies) <= set(CHANNELS)
    taken = sorted(set(CHANNELS) - set(replies))
    # What a frame does is one `match` over its channel: a channel the stream names that has no case there is
    # delivered and passed by, and whoever asked waits out its own wait.
    source = (SRC / "librarian.py").read_text(encoding="utf-8")
    taking = source[source.index("    def delivered(") : source.index("    def _signalled")]
    stated = re.findall(r"^            case (.+):$", taking, re.MULTILINE)
    cases = [name for line in stated for name in re.findall(r'"([a-z]+:[a-z-]+)"', line)]
    assert len(cases) == len(set(cases)) == 8
    # The two limits requests are answered by what listens for them itself, each with its own actor's model.
    listening = re.findall(r"answer_limits_requests\(self\._bus, ([A-Z_]+), \(self\._(\w+),\)\)", source)
    assert sorted(listening) == [("GATHER_LIMITS_REQUESTED", "gatherer"), ("MATCH_LIMITS_REQUESTED", "matcher")]
    limits = ["gather:limits-requested", "match:limits-requested"]
    assert sorted([*cases, *limits]) == taken
    # They are the eight requests the protocol's table lists, and the two signals its rule names.
    page = (ROOT / "docs/protocol/LIBRARIAN.md").read_text(encoding="utf-8")
    section = re.search(r"^## What it answers\n(.*?)^## ", page, re.DOTALL | re.MULTILINE)
    assert section is not None, "docs/protocol/LIBRARIAN.md no longer has a section on what a Librarian answers"
    requests = re.findall(r"^\s*\| `([a-z]+:[a-z-]+)` \|", section.group(1), re.MULTILINE)
    assert len(requests) == 8
    rule = re.search(r"\*\*It follows two signals:\*\*(.*?)\*Held by", section.group(1), re.DOTALL)
    assert rule is not None, "docs/protocol/LIBRARIAN.md no longer names the signals a Librarian follows"
    signals = re.findall(r"`([a-z]+:[a-z-]+)`", rule.group(1))
    assert sorted([*requests, *signals]) == taken


def test_the_variables_it_reads_by_name_are_the_ones_the_protocol_lists() -> None:
    page = (ROOT / "docs/protocol/LIBRARIAN.md").read_text(encoding="utf-8")
    section = re.search(r"^## Environment\n(.*?)^## ", page, re.DOTALL | re.MULTILINE)
    assert section is not None, "docs/protocol/LIBRARIAN.md no longer has an Environment section"
    listed_there = {
        name
        for row in section.group(1).splitlines()
        if row.startswith("| ") and not row.startswith("| Variable")
        for name in re.findall(r"`([A-Z][A-Z0-9_]+)`", row.split("|")[1])
    }
    # Every variable the service's code names: its own, and the shared package's it is built on.
    sources = sorted([*SRC.rglob("*.py"), *(SHARED / "src").rglob("*.py")])
    assert any(path.is_relative_to(SHARED) for path in sources), "packages/python/service has no source"
    # A module's `__all__` names what it exports, in quotes too: a constant's name there is no variable read.
    texts = [re.sub(r"^__all__ = \[.*?\]$", "", path.read_text(encoding="utf-8"), flags=re.DOTALL | re.MULTILINE) for path in sources]
    read_here = {name for text in texts for name in re.findall(r'"([A-Z][A-Z0-9]*_[A-Z0-9_]+)"', text)}
    assert read_here == listed_there
    # Its service account, and what says where its telemetry goes and under what name. Each secret is in a
    # variable its document names, and so is named by no code.
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
