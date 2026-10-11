"""The rules read from the media types a knowledge base admits, as every SDK reads them (`specs/src/media-types/cases.json`)."""

from typing import get_args

import pytest
from spec import SPEC, JsonObject, objects, read, strings, text

from semiont.media_types import base_media_type, capabilities_of, clone_format, primary_media_type, storage_file_name, storage_uri
from semiont.media_types_table import MEDIA_TYPES, TextSource
from semiont.types import ResourceDescriptor

TABLE = read(SPEC / "media-types/cases.json")
REGISTRY = read(SPEC / "media-types/registry.json")
CLONES = objects(TABLE["cloneFormat"], "cloneFormat")
NAMES = objects(TABLE["storageFileName"], "storageFileName")


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


def test_the_table_was_read() -> None:
    assert len(CLONES) >= 7
    assert len(NAMES) >= 7


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


def test_some_types_can_be_generated_and_some_cannot() -> None:
    # The rows above tell the column from one that is all one answer.
    assert {row.generatable for row in MEDIA_TYPES} == {True, False}


def test_a_format_is_read_without_its_parameters_and_in_lower_case() -> None:
    assert base_media_type("Text/HTML; charset=iso-8859-1") == "text/html"
    assert capabilities_of("application/x-unheard-of") is None


def test_a_resources_format_is_its_first_representations() -> None:
    def resource(representations: object) -> ResourceDescriptor:
        return ResourceDescriptor.model_validate(
            {"@context": "https://schema.org", "@id": "res-1", "name": "A resource", "representations": representations}
        )

    assert primary_media_type(resource({"mediaType": "text/markdown"})) == "text/markdown"
    assert primary_media_type(resource([{"mediaType": "application/pdf"}, {"mediaType": "text/plain"}])) == "application/pdf"
    assert primary_media_type(resource([])) is None
