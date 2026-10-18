"""The Typst compiler itself, run by the worker: the `typst` found on `PATH`, which is where the worker's image puts it.

`test_typst.py` holds how the worker calls a compiler. These hold what the
call is for, which only the compiler can show: a PDF comes back, the pinned
creation time is the PDF's, one source is the same bytes every time, a
source it refuses comes back with diagnostics that name the place, and a
source's name, as the worker writes one into Typst, is read as itself.

Nothing here installs the compiler or stands in for it, and no test is
skipped without it: on a machine that has no `typst` each fails, and says
where the image gets its own.
"""

import json
import re
import shutil
import string
from datetime import UTC, datetime
from typing import Final

import pytest
from spec import PROJECT

from semiont_worker.generation.citations import CitableIds, resolve_citation_tokens
from semiont_worker.generation.typst import (
    PINNED_CREATION_TIMESTAMP,
    Compiled,
    Landed,
    LandedCompile,
    NotCompiled,
    compile_typst,
    compile_typst_landing,
)

DOCUMENT: Final = "= The Analytical Engine\n\nIt was never built, and caf\u00e9s were.\n"


@pytest.fixture(autouse=True)
def the_compiler() -> None:
    """Fail, and do not skip, where there is no compiler to run."""
    taken_from = re.findall(r"^COPY --from=(\S*typst\S*) ", (PROJECT / "Dockerfile").read_text(encoding="utf-8"), flags=re.MULTILINE)
    assert shutil.which("typst") is not None, (
        f"no `typst` on PATH: these tests run the compiler itself, which the worker's image takes from {taken_from}"
    )


def compiled(source: str) -> bytes:
    result = compile_typst(source)
    assert isinstance(result, Compiled), result
    return result.pdf


def test_a_document_compiles_to_a_pdf() -> None:
    assert compiled(DOCUMENT).startswith(b"%PDF-")


def test_the_pinned_creation_time_is_the_pdf_s() -> None:
    # A PDF states when it was made as `D:` and the instant's digits.
    pinned = datetime.fromtimestamp(PINNED_CREATION_TIMESTAMP, UTC).strftime("D:%Y%m%d%H%M%S").encode("ascii")
    stated = set(re.findall(rb"D:\d{14}", compiled(DOCUMENT)))
    assert stated == {pinned}


def test_one_source_is_the_same_bytes_every_time() -> None:
    assert compiled(DOCUMENT) == compiled(DOCUMENT)


def test_a_source_the_compiler_refuses_comes_back_with_where_it_is_wrong() -> None:
    refused = compile_typst("= Title\n#let broken = [unclosed\n")
    assert isinstance(refused, NotCompiled), refused
    # What went wrong, and the file, the line and the column it went wrong at.
    assert "error: unclosed delimiter" in refused.error
    assert "doc.typ:2:14" in refused.error


# ── where each cited span landed, as the compiler says ─────────────────

PAGE: Final = "#set page(width: 300pt, height: 200pt)\n#set text(size: 10pt)\n"
"""A page of a known height, so that where a mark landed can be held to it."""


def landed(source: str, ends: list[int]) -> list[Landed | None]:
    result = compile_typst_landing(source, ends)
    assert isinstance(result, LandedCompile), result
    assert result.pdf.startswith(b"%PDF-")
    return result.landed


def at(source: str, after: str) -> int:
    """The offset just after the first `after` in `source`: where a span that ends with it ends."""
    return source.index(after) + len(after)


def test_spans_that_end_on_one_line_land_on_its_baseline_and_one_on_the_next_line_lands_lower() -> None:
    source = PAGE + "First claim here, second claim there, and a third that runs on until the line is broken by its width alone.\n"
    first, second, third = landed(source, [at(source, "here"), at(source, "there"), at(source, "alone")])

    assert first is not None
    assert second is not None
    assert third is not None
    # A baseline measured from the bottom of the page: on it, inside it.
    assert (first.page, second.page, third.page) == (1, 1, 1)
    assert 0 < first.y < 200
    assert 0 < first.x < 300
    # Two ends on one line share its baseline, and the later is further along it.
    assert first.y == second.y
    assert first.x < second.x
    # The third ends on a later line, which is lower on the page: by at least a line of 10-point text.
    assert third.y <= first.y - 10


def test_the_same_words_on_two_pages_land_on_two_pages() -> None:
    source = PAGE + "On Radiant Matter, a first time.\n\n#pagebreak()\n\nOn Radiant Matter, a second time.\n"
    ends = [at(source, "Radiant Matter"), source.rindex("Radiant Matter") + len("Radiant Matter")]

    first, second = landed(source, ends)

    assert first is not None
    assert second is not None
    assert (first.page, second.page) == (1, 2)


def test_a_mark_before_a_full_stop_a_bracket_or_a_parenthesis_or_inside_emphasis_is_compiled_and_lands() -> None:
    # A mark is code in the middle of the model's prose: what follows it must not be read as more of it.
    source = PAGE + "It was cited(twice), [seen[x]], *bold* and done. The end"
    ends = [at(source, "cited"), at(source, "seen"), at(source, "*bold"), at(source, "done"), len(source)]

    points = landed(source, ends)

    assert all(point is not None for point in points)


def test_two_citations_that_end_at_one_place_land_at_one_point() -> None:
    source = PAGE + "Tea is hot, they said."
    first, second = landed(source, [at(source, "hot"), at(source, "hot")])

    assert first is not None
    assert first == second


def test_a_mark_on_a_page_whose_height_is_auto_has_no_landing() -> None:
    source = "#set page(height: auto)\nTea is hot."

    assert landed(source, [at(source, "hot")]) == [None]


# ── a source's name, as a PDF's source has it ──────────────────────────


def test_a_name_written_for_a_pdf_is_read_as_itself_and_a_mark_after_it_lands() -> None:
    # A name put in a PDF's source has each of its ASCII punctuation characters after a backslash (`citation-cases.json`). Each
    # of the 32 must be read by the compiler as itself, and none of them, nor what follows them, as markup.
    citable = CitableIds(resource_ids=frozenset({"r1"}), annotation_ids=frozenset(), names={"r1": string.punctuation})
    written = resolve_citation_tokens("[[r1]]", citable, "application/pdf").content
    read_back = (
        f"#let name = [{written}]\n"
        '#let read = if name.has("children") { name.children.map(part => part.text).join() } else { name.text }\n'
        f"#assert.eq(read, {json.dumps(string.punctuation)})\n"
        "#name\n"
    )
    assert compiled(read_back).startswith(b"%PDF-")
    # A mark at the name's end is code just after its last escape: it lands as at any other word.
    source = PAGE + f"See {written}. Then more."
    (point,) = landed(source, [at(source, written)])
    assert point is not None
