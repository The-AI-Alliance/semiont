"""Making a store or a reader from what a service's configuration names: the kind of graph database, and what it needs to be reached."""

from typing import assert_never

from semiont.types import GraphConfig, JanusGraphConfig, MemoryGraphConfig, Neo4jGraphConfig, NeptuneGraphConfig

from semiont_graph.interface import GraphDatabase, GraphReader

__all__ = ["create_graph_database", "create_graph_reader"]


def create_graph_database(config: GraphConfig, *, password: str | None) -> GraphDatabase:
    """The store of the graph database `config` names. Nothing is dialled: a store reaches its database when it is connected.

    `config` is the protocol's `GraphConfig`, as a service's configuration
    document states it. A password is never in it: the document names the
    environment variable that holds one, and whoever reads the environment
    hands the password here. It is `None` for a database that takes none.
    Neo4j takes one, and is refused without it.

    A store's module is imported when its database is asked for, and not
    before: a database's own client is needed only by whoever asks for that
    database. Asked for one whose client is not installed, this raises a
    `ModuleNotFoundError` that names the extra to install.
    """
    match config:
        case Neo4jGraphConfig():
            if password is None or password == "":
                raise ValueError("password is required for the neo4j store")
            from semiont_graph.neo4j import Neo4jGraphDatabase

            return Neo4jGraphDatabase(uri=config.uri, username=config.username, password=password, database=config.database)
        case JanusGraphConfig():
            from semiont_graph.janusgraph import JanusGraphDatabase

            return JanusGraphDatabase(host=config.host, port=config.port)
        case NeptuneGraphConfig():
            from semiont_graph.neptune import NeptuneGraphDatabase

            return NeptuneGraphDatabase(endpoint=config.endpoint, port=config.port)
        case MemoryGraphConfig():
            from semiont_graph.memory import MemoryGraphDatabase

            return MemoryGraphDatabase()
        case _:
            assert_never(config)


def create_graph_reader(config: GraphConfig, *, password: str | None) -> GraphReader:
    """The reader of the graph database `config` names. Nothing is dialled: a reader reaches its database when it is connected.

    `config` and `password` are as `create_graph_database` takes them, and a
    module is imported as it imports one. Neo4j takes a password, and is
    refused without it.

    A reader makes nothing in its database. Neo4j has a reader of its own,
    which runs no schema statement when it connects. A JanusGraph and a
    Neptune are read by their stores, handed over as readers: connecting
    either asks the server one traversal that reads, and makes nothing. A
    reader in memory is a graph of its own, held in the process, that
    nothing has written to: it answers every read with nothing.
    """
    match config:
        case Neo4jGraphConfig():
            if password is None or password == "":
                raise ValueError("password is required for the neo4j reader")
            from semiont_graph.neo4j import Neo4jGraphReader

            return Neo4jGraphReader(uri=config.uri, username=config.username, password=password, database=config.database)
        case JanusGraphConfig():
            from semiont_graph.janusgraph import JanusGraphDatabase

            return JanusGraphDatabase(host=config.host, port=config.port)
        case NeptuneGraphConfig():
            from semiont_graph.neptune import NeptuneGraphDatabase

            return NeptuneGraphDatabase(endpoint=config.endpoint, port=config.port)
        case MemoryGraphConfig():
            from semiont_graph.memory import MemoryGraphDatabase

            return MemoryGraphDatabase()
        case _:
            assert_never(config)
