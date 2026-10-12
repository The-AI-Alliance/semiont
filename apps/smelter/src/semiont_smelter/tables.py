"""A page that is a grid of cells: found from where its words are, and written as rows.

A PDF has no tables. It has words at places, and read in the order they are
drawn a grid's cells run together: a row's values are scattered through the
text. So a grid is found from the places, and written a row to a line, each
cell beside the next.

A page is taken for a grid only where it is a strict one: at least three
rows and two columns, every row of as many cells, and every column starting
at one place down the page. Prose taken for a grid is scrambled, and a grid
taken for prose is only read in the order it was drawn, so what is in doubt
is prose.

An item here is one word. Two words of one cell are two items a word space
apart, and what keeps them one cell is that a word space is narrower than
the gap that ends a cell.

Offsets count Unicode code points.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, final

from semiont.types import PdfTextItem

__all__ = ["TableCell", "detect_table", "render_table"]

_FEWEST_ROWS: Final = 3
"""A heading and two rows under it. With fewer, prose set in columns cannot be told from a grid."""

_FEWEST_COLUMNS: Final = 2

_ROW_TOLERANCE: Final = 0.5
"""How far apart the baselines of two words of one row may be, in heights of the page's text."""

_CELL_GAP: Final = 0.8
"""The gap across that ends a cell, in heights of the page's text: two words no further apart than this are one cell.

A word space is a quarter to a third of a height in most typefaces, and six
tenths in one whose characters are all as wide as each other. A gutter
between two columns is wider than a height.
"""

_HEIGHT_WHERE_NONE_IS_STATED: Final = 12.0
"""The height taken for a page's text where no word of the page states one."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class TableCell:
    """One cell of a grid: its text, and the rectangle around its words, in PDF points from the bottom left of the page."""

    text: str
    x: float
    y: float
    width: float
    height: float


def _rows(items: Sequence[PdfTextItem], tolerance: float) -> list[list[PdfTextItem]]:
    """A page's words as its rows, from the top: a word within `tolerance` of a row's first word's baseline is of that row."""
    rows: list[list[PdfTextItem]] = []
    for item in sorted(items, key=lambda item: item.y, reverse=True):
        if rows and abs(rows[-1][0].y - item.y) <= tolerance:
            rows[-1].append(item)
        else:
            rows.append([item])
    return rows


def _cell(words: Sequence[PdfTextItem], text: str) -> TableCell:
    """The cell some words are: their texts a space apart, and the rectangle around them all."""
    x = min(word.x for word in words)
    y = min(word.y for word in words)
    right = max(word.x + word.width for word in words)
    top = max(word.y + word.height for word in words)
    said = " ".join(text[word.start : word.end] for word in words).strip()
    return TableCell(text=said, x=x, y=y, width=right - x, height=top - y)


def _cells(row: Sequence[PdfTextItem], gap: float, text: str) -> list[TableCell]:
    """A row's cells from the left: a word further than `gap` from the end of the word before it begins a cell."""
    cells: list[TableCell] = []
    current: list[PdfTextItem] = []
    for item in sorted(row, key=lambda item: item.x):
        if current and item.x - (current[-1].x + current[-1].width) > gap:
            cells.append(_cell(current, text))
            current = []
        current.append(item)
    if current:
        cells.append(_cell(current, text))
    return cells


def detect_table(items: Sequence[PdfTextItem], text: str) -> list[list[TableCell]] | None:
    """The grid one page's words make: its rows from the top, each as its cells from the left. `None` for a page that is no strict grid.

    `items` are the page's words, and their offsets are into `text`.
    Distances are measured in heights of the page's text: the height in the
    middle of its words' heights, the upper of the two where they are even
    in number.
    """
    if not items:
        return None
    heights = sorted(item.height for item in items if item.height > 0)
    unit = heights[len(heights) // 2] if heights else _HEIGHT_WHERE_NONE_IS_STATED

    rows = [_cells(row, unit * _CELL_GAP, text) for row in _rows(items, unit * _ROW_TOLERANCE)]
    if len(rows) < _FEWEST_ROWS:
        return None
    columns = len(rows[0])
    if columns < _FEWEST_COLUMNS:
        return None
    if any(len(row) != columns for row in rows):
        return None
    # A column starts at one place down the page. Left edges more than a height apart are prose that wraps, and no grid.
    for column in range(columns):
        lefts = [row[column].x for row in rows]
        if max(lefts) - min(lefts) > unit:
            return None
    if any(not cell.text for row in rows for cell in row):
        return None
    return rows


def render_table(rows: Sequence[Sequence[TableCell]], page: int, offset: int) -> tuple[str, list[PdfTextItem]]:
    """A grid as text, a row to a line, and an item for each cell at the place the cell's words were.

    A row is written `| cell | cell |`, and the first is followed by the
    line of dashes that makes it a table's heading. `offset` is where the
    text begins in the document it is put into: the items' offsets are into
    that document.
    """
    parts: list[str] = []
    length = 0
    items: list[PdfTextItem] = []
    for index, row in enumerate(rows):
        opening = "|"
        parts.append(opening)
        length += len(opening)
        for cell in row:
            start = offset + length + 1
            end = start + len(cell.text)
            parts.append(f" {cell.text} |")
            length += len(cell.text) + 3
            items.append(PdfTextItem(start=start, end=end, page=page, x=cell.x, y=cell.y, width=cell.width, height=cell.height))
        parts.append("\n")
        length += 1
        if index == 0:
            dashes = "|" + " --- |" * len(row) + "\n"
            parts.append(dashes)
            length += len(dashes)
    return "".join(parts), items
