"""The knowledge graph around one resource, built from the graph database and the views.

Both gathers build it (`docs/protocol/LIBRARIAN.md` § The knowledge graph).
The first node is the resource. Then each of its connections is a node and
an edge to it; then each annotation elsewhere that refers to it, with the
resource that annotation is on; then each annotation on it. A thing is a node
once, and keeps the name it was first given.

That is the graph one link out, and a depth of 1. A greater depth reaches
further, a link at a time and nearest first: each resource the last step
added is asked for what it links to and for what cites it, and each of those
is a resource node with a `link` edge between the two. Only the resource the
graph is built around has its annotations as nodes. The graph stops taking
resources at `RESOURCE_CEILING`, and then says that it is `truncated`.

The graph database is written after the record, by the Weaver. A resource
its view holds and the graph database does not is waited for (§ The two
waits): for `weave:applied` to reach the sequence number the view states,
then by asking the graph database again after longer and longer pauses. A
resource neither holds is unknown, and nothing waits. A resource the graph
database never comes to hold is the graph behind the views, and is not a
missing resource: it is counted, logged as a warning, and said in those
words. Only the resource the graph is built around is waited for.
"""

import asyncio
from collections.abc import Sequence
from typing import Final, final

from semiont.annotations import entity_types, target_source
from semiont.identifiers import ResourceId
from semiont.model import stated
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

from semiont_librarian.grace import view_if_readable
from semiont_librarian.log import LOG
from semiont_librarian.reads import Degraded, GraphReads, Views, WeaveWaits, WeaveWaitTimedOut

__all__ = [
    "GRAPH_WAIT_BUDGET",
    "LARGEST_DEPTH",
    "LEAST_DEPTH",
    "RESOURCE_CEILING",
    "DepthRefused",
    "GraphBehind",
    "ResourceUnknown",
    "build_knowledge_graph",
    "refuse_depth_out_of_bounds",
]

LEAST_DEPTH: Final = 1
"""The least depth a graph is built to: one link out from its resource."""

LARGEST_DEPTH: Final = 3
"""The greatest depth a graph is built to."""

RESOURCE_CEILING: Final = 200
"""How many resource nodes a graph holds before a further link out adds no more."""

_SIGNAL_SECONDS: Final = 0.5
"""How long a build waits for `weave:applied` to reach the sequence number a resource's view states."""

_PAUSES_SECONDS: Final = (0.025, 0.05, 0.1, 0.2)
"""The pause before each time the graph database is asked again, once the signal has come or its wait has run out."""

GRAPH_WAIT_BUDGET: Final[float] = _SIGNAL_SECONDS + sum(_PAUSES_SECONDS)
"""The longest a build waits for the graph, in seconds: the wait for the signal, and every pause after it."""

_LINK: Final = "link"
"""The type of an edge between two resources. A connection, as the graph package answers one, names no relationship type of its own."""


@final
class DepthRefused(Exception):
    """A graph's depth is less than `LEAST_DEPTH` or more than `LARGEST_DEPTH`: nothing is built."""


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
        self.resources: Final[list[ResourceId]] = []
        """Each resource that is a node, in the order it became one."""
        self.kept_out = False
        """Whether the ceiling kept a resource out."""
        self._seen: Final[set[str]] = set()
        self._linked: Final[set[tuple[str, str]]] = set()
        self._both_ways: Final[set[tuple[str, str]]] = set()

    def holds(self, node: str) -> bool:
        return node in self._seen

    def resource(self, resource_id: ResourceId, label: str, types: list[str]) -> None:
        """A resource's node, unless the graph has it already."""
        if resource_id in self._seen:
            return
        self.nodes.append(GraphResourceNode(id=resource_id, type="resource", label=label, entity_types=types))
        self._seen.add(resource_id)
        self.resources.append(resource_id)

    def has_room_for(self, resource_id: ResourceId) -> bool:
        """Whether a resource is a node already, or may become one. One the ceiling keeps out is noted as kept out."""
        if resource_id in self._seen or len(self.resources) < RESOURCE_CEILING:
            return True
        self.kept_out = True
        return False

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

    def connection(self, source: ResourceId, target: ResourceId, bidirectional: bool) -> None:
        """The edge of a connection of the resource the graph is built around: each connection has its own, whatever the graph has."""
        self.edges.append(KnowledgeGraphEdgesItem(source=source, target=target, type=_LINK, bidirectional=bidirectional))
        self._note(source, target, bidirectional)

    def link(self, source: ResourceId, target: ResourceId, bidirectional: bool | None) -> None:
        """The edge of a link found further out, unless the graph has it. `bidirectional` is `None` where nothing said.

        The graph has a link where it has an edge from the one resource to
        the other, and where it has the edge the other way and that edge
        says it goes both ways.
        """
        if (source, target) in self._linked or (target, source) in self._both_ways:
            return
        if bidirectional is None:
            self.edges.append(KnowledgeGraphEdgesItem(source=source, target=target, type=_LINK))
        else:
            self.edges.append(KnowledgeGraphEdgesItem(source=source, target=target, type=_LINK, bidirectional=bidirectional))
        self._note(source, target, bidirectional)

    def _note(self, source: ResourceId, target: ResourceId, bidirectional: bool | None) -> None:
        self._linked.add((source, target))
        if bidirectional:
            self._both_ways.add((source, target))


def refuse_depth_out_of_bounds(depth: int) -> None:
    """Refuse a graph's depth that is out of bounds. This is the one place that says what the bounds are, and in what words.

    Raises `DepthRefused` for a depth less than `LEAST_DEPTH` or more than
    `LARGEST_DEPTH`. A gather around a resource asks this before it reads
    anything.
    """
    if not LEAST_DEPTH <= depth <= LARGEST_DEPTH:
        raise DepthRefused(f"depth must be between {LEAST_DEPTH} and {LARGEST_DEPTH}")


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


async def _one_link_further(built: _Built, frontier: Sequence[ResourceId], *, graph: GraphReads, views: Views) -> list[ResourceId]:
    """Take the graph one link further out from `frontier`, the resources its last step added. Answers the resources this step added.

    Each resource of the frontier is asked, in order, for what it links to
    and then for what cites it. Each answer is a resource node, unless the
    graph has it or has no room for it, and a `link` edge between the two,
    unless the graph has it. A resource that links to another is named and
    typed by the description the graph database answers with the connection;
    one that cites another by its view, or by its id where it has no view.
    No annotation becomes a node.
    """
    added_from = len(built.resources)
    for at in frontier:
        for connection in await graph.get_resource_connections(at):
            peer = connection.target_resource
            if not built.has_room_for(peer.id):
                continue
            built.resource(peer.id, peer.name, resource_entity_types(peer))
            built.link(at, peer.id, connection.bidirectional)
        for annotation in await graph.get_resource_referenced_by(at, None):
            source = target_source(annotation.target)
            if source == at or not built.has_room_for(source):
                continue
            if not built.holds(source):
                await _cited_from(built, source, views)
            built.link(source, at, None)
    return built.resources[added_from:]


async def _cited_from(built: _Built, source: ResourceId, views: Views) -> None:
    """The node of a resource that cites another: named and typed by its view, and by its id alone where it has no view that can be read."""
    view = await view_if_readable(views, source)
    if view is None:
        built.resource(source, source, [])
    else:
        built.resource(source, view.resource.name, resource_entity_types(view.resource))


async def build_knowledge_graph(
    resource_id: ResourceId, *, graph: GraphReads, views: Views, weave: WeaveWaits, degraded: Degraded, depth: int
) -> KnowledgeGraph:
    """The knowledge graph around a resource, `depth` links out: its nodes and its edges, in the order the page states.

    Raises `DepthRefused` for a depth out of bounds, before anything is
    read; `ResourceUnknown` where neither the graph database nor the views
    hold the resource; and `GraphBehind` where the views hold it and the
    graph database does not come to within `GRAPH_WAIT_BUDGET`. A read that
    fails is raised as it failed.
    """
    refuse_depth_out_of_bounds(depth)
    main = await _held(resource_id, graph, views, weave, degraded)
    connections = await graph.get_resource_connections(resource_id)
    referring = await graph.get_resource_referenced_by(resource_id, None)
    on_it = await graph.get_resource_annotations(resource_id)

    built = _Built()
    built.resource(resource_id, main.name, resource_entity_types(main))

    for connection in connections:
        peer = connection.target_resource
        built.resource(peer.id, peer.name, resource_entity_types(peer))
        built.connection(resource_id, peer.id, connection.bidirectional)

    # A citation is its linking annotation: a node, placed on its citing resource by `annotation-of` and pointed at
    # this resource by `cites`. An annotation on this resource is no citation of it.
    for annotation in referring:
        source = target_source(annotation.target)
        if source == resource_id or built.holds(annotation.id):
            continue
        # A citing resource that is a node already, as one this resource links to is, is not read again.
        if not built.holds(source):
            await _cited_from(built, source, views)
        built.annotation(annotation)
        built.edges.append(KnowledgeGraphEdgesItem(source=annotation.id, target=source, type="annotation-of"))
        built.edges.append(KnowledgeGraphEdgesItem(source=annotation.id, target=resource_id, type="cites"))

    for annotation in on_it:
        if built.holds(annotation.id):
            continue
        built.annotation(annotation)
        built.edges.append(KnowledgeGraphEdgesItem(source=annotation.id, target=resource_id, type="annotation-of"))

    # That is one link out. Each further link out starts from the resources the last one added, so the nearest come first.
    frontier: Sequence[ResourceId] = built.resources[1:]
    for _ in range(LEAST_DEPTH, depth):
        frontier = await _one_link_further(built, frontier, graph=graph, views=views)

    # `truncated` is said only where it is true.
    return stated(KnowledgeGraph(nodes=built.nodes, edges=built.edges, truncated=True if built.kept_out else None))
