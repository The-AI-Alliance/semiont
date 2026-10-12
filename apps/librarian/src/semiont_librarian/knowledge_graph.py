"""The knowledge graph around one resource, built from the graph database and the views.

Both gathers build it (`docs/protocol/LIBRARIAN.md` § The knowledge graph).
The first node is the resource. Then each of its connections is a node and
an edge to it; then each annotation elsewhere that refers to it, with the
resource that annotation is on; then each annotation on it. A thing is a node
once, and keeps the name it was first given.

The graph database is written after the record, by the Weaver. A resource
its view holds and the graph database does not is waited for (§ The two
waits): for `weave:applied` to reach the sequence number the view states,
then by asking the graph database again after longer and longer pauses. A
resource neither holds is unknown, and nothing waits. A resource the graph
database never comes to hold is the graph behind the views, and is not a
missing resource: it is counted, logged as a warning, and said in those
words.
"""

import asyncio
from typing import Final, final

from semiont.annotations import entity_types, target_source
from semiont.identifiers import ResourceId
from semiont.resources import resource_entity_types
from semiont.types import (
    Annotation,
    GraphAnnotationNode,
    GraphResourceNode,
    KnowledgeGraph,
    KnowledgeGraphEdgesItem,
    KnowledgeGraphNodesItem,
    ResourceDescriptor,
)

from semiont_librarian.log import LOG
from semiont_librarian.reads import Degraded, GraphReads, Views, WeaveWaits, WeaveWaitTimedOut

__all__ = ["GRAPH_WAIT_BUDGET", "GraphBehind", "ResourceUnknown", "build_knowledge_graph"]

_SIGNAL_SECONDS: Final = 0.5
"""How long a build waits for `weave:applied` to reach the sequence number a resource's view states."""

_PAUSES_SECONDS: Final = (0.025, 0.05, 0.1, 0.2)
"""The pause before each time the graph database is asked again, once the signal has come or its wait has run out."""

GRAPH_WAIT_BUDGET: Final[float] = _SIGNAL_SECONDS + sum(_PAUSES_SECONDS)
"""The longest a build waits for the graph, in seconds: the wait for the signal, and every pause after it."""

_LINK: Final = "link"
"""The type of an edge to a connection. A connection, as the graph package answers one, names no relationship type of its own."""


@final
class ResourceUnknown(Exception):
    """Neither the graph database nor the views hold the resource."""


@final
class GraphBehind(Exception):
    """The views hold the resource, and the graph database did not come to hold it within the wait. The resource is not missing."""


@final
class _Built:
    """A knowledge graph as it is built: a thing is a node once, and keeps the name it was first given."""

    def __init__(self) -> None:
        self.nodes: Final[list[KnowledgeGraphNodesItem]] = []
        self.edges: Final[list[KnowledgeGraphEdgesItem]] = []
        self._seen: Final[set[str]] = set()

    def holds(self, node: str) -> bool:
        return node in self._seen

    def resource(self, resource_id: ResourceId, label: str, types: list[str]) -> None:
        """A resource's node, unless the graph has it already."""
        if resource_id in self._seen:
            return
        self.nodes.append(GraphResourceNode(id=resource_id, type="resource", label=label, entity_types=types))
        self._seen.add(resource_id)

    def annotation(self, annotation: Annotation) -> None:
        """An annotation's node: the whole annotation, labelled by its motivation and typed by its tagging bodies."""
        self.nodes.append(
            GraphAnnotationNode(
                id=annotation.id,
                type="annotation",
                label=annotation.motivation,
                entity_types=entity_types(annotation),
                annotation=annotation,
            )
        )
        self._seen.add(annotation.id)


async def _held(resource_id: ResourceId, graph: GraphReads, views: Views, weave: WeaveWaits, degraded: Degraded) -> ResourceDescriptor:
    """The resource's description, from the graph database, waited for where the views hold the resource and it does not yet."""
    described = await graph.get_resource(resource_id)
    if described is not None:
        return described
    view = await views.get(resource_id)
    if view is None:
        raise ResourceUnknown("Resource not found")

    # The signal first: it comes at the moment the Weaver has applied what the view states. A wait that fails in any
    # way but running out is raised, and is not asked past.
    try:
        await weave.when_applied(resource_id, view.last_sequence, _SIGNAL_SECONDS)
        described = await graph.get_resource(resource_id)
    except WeaveWaitTimedOut:
        described = None
    if described is not None:
        return described

    for pause in _PAUSES_SECONDS:
        await asyncio.sleep(pause)
        described = await graph.get_resource(resource_id)
        if described is not None:
            return described

    degraded.note("graph")
    LOG.warning(
        "Gather degraded: the graph did not come to hold a resource its view holds",
        extra={"resourceId": resource_id, "lastSequence": view.last_sequence, "waitedSeconds": GRAPH_WAIT_BUDGET},
    )
    raise GraphBehind(
        f"The graph is behind the views for {resource_id}: the views hold it and the graph does not "
        "(the Weaver has not applied it yet; the resource is not missing)"
    )


async def build_knowledge_graph(
    resource_id: ResourceId, *, graph: GraphReads, views: Views, weave: WeaveWaits, degraded: Degraded
) -> KnowledgeGraph:
    """The knowledge graph around a resource: its nodes and its edges, in the order the page states.

    Raises `ResourceUnknown` where neither the graph database nor the views
    hold the resource, and `GraphBehind` where the views hold it and the
    graph database does not come to within `GRAPH_WAIT_BUDGET`. A read that
    fails is raised as it failed.
    """
    main = await _held(resource_id, graph, views, weave, degraded)
    connections = await graph.get_resource_connections(resource_id)
    referring = await graph.get_resource_referenced_by(resource_id, None)
    on_it = await graph.get_resource_annotations(resource_id)

    built = _Built()
    built.resource(resource_id, main.name, resource_entity_types(main))

    for connection in connections:
        peer = connection.target_resource
        built.resource(peer.id, peer.name, resource_entity_types(peer))
        to_it = KnowledgeGraphEdgesItem(source=resource_id, target=peer.id, type=_LINK, bidirectional=connection.bidirectional)
        built.edges.append(to_it)

    # A citation is its linking annotation: a node, placed on its citing resource by `annotation-of` and pointed at
    # this resource by `cites`. An annotation on this resource is no citation of it.
    citing: set[ResourceId] = set()
    for annotation in referring:
        source = target_source(annotation.target)
        if source == resource_id or built.holds(annotation.id):
            continue
        if source not in citing:
            citing.add(source)
            view = await views.get(source)
            if view is None:
                built.resource(source, source, [])
            else:
                built.resource(source, view.resource.name, resource_entity_types(view.resource))
        built.annotation(annotation)
        built.edges.append(KnowledgeGraphEdgesItem(source=annotation.id, target=source, type="annotation-of"))
        built.edges.append(KnowledgeGraphEdgesItem(source=annotation.id, target=resource_id, type="cites"))

    for annotation in on_it:
        if built.holds(annotation.id):
            continue
        built.annotation(annotation)
        built.edges.append(KnowledgeGraphEdgesItem(source=annotation.id, target=resource_id, type="annotation-of"))

    return KnowledgeGraph(nodes=built.nodes, edges=built.edges)
