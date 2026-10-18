"""Finding a claim again in the text of a PDF the worker has made.

A citation's claim is words of the source the model wrote, and a PDF is
anchored by where its words are on a page. So a claim is cited by finding it
in the PDF's own text, as the Smelter read it back. That text differs from
the source in two ways: lines are broken where the page is, and a word
hyphenated at a line's end comes back as its two halves, with no hyphen
between them.

So a claim is looked for by two searches. The strict one looks for it with
white space collapsed on both sides, which bridges a line broken between two
words. The break-aware one looks for its characters with a line break
allowed between any two of them, which bridges a word broken at a line's
end. Every place either finds is a place of the claim.

A claim the text has more than once is cited at one place: the one where the
compiler says the cited span ended, which the worker asked it when it made
the PDF. No place is taken where none is there, so a citation is never
anchored in the wrong place.

`specs/src/annotations/pdf-locate-cases.json` holds the rule, under `claims`
and `landing`. An offset counts the text's code points, as a Python string's
own index does.
"""

import re
from typing import Final

from semiont.types import AnchoredText, PdfTextItem
from semiont_service.white_space import WHITE_SPACE

from semiont_worker.generation.typst import Landed

_BREAK_BETWEEN: Final = "(?: ?\n ?)?"
"""What may stand between two characters of a claim: nothing, or a line break with at most one space on either side of it."""

_SPACE_OR_BREAK: Final = "(?: |\n)"
"""What a space of a claim is found as: one space, or the break of a line that ends where the space would be."""

LANDING_SLACK: Final = 0.5
"""How far, in points, a landing may be before the start of the word a place ends in, or after its end, and still be at it.

The compiler's point and the word's box are measured by two readings of one
layout, which agree to within a hundredth of a point. Half a point is no
letter's width.
"""


def find_claim_spans(text: str, claim: str) -> list[tuple[int, int]]:
    """Every place `text` has `claim`: the offsets of each place's first character and of the one after its last, in the text's order.

    The claim is looked for with every run of its white space made one space
    and none at its ends. A claim of nothing is found nowhere. Each search
    takes every place after the last it took ends, and a place both searches
    take is one place.
    """
    spaced = "".join(" " if character in WHITE_SPACE else character for character in claim)
    sought = " ".join(word for word in spaced.split(" ") if word)
    if not sought:
        return []
    places: set[tuple[int, int]] = set()

    # Strict: the text with its white space collapsed the same way, each of its characters with the offset it came from.
    collapsed: list[str] = []
    came_from: list[int] = []
    run_began: int | None = None
    for offset, character in enumerate(text):
        if character in WHITE_SPACE:
            if run_began is None:
                run_began = offset
        else:
            if run_began is not None:
                collapsed.append(" ")
                came_from.append(run_began)
                run_began = None
            collapsed.append(character)
            came_from.append(offset)
    joined = "".join(collapsed)
    found = joined.find(sought)
    while found != -1:
        places.add((came_from[found], came_from[found + len(sought) - 1] + 1))
        found = joined.find(sought, found + len(sought))

    # Break-aware: a line break may come between any two characters. A space is never passed over for nothing, so `abc` is
    # not found in `a b c`.
    pattern = _BREAK_BETWEEN.join(_SPACE_OR_BREAK if character == " " else re.escape(character) for character in sought)
    places.update(match.span() for match in re.finditer(pattern, text))
    return sorted(places)


def find_landed_claim(anchored: AnchoredText, claim: str, landed: Landed) -> tuple[int, int] | None:
    """The place of `claim` in `anchored`'s text where the compiler says it ended, or None where it is at no place.

    A place is at the landing when the item that holds its last character is
    on the landed page, that item's baseline is within half its height of the
    landed `y`, and the landed `x` is within `LANDING_SLACK` of the item's
    stretch along its line. Of the places at it, the one whose end is
    nearest the landed `x`, an end being placed along its item by the share
    of the item's characters before it.
    """
    at: list[tuple[float, tuple[int, int]]] = []
    for start, end in find_claim_spans(anchored.text, claim):
        item = _holding(anchored.items, end - 1)
        if item is None or item.page != landed.page or abs(item.y - landed.y) > item.height / 2:
            continue
        if not item.x - LANDING_SLACK <= landed.x <= item.x + item.width + LANDING_SLACK:
            continue
        along = item.x + item.width * (end - item.start) / (item.end - item.start)
        at.append((abs(along - landed.x), (start, end)))
    return min(at)[1] if at else None


def _holding(items: list[PdfTextItem], offset: int) -> PdfTextItem | None:
    """The item whose stretch of the text holds the character at `offset`, or None where none does."""
    return next((item for item in items if item.start <= offset < item.end), None)
