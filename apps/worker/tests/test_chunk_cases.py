"""The chunker, held to `specs/src/text/chunk-cases.json`.

It is the table every implementation of the worker runs, so that a text is cut
the same way whoever cuts it.
"""

from typing import Annotated, Final

import pytest
from pydantic import BaseModel, Field
from spec import SPEC

from semiont_worker.chunking import Chunking, Cut, chunk_text, cut_chunk, estimate_tokens


class StatedChunking(BaseModel, frozen=True, extra="forbid", strict=True):
    chunk_size: Annotated[int, Field(alias="chunkSize")]
    overlap: int


class StatedCut(BaseModel, frozen=True, extra="forbid", strict=True):
    at: int
    piece: str
    next: int


class Case(BaseModel, frozen=True, extra="forbid", strict=True):
    why: str
    text: str
    estimated_tokens: Annotated[int, Field(alias="estimatedTokens")]
    chunking: StatedChunking
    chunks: list[str]
    cuts: list[StatedCut]


class Table(BaseModel, frozen=True, extra="forbid", strict=True):
    comment: Annotated[str, Field(alias="$comment")]
    # The chunking used when none is given. This worker is never given none: a piece's size is its
    # unit's budget's, and then the step's. The member is read, and nothing here has a value to hold to it.
    defaults: StatedChunking
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "text/chunk-cases.json").read_bytes())


def chunking_of(stated: StatedChunking) -> Chunking:
    return Chunking(chunk_size=stated.chunk_size, overlap=stated.overlap)


def test_the_runner_found_the_table_s_cases() -> None:
    assert len(TABLE.cases) >= 20


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_a_text_s_tokens_are_estimated_as_the_table_says(case: Case) -> None:
    assert estimate_tokens(case.text) == case.estimated_tokens, case.why


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_a_text_is_cut_whole_into_the_chunks_the_table_gives(case: Case) -> None:
    assert chunk_text(case.text, chunking_of(case.chunking)) == case.chunks, case.why


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_each_cut_takes_the_piece_and_names_the_next_the_table_gives(case: Case) -> None:
    for stated in case.cuts:
        cut = cut_chunk(case.text, stated.at, chunking_of(case.chunking))
        assert cut == Cut(piece=stated.piece, next=stated.next), f"{case.why}: the cut at {stated.at}"


# The table holds every cut of a walk. These hold the two ends of what `at` may be.


def test_a_cut_at_the_end_of_the_text_takes_nothing_and_stays_there() -> None:
    # Three code points, the last two outside the basic plane.
    assert cut_chunk("a😀😀", 3, Chunking(chunk_size=5, overlap=1)) == Cut(piece="", next=3)


@pytest.mark.parametrize(("text", "at"), [("a😀😀", 4), ("abc", -1)])
def test_an_at_the_text_does_not_have_is_refused(text: str, at: int) -> None:
    with pytest.raises(ValueError, match=f"offset {at} is not in a text of {len(text)} code points"):
        cut_chunk(text, at, Chunking(chunk_size=5, overlap=1))


# No case of the table rests on a character about which the trimming a language is born with disagrees. These do.


def test_a_piece_is_trimmed_of_what_unicode_calls_white_space_and_of_nothing_else() -> None:
    chunking = Chunking(chunk_size=5, overlap=1)
    # The next line (U+0085) has the property, and JavaScript's own trim leaves it.
    assert cut_chunk("\u0085 abc\u3000\u0085", 0, chunking) == Cut(piece="abc", next=7)
    # A unit separator (U+001F) does not have it, and Python's own strip takes it.
    assert cut_chunk("\x1fabc\x1f", 0, chunking) == Cut(piece="\x1fabc\x1f", next=5)
    # Neither does the byte order mark (U+FEFF), which JavaScript's own trim takes.
    assert cut_chunk("\ufeffabc\ufeff", 0, chunking) == Cut(piece="\ufeffabc\ufeff", next=5)
