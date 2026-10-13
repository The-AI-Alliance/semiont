"""The text around a selection: what an annotation's target selects of a text, and the text on either side of it.

A Librarian cuts a text around an annotation in two places
(`docs/protocol/LIBRARIAN.md` § Gathering around an annotation, § An
annotation's summary), and `specs/src/librarian/window-cases.json` states
both. The cut is one, and so is the rule for where: a target's position
selector, wherever among its selectors it is, and otherwise its quote
selector, found in the text as every SDK finds a quote
(`semiont.annotations.reconcile`), which reads its prefix and its suffix.

An offset counts Unicode code points from the start of the text, and so does
a window. A `str` is indexed by code point, so an offset is the string's own
index and nothing is converted.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, final

from semiont.annotations import QuotedText, reconcile, target_selector
from semiont.types import Annotation, Selector, TextPositionSelector, TextQuoteSelector

__all__ = [
    "LARGEST_WINDOW",
    "LEAST_WINDOW",
    "Unplaced",
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
class Unplaced(Exception):
    """No selector of an annotation's target places it in the text, and the cut asked for cannot be made without a place."""


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


def _placed(annotation: Annotation, text: str) -> tuple[int, int] | None:
    """Where an annotation's target places it in `text`: the two offsets of what it selects. `None` where no selector places it.

    The first position selector the target states is the place, wherever
    among its selectors it is: its `start` and its `end`. A target with none
    is placed by the first quote selector it states, found in the text as a
    quote is found everywhere (`semiont.annotations.reconcile`): where the
    text has its words once, there; where it has them more than once, at the
    place its prefix and its suffix fit, and at the first where neither
    chooses; and where it does not have them as written, where a looser
    search finds them. Words the text has nowhere place nothing, and neither
    does a selector of another kind.
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
    if position is not None:
        return position.start, position.end
    quote = next((each for each in selectors if isinstance(each, TextQuoteSelector)), None)
    if quote is None:
        return None
    found = reconcile(text, QuotedText(exact=quote.exact, prefix=quote.prefix, suffix=quote.suffix))
    return None if found is None else (found.start, found.end)


def selection_of(annotation: Annotation, text: str, window: int) -> Window | None:
    """What a gather cuts of `text` around an annotation: the selection, and `window` code points on each side of it.

    `None` where no selector of the target places the annotation in the
    text.

    Raises `WindowRefused` for a window outside `LEAST_WINDOW` to
    `LARGEST_WINDOW`, before anything is read of the annotation.
    """
    refuse_out_of_bounds(window)
    place = _placed(annotation, text)
    return None if place is None else text_around(text, *place, window, window)


def annotation_context(annotation: Annotation, text: str, before: int, after: int) -> Window:
    """What a summary cuts of `text` around an annotation: what its target selects, with a window of its own on each side.

    Raises `Unplaced` where no selector of the target places the annotation
    in the text: a summary is of a passage, and there is none.
    """
    place = _placed(annotation, text)
    if place is None:
        raise Unplaced("No selector of the annotation's target places it in the text")
    return text_around(text, *place, before, after)
