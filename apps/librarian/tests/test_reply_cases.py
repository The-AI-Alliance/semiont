"""What is read from a model's reply, held to `specs/src/librarian/reply-cases.json`.

It is the table every Librarian runs: a reply, whole, and what one of the two
readers reads from it. Each reader here is a function of the reply, so a case
is one call.
"""

from typing import Final

import pytest
from spec import SPEC, JsonObject, number, objects, read, strings, text, whole

from semiont_librarian.replies import read_scores, read_suggestions

TABLE: Final = read(SPEC / "librarian/reply-cases.json")
CASES: Final = objects(TABLE["cases"], "the table's cases")


def of_reader(reader: str) -> list[JsonObject]:
    """The cases of one reader."""
    return [case for case in CASES if case["reader"] == reader]


def whys(cases: list[JsonObject]) -> list[str]:
    return [text(case["why"], "why") for case in cases]


SCORES: Final = of_reader("scores")
SUGGESTIONS: Final = of_reader("suggestions")


def test_the_runner_found_the_table_s_cases_and_every_one_is_of_a_reader_it_runs() -> None:
    assert len(SCORES) >= 15
    assert len(SUGGESTIONS) >= 15
    assert len(SCORES) + len(SUGGESTIONS) == len(CASES)


@pytest.mark.parametrize("case", SCORES, ids=whys(SCORES))
def test_the_scores_read_from_a_reply_are_the_table_s(case: JsonObject) -> None:
    assert set(case) == {"why", "reader", "reply", "candidates", "scores"}
    expected = {
        whole(scored["candidate"], "candidate"): number(scored["score"], "score") for scored in objects(case["scores"], "scores")
    }
    assert read_scores(text(case["reply"], "reply"), whole(case["candidates"], "candidates")) == expected, text(case["why"], "why")


@pytest.mark.parametrize("case", SUGGESTIONS, ids=whys(SUGGESTIONS))
def test_the_suggestions_read_from_a_reply_are_the_table_s(case: JsonObject) -> None:
    assert set(case) == {"why", "reader", "reply", "suggestions"}
    expected = None if case["suggestions"] is None else strings(case["suggestions"], "suggestions")
    assert read_suggestions(text(case["reply"], "reply")) == expected, text(case["why"], "why")


# The table's one score that is no number is full stops alone. A score with two full stops in it is no number either.


def test_a_score_with_two_full_stops_is_no_number_and_its_line_is_dropped() -> None:
    assert read_scores("1. 0.8.5\n2. 0.6", 3) == {2: 0.6}


# No case of the table rests on a character about which the white space a language is born with disagrees. These do.


def test_white_space_is_what_unicode_calls_white_space_and_nothing_else() -> None:
    # The next line (U+0085) has the property: it is dropped from the ends of a reply, and may stand before a score.
    assert read_scores("\u0085 1.\u00850.8", 3) == {1: 0.8}
    # A unit separator (U+001F) does not have it: a line that starts with one does not start with a number.
    assert read_scores("\x1f1. 0.8", 3) == {}
    assert read_suggestions("-\N{IDEOGRAPHIC SPACE}One\u0085\n\x1fTwo\x1f") == ["One", "\x1fTwo\x1f"]
