# semiont-graph

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=python-graph)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The graph databases [Semiont][semiont]'s Python services write and read,
behind one interface: what the graph holds of a resource and of an
annotation, and the questions only a graph answers.

It is for whoever writes a Semiont service in Python that keeps the graph or
reads it: the Weaver keeps it, and the Librarian reads it. A program that
only reads and writes a knowledge base needs the SDK,
[`semiont`][sdk-python], and not this package.

It runs on asyncio and requires Python 3.12 or later. It is checked by
`mypy --strict` and by `pyright` in strict mode, and ships its types
(`py.typed`).

## What an install has

The package alone has the interface, the codec and the store that holds its
graph in the process. Its dependencies are `semiont` and `pydantic`.

The client a store asks its database through is not required. It comes with
the extra named for the store, and is imported only when that store is asked
for:

| Store | Install | What the extra brings | Run against a server |
| --- | --- | --- | --- |
| `memory` | `semiont-graph` | Nothing: the graph is in the process | It needs none |
| `neo4j` | `semiont-graph[neo4j]` | Neo4j's `neo4j` client | Yes: every case of the store contract |
| `janusgraph` | `semiont-graph[janusgraph]` | Apache TinkerPop's `gremlinpython` | **Never** |
| `neptune` | `semiont-graph[neptune]` | Apache TinkerPop's `gremlinpython` | **Never, nor on AWS** |

An image built for one database installs that store's extra alone. One that
may be configured for any database installs every extra. Asked for a store
or a reader whose client is not installed, `create_graph_database` and
`create_graph_reader` raise a `ModuleNotFoundError` that names the extra to
install.

**The two Gremlin stores are kept as a reminder of other kinds of graph
database, and nothing is known of them against a server.** Each is tested
against a fake client alone. Each module's first lines say
what it is known to get wrong.

## A first use

A store is made from what a service's configuration document states of its
graph database (`GraphConfig`), and reaches the database when it is
connected. A password is never in the document: the document names the
environment variable that holds it, and whoever reads the environment hands
the password over.

```python
from semiont.types import GraphConfig, ResourceDescriptor
from semiont_graph.factory import create_graph_database
from semiont_graph.interface import GraphDatabase


async def stored(config: GraphConfig, password: str | None, resource: ResourceDescriptor) -> GraphDatabase:
    graph = create_graph_database(config, password=password)
    await graph.connect()
    await graph.create_resource(resource)
    return graph
```

A service that only reads the graph is handed a reader. A reader has the six
reads such a service makes and nothing that writes, and it makes nothing in
its database: connecting one to a Neo4j makes no constraint and no index. A
read of a database nobody has written to yet answers nothing.

```python
from semiont.identifiers import ResourceId
from semiont.types import GraphConfig, ResourceDescriptor
from semiont_graph.factory import create_graph_reader


async def read(config: GraphConfig, password: str | None, resource_id: ResourceId) -> ResourceDescriptor | None:
    graph = create_graph_reader(config, password=password)
    await graph.connect()
    try:
        return await graph.get_resource(resource_id)
    finally:
        await graph.disconnect()
```

What `create_graph_reader` answers for each kind of database:

| Kind | The reader | What connecting it does |
| --- | --- | --- |
| `neo4j` | `Neo4jGraphReader` | Asks the database for an answer. No schema statement is run |
| `janusgraph` | The store, handed over as a reader | Asks the server one traversal that reads |
| `neptune` | The store, handed over as a reader | Asks the server one traversal that reads |
| `memory` | The store, handed over as a reader | Nothing: it is a graph of its own, which holds nothing |

## What is where

Every name is imported from the module that has it. The package's root
exports nothing.

- `semiont_graph.interface`: `GraphReader`, the protocol every reader is
  (`connect`, `disconnect`, `get_resource`, `list_resources`,
  `get_resource_annotations`, `get_resource_referenced_by`,
  `get_resource_connections`, `get_entity_type_stats`); `GraphDatabase`, the
  protocol every store is, which is a reader's members, `is_connected`, the
  writes (`create_resource`, `update_resource`, `delete_resource`,
  `create_annotation`, `update_annotation`, `delete_annotation`,
  `resolve_reference`, `clear_database`) and three more reads
  (`get_annotation`, `find_path`, `get_stats`); and what their members take
  and answer.
- `semiont_graph.codec`: how a resource and an annotation become stored
  properties and back, and `intended_graph_annotation`, which says what the
  graph is to hold of an annotation.
- `semiont_graph.factory`: `create_graph_database` and `create_graph_reader`,
  which make the store and the reader a service's configuration document
  names.
- `semiont_graph.neo4j`: `Neo4jGraphDatabase`, which makes its constraints
  and its indexes when it connects, and `Neo4jGraphReader`, which makes
  nothing.
- `semiont_graph.memory`, `semiont_graph.janusgraph`,
  `semiont_graph.neptune`: one store each, and so a reader too.

## What the graph holds

The graph is a projection of a knowledge base's record, and not a copy of
it: it holds what the questions that cross documents need. What is stored of
an annotation and of a resource, what each stored thing is called, which are
required and what is refused are stated once, in
[`specs/src/graph/codec-cases.json`][codec-cases], and every implementation
of the codecs runs that table. A store keeps its own dialect and decides
nothing about the shape.

A store is given what the record says and reads no clock of its own. Every
date in the graph is one an event carried.

## Testing it

```sh
uv sync --locked
uv run pytest                       # needs no database
uv run pytest tests/neo4j_live.py   # against a real neo4j
```

The second run is told where a neo4j is by `NEO4J_HOST`, and its password by
`NEO4J_PASSWORD`. It fails, and is not skipped, without the two. It clears
that database before and after each case. The reader's cases also drop the
constraints and the indexes a store makes, and a store that connects makes
them again.

[semiont]: https://github.com/The-AI-Alliance/semiont
[sdk-python]: https://github.com/The-AI-Alliance/semiont/tree/main/packages/python/sdk
[codec-cases]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/graph/codec-cases.json
