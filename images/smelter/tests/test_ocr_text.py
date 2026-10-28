"""The text of an image an engine read, and where each word of it is on the page.

An engine's builds read the same pixels differently, so nothing here is read
from pixels: what an engine hands over is stated, and what is held is what
is made of it. A word's offsets are the part that must not slip: a span is
anchored by them, and one that is a character out selects other text.
"""

from collections.abc import Sequence

from semiont.types import PdfTextItem

from semiont_smelter.ocr_engine import Box, OcrLine, OcrParagraph, OcrRead, OcrWord
from semiont_smelter.ocr_text import ImageText, ReadWord, assemble, place
from semiont_smelter.pdf_reader import Matrix

WHOLE_PAGE: Matrix = (612.0, 0.0, 0.0, 792.0, 0.0, 0.0)
"""The matrix that places an image over the whole of a US Letter page."""


def read_word(text: str, x0: float) -> OcrWord:
    """A word an engine read, 8 pixels wide for each of its characters."""
    return OcrWord(text=text, confidence=90.0, box=Box(x0=x0, y0=10.0, x1=x0 + len(text) * 8, y1=26.0))


def read_line(words: Sequence[str]) -> OcrLine:
    """A line an engine read: its words 60 pixels apart, from 20."""
    placed = tuple(read_word(each, 20.0 + at * 60) for at, each in enumerate(words))
    return OcrLine(box=Box(x0=20.0, y0=10.0, x1=400.0, y1=26.0), words=placed)


def read_of(paragraphs: Sequence[Sequence[Sequence[str]]]) -> OcrRead:
    """What an engine read: paragraphs of lines of words."""
    return OcrRead(paragraphs=tuple(OcrParagraph(lines=tuple(read_line(words) for words in lines)) for lines in paragraphs))


def quoted(found: ImageText) -> list[str]:
    """The stretch of the text each word's offsets select."""
    return [found.text[word.start : word.end] for word in found.words]


def boxed(x0: float, y0: float, x1: float, y1: float, *, start: int = 0, end: int = 1) -> ReadWord:
    """A word of an image's text, with the box it has in the image."""
    return ReadWord(text="x" * (end - start), start=start, end=end, box=Box(x0=x0, y0=y0, x1=x1, y1=y1), confidence=90.0)


# ── The text of an image ───────────────────────────────────────────────


def test_words_are_a_space_apart_and_lines_a_line_feed_apart() -> None:
    assert assemble(read_of([[["the", "quick"], ["brown", "fox"]]])).text == "the quick\nbrown fox"


def test_an_empty_line_is_between_two_paragraphs() -> None:
    assert assemble(read_of([[["first"]], [["second"]]])).text == "first\n\nsecond"


def test_every_words_offsets_select_that_word() -> None:
    found = assemble(read_of([[["the", "quick"], ["brown", "fox"]], [["jumps"]]]))
    assert [word.text for word in found.words] == ["the", "quick", "brown", "fox", "jumps"]
    assert quoted(found) == ["the", "quick", "brown", "fox", "jumps"]


def test_a_words_offsets_count_code_points() -> None:
    found = assemble(read_of([[["\U0001d538", "bc"], ["\U0001f600x", "d"]]]))
    assert found.text == "\U0001d538 bc\n\U0001f600x d"
    assert [(word.start, word.end) for word in found.words] == [(0, 1), (2, 4), (5, 7), (8, 9)]
    assert quoted(found) == ["\U0001d538", "bc", "\U0001f600x", "d"]


def test_a_word_keeps_how_sure_the_engine_was_of_it_and_its_extent_across() -> None:
    found = assemble(read_of([[["alpha"]]]))
    assert found.words == (ReadWord(text="alpha", start=0, end=5, box=Box(x0=20.0, y0=10.0, x1=60.0, y1=26.0), confidence=90.0),)


def test_a_word_of_white_space_alone_is_no_word_and_moves_no_offset() -> None:
    found = assemble(read_of([[["real", "   ", "words"]]]))
    assert found.text == "real words"
    assert quoted(found) == ["real", "words"]


def test_white_space_at_a_words_ends_is_not_of_the_word() -> None:
    found = assemble(read_of([[[" padded ", "next"]]]))
    assert found.text == "padded next"
    assert quoted(found) == ["padded", "next"]


def test_a_paragraph_with_no_word_in_it_leaves_its_empty_line_and_the_words_after_it_are_still_selected() -> None:
    found = assemble(read_of([[["first"]], [[" "]], [["second"]]]))
    assert found.text == "first\n\n\nsecond"
    assert quoted(found) == ["first", "second"]


def test_an_image_nothing_was_read_from_has_no_text_and_no_word() -> None:
    assert assemble(OcrRead()) == ImageText(text="", words=())
    assert assemble(read_of([[[" "]]])) == ImageText(text="", words=())


def test_the_words_of_a_line_have_the_lines_top_and_bottom_and_their_own_left_and_right() -> None:
    # A box hugs its glyphs: "page" reaches lower than "the". Each takes the line's extent up and down, so that
    # the two are known for one line by where they are.
    line = OcrLine(
        box=Box(x0=20.0, y0=10.0, x1=300.0, y1=30.0),
        words=(
            OcrWord(text="the", confidence=90.0, box=Box(x0=20.0, y0=12.0, x1=60.0, y1=24.0)),
            OcrWord(text="page", confidence=90.0, box=Box(x0=70.0, y0=12.0, x1=130.0, y1=30.0)),
        ),
    )
    found = assemble(OcrRead(paragraphs=(OcrParagraph(lines=(line,)),)))
    assert [(word.box.y0, word.box.y1) for word in found.words] == [(10.0, 30.0), (10.0, 30.0)]
    assert [(word.box.x0, word.box.x1) for word in found.words] == [(20.0, 60.0), (70.0, 130.0)]


# ── Where a word is on its page ────────────────────────────────────────


def test_a_word_at_the_top_of_an_image_is_high_on_the_page() -> None:
    # A pixel's y runs down from the top, and a page's runs up from the bottom.
    items = place([boxed(0.0, 0.0, 50.0, 50.0)], width=100, height=100, matrix=WHOLE_PAGE, page=1, offset=0)
    assert items == [PdfTextItem(start=0, end=1, page=1, x=0.0, y=396.0, width=306.0, height=396.0)]


def test_a_word_at_the_bottom_right_of_an_image_is_at_the_bottom_right_of_the_page() -> None:
    items = place([boxed(50.0, 50.0, 100.0, 100.0)], width=100, height=100, matrix=WHOLE_PAGE, page=1, offset=0)
    assert items == [PdfTextItem(start=0, end=1, page=1, x=306.0, y=0.0, width=306.0, height=396.0)]


def test_an_image_drawn_small_and_away_from_the_corner_places_its_words_where_it_is_drawn() -> None:
    # The image is 300 by 400 points from (100, 200), and the word is the whole of it.
    placed = (300.0, 0.0, 0.0, 400.0, 100.0, 200.0)
    items = place([boxed(0.0, 0.0, 100.0, 100.0)], width=100, height=100, matrix=placed, page=2, offset=0)
    assert items == [PdfTextItem(start=0, end=1, page=2, x=100.0, y=200.0, width=300.0, height=400.0)]


def test_a_box_is_measured_by_the_images_own_width_and_height() -> None:
    # The same box in an image twice as wide and four times as high is half as wide on the page, and a quarter as high.
    items = place([boxed(0.0, 0.0, 50.0, 50.0)], width=200, height=400, matrix=WHOLE_PAGE, page=1, offset=0)
    assert items == [PdfTextItem(start=0, end=1, page=1, x=0.0, y=693.0, width=153.0, height=99.0)]


def test_a_words_offsets_are_moved_by_where_the_images_text_begins() -> None:
    words = [boxed(0.0, 0.0, 10.0, 10.0, start=0, end=5), boxed(20.0, 0.0, 30.0, 10.0, start=6, end=10)]
    items = place(words, width=100, height=100, matrix=WHOLE_PAGE, page=1, offset=1000)
    assert [(item.start, item.end) for item in items] == [(1000, 1005), (1006, 1010)]


def test_an_image_placed_upside_down_still_gives_a_rectangle_from_its_least_corner() -> None:
    mirrored = (612.0, 0.0, 0.0, -792.0, 0.0, 792.0)
    items = place([boxed(0.0, 0.0, 50.0, 50.0)], width=100, height=100, matrix=mirrored, page=1, offset=0)
    assert items == [PdfTextItem(start=0, end=1, page=1, x=0.0, y=0.0, width=306.0, height=396.0)]


def test_an_image_turned_a_quarter_places_a_word_by_the_matrix_and_by_no_case_of_its_own() -> None:
    # The unit square's x axis runs up the page and its y axis runs to the left: the image's top left is the page's bottom left.
    turned = (0.0, 792.0, -612.0, 0.0, 612.0, 0.0)
    items = place([boxed(0.0, 0.0, 50.0, 50.0)], width=100, height=100, matrix=turned, page=1, offset=0)
    assert items == [PdfTextItem(start=0, end=1, page=1, x=0.0, y=0.0, width=306.0, height=396.0)]


def test_an_image_of_no_width_or_no_height_places_nothing() -> None:
    assert place([boxed(0.0, 0.0, 1.0, 1.0)], width=0, height=100, matrix=WHOLE_PAGE, page=1, offset=0) == []
    assert place([boxed(0.0, 0.0, 1.0, 1.0)], width=100, height=0, matrix=WHOLE_PAGE, page=1, offset=0) == []


def test_the_words_of_a_line_read_from_pixels_are_placed_on_one_baseline() -> None:
    line = OcrLine(
        box=Box(x0=10.0, y0=25.0, x1=90.0, y1=50.0),
        words=(
            OcrWord(text="the", confidence=90.0, box=Box(x0=10.0, y0=30.0, x1=40.0, y1=45.0)),
            OcrWord(text="page", confidence=90.0, box=Box(x0=50.0, y0=30.0, x1=90.0, y1=50.0)),
        ),
    )
    found = assemble(OcrRead(paragraphs=(OcrParagraph(lines=(line,)),)))
    items = place(found.words, width=100, height=100, matrix=WHOLE_PAGE, page=1, offset=0)
    # The line is from a quarter to a half of the way down the image: from 396 to 594 points up the page.
    assert [(item.y, item.height) for item in items] == [(396.0, 198.0), (396.0, 198.0)]
