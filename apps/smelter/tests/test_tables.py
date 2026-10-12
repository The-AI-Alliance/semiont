"""A page that is a grid: found from where its words are, and written as rows.

A reader hands over one run for each word, so a cell of two words is two
runs a word space apart. Most pages here are stated that way, as runs, and
made into a page's text and items by the rule every page's are
(`anchor_runs`): what holds a cell together, and what keeps prose from being
taken for a grid, is held on the pieces a reader gives.
"""

from collections.abc import Sequence

import pytest
from semiont.types import PdfTextItem

from semiont_smelter.anchoring import anchor_runs
from semiont_smelter.pdf_reader import Run
from semiont_smelter.tables import TableCell, detect_table, render_table

WORD_SPACE = 3.0
"""The gap between two words of one cell: a quarter of the height of 12-point text."""


def word(text: str, x: float, y: float, *, width: float = 30.0, height: float = 12.0) -> Run:
    """A word drawn at a place."""
    return Run(text=text, x=x, y=y, width=width, height=height, ends_line=False)


def cell(text: str, x: float, y: float, *, height: float = 12.0) -> list[Run]:
    """The words of one cell drawn from `x`: each half its height wide for each of its characters, and a word space from the last."""
    runs: list[Run] = []
    at = x
    for each in text.split():
        width = height / 2 * len(each)
        runs.append(word(each, at, y, width=width, height=height))
        at += width + WORD_SPACE
    return runs


def grid(rows: Sequence[Sequence[str]], columns: Sequence[float], *, top: float = 720.0, leading: float = 24.0) -> list[Run]:
    """A grid drawn row by row from `top`, each row's cells at the columns' places."""
    runs: list[Run] = []
    for down, row in enumerate(rows):
        for stated, x in zip(row, columns, strict=True):
            runs.extend(cell(stated, x, top - down * leading))
    return runs


def found(runs: Sequence[Run]) -> list[list[TableCell]] | None:
    """The grid found on a page that draws `runs`."""
    anchored = anchor_runs(runs, 1)
    return detect_table(anchored.items, anchored.text)


def texts(runs: Sequence[Run]) -> list[list[str]] | None:
    """The text of each cell of the grid found on a page that draws `runs`, row by row."""
    rows = found(runs)
    return None if rows is None else [[each.text for each in row] for row in rows]


OUTCOMES = [
    ["Treatment", "Responders", "p-value"],
    ["Drug A", "12%", "0.03"],
    ["Drug B", "9%", "0.21"],
    ["Placebo", "4%", "0.88"],
]
COLUMNS = [72.0, 250.0, 420.0]


# ── Finding a grid ─────────────────────────────────────────────────────


def test_a_grid_is_found_as_its_rows_from_the_top_and_each_rows_cells_from_the_left() -> None:
    assert texts(grid(OUTCOMES, COLUMNS)) == OUTCOMES


def test_the_order_the_words_are_drawn_in_does_not_change_the_grid() -> None:
    # Column by column, from the bottom: what was drawn last is read first.
    assert texts([*reversed(grid(OUTCOMES, COLUMNS))]) == OUTCOMES


def test_two_words_a_word_space_apart_are_one_cell_with_the_rectangle_around_both() -> None:
    rows = found(grid(OUTCOMES, COLUMNS))
    assert rows is not None
    # "Drug" is 24 points from 72, and "A" is 6 points from 99.
    assert rows[1][0] == TableCell(text="Drug A", x=72.0, y=696.0, width=33.0, height=12.0)


def test_a_word_no_further_than_eight_tenths_of_a_height_from_the_last_is_of_its_cell_and_one_further_begins_a_cell() -> None:
    def page(gap: float) -> list[Run]:
        """Three rows of words 10 high: one that ends 100 across, one `gap` after it, and one far to the right."""
        runs: list[Run] = []
        for y in (700.0, 680.0, 660.0):
            runs += [word("a", 70.0, y, height=10.0), word("b", 100.0 + gap, y, height=10.0), word("c", 300.0, y, height=10.0)]
        return runs

    assert texts(page(8.0)) == [["a b", "c"]] * 3
    assert texts(page(8.5)) == [["a", "b", "c"]] * 3


def test_words_within_half_a_height_of_a_rows_first_baseline_are_of_that_row() -> None:
    def page(raised: float) -> list[Run]:
        """Three rows of two cells, the second cell's baseline `raised` above the first's."""
        runs: list[Run] = []
        for y in (700.0, 660.0, 620.0):
            runs += [word("left", 72.0, y), word("right", 300.0, y + raised)]
        return runs

    assert texts(page(6.0)) == [["left", "right"]] * 3
    # Seven points is more than half of twelve: six rows of one cell, which is no grid.
    assert texts(page(7.0)) is None


def test_a_page_whose_words_state_no_height_is_measured_as_text_12_high() -> None:
    def page(gap: float) -> list[Run]:
        runs: list[Run] = []
        for y in (700.0, 680.0, 660.0):
            runs += [word("a", 70.0, y, height=0.0), word("b", 100.0 + gap, y, height=0.0), word("c", 300.0, y, height=0.0)]
        return runs

    assert texts(page(9.0)) == [["a b", "c"]] * 3
    assert texts(page(10.0)) == [["a", "b", "c"]] * 3


def test_the_height_a_page_is_measured_by_is_the_one_in_the_middle_of_its_words_heights() -> None:
    # Six words 10 high and three 40 high: the height is 10, and a gap of 9 ends a cell. By the mean, 20, it would not.
    runs: list[Run] = []
    for y in (700.0, 600.0, 500.0):
        runs += [word("a", 70.0, y, height=10.0), word("b", 109.0, y, height=10.0), word("c", 300.0, y, height=40.0)]
    assert texts(runs) == [["a", "b", "c"]] * 3


# ── What is no grid ────────────────────────────────────────────────────


def test_lines_of_prose_are_no_grid() -> None:
    lines = ["first line of text", "second line of text", "third line of text"]
    prose = [run for down, stated in enumerate(lines) for run in cell(stated, 72.0, 720.0 - 20.0 * down)]
    assert found(prose) is None


def test_two_rows_are_no_grid() -> None:
    # Two columns of prose, two lines long: with fewer than three rows nothing tells them from a grid.
    columns = [["left column line one", "right column line one"], ["left column line two", "right column line two"]]
    assert found(grid(columns, [72.0, 320.0])) is None


def test_rows_of_unlike_numbers_of_cells_are_no_grid() -> None:
    ragged = [*grid(OUTCOMES[:3], COLUMNS), *cell("A note under the rows", 72.0, 600.0)]
    assert found(ragged) is None


@pytest.mark.parametrize(("indent", "is_grid"), [(12.0, True), (12.5, False)])
def test_a_column_whose_cells_start_more_than_a_height_apart_is_no_column(indent: float, is_grid: bool) -> None:
    rows = [["one", "two"], ["three", "four"], ["five", "six"]]
    runs = [*grid(rows[:2], [72.0, 300.0]), *grid(rows[2:], [72.0, 300.0 + indent], top=672.0)]
    assert (found(runs) is not None) == is_grid


def test_a_page_with_no_word_is_no_grid() -> None:
    assert detect_table([], "") is None


def test_each_cell_is_read_at_its_words_offsets_after_characters_outside_the_basic_plane() -> None:
    text = "\U0001f600 Arm Dose\n\U0001d538x 5mg\nB 7mg\n"

    def at(start: int, end: int, x: float, y: float) -> PdfTextItem:
        return PdfTextItem(start=start, end=end, page=1, x=x, y=y, width=30.0, height=12.0)

    items = [
        at(2, 5, 72.0, 700.0),
        at(6, 10, 200.0, 700.0),
        at(11, 13, 72.0, 680.0),
        at(14, 17, 200.0, 680.0),
        at(18, 19, 72.0, 660.0),
        at(20, 23, 200.0, 660.0),
    ]
    rows = detect_table(items, text)
    assert rows is not None
    assert [[each.text for each in row] for row in rows] == [["Arm", "Dose"], ["\U0001d538x", "5mg"], ["B", "7mg"]]


# ── Writing a grid as rows ─────────────────────────────────────────────


def test_a_grid_is_written_a_row_to_a_line_with_a_line_of_dashes_under_the_first() -> None:
    rows = found(grid(OUTCOMES, COLUMNS))
    assert rows is not None
    text, _ = render_table(rows, 1, 0)
    assert text == (
        "| Treatment | Responders | p-value |\n"
        "| --- | --- | --- |\n"
        "| Drug A | 12% | 0.03 |\n"
        "| Drug B | 9% | 0.21 |\n"
        "| Placebo | 4% | 0.88 |\n"
    )


def test_each_cell_is_anchored_in_code_points_from_where_the_table_is_put() -> None:
    def stated(text: str, x: float, y: float) -> TableCell:
        return TableCell(text=text, x=x, y=y, width=30.0, height=12.0)

    rows = [
        [stated("\U0001d538rm", 72.0, 700.0), stated("Dose", 200.0, 700.0)],
        [stated("\U0001f600", 72.0, 680.0), stated("5 mg", 200.0, 680.0)],
        [stated("B", 72.0, 660.0), stated("7 mg", 200.0, 660.0)],
    ]
    text, items = render_table(rows, 3, 10)

    assert text == "| \U0001d538rm | Dose |\n| --- | --- |\n| \U0001f600 | 5 mg |\n| B | 7 mg |\n"
    assert [(item.start, item.end) for item in items] == [(12, 15), (18, 22), (41, 42), (45, 49), (54, 55), (58, 62)]
    assert all(item.page == 3 for item in items)
    # Ten code points come before the table where it is put, so each cell is ten earlier in the table's own text.
    assert [text[item.start - 10 : item.end - 10] for item in items] == [each.text for row in rows for each in row]


def test_a_cells_item_has_the_cells_rectangle() -> None:
    _, items = render_table([[TableCell(text="Drug A", x=72.0, y=696.0, width=33.0, height=12.0)]], 2, 0)
    assert items == [PdfTextItem(start=2, end=8, page=2, x=72.0, y=696.0, width=33.0, height=12.0)]
