"""What a prompt says of a resource's neighbourhood, read off the knowledge graph gathered for it.

The graph holds resources and annotations as nodes. A citation of a resource
is a linking annotation: a node with an `annotation-of` edge to the resource
it is in, and a `cites` edge to the resource it cites. So who cites a
resource is found through that pair of edges, and never by an edge's name
alone: a connection between two resources may be named anything, `cites`
among it. The graph is reported as it is. A citer whose own node is missing
is kept, and named by its id.
"""

from dataclasses import dataclass
from typing import final

from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import GraphAnnotationNode, KnowledgeGraph, KnowledgeGraphNodesItem


@final
@dataclass(frozen=True, slots=True)
class Connection:
    """A resource an edge leads to from the resource in focus."""

    resource_id: str
    resource_name: str
    """The node's label, or the id where the graph has no node for it."""
    entity_types: list[str]


@final
@dataclass(frozen=True, slots=True)
class Citer:
    """A resource that cites the resource in focus."""

    resource_id: str
    resource_name: str
    """The node's label, or the id where the graph has no node for it."""


@final
@dataclass(frozen=True, slots=True)
class GraphViews:
    """The neighbourhood of one resource, flattened."""

    connections: list[Connection]
    """One for each edge out of the resource, in the graph's order."""
    cited_by: list[Citer]
    """Each citing resource once, however many of its annotations cite, in the order the graph first shows one."""
    sibling_entity_types: list[str]
    """The entity types of the other annotations in the resource, each once, in the order the graph first shows it."""


def derive_views(graph: KnowledgeGraph, main_resource_id: ResourceId, focal_annotation_id: AnnotationId | None) -> GraphViews:
    """The views of `graph` around `main_resource_id`.

    An annotation's resource is the target of its `annotation-of` edge. An
    edge that `cites` the main resource from an annotation with a resource
    makes that resource a citer. Any other edge out of the main resource is a
    connection. The siblings are the annotations in the main resource, less
    `focal_annotation_id`: an annotation is no sibling of itself, and one
    that cites the resource is in another.
    """
    # An edge names its ends as text, of either kind of node: the nodes are looked up by that text.
    node_by_id: dict[str, KnowledgeGraphNodesItem] = {node.id: node for node in graph.nodes}
    # Both the citers and the siblings are found through this, which is what keeps them told by the graph's
    # shape: a connection that happens to be named `cites` starts at no annotation that has a resource.
    resource_of = {edge.source: edge.target for edge in graph.edges if edge.type == "annotation-of"}

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
                    entity_types=[] if node is None or node.entity_types is None else node.entity_types,
                )
            )

    siblings: dict[str, None] = {}
    for node in graph.nodes:
        in_the_resource = resource_of.get(node.id) == main_resource_id
        if isinstance(node, GraphAnnotationNode) and node.id != focal_annotation_id and in_the_resource and node.entity_types is not None:
            siblings.update(dict.fromkeys(node.entity_types))

    return GraphViews(connections=connections, cited_by=list(cited_by.values()), sibling_entity_types=list(siblings))
