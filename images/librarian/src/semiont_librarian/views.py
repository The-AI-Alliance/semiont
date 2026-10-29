"""The lists read off a knowledge graph for one resource: what it is connected to, what cites it, and its siblings' entity types.

A knowledge graph holds resources and annotations as nodes
(`docs/protocol/LIBRARIAN.md` § The lists read off a graph). A citation of a
resource is a linking annotation: a node with an `annotation-of` edge to the
resource it is on, and a `cites` edge to the resource it cites. So what cites
a resource is found through that pair of edges, and a connection between two
resources may be named anything, `cites` among it. The graph is read as it
is: a resource the graph has no node for is kept, and named by its id.

The reference search reads the first two lists from the context it is given,
and the relationship prompt is made from all three.
"""

from dataclasses import dataclass
from typing import final

from semiont.types import GraphAnnotationNode, KnowledgeGraph, KnowledgeGraphNodesItem

__all__ = ["Citer", "Connection", "GraphViews", "derive_views"]


@final
@dataclass(frozen=True, slots=True)
class Connection:
    """A resource an edge leads to from the main resource."""

    resource_id: str
    resource_name: str
    """The node's label, or the id where the graph has no node for it."""
    entity_types: tuple[str, ...]
    """The node's entity types: none where the node states none, and where the graph has no node for it."""
    bidirectional: bool
    """The edge's flag: false where the edge states none."""


@final
@dataclass(frozen=True, slots=True)
class Citer:
    """A resource that cites the main resource."""

    resource_id: str
    resource_name: str
    """The node's label, or the id where the graph has no node for it."""


@final
@dataclass(frozen=True, slots=True)
class GraphViews:
    """What is read off a knowledge graph for its main resource."""

    connections: tuple[Connection, ...]
    """One for each edge out of the main resource that is no citation, in the order of the edges."""
    cited_by: tuple[Citer, ...]
    """Each citing resource once, however many of its annotations cite, in the order of the first citation from each."""
    sibling_entity_types: tuple[str, ...]
    """The entity types of the other annotations on the main resource, each once, in the order the nodes first state it."""

    @property
    def cited_by_count(self) -> int:
        """How many resources cite the main resource."""
        return len(self.cited_by)


def derive_views(graph: KnowledgeGraph, main_resource_id: str, focal_annotation_id: str | None) -> GraphViews:
    """The lists read off `graph` for `main_resource_id`.

    An annotation is on the target of its `annotation-of` edge, and on the
    target of the last such edge where the graph states more than one. A
    `cites` edge to the main resource from an annotation that is on a
    resource makes that resource one that cites it. Any other edge out of
    the main resource is a connection. The siblings are the annotations on
    the main resource but for `focal_annotation_id`: an annotation is no
    sibling of itself, and one that cites the main resource is on another.
    """
    # An edge names its two ends as text, of either kind of node: the nodes are looked up by that text.
    node_by_id: dict[str, KnowledgeGraphNodesItem] = {node.id: node for node in graph.nodes}
    resource_of: dict[str, str] = {edge.source: edge.target for edge in graph.edges if edge.type == "annotation-of"}

    connections: list[Connection] = []
    cited_by: dict[str, Citer] = {}
    for edge in graph.edges:
        citing = resource_of.get(edge.source) if edge.type == "cites" and edge.target == main_resource_id else None
        if citing is not None:
            if citing not in cited_by:
                node = node_by_id.get(citing)
                cited_by[citing] = Citer(resource_id=citing, resource_name=citing if node is None else node.label)
        elif edge.source == main_resource_id:
            node = node_by_id.get(edge.target)
            connections.append(
                Connection(
                    resource_id=edge.target,
                    resource_name=edge.target if node is None else node.label,
                    entity_types=() if node is None or node.entity_types is None else tuple(node.entity_types),
                    bidirectional=False if edge.bidirectional is None else edge.bidirectional,
                )
            )

    siblings: dict[str, None] = {}
    for node in graph.nodes:
        a_sibling = node.id != focal_annotation_id and resource_of.get(node.id) == main_resource_id
        if isinstance(node, GraphAnnotationNode) and a_sibling and node.entity_types is not None:
            siblings.update(dict.fromkeys(node.entity_types))

    return GraphViews(connections=tuple(connections), cited_by=tuple(cited_by.values()), sibling_entity_types=tuple(siblings))
