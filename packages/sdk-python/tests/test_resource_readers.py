"""The readers of a resource, held to `specs/src/resources/reader-cases.json`: the table every SDK's readers run."""

from typing import Annotated, Final

import pytest
from pydantic import BaseModel, Field
from spec import SPEC, JsonObject

from semiont.model import written
from semiont.resources import primary_media_type, primary_representation, resource_entity_types
from semiont.types import Representation, ResourceDescriptor


class Case(BaseModel, frozen=True, extra="forbid"):
    """A resource, and what each reader gives of it. A member this does not read is refused."""

    why: str
    resource: ResourceDescriptor
    entity_types: Annotated[list[str], Field(alias="entityTypes")]
    representation: Annotated[JsonObject | None, Field(alias="primaryRepresentation")] = None
    """The primary representation as the wire carries it, whole. Not stated for a resource with none."""
    media_type: Annotated[str | None, Field(alias="primaryMediaType")] = None
    """The primary representation's. Not stated for a resource with none."""


class Table(BaseModel, frozen=True):
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "resources/reader-cases.json").read_bytes())


def test_the_table_has_a_resource_of_each_shape() -> None:
    # What the cases must tell apart: one representation from a list of them, the first of a list from the
    # others, a resource with none, and a resource that states entity types from one that states none.
    stated = [case.resource.representations for case in TABLE.cases]
    assert any(isinstance(representations, Representation) for representations in stated)
    assert any(isinstance(representations, list) and len(representations) > 1 for representations in stated)
    assert any(isinstance(representations, list) and not representations for representations in stated)
    assert any(case.entity_types for case in TABLE.cases)
    assert any(not case.entity_types for case in TABLE.cases)


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_every_reader_gives_what_the_table_says(case: Case) -> None:
    found = primary_representation(case.resource)
    assert (None if found is None else written(found)) == case.representation
    assert primary_media_type(case.resource) == case.media_type
    assert resource_entity_types(case.resource) == case.entity_types
