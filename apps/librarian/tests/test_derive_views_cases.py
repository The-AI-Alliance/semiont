"""The lists read off a knowledge graph, held to `specs/src/librarian/derive-views-cases.json`.

It is the table every implementation of the reading runs, so that one graph
gives one set of connections, citations and sibling entity types in any
language. A case is run through `derive_views` and through nothing else.

A case's graph is decoded as the SDK's `KnowledgeGraph`, so a graph the spec
does not accept cannot be read, and fails. What is read off it is put in the
table's words and compared whole with what the case states, each list in its
order. A member of a case that has no place here fails.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, final

import pytest
from pydantic import JsonValue
from semiont.types import KnowledgeGraph
from spec import SPEC, JsonObject, objects, read, text, thing

from semiont_librarian.views import GraphViews, derive_views

PLACES: Final = frozenset({"why", "graph", "resource", "annotation", "views"})
"""The members a case may have."""


@final
@dataclass(frozen=True, slots=True)
class Case:
    """One case of the table."""

    why: str
    graph: KnowledgeGraph
    resource: str
    annotation: str | None
    """The focal annotation, where the case has one."""
    views: JsonObject
    """What is read, as the table words it."""


def case_of(stated: JsonObject) -> Case:
    """A case, from what the table states of it."""
    why = text(stated["why"], "a case's why")
    assert set(stated) <= PLACES, f"{why}: {sorted(set(stated) - PLACES)} has no place in a case"
    annotation = stated.get("annotation")
    return Case(
        why=why,
        graph=KnowledgeGraph.model_validate(stated["graph"]),
        resource=text(stated["resource"], f"{why}: resource"),
        annotation=None if annotation is None else text(annotation, f"{why}: annotation"),
        views=thing(stated["views"], f"{why}: views"),
    )


CASES: Final = [case_of(stated) for stated in objects(read(SPEC / "librarian/derive-views-cases.json")["cases"], "cases")]


def listed(texts: Sequence[str]) -> list[JsonValue]:
    """Texts, as a list the table can be compared with."""
    return [*texts]


def in_table_words(views: GraphViews) -> JsonObject:
    """What was read off a graph, as the table words it: the one place the names of `GraphViews` meet the table's."""
    connections: list[JsonValue] = [
        {
            "resourceId": connection.resource_id,
            "resourceName": connection.resource_name,
            "entityTypes": listed(connection.entity_types),
            "bidirectional": connection.bidirectional,
        }
        for connection in views.connections
    ]
    cited_by: list[JsonValue] = [{"resourceId": citer.resource_id, "resourceName": citer.resource_name} for citer in views.cited_by]
    return {
        "connections": connections,
        "citedBy": cited_by,
        "citedByCount": views.cited_by_count,
        "siblingEntityTypes": listed(views.sibling_entity_types),
    }


def test_the_runner_found_the_table_s_cases() -> None:
    assert len(CASES) >= 20


def test_each_case_is_told_from_the_others_by_its_why() -> None:
    whys = [case.why for case in CASES]
    assert len(set(whys)) == len(whys)


def test_the_table_has_cases_with_a_focal_annotation_and_with_none() -> None:
    assert any(case.annotation is not None for case in CASES)
    assert any(case.annotation is None for case in CASES)


def test_every_case_states_all_four_of_what_is_read() -> None:
    for case in CASES:
        assert sorted(case.views) == ["citedBy", "citedByCount", "connections", "siblingEntityTypes"], case.why


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.why)
def test_a_graph_is_read_into_the_lists_the_table_states(case: Case) -> None:
    assert in_table_words(derive_views(case.graph, case.resource, case.annotation)) == case.views, case.why
