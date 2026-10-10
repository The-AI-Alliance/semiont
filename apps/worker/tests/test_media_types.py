"""What the worker reads of a media type, held to the registry of the media types a knowledge base admits.

The registry is `specs/src/media-types/registry.json`. The SDK's table of it
carries neither where a type's text comes from nor whether the worker can
generate it. So the module writes both out by hand, and nothing generates
them: a row the registry gains, loses or changes fails here.
"""

from typing import Annotated, Final, get_args

from pydantic import BaseModel, Field
from semiont.media_types_table import MEDIA_TYPES
from spec import SPEC

from semiont_worker.media_types import GENERATABLE_MEDIA_TYPES, TEXT_SOURCES, TextSource, text_source_of


class Row(BaseModel, frozen=True, extra="forbid", strict=True):
    media_type: Annotated[str, Field(alias="mediaType")]
    extension: str
    label: str
    render: str
    anchoring: str
    text_source: Annotated[str, Field(alias="textSource")]
    authorable: bool
    uploadable: bool
    generatable: bool


class Registry(BaseModel, frozen=True, extra="forbid", strict=True):
    comment: Annotated[str, Field(alias="$comment")]
    render: list[str]
    anchoring: list[str]
    text_source: Annotated[list[str], Field(alias="textSource")]
    extension_aliases: Annotated[dict[str, str], Field(alias="extensionAliases")]
    media_types: Annotated[list[Row], Field(alias="mediaTypes")]


REGISTRY: Final = Registry.model_validate_json((SPEC / "media-types/registry.json").read_bytes())


def test_the_registry_was_read_and_the_sdk_s_table_is_of_it() -> None:
    assert len(REGISTRY.media_types) >= 63
    assert [row.media_type for row in MEDIA_TYPES] == [row.media_type for row in REGISTRY.media_types]


def test_the_places_a_type_s_text_comes_from_are_the_registry_s() -> None:
    assert list(get_args(TextSource.__value__)) == REGISTRY.text_source


def test_where_each_type_s_text_comes_from_is_what_its_row_says_each_type_once_and_in_the_registry_s_order() -> None:
    assert list(TEXT_SOURCES.items()) == [(row.media_type, row.text_source) for row in REGISTRY.media_types]
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
