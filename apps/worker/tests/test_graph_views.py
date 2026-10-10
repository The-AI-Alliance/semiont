"""The views a prompt reads off a gathered knowledge graph.

No table of `specs/src` states them. The cases are those TypeScript's own
derivation is held by (`packages/core/src/__tests__/knowledge-graph-views.test.ts`),
each graph written as the wire carries one.
"""

from typing import Final

from pydantic import JsonValue
from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import KnowledgeGraph

from semiont_worker.generation.graph_views import Citer, Connection, GraphViews, derive_views

MAIN: Final = ResourceId("res-main")


def resource(resource_id: str, label: str, entity_types: list[JsonValue]) -> JsonValue:
    return {"id": resource_id, "type": "resource", "label": label, "entityTypes": entity_types}


def annotation(annotation_id: str, on: str, label: str, entity_types: list[JsonValue]) -> JsonValue:
    """An annotation's node, the annotation itself in it, as a graph must carry one."""
    return {
        "id": annotation_id,
        "type": "annotation",
        "label": label,
        "entityTypes": entity_types,
        "annotation": {
            "@context": "http://www.w3.org/ns/anno.jsonld",
            "type": "Annotation",
            "id": annotation_id,
            "motivation": "linking",
            "target": {"source": on},
            "created": "2020-01-01T00:00:00.000Z",
        },
    }


def edge(source: str, target: str, kind: str) -> JsonValue:
    return {"source": source, "target": target, "type": kind}


def graph_of(nodes: list[JsonValue], edges: list[JsonValue]) -> KnowledgeGraph:
    return KnowledgeGraph.model_validate({"nodes": nodes, "edges": edges})


def test_an_edge_out_of_the_resource_is_a_connection_whatever_it_is_named() -> None:
    # A stored connection may be named anything, `cites` too. It is told by its ends: no annotation is at this one's,
    # so it is a connection and no citation.
    graph = graph_of(
        [resource("res-main", "Main", ["Paper"]), resource("res-peer", "Peer", ["Author"])],
        [{"source": "res-main", "target": "res-peer", "type": "cites", "bidirectional": True}],
    )

    views = derive_views(graph, MAIN, None)

    assert views == GraphViews(
        connections=[Connection(resource_id="res-peer", resource_name="Peer", entity_types=["Author"])],
        cited_by=[],
        sibling_entity_types=[],
    )


def test_a_connection_to_a_resource_the_graph_has_no_node_for_is_named_by_its_id_and_has_no_types() -> None:
    graph = graph_of([resource("res-main", "Main", [])], [edge("res-main", "res-gone", "related")])

    assert derive_views(graph, MAIN, None).connections == [Connection(resource_id="res-gone", resource_name="res-gone", entity_types=[])]


def test_a_connection_to_a_resource_whose_node_states_no_types_has_none() -> None:
    graph = graph_of(
        [resource("res-main", "Main", []), {"id": "res-peer", "type": "resource", "label": "Peer"}],
        [edge("res-main", "res-peer", "related")],
    )

    assert derive_views(graph, MAIN, None).connections == [Connection(resource_id="res-peer", resource_name="Peer", entity_types=[])]


def test_a_citer_is_a_resource_whose_annotation_cites_once_however_many_do_and_is_kept_where_its_node_is_missing() -> None:
    graph = graph_of(
        [
            resource("res-main", "Main", []),
            resource("res-citing", "Citing Paper", []),
            # Two citations from the one resource: two annotations, and one citer.
            annotation("ann-cite-1", "res-citing", "linking", []),
            annotation("ann-cite-2", "res-citing", "linking", []),
            # A citer the graph has no node for: it is named by its id.
            annotation("ann-noview", "res-noview", "linking", []),
            # An annotation that cites another resource: its own is no citer of this one.
            annotation("ann-elsewhere", "res-third", "linking", []),
        ],
        [
            edge("ann-elsewhere", "res-third", "annotation-of"),
            edge("ann-elsewhere", "res-other", "cites"),
            edge("ann-cite-1", "res-citing", "annotation-of"),
            edge("ann-cite-1", "res-main", "cites"),
            edge("ann-cite-2", "res-citing", "annotation-of"),
            edge("ann-cite-2", "res-main", "cites"),
            edge("ann-noview", "res-noview", "annotation-of"),
            edge("ann-noview", "res-main", "cites"),
        ],
    )

    views = derive_views(graph, MAIN, None)

    assert views.cited_by == [
        Citer(resource_id="res-citing", resource_name="Citing Paper"),
        Citer(resource_id="res-noview", resource_name="res-noview"),
    ]
    # A citation is no connection, and an annotation in another resource no sibling.
    assert views.connections == []
    assert views.sibling_entity_types == []


def test_the_siblings_are_the_other_annotations_in_the_resource_and_not_one_that_cites_it() -> None:
    graph = graph_of(
        [
            resource("res-main", "Main", []),
            resource("res-other", "Other", []),
            annotation("ann-focal", "res-main", "commenting", ["Focal"]),
            annotation("ann-sib-1", "res-main", "linking", ["Author", "Org"]),
            annotation("ann-sib-2", "res-main", "commenting", ["Org", "Place"]),
            # An annotation that cites the resource is in another: it is no sibling.
            annotation("ann-citing", "res-other", "linking", ["Leaky"]),
        ],
        [
            edge("ann-focal", "res-main", "annotation-of"),
            edge("ann-sib-1", "res-main", "annotation-of"),
            edge("ann-sib-2", "res-main", "annotation-of"),
            edge("ann-citing", "res-other", "annotation-of"),
            edge("ann-citing", "res-main", "cites"),
        ],
    )

    # Each type once, in the order the graph first shows it.
    assert derive_views(graph, MAIN, AnnotationId("ann-focal")).sibling_entity_types == ["Author", "Org", "Place"]
    # With no annotation in focus, every annotation in the resource is one of them.
    assert derive_views(graph, MAIN, None).sibling_entity_types == ["Focal", "Author", "Org", "Place"]


def test_a_graph_of_the_resource_alone_has_no_views() -> None:
    graph = graph_of([resource("res-main", "Main", [])], [])

    assert derive_views(graph, MAIN, None) == GraphViews(connections=[], cited_by=[], sibling_entity_types=[])
