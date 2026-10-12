"""The text around a selection: what an annotation's target selects of a text, and the text on either side of it.

A Librarian cuts a text around an annotation in two places
(`docs/protocol/LIBRARIAN.md` § Gathering around an annotation, § An
annotation's summary), and `specs/src/librarian/window-cases.json` states
both. The cut is one. What differs is which selector says where: a gather
reads the first selector of a target, a position or a quote, and a summary
reads the position selector, wherever in a list it is.

An offset counts Unicode code points from the start of the text, and so does
a window. A `str` is indexed by code point, so an offset is the string's own
index and nothing is converted.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, final

from semiont.annotations import target_selector
from semiont.types import Annotation, Selector, TextPositionSelector, TextQuoteSelector

__all__ = [
    "LARGEST_WINDOW",
    "LEAST_WINDOW",
    "PositionRequired",
    "Window",
    "WindowRefused",
    "annotation_context",
    "refuse_out_of_bounds",
    "selection_of",
    "text_around",
]

LEAST_WINDOW: Final = 100
"""The least window a gather takes, in code points."""

LARGEST_WINDOW: Final = 5000
"""The largest window a gather takes, in code points."""


@final
class WindowRefused(Exception):
    """A gather's window is less than `LEAST_WINDOW` or more than `LARGEST_WINDOW`: nothing is cut."""


@final
class PositionRequired(Exception):
    """An annotation's target states no position selector, and the cut asked for is the one made at a position."""


@final
@dataclass(frozen=True, slots=True)
class Window:
    """A selection of a text, and the text on either side of it."""

    before: str
    selected: str
    after: str


def refuse_out_of_bounds(window: int) -> None:
    """Refuse a gather's window that is out of bounds. This is the one place that says what the bounds are, and in what words.

    Raises `WindowRefused` for a window less than `LEAST_WINDOW` or more
    than `LARGEST_WINDOW`. A gather asks this before it reads anything.
    """
    if not LEAST_WINDOW <= window <= LARGEST_WINDOW:
        raise WindowRefused(f"contextWindow must be between {LEAST_WINDOW} and {LARGEST_WINDOW}")


def text_around(text: str, start: int, end: int, before: int, after: int) -> Window:
    """The span of `text` from `start` to `end`, with at most `before` code points of the text before it and `after` of the text after it.

    Each side is cut at the nearer of its window and the end of the text.
    An offset past the end of the text is the end of the text.
    """
    length = len(text)
    start = min(length, max(0, start))
    end = min(length, max(0, end))
    return Window(before=text[max(0, start - before) : start], selected=text[start:end], after=text[end : end + after])


def selection_of(annotation: Annotation, text: str, window: int) -> Window | None:
    """What a gather cuts of `text` around an annotation: the selection, and `window` code points on each side of it.

    The selector read is the target's first, and no other. A position
    selector selects from its `start` to its `end`. A quote selector selects
    the first place the text has its `exact` words, whatever its prefix and
    its suffix say. `None` where there is no selection: words the text does
    not have, a target that states no selector, and a selector of another
    kind.

    Raises `WindowRefused` for a window outside `LEAST_WINDOW` to
    `LARGEST_WINDOW`, before anything is read of the annotation.
    """
    refuse_out_of_bounds(window)
    stated = target_selector(annotation.target)
    if isinstance(stated, list):
        if not stated:
            return None
        stated = stated[0]
    if isinstance(stated, TextPositionSelector):
        return text_around(text, stated.start, stated.end, window, window)
    if isinstance(stated, TextQuoteSelector):
        found = text.find(stated.exact)
        if found == -1:
            return None
        return text_around(text, found, found + len(stated.exact), window, window)
    return None


def annotation_context(annotation: Annotation, text: str, before: int, after: int) -> Window:
    """What a summary cuts of `text` around an annotation: the span of its position selector, with a window of its own on each side.

    The position selector is the first the target states, wherever in a
    list of selectors it is. Raises `PositionRequired` for a target that
    states none, whatever else it states.
    """
    stated = target_selector(annotation.target)
    selectors: Sequence[Selector]
    if stated is None:
        selectors = ()
    elif isinstance(stated, list):
        selectors = stated
    else:
        selectors = (stated,)
    position = next((each for each in selectors if isinstance(each, TextPositionSelector)), None)
    if position is None:
        raise PositionRequired("TextPositionSelector required for context")
    return text_around(text, position.start, position.end, before, after)
