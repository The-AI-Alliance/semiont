"""The text of an image an engine read, and where each word of it is on the page.

An engine hands over paragraphs of lines of words. The text is put together
here, word by word, and each word's offsets are written down as the word is
written. So the stretch a word's offsets select is that word by how the
text was made, and not by looking for the word in it afterwards. The words
of a line are a space apart, a line ends in a line feed, and an empty line
is between two paragraphs.

A word's box is in the image's pixels, from the image's top left corner.
Where the word is on the page is where the matrix that placed the image
takes the corners of its box.

Offsets count Unicode code points.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import final

from semiont.types import PdfTextItem

from semiont_smelter.anchoring import apply
from semiont_smelter.ocr_engine import Box, OcrRead
from semiont_smelter.pdf_reader import Matrix

__all__ = ["ImageText", "ReadWord", "assemble", "place"]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ReadWord:
    """One word of an image's text: which stretch of the text it is, where it is in the image, and how sure the engine was of it."""

    text: str
    start: int
    end: int
    box: Box
    """Across, the word's own extent. Up and down, its line's: `assemble` says why."""
    confidence: float


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ImageText:
    """What was read of one image: its text, and the words of the text in their order."""

    text: str
    words: tuple[ReadWord, ...]


def assemble(read: OcrRead) -> ImageText:
    """The text of one image, and each word of it with the stretch of the text it is.

    A word of white space alone is no word. White space is taken from a
    word's two ends, and from the end of the text; nothing is taken from
    the text's start, so no offset moves.

    A word's box hugs its glyphs, so a word with a descender reaches lower
    than its neighbours. The items of one line are known for one line by
    their `y`, which words drawn as text share, being on one baseline. So a
    word read from pixels takes its line's top and bottom, and only its
    left and right are its own.
    """
    parts: list[str] = []
    length = 0
    words: list[ReadWord] = []
    for paragraph in read.paragraphs:
        for line in paragraph.lines:
            wrote = False
            for word in line.words:
                value = word.text.strip()
                if not value:
                    continue
                if wrote:
                    parts.append(" ")
                    length += 1
                start = length
                parts.append(value)
                length += len(value)
                box = Box(x0=word.box.x0, y0=line.box.y0, x1=word.box.x1, y1=line.box.y1)
                words.append(ReadWord(text=value, start=start, end=length, box=box, confidence=word.confidence))
                wrote = True
            if wrote:
                parts.append("\n")
                length += 1
        parts.append("\n")
        length += 1
    return ImageText(text="".join(parts).rstrip(), words=tuple(words))


def place(words: Sequence[ReadWord], *, width: int, height: int, matrix: Matrix, page: int, offset: int) -> list[PdfTextItem]:
    """An item for each word of an image's text: the word's place on its page, in PDF points, and its stretch of the document's text.

    `width` and `height` are the image's, in the pixels the engine read,
    and `matrix` is the one that placed the image on the page. `offset` is
    where the image's text begins in the document's.

    A pixel is taken to the image's unit square, whose y runs up where a
    pixel's runs down, and from there to the page by the matrix. Two
    opposite corners of a word's box are taken, and the item is the
    rectangle between them: a placement that mirrors or turns the image
    puts either corner first. Nothing is placed for an image of no width
    or no height.
    """
    if width <= 0 or height <= 0:
        return []
    items: list[PdfTextItem] = []
    for word in words:
        ax, ay = apply(matrix, word.box.x0 / width, 1 - word.box.y0 / height)
        bx, by = apply(matrix, word.box.x1 / width, 1 - word.box.y1 / height)
        x, y = min(ax, bx), min(ay, by)
        start, end = word.start + offset, word.end + offset
        items.append(PdfTextItem(start=start, end=end, page=page, x=x, y=y, width=abs(bx - ax), height=abs(by - ay)))
    return items
