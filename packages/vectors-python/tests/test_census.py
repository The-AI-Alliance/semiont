"""What this package is made of, each part held to its rule.

Its public names are the ones its design lists, and no others. Hand-written
code states no type by force: it has no `cast`, names no `Any`, and silences
no checker. The HTTP client is named only by the modules that ask through
it, and no type of it appears in either protocol. Every store has the
members of a vector index and no others, a reader has its searches and
nothing that writes, and every provider the members of an embedding
provider and no others. No store reads a clock. The package has
no extra: nothing it asks is asked through a library of the one it asks. And
what this package's manifest says a second time, after the SDK's, says the
same.
"""

import ast
import importlib
import re
import tomllib
from pathlib import Path

from pydantic import JsonValue, TypeAdapter
from spec import PACKAGE, SDK

from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.memory import MemoryVectorStore
from semiont_vectors.mock import MockEmbeddingProvider
from semiont_vectors.ollama import OllamaEmbeddingProvider
from semiont_vectors.qdrant import QdrantVectorReader, QdrantVectorStore
from semiont_vectors.store import VectorReader, VectorStore
from semiont_vectors.voyage import VoyageEmbeddingProvider

SRC = PACKAGE / "src/semiont_vectors"
SOURCES = sorted(path for top in ("src", "tests") for path in (PACKAGE / top).rglob("*.py"))

# The public names, by the module that has each.
SURFACE = {
    "store": [
        "AnnotationPayload",
        "CollectionAbsent",
        "EmbeddingChunk",
        "ResourceStamp",
        "SearchFilter",
        "SearchOptions",
        "VectorReader",
        "VectorSearchResult",
        "VectorStore",
    ],
    "payload": [
        "STAMP_MEMBERS",
        "Payload",
        "annotation_key",
        "annotation_of",
        "annotation_payload",
        "chunk_key",
        "chunk_payload",
        "qdrant_id",
        "resource_of",
        "result_of",
        "stamp_of",
    ],
    "merge": ["merge_by_resource"],
    "memory": ["MemoryVectorStore"],
    "qdrant": ["QdrantVectorReader", "QdrantVectorStore"],
    "embedding": [
        "EMBED_ROUND_TRIP_SECONDS",
        "BatchPolicy",
        "EmbeddingProvider",
        "EmbeddingProviderError",
        "ProviderName",
        "SliceRef",
        "TextKind",
    ],
    "ollama": ["OLLAMA_BATCH_POLICY", "OllamaEmbeddingProvider"],
    "voyage": ["VOYAGE_BATCH_POLICY", "VoyageEmbeddingProvider"],
    "mock": ["MockEmbeddingProvider", "deterministic_vector"],
    "factory": ["create_embedding_provider", "create_vector_reader", "create_vector_store"],
}

# The modules that say what a store and a provider are, and what they share: none knows of a store or a provider.
PROTOCOLS = {"store.py", "payload.py", "merge.py", "embedding.py"}

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


def public(thing: object) -> set[str]:
    return {name for name in dir(thing) if not name.startswith("_")}


async def never_asked() -> int:
    raise AssertionError("making a store asks nobody how wide a vector is")


MANIFEST = toml(PACKAGE / "pyproject.toml")


def test_the_walk_found_the_package() -> None:
    assert len(SOURCES) > 20


def test_the_public_modules_and_their_names_are_the_ones_the_design_lists() -> None:
    modules = sorted(path.stem for path in SRC.glob("*.py") if not path.stem.startswith("_"))
    assert modules == sorted(SURFACE)
    for module, names in SURFACE.items():
        assert sorted(importlib.import_module(f"semiont_vectors.{module}").__all__) == sorted(names), f"semiont_vectors.{module}"


def test_a_public_name_is_imported_from_its_module_and_not_from_the_packages_root() -> None:
    # One path to each name, as the SDK has it. It is also why importing the package imports no store and no provider.
    # Read as Python, and not as text: a docstring may have a line that begins with the word "from".
    root_statements = ast.parse((SRC / "__init__.py").read_text(encoding="utf-8")).body
    assert not [held for held in root_statements if isinstance(held, ast.Import | ast.ImportFrom)], "the package's root imports something"
    root = importlib.import_module("semiont_vectors")
    assert not hasattr(root, "__all__")
    for module, names in SURFACE.items():
        for name in names:
            assert not hasattr(root, name), f"{name} can be imported from the package's root as well as from semiont_vectors.{module}"
    assert (SRC / "py.typed").read_bytes() == b""


def test_a_store_has_the_members_of_a_vector_index_and_no_others() -> None:
    members = public(VectorStore)
    assert len(members) == 15
    # Making a store dials nothing, and asks nobody how wide a vector is: each reaches its index when it is connected.
    assert public(MemoryVectorStore()) == members
    assert public(QdrantVectorStore(host="127.0.0.1", port=1, dimensions=never_asked)) == members


def test_a_reader_has_the_searches_of_a_vector_index_and_nothing_that_writes() -> None:
    members = public(VectorReader)
    assert members == {"connect", "disconnect", "search_resources", "search_annotations", "search_by_resource", "get_resource_stamp"}
    # A store is asked everything a reader is, so whatever is handed a reader can be handed a store.
    assert members < public(VectorStore)
    in_memory: VectorReader = MemoryVectorStore()
    assert members < public(in_memory)
    # Making a reader dials nothing, and it is told no width.
    assert public(QdrantVectorReader(host="127.0.0.1", port=1)) == members


def test_a_provider_has_the_members_of_an_embedding_provider_and_no_others() -> None:
    members = public(EmbeddingProvider)
    assert members == {"dimensions", "embed_documents", "embed_query"}
    # Making a provider asks it nothing.
    assert public(OllamaEmbeddingProvider(model="a-model", base_url="http://127.0.0.1:1")) == members
    assert public(VoyageEmbeddingProvider(model="a-model", api_key="a-key", endpoint="http://127.0.0.1:1")) == members
    assert public(MockEmbeddingProvider(dimensions=3)) == members


def test_no_hand_written_line_forces_a_type_or_silences_a_checker() -> None:
    forced = [
        f"{path.relative_to(PACKAGE)}:{number}: {line.strip()}"
        for path in SOURCES
        if path.name != "test_census.py"
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if FORCED.search(line)
    ]
    assert forced == []


def test_the_http_client_is_named_only_by_the_modules_that_ask_through_it() -> None:
    # Qdrant and both providers are asked over HTTP by this package's own requests. What stands between a caller
    # and the client is a protocol: nothing else here knows a request is made.
    assert importing("httpx") == ["ollama.py", "qdrant.py", "voyage.py"]
    # The modules that say what a store and a provider are import no store and no provider.
    for module in ("memory", "qdrant", "ollama", "voyage", "mock", "factory"):
        imported_by = set(importing(rf"semiont_vectors\.{module}"))
        assert not imported_by & PROTOCOLS, module
    # One module makes a store or a provider from a configuration, and it is the one that names them all.
    for module in ("memory", "qdrant", "ollama", "voyage"):
        assert importing(rf"semiont_vectors\.{module}") == ["factory.py"], module
    assert importing(r"semiont_vectors\.mock") == []
    # A store knows no provider: the one thing it asks of one is handed to it.
    for store in ("memory.py", "qdrant.py"):
        for provider in ("ollama", "voyage", "mock"):
            assert store not in importing(rf"semiont_vectors\.{provider}"), f"{store} imports semiont_vectors.{provider}"


def test_no_store_reads_a_clock() -> None:
    # A store is handed what the record says. One that stamped a time of its own would index everything again
    # at every rebuild.
    for name in ("store.py", "payload.py", "merge.py", "memory.py", "qdrant.py"):
        source = (SRC / name).read_text(encoding="utf-8")
        assert not re.search(r"\.now\(|\.utcnow\(|\btime\.time\(|\btoday\(", source), name


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
    assert set(tools(MANIFEST)) == set(checkers)
    assert tools(MANIFEST) == {name: tools(theirs)[name] for name in checkers}

    def settings(of: Toml, tool: str, *, but: tuple[str, ...]) -> Toml:
        return {key: value for key, value in table(table(of["tool"], "tool")[tool], tool).items() if key not in but}

    # What each reads is its own package's; everything else is the same.
    assert settings(MANIFEST, "mypy", but=("files",)) == settings(theirs, "mypy", but=("files",))
    assert settings(MANIFEST, "pydantic-mypy", but=()) == settings(theirs, "pydantic-mypy", but=())
    assert settings(MANIFEST, "pytest", but=()) == settings(theirs, "pytest", but=())
    assert settings(MANIFEST, "pyright", but=("include",)) == settings(theirs, "pyright", but=("include",))
    # The SDK's formatter is told which of its modules are generated, and its linter which of its tests are
    # programs that must not type-check. This package has neither.
    assert settings(MANIFEST, "ruff", but=("lint",)) == settings(theirs, "ruff", but=("lint", "extend-exclude"))
    our_lint = table(settings(MANIFEST, "ruff", but=())["lint"], "ruff's lint")
    their_lint = table(settings(theirs, "ruff", but=())["lint"], "ruff's lint")
    assert our_lint == {key: value for key, value in their_lint.items() if key != "per-file-ignores"}
    # Which Pythons the two run on is lint:python-version's to hold: it is the one gate that reads that line.
    assert MANIFEST["build-system"] == theirs["build-system"]


def test_what_every_install_has_is_all_of_it_and_there_is_no_extra() -> None:
    project = table(MANIFEST["project"], "project")
    required = listed(project["dependencies"], "dependencies")
    assert {name_of(requirement) for requirement in required} == {"httpx", "pydantic", "semiont"}
    for library in ("httpx", "pydantic", "semiont"):
        assert importing(library), f"{library} is required and nothing imports it"
    # A dependency the SDK bounds is named here without a bound of its own.
    of_the_sdk = listed(table(toml(SDK / "pyproject.toml")["project"], "project")["dependencies"], "the SDK's dependencies")
    bounded = {name_of(requirement) for requirement in of_the_sdk}
    assert {"httpx", "pydantic"} <= bounded
    for requirement in required:
        if name_of(requirement) in bounded:
            assert requirement == name_of(requirement), f"{requirement}: the SDK states the versions of {name_of(requirement)}"
    # No database's client and no provider's library: each is asked over HTTP, so nothing is left for an extra to bring.
    assert "optional-dependencies" not in project
