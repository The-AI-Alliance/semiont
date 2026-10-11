"""What the worker reads of a media type, held to the registry of the media types a knowledge base admits.

The registry is `specs/src/media-types/registry.json`, and the SDK's table of
it carries where a type's text comes from and whether it can be generated. The
worker reads both from that table, so what it answers for a row is held here to
the registry itself. Its own rule is the answer for a type the registry lacks.
"""

from typing import Annotated, Final

from pydantic import BaseModel, Field
from spec import SPEC

from semiont_worker.media_types import GENERATABLE_MEDIA_TYPES, text_source_of


class Row(BaseModel, frozen=True):
    media_type: Annotated[str, Field(alias="mediaType")]
    text_source: Annotated[str, Field(alias="textSource")]
    generatable: bool


class Registry(BaseModel, frozen=True):
    text_source: Annotated[list[str], Field(alias="textSource")]
    media_types: Annotated[list[Row], Field(alias="mediaTypes")]


REGISTRY: Final = Registry.model_validate_json((SPEC / "media-types/registry.json").read_bytes())


def test_where_each_type_s_text_comes_from_is_what_its_row_of_the_registry_says() -> None:
    assert len(REGISTRY.media_types) >= 63
    assert [text_source_of(row.media_type) for row in REGISTRY.media_types] == [row.text_source for row in REGISTRY.media_types]
    # Each of the three is some row's, so each is told from the other two here.
    assert {row.text_source for row in REGISTRY.media_types} == set(REGISTRY.text_source)


def test_a_type_s_parameters_and_its_case_are_not_read() -> None:
    assert text_source_of("text/markdown; charset=iso-8859-1") == "decode"
    assert text_source_of("Application/PDF") == "pdf-text-layer"
    assert text_source_of("IMAGE/PNG; q=1") == "none"


def test_a_type_the_registry_lacks_is_decoded_when_it_is_text_and_has_no_text_otherwise() -> None:
    registered = {row.media_type for row in REGISTRY.media_types}
    for media_type, text_source in (
        ("text/x-obscure-notation", "decode"),
        ("TEXT/X-Obscure-Notation; charset=utf-8", "decode"),
        ("application/x-obscure", "none"),
        # A resource with no representation has no media type, and no text.
        ("", "none"),
    ):
        assert media_type.split(";")[0].lower() not in registered
        assert text_source_of(media_type) == text_source


def test_what_the_worker_generates_is_what_the_registry_marks_generatable_in_its_order() -> None:
    assert list(GENERATABLE_MEDIA_TYPES) == [row.media_type for row in REGISTRY.media_types if row.generatable]
    assert len(GENERATABLE_MEDIA_TYPES) >= 3
