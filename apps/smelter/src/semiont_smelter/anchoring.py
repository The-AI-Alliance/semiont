"""A page's text, made from the words drawn on it, and where a matrix takes a point.

`anchor_runs` is the one rule that says what a page's text is, and which
stretch of it each word is: a word's text, then a line feed where the word
ends a line of the page and a space otherwise. Whatever reads the file, a
page's text is made by this rule, so a rectangle drawn on a page quotes the
same text whoever asks.

Offsets count Unicode code points, as every offset into a text does.
"""

from collections.abc import Sequence

from semiont.types import AnchoredText, PdfTextItem

from semiont_smelter.pdf_reader import Matrix, Run

__all__ = ["anchor_runs", "apply"]


def anchor_runs(runs: Sequence[Run], page: int) -> AnchoredText:
    """One page's text, with an item for each word: where the word is on the page, and which stretch of the text it is.

    A word's stretch is the word as its reader handed it over, whole, and
    never the separator after it. A run of white space alone is no word: it
    adds no item and no space, and a line feed where it ends a line.

    Offsets are the page's own, from 0. Whoever puts pages together moves
    them by the length of the text before the page.
    """
    items: list[PdfTextItem] = []
    parts: list[str] = []
    length = 0
    for run in runs:
        if run.text.strip():
            end = length + len(run.text)
            items.append(PdfTextItem(start=length, end=end, page=page, x=run.x, y=run.y, width=run.width, height=run.height))
            # The separator is written after the word is recorded, so that no word's stretch has it.
            parts.append(run.text)
            parts.append("\n" if run.ends_line else " ")
            length = end + 1
        elif run.ends_line:
            parts.append("\n")
            length += 1
    return AnchoredText(text="".join(parts), items=items)


def apply(matrix: Matrix, x: float, y: float) -> tuple[float, float]:
    """Where `matrix` takes the point `(x, y)`."""
    a, b, c, d, e, f = matrix
    return a * x + c * y + e, b * x + d * y + f
