"""A PDF's text by its class, or the name it is declined by: the Smelter's own rules, on a reader and an engine that read nothing.

A document is stated here as what a reader hands over of it (the words
drawn on each page, one run for each word; its form's widgets; the images
each page paints) and an image as what an engine reads of it. So what is
held is what the Smelter makes of those: a document's class and method, its
text, where each item is and which stretch of the text it selects, the
pages nothing was read from, and what is never asked of a reader or an
engine. What the real reader and the real engine make of a real file is
held by `test_extraction_cases.py`.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final, final, override

import pytest
from aio import run
from semiont.types import ExtractedText, ExtractedTextOcrConfidence, ExtractionDeclined, ExtractionOutcome, PdfTextItem

from semiont_smelter.anchoring import anchor_runs
from semiont_smelter.extraction import LARGEST_PDF_BYTES, PdfExtractor
from semiont_smelter.ocr_engine import Box, OcrEngine, OcrLine, OcrParagraph, OcrRead, OcrWord
from semiont_smelter.pdf_reader import FormField, Matrix, PdfDocument, PdfEncrypted, PdfReader, PdfUnreadable, Pixels, Run
from semiont_smelter.scripted import ScriptedDocument, ScriptedImage, ScriptedOcrEngine, ScriptedPage, ScriptedPdfReader

CONTENT = b"%PDF the bytes of the document a test states"

WHOLE_PAGE: Matrix = (612.0, 0.0, 0.0, 792.0, 0.0, 0.0)
"""The matrix that places an image over the whole of a US Letter page."""

NO_TEXT_LAYER = ExtractionDeclined(kind="declined", declined="no-text-layer")


# ── Stating a document ─────────────────────────────────────────────────


def word(text: str, x: float, y: float, *, ends_line: bool = False) -> Run:
    """A word drawn at a place, 30 points wide and 12 high."""
    return Run(text=text, x=x, y=y, width=30.0, height=12.0, ends_line=ends_line)


def line(text: str, x: float, y: float, *, size: float = 12.0) -> list[Run]:
    """The words of one line drawn from `x`: each half its size wide for each of its characters and a quarter of its size from the last.

    The last word ends the line.
    """
    words = text.split()
    runs: list[Run] = []
    at = x
    for index, each in enumerate(words):
        width = size / 2 * len(each)
        runs.append(Run(text=each, x=at, y=y, width=width, height=size, ends_line=index == len(words) - 1))
        at += width + size / 4
    return runs


def page_of(*lines: str) -> ScriptedPage:
    """A page that draws these lines from its top left, 20 points apart."""
    return ScriptedPage(runs=[each for down, stated in enumerate(lines) for each in line(stated, 72.0, 720.0 - 20.0 * down)])


def grid(rows: Sequence[Sequence[str]], columns: Sequence[float]) -> list[Run]:
    """A grid drawn row by row, 24 points apart, each row's cells at the columns' places."""
    runs: list[Run] = []
    for down, row in enumerate(rows):
        for stated, x in zip(row, columns, strict=True):
            runs.extend(line(stated, x, 720.0 - 24.0 * down))
    return runs


def field(name: str, value: str, *, y: float = 600.0) -> FormField:
    """A widget of a form on the first page, 80 points by 14 from 100 across."""
    return FormField(name=name, value=value, page=1, x=100.0, y=y, width=80.0, height=14.0)


def pixels(mark: int) -> Pixels:
    """The pixels of an image 100 by 100, every byte of them `mark`: images of two marks are two images to an engine."""
    return Pixels(width=100, height=100, rgb=bytes([mark]) * 30_000)


def scan(mark: int, matrix: Matrix = WHOLE_PAGE) -> ScriptedImage:
    """An image 100 by 100 that a page paints, which decodes to `pixels(mark)`."""
    return ScriptedImage(width=100, height=100, matrix=matrix, pixels=pixels(mark))


def stating(width: int, height: int, *, mark: int = 1) -> ScriptedImage:
    """An image its page states as `width` by `height`, which decodes to `pixels(mark)` whatever is stated."""
    return ScriptedImage(width=width, height=height, matrix=WHOLE_PAGE, pixels=pixels(mark))


def scanned(*images: ScriptedImage) -> ScriptedDocument:
    """A document of one page, which draws no text and paints these images."""
    return ScriptedDocument(pages=[ScriptedPage(images=images)])


# ── Stating what an engine reads ───────────────────────────────────────


def read_of(*lines: str) -> OcrRead:
    """What an engine reads of an image: one paragraph of these lines, 25 pixels apart, the engine 90 sure of each word."""
    made: list[OcrLine] = []
    for down, stated in enumerate(lines):
        top = 25.0 * down
        words = tuple(
            OcrWord(text=each, confidence=90.0, box=Box(x0=10.0 * at, y0=top + 5, x1=10.0 * at + 8, y1=top + 20))
            for at, each in enumerate(stated.split())
        )
        made.append(OcrLine(box=Box(x0=0.0, y0=top, x1=100.0, y1=top + 25), words=words))
    return OcrRead(paragraphs=(OcrParagraph(lines=tuple(made)),))


def one_word(text: str, box: Box) -> OcrRead:
    """What an engine reads of an image with one word in it, alone on its line."""
    return OcrRead(paragraphs=(OcrParagraph(lines=(OcrLine(box=box, words=(OcrWord(text=text, confidence=90.0, box=box),)),)),))


def sure(*confidences: float) -> OcrRead:
    """What an engine reads of an image: one line with a word for each of `confidences`, the engine that sure of it."""
    box = Box(x0=0.0, y0=0.0, x1=100.0, y1=10.0)
    words = tuple(OcrWord(text=f"w{at}", confidence=each, box=box) for at, each in enumerate(confidences))
    return OcrRead(paragraphs=(OcrParagraph(lines=(OcrLine(box=box, words=words),)),))


# ── Deriving, and reading what came of it ──────────────────────────────


@final
@dataclass(frozen=True, slots=True)
class Derived:
    """What came of deriving one document, with the reader and the engine it was derived with."""

    outcome: ExtractionOutcome
    reader: ScriptedPdfReader
    engine: ScriptedOcrEngine


def derive(document: ScriptedDocument | PdfEncrypted | PdfUnreadable, reads: Mapping[bytes, OcrRead] | None = None) -> Derived:
    """Derive the document a reader was told `CONTENT` is, with an engine that reads `reads` of the images that have those pixels."""
    reader = ScriptedPdfReader({CONTENT: document})
    engine = ScriptedOcrEngine(reads)
    return Derived(run(PdfExtractor(reader=reader, engine=engine).extract(CONTENT)), reader, engine)


def extracted(document: ScriptedDocument, reads: Mapping[bytes, OcrRead] | None = None) -> ExtractedText:
    """What is derived of a document that is not declined."""
    outcome = derive(document, reads).outcome
    assert isinstance(outcome, ExtractedText), f"declined: {outcome}"
    return outcome


def quoted(out: ExtractedText) -> list[str]:
    """The stretch of the text each item's offsets select."""
    return [out.text[item.start : item.end] for item in out.items]


def spans(out: ExtractedText) -> list[tuple[int, int]]:
    """Each item's offsets."""
    return [(item.start, item.end) for item in out.items]


def pages(out: ExtractedText) -> list[int]:
    """The page each item is on."""
    return [int(item.page) for item in out.items]


# ── Class A: text of its own ───────────────────────────────────────────


def test_a_document_whose_pages_have_text_is_read_as_that_text_with_an_item_for_each_word() -> None:
    runs = line("known phrase from fixture", 72.0, 720.0)
    out = extracted(ScriptedDocument(pages=[ScriptedPage(runs=runs)]))
    assert out == ExtractedText(
        kind="extracted",
        text="known phrase from fixture\n\n",
        items=anchor_runs(runs, 1).items,
        method="pdf-text-layer",
        pdf_class="A",
    )
    assert quoted(out) == ["known", "phrase", "from", "fixture"]


def test_a_documents_text_is_its_pages_in_order_each_ended_by_a_line_feed_and_no_page_is_named_unread() -> None:
    out = extracted(ScriptedDocument(pages=[page_of("content on page one"), page_of("content on page two")]))
    assert out.text == "content on page one\n\ncontent on page two\n\n"
    assert out.pdf_class == "A"
    assert out.unread_pages is None
    assert pages(out) == [1, 1, 1, 1, 2, 2, 2, 2]
    assert quoted(out) == ["content", "on", "page", "one", "content", "on", "page", "two"]
    # The second page's words are 21 code points on: the first page's 20, and the line feed that ends the page.
    assert spans(out)[4:] == [(21, 28), (29, 31), (32, 36), (37, 40)]


def test_a_document_whose_pages_all_have_text_has_none_of_its_images_decoded_and_the_engine_is_not_asked() -> None:
    pictured = ScriptedPage(runs=line("a page with a picture", 72.0, 720.0), images=[scan(1)])
    derived = derive(ScriptedDocument(pages=[pictured]), {pixels(1).rgb: read_of("NEVER READ")})
    assert derived.reader.decoded == []
    assert derived.engine.asked == []


def test_lines_of_prose_stay_prose() -> None:
    out = extracted(ScriptedDocument(pages=[page_of("first line of text", "second line of text", "third line of text")]))
    assert out.pdf_class == "A"
    assert out.text == "first line of text\nsecond line of text\nthird line of text\n\n"


def test_two_columns_of_prose_two_lines_long_stay_prose() -> None:
    columns = [
        *line("left column line one", 72.0, 720.0),
        *line("left column line two", 72.0, 700.0),
        *line("right column line one", 320.0, 720.0),
        *line("right column line two", 320.0, 700.0),
    ]
    out = extracted(ScriptedDocument(pages=[ScriptedPage(runs=columns)]))
    assert out.pdf_class == "A"
    assert "|" not in out.text
    assert "oneleft" not in out.text


# ── Class B: no text of its own ────────────────────────────────────────


def test_a_document_with_no_text_and_no_image_is_declined_and_the_engine_is_not_asked() -> None:
    derived = derive(scanned())
    assert derived.outcome == NO_TEXT_LAYER
    assert derived.engine.asked == []


def test_a_document_of_no_pages_is_declined_the_same_way() -> None:
    assert derive(ScriptedDocument(pages=[])).outcome == NO_TEXT_LAYER


def test_a_scan_the_engine_reads_nothing_from_is_declined_and_the_engine_was_handed_its_image() -> None:
    # The name says that reading was tried and came to nothing: so the image reached the engine.
    derived = derive(scanned(scan(1)))
    assert derived.outcome == NO_TEXT_LAYER
    assert derived.reader.decoded == [(1, 0)]
    assert derived.engine.asked == [(pixels(1),)]


def test_a_scan_is_read_by_the_engine_and_every_word_is_an_item_that_selects_it() -> None:
    out = extracted(scanned(scan(1)), {pixels(1).rgb: read_of("RECOVERED FROM", "THE SCAN")})
    assert out.text == "RECOVERED FROM\nTHE SCAN"
    assert out.pdf_class == "B"
    assert out.method == "ocr"
    assert out.unread_pages is None
    assert quoted(out) == ["RECOVERED", "FROM", "THE", "SCAN"]
    assert pages(out) == [1, 1, 1, 1]
    assert out.ocr_confidence == ExtractedTextOcrConfidence(mean=90.0, low_confidence_words=0, total_words=4)


def test_a_word_read_from_pixels_is_placed_on_its_page_by_the_matrix_that_placed_its_image() -> None:
    # The image is drawn 300 by 400 points from (100, 200). The word is the middle half of its width, from a quarter
    # to a half of the way down it.
    image = scan(1, (300.0, 0.0, 0.0, 400.0, 100.0, 200.0))
    out = extracted(scanned(image), {pixels(1).rgb: one_word("SCANNED", Box(x0=25.0, y0=25.0, x1=75.0, y1=50.0))})
    assert out.items == [PdfTextItem(start=0, end=7, page=1, x=175.0, y=400.0, width=150.0, height=100.0)]


def test_a_word_is_placed_by_the_size_its_image_decodes_to_and_not_by_the_size_its_page_states() -> None:
    # Stated 400 by 200, decoded 100 by 100: the word is the top left quarter of what was decoded.
    out = extracted(scanned(stating(400, 200)), {pixels(1).rgb: one_word("HALF", Box(x0=0.0, y0=0.0, x1=50.0, y1=50.0))})
    assert out.items == [PdfTextItem(start=0, end=4, page=1, x=0.0, y=396.0, width=306.0, height=396.0)]


def test_the_texts_of_one_pages_images_are_a_line_feed_apart_and_two_pages_an_empty_line_apart() -> None:
    document = ScriptedDocument(pages=[ScriptedPage(images=[scan(1), scan(2), scan(3)]), ScriptedPage(images=[scan(4)])])
    reads = {pixels(1).rgb: read_of("one"), pixels(3).rgb: read_of("three"), pixels(4).rgb: read_of("four")}
    derived = derive(document, reads)
    out = derived.outcome
    assert isinstance(out, ExtractedText)
    # The second image has nothing legible in it, and leaves no line of its own.
    assert out.text == "one\nthree\n\nfour"
    assert quoted(out) == ["one", "three", "four"]
    assert pages(out) == [1, 1, 2]
    # The engine is asked once for each page, with that page's images, in the order of the pages.
    assert derived.engine.asked == [(pixels(1), pixels(2), pixels(3)), (pixels(4),)]


def test_how_sure_the_engine_was_is_summed_up_over_every_word_it_read() -> None:
    out = extracted(scanned(scan(1)), {pixels(1).rgb: sure(30.0, 59.0, 60.0, 95.0)})
    # Two words are under 60, and one at 60 is not.
    assert out.ocr_confidence == ExtractedTextOcrConfidence(mean=61.0, low_confidence_words=2, total_words=4)


def test_the_mean_is_stated_to_a_tenth_and_a_half_of_a_tenth_goes_up() -> None:
    out = extracted(scanned(scan(1)), {pixels(1).rgb: sure(90.0, 90.0, 90.0, 91.0)})
    assert out.ocr_confidence is not None
    # 90.25, which rounding to the nearest even tenth would make 90.2.
    assert out.ocr_confidence.mean == 90.3


# ── The pixel budget ───────────────────────────────────────────────────


def test_an_image_of_48_million_pixels_is_decoded_and_read() -> None:
    derived = derive(scanned(stating(8000, 6000)), {pixels(1).rgb: read_of("READ")})
    assert derived.reader.decoded == [(1, 0)]
    assert isinstance(derived.outcome, ExtractedText)


def test_an_image_of_one_row_more_is_never_decoded_and_nothing_is_read_from_its_page() -> None:
    derived = derive(scanned(stating(8000, 6001)), {pixels(1).rgb: read_of("NEVER READ")})
    assert derived.reader.decoded == []
    assert derived.engine.asked == []
    assert derived.outcome == NO_TEXT_LAYER


@pytest.mark.parametrize(("width", "height"), [(0, 100), (100, 0), (-1, 100)])
def test_an_image_stated_with_no_width_or_no_height_is_never_decoded(width: int, height: int) -> None:
    derived = derive(scanned(stating(width, height)), {pixels(1).rgb: read_of("NEVER READ")})
    assert derived.reader.decoded == []
    assert derived.outcome == NO_TEXT_LAYER


def test_an_image_over_the_budget_is_passed_over_and_the_image_after_it_is_read() -> None:
    # A page of US Letter scanned at 300 dots to the inch, after an image that states 400 million pixels.
    derived = derive(scanned(stating(20_000, 20_000, mark=2), stating(2550, 3300)), {pixels(1).rgb: read_of("READ")})
    assert derived.reader.decoded == [(1, 1)]
    assert derived.engine.asked == [(pixels(1),)]
    assert isinstance(derived.outcome, ExtractedText)


def test_an_image_its_reader_does_not_decode_is_passed_over_and_the_engine_is_not_asked() -> None:
    derived = derive(scanned(ScriptedImage(width=100, height=100, matrix=WHOLE_PAGE, pixels=None)))
    assert derived.reader.decoded == [(1, 0)]
    assert derived.engine.asked == []
    assert derived.outcome == NO_TEXT_LAYER


# ── Class C: some pages with text and some without ─────────────────────

MIXED = ScriptedDocument(pages=[page_of("native page text"), ScriptedPage(images=[scan(1)])])


def test_a_page_nothing_was_read_from_is_named_and_the_method_stays_that_of_the_pages_with_text() -> None:
    derived = derive(MIXED)
    out = derived.outcome
    assert isinstance(out, ExtractedText)
    assert out.text == "native page text\n\n\n"
    assert out.pdf_class == "C"
    assert out.method == "pdf-text-layer"
    assert out.unread_pages == [2]
    assert out.ocr_confidence is None
    assert quoted(out) == ["native", "page", "text"]
    assert derived.engine.asked == [(pixels(1),)]


def test_what_the_engine_reads_of_a_page_with_no_text_follows_the_documents_own_text() -> None:
    out = extracted(MIXED, {pixels(1).rgb: read_of("TEXT FROM THE", "SCANNED PAGE")})
    assert out.text == "native page text\n\n\nTEXT FROM THE\nSCANNED PAGE\n"
    assert out.pdf_class == "C"
    assert out.method == "ocr"
    assert out.unread_pages is None
    assert pages(out) == [1, 1, 1, 2, 2, 2, 2, 2]
    # The words of the page with text select what they did, and the engine's are past all 19 code points of that text.
    assert quoted(out) == ["native", "page", "text", "TEXT", "FROM", "THE", "SCANNED", "PAGE"]
    assert spans(out)[3:] == [(19, 23), (24, 28), (29, 32), (33, 40), (41, 45)]
    assert out.ocr_confidence == ExtractedTextOcrConfidence(mean=90.0, low_confidence_words=0, total_words=5)


def test_only_the_images_of_pages_with_no_text_are_decoded() -> None:
    pictured = ScriptedPage(runs=line("a page with a picture", 72.0, 720.0), images=[scan(1)])
    derived = derive(ScriptedDocument(pages=[pictured, ScriptedPage(images=[scan(2)])]))
    assert derived.reader.decoded == [(2, 0)]
    assert derived.engine.asked == [(pixels(2),)]


def test_of_the_pages_with_no_text_those_nothing_was_read_from_are_named() -> None:
    document = ScriptedDocument(pages=[page_of("native"), ScriptedPage(images=[scan(1)]), ScriptedPage(images=[scan(2)]), ScriptedPage()])
    out = extracted(document, {pixels(1).rgb: read_of("READ")})
    assert out.text == "native\n\n\n\n\nREAD\n"
    assert out.pdf_class == "C"
    assert out.method == "ocr"
    assert out.unread_pages == [3, 4]


def test_recovered_words_follow_the_documents_text_in_code_points_image_after_image_and_page_after_page() -> None:
    document = ScriptedDocument(
        pages=[page_of("\U0001d538 native"), ScriptedPage(images=[scan(1), scan(2)]), ScriptedPage(images=[scan(3)])],
    )
    reads = {
        pixels(1).rgb: read_of("\U0001f600 scan"),
        pixels(2).rgb: read_of("more"),
        pixels(3).rgb: read_of("\U0001d49c last"),
    }
    out = extracted(document, reads)
    assert out.text == "\U0001d538 native\n\n\n\n\U0001f600 scan\nmore\n\n\U0001d49c last\n"
    assert pages(out) == [1, 1, 2, 2, 2, 3, 3]
    assert spans(out) == [(0, 1), (2, 8), (12, 13), (14, 18), (19, 23), (25, 26), (27, 31)]
    assert quoted(out) == ["\U0001d538", "native", "\U0001f600", "scan", "more", "\U0001d49c", "last"]


# ── Class D: a grid ────────────────────────────────────────────────────

OUTCOMES = [
    ["Treatment", "Responders", "p-value"],
    ["Drug A", "12%", "0.03"],
    ["Drug B", "9%", "0.21"],
    ["Placebo", "4%", "0.88"],
]
GRID = ScriptedDocument(pages=[ScriptedPage(runs=grid(OUTCOMES, [72.0, 250.0, 420.0]))])
ROWS = (
    "| Treatment | Responders | p-value |\n"
    "| --- | --- | --- |\n"
    "| Drug A | 12% | 0.03 |\n"
    "| Drug B | 9% | 0.21 |\n"
    "| Placebo | 4% | 0.88 |\n"
)


def test_a_page_that_is_a_grid_is_written_as_rows_and_each_cell_is_an_item() -> None:
    out = extracted(GRID)
    assert out.text == ROWS
    assert out.pdf_class == "D"
    assert out.method == "table"
    assert quoted(out) == [cell for row in OUTCOMES for cell in row]


def test_a_cell_of_two_words_is_one_item_at_the_rectangle_around_both() -> None:
    # "Drug" is 24 points from 72 and "A" is 6 points from 99, on the second row, 24 points under the first.
    assert extracted(GRID).items[3] == PdfTextItem(start=59, end=65, page=1, x=72.0, y=696.0, width=33.0, height=12.0)


def test_a_grid_between_two_pages_of_prose_is_written_as_rows_and_the_pages_around_it_as_they_are() -> None:
    table = [
        word("Arm", 72.0, 700.0),
        word("Dose", 200.0, 700.0, ends_line=True),
        word("\U0001d538x", 72.0, 680.0),
        word("5mg", 200.0, 680.0, ends_line=True),
        word("B", 72.0, 660.0),
        word("7mg", 200.0, 660.0, ends_line=True),
    ]
    document = ScriptedDocument(
        pages=[
            ScriptedPage(runs=[word("\U0001f600", 72.0, 700.0), word("intro", 110.0, 700.0)]),
            ScriptedPage(runs=table),
            ScriptedPage(runs=[word("after", 72.0, 700.0)]),
        ],
    )
    out = extracted(document)
    assert out.pdf_class == "D"
    assert out.method == "table"
    assert out.text == "\U0001f600 intro \n| Arm | Dose |\n| --- | --- |\n| \U0001d538x | 5mg |\n| B | 7mg |\nafter \n"
    assert pages(out) == [1, 1, 2, 2, 2, 2, 2, 2, 3]
    assert spans(out) == [(0, 1), (2, 7), (11, 14), (17, 21), (40, 42), (45, 48), (53, 54), (57, 60), (63, 68)]
    assert quoted(out) == ["\U0001f600", "intro", "Arm", "Dose", "\U0001d538x", "5mg", "B", "7mg", "after"]


# ── Class E: a filled form ─────────────────────────────────────────────

FORM = ScriptedDocument(
    pages=[ScriptedPage(runs=line("Policy Application", 72.0, 740.0, size=14.0))],
    fields=[
        FormField(name="policy.holderName", value="Ada Lovelace", page=1, x=72.0, y=700.0, width=200.0, height=20.0),
        FormField(name="policy.coverageAmount", value="$250,000", page=1, x=72.0, y=660.0, width=200.0, height=20.0),
        FormField(name="policy.state", value="NY", page=1, x=72.0, y=620.0, width=100.0, height=20.0),
        FormField(name="policy.notes", value="", page=1, x=72.0, y=580.0, width=200.0, height=20.0),
    ],
)


def test_a_filled_forms_values_are_lines_of_the_text_after_the_words_drawn_on_its_pages() -> None:
    out = extracted(FORM)
    assert out.text == "Policy Application\n\npolicy.holderName: Ada Lovelace\npolicy.coverageAmount: $250,000\npolicy.state: NY\n"
    assert out.pdf_class == "E"
    assert out.method == "form"
    assert quoted(out) == ["Policy", "Application", "Ada Lovelace", "$250,000", "NY"]


def test_a_field_with_no_value_adds_nothing_and_its_name_is_not_in_the_text() -> None:
    assert "policy.notes" not in extracted(FORM).text


def test_a_value_is_one_item_at_its_fields_widget() -> None:
    assert extracted(FORM).items[2] == PdfTextItem(start=39, end=51, page=1, x=72.0, y=700.0, width=200.0, height=20.0)


def test_a_value_is_written_without_the_white_space_at_its_ends_and_one_of_white_space_alone_does_not_count() -> None:
    out = extracted(ScriptedDocument(pages=[page_of("Form")], fields=[field("city", "  Paris \n"), field("blank", " \t ")]))
    assert out.text == "Form\n\ncity: Paris\n"
    assert quoted(out) == ["Form", "Paris"]


def test_of_the_widgets_of_one_name_the_first_that_has_a_value_is_the_field() -> None:
    widgets = [field("choice", "", y=640.0), field("choice", "yes", y=600.0), field("choice", "no", y=560.0)]
    out = extracted(ScriptedDocument(pages=[page_of("Form")], fields=widgets))
    assert out.text == "Form\n\nchoice: yes\n"
    assert out.items[-1] == PdfTextItem(start=14, end=17, page=1, x=100.0, y=600.0, width=80.0, height=14.0)


def test_a_forms_values_are_anchored_in_code_points() -> None:
    drawn = ScriptedPage(runs=[word("\U0001f600", 72.0, 700.0), word("Form", 110.0, 700.0)])
    out = extracted(ScriptedDocument(pages=[drawn], fields=[field("n\U0001d538me", "\U0001d49cda"), field("city", "Paris", y=580.0)]))
    assert out.text == "\U0001f600 Form \nn\U0001d538me: \U0001d49cda\ncity: Paris\n"
    assert spans(out) == [(0, 1), (2, 6), (14, 17), (24, 29)]
    assert quoted(out) == ["\U0001f600", "Form", "\U0001d49cda", "Paris"]


def test_a_filled_form_with_a_grid_on_its_page_is_a_form() -> None:
    out = extracted(ScriptedDocument(pages=GRID.pages, fields=[field("city", "Paris")]))
    assert out.pdf_class == "E"
    assert out.method == "form"
    assert "|" not in out.text


def test_a_form_with_a_page_nothing_was_read_from_stays_a_form_and_names_the_page() -> None:
    out = extracted(ScriptedDocument(pages=[page_of("Form"), ScriptedPage()], fields=[field("city", "Paris")]))
    assert out.text == "Form\n\n\ncity: Paris\n"
    assert out.pdf_class == "E"
    assert out.method == "form"
    assert out.unread_pages == [2]


def test_a_form_whose_pages_draw_no_text_is_a_scan_and_its_values_are_no_text_of_its_own() -> None:
    assert derive(ScriptedDocument(pages=[ScriptedPage()], fields=[field("city", "Paris")])).outcome == NO_TEXT_LAYER


# ── Declined before anything is read ───────────────────────────────────


@final
class Unopening(PdfReader):
    """A reader that opens nothing, and keeps how long each document it was handed is. It reads no byte of one."""

    def __init__(self) -> None:
        self.lengths: Final[list[int]] = []

    @override
    async def stamp(self) -> str:
        return "unopening-1"

    @override
    async def open(self, content: bytes) -> PdfDocument:
        self.lengths.append(len(content))
        raise PdfUnreadable("this reader opens nothing")


def test_a_document_at_the_bound_is_handed_to_the_reader_and_one_a_byte_over_is_declined_before_it_is() -> None:
    # Neither document's bytes are read: the reader here takes a document's length and nothing else.
    reader = Unopening()
    extractor = PdfExtractor(reader=reader, engine=ScriptedOcrEngine())
    assert run(extractor.extract(bytes(LARGEST_PDF_BYTES))) == ExtractionDeclined(kind="declined", declined="corrupt")
    assert reader.lengths == [LARGEST_PDF_BYTES]
    assert run(extractor.extract(bytes(LARGEST_PDF_BYTES + 1))) == ExtractionDeclined(kind="declined", declined="too-large")
    assert reader.lengths == [LARGEST_PDF_BYTES]


def test_a_document_that_asks_for_a_password_is_declined_as_encrypted() -> None:
    derived = derive(PdfEncrypted("the document asks for a password"))
    assert derived.outcome == ExtractionDeclined(kind="declined", declined="encrypted")
    assert derived.reader.opened == [CONTENT]
    assert derived.reader.closed == []


def test_bytes_that_do_not_open_are_declined_as_corrupt() -> None:
    derived = derive(PdfUnreadable("the bytes are no PDF"))
    assert derived.outcome == ExtractionDeclined(kind="declined", declined="corrupt")
    assert derived.reader.closed == []


def test_a_document_that_opens_and_has_a_page_its_reader_cannot_read_is_declined_as_corrupt_and_let_go_of() -> None:
    for broken in (
        ScriptedDocument(pages=[page_of("a line of text"), ScriptedPage(unreadable=True)]),
        ScriptedDocument(pages=[ScriptedPage(unreadable=True)]),
    ):
        derived = derive(broken)
        assert derived.outcome == ExtractionDeclined(kind="declined", declined="corrupt")
        assert derived.reader.closed == [broken]


# ── Letting go of a document ───────────────────────────────────────────


@final
class Failing(OcrEngine):
    """An engine that fails whatever it is handed."""

    @override
    async def stamp(self) -> str:
        return "failing-1"

    @override
    async def read(self, images: Sequence[Pixels]) -> list[OcrRead]:
        raise RuntimeError("the engine failed")


@final
class Silent(OcrEngine):
    """An engine that answers for no image, however many it is handed."""

    @override
    async def stamp(self) -> str:
        return "silent-1"

    @override
    async def read(self, images: Sequence[Pixels]) -> list[OcrRead]:
        return []


def test_a_document_is_let_go_of_once_it_is_read_and_once_it_is_declined() -> None:
    assert derive(MIXED).reader.closed == [MIXED]
    assert derive(scanned()).reader.closed == [scanned()]


def test_a_failure_of_the_engine_is_raised_as_it_is_and_the_document_is_let_go_of() -> None:
    reader = ScriptedPdfReader({CONTENT: scanned(scan(1))})
    extractor = PdfExtractor(reader=reader, engine=Failing())
    with pytest.raises(RuntimeError, match="the engine failed"):
        run(extractor.extract(CONTENT))
    assert reader.closed == [scanned(scan(1))]


def test_an_engine_that_answers_for_fewer_images_than_it_was_handed_fails_and_the_document_is_let_go_of() -> None:
    reader = ScriptedPdfReader({CONTENT: scanned(scan(1))})
    extractor = PdfExtractor(reader=reader, engine=Silent())
    with pytest.raises(ValueError, match="shorter"):
        run(extractor.extract(CONTENT))
    assert reader.closed == [scanned(scan(1))]
