"""The rules read from the media types a knowledge base admits, as every SDK reads them (`specs/src/media-types/cases.json`)."""

from typing import get_args

import pytest
from spec import SPEC, JsonObject, objects, read, strings, text

from semiont.media_types import (
    base_media_type,
    capabilities_of,
    clone_format,
    derives_text_of,
    storage_file_name,
    storage_uri,
    text_source_of,
    yields_geometry_of,
)
from semiont.media_types_table import MEDIA_TYPES, TextSource

TABLE = read(SPEC / "media-types/cases.json")
REGISTRY = read(SPEC / "media-types/registry.json")
CLONES = objects(TABLE["cloneFormat"], "cloneFormat")
NAMES = objects(TABLE["storageFileName"], "storageFileName")
SOURCES = objects(TABLE["textSource"], "textSource")


def why(row: JsonObject) -> str:
    return text(row["why"], "why")


@pytest.mark.parametrize("row", CLONES, ids=why)
def test_a_clone_takes_the_format_the_table_says(row: JsonObject) -> None:
    source = row["source"]
    assert source is None or isinstance(source, str)
    assert clone_format(source).media_type == row["format"]


@pytest.mark.parametrize("row", NAMES, ids=why)
def test_content_is_stored_under_the_name_the_table_says(row: JsonObject) -> None:
    kind = capabilities_of(text(row["format"], "format"))
    assert kind is not None
    assert storage_file_name(text(row["name"], "name"), kind) == row["fileName"]
    assert storage_uri(text(row["name"], "name"), kind) == f"file://{row['fileName']}"


@pytest.mark.parametrize("row", SOURCES, ids=why)
def test_where_a_types_text_comes_from_and_what_follows_from_it_are_what_the_table_says(row: JsonObject) -> None:
    # A member this does not read would be a rule this SDK is not held to.
    assert set(row) == {"why", "format", "textSource", "yieldsGeometry", "derivesText"}
    media_type = text(row["format"], "format")
    assert text_source_of(media_type) == row["textSource"]
    assert yields_geometry_of(media_type) is row["yieldsGeometry"]
    assert derives_text_of(media_type) is row["derivesText"]


def test_the_table_was_read() -> None:
    assert len(CLONES) >= 7
    assert len(NAMES) >= 7
    # What the cases of where a text comes from must tell apart: each of the registry's words for it, each answer
    # for a type the registry lacks, and a format from its parameters and its case.
    sources = [(text(row["format"], "format"), text(row["textSource"], "textSource")) for row in SOURCES]
    assert {source for _, source in sources} == set(get_args(TextSource.__value__))
    assert {source for media_type, source in sources if capabilities_of(media_type) is None} == {"decode", "none"}
    assert any(media_type != base_media_type(media_type) for media_type, _ in sources)


def test_this_sdks_rows_are_the_registrys() -> None:
    rows = objects(REGISTRY["mediaTypes"], "mediaTypes")
    assert [(row.media_type, row.extension, row.text_source, row.authorable, row.generatable) for row in MEDIA_TYPES] == [
        (row["mediaType"], row["extension"], row["textSource"], row["authorable"], row["generatable"]) for row in rows
    ]


def test_where_a_types_text_comes_from_is_one_of_the_registrys_words_and_each_word_is_some_rows() -> None:
    words = list(get_args(TextSource.__value__))
    assert words == strings(REGISTRY["textSource"], "textSource")
    # Each word is some row's, so the rows above tell each from the others.
    assert {row.text_source for row in MEDIA_TYPES} == set(words)


def test_a_type_the_registry_has_answers_where_its_text_comes_from_as_its_row_says() -> None:
    assert [text_source_of(row.media_type) for row in MEDIA_TYPES] == [row.text_source for row in MEDIA_TYPES]


def test_some_types_can_be_generated_and_some_cannot() -> None:
    # The rows above tell the column from one that is all one answer.
    assert {row.generatable for row in MEDIA_TYPES} == {True, False}


def test_a_format_is_read_without_its_parameters_and_in_lower_case() -> None:
    assert base_media_type("Text/HTML; charset=iso-8859-1") == "text/html"
    assert capabilities_of("application/x-unheard-of") is None
