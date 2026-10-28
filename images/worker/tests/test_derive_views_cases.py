"""The views a generation prompt reads off a gathered graph, held to `specs/src/librarian/derive-views-cases.json`.

It is the table every reader of a gathered knowledge graph runs, so that one
graph gives one set of connections, citations and sibling entity types in any
language. A case's graph is decoded as the SDK's `KnowledgeGraph`, so a graph
the spec does not accept cannot be read, and fails.

The Worker reads less than the table states, and is held to all that it reads.
Its prompt says nothing of whether a connection is bidirectional, and counts
the citing resources itself, so neither a connection's `bidirectional` nor the
views' `citedByCount` is compared here.
"""

from typing import Annotated, Final

import pytest
from pydantic import BaseModel, Field
from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import KnowledgeGraph
from spec import SPEC

from semiont_worker.generation.graph_views import Citer, Connection, GraphViews, derive_views


class Stated(BaseModel, frozen=True, extra="forbid", strict=True):
    """Something the table states: a member it does not have a place for here cannot be read, and fails."""


class StatedConnection(Stated, frozen=True):
    resource_id: Annotated[str, Field(alias="resourceId")]
    resource_name: Annotated[str, Field(alias="resourceName")]
    entity_types: Annotated[list[str], Field(alias="entityTypes")]
    bidirectional: bool
    """Read by the Librarian's relationship prompt, and by no prompt of the Worker's."""


class StatedCiter(Stated, frozen=True):
    resource_id: Annotated[str, Field(alias="resourceId")]
    resource_name: Annotated[str, Field(alias="resourceName")]


class StatedViews(Stated, frozen=True):
    connections: list[StatedConnection]
    cited_by: Annotated[list[StatedCiter], Field(alias="citedBy")]
    cited_by_count: Annotated[int, Field(alias="citedByCount")]
    """The length of `cited_by`, which the Worker's prompt takes for itself."""
    sibling_entity_types: Annotated[list[str], Field(alias="siblingEntityTypes")]


class Case(Stated, frozen=True):
    why: str
    graph: KnowledgeGraph
    resource: str
    annotation: str | None = None
    """The focal annotation, where the case has one."""
    views: StatedViews


class Table(Stated, frozen=True):
    comment: Annotated[str, Field(alias="$comment")]
    run_by: Annotated[dict[str, list[str]], Field(alias="runBy")]
    """Who runs the table, which lint:spec-case-tables holds it to."""
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "librarian/derive-views-cases.json").read_bytes())


def as_the_worker_reads(views: StatedViews) -> GraphViews:
    """What the Worker reads of the views a case states: the one place the table's names meet `GraphViews`."""
    return GraphViews(
        connections=[
            Connection(resource_id=connection.resource_id, resource_name=connection.resource_name, entity_types=connection.entity_types)
            for connection in views.connections
        ],
        cited_by=[Citer(resource_id=citer.resource_id, resource_name=citer.resource_name) for citer in views.cited_by],
        sibling_entity_types=views.sibling_entity_types,
    )


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_a_graph_is_read_into_the_lists_the_table_states(case: Case) -> None:
    focal = None if case.annotation is None else AnnotationId(case.annotation)
    assert derive_views(case.graph, ResourceId(case.resource), focal) == as_the_worker_reads(case.views), case.why
