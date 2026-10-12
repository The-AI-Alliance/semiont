"""The Tesseract engine, with the real `tesseract` program under it.

The tests of what the program reads run the program installed on the path,
and fail, saying that it is not installed, where there is none. They hold
what any build of the program reads: which words, in which lines, and that
each is inside its image. How sure the program was and where exactly a box
lies differ from one build to the next, and are not held.

How the engine reads what the program prints, and what it makes of a
program that fails, is held with a program of this file's own put on the
path in its place: a shell script that prints what a test states.
"""

import re
from pathlib import Path
from typing import Final

import pytest
from aio import run
from spec import ROOT

from semiont_smelter.ocr_engine import Box, OcrLine, OcrParagraph, OcrRead, OcrWord
from semiont_smelter.pdf_reader import Pixels
from semiont_smelter.pdfium import PdfiumReader
from semiont_smelter.tesseract import TesseractEngine

SCAN: Final = ROOT / "specs/src/smelter/fixtures/legible-scan.pdf"

COLUMNS: Final = "level|page_num|block_num|par_num|line_num|word_num|left|top|width|height|conf|text"
"""The first row the program prints, with `|` where it prints a tab."""


def legible() -> Pixels:
    """The image `legible-scan.pdf` paints, whose pixels say RECOVERED FROM on one line and THE PIXELS on the next."""
    content = SCAN.read_bytes()

    async def decoded() -> Pixels:
        document = await PdfiumReader().open(content)
        try:
            [image] = await document.placed_images(1)
            pixels = await document.decode(1, image)
        finally:
            await document.close()
        assert pixels is not None, "PDFium did not decode the image of legible-scan.pdf"
        return pixels

    return run(decoded())


def bars() -> Pixels:
    """Three dark bars on white: a picture of three lines of text with no character in it."""
    width, height = 240, 140
    rgb = bytearray([0xFF]) * (width * height * 3)
    for top in (20, 60, 100):
        for y in range(top, top + 14):
            rgb[(y * width + 20) * 3 : (y * width + 220) * 3] = bytes([0x20]) * (200 * 3)
    return Pixels(width=width, height=height, rgb=bytes(rgb))


def lines(read: OcrRead) -> list[list[str]]:
    """The words of each line that has a word to be seen, in the order read. A word of blank text is not one to be seen."""
    found = [[word.text for word in line.words if word.text.strip()] for paragraph in read.paragraphs for line in paragraph.lines]
    return [line for line in found if line]


def stand_in(directory: Path, script: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Put a program named `tesseract` that runs `script`, a shell script, in `directory`, and make that the whole path."""
    program = directory / "tesseract"
    program.write_text(f"#!/bin/sh\n{script}\n")
    program.chmod(0o755)
    monkeypatch.setenv("PATH", str(directory))


def printing(*rows: str) -> str:
    """A shell script that takes what it is given and prints `rows` as the program prints its table. `|` stands for a tab."""
    table = "".join(row.replace("|", r"\t") + r"\n" for row in rows)
    return f"/bin/cat > /dev/null\nprintf '{table}'"


# ── The program that is installed ─────────────────────────────────────


def test_the_words_of_an_image_are_read_in_their_lines_and_each_is_inside_the_image() -> None:
    image = legible()
    [read] = run(TesseractEngine().read([image]))
    assert lines(read) == [["RECOVERED", "FROM"], ["THE", "PIXELS"]]
    boxes = [box for paragraph in read.paragraphs for line in paragraph.lines for box in (line.box, *(word.box for word in line.words))]
    for box in boxes:
        assert 0 <= box.x0 < box.x1 <= image.width, box
        assert 0 <= box.y0 < box.y1 <= image.height, box


def test_an_image_with_no_character_in_it_is_read_as_no_word() -> None:
    [read] = run(TesseractEngine().read([bars()]))
    assert lines(read) == []


def test_each_image_has_an_answer_of_its_own_in_the_order_of_the_images() -> None:
    reads = run(TesseractEngine().read([bars(), legible(), bars()]))
    assert [lines(read) for read in reads] == [[], [["RECOVERED", "FROM"], ["THE", "PIXELS"]], []]


def test_the_stamp_is_the_program_s_version_and_its_english_data_s_and_is_measured_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    engine = TesseractEngine()
    stamp = run(engine.stamp())
    assert re.fullmatch(r"tesseract-\S+\+eng-[0-9a-f]{8}", stamp), stamp
    # With no program on the path, the engine still answers what it measured.
    monkeypatch.setenv("PATH", str(tmp_path))
    assert run(engine.stamp()) == stamp


# ── A program that is not there, or that fails ────────────────────────


def test_a_program_that_is_not_installed_fails_by_its_name(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(RuntimeError, match="`tesseract` program is not installed"):
        run(TesseractEngine().read([bars()]))
    with pytest.raises(RuntimeError, match="`tesseract` program is not installed"):
        run(TesseractEngine().stamp())
    # No image, and no program is run.
    assert run(TesseractEngine().read([])) == []


def test_a_program_that_exits_with_a_failure_fails_with_what_it_said(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    stand_in(tmp_path, "/bin/cat > /dev/null\necho 'no such language' >&2\nexit 3", monkeypatch)
    with pytest.raises(RuntimeError, match="tesseract .* exited with 3: no such language"):
        run(TesseractEngine().read([bars()]))


@pytest.mark.parametrize(
    "script",
    [
        "/bin/cat > /dev/null\necho 'Hello world'",
        printing(COLUMNS, "5|1|1|1|1|1|10|10|80|30|96.5|Hello"),
        printing(COLUMNS, "4|1|1|1|1|0|10|10|180|30|-1"),
        printing(COLUMNS, "4|1|1|1|1|0|ten|10|180|30|-1|"),
        printing(COLUMNS, "6|1|1|1|1|0|10|10|180|30|-1|"),
    ],
    ids=["no table", "a word with no line", "a row a column short", "a word where a number belongs", "a level the program has not"],
)
def test_a_program_that_prints_what_is_no_table_fails_by_its_name(script: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    stand_in(tmp_path, script, monkeypatch)
    with pytest.raises(RuntimeError, match="`tesseract` program printed what is no TSV"):
        run(TesseractEngine().read([bars()]))


def test_a_table_is_read_as_its_paragraphs_of_lines_of_words(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    script = printing(
        COLUMNS,
        "1|1|0|0|0|0|0|0|240|140|-1|",
        "2|1|1|0|0|0|10|10|180|30|-1|",
        "3|1|1|1|0|0|10|10|180|30|-1|",
        "4|1|1|1|1|0|10|10|180|30|-1|",
        "5|1|1|1|1|1|10|10|80|30|96.5|Hello",
        "5|1|1|1|1|2|100|12|90|28|91.25|world",
        "2|1|2|0|0|0|10|60|50|20|-1|",
        "3|1|2|1|0|0|10|60|50|20|-1|",
        "4|1|2|1|1|0|10|60|50|20|-1|",
        "5|1|2|1|1|1|10|60|50|20|95| ",
    )
    stand_in(tmp_path, script, monkeypatch)
    hello = OcrWord(text="Hello", confidence=96.5, box=Box(x0=10, y0=10, x1=90, y1=40))
    world = OcrWord(text="world", confidence=91.25, box=Box(x0=100, y0=12, x1=190, y1=40))
    # A word of blank text is handed over: which words count is not the engine's to say.
    blank = OcrWord(text=" ", confidence=95.0, box=Box(x0=10, y0=60, x1=60, y1=80))
    first = OcrParagraph(lines=(OcrLine(box=Box(x0=10, y0=10, x1=190, y1=40), words=(hello, world)),))
    second = OcrParagraph(lines=(OcrLine(box=Box(x0=10, y0=60, x1=60, y1=80), words=(blank,)),))
    assert run(TesseractEngine().read([bars()])) == [OcrRead(paragraphs=(first, second))]
