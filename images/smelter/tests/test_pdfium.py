"""The PDFium reader, with the real PDFium under it, over the fixtures in `specs/src/smelter/fixtures`.

What is held here is what PDFium hands over of a real file, which no
scripted reader can say: the words it finds and where a line ends, where a
word is put, a form's widgets, the images a page paints and their pixels,
and the two ways a document does not open. `scripts/fixtures/make-pdf-fixtures.py`
says what each fixture draws.

No fixture has a colour in it, and a bitmap of PDFium's is blue first. So
one document is made here: a page that paints an image of four pixels, each
of another colour, which says whether a pixel's bytes and an image's rows
are handed over in the right order.
"""

import asyncio
import importlib.metadata
import re
from collections.abc import Awaitable, Callable
from typing import Final

import pytest
from aio import run
from spec import ROOT

from semiont_smelter.pdf_reader import Matrix, PdfDocument, PdfEncrypted, PdfUnreadable, Pixels, PlacedImage, Run
from semiont_smelter.pdfium import PdfiumReader

FIXTURES: Final = ROOT / "specs/src/smelter/fixtures"

DRAWN: Final[dict[str, list[list[str]]]] = {
    "single-line.pdf": [["known", "phrase", "from", "fixture"]],
    "multi-line.pdf": [["first", "line", "of", "text", "second", "line", "of", "text", "third", "line", "of", "text"]],
    "multi-page.pdf": [["content", "on", "page", "one"], ["content", "on", "page", "two"]],
    "form.pdf": [["Policy", "Application"]],
    "mixed.pdf": [["native", "page", "text"], []],
    "scanned.pdf": [[]],
    "scanned-image.pdf": [[]],
    "scanned-jpeg.pdf": [[]],
    "scanned-placed.pdf": [[]],
    "shared-image.pdf": [[], []],
    "legible-scan.pdf": [[]],
}
"""The words drawn on each page of a fixture, in the order they are read. A value of a form's field is not drawn."""

DRAWN_IN_SOME_ORDER: Final[dict[str, str]] = {
    "multi-column.pdf": "left column line one left column line two right column line one right column line two",
    "table.pdf": "Treatment Responders p-value Drug A 12% 0.03 Drug B 9% 0.21 Placebo 4% 0.88",
}
"""The words drawn on the one page of a fixture whose columns no reader is held to an order of, a space between two."""

BARS: Final = (240, 140)
"""How many pixels wide and high the image of bars is."""
WHOLE_PAGE: Final[Matrix] = (612.0, 0.0, 0.0, 792.0, 0.0, 0.0)

PAINTED: Final[dict[str, list[list[tuple[int, int, Matrix]]]]] = {
    "single-line.pdf": [[]],
    "scanned.pdf": [[]],
    "scanned-image.pdf": [[(240, 140, WHOLE_PAGE)]],
    "scanned-placed.pdf": [[(240, 140, (300.0, 0.0, 0.0, 400.0, 100.0, 200.0))]],
    "scanned-jpeg.pdf": [[(8, 8, WHOLE_PAGE)]],
    "mixed.pdf": [[], [(240, 140, WHOLE_PAGE)]],
    "shared-image.pdf": [[(240, 140, WHOLE_PAGE)], [(240, 140, WHOLE_PAGE)]],
    "legible-scan.pdf": [[(1600, 560, (552.0, 0.0, 0.0, 193.0, 30.0, 480.0))]],
}
"""The images each page of a fixture paints: the width and the height of each in pixels, and the matrix that places it."""

WIDGETS: Final[dict[str, tuple[str, float, float, float, float]]] = {
    "policy.holderName": ("Ada Lovelace", 71.5, 699.5, 201.0, 21.0),
    "policy.coverageAmount": ("$250,000", 71.5, 659.5, 201.0, 21.0),
    "policy.state": ("NY", 71.5, 619.5, 101.0, 21.0),
    "policy.notes": ("", 71.5, 579.5, 201.0, 21.0),
}
"""The widgets of `form.pdf` in the order its page has them: each field's value, and its widget's x, y, width and height."""

RED: Final = bytes([255, 0, 0])
GREEN: Final = bytes([0, 255, 0])
BLUE: Final = bytes([0, 0, 255])
WHITE: Final = bytes([255, 255, 255])
FOUR_PIXELS: Final = b"/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8"
"""The dictionary of an image of two pixels by two, each three bytes: red, green and blue."""


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


async def asked[T](content: bytes, ask: Callable[[PdfDocument], Awaitable[T]]) -> T:
    """What `ask` answers of the document `content` is. The document is closed whatever happens."""
    document = await PdfiumReader().open(content)
    try:
        return await ask(document)
    finally:
        await document.close()


async def every_run(document: PdfDocument) -> list[list[Run]]:
    return [await document.runs(page) for page in range(1, document.page_count() + 1)]


async def every_image(document: PdfDocument) -> list[list[PlacedImage]]:
    return [await document.placed_images(page) for page in range(1, document.page_count() + 1)]


async def only_image(document: PdfDocument, page: int) -> Pixels:
    """The one image a page paints, decoded."""
    [image] = await document.placed_images(page)
    pixels = await document.decode(page, image)
    assert pixels is not None, "PDFium did not decode the image"
    return pixels


def words(pages: list[list[Run]]) -> list[list[str]]:
    return [[each.text for each in page] for page in pages]


def pixel(pixels: Pixels, x: int, y: int) -> bytes:
    """The red, green and blue of the pixel `x` from the left and `y` from the top."""
    at = (y * pixels.width + x) * 3
    return pixels.rgb[at : at + 3]


def stream(dictionary: bytes, data: bytes) -> bytes:
    """A stream object of a PDF: its dictionary, which is given without its length, and its bytes."""
    return b"<< " + dictionary + b" /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"


def pdf_of(objects: list[bytes]) -> bytes:
    """A PDF of `objects`, numbered from 1, the first of which is its catalog, with the table of where each begins."""
    body = b"%PDF-1.4\n"
    begins: list[int] = []
    for number, each in enumerate(objects, start=1):
        begins.append(len(body))
        body += b"%d 0 obj\n" % number + each + b"\nendobj\n"
    table = len(body)
    body += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for begin in begins:
        body += b"%010d 00000 n \n" % begin
    return body + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, table)


def four_colours() -> bytes:
    """A page that paints one image of two pixels by two: red and green above, blue and white below."""
    page = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>"
    image = stream(FOUR_PIXELS, RED + GREEN + BLUE + WHITE)
    painting = stream(b"", b"q 20 0 0 10 30 40 cm /Im0 Do Q")
    return pdf_of([b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page, image, painting])


# ── Runs ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", sorted(DRAWN))
def test_the_runs_of_each_page_are_the_words_drawn_on_it_in_the_order_they_are_read(name: str) -> None:
    assert words(run(asked(fixture(name), every_run))) == DRAWN[name]


@pytest.mark.parametrize("name", sorted(DRAWN_IN_SOME_ORDER))
def test_the_runs_of_a_page_of_columns_are_the_words_drawn_on_it(name: str) -> None:
    [page] = words(run(asked(fixture(name), every_run)))
    assert sorted(page) == sorted(DRAWN_IN_SOME_ORDER[name].split())


def test_a_run_ends_a_line_where_the_page_begins_another() -> None:
    [page] = run(asked(fixture("multi-line.pdf"), every_run))
    # Each line is four words. Nothing is said of the last run of the page: no line begins after it.
    assert [at for at, each in enumerate(page[:11]) if each.ends_line] == [3, 7]


def test_a_run_is_placed_by_its_baseline_and_is_as_high_as_its_font() -> None:
    [page] = run(asked(fixture("single-line.pdf"), every_run))
    known, phrase = page[0], page[1]
    # The line is drawn from (72, 720) in Helvetica of 12 points, in which `known` is 34.68 points wide.
    assert (known.x, known.y, known.height) == pytest.approx((72.0, 720.0, 12.0), abs=0.01)
    assert known.width == pytest.approx(34.68, abs=0.5)
    assert [each.y for each in page] == pytest.approx([720.0] * 4, abs=0.01)
    # A word ends before the next begins, and a space is between them.
    assert known.x + known.width < phrase.x
    assert [each.x for each in page] == sorted(each.x for each in page)


# ── The form ──────────────────────────────────────────────────────────


def test_every_widget_of_a_form_is_handed_over_with_its_whole_name_its_value_and_its_rectangle() -> None:
    fields = run(asked(fixture("form.pdf"), lambda document: document.form_fields()))
    assert [field.name for field in fields] == [*WIDGETS]
    for field in fields:
        value, x, y, width, height = WIDGETS[field.name]
        # A field with no value is handed over with an empty one.
        assert (field.value, field.page) == (value, 1)
        assert (field.x, field.y, field.width, field.height) == pytest.approx((x, y, width, height), abs=0.01)


def test_a_document_with_no_form_has_no_fields() -> None:
    assert run(asked(fixture("single-line.pdf"), lambda document: document.form_fields())) == []


# ── Images ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", sorted(PAINTED))
def test_the_images_of_each_page_are_those_it_paints_with_their_size_and_their_matrix(name: str) -> None:
    pages = run(asked(fixture(name), every_image))
    found = [[(image.index, image.width, image.height) for image in page] for page in pages]
    assert found == [[(at, width, height) for at, (width, height, _) in enumerate(page)] for page in PAINTED[name]]
    for page, painted in zip(pages, PAINTED[name], strict=True):
        for image, (_, _, matrix) in zip(page, painted, strict=True):
            assert image.matrix == pytest.approx(matrix, abs=0.001)


def test_a_decoded_image_is_three_bytes_for_each_pixel_with_its_top_row_first() -> None:
    bars = run(asked(fixture("scanned-image.pdf"), lambda document: only_image(document, 1)))
    assert (bars.width, bars.height) == BARS
    assert len(bars.rgb) == 240 * 140 * 3
    # The bars are rows 20 to 33, 60 to 73 and 100 to 113 from the top, from 20 to 219 across: read from the bottom, row 25 is white.
    assert max(pixel(bars, 100, 25)) < 64
    assert min(pixel(bars, 100, 119)) > 192
    assert min(pixel(bars, 0, 0)) > 192


def test_a_jpeg_image_is_decoded_to_pixels() -> None:
    grey = run(asked(fixture("scanned-jpeg.pdf"), lambda document: only_image(document, 1)))
    assert (grey.width, grey.height, len(grey.rgb)) == (8, 8, 8 * 8 * 3)
    red, green, blue = pixel(grey, 0, 0)
    assert red == green == blue


def test_an_image_two_pages_paint_is_decoded_for_each() -> None:
    async def both(document: PdfDocument) -> tuple[Pixels, Pixels]:
        return await only_image(document, 1), await only_image(document, 2)

    first, second = run(asked(fixture("shared-image.pdf"), both))
    assert first == second
    assert len(first.rgb) == 240 * 140 * 3


def test_a_pixel_is_red_then_green_then_blue_and_a_row_has_no_bytes_after_its_pixels() -> None:
    async def painted(document: PdfDocument) -> tuple[list[PlacedImage], Pixels]:
        return await document.placed_images(1), await only_image(document, 1)

    [image], pixels = run(asked(four_colours(), painted))
    assert (image.width, image.height) == (2, 2)
    assert image.matrix == pytest.approx((20.0, 0.0, 0.0, 10.0, 30.0, 40.0), abs=0.001)
    assert pixels == Pixels(width=2, height=2, rgb=RED + GREEN + BLUE + WHITE)


# ── Documents ─────────────────────────────────────────────────────────


def test_a_document_that_asks_for_a_password_is_encrypted() -> None:
    with pytest.raises(PdfEncrypted):
        run(PdfiumReader().open(fixture("encrypted.pdf")))


def test_bytes_that_are_no_pdf_are_unreadable() -> None:
    with pytest.raises(PdfUnreadable):
        run(PdfiumReader().open(b"not a pdf at all"))


def test_a_document_says_how_many_pages_it_has_and_has_no_page_outside_them() -> None:
    async def whole(document: PdfDocument) -> None:
        assert document.page_count() == 2
        for page in (0, 3):
            with pytest.raises(IndexError, match=f"no page {page}"):
                await document.runs(page)
            with pytest.raises(IndexError, match=f"no page {page}"):
                await document.placed_images(page)

    run(asked(fixture("multi-page.pdf"), whole))


def test_nothing_is_asked_of_a_document_that_was_closed_and_closing_it_again_does_nothing() -> None:
    async def whole() -> None:
        document = await PdfiumReader().open(fixture("single-line.pdf"))
        await document.close()
        await document.close()
        with pytest.raises(RuntimeError, match="closed"):
            await document.runs(1)

    run(whole())


def test_calls_made_at_once_from_several_tasks_all_answer() -> None:
    names = [name for name in sorted(DRAWN) for _ in range(3)]

    async def whole() -> list[list[list[str]]]:
        # Each task opens a document of its own, on a reader of its own: PDFium takes them one at a time.
        return [words(pages) for pages in await asyncio.gather(*(asked(fixture(name), every_run) for name in names))]

    assert run(whole()) == [DRAWN[name] for name in names]


def test_calls_made_at_once_of_one_document_all_answer() -> None:
    async def whole(document: PdfDocument) -> tuple[list[Run], list[Run], list[PlacedImage], list[PlacedImage]]:
        return await asyncio.gather(document.runs(1), document.runs(2), document.placed_images(1), document.placed_images(2))

    first, second, unpainted, [image] = run(asked(fixture("mixed.pdf"), whole))
    assert [each.text for each in first] == ["native", "page", "text"]
    assert (second, unpainted) == ([], [])
    assert (image.width, image.height) == BARS


# ── The stamp ─────────────────────────────────────────────────────────


def test_the_stamp_is_pdfium_s_version_and_the_installed_binding_s_with_no_space() -> None:
    stamp = run(PdfiumReader().stamp())
    assert re.fullmatch(r"pdfium-\d\S*\+pypdfium2-\d\S*", stamp), stamp
    assert f"+pypdfium2-{importlib.metadata.version('pypdfium2')}" in stamp
