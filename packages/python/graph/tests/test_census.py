"""What this package is made of, each part held to its rule.

Its public names are the ones its design lists, and no others. Hand-written
code states no type by force: it has no `cast`, names no `Any`, and silences
no checker. A database's client is named only by the module that asks
through it, is an extra and not a requirement, and is imported only when its
store is. No type of a client's appears in the interface or the codec. Every
store has the members of a graph database and no others, a reader has its
reads and nothing that writes, and nothing a reader can say to its database
writes there. No module reads a clock. And what this package's manifest says
a second time, after the SDK's, says the same.
"""

import ast
import importlib
import re
import tomllib
from pathlib import Path

from pydantic import JsonValue, TypeAdapter
from spec import PACKAGE, SDK

from semiont_graph.interface import GraphDatabase, GraphReader
from semiont_graph.janusgraph import JanusGraphDatabase
from semiont_graph.memory import MemoryGraphDatabase
from semiont_graph.neo4j import Neo4jGraphDatabase, Neo4jGraphReader
from semiont_graph.neptune import NeptuneGraphDatabase

SRC = PACKAGE / "src/semiont_graph"
SOURCES = sorted(path for top in ("src", "tests") for path in (PACKAGE / top).rglob("*.py"))

# The public names, by the module that has each.
SURFACE = {
    "interface": [
        "EntityTypeCount",
        "GraphConnection",
        "GraphDatabase",
        "GraphPath",
        "GraphReader",
        "GraphStats",
        "ResourceChange",
        "ResourceListing",
        "ResourceQuery",
    ],
    "codec": [
        "LINKING",
        "ResourceProperties",
        "decode_annotation",
        "decode_resource",
        "encode_annotation",
        "encode_resource",
        "intended_graph_annotation",
        "resolved_body",
        "stored_annotation_type",
        "updated_annotation",
    ],
    "memory": ["MemoryGraphDatabase"],
    "neo4j": ["Neo4jGraphDatabase", "Neo4jGraphReader"],
    "janusgraph": ["JanusGraphDatabase"],
    "neptune": ["NeptuneGraphDatabase"],
    "factory": ["create_graph_database", "create_graph_reader"],
}

# A Cypher clause that writes, and a Gremlin step that does.
CYPHER_WRITES = re.compile(r"(^|[^A-Za-z_])(CREATE|MERGE|SET|DELETE|REMOVE|DROP)([^A-Za-z_]|$)")
GREMLIN_WRITES = re.compile(r"\.(addV|addE|property|drop)\(")

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
    """The modules of this package that import `library`, by their paths in it."""
    names_it = re.compile(rf"^\s*(import|from)\s+{library}\b", re.MULTILINE)
    return sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*.py") if names_it.search(path.read_text(encoding="utf-8")))


def naming(text: str) -> list[str]:
    """The modules of this package whose source holds `text`, by their paths in it."""
    return sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*.py") if text in path.read_text(encoding="utf-8"))


def public(thing: object) -> set[str]:
    return {name for name in dir(thing) if not name.startswith("_")}


def texts_in(node: ast.AST) -> list[str]:
    """Every text a piece of a module's code holds, but its documentation: a text that stands as a statement is said to no database."""
    documentation = {id(held.value) for held in ast.walk(node) if isinstance(held, ast.Expr)}
    return [
        held.value
        for held in ast.walk(node)
        if isinstance(held, ast.Constant) and isinstance(held.value, str) and id(held) not in documentation
    ]


def reached_from(module: str, name: str) -> tuple[list[str], set[str]]:
    """What the class `name` of a store's module can say and do: every text its code holds, and every attribute it asks for.

    Its code is the class, and whatever of its module the class names, and
    whatever those name in turn: the class it extends, a statement kept
    under a name, a function it calls. So a statement a reader runs is read
    wherever in the module it is written, and one only a store runs is not.
    """
    defined: dict[str, ast.stmt] = {}
    for statement in ast.parse((SRC / f"{module}.py").read_text(encoding="utf-8")).body:
        if isinstance(statement, ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
            defined[statement.name] = statement
        elif isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
            defined[statement.target.id] = statement
        elif isinstance(statement, ast.Assign):
            for target in statement.targets:
                if isinstance(target, ast.Name):
                    defined[target.id] = statement
    texts: list[str] = []
    attributes: set[str] = set()
    reached: set[str] = set()
    waiting = [name]
    while waiting:
        next_name = waiting.pop()
        if next_name in reached:
            continue
        reached.add(next_name)
        texts.extend(texts_in(defined[next_name]))
        for held in ast.walk(defined[next_name]):
            if isinstance(held, ast.Name) and held.id in defined:
                waiting.append(held.id)
            elif isinstance(held, ast.Attribute):
                attributes.add(held.attr)
    return texts, attributes


def connecting_says(module: str, name: str) -> list[str]:
    """Every text the `connect` of the class `name` of a store's module holds."""
    classes = [held for held in ast.parse((SRC / f"{module}.py").read_text(encoding="utf-8")).body if isinstance(held, ast.ClassDef)]
    (store,) = [held for held in classes if held.name == name]
    (connect,) = [held for held in store.body if isinstance(held, ast.AsyncFunctionDef) and held.name == "connect"]
    return texts_in(connect)


MANIFEST = toml(PACKAGE / "pyproject.toml")


def test_the_walk_found_the_package() -> None:
    assert len(SOURCES) > 15


def test_the_public_modules_and_their_names_are_the_ones_the_design_lists() -> None:
    modules = sorted(path.stem for path in SRC.glob("*.py") if not path.stem.startswith("_"))
    assert modules == sorted(SURFACE)
    for module, names in SURFACE.items():
        assert sorted(importlib.import_module(f"semiont_graph.{module}").__all__) == sorted(names), f"semiont_graph.{module}"


def test_a_public_name_is_imported_from_its_module_and_not_from_the_packages_root() -> None:
    # One path to each name, as the SDK has it. It is also why importing the package imports no database's client.
    # Read as Python, and not as text: the root's docstring has a line that begins with the word "from".
    root_statements = ast.parse((SRC / "__init__.py").read_text(encoding="utf-8")).body
    assert not [held for held in root_statements if isinstance(held, ast.Import | ast.ImportFrom)], "the package's root imports something"
    root = importlib.import_module("semiont_graph")
    assert not hasattr(root, "__all__")
    for module, names in SURFACE.items():
        for name in names:
            assert not hasattr(root, name), f"{name} can be imported from the package's root as well as from semiont_graph.{module}"
    assert (SRC / "py.typed").read_bytes() == b""


def test_a_store_has_the_members_of_a_graph_database_and_no_others() -> None:
    members = public(GraphDatabase)
    assert len(members) == 20
    # Making a store dials nothing: each reaches its database when it is connected.
    assert public(MemoryGraphDatabase()) == members
    assert public(Neo4jGraphDatabase(uri="bolt://127.0.0.1:1", username="u", password="p", database="d")) == members
    assert public(JanusGraphDatabase(host="127.0.0.1", port=1)) == members
    assert public(NeptuneGraphDatabase(endpoint="127.0.0.1", port=1)) == members


def test_a_reader_has_the_reads_of_a_graph_database_and_nothing_that_writes() -> None:
    members = public(GraphReader)
    assert members == {
        "connect",
        "disconnect",
        "get_resource",
        "list_resources",
        "get_resource_annotations",
        "get_resource_referenced_by",
        "get_resource_connections",
        "get_entity_type_stats",
    }
    # A store is asked everything a reader is, so whatever is handed a reader can be handed a store.
    assert members < public(GraphDatabase)
    in_memory: GraphReader = MemoryGraphDatabase()
    assert members < public(in_memory)
    # Making a reader dials nothing.
    assert public(Neo4jGraphReader(uri="bolt://127.0.0.1:1", username="u", password="p", database="d")) == members


def test_no_statement_the_neo4j_reader_can_run_writes() -> None:
    statements, asked_for = reached_from("neo4j", "Neo4jGraphReader")
    # The walk read the reads: each of the six asks at least one statement that matches.
    assert sum("MATCH " in statement for statement in statements) >= 6
    assert "execute_query" in asked_for
    assert [statement for statement in statements if CYPHER_WRITES.search(statement)] == []
    # A reader asks one statement at a time, and opens no transaction that may write.
    assert not asked_for & {"execute_write", "session", "run"}
    # The other half: read the same way, the store is seen to write, so a reader that came to would be seen too.
    of_the_store, the_store_asks_for = reached_from("neo4j", "Neo4jGraphDatabase")
    assert [statement for statement in of_the_store if CYPHER_WRITES.search(statement)]
    assert "execute_write" in the_store_asks_for


def test_connecting_a_gremlin_store_asks_a_traversal_that_reads_and_none_that_writes() -> None:
    # The reader of a JanusGraph and of a Neptune is the store, handed over as a reader: what a reader does
    # unasked is connect, so a store's `connect` is held to make nothing.
    for module, name in (("janusgraph", "JanusGraphDatabase"), ("neptune", "NeptuneGraphDatabase")):
        said = connecting_says(module, name)
        assert [text for text in said if text.startswith("g.V()")], module
        assert [text for text in said if GREMLIN_WRITES.search(text)] == [], module
    # The same search finds the steps a Gremlin store writes by.
    for path in ("janusgraph.py", "neptune.py"):
        assert GREMLIN_WRITES.search((SRC / path).read_text(encoding="utf-8")), path


def test_no_hand_written_line_forces_a_type_or_silences_a_checker() -> None:
    forced = [
        f"{path.relative_to(PACKAGE)}:{number}: {line.strip()}"
        for path in SOURCES
        if path.name != "test_census.py"
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if FORCED.search(line)
    ]
    assert forced == []


def test_a_client_is_named_only_by_the_module_that_asks_through_it() -> None:
    # What stands between a caller and a database's client is the interface: nothing else here knows which
    # client a store uses.
    assert importing("neo4j") == ["neo4j.py"]
    # The Gremlin client states no types, so it is looked up by name and never imported by one. One module
    # names it, and the two stores that ask through it ask that module.
    assert importing("gremlin_python") == []
    assert naming("gremlin_python") == ["_gremlin.py"]
    assert importing(r"semiont_graph\._gremlin") == ["janusgraph.py", "neptune.py"]
    # The interface, the codec and what they share import no store, and so no client.
    for store in ("neo4j", "janusgraph", "neptune", "memory", "_gremlin", "factory"):
        imported_by = set(importing(rf"semiont_graph\.{store}"))
        assert not imported_by & {"interface.py", "codec.py", "_query.py"}, store


def test_the_factory_imports_a_store_where_its_database_is_asked_for_and_not_before() -> None:
    source = (SRC / "factory.py").read_text(encoding="utf-8")
    at_the_top = [line for line in source.splitlines() if re.match(r"(import|from)\s", line)]
    assert not any(re.search(r"semiont_graph\.(neo4j|janusgraph|neptune|memory)\b", line) for line in at_the_top)
    for store in ("neo4j", "janusgraph", "neptune", "memory"):
        assert re.search(rf"^\s+from semiont_graph\.{store} import ", source, re.MULTILINE), store


def test_no_module_reads_a_clock() -> None:
    # Every date in the graph is one an event carried. A store that stamped its own would date everything again
    # at every rebuild.
    for path in SRC.rglob("*.py"):
        assert not re.search(r"\.now\(|\.utcnow\(|\btime\.time\(|\btoday\(", path.read_text(encoding="utf-8")), path.name


def test_the_package_holds_nothing_beside_its_modules_but_its_typed_marker() -> None:
    beside = sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*") if path.is_file() and path.suffix not in (".py", ".pyc"))
    assert beside == ["py.typed"]


def test_the_checkers_and_their_strictness_are_the_sdks() -> None:
    # This package's manifest states them a second time. A pin or a setting moved in one and not the other fails here.
    theirs = toml(SDK / "pyproject.toml")

    def tools(of: Toml) -> dict[str, str]:
        dev = listed(table(of["dependency-groups"], "dependency-groups")["dev"], "dev")
        return {name_of(requirement): requirement for requirement in dev}

    checkers = ("mypy", "pyright", "pytest", "ruff")
    assert set(tools(MANIFEST)) == {*checkers, "semiont-graph"}
    assert {name: tools(MANIFEST)[name] for name in checkers} == {name: tools(theirs)[name] for name in checkers}

    def settings(of: Toml, tool: str, *, but: tuple[str, ...]) -> Toml:
        return {key: value for key, value in table(table(of["tool"], "tool")[tool], tool).items() if key not in but}

    # What each reads is its own package's; everything else is the same.
    assert settings(MANIFEST, "mypy", but=("files",)) == settings(theirs, "mypy", but=("files",))
    assert settings(MANIFEST, "pydantic-mypy", but=()) == settings(theirs, "pydantic-mypy", but=())
    assert settings(MANIFEST, "pytest", but=()) == settings(theirs, "pytest", but=())
    # One setting of pyright's is this package's alone, and is no loosening: Neo4j's client states the signatures
    # a checker is to read under a name for `TYPE_CHECKING` that pyright does not know, and this says what it is.
    assert settings(MANIFEST, "pyright", but=("include", "defineConstant")) == settings(theirs, "pyright", but=("include",))
    assert settings(MANIFEST, "pyright", but=())["defineConstant"] == {"TYPE_CHECKING": True}
    # The SDK's formatter is told which of its modules are generated, and its linter which of its tests are
    # programs that must not type-check. This package has neither.
    assert settings(MANIFEST, "ruff", but=("lint",)) == settings(theirs, "ruff", but=("lint", "extend-exclude"))
    our_lint = table(settings(MANIFEST, "ruff", but=())["lint"], "ruff's lint")
    their_lint = table(settings(theirs, "ruff", but=())["lint"], "ruff's lint")
    assert our_lint == {key: value for key, value in their_lint.items() if key != "per-file-ignores"}
    # Which Pythons the two run on is lint:python-version's to hold: it is the one gate that reads that line.
    assert MANIFEST["build-system"] == theirs["build-system"]


def test_what_every_install_has_is_what_the_package_imports_without_a_databases_client() -> None:
    project = table(MANIFEST["project"], "project")
    required = listed(project["dependencies"], "dependencies")
    assert {name_of(requirement) for requirement in required} == {"pydantic", "semiont"}
    for library in ("pydantic", "semiont"):
        assert importing(library), f"{library} is required and nothing imports it"
    # A dependency the SDK bounds is named here without a bound of its own.
    of_the_sdk = listed(table(toml(SDK / "pyproject.toml")["project"], "project")["dependencies"], "the SDK's dependencies")
    bounded = {name_of(requirement) for requirement in of_the_sdk}
    assert "pydantic" in bounded
    for requirement in required:
        if name_of(requirement) in bounded:
            assert requirement == name_of(requirement), f"{requirement}: the SDK states the versions of {name_of(requirement)}"

    # An extra is named for a store, and brings the client that store asks through. Both Gremlin stores ask
    # through one client, and state its versions the same.
    extras = table(project["optional-dependencies"], "extras")
    brought = {"neo4j": "neo4j", "janusgraph": "gremlinpython", "neptune": "gremlinpython"}
    assert {extra: [name_of(requirement) for requirement in listed(requirements, extra)] for extra, requirements in extras.items()} == {
        extra: [distribution] for extra, distribution in brought.items()
    }
    for extra, distribution in brought.items():
        assert (SRC / f"{extra}.py").is_file(), f"the extra {extra} is named for no store"
        assert distribution not in {name_of(requirement) for requirement in required}
    assert extras["janusgraph"] == extras["neptune"]

    # The checkers and the tests read every store: the environment they run in has every extra.
    dev = listed(table(MANIFEST["dependency-groups"], "dependency-groups")["dev"], "dev")
    assert f"semiont-graph[{','.join(sorted(extras))}]" in dev
