"""Finding a claim again in the text of a PDF the worker has made.

A citation's claim is words of the source the model wrote, and a PDF is
anchored by where its words are on a page. So a claim is cited by finding it
in the PDF's own text, as the Smelter read it back. That text differs from
the source in two ways: lines are broken where the page is, and a word
hyphenated at a line's end comes back as its two halves, with no hyphen
between them.

The search is in two stages, in this order, and never one. The strict stage
looks for the claim with white space collapsed on both sides, which bridges a
line broken between two words. Only where that finds nothing does the second
look for the claim's characters with a line break allowed between any two of
them, which bridges a word broken at a line's end. The order is what keeps
the second from turning a claim the first finds into another one.

`specs/src/annotations/pdf-locate-cases.json` holds the rule, under `claims`.
An offset counts the text's code points, as a Python string's own index does.
"""

import re
from typing import Final

from semiont_worker.white_space import WHITE_SPACE

_BREAK_BETWEEN: Final = "(?: ?\n ?)?"
"""What may stand between two characters of a claim: nothing, or a line break with at most one space on either side of it."""

_SPACE_OR_BREAK: Final = "(?: |\n)"
"""What a space of a claim is found as: one space, or the break of a line that ends where the space would be."""


def find_claim_span(text: str, claim: str) -> tuple[int, int] | None:
    """Where `text` has `claim`: the offsets of its first character and of the one after its last, or `None` where it has none.

    The claim is looked for with every run of its white space made one space
    and none at its ends. A claim of nothing is found nowhere.
    """
    spaced = "".join(" " if character in WHITE_SPACE else character for character in claim)
    sought = " ".join(word for word in spaced.split(" ") if word)
    if not sought:
        return None

    # Strict: the text with its white space collapsed the same way, each of its characters with the offset it came from.
    collapsed: list[str] = []
    came_from: list[int] = []
    run_began: int | None = None
    for offset, character in enumerate(text):
        if character in WHITE_SPACE:
            # White space ahead of the first word is no part of the collapsed text.
            if collapsed and run_began is None:
                run_began = offset
        else:
            if run_began is not None:
                collapsed.append(" ")
                came_from.append(run_began)
                run_began = None
            collapsed.append(character)
            came_from.append(offset)
    found = "".join(collapsed).find(sought)
    if found != -1:
        return came_from[found], came_from[found + len(sought) - 1] + 1

    # Break-aware, and only on a miss: a line break may come between any two characters. A space is never passed over
    # for nothing, so `abc` is not found in `a b c`.
    broken = re.search(_BREAK_BETWEEN.join(_SPACE_OR_BREAK if character == " " else re.escape(character) for character in sought), text)
    return None if broken is None else broken.span()
