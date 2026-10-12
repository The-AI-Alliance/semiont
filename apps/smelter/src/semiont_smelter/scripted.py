"""A reader and an engine that read nothing: each answers what a test said, and keeps what it was asked. For tests.

Each is the second implementation of its protocol, and what the Smelter's
own rules are tested on: a class, a table, a form, where a word read from
pixels lands. What the real reader and the real engine make of a real file
is held by their own tests.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final, final, override

from semiont_smelter.ocr_engine import OcrEngine, OcrRead
from semiont_smelter.pdf_reader import FormField, Matrix, PdfDocument, PdfEncrypted, PdfReader, PdfUnreadable, Pixels, PlacedImage, Run

__all__ = ["ScriptedDocument", "ScriptedImage", "ScriptedOcrEngine", "ScriptedPage", "ScriptedPdfReader"]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ScriptedImage:
    """An image a scripted page paints. `pixels` is what it decodes to, and `None` for one the reader does not decode."""

    width: int
    height: int
    matrix: Matrix
    pixels: Pixels | None


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ScriptedPage:
    """One page of a scripted document: the words drawn on it and the images it paints.

    A page stated `unreadable` is one its reader cannot read: whatever is
    asked of it raises `PdfUnreadable`.
    """

    runs: Sequence[Run] = ()
    images: Sequence[ScriptedImage] = ()
    unreadable: bool = False


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ScriptedDocument:
    """A document as a test states it: its pages from the first, and its form's fields."""

    pages: Sequence[ScriptedPage]
    fields: Sequence[FormField] = ()


@final
class _Opened(PdfDocument):
    def __init__(self, document: ScriptedDocument, closed: list[ScriptedDocument], decoded: list[tuple[int, int]]) -> None:
        self._document: Final = document
        self._closed: Final = closed
        self._decoded: Final = decoded

    def _page(self, page: int) -> ScriptedPage:
        if not 1 <= page <= len(self._document.pages):
            raise IndexError(f"the document has no page {page}")
        stated = self._document.pages[page - 1]
        if stated.unreadable:
            raise PdfUnreadable(f"page {page} is one no reader can read")
        return stated

    @override
    def page_count(self) -> int:
        return len(self._document.pages)

    @override
    async def runs(self, page: int) -> list[Run]:
        return [*self._page(page).runs]

    @override
    async def form_fields(self) -> list[FormField]:
        return [*self._document.fields]

    @override
    async def placed_images(self, page: int) -> list[PlacedImage]:
        painted = self._page(page).images
        return [
            PlacedImage(index=index, width=image.width, height=image.height, matrix=image.matrix) for index, image in enumerate(painted)
        ]

    @override
    async def decode(self, page: int, image: PlacedImage) -> Pixels | None:
        self._decoded.append((page, image.index))
        return self._page(page).images[image.index].pixels

    @override
    async def close(self) -> None:
        self._closed.append(self._document)


@final
class ScriptedPdfReader(PdfReader):
    """Opens the documents a test stated, by their bytes. Bytes it was told nothing of are unreadable.

    `documents` gives, for some bytes, the document they are, or the
    failure opening them raises. `opened` is the bytes of every document
    asked for, in order; `closed` every document that was let go of; and
    `decoded` every image that was decoded, as its page and its place among
    the page's images.
    """

    def __init__(
        self, documents: Mapping[bytes, ScriptedDocument | PdfEncrypted | PdfUnreadable], *, stamp: str = "scripted-reader-1"
    ) -> None:
        self._documents: Final = dict(documents)
        self._stamp: Final = stamp
        self.opened: Final[list[bytes]] = []
        self.closed: Final[list[ScriptedDocument]] = []
        self.decoded: Final[list[tuple[int, int]]] = []

    @override
    async def stamp(self) -> str:
        return self._stamp

    @override
    async def open(self, content: bytes) -> PdfDocument:
        self.opened.append(content)
        stated = self._documents.get(content)
        if stated is None:
            raise PdfUnreadable("bytes no test said anything of")
        if isinstance(stated, ScriptedDocument):
            return _Opened(stated, self.closed, self.decoded)
        raise stated


@final
class ScriptedOcrEngine(OcrEngine):
    """Reads of each image what a test stated for its pixels, and nothing of any other image.

    `reads` gives, for the bytes of some images' pixels, what is read of
    them. `asked` is the images of every call, in order: an engine is asked
    once for each page it is to read, and a test can hold that.
    """

    def __init__(self, reads: Mapping[bytes, OcrRead] | None = None, *, stamp: str = "scripted-engine-1") -> None:
        self._reads: Final = dict(reads or {})
        self._stamp: Final = stamp
        self.asked: Final[list[tuple[Pixels, ...]]] = []

    @override
    async def stamp(self) -> str:
        return self._stamp

    @override
    async def read(self, images: Sequence[Pixels]) -> list[OcrRead]:
        self.asked.append(tuple(images))
        return [self._reads.get(image.rgb, OcrRead()) for image in images]
