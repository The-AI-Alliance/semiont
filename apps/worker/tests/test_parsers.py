"""What reading a reply says and counts beside the items it hands on, which `specs/src/worker/parser-cases.json` does not state.

Every word of it is a log line, and every span found is counted by how it
was found.
"""

import logging
from collections import Counter
from collections.abc import Callable, Sequence
from typing import Final

import pytest
from counted import counted
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from pydantic import JsonValue
from semiont.annotations import TextSpan

from semiont_worker.detection.parsers import (
    Anchored,
    AssessmentMatch,
    CommentMatch,
    TagMatch,
    read_assessments,
    read_comments,
    read_highlights,
    read_tags,
)

TEXT: Final = "Ada met Babbage in London. London ignored them. Ada went home."

type Read = Callable[
    [Sequence[JsonValue], str], Anchored[TextSpan] | Anchored[CommentMatch] | Anchored[AssessmentMatch] | Anchored[TagMatch]
]


def tags_read(elements: Sequence[JsonValue], text: str) -> Anchored[TagMatch]:
    return read_tags(elements, text, "Place")


# Each kind of reply: how it is read, the member its kind requires beside `exact`, what its anchors are counted under,
# and what a proposal the text does not hold is said to be of.
KINDS: Final[list[tuple[Read, dict[str, JsonValue], str, dict[str, str]]]] = [
    (read_highlights, {}, "highlight", {"motivation": "highlighting"}),
    (read_comments, {"comment": "Said."}, "comment", {"motivation": "commenting"}),
    (read_assessments, {"assessment": "Judged."}, "assessment", {"motivation": "assessing"}),
    (tags_read, {}, "tag", {"motivation": "tagging", "category": "Place"}),
]
EVERY_KIND: Final = pytest.mark.parametrize(("read", "required", "label", "of"), KINDS, ids=[label for _, _, label, _ in KINDS])


def anchors(reader: InMemoryMetricReader) -> Counter[tuple[object, ...]]:
    """How many anchors have been counted so far, by what was anchored and how."""
    return counted(reader, "semiont.detection.anchors", "detection.label", "anchor.method")


def said(caplog: pytest.LogCaptureFixture, level: int) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_worker" and record.levelno == level]


@EVERY_KIND
def test_every_span_found_is_counted_by_its_kind_and_by_how_it_was_found(
    read: Read, required: dict[str, JsonValue], label: str, of: dict[str, str], metric_reader: InMemoryMetricReader
) -> None:
    before = anchors(metric_reader)
    found = read(
        [
            # Once in the text; twice, and the model says which; twice, and it says nothing; not as the text has it.
            {"exact": "Babbage", **required},
            {"exact": "London", "prefix": "London. ", **required},
            {"exact": "Ada", **required},
            {"exact": "babbage", **required},
            {"exact": "Lovelace was never here at all.", **required},
        ],
        TEXT,
    )
    assert [(match.start, match.end, match.exact) for match in found.matches] == [
        (8, 15, "Babbage"),
        (27, 33, "London"),
        (0, 3, "Ada"),
        (8, 15, "Babbage"),
    ]
    assert found.dropped == 1
    assert anchors(metric_reader) - before == Counter(
        {(label, "unique-match"): 1, (label, "context-recovered"): 1, (label, "first-of-many"): 1, (label, "fuzzy-match"): 1}
    )


@EVERY_KIND
def test_a_proposal_the_text_does_not_hold_is_warned_of_as_what_it_was_of(
    read: Read, required: dict[str, JsonValue], label: str, of: dict[str, str], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    read([{"exact": "Lovelace was never here at all.", **required}, {"exact": "Babbage", **required}], TEXT)
    (warned,) = said(caplog, logging.WARNING)
    assert warned.getMessage() == "Proposal dropped — text not found in source"
    facts = {**of, "text": "Lovelace was never here at all."}
    assert {key: vars(warned)[key] for key in facts} == facts
    assert ("category" in vars(warned)) == ("category" in of)


@EVERY_KIND
def test_a_span_found_where_the_model_did_not_say_which_is_warned_of_with_the_words_as_the_model_quoted_them(
    read: Read, required: dict[str, JsonValue], label: str, of: dict[str, str], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    read([{"exact": "babbage", **required}], TEXT)
    (warned,) = said(caplog, logging.WARNING)
    assert warned.getMessage() == "Annotation anchored via degraded method"
    assert {key: vars(warned)[key] for key in ("label", "text", "anchorMethod")} == {
        "label": label,
        "text": "babbage",
        "anchorMethod": "fuzzy-match",
    }


def test_a_commenting_and_a_tagging_reply_say_how_many_of_their_elements_were_proposals(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    elements: list[JsonValue] = [{"exact": "Babbage", "comment": "Said."}, {"exact": "Ada"}, None, 7]
    read_comments(elements, TEXT)
    read_tags(elements, TEXT, "Place")
    counts = [
        (record.getMessage(), vars(record)["motivation"], vars(record)["proposals"], vars(record)["elements"])
        for record in said(caplog, logging.DEBUG)
    ]
    assert counts == [("Read the proposals of a reply", "commenting", 1, 4), ("Read the proposals of a reply", "tagging", 2, 4)]


def test_a_reply_that_is_read_whole_says_nothing_above_a_whisper(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    read_highlights([{"exact": "Babbage"}], TEXT)
    read_comments([{"exact": "Babbage", "comment": "Said."}], TEXT)
    read_assessments([{"exact": "Babbage", "assessment": "Judged."}], TEXT)
    read_tags([{"exact": "Babbage"}], TEXT, "Place")
    assert [record for record in caplog.records if record.name == "semiont_worker" and record.levelno > logging.DEBUG] == []


@pytest.mark.parametrize(("member", "read"), [("comment", read_comments), ("assessment", read_assessments)])
def test_blank_is_no_characters_or_white_space_only_as_the_tables_count_white_space(member: str, read: Read) -> None:
    def proposals_of(said_of_it: str) -> int:
        found = read([{"exact": "Babbage", member: said_of_it}], TEXT)
        return len(found.matches) + found.dropped

    # The next-line character has the White_Space property. The information separators do not, though Python strips them,
    # and neither does the byte order mark, though JavaScript trims it.
    assert [proposals_of(blank) for blank in ("", " ", "\t\n", "\u0085", "\u2003\u00a0")] == [0, 0, 0, 0, 0]
    assert [proposals_of(something) for something in ("x", " x ", "\u001c", "\u001f", "\ufeff")] == [1, 1, 1, 1, 1]
