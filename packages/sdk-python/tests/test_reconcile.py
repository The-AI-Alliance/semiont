"""`reconcile`, held to `specs/src/annotations/reconcile-cases.json`: the table every SDK's reconciling runs."""

import random
from typing import Final, get_args

import pytest
from pydantic import BaseModel
from spec import SPEC, JsonObject, text

from semiont._spans import nearest_stretch
from semiont.annotations import AnchorMethod, MatchQuality, QuotedText, ReconciledSpan, annotation_of_span, reconcile, text_quote_selector
from semiont.identifiers import ResourceId
from semiont.types import AgentSoftware, AnnotationTarget


class Case(BaseModel, frozen=True, extra="forbid"):
    why: str
    text: str
    quoted: QuotedText
    reconciled: JsonObject | None


class Table(BaseModel, frozen=True):
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "annotations/reconcile-cases.json").read_bytes())
FOUND: Final = [case.reconciled for case in TABLE.cases if case.reconciled is not None]


def as_the_table_writes(span: ReconciledSpan | None) -> JsonObject | None:
    """What `reconcile` gave, as the table writes it: a member for each thing the span has, and none for what it lacks."""
    if span is None:
        return None
    written: JsonObject = {"start": span.start, "end": span.end, "exact": span.exact, "anchorMethod": span.anchor_method}
    if span.prefix is not None:
        written["prefix"] = span.prefix
    if span.suffix is not None:
        written["suffix"] = span.suffix
    if span.match_quality is not None:
        written["matchQuality"] = span.match_quality
    return written


def test_the_runner_found_the_table_s_cases() -> None:
    assert len(TABLE.cases) >= 89


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_a_quote_is_reconciled_as_the_table_says(case: Case) -> None:
    assert as_the_table_writes(reconcile(case.text, case.quoted)) == case.reconciled, case.why


def test_how_a_span_was_found_is_one_of_the_ways_the_table_states_and_no_other() -> None:
    assert sorted({text(found["anchorMethod"], "anchorMethod") for found in FOUND}) == sorted(get_args(AnchorMethod.__value__))
    qualities = {text(found["matchQuality"], "matchQuality") for found in FOUND if "matchQuality" in found}
    assert sorted(qualities) == sorted(get_args(MatchQuality.__value__))


@pytest.mark.parametrize("case", [case for case in TABLE.cases if case.reconciled is not None], ids=lambda case: case.why)
def test_a_reconciled_span_is_one_the_builder_takes_as_it_is(case: Case) -> None:
    span = reconcile(case.text, case.quoted)
    assert span is not None
    built = annotation_of_span(
        case.text,
        span,
        resource_id=ResourceId("res-1"),
        motivation="highlighting",
        generator=AgentSoftware(type="Software", name="ollama gemma3"),
    )
    assert isinstance(built.target, AnnotationTarget)
    assert built.target.selector is not None
    quote = text_quote_selector(built.target.selector)
    assert quote is not None
    assert (quote.exact, quote.prefix, quote.suffix) == (span.exact, span.prefix, span.suffix)


def test_white_space_is_unicode_s_and_not_python_s_own() -> None:
    # `str.isspace` takes the four separators U+001C to U+001F for white space, and Unicode's White_Space property does not.
    separator = "\x1f"
    assert separator.isspace()
    # So one is words to find, where a quote of white space alone is refused.
    found = reconcile(f"a{separator}b", QuotedText(exact=separator))
    assert found is not None
    assert (found.start, found.end, found.anchor_method) == (1, 2, "unique-match")
    assert reconcile("a b", QuotedText(exact=" ")) is None
    # And it is no run to collapse: the quote with a space where the text has one is not found by normalizing.
    assert reconcile(f"one{separator}two three", QuotedText(exact="one two three")) is None


def edits(one: str, other: str) -> int:
    """The edit distance, worked out in full."""
    row = list(range(len(other) + 1))
    for i, mine in enumerate(one, start=1):
        above, row = row, [i]
        for j, theirs in enumerate(other, start=1):
            row.append(min(above[j] + 1, row[j - 1] + 1, above[j - 1] + (mine != theirs)))
    return row[-1]


def nearest_by_the_table_s_words(content: str, exact: str) -> tuple[int, int] | None:
    """The loose search as the table states it: every stretch compared, one at a time."""
    allowance = len(exact) // 20
    # With no allowance a stretch would have to be `exact` itself, which is found by what comes before this search.
    if allowance == 0:
        return None
    best: tuple[tuple[int, int, int, int], tuple[int, int]] | None = None
    for start in range(len(content) + 1):
        # A stretch within the allowance is at most the allowance longer or shorter than `exact`.
        for length in range(max(0, len(exact) - allowance), len(exact) + allowance + 1):
            if start + length > len(content):
                break
            distance = edits(exact, content[start : start + length])
            if distance > allowance:
                continue
            # The least distance; of several the first in the text; from one start the nearest in length; of two as near, the shorter.
            order = (distance, start, abs(length - len(exact)), length)
            if best is None or order < best[0]:
                best = (order, (start, start + length))
    return None if best is None else best[1]


def test_the_loose_search_gives_what_comparing_every_stretch_gives() -> None:
    # The package works out only the distances that can be within the allowance. This is the table's rule, worked out in full.
    chance = random.Random(20261009)
    letters = "abab c\U0001f600"
    found = 0
    for _ in range(60):
        content = "".join(chance.choice(letters) for _ in range(chance.randrange(15, 70)))
        size = chance.choice([19, 20, 21, 26, 40, 41])
        at = chance.randrange(0, max(1, len(content) - size))
        quote = list(content[at : at + size])
        for _ in range(chance.randrange(0, 4)):
            where = chance.randrange(0, len(quote) + 1)
            match chance.randrange(3):
                case 0:
                    quote.insert(where, chance.choice(letters))
                case 1:
                    del quote[where : where + 1]
                case _:
                    quote[where : where + 1] = chance.choice(letters)
        exact = "".join(quote)
        expected = nearest_by_the_table_s_words(content, exact)
        assert nearest_stretch(content, exact) == expected, (content, exact)
        found += expected is not None
    assert 15 < found < 55, "the trial texts are all found or all refused: they tell nothing apart"
