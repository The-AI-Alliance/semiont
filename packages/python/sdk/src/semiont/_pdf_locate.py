"""Where a span of a PDF's text is on its pages.

An annotation of a PDF is anchored by rectangles on its pages, so a span of
the PDF's anchored text is located: one rectangle for each line it touches,
each written as an RFC 3778 fragment.
`specs/src/annotations/pdf-locate-cases.json` holds the rule, for this and for
every other SDK.

A span's offsets and an item's count code points. Coordinates are PDF points
from the bottom-left corner of the page, `y` growing upward.
"""

from dataclasses import dataclass
from decimal import Decimal
from typing import Final, final

from semiont.types import AnchoredText, PdfTextItem

_SAME_LINE: Final = 2
"""Items whose `y` is within this many points of the first item of a line are on that line."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Rectangle:
    """A rectangle on a page: its bottom-left corner and its size, in PDF points."""

    page: float
    x: float
    y: float
    width: float
    height: float


def _lines(items: list[PdfTextItem]) -> list[list[PdfTextItem]]:
    """A page's items as its lines, the top of the page first and each line from its left."""
    lines: list[list[PdfTextItem]] = []
    for item in sorted(items, key=lambda item: (-item.y, item.x)):
        if lines and abs(item.y - lines[-1][0].y) <= _SAME_LINE:
            lines[-1].append(item)
        else:
            lines.append([item])
    return lines


def _edges(item: PdfTextItem, start: int, end: int) -> tuple[float, float]:
    """An item's left and right edges, each moved in where the span cuts the item: in proportion to the code points cut off."""
    count = item.end - item.start
    left = item.x + item.width * ((start - item.start) / count) if item.start < start else item.x
    right = item.x + item.width * ((end - item.start) / count) if item.end > end else item.x + item.width
    return left, right


def _spanning(page: float, line: list[PdfTextItem], start: int, end: int) -> Rectangle:
    """The rectangle that spans a line's items, as far as the span reaches into each."""
    edges = [_edges(item, start, end) for item in line]
    x = min(left for left, _ in edges)
    right = max(right for _, right in edges)
    y = min(item.y for item in line)
    top = max(item.y + item.height for item in line)
    return Rectangle(page=page, x=x, y=y, width=right - x, height=top - y)


def locate(anchored: AnchoredText, start: int, end: int) -> tuple[list[PdfTextItem], list[Rectangle]]:
    """The items a span of the anchored text overlaps, in the text's order, and a rectangle for each line of each page it touches.

    Pages come in the order their first overlapped item has in the text. A
    span that no item overlaps has neither, and an empty span overlaps none.
    """
    # An empty span has no character for an item to hold, inside one as between two.
    if start == end:
        return [], []
    overlapping = [item for item in anchored.items if item.start < end and item.end > start]
    pages: dict[float, list[PdfTextItem]] = {}
    for item in overlapping:
        pages.setdefault(item.page, []).append(item)
    return overlapping, [_spanning(page, line, start, end) for page, items in pages.items() for line in _lines(items)]


def _decimal(number: float) -> str:
    """A number as the shortest decimal that reads back as it: a whole number has no point.

    `repr` is that decimal, but for a small number it is written with an
    exponent, which a fragment has no form for.
    """
    return str(int(number)) if number.is_integer() else format(Decimal(repr(number)), "f")


def fragment_of(rectangle: Rectangle) -> str:
    """A rectangle as the value of a `FragmentSelector`: `page=P&viewrect=X,Y,W,H`."""
    return (
        f"page={_decimal(rectangle.page)}"
        f"&viewrect={_decimal(rectangle.x)},{_decimal(rectangle.y)},{_decimal(rectangle.width)},{_decimal(rectangle.height)}"
    )
