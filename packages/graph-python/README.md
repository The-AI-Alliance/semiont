# semiont-graph

The graph databases [Semiont][semiont]'s Python services write and read,
behind one interface: what the graph holds of a resource and of an
annotation, and the questions only a graph answers.

It is for whoever writes a Semiont service in Python that keeps the graph or
reads it: the Weaver first. A program that only reads and writes a knowledge
base needs the SDK, [`semiont`][sdk-python], and not this package.

It runs on asyncio and requires Python 3.12 or later. It is checked by
`mypy --strict` and by `pyright` in strict mode, and ships its types
(`py.typed`). It is the Python counterpart of [`@semiont/graph`][graph-typescript].

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
whose client is not installed, `create_graph_database` raises a
`ModuleNotFoundError` that names the extra to install.

**The two Gremlin stores are kept as a reminder of other kinds of graph
database, and nothing is known of them against a server.** Each was ported
from its TypeScript store onto a fake client. Each module's first lines say
what it is known to get wrong.

## A first use

A store is made from what a service's configuration document states of its
graph database (`GraphConfig`), and reaches the database when it is
connected. A password is never in the document: the document names the
environment variable that holds it, and whoever reads the environment hands
the password over.

```python
from semiont.identifiers import ResourceId
from semiont.types import GraphConfig, ResourceDescriptor
from semiont_graph.factory import create_graph_database


async def read(config: GraphConfig, password: str | None, resource_id: ResourceId) -> ResourceDescriptor | None:
    graph = create_graph_database(config, password=password)
    await graph.connect()
    try:
        return await graph.get_resource(resource_id)
    finally:
        await graph.disconnect()
```

## What is where

Every name is imported from the module that has it. The package's root
exports nothing.

- `semiont_graph.interface`: `GraphDatabase`, the protocol every store is,
  and what its members take and answer.
- `semiont_graph.codec`: how a resource and an annotation become stored
  properties and back, and `intended_graph_annotation`, which says what the
  graph is to hold of an annotation.
- `semiont_graph.factory`: `create_graph_database`.
- `semiont_graph.memory`, `semiont_graph.neo4j`, `semiont_graph.janusgraph`,
  `semiont_graph.neptune`: one store each.

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
`NEO4J_PASSWORD`. It clears that database before and after each case, and
fails, and is not skipped, without the two.

[semiont]: https://github.com/The-AI-Alliance/semiont
[sdk-python]: https://github.com/The-AI-Alliance/semiont/tree/main/packages/sdk-python
[graph-typescript]: https://github.com/The-AI-Alliance/semiont/tree/main/packages/graph
[codec-cases]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/graph/codec-cases.json
