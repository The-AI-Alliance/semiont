"""What the worker reads of a media type for itself, held to the registry of the media types a knowledge base admits.

The registry is `specs/src/media-types/registry.json`, and the SDK's table of
it carries whether a type can be generated. The worker reads that from the
table, so what it lists is held here to the registry itself. Where a type's
text comes from is the SDK's rule, and the SDK's tests hold it.
"""

from typing import Annotated, Final

from pydantic import BaseModel, Field
from spec import SPEC

from semiont_worker.media_types import GENERATABLE_MEDIA_TYPES


class Row(BaseModel, frozen=True):
    media_type: Annotated[str, Field(alias="mediaType")]
    generatable: bool


class Registry(BaseModel, frozen=True):
    media_types: Annotated[list[Row], Field(alias="mediaTypes")]


REGISTRY: Final = Registry.model_validate_json((SPEC / "media-types/registry.json").read_bytes())


def test_what_the_worker_generates_is_what_the_registry_marks_generatable_in_its_order() -> None:
    assert len(REGISTRY.media_types) >= 63
    assert list(GENERATABLE_MEDIA_TYPES) == [row.media_type for row in REGISTRY.media_types if row.generatable]
    assert len(GENERATABLE_MEDIA_TYPES) >= 3
