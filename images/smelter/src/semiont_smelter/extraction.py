"""A PDF's text, and where each word of it is on its pages; or the name the document is declined by.

A document is sorted into one class, and read that class's way:

- **A**: its pages have text of their own, which is read.
- **B**: no page has text of its own. The images its pages paint are read
  by the OCR engine.
- **C**: some pages have text of their own and some have none. The first
  are read, the images of the others are read by the engine, and what the
  engine read follows the document's own text. `unread_pages` names each
  page nothing was read from.
- **D**: a page is a grid of cells, and is written as rows.
- **E**: a filled form. Each field's value is a line of the text, anchored
  to the field's widget.

A document has one class. A filled form is E whatever else it is: a value
is nowhere else in the document, where a grid's cells are at worst read in
the order they were drawn. C is said of a document that would be A. A form
or a grid with pages that have no text keeps its class, and its pages are
read by the engine and named all the same.

A document with no text to give is declined, by name: one of more than
`LARGEST_PDF_BYTES` bytes as `too-large`, one that asks for a password as
`encrypted`, one that does not open as `corrupt`, and one with no text of
its own whose images the engine reads nothing from as `no-text-layer`.

What reads the file and what reads an image are each behind a protocol.
Everything here is worked out from what they hand over, so it is the same
whichever reads.

Offsets count Unicode code points.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Final, final

from semiont.types import (
    ExtractedText,
    ExtractedTextOcrConfidence,
    ExtractedTextPdfClass,
    ExtractionDeclined,
    ExtractionOutcome,
    PdfTextItem,
)

from semiont_smelter.anchoring import anchor_runs
from semiont_smelter.ocr_engine import OcrEngine
from semiont_smelter.ocr_text import assemble, place
from semiont_smelter.pdf_reader import FormField, Matrix, PdfDocument, PdfEncrypted, PdfReader, PdfUnreadable, Pixels, PlacedImage
from semiont_smelter.tables import detect_table, render_table

__all__ = ["LARGEST_PDF_BYTES", "PdfExtractor"]

LARGEST_PDF_BYTES: Final = 200 * 1024 * 1024
"""The largest PDF that is opened, in bytes.

A PDF is packed, so its size bounds nothing of what it opens to. It is the
one number known before a reader is handed the file, though, and a document
over it is declined by it, before any byte is read. What a page's images
open to is bounded apart, image by image.
"""

_LARGEST_IMAGE_PIXELS: Final = 48_000_000
"""The largest image that is decoded, in pixels.

A page of US Letter scanned at 600 dots to the inch is about 34 million
pixels, and an A0 sheet at 300 about 35 million: both are read. An ordinary
page at 300 is about 8 million. A decoded image is three bytes for each
pixel, 144 MB at the bound, beside what its reader holds while it decodes.
The images of one page are held, decoded, until the engine has read that
page's, and no longer: a scan of hundreds of pages is never held whole.
"""

_LOW_CONFIDENCE: Final = 60
"""A word the engine was less sure of than this, of 100, is counted among those it was unsure of."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class _Page:
    """One page's part of the text a document has of its own."""

    number: int
    start: int
    end: int
    """Past the line feed that ends the page."""
    items: tuple[PdfTextItem, ...]
    """The page's words, their offsets into the document's text. None for a page that draws no text."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class _Layer:
    """The text a document has of its own: each page's, in order, and a line feed after each."""

    text: str
    pages: tuple[_Page, ...]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class _Painted:
    """An image a page paints, decoded: what the engine is handed, and the matrix its words are placed by."""

    page: int
    matrix: Matrix
    pixels: Pixels


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class _Recovered:
    """What the engine read of some pages: the text, an item for each word, and how sure the engine was of each word."""

    text: str
    items: list[PdfTextItem]
    confidences: list[float]


def _moved(item: PdfTextItem, by: int) -> PdfTextItem:
    """`item` with its offsets moved by `by`: the same word at the same place, in a text with that much more before it."""
    return PdfTextItem(start=item.start + by, end=item.end + by, page=item.page, x=item.x, y=item.y, width=item.width, height=item.height)


async def _layer(document: PdfDocument) -> _Layer:
    """The text a document has of its own, page after page."""
    pages: list[_Page] = []
    parts: list[str] = []
    length = 0
    for number in range(1, document.page_count() + 1):
        anchored = anchor_runs(await document.runs(number), number)
        start = length
        parts.append(f"{anchored.text}\n")
        length += len(anchored.text) + 1
        pages.append(_Page(number=number, start=start, end=length, items=tuple(_moved(item, start) for item in anchored.items)))
    return _Layer(text="".join(parts), pages=tuple(pages))


def _items(layer: _Layer) -> list[PdfTextItem]:
    """Every word of a document's own text, page after page."""
    return [item for page in layer.pages for item in page.items]


def _filled(fields: Sequence[FormField]) -> list[FormField]:
    """The fields of a form that count, in the order they were handed over, each with its value's white space taken from its two ends.

    A widget counts where its value has more than white space in it, and
    the first such widget of a name is the field: the buttons of one choice
    are one answer.
    """
    by_name: dict[str, FormField] = {}
    for field in fields:
        value = field.value.strip()
        if value and field.name not in by_name:
            by_name[field.name] = replace(field, value=value)
    return [*by_name.values()]


def _folded(layer: _Layer, fields: Sequence[FormField]) -> ExtractedText:
    """Class E: the document's own text, then a line `name: value` for each field, the value anchored to the field's widget.

    A form's answers are in its fields and are not drawn on the page, so
    the page's own text has the labels and none of the values.
    """
    parts = [layer.text]
    length = len(layer.text)
    items = _items(layer)
    for field in fields:
        label = f"{field.name}: "
        start = length + len(label)
        end = start + len(field.value)
        parts.append(f"{label}{field.value}\n")
        length = end + 1
        items.append(PdfTextItem(start=start, end=end, page=field.page, x=field.x, y=field.y, width=field.width, height=field.height))
    return ExtractedText(kind="extracted", text="".join(parts), items=items, method="form", pdf_class="E")


def _as_rows(layer: _Layer) -> ExtractedText | None:
    """Class D: each page that is a grid written as rows, and every other page as it is. `None` where no page is a grid."""
    grids = [detect_table(page.items, layer.text) for page in layer.pages]
    if all(grid is None for grid in grids):
        return None
    parts: list[str] = []
    length = 0
    items: list[PdfTextItem] = []
    for page, grid in zip(layer.pages, grids, strict=True):
        if grid is None:
            # The page as it is: its stretch of the text, and its words moved to where that stretch now lies.
            parts.append(layer.text[page.start : page.end])
            items.extend(_moved(item, length - page.start) for item in page.items)
            length += page.end - page.start
        else:
            text, cells = render_table(grid, page.number, length)
            parts.append(text)
            items.extend(cells)
            length += len(text)
    return ExtractedText(kind="extracted", text="".join(parts), items=items, method="table", pdf_class="D")


def _shaped(layer: _Layer, fields: Sequence[FormField]) -> ExtractedText:
    """A document's own text in the shape of its class: a filled form's (E), or else a grid's (D), or else as it is (A)."""
    if fields:
        return _folded(layer, fields)
    rows = _as_rows(layer)
    if rows is not None:
        return rows
    return ExtractedText(kind="extracted", text=layer.text, items=_items(layer), method="pdf-text-layer", pdf_class="A")


def _summary(confidences: Sequence[float]) -> ExtractedTextOcrConfidence | None:
    """How well the engine read, over every word it read. `None` where it read no word."""
    if not confidences:
        return None
    mean = sum(confidences) / len(confidences)
    return ExtractedTextOcrConfidence(
        # To a tenth, and a half of a tenth goes up.
        mean=math.floor(mean * 10 + 0.5) / 10,
        low_confidence_words=sum(1 for confidence in confidences if confidence < _LOW_CONFIDENCE),
        total_words=len(confidences),
    )


def _within_budget(image: PlacedImage) -> bool:
    """Whether an image is one to decode, by the size its page states for it: nothing of it is decoded to find out."""
    return image.width > 0 and image.height > 0 and image.width * image.height <= _LARGEST_IMAGE_PIXELS


@final
class PdfExtractor:
    """Derives a PDF's text with one reader and one engine. It keeps nothing of a document it has derived."""

    def __init__(self, *, reader: PdfReader, engine: OcrEngine) -> None:
        self._reader: Final = reader
        self._engine: Final = engine

    async def extract(self, content: bytes) -> ExtractionOutcome:
        """The text of the PDF these bytes are, with an item for each word of it; or the name it is declined by.

        A document over `LARGEST_PDF_BYTES` is declined before the reader
        is handed it. A document that opened and has a part its reader
        cannot read is declined as `corrupt`, as bytes that do not open
        are. A document that was opened is let go of whatever comes of
        reading it. A failure of the engine is raised as it is.
        """
        if len(content) > LARGEST_PDF_BYTES:
            return ExtractionDeclined(kind="declined", declined="too-large")
        try:
            document = await self._reader.open(content)
        except PdfEncrypted:
            return ExtractionDeclined(kind="declined", declined="encrypted")
        except PdfUnreadable:
            return ExtractionDeclined(kind="declined", declined="corrupt")
        try:
            return await self._derive(document)
        except PdfUnreadable:
            return ExtractionDeclined(kind="declined", declined="corrupt")
        finally:
            await document.close()

    async def _derive(self, document: PdfDocument) -> ExtractionOutcome:
        """What an opened document comes to."""
        layer = await _layer(document)
        without_text = [page.number for page in layer.pages if not page.items]

        # Class B: no page draws text, so the characters are in pixels alone. Its form, if it has one, is not
        # asked for: a form's values add to a document's text, and are none of their own.
        if len(without_text) == len(layer.pages):
            scanned = await self._read(document, without_text)
            if not scanned.text:
                return ExtractionDeclined(kind="declined", declined="no-text-layer")
            return ExtractedText(
                kind="extracted",
                text=scanned.text,
                items=scanned.items,
                method="ocr",
                pdf_class="B",
                ocr_confidence=_summary(scanned.confidences),
            )

        shaped = _shaped(layer, _filled(await document.form_fields()))
        if not without_text:
            return shaped

        recovered = await self._read(document, without_text)
        read_from = {int(item.page) for item in recovered.items}
        unread = [page for page in without_text if page not in read_from]
        # C is said in place of A alone: a form and a grid keep their class.
        pdf_class: ExtractedTextPdfClass | None = shaped.pdf_class
        if pdf_class == "A":
            pdf_class = "C"
        if not recovered.text:
            return ExtractedText(
                kind="extracted",
                text=shaped.text,
                items=shaped.items,
                method=shaped.method,
                pdf_class=pdf_class,
                unread_pages=unread,
            )
        # What the engine read follows the document's own text, and is not put between its pages: the items
        # of the pages that have text keep their offsets, and the engine's words are moved past them.
        past = len(shaped.text)
        return ExtractedText(
            kind="extracted",
            text=f"{shaped.text}{recovered.text}\n",
            items=[*shaped.items, *(_moved(item, past) for item in recovered.items)],
            method="ocr",
            pdf_class=pdf_class,
            ocr_confidence=_summary(recovered.confidences),
            unread_pages=unread or None,
        )

    async def _read(self, document: PdfDocument, pages: Sequence[int]) -> _Recovered:
        """What the engine reads of the images some pages paint: the text, with each word placed on its page.

        The engine is asked once for each page that has an image to read,
        with that page's images, and a page's pixels are let go of before
        the next page's are decoded. It is not asked for a page with no
        image. An image over the pixel budget is not decoded, and one its
        reader does not decode is passed over. The texts of one page's
        images are a line feed apart, and two pages' an empty line apart.
        A page nothing was read from has no item.
        """
        parts: list[str] = []
        length = 0
        items: list[PdfTextItem] = []
        confidences: list[float] = []
        last: int | None = None
        for page in pages:
            painted: list[_Painted] = []
            for image in await document.placed_images(page):
                if not _within_budget(image):
                    continue
                decoded = await document.decode(page, image)
                if decoded is not None:
                    painted.append(_Painted(page=page, matrix=image.matrix, pixels=decoded))
            if not painted:
                continue
            answers = await self._engine.read([each.pixels for each in painted])
            # An engine that answers for more or fewer images than it was handed fails here.
            for each, answer in zip(painted, answers, strict=True):
                found = assemble(answer)
                if not found.text.strip():
                    continue
                if last is not None:
                    between = "\n" if each.page == last else "\n\n"
                    parts.append(between)
                    length += len(between)
                size = each.pixels
                placed = place(found.words, width=size.width, height=size.height, matrix=each.matrix, page=each.page, offset=length)
                items.extend(placed)
                confidences.extend(word.confidence for word in found.words)
                parts.append(found.text)
                length += len(found.text)
                last = each.page
        return _Recovered(text="".join(parts), items=items, confidences=confidences)
