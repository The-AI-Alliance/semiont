"""What is read from a model's reply, held to `specs/src/librarian/reply-cases.json`.

It is the table every Librarian runs: the elements a model answered, and
what one of the two readers reads from them. Each reader here is a function
of the elements, so a case is one call. What a model is asked for them with,
and what a reply that is no array or is cut off does, is held beside the
table.
"""

from typing import Final

import pytest
from aio import run
from pydantic import JsonValue
from rig import FakeInference
from semiont_inference.interface import StructuredReadError
from spec import SPEC, JsonObject, number, objects, read, strings, text, whole

from semiont_librarian.prompts import Prompt
from semiont_librarian.replies import SCORE_ELEMENT, ReplyCutOff, ask_for_elements, read_scores, read_suggestions

TABLE: Final = read(SPEC / "librarian/reply-cases.json")
CASES: Final = objects(TABLE["cases"], "the table's cases")

ASKING: Final = Prompt("Score these.", max_tokens=40, temperature=0.1)
"""A prompt, with a token limit and a temperature of its own."""


def of_reader(reader: str) -> list[JsonObject]:
    """The cases of one reader."""
    return [case for case in CASES if case["reader"] == reader]


def whys(cases: list[JsonObject]) -> list[str]:
    return [text(case["why"], "why") for case in cases]


def elements_of(case: JsonObject) -> list[JsonValue]:
    """The array a case's model answered."""
    stated = case["elements"]
    assert isinstance(stated, list), "elements"
    return stated


SCORES: Final = of_reader("scores")
SUGGESTIONS: Final = of_reader("suggestions")


def test_the_runner_found_the_table_s_cases_and_every_one_is_of_a_reader_it_runs() -> None:
    assert set(TABLE) == {"$comment", "cases"}
    assert len(SCORES) >= 15
    assert len(SUGGESTIONS) >= 10
    assert len(SCORES) + len(SUGGESTIONS) == len(CASES)
    assert len(set(whys(CASES))) == len(CASES)


@pytest.mark.parametrize("case", SCORES, ids=whys(SCORES))
def test_the_scores_read_from_a_reply_are_the_table_s(case: JsonObject) -> None:
    assert set(case) == {"why", "reader", "elements", "candidates", "scores"}
    expected = {whole(scored["candidate"], "candidate"): number(scored["score"], "score") for scored in objects(case["scores"], "scores")}
    assert read_scores(elements_of(case), whole(case["candidates"], "candidates")) == expected, text(case["why"], "why")


@pytest.mark.parametrize("case", SUGGESTIONS, ids=whys(SUGGESTIONS))
def test_the_suggestions_read_from_a_reply_are_the_table_s(case: JsonObject) -> None:
    assert set(case) == {"why", "reader", "elements", "suggestions"}
    expected = None if case["suggestions"] is None else strings(case["suggestions"], "suggestions")
    assert read_suggestions(elements_of(case)) == expected, text(case["why"], "why")


# ── What no case of the table rests on ────────────────────────────────


def test_white_space_is_what_unicode_calls_white_space_and_nothing_else() -> None:
    # The next line (U+0085) and the ideographic space have the property, and are dropped from a suggestion's ends.
    # A unit separator (U+001F) does not have it, though a language's own trimming may drop it.
    said: list[JsonValue] = [
        {"suggestion": "\u0085\N{IDEOGRAPHIC SPACE}One\u0085"},
        {"suggestion": "\x1fTwo\x1f"},
        {"suggestion": "\u0085"},
    ]
    assert read_suggestions(said) == ["One", "\x1fTwo\x1f"]


def test_a_score_that_is_no_finite_number_gives_nothing() -> None:
    # JSON has no such number, and a reader of JSON may answer one all the same.
    said: list[JsonValue] = [
        {"candidate": 1, "score": float("nan")},
        {"candidate": float("inf"), "score": 0.5},
        {"candidate": 2, "score": 0.5},
    ]
    assert read_scores(said, 2) == {2: 0.5}


def test_elements_are_asked_for_with_the_prompt_s_own_limit_and_temperature_and_the_schema_given() -> None:
    async def scenario() -> None:
        model = FakeInference('[{"candidate": 1, "score": 0.5}]')

        assert await ask_for_elements(model, ASKING, SCORE_ELEMENT) == [{"candidate": 1, "score": 0.5}]
        assert [(asked.prompt, asked.max_tokens, asked.temperature) for asked in model.asked] == [("Score these.", 40, 0.1)]
        assert model.schemas == [SCORE_ELEMENT]

    run(scenario())


def test_a_reply_that_is_no_array_is_a_failure_and_is_not_read_as_no_elements() -> None:
    async def scenario() -> None:
        with pytest.raises(StructuredReadError):
            await ask_for_elements(FakeInference("1. 0.8"), ASKING, SCORE_ELEMENT)

    run(scenario())


def test_a_reply_cut_off_at_the_token_limit_is_a_failure_though_what_was_written_is_an_array() -> None:
    async def scenario() -> None:
        model = FakeInference()
        model.say_as('[{"candidate": 1, "score": 0.5}]', stopped="max_tokens")
        with pytest.raises(ReplyCutOff, match=r"^the model stopped at its limit of 40 tokens before its reply was whole$"):
            await ask_for_elements(model, ASKING, SCORE_ELEMENT)

    run(scenario())
