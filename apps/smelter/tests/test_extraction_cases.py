"""What deriving a PDF's text comes to, held to `specs/src/smelter/extraction-cases.json` with the reader and the engine the Smelter runs.

The table is the one every Smelter runs: a document is sorted into the same
class, read the same way and declined by the same name, whoever reads it.
Nothing is stood in for here. The reader is PDFium's and the engine is the
`tesseract` program, since a table run against a stand-in holds nothing; a
case that comes to reading an image fails, saying so, where the program is
not installed.

The documents are the files in `specs/src/smelter/fixtures`. The table's
`fixtures` member names another directory, which nothing here reads from.

Two documents are held beside the table, which has no case of either: one
that asks for a password, and a scan whose pixels have words in them.

A member of the table or of a case that nothing here reads fails: a table
that grows a way of stating a document is not passed over.
"""

from collections.abc import Iterable

import pytest
from aio import run, soon
from pydantic import JsonValue
from semiont.types import ExtractedText, ExtractionDeclined, ExtractionOutcome
from spec import ROOT, JsonObject, objects, read, strings, text, thing

from semiont_smelter.extraction import LARGEST_PDF_BYTES, PdfExtractor
from semiont_smelter.pdfium import PdfiumReader
from semiont_smelter.tesseract import TesseractEngine

TABLE = read(ROOT / "specs/src/smelter/extraction-cases.json")
CASES = objects(TABLE["cases"], "cases")
FIXTURES = ROOT / "specs/src/smelter/fixtures"

ENCRYPTED = "encrypted.pdf"
LEGIBLE_SCAN = "legible-scan.pdf"
"""The two fixtures the table has no case of."""

SECONDS = 60.0
"""How long deriving one document may take: long enough for the engine to start and to read a page's images."""

# Every member each thing the table states may have. A member that is none of these is one nothing here would read.
TABLE_MEMBERS = ("$comment", "cases", "fixtures", "largestPdfBytes")
READ_MEMBERS = ("why", "fixture", "pdfClass", "method", "unreadPages", "pagesWithItems", "words", "onPage", "absent", "rows")
DECLINED_MEMBERS = ("why", "fixture", "bytes", "declined")
BYTES_MEMBERS = ("utf8", "length")


def only(stated: JsonObject, known: Iterable[str], what: str) -> None:
    """Fail for a member of `stated` that is none of `known`: nothing here would read it."""
    unread = sorted(set(stated) - set(known))
    assert unread == [], f"{what} states {unread}, which nothing here reads"


def integer(stated: JsonValue, what: str) -> int:
    """The whole number a table states."""
    assert not isinstance(stated, bool), f"{what} is not a whole number"
    assert isinstance(stated, int), f"{what} is not a whole number"
    return stated


def unread_pages(case: JsonObject) -> list[int] | None:
    """The pages a case says nothing was read from. `None` for a case that names none: its outcome names none either."""
    if "unreadPages" not in case:
        return None
    listed = case["unreadPages"]
    assert isinstance(listed, list), "unreadPages is not a list"
    return [integer(page, "a page") for page in listed]


def absent(case: JsonObject) -> list[str]:
    """The strings a case says the text has not."""
    return strings(case["absent"], "absent") if "absent" in case else []


def rows(case: JsonObject) -> list[list[str]]:
    """The rows of a grid a case states, each as its cells from the left."""
    if "rows" not in case:
        return []
    listed = case["rows"]
    assert isinstance(listed, list), "rows is not a list"
    return [strings(row, "a row") for row in listed]


def on_page(case: JsonObject) -> dict[str, int]:
    """The page a case gives for some of its words."""
    if "onPage" not in case:
        return {}
    return {word: integer(page, "a page") for word, page in thing(case["onPage"], "onPage").items()}


def in_order(line: str, cells: list[str]) -> bool:
    """Whether `line` has every one of `cells`, each after the one before it."""
    start = 0
    for cell in cells:
        at = line.find(cell, start)
        if at == -1:
            return False
        start = at + len(cell)
    return True


def committed(name: str) -> bytes:
    """The bytes of one of the committed documents."""
    return (FIXTURES / name).read_bytes()


def document_of(case: JsonObject) -> bytes:
    """The document a case is of: a fixture's bytes, or the bytes the case says how to make."""
    if "fixture" in case:
        return committed(text(case["fixture"], "fixture"))
    made = thing(case["bytes"], "bytes")
    if "utf8" in made:
        return text(made["utf8"], "utf8").encode()
    # A document of that many bytes, whatever they are: it is declined by its size, and no byte of it is read.
    return bytes(integer(made["length"], "length"))


async def derived(document: bytes) -> ExtractionOutcome:
    """What the Smelter's own reader and engine derive of a document."""
    extractor = PdfExtractor(reader=PdfiumReader(), engine=TesseractEngine())
    return await soon(extractor.extract(document), within=SECONDS)


def items_having(outcome: ExtractedText, word: str, page: int) -> int:
    """How many items on a page select a stretch of the text that has a word in it."""
    return sum(1 for item in outcome.items if item.page == page and word in outcome.text[item.start : item.end])


def cases() -> list[object]:
    """Each case of the table, named in a test's id by why the case is there."""
    return [pytest.param(case, id=text(case["why"], "why")) for case in CASES]


def test_the_table_has_cases_each_of_one_document_that_is_read_or_declined_and_no_member_nothing_here_reads() -> None:
    only(TABLE, TABLE_MEMBERS, "the table")
    assert sorted(TABLE) == sorted(TABLE_MEMBERS)
    assert len(CASES) > 0
    for case in CASES:
        why = text(case["why"], "why")
        if "declined" in case:
            only(case, DECLINED_MEMBERS, why)
            assert ("fixture" in case) != ("bytes" in case), why
            if "bytes" in case:
                made = thing(case["bytes"], "bytes")
                only(made, BYTES_MEMBERS, why)
                assert len(made) == 1, why
        else:
            only(case, READ_MEMBERS, why)
            assert set(case) >= {"fixture", "pdfClass", "method", "pagesWithItems", "words"}, why
            words = strings(case["words"], "words")
            assert words != [], why
            # A word given a page is one of the words the text must have.
            assert set(on_page(case)) <= set(words), why
            # A row of no cells is on every line, and holds nothing.
            assert all(row != [] for row in rows(case)), why


def test_the_table_names_a_directory_of_fixtures_and_every_committed_fixture_has_a_case_in_the_table_or_beside_it() -> None:
    assert text(TABLE["fixtures"], "fixtures") != ""
    made = sorted(path.name for path in FIXTURES.glob("*.pdf"))
    stated = [text(case["fixture"], "fixture") for case in CASES if "fixture" in case]
    assert sorted([*stated, ENCRYPTED, LEGIBLE_SCAN]) == made


def test_the_largest_pdf_that_is_opened_is_the_tables() -> None:
    assert integer(TABLE["largestPdfBytes"], "largestPdfBytes") == LARGEST_PDF_BYTES


@pytest.mark.parametrize("case", cases())
def test_a_document_comes_to_what_the_table_states_of_it(case: JsonObject) -> None:
    outcome = run(derived(document_of(case)))

    if "declined" in case:
        assert isinstance(outcome, ExtractionDeclined), "the document was read, and not declined"
        assert outcome.declined == text(case["declined"], "declined")
        return
    assert isinstance(outcome, ExtractedText), f"declined: {outcome}"

    assert outcome.pdf_class == text(case["pdfClass"], "pdfClass")
    assert outcome.method == text(case["method"], "method")
    assert outcome.unread_pages == unread_pages(case)
    assert len({item.page for item in outcome.items}) == integer(case["pagesWithItems"], "pagesWithItems")
    for word in strings(case["words"], "words"):
        assert word in outcome.text, f"the word {word}"
    for unwanted in absent(case):
        assert unwanted not in outcome.text, f"the absent {unwanted}"
    lines = outcome.text.split("\n")
    for row in rows(case):
        assert any(in_order(line, row) for line in lines), f"one line with the row {row}"
    for word, page in on_page(case).items():
        assert items_having(outcome, word, page) > 0, f"an item on page {page} that has the word {word}"


def test_a_document_that_asks_for_a_password_is_declined_as_encrypted() -> None:
    assert run(derived(committed(ENCRYPTED))) == ExtractionDeclined(kind="declined", declined="encrypted")


def test_a_scan_whose_pixels_have_words_is_read_by_the_engine_and_each_word_is_an_item_on_its_page() -> None:
    outcome = run(derived(committed(LEGIBLE_SCAN)))
    assert isinstance(outcome, ExtractedText), f"declined: {outcome}"
    assert outcome.pdf_class == "B"
    assert outcome.method == "ocr"
    assert outcome.unread_pages is None
    for word in ("RECOVERED", "FROM", "THE", "PIXELS"):
        assert word in outcome.text, f"the word {word}"
        assert items_having(outcome, word, 1) > 0, f"an item on page 1 that has the word {word}"
    # How sure the engine was is stated of every word that is an item, and what it comes to is the engine's build's.
    assert outcome.ocr_confidence is not None
    assert outcome.ocr_confidence.total_words == len(outcome.items)
