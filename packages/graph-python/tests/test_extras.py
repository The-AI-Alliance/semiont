"""A database's own client is an extra: the package is whole without it, and says what to install when a store needs it.

Each program here is run by an interpreter of its own, so that what it
imports is what the program itself asked for, and not what another test had
already imported.
"""

import subprocess
import sys

# The modules of a database's own client that a program has imported.
LOADED = 'sorted(name for name in sys.modules if name.split(".")[0] in ("neo4j", "gremlin_python"))'

NEO4J = 'Neo4jGraphConfig(type="neo4j", uri="bolt://127.0.0.1:1", username="neo4j", password_env="NEO4J_PASSWORD", database="neo4j")'

ASKING_FOR_NEITHER = f"""
import sys
import semiont_graph
from semiont.types import MemoryGraphConfig
from semiont_graph.codec import intended_graph_annotation
from semiont_graph.factory import create_graph_database
from semiont_graph.interface import GraphDatabase

store = create_graph_database(MemoryGraphConfig(type="memory"), password=None)
print(type(store).__name__, {LOADED}, "semiont_graph.neo4j" in sys.modules, "semiont_graph.janusgraph" in sys.modules)
"""

ASKING_FOR_NEO4J = f"""
import sys
from semiont.types import Neo4jGraphConfig
from semiont_graph.factory import create_graph_database

store = create_graph_database({NEO4J}, password="p")
print(type(store).__name__, store.is_connected(), "neo4j" in sys.modules, "semiont_graph.neo4j" in sys.modules)
"""

WITHOUT_THE_CLIENT = f"""
import sys

sys.modules["neo4j"] = None  # as an interpreter has it where the client is not installed
from semiont.types import MemoryGraphConfig, Neo4jGraphConfig
from semiont_graph.factory import create_graph_database

for ask in ("the factory", "the module"):
    try:
        if ask == "the factory":
            create_graph_database({NEO4J}, password="p")
        else:
            import semiont_graph.neo4j
    except ModuleNotFoundError as missing:
        print(ask, "|", type(missing).__name__, "|", missing.name, "|", type(missing.__cause__).__name__, "|", missing)
print(type(create_graph_database(MemoryGraphConfig(type="memory"), password=None)).__name__)
"""

WITHOUT_A_PASSWORD = f"""
from semiont.types import Neo4jGraphConfig
from semiont_graph.factory import create_graph_database

for password in (None, ""):
    try:
        create_graph_database({NEO4J}, password=password)
    except ValueError as refused:
        print(refused)
"""


def alone(program: str) -> str:
    """What `program` printed, run by an interpreter of its own."""
    ran = subprocess.run([sys.executable, "-c", program], capture_output=True, text=True, check=False)
    assert ran.returncode == 0, ran.stderr
    return ran.stdout


def test_the_package_its_codec_and_the_store_in_memory_import_no_part_of_a_databases_client() -> None:
    assert alone(ASKING_FOR_NEITHER) == "MemoryGraphDatabase [] False False\n"


def test_asking_for_the_neo4j_store_is_what_imports_the_client_and_making_it_dials_nothing() -> None:
    # The other half: the program above would print the same of a package that never imported the client at all.
    assert alone(ASKING_FOR_NEO4J) == "Neo4jGraphDatabase False True True\n"


def test_without_the_client_the_neo4j_store_fails_naming_the_extra_and_the_store_in_memory_is_made() -> None:
    said = "The neo4j store needs Neo4j's `neo4j` client, which is not installed. It comes with the extra: install `semiont-graph[neo4j]`."
    assert alone(WITHOUT_THE_CLIENT).splitlines() == [
        f"the factory | ModuleNotFoundError | neo4j | ModuleNotFoundError | {said}",
        f"the module | ModuleNotFoundError | neo4j | ModuleNotFoundError | {said}",
        "MemoryGraphDatabase",
    ]


def test_the_neo4j_store_is_refused_without_its_password() -> None:
    assert alone(WITHOUT_A_PASSWORD).splitlines() == ["password is required for the neo4j store"] * 2
