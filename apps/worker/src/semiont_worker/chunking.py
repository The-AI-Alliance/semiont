"""Where a text is cut into the pieces a model is asked about, one at a time.

Every length and every position here counts Unicode code points, as a text
offset does: a piece's size, the overlap, where a cut is made and where the
next one starts. A Python string is indexed by code points, so an offset is a
string's own index. `specs/src/text/chunk-cases.json` holds the rule.
"""

import math
from dataclasses import dataclass
from typing import Final, final

from semiont_worker.white_space import trimmed

CODE_POINTS_PER_TOKEN: Final = 4
"""About four code points to a token, for English text."""

_BREAKS: Final = (("\n\n", 0), (". ", 1), (" ", 0))
"""Where a cut may be moved back to, in the order they are tried: what marks the break, and how much of the mark the piece keeps.

A blank line, and the cut is where it starts. The end of a sentence, a full
stop and a space, and the cut is after the full stop. A space (U+0020 and no
other), and the cut is where it is.
"""


@final
@dataclass(frozen=True, slots=True)
class Chunking:
    """How a text is cut: the size of a piece and what each cut keeps of the piece before, both in tokens."""

    chunk_size: int
    overlap: int


@final
@dataclass(frozen=True, slots=True)
class Cut:
    """One piece of a text, and the offset the next cut starts at."""

    piece: str
    next: int


def estimate_tokens(text: str) -> int:
    """About how many tokens `text` is: its length in code points, divided by four and rounded up.

    It is the one estimate here. A piece is sized by it and a prompt is
    measured by it, so that a budget worked out from one fits the other.
    """
    return math.ceil(len(text) / CODE_POINTS_PER_TOKEN)


def cut_chunk(text: str, at: int, chunking: Chunking) -> Cut:
    """One piece, cut from the offset `at`, and where the next one starts.

    The piece's window ends `chunk_size` tokens on, or where the text does.
    Short of the end of the text the cut is moved back to a break, the first
    of these that has one after the window's middle: a blank line, the end of
    a sentence, a space. The piece is the text from `at` to the cut, without
    the white space at its two ends. The next cut starts an overlap before
    this one ended, or where this one ended when that would be no further on
    than `at`; a cut that reaches the end of the text answers the text's
    length, and one made there takes nothing and answers it again.

    Raises `ValueError` for an `at` the text does not have.
    """
    length = len(text)
    if not 0 <= at <= length:
        raise ValueError(f"offset {at} is not in a text of {length} code points")
    window = chunking.chunk_size * CODE_POINTS_PER_TOKEN
    middle = at + window // 2
    end = min(at + window, length)

    if end < length:
        for mark, kept in _BREAKS:
            # Where the mark last starts at or before the window's end. One that starts there counts.
            found = text.rfind(mark, 0, end + len(mark))
            if found > middle:
                end = found + kept
                break

    piece = trimmed(text[at:end])
    # Reaching the end ends the walk. An overlap taken here would hand out one more cut of nothing but
    # text this piece already holds: a whole call to a model for spans that are all repeats.
    if end >= length:
        return Cut(piece=piece, next=length)
    back = end - chunking.overlap * CODE_POINTS_PER_TOKEN
    return Cut(piece=piece, next=back if back > at else end)


def chunk_text(text: str, chunking: Chunking) -> list[str]:
    """`text` cut whole: none for the empty text, the text itself when it is one piece's size or less, otherwise each cut's piece.

    The cuts are made from 0, each at the `next` of the one before, until one
    reaches the end of the text. A piece that is empty is left out.
    """
    length = len(text)
    if length == 0:
        return []
    if estimate_tokens(text) <= chunking.chunk_size:
        return [text]
    pieces: list[str] = []
    at = 0
    while at < length:
        cut = cut_chunk(text, at, chunking)
        pieces.append(cut.piece)
        at = cut.next
    return [piece for piece in pieces if piece]
