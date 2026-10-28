"""A resource's text, read where its media type says the text is.

The rule is `docs/protocol/LIBRARIAN.md`'s (§ Gathering around an
annotation, "A resource's text is"): bytes decoded, read from the Archivist;
the anchored text, asked of the gateway; or nothing. What a preview is, is
held by the cases of `specs/src/librarian/search-cases.json`, which
`test_search_cases.py` runs.
"""

import pytest
from aio import run
from rig import FakeAnchoredText, FakeContent, described
from semiont.identifiers import ResourceId
from semiont.types import AnchoredTextAbsent, AnchoredTextAnswer, ExtractedText, ExtractionDeclined, ResourceDescriptor
from semiont_service.content import Content, ContentUnread
from spec import JsonObject

from semiont_librarian.resource_text import preview_of, text_of

R1 = ResourceId("res-1")


def stored_as(media_type: str) -> ResourceDescriptor:
    """A resource with stored bytes of one media type."""
    stored: JsonObject = {"mediaType": media_type, "storageUri": "file://the-bytes", "rel": "original"}
    return described(R1, representations=[stored])


def read_of(resource: ResourceDescriptor, content: FakeContent, anchored: FakeAnchoredText) -> str | None:
    return run(text_of(resource, content=content, anchored=anchored))


@pytest.mark.parametrize("media_type", ["text/plain", "text/markdown", "text/troff", "TEXT/Plain; charset=utf-8"])
def test_the_text_of_a_resource_whose_bytes_are_its_text_is_its_bytes_decoded_and_the_gateway_is_not_asked(media_type: str) -> None:
    content, anchored = FakeContent(), FakeAnchoredText()
    content.held[R1] = Content(data="Black Hawk était un chef. \U0001f4da".encode(), content_type="text/plain")
    assert read_of(stored_as(media_type), content, anchored) == "Black Hawk était un chef. \U0001f4da"
    assert content.asked == [R1]
    assert anchored.asked == []


def test_bytes_are_decoded_as_the_content_type_they_were_served_with_says() -> None:
    content, anchored = FakeContent(), FakeAnchoredText()
    content.held[R1] = Content(data="café".encode("latin-1"), content_type="text/plain; charset=iso-8859-1")
    assert read_of(stored_as("text/plain"), content, anchored) == "café"


def test_a_text_with_nothing_in_it_is_the_empty_text_and_not_no_text() -> None:
    content, anchored = FakeContent(), FakeAnchoredText()
    content.held[R1] = Content(data=b"", content_type="text/plain")
    assert read_of(stored_as("text/plain"), content, anchored) == ""


def test_the_text_of_a_resource_whose_text_is_derived_is_its_anchored_text_and_no_bytes_are_read() -> None:
    content, anchored = FakeContent(), FakeAnchoredText()
    # Bytes that would decode, were they read: they are not.
    content.held[R1] = Content(data=b"%PDF-1.7", content_type="application/pdf")
    anchored.answers[R1] = ExtractedText(kind="extracted", method="pdf-text-layer", text="The Treaty of 1804", items=[])
    assert read_of(stored_as("application/pdf"), content, anchored) == "The Treaty of 1804"
    assert anchored.asked == [R1]
    assert content.asked == []


@pytest.mark.parametrize(
    "answer",
    [
        AnchoredTextAbsent(kind="not-yet"),
        AnchoredTextAbsent(kind="no-map"),
        AnchoredTextAbsent(kind="unknown"),
        ExtractionDeclined(kind="declined", declined="no-text-layer"),
    ],
    ids=["not yet", "no map", "unknown", "declined"],
)
def test_a_derived_text_that_is_not_there_is_no_text_and_never_the_empty_text(answer: AnchoredTextAnswer) -> None:
    content, anchored = FakeContent(), FakeAnchoredText()
    anchored.answers[R1] = answer
    assert read_of(stored_as("application/pdf"), content, anchored) is None
    assert anchored.asked == [R1]
    assert content.asked == []


def test_a_derived_text_with_nothing_in_it_is_the_empty_text() -> None:
    content, anchored = FakeContent(), FakeAnchoredText()
    anchored.answers[R1] = ExtractedText(kind="extracted", method="pdf-text-layer", text="", items=[])
    assert read_of(stored_as("application/pdf"), content, anchored) == ""


@pytest.mark.parametrize("media_type", ["image/png", "application/x-unlisted"])
def test_a_media_type_with_no_text_has_none_and_neither_the_archivist_nor_the_gateway_is_asked(media_type: str) -> None:
    content, anchored = FakeContent(), FakeAnchoredText()
    content.held[R1] = Content(data=b"\x89PNG", content_type=media_type)
    assert read_of(stored_as(media_type), content, anchored) is None
    assert content.asked == []
    assert anchored.asked == []


def test_a_resource_with_no_stored_bytes_has_no_text_and_nothing_is_asked() -> None:
    content, anchored = FakeContent(), FakeAnchoredText()
    nowhere: JsonObject = {"mediaType": "text/plain", "rel": "original"}
    for resource in (described(R1), described(R1, representations=[nowhere])):
        assert read_of(resource, content, anchored) is None
    assert content.asked == []
    assert anchored.asked == []


def test_the_text_is_that_of_the_first_representation() -> None:
    content, anchored = FakeContent(), FakeAnchoredText()
    content.held[R1] = Content(data=b"the text", content_type="text/plain")
    first: JsonObject = {"mediaType": "text/plain", "storageUri": "file://a-text.txt"}
    second: JsonObject = {"mediaType": "application/pdf", "storageUri": "file://a-text.pdf"}
    assert read_of(described(R1, representations=[first, second]), content, anchored) == "the text"
    assert anchored.asked == []


def test_a_read_of_bytes_that_fails_is_raised() -> None:
    content, anchored = FakeContent(), FakeAnchoredText()
    with pytest.raises(ContentUnread, match=r"the bytes of res-1 could not be read"):
        read_of(stored_as("text/plain"), content, anchored)
    assert content.asked == [R1]


def test_a_read_of_bytes_that_fails_previews_as_the_empty_string_where_the_text_is_raised() -> None:
    content = FakeContent()
    assert run(preview_of(stored_as("text/plain"), content=content)) == ""
    assert content.asked == [R1]
    # Bytes served as what was never text preview as the empty string too.
    content.held[R1] = Content(data=b"%PDF-1.7", content_type="application/pdf")
    assert run(preview_of(stored_as("text/plain"), content=content)) == ""
