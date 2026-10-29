"""The PDFium reader: a PDF read by PDFium, the reader Chrome has, through the `pypdfium2` package.

**One thread.** PDFium is not safe on more than one thread, not even for two
documents. Every call into it, of every document of every reader, runs on
one thread that this module owns: an executor of one worker, and no lock,
which takes the calls in the order they were asked. Importing the package
is such a call, since importing it starts PDFium, and it is made there too.
The package lets go of what it made when the last name for it goes, on
whatever thread that happens. So every page, text page and bitmap made here
is closed here, on that thread, before the call that made it answers, and
nothing is kept between two calls but the document: a page is loaded for a
call and closed after it.

**No types.** `pypdfium2` states none: it has no `py.typed`, its helper
classes are not annotated, and `pypdfium2.raw` is `ctypes` bindings made
when the package is built. So it is never imported by name. It is looked
up, and what is asked of it is stated here, as protocols.

**What is handed over.**

- A run is a word, and a word ends where PDFium judges it to: at a space or
  a line end of its own text of the page. Its place is its baseline's: from
  the origin of its first glyph to where the advance of its last one ends,
  and as high as its font's size, scaled by its text matrix.
- PDFium joins a word hyphenated over a line end, and leaves a mark (U+0002)
  where the hyphen was. The mark is handed over as the hyphen the page
  draws, and ends its run and its line.
- PDFium counts characters in UTF-16. A character outside the basic plane is
  two of its, and is put back together. Half of one with no other half, and
  a code that is no character, are U+FFFD.
- A form's widgets are read in the order of the pages, each with its
  field's whole name and its value as it is. The form is started before any
  page is loaded: a widget's value reads empty otherwise.
- A page's images are the image objects it paints, and those of the forms
  it paints, to a depth of 15. An image inside a form is handed over with
  its own matrix, which places it in its form and not on the page.
- An image is decoded as PDFium holds it, and neither its mask nor its
  matrix is applied. PDFium's bitmap is grey (one byte for a pixel), or
  blue, green and red (three), or those and a fourth byte (four), each row
  from the top and as many bytes long as the bitmap's `stride`, which can be
  more than the row's pixels take. It is handed over as red, green and blue
  with no bytes between rows: a grey is the same in all three, and a fourth
  byte is left out, so an alpha is not applied.

**What it leans on in the package** (`pypdfium2` 5.14, which is the least
the Smelter asks for):

- `PYPDFIUM_INFO.version` and `PDFIUM_INFO.version`: the package's version
  and PDFium's, as text.
- `PdfDocument(bytes)`, which raises `PdfiumError` for a document that does
  not open, and with no page counts as one that does not; the error's
  `err_code`, which is `FPDF_ERR_PASSWORD` for a document that asks for a
  password; the document's `init_forms()`, `formenv` (`None` with no form;
  its `raw` is the form's handle), `len()`, `get_page(index)` from 0, and
  `close()`.
- A page's `raw`, `get_textpage()`, `get_objects(filter, max_depth)` and
  `close()`.
- A text page's `raw`, `count_chars()`, `get_charbox(index, loose=True)`
  (left, bottom, right, top) and `close()`.
- An image object's `get_px_size()`, `get_matrix().get()` and
  `get_bitmap(render=False)`, which raises `PdfiumError` for an image PDFium
  does not decode.
- A bitmap's `buffer`, `width`, `height`, `stride`, `n_channels`,
  `rev_byteorder` (false for a bitmap PDFium made: its bytes are then blue
  first), `warn_on_close` and `close()`, which frees the buffer: its bytes
  are copied first.
- Of PDFium itself, in `pypdfium2.raw`: `FPDFText_GetUnicode`,
  `FPDFText_GetCharOrigin`, `FPDFText_GetFontSize`, `FPDFText_GetMatrix`,
  `FPDFPage_GetAnnotCount`, `FPDFPage_GetAnnot`, `FPDFPage_CloseAnnot`,
  `FPDFAnnot_GetSubtype`, `FPDFAnnot_GetRect`, `FPDFAnnot_GetFormFieldName`,
  `FPDFAnnot_GetFormFieldValue`; the structures `FS_MATRIX` and `FS_RECTF`;
  the type `FPDF_WCHAR`; and the numbers `FPDF_ERR_PASSWORD`,
  `FPDF_PAGEOBJ_IMAGE` and `FPDF_ANNOT_WIDGET`.
"""

import asyncio
import ctypes
import importlib
import math
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from functools import cache
from typing import Final, Protocol, final, override

from semiont_smelter.pdf_reader import FormField, Matrix, PdfDocument, PdfEncrypted, PdfReader, PdfUnreadable, Pixels, PlacedImage, Run

__all__ = ["PdfiumReader"]

# The one thread every call into PDFium is made on: see the module's documentation.
_THREAD: Final = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pdfium")

# PDFium's mark for a hyphen that ends a line.
_LINE_END_HYPHEN: Final = "\x02"

# What stands for a code that is no character.
_NO_CHARACTER: Final = chr(0xFFFD)

# How deep a form painted inside a form is looked into for images.
_DEEPEST_FORM: Final = 15


# ── What is asked of the package ──────────────────────────────────────


class _Version(Protocol):
    """A version as the package states it: `PYPDFIUM_INFO`, `PDFIUM_INFO`."""

    version: str


class _Rectangle(Protocol):
    """PDFium's `FS_RECTF`."""

    left: float
    bottom: float
    right: float
    top: float


class _TextMatrix(Protocol):
    """PDFium's `FS_MATRIX`, of which the second row is read."""

    c: float
    d: float


class _TextPage(Protocol):
    """The text of one page, as PDFium laid it out. `raw` is PDFium's handle."""

    raw: object

    def count_chars(self) -> int: ...

    def get_charbox(self, index: int, *, loose: bool) -> tuple[float, float, float, float]: ...

    def close(self) -> object: ...


class _PlacedMatrix(Protocol):
    """The matrix of an object a page paints."""

    def get(self) -> Matrix: ...


class _Bitmap(Protocol):
    """An image's pixels, as PDFium decoded them."""

    buffer: ctypes.Array[ctypes.c_ubyte]
    width: int
    height: int
    stride: int
    n_channels: int
    rev_byteorder: bool
    warn_on_close: bool

    def close(self) -> object: ...


class _Image(Protocol):
    """An image object of a page."""

    def get_px_size(self) -> tuple[int, int]: ...

    def get_matrix(self) -> _PlacedMatrix: ...

    def get_bitmap(self, *, render: bool) -> _Bitmap: ...


class _Page(Protocol):
    """One page, loaded. `raw` is PDFium's handle."""

    raw: object

    def get_textpage(self) -> _TextPage: ...

    def get_objects(self, *, filter: tuple[int, ...], max_depth: int) -> Iterator[_Image]: ...

    def close(self) -> object: ...


class _Form(Protocol):
    """A document's form, started. `raw` is PDFium's handle."""

    raw: object


class _Document(Protocol):
    """A document PDFium opened."""

    formenv: _Form | None

    def init_forms(self) -> object: ...

    def __len__(self) -> int: ...

    def get_page(self, index: int) -> _Page: ...

    def close(self) -> object: ...


class _DocumentClass(Protocol):
    """The package's `PdfDocument`, as a document is opened from its bytes."""

    def __call__(self, content: bytes) -> _Document: ...


type _FieldText = Callable[[object, object, ctypes.Array[ctypes.c_ushort] | None, int], int]
"""A call of PDFium that writes a text of a widget's field.

It takes the form's handle, the widget's, where to write and how many bytes
may be written, and answers how many bytes the text is, in UTF-16 with the
low byte first and two bytes of zero after it.
"""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class _Pdfium:
    """What this module leans on in the package, looked up once. PDFium's own names are spelled as PDFium spells them."""

    stamp: str
    document: _DocumentClass
    failure: type[Exception]
    """The package's `PdfiumError`."""

    FPDF_ERR_PASSWORD: int
    FPDF_PAGEOBJ_IMAGE: int
    FPDF_ANNOT_WIDGET: int
    FPDF_WCHAR: type[ctypes.c_ushort]
    FS_MATRIX: Callable[[], _TextMatrix]
    FS_RECTF: Callable[[], _Rectangle]

    FPDFText_GetUnicode: Callable[[object, int], int]
    FPDFText_GetCharOrigin: Callable[[object, int, object, object], int]
    FPDFText_GetFontSize: Callable[[object, int], float]
    FPDFText_GetMatrix: Callable[[object, int, _TextMatrix], int]

    FPDFPage_GetAnnotCount: Callable[[object], int]
    FPDFPage_GetAnnot: Callable[[object, int], object]
    FPDFPage_CloseAnnot: Callable[[object], object]
    FPDFAnnot_GetSubtype: Callable[[object], int]
    FPDFAnnot_GetRect: Callable[[object, _Rectangle], int]
    FPDFAnnot_GetFormFieldName: _FieldText
    FPDFAnnot_GetFormFieldValue: _FieldText


@cache
def _pdfium() -> _Pdfium:
    """The package, imported and looked up. Called on PDFium's thread alone: importing the package starts PDFium.

    A name the package does not have fails here, as a `KeyError` of that name.
    """
    library = vars(importlib.import_module("pypdfium2"))
    raw = vars(importlib.import_module("pypdfium2.raw"))
    binding: _Version = library["PYPDFIUM_INFO"]
    engine: _Version = library["PDFIUM_INFO"]
    return _Pdfium(
        stamp=f"pdfium-{engine.version}+pypdfium2-{binding.version}",
        document=library["PdfDocument"],
        failure=library["PdfiumError"],
        FPDF_ERR_PASSWORD=raw["FPDF_ERR_PASSWORD"],
        FPDF_PAGEOBJ_IMAGE=raw["FPDF_PAGEOBJ_IMAGE"],
        FPDF_ANNOT_WIDGET=raw["FPDF_ANNOT_WIDGET"],
        FPDF_WCHAR=raw["FPDF_WCHAR"],
        FS_MATRIX=raw["FS_MATRIX"],
        FS_RECTF=raw["FS_RECTF"],
        FPDFText_GetUnicode=raw["FPDFText_GetUnicode"],
        FPDFText_GetCharOrigin=raw["FPDFText_GetCharOrigin"],
        FPDFText_GetFontSize=raw["FPDFText_GetFontSize"],
        FPDFText_GetMatrix=raw["FPDFText_GetMatrix"],
        FPDFPage_GetAnnotCount=raw["FPDFPage_GetAnnotCount"],
        FPDFPage_GetAnnot=raw["FPDFPage_GetAnnot"],
        FPDFPage_CloseAnnot=raw["FPDFPage_CloseAnnot"],
        FPDFAnnot_GetSubtype=raw["FPDFAnnot_GetSubtype"],
        FPDFAnnot_GetRect=raw["FPDFAnnot_GetRect"],
        FPDFAnnot_GetFormFieldName=raw["FPDFAnnot_GetFormFieldName"],
        FPDFAnnot_GetFormFieldValue=raw["FPDFAnnot_GetFormFieldValue"],
    )


async def _on_thread[T](work: Callable[[], T]) -> T:
    """Do one piece of work on PDFium's thread, after every piece asked before it, and wait for it off the loop."""
    return await asyncio.get_running_loop().run_in_executor(_THREAD, work)


def _answered(could: int, what: str) -> None:
    """Hold PDFium to having answered. Raises `PdfUnreadable` where it says that it could not."""
    if not could:
        raise PdfUnreadable(f"PDFium did not answer {what}")


def _reading[T](work: Callable[[], T]) -> T:
    """Do one piece of reading of an opened document. What PDFium fails at there is a part of the document it cannot read."""
    try:
        return work()
    except _pdfium().failure as error:
        raise PdfUnreadable(str(error)) from error


# ── Opening ───────────────────────────────────────────────────────────


def _opened(content: bytes) -> tuple[_Document, int]:
    """A document opened from its bytes, with its form started, and how many pages it has."""
    pdfium = _pdfium()
    try:
        document = pdfium.document(content)
    except pdfium.failure as error:
        if vars(error)["err_code"] == pdfium.FPDF_ERR_PASSWORD:
            raise PdfEncrypted(str(error)) from error
        raise PdfUnreadable(str(error)) from error
    try:
        # The form is started before a page is counted or loaded: a widget's value reads empty otherwise.
        # A document with no form starts none.
        document.init_forms()
        return document, len(document)
    except BaseException:
        document.close()
        raise


# ── Runs ──────────────────────────────────────────────────────────────


def _character(pdfium: _Pdfium, handle: object, index: int, count: int) -> tuple[str, int]:
    """The character at `index` of a text page, and how many of PDFium's characters it is: two for one outside the basic plane."""
    code = pdfium.FPDFText_GetUnicode(handle, index)
    if 0xD800 <= code <= 0xDBFF and index + 1 < count:
        low = pdfium.FPDFText_GetUnicode(handle, index + 1)
        if 0xDC00 <= low <= 0xDFFF:
            return chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)), 2
    if 0xD800 <= code <= 0xDFFF or code > 0x10FFFF:
        return _NO_CHARACTER, 1
    return chr(code), 1


def _run(pdfium: _Pdfium, text: _TextPage, first: int, last: int, word: str, *, ends_line: bool) -> Run:
    """The run of PDFium's characters `first` to `last`, placed by its baseline."""
    handle = text.raw
    x, y = ctypes.c_double(), ctypes.c_double()
    _answered(pdfium.FPDFText_GetCharOrigin(handle, first, ctypes.byref(x), ctypes.byref(y)), "where a character is set down")
    # The loose box of a glyph ends where its advance does, which the box of its ink does not.
    _, _, right, _ = text.get_charbox(last, loose=True)
    # The font's size is in the text's own units, and the text's matrix scales it to the page.
    matrix = pdfium.FS_MATRIX()
    _answered(pdfium.FPDFText_GetMatrix(handle, first, matrix), "a character's text matrix")
    height = pdfium.FPDFText_GetFontSize(handle, first) * math.hypot(matrix.c, matrix.d)
    return Run(text=word, x=x.value, y=y.value, width=abs(right - x.value), height=height, ends_line=ends_line)


def _words(pdfium: _Pdfium, text: _TextPage) -> list[Run]:
    """The words of a text page, in PDFium's order, each ended where PDFium's own text has a space or a line end."""
    handle = text.raw
    count = text.count_chars()
    runs: list[Run] = []
    letters: list[str] = []
    first = last = index = 0
    while index < count:
        character, taken = _character(pdfium, handle, index, count)
        if character == _LINE_END_HYPHEN:
            if not letters:
                first = index
            runs.append(_run(pdfium, text, first, index, "".join([*letters, "-"]), ends_line=True))
            letters = []
        elif character in "\r\n":
            if letters:
                runs.append(_run(pdfium, text, first, last, "".join(letters), ends_line=True))
                letters = []
            elif runs and not runs[-1].ends_line:
                runs[-1] = replace(runs[-1], ends_line=True)
        elif character.isspace() or character == "\x00":
            if letters:
                runs.append(_run(pdfium, text, first, last, "".join(letters), ends_line=False))
                letters = []
        else:
            if not letters:
                first = index
            last = index + taken - 1
            letters.append(character)
        index += taken
    if letters:
        runs.append(_run(pdfium, text, first, last, "".join(letters), ends_line=False))
    return runs


def _runs(document: _Document, index: int) -> list[Run]:
    pdfium = _pdfium()
    page = document.get_page(index)
    try:
        text = page.get_textpage()
        try:
            return _words(pdfium, text)
        finally:
            text.close()
    finally:
        page.close()


# ── The form ──────────────────────────────────────────────────────────


def _field_text(pdfium: _Pdfium, ask: _FieldText, form: object, widget: object) -> str:
    """A text PDFium writes of a widget's field: its name, or its value. Empty where the field has none."""
    size = ask(form, widget, None, 0)
    if size <= 2:
        return ""
    written = (pdfium.FPDF_WCHAR * ((size + 1) // 2))()
    ask(form, widget, written, size)
    return bytes(written)[: size - 2].decode("utf-16-le", errors="replace")


def _fields(document: _Document, pages: int) -> list[FormField]:
    pdfium = _pdfium()
    form = document.formenv
    if form is None:
        return []
    fields: list[FormField] = []
    for index in range(pages):
        page = document.get_page(index)
        try:
            for at in range(pdfium.FPDFPage_GetAnnotCount(page.raw)):
                annotation = pdfium.FPDFPage_GetAnnot(page.raw, at)
                try:
                    if pdfium.FPDFAnnot_GetSubtype(annotation) != pdfium.FPDF_ANNOT_WIDGET:
                        continue
                    rectangle = pdfium.FS_RECTF()
                    _answered(pdfium.FPDFAnnot_GetRect(annotation, rectangle), "a widget's rectangle")
                    fields.append(
                        FormField(
                            name=_field_text(pdfium, pdfium.FPDFAnnot_GetFormFieldName, form.raw, annotation),
                            value=_field_text(pdfium, pdfium.FPDFAnnot_GetFormFieldValue, form.raw, annotation),
                            page=index + 1,
                            x=min(rectangle.left, rectangle.right),
                            y=min(rectangle.bottom, rectangle.top),
                            width=abs(rectangle.right - rectangle.left),
                            height=abs(rectangle.top - rectangle.bottom),
                        )
                    )
                finally:
                    pdfium.FPDFPage_CloseAnnot(annotation)
        finally:
            page.close()
    return fields


# ── Images ────────────────────────────────────────────────────────────


def _images(pdfium: _Pdfium, page: _Page) -> list[_Image]:
    """The images a page paints, in the order it paints them. They are the page's: none outlives it."""
    return [*page.get_objects(filter=(pdfium.FPDF_PAGEOBJ_IMAGE,), max_depth=_DEEPEST_FORM)]


def _placed(document: _Document, index: int) -> list[PlacedImage]:
    pdfium = _pdfium()
    page = document.get_page(index)
    try:
        placed: list[PlacedImage] = []
        for at, image in enumerate(_images(pdfium, page)):
            width, height = image.get_px_size()
            placed.append(PlacedImage(index=at, width=width, height=height, matrix=image.get_matrix().get()))
        return placed
    finally:
        page.close()


def _pixels(bitmap: _Bitmap) -> Pixels:
    """A bitmap of PDFium's as red, green and blue, with no bytes between rows. See the module's documentation."""
    width, height, stride, channels = bitmap.width, bitmap.height, bitmap.stride, bitmap.n_channels
    across = width * channels
    held = bytes(bitmap.buffer)
    samples = held if stride == across else b"".join(held[top : top + across] for top in range(0, stride * height, stride))
    rgb = bytearray(width * height * 3)
    if channels == 1:
        rgb[0::3] = rgb[1::3] = rgb[2::3] = samples
    elif channels in (3, 4):
        red, blue = (0, 2) if bitmap.rev_byteorder else (2, 0)
        rgb[0::3] = samples[red::channels]
        rgb[1::3] = samples[1::channels]
        rgb[2::3] = samples[blue::channels]
    else:
        raise RuntimeError(f"PDFium decoded an image to {channels} bytes for each pixel, which is no layout this reader knows")
    return Pixels(width=width, height=height, rgb=bytes(rgb))


def _decoded_image(pdfium: _Pdfium, image: _Image) -> Pixels | None:
    """One image's pixels. `None` for an image PDFium cannot decode."""
    try:
        bitmap = image.get_bitmap(render=False)
    except pdfium.failure:
        return None
    try:
        return _pixels(bitmap)
    finally:
        # Closing frees the bitmap's buffer, which the package warns of. Its bytes were copied, and nothing reads it again.
        bitmap.warn_on_close = False
        bitmap.close()


def _decoded(document: _Document, index: int, at: int) -> Pixels | None:
    pdfium = _pdfium()
    page = document.get_page(index)
    try:
        return _decoded_image(pdfium, _images(pdfium, page)[at])
    finally:
        page.close()


# ── The reader ────────────────────────────────────────────────────────


@final
class _Opened(PdfDocument):
    """A document PDFium has open. Each call is one piece of work on PDFium's thread."""

    def __init__(self, document: _Document, pages: int) -> None:
        self._document: _Document | None = document
        self._pages: Final = pages

    def _held(self) -> _Document:
        if self._document is None:
            raise RuntimeError("the document is closed")
        return self._document

    def _index(self, page: int) -> int:
        """Where PDFium counts a page, which is from 0."""
        if not 1 <= page <= self._pages:
            raise IndexError(f"the document has no page {page}")
        return page - 1

    @override
    def page_count(self) -> int:
        return self._pages

    @override
    async def runs(self, page: int) -> list[Run]:
        document, index = self._held(), self._index(page)
        return await _on_thread(lambda: _reading(lambda: _runs(document, index)))

    @override
    async def form_fields(self) -> list[FormField]:
        document, pages = self._held(), self._pages
        return await _on_thread(lambda: _reading(lambda: _fields(document, pages)))

    @override
    async def placed_images(self, page: int) -> list[PlacedImage]:
        document, index = self._held(), self._index(page)
        return await _on_thread(lambda: _reading(lambda: _placed(document, index)))

    @override
    async def decode(self, page: int, image: PlacedImage) -> Pixels | None:
        document, index = self._held(), self._index(page)
        return await _on_thread(lambda: _reading(lambda: _decoded(document, index, image.index)))

    @override
    async def close(self) -> None:
        document, self._document = self._document, None
        if document is not None:
            await _on_thread(document.close)


@final
class PdfiumReader(PdfReader):
    """Reads PDFs with PDFium. See the module's documentation.

    Every reader asks the one PDFium of the process, on its one thread: a
    reader holds nothing of its own.
    """

    def __init__(self) -> None:
        """Nothing is loaded until a reader is first asked something."""

    @override
    async def stamp(self) -> str:
        return (await _on_thread(_pdfium)).stamp

    @override
    async def open(self, content: bytes) -> PdfDocument:
        document, pages = await _on_thread(lambda: _reading(lambda: _opened(content)))
        return _Opened(document, pages)
