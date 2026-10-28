"""A page's text, made from the words drawn on it, and where a matrix takes a point.

The words are stated here as a reader hands them over: one run for each
word, the last word of a line saying that it ends one.
"""

from semiont.types import AnchoredText, PdfTextItem

from semiont_smelter.anchoring import anchor_runs, apply
from semiont_smelter.pdf_reader import Run


def word(text: str, *, x: float = 72.0, ends_line: bool = False) -> Run:
    """A word drawn on a line 700 points up the page."""
    return Run(text=text, x=x, y=700.0, width=30.0, height=12.0, ends_line=ends_line)


def spans(anchored: AnchoredText) -> list[tuple[int, int]]:
    """Each item's offsets, in the items' order."""
    return [(item.start, item.end) for item in anchored.items]


def quoted(anchored: AnchoredText) -> list[str]:
    """The stretch of the text each item's offsets select."""
    return [anchored.text[item.start : item.end] for item in anchored.items]


TWO_LINES = [word("first"), word("line", ends_line=True), word("second"), word("line", ends_line=True)]


def test_a_word_is_followed_by_a_space_and_the_last_word_of_a_line_by_a_line_feed() -> None:
    assert anchor_runs(TWO_LINES, 1).text == "first line\nsecond line\n"


def test_the_end_of_a_line_is_not_glued_to_the_start_of_the_next() -> None:
    text = anchor_runs([word("text", ends_line=True), word("second")], 1).text
    assert "text\nsecond" in text
    assert "textsecond" not in text


def test_each_items_offsets_select_its_word_and_nothing_of_the_separator_after_it() -> None:
    anchored = anchor_runs(TWO_LINES, 1)
    assert spans(anchored) == [(0, 5), (6, 10), (11, 17), (18, 22)]
    assert quoted(anchored) == ["first", "line", "second", "line"]


def test_an_item_has_its_words_place_and_the_page_it_was_asked_for() -> None:
    drawn = Run(text="known", x=72.0, y=720.0, width=31.5, height=12.0, ends_line=False)
    assert anchor_runs([drawn], 3).items == [PdfTextItem(start=0, end=5, page=3, x=72.0, y=720.0, width=31.5, height=12.0)]


def test_a_run_of_white_space_alone_is_no_word_and_adds_no_space() -> None:
    anchored = anchor_runs([word("a"), word(" "), word(""), word("b")], 1)
    assert anchored.text == "a b "
    assert quoted(anchored) == ["a", "b"]


def test_a_run_of_white_space_that_ends_a_line_leaves_the_line_feed() -> None:
    anchored = anchor_runs([word("a"), word(" ", ends_line=True), word("b", ends_line=True)], 1)
    assert anchored.text == "a \nb\n"
    assert spans(anchored) == [(0, 1), (3, 4)]


def test_a_run_is_written_whole_with_what_white_space_it_has_of_its_own() -> None:
    anchored = anchor_runs([word("to be "), word("or")], 1)
    assert anchored.text == "to be  or "
    assert quoted(anchored) == ["to be ", "or"]


def test_offsets_count_code_points() -> None:
    # A character outside the basic plane is one code point, and two of a string's units where a string counts in sixteen bits.
    runs = [word("\U0001d538"), word("bc", ends_line=True), word("\U0001f600x"), word("d", ends_line=True)]
    anchored = anchor_runs(runs, 1)
    assert anchored.text == "\U0001d538 bc\n\U0001f600x d\n"
    assert spans(anchored) == [(0, 1), (2, 4), (5, 7), (8, 9)]
    assert quoted(anchored) == ["\U0001d538", "bc", "\U0001f600x", "d"]


def test_a_page_that_draws_no_text_has_no_text_and_no_item() -> None:
    assert anchor_runs([], 1) == AnchoredText(text="", items=[])


def test_a_matrix_that_changes_nothing_leaves_a_point_where_it_is() -> None:
    assert apply((1.0, 0.0, 0.0, 1.0, 0.0, 0.0), 3.0, 4.0) == (3.0, 4.0)


def test_a_matrix_takes_a_point_by_all_six_of_its_numbers() -> None:
    # (a*x + c*y + e, b*x + d*y + f), each of the six a different prime: a number put in another's place gives another point.
    assert apply((2.0, 3.0, 5.0, 7.0, 11.0, 13.0), 1.0, 1.0) == (18.0, 23.0)
    assert apply((2.0, 3.0, 5.0, 7.0, 11.0, 13.0), 2.0, 3.0) == (30.0, 40.0)


def test_the_matrix_that_places_an_image_takes_its_unit_square_onto_the_rectangle_it_is_drawn_in() -> None:
    placed = (300.0, 0.0, 0.0, 400.0, 100.0, 200.0)
    assert apply(placed, 0.0, 0.0) == (100.0, 200.0)
    assert apply(placed, 1.0, 1.0) == (400.0, 600.0)


def test_a_matrix_that_turns_a_quarter_takes_the_x_axis_to_the_y_axis() -> None:
    assert apply((0.0, 1.0, -1.0, 0.0, 0.0, 0.0), 1.0, 0.0) == (0.0, 1.0)
