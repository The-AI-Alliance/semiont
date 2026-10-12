"""What reads a PDF, as the Smelter asks it: what is in the document, and nothing worked out from it.

A reader hands over the words drawn on each page and where each is, a filled
form's fields, and the images placed on a page with their pixels. Which
class a document is, what its text is, a table's rows, a form's lines and
where a word read from pixels is on its page are the Smelter's own, written
once, whatever reads the file. So a second reader can differ from the first
only in where it judges a word to end.

Places and sizes are in PDF points, measured from the bottom left of the
page, with y upward. Pages are counted from 1.

Reading a PDF is work for a processor, and none of it is a wait. Every call
here is asynchronous all the same: a reader does its work off the loop, at
one place of its own, and says there how.

No type of a reader's library appears here.
"""

from dataclasses import dataclass
from typing import Protocol, final

__all__ = [
    "FormField",
    "Matrix",
    "PdfDocument",
    "PdfEncrypted",
    "PdfReader",
    "PdfUnreadable",
    "Pixels",
    "PlacedImage",
    "Run",
]

type Matrix = tuple[float, float, float, float, float, float]
"""A PDF matrix `(a, b, c, d, e, f)`: it takes the point `(x, y)` to `(a*x + c*y + e, b*x + d*y + f)`."""


@final
class PdfEncrypted(Exception):
    """The document asks for a password, and is not read without one."""


@final
class PdfUnreadable(Exception):
    """The bytes are no PDF a reader can open, or a part of the document that was asked for cannot be read."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Run:
    """One word drawn on a page, as the reader finds it. Where a word ends is the reader's judgement, and is not remade."""

    text: str
    x: float
    """Where its baseline begins: the origin of its first glyph."""
    y: float
    """Its baseline."""
    width: float
    """Along the baseline, from the first glyph's origin to where the last glyph's advance ends."""
    height: float
    """The size of its font, as the page shows it."""
    ends_line: bool
    """Whether a line of the page ends after it."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class FormField:
    """One field of a form, with the value it was filled with and the rectangle of its widget."""

    name: str
    """The field's whole name, with its parents' (`policy.holder.name`)."""
    value: str
    page: int
    x: float
    y: float
    width: float
    height: float


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class PlacedImage:
    """An image a page paints, before anything of it is decoded: how large it is, and where the page puts it."""

    index: int
    """Which of the page's images it is, in the order the page paints them, counted from 0."""
    width: int
    """In pixels."""
    height: int
    matrix: Matrix
    """Takes the image's unit square onto the page: its bottom left corner to `(e, f)`."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Pixels:
    """An image decoded: three bytes for each pixel, red, green and blue, the top row first and each row from the left."""

    width: int
    height: int
    rgb: bytes


class PdfDocument(Protocol):
    """A PDF that was opened. Every document a reader opens has these members and no others.

    A document that opened may still have a page its reader cannot read.
    Whatever is asked of such a page raises `PdfUnreadable`, as bytes that
    do not open do.
    """

    def page_count(self) -> int: ...

    async def runs(self, page: int) -> list[Run]:
        """The words drawn on a page, in the order they are read. None for a page that draws no text."""
        ...

    async def form_fields(self) -> list[FormField]:
        """Every widget of the document's form, in the order of the pages. None for a document with no form.

        A field with no value is handed over with an empty one: which
        fields count is not the reader's to say.
        """
        ...

    async def placed_images(self, page: int) -> list[PlacedImage]:
        """The images a page paints, in the order it paints them. Nothing is decoded, so a caller can refuse one by its size first."""
        ...

    async def decode(self, page: int, image: PlacedImage) -> Pixels | None:
        """One of a page's images as pixels. `None` for an image of a kind the reader does not decode."""
        ...

    async def close(self) -> None:
        """Let go of the document. Nothing is asked of it afterwards."""
        ...


class PdfReader(Protocol):
    """What reads PDFs. Every reader has these members and no others."""

    async def stamp(self) -> str:
        """The reader's name and its version, as the anchored-text store's stamp states them.

        Read from what is installed, and never written by hand: a reader
        that is upgraded reads differently, and what it read before is
        then no longer taken.
        """
        ...

    async def open(self, content: bytes) -> PdfDocument:
        """Open a document. Raises `PdfEncrypted` for one that asks for a password, and `PdfUnreadable` for bytes that are no PDF."""
        ...
